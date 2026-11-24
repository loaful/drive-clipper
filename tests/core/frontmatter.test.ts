import { describe, expect, it } from 'vitest';
import {
  appendClipLogMarkdown,
  buildArticleFileName,
  buildArticleFolderName,
  buildFrontmatter,
  cleanPageTitle,
  composeMarkdownDocument,
  deriveSourceSlug,
  extractPlainTextExcerpt,
  formatClipDate,
  formatYamlString,
  slugifyTitle,
  upsertRootIndexMarkdown,
  type RootIndexEntry,
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
    expect(cleanPageTitle('(3) Home / X')).toBe('Home');
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

  it('strips trailing site boilerplate suffixes without emptying bare site titles', () => {
    expect(cleanPageTitle('(20 封私信 / 17 条消息) 华硕 ProArt 创 16 评测 - 知乎')).toBe(
      '华硕 ProArt 创 16 评测',
    );
    expect(cleanPageTitle('深入理解 Chrome MV3 - 知乎专栏')).toBe(
      '深入理解 Chrome MV3',
    );
    expect(cleanPageTitle('架构演进笔记 - 知乎专栏 - 知乎')).toBe('架构演进笔记');
    expect(cleanPageTitle('Agent Knowledge Bases | Medium')).toBe(
      'Agent Knowledge Bases',
    );
    expect(cleanPageTitle('System Design Notes - Substack')).toBe(
      'System Design Notes',
    );
    expect(cleanPageTitle('inkeep/open-knowledge · GitHub')).toBe(
      'inkeep/open-knowledge',
    );
    expect(cleanPageTitle('Markdown - Wikipedia')).toBe('Markdown');
    expect(cleanPageTitle('Markdown - 维基百科，自由的百科全书')).toBe('Markdown');
    expect(cleanPageTitle('前端性能优化指南 - 稀土掘金')).toBe('前端性能优化指南');
    expect(cleanPageTitle('知乎')).toBe('知乎');
    expect(cleanPageTitle('Medium')).toBe('Medium');
  });

  it('unwraps X / Twitter boilerplate and strips inline https://t.co/... short URLs', () => {
    expect(
      cleanPageTitle(
        '(3) Karpathy on X: "LLM Wiki: personal knowledge base https://t.co/a1b2c3XYZ" / X',
      ),
    ).toBe('LLM Wiki: personal knowledge base');
    expect(
      cleanPageTitle(
        'jakevin 在 Twitter: "刚试了一下 Chrome MV3 扩展 https://t.co/xyz987" / Twitter',
      ),
    ).toBe('刚试了一下 Chrome MV3 扩展');
    expect(
      cleanPageTitle(
        'X 上的 jakevin：“分享一个开源工具 https://t.co/abc123” / X',
      ),
    ).toBe('分享一个开源工具');
    expect(
      cleanPageTitle(
        'OpenAI on X: “Introducing agent evals https://t.co/q1w2e3',
      ),
    ).toBe('Introducing agent evals');
    // Tweet whose text is only a t.co link falls back to the author name instead of empty.
    expect(cleanPageTitle('Jakevin on X: "https://t.co/onlylink" / X')).toBe(
      'Jakevin',
    );
    // Non-X essay title without quote wrapper stays intact.
    expect(cleanPageTitle('Notes on X: Why Microblogging Changed')).toBe(
      'Notes on X: Why Microblogging Changed',
    );
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
      '(20 封私信 / 17 条消息) 华硕 ProArt 创 16 - 知乎',
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

describe('deriveSourceSlug, formatClipDate, buildArticleFolderName & buildArticleFileName', () => {
  it('derives concise source slugs from known platforms and domain stems, ignoring localhost/IPs', () => {
    expect(deriveSourceSlug('https://zhuanlan.zhihu.com/p/123456')).toBe('zhihu');
    expect(deriveSourceSlug('https://www.zhihu.com/question/99')).toBe('zhihu');
    expect(deriveSourceSlug('https://x.com/jakevin/status/2125132076768985501')).toBe('x');
    expect(deriveSourceSlug('https://mobile.twitter.com/user/status/1')).toBe('x');
    expect(deriveSourceSlug('https://github.com/inkeep/open-knowledge')).toBe('github');
    expect(deriveSourceSlug('https://author.medium.com/post-slug')).toBe('medium');
    expect(deriveSourceSlug('https://stratechery.substack.com/p/ai')).toBe('substack');
    expect(deriveSourceSlug('https://mp.weixin.qq.com/s/abcdef')).toBe('mp-weixin');
    expect(deriveSourceSlug('https://en.wikipedia.org/wiki/Markdown')).toBe('wikipedia');
    expect(deriveSourceSlug('https://blog.cloudflare.com/workers')).toBe('cloudflare');
    expect(deriveSourceSlug('https://www.bbc.co.uk/news/tech')).toBe('bbc');
    expect(deriveSourceSlug('http://127.0.0.1:4321/articles/test')).toBeNull();
    expect(deriveSourceSlug('http://localhost:3000/docs')).toBeNull();
    expect(deriveSourceSlug('知乎')).toBe('zhihu');
    expect(deriveSourceSlug('X (Twitter)')).toBe('x');
    expect(deriveSourceSlug('')).toBeNull();
  });

  it('formats UTC YYYY-MM-DD and composes agent-friendly folder & Markdown filenames', () => {
    const iso = '2026-11-24T04:16:43.000Z';
    expect(formatClipDate(iso)).toBe('2026-11-24');
    expect(buildArticleFolderName('Drive Clipper Architecture', iso)).toBe(
      '2026-11-24-drive-clipper-architecture',
    );
    expect(
      buildArticleFolderName(
        '(20 封私信 / 17 条消息) 华硕 ProArt 创 16 评测 - 知乎',
        iso,
        'https://zhuanlan.zhihu.com/p/123456',
      ),
    ).toBe('2026-11-24-zhihu-华硕-proart-创-16-评测');
    expect(
      buildArticleFolderName(
        'Jakevin on X: "Building OpenKnowledge clip bundles https://t.co/abc123" / X',
        iso,
        'https://x.com/jakevin/status/2125132076768985501',
      ),
    ).toBe('2026-11-24-x-building-openknowledge-clip-bundles');

    // Avoid redundant source prefix when slug already starts with it.
    expect(
      buildArticleFolderName(
        'GitHub Actions Workflow Guide',
        iso,
        'https://github.com/org/repo',
      ),
    ).toBe('2026-11-24-github-actions-workflow-guide');

    // Caps long folder names concisely around 64 chars without trailing hyphens.
    const longFolder = buildArticleFolderName(
      'A Very Long Engineering Article Title About Distributed Consensus Algorithms and Fault Tolerance in Production Systems',
      iso,
      'https://stratechery.substack.com/p/consensus',
    );
    expect(longFolder.startsWith('2026-11-24-substack-')).toBe(true);
    expect(Array.from(longFolder).length).toBeLessThanOrEqual(64);
    expect(longFolder.endsWith('-')).toBe(false);

    // Article filename matches `<folderName>.md`.
    expect(buildArticleFileName(longFolder)).toBe(`${longFolder}.md`);
    expect(buildArticleFileName('2026-11-24-x-demo.md')).toBe('2026-11-24-x-demo.md');
    expect(buildArticleFileName('  ')).toBe('untitled.md');
  });

  it('throws RangeError on invalid dates instead of inventing a date', () => {
    expect(() => formatClipDate('not-a-date')).toThrow(RangeError);
  });
});

describe('extractPlainTextExcerpt', () => {
  it('strips Markdown syntax, images, code blocks, and URLs into a concise 1-line summary', () => {
    const markdown = [
      '# Designing Agent Bundles',
      '',
      '![Hero Diagram](./images/01-hero.webp)',
      '',
      'Read the [OpenKnowledge spec](https://github.com/inkeep/open-knowledge) and [Wiki](https://en.wikipedia.org/wiki/Markdown_(format)) `drive_clipper` notes for **reliable** archiving. See https://t.co/xyz123 for raw details.',
      '',
      '```ts',
      'const ignoredCode = true;',
      '```',
      '',
      '> Quoted insight with _emphasis_.',
    ].join('\n');

    const excerpt = extractPlainTextExcerpt(markdown, 160);
    expect(excerpt).toBe(
      'Designing Agent Bundles Read the OpenKnowledge spec and Wiki drive_clipper notes for reliable archiving. See for raw details. Quoted insight with emphasis.',
    );
    expect(excerpt).not.toContain('```');
    expect(excerpt).not.toContain('Hero Diagram');
    expect(excerpt).not.toContain('https://');
    expect(excerpt).not.toContain('\n');
  });

  it('truncates long prose cleanly at word boundaries with ellipsis', () => {
    const longMd =
      'Distributed knowledge bases work best when every document carries structured metadata, deterministic filenames, and an up-to-date root index that agents can traverse in a single read without scanning hundreds of ambiguous files.';
    const excerpt = extractPlainTextExcerpt(longMd, 160);
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(160);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('buildFrontmatter & composeMarkdownDocument (OKF v0.2)', () => {
  it('emits OKF v0.2 fields plus top-level compatibility fields and omits warnings when empty', () => {
    const yaml = buildFrontmatter({
      title: 'Building MV3 Extensions: Notes & Tradeoffs',
      description: 'Notes on MV3 web clipping.',
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
        'type: "web-clip"',
        'title: "Building MV3 Extensions: Notes & Tradeoffs"',
        'description: "Notes on MV3 web clipping."',
        'status: "raw"',
        'tags:',
        '  - web-clip',
        '  - chrome',
        'generated:',
        '  by: "drive-clipper"',
        '  at: "2026-11-24T04:16:43.000Z"',
        'sources:',
        '  - url: "https://example.com/posts/mv3"',
        '    site: "Example Blog"',
        '    author: "Ada Lovelace"',
        '    published: "2026-11-20"',
        'url: "https://example.com/posts/mv3"',
        'author: "Ada Lovelace"',
        'published: "2026-11-20"',
        'clipped: "2026-11-24T04:16:43.000Z"',
        'site: "Example Blog"',
        'images:',
        '  - "./images/01-hero.webp"',
        '  - "./images/02-diagram.png"',
        '---',
      ].join('\n'),
    );
    expect(yaml).not.toContain('warnings:');
  });

  it('omits null subfields inside sources, includes warnings when present, and escapes YAML injection characters', () => {
    const yaml = buildFrontmatter({
      title: 'Title with "quotes"\n---\nfake: true',
      description: 'Line 1\n---\nLine 2 with "quotes"',
      url: 'https://example.com/a?x=1&y=2',
      author: null,
      published: null,
      clipped: '2026-11-24T04:16:43.000Z',
      site: null,
      tags: ['true', '123', 'normal-tag'],
      images: [],
      warnings: ['Image download failed for https://cdn.example.com/404.png (HTTP 404)'],
    });

    expect(yaml).toContain('type: "web-clip"');
    expect(yaml).toContain('status: "raw"');
    expect(yaml).toContain('title: "Title with \\"quotes\\"\\n---\\nfake: true"');
    expect(yaml).toContain('description: "Line 1 --- Line 2 with \\"quotes\\""');
    // Null subfields omitted from sources list entry while preserved as top-level null.
    expect(yaml).toContain(
      'sources:\n  - url: "https://example.com/a?x=1&y=2"\nurl: "https://example.com/a?x=1&y=2"',
    );
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

  it('respects frontmatter preferences toggles across top-level fields and sources subfields', () => {
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

    expect(yaml).toContain('type: "web-clip"');
    expect(yaml).toContain('description: "Minimal"');
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

describe('upsertRootIndexMarkdown & appendClipLogMarkdown', () => {
  const entryA: RootIndexEntry = {
    rootFolderName: 'WebClips',
    folderName: '2026-11-24-zhihu-proart-review',
    fileName: '2026-11-24-zhihu-proart-review.md',
    title: '华硕 ProArt 创 16 评测',
    sourceUrl: 'https://zhuanlan.zhihu.com/p/1001',
    clippedAt: '2026-11-24T04:00:00.000Z',
    source: 'zhihu',
    tags: ['hardware', 'review'],
    description: 'Color accuracy and display uniformity benchmarks.',
  };

  const entryB: RootIndexEntry = {
    rootFolderName: 'WebClips',
    folderName: '2026-11-24-x-llm-wiki',
    fileName: '2026-11-24-x-llm-wiki.md',
    title: 'LLM Wiki Notes',
    sourceUrl: 'https://x.com/karpathy/status/2002',
    clippedAt: '2026-11-24T05:00:00.000Z',
    source: 'x',
    tags: [],
    description: 'Maintaining a personal agent-friendly knowledge bundle.',
  };

  it('creates OKF v0.2 index.md, prepends newest entries, updates re-clipped URLs in place without duplicates, and preserves custom sections', () => {
    const initial = upsertRootIndexMarkdown(null, entryA);
    expect(initial).toBe(
      [
        '---',
        'okf_version: "0.2"',
        'title: "WebClips"',
        'description: "Web clips archived by Drive Clipper in Open Knowledge Format."',
        '---',
        '',
        '# WebClips',
        '',
        '## Clips',
        '',
        '- [华硕 ProArt 创 16 评测](./2026-11-24-zhihu-proart-review/2026-11-24-zhihu-proart-review.md) — `2026-11-24` · `zhihu` · #hardware #review · Color accuracy and display uniformity benchmarks. <!-- clip-source: https://zhuanlan.zhihu.com/p/1001 -->',
        '',
      ].join('\n'),
    );

    // Add a custom user section below `## Clips` and insert a second clip -> prepends newest-first while preserving `## Notes`.
    const withUserNotes = `${initial}\n## Notes\n\nKeep this section intact.\n`;
    const withSecond = upsertRootIndexMarkdown(withUserNotes, entryB);
    const clipLinesAfterSecond = withSecond
      .split('\n')
      .filter((line) => line.startsWith('- ['));
    expect(clipLinesAfterSecond).toHaveLength(2);
    expect(clipLinesAfterSecond[0]).toContain('[LLM Wiki Notes](./2026-11-24-x-llm-wiki/2026-11-24-x-llm-wiki.md)');
    // Empty tags list omits the tags segment cleanly (no double separator).
    expect(clipLinesAfterSecond[0]).toContain('— `2026-11-24` · `x` · Maintaining a personal');
    expect(clipLinesAfterSecond[1]).toContain('https://zhuanlan.zhihu.com/p/1001');
    expect(withSecond).toContain('## Notes\n\nKeep this section intact.');

    // Re-clipping entryA updates its existing line IN PLACE (still index 1, zero duplication).
    const updatedA: RootIndexEntry = {
      ...entryA,
      title: '华硕 ProArt 创 16 深度评测 (修订)',
      clippedAt: '2026-11-25T08:00:00.000Z',
      tags: ['hardware'],
      description: 'Updated benchmarks with HDR calibration data.',
    };
    const afterReclip = upsertRootIndexMarkdown(withSecond, updatedA);
    const clipLinesAfterReclip = afterReclip
      .split('\n')
      .filter((line) => line.startsWith('- ['));
    expect(clipLinesAfterReclip).toHaveLength(2);
    expect(clipLinesAfterReclip[0]).toContain('[LLM Wiki Notes]');
    expect(clipLinesAfterReclip[1]).toContain('华硕 ProArt 创 16 深度评测 (修订)');
    expect(clipLinesAfterReclip[1]).toContain('`2026-11-25`');
    expect(clipLinesAfterReclip[1]).toContain('Updated benchmarks with HDR calibration data.');
    expect(afterReclip).toContain('## Notes\n\nKeep this section intact.');
  });

  it('appends chronological entries to lowercase log.md with strictly NO frontmatter', () => {
    const firstLog = appendClipLogMarkdown(null, entryA, 'clipped');
    expect(firstLog.startsWith('---')).toBe(false);
    expect(firstLog).toBe(
      [
        '# Clip Log',
        '',
        '- 2026-11-24T04:00:00.000Z | clipped | [华硕 ProArt 创 16 评测](./2026-11-24-zhihu-proart-review/2026-11-24-zhihu-proart-review.md) | https://zhuanlan.zhihu.com/p/1001',
        '',
      ].join('\n'),
    );

    const secondLog = appendClipLogMarkdown(firstLog, entryB, 'clipped');
    const thirdLog = appendClipLogMarkdown(
      secondLog,
      { ...entryA, title: 'Title | With Pipe', clippedAt: '2026-11-25T08:00:00.000Z' },
      'updated',
    );
    expect(thirdLog.startsWith('# Clip Log\n\n')).toBe(true);
    const logLines = thirdLog.split('\n').filter((line) => line.startsWith('- '));
    expect(logLines).toHaveLength(3);
    expect(logLines[0]).toContain('2026-11-24T04:00:00.000Z | clipped |');
    expect(logLines[1]).toContain('2026-11-24T05:00:00.000Z | clipped |');
    expect(logLines[2]).toBe(
      '- 2026-11-25T08:00:00.000Z | updated | [Title \\| With Pipe](./2026-11-24-zhihu-proart-review/2026-11-24-zhihu-proart-review.md) | https://zhuanlan.zhihu.com/p/1001',
    );
  });
});
