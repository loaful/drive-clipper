// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  discoverImagesFromMarkdown,
  isTrackingPixel,
  resolveDomImages,
  rewriteMarkdownImageUrls,
  selectBestSrcsetUrl,
} from '../../src/core/images.js';
import { LIVE_IMG_ATTRS } from '../../src/core/shadow-dom.js';

const BASE_URL = 'https://blog.example.com/posts/mv3-guide';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('selectBestSrcsetUrl', () => {
  it('picks the highest-resolution candidate even when URLs contain commas', () => {
    const srcset =
      'https://cdn.example.com/w_400,f_auto/photo.jpg 400w, https://cdn.example.com/w_1600,f_auto/photo.jpg 1600w, https://cdn.example.com/w_800,f_auto/photo.jpg 800w';
    expect(selectBestSrcsetUrl(srcset)).toBe(
      'https://cdn.example.com/w_1600,f_auto/photo.jpg',
    );
  });

  it('supports density descriptors (1x / 2x)', () => {
    expect(selectBestSrcsetUrl('/img/a.png 1x, /img/a@2x.png 2x')).toBe('/img/a@2x.png');
  });
});

describe('isTrackingPixel', () => {
  it('detects explicit 1x1 attribute, CSS 1px style, and live 1x1 natural dimensions', () => {
    const doc = createDoc(`
      <img id="attr-pixel" src="/p.gif" width="1" height="1">
      <img id="css-pixel" src="/p2.gif" style="display:block; width: 1px; height: 1px;">
      <img id="live-pixel" src="/p3.gif" ${LIVE_IMG_ATTRS.naturalWidth}="1" ${LIVE_IMG_ATTRS.naturalHeight}="1">
      <img id="tiny-valid" src="/swatch.png" ${LIVE_IMG_ATTRS.naturalWidth}="2" ${LIVE_IMG_ATTRS.naturalHeight}="2">
      <img id="divider" src="/line.png" width="1" height="200">
      <img id="broken-404" src="/missing.png" alt="Broken">
    `);

    expect(isTrackingPixel(doc.getElementById('attr-pixel')!)).toBe(true);
    expect(isTrackingPixel(doc.getElementById('css-pixel')!)).toBe(true);
    expect(isTrackingPixel(doc.getElementById('live-pixel')!)).toBe(true);
    expect(isTrackingPixel(doc.getElementById('tiny-valid')!)).toBe(false);
    expect(isTrackingPixel(doc.getElementById('divider')!)).toBe(false);
    expect(isTrackingPixel(doc.getElementById('broken-404')!)).toBe(false);
  });

  it('does not delete a lazy-loaded image whose SVG/GIF placeholder decoded to 1x1 natural dimensions', () => {
    const doc = createDoc(`
      <article>
        <img id="lazy-1x1-svg"
          src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'/%3E"
          ${LIVE_IMG_ATTRS.currentSrc}="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'/%3E"
          ${LIVE_IMG_ATTRS.naturalWidth}="1"
          ${LIVE_IMG_ATTRS.naturalHeight}="1"
          data-src="/img/lazy.webp"
          alt="Lazy Photo">
        <img id="lazy-1x1-gif"
          src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
          ${LIVE_IMG_ATTRS.naturalWidth}="1"
          ${LIVE_IMG_ATTRS.naturalHeight}="1"
          data-original="/img/lazy-gif.png"
          alt="Lazy Gif">
        <img id="real-1x1-tracker"
          src="https://track.example.com/pixel.gif"
          ${LIVE_IMG_ATTRS.naturalWidth}="1"
          ${LIVE_IMG_ATTRS.naturalHeight}="1">
      </article>
    `);

    expect(isTrackingPixel(doc.getElementById('lazy-1x1-svg')!)).toBe(false);
    expect(isTrackingPixel(doc.getElementById('lazy-1x1-gif')!)).toBe(false);
    expect(isTrackingPixel(doc.getElementById('real-1x1-tracker')!)).toBe(true);

    const meta = resolveDomImages(doc, BASE_URL);

    expect(doc.getElementById('lazy-1x1-svg')?.getAttribute('src')).toBe(
      'https://blog.example.com/img/lazy.webp',
    );
    expect(doc.getElementById('lazy-1x1-gif')?.getAttribute('src')).toBe(
      'https://blog.example.com/img/lazy-gif.png',
    );
    expect(doc.getElementById('real-1x1-tracker')).toBeNull();

    // Placeholder's 1x1 natural dimensions must not leak into DomImageMetadata
    expect(meta.get('https://blog.example.com/img/lazy.webp')).toEqual({
      alt: 'Lazy Photo',
      width: undefined,
      height: undefined,
    });
    expect(meta.get('https://blog.example.com/img/lazy-gif.png')).toEqual({
      alt: 'Lazy Gif',
      width: undefined,
      height: undefined,
    });
  });
});

