// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { handleContentMessage } from '../../src/content/content.js';
import {
  extractPage,
  getPageInfo,
  type DefuddleInstance,
} from '../../src/core/extract.js';

const ARTICLE_URL = 'https://docs.example.com/engineering/drive-clipper';

function buildArticleDocument(): Document {
  const html = `<!doctype html>
  <html lang="en">
    <head>
      <title>Designing a Reliable Web Clipper</title>
      <meta name="author" content="Grace Hopper">
      <meta property="og:site_name" content="Engineering Notes">
      <meta property="article:published_time" content="2026-11-20T12:00:00Z">
      <meta name="description" content="Notes on MV3 web clipping.">
    </head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <main>
        <article>
          <h1>Designing a Reliable Web Clipper</h1>
          <p>Clipping modern web pages cleanly requires flattening shadow trees, resolving lazy images, and turning noisy markup into readable Markdown.</p>
          <x-callout id="shadow-box"></x-callout>
          <p>We also want duplicate images downloaded only once, while tracking pixels and SVG placeholders are ignored completely.</p>
          <figure>
            <img src="data:image/svg+xml;base64,PHN2Zy8+" data-src="/media/architecture.webp" alt="Architecture Diagram">
            <figcaption>System overview</figcaption>
          </figure>
          <p>Here is the same architecture image referenced a second time in the article body.</p>
          <p><img src="https://docs.example.com/media/architecture.webp" alt="Architecture Repeat"></p>
          <p><img src="/media/photo.png" alt="Secondary Photo"></p>
          <img src="https://analytics.example.com/t.gif" width="1" height="1" alt="">
          <img src="data:image/svg+xml,%3Csvg/%3E" alt="Empty Placeholder">
        </article>
      </main>
      <footer>Copyright 2026</footer>
    </body>
  </html>`;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const shadowHost = doc.getElementById('shadow-box')!;
  const shadow = shadowHost.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>p { color: blue; }</style><p>Key insight inside an open Shadow DOM component that must appear in the clipped Markdown.</p>';
  return doc;
}

describe('extractPage (full-page pipeline)', () => {
  it('extracts article Markdown via defuddle/full, flattens Shadow DOM, resolves lazy images, strips placeholders/pixels, and deduplicates URLs', async () => {
    const doc = buildArticleDocument();
    const fixedDate = new Date('2026-11-24T04:16:43.000Z');

    const extracted = await extractPage(doc, ARTICLE_URL, {
      mode: 'full',
      now: () => fixedDate,
    });

    expect(extracted.url).toBe(ARTICLE_URL);
    expect(extracted.title).toBe('Designing a Reliable Web Clipper');
    expect(extracted.author).toBe('Grace Hopper');
    expect(extracted.site).toBe('Engineering Notes');
    expect(extracted.published).toBe('2026-11-20T12:00:00Z');
    expect(extracted.mode).toBe('full');
    expect(extracted.extractedAt).toBe('2026-11-24T04:16:43.000Z');
    expect(extracted.warnings).toEqual([]);

    // Body text and Shadow DOM text are both extracted
    expect(extracted.markdown).toContain('Clipping modern web pages cleanly');
    expect(extracted.markdown).toContain(
      'Key insight inside an open Shadow DOM component',
    );
    expect(extracted.markdown).not.toContain('color: blue');

    // Lazy image resolved, duplicate image deduplicated, tracking pixel & SVG placeholder omitted
    expect(extracted.images.map((i) => i.resolvedUrl)).toEqual([
      'https://docs.example.com/media/architecture.webp',
      'https://docs.example.com/media/photo.png',
    ]);
    expect(extracted.markdown).not.toContain('analytics.example.com');
    expect(extracted.markdown).not.toContain('data:image/svg+xml');

    // Original live DOM must remain untouched
    expect(doc.querySelector('img[data-src]')?.getAttribute('data-src')).toBe(
      '/media/architecture.webp',
    );
    expect(doc.getElementById('shadow-box')?.shadowRoot).not.toBeNull();
  });

  it('falls back to synchronous Defuddle.parse() when parseAsync() exceeds asyncTimeoutMs', async () => {
    const doc = buildArticleDocument();
    const syncParse = vi.fn(() => ({
      title: 'Sync Fallback Title',
      description: '',
      domain: 'docs.example.com',
      favicon: '',
      image: '',
      language: 'en',
      parseTime: 3,
      published: '',
      author: 'Grace Hopper',
      site: 'Engineering Notes',
      schemaOrgData: null,
      wordCount: 5,
      content: '<p>Recovered synchronously from fallback.</p>',
    }));

    const neverResolvingAsync = vi.fn(() => new Promise<never>(() => {}));

    const extracted = await extractPage(doc, ARTICLE_URL, {
      asyncTimeoutMs: 25,
      createDefuddle: (): DefuddleInstance => ({
        parseAsync: neverResolvingAsync,
        parse: syncParse,
      }),
    });

    expect(neverResolvingAsync).toHaveBeenCalledTimes(1);
    expect(syncParse).toHaveBeenCalledTimes(1);
    expect(extracted.title).toBe('Sync Fallback Title');
    expect(extracted.markdown).toContain('Recovered synchronously from fallback.');
    expect(extracted.warnings.some((w) => w.includes('timed out after 25ms'))).toBe(true);
  });

  it('falls back to synchronous Defuddle.parse() when parseAsync() rejects', async () => {
    const doc = buildArticleDocument();
    const syncParse = vi.fn(() => ({
      title: 'Recovered After Rejection',
      description: '',
      domain: 'docs.example.com',
      favicon: '',
      image: '',
      language: 'en',
      parseTime: 2,
      published: '',
      author: '',
      site: '',
      schemaOrgData: null,
      wordCount: 4,
      content: '<p>Recovered after rejection.</p>',
    }));

    const extracted = await extractPage(doc, ARTICLE_URL, {
      createDefuddle: (): DefuddleInstance => ({
        parseAsync: async () => {
          throw new Error('upstream network blocked');
        },
        parse: syncParse,
      }),
    });

    expect(syncParse).toHaveBeenCalledTimes(1);
    expect(extracted.markdown).toContain('Recovered after rejection.');
    expect(
      extracted.warnings.some((w) => w.includes('upstream network blocked')),
    ).toBe(true);
  });
});

