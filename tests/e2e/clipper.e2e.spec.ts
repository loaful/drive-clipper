import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ROOT_DIR = path.resolve(process.cwd());
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const SCREENSHOT_DIR =
  process.env.E2E_SCREENSHOT_DIR && process.env.E2E_SCREENSHOT_DIR.trim().length > 0
    ? path.resolve(process.env.E2E_SCREENSHOT_DIR)
    : path.join(ROOT_DIR, 'test-results');

const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TEST_OAUTH_CLIENT_ID = '1234567890-e2eclient.apps.googleusercontent.com';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

// Minimal valid 2x2 PNG (not 1x1 so Chromium never misclassifies it as a tracking pixel)
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8AARAwMDAwAAwAB/wE+3gAAAABJRU5ErkJggg==',
  'base64',
);

// Minimal valid 2x2 lossless WebP (RIFF....WEBP VP8L)
const VALID_WEBP_BYTES = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
  'base64',
);

// Minimal valid 2x2 baseline JPEG
const VALID_JPEG_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAACAAIBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

// Minimal 1x1 transparent GIF for genuine tracking pixel fixture
const TRACKING_PIXEL_GIF_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

// 1x1 SVG placeholder used on the lazy-loaded <img> (decodes to naturalWidth=1, naturalHeight=1 in Chromium)
const LAZY_SVG_PLACEHOLDER =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>',
  ).toString('base64');

interface RecordedMultipartUpload {
  method: 'POST' | 'PATCH';
  fileId?: string;
  metadata: Record<string, unknown>;
  contentType: string;
  contentBytes: Buffer;
}

interface MockDriveItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties: Record<string, string>;
  content?: Buffer;
}

interface MockDriveServerHandle {
  server: Server;
  baseUrl: string;
  files: Map<string, MockDriveItem>;
  folderCreations: MockDriveItem[];
  sourceUrlQueries: string[];
  uploads: RecordedMultipartUpload[];
  uploadOrder: string[];
  close(): Promise<void>;
}

interface FixtureServerHandle {
  server: Server;
  baseUrl: string;
  articleUrl: string;
  imageRequests: Array<{ path: string; referer: string | undefined; status: number }>;
  close(): Promise<void>;
}

