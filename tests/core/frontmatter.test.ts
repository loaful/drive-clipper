import { describe, expect, it } from 'vitest';
import {
  buildArticleFolderName,
  buildFrontmatter,
  composeMarkdownDocument,
  formatClipDate,
  formatYamlString,
  slugifyTitle,
} from '../../src/core/frontmatter.js';

describe('slugifyTitle', () => {
  it('normalizes ASCII punctuation, case, and whitespace', () => {
    expect(slugifyTitle('  Hello, World! (MV3 Edition)  ')).toBe(
      'hello-world-mv3-edition',
    );
  });

  it('folds Latin diacritics while preserving CJK characters', () => {
    expect(slugifyTitle('Café & Résumé: A Guide')).toBe('cafe-resume-a-guide');
    expect(slugifyTitle('深入理解 Chrome MV3 架构')).toBe(
      '深入理解-chrome-mv3-架构',
    );
  });

  it('strips path-unsafe characters and falls back to untitled when empty', () => {
    expect(slugifyTitle('foo/bar\\baz:qux*test?')).toBe('foo-bar-baz-qux-test');
    expect(slugifyTitle('   !!! ///   ')).toBe('untitled');
    expect(slugifyTitle('')).toBe('untitled');
  });

  it('truncates long titles cleanly without trailing hyphens', () => {
    const slug = slugifyTitle('one-two-three-four-five-six-seven', 14);
    expect(slug).toBe('one-two-three');
    expect(slug.length).toBeLessThanOrEqual(14);
  });
});

describe('formatClipDate & buildArticleFolderName', () => {
  it('formats UTC YYYY-MM-DD and composes folder names', () => {
    const iso = '2026-11-24T04:16:43.000Z';
    expect(formatClipDate(iso)).toBe('2026-11-24');
    expect(buildArticleFolderName('Drive Clipper Architecture', iso)).toBe(
      '2026-11-24-drive-clipper-architecture',
    );
  });

  it('throws RangeError on invalid dates instead of inventing a date', () => {
    expect(() => formatClipDate('not-a-date')).toThrow(RangeError);
  });
});

describe('buildFrontmatter & composeMarkdownDocument', () => {
  it('emits all expected fields and omits warnings when empty', () => {
    const yaml = buildFrontmatter({
      title: 'Building MV3 Extensions: Notes & Tradeoffs',
      url: 'https://example.com/posts/mv3',
      author: 'Ada Lovelace',
      published: '2026-11-20',
      clipped: '2026-11-24T04:16:43.000Z',
      site: 'Example Blog',
      tags: ['web-clip', 'chrome', 'web-clip', '  '],
      images: ['./images/01-hero.webp', './images/02-diagram.png'],
      warnings: [],
    });

    expect(yaml).toBe(
      [
        '---',
        'title: "Building MV3 Extensions: Notes & Tradeoffs"',
        'url: "https://example.com/posts/mv3"',
        'author: "Ada Lovelace"',
        'published: "2026-11-20"',
        'clipped: "2026-11-24T04:16:43.000Z"',
        'site: "Example Blog"',
        'tags:',
        '  - web-clip',
        '  - chrome',
        'images:',
        '  - "./images/01-hero.webp"',
        '  - "./images/02-diagram.png"',
        '---',
      ].join('\n'),
    );
    expect(yaml).not.toContain('warnings:');
  });

  it('includes warnings when present and escapes YAML injection characters', () => {
    const yaml = buildFrontmatter({
      title: 'Title with "quotes"\n---\nfake: true',
      url: 'https://example.com/a?x=1&y=2',
      author: null,
      published: null,
      clipped: '2026-11-24T04:16:43.000Z',
      site: null,
      tags: ['true', '123', 'normal-tag'],
      images: [],
      warnings: ['Image download failed for https://cdn.example.com/404.png (HTTP 404)'],
    });

    expect(yaml).toContain('title: "Title with \\"quotes\\"\\n---\\nfake: true"');
    expect(yaml).toContain('author: null');
    expect(yaml).toContain('published: null');
    expect(yaml).toContain('site: null');
    expect(yaml).toContain('  - "true"');
    expect(yaml).toContain('  - "123"');
    expect(yaml).toContain('  - normal-tag');
    expect(yaml).toContain('images: []');
    expect(yaml).toContain('warnings:');
    expect(yaml).toContain(
      '  - "Image download failed for https://cdn.example.com/404.png (HTTP 404)"',
    );
  });

  it('respects frontmatter preferences toggles', () => {
    const yaml = buildFrontmatter(
      {
        title: 'Minimal',
        url: 'https://example.com',
        author: 'Hidden',
        published: '2026-01-01',
        clipped: '2026-11-24T04:16:43.000Z',
        site: 'Hidden Site',
        tags: [],
        images: ['./images/01.png'],
        warnings: ['A warning'],
      },
      {
        includeAuthor: false,
        includePublished: false,
        includeSite: false,
        includeImages: false,
        includeWarnings: false,
      },
    );

    expect(yaml).not.toContain('author:');
    expect(yaml).not.toContain('published:');
    expect(yaml).not.toContain('site:');
    expect(yaml).not.toContain('images:');
    expect(yaml).not.toContain('warnings:');
  });

  it('quotes YAML reserved scalars cleanly in formatYamlString', () => {
    expect(formatYamlString('web-clip')).toBe('web-clip');
    expect(formatYamlString('null')).toBe('"null"');
    expect(formatYamlString('2026-11-24')).toBe('"2026-11-24"');
    expect(formatYamlString('has: colon')).toBe('"has: colon"');
  });

  it('composes frontmatter and body with normalized trailing newline', () => {
    const doc = composeMarkdownDocument('---\ntitle: "Test"\n---', '  # Heading\n\nBody  ');
    expect(doc).toBe('---\ntitle: "Test"\n---\n\n# Heading\n\nBody\n');
  });
});