describe('selection clip support & content script message handler', () => {
  it('clips only the active DOM selection and preserves page metadata and lazy images', async () => {
    document.head.innerHTML =
      '<title>Selection Article</title><meta name="author" content="Alan Turing"><meta property="og:site_name" content="CS Blog">';
    document.body.innerHTML = `
      <article>
        <p id="before">Unselected intro paragraph.</p>
        <div id="target">
          <p>Selected <strong>important</strong> takeaway.</p>
          <img src="data:image/svg+xml;base64,PHN2Zy8+" data-src="/img/selected.png" alt="Selected Pic">
        </div>
        <p id="after">Unselected trailing paragraph.</p>
      </article>
    `;

    const range = document.createRange();
    range.selectNodeContents(document.getElementById('target')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const info = getPageInfo(document, ARTICLE_URL);
    expect(info.hasSelection).toBe(true);
    expect(info.selectionLength).toBeGreaterThan(0);
    expect(info.title).toBe('Selection Article');

    const extracted = await extractPage(document, ARTICLE_URL, { mode: 'selection' });
    expect(extracted.mode).toBe('selection');
    expect(extracted.hasSelection).toBe(true);
    expect(extracted.author).toBe('Alan Turing');
    expect(extracted.markdown).toContain('Selected **important** takeaway.');
    expect(extracted.markdown).not.toContain('Unselected intro paragraph');
    expect(extracted.markdown).not.toContain('Unselected trailing paragraph');
    expect(extracted.images.map((i) => i.resolvedUrl)).toEqual([
      'https://docs.example.com/img/selected.png',
    ]);

    selection.removeAllRanges();
  });

  it('degrades to full-page clip with a warning when selection mode is requested with no selection', async () => {
    const doc = buildArticleDocument();
    const extracted = await extractPage(doc, ARTICLE_URL, {
      mode: 'selection',
      selection: null,
    });

    expect(extracted.mode).toBe('full');
    expect(extracted.hasSelection).toBe(false);
    expect(
      extracted.warnings.some((w) => w.includes('No active text selection found')),
    ).toBe(true);
    expect(extracted.markdown).toContain('Clipping modern web pages cleanly');
  });

  it('responds cleanly to CONTENT_GET_PAGE_INFO and CONTENT_EXTRACT_PAGE messages', async () => {
    const doc = buildArticleDocument();

    const infoResp = await handleContentMessage(
      { type: 'CONTENT_GET_PAGE_INFO' },
      doc,
      ARTICLE_URL,
    );
    expect(infoResp.ok).toBe(true);
    if (infoResp.ok && infoResp.type === 'CONTENT_PAGE_INFO') {
      expect(infoResp.data.title).toBe('Designing a Reliable Web Clipper');
      expect(infoResp.data.site).toBe('Engineering Notes');
    }

    const extractResp = await handleContentMessage(
      { type: 'CONTENT_EXTRACT_PAGE', mode: 'full' },
      doc,
      ARTICLE_URL,
    );
    expect(extractResp.ok).toBe(true);
    if (extractResp.ok && extractResp.type === 'CONTENT_EXTRACTED_PAGE') {
      expect(extractResp.data.images).toHaveLength(2);
      expect(extractResp.data.markdown).toContain('Key insight inside an open Shadow DOM');
    }
  });

  it('strips unread notification prefixes from default titles in getPageInfo and extractPage while preserving years/labels', async () => {
    const zhihuHtml = `<!doctype html>
      <html>
        <head><title>(20 封私信 / 17 条消息) 华硕 ProArt 创 16 深度评测 - 知乎</title></head>
        <body><article><h1>华硕 ProArt 创 16 深度评测</h1><p>这是一篇关于硬件架构与屏幕素质的深度评测文章，包含详细实测数据与对比结论。</p></article></body>
      </html>`;
    const zhihuDoc = new DOMParser().parseFromString(zhihuHtml, 'text/html');
    const zhihuUrl = 'https://zhuanlan.zhihu.com/p/123456';

    const zhihuInfo = getPageInfo(zhihuDoc, zhihuUrl);
    expect(zhihuInfo.title).toBe('华硕 ProArt 创 16 深度评测');

    const zhihuExtracted = await extractPage(zhihuDoc, zhihuUrl, {
      mode: 'full',
      createDefuddle: (): DefuddleInstance => ({
        parseAsync: async () => ({
          title: '(20 封私信 / 17 条消息) 华硕 ProArt 创 16 深度评测',
          description: '',
          domain: 'zhuanlan.zhihu.com',
          favicon: '',
          image: '',
          language: 'zh',
          parseTime: 1,
          published: '',
          author: '',
          site: '知乎',
          schemaOrgData: null,
          wordCount: 10,
          content: '<p>正文内容。</p>',
        }),
        parse: () => {
          throw new Error('should not fall back');
        },
      }),
    });
    expect(zhihuExtracted.title).toBe('华硕 ProArt 创 16 深度评测');

    const yearHtml = `<!doctype html>
      <html>
        <head><title>(2026) Annual Report</title></head>
        <body><article><p>Annual engineering summary for 2026.</p></article></body>
      </html>`;
    const yearDoc = new DOMParser().parseFromString(yearHtml, 'text/html');
    expect(getPageInfo(yearDoc, 'https://example.com/report').title).toBe(
      '(2026) Annual Report',
    );
    const yearExtracted = await extractPage(yearDoc, 'https://example.com/report');
    expect(yearExtracted.title).toBe('(2026) Annual Report');
  });

  it('generates a clean plain-text description excerpt from extracted Markdown when meta description is missing', async () => {
    const html = `<!doctype html>
      <html>
        <head><title>Open Knowledge Format Guide</title></head>
        <body>
          <article>
            <h1>Open Knowledge Format Guide</h1>
            <p>Read the <a href="https://example.com/spec">specification</a> and store <strong>structured</strong> clips with https://t.co/ignored123 links stripped cleanly.</p>
            <img src="https://example.com/hero.png" alt="Hero Image" />
          </article>
        </body>
      </html>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const extracted = await extractPage(doc, 'https://example.com/okf', {
      mode: 'full',
    });
    expect(extracted.description).toBeTruthy();
    expect(extracted.description).toContain('Read the specification and store structured clips');
    expect(extracted.description).not.toContain('**');
    expect(extracted.description).not.toContain('https://');
    expect(Array.from(extracted.description ?? '').length).toBeLessThanOrEqual(160);
  });
});
