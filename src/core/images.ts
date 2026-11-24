import type { DiscoveredImage, ImageFetchFailure } from '../types.js';
import { slugifyTitle } from './frontmatter.js';
import { LIVE_IMG_ATTRS } from './shadow-dom.js';

const SVG_DATA_URL_RE = /^data:image\/svg\+xml\b/i;
const BLANK_GIF_DATA_URL_RE =
  /^data:image\/gif;base64,R0lGODlhAQAB(?:AIAAAAAAAP\/\/\/yH5BAEAAAAALAAAAAABAAEAAAIBRAA7|AAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==)/i;

const LAZY_SRC_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-actualsrc',
  'data-url',
] as const;

const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'] as const;

const STYLE_WIDTH_RE = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)\s*px\b/i;
const STYLE_HEIGHT_RE = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)\s*px\b/i;

export interface DomImageMetadata {
  alt: string;
  width?: number;
  height?: number;
}

export interface RewriteImageMapping {
  resolvedUrl: string;
  originalUrl?: string;
  sourceUrls?: string[];
  filename: string;
}

export interface RewriteMarkdownImagesResult {
  markdown: string;
  rewrittenCount: number;
  /** Deduplicated local relative paths in document order (e.g. "./images/01-hero.webp"). */
  localImagePaths: string[];
  /** Human-readable warnings for images that failed to download and kept their original URLs. */
  warnings: string[];
}

interface MarkdownImageMatch {
  kind: 'markdown' | 'html';
  start: number;
  end: number;
  alt: string;
  rawUrl: string;
  /** Optional title suffix (including leading whitespace) for Markdown image syntax. */
  titlePart: string;
  /** Full raw match string. */
  rawMatch: string;
  /** For HTML `<img ...>` matches, exact index range of the `src` attribute value inside `rawMatch`. */
  htmlSrcValueStart?: number;
  htmlSrcValueEnd?: number;
}

/**
 * Returns true if the URL is an inline SVG data URI placeholder.
 */
export function isSvgPlaceholderDataUrl(url: string): boolean {
  return SVG_DATA_URL_RE.test(url.trim());
}

/**
 * Returns true if the URL is an empty string, anchor, unsafe scheme, or known
 * SVG / 1x1 blank GIF lazy-load placeholder.
 */
export function isPlaceholderImageUrl(url: string | null | undefined): boolean {
  if (!url) {
    return true;
  }
  const trimmed = url.trim();
  if (
    trimmed.length === 0 ||
    trimmed === '#' ||
    trimmed.startsWith('#') ||
    /^about:blank$/i.test(trimmed) ||
    /^javascript:/i.test(trimmed)
  ) {
    return true;
  }
  return SVG_DATA_URL_RE.test(trimmed) || BLANK_GIF_DATA_URL_RE.test(trimmed);
}

/**
 * Resolves a candidate URL against `baseUrl`, keeping only `http:` / `https:` URLs
 * and stripping `#fragment` so identical network resources deduplicate cleanly.
 */