interface StaticDistServerHandle {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartRelated(
  rawBody: Buffer,
  contentTypeHeader: string,
): {
  metadata: Record<string, unknown>;
  contentType: string;
  contentBytes: Buffer;
} {
  const boundaryMatch = /boundary=([^\s;]+)/i.exec(contentTypeHeader);
  if (!boundaryMatch) {
    throw new Error(`Missing multipart boundary in Content-Type: ${contentTypeHeader}`);
  }
  const boundary = boundaryMatch[1];
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const firstIdx = rawBody.indexOf(delimiter);
  const secondIdx = rawBody.indexOf(delimiter, firstIdx + delimiter.length);
  const closeIdx = rawBody.indexOf(
    Buffer.from(`\r\n--${boundary}--`, 'latin1'),
    secondIdx + delimiter.length,
  );
  if (firstIdx === -1 || secondIdx === -1 || closeIdx === -1) {
    throw new Error('Malformed multipart/related body');
  }

  const sep = Buffer.from('\r\n\r\n', 'latin1');
  const part1Start = firstIdx + delimiter.length + 2;
  const part1HeaderEnd = rawBody.indexOf(sep, part1Start);
  const part1Body = rawBody
    .subarray(part1HeaderEnd + 4, secondIdx - 2)
    .toString('utf8');
  const metadata = JSON.parse(part1Body) as Record<string, unknown>;

  const part2Start = secondIdx + delimiter.length + 2;
  const part2HeaderEnd = rawBody.indexOf(sep, part2Start);
  const part2Headers = rawBody
    .subarray(part2Start, part2HeaderEnd)
    .toString('latin1');
  const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(part2Headers);
  const contentType = ctMatch?.[1].trim() ?? '';
  const contentBytes = Buffer.from(rawBody.subarray(part2HeaderEnd + 4, closeIdx));

  return { metadata, contentType, contentBytes };
}

async function startFixtureServer(): Promise<FixtureServerHandle> {
  const imageRequests: Array<{ path: string; referer: string | undefined; status: number }> = [];
  let baseUrl = '';
  let articleUrl = '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (pathname === '/articles/mv3-clipper-test') {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Drive Clipper End-to-End Architecture</title>
    <meta name="author" content="Ada Lovelace" />
    <meta property="og:site_name" content="Clipper Engineering Blog" />
    <meta property="article:published_time" content="2026-11-20T09:00:00Z" />
    <meta name="description" content="Real-browser E2E fixture covering Shadow DOM, lazy images, deduplication, anti-hotlink Referer, and 404 fallback." />
  </head>
  <body>
    <nav><a href="/">Home</a> <a href="/archive">Archive</a></nav>
    <main>
      <article>
        <h1>Drive Clipper End-to-End Architecture</h1>
        <p>Normal light-DOM article introduction explaining why clean Markdown extraction and offline image archiving belong together in a Manifest V3 extension.</p>

        <x-shadow-callout id="shadow-callout"></x-shadow-callout>

        <h2>Lazy-Loaded Hero Image</h2>
        <p>The hero below starts with a 1x1 inline SVG placeholder in src and keeps its real WebP asset in data-src.</p>
        <figure>
          <img
            id="lazy-img"
            src="${LAZY_SVG_PLACEHOLDER}"
            data-src="/media/lazy-hero.webp"
            alt="Lazy Architecture Hero"
          />
          <figcaption>Lazy-loaded architecture diagram</figcaption>
        </figure>

        <h2>Duplicate Image Deduplication</h2>
        <p>The diagram below appears twice using relative and absolute URLs with a fragment; it must upload only once.</p>
        <p><img src="/media/shared-diagram.png" alt="Shared Diagram First" /></p>
        <p><img src="${baseUrl}/media/shared-diagram.png#second-occurrence" alt="Shared Diagram Second" /></p>

        <h2>Anti-Hotlink Protected Image</h2>
        <p>This image endpoint strictly requires a Referer header containing the article page URL and returns HTTP 403 otherwise.</p>
        <p><img src="/media/protected-hotlink.jpg" alt="Protected Hotlink Photo" /></p>

        <h2>Broken 404 Image Fallback</h2>
        <p>This image returns HTTP 404 and must stay as its original remote URL in Markdown with a YAML frontmatter warning.</p>
        <p><img src="/media/missing-404.png" alt="Missing Asset" /></p>

        <img src="/media/tracker.gif" width="1" height="1" alt="" />
        <img src="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E" alt="Standalone Placeholder" />
      </article>
    </main>
    <footer>Site footer boilerplate</footer>
    <script>
      const host = document.getElementById('shadow-callout');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<style>p { color: crimson; }</style>' +
        '<h2>Shadow DOM Insights</h2>' +
        '<p>Critical architectural note rendered strictly inside an open Shadow DOM root that Defuddle must extract cleanly.</p>';
    </script>
  </body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname === '/media/lazy-hero.webp') {
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': String(VALID_WEBP_BYTES.byteLength),
      });
      res.end(VALID_WEBP_BYTES);
      return;
    }

    if (pathname === '/media/shared-diagram.png') {
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(VALID_PNG_BYTES.byteLength),
      });
      res.end(VALID_PNG_BYTES);
      return;
    }

    if (pathname === '/media/protected-hotlink.jpg') {
      const referer = req.headers.referer;
      const authorized = typeof referer === 'string' && referer.includes(articleUrl);
      if (!authorized) {
        imageRequests.push({ path: pathname, referer, status: 403 });
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden: missing valid Referer');
        return;
      }
      imageRequests.push({ path: pathname, referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(VALID_JPEG_BYTES.byteLength),
      });
      res.end(VALID_JPEG_BYTES);
      return;
    }

    if (pathname === '/media/missing-404.png') {
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 404 });
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    if (pathname === '/media/tracker.gif') {
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': String(TRACKING_PIXEL_GIF_BYTES.byteLength),
      });
      res.end(TRACKING_PIXEL_GIF_BYTES);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Unknown fixture route');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  articleUrl = `${baseUrl}/articles/mv3-clipper-test`;

  return {
    server,
    baseUrl,
    articleUrl,
    imageRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function startMockDriveServer(): Promise<MockDriveServerHandle> {
  let idSeq = 0;
  const files = new Map<string, MockDriveItem>();
  const folderCreations: MockDriveItem[] = [];
  const sourceUrlQueries: string[] = [];
  const uploads: RecordedMultipartUpload[] = [];
  const uploadOrder: string[] = [];

  const createItem = (item: Omit<MockDriveItem, 'id'>): MockDriveItem => {
    idSeq += 1;
    const stored: MockDriveItem = { id: `mock-drive-${idSeq}`, ...item };
    files.set(stored.id, stored);
    return stored;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = (req.method ?? 'GET').toUpperCase();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Missing Bearer token' } }));
      return;
    }

    // GET /drive/v3/files/:id
    if (method === 'GET' && reqUrl.pathname.startsWith('/drive/v3/files/')) {
      const fileId = decodeURIComponent(reqUrl.pathname.slice('/drive/v3/files/'.length));
      const found = files.get(fileId);
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File not found' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: found.id,
          name: found.name,
          mimeType: found.mimeType,
          trashed: found.trashed,
        }),
      );
      return;
    }

    // GET /drive/v3/files?q=...
    if (method === 'GET' && reqUrl.pathname === '/drive/v3/files') {
      const q = reqUrl.searchParams.get('q') ?? '';
      if (q.includes("key='sourceUrl'")) {
        sourceUrlQueries.push(q);
      }

      const parentMatch = /'((?:\\.|[^'])+)' in parents/.exec(q);
      const nameMatch = /name = '((?:\\.|[^'])+)'/.exec(q);
      const sourceUrlMatch =
        /appProperties has \{ key='sourceUrl' and value='((?:\\.|[^'])+)' \}/.exec(q);
      const onlyFolders = q.includes(`mimeType = '${DRIVE_FOLDER_MIME}'`);
      const excludeFolders = q.includes(`mimeType != '${DRIVE_FOLDER_MIME}'`);
      const unescape = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

      const matched = Array.from(files.values()).filter((item) => {
        if (q.includes('trashed = false') && item.trashed) return false;
        if (onlyFolders && item.mimeType !== DRIVE_FOLDER_MIME) return false;
        if (excludeFolders && item.mimeType === DRIVE_FOLDER_MIME) return false;
        if (parentMatch && !item.parents.includes(unescape(parentMatch[1]))) return false;
        if (nameMatch && item.name !== unescape(nameMatch[1])) return false;
        if (
          sourceUrlMatch &&
          item.appProperties.sourceUrl !== unescape(sourceUrlMatch[1])
        ) {
          return false;
        }
        return true;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          files: matched.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            trashed: f.trashed,
          })),
        }),
      );
      return;
    }

    // POST /drive/v3/files (folder creation)
    if (method === 'POST' && reqUrl.pathname === '/drive/v3/files') {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw.toString('utf8')) as {
        name: string;
        mimeType: string;
        parents?: string[];
        appProperties?: Record<string, string>;
      };
      const created = createItem({
        name: payload.name,
        mimeType: payload.mimeType,
        parents: payload.parents ?? [],
        trashed: false,
        appProperties: payload.appProperties ?? {},
      });
      if (created.mimeType === DRIVE_FOLDER_MIME) {
        folderCreations.push(created);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: created.id,
          name: created.name,
          mimeType: created.mimeType,
        }),
      );
      return;
    }

    // POST or PATCH /upload/drive/v3/files(/:id)?uploadType=multipart
    if (
      (method === 'POST' || method === 'PATCH') &&
      reqUrl.pathname.startsWith('/upload/drive/v3/files')
    ) {
      const raw = await readRequestBody(req);
      const parsed = parseMultipartRelated(
        raw,
        String(req.headers['content-type'] ?? ''),
      );
      const isPatch = method === 'PATCH';
      const fileId = isPatch
        ? decodeURIComponent(reqUrl.pathname.slice('/upload/drive/v3/files/'.length))
        : undefined;

      if (isPatch && parsed.metadata.parents !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'The parents field is not directly writable on PATCH' },
          }),
        );
        return;
      }

      const name = String(parsed.metadata.name);
      uploads.push({
        method,
        fileId,
        metadata: parsed.metadata,
        contentType: parsed.contentType,
        contentBytes: parsed.contentBytes,
      });
      uploadOrder.push(name);

      if (isPatch && fileId) {
        const existing = files.get(fileId);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'File not found' } }));
          return;
        }
        existing.name = name;
        existing.mimeType = parsed.contentType;
        existing.content = parsed.contentBytes;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: existing.id,
            name: existing.name,
            mimeType: existing.mimeType,
          }),
        );
        return;
      }

      const created = createItem({
        name,
        mimeType: parsed.contentType,
        parents: (parsed.metadata.parents as string[]) ?? [],
        trashed: false,
        appProperties: {},
        content: parsed.contentBytes,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: created.id,
          name: created.name,
          mimeType: created.mimeType,
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Unhandled ${method} ${reqUrl.pathname}` } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    files,
    folderCreations,
    sourceUrlQueries,
    uploads,
    uploadOrder,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function startStaticDistServer(): Promise<StaticDistServerHandle> {
  const mimeByExt: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const relPath = reqUrl.pathname.replace(/^\/+/, '') || 'harness.html';

    if (relPath === 'harness.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>SW Harness</title></head><body></body></html>');
      return;
    }

    const resolved = path.resolve(DIST_DIR, relPath);
    if (!resolved.startsWith(DIST_DIR) || !existsSync(resolved)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeByExt[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(resolved));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

interface DnrRuleSummary {
  id: number;
  urlFilter?: string;
  tabIds?: number[];
  requestHeaders?: Array<{ header: string; operation: string; value?: string }>;
}

function matchesDnrUrlFilter(url: string, urlFilter: string | undefined): boolean {
  if (!urlFilter) {
    return true;
  }
  if (urlFilter.startsWith('|')) {
    return url.startsWith(urlFilter.slice(1));
  }
  return url.includes(urlFilter);
}

/**
 * Wires real built `dist/background.js` inside a Chromium page with faithful
 * `chrome.*` bridges so Popup, Options, and the real `dist/content.js` on the
 * fixture article page communicate end to end while routing Drive calls to the
 * local mock Drive HTTP server and enforcing DNR Referer rules on real HTTP requests.
 */
async function createExtensionHarness(params: {
  context: BrowserContext;
  distBaseUrl: string;
  fixtureServer: FixtureServerHandle;
  driveServer: MockDriveServerHandle;
}) {
  const { context, distBaseUrl, fixtureServer, driveServer } = params;

  const activeDnrRules = new Map<number, DnrRuleSummary>();
  const dnrUpdateLog: Array<{ addedIds: number[]; removedIds: number[] }> = [];
  const syncStore: Record<string, unknown> = {};
  const localStore: Record<string, unknown> = {};
  const recordedAuthScopes: string[][] = [];
  let signedIn = true;
  let injectedContentCount = 0;

  // 1. Open the real fixture article page in Chromium
  const articlePage = await context.newPage();
  const articleErrors: string[] = [];
  articlePage.on('pageerror', (err) => articleErrors.push(err.message));

  await articlePage.addInitScript(() => {
    const listeners: Array<
      (
        msg: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined
    > = [];
    const w = window as unknown as Record<string, unknown>;
    w.__contentListeners = listeners;
    w.chrome = {
      runtime: {
        onMessage: {
          addListener: (
            fn: (
              msg: unknown,
              sender: unknown,
              sendResponse: (response: unknown) => void,
            ) => boolean | undefined,
          ) => {
            listeners.push(fn);
          },
        },
      },
    };
  });

  await articlePage.goto(fixtureServer.articleUrl, { waitUntil: 'networkidle' });
  // Wait for the lazy <img> SVG placeholder to finish decoding in real Chromium
  await articlePage.waitForFunction(() => {
    const img = document.getElementById('lazy-img') as HTMLImageElement | null;
    return Boolean(img && img.complete && img.naturalWidth > 0);
  });

  // 2. Open the background harness page and route Drive API + DNR image requests
  const swPage = await context.newPage();
  const swErrors: string[] = [];
  const expectedMissingImageUrl = `${fixtureServer.baseUrl}/media/missing-404.png`;
  swPage.on('pageerror', (err) => swErrors.push(err.message));
  swPage.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      const locUrl = msg.location().url;
      // Chromium logs a network-layer console error whenever fetch() gets our intentional 404 fixture.
      if (
        locUrl === expectedMissingImageUrl &&
        text.includes('404')
      ) {
        return;
      }
      swErrors.push(`${text} (${locUrl})`);
    }
  });

  // Forward https://www.googleapis.com/* to our local mock Drive v3 HTTP server verbatim
  await swPage.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      });
      return;
    }

    const origUrl = new URL(req.url());
    const targetUrl = `${driveServer.baseUrl}${origUrl.pathname}${origUrl.search}`;
    const reqHeaders = await req.allHeaders();
    const forwardHeaders: Record<string, string> = {};
    if (reqHeaders.authorization) {
      forwardHeaders.Authorization = reqHeaders.authorization;
    }
    if (reqHeaders['content-type']) {
      forwardHeaders['Content-Type'] = reqHeaders['content-type'];
    }

    const postBuf = req.postDataBuffer();
    const bodyInit = postBuf ? new Uint8Array(postBuf) : undefined;
    const upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body: bodyInit,
    });
    const respBuf = Buffer.from(await upstream.arrayBuffer());
    const respContentType = upstream.headers.get('content-type') ?? 'application/json';

    await route.fulfill({
      status: upstream.status,
      headers: {
        'Content-Type': respContentType,
        'Access-Control-Allow-Origin': '*',
      },
      body: respBuf,
    });
  });

  // Apply active DNR session rules registered by dist/background.js onto fixture image requests
  await swPage.route(`${fixtureServer.baseUrl}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    const reqHeaders = await req.allHeaders();
    const forwardHeaders: Record<string, string> = {};
    if (reqHeaders.accept) {
      forwardHeaders.Accept = reqHeaders.accept;
    }

    // Only apply Referer if dist/background.js registered a matching active DNR rule for tabIds [-1]
    for (const rule of activeDnrRules.values()) {
      if (
        rule.tabIds?.includes(-1) &&
        matchesDnrUrlFilter(url, rule.urlFilter) &&
        rule.requestHeaders
      ) {
        for (const mod of rule.requestHeaders) {
          if (mod.operation === 'set' && mod.value !== undefined) {
            forwardHeaders[mod.header] = mod.value;
          }
        }
      }
    }

    const upstream = await fetch(url, {
      method: req.method(),
      headers: forwardHeaders,
    });
    const respBuf = Buffer.from(await upstream.arrayBuffer());
    const respHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
    };
    const ct = upstream.headers.get('content-type');
    if (ct) respHeaders['Content-Type'] = ct;
    const cl = upstream.headers.get('content-length');
    if (cl) respHeaders['Content-Length'] = cl;

    await route.fulfill({
      status: upstream.status,
      headers: respHeaders,
      body: respBuf,
    });
  });

  const uiPushSubscribers = new Set<Page>();

  await swPage.exposeFunction('__e2eGetAuthToken', (details: { interactive?: boolean; scopes?: string[] }) => {
    if (Array.isArray(details?.scopes)) {
      recordedAuthScopes.push([...details.scopes]);
    }
    if (!signedIn) {
      if (details?.interactive) {
        signedIn = true;
        return { token: 'mock-e2e-access-token' };
      }
      throw new Error('User is signed out');
    }
    return { token: 'mock-e2e-access-token' };
  });

  await swPage.exposeFunction('__e2eClearAuth', () => {
    signedIn = false;
  });

  await swPage.exposeFunction(
    '__e2eDnrUpdateSessionRules',
    (options: { addRules?: DnrRuleSummary[]; removeRuleIds?: number[] }) => {
      const addedIds: number[] = [];
      const removedIds: number[] = [];
      if (options.removeRuleIds) {
        for (const id of options.removeRuleIds) {
          activeDnrRules.delete(id);
          removedIds.push(id);
        }
      }
      if (options.addRules) {
        for (const rule of options.addRules) {
          const cond = (rule as unknown as {
            condition?: { urlFilter?: string; tabIds?: number[] };
            action?: { requestHeaders?: Array<{ header: string; operation: string; value?: string }> };
          });
          activeDnrRules.set(rule.id, {
            id: rule.id,
            urlFilter: cond.condition?.urlFilter,
            tabIds: cond.condition?.tabIds,
            requestHeaders: cond.action?.requestHeaders,
          });
          addedIds.push(rule.id);
        }
      }
      dnrUpdateLog.push({ addedIds, removedIds });
    },
  );

  await swPage.exposeFunction('__e2eStorageGet', (area: 'sync' | 'local', key: string) => {
    const store = area === 'sync' ? syncStore : localStore;
    return key in store ? { [key]: store[key] } : {};
  });

  await swPage.exposeFunction(
    '__e2eStorageSet',
    (area: 'sync' | 'local', items: Record<string, unknown>) => {
      const store = area === 'sync' ? syncStore : localStore;
      Object.assign(store, items);
    },
  );

  await swPage.exposeFunction('__e2eTabsQuery', () => [
    { id: 101, url: articlePage.url(), title: 'Drive Clipper End-to-End Architecture' },
  ]);

  await swPage.exposeFunction('__e2eTabsGet', (tabId: number) => ({
    id: tabId,
    url: articlePage.url(),
    title: 'Drive Clipper End-to-End Architecture',
  }));

  await swPage.exposeFunction(
    '__e2eExecuteScript',
    async (injection: { target: { tabId: number }; files?: string[] }) => {
      for (const file of injection.files ?? []) {
        const scriptPath = path.join(DIST_DIR, file);
        await articlePage.addScriptTag({ path: scriptPath });
        injectedContentCount += 1;
      }
      return [];
    },
  );

  await swPage.exposeFunction(
    '__e2eTabsSendMessage',
    async (_tabId: number, message: unknown) => {
      return articlePage.evaluate((msg) => {
        const listeners = (
          window as unknown as {
            __contentListeners: Array<
              (
                m: unknown,
                sender: unknown,
                cb: (res: unknown) => void,
              ) => boolean | undefined
            >;
          }
        ).__contentListeners;
        return new Promise((resolve, reject) => {
          let handled = false;
          for (const fn of listeners) {
            const keepOpen = fn(msg, {}, (response) => {
              handled = true;
              resolve(response);
            });
            if (keepOpen === true) {
              handled = true;
            }
          }
          if (!handled) {
            reject(new Error('No content script listener handled message'));
          }
        });
      }, message);
    },
  );

  await swPage.exposeFunction('__e2eBroadcastPush', async (message: unknown) => {
    for (const uiPage of uiPushSubscribers) {
      if (!uiPage.isClosed()) {
        await uiPage
          .evaluate((msg) => {
            const dispatch = (
              window as unknown as { __dispatchRuntimePush?: (m: unknown) => void }
            ).__dispatchRuntimePush;
            dispatch?.(msg);
          }, message)
          .catch(() => undefined);
      }
    }
  });

  await swPage.goto(`${distBaseUrl}/harness.html`);
  await swPage.evaluate((clientId) => {
    const w = window as unknown as Record<string, unknown>;
    const swListeners: Array<
      (
        msg: unknown,
        sender: unknown,
        sendResponse: (res: unknown) => void,
      ) => boolean | undefined
    > = [];
    w.__swListeners = swListeners;

    w.chrome = {
      runtime: {
        getManifest: () => ({
          manifest_version: 3,
          name: 'Drive Clipper',
          version: '0.1.0',
          oauth2: {
            client_id: clientId,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
          },
        }),
        onInstalled: { addListener: () => undefined },
        onMessage: {
          addListener: (
            fn: (
              msg: unknown,
              sender: unknown,
              sendResponse: (res: unknown) => void,
            ) => boolean | undefined,
          ) => {
            swListeners.push(fn);
          },
        },
        sendMessage: (msg: unknown) =>
          (w.__e2eBroadcastPush as (m: unknown) => Promise<void>)(msg),
      },
      contextMenus: {
        removeAll: (cb?: () => void) => cb?.(),
        create: () => undefined,
        onClicked: { addListener: () => undefined },
      },
      action: {
        setBadgeText: async () => undefined,
        setBadgeBackgroundColor: async () => undefined,
      },
      identity: {
        getAuthToken: (details: unknown) =>
          (w.__e2eGetAuthToken as (d: unknown) => Promise<unknown>)(details),
        removeCachedAuthToken: async () =>
          (w.__e2eClearAuth as () => Promise<void>)(),
        clearAllCachedAuthTokens: async () =>
          (w.__e2eClearAuth as () => Promise<void>)(),
      },
      declarativeNetRequest: {
        updateSessionRules: (opts: unknown) =>
          (w.__e2eDnrUpdateSessionRules as (o: unknown) => Promise<void>)(opts),
      },
      storage: {
        sync: {
          get: (key: string) =>
            (w.__e2eStorageGet as (a: string, k: string) => Promise<unknown>)('sync', key),
          set: (items: Record<string, unknown>) =>
            (w.__e2eStorageSet as (a: string, i: Record<string, unknown>) => Promise<void>)('sync', items),
        },
        local: {
          get: (key: string) =>
            (w.__e2eStorageGet as (a: string, k: string) => Promise<unknown>)('local', key),
          set: (items: Record<string, unknown>) =>
            (w.__e2eStorageSet as (a: string, i: Record<string, unknown>) => Promise<void>)('local', items),
        },
      },
      tabs: {
        query: () => (w.__e2eTabsQuery as () => Promise<unknown>)(),
        get: (tabId: number) =>
          (w.__e2eTabsGet as (id: number) => Promise<unknown>)(tabId),
        sendMessage: (tabId: number, msg: unknown) =>
          (w.__e2eTabsSendMessage as (id: number, m: unknown) => Promise<unknown>)(tabId, msg),
      },
      scripting: {
        executeScript: (injection: unknown) =>
          (w.__e2eExecuteScript as (inj: unknown) => Promise<unknown>)(injection),
      },
    };
  }, TEST_OAUTH_CLIENT_ID);

  // Load the REAL bundled dist/background.js into Chromium!
  await swPage.addScriptTag({ path: path.join(DIST_DIR, 'background.js') });

  const sendToServiceWorker = async (message: unknown): Promise<unknown> => {
    return swPage.evaluate((msg) => {
      const listeners = (
        window as unknown as {
          __swListeners: Array<
            (
              m: unknown,
              sender: unknown,
              cb: (res: unknown) => void,
            ) => boolean | undefined
          >;
        }
      ).__swListeners;
      return new Promise((resolve, reject) => {
        let handled = false;
        for (const fn of listeners) {
          const keepOpen = fn(msg, {}, (res) => {
            handled = true;
            resolve(res);
          });
          if (keepOpen === true) {
            handled = true;
          }
        }
        if (!handled) {
          reject(new Error(`No service worker listener handled ${JSON.stringify(msg)}`));
        }
      });
    }, message);
  };

  const attachUiChromeBridge = async (uiPage: Page): Promise<void> => {
    uiPushSubscribers.add(uiPage);
    await uiPage.exposeFunction('__e2eUiSendMessage', (msg: unknown) =>
      sendToServiceWorker(msg),
    );
    await uiPage.exposeFunction('__e2eOpenOptions', () => undefined);

    await uiPage.addInitScript((clientId) => {
      const w = window as unknown as Record<string, unknown>;
      const pushListeners: Array<(msg: unknown) => void> = [];
      w.__dispatchRuntimePush = (msg: unknown) => {
        for (const listener of pushListeners) {
          listener(msg);
        }
      };

      w.chrome = {
        runtime: {
          lastError: undefined,
          getManifest: () => ({
            manifest_version: 3,
            name: 'Drive Clipper',
            version: '0.1.0',
            oauth2: {
              client_id: clientId,
              scopes: ['https://www.googleapis.com/auth/drive.file'],
            },
          }),
          sendMessage: (
            msg: unknown,
            cb?: (response: unknown) => void,
          ) => {
            const promise = (
              w.__e2eUiSendMessage as (m: unknown) => Promise<unknown>
            )(msg);
            if (typeof cb === 'function') {
              void promise.then((res) => cb(res));
              return undefined;
            }
            return promise;
          },
          onMessage: {
            addListener: (fn: (msg: unknown) => void) => {
              pushListeners.push(fn);
            },
            removeListener: (fn: (msg: unknown) => void) => {
              const idx = pushListeners.indexOf(fn);
              if (idx >= 0) pushListeners.splice(idx, 1);
            },
          },
          openOptionsPage: () => {
            void (w.__e2eOpenOptions as () => Promise<void>)();
          },
        },
      };
    }, TEST_OAUTH_CLIENT_ID);
  };

  return {
    articlePage,
    articleErrors,
    swPage,
    swErrors,
    activeDnrRules,
    dnrUpdateLog,
    recordedAuthScopes,
    getInjectedContentCount: () => injectedContentCount,
    sendToServiceWorker,
    attachUiChromeBridge,
    async close() {
      for (const p of uiPushSubscribers) {
        if (!p.isClosed()) await p.close();
      }
      if (!swPage.isClosed()) await swPage.close();
      if (!articlePage.isClosed()) await articlePage.close();
    },
  };
}

