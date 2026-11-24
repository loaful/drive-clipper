import type { FrontmatterPreferences } from '../types.js';

export const OKF_VERSION = '0.2';
export const OKF_CLIP_TYPE = 'web-clip';
export const OKF_DEFAULT_STATUS = 'raw';
export const OKF_GENERATOR = 'drive-clipper';
export const DEFAULT_ROOT_INDEX_DESCRIPTION =
  'Web clips archived by Drive Clipper in Open Knowledge Format.';

const DEFAULT_FRONTMATTER_PREFS: FrontmatterPreferences = {
  includeAuthor: true,
  includePublished: true,
  includeSite: true,
  includeImages: true,
  includeWarnings: true,
};

const LATIN_WITH_DIACRITICS_RE = /[\u00C0-\u024F\u1E00-\u1EFF]/g;
const COMBINING_DIACRITICS_RE = /[\u0300-\u036f]/g;
const NON_ALNUM_UNICODE_RE = /[^\p{L}\p{N}]+/gu;

const SAFE_UNQUOTED_YAML_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const YAML_RESERVED_LITERAL_RE =
  /^(?:true|false|yes|no|on|off|null|~|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\d{4}-\d{2}-\d{2})$/i;

const ZH_NOTIFICATION_UNIT =
  '(?:封私信|条私信|条新消息|条消息|条通知|条未读消息|条未读|个未读|个新消息|个通知|个提醒|条提醒|条新动态|条动态|条评论|条回复|封未读邮件|封邮件)';
const ZH_NOTIFICATION_CLAUSE = `\\d+\\+?\\s*${ZH_NOTIFICATION_UNIT}`;
const ZH_NOTIFICATION_INNER = `${ZH_NOTIFICATION_CLAUSE}(?:\\s*[/／、,，·|]\\s*${ZH_NOTIFICATION_CLAUSE})*`;
const EN_NOTIFICATION_INNER =
  '\\d+\\+?\\s*(?:unread(?:\\s+(?:messages?|emails?|notifications?|items?))?|new\\s+(?:messages?|notifications?|alerts?)|messages?|notifications?|alerts?)';
// 1–3 digits (1..999) with optional "+", avoiding 4-digit years like "(2026)".
const NUMERIC_UNREAD_INNER = '[1-9]\\d{0,2}\\+?';

const LEADING_UNREAD_PREFIX_RE = new RegExp(
  `^(?:[•·]\\s*)?(?:` +
    `(?:\\(\\s*${ZH_NOTIFICATION_INNER}\\s*\\)|\\[\\s*${ZH_NOTIFICATION_INNER}\\s*\\]|（\\s*${ZH_NOTIFICATION_INNER}\\s*）)\\s*` +
    `|` +
    `(?:\\(\\s*${EN_NOTIFICATION_INNER}\\s*\\)|\\[\\s*${EN_NOTIFICATION_INNER}\\s*\\]|（\\s*${EN_NOTIFICATION_INNER}\\s*）)(?:\\s+|(?=[^\\x00-\\x7f]))` +
    `|` +
    `(?:\\(\\s*${NUMERIC_UNREAD_INNER}\\s*\\)|\\[\\s*${NUMERIC_UNREAD_INNER}\\s*\\])(?:\\s+|(?=[^\\x00-\\x7f]))` +
    `|` +
    `（\\s*${NUMERIC_UNREAD_INNER}\\s*）\\s*` +
    `)`,
  'i',
);

const KNOWN_SITE_SUFFIX_NAMES = [
  '知乎专栏',
  '知乎',
  '微信公众平台',
  '微信公众号',
  '稀土掘金',
  '掘金',
  '少数派',
  'sspai',
  'CSDN博客',
  'CSDN',
  '博客园',
  '简书',
  '豆瓣',
  '哔哩哔哩',
  'bilibili',
  '36氪',
  '虎嗅',
  'InfoQ',
  'V2EX',
  'SegmentFault\\s*思否',
  '开源中国',
  'OSCHINA',
  '维基百科(?:[，,]\\s*自由的百科全书)?',
  'Wikipedia(?:,\\s*the free encyclopedia)?',
  'X',
  'Twitter',
  'Medium',
  'Substack',
  'GitHub',
  'DEV Community',
  'Hashnode',
  'Hacker News',
  'Reddit',
  'YouTube',
  'LinkedIn',
  'Stack Overflow',
  'Ars Technica',
  'The Verge',
  'TechCrunch',
  'Wired',
  'The New York Times',
  'Bloomberg',
  'Notion',
  'Mirror\\.xyz',
].join('|');

