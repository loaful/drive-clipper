import {
  DEFAULT_EXTENSION_SETTINGS,
  type DiscoveredImage,
  type FetchedImage,
  type ImageFetchBatchResult,
  type ImageFetchFailure,
} from '../types.js';

export interface DetectedImageFormat {
  mimeType: string;
  ext: string;
}

export interface DeclarativeNetRequestLike {
  updateSessionRules(
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ): Promise<void>;
  getSessionRules?: () => Promise<chrome.declarativeNetRequest.Rule[]>;
}

export interface ImageFetchOptions {
  /** Maximum concurrent image downloads. Defaults to 5. */
  concurrency?: number;
  /** Per-image timeout in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Maximum permitted payload size in bytes. Defaults to 15 MiB. */
  maxBytes?: number;
  /** Custom fetch implementation for tests or non-browser environments. */
  fetchImpl?: typeof fetch;
  /**
   * Custom Declarative Net Request API implementation.
   * Defaults to `globalThis.chrome?.declarativeNetRequest`; pass `null` to disable.
   */
  dnr?: DeclarativeNetRequestLike | null;
  /** Invoked as each deduplicated image finishes (succeeded or failed). */
  onProgress?: (completed: number, total: number) => void;
  /** Cancels the whole batch while still removing temporary DNR session rules. */
  signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = DEFAULT_EXTENSION_SETTINGS.imageConcurrency;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = DEFAULT_EXTENSION_SETTINGS.maxImageSizeBytes;
const MAX_URL_FILTERS_BEFORE_ORIGIN_COLLAPSE = 1_000;
const MAX_REGEX_FILTER_LENGTH = 1_800;
const SPECIFIC_URL_RULE_PRIORITY = 2;
const ORIGIN_FALLBACK_RULE_PRIORITY = 1;
const MIN_RULE_ID = 1_000;
const MAX_RULE_ID = 2_000_000_000;

// Seeded per worker startup so concurrent or restarted runs avoid rule ID collisions.
let nextDnrRuleId =
  MIN_RULE_ID +
  ((Date.now() % 1_000_000) * 1_000 + Math.floor(Math.random() * 1_000));

// Tracks rule IDs owned by active in-flight fetchImages() batches in this SW instance.
const activeDnrRuleIds = new Set<number>();

const KNOWN_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'tiff',
  'tif',
  'bmp',
]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70];
const ICO_SIGNATURE = [0x00, 0x00, 0x01, 0x00];
const TIFF_LE_SIGNATURE = [0x49, 0x49, 0x2a, 0x00];
const TIFF_BE_SIGNATURE = [0x4d, 0x4d, 0x00, 0x2a];
const BMP_SIGNATURE = [0x42, 0x4d];

const textDecoder = new TextDecoder('utf-8', { fatal: false });

function matchesAt(
  bytes: Uint8Array,
  offset: number,
  signature: readonly number[],
): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !matchesAt(bytes, 4, FTYP_SIGNATURE)) {
    return false;
  }

  const declaredBoxSize =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const boxEnd =
    declaredBoxSize >= 12
      ? Math.min(declaredBoxSize, bytes.length, 128)
      : Math.min(bytes.length, 64);

  const majorBrand = readAscii4(bytes, 8);
  if (majorBrand === 'avif' || majorBrand === 'avis') {
    return true;
  }

  // Compatible brands begin at byte 16 after 4-byte major brand + 4-byte minor version.
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    const brand = readAscii4(bytes, offset);
    if (brand === 'avif' || brand === 'avis') {
      return true;
    }
  }
  return false;
}