describe('resolveDomImages', () => {
  it('resolves lazy attributes, prefers data-src over SVG placeholder currentSrc, uses live currentSrc for picture, and removes placeholders/tracking pixels', () => {
    const doc = createDoc(`
      <article>
        <img id="lazy-svg"
          src="data:image/svg+xml;base64,PHN2Zy8+"
          ${LIVE_IMG_ATTRS.currentSrc}="data:image/svg+xml;base64,PHN2Zy8+"
          data-src="/img/lazy-hero.webp"
          alt="Lazy Hero">
        <img id="lazy-orig" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-original="../assets/original.png" alt="Orig">
        <img id="lazy-alt" data-lazy-src="https://cdn.example.com/lazy.jpg" alt="Lazy Alt">
        <picture>
          <source srcset="/img/pic.avif" type="image/avif">
          <img id="pic-img" src="/img/pic.jpg" ${LIVE_IMG_ATTRS.currentSrc}="https://blog.example.com/img/pic.avif" alt="Picture">
        </picture>
        <img id="svg-only" src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E" alt="Placeholder">
        <img id="tracker" src="https://track.example.com/pixel.gif" width="1" height="1">
      </article>
    `);

    const meta = resolveDomImages(doc, BASE_URL);

    expect(doc.getElementById('lazy-svg')?.getAttribute('src')).toBe(
      'https://blog.example.com/img/lazy-hero.webp',
    );
    expect(doc.getElementById('lazy-orig')?.getAttribute('src')).toBe(
      'https://blog.example.com/assets/original.png',
    );
    expect(doc.getElementById('lazy-alt')?.getAttribute('src')).toBe(
      'https://cdn.example.com/lazy.jpg',
    );
    expect(doc.getElementById('pic-img')?.getAttribute('src')).toBe(
      'https://blog.example.com/img/pic.avif',
    );
    expect(doc.querySelectorAll('picture source').length).toBe(0);

    // Standalone SVG placeholder and 1px tracking pixel are removed
    expect(doc.getElementById('svg-only')).toBeNull();
    expect(doc.getElementById('tracker')).toBeNull();

    expect(meta.has('https://blog.example.com/img/lazy-hero.webp')).toBe(true);
    expect(meta.get('https://blog.example.com/img/lazy-hero.webp')?.alt).toBe('Lazy Hero');
  });
});

