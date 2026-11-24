import {
  discoverImagesFromMarkdown,
  isTrackingPixel,
  normalizeImageUrl,
} from './images.js';

export type XMediaKind = 'photo' | 'video-poster' | 'card';

export interface ExtractedXMedia {
  /** High-quality normalized URL to embed and fetch (e.g. `name=large` on `pbs.twimg.com/media/...`). */
  url: string;
  /** Original resolved DOM URL prior to high-quality upgrade (for DOM metadata lookup). */
  sourceUrl: string;
  /** Canonical deduplication key (normalizes `name=` variants and legacy `:size` suffixes). */
  dedupKey: string;
  /** Cleaned alt text (empty string when none is present). */
  alt: string;
  /** Classification of the extracted tweet media. */
  kind: XMediaKind;
}

const X_HOSTNAMES = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'm.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'm.twitter.com',
]);

const RESERVED_HANDLE_PATHS = new Set([
  'i',
  'home',
  'explore',
  'search',
  'notifications',
  'messages',
  'settings',
  'compose',
  'hashtag',
  'intent',
]);

const STATUS_PATH_RE =
  /^(?:https?:\/\/(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com)?\/(\w{1,15})\/status\/(\d+)\/?(?:[?#]|$)/i;

const EMBEDDED_POST_SELECTOR = '[data-slot="embedded-tweet-frame"]';
const AVATAR_ANCESTOR_SELECTOR =
  '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar"], [data-testid="User-Name"]';
const PHOTO_CONTAINER_SELECTOR =
  '[data-testid="tweetPhoto"], [data-testid="tweet-image"]';
const CARD_CONTAINER_SELECTOR =
  '[data-testid="card.wrapper"], [data-testid="card.layoutLarge.media"], [data-testid="card.layoutSmall.media"]';
const VIDEO_CONTAINER_SELECTOR =
  '[data-testid="videoPlayer"], [data-testid="videoComponent"]';

const LEGACY_TWITTER_SIZE_SUFFIX_RE =
  /:(?:orig|large|medium|small|thumb|\d+x\d+)$/i;
const MEDIA_EXT_SUFFIX_RE = /\.(?:jpe?g|png|webp|gif|avif)$/i;

const EXCLUDED_TWIMG_HOSTS = new Set(['abs.twimg.com', 'abs-0.twimg.com']);
const EXCLUDED_PATH_FRAGMENTS = [
  '/profile_images/',
  '/sticky/default_profile_images/',
  '/profile_banners/',
  '/emoji/',
  '/twemoji/',
  '/hashflags/',
];

const BG_DECL_RE = /background(?:-image)?\s*:\s*((?:[^;"']|"[^"]*"|'[^']*')+)/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;

const COMMENTS_DIVIDER_RE = /\n+---[ \t]*\n+## Comments(?:\n|$)/;

/**
 * Returns true when `url` points to an X.com or Twitter.com HTTP(S) page.
 */
export function isXUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return X_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isExcludedXMediaUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (EXCLUDED_TWIMG_HOSTS.has(host)) {
    return true;
  }
  const lowerPath = parsed.pathname.toLowerCase();
  return EXCLUDED_PATH_FRAGMENTS.some((fragment) => lowerPath.includes(fragment));
}

function isPbsTwimgHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'pbs.twimg.com' || lower === 'ton.twimg.com';
}

function isPbsMediaPath(parsed: URL): boolean {
  return (
    parsed.hostname.toLowerCase() === 'pbs.twimg.com' &&
    parsed.pathname.startsWith('/media/')
  );
}

/**
 * Normalizes an X/Twitter media URL:
 * - Resolves relative URLs, decodes `&amp;`, strips `#fragment`, rejects placeholders.
 * - Upgrades `pbs.twimg.com/media/...` URLs consistently to `name=large` while preserving
 *   `format=...` and stripping legacy `:small`/`:large` path suffixes.
 * - Preserves exact query parameters on `card_img` and `*_video_thumb` URLs where
 *   changing `name=` can 404 on X's CDN.
 */
export function normalizeXMediaUrl(
  rawUrl: string | null | undefined,
  baseUrl = 'https://x.com/',
): string | null {
  const normalized = normalizeImageUrl(rawUrl, baseUrl);
  if (!normalized) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  if (isExcludedXMediaUrl(parsed)) {
    return null;
  }

  if (isPbsMediaPath(parsed)) {
    parsed.pathname = parsed.pathname.replace(LEGACY_TWITTER_SIZE_SUFFIX_RE, '');
    parsed.searchParams.set('name', 'large');
    return parsed.toString();
  }

  return parsed.toString();
}

/**
 * Computes a canonical deduplication key for an X/Twitter media URL so size/format
 * variants of the same asset (e.g. `?format=jpg&name=small`, `?name=900x900&format=jpg`,
 * `?format=jpg&name=large`, `.jpg:small`) collapse to one key.
 */
export function getXMediaDedupKey(
  rawUrl: string | null | undefined,
  baseUrl = 'https://x.com/',
): string | null {
  const normalized = normalizeImageUrl(rawUrl, baseUrl);
  if (!normalized) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/')) {
    const cleanPath = parsed.pathname
      .replace(LEGACY_TWITTER_SIZE_SUFFIX_RE, '')
      .replace(MEDIA_EXT_SUFFIX_RE, '');
    return `${parsed.protocol}//${host}${cleanPath}`;
  }

  const params = new URLSearchParams(parsed.searchParams);
  params.delete('name');
  params.sort();
  const query = params.toString();
  return `${parsed.protocol}//${host}${parsed.pathname}${query ? `?${query}` : ''}`;
}

function ownElements(root: Element, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((el) => {
    const scope = el.parentElement?.closest(`article, ${EMBEDDED_POST_SELECTOR}`);
    return !scope || scope === root || !root.contains(scope);
  });
}

function findStatusLink(
  tweet: Element,
): { href: string; handle: string; id: string } | null {
  for (const link of ownElements(tweet, 'a[href]')) {
    const href = link.getAttribute('href') ?? '';
    const match = STATUS_PATH_RE.exec(href);
    if (match) {
      return { href, handle: match[1], id: match[2] };
    }
  }
  return null;
}

function getTweetHandle(tweet: Element): string {
  const nameElement = ownElements(tweet, '[data-testid="User-Name"]')[0] ?? null;
  if (!nameElement) {
    const status = findStatusLink(tweet);
    return status ? `@${status.handle.toLowerCase()}` : '';
  }

  const links = Array.from(nameElement.querySelectorAll('a'));
  for (const link of links) {
    const text = link.textContent?.trim() ?? '';
    if (/^@\w{1,15}$/.test(text)) {
      return text.toLowerCase();
    }
  }
  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    const match = /^(?:https?:\/\/[^/]+)?\/(\w{1,15})(?:\/|$)/.exec(href);
    if (match && !RESERVED_HANDLE_PATHS.has(match[1].toLowerCase())) {
      return `@${match[1].toLowerCase()}`;
    }
  }
  const textMatch = /@(\w{1,15})/.exec(nameElement.textContent ?? '');
  return textMatch ? `@${textMatch[1].toLowerCase()}` : '';
}

function collectLegacyConversationEntries(doc: Document): Array<Element | null> {
  const cells: Element[] = [];
  for (const el of Array.from(
    doc.querySelectorAll('[data-testid="cellInnerDiv"], section, h2'),
  )) {
    if (el.getAttribute('data-testid') === 'cellInnerDiv') {
      cells.push(el);
    } else if (cells.length > 0 && !el.closest('article[data-testid="tweet"]')) {
      // Stop at trailing "Discover more" / section boundaries outside a tweet.
      break;
    }
  }

  if (cells.length > 0) {
    return cells.map((cell) => cell.querySelector('article[data-testid="tweet"]'));
  }

  return Array.from(doc.querySelectorAll('article[data-testid="tweet"]')).filter(
    (article) => !article.parentElement?.closest('article'),
  );
}

function collectRedesignConversationEntries(doc: Document): Array<Element | null> {
  const posts = Array.from(doc.querySelectorAll('article')).filter(
    (article) => !article.parentElement?.closest('article') && Boolean(findStatusLink(article)),
  );
  if (posts.length === 0) {
    return [];
  }

  const list = posts
    .map((post) => post.closest('li')?.parentElement ?? null)
    .find((parent): parent is HTMLElement => parent !== null);
  if (!list) {
    return posts.slice(0, 1);
  }

  const entries: Array<Element | null> = [];
  for (const item of Array.from(list.children)) {
    const itemPosts = posts.filter((post) => item.contains(post));
    if (itemPosts.length === 0 && entries.length > 0 && item.querySelector('h2')) {
      break;
    }
    entries.push(...itemPosts, null);
  }
  return entries;
}

/**
 * Selects the main post (plus consecutive self-thread posts by the same author)
 * while excluding unrelated replies and trailing "Discover more" timelines.
 */
function collectTargetTweetRoots(doc: Document): Element[] {
  const articleReadView = doc.querySelector(
    '[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]',
  );
  if (articleReadView) {
    return [articleReadView];
  }

  const hasLegacyTweets = Boolean(doc.querySelector('article[data-testid="tweet"]'));
  const entries = hasLegacyTweets
    ? collectLegacyConversationEntries(doc)
    : collectRedesignConversationEntries(doc);

  const selected: Element[] = [];
  let mainHandle = '';

  for (const article of entries) {
    if (!article) {
      continue;
    }
    if (selected.length === 0) {
      selected.push(article);
      mainHandle = getTweetHandle(article);
      continue;
    }

    const handle = getTweetHandle(article);
    if (mainHandle && handle && handle === mainHandle) {
      selected.push(article);
      continue;
    }

    // First tweet by another author (or unidentified reply) ends the self-thread.
    break;
  }

  return selected;
}

function extractCssBackgroundUrls(styleText: string): string[] {
  const urls: string[] = [];
  BG_DECL_RE.lastIndex = 0;

  let declMatch: RegExpExecArray | null;
  while ((declMatch = BG_DECL_RE.exec(styleText)) !== null) {
    const value = declMatch[1] ?? '';
    CSS_URL_RE.lastIndex = 0;
    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = CSS_URL_RE.exec(value)) !== null) {
      const candidate = (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3] ?? '').trim();
      if (candidate.length > 0) {
        urls.push(candidate);
      }
    }
  }

  return urls;
}

