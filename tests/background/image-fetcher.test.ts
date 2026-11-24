import { describe, expect, it, vi } from 'vitest';
import {
  buildRefererSessionRules,
  cleanupOrphanedRefererSessionRules,
  detectImageFormat,
  fetchImages,
  withRefererSessionRules,
  type DeclarativeNetRequestLike,
} from '../../src/background/image-fetcher.js';
import type { DiscoveredImage } from '../../src/types.js';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF89A_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20,
]);
// ISO BMFF ftyp box with major brand 'avif'
const AVIF_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00,
  0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x6d, 0x69, 0x61, 0x66,
]);
// ISO BMFF ftyp box with major brand 'mif1' and compatible brand 'avif'
const AVIF_COMPAT_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0x00,
  0x00, 0x00, 0x00, 0x6d, 0x69, 0x61, 0x66, 0x61, 0x76, 0x69, 0x66,
]);
const SVG_BYTES = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- icon --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
);

function makeImage(
  idx: number,
  url: string,
  suggestedName = `img-${String(idx).padStart(2, '0')}`,
): DiscoveredImage {
  return {
    id: `img-${idx}`,
    originalUrl: url,
    resolvedUrl: url,
    sourceUrls: [url],
    alt: `Image ${idx}`,
    suggestedName,
  };
}

function makeBinaryResponse(
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
  status = 200,
): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    status,
    headers: {
      'content-type': contentType,
      'content-length': String(copy.byteLength),
    },
  });
}

function createFakeDnr() {
  const activeRules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const history: chrome.declarativeNetRequest.UpdateRuleOptions[] = [];

  const dnr: DeclarativeNetRequestLike = {
    async getSessionRules() {
      return Array.from(activeRules.values());
    },
    async updateSessionRules(options) {
      history.push(options);
      if (options.removeRuleIds) {
        for (const id of options.removeRuleIds) {
          activeRules.delete(id);
        }
      }
      if (options.addRules) {
        for (const rule of options.addRules) {
          if (activeRules.has(rule.id)) {
            throw new Error(`Duplicate DNR session rule ID: ${rule.id}`);
          }
          activeRules.set(rule.id, rule);
        }
      }
    },
  };

  return { dnr, activeRules, history };
}

describe('detectImageFormat', () => {
  it('sniffs PNG, JPEG, GIF, WebP, AVIF (major + compat brand), and SVG without re-encoding', () => {
    expect(detectImageFormat(PNG_BYTES, 'application/octet-stream')).toEqual({
      mimeType: 'image/png',
      ext: 'png',
    });
    expect(detectImageFormat(JPEG_BYTES, 'image/png')).toEqual({
      mimeType: 'image/jpeg',
      ext: 'jpg',
    });
    expect(detectImageFormat(GIF89A_BYTES, null)).toEqual({
      mimeType: 'image/gif',
      ext: 'gif',
    });
    expect(detectImageFormat(WEBP_BYTES, 'image/jpeg')).toEqual({
      mimeType: 'image/webp',
      ext: 'webp',
    });
    expect(detectImageFormat(AVIF_BYTES, 'application/octet-stream')).toEqual({
      mimeType: 'image/avif',
      ext: 'avif',
    });
    expect(detectImageFormat(AVIF_COMPAT_BYTES, 'image/avif')).toEqual({
      mimeType: 'image/avif',
      ext: 'avif',
    });
    expect(detectImageFormat(SVG_BYTES, 'text/plain')).toEqual({
      mimeType: 'image/svg+xml',
      ext: 'svg',
    });
  });

  it('rejects empty payloads, HTML error pages, and JSON even if Content-Type claims image/*', () => {
    expect(detectImageFormat(new Uint8Array(), 'image/png')).toBeNull();
    expect(
      detectImageFormat(
        new TextEncoder().encode('<!DOCTYPE html><html><body><svg></svg></body></html>'),
        'image/svg+xml',
      ),
    ).toBeNull();
    expect(
      detectImageFormat(
        new TextEncoder().encode('{"error":"hotlink blocked"}'),
        'image/png',
      ),
    ).toBeNull();
  });
});

