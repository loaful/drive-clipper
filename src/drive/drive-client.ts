import {
  appendClipLogMarkdown,
  buildArticleFileName,
  buildArticleFolderName,
  buildFrontmatter,
  composeMarkdownDocument,
  extractPlainTextExcerpt,
  upsertRootIndexMarkdown,
  type RootIndexEntry,
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
/**
 * Google Drive API v3 rejects `uploadType=multipart` above 5 MB total payload
 * (including JSON metadata and MIME boundaries). Switch to `uploadType=resumable`
 * above 4.5 MiB so high-res images up to `maxImageSizeBytes` (15 MiB) upload cleanly.
 */
export const MULTIPART_UPLOAD_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const GOOGLE_OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const WEB_AUTH_TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_WEB_AUTH_EXPIRES_IN_SECONDS = 3600;

// Google Drive v3 appProperties limits each entry to 124 UTF-8 bytes (key + value).
const DRIVE_APP_PROPERTY_MAX_BYTES = 124;
const SOURCE_URL_PROPERTY_KEY = 'sourceUrl';
const IMAGE_URL_PROPERTY_KEY = 'imageUrl';
const ROLE_PROPERTY_KEY = 'driveClipperRole';
const ARTICLE_ROLE_VALUE = 'article';
const ROOT_INDEX_FILENAME = 'index.md';
const ROOT_LOG_FILENAME = 'log.md';
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

export interface UpdateBundleIndexAndLogParams {
  rootFolderId: string;
  rootFolderName: string;
  entry: Omit<RootIndexEntry, 'rootFolderName'>;
  action: 'clipped' | 'updated';
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface UpdateBundleIndexAndLogResult {
  indexFileId: string;
  logFileId: string;
}

interface DriveFileResource {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export interface UploadFileParams {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  parentFolderId: string;
  existingFileId?: string;
  appProperties?: Record<string, string>;
  interactive?: boolean;
  signal?: AbortSignal;
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
  clientId?: string;
  isCustomClient?: boolean;
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

function isMatchingCachedWebAuthToken(
  entry: CachedWebAuthToken,
  customClientId: string | null,
): boolean {
  if (customClientId !== null) {
    return entry.isCustomClient === true && entry.clientId === customClientId;
  }
  return entry.isCustomClient !== true;
}

async function readCachedWebAuthToken(
  customClientId: string | null = null,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const session = getSessionStorageArea();
  if (session) {
    try {
      const stored = await session.get(STORAGE_KEYS.webAuthToken);
      const entry = stored[STORAGE_KEYS.webAuthToken];
      if (isValidCachedWebAuthToken(entry, nowMs)) {
        inMemoryWebAuthToken = entry;
        return isMatchingCachedWebAuthToken(entry, customClientId)
          ? entry.token
          : null;
      }
      if (entry !== undefined) {
        await session.remove(STORAGE_KEYS.webAuthToken).catch(() => undefined);
      }
    } catch {
      // Fall back to in-memory cache if session storage is temporarily inaccessible.
    }
  }

  if (isValidCachedWebAuthToken(inMemoryWebAuthToken, nowMs)) {
    return isMatchingCachedWebAuthToken(inMemoryWebAuthToken, customClientId)
      ? inMemoryWebAuthToken.token
      : null;
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
  isCustomClient?: boolean;
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

  const clientId = options.isCustomClient
    ? isConfiguredOAuthClientIdValue(options.webAuthClientId)
      ? options.webAuthClientId.trim()
      : null
    : resolveWebAuthClientId(
        'webAuthClientId' in options
          ? { webAuthClientId: options.webAuthClientId }
          : undefined,
      );
  if (!clientId) {
    throw new DriveApiError(
      'Google OAuth Client ID is not configured. Configure a Custom Web OAuth Client ID in Settings or config.local.json.',
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
  await writeCachedWebAuthToken({
    ...parsed,
    clientId,
    isCustomClient: Boolean(options.isCustomClient),
  });
  return parsed.token;
}

/**
 * Acquires a Google OAuth2 access token strictly scoped to
 * `https://www.googleapis.com/auth/drive.file`.
 *
 * When a valid non-placeholder `customWebAuthClientId` is provided, bypasses
 * `chrome.identity.getAuthToken()` completely and authenticates directly via
 * `chrome.identity.launchWebAuthFlow` with session caching so users on any
 * Chromium browser can connect their own GCP Web Application OAuth Client ID
 * at runtime.
 *
 * Otherwise, uses `chrome.identity.getAuthToken` when Chrome browser sign-in
 * is active, and falls back to `chrome.identity.launchWebAuthFlow` with session
 * token caching on Chromium browsers where browser sign-in is disabled (such as
 * Ego Lite, Brave, Arc, or unbranded Chromium) or when using a Web Application
 * OAuth Client ID.
 */
export async function getChromeDriveAuthToken(options: {
  interactive: boolean;
  webAuthClientId?: string | null;
  customWebAuthClientId?: string | null;
}): Promise<string> {
  const customClientId = isConfiguredOAuthClientIdValue(
    options.customWebAuthClientId,
  )
    ? options.customWebAuthClientId.trim()
    : null;

  const hasWebAuthFlow =
    typeof chrome !== 'undefined' &&
    typeof chrome.identity?.launchWebAuthFlow === 'function' &&
    typeof chrome.identity?.getRedirectURL === 'function';

  if (customClientId !== null) {
    const cachedCustomToken = await readCachedWebAuthToken(customClientId);
    if (cachedCustomToken) {
      return cachedCustomToken;
    }

    if (!hasWebAuthFlow) {
      throw new DriveApiError('chrome.identity.launchWebAuthFlow is unavailable.', {
        status: 401,
        code: 'AUTH_REQUIRED',
      });
    }

    if (!options.interactive) {
      throw new DriveApiError('User is not signed in.', {
        status: 401,
        code: 'AUTH_REQUIRED',
      });
    }

    return launchChromeDriveWebAuthFlow({
      interactive: true,
      webAuthClientId: customClientId,
      isCustomClient: true,
    });
  }

  const cachedWebToken = await readCachedWebAuthToken(null);
  if (cachedWebToken) {
    return cachedWebToken;
  }

  const hasGetAuthToken =
    typeof chrome !== 'undefined' && typeof chrome.identity?.getAuthToken === 'function';

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
      isCustomClient: false,
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

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
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

  private async requestWithRetry(
    url: string,
    init: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      headers?: Record<string, string>;
      body?: BodyInit;
      interactive?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
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
        return response;
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

  private async requestJson<T>(
    url: string,
    init: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT';
      headers?: Record<string, string>;
      body?: BodyInit;
      interactive?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const response = await this.requestWithRetry(url, init);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
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

  private async listChildFiles(
    parentFolderId: string,
    options?: { interactive?: boolean; signal?: AbortSignal },
  ): Promise<{
    byName: Map<string, string>;
    byImageUrl: Map<string, string>;
    articleFileId?: string;
  }> {
    const byName = new Map<string, string>();
    const byImageUrl = new Map<string, string>();
    let articleFileId: string | undefined;
    const query =
      `'${escapeDriveQueryValue(parentFolderId)}' in parents ` +
      `and mimeType != '${DRIVE_FOLDER_MIME_TYPE}' ` +
      `and trashed = false`;

    let pageToken: string | undefined;
    do {
      const searchParams = new URLSearchParams({
        q: query,
        fields: 'nextPageToken,files(id,name,trashed,appProperties)',
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
        if (!file.id || file.trashed === true) {
          continue;
        }
        if (file.name && !byName.has(file.name)) {
          byName.set(file.name, file.id);
        }
        const imageUrlKey = file.appProperties?.[IMAGE_URL_PROPERTY_KEY];
        if (imageUrlKey && !byImageUrl.has(imageUrlKey)) {
          byImageUrl.set(imageUrlKey, file.id);
        }
        if (
          !articleFileId &&
          file.appProperties?.[ROLE_PROPERTY_KEY] === ARTICLE_ROLE_VALUE
        ) {
          articleFileId = file.id;
        }
      }

      pageToken = list.nextPageToken;
    } while (pageToken);

    return { byName, byImageUrl, articleFileId };
  }

  /**
   * Lists non-trashed direct child files under `parentFolderId` indexed by name.
   */
  async listChildFilesByName(
    parentFolderId: string,
    options?: { interactive?: boolean; signal?: AbortSignal },
  ): Promise<Map<string, string>> {
    const { byName } = await this.listChildFiles(parentFolderId, options);
    return byName;
  }

  /**
   * Downloads a UTF-8 text file's raw contents via Drive API v3 `alt=media`.
   */
  async downloadTextFile(
    fileId: string,
    options?: { interactive?: boolean; signal?: AbortSignal },
  ): Promise<string> {
    const response = await this.requestWithRetry(
      `${this.apiBaseUrl}/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        method: 'GET',
        interactive: options?.interactive,
        signal: options?.signal,
      },
    );
    return response.text();
  }

  /**
   * Uploads or updates a file via Drive API v3 `multipart/related` (for files
   * `<= MULTIPART_UPLOAD_MAX_BYTES`).
   */
  async uploadMultipartFile(
    params: UploadFileParams,
  ): Promise<{ id: string; name: string; mimeType: string }> {
    const isUpdate = Boolean(params.existingFileId);
    // Drive v3 PATCH rejects `parents` in the metadata body; only POST includes it.
    const metadata: Record<string, unknown> = isUpdate
      ? {
          name: params.name,
          mimeType: params.mimeType,
          ...(params.appProperties ? { appProperties: params.appProperties } : {}),
        }
      : {
          name: params.name,
          mimeType: params.mimeType,
          parents: [params.parentFolderId],
          ...(params.appProperties ? { appProperties: params.appProperties } : {}),
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
   * Uploads or updates a large file via Drive API v3 two-step `uploadType=resumable`
   * protocol (required for payloads exceeding Google Drive's 5 MB multipart limit).
   */
  async uploadResumableFile(
    params: UploadFileParams,
  ): Promise<{ id: string; name: string; mimeType: string }> {
    const isUpdate = Boolean(params.existingFileId);
    const metadata: Record<string, unknown> = isUpdate
      ? {
          name: params.name,
          mimeType: params.mimeType,
          ...(params.appProperties ? { appProperties: params.appProperties } : {}),
        }
      : {
          name: params.name,
          mimeType: params.mimeType,
          parents: [params.parentFolderId],
          ...(params.appProperties ? { appProperties: params.appProperties } : {}),
        };

    const initEndpoint = isUpdate
      ? `${this.uploadBaseUrl}/files/${encodeURIComponent(params.existingFileId!)}?uploadType=resumable&fields=id,name,mimeType`
      : `${this.uploadBaseUrl}/files?uploadType=resumable&fields=id,name,mimeType`;

    const initResponse = await this.requestWithRetry(initEndpoint, {
      method: isUpdate ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': params.mimeType,
        'X-Upload-Content-Length': String(params.bytes.byteLength),
      },
      body: JSON.stringify(metadata),
      interactive: params.interactive,
      signal: params.signal,
    });

    const rawLocation = initResponse.headers.get('location')?.trim();
    if (!rawLocation) {
      throw new DriveApiError(
        `Resumable upload initiation for "${params.name}" returned no Location header.`,
        { status: 500 },
      );
    }

    const sessionUrl = new URL(rawLocation, initEndpoint).toString();
    const uploadBody = new Uint8Array(params.bytes.byteLength);
    uploadBody.set(params.bytes);

    const uploaded = await this.requestJson<DriveFileResource>(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': params.mimeType,
      },
      body: uploadBody,
      interactive: params.interactive,
      signal: params.signal,
    });

    if (!uploaded.id) {
      throw new DriveApiError(
        `Resumable upload for "${params.name}" returned no file ID.`,
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
   * Automatically selects `uploadType=multipart` for payloads `<= 4.5 MiB`
   * and `uploadType=resumable` for larger payloads.
   */
  async uploadFile(
    params: UploadFileParams,
  ): Promise<{ id: string; name: string; mimeType: string }> {
    if (params.bytes.byteLength > MULTIPART_UPLOAD_MAX_BYTES) {
      return this.uploadResumableFile(params);
    }
    return this.uploadMultipartFile(params);
  }

  /**
   * Uploads a clipped article with strict ordering:
   * 1. Find or create idempotent article folder (`appProperties.sourceUrl`).
   * 2. Upload ALL downloaded images into `images/` with bounded concurrency and await all.
   *    Per-image non-auth upload failures degrade gracefully (keeping remote URL + warning).
   * 3. Rewrite Markdown links and generate OKF v0.2 YAML frontmatter.
   * 4. Upload `<folderName>.md` LAST.
   */
  async uploadArticle(params: UploadArticleParams): Promise<ClipResult> {
    const clippedAt = params.clippedAt ?? new Date().toISOString();
    const finalTitle =
      params.title?.trim() || params.page.title.trim() || 'Untitled';
    const requestedFolderName =
      params.folderName?.trim() ||
      buildArticleFolderName(
        finalTitle,
        clippedAt,
        params.page.url || params.page.site,
      );
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
    const articleFileName = buildArticleFileName(articleFolder.folderName);

    const totalUploads = params.fetchedImages.length + 1;
    let completedUploads = 0;
    params.onProgress?.(0, totalUploads);

    // Phase 1: Upload all downloaded images and wait for every upload to finish.
    const uploadedSlots: Array<UploadedImageInfo | undefined> = new Array(
      params.fetchedImages.length,
    );
    const succeededFetchedSlots: Array<FetchedImage | undefined> = new Array(
      params.fetchedImages.length,
    );
    const uploadFailureSlots: Array<ImageFetchFailure | undefined> = new Array(
      params.fetchedImages.length,
    );

    if (params.fetchedImages.length > 0) {
      const imagesFolder = await this.findOrCreateSubfolder({
        parentFolderId: articleFolder.folderId,
        name: 'images',
        interactive,
        signal: params.signal,
      });

      const existingFiles = imagesFolder.reused
        ? await this.listChildFiles(imagesFolder.folderId, {
            interactive,
            signal: params.signal,
          })
        : {
            byName: new Map<string, string>(),
            byImageUrl: new Map<string, string>(),
          };

      // Pre-resolve existing file IDs in two passes before spawning workers so an
      // image matched by `appProperties.imageUrl` always claims its Drive file ID
      // first, preventing a newly prepended image with the old filename from
      // falling back to `byName` and PATCHing the same file ID concurrently.
      const encodedImageUrls = await Promise.all(
        params.fetchedImages.map((image) =>
          encodeSourceUrlProperty(image.resolvedUrl),
        ),
      );
      const resolvedExistingFileIds = new Array<string | undefined>(
        params.fetchedImages.length,
      );
      const claimedFileIds = new Set<string>();

      for (let i = 0; i < params.fetchedImages.length; i += 1) {
        const matchedByUrl = existingFiles.byImageUrl.get(encodedImageUrls[i]);
        if (matchedByUrl && !claimedFileIds.has(matchedByUrl)) {
          resolvedExistingFileIds[i] = matchedByUrl;
          claimedFileIds.add(matchedByUrl);
        }
      }

      for (let i = 0; i < params.fetchedImages.length; i += 1) {
        if (resolvedExistingFileIds[i] !== undefined) {
          continue;
        }
        const matchedByName = existingFiles.byName.get(
          params.fetchedImages[i].filename,
        );
        if (matchedByName && !claimedFileIds.has(matchedByName)) {
          resolvedExistingFileIds[i] = matchedByName;
          claimedFileIds.add(matchedByName);
        }
      }

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
          const encodedImageUrl = encodedImageUrls[idx];
          const existingFileId = resolvedExistingFileIds[idx];

          try {
            const uploaded = await this.uploadFile({
              name: image.filename,
              mimeType: image.mimeType,
              bytes: image.bytes,
              parentFolderId: imagesFolder.folderId,
              existingFileId,
              appProperties: {
                [IMAGE_URL_PROPERTY_KEY]: encodedImageUrl,
              },
              interactive,
              signal: params.signal,
            });

            uploadedSlots[idx] = {
              id: image.id,
              filename: image.filename,
              fileId: uploaded.id,
              mimeType: image.mimeType,
              resolvedUrl: image.resolvedUrl,
            };
            succeededFetchedSlots[idx] = image;
          } catch (error) {
            if (isAbortError(error, params.signal)) {
              throw error;
            }
            if (
              error instanceof DriveApiError &&
              (error.code === 'AUTH_REQUIRED' || error.status === 401)
            ) {
              throw error;
            }
            const reason = error instanceof Error ? error.message : String(error);
            const status = error instanceof DriveApiError ? error.status : undefined;
            uploadFailureSlots[idx] = {
              id: image.id,
              originalUrl: image.originalUrl,
              resolvedUrl: image.resolvedUrl,
              sourceUrls: [...image.sourceUrls],
              reason: `Drive upload failed: ${reason}`,
              ...(status !== undefined ? { status } : {}),
            };
          }

          completedUploads += 1;
          params.onProgress?.(completedUploads, totalUploads);
        }
      });

      await Promise.all(workers);
    }

    const uploadedImages = uploadedSlots.filter(
      (item): item is UploadedImageInfo => item !== undefined,
    );
    const succeededFetchedImages = succeededFetchedSlots.filter(
      (item): item is FetchedImage => item !== undefined,
    );
    const uploadFailures = uploadFailureSlots.filter(
      (item): item is ImageFetchFailure => item !== undefined,
    );

    // Phase 2: Rewrite Markdown image links and build YAML frontmatter.
    const downloadFailures = [...(params.failedImages ?? [])];
    const failedImages = [...downloadFailures, ...uploadFailures];
    const rewriteResult = rewriteMarkdownImageUrls(
      params.page.markdown,
      params.page.url,
      succeededFetchedImages,
      downloadFailures,
    );

    const uploadFailureWarnings = uploadFailures.map((failure) => {
      const statusSuffix =
        typeof failure.status === 'number' ? ` (HTTP ${failure.status})` : '';
      return `Image upload failed for ${failure.resolvedUrl}${statusSuffix}: ${failure.reason}; kept original URL.`;
    });

    const allWarnings = Array.from(
      new Set(
        [...params.page.warnings, ...rewriteResult.warnings, ...uploadFailureWarnings]
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

    const description =
      params.page.description?.replace(/\s+/g, ' ').trim() ||
      extractPlainTextExcerpt(rewriteResult.markdown) ||
      finalTitle;

    const frontmatter = buildFrontmatter(
      {
        title: finalTitle,
        description,
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

    const articleContent = composeMarkdownDocument(
      frontmatter,
      rewriteResult.markdown,
    );

    // Phase 3: Upload `<folderName>.md` strictly AFTER all images have completed.
    let existingArticleFileId: string | undefined;
    if (articleFolder.reused) {
      const existingArticleFiles = await this.listChildFiles(
        articleFolder.folderId,
        {
          interactive,
          signal: params.signal,
        },
      );
      existingArticleFileId =
        existingArticleFiles.byName.get(articleFileName) ??
        existingArticleFiles.articleFileId ??
        existingArticleFiles.byName.get('README.md');
    }

    const articleFile = await this.uploadFile({
      name: articleFileName,
      mimeType: 'text/markdown',
      bytes: textEncoder.encode(articleContent),
      parentFolderId: articleFolder.folderId,
      existingFileId: existingArticleFileId,
      appProperties: {
        [ROLE_PROPERTY_KEY]: ARTICLE_ROLE_VALUE,
      },
      interactive,
      signal: params.signal,
    });

    completedUploads += 1;
    params.onProgress?.(completedUploads, totalUploads);

    return {
      folderId: articleFolder.folderId,
      folderUrl: buildDriveFolderUrl(articleFolder.folderId),
      folderName: articleFolder.folderName,
      fileName: articleFileName,
      articleFileName,
      articleFileId: articleFile.id,
      readmeFileId: articleFile.id,
      title: finalTitle,
      sourceUrl: params.page.url,
      clippedAt,
      uploadedImages,
      failedImages,
      warnings: allWarnings,
      reusedFolder: articleFolder.reused,
    };
  }

  /**
   * Downloads existing OKF v0.2 bundle root `index.md` and `log.md` from
   * `rootFolderId` (if present), applies deterministic upsert/append updates,
   * and writes them back via `POST`/`PATCH`.
   *
   * Callers performing concurrent clips MUST serialize calls to this method
   * (e.g. via an async mutex chain) to prevent lost-update races.
   */
  async updateBundleIndexAndLog(
    params: UpdateBundleIndexAndLogParams,
  ): Promise<UpdateBundleIndexAndLogResult> {
    const interactive = params.interactive ?? true;
    const childFiles = await this.listChildFilesByName(params.rootFolderId, {
      interactive,
      signal: params.signal,
    });

    let existingIndexId = childFiles.get(ROOT_INDEX_FILENAME);
    let existingLogId = childFiles.get(ROOT_LOG_FILENAME);

    const readOptionalText = async (
      fileId: string | undefined,
    ): Promise<{ text: string | null; stillExists: boolean }> => {
      if (!fileId) {
        return { text: null, stillExists: false };
      }
      try {
        const text = await this.downloadTextFile(fileId, {
          interactive,
          signal: params.signal,
        });
        return { text, stillExists: true };
      } catch (error) {
        if (error instanceof DriveApiError && error.status === 404) {
          return { text: null, stillExists: false };
        }
        throw error;
      }
    };

    const [indexRead, logRead] = await Promise.all([
      readOptionalText(existingIndexId),
      readOptionalText(existingLogId),
    ]);

    if (!indexRead.stillExists) {
      existingIndexId = undefined;
    }
    if (!logRead.stillExists) {
      existingLogId = undefined;
    }

    const fullEntry: RootIndexEntry = {
      ...params.entry,
      rootFolderName: params.rootFolderName,
    };

    const nextIndexContent = upsertRootIndexMarkdown(indexRead.text, fullEntry);
    const nextLogContent = appendClipLogMarkdown(
      logRead.text,
      fullEntry,
      params.action,
    );

    const [indexFile, logFile] = await Promise.all([
      this.uploadFile({
        name: ROOT_INDEX_FILENAME,
        mimeType: 'text/markdown',
        bytes: textEncoder.encode(nextIndexContent),
        parentFolderId: params.rootFolderId,
        existingFileId: existingIndexId,
        interactive,
        signal: params.signal,
      }),
      this.uploadFile({
        name: ROOT_LOG_FILENAME,
        mimeType: 'text/markdown',
        bytes: textEncoder.encode(nextLogContent),
        parentFolderId: params.rootFolderId,
        existingFileId: existingLogId,
        interactive,
        signal: params.signal,
      }),
    ]);

    return {
      indexFileId: indexFile.id,
      logFileId: logFile.id,
    };
  }
}