function classifyMediaCandidate(
  parsed: URL,
  el: Element,
  isVideoPoster: boolean,
): XMediaKind | null {
  if (isExcludedXMediaUrl(parsed)) {
    return null;
  }

  const pathLower = parsed.pathname.toLowerCase();
  const isTwimg = isPbsTwimgHost(parsed.hostname);

  if (isVideoPoster) {
    return 'video-poster';
  }
  if (isTwimg && pathLower.includes('video_thumb')) {
    return 'video-poster';
  }
  if (isTwimg && pathLower.startsWith('/card_img/')) {
    return 'card';
  }
  if (isTwimg && pathLower.startsWith('/media/')) {
    return 'photo';
  }

  if (el.closest(CARD_CONTAINER_SELECTOR)) {
    return 'card';
  }
  if (el.closest(VIDEO_CONTAINER_SELECTOR)) {
    return 'video-poster';
  }
  if (el.closest(PHOTO_CONTAINER_SELECTOR)) {
    return 'photo';
  }

  return null;
}

function cleanAltText(raw: string | null | undefined): string {
  if (!raw) {
    return '';
  }
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts media (photos, CSS background-image fallbacks, video posters, and card images)
 * from the main X.com/Twitter post and any consecutive self-thread tweets (including
 * embedded quoted tweets), in document order, deduplicated by canonical media key.
 */
export function extractXPostMedia(
  doc: Document,
  pageUrl: string,
): ExtractedXMedia[] {
  const roots = collectTargetTweetRoots(doc);
  if (roots.length === 0) {
    return [];
  }

  const byDedupKey = new Map<string, ExtractedXMedia>();

  const registerCandidate = (
    rawUrl: string | null | undefined,
    el: Element,
    alt: string,
    isVideoPoster: boolean,
  ): void => {
    if (!rawUrl || el.closest(AVATAR_ANCESTOR_SELECTOR)) {
      return;
    }

    const sourceUrl = normalizeImageUrl(rawUrl, pageUrl);
    if (!sourceUrl) {
      return;
    }

    let parsedSource: URL;
    try {
      parsedSource = new URL(sourceUrl);
    } catch {
      return;
    }

    const kind = classifyMediaCandidate(parsedSource, el, isVideoPoster);
    if (!kind) {
      return;
    }

    const url = normalizeXMediaUrl(sourceUrl, pageUrl);
    const dedupKey = getXMediaDedupKey(sourceUrl, pageUrl);
    if (!url || !dedupKey) {
      return;
    }

    const cleanedAlt = cleanAltText(alt);
    const existing = byDedupKey.get(dedupKey);
    if (existing) {
      if (!existing.alt && cleanedAlt) {
        existing.alt = cleanedAlt;
      }
      return;
    }

    byDedupKey.set(dedupKey, {
      url,
      sourceUrl,
      dedupKey,
      alt: cleanedAlt,
      kind,
    });
  };

  for (const root of roots) {
    const candidates = Array.from(
      root.querySelectorAll('img, video[poster], [style*="background"]'),
    );

    for (const el of candidates) {
      const tag = el.tagName.toUpperCase();

      if (tag === 'IMG') {
        if (isTrackingPixel(el)) {
          continue;
        }
        const src = el.getAttribute('src');
        const alt = el.getAttribute('alt') ?? '';
        registerCandidate(src, el, alt, false);
        continue;
      }

      if (tag === 'VIDEO') {
        const poster = el.getAttribute('poster');
        const label =
          cleanAltText(el.getAttribute('aria-label')) || 'Video thumbnail';
        registerCandidate(poster, el, label, true);
        continue;
      }

      const style = el.getAttribute('style') ?? '';
      const bgUrls = extractCssBackgroundUrls(style);
      if (bgUrls.length === 0) {
        continue;
      }

      // Only inspect background-image inside media containers or direct Twitter media URLs.
      const insideMediaContainer = Boolean(
        el.closest(`${PHOTO_CONTAINER_SELECTOR}, ${CARD_CONTAINER_SELECTOR}`),
      );
      const fallbackAlt = cleanAltText(el.getAttribute('aria-label'));
      for (const bgUrl of bgUrls) {
        if (!insideMediaContainer) {
          const resolved = normalizeImageUrl(bgUrl, pageUrl);
          if (!resolved) {
            continue;
          }
          try {
            const parsed = new URL(resolved);
            if (!isPbsTwimgHost(parsed.hostname)) {
              continue;
            }
          } catch {
            continue;
          }
        }
        registerCandidate(bgUrl, el, fallbackAlt, false);
      }
    }
  }

  return Array.from(byDedupKey.values());
}

function escapeMarkdownAlt(alt: string): string {
  return alt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\[\]])/g, '\\$1');
}

