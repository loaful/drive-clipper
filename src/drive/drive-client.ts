import {
  buildArticleFolderName,
  buildFrontmatter,
  composeMarkdownDocument,
} from '../core/frontmatter.js';
import { rewriteMarkdownImageUrls } from '../core/images.js';
import {
  DRIVE_FILE_SCOPE,
  STORAGE_KEYS,
  buildDriveFolderUrl,
  getBuildWebAuthClientId,
  isConfiguredOAuthClientIdValue,
  normalizeWebAuthRedirectUri,
  type ClipResult,
  type ExtractedPage,
  type FetchedImage,
  type FrontmatterPreferences,
  type ImageFetchFailure,
  type RootFolderInfo,
  type UploadedImageInfo,
} from '../types.js';

export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const DEFAULT_DRIVE_BASE_URL = 'https://www.googleapis.com';
const GOOGLE_OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const WEB_AUTH_TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_WEB_AUTH_EXPIRES_IN_SECONDS = 3600;

// Google Drive v3 appProperties limits each entry to 124 UTF-8 bytes (key + value).
const DRIVE_APP_PROPERTY_MAX_BYTES = 124;
const SOURCE_URL_PROPERTY_KEY = 'sourceUrl';
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_UPLOAD_CONCURRENCY = 5;

const textEncoder = new TextEncoder();

export type DriveTokenProvider = (options: {
  interactive: boolean;
}) => Promise<string>;