function isSvgPayload(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  // Binary control bytes (NUL, etc.) disqualify XML/SVG text.
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample[i];
    if (code === 0x00) {
      return false;
    }
  }

  let text = textDecoder.decode(sample);
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  let cursor = 0;
  while (cursor < text.length) {
    const rest = text.slice(cursor).trimStart();
    cursor = text.length - rest.length;

    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end === -1) {
        return false;
      }
      cursor += end + 2;
      continue;
    }

    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end === -1) {
        return false;
      }
      cursor += end + 3;
      continue;
    }

    if (/^<!doctype\s+/i.test(rest)) {
      if (/^<!doctype\s+html\b/i.test(rest)) {
        return false;
      }
      const end = rest.indexOf('>');
      if (end === -1) {
        return false;
      }
      cursor += end + 1;
      continue;
    }

    return /^<svg(?:\s|>|\/)/i.test(rest);
  }

  return false;
}

export function parseContentTypeMime(
  contentType: string | null | undefined,
): string | null {
  if (!contentType) {
    return null;
  }
  const semi = contentType.indexOf(';');
  const raw = (semi === -1 ? contentType : contentType.slice(0, semi))
    .trim()
    .toLowerCase();
  return raw.length > 0 ? raw : null;
}

/**
 * Determines canonical image MIME type and file extension from payload magic
 * bytes (ground truth) and HTTP Content-Type, preserving the original format.
 * Returns null for empty or non-image payloads.
 */
export function detectImageFormat(
  bytes: Uint8Array,
  contentType?: string | null,
): DetectedImageFormat | null {
  if (bytes.byteLength === 0) {
    return null;
  }

  if (matchesAt(bytes, 0, PNG_SIGNATURE)) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (matchesAt(bytes, 0, JPEG_SIGNATURE)) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (
    matchesAt(bytes, 0, GIF87A_SIGNATURE) ||
    matchesAt(bytes, 0, GIF89A_SIGNATURE)
  ) {
    return { mimeType: 'image/gif', ext: 'gif' };
  }
  if (matchesAt(bytes, 0, RIFF_SIGNATURE) && matchesAt(bytes, 8, WEBP_SIGNATURE)) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  if (isAvif(bytes)) {
    return { mimeType: 'image/avif', ext: 'avif' };
  }
  if (isSvgPayload(bytes)) {
    return { mimeType: 'image/svg+xml', ext: 'svg' };
  }
  if (bytes.length >= 6 && matchesAt(bytes, 0, ICO_SIGNATURE)) {
    return { mimeType: 'image/x-icon', ext: 'ico' };
  }
  if (
    matchesAt(bytes, 0, TIFF_LE_SIGNATURE) ||
    matchesAt(bytes, 0, TIFF_BE_SIGNATURE)
  ) {
    return { mimeType: 'image/tiff', ext: 'tiff' };
  }

  const normalizedMime = parseContentTypeMime(contentType);
  if (
    (normalizedMime === 'image/bmp' || normalizedMime === 'image/x-ms-bmp') &&
    bytes.length >= 26 &&
    matchesAt(bytes, 0, BMP_SIGNATURE)
  ) {
    return { mimeType: 'image/bmp', ext: 'bmp' };
  }

  return null;
}

/**
 * Allocates unique positive 32-bit integer DNR rule IDs that never collide
 * with rule IDs currently active in concurrent `fetchImages` batches.
 */
export function allocateDnrRuleIds(count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let attempts = 0;
    while (activeDnrRuleIds.has(nextDnrRuleId)) {
      nextDnrRuleId = nextDnrRuleId >= MAX_RULE_ID ? MIN_RULE_ID : nextDnrRuleId + 1;
      attempts += 1;
      if (attempts > 100_000) {
        throw new Error('Exhausted available DNR session rule IDs.');
      }
    }
    const allocated = nextDnrRuleId;
    nextDnrRuleId = nextDnrRuleId >= MAX_RULE_ID ? MIN_RULE_ID : nextDnrRuleId + 1;
    ids.push(allocated);
  }
  return ids;
}

function isHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

const DNR_FILTER_SPECIAL_OR_NON_ASCII_RE = /[^\x21-\x7e]|[*|^]/;
const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/;