test.describe('Drive Clipper E2E (real Chromium + built dist/ artifacts)', () => {
  test('validates built dist/manifest.json, entrypoints, minimal drive.file scope, and MV3 CSP/no-remote-scripts', () => {
    const manifestPath = path.join(DIST_DIR, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      manifest_version: number;
      oauth2?: { client_id?: string; scopes?: string[] };
      background?: { service_worker?: string };
      action?: { default_popup?: string; default_icon?: Record<string, string> };
      options_page?: string;
      icons?: Record<string, string>;
      content_security_policy?: { extension_pages?: string };
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.oauth2?.scopes).toEqual([REQUIRED_DRIVE_SCOPE]);
    expect(manifest.content_security_policy?.extension_pages).toBe(
      "script-src 'self'; object-src 'self'",
    );

    const requiredFiles = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      manifest.options_page,
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
      'content.js',
      'popup.js',
      'popup.css',
      'options.js',
      'options.css',
    ].filter((f): f is string => Boolean(f));

    for (const rel of new Set(requiredFiles)) {
      const fullPath = path.join(DIST_DIR, rel);
      expect(existsSync(fullPath), `Missing built artifact dist/${rel}`).toBe(true);
      expect(statSync(fullPath).size, `Empty built artifact dist/${rel}`).toBeGreaterThan(0);
    }

    for (const htmlFile of ['popup.html', 'options.html']) {
      const html = readFileSync(path.join(DIST_DIR, htmlFile), 'utf8');
      // Zero remote <script src="http(s)://..."> or protocol-relative URLs
      expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i);
      // Zero inline <script> bodies
      const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, body] of scripts) {
        expect(body.trim()).toBe('');
      }
    }
  });

  test('executes full bundled clip pipeline via Popup UI, verifies Shadow DOM / lazy / dedup / anti-hotlink Referer / 404 fallback / upload order / idempotent re-clip, and renders Popup + Options UI cleanly', async ({
    browser,
  }) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const fixtureServer = await startFixtureServer();
    const driveServer = await startMockDriveServer();
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    try {
      // Negative control: confirm anti-hotlink endpoint strictly rejects requests without Referer
      const directHotlinkResp = await fetch(
        `${fixtureServer.baseUrl}/media/protected-hotlink.jpg`,
      );
      expect(directHotlinkResp.status).toBe(403);

      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
      });

      // 1. Render built dist/popup.html in a 360px viewport wired to live dist/background.js
      const popupPage = await context.newPage();
      await popupPage.setViewportSize({ width: 360, height: 640 });
      const popupConsoleErrors: string[] = [];
      const popupPageErrors: string[] = [];
      popupPage.on('console', (msg) => {
        if (msg.type() === 'error') popupConsoleErrors.push(msg.text());
      });
      popupPage.on('pageerror', (err) => popupPageErrors.push(err.message));

      await harness.attachUiChromeBridge(popupPage);
      await popupPage.goto(`${distServer.baseUrl}/popup.html`, {
        waitUntil: 'networkidle',
      });

      await expect(popupPage.locator('#title-input')).toHaveValue(
        'Drive Clipper End-to-End Architecture',
      );
      await expect(popupPage.locator('#auth-pill-label')).toHaveText('Connected');
      await expect(popupPage.locator('#folder-preview')).toContainText(
        '-drive-clipper-end-to-end-architecture',
      );
      await expect(popupPage.locator('#clip-submit-btn')).toBeEnabled();

      // Verify clean 360px popup layout (no horizontal overflow)
      const popupOverflow = await popupPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(popupOverflow).toBeLessThanOrEqual(0);

      // Clear initial page-load image hits so imageRequests tracks only extension background fetches
      fixtureServer.imageRequests.length = 0;

      // 2. Click "Clip to Google Drive" to run the REAL bundled pipeline end to end!
      await popupPage.locator('#clip-submit-btn').click();
      await expect(popupPage.locator('#progress-status-label')).toHaveText('Saved', {
        timeout: 20_000,
      });

      // Verify UI displays Drive link, 1 warning (for the broken 404 image), and updated history
      const driveHref = await popupPage.locator('#result-drive-link').getAttribute('href');
      expect(driveHref).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\/mock-drive-\d+$/);
      await expect(popupPage.locator('#warnings-details')).toBeVisible();
      await expect(popupPage.locator('#warnings-summary')).toContainText('1 warning');
      await expect(popupPage.locator('#recent-clips-count')).toHaveText('1');

      // Open warnings and recent clips for an informative Popup screenshot
      await popupPage.locator('#warnings-summary').click();
      await popupPage.locator('.recent-clips-summary').click();
      await expect(popupPage.locator('#warnings-list li')).toHaveCount(1);
      await expect(popupPage.locator('#recent-clips-list .recent-clip-item')).toHaveCount(1);

      const popupScreenshotPath = path.join(SCREENSHOT_DIR, 'popup-ui.png');
      await popupPage.screenshot({ path: popupScreenshotPath, fullPage: true });

      // 3. Assert all E2E pipeline invariants on the first clip
      expect(harness.getInjectedContentCount()).toBeGreaterThanOrEqual(2);
      expect(harness.recordedAuthScopes.length).toBeGreaterThan(0);
      for (const scopes of harness.recordedAuthScopes) {
        expect(scopes).toEqual([REQUIRED_DRIVE_SCOPE]);
      }

      // DNR Referer rules were added during fetch and completely removed afterwards
      expect(harness.dnrUpdateLog.some((e) => e.addedIds.length > 0)).toBe(true);
      expect(harness.dnrUpdateLog.some((e) => e.removedIds.length > 0)).toBe(true);
      expect(harness.activeDnrRules.size).toBe(0);

      // Anti-hotlink image was fetched with Referer containing articleUrl and succeeded with 200
      const hotlinkHits = fixtureServer.imageRequests.filter(
        (r) => r.path === '/media/protected-hotlink.jpg' && r.status === 200,
      );
      expect(hotlinkHits).toHaveLength(1);
      expect(hotlinkHits[0].referer).toContain(fixtureServer.articleUrl);

      // Duplicate image was requested and uploaded ONLY ONCE
      const dupImageHits = fixtureServer.imageRequests.filter(
        (r) => r.path === '/media/shared-diagram.png' && r.status === 200,
      );
      expect(dupImageHits).toHaveLength(1);

      // Tracking pixel was stripped and never requested by image fetcher
      const trackerHits = fixtureServer.imageRequests.filter(
        (r) => r.path === '/media/tracker.gif',
      );
      expect(trackerHits).toHaveLength(0);

      // Folder creations: WebClips root + article folder + images subfolder
      expect(driveServer.folderCreations.map((f) => f.name)).toEqual([
        'WebClips',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}-drive-clipper-end-to-end-architecture$/),
        'images',
      ]);
      expect(driveServer.sourceUrlQueries.length).toBe(1);

      // Exact upload order: 3 valid images (lazy .webp, duplicate .png once, anti-hotlink .jpg) BEFORE README.md
      expect(driveServer.uploadOrder).toHaveLength(4);
      expect(driveServer.uploadOrder[3]).toBe('README.md');
      const uploadedImageNames = driveServer.uploadOrder.slice(0, 3);
      expect(uploadedImageNames).not.toContain('README.md');
      expect(uploadedImageNames.some((n) => n.endsWith('.webp'))).toBe(true);
      expect(uploadedImageNames.some((n) => n.endsWith('.png'))).toBe(true);
      expect(uploadedImageNames.some((n) => n.endsWith('.jpg'))).toBe(true);

      // Verify uploaded binary payloads preserved original formats (no PNG re-encoding)
      const webpUpload = driveServer.uploads.find((u) =>
        String(u.metadata.name).endsWith('.webp'),
      )!;
      expect(webpUpload.contentType).toBe('image/webp');
      expect(webpUpload.contentBytes.equals(VALID_WEBP_BYTES)).toBe(true);

      const jpgUpload = driveServer.uploads.find((u) =>
        String(u.metadata.name).endsWith('.jpg'),
      )!;
      expect(jpgUpload.contentType).toBe('image/jpeg');
      expect(jpgUpload.contentBytes.equals(VALID_JPEG_BYTES)).toBe(true);

      const pngUpload = driveServer.uploads.find((u) =>
        String(u.metadata.name).endsWith('.png'),
      )!;
      expect(pngUpload.contentType).toBe('image/png');
      expect(pngUpload.contentBytes.equals(VALID_PNG_BYTES)).toBe(true);

      // Verify README.md content: frontmatter, Shadow DOM content, rewritten relative links, deduplicated refs, 404 graceful fallback
      const readmeUpload = driveServer.uploads.find((u) => u.metadata.name === 'README.md')!;
      const readmeText = readmeUpload.contentBytes.toString('utf8');

      // Normal + Shadow DOM content extracted cleanly; shadow <style> stripped
      expect(readmeText).toContain('Normal light-DOM article introduction');
      expect(readmeText).toContain('Critical architectural note rendered strictly inside an open Shadow DOM root');
      expect(readmeText).not.toContain('color: crimson');

      // Lazy image resolved & rewritten
      const webpFilename = String(webpUpload.metadata.name);
      expect(readmeText).toContain(`./images/${webpFilename}`);
      expect(readmeText).not.toContain('data:image/svg+xml');

      // Duplicate image rewritten at BOTH occurrences to the single uploaded filename
      const pngFilename = String(pngUpload.metadata.name);
      const dupRewrittenMatches = readmeText.match(
        new RegExp(`!\\[[^\\]]*\\]\\(\\./images/${pngFilename.replace('.', '\\.')}\\)`, 'g'),
      );
      expect(dupRewrittenMatches?.length).toBe(2);

      // Anti-hotlink image rewritten
      const jpgFilename = String(jpgUpload.metadata.name);
      expect(readmeText).toContain(`./images/${jpgFilename}`);

      // Broken 404 image keeps original remote URL + YAML frontmatter warning
      expect(readmeText).toContain(`${fixtureServer.baseUrl}/media/missing-404.png`);
      expect(readmeText).toContain('warnings:');
      expect(readmeText).toContain('HTTP 404');

      // 4. Re-clip the EXACT same URL and verify folder reuse (idempotency via appProperties.sourceUrl)
      const firstFolderCount = driveServer.folderCreations.length;
      const firstUploadCount = driveServer.uploads.length;
      const firstArticleFolderId = driveServer.folderCreations[1].id;

      await popupPage.locator('#clip-submit-btn').click();
      await expect(popupPage.locator('#progress-badge')).toHaveText('Updated', {
        timeout: 20_000,
      });

      expect(driveServer.sourceUrlQueries.length).toBe(2);
      // Zero new folders created on re-clip!
      expect(driveServer.folderCreations.length).toBe(firstFolderCount);
      const secondRunUploads = driveServer.uploads.slice(firstUploadCount);
      expect(secondRunUploads).toHaveLength(4);
      // All 4 second-run uploads must PATCH existing files in place, with README.md strictly last
      expect(secondRunUploads.every((u) => u.method === 'PATCH')).toBe(true);
      expect(secondRunUploads[3].metadata.name).toBe('README.md');
      const updatedHref = await popupPage.locator('#result-drive-link').getAttribute('href');
      expect(updatedHref).toBe(`https://drive.google.com/drive/folders/${firstArticleFolderId}`);
      expect(harness.activeDnrRules.size).toBe(0);

      // 5. Render built dist/options.html in a 900px viewport wired to the SAME live dist/background.js
      const optionsPage = await context.newPage();
      await optionsPage.setViewportSize({ width: 900, height: 960 });
      const optionsConsoleErrors: string[] = [];
      const optionsPageErrors: string[] = [];
      optionsPage.on('console', (msg) => {
        if (msg.type() === 'error') optionsConsoleErrors.push(msg.text());
      });
      optionsPage.on('pageerror', (err) => optionsPageErrors.push(err.message));

      await harness.attachUiChromeBridge(optionsPage);
      await optionsPage.goto(`${distServer.baseUrl}/options.html`, {
        waitUntil: 'networkidle',
      });

      const rootFolderId = driveServer.folderCreations[0].id;
      await expect(optionsPage.locator('#auth-status-text')).toHaveText('Connected');
      await expect(optionsPage.locator('#root-folder-id-value')).toHaveText(rootFolderId);
      await expect(optionsPage.locator('#open-root-folder-link')).toBeVisible();
      await expect(optionsPage.locator('#open-root-folder-link')).toHaveAttribute(
        'href',
        `https://drive.google.com/drive/folders/${rootFolderId}`,
      );
      await expect(optionsPage.locator('#drive-file-note')).toContainText('drive.file');

      // Verify clean 900px options layout (no horizontal overflow)
      const optionsOverflow = await optionsPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(optionsOverflow).toBeLessThanOrEqual(0);

      // Verify interactive preference persistence in Options UI
      await optionsPage.locator('#default-tags-input').fill('engineering');
      await optionsPage.locator('#default-tags-input').press('Enter');
      await optionsPage.locator('#save-preferences-btn').click();
      await expect(optionsPage.locator('#preferences-feedback')).toHaveText('Preferences saved.');

      const optionsScreenshotPath = path.join(SCREENSHOT_DIR, 'options-ui.png');
      await optionsPage.screenshot({ path: optionsScreenshotPath, fullPage: true });

      // Assert zero console/page errors across all Chromium pages
      expect(popupConsoleErrors).toEqual([]);
      expect(popupPageErrors).toEqual([]);
      expect(optionsConsoleErrors).toEqual([]);
      expect(optionsPageErrors).toEqual([]);
      expect(harness.swErrors).toEqual([]);
      expect(harness.articleErrors).toEqual([]);

      await harness.close();
    } finally {
      await context.close();
      await Promise.all([
        fixtureServer.close(),
        driveServer.close(),
        distServer.close(),
      ]);
    }
  });
});