const TRAILING_SITE_SUFFIX_RE = new RegExp(
  `(?:\\s*[/／]\\s*(?:X|Twitter)|\\s*[-–—|·•]\\s*(?:${KNOWN_SITE_SUFFIX_NAMES}))\\s*$`,
  'i',
);

// English `<name> on X: "..."` requires a quote after the colon to avoid stripping
// legitimate essay titles such as "Notes on X: Why Microblogging Changed".
const X_WRAPPER_EN_RE =
  /^(.+?)\s+on\s+(?:X|Twitter)\s*[:：]\s*(["“「『][\s\S]+)$/i;
const X_WRAPPER_ZH_RE =
  /^(.+?)\s+在\s*(?:X|Twitter)(?:\s*上)?\s*[:：]\s*([\s\S]+)$/i;
const X_WRAPPER_ZH_PREFIX_RE =
  /^(?:X|Twitter)\s*上的\s*(.+?)\s*[:：]\s*([\s\S]+)$/i;

const INLINE_TCO_URL_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/gi;

const KNOWN_HOST_SLUGS: ReadonlyArray<readonly [string, string]> = [
  ['mp.weixin.qq.com', 'mp-weixin'],
  ['zhihu.com', 'zhihu'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['github.com', 'github'],
  ['medium.com', 'medium'],
  ['substack.com', 'substack'],
  ['wikipedia.org', 'wikipedia'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['reddit.com', 'reddit'],
  ['juejin.cn', 'juejin'],
  ['sspai.com', 'sspai'],
  ['bilibili.com', 'bilibili'],
  ['notion.so', 'notion'],
  ['notion.site', 'notion'],
];

const KNOWN_SITE_NAME_SLUGS: Readonly<Record<string, string>> = {
  知乎: 'zhihu',
  知乎专栏: 'zhihu',
  zhihu: 'zhihu',
  x: 'x',
  twitter: 'x',
  'x (twitter)': 'x',
  github: 'github',
  medium: 'medium',
  substack: 'substack',
  微信公众平台: 'mp-weixin',
  微信公众号: 'mp-weixin',
  wikipedia: 'wikipedia',
  维基百科: 'wikipedia',
  youtube: 'youtube',
  reddit: 'reddit',
  掘金: 'juejin',
  稀土掘金: 'juejin',
  少数派: 'sspai',
  sspai: 'sspai',
  哔哩哔哩: 'bilibili',
  bilibili: 'bilibili',
};

const TWO_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'com.hk',
  'com.tw',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.au',
  'com.sg',
  'co.kr',
  'com.br',
  'co.in',
  'com.mx',
]);

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOSTNAME_CANDIDATE_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
];

const CLIP_SOURCE_COMMENT_RE = /<!--\s*clip-source:\s*([\s\S]*?)\s*-->/i;
const MARKDOWN_ENTRY_LINK_RE = /^-\s+\[(?:\\.|[^\]])*\]\(([^)\s]+)\)/;

export interface FrontmatterInput {
  type?: string;
  title: string;
  description?: string | null;
  status?: string;
  url: string;
  author?: string | null;
  published?: string | null;
  clipped: string;
  site?: string | null;
  tags?: string[];
  images?: string[];
  warnings?: string[];
}

export interface RootIndexEntry {
  rootFolderName?: string;
  folderName: string;
  fileName: string;
  title: string;
  sourceUrl: string;
  clippedAt: string;
  source?: string | null;
  tags?: readonly string[];
  description?: string | null;
}