interface DnrUrlMatcher {
  key: string;
  urlFilter?: string;
  regexFilter?: string;
  priority: number;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds an exact-URL DNR matcher (origin + pathname + query, excluding hash)
 * so concurrent jobs clipping different articles on the same domain/CDN never
 * collide on broad host rules or URL prefix overlaps (e.g. `/img/1` vs `/img/10`
 * or `/proxy?id=1` vs `/proxy?id=2`).
 */
function buildUrlMatcher(parsed: URL): DnrUrlMatcher {
  const fullUrl = `${parsed.origin}${parsed.pathname}${parsed.search}`;
  if (!DNR_FILTER_SPECIAL_OR_NON_ASCII_RE.test(fullUrl)) {
    const urlFilter = `|${fullUrl}|`;
    return {
      key: `url:${urlFilter}`,
      urlFilter,
      priority: SPECIFIC_URL_RULE_PRIORITY,
    };
  }

  const regexFilter = `^${escapeRegexLiteral(fullUrl)}$`;
  if (
    regexFilter.length <= MAX_REGEX_FILTER_LENGTH &&
    ASCII_PRINTABLE_RE.test(regexFilter)
  ) {
    return {
      key: `regex:${regexFilter}`,
      regexFilter,
      priority: SPECIFIC_URL_RULE_PRIORITY,
    };
  }

  const originFilter = `|${parsed.origin}/`;
  return {
    key: `origin:${originFilter}`,
    urlFilter: originFilter,
    priority: ORIGIN_FALLBACK_RULE_PRIORITY,
  };
}

/**
 * Builds temporary session DNR rules that inject `Referer: <pageUrl>` for
 * Service Worker (`tabIds: [-1]`) requests targeting the given HTTP(S) image URLs.
 */
export function buildRefererSessionRules(
  pageUrl: string,
  targetUrls: readonly string[],
): chrome.declarativeNetRequest.Rule[] {
  const parsedPage = isHttpUrl(pageUrl);
  if (!parsedPage) {
    return [];
  }

  const parsedTargets: URL[] = [];
  for (const rawUrl of targetUrls) {
    const parsed = isHttpUrl(rawUrl);
    if (parsed) {
      parsedTargets.push(parsed);
    }
  }
  if (parsedTargets.length === 0) {
    return [];
  }

  const matcherMap = new Map<string, DnrUrlMatcher>();
  for (const target of parsedTargets) {
    const matcher = buildUrlMatcher(target);
    if (!matcherMap.has(matcher.key)) {
      matcherMap.set(matcher.key, matcher);
    }
  }

  let matchers = Array.from(matcherMap.values());
  if (matchers.length > MAX_URL_FILTERS_BEFORE_ORIGIN_COLLAPSE) {
    const originMatchers = new Map<string, DnrUrlMatcher>();
    for (const target of parsedTargets) {
      const originFilter = `|${target.origin}/`;
      const key = `origin:${originFilter}`;
      if (!originMatchers.has(key)) {
        originMatchers.set(key, {
          key,
          urlFilter: originFilter,
          priority: ORIGIN_FALLBACK_RULE_PRIORITY,
        });
      }
    }
    matchers = Array.from(originMatchers.values());
  }

  const ids = allocateDnrRuleIds(matchers.length);
  return matchers.map((matcher, idx) => ({
    id: ids[idx],
    priority: matcher.priority,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'Referer',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: parsedPage.href,
        },
      ],
    },
    condition: {
      ...(matcher.urlFilter !== undefined ? { urlFilter: matcher.urlFilter } : {}),
      ...(matcher.regexFilter !== undefined
        ? { regexFilter: matcher.regexFilter }
        : {}),
      // TAB_ID_NONE (-1) limits the Referer override to Service Worker fetches.
      tabIds: [-1],
      resourceTypes: [
        'xmlhttprequest',
        'image',
        'other',
      ] as chrome.declarativeNetRequest.ResourceType[],
    },
  }));
}

/**
 * Registers temporary DNR session rules for `fn` and unconditionally removes
 * those exact rule IDs in `finally`, even if `fn` throws or aborts.
 */
