import { describe, expect, it } from 'vitest';
import {
  buildArticleFolderName,
  buildFrontmatter,
  cleanPageTitle,
  composeMarkdownDocument,
  formatClipDate,
  formatYamlString,
  slugifyTitle,
} from '../../src/core/frontmatter.js';

describe('cleanPageTitle', () => {
  it('strips Zhihu and Chinese notification prefixes in ASCII and full-width brackets', () => {
    expect(cleanPageTitle('(20 封私信 / 17 条消息) 华硕 ProArt 创 16 评测')).toBe(
      '华硕 ProArt 创 16 评测',
    );
    expect(cleanPageTitle('(5 条消息) 如何看待 Chrome MV3 架构？')).toBe(
      '如何看待 Chrome MV3 架构？',
    );
    expect(cleanPageTitle('（3 封私信 / 2 条通知）知乎专栏深度解析')).toBe(
      '知乎专栏深度解析',
    );
    expect(cleanPageTitle('（99+ 条未读消息）飞书文档')).toBe('飞书文档');
    expect(cleanPageTitle('[4 条提醒] 系统通知中心')).toBe('系统通知中心');
  });

  it('strips 1-3 digit and 99+ numeric unread counts with optional leading bullets', () => {
    expect(cleanPageTitle('(3) Home / X')).toBe('Home / X');
    expect(cleanPageTitle('(99+) Inbox - user@gmail.com')).toBe(
      'Inbox - user@gmail.com',
    );
    expect(cleanPageTitle('(999+) All Mail')).toBe('All Mail');
    expect(cleanPageTitle('[12] Alert - Dashboard')).toBe('Alert - Dashboard');
    expect(cleanPageTitle('• (3) Slack - #engineering')).toBe(
      'Slack - #engineering',
    );
    expect(cleanPageTitle('· [18] Notifications')).toBe('Notifications');
    expect(cleanPageTitle('（8）微信读书')).toBe('微信读书');
    expect(cleanPageTitle('(2 unread) Gmail')).toBe('Gmail');
    expect(cleanPageTitle('(3) (5 条消息) 叠加通知标题')).toBe('叠加通知标题');
  });

  it('preserves legitimate parentheticals like 4-digit years, parts, RFCs, and labels', () => {
    expect(cleanPageTitle('(2026) Annual Report')).toBe('(2026) Annual Report');
    expect(cleanPageTitle('(1999) Classic Systems Paper')).toBe(
      '(1999) Classic Systems Paper',
    );
    expect(cleanPageTitle('(Part 1) Guide to Distributed Storage')).toBe(
      '(Part 1) Guide to Distributed Storage',
    );
    expect(cleanPageTitle('(RFC 9110) HTTP Semantics')).toBe(
      '(RFC 9110) HTTP Semantics',
    );
    expect(cleanPageTitle('(Beta) Feature Flags')).toBe('(Beta) Feature Flags');
    expect(cleanPageTitle('Article (3) Notes')).toBe('Article (3) Notes');
    expect(cleanPageTitle('• Regular Bullet Heading')).toBe(
      '• Regular Bullet Heading',
    );
    expect(cleanPageTitle('(3] Mismatched Bracket')).toBe(
      '(3] Mismatched Bracket',
    );
    expect(cleanPageTitle('(3)')).toBe('(3)');
    expect(cleanPageTitle('   ')).toBe('');
  });

  it('produces clean Drive folder names when combined with buildArticleFolderName', () => {
    const cleaned = cleanPageTitle(
      '(20 封私信 / 17 条消息) 华硕 ProArt 创 16',
    );
    expect(
      buildArticleFolderName(cleaned, '2026-11-24T04:16:43.000Z'),
    ).toBe('2026-11-24-华硕-proart-创-16');
  });
});

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
