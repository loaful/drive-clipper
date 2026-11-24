import Defuddle, {
  createMarkdownContent,
  type DefuddleOptions,
  type DefuddleResponse,
} from 'defuddle/full';
import type { ClipMode, ExtractedPage, PageInfo } from '../types.js';
import { cleanPageTitle } from './frontmatter.js';
import {
  discoverImagesFromMarkdown,
  resolveDomImages,
  type DomImageMetadata,
} from './images.js';
import {
  flattenShadowDom,
  LIVE_IMG_ATTRS,
  type FlattenShadowDomOptions,
} from './shadow-dom.js';
import {
  appendMissingXMediaToMarkdown,
  extractXPostMedia,
  isXUrl,
} from './x-media.js';

export const DEFAULT_PARSE_ASYNC_TIMEOUT_MS = 8_000;

export interface DefuddleInstance {
  parse(): DefuddleResponse;
  parseAsync(): Promise<DefuddleResponse>;
}

export interface ExtractPageOptions {
  mode?: ClipMode;
  /** Timeout for `Defuddle.parseAsync()` before falling back to sync `.parse()`. Defaults to 8000ms. */
  asyncTimeoutMs?: number;
  shadowDomOptions?: FlattenShadowDomOptions;
  /** Optional Selection override (defaults to `doc.defaultView?.getSelection()`). */
  selection?: Selection | null;
  /** Optional Defuddle factory injected for deterministic unit testing. */
  createDefuddle?: (doc: Document, options: DefuddleOptions) => DefuddleInstance;
  /** Optional Markdown converter override. */
  markdownConverter?: (html: string, url: string) => string;
  /** Optional clock override for deterministic `extractedAt` timestamps. */
  now?: () => Date;
}

class ParseAsyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Defuddle parseAsync timed out after ${timeoutMs}ms`);
    this.name = 'ParseAsyncTimeoutError';
  }
}

function readMetaContent(doc: Document, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const value = el?.getAttribute('content')?.trim();
    if (value && value.length > 0) {
      return value;
    }
  }
  return null;
}

function deriveSiteName(doc: Document, url: string): string | null {
  const metaSite = readMetaContent(doc, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
    'meta[name="twitter:site"]',
  ]);
  if (metaSite) {
    return metaSite;
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

function readFallbackMetadata(doc: Document, url: string): {
  title: string;
  author: string | null;
  published: string | null;
  site: string | null;
  description: string | null;
} {
  const rawTitle =
    doc.title?.trim() ||
    readMetaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    doc.querySelector('h1')?.textContent?.trim() ||
    'Untitled';
  const title = cleanPageTitle(rawTitle) || 'Untitled';

  const author = readMetaContent(doc, [
    'meta[name="author"]',
    'meta[property="article:author"]',
    'meta[name="twitter:creator"]',
  ]);

  const published =
    readMetaContent(doc, [
      'meta[property="article:published_time"]',
      'meta[name="pubdate"]',
      'meta[name="publishdate"]',
      'meta[name="date"]',
    ]) ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime')?.trim() ||
    null;

  const description = readMetaContent(doc, [
    'meta[name="description"]',
    'meta[property="og:description"]',
  ]);

  return {
    title,
    author,
    published,
    site: deriveSiteName(doc, url),
    description,
  };
}

function getActiveSelection(
  doc: Document,
  override?: Selection | null,
): Selection | null {
  if (override !== undefined) {
    return override;
  }
  try {
    return doc.defaultView?.getSelection() ?? null;
  } catch {
    return null;
  }
}

function getSelectionText(selection: Selection | null): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return '';
  }
  return selection.toString().trim();
}

/**
 * Returns lightweight page metadata and active selection state without mutating the page.
 */
export function getPageInfo(
  doc: Document,
  url: string,
  selectionOverride?: Selection | null,
): Omit<PageInfo, 'tabId'> {
  const selection = getActiveSelection(doc, selectionOverride);
  const selectedText = getSelectionText(selection);
  const fallbackMeta = readFallbackMetadata(doc, url);

  return {
    url,
    title: fallbackMeta.title,
    hasSelection: selectedText.length > 0,
    selectionLength: selectedText.length,
    site: fallbackMeta.site,
  };
}

function buildSelectionHtml(
  doc: Document,
  selection: Selection,
  url: string,
): { html: string; domMeta: Map<string, DomImageMetadata> } {
  const selectionDoc = doc.implementation.createHTMLDocument(doc.title || '');
  const container = selectionDoc.createElement('article');
  selectionDoc.body.appendChild(container);

  // Capture live image metadata for any images intersecting the selection without mutating live DOM.
  const liveImagesBySrc = new Map<string, HTMLImageElement>();
  try {
    for (const liveImg of Array.from(doc.querySelectorAll('img'))) {
      if (selection.containsNode(liveImg, true)) {
        const key =
          liveImg.getAttribute('src') ??
          liveImg.getAttribute('data-src') ??
          liveImg.currentSrc ??
          '';
        if (key && !liveImagesBySrc.has(key)) {
          liveImagesBySrc.set(key, liveImg as HTMLImageElement);
        }
      }
    }
  } catch {
    // Some jsdom versions may not support `containsNode` on detached nodes; proceed with attributes.
  }

  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    const fragment = range.cloneContents();
    container.appendChild(selectionDoc.importNode(fragment, true));
  }

  for (const clonedImg of Array.from(container.querySelectorAll('img'))) {
    const key =
      clonedImg.getAttribute('src') ??
      clonedImg.getAttribute('data-src') ??
      '';
    const liveImg = key ? liveImagesBySrc.get(key) : undefined;
    if (liveImg) {
      if (liveImg.currentSrc) {
        clonedImg.setAttribute(LIVE_IMG_ATTRS.currentSrc, liveImg.currentSrc);
      }
      if (liveImg.naturalWidth > 0) {
        clonedImg.setAttribute(LIVE_IMG_ATTRS.naturalWidth, String(liveImg.naturalWidth));
      }
      if (liveImg.naturalHeight > 0) {
        clonedImg.setAttribute(LIVE_IMG_ATTRS.naturalHeight, String(liveImg.naturalHeight));
      }
    }
  }

  const domMeta = resolveDomImages(container, url);
  return { html: container.innerHTML, domMeta };
}

async function parseWithTimeoutFallback(
  preparedDoc: Document,
  url: string,
  asyncTimeoutMs: number,
  createDefuddle: (doc: Document, options: DefuddleOptions) => DefuddleInstance,
  warnings: string[],
): Promise<DefuddleResponse> {
  const asyncInstance = createDefuddle(preparedDoc, { url });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ParseAsyncTimeoutError(asyncTimeoutMs));
      }, asyncTimeoutMs);
    });

    return await Promise.race([asyncInstance.parseAsync(), timeoutPromise]);
  } catch (err) {
    if (err instanceof ParseAsyncTimeoutError) {
      warnings.push(
        `Defuddle async parse timed out after ${asyncTimeoutMs}ms; fell back to synchronous parse.`,
      );
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Defuddle async parse failed (${reason}); fell back to synchronous parse.`,
      );
    }
    const syncInstance = createDefuddle(preparedDoc, { url });
    return syncInstance.parse();
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts either the active selection or the full article from `doc` using
 * bounded Shadow DOM flattening, lazy-load image resolution, Defuddle (`parseAsync`
 * with 8s timeout fallback to sync `parse`), and Markdown conversion.
 */