describe('discoverImagesFromMarkdown & rewriteMarkdownImageUrls', () => {
  it('deduplicates repeated URLs, ignores code blocks/inline code, and rewrites all duplicates while degrading failed images gracefully', () => {
    const markdown = [
      'Intro text with ![Hero Image](https://blog.example.com/img/hero.jpg "Hero Title").',
      '',
      'Duplicate with fragment: ![Hero Again](/img/hero.jpg#preview)',
      '',
      'Linked badge: [![Diagram [v2]](https://cdn.example.com/arch\\(v2\\).png)](https://cdn.example.com/full)',
      '',
      'Broken image: ![Broken](https://blog.example.com/img/missing-404.png)',
      '',
      'Inline code example: `![NotAnImage](https://blog.example.com/img/hero.jpg)`',
      '',
      '```markdown',
      '![FencedExample](https://blog.example.com/img/hero.jpg)',
      '```',
      '',
      'Raw HTML fallback: <img src="https://blog.example.com/img/hero.jpg" alt="Raw">',
    ].join('\n');

    const discovered = discoverImagesFromMarkdown(markdown, BASE_URL);

    // 3 unique remote images: hero.jpg (deduped across 3 occurrences), arch(v2).png, missing-404.png
    expect(discovered).toHaveLength(3);
    expect(discovered[0]).toMatchObject({
      id: 'img-01',
      resolvedUrl: 'https://blog.example.com/img/hero.jpg',
      suggestedName: '01-hero',
    });
    expect(discovered[0].sourceUrls).toEqual([
      'https://blog.example.com/img/hero.jpg',
      '/img/hero.jpg#preview',
    ]);
    expect(discovered[1]).toMatchObject({
      id: 'img-02',
      resolvedUrl: 'https://cdn.example.com/arch(v2).png',
      alt: 'Diagram [v2]',
    });
    expect(discovered[2]).toMatchObject({
      id: 'img-03',
      resolvedUrl: 'https://blog.example.com/img/missing-404.png',
    });

    const rewritten = rewriteMarkdownImageUrls(
      markdown,
      BASE_URL,
      [
        {
          resolvedUrl: discovered[0].resolvedUrl,
          originalUrl: discovered[0].originalUrl,
          sourceUrls: discovered[0].sourceUrls,
          filename: '01-hero.jpg',
        },
        {
          resolvedUrl: discovered[1].resolvedUrl,
          originalUrl: discovered[1].originalUrl,
          sourceUrls: discovered[1].sourceUrls,
          filename: '02-arch-v2.png',
        },
      ],
      [
        {
          id: discovered[2].id,
          originalUrl: discovered[2].originalUrl,
          resolvedUrl: discovered[2].resolvedUrl,
          sourceUrls: discovered[2].sourceUrls,
          reason: 'Not Found',
          status: 404,
        },
      ],
    );

    expect(rewritten.rewrittenCount).toBe(4);
    expect(rewritten.localImagePaths).toEqual([
      './images/01-hero.jpg',
      './images/02-arch-v2.png',
    ]);
    expect(rewritten.warnings).toEqual([
      'Image download failed for https://blog.example.com/img/missing-404.png (HTTP 404): Not Found; kept original URL.',
    ]);

    // All real occurrences of hero.jpg and arch(v2).png rewritten
    expect(rewritten.markdown).toContain('![Hero Image](./images/01-hero.jpg "Hero Title")');
    expect(rewritten.markdown).toContain('![Hero Again](./images/01-hero.jpg)');
    expect(rewritten.markdown).toContain(
      '[![Diagram [v2]](./images/02-arch-v2.png)](https://cdn.example.com/full)',
    );
    expect(rewritten.markdown).toContain('<img src="./images/01-hero.jpg" alt="Raw">');

    // Failed 404 image keeps original URL
    expect(rewritten.markdown).toContain(
      '![Broken](https://blog.example.com/img/missing-404.png)',
    );

    // Code samples remain untouched
    expect(rewritten.markdown).toContain(
      '`![NotAnImage](https://blog.example.com/img/hero.jpg)`',
    );
    expect(rewritten.markdown).toContain(
      '![FencedExample](https://blog.example.com/img/hero.jpg)',
    );
  });

  it('normalizes HTML-escaped &amp; query strings for discovery and rewrites them cleanly', () => {
    const md =
      'Chart: ![Chart](https://cdn.example.com/render?a=1&amp;copy=2) and again ![Chart 2](https://cdn.example.com/render?a=1&copy=2)';
    const discovered = discoverImagesFromMarkdown(md, BASE_URL);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].resolvedUrl).toBe('https://cdn.example.com/render?a=1&copy=2');
    expect(discovered[0].sourceUrls).toEqual([
      'https://cdn.example.com/render?a=1&amp;copy=2',
      'https://cdn.example.com/render?a=1&copy=2',
    ]);

    const rewritten = rewriteMarkdownImageUrls(md, BASE_URL, [
      {
        resolvedUrl: discovered[0].resolvedUrl,
        originalUrl: discovered[0].originalUrl,
        sourceUrls: discovered[0].sourceUrls,
        filename: '01-render.png',
      },
    ]);
    expect(rewritten.rewrittenCount).toBe(2);
    expect(rewritten.markdown).toBe(
      'Chart: ![Chart](./images/01-render.png) and again ![Chart 2](./images/01-render.png)',
    );
  });

  it('ignores data-src and data-alt when parsing inline HTML <img> tags in Markdown', () => {
    const md =
      '<img data-src="https://wrong.example.com/ignored.png" src="https://cdn.example.com/real.png" data-alt="Wrong Alt" alt="Real Alt">';

    const discovered = discoverImagesFromMarkdown(md, BASE_URL);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      resolvedUrl: 'https://cdn.example.com/real.png',
      alt: 'Real Alt',
    });

    const rewritten = rewriteMarkdownImageUrls(md, BASE_URL, [
      {
        resolvedUrl: discovered[0].resolvedUrl,
        originalUrl: discovered[0].originalUrl,
        sourceUrls: discovered[0].sourceUrls,
        filename: '01-real.png',
      },
    ]);
    expect(rewritten.rewrittenCount).toBe(1);
    expect(rewritten.markdown).toBe(
      '<img data-src="https://wrong.example.com/ignored.png" src="./images/01-real.png" data-alt="Wrong Alt" alt="Real Alt">',
    );
  });
});