export async function withRefererSessionRules<T>(
  dnr: DeclarativeNetRequestLike | null | undefined,
  pageUrl: string,
  targetUrls: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (!dnr) {
    return fn();
  }

  const rules = buildRefererSessionRules(pageUrl, targetUrls);
  if (rules.length === 0) {
    return fn();
  }

  const ruleIds = rules.map((rule) => rule.id);
  for (const id of ruleIds) {
    activeDnrRuleIds.add(id);
  }

  let rulesAdded = false;
  let hasPrimaryError = false;

  try {
    await dnr.updateSessionRules({ addRules: rules });
    rulesAdded = true;
    return await fn();
  } catch (error) {
    hasPrimaryError = true;
    throw error;
  } finally {
    try {
      if (rulesAdded) {
        await dnr.updateSessionRules({ removeRuleIds: ruleIds });
      }
    } catch (cleanupError) {
      if (!hasPrimaryError) {
        throw cleanupError;
      }
    } finally {
      for (const id of ruleIds) {
        activeDnrRuleIds.delete(id);
      }
    }
  }
}

function isServiceWorkerRefererRule(rule: chrome.declarativeNetRequest.Rule): boolean {
  return (
    rule.action.type === 'modifyHeaders' &&
    Array.isArray(rule.condition.tabIds) &&
    rule.condition.tabIds.length === 1 &&
    rule.condition.tabIds[0] === -1 &&
    Array.isArray(rule.action.requestHeaders) &&
    rule.action.requestHeaders.length === 1 &&
    rule.action.requestHeaders[0]?.header.toLowerCase() === 'referer' &&
    rule.action.requestHeaders[0]?.operation === 'set'
  );
}

/**
 * Removes any orphaned Service Worker Referer session rules left behind by a
 * previous crashed/restarted Service Worker instance while leaving rules owned
 * by active in-flight batches untouched.
 */
export async function cleanupOrphanedRefererSessionRules(
  dnr?: DeclarativeNetRequestLike | null,
): Promise<number[]> {
  const resolvedDnr = dnr === undefined ? resolveDefaultDnr() : dnr;
  if (!resolvedDnr?.getSessionRules) {
    return [];
  }

  const existing = await resolvedDnr.getSessionRules();
  const orphanIds = existing
    .filter((rule) => isServiceWorkerRefererRule(rule) && !activeDnrRuleIds.has(rule.id))
    .map((rule) => rule.id);

  if (orphanIds.length > 0) {
    await resolvedDnr.updateSessionRules({ removeRuleIds: orphanIds });
  }
  return orphanIds;
}

function deduplicateImages(images: readonly DiscoveredImage[]): DiscoveredImage[] {
  const byResolvedUrl = new Map<string, DiscoveredImage>();

  for (const image of images) {
    const key = image.resolvedUrl.trim();
    const existing = byResolvedUrl.get(key);
    if (!existing) {
      const sourceUrls = Array.from(
        new Set([image.originalUrl, ...image.sourceUrls].filter(Boolean)),
      );
      byResolvedUrl.set(key, {
        ...image,
        resolvedUrl: key,
        sourceUrls,
      });
      continue;
    }

    const mergedSources = new Set(existing.sourceUrls);
    mergedSources.add(image.originalUrl);
    for (const src of image.sourceUrls) {
      if (src) {
        mergedSources.add(src);
      }
    }
    existing.sourceUrls = Array.from(mergedSources);
  }

  return Array.from(byResolvedUrl.values());
}

function sanitizeBaseName(suggestedName: string, fallbackIndex: number): string {
  const cleaned = suggestedName
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (cleaned.length === 0) {
    return `image-${String(fallbackIndex + 1).padStart(2, '0')}`;
  }

  // Strip a trailing known image extension if one leaked into suggestedName.
  const dotIdx = cleaned.lastIndexOf('.');
  if (dotIdx > 0) {
    const tail = cleaned.slice(dotIdx + 1).toLowerCase();
    if (KNOWN_IMAGE_EXTENSIONS.has(tail)) {
      const stem = cleaned.slice(0, dotIdx).replace(/^-+|-+$/g, '');
      if (stem.length > 0) {
        return stem;
      }
    }
  }

  return cleaned;
}