export async function extractPage(
  doc: Document,
  url: string,
  options: ExtractPageOptions = {},
): Promise<ExtractedPage> {
  const requestedMode: ClipMode = options.mode ?? 'full';
  const asyncTimeoutMs = options.asyncTimeoutMs ?? DEFAULT_PARSE_ASYNC_TIMEOUT_MS;
  const createDefuddle =
    options.createDefuddle ?? ((d, opts) => new Defuddle(d, opts));
  const markdownConverter = options.markdownConverter ?? createMarkdownContent;
  const extractedAt = (options.now ?? (() => new Date()))().toISOString();

  const warnings: string[] = [];
  const selection = getActiveSelection(doc, options.selection);
  const selectedText = getSelectionText(selection);
  const hasSelection = selectedText.length > 0;
  const fallbackMeta = readFallbackMetadata(doc, url);

  if (requestedMode === 'selection' && hasSelection && selection) {
    const { html, domMeta } = buildSelectionHtml(doc, selection, url);
    const markdown = markdownConverter(html, url).trim();
    const images = discoverImagesFromMarkdown(markdown, url, domMeta);

    return {
      url,
      title: fallbackMeta.title,
      author: fallbackMeta.author,
      published: fallbackMeta.published,
      site: fallbackMeta.site,
      description: fallbackMeta.description,
      markdown,
      mode: 'selection',
      hasSelection: true,
      images,
      warnings,
      extractedAt,
    };
  }

  if (requestedMode === 'selection' && !hasSelection) {
    warnings.push('No active text selection found; clipped full page instead.');
  }

  const flattened = flattenShadowDom(doc, options.shadowDomOptions);
  warnings.push(...flattened.warnings);

  const domMeta = resolveDomImages(flattened.document, url);
  const xMedia = isXUrl(url) ? extractXPostMedia(flattened.document, url) : [];
  for (const item of xMedia) {
    if (!domMeta.has(item.url)) {
      const sourceMeta = domMeta.get(item.sourceUrl);
      if (sourceMeta) {
        domMeta.set(item.url, sourceMeta);
      }
    }
  }

  const parsed = await parseWithTimeoutFallback(
    flattened.document,
    url,
    asyncTimeoutMs,
    createDefuddle,
    warnings,
  );

  const rawMarkdown = markdownConverter(parsed.content || '', url).trim();
  const markdown =
    xMedia.length > 0
      ? appendMissingXMediaToMarkdown(rawMarkdown, xMedia, url)
      : rawMarkdown;
  const images = discoverImagesFromMarkdown(markdown, url, domMeta);

  const parsedTitle = nonEmptyOrNull(parsed.title);

  return {
    url,
    title: parsedTitle
      ? cleanPageTitle(parsedTitle) || fallbackMeta.title
      : fallbackMeta.title,
    author: nonEmptyOrNull(parsed.author) ?? fallbackMeta.author,
    published: nonEmptyOrNull(parsed.published) ?? fallbackMeta.published,
    site: nonEmptyOrNull(parsed.site) ?? fallbackMeta.site,
    description: nonEmptyOrNull(parsed.description) ?? fallbackMeta.description,
    markdown,
    mode: 'full',
    hasSelection,
    images,
    warnings,
    extractedAt,
  };
}
