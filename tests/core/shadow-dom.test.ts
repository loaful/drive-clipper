// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  flattenShadowDom,
  LIVE_IMG_ATTRS,
} from '../../src/core/shadow-dom.js';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('flattenShadowDom', () => {
  it('flattens open shadow roots on custom elements without mutating the source document', () => {
    const doc = createDoc(
      '<!doctype html><html><head><title>Shadow Test</title><script type="application/ld+json">{"@type":"Article"}</script></head><body><main><x-article id="entry"></x-article></main></body></html>',
    );
    const host = doc.querySelector('x-article')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>.secret { color: red; }</style><script>window.x = 1;</script><h2>Inside Shadow</h2><p>Paragraph hidden in shadow DOM.</p>';

    const result = flattenShadowDom(doc);

    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.flattenedShadowRoots).toBe(1);
    expect(result.warnings).toEqual([]);

    // Custom element host is replaced with a div carrying data-shadow-host
    const flattenedHost = result.document.querySelector('[data-shadow-host="x-article"]');
    expect(flattenedHost).not.toBeNull();
    expect(flattenedHost?.tagName).toBe('DIV');
    expect(flattenedHost?.textContent).toContain('Inside Shadow');
    expect(flattenedHost?.textContent).toContain('Paragraph hidden in shadow DOM.');
    // Shadow <style> and <script> are stripped, while light-DOM JSON-LD metadata survives
    expect(flattenedHost?.querySelector('style')).toBeNull();
    expect(flattenedHost?.querySelector('script')).toBeNull();
    expect(
      result.document.querySelector('script[type="application/ld+json"]')?.textContent,
    ).toBe('{"@type":"Article"}');

    // Original live document was never mutated
    expect(doc.querySelector('x-article')?.shadowRoot).toBe(shadow);
    expect(doc.querySelector('[data-shadow-host]')).toBeNull();
  });

  it('resolves named slots, default slots, fallback slots, and nested shadow roots', () => {
    const doc = createDoc(
      '<!doctype html><html><body><x-card><span slot="header">Card Header</span><x-nested>Light nested</x-nested></x-card></body></html>',
    );

    const card = doc.querySelector('x-card')!;
    const cardShadow = card.attachShadow({ mode: 'open' });
    cardShadow.innerHTML =
      '<header><slot name="header">Default Header</slot></header><section><slot></slot></section><footer><slot name="footer">Fallback Footer</slot></footer>';

    const nested = doc.querySelector('x-nested')!;
    const nestedShadow = nested.attachShadow({ mode: 'open' });
    nestedShadow.innerHTML = '<p>Nested Shadow: <slot></slot></p>';

    const result = flattenShadowDom(doc);

    expect(result.flattenedShadowRoots).toBe(2);
    const text = result.document.body.textContent ?? '';
    expect(text).toContain('Card Header');
    expect(text).toContain('Nested Shadow: Light nested');
    expect(text).toContain('Fallback Footer');
  });

  it('copies live image currentSrc and natural dimensions onto the clone only', () => {
    const doc = createDoc(
      '<!doctype html><html><body><img id="hero" src="/fallback.jpg"></body></html>',
    );
    const liveImg = doc.getElementById('hero') as HTMLImageElement;
    Object.defineProperty(liveImg, 'currentSrc', {
      value: 'https://cdn.example.com/hero@2x.webp',
      configurable: true,
    });
    Object.defineProperty(liveImg, 'naturalWidth', {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(liveImg, 'naturalHeight', {
      value: 630,
      configurable: true,
    });

    const result = flattenShadowDom(doc);
    const clonedImg = result.document.getElementById('hero')!;

    expect(clonedImg.getAttribute(LIVE_IMG_ATTRS.currentSrc)).toBe(
      'https://cdn.example.com/hero@2x.webp',
    );
    expect(clonedImg.getAttribute(LIVE_IMG_ATTRS.naturalWidth)).toBe('1200');
    expect(clonedImg.getAttribute(LIVE_IMG_ATTRS.naturalHeight)).toBe('630');
    // Live element must remain untouched
    expect(liveImg.hasAttribute(LIVE_IMG_ATTRS.currentSrc)).toBe(false);
  });

  it('bails out gracefully with a warning when timeoutMs is exceeded', () => {
    const doc = createDoc(
      '<!doctype html><html><body><x-first></x-first><x-second></x-second></body></html>',
    );
    const first = doc.querySelector('x-first')!;
    first.attachShadow({ mode: 'open' }).innerHTML = '<p>First shadow</p>';
    const second = doc.querySelector('x-second')!;
    second.attachShadow({ mode: 'open' }).innerHTML = '<p>Second shadow</p>';

    let tick = 0;
    const fakeNow = () => {
      // Initial deadline call returns 0; first shadow boundary returns 50; next call returns 200 (> 100ms)
      tick += 1;
      if (tick === 1) return 0;
      if (tick === 2) return 50;
      return 200;
    };

    const result = flattenShadowDom(doc, { timeoutMs: 100, now: fakeNow });

    expect(result.timedOut).toBe(true);
    expect(result.flattenedShadowRoots).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('timed out after 100ms');
    expect(result.document.body.textContent).toContain('First shadow');
  });

  it('enforces maxDepth and reports truncation warning', () => {
    const doc = createDoc('<!doctype html><html><body><x-outer></x-outer></body></html>');
    const outer = doc.querySelector('x-outer')!;
    const outerShadow = outer.attachShadow({ mode: 'open' });
    outerShadow.innerHTML = '<x-inner></x-inner>';
    const inner = outerShadow.querySelector('x-inner')!;
    inner.attachShadow({ mode: 'open' }).innerHTML = '<p>Too Deep</p>';

    const result = flattenShadowDom(doc, { maxDepth: 1 });

    expect(result.truncated).toBe(true);
    expect(result.flattenedShadowRoots).toBe(1);
    expect(result.document.body.textContent).not.toContain('Too Deep');
    expect(result.warnings.some((w) => w.includes('safety depth/node limit'))).toBe(true);
  });
});