function unwrapOuterQuotes(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (
      trimmed.startsWith(open) &&
      trimmed.endsWith(close) &&
      trimmed.length >= open.length + close.length
    ) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  // Handle X titles truncated before the closing quote (e.g. `"Long tweet...`).
  for (const [open, close] of QUOTE_PAIRS) {
    if (trimmed.startsWith(open) && !trimmed.slice(open.length).includes(close)) {
      return trimmed.slice(open.length).trim();
    }
  }
  return trimmed;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Strips leading site unread/notification prefixes (e.g. Zhihu
 * `(20 封私信 / 17 条消息) ...`, X `(3) ...`, `(99+) ...`, `[12] ...`),
 * trailing site brand suffixes (` - 知乎`, ` - 知乎专栏`, ` / X`, ` / Twitter`,
 * ` | Medium`, etc.), X/Twitter wrapper boilerplate (`<name> on X: "..."`,
 * `<name> 在 Twitter: "..."`, `X 上的 <name>：“...”`), and inline `https://t.co/...`
 * short URLs while preserving legitimate parentheticals such as `(2026) Annual Report`,
 * `(Part 1) Guide`, `(RFC 9110) HTTP`, and `(Beta) Feature`.
 */
export function cleanPageTitle(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  if (trimmed.length === 0) {
    return '';
  }

  let current = trimmed;

  // 1. Strip leading unread/notification prefixes.
  for (;;) {
    const next = current.replace(LEADING_UNREAD_PREFIX_RE, '').trimStart();
    if (next === current || next.length === 0) {
      break;
    }
    current = next;
  }

  // 2. Strip known trailing site suffixes without ever emptying a bare site title.
  for (;;) {
    const next = current.replace(TRAILING_SITE_SUFFIX_RE, '').trimEnd();
    if (next === current || next.length === 0) {
      break;
    }
    current = next;
  }

  // 3. Unwrap X / Twitter `<author> on X: "..."` and Chinese variants.
  let xFallbackAuthor: string | null = null;
  const xMatch =
    X_WRAPPER_EN_RE.exec(current) ??
    X_WRAPPER_ZH_RE.exec(current) ??
    X_WRAPPER_ZH_PREFIX_RE.exec(current);
  if (xMatch) {
    const candidateAuthor = collapseWhitespace(xMatch[1]);
    const unwrappedBody = unwrapOuterQuotes(xMatch[2]);
    if (unwrappedBody.length > 0) {
      xFallbackAuthor = candidateAuthor.length > 0 ? candidateAuthor : null;
      current = unwrappedBody;
    }
  }

  // 4. Strip inline `https://t.co/...` short URLs and normalize spaces.
  const withoutTco = collapseWhitespace(current.replace(INLINE_TCO_URL_RE, ' '));
  if (withoutTco.length > 0) {
    current = withoutTco;
  } else if (xFallbackAuthor) {
    current = xFallbackAuthor;
  } else {
    current = collapseWhitespace(current);
  }

  return current;
}

/**
 * Produces a URL- and Drive-safe Unicode slug from an article title.
 * Folds Latin diacritics while preserving CJK/Kana/Hangul characters.
 */
export function slugifyTitle(title: string, maxLength = 60): string {
  const normalized = title
    .normalize('NFC')
    .replace(LATIN_WITH_DIACRITICS_RE, (ch) =>
      ch.normalize('NFD').replace(COMBINING_DIACRITICS_RE, ''),
    )
    .toLowerCase()
    .replace(NON_ALNUM_UNICODE_RE, '-')
    .replace(/^-+|-+$/g, '');

  if (normalized.length === 0) {
    return 'untitled';
  }

  const codePoints = Array.from(normalized);
  const truncated =
    codePoints.length > maxLength
      ? codePoints.slice(0, maxLength).join('').replace(/-+$/g, '')
      : normalized;

  return truncated.length > 0 ? truncated : 'untitled';
}

function extractHostname(urlOrSite: string): string | null {
  const trimmed = urlOrSite.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  if (!/\s/.test(trimmed)) {
    const bareHost = trimmed.split(/[/:?#]/, 1)[0].toLowerCase();
    if (HOSTNAME_CANDIDATE_RE.test(bareHost) || IPV4_RE.test(bareHost)) {
      return bareHost;
    }
  }

  return null;
}

function isLocalOrIpHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.includes(':') ||
    IPV4_RE.test(hostname)
  );
}

/**
 * Derives a concise lowercase source prefix from a URL, hostname, or site name
 * (e.g. `zhihu`, `x`, `github`, `medium`, `substack`, `mp-weixin`, `wikipedia`,
 * or a clean domain stem). Returns `null` for empty inputs, localhost, or raw IPs.
 */
export function deriveSourceSlug(urlOrSite?: string | null): string | null {
  if (!urlOrSite) {
    return null;
  }
  const trimmed = urlOrSite.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const hostname = extractHostname(trimmed);
  if (hostname) {
    if (isLocalOrIpHostname(hostname)) {
      return null;
    }

    for (const [hostSuffix, slug] of KNOWN_HOST_SLUGS) {
      if (hostname === hostSuffix || hostname.endsWith(`.${hostSuffix}`)) {
        return slug;
      }
    }

    const labels = hostname.split('.').filter((part) => part.length > 0);
    while (
      labels.length > 2 &&
      (labels[0] === 'www' || labels[0] === 'm' || labels[0] === 'mobile')
    ) {
      labels.shift();
    }

    let stem: string;
    if (labels.length >= 3) {
      const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
      stem = TWO_PART_PUBLIC_SUFFIXES.has(lastTwo)
        ? labels[labels.length - 3]
        : labels[labels.length - 2];
    } else if (labels.length === 2) {
      stem = labels[0];
    } else {
      stem = labels[0] ?? '';
    }

    const slug = slugifyTitle(stem, 20);
    return slug === 'untitled' ? null : slug;
  }

  const lower = trimmed.toLowerCase();
  if (lower in KNOWN_SITE_NAME_SLUGS) {
    return KNOWN_SITE_NAME_SLUGS[lower];
  }
  if (trimmed in KNOWN_SITE_NAME_SLUGS) {
    return KNOWN_SITE_NAME_SLUGS[trimmed];
  }

  const fallback = slugifyTitle(trimmed, 20);
  return fallback === 'untitled' ? null : fallback;
}

/**
 * Formats a Date or ISO date string as UTC YYYY-MM-DD.
 */
export function formatClipDate(date: Date | string = new Date()): string {
  const parsed = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Invalid clip date: ${String(date)}`);
  }

  const year = String(parsed.getUTCFullYear()).padStart(4, '0');
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Builds the canonical agent-friendly Google Drive article folder name:
 * `YYYY-MM-DD-<source>-<clean-slug>` when a source hostname/site is provided
 * (omitting redundant `<source>` if the slug already begins with it), or
 * `YYYY-MM-DD-<clean-slug>` otherwise. Capped concisely around `maxLength` (64).
 */
export function buildArticleFolderName(
  title: string,
  date: Date | string = new Date(),
  urlOrSite?: string | null,
  maxLength = 64,
): string {
  const datePrefix = formatClipDate(date);
  const cleanedTitle = cleanPageTitle(title);
  const sourceSlug = deriveSourceSlug(urlOrSite);
  const safeMaxLength = Math.max(24, Math.floor(maxLength));

  const previewSlug = slugifyTitle(cleanedTitle, safeMaxLength);
  const includeSource =
    sourceSlug !== null &&
    previewSlug !== sourceSlug &&
    !previewSlug.startsWith(`${sourceSlug}-`);

  const prefix = includeSource
    ? `${datePrefix}-${sourceSlug}-`
    : `${datePrefix}-`;
  const slugBudget = Math.max(8, safeMaxLength - Array.from(prefix).length);
  const finalSlug = slugifyTitle(cleanedTitle, slugBudget);

  return `${prefix}${finalSlug}`;
}

/**
 * Builds the canonical article Markdown filename inside `<folderName>/`:
 * `<folderName>.md`.
 */
export function buildArticleFileName(folderName: string): string {
  const sanitized = folderName.trim().replace(/[\\/]+/g, '-');
  const base = sanitized.length > 0 ? sanitized : 'untitled';
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

/**
 * Extracts a clean 1-line plain-text summary excerpt (default max ~160 chars)
 * from Markdown content by stripping code blocks, images, links, bare URLs,
 * HTML tags, and Markdown formatting syntax.
 */
export function extractPlainTextExcerpt(
  markdown: string,
  maxLength = 160,
): string {
  if (!markdown || markdown.trim().length === 0) {
    return '';
  }

  let text = markdown.replace(/\r\n/g, '\n');

  // Remove fenced code blocks (` ``` ` or `~~~`).
  text = text.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');

  // Remove Markdown images (inline and reference-style) so noisy alt text is skipped.
  text = text
    .replace(/!\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ');

  // Remove reference link definitions (`[id]: https://...`).
  text = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ');

  // Unwrap Markdown links `[label](url)` -> `label` (dropping bare URL labels).
  text = text.replace(
    /\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g,
    (_match, label: string) => (/^https?:\/\//i.test(label.trim()) ? ' ' : label),
  );
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // Remove autolinks and bare URLs.
  text = text
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/https?:\/\/[^\s<>()]+/gi, ' ');

  // Remove HTML tags and comments.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');

  // Remove table delimiter lines (`| --- | --- |`) and structural Markdown prefixes.
  text = text
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, ' ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:>\s*)+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\|/g, ' ');

  // Strip inline formatting markers while preserving underscores inside words.
  text = text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}])_+([^\n_]+?)_+(?=$|[^\p{L}\p{N}])/gu, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');

  const collapsed = collapseWhitespace(text);
  if (collapsed.length === 0) {
    return '';
  }

  const safeLimit = Math.max(16, Math.floor(maxLength));
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= safeLimit) {
    return collapsed;
  }

  let sliced = codePoints.slice(0, safeLimit - 1).join('');
  // Break on a word boundary when spaces exist near the end (Latin prose).
  const lastSpaceIdx = sliced.lastIndexOf(' ');
  if (lastSpaceIdx >= Math.floor(sliced.length * 0.7)) {
    sliced = sliced.slice(0, lastSpaceIdx);
  }
  const cleanedTail = sliced.replace(/[\s,.;:!?，。；：！？\-—–]+$/u, '');
  return `${cleanedTail.length > 0 ? cleanedTail : sliced.trimEnd()}…`;
}