function formatMarkdownDestination(url: string): string {
  if (/[\s<>]/.test(url)) {
    return `<${url}>`;
  }
  return url.replace(/([()])/g, '\\$1');
}

/**
 * Inserts any missing X.com post media into `markdown`, deduplicating against
 * images already emitted by Defuddle (regardless of `name=` size param variants).
 * When a Defuddle `--- / ## Comments` section exists, missing post media is inserted
 * immediately before it rather than appended below replies.
 */
export function appendMissingXMediaToMarkdown(
  markdown: string,
  media: readonly ExtractedXMedia[],
  pageUrl: string,
): string {
  if (media.length === 0) {
    return markdown;
  }

  const commentsMatch = COMMENTS_DIVIDER_RE.exec(markdown);
  const postSection = commentsMatch
    ? markdown.slice(0, commentsMatch.index)
    : markdown;

  const existingKeys = new Set<string>();
  for (const img of discoverImagesFromMarkdown(postSection, pageUrl)) {
    existingKeys.add(img.resolvedUrl);
    const key = getXMediaDedupKey(img.resolvedUrl, pageUrl);
    if (key) {
      existingKeys.add(key);
    }
  }

  const missingLines: string[] = [];
  for (const item of media) {
    if (existingKeys.has(item.dedupKey) || existingKeys.has(item.url)) {
      continue;
    }
    existingKeys.add(item.dedupKey);
    existingKeys.add(item.url);
    missingLines.push(
      `![${escapeMarkdownAlt(item.alt)}](${formatMarkdownDestination(item.url)})`,
    );
  }

  if (missingLines.length === 0) {
    return markdown;
  }

  const block = missingLines.join('\n\n');

  if (commentsMatch) {
    const before = postSection.trimEnd();
    const after = markdown.slice(commentsMatch.index);
    return before.length > 0 ? `${before}\n\n${block}${after}` : `${block}${after}`;
  }

  const trimmed = markdown.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}
