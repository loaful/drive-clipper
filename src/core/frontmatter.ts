import type { FrontmatterPreferences } from '../types.js';

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

export interface FrontmatterInput {
  title: string;
  url: string;
  author?: string | null;
  published?: string | null;
  clipped: string;
  site?: string | null;
  tags?: string[];
  images?: string[];
  warnings?: string[];
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
 * Builds the canonical Google Drive article folder name: YYYY-MM-DD-<slug>.
 */
export function buildArticleFolderName(
  title: string,
  date: Date | string = new Date(),
  maxSlugLength = 60,
): string {
  return `${formatClipDate(date)}-${slugifyTitle(title, maxSlugLength)}`;
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

function normalizeStringList(items: string[] | undefined): string[] {
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
 * Builds a YAML frontmatter block enclosed in `---` fences.
 * Optional `warnings` is omitted unless at least one warning is present and enabled.
 */
export function buildFrontmatter(
  input: FrontmatterInput,
  preferences?: Partial<FrontmatterPreferences>,
): string {
  const prefs: FrontmatterPreferences = {
    ...DEFAULT_FRONTMATTER_PREFS,
    ...preferences,
  };

  const lines: string[] = ['---'];
  lines.push(`title: ${formatYamlString(input.title.trim() || 'Untitled', true)}`);
  lines.push(`url: ${formatYamlString(input.url.trim(), true)}`);

  if (prefs.includeAuthor) {
    const author = input.author?.trim();
    lines.push(`author: ${author ? formatYamlString(author, true) : 'null'}`);
  }

  if (prefs.includePublished) {
    const published = input.published?.trim();
    lines.push(
      `published: ${published ? formatYamlString(published, true) : 'null'}`,
    );
  }

  lines.push(`clipped: ${formatYamlString(input.clipped.trim(), true)}`);

  if (prefs.includeSite) {
    const site = input.site?.trim();
    lines.push(`site: ${site ? formatYamlString(site, true) : 'null'}`);
  }

  const tags = normalizeStringList(input.tags);
  appendYamlList(lines, 'tags', tags, false);

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
 * Combines YAML frontmatter and Markdown body into the final README.md document.
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