function allocateUniqueFilename(
  baseName: string,
  ext: string,
  usedLowercase: Set<string>,
): string {
  let candidate = `${baseName}.${ext}`;
  let suffix = 2;
  while (usedLowercase.has(candidate.toLowerCase())) {
    candidate = `${baseName}-${suffix}.${ext}`;
    suffix += 1;
  }
  usedLowercase.add(candidate.toLowerCase());
  return candidate;
}

function decodeDataImageUrl(
  url: string,
  maxBytes: number,
): { bytes: Uint8Array; contentType: string | null } | { error: string } {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) {
    return { error: 'Malformed data URL' };
  }

  const meta = url.slice(5, commaIndex);
  const payload = url.slice(commaIndex + 1);
  const parts = meta.split(';');
  const isBase64 = parts.some((p) => p.trim().toLowerCase() === 'base64');
  const mime = parts[0]?.trim() || null;

  try {
    let bytes: Uint8Array;
    if (isBase64) {
      const normalized = payload.replace(/\s+/g, '');
      const estimatedBytes = Math.floor((normalized.length * 3) / 4);
      if (estimatedBytes > maxBytes + 3) {
        return {
          error: `Image exceeds maximum allowed size (${maxBytes} bytes)`,
        };
      }
      const binary = atob(normalized);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
    } else {
      const decoded = decodeURIComponent(payload);
      bytes = new TextEncoder().encode(decoded);
    }

    if (bytes.byteLength > maxBytes) {
      return {
        error: `Image exceeds maximum allowed size (${maxBytes} bytes)`,
      };
    }

    return { bytes, contentType: mime };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to decode data URL: ${message}` };
  }
}

async function readResponseBytesBounded(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader.trim());
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore stream cancellation error once size cap is exceeded.
      }
      return {
        error: `Image size ${declared} bytes exceeds limit of ${maxBytes} bytes`,
      };
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return {
            error: `Image payload exceeds limit of ${maxBytes} bytes`,
          };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: merged };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return {
      error: `Image size ${buffer.byteLength} bytes exceeds limit of ${maxBytes} bytes`,
    };
  }
  return { bytes: new Uint8Array(buffer) };
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Image fetch batch aborted', 'AbortError');
  }
  const err = new Error('Image fetch batch aborted');
  err.name = 'AbortError';
  return err;
}

interface SingleFetchOutcome {
  ok: true;
  image: DiscoveredImage;
  bytes: Uint8Array;
  format: DetectedImageFormat;
}

interface SingleFetchFailureOutcome {
  ok: false;
  failure: ImageFetchFailure;
}

async function fetchSingleImage(
  image: DiscoveredImage,
  pageUrl: string,
  config: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    maxBytes: number;
    includeHeaderReferer: boolean;
    signal?: AbortSignal;
  },
): Promise<SingleFetchOutcome | SingleFetchFailureOutcome> {
  const { fetchImpl, timeoutMs, maxBytes, includeHeaderReferer, signal } = config;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const fail = (reason: string, status?: number): SingleFetchFailureOutcome => ({
    ok: false,
    failure: {
      id: image.id,
      originalUrl: image.originalUrl,
      resolvedUrl: image.resolvedUrl,
      sourceUrls: image.sourceUrls,
      reason,
      ...(status !== undefined ? { status } : {}),
    },
  });

  if (image.resolvedUrl.startsWith('data:')) {
    const decoded = decodeDataImageUrl(image.resolvedUrl, maxBytes);
    if ('error' in decoded) {
      return fail(decoded.error);
    }
    const format = detectImageFormat(decoded.bytes, decoded.contentType);
    if (!format) {
      return fail(
        `Non-image data payload (${decoded.contentType ?? 'unknown MIME'})`,
      );
    }
    return { ok: true, image, bytes: decoded.bytes, format };
  }

  const parsedUrl = isHttpUrl(image.resolvedUrl);
  if (!parsedUrl) {
    return fail(`Unsupported image URL scheme: ${image.resolvedUrl}`);
  }

  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    // Outside Chrome DNR (e.g., Node integration tests), supply Referer directly.
    if (includeHeaderReferer && isHttpUrl(pageUrl)) {
      headers.Referer = pageUrl;
    }

    const response = await fetchImpl(parsedUrl.href, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok || response.status >= 400) {
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      return fail(`HTTP ${response.status}${statusText}`, response.status);
    }

    const bodyResult = await readResponseBytesBounded(response, maxBytes);
    if ('error' in bodyResult) {
      return fail(bodyResult.error, response.status);
    }

    const contentType = response.headers.get('content-type');
    const format = detectImageFormat(bodyResult.bytes, contentType);
    if (!format) {
      const mimeLabel = parseContentTypeMime(contentType) ?? 'unknown';
      return fail(
        `Non-image payload (Content-Type: ${mimeLabel}, ${bodyResult.bytes.byteLength} bytes)`,
        response.status,
      );
    }

    return { ok: true, image, bytes: bodyResult.bytes, format };
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      return fail(`Request timed out after ${timeoutMs}ms`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Network error: ${message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

function resolveDefaultDnr(): DeclarativeNetRequestLike | null {
  if (
    typeof chrome !== 'undefined' &&
    chrome.declarativeNetRequest &&
    typeof chrome.declarativeNetRequest.updateSessionRules === 'function'
  ) {
    return chrome.declarativeNetRequest;
  }
  return null;
}

/**
 * Fetches deduplicated article images with bounded concurrency, format sniffing,
 * temporary DNR Referer session rules, and per-image graceful fallback.
 */
export async function fetchImages(
  images: readonly DiscoveredImage[],
  pageUrl: string,
  options: ImageFetchOptions = {},
): Promise<ImageFetchBatchResult> {
  const deduped = deduplicateImages(images);
  if (deduped.length === 0) {
    return { succeeded: [], failed: [] };
  }

  const concurrency = Math.max(
    1,
    Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const dnr = options.dnr === undefined ? resolveDefaultDnr() : options.dnr;
  const includeHeaderReferer = dnr === null;

  const targetUrls = deduped.map((img) => img.resolvedUrl);

  return withRefererSessionRules(dnr, pageUrl, targetUrls, async () => {
    const outcomes = new Array<
      SingleFetchOutcome | SingleFetchFailureOutcome | undefined
    >(deduped.length);
    let nextIndex = 0;
    let completed = 0;

    const workerCount = Math.min(concurrency, deduped.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (options.signal?.aborted) {
          throw createAbortError();
        }
        const currentIndex = nextIndex;
        if (currentIndex >= deduped.length) {
          return;
        }
        nextIndex += 1;

        const outcome = await fetchSingleImage(deduped[currentIndex], pageUrl, {
          fetchImpl,
          timeoutMs,
          maxBytes,
          includeHeaderReferer,
          signal: options.signal,
        });

        outcomes[currentIndex] = outcome;
        completed += 1;
        options.onProgress?.(completed, deduped.length);
      }
    });

    await Promise.all(workers);

    const usedFilenames = new Set<string>();
    const succeeded: FetchedImage[] = [];
    const failed: ImageFetchFailure[] = [];

    for (let i = 0; i < deduped.length; i += 1) {
      const outcome = outcomes[i];
      if (!outcome) {
        continue;
      }
      if (!outcome.ok) {
        failed.push(outcome.failure);
        continue;
      }

      const baseName = sanitizeBaseName(outcome.image.suggestedName, i);
      const filename = allocateUniqueFilename(
        baseName,
        outcome.format.ext,
        usedFilenames,
      );
      succeeded.push({
        id: outcome.image.id,
        originalUrl: outcome.image.originalUrl,
        resolvedUrl: outcome.image.resolvedUrl,
        sourceUrls: outcome.image.sourceUrls,
        filename,
        mimeType: outcome.format.mimeType,
        bytes: outcome.bytes,
        byteLength: outcome.bytes.byteLength,
      });
    }

    return { succeeded, failed };
  });
}