export function normalizeImageUrl(
  rawUrl: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!rawUrl || isPlaceholderImageUrl(rawUrl)) {
    return null;
  }
  const trimmed = rawUrl.trim().replace(/&amp;/gi, '&');
  try {
    const parsed = new URL(trimmed, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Parses an HTML `srcset` attribute and returns the highest-resolution candidate URL.
 * Handles URLs that contain commas (e.g. CDN transform paths) cleanly.
 */
export function selectBestSrcsetUrl(srcset: string | null | undefined): string | null {
  if (!srcset) {
    return null;
  }
  const input = srcset.trim();
  if (input.length === 0) {
    return null;
  }

  let bestUrl: string | null = null;
  let bestScore = -1;

  // Scan comma-separated candidates without splitting on commas embedded in URL paths.
  let i = 0;
  const len = input.length;
  while (i < len) {
    while (i < len && (input[i] === ' ' || input[i] === '\t' || input[i] === '\n' || input[i] === '\r' || input[i] === ',')) {
      i += 1;
    }
    if (i >= len) {
      break;
    }

    const urlStart = i;
    while (i < len && !/\s/.test(input[i])) {
      i += 1;
    }
    let urlToken = input.slice(urlStart, i);
    let hasTrailingComma = false;
    if (urlToken.endsWith(',')) {
      hasTrailingComma = true;
      urlToken = urlToken.slice(0, -1);
    }

    let descriptor = '';
    if (!hasTrailingComma) {
      const descStart = i;
      while (i < len && input[i] !== ',') {
        i += 1;
      }
      descriptor = input.slice(descStart, i).trim();
      if (i < len && input[i] === ',') {
        i += 1;
      }
    }

    if (urlToken.length === 0 || isPlaceholderImageUrl(urlToken)) {
      continue;
    }

    let score = 1;
    const widthMatch = descriptor.match(/^(\d+)w$/i);
    const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/i);
    if (widthMatch) {
      score = Number(widthMatch[1]);
    } else if (densityMatch) {
      score = Number(densityMatch[1]) * 1000;
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = urlToken;
    }
  }

  return bestUrl;
}

function parsePixelAttribute(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getExplicitDimensions(img: Element): { width: number | null; height: number | null } {
  const attrWidth = parsePixelAttribute(img.getAttribute('width'));
  const attrHeight = parsePixelAttribute(img.getAttribute('height'));

  const style = img.getAttribute('style') ?? '';
  const styleWidthMatch = style.match(STYLE_WIDTH_RE);
  const styleHeightMatch = style.match(STYLE_HEIGHT_RE);
  const styleWidth = styleWidthMatch ? Number(styleWidthMatch[1]) : null;
  const styleHeight = styleHeightMatch ? Number(styleHeightMatch[1]) : null;

  return {
    width: attrWidth ?? styleWidth,
    height: attrHeight ?? styleHeight,
  };
}

function getLiveNaturalDimensions(img: Element): { width: number | null; height: number | null } {
  const clonedWidth = parsePixelAttribute(img.getAttribute(LIVE_IMG_ATTRS.naturalWidth));
  const clonedHeight = parsePixelAttribute(img.getAttribute(LIVE_IMG_ATTRS.naturalHeight));
  if (clonedWidth !== null || clonedHeight !== null) {
    return { width: clonedWidth, height: clonedHeight };
  }
  const htmlImg = img as HTMLImageElement;
  const w = typeof htmlImg.naturalWidth === 'number' && htmlImg.naturalWidth > 0 ? htmlImg.naturalWidth : null;
  const h = typeof htmlImg.naturalHeight === 'number' && htmlImg.naturalHeight > 0 ? htmlImg.naturalHeight : null;
  return { width: w, height: h };
}

function hasNonPlaceholderLazyCandidate(img: Element): boolean {
  for (const attr of LAZY_SRC_ATTRS) {
    if (!isPlaceholderImageUrl(img.getAttribute(attr))) {
      return true;
    }
  }
  for (const attr of LAZY_SRCSET_ATTRS) {
    if (selectBestSrcsetUrl(img.getAttribute(attr)) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if an `<img>` is a 1px tracking pixel based on explicit HTML/CSS
 * dimensions or known live natural dimensions. Broken/unloaded images (where
 * natural dimensions are 0/unknown and no explicit <=1px size is declared) and
 * lazy-loaded images whose placeholder decoded to 1x1 are never misclassified
 * as tracking pixels.
 */
export function isTrackingPixel(
  img: Element,
  options?: { ignoreLiveNaturalDimensions?: boolean },
): boolean {
  const explicit = getExplicitDimensions(img);
  if (explicit.width !== null || explicit.height !== null) {
    const w = explicit.width;
    const h = explicit.height;
    if (w !== null && h !== null && w <= 1 && h <= 1) {
      return true;
    }
    if (w !== null && w <= 1 && h === null) {
      return true;
    }
    if (h !== null && h <= 1 && w === null) {
      return true;
    }
  }

  const ignoreLiveNatural =
    options?.ignoreLiveNaturalDimensions ??
    (isPlaceholderImageUrl(img.getAttribute('src')) &&
      hasNonPlaceholderLazyCandidate(img));

  if (!ignoreLiveNatural) {
    const natural = getLiveNaturalDimensions(img);
    if (
      natural.width !== null &&
      natural.height !== null &&
      natural.width <= 1 &&
      natural.height <= 1
    ) {
      return true;
    }
  }

  return false;
}

interface ResolvedImageElement {
  url: string | null;
  usedLazyOverride: boolean;
}

function resolveImageElementDetails(
  img: Element,
  baseUrl: string,
): ResolvedImageElement {
  const rawSrc = img.getAttribute('src') ?? '';
  const normalizedSrc = normalizeImageUrl(rawSrc, baseUrl);

  const liveCurrentSrcRaw =
    img.getAttribute(LIVE_IMG_ATTRS.currentSrc) ??
    ((img as HTMLImageElement).currentSrc || '');
  const normalizedCurrentSrc = normalizeImageUrl(liveCurrentSrcRaw, baseUrl);

  let lazyResolved: string | null = null;
  for (const attr of LAZY_SRC_ATTRS) {
    const candidate = normalizeImageUrl(img.getAttribute(attr), baseUrl);
    if (candidate) {
      lazyResolved = candidate;
      break;
    }
  }
  if (!lazyResolved) {
    for (const attr of LAZY_SRCSET_ATTRS) {
      const best = selectBestSrcsetUrl(img.getAttribute(attr));
      const candidate = normalizeImageUrl(best, baseUrl);
      if (candidate) {
        lazyResolved = candidate;
        break;
      }
    }
  }

  // Prefer an explicit lazy attribute when `src` is a placeholder or differs from the lazy URL
  // (e.g. Chromium populates `currentSrc` with the SVG or LQIP placeholder already in `src`).
  if (lazyResolved && (isPlaceholderImageUrl(rawSrc) || lazyResolved !== normalizedSrc)) {
    return { url: lazyResolved, usedLazyOverride: true };
  }

  // Otherwise prefer browser-resolved `currentSrc` (covers `<picture>` / responsive `srcset`).
  if (normalizedCurrentSrc) {
    return { url: normalizedCurrentSrc, usedLazyOverride: false };
  }

  if (lazyResolved) {
    return { url: lazyResolved, usedLazyOverride: true };
  }

  const srcsetBest = normalizeImageUrl(selectBestSrcsetUrl(img.getAttribute('srcset')), baseUrl);
  if (srcsetBest) {
    return { url: srcsetBest, usedLazyOverride: false };
  }

  return { url: normalizedSrc, usedLazyOverride: false };
}

/**
 * Resolves the real download URL for an `<img>` element, checking live `currentSrc`,
 * lazy-load attributes (`data-src`, `data-original`, `data-lazy-src`, `data-srcset`),
 * `srcset`, and `src`, while rejecting SVG/blank placeholders.
 */
export function resolveImageElementUrl(img: Element, baseUrl: string): string | null {
  return resolveImageElementDetails(img, baseUrl).url;
}

/**
 * Resolves lazy-loaded images and strips SVG placeholders and 1px tracking pixels
 * in-place on a cloned DOM before Defuddle / Markdown conversion runs.
 */
export function resolveDomImages(
  root: Document | Element,
  baseUrl: string,
): Map<string, DomImageMetadata> {
  const metadata = new Map<string, DomImageMetadata>();
  const images = Array.from(root.querySelectorAll('img'));

  for (const img of images) {
    const rawSrc = img.getAttribute('src') ?? '';
    const { url: resolvedUrl, usedLazyOverride } = resolveImageElementDetails(
      img,
      baseUrl,
    );
    const ignoreLiveNatural =
      usedLazyOverride || (resolvedUrl !== null && isPlaceholderImageUrl(rawSrc));

    if (isTrackingPixel(img, { ignoreLiveNaturalDimensions: ignoreLiveNatural })) {
      img.remove();
      continue;
    }

    if (!resolvedUrl) {
      if (isPlaceholderImageUrl(rawSrc)) {
        img.remove();
      }
      continue;
    }

    const explicit = getExplicitDimensions(img);
    const natural = ignoreLiveNatural
      ? { width: null, height: null }
      : getLiveNaturalDimensions(img);
    const width = natural.width ?? explicit.width ?? undefined;
    const height = natural.height ?? explicit.height ?? undefined;
    const alt = (img.getAttribute('alt') ?? '').trim();

    if (!metadata.has(resolvedUrl)) {
      metadata.set(resolvedUrl, { alt, width, height });
    }

    img.setAttribute('src', resolvedUrl);
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    for (const attr of LAZY_SRC_ATTRS) {
      img.removeAttribute(attr);
    }
    for (const attr of LAZY_SRCSET_ATTRS) {
      img.removeAttribute(attr);
    }
    img.removeAttribute(LIVE_IMG_ATTRS.currentSrc);
    img.removeAttribute(LIVE_IMG_ATTRS.naturalWidth);
    img.removeAttribute(LIVE_IMG_ATTRS.naturalHeight);

    const parent = img.parentElement;
    if (parent && parent.tagName.toUpperCase() === 'PICTURE') {
      for (const source of Array.from(parent.querySelectorAll('source'))) {
        source.remove();
      }
    }
  }

  return metadata;
}

function unescapeMarkdownUrl(dest: string): string {
  return dest.replace(/\\([()\\])/g, '$1');
}

function parseMarkdownImageAt(markdown: string, start: number): MarkdownImageMatch | null {
  if (markdown[start] !== '!' || markdown[start + 1] !== '[') {
    return null;
  }

  // Parse alt text allowing escaped characters and balanced square brackets.
  let i = start + 2;
  let bracketDepth = 1;
  while (i < markdown.length && bracketDepth > 0) {
    const ch = markdown[i];
    if (ch === '\\' && i + 1 < markdown.length) {
      i += 2;
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
    } else if (ch === ']') {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        break;
      }
    }
    i += 1;
  }

  if (bracketDepth !== 0 || markdown[i + 1] !== '(') {
    return null;
  }

  const alt = markdown.slice(start + 2, i);
  let pos = i + 2;

  while (pos < markdown.length && (markdown[pos] === ' ' || markdown[pos] === '\t')) {
    pos += 1;
  }

  let rawUrl = '';
  if (markdown[pos] === '<') {
    pos += 1;
    const urlStart = pos;
    while (pos < markdown.length && markdown[pos] !== '>' && markdown[pos] !== '\n') {
      if (markdown[pos] === '\\' && pos + 1 < markdown.length) {
        pos += 2;
        continue;
      }
      pos += 1;
    }
    if (markdown[pos] !== '>') {
      return null;
    }
    rawUrl = unescapeMarkdownUrl(markdown.slice(urlStart, pos));
    pos += 1;
  } else {
    const urlStart = pos;
    let parenDepth = 0;
    while (pos < markdown.length) {
      const ch = markdown[pos];
      if (ch === '\\' && pos + 1 < markdown.length) {
        pos += 2;
        continue;
      }
      if (ch === '(') {
        parenDepth += 1;
      } else if (ch === ')') {
        if (parenDepth === 0) {
          break;
        }
        parenDepth -= 1;
      } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        break;
      }
      pos += 1;
    }
    rawUrl = unescapeMarkdownUrl(markdown.slice(urlStart, pos));
  }

  if (rawUrl.length === 0) {
    return null;
  }

  const titleStart = pos;
  while (pos < markdown.length && markdown[pos] !== ')') {
    const ch = markdown[pos];
    if (ch === '\\' && pos + 1 < markdown.length) {
      pos += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      pos += 1;
      while (pos < markdown.length && markdown[pos] !== quote) {
        if (markdown[pos] === '\\' && pos + 1 < markdown.length) {
          pos += 2;
          continue;
        }
        pos += 1;
      }
      if (pos < markdown.length) {
        pos += 1;
      }
      continue;
    }
    if (ch === '\n') {
      return null;
    }
    pos += 1;
  }

  if (markdown[pos] !== ')') {
    return null;
  }

  const titlePart = markdown.slice(titleStart, pos);
  const end = pos + 1;

  return {
    kind: 'markdown',
    start,
    end,
    alt,
    rawUrl,
    titlePart,
    rawMatch: markdown.slice(start, end),
  };
}

function parseHtmlImgAt(markdown: string, start: number): MarkdownImageMatch | null {
  if (markdown[start] !== '<') {
    return null;
  }
  const head = markdown.slice(start, start + 5).toLowerCase();
  if (!head.startsWith('<img') || (head.length === 5 && !/[\s/>]/.test(head[4]))) {
    return null;
  }

  // Find tag closing `>` respecting quoted attributes.
  let pos = start + 4;
  let quote: string | null = null;
  while (pos < markdown.length) {
    const ch = markdown[pos];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
    pos += 1;
  }
  if (markdown[pos] !== '>') {
    return null;
  }

  const end = pos + 1;
  const rawMatch = markdown.slice(start, end);
  const srcAttrMatch = /(?<![-\w])src\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rawMatch);
  if (!srcAttrMatch) {
    return null;
  }
  const rawUrl = (srcAttrMatch[1] ?? srcAttrMatch[2] ?? '').trim();
  if (rawUrl.length === 0) {
    return null;
  }

  const quoteOffset = srcAttrMatch[0].search(/["']/);
  const valueOffsetInAttr = srcAttrMatch[0].indexOf(rawUrl, quoteOffset + 1);
  const htmlSrcValueStart = srcAttrMatch.index + valueOffsetInAttr;
  const htmlSrcValueEnd = htmlSrcValueStart + rawUrl.length;

  const altAttrMatch = /(?<![-\w])alt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rawMatch);
  const alt = (altAttrMatch?.[1] ?? altAttrMatch?.[2] ?? '').trim();

  return {
    kind: 'html',
    start,
    end,
    alt,
    rawUrl,
    titlePart: '',
    rawMatch,
    htmlSrcValueStart,
    htmlSrcValueEnd,
  };
}

/**
 * Scans Markdown for image references while skipping fenced code blocks and
 * inline code spans so code samples are never rewritten or misclassified.
 */
function scanMarkdownImages(markdown: string): MarkdownImageMatch[] {
  const matches: MarkdownImageMatch[] = [];
  let i = 0;
  let atLineStart = true;
  let activeFenceChar: '`' | '~' | null = null;
  let activeFenceLen = 0;

  while (i < markdown.length) {
    if (atLineStart) {
      let lineIndent = i;
      while (lineIndent < markdown.length && markdown[lineIndent] === ' ' && lineIndent - i < 3) {
        lineIndent += 1;
      }
      const ch = markdown[lineIndent];
      if (ch === '`' || ch === '~') {
        let runEnd = lineIndent;
        while (runEnd < markdown.length && markdown[runEnd] === ch) {
          runEnd += 1;
        }
        const runLen = runEnd - lineIndent;
        if (runLen >= 3) {
          if (activeFenceChar === null) {
            activeFenceChar = ch;
            activeFenceLen = runLen;
            const nl = markdown.indexOf('\n', runEnd);
            i = nl === -1 ? markdown.length : nl + 1;
            atLineStart = true;
            continue;
          }
          if (activeFenceChar === ch && runLen >= activeFenceLen) {
            const restLineEnd = markdown.indexOf('\n', runEnd);
            const restOfLine =
              restLineEnd === -1
                ? markdown.slice(runEnd)
                : markdown.slice(runEnd, restLineEnd);
            if (restOfLine.trim().length === 0) {
              activeFenceChar = null;
              activeFenceLen = 0;
              i = restLineEnd === -1 ? markdown.length : restLineEnd + 1;
              atLineStart = true;
              continue;
            }
          }
        }
      }
    }

    if (activeFenceChar !== null) {
      const nl = markdown.indexOf('\n', i);
      if (nl === -1) {
        break;
      }
      i = nl + 1;
      atLineStart = true;
      continue;
    }

    const ch = markdown[i];
    if (ch === '\n') {
      atLineStart = true;
      i += 1;
      continue;
    }

    // Skip inline code spans (`...` or ``...``).
    if (ch === '`') {
      let ticksEnd = i;
      while (ticksEnd < markdown.length && markdown[ticksEnd] === '`') {
        ticksEnd += 1;
      }
      const tickCount = ticksEnd - i;
      const closing = '`'.repeat(tickCount);
      const closeIdx = markdown.indexOf(closing, ticksEnd);
      if (closeIdx !== -1) {
        i = closeIdx + tickCount;
        atLineStart = false;
        continue;
      }
      i = ticksEnd;
      atLineStart = false;
      continue;
    }

    if (ch === '!' && markdown[i + 1] === '[') {
      const mdMatch = parseMarkdownImageAt(markdown, i);
      if (mdMatch) {
        matches.push(mdMatch);
        i = mdMatch.end;
        atLineStart = false;
        continue;
      }
    }

    if (ch === '<') {
      const htmlMatch = parseHtmlImgAt(markdown, i);
      if (htmlMatch) {
        matches.push(htmlMatch);
        i = htmlMatch.end;
        atLineStart = false;
        continue;
      }
    }

    atLineStart = false;
    i += 1;
  }

  return matches;
}

function buildSuggestedImageName(resolvedUrl: string, index: number): string {
  const prefix = String(index).padStart(2, '0');
  try {
    const parsed = new URL(resolvedUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] ?? '';
    const decoded = decodeURIComponent(lastSegment);
    const withoutSizeSuffix = decoded.replace(
      /:(?:orig|large|medium|small|thumb|\d+x\d+)$/i,
      '',
    );
    const withoutExt = withoutSizeSuffix.replace(/\.[a-zA-Z0-9]{1,8}$/, '');
    const slug = slugifyTitle(withoutExt, 40);
    if (slug !== 'untitled') {
      return `${prefix}-${slug}`;
    }
  } catch {
    // Fall back to positional name below.
  }
  return `image-${prefix}`;
}

/**
 * Extracts and deduplicates all downloadable remote images referenced in Markdown.
 * Identical normalized URLs produce a single `DiscoveredImage` entry whose `sourceUrls`
 * tracks every raw URL variant encountered.
 */
export function discoverImagesFromMarkdown(
  markdown: string,
  baseUrl: string,
  domMeta?: ReadonlyMap<string, DomImageMetadata>,
): DiscoveredImage[] {
  const matches = scanMarkdownImages(markdown);
  const byResolvedUrl = new Map<string, DiscoveredImage>();

  for (const match of matches) {
    const resolvedUrl = normalizeImageUrl(match.rawUrl, baseUrl);
    if (!resolvedUrl) {
      continue;
    }

    const existing = byResolvedUrl.get(resolvedUrl);
    if (existing) {
      if (!existing.sourceUrls.includes(match.rawUrl)) {
        existing.sourceUrls.push(match.rawUrl);
      }
      if (!existing.alt && match.alt.trim().length > 0) {
        existing.alt = match.alt.trim();
      }
      continue;
    }

    const index = byResolvedUrl.size + 1;
    const meta = domMeta?.get(resolvedUrl);
    const discovered: DiscoveredImage = {
      id: `img-${String(index).padStart(2, '0')}`,
      originalUrl: match.rawUrl,
      resolvedUrl,
      sourceUrls: [match.rawUrl],
      alt: match.alt.trim() || meta?.alt || '',
      suggestedName: buildSuggestedImageName(resolvedUrl, index),
      ...(meta?.width !== undefined ? { width: meta.width } : {}),
      ...(meta?.height !== undefined ? { height: meta.height } : {}),
    };
    byResolvedUrl.set(resolvedUrl, discovered);
  }

  return Array.from(byResolvedUrl.values());
}

/**
 * Formats a human-readable frontmatter warning for an image that fell back to its
 * original remote URL.
 */
export function formatImageFailureWarning(failure: ImageFetchFailure): string {
  const statusSuffix =
    typeof failure.status === 'number' ? ` (HTTP ${failure.status})` : '';
  return `Image download failed for ${failure.resolvedUrl}${statusSuffix}: ${failure.reason}; kept original URL.`;
}

function buildLocalRelativePath(filename: string): string {
  const safeName = filename.replace(/^\/+/, '').replace(/^\.\/images\//, '');
  return `./images/${safeName}`;
}

function formatMarkdownDestination(path: string): string {
  if (/[\s<>]/.test(path)) {
    return `<${path}>`;
  }
  return path.replace(/([()])/g, '\\$1');
}

/**
 * Rewrites Markdown (and inline HTML `<img>`) image URLs for successfully downloaded
 * images to `./images/<filename>`, while preserving original remote URLs and generating
 * structured warnings for any failed images.
 */
export function rewriteMarkdownImageUrls(
  markdown: string,
  baseUrl: string,
  succeeded: ReadonlyArray<RewriteImageMapping>,
  failed: ReadonlyArray<ImageFetchFailure> = [],
): RewriteMarkdownImagesResult {
  const localPathByKey = new Map<string, string>();

  for (const item of succeeded) {
    const localPath = buildLocalRelativePath(item.filename);
    const keys = [
      item.resolvedUrl,
      item.originalUrl,
      ...(item.sourceUrls ?? []),
    ];
    for (const key of keys) {
      if (!key) {
        continue;
      }
      localPathByKey.set(key, localPath);
      const normalized = normalizeImageUrl(key, baseUrl);
      if (normalized) {
        localPathByKey.set(normalized, localPath);
      }
    }
  }

  const matches = scanMarkdownImages(markdown);
  const localImagePaths: string[] = [];
  const seenLocalPaths = new Set<string>();
  let rewrittenCount = 0;

  let output = '';
  let cursor = 0;

  for (const match of matches) {
    output += markdown.slice(cursor, match.start);

    const normalizedRaw = normalizeImageUrl(match.rawUrl, baseUrl);
    const localPath =
      localPathByKey.get(match.rawUrl) ??
      (normalizedRaw ? localPathByKey.get(normalizedRaw) : undefined);

    if (localPath) {
      rewrittenCount += 1;
      if (!seenLocalPaths.has(localPath)) {
        seenLocalPaths.add(localPath);
        localImagePaths.push(localPath);
      }

      if (match.kind === 'markdown') {
        output += `![${match.alt}](${formatMarkdownDestination(localPath)}${match.titlePart})`;
      } else if (
        match.htmlSrcValueStart !== undefined &&
        match.htmlSrcValueEnd !== undefined
      ) {
        output +=
          match.rawMatch.slice(0, match.htmlSrcValueStart) +
          localPath +
          match.rawMatch.slice(match.htmlSrcValueEnd);
      } else {
        output += match.rawMatch;
      }
    } else {
      output += match.rawMatch;
    }

    cursor = match.end;
  }

  output += markdown.slice(cursor);

  const warnings = failed.map(formatImageFailureWarning);

  return {
    markdown: output,
    rewrittenCount,
    localImagePaths,
    warnings,
  };
}