export interface DriveClientOptions {
  /**
   * Convenience base origin (e.g. "http://127.0.0.1:4321") used to derive
   * `${baseUrl}/drive/v3` and `${baseUrl}/upload/drive/v3`.
   */
  baseUrl?: string;
  /** Explicit Drive v3 API base URL (defaults to `${baseUrl}/drive/v3`). */
  apiBaseUrl?: string;
  /** Explicit Drive v3 upload base URL (defaults to `${baseUrl}/upload/drive/v3`). */
  uploadBaseUrl?: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: DriveTokenProvider;
  /** Called on HTTP 401 before attempting a single token refresh retry. */
  onUnauthorizedToken?: (token: string) => Promise<void>;
  /** Injectable sleep function for deterministic backoff testing. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  uploadConcurrency?: number;
}

export interface EnsureRootFolderParams {
  rootFolderName: string;
  rootFolderId: string | null;
  forceNew?: boolean;
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface UploadArticleParams {
  rootFolderId: string;
  page: ExtractedPage;
  fetchedImages: readonly FetchedImage[];
  failedImages?: readonly ImageFetchFailure[];
  title?: string;
  tags?: readonly string[];
  folderName?: string;
  clippedAt?: string;
  frontmatterPreferences?: Partial<FrontmatterPreferences>;
  uploadConcurrency?: number;
  interactive?: boolean;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

interface DriveFileResource {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
}

interface DriveFileListResponse {
  files?: DriveFileResource[];
  nextPageToken?: string;
}

export class DriveApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status: number; code?: string; retryable?: boolean },
  ) {
    super(message);
    this.name = 'DriveApiError';
    this.status = options.status;
    this.code = options.code ?? 'DRIVE_API_ERROR';
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Escapes backslashes and single quotes for Google Drive v3 `q` query literals.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Encodes a source URL for Drive's `appProperties.sourceUrl` field while
 * respecting Google Drive's 124-byte UTF-8 key+value limit.
 * URLs fitting within the limit are stored verbatim; longer URLs use a stable
 * SHA-256 digest so idempotency still holds without Drive returning HTTP 400.
 */
export async function encodeSourceUrlProperty(sourceUrl: string): Promise<string> {
  const normalized = sourceUrl.trim();
  const maxValueBytes =
    DRIVE_APP_PROPERTY_MAX_BYTES - textEncoder.encode(SOURCE_URL_PROPERTY_KEY).byteLength;
  const encoded = textEncoder.encode(normalized);

  if (encoded.byteLength <= maxValueBytes) {
    return normalized;
  }

  const digestBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const digestBytes = new Uint8Array(digestBuffer);
  let hex = '';
  for (let i = 0; i < digestBytes.length; i += 1) {
    hex += digestBytes[i].toString(16).padStart(2, '0');
  }
  return `sha256:${hex}`;
}

/**
 * Builds an RFC 2387 `multipart/related` binary payload for Google Drive v3
 * file uploads without corrupting binary media bytes through UTF-8 decoding.
 */
export function buildMultipartRelatedBody(params: {
  metadata: Record<string, unknown>;
  content: Uint8Array;
  contentType: string;
  boundary?: string;
}): { body: Uint8Array; contentTypeHeader: string } {
  const boundary =
    params.boundary ??
    `drive-clipper-${crypto.randomUUID().replace(/-/g, '')}`;

  const preamble = textEncoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(params.metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${params.contentType}\r\n\r\n`,
  );
  const epilogue = textEncoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(
    preamble.byteLength + params.content.byteLength + epilogue.byteLength,
  );
  body.set(preamble, 0);
  body.set(params.content, preamble.byteLength);
  body.set(epilogue, preamble.byteLength + params.content.byteLength);

  return {
    body,
    contentTypeHeader: `multipart/related; boundary=${boundary}`,
  };
}

interface CachedWebAuthToken {
  token: string;
  expiresAt: number;
}

let inMemoryWebAuthToken: CachedWebAuthToken | null = null;

function extractTokenValue(
  result: chrome.identity.GetAuthTokenResult | string | undefined,
): string | null {
  if (typeof result === 'string') {
    return result.trim().length > 0 ? result.trim() : null;
  }
  if (result && typeof result.token === 'string' && result.token.trim().length > 0) {
    return result.token.trim();
  }
  return null;
}

/**
 * Resolves the OAuth Client ID for `chrome.identity.launchWebAuthFlow`.
 * Prefers the optional build-time `webAuthClientId` (Web Application client
 * for non-Sync Chromium browsers like Ego Lite / Brave / Arc) and falls back
 * to `manifest.oauth2.client_id`.
 */
export function resolveWebAuthClientId(options?: {
  webAuthClientId?: string | null;
  manifestClientId?: string | null;
}): string | null {
  const configuredWebClient =
    options && 'webAuthClientId' in options
      ? options.webAuthClientId
      : getBuildWebAuthClientId();
  if (isConfiguredOAuthClientIdValue(configuredWebClient)) {
    return configuredWebClient.trim();
  }

  const manifestClient =
    options && 'manifestClientId' in options
      ? options.manifestClientId
      : typeof chrome !== 'undefined'
        ? chrome.runtime?.getManifest?.()?.oauth2?.client_id
        : undefined;
  if (isConfiguredOAuthClientIdValue(manifestClient)) {
    return manifestClient.trim();
  }

  return null;
}

function getSessionStorageArea():
  | {
      get(keys: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string): Promise<void>;
    }
  | null {
  if (
    typeof chrome !== 'undefined' &&
    chrome.storage?.session &&
    typeof chrome.storage.session.get === 'function' &&
    typeof chrome.storage.session.set === 'function' &&
    typeof chrome.storage.session.remove === 'function'
  ) {
    return chrome.storage.session;
  }
  return null;
}

function isValidCachedWebAuthToken(
  value: unknown,
  nowMs: number = Date.now(),
): value is CachedWebAuthToken {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CachedWebAuthToken>;
  return (
    typeof candidate.token === 'string' &&
    candidate.token.trim().length > 0 &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt - WEB_AUTH_TOKEN_EXPIRY_SKEW_MS > nowMs
  );
}

async function readCachedWebAuthToken(nowMs: number = Date.now()): Promise<string | null> {
  const session = getSessionStorageArea();
  if (session) {
    try {
      const stored = await session.get(STORAGE_KEYS.webAuthToken);
      const entry = stored[STORAGE_KEYS.webAuthToken];
      if (isValidCachedWebAuthToken(entry, nowMs)) {
        inMemoryWebAuthToken = entry;
        return entry.token;
      }
      if (entry !== undefined) {
        await session.remove(STORAGE_KEYS.webAuthToken).catch(() => undefined);
      }
    } catch {
      // Fall back to in-memory cache if session storage is temporarily inaccessible.
    }
  }

  if (isValidCachedWebAuthToken(inMemoryWebAuthToken, nowMs)) {
    return inMemoryWebAuthToken.token;
  }
  inMemoryWebAuthToken = null;
  return null;
}

async function writeCachedWebAuthToken(entry: CachedWebAuthToken): Promise<void> {
  inMemoryWebAuthToken = entry;
  const session = getSessionStorageArea();
  if (session) {
    try {
      await session.set({ [STORAGE_KEYS.webAuthToken]: entry });
    } catch {
      // In-memory cache still holds the token for this service worker lifetime.
    }
  }
}

export async function clearCachedWebAuthToken(matchingToken?: string): Promise<void> {
  if (!matchingToken || inMemoryWebAuthToken?.token === matchingToken) {
    inMemoryWebAuthToken = null;
  }
  const session = getSessionStorageArea();
  if (!session) {
    return;
  }
  try {
    if (!matchingToken) {
      await session.remove(STORAGE_KEYS.webAuthToken);
      return;
    }
    const stored = await session.get(STORAGE_KEYS.webAuthToken);
    const entry = stored[STORAGE_KEYS.webAuthToken] as Partial<CachedWebAuthToken> | undefined;
    if (entry?.token === matchingToken) {
      await session.remove(STORAGE_KEYS.webAuthToken);
    }
  } catch {
    // Ignore storage cleanup errors when clearing expired or revoked tokens.
  }
}

/**
 * Determines whether a `chrome.identity.getAuthToken` failure indicates that
 * Chromium browser sign-in is unavailable or the configured OAuth Client ID is
 * a Web Application client meant for `chrome.identity.launchWebAuthFlow`.
 */
export function shouldFallbackToWebAuthFlow(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  if (
    normalized.includes('did not approve') ||
    normalized.includes('user canceled') ||
    normalized.includes('user cancelled') ||
    normalized.includes('access_denied')
  ) {
    return false;
  }
  return (
    normalized.includes('browser signin') ||
    normalized.includes('not signed in') ||
    normalized.includes('not supported') ||
    normalized.includes('bad client id') ||
    normalized.includes('invalid_client') ||
    normalized.includes('oauth2 request failed') ||
    normalized.includes('oauth2 not granted') ||
    normalized.includes('no account') ||
    normalized.includes('chrome sign-in')
  );
}

/**
 * Builds the Google OAuth 2.0 authorization URL for `launchWebAuthFlow`
 * strictly scoped to `https://www.googleapis.com/auth/drive.file`.
 */
export function buildGoogleWebAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  authEndpoint?: string;
}): string {
  const url = new URL(params.authEndpoint ?? GOOGLE_OAUTH_AUTH_ENDPOINT);
  url.searchParams.set('client_id', params.clientId.trim());
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', DRIVE_FILE_SCOPE);
  url.searchParams.set('state', params.state);
  return url.toString();
}

/**
 * Parses and validates the redirect callback URL returned by
 * `chrome.identity.launchWebAuthFlow`, verifying the CSRF `state` nonce.
 */
export function parseWebAuthFlowRedirect(
  redirectUrl: string,
  expectedState: string,
  nowMs: number = Date.now(),
): CachedWebAuthToken {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    throw new DriveApiError('Google authentication returned a malformed redirect URL.', {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  const fragmentParams = new URLSearchParams(
    parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash,
  );
  const queryParams = parsed.searchParams;
  const readParam = (key: string): string | null =>
    fragmentParams.get(key) ?? queryParams.get(key);

  const oauthError = readParam('error');
  if (oauthError) {
    const description = readParam('error_description');
    const detail = description ? `${oauthError}: ${description}` : oauthError;
    throw new DriveApiError(`Google web sign-in failed (${detail}).`, {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  const returnedState = readParam('state');
  if (!returnedState || returnedState !== expectedState) {
    throw new DriveApiError(
      'Google web sign-in failed: OAuth state verification mismatch.',
      {
        status: 401,
        code: 'AUTH_REQUIRED',
      },
    );
  }

  const token = readParam('access_token')?.trim();
  if (!token) {
    throw new DriveApiError(
      'Google web sign-in did not return an access token.',
      {
        status: 401,
        code: 'AUTH_REQUIRED',
      },
    );
  }

  const expiresInRaw = Number(readParam('expires_in'));
  const expiresInSeconds =
    Number.isFinite(expiresInRaw) && expiresInRaw > 0
      ? Math.max(60, Math.floor(expiresInRaw))
      : DEFAULT_WEB_AUTH_EXPIRES_IN_SECONDS;

  return {
    token,
    expiresAt: nowMs + expiresInSeconds * 1000,
  };
}

async function launchChromeDriveWebAuthFlow(options: {
  interactive: boolean;
  webAuthClientId?: string | null;
}): Promise<string> {
  if (
    typeof chrome === 'undefined' ||
    !chrome.identity?.launchWebAuthFlow ||
    !chrome.identity?.getRedirectURL
  ) {
    throw new DriveApiError('chrome.identity.launchWebAuthFlow is unavailable.', {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  const clientId = resolveWebAuthClientId(
    'webAuthClientId' in options
      ? { webAuthClientId: options.webAuthClientId }
      : undefined,
  );
  if (!clientId) {
    throw new DriveApiError(
      'Google OAuth Client ID is not configured in config.local.json.',
      {
        status: 401,
        code: 'AUTH_REQUIRED',
      },
    );
  }

  const redirectUri = normalizeWebAuthRedirectUri(
    chrome.identity.getRedirectURL(),
  );
  const state = crypto.randomUUID();
  const authUrl = buildGoogleWebAuthUrl({ clientId, redirectUri, state });

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: options.interactive,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DriveApiError(`Google web sign-in failed: ${message}`, {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  if (!responseUrl) {
    throw new DriveApiError('Google web sign-in was cancelled before completing.', {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  const parsed = parseWebAuthFlowRedirect(responseUrl, state);
  await writeCachedWebAuthToken(parsed);
  return parsed.token;
}

/**
 * Acquires a Google OAuth2 access token strictly scoped to
 * `https://www.googleapis.com/auth/drive.file`.
 *
 * Uses `chrome.identity.getAuthToken` when Chrome browser sign-in is active,
 * and falls back to `chrome.identity.launchWebAuthFlow` with session token
 * caching on Chromium browsers where browser sign-in is disabled (such as Ego
 * Lite, Brave, Arc, or unbranded Chromium) or when using a Web Application
 * OAuth Client ID.
 */
export async function getChromeDriveAuthToken(options: {
  interactive: boolean;
  webAuthClientId?: string | null;
}): Promise<string> {
  const cachedWebToken = await readCachedWebAuthToken();
  if (cachedWebToken) {
    return cachedWebToken;
  }

  const hasGetAuthToken =
    typeof chrome !== 'undefined' && typeof chrome.identity?.getAuthToken === 'function';
  const hasWebAuthFlow =
    typeof chrome !== 'undefined' &&
    typeof chrome.identity?.launchWebAuthFlow === 'function' &&
    typeof chrome.identity?.getRedirectURL === 'function';

  if (!hasGetAuthToken && !hasWebAuthFlow) {
    throw new DriveApiError('chrome.identity API is unavailable.', {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  let getAuthTokenError: Error | null = null;
  if (hasGetAuthToken) {
    try {
      const result = await chrome.identity.getAuthToken({
        interactive: options.interactive,
        scopes: [DRIVE_FILE_SCOPE],
      });
      const token = extractTokenValue(result);
      if (token) {
        return token;
      }
      getAuthTokenError = new DriveApiError(
        'Google authentication did not return an access token.',
        { status: 401, code: 'AUTH_REQUIRED' },
      );
    } catch (error) {
      getAuthTokenError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  if (
    options.interactive &&
    hasWebAuthFlow &&
    (!hasGetAuthToken ||
      (getAuthTokenError !== null &&
        shouldFallbackToWebAuthFlow(getAuthTokenError.message)))
  ) {
    return launchChromeDriveWebAuthFlow({
      interactive: true,
      ...('webAuthClientId' in options
        ? { webAuthClientId: options.webAuthClientId }
        : {}),
    });
  }

  if (getAuthTokenError instanceof DriveApiError) {
    throw getAuthTokenError;
  }

  const message = getAuthTokenError?.message ?? 'User is not signed in.';
  throw new DriveApiError(`Google authentication failed: ${message}`, {
    status: 401,
    code: 'AUTH_REQUIRED',
  });
}

export async function removeCachedChromeAuthToken(token: string): Promise<void> {
  await clearCachedWebAuthToken(token);
  if (typeof chrome === 'undefined' || !chrome.identity?.removeCachedAuthToken) {
    return;
  }
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    // Non-Sync Chromium builds may reject Chrome token-cache APIs; session cache is already cleared.
  }
}

export async function clearAllCachedChromeAuthTokens(): Promise<void> {
  await clearCachedWebAuthToken();
  if (
    typeof chrome === 'undefined' ||
    !chrome.identity ||
    typeof chrome.identity.clearAllCachedAuthTokens !== 'function'
  ) {
    return;
  }
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch {
    // Non-Sync Chromium builds may reject clearAllCachedAuthTokens when browser sign-in is disabled.
  }
}

/**
 * Removes the token from Chrome's identity cache and best-effort revokes it
 * with Google's OAuth2 revocation endpoint.
 */
export async function revokeChromeAuthToken(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  await removeCachedChromeAuthToken(token);
  try {
    await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `token=${encodeURIComponent(token)}`,
    });
  } catch {
    // Local cache is already cleared; remote revoke failure should not block sign-out.
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.min(Math.max(delta, 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

function isRetryableDriveError(status: number, bodyText: string): boolean {
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  if (status === 403) {
    return (
      bodyText.includes('rateLimitExceeded') ||
      bodyText.includes('userRateLimitExceeded')
    );
  }
  return false;
}

function formatDriveErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string };
    };
    const apiMessage = parsed.error?.message?.trim();
    if (apiMessage) {
      return `Google Drive API error (${status}): ${apiMessage}`;
    }
  } catch {
    // Fall back to raw text snippet.
  }
  const snippet = bodyText.trim().slice(0, 200);
  return snippet.length > 0
    ? `Google Drive API error (${status}): ${snippet}`
    : `Google Drive API error (${status})`;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Drive operation aborted', 'AbortError');
  }
  const err = new Error('Drive operation aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Minimal Google Drive API v3 client scoped strictly to `drive.file`.
 */
export class DriveClient {
  private readonly apiBaseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: DriveTokenProvider;
  private readonly onUnauthorizedToken?: (token: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly uploadConcurrency: number;

  constructor(options: DriveClientOptions = {}) {
    const normalizedOrigin = stripTrailingSlashes(
      options.baseUrl ?? DEFAULT_DRIVE_BASE_URL,
    );
    this.apiBaseUrl = stripTrailingSlashes(
      options.apiBaseUrl ?? `${normalizedOrigin}/drive/v3`,
    );
    this.uploadBaseUrl = stripTrailingSlashes(
      options.uploadBaseUrl ?? `${normalizedOrigin}/upload/drive/v3`,
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.tokenProvider = options.tokenProvider ?? getChromeDriveAuthToken;
    this.onUnauthorizedToken =
      options.onUnauthorizedToken ??
      (options.tokenProvider && options.tokenProvider !== getChromeDriveAuthToken
        ? undefined
        : removeCachedChromeAuthToken);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.baseRetryDelayMs = Math.max(
      1,
      options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
    );
    this.uploadConcurrency = Math.max(
      1,
      Math.floor(options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY),
    );
  }

  private async requestJson<T>(
    url: string,
    init: {
      method: 'GET' | 'POST' | 'PATCH';
      headers?: Record<string, string>;
      body?: BodyInit;
      interactive?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const interactive = init.interactive ?? true;
    let token = await this.tokenProvider({ interactive });
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt += 1) {
      if (init.signal?.aborted) {
        throw createAbortError();
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      };

      const response = await this.fetchImpl(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
      });

      if (response.ok) {
        if (response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      }

      const bodyText = await response.text().catch(() => '');

      if (
        response.status === 401 &&
        !refreshedAfter401 &&
        this.onUnauthorizedToken
      ) {
        refreshedAfter401 = true;
        await this.onUnauthorizedToken(token);
        token = await this.tokenProvider({ interactive });
        attempt -= 1;
        continue;
      }

      const retryable = isRetryableDriveError(response.status, bodyText);
      if (retryable && attempt < this.maxRetries) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after'),
        );
        const backoffMs =
          retryAfterMs ?? this.baseRetryDelayMs * 2 ** attempt;
        if (init.signal?.aborted) {
          throw createAbortError();
        }
        await this.sleep(backoffMs);
        continue;
      }

      throw new DriveApiError(
        formatDriveErrorMessage(response.status, bodyText),
        {
          status: response.status,
          code: response.status === 401 ? 'AUTH_REQUIRED' : 'DRIVE_API_ERROR',
          retryable,
        },
      );
    }
  }

  /**
   * Verifies a persisted extension-owned root folder by ID (supporting user
   * moves/renames transparently), or creates a new root folder on first use /
   * when trashed or missing.
   */
  async ensureRootFolder(
    params: EnsureRootFolderParams,
  ): Promise<RootFolderInfo> {
    const desiredName = params.rootFolderName.trim() || 'WebClips';
    const interactive = params.interactive ?? true;

    if (!params.forceNew && params.rootFolderId) {
      try {
        const existing = await this.requestJson<DriveFileResource>(
          `${this.apiBaseUrl}/files/${encodeURIComponent(params.rootFolderId)}?fields=id,name,mimeType,trashed`,
          {
            method: 'GET',
            interactive,
            signal: params.signal,
          },
        );

        if (
          existing.id &&
          existing.trashed !== true &&
          existing.mimeType === DRIVE_FOLDER_MIME_TYPE
        ) {
          return {
            folderId: existing.id,
            folderName: existing.name?.trim() || desiredName,
            folderUrl: buildDriveFolderUrl(existing.id),
            created: false,
          };
        }
      } catch (error) {
        // Recreate only when Drive explicitly reports the stored folder is gone.
        if (!(error instanceof DriveApiError) || error.status !== 404) {
          throw error;
        }
      }
    }

    const created = await this.requestJson<DriveFileResource>(
      `${this.apiBaseUrl}/files?fields=id,name`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          name: desiredName,
          mimeType: DRIVE_FOLDER_MIME_TYPE,
          appProperties: {
            driveClipperRole: 'root',
          },
        }),
        interactive,
        signal: params.signal,
      },
    );

    if (!created.id) {
      throw new DriveApiError('Drive folder creation returned no folder ID.', {
        status: 500,
      });
    }

    return {
      folderId: created.id,
      folderName: created.name?.trim() || desiredName,
      folderUrl: buildDriveFolderUrl(created.id),
      created: true,
    };
  }

  /**
   * Finds an existing non-trashed article folder under `rootFolderId` matching
   * `appProperties.sourceUrl`, or creates a new one if none exists.
   */
  async findOrCreateArticleFolder(params: {
    rootFolderId: string;
    folderName: string;
    sourceUrl: string;
    interactive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ folderId: string; folderName: string; reused: boolean }> {
    const sourceUrlValue = await encodeSourceUrlProperty(params.sourceUrl);
    const query =
      `'${escapeDriveQueryValue(params.rootFolderId)}' in parents ` +
      `and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' ` +
      `and trashed = false ` +
      `and appProperties has { key='${SOURCE_URL_PROPERTY_KEY}' and value='${escapeDriveQueryValue(sourceUrlValue)}' }`;

    const searchUrl =
      `${this.apiBaseUrl}/files?` +
      new URLSearchParams({
        q: query,
        fields: 'files(id,name,trashed)',
        spaces: 'drive',
        pageSize: '1',
      }).toString();

    const list = await this.requestJson<DriveFileListResponse>(searchUrl, {
      method: 'GET',
      interactive: params.interactive,
      signal: params.signal,
    });

    const existing = list.files?.find((file) => file.id && file.trashed !== true);
    if (existing) {
      return {
        folderId: existing.id,
        folderName: existing.name?.trim() || params.folderName,
        reused: true,
      };
    }

    const created = await this.requestJson<DriveFileResource>(
      `${this.apiBaseUrl}/files?fields=id,name`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          name: params.folderName,
          mimeType: DRIVE_FOLDER_MIME_TYPE,
          parents: [params.rootFolderId],
          appProperties: {
            [SOURCE_URL_PROPERTY_KEY]: sourceUrlValue,
          },
        }),
        interactive: params.interactive,
        signal: params.signal,
      },
    );

    if (!created.id) {
      throw new DriveApiError('Article folder creation returned no folder ID.', {
        status: 500,
      });
    }

    return {
      folderId: created.id,
      folderName: created.name?.trim() || params.folderName,
      reused: false,
    };
  }

  /**
   * Finds or creates a named subfolder (such as `images`) inside `parentFolderId`.
   */
  async findOrCreateSubfolder(params: {
    parentFolderId: string;
    name: string;
    interactive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ folderId: string; reused: boolean }> {
    const query =
      `'${escapeDriveQueryValue(params.parentFolderId)}' in parents ` +
      `and name = '${escapeDriveQueryValue(params.name)}' ` +
      `and mimeType = '${DRIVE_FOLDER_MIME_TYPE}' ` +
      `and trashed = false`;

    const searchUrl =
      `${this.apiBaseUrl}/files?` +
      new URLSearchParams({
        q: query,
        fields: 'files(id,name,trashed)',
        spaces: 'drive',
        pageSize: '1',
      }).toString();

    const list = await this.requestJson<DriveFileListResponse>(searchUrl, {
      method: 'GET',
      interactive: params.interactive,
      signal: params.signal,
    });

    const existing = list.files?.find((file) => file.id && file.trashed !== true);
    if (existing) {
      return { folderId: existing.id, reused: true };
    }

    const created = await this.requestJson<DriveFileResource>(
      `${this.apiBaseUrl}/files?fields=id,name`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          name: params.name,
          mimeType: DRIVE_FOLDER_MIME_TYPE,
          parents: [params.parentFolderId],
        }),
        interactive: params.interactive,
        signal: params.signal,
      },
    );

    if (!created.id) {
      throw new DriveApiError(
        `Subfolder creation for "${params.name}" returned no folder ID.`,
        { status: 500 },
      );
    }

    return { folderId: created.id, reused: false };
  }

  /**
   * Lists non-trashed direct child files under `parentFolderId` indexed by name.
   */
  async listChildFilesByName(
    parentFolderId: string,
    options?: { interactive?: boolean; signal?: AbortSignal },
  ): Promise<Map<string, string>> {
    const byName = new Map<string, string>();
    const query =
      `'${escapeDriveQueryValue(parentFolderId)}' in parents ` +
      `and mimeType != '${DRIVE_FOLDER_MIME_TYPE}' ` +
      `and trashed = false`;

    let pageToken: string | undefined;
    do {
      const searchParams = new URLSearchParams({
        q: query,
        fields: 'nextPageToken,files(id,name,trashed)',
        spaces: 'drive',
        pageSize: '100',
      });
      if (pageToken) {
        searchParams.set('pageToken', pageToken);
      }

      const list = await this.requestJson<DriveFileListResponse>(
        `${this.apiBaseUrl}/files?${searchParams.toString()}`,
        {
          method: 'GET',
          interactive: options?.interactive,
          signal: options?.signal,
        },
      );

      for (const file of list.files ?? []) {
        if (file.id && file.name && file.trashed !== true && !byName.has(file.name)) {
          byName.set(file.name, file.id);
        }
      }

      pageToken = list.nextPageToken;
    } while (pageToken);

    return byName;
  }

  /**
   * Uploads or updates a file via Drive API v3 `multipart/related`.
   */
  async uploadMultipartFile(params: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    parentFolderId: string;
    existingFileId?: string;
    interactive?: boolean;
    signal?: AbortSignal;
  }): Promise<{ id: string; name: string; mimeType: string }> {
    const isUpdate = Boolean(params.existingFileId);
    // Drive v3 PATCH rejects `parents` in the metadata body; only POST includes it.
    const metadata: Record<string, unknown> = isUpdate
      ? { name: params.name, mimeType: params.mimeType }
      : {
          name: params.name,
          mimeType: params.mimeType,
          parents: [params.parentFolderId],
        };

    const { body, contentTypeHeader } = buildMultipartRelatedBody({
      metadata,
      content: params.bytes,
      contentType: params.mimeType,
    });

    // Copy into an ArrayBuffer-backed Uint8Array so BodyInit satisfies strict DOM typing.
    const uploadBody = new Uint8Array(body.byteLength);
    uploadBody.set(body);

    const endpoint = isUpdate
      ? `${this.uploadBaseUrl}/files/${encodeURIComponent(params.existingFileId!)}?uploadType=multipart&fields=id,name,mimeType`
      : `${this.uploadBaseUrl}/files?uploadType=multipart&fields=id,name,mimeType`;

    const uploaded = await this.requestJson<DriveFileResource>(endpoint, {
      method: isUpdate ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': contentTypeHeader,
      },
      body: uploadBody,
      interactive: params.interactive,
      signal: params.signal,
    });

    if (!uploaded.id) {
      throw new DriveApiError(
        `Multipart upload for "${params.name}" returned no file ID.`,
        { status: 500 },
      );
    }

    return {
      id: uploaded.id,
      name: uploaded.name ?? params.name,
      mimeType: uploaded.mimeType ?? params.mimeType,
    };
  }

  /**
   * Uploads a clipped article with strict ordering:
   * 1. Find or create idempotent article folder (`appProperties.sourceUrl`).
   * 2. Upload ALL downloaded images into `images/` with bounded concurrency and await all.
   * 3. Rewrite Markdown links and generate YAML frontmatter.
   * 4. Upload `README.md` LAST.
   */
  async uploadArticle(params: UploadArticleParams): Promise<ClipResult> {
    const clippedAt = params.clippedAt ?? new Date().toISOString();
    const finalTitle =
      params.title?.trim() || params.page.title.trim() || 'Untitled';
    const requestedFolderName =
      params.folderName?.trim() || buildArticleFolderName(finalTitle, clippedAt);
    const interactive = params.interactive ?? true;
    const concurrency = Math.max(
      1,
      Math.floor(params.uploadConcurrency ?? this.uploadConcurrency),
    );

    const articleFolder = await this.findOrCreateArticleFolder({
      rootFolderId: params.rootFolderId,
      folderName: requestedFolderName,
      sourceUrl: params.page.url,
      interactive,
      signal: params.signal,
    });

    const totalUploads = params.fetchedImages.length + 1;
    let completedUploads = 0;
    params.onProgress?.(0, totalUploads);

    // Phase 1: Upload all downloaded images and wait for every upload to finish.
    const uploadedImages: UploadedImageInfo[] = new Array(
      params.fetchedImages.length,
    );

    if (params.fetchedImages.length > 0) {
      const imagesFolder = await this.findOrCreateSubfolder({
        parentFolderId: articleFolder.folderId,
        name: 'images',
        interactive,
        signal: params.signal,
      });

      const existingImages = imagesFolder.reused
        ? await this.listChildFilesByName(imagesFolder.folderId, {
            interactive,
            signal: params.signal,
          })
        : new Map<string, string>();

      let nextIndex = 0;
      const workerCount = Math.min(concurrency, params.fetchedImages.length);
      const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
          if (params.signal?.aborted) {
            throw createAbortError();
          }
          const idx = nextIndex;
          if (idx >= params.fetchedImages.length) {
            return;
          }
          nextIndex += 1;

          const image = params.fetchedImages[idx];
          const uploaded = await this.uploadMultipartFile({
            name: image.filename,
            mimeType: image.mimeType,
            bytes: image.bytes,
            parentFolderId: imagesFolder.folderId,
            existingFileId: existingImages.get(image.filename),
            interactive,
            signal: params.signal,
          });

          uploadedImages[idx] = {
            id: image.id,
            filename: image.filename,
            fileId: uploaded.id,
            mimeType: image.mimeType,
            resolvedUrl: image.resolvedUrl,
          };

          completedUploads += 1;
          params.onProgress?.(completedUploads, totalUploads);
        }
      });

      await Promise.all(workers);
    }

    // Phase 2: Rewrite Markdown image links and build YAML frontmatter.
    const failedImages = [...(params.failedImages ?? [])];
    const rewriteResult = rewriteMarkdownImageUrls(
      params.page.markdown,
      params.page.url,
      params.fetchedImages,
      failedImages,
    );

    const allWarnings = Array.from(
      new Set(
        [...params.page.warnings, ...rewriteResult.warnings]
          .map((w) => w.trim())
          .filter((w) => w.length > 0),
      ),
    );

    const frontmatterImagePaths = [...rewriteResult.localImagePaths];
    const seenImagePaths = new Set(frontmatterImagePaths);
    for (const img of uploadedImages) {
      const localPath = `./images/${img.filename}`;
      if (!seenImagePaths.has(localPath)) {
        seenImagePaths.add(localPath);
        frontmatterImagePaths.push(localPath);
      }
    }

    const frontmatter = buildFrontmatter(
      {
        title: finalTitle,
        url: params.page.url,
        author: params.page.author,
        published: params.page.published,
        clipped: clippedAt,
        site: params.page.site,
        tags: params.tags ? [...params.tags] : [],
        images: frontmatterImagePaths,
        warnings: allWarnings,
      },
      params.frontmatterPreferences,
    );

    const readmeContent = composeMarkdownDocument(
      frontmatter,
      rewriteResult.markdown,
    );

    // Phase 3: Upload README.md strictly AFTER all images have completed.
    let existingReadmeId: string | undefined;
    if (articleFolder.reused) {
      const existingArticleFiles = await this.listChildFilesByName(
        articleFolder.folderId,
        {
          interactive,
          signal: params.signal,
        },
      );
      existingReadmeId = existingArticleFiles.get('README.md');
    }

    const readmeFile = await this.uploadMultipartFile({
      name: 'README.md',
      mimeType: 'text/markdown',
      bytes: textEncoder.encode(readmeContent),
      parentFolderId: articleFolder.folderId,
      existingFileId: existingReadmeId,
      interactive,
      signal: params.signal,
    });

    completedUploads += 1;
    params.onProgress?.(completedUploads, totalUploads);

    return {
      folderId: articleFolder.folderId,
      folderUrl: buildDriveFolderUrl(articleFolder.folderId),
      folderName: articleFolder.folderName,
      readmeFileId: readmeFile.id,
      title: finalTitle,
      sourceUrl: params.page.url,
      clippedAt,
      uploadedImages,
      failedImages,
      warnings: allWarnings,
      reusedFolder: articleFolder.reused,
    };
  }
}