describe('fetchImages', () => {
  it('enforces bounded concurrency (<= 5 by default) and preserves original extensions', async () => {
    const images = Array.from({ length: 12 }, (_, i) =>
      makeImage(i + 1, `https://cdn.example.com/pic-${i + 1}`, `0${i + 1}-asset`),
    );

    const formats: Array<{ bytes: Uint8Array; ct: string; expectedExt: string }> = [
      { bytes: WEBP_BYTES, ct: 'image/webp', expectedExt: 'webp' },
      { bytes: PNG_BYTES, ct: 'image/png', expectedExt: 'png' },
      { bytes: JPEG_BYTES, ct: 'image/jpeg', expectedExt: 'jpg' },
      { bytes: GIF89A_BYTES, ct: 'image/gif', expectedExt: 'gif' },
      { bytes: AVIF_BYTES, ct: 'image/avif', expectedExt: 'avif' },
      { bytes: SVG_BYTES, ct: 'image/svg+xml', expectedExt: 'svg' },
    ];

    let inFlight = 0;
    let peakConcurrency = 0;

    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      const match = /pic-(\d+)$/.exec(url);
      const idx = Number(match?.[1] ?? 1) - 1;
      const spec = formats[idx % formats.length];

      inFlight += 1;
      peakConcurrency = Math.max(peakConcurrency, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;

      return makeBinaryResponse(spec.bytes, spec.ct);
    });

    const progressUpdates: Array<[number, number]> = [];
    const result = await fetchImages(images, 'https://blog.example.com/post', {
      fetchImpl,
      dnr: null,
      onProgress: (completed, total) => progressUpdates.push([completed, total]),
    });

    expect(peakConcurrency).toBeLessThanOrEqual(5);
    expect(peakConcurrency).toBeGreaterThan(1);
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(12);
    expect(result.succeeded.map((img) => img.filename)).toEqual(
      images.map(
        (img, i) => `${img.suggestedName}.${formats[i % formats.length].expectedExt}`,
      ),
    );
    expect(progressUpdates[progressUpdates.length - 1]).toEqual([12, 12]);
  });

  it('adds temporary DNR Referer session rules before fetching and removes exact rule IDs on success', async () => {
    const { dnr, activeRules, history } = createFakeDnr();
    const pageUrl = 'https://news.example.org/articles/42';
    const imageUrl = 'https://img.example.org/protected/hero';

    let activeRulesDuringFetch: chrome.declarativeNetRequest.Rule[] = [];

    const fetchImpl: typeof fetch = vi.fn(async () => {
      activeRulesDuringFetch = Array.from(activeRules.values());
      return makeBinaryResponse(WEBP_BYTES, 'application/octet-stream');
    });

    const result = await fetchImages([makeImage(1, imageUrl, '01-hero')], pageUrl, {
      fetchImpl,
      dnr,
    });

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].filename).toBe('01-hero.webp');

    expect(activeRulesDuringFetch).toHaveLength(1);
    const addedRule = activeRulesDuringFetch[0];
    expect(addedRule.action.type).toBe('modifyHeaders');
    expect(addedRule.action.requestHeaders).toEqual([
      { header: 'Referer', operation: 'set', value: pageUrl },
    ]);
    expect(addedRule.condition.tabIds).toEqual([-1]);
    expect(addedRule.condition.urlFilter).toBe(
      '|https://img.example.org/protected/hero|',
    );

    // Exact rule ID removed after fetch completes.
    expect(activeRules.size).toBe(0);
    expect(history).toHaveLength(2);
    expect(history[0].addRules?.map((r) => r.id)).toEqual([addedRule.id]);
    expect(history[1].removeRuleIds).toEqual([addedRule.id]);
  });

  it('guarantees DNR session rule cleanup even when an error is thrown or batch is aborted', async () => {
    const { dnr, activeRules, history } = createFakeDnr();

    await expect(
      withRefererSessionRules(
        dnr,
        'https://site.example/page',
        ['https://cdn.example/a.png', 'https://cdn.example/b.webp'],
        async () => {
          expect(activeRules.size).toBe(2);
          throw new Error('simulated failure mid-batch');
        },
      ),
    ).rejects.toThrow('simulated failure mid-batch');

    expect(activeRules.size).toBe(0);
    const addedIds = history[0].addRules?.map((r) => r.id) ?? [];
    expect(addedIds).toHaveLength(2);
    expect(history[1].removeRuleIds).toEqual(addedIds);

    // Also verify fetchImages cleans up DNR rules when onProgress throws.
    const { dnr: dnr2, activeRules: activeRules2, history: history2 } = createFakeDnr();
    await expect(
      fetchImages(
        [makeImage(1, 'https://cdn.example/c.png')],
        'https://site.example/page',
        {
          dnr: dnr2,
          fetchImpl: async () => makeBinaryResponse(PNG_BYTES, 'image/png'),
          onProgress: () => {
            throw new Error('observer crashed');
          },
        },
      ),
    ).rejects.toThrow('observer crashed');

    expect(activeRules2.size).toBe(0);
    expect(history2[1].removeRuleIds).toEqual(history2[0].addRules?.map((r) => r.id));
  });

  it('assigns non-overlapping DNR rule IDs across concurrent runs', async () => {
    const { dnr, activeRules } = createFakeDnr();
    const observedRuleSets: number[][] = [];

    const makeSlowFetch = (): typeof fetch => async () => {
      observedRuleSets.push(Array.from(activeRules.keys()));
      await new Promise((r) => setTimeout(r, 20));
      return makeBinaryResponse(PNG_BYTES, 'image/png');
    };

    const [r1, r2] = await Promise.all([
      fetchImages(
        [makeImage(1, 'https://cdn.example/one.png')],
        'https://site-a.example/post',
        { dnr, fetchImpl: makeSlowFetch() },
      ),
      fetchImages(
        [makeImage(1, 'https://cdn.example/two.png')],
        'https://site-b.example/post',
        { dnr, fetchImpl: makeSlowFetch() },
      ),
    ]);

    expect(r1.succeeded).toHaveLength(1);
    expect(r2.succeeded).toHaveLength(1);
    expect(activeRules.size).toBe(0);
    // Both rules coexisted without overwriting each other's IDs.
    expect(observedRuleSets.some((ids) => ids.length === 2)).toBe(true);
  });

  it('isolates exact-URL DNR Referer rules across concurrent articles sharing the same CDN host and removes only each call’s own rule IDs', async () => {
    const { dnr, activeRules, history } = createFakeDnr();
    const articleA = 'https://zhuanlan.zhihu.com/p/111';
    const articleB = 'https://zhuanlan.zhihu.com/p/222';

    const imgA1 = 'https://pic1.zhimg.com/img/1';
    const imgA2 = 'https://pic1.zhimg.com/proxy?id=1';
    const imgB1 = 'https://pic1.zhimg.com/img/10';
    const imgB2 = 'https://pic1.zhimg.com/proxy?id=2';

    let releaseJobA!: () => void;
    let releaseJobB!: () => void;
    const jobAGate = new Promise<void>((resolve) => {
      releaseJobA = resolve;
    });
    const jobBGate = new Promise<void>((resolve) => {
      releaseJobB = resolve;
    });

    let bothStartedResolve!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      bothStartedResolve = resolve;
    });
    const startedJobs = new Set<string>();

    const makeGatedFetch =
      (jobName: string, gate: Promise<void>): typeof fetch =>
      async () => {
        startedJobs.add(jobName);
        if (startedJobs.size === 2) {
          bothStartedResolve();
        }
        await gate;
        return makeBinaryResponse(PNG_BYTES, 'image/png');
      };

    const runA = fetchImages(
      [makeImage(1, imgA1), makeImage(2, imgA2)],
      articleA,
      { dnr, fetchImpl: makeGatedFetch('A', jobAGate) },
    );
    const runB = fetchImages(
      [makeImage(1, imgB1), makeImage(2, imgB2)],
      articleB,
      { dnr, fetchImpl: makeGatedFetch('B', jobBGate) },
    );

    await bothStarted;

    // All 4 specific-URL rules coexist with unique IDs and distinct Referers (no broad host wildcards).
    expect(activeRules.size).toBe(4);
    const rulesDuringOverlap = Array.from(activeRules.values());
    const filtersByReferer = new Map<string, string[]>();
    for (const rule of rulesDuringOverlap) {
      const ref = rule.action.requestHeaders?.[0]?.value ?? '';
      const filter = rule.condition.urlFilter ?? '';
      expect(filter).not.toBe('|https://pic1.zhimg.com/');
      filtersByReferer.set(ref, [...(filtersByReferer.get(ref) ?? []), filter]);
    }

    expect(filtersByReferer.get(articleA)?.sort()).toEqual([
      '|https://pic1.zhimg.com/img/1|',
      '|https://pic1.zhimg.com/proxy?id=1|',
    ]);
    expect(filtersByReferer.get(articleB)?.sort()).toEqual([
      '|https://pic1.zhimg.com/img/10|',
      '|https://pic1.zhimg.com/proxy?id=2|',
    ]);

    // Finish Job A first: only Job A's rule IDs are removed; Job B's rules remain active!
    releaseJobA();
    const resA = await runA;
    expect(resA.succeeded).toHaveLength(2);
    expect(activeRules.size).toBe(2);
    for (const remainingRule of activeRules.values()) {
      expect(remainingRule.action.requestHeaders?.[0]?.value).toBe(articleB);
    }

    // Finish Job B: all rules cleaned up cleanly.
    releaseJobB();
    const resB = await runB;
    expect(resB.succeeded).toHaveLength(2);
    expect(activeRules.size).toBe(0);
    expect(history.filter((entry) => entry.removeRuleIds)).toHaveLength(2);
  });

  it('uses exact regexFilter for image URLs containing DNR wildcards (*|^) instead of falling back to a broad origin rule', () => {
    const rules = buildRefererSessionRules('https://site.example/post/1', [
      'https://cdn.example/images/hero*2x|alt.png?v=1^2',
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].condition.urlFilter).toBeUndefined();
    expect(rules[0].condition.regexFilter).toBe(
      '^https://cdn\\.example/images/hero\\*2x\\|alt\\.png\\?v=1\\^2$',
    );
    expect(rules[0].priority).toBe(2);
  });

  it('cleans up orphaned SW Referer session rules while preserving active batch rules and unrelated rules', async () => {
    const { dnr, activeRules } = createFakeDnr();
    const orphanRule: chrome.declarativeNetRequest.Rule = {
      id: 777,
      priority: 2,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'Referer',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: 'https://stale.example/article',
          },
        ],
      },
      condition: {
        urlFilter: '|https://cdn.example/stale.png|',
        tabIds: [-1],
        resourceTypes: ['image'] as chrome.declarativeNetRequest.ResourceType[],
      },
    };
    const unrelatedRule: chrome.declarativeNetRequest.Rule = {
      id: 888,
      priority: 1,
      action: {
        type: 'allow' as chrome.declarativeNetRequest.RuleActionType,
      },
      condition: {
        urlFilter: '|https://other.example/',
      },
    };
    await dnr.updateSessionRules({ addRules: [orphanRule, unrelatedRule] });

    const removed = await withRefererSessionRules(
      dnr,
      'https://live.example/article',
      ['https://cdn.example/live.png'],
      async () => {
        const cleaned = await cleanupOrphanedRefererSessionRules(dnr);
        // Orphan 777 removed, active live rule + unrelated rule 888 preserved!
        expect(cleaned).toEqual([777]);
        expect(activeRules.has(777)).toBe(false);
        expect(activeRules.has(888)).toBe(true);
        expect(activeRules.size).toBe(2);
        return cleaned;
      },
    );

    expect(removed).toEqual([777]);
    expect(Array.from(activeRules.keys())).toEqual([888]);
  });

  it('gracefully returns structured failures for 404, network error, timeout, non-image payload, and size cap without failing valid images', async () => {
    const images: DiscoveredImage[] = [
      makeImage(1, 'https://cdn.example/ok.png', '01-ok'),
      makeImage(2, 'https://cdn.example/missing.png', '02-missing'),
      makeImage(3, 'https://cdn.example/network-down.png', '03-down'),
      makeImage(4, 'https://cdn.example/slow.png', '04-slow'),
      makeImage(5, 'https://cdn.example/html-wall.png', '05-html'),
      makeImage(6, 'https://cdn.example/huge.png', '06-huge'),
    ];

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/ok.png')) {
        return makeBinaryResponse(PNG_BYTES, 'image/png');
      }
      if (url.endsWith('/missing.png')) {
        return new Response('Not Found', { status: 404, statusText: 'Not Found' });
      }
      if (url.endsWith('/network-down.png')) {
        throw new TypeError('Failed to fetch');
      }
      if (url.endsWith('/slow.png')) {
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (url.endsWith('/html-wall.png')) {
        return new Response('<html><body>Please sign in</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.endsWith('/huge.png')) {
        const big = new Uint8Array(2048);
        big.set(PNG_BYTES, 0);
        return makeBinaryResponse(big, 'image/png');
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchImages(images, 'https://blog.example/post', {
      fetchImpl,
      dnr: null,
      timeoutMs: 40,
      maxBytes: 1024,
    });

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].id).toBe('img-1');
    expect(result.succeeded[0].filename).toBe('01-ok.png');

    expect(result.failed).toHaveLength(5);
    const byId = new Map(result.failed.map((f) => [f.id, f]));
    expect(byId.get('img-2')?.status).toBe(404);
    expect(byId.get('img-3')?.reason).toMatch(/Network error/i);
    expect(byId.get('img-4')?.reason).toMatch(/timed out/i);
    expect(byId.get('img-5')?.reason).toMatch(/Non-image payload/i);
    expect(byId.get('img-6')?.reason).toMatch(/exceeds limit/i);
  });

  it('deduplicates identical resolved URLs and merges sourceUrls', async () => {
    const images: DiscoveredImage[] = [
      {
        id: 'img-1',
        originalUrl: '/assets/diagram.png',
        resolvedUrl: 'https://blog.example/assets/diagram.png',
        sourceUrls: ['/assets/diagram.png'],
        alt: 'Diagram',
        suggestedName: '01-diagram',
      },
      {
        id: 'img-2',
        originalUrl: 'https://blog.example/assets/diagram.png',
        resolvedUrl: 'https://blog.example/assets/diagram.png',
        sourceUrls: ['https://blog.example/assets/diagram.png'],
        alt: 'Diagram again',
        suggestedName: '02-diagram',
      },
    ];

    const fetchImpl = vi.fn(async () => makeBinaryResponse(PNG_BYTES, 'image/png'));

    const result = await fetchImages(images, 'https://blog.example/post', {
      fetchImpl,
      dnr: null,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].sourceUrls).toEqual([
      '/assets/diagram.png',
      'https://blog.example/assets/diagram.png',
    ]);
  });

  it('enforces maxBytes on chunked streams without Content-Length and disambiguates duplicate filenames', async () => {
    const images: DiscoveredImage[] = [
      makeImage(1, 'https://cdn.example/a.png', 'hero.png'),
      makeImage(2, 'https://cdn.example/b.png', 'hero'),
      makeImage(3, 'https://cdn.example/chunked-huge.png', 'stream'),
    ];

    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/chunked-huge.png')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG_BYTES);
            controller.enqueue(new Uint8Array(600));
            controller.enqueue(new Uint8Array(600));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return makeBinaryResponse(PNG_BYTES, 'image/png');
    });

    const result = await fetchImages(images, 'https://blog.example/post', {
      fetchImpl,
      dnr: null,
      maxBytes: 1024,
    });

    expect(result.succeeded.map((img) => img.filename)).toEqual([
      'hero.png',
      'hero-2.png',
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('img-3');
    expect(result.failed[0].reason).toMatch(/exceeds limit/i);
  });

  it('propagates AbortSignal cancellation while still removing active DNR rules', async () => {
    const { dnr, activeRules, history } = createFakeDnr();
    const controller = new AbortController();

    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      controller.abort();
      return await new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    await expect(
      fetchImages(
        [makeImage(1, 'https://cdn.example/cancel-me.png')],
        'https://blog.example/post',
        {
          fetchImpl,
          dnr,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(activeRules.size).toBe(0);
    expect(history).toHaveLength(2);
    expect(history[1].removeRuleIds).toEqual(history[0].addRules?.map((r) => r.id));
  });

  it('assigns deterministic, shift-proof filenames when image #1 fails on Run 1 and succeeds on Run 2', async () => {
    const images: DiscoveredImage[] = [
      makeImage(1, 'https://cdn.example/photo-a.jpg', 'photo'),
      makeImage(2, 'https://cdn.example/photo-b.png', 'photo'),
      makeImage(3, 'https://cdn.example/photo-c.webp', ''),
    ];

    let failFirstImage = true;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/photo-a.jpg')) {
        if (failFirstImage) {
          return new Response('Temporary error', { status: 503 });
        }
        return makeBinaryResponse(JPEG_BYTES, 'image/jpeg');
      }
      if (url.endsWith('/photo-b.png')) {
        return makeBinaryResponse(PNG_BYTES, 'image/png');
      }
      return makeBinaryResponse(WEBP_BYTES, 'image/webp');
    });

    // Run 1: Image #1 fails -> Images #2 and #3 must still keep their deterministic slots!
    const run1 = await fetchImages(images, 'https://blog.example/post', {
      fetchImpl,
      dnr: null,
    });
    expect(run1.failed).toHaveLength(1);
    expect(run1.succeeded.map((img) => [img.id, img.filename])).toEqual([
      ['img-2', 'photo-2.png'],
      ['img-3', 'image-03.webp'],
    ]);

    // Run 2: Image #1 succeeds -> Images #2 and #3 keep the EXACT SAME filenames!
    failFirstImage = false;
    const run2 = await fetchImages(images, 'https://blog.example/post', {
      fetchImpl,
      dnr: null,
    });
    expect(run2.failed).toHaveLength(0);
    expect(run2.succeeded.map((img) => [img.id, img.filename])).toEqual([
      ['img-1', 'photo.jpg'],
      ['img-2', 'photo-2.png'],
      ['img-3', 'image-03.webp'],
    ]);
  });
});