/**
 * Formats a scalar string safely for YAML 1.2 without allowing delimiter or
 * newline injection.
 */
export function formatYamlString(value: string, forceQuote = false): string {
  const sanitized = value.replace(/\r\n/g, '\n');
  if (
    !forceQuote &&
    sanitized.length > 0 &&
    SAFE_UNQUOTED_YAML_RE.test(sanitized) &&
    !YAML_RESERVED_LITERAL_RE.test(sanitized)
  ) {
    return sanitized;
  }

  const escaped = sanitized
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  return `"${escaped}"`;
}

function normalizeStringList(items: readonly string[] | undefined): string[] {
  if (!items) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function appendYamlList(
  lines: string[],
  key: string,
  values: string[],
  forceQuoteItems = false,
): void {
  if (values.length === 0) {
    lines.push(`${key}: []`);
    return;
  }
  lines.push(`${key}:`);
  for (const item of values) {
    lines.push(`  - ${formatYamlString(item, forceQuoteItems)}`);
  }
}

/**
 * Builds an OKF v0.2 + OpenKnowledge compliant YAML frontmatter block enclosed
 * in `---` fences, preserving top-level compatibility fields (`url`, `author`,
 * `published`, `clipped`, `site`, `images`, and optional `warnings`).
 */
export function buildFrontmatter(
  input: FrontmatterInput,
  preferences?: Partial<FrontmatterPreferences>,
): string {
  const prefs: FrontmatterPreferences = {
    ...DEFAULT_FRONTMATTER_PREFS,
    ...preferences,
  };

  const docType = input.type?.trim() || OKF_CLIP_TYPE;
  const title = input.title.trim() || 'Untitled';
  const description =
    collapseWhitespace(input.description ?? '') || collapseWhitespace(title) || 'Untitled';
  const status = input.status?.trim() || OKF_DEFAULT_STATUS;
  const url = input.url.trim();
  const clipped = input.clipped.trim();
  const author = input.author?.trim() || null;
  const published = input.published?.trim() || null;
  const site = input.site?.trim() || null;
  const tags = normalizeStringList(input.tags);

  const lines: string[] = ['---'];
  lines.push(`type: ${formatYamlString(docType, true)}`);
  lines.push(`title: ${formatYamlString(title, true)}`);
  lines.push(`description: ${formatYamlString(description, true)}`);
  lines.push(`status: ${formatYamlString(status, true)}`);
  appendYamlList(lines, 'tags', tags, false);

  lines.push('generated:');
  lines.push(`  by: ${formatYamlString(OKF_GENERATOR, true)}`);
  lines.push(`  at: ${formatYamlString(clipped, true)}`);

  lines.push('sources:');
  lines.push(`  - url: ${formatYamlString(url, true)}`);
  if (prefs.includeSite && site) {
    lines.push(`    site: ${formatYamlString(site, true)}`);
  }
  if (prefs.includeAuthor && author) {
    lines.push(`    author: ${formatYamlString(author, true)}`);
  }
  if (prefs.includePublished && published) {
    lines.push(`    published: ${formatYamlString(published, true)}`);
  }

  // Top-level compatibility fields for existing Markdown tools & consumers.
  lines.push(`url: ${formatYamlString(url, true)}`);

  if (prefs.includeAuthor) {
    lines.push(`author: ${author ? formatYamlString(author, true) : 'null'}`);
  }

  if (prefs.includePublished) {
    lines.push(
      `published: ${published ? formatYamlString(published, true) : 'null'}`,
    );
  }

  lines.push(`clipped: ${formatYamlString(clipped, true)}`);

  if (prefs.includeSite) {
    lines.push(`site: ${site ? formatYamlString(site, true) : 'null'}`);
  }

  if (prefs.includeImages) {
    const images = normalizeStringList(input.images);
    appendYamlList(lines, 'images', images, true);
  }

  const warnings = normalizeStringList(input.warnings);
  if (prefs.includeWarnings && warnings.length > 0) {
    appendYamlList(lines, 'warnings', warnings, true);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Combines YAML frontmatter and Markdown body into the final article `.md` document.
 */
export function composeMarkdownDocument(
  frontmatter: string,
  markdownBody: string,
): string {
  const trimmedFrontmatter = frontmatter.trimEnd();
  const trimmedBody = markdownBody.trim();
  if (trimmedBody.length === 0) {
    return `${trimmedFrontmatter}\n`;
  }
  return `${trimmedFrontmatter}\n\n${trimmedBody}\n`;
}

function escapeMarkdownLinkLabel(text: string): string {
  return collapseWhitespace(text)
    .replace(/-->/g, '--&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function sanitizeCommentUrl(url: string): string {
  return collapseWhitespace(url).replace(/-->/g, '--%3E');
}

function formatRelativeArticlePath(folderName: string, fileName: string): string {
  const cleanFolder = folderName.trim().replace(/^\/+|\/+$/g, '');
  const cleanFile = buildArticleFileName(fileName);
  return `./${cleanFolder}/${cleanFile}`.replace(/\s/g, '%20');
}

function buildRootIndexHeader(rootFolderName: string): string {
  const safeRoot = rootFolderName.trim() || 'WebClips';
  return [
    '---',
    `okf_version: ${formatYamlString(OKF_VERSION, true)}`,
    `title: ${formatYamlString(safeRoot, true)}`,
    `description: ${formatYamlString(DEFAULT_ROOT_INDEX_DESCRIPTION, true)}`,
    '---',
    '',
    `# ${safeRoot}`,
  ].join('\n');
}

function formatRootIndexEntryLine(entry: RootIndexEntry): string {
  const titleLabel = escapeMarkdownLinkLabel(entry.title || 'Untitled');
  const relativePath = formatRelativeArticlePath(entry.folderName, entry.fileName);
  const dateStr = formatClipDate(entry.clippedAt);
  const sourceLabel =
    entry.source?.trim() || deriveSourceSlug(entry.sourceUrl) || 'web';
  const tags = normalizeStringList(entry.tags);
  const tagsSegment = tags.map((t) => `#${t}`).join(' ');
  const rawDescription = entry.description
    ? extractPlainTextExcerpt(entry.description, 120)
    : '';
  const safeDescription = rawDescription.replace(/-->/g, '--&gt;');

  const metaParts: string[] = [`\`${dateStr}\``, `\`${sourceLabel}\``];
  if (tagsSegment.length > 0) {
    metaParts.push(tagsSegment);
  }
  if (safeDescription.length > 0) {
    metaParts.push(safeDescription);
  }

  const commentKey = sanitizeCommentUrl(entry.sourceUrl);
  return `- [${titleLabel}](${relativePath}) — ${metaParts.join(' · ')} <!-- clip-source: ${commentKey} -->`;
}

function matchesRootIndexEntryLine(
  line: string,
  commentKey: string,
  relativePath: string,
): boolean {
  const commentMatch = CLIP_SOURCE_COMMENT_RE.exec(line);
  if (commentMatch && commentMatch[1].trim() === commentKey) {
    return true;
  }
  const linkMatch = MARKDOWN_ENTRY_LINK_RE.exec(line);
  if (linkMatch && linkMatch[1].trim() === relativePath) {
    return true;
  }
  return false;
}

/**
 * Pure deterministic builder for OKF v0.2 bundle root `index.md`.
 * - Initializes OKF v0.2 frontmatter + `# <rootFolderName>` + `## Clips` when absent.
 * - Updates an existing clip entry in place when matched by `<!-- clip-source: <url> -->`
 *   or relative path `./<folderName>/<fileName>` (preventing duplicates on re-clip).
 * - Prepends new clip entries newest-first under `## Clips` while preserving all
 *   other user sections and frontmatter.
 */
export function upsertRootIndexMarkdown(
  existingIndex: string | null,
  entry: RootIndexEntry,
): string {
  const rootFolderName = entry.rootFolderName?.trim() || 'WebClips';
  const newLine = formatRootIndexEntryLine(entry);
  const commentKey = sanitizeCommentUrl(entry.sourceUrl);
  const relativePath = formatRelativeArticlePath(entry.folderName, entry.fileName);

  if (!existingIndex || existingIndex.trim().length === 0) {
    return `${buildRootIndexHeader(rootFolderName)}\n\n## Clips\n\n${newLine}\n`;
  }

  let normalized = existingIndex.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.trimStart().startsWith('---\n')) {
    normalized = `${buildRootIndexHeader(rootFolderName)}\n\n${normalized.trimStart()}`;
  }

  const lines = normalized.split('\n');
  const clipsHeadingIdx = lines.findIndex((line) => /^##\s+Clips\s*$/.test(line));

  if (clipsHeadingIdx === -1) {
    const trimmedExisting = normalized.trimEnd();
    return `${trimmedExisting}\n\n## Clips\n\n${newLine}\n`;
  }

  let sectionEndIdx = lines.length;
  for (let i = clipsHeadingIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      sectionEndIdx = i;
      break;
    }
  }

  const beforeSection = lines.slice(0, clipsHeadingIdx + 1);
  const sectionLines = lines.slice(clipsHeadingIdx + 1, sectionEndIdx);
  const afterSection = lines.slice(sectionEndIdx);

  // Separate non-bullet preamble lines inside `## Clips` from bullet entries.
  const firstBulletIdx = sectionLines.findIndex((line) => /^-\s+/.test(line));
  const preambleLines =
    firstBulletIdx === -1
      ? sectionLines.filter((line) => line.trim().length > 0)
      : sectionLines.slice(0, firstBulletIdx).filter((line) => line.trim().length > 0);
  const tailLines =
    firstBulletIdx === -1 ? [] : sectionLines.slice(firstBulletIdx);

  const updatedEntries: string[] = [];
  let replaced = false;

  for (const line of tailLines) {
    if (line.trim().length === 0) {
      continue;
    }
    if (/^-\s+/.test(line) && matchesRootIndexEntryLine(line, commentKey, relativePath)) {
      if (!replaced) {
        updatedEntries.push(newLine);
        replaced = true;
      }
      // Drop any duplicate entries for the same URL/path.
      continue;
    }
    updatedEntries.push(line);
  }

  if (!replaced) {
    updatedEntries.unshift(newLine);
  }

  const rebuiltSection: string[] = [''];
  if (preambleLines.length > 0) {
    rebuiltSection.push(...preambleLines, '');
  }
  rebuiltSection.push(...updatedEntries);

  const hasAfter = afterSection.some((line) => line.trim().length > 0);
  const outputLines = hasAfter
    ? [...beforeSection, ...rebuiltSection, '', ...afterSection]
    : [...beforeSection, ...rebuiltSection];

  return `${outputLines.join('\n').trimEnd()}\n`;
}

/**
 * Pure deterministic builder for OKF v0.2 lowercase `log.md` (strictly NO
 * frontmatter). Appends chronological clip/update events under `# Clip Log`.
 */
export function appendClipLogMarkdown(
  existingLog: string | null,
  entry: RootIndexEntry,
  action: 'clipped' | 'updated',
): string {
  const iso = entry.clippedAt.trim() || new Date().toISOString();
  const titleLabel = escapeMarkdownLinkLabel(entry.title || 'Untitled').replace(
    /\|/g,
    '\\|',
  );
  const relativePath = formatRelativeArticlePath(entry.folderName, entry.fileName);
  const sourceUrl = collapseWhitespace(entry.sourceUrl);
  const logLine = `- ${iso} | ${action} | [${titleLabel}](${relativePath}) | ${sourceUrl}`;

  if (!existingLog || existingLog.trim().length === 0) {
    return `# Clip Log\n\n${logLine}\n`;
  }

  const normalized = existingLog
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trimEnd();
  if (/^#\s+Clip Log\s*$/.test(normalized)) {
    return `${normalized}\n\n${logLine}\n`;
  }

  return `${normalized}\n${logLine}\n`;
}
