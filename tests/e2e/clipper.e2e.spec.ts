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
const MULTIPART_THRESHOLD_BYTES = Math.floor(4.5 * 1024 * 1024);

// Minimal valid 2x2 PNG (not 1x1 so Chromium never misclassifies it as a tracking pixel)
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8AARAwMDAwAAwAB/wE+3gAAAABJRU5ErkJggg==',
  'base64',
);

// > 4.5 MiB valid PNG payload (header + padding) to exercise Drive uploadType=resumable
const LARGE_RESUMABLE_PNG_BYTES = (() => {
  const buf = Buffer.alloc(MULTIPART_THRESHOLD_BYTES + 8_192, 0x2a);
  VALID_PNG_BYTES.copy(buf, 0);
  buf[buf.byteLength - 1] = 0x7e;
  return buf;
})();

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

interface RecordedUpload {
  method: 'POST' | 'PATCH';
  uploadType: 'multipart' | 'resumable';
  fileId?: string;
  metadata: Record<string, unknown>;
  contentType: string;
  contentBytes: Buffer;
  declaredContentLength?: number;
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

interface ResumableSession {
  method: 'POST' | 'PATCH';
  fileId?: string;
  metadata: Record<string, unknown>;
  contentType: string;
  declaredContentLength: number;
}

interface MockDriveServerOptions {
  failUploadNames?: Record<string, { status: number; message: string }>;
  beforeUpload?: (name: string) => Promise<void>;
}

interface MockDriveServerHandle {
  server: Server;
  baseUrl: string;
  files: Map<string, MockDriveItem>;
  folderCreations: MockDriveItem[];
  sourceUrlQueries: string[];
  uploads: RecordedUpload[];
  uploadOrder: string[];
  close(): Promise<void>;
}

interface FixtureServerOptions {
  beforeImageResponse?: (pathname: string) => Promise<void>;
}

interface FixtureServerHandle {
  server: Server;
  baseUrl: string;
  articleUrl: string;
  imageRequests: Array<{ path: string; referer: string | undefined; status: number }>;
  state: {
    shiftFirstImageStatus: number;
    shiftArticleVariant: 'run1' | 'run2-recovered' | 'run3-prepended';
  };
  close(): Promise<void>;
}

interface StaticDistServerHandle {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

interface DeferredGate {
  promise: Promise<void>;
  release(): void;
  readonly released: boolean;
}

function createGate(): DeferredGate {
  let resolveFn!: () => void;
  let released = false;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    release() {
      if (!released) {
        released = true;
        resolveFn();
      }
    },
    get released() {
      return released;
    },
  };
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

async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServerHandle> {
  const imageRequests: Array<{ path: string; referer: string | undefined; status: number }> = [];
  const state: FixtureServerHandle['state'] = {
    shiftFirstImageStatus: 500,
    shiftArticleVariant: 'run1',
  };
  let baseUrl = '';
  let articleUrl = '';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

    if (pathname === '/articles/zhihu-unread') {
      const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>(20 封私信 / 17 条消息) 华硕 ProArt 显示器色彩评测</title>
    <meta name="author" content="硬件评测室" />
    <meta property="og:site_name" content="知乎" />
  </head>
  <body>
    <main>
      <article>
        <h1>(20 封私信 / 17 条消息) 华硕 ProArt 显示器色彩评测</h1>
        <p>这篇文章实测了华硕 ProArt 专业显示器的色准表现、均匀度与接口配置，并验证知乎未读前缀在标题和目录名中的自动清理逻辑。</p>
      </article>
    </main>
  </body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname === '/articles/year-2026') {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>(2026) Annual Systems Architecture Report</title>
    <meta name="author" content="Systems Team" />
  </head>
  <body>
    <main>
      <article>
        <h1>(2026) Annual Systems Architecture Report</h1>
        <p>This report reviews distributed systems reliability benchmarks from 2026 and ensures legitimate four-digit year prefixes stay intact in both the Markdown title and Drive folder name.</p>
      </article>
    </main>
  </body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Multi-tab queue articles on the SAME origin (each requiring its own distinct Referer!)
    const queueMatch = /^\/articles\/queue-(\d+)$/.exec(pathname);
    if (queueMatch) {
      const idx = Number(queueMatch[1]);
      const titles: Record<number, string> = {
        1: '(20 封私信 / 17 条消息) 华硕 ProArt 桌面工作站配置笔记',
        2: '(3) High-Res Resumable Media Architecture',
        3: 'Resilient Drive Upload Fallback Guide',
        4: 'Concurrent DNR Referer Isolation Deep Dive',
        5: '(2026) Queue Scheduling Backpressure Design',
        6: 'Unclipped Sixth Tab Ready for Submission',
      };
      const extraBody: Record<number, string> = {
        1: `<p><img src="/media/queue-1-protected.jpg" alt="Tab 1 Protected" /></p>
            <p><img src="/media/missing-404.png" alt="Tab 1 Missing 404" /></p>`,
        2: `<p><img src="/media/queue-2-protected.jpg" alt="Tab 2 Protected" /></p>
            <p><img src="/media/queue-2-large.png" alt="Tab 2 Large Resumable PNG" /></p>`,
        3: `<p><img src="/media/queue-3-protected.jpg" alt="Tab 3 Protected" /></p>
            <p><img src="/media/queue-3-upload-fail.png" alt="Tab 3 Drive Upload Failure" /></p>`,
        4: `<p><img src="/media/queue-4-protected.jpg" alt="Tab 4 Protected" /></p>`,
        5: `<p><img src="/media/queue-5-protected.jpg" alt="Tab 5 Protected" /></p>`,
        6: `<p>Fresh tab not yet in the active clip queue.</p>`,
      };
      const title = titles[idx] ?? `Queue Tab ${idx}`;
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    <main>
      <article>
        <h1>${title}</h1>
        <p>Multi-tab queue article #${idx} verifying concurrent background execution, single root folder creation, non-colliding DNR rules, and live Popup process list rendering.</p>
        ${extraBody[idx] ?? ''}
      </article>
    </main>
  </body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Shift-proof filename + prepended-image collision fixture
    if (pathname === '/articles/shift-proof') {
      let bodyImages = '';
      if (state.shiftArticleVariant === 'run3-prepended') {
        bodyImages = `
          <p><img src="/media/prepend/photo.png" alt="Prepended Photo" /></p>
          <p><img src="/media/first/photo.png" alt="Original First Photo" /></p>
          <p><img src="/media/second/diagram.png" alt="Original Second Diagram" /></p>`;
      } else {
        bodyImages = `
          <p><img src="/media/first/photo.png" alt="Original First Photo" /></p>
          <p><img src="/media/second/diagram.png" alt="Original Second Diagram" /></p>`;
      }
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Shift Proof Image Filenames</title>
  </head>
  <body>
    <main>
      <article>
        <h1>Shift Proof Image Filenames</h1>
        <p>Verifies that image download failures and prepended images never shift filenames into duplicate Drive files or PATCH collisions.</p>
        ${bodyImages}
      </article>
    </main>
  </body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname.startsWith('/media/')) {
      await options.beforeImageResponse?.(pathname);
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

    const queueProtectedMatch = /^\/media\/queue-(\d+)-protected\.jpg$/.exec(pathname);
    if (queueProtectedMatch) {
      const idx = queueProtectedMatch[1];
      const expectedArticleUrl = `${baseUrl}/articles/queue-${idx}`;
      const referer = req.headers.referer;
      const authorized = referer === expectedArticleUrl;
      if (!authorized) {
        imageRequests.push({ path: pathname, referer, status: 403 });
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Forbidden: expected Referer ${expectedArticleUrl}, got ${referer ?? 'none'}`);
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

    if (pathname === '/media/queue-2-large.png') {
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(LARGE_RESUMABLE_PNG_BYTES.byteLength),
      });
      res.end(LARGE_RESUMABLE_PNG_BYTES);
      return;
    }

    if (pathname === '/media/queue-3-upload-fail.png') {
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(VALID_PNG_BYTES.byteLength),
      });
      res.end(VALID_PNG_BYTES);
      return;
    }

    if (pathname === '/media/first/photo.png') {
      if (state.shiftFirstImageStatus !== 200) {
        imageRequests.push({
          path: pathname,
          referer: req.headers.referer,
          status: state.shiftFirstImageStatus,
        });
        res.writeHead(state.shiftFirstImageStatus, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('Temporary upstream error');
        return;
      }
      const payload = Buffer.concat([VALID_PNG_BYTES, Buffer.from('FIRST')]);
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(payload.byteLength),
      });
      res.end(payload);
      return;
    }

    if (pathname === '/media/second/diagram.png') {
      const payload = Buffer.concat([VALID_PNG_BYTES, Buffer.from('SECOND')]);
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(payload.byteLength),
      });
      res.end(payload);
      return;
    }

    if (pathname === '/media/prepend/photo.png') {
      const payload = Buffer.concat([VALID_PNG_BYTES, Buffer.from('PREPENDED')]);
      imageRequests.push({ path: pathname, referer: req.headers.referer, status: 200 });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(payload.byteLength),
      });
      res.end(payload);
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
    state,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function startMockDriveServer(
  options: MockDriveServerOptions = {},
): Promise<MockDriveServerHandle> {
  let idSeq = 0;
  let resumableSeq = 0;
  const files = new Map<string, MockDriveItem>();
  const folderCreations: MockDriveItem[] = [];
  const sourceUrlQueries: string[] = [];
  const uploads: RecordedUpload[] = [];
  const uploadOrder: string[] = [];
  const resumableSessions = new Map<string, ResumableSession>();

  const createItem = (item: Omit<MockDriveItem, 'id'>): MockDriveItem => {
    idSeq += 1;
    const stored: MockDriveItem = { id: `mock-drive-${idSeq}`, ...item };
    files.set(stored.id, stored);
    return stored;
  };

  const finalizeUpload = (params: {
    method: 'POST' | 'PATCH';
    uploadType: 'multipart' | 'resumable';
    fileId?: string;
    metadata: Record<string, unknown>;
    contentType: string;
    contentBytes: Buffer;
    declaredContentLength?: number;
    res: ServerResponse;
  }): void => {
    const { method, uploadType, fileId, metadata, contentType, contentBytes, res } = params;
    const isPatch = method === 'PATCH';

    if (isPatch && metadata.parents !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'The parents field is not directly writable on PATCH' },
        }),
      );
      return;
    }

    const name = String(metadata.name);
    const configuredFail = options.failUploadNames?.[name];
    if (configuredFail) {
      res.writeHead(configuredFail.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: configuredFail.message } }));
      return;
    }

    uploads.push({
      method,
      uploadType,
      fileId,
      metadata,
      contentType,
      contentBytes,
      ...(params.declaredContentLength !== undefined
        ? { declaredContentLength: params.declaredContentLength }
        : {}),
    });
    uploadOrder.push(name);

    const incomingProps =
      metadata.appProperties && typeof metadata.appProperties === 'object'
        ? (metadata.appProperties as Record<string, string>)
        : {};

    if (isPatch && fileId) {
      const existing = files.get(fileId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File not found' } }));
        return;
      }
      existing.name = name;
      existing.mimeType = contentType;
      existing.content = contentBytes;
      existing.appProperties = { ...existing.appProperties, ...incomingProps };
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
      mimeType: contentType,
      parents: (metadata.parents as string[]) ?? [],
      trashed: false,
      appProperties: { ...incomingProps },
      content: contentBytes,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: created.id,
        name: created.name,
        mimeType: created.mimeType,
      }),
    );
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

    // GET /drive/v3/files/:id (metadata or ?alt=media raw bytes)
    if (method === 'GET' && reqUrl.pathname.startsWith('/drive/v3/files/')) {
      const fileId = decodeURIComponent(reqUrl.pathname.slice('/drive/v3/files/'.length));
      const found = files.get(fileId);
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File not found' } }));
        return;
      }
      if (reqUrl.searchParams.get('alt') === 'media') {
        res.writeHead(200, {
          'Content-Type': found.mimeType || 'application/octet-stream',
        });
        res.end(found.content ?? Buffer.alloc(0));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: found.id,
          name: found.name,
          mimeType: found.mimeType,
          trashed: found.trashed,
          appProperties: found.appProperties,
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
            appProperties: f.appProperties,
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

    // PUT /upload/drive/v3/files?uploadType=resumable&upload_id=... (Step 2 of resumable upload)
    if (
      method === 'PUT' &&
      reqUrl.pathname.startsWith('/upload/drive/v3/files') &&
      reqUrl.searchParams.get('uploadType') === 'resumable'
    ) {
      const uploadId = reqUrl.searchParams.get('upload_id') ?? '';
      const session = resumableSessions.get(uploadId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unknown resumable upload_id' } }));
        return;
      }
      resumableSessions.delete(uploadId);
      const raw = await readRequestBody(req);
      const fileName = String(session.metadata.name ?? '');
      await options.beforeUpload?.(fileName);
      finalizeUpload({
        method: session.method,
        uploadType: 'resumable',
        fileId: session.fileId,
        metadata: session.metadata,
        contentType: String(req.headers['content-type'] ?? session.contentType),
        contentBytes: raw,
        declaredContentLength: session.declaredContentLength,
        res,
      });
      return;
    }

    // POST or PATCH /upload/drive/v3/files(/:id)?uploadType=resumable (Step 1 initiation)
    if (
      (method === 'POST' || method === 'PATCH') &&
      reqUrl.pathname.startsWith('/upload/drive/v3/files') &&
      reqUrl.searchParams.get('uploadType') === 'resumable'
    ) {
      const raw = await readRequestBody(req);
      const metadata = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      const isPatch = method === 'PATCH';
      const fileId = isPatch
        ? decodeURIComponent(reqUrl.pathname.slice('/upload/drive/v3/files/'.length))
        : undefined;

      if (isPatch && metadata.parents !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'The parents field is not directly writable on PATCH' },
          }),
        );
        return;
      }

      const contentType = String(req.headers['x-upload-content-type'] ?? 'application/octet-stream');
      const declaredContentLength = Number(req.headers['x-upload-content-length'] ?? 0);

      resumableSeq += 1;
      const uploadId = `resumable-${resumableSeq}`;
      resumableSessions.set(uploadId, {
        method,
        fileId,
        metadata,
        contentType,
        declaredContentLength,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
      });
      res.end('');
      return;
    }

    // POST or PATCH /upload/drive/v3/files(/:id)?uploadType=multipart
    if (
      (method === 'POST' || method === 'PATCH') &&
      reqUrl.pathname.startsWith('/upload/drive/v3/files')
    ) {
      const raw = await readRequestBody(req);
      if (raw.byteLength > 5 * 1024 * 1024) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Multipart upload exceeds Google Drive 5 MB limit' },
          }),
        );
        return;
      }
      const parsed = parseMultipartRelated(
        raw,
        String(req.headers['content-type'] ?? ''),
      );
      const isPatch = method === 'PATCH';
      const fileId = isPatch
        ? decodeURIComponent(reqUrl.pathname.slice('/upload/drive/v3/files/'.length))
        : undefined;

      const fileName = String(parsed.metadata.name ?? '');
      await options.beforeUpload?.(fileName);

      finalizeUpload({
        method,
        uploadType: 'multipart',
        fileId,
        metadata: parsed.metadata,
        contentType: parsed.contentType,
        contentBytes: parsed.contentBytes,
        res,
      });
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
  priority: number;
  urlFilter?: string;
  regexFilter?: string;
  tabIds?: number[];
  actionType?: string;
  requestHeaders?: Array<{ header: string; operation: string; value?: string }>;
}

function matchesDnrRule(url: string, rule: DnrRuleSummary): boolean {
  if (!rule.tabIds?.includes(-1)) {
    return false;
  }
  if (rule.regexFilter) {
    return new RegExp(rule.regexFilter).test(url);
  }
  if (!rule.urlFilter) {
    return true;
  }
  let filter = rule.urlFilter;
  const anchorStart = filter.startsWith('|');
  if (anchorStart) {
    filter = filter.slice(1);
  }
  const anchorEnd = filter.endsWith('|');
  if (anchorEnd) {
    filter = filter.slice(0, -1);
  }
  if (anchorStart && anchorEnd) {
    return url === filter;
  }
  if (anchorStart) {
    return url.startsWith(filter);
  }
  if (anchorEnd) {
    return url.endsWith(filter);
  }
  return url.includes(filter);
}

interface RegisteredTabEntry {
  tabId: number;
  page: Page;
  errors: string[];
}

/**
 * Wires real built `dist/background.js` inside a Chromium page with faithful
 * multi-tab `chrome.*` bridges (`storage.sync/local/session`, `tabs`, `scripting`,
 * `declarativeNetRequest`, `action`, `identity`, `runtime`) so Popup, Options,
 * and real `dist/content.js` tabs communicate end to end.
 */
async function createExtensionHarness(params: {
  context: BrowserContext;
  distBaseUrl: string;
  fixtureServer: FixtureServerHandle;
  driveServer: MockDriveServerHandle;
  initialTabs?: Array<{ tabId: number; url: string }>;
  ignoredConsoleUrls?: string[];
  initialSessionStore?: Record<string, unknown>;
  initialSignedIn?: boolean;
}) {
  const { context, distBaseUrl, fixtureServer, driveServer } = params;

  const activeDnrRules = new Map<number, DnrRuleSummary>();
  const dnrUpdateLog: Array<{ addedIds: number[]; removedIds: number[] }> = [];
  const dnrRuleIdCollisions: number[] = [];
  const syncStore: Record<string, unknown> = {};
  const localStore: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {
    ...(params.initialSessionStore ?? {}),
  };
  const recordedAuthScopes: string[][] = [];
  const recordedGetAuthTokenCalls: Array<{
    interactive?: boolean;
    scopes?: string[];
  }> = [];
  const recordedWebAuthFlowCalls: Array<{
    url: string;
    interactive?: boolean;
    clientId: string | null;
    scope: string | null;
    redirectUri: string | null;
    state: string | null;
  }> = [];
  const badgeUpdates: Array<{ text: string; color?: string }> = [];
  let keepalivePings = 0;
  let signedIn = params.initialSignedIn ?? true;
  let injectedContentCount = 0;
  let activeTabId = 101;
  const tabsById = new Map<number, RegisteredTabEntry>();

  const openArticleTab = async (tabId: number, url: string): Promise<Page> => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.addInitScript(() => {
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

    await page.goto(url, { waitUntil: 'networkidle' });
    tabsById.set(tabId, { tabId, page, errors });
    return page;
  };

  const tabSpecs = params.initialTabs ?? [{ tabId: 101, url: fixtureServer.articleUrl }];
  for (const spec of tabSpecs) {
    await openArticleTab(spec.tabId, spec.url);
  }
  activeTabId = tabSpecs[0].tabId;

  const firstArticlePage = tabsById.get(activeTabId)!.page;
  if (tabSpecs[0].url === fixtureServer.articleUrl) {
    await firstArticlePage.waitForFunction(() => {
      const img = document.getElementById('lazy-img') as HTMLImageElement | null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });
  }

  // Open the background harness page and route Drive API + DNR image requests
  const swPage = await context.newPage();
  const swErrors: string[] = [];
  const expectedMissingImageUrls = new Set([
    `${fixtureServer.baseUrl}/media/missing-404.png`,
    ...(params.ignoredConsoleUrls ?? []),
  ]);
  swPage.on('pageerror', (err) => swErrors.push(err.message));
  swPage.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      const locUrl = msg.location().url;
      if (
        expectedMissingImageUrls.has(locUrl) ||
        (locUrl.includes('/upload/drive/v3/files') && text.includes('400'))
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
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, X-Upload-Content-Type, X-Upload-Content-Length',
          'Access-Control-Expose-Headers': 'Location',
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
    if (reqHeaders['x-upload-content-type']) {
      forwardHeaders['X-Upload-Content-Type'] = reqHeaders['x-upload-content-type'];
    }
    if (reqHeaders['x-upload-content-length']) {
      forwardHeaders['X-Upload-Content-Length'] = reqHeaders['x-upload-content-length'];
    }

    const postBuf = req.postDataBuffer();
    const bodyInit = postBuf ? new Uint8Array(postBuf) : undefined;
    const upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body: bodyInit,
    });
    const respBuf = Buffer.from(await upstream.arrayBuffer());
    const respHeaders: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Location',
    };
    const location = upstream.headers.get('location');
    if (location) {
      respHeaders.Location = location;
    }

    await route.fulfill({
      status: upstream.status,
      headers: respHeaders,
      body: respBuf,
    });
  });

  // Intercept Google OAuth2 token revocation requests locally during sign-out tests
  await swPage.route('https://oauth2.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: '{}',
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

    const matchingRules = Array.from(activeDnrRules.values())
      .filter((rule) => matchesDnrRule(url, rule) && Boolean(rule.requestHeaders))
      .sort((a, b) => a.priority - b.priority);

    for (const rule of matchingRules) {
      for (const mod of rule.requestHeaders ?? []) {
        if (mod.operation === 'set' && mod.value !== undefined) {
          forwardHeaders[mod.header] = mod.value;
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

  await swPage.exposeFunction(
    '__e2eGetAuthToken',
    (details: { interactive?: boolean; scopes?: string[] }) => {
      recordedGetAuthTokenCalls.push({
        interactive: details?.interactive,
        scopes: Array.isArray(details?.scopes) ? [...details.scopes] : undefined,
      });
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
    },
  );

  await swPage.exposeFunction(
    '__e2eLaunchWebAuthFlow',
    (details: { url: string; interactive?: boolean }) => {
      const parsed = new URL(details.url);
      const clientId = parsed.searchParams.get('client_id');
      const scope = parsed.searchParams.get('scope');
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      recordedWebAuthFlowCalls.push({
        url: details.url,
        interactive: details.interactive,
        clientId,
        scope,
        redirectUri,
        state,
      });
      if (scope) {
        recordedAuthScopes.push(scope.split(/\s+/).filter(Boolean));
      }
      if (!details.interactive) {
        throw new Error('User interaction required');
      }
      const callbackBase =
        redirectUri ?? 'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org';
      return `${callbackBase}#access_token=mock-e2e-web-auth-token&expires_in=3600&state=${encodeURIComponent(state ?? '')}`;
    },
  );

  await swPage.exposeFunction('__e2eClearAuth', () => {
    signedIn = false;
  });

  await swPage.exposeFunction('__e2eGetPlatformInfo', () => {
    keepalivePings += 1;
    return { os: 'mac', arch: 'arm64', nacl_arch: 'arm' };
  });

  await swPage.exposeFunction('__e2eSetBadgeText', (details: { text: string }) => {
    badgeUpdates.push({ text: details.text });
  });

  await swPage.exposeFunction(
    '__e2eSetBadgeBgColor',
    (details: { color: string }) => {
      const latest = badgeUpdates[badgeUpdates.length - 1];
      if (latest) {
        latest.color = details.color;
      }
    },
  );

  await swPage.exposeFunction('__e2eDnrGetSessionRules', () => {
    return Array.from(activeDnrRules.values()).map((r) => ({
      id: r.id,
      priority: r.priority,
      action: {
        type: r.actionType ?? 'modifyHeaders',
        requestHeaders: r.requestHeaders ?? [],
      },
      condition: {
        ...(r.urlFilter !== undefined ? { urlFilter: r.urlFilter } : {}),
        ...(r.regexFilter !== undefined ? { regexFilter: r.regexFilter } : {}),
        tabIds: r.tabIds ?? [-1],
      },
    }));
  });

  await swPage.exposeFunction(
    '__e2eDnrUpdateSessionRules',
    (options: { addRules?: unknown[]; removeRuleIds?: number[] }) => {
      const addedIds: number[] = [];
      const removedIds: number[] = [];
      if (options.removeRuleIds) {
        for (const id of options.removeRuleIds) {
          activeDnrRules.delete(id);
          removedIds.push(id);
        }
      }
      if (options.addRules) {
        for (const rawRule of options.addRules) {
          const rule = rawRule as {
            id: number;
            priority?: number;
            condition?: { urlFilter?: string; regexFilter?: string; tabIds?: number[] };
            action?: {
              type?: string;
              requestHeaders?: Array<{ header: string; operation: string; value?: string }>;
            };
          };
          if (activeDnrRules.has(rule.id)) {
            dnrRuleIdCollisions.push(rule.id);
          }
          activeDnrRules.set(rule.id, {
            id: rule.id,
            priority: rule.priority ?? 1,
            urlFilter: rule.condition?.urlFilter,
            regexFilter: rule.condition?.regexFilter,
            tabIds: rule.condition?.tabIds,
            actionType: rule.action?.type,
            requestHeaders: rule.action?.requestHeaders,
          });
          addedIds.push(rule.id);
        }
      }
      dnrUpdateLog.push({ addedIds, removedIds });
    },
  );

  const getStore = (area: 'sync' | 'local' | 'session'): Record<string, unknown> => {
    if (area === 'sync') return syncStore;
    if (area === 'local') return localStore;
    return sessionStore;
  };

  await swPage.exposeFunction(
    '__e2eStorageGet',
    (area: 'sync' | 'local' | 'session', key: string) => {
      const store = getStore(area);
      return key in store ? { [key]: store[key] } : {};
    },
  );

  await swPage.exposeFunction(
    '__e2eStorageSet',
    (area: 'sync' | 'local' | 'session', items: Record<string, unknown>) => {
      const store = getStore(area);
      Object.assign(store, items);
    },
  );

  await swPage.exposeFunction(
    '__e2eStorageRemove',
    (area: 'sync' | 'local' | 'session', key: string) => {
      const store = getStore(area);
      delete store[key];
    },
  );

  const getTabMeta = async (tabId: number) => {
    const entry = tabsById.get(tabId);
    if (!entry) {
      throw new Error(`Unknown tab ${tabId}`);
    }
    const title = await entry.page.title();
    return { id: entry.tabId, url: entry.page.url(), title };
  };

  await swPage.exposeFunction('__e2eTabsQuery', async () => [
    await getTabMeta(activeTabId),
  ]);

  await swPage.exposeFunction('__e2eTabsGet', async (tabId: number) =>
    getTabMeta(tabId),
  );

  await swPage.exposeFunction(
    '__e2eExecuteScript',
    async (injection: { target: { tabId: number }; files?: string[] }) => {
      const entry = tabsById.get(injection.target.tabId);
      if (!entry) {
        throw new Error(`Cannot executeScript on missing tab ${injection.target.tabId}`);
      }
      for (const file of injection.files ?? []) {
        const scriptPath = path.join(DIST_DIR, file);
        await entry.page.addScriptTag({ path: scriptPath });
        injectedContentCount += 1;
      }
      return [];
    },
  );

  await swPage.exposeFunction(
    '__e2eTabsSendMessage',
    async (tabId: number, message: unknown) => {
      const entry = tabsById.get(tabId);
      if (!entry) {
        throw new Error(`Cannot sendMessage to missing tab ${tabId}`);
      }
      return entry.page.evaluate((msg) => {
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
        id: 'lliikkoebahbliapkdchhdahfodpcach',
        getManifest: () => ({
          manifest_version: 3,
          name: 'OKF Clipper for Google Drive',
          short_name: 'OKF Clipper',
          version: '0.1.0',
          oauth2: {
            client_id: clientId,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
          },
        }),
        getPlatformInfo: () =>
          (w.__e2eGetPlatformInfo as () => Promise<unknown>)(),
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
        setBadgeText: (details: unknown) =>
          (w.__e2eSetBadgeText as (d: unknown) => Promise<void>)(details),
        setBadgeBackgroundColor: (details: unknown) =>
          (w.__e2eSetBadgeBgColor as (d: unknown) => Promise<void>)(details),
      },
      identity: {
        getRedirectURL: () =>
          'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org/',
        getAuthToken: (details: unknown) =>
          (w.__e2eGetAuthToken as (d: unknown) => Promise<unknown>)(details),
        launchWebAuthFlow: (details: unknown) =>
          (w.__e2eLaunchWebAuthFlow as (d: unknown) => Promise<string>)(details),
        removeCachedAuthToken: async () =>
          (w.__e2eClearAuth as () => Promise<void>)(),
        clearAllCachedAuthTokens: async () =>
          (w.__e2eClearAuth as () => Promise<void>)(),
      },
      declarativeNetRequest: {
        getSessionRules: () =>
          (w.__e2eDnrGetSessionRules as () => Promise<unknown>)(),
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
        session: {
          get: (key: string) =>
            (w.__e2eStorageGet as (a: string, k: string) => Promise<unknown>)('session', key),
          set: (items: Record<string, unknown>) =>
            (w.__e2eStorageSet as (a: string, i: Record<string, unknown>) => Promise<void>)('session', items),
          remove: (key: string) =>
            (w.__e2eStorageRemove as (a: string, k: string) => Promise<void>)('session', key),
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
          id: 'lliikkoebahbliapkdchhdahfodpcach',
          lastError: undefined,
          getManifest: () => ({
            manifest_version: 3,
            name: 'OKF Clipper for Google Drive',
            short_name: 'OKF Clipper',
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
        identity: {
          getRedirectURL: () =>
            'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org/',
        },
      };
    }, TEST_OAUTH_CLIENT_ID);
  };

  const openPopup = async (): Promise<{
    page: Page;
    consoleErrors: string[];
    pageErrors: string[];
  }> => {
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 360, height: 640 });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    popupPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    popupPage.on('pageerror', (err) => pageErrors.push(err.message));

    await attachUiChromeBridge(popupPage);
    await popupPage.goto(`${distBaseUrl}/popup.html`, { waitUntil: 'networkidle' });
    return { page: popupPage, consoleErrors, pageErrors };
  };

  const openOptions = async (): Promise<{
    page: Page;
    consoleErrors: string[];
    pageErrors: string[];
  }> => {
    const optionsPage = await context.newPage();
    await optionsPage.setViewportSize({ width: 900, height: 960 });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    optionsPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    optionsPage.on('pageerror', (err) => pageErrors.push(err.message));

    await attachUiChromeBridge(optionsPage);
    await optionsPage.goto(`${distBaseUrl}/options.html`, { waitUntil: 'networkidle' });
    return { page: optionsPage, consoleErrors, pageErrors };
  };

  return {
    articlePage: firstArticlePage,
    tabsById,
    setActiveTab(tabId: number) {
      activeTabId = tabId;
    },
    getAllArticleErrors: () =>
      Array.from(tabsById.values()).flatMap((entry) => entry.errors),
    swPage,
    swErrors,
    activeDnrRules,
    dnrUpdateLog,
    dnrRuleIdCollisions,
    recordedAuthScopes,
    recordedGetAuthTokenCalls,
    recordedWebAuthFlowCalls,
    badgeUpdates,
    sessionStore,
    getKeepalivePings: () => keepalivePings,
    getInjectedContentCount: () => injectedContentCount,
    sendToServiceWorker,
    attachUiChromeBridge,
    openPopup,
    openOptions,
    async close() {
      for (const p of uiPushSubscribers) {
        if (!p.isClosed()) await p.close();
      }
      if (!swPage.isClosed()) await swPage.close();
      for (const entry of tabsById.values()) {
        if (!entry.page.isClosed()) await entry.page.close();
      }
    },
  };
}

test.describe('Drive Clipper E2E (real Chromium + built dist/ artifacts)', () => {
  test('validates built dist/manifest.json, entrypoints, minimal drive.file scope, and MV3 CSP/no-remote-scripts', () => {
    const manifestPath = path.join(DIST_DIR, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      manifest_version: number;
      name?: string;
      short_name?: string;
      oauth2?: { client_id?: string; scopes?: string[] };
      background?: { service_worker?: string };
      action?: { default_popup?: string; default_icon?: Record<string, string> };
      options_page?: string;
      icons?: Record<string, string>;
      content_security_policy?: { extension_pages?: string };
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('OKF Clipper for Google Drive');
    expect(manifest.short_name).toBe('OKF Clipper');
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
      expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i);
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

      const {
        page: popupPage,
        consoleErrors: popupConsoleErrors,
        pageErrors: popupPageErrors,
      } = await harness.openPopup();

      await expect(popupPage.locator('#title-input')).toHaveValue(
        'Drive Clipper End-to-End Architecture',
      );
      await expect(popupPage.locator('#auth-pill-label')).toHaveText('Connected');
      await expect(popupPage.locator('#folder-preview')).toHaveText(
        /^\d{4}-\d{2}-\d{2}-drive-clipper-end-to-end-architecture\/\d{4}-\d{2}-\d{2}-drive-clipper-end-to-end-architecture\.md$/,
      );
      await expect(popupPage.locator('#folder-preview')).toHaveAttribute(
        'title',
        /^WebClips\/\d{4}-\d{2}-\d{2}-drive-clipper-end-to-end-architecture\/\d{4}-\d{2}-\d{2}-drive-clipper-end-to-end-architecture\.md$/,
      );
      await expect(popupPage.locator('#clip-submit-btn')).toBeEnabled();

      // Verify clean 360px popup layout (no horizontal overflow)
      const popupOverflow = await popupPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(popupOverflow).toBeLessThanOrEqual(0);

      // Clear initial page-load image hits so imageRequests tracks only extension background fetches
      fixtureServer.imageRequests.length = 0;

      // Click "Clip to Google Drive" to run the REAL bundled pipeline end to end!
      await popupPage.locator('#clip-submit-btn').click();
      const firstRow = popupPage.locator('#clip-queue-list .queue-item').first();
      await expect(firstRow).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
      await expect(firstRow.locator('.queue-item-detail')).toHaveText('Saved · 3 images');

      // Verify UI displays Drive link, 1 warning (for the broken 404 image), and updated history
      const driveHref = await firstRow.locator('.queue-open-link').getAttribute('href');
      expect(driveHref).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\/mock-drive-\d+$/);
      await expect(firstRow.locator('.queue-warnings')).toBeVisible();
      await expect(firstRow.locator('.queue-warnings-summary')).toContainText('1 warning');
      await expect(popupPage.locator('#recent-clips-count')).toHaveText('1');

      // Open warnings and recent clips to verify rendering
      await firstRow.locator('.queue-warnings-summary').click();
      await popupPage.locator('.recent-clips-summary').click();
      await expect(firstRow.locator('.queue-warnings-list li')).toHaveCount(1);
      await expect(popupPage.locator('#recent-clips-list .recent-clip-item')).toHaveCount(1);

      // Assert all E2E pipeline invariants on the first clip
      expect(harness.getInjectedContentCount()).toBeGreaterThanOrEqual(2);
      expect(harness.recordedAuthScopes.length).toBeGreaterThan(0);
      for (const scopes of harness.recordedAuthScopes) {
        expect(scopes).toEqual([REQUIRED_DRIVE_SCOPE]);
      }

      // DNR Referer rules were added during fetch and completely removed afterwards
      expect(harness.dnrRuleIdCollisions).toEqual([]);
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

      const rootFolderId = driveServer.folderCreations[0].id;
      const articleFolderName = driveServer.folderCreations[1].name;
      const expectedArticleFileName = `${articleFolderName}.md`;

      // Exact upload order: 3 valid images BEFORE `<folderName>.md`, followed by root `index.md` + `log.md`
      expect(driveServer.uploadOrder).toHaveLength(6);
      expect(driveServer.uploadOrder[3]).toBe(expectedArticleFileName);
      expect(driveServer.uploadOrder.slice(4, 6).sort()).toEqual(['index.md', 'log.md']);
      const uploadedImageNames = driveServer.uploadOrder.slice(0, 3);
      expect(uploadedImageNames).not.toContain(expectedArticleFileName);
      expect(uploadedImageNames).not.toContain('README.md');
      expect(uploadedImageNames.some((n) => n.endsWith('.webp'))).toBe(true);
      expect(uploadedImageNames.some((n) => n.endsWith('.png'))).toBe(true);
      expect(uploadedImageNames.some((n) => n.endsWith('.jpg'))).toBe(true);

      // Verify uploaded binary payloads preserved original formats
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

      // Verify `<folderName>.md` OKF v0.2 frontmatter and content
      const articleUpload = driveServer.uploads.find(
        (u) => u.metadata.name === expectedArticleFileName,
      )!;
      expect(articleUpload).toBeDefined();
      const articleText = articleUpload.contentBytes.toString('utf8');
      expect(articleText).toContain('type: "web-clip"');
      expect(articleText).toContain('title: "Drive Clipper End-to-End Architecture"');
      expect(articleText).toContain(
        'description: "Real-browser E2E fixture covering Shadow DOM, lazy images, deduplication, anti-hotlink Referer, and 404 fallback."',
      );
      expect(articleText).toContain('status: "raw"');
      expect(articleText).toContain('generated:\n  by: "drive-clipper"\n  at: "');
      expect(articleText).toContain(`sources:\n  - url: "${fixtureServer.articleUrl}"`);
      expect(articleText).toContain('    site: "Clipper Engineering Blog"');
      expect(articleText).toContain('    author: "Ada Lovelace"');
      expect(articleText).toContain('    published: "2026-11-20T09:00:00Z"');
      expect(articleText).toContain('Normal light-DOM article introduction');
      expect(articleText).toContain(
        'Critical architectural note rendered strictly inside an open Shadow DOM root',
      );
      expect(articleText).not.toContain('color: crimson');
      const webpFilename = String(webpUpload.metadata.name);
      expect(articleText).toContain(`./images/${webpFilename}`);
      expect(articleText).not.toContain('data:image/svg+xml');
      const pngFilename = String(pngUpload.metadata.name);
      const dupRewrittenMatches = articleText.match(
        new RegExp(`!\\[[^\\]]*\\]\\(\\./images/${pngFilename.replace('.', '\\.')}\\)`, 'g'),
      );
      expect(dupRewrittenMatches?.length).toBe(2);
      const jpgFilename = String(jpgUpload.metadata.name);
      expect(articleText).toContain(`./images/${jpgFilename}`);
      expect(articleText).toContain(`${fixtureServer.baseUrl}/media/missing-404.png`);
      expect(articleText).toContain('warnings:');
      expect(articleText).toContain('HTTP 404');

      // Verify OKF v0.2 root `WebClips/index.md` and lowercase `WebClips/log.md`
      const getRootFileText = (name: string): string => {
        const matched = Array.from(driveServer.files.values()).filter(
          (f) => f.parents.includes(rootFolderId) && f.name === name,
        );
        expect(matched, `Expected exactly 1 ${name} in WebClips root`).toHaveLength(1);
        return matched[0].content?.toString('utf8') ?? '';
      };

      const indexText1 = getRootFileText('index.md');
      expect(indexText1).toContain('okf_version: "0.2"');
      expect(indexText1).toContain('title: "WebClips"');
      expect(indexText1).toContain('## Clips');
      expect(indexText1).toContain(
        `[Drive Clipper End-to-End Architecture](./${articleFolderName}/${expectedArticleFileName})`,
      );
      expect(indexText1).toContain(`<!-- clip-source: ${fixtureServer.articleUrl} -->`);

      const logText1 = getRootFileText('log.md');
      expect(logText1.startsWith('# Clip Log\n')).toBe(true);
      expect(logText1).not.toContain('---');
      const logLines1 = logText1
        .split('\n')
        .filter((line) => line.startsWith('- '));
      expect(logLines1).toHaveLength(1);
      expect(logLines1[0]).toContain(
        `| clipped | [Drive Clipper End-to-End Architecture](./${articleFolderName}/${expectedArticleFileName}) | ${fixtureServer.articleUrl}`,
      );

      // Re-clip the EXACT same URL and verify folder reuse + idempotent index.md + appended log.md
      const firstFolderCount = driveServer.folderCreations.length;
      const firstUploadCount = driveServer.uploads.length;
      const firstArticleFolderId = driveServer.folderCreations[1].id;

      await expect(popupPage.locator('#clip-submit-btn')).toBeEnabled();
      await popupPage.locator('#clip-submit-btn').click();
      const reclipRow = popupPage.locator('#clip-queue-list .queue-item').first();
      await expect(reclipRow.locator('.queue-item-detail')).toHaveText('Updated · 3 images', {
        timeout: 20_000,
      });

      expect(driveServer.sourceUrlQueries.length).toBe(2);
      expect(driveServer.folderCreations.length).toBe(firstFolderCount);
      const secondRunUploads = driveServer.uploads.slice(firstUploadCount);
      expect(secondRunUploads).toHaveLength(6);
      expect(secondRunUploads.every((u) => u.method === 'PATCH')).toBe(true);
      expect(secondRunUploads[3].metadata.name).toBe(expectedArticleFileName);
      expect(
        secondRunUploads
          .slice(4, 6)
          .map((u) => String(u.metadata.name))
          .sort(),
      ).toEqual(['index.md', 'log.md']);
      const updatedHref = await reclipRow.locator('.queue-open-link').getAttribute('href');
      expect(updatedHref).toBe(`https://drive.google.com/drive/folders/${firstArticleFolderId}`);
      expect(harness.activeDnrRules.size).toBe(0);

      // Re-clip updated `index.md` in place (still 1 entry, zero duplicates) and appended `updated` to `log.md`
      const indexText2 = getRootFileText('index.md');
      const indexEntries2 = indexText2
        .split('\n')
        .filter((line) => line.startsWith('- ['));
      expect(indexEntries2).toHaveLength(1);
      expect(indexEntries2[0]).toContain(
        `./${articleFolderName}/${expectedArticleFileName}`,
      );

      const logText2 = getRootFileText('log.md');
      const logLines2 = logText2
        .split('\n')
        .filter((line) => line.startsWith('- '));
      expect(logLines2).toHaveLength(2);
      expect(logLines2[0]).toContain('| clipped |');
      expect(logLines2[1]).toContain(
        `| updated | [Drive Clipper End-to-End Architecture](./${articleFolderName}/${expectedArticleFileName}) | ${fixtureServer.articleUrl}`,
      );

      // Render built dist/options.html in a 900px viewport wired to the SAME live dist/background.js
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

      await expect(optionsPage.locator('#auth-status-text')).toHaveText('Connected');
      await expect(optionsPage.locator('#root-folder-id-value')).toHaveText(rootFolderId);
      await expect(optionsPage.locator('#open-root-folder-link')).toBeVisible();
      await expect(optionsPage.locator('#open-root-folder-link')).toHaveAttribute(
        'href',
        `https://drive.google.com/drive/folders/${rootFolderId}`,
      );
      await expect(optionsPage.locator('#drive-file-note')).toContainText('Google Drive ID');
      await expect(optionsPage.locator('#drive-file-note')).toContainText('move or rename');
      await expect(optionsPage.locator('#drive-file-note')).not.toContainText('drive.file');
      await expect(optionsPage.locator('#advanced-section')).not.toHaveAttribute('open', '');
      await expect(optionsPage.locator('#advanced-section')).toContainText(REQUIRED_DRIVE_SCOPE);

      const optionsOverflow = await optionsPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(optionsOverflow).toBeLessThanOrEqual(0);

      await optionsPage.locator('#default-tags-input').fill('engineering');
      await optionsPage.locator('#default-tags-input').press('Enter');
      await optionsPage.locator('#save-preferences-btn').click();
      await expect(optionsPage.locator('#preferences-feedback')).toHaveText('Preferences saved.');

      expect(popupConsoleErrors).toEqual([]);
      expect(popupPageErrors).toEqual([]);
      expect(optionsConsoleErrors).toEqual([]);
      expect(optionsPageErrors).toEqual([]);
      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

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

  test('strips Zhihu unread prefixes from extracted title & Drive folder name while preserving legitimate (2026) parentheticals', async ({
    browser,
  }) => {
    const fixtureServer = await startFixtureServer();
    const driveServer = await startMockDriveServer();
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    try {
      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
        initialTabs: [
          { tabId: 201, url: `${fixtureServer.baseUrl}/articles/zhihu-unread` },
          { tabId: 202, url: `${fixtureServer.baseUrl}/articles/year-2026` },
        ],
      });

      // Tab 201: Zhihu unread prefix stripped cleanly
      harness.setActiveTab(201);
      const popup1 = await harness.openPopup();
      await expect(popup1.page.locator('#title-input')).toHaveValue(
        '华硕 ProArt 显示器色彩评测',
      );
      await expect(popup1.page.locator('#folder-preview')).toHaveText(
        /^\d{4}-\d{2}-\d{2}-华硕-proart-显示器色彩评测\/\d{4}-\d{2}-\d{2}-华硕-proart-显示器色彩评测\.md$/,
      );
      await expect(popup1.page.locator('#folder-preview')).not.toContainText('私信');

      await popup1.page.locator('#clip-submit-btn').click();
      await expect(
        popup1.page.locator('#clip-queue-list .queue-item').first(),
      ).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
      await popup1.page.close();

      // Tab 202: (2026) preserved intact
      harness.setActiveTab(202);
      const popup2 = await harness.openPopup();
      await expect(popup2.page.locator('#title-input')).toHaveValue(
        '(2026) Annual Systems Architecture Report',
      );
      await expect(popup2.page.locator('#folder-preview')).toHaveText(
        /^\d{4}-\d{2}-\d{2}-2026-annual-systems-architecture-report\/\d{4}-\d{2}-\d{2}-2026-annual-systems-architecture-report\.md$/,
      );

      await popup2.page.locator('#clip-submit-btn').click();
      await expect(
        popup2.page.locator('#clip-queue-list .queue-item[data-status="done"]'),
      ).toHaveCount(2, { timeout: 15_000 });
      await popup2.page.close();

      const folderNames = driveServer.folderCreations.map((f) => f.name);
      expect(folderNames).toEqual([
        'WebClips',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}-华硕-proart-显示器色彩评测$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}-2026-annual-systems-architecture-report$/),
      ]);

      const articleUploads = driveServer.uploads.filter((u) => {
        const name = String(u.metadata.name);
        return name.endsWith('.md') && name !== 'index.md' && name !== 'log.md';
      });
      expect(articleUploads.map((u) => u.metadata.name)).toEqual([
        `${folderNames[1]}.md`,
        `${folderNames[2]}.md`,
      ]);
      const articleTexts = articleUploads.map((u) => u.contentBytes.toString('utf8'));
      expect(articleTexts[0]).toContain('type: "web-clip"');
      expect(articleTexts[0]).toContain('title: "华硕 ProArt 显示器色彩评测"');
      expect(articleTexts[0]).not.toContain('20 封私信');
      expect(articleTexts[1]).toContain('title: "(2026) Annual Systems Architecture Report"');

      // Root index.md has both articles newest-first; log.md has both chronologically
      const rootId = driveServer.folderCreations[0].id;
      const rootIndex = Array.from(driveServer.files.values()).find(
        (f) => f.parents.includes(rootId) && f.name === 'index.md',
      );
      const rootLog = Array.from(driveServer.files.values()).find(
        (f) => f.parents.includes(rootId) && f.name === 'log.md',
      );
      expect(rootIndex?.content?.toString('utf8')).toContain(
        `./${folderNames[1]}/${folderNames[1]}.md`,
      );
      expect(rootIndex?.content?.toString('utf8')).toContain(
        `./${folderNames[2]}/${folderNames[2]}.md`,
      );
      const rootLogLines = (rootLog?.content?.toString('utf8') ?? '')
        .split('\n')
        .filter((line) => line.startsWith('- '));
      expect(rootLogLines).toHaveLength(2);
      expect(rootLogLines[0]).toContain(folderNames[1]);
      expect(rootLogLines[1]).toContain(folderNames[2]);

      expect(popup1.consoleErrors).toEqual([]);
      expect(popup1.pageErrors).toEqual([]);
      expect(popup2.consoleErrors).toEqual([]);
      expect(popup2.pageErrors).toEqual([]);
      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

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

  test('runs multi-tab background Clip queue concurrently with single-flight WebClips creation, non-colliding DNR Referers, >4.5MB resumable upload, per-image upload failure fallback, live Popup Process List UI, and captures screenshot', async ({
    browser,
  }) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const tab3UploadGate = createGate();
    const tab4DownloadGate = createGate();
    let gateTab4Downloads = false;

    const fixtureServer = await startFixtureServer({
      beforeImageResponse: async (pathname) => {
        if (gateTab4Downloads && pathname === '/media/queue-4-protected.jpg') {
          await tab4DownloadGate.promise;
        }
      },
    });
    const driveServer = await startMockDriveServer({
      failUploadNames: {
        '02-queue-3-upload-fail.png': {
          status: 400,
          message: 'Simulated Drive upload rejection',
        },
      },
      beforeUpload: async (name) => {
        if (name === '01-queue-3-protected.jpg') {
          await tab3UploadGate.promise;
        }
      },
    });
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    try {
      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
        initialTabs: [
          { tabId: 301, url: `${fixtureServer.baseUrl}/articles/queue-1` },
          { tabId: 302, url: `${fixtureServer.baseUrl}/articles/queue-2` },
          { tabId: 303, url: `${fixtureServer.baseUrl}/articles/queue-3` },
          { tabId: 304, url: `${fixtureServer.baseUrl}/articles/queue-4` },
          { tabId: 305, url: `${fixtureServer.baseUrl}/articles/queue-5` },
          { tabId: 306, url: `${fixtureServer.baseUrl}/articles/queue-6` },
        ],
      });

      fixtureServer.imageRequests.length = 0;

      // 1. Enqueue Tab 302 (done + >4.5 MiB resumable upload) and Tab 301 (done + Zhihu cleaned title + 404 warning) concurrently!
      // Starting 302 slightly ahead places Tab 301 (with its warning badge) directly visible in the top 4 rows of the Process List.
      const start2 = (await harness.sendToServiceWorker({
        type: 'START_CLIP',
        request: { tabId: 302, mode: 'full' },
      })) as { ok: boolean; data?: { id: string; status: string } };
      const start1 = (await harness.sendToServiceWorker({
        type: 'START_CLIP',
        request: { tabId: 301, mode: 'full' },
      })) as { ok: boolean; data?: { id: string; status: string } };
      expect(start1.ok).toBe(true);
      expect(start2.ok).toBe(true);

      // Wait until both Tab 301 and Tab 302 reach 'done'
      await expect
        .poll(
          async () => {
            const res = (await harness.sendToServiceWorker({
              type: 'GET_CLIP_JOBS',
            })) as { ok: boolean; data: Array<{ status: string }> };
            return res.data.filter((j) => j.status === 'done').length;
          },
          { timeout: 20_000 },
        )
        .toBe(2);

      // 2. Arm Tab 304 download gate now (after initial page loads finished), then enqueue
      // Tab 303 (held in 'uploading'), Tab 304 (held in 'downloading'), and Tab 305 ('queued' behind maxConcurrentJobs=2)!
      gateTab4Downloads = true;
      for (const tabId of [303, 304, 305]) {
        const res = (await harness.sendToServiceWorker({
          type: 'START_CLIP',
          request: { tabId, mode: 'full' },
        })) as { ok: boolean };
        expect(res.ok).toBe(true);
      }

      // Wait until exact multi-state queue snapshot is reached: 1 uploading, 1 downloading, 1 queued, 2 done
      await expect
        .poll(
          async () => {
            const res = (await harness.sendToServiceWorker({
              type: 'GET_CLIP_JOBS',
            })) as { ok: boolean; data: Array<{ status: string }> };
            const counts: Record<string, number> = {};
            for (const job of res.data) {
              counts[job.status] = (counts[job.status] ?? 0) + 1;
            }
            return counts;
          },
          { timeout: 15_000 },
        )
        .toEqual({
          done: 2,
          uploading: 1,
          downloading: 1,
          queued: 1,
        });

      // 3. Reopen Popup on active Tab 303 (already clipping) -> verify hydration + duplicate-active-URL guard
      harness.setActiveTab(303);
      const popupTab3 = await harness.openPopup();
      await expect(popupTab3.page.locator('#clip-submit-btn')).toBeDisabled();
      await expect(popupTab3.page.locator('#clip-submit-hint')).toHaveText(
        'Already clipping this page',
      );
      await expect(popupTab3.page.locator('#clip-queue-summary')).toHaveText(
        '2 running · 1 queued',
      );
      await popupTab3.page.close();

      // 4. Switch to unclipped Tab 306 & reopen Popup -> button is immediately enabled AND full 5-job Process List renders cleanly at 360px!
      harness.setActiveTab(306);
      const popupLive = await harness.openPopup();
      await expect(popupLive.page.locator('#clip-submit-btn')).toBeEnabled();
      await expect(popupLive.page.locator('#clip-queue-panel')).toBeVisible();
      await expect(popupLive.page.locator('#clip-queue-summary')).toHaveText(
        '2 running · 1 queued',
      );
      await expect(popupLive.page.locator('#clear-done-jobs-btn')).toBeVisible();
      await expect(popupLive.page.locator('#clip-queue-list .queue-item')).toHaveCount(5);

      await expect(
        popupLive.page.locator('#clip-queue-list .queue-item[data-status="queued"]'),
      ).toHaveCount(1);
      await expect(
        popupLive.page.locator('#clip-queue-list .queue-item[data-status="downloading"]'),
      ).toHaveCount(1);
      await expect(
        popupLive.page.locator('#clip-queue-list .queue-item[data-status="uploading"]'),
      ).toHaveCount(1);
      await expect(
        popupLive.page.locator('#clip-queue-list .queue-item[data-status="done"]'),
      ).toHaveCount(2);

      // Verify zero horizontal overflow at 360px width
      const liveOverflow = await popupLive.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(liveOverflow).toBeLessThanOrEqual(0);

      // Capture full-window Popup screenshot showing active + queued + done + warning rows!
      const queueScreenshotPath = path.join(SCREENSHOT_DIR, 'popup-multitab-queue.png');
      await popupLive.page.screenshot({ path: queueScreenshotPath, fullPage: true });
      expect(statSync(queueScreenshotPath).size).toBeGreaterThan(0);

      // 5. Release both gates -> verify live CLIP_JOBS_UPDATED pushes drive all 5 jobs to 'done' without reopening Popup
      tab3UploadGate.release();
      tab4DownloadGate.release();

      await expect(
        popupLive.page.locator('#clip-queue-list .queue-item[data-status="done"]'),
      ).toHaveCount(5, { timeout: 25_000 });
      await expect(popupLive.page.locator('#clip-queue-summary')).toHaveText('5 saved');
      await expect(popupLive.page.locator('#recent-clips-count')).toHaveText('5');

      // 6. Verify single-flight ensureRootFolder: ONLY ONE 'WebClips' root folder created across 5 concurrent clips!
      const rootFolders = driveServer.folderCreations.filter((f) => f.name === 'WebClips');
      expect(rootFolders).toHaveLength(1);

      // 7. Verify non-colliding DNR Referer rules across all 5 same-origin tabs
      expect(harness.dnrRuleIdCollisions).toEqual([]);
      expect(harness.activeDnrRules.size).toBe(0);
      for (let i = 1; i <= 5; i += 1) {
        const hits = fixtureServer.imageRequests.filter(
          (r) => r.path === `/media/queue-${i}-protected.jpg` && r.status === 200,
        );
        expect(hits, `Tab ${i} protected image must succeed with its own Referer`).toHaveLength(1);
        expect(hits[0].referer).toBe(`${fixtureServer.baseUrl}/articles/queue-${i}`);
      }

      // 8. Verify > 4.5 MiB image on Tab 302 used uploadType=resumable with exact intact bytes
      const largeUpload = driveServer.uploads.find(
        (u) => u.metadata.name === '02-queue-2-large.png',
      );
      expect(largeUpload).toBeDefined();
      expect(largeUpload!.uploadType).toBe('resumable');
      expect(largeUpload!.declaredContentLength).toBe(LARGE_RESUMABLE_PNG_BYTES.byteLength);
      expect(largeUpload!.contentBytes.equals(LARGE_RESUMABLE_PNG_BYTES)).toBe(true);

      // Small images stayed on multipart
      const smallProtectedUpload = driveServer.uploads.find(
        (u) => u.metadata.name === '01-queue-1-protected.jpg',
      );
      expect(smallProtectedUpload?.uploadType).toBe('multipart');

      // 9. Verify per-image Drive upload failure on Tab 303 degraded gracefully AND still uploaded `<folderName>.md` with warning!
      const tab3Article = driveServer.uploads.find((u) => {
        const name = String(u.metadata.name);
        return (
          name.endsWith('-resilient-drive-upload-fallback-guide.md') &&
          u.contentBytes.toString('utf8').includes('Resilient Drive Upload Fallback Guide')
        );
      });
      expect(tab3Article).toBeDefined();
      const tab3ArticleText = tab3Article!.contentBytes.toString('utf8');
      expect(tab3ArticleText).toContain('type: "web-clip"');
      expect(tab3ArticleText).toContain('./images/01-queue-3-protected.jpg');
      expect(tab3ArticleText).toContain(`${fixtureServer.baseUrl}/media/queue-3-upload-fail.png`);
      expect(tab3ArticleText).toContain('warnings:');
      expect(tab3ArticleText).toContain('Simulated Drive upload rejection');

      // 9b. Verify serialized `WebClips/index.md` and `WebClips/log.md` captured ALL 5 concurrent clips with ZERO lost updates!
      const webClipsRootId = rootFolders[0].id;
      const rootIndexFiles = Array.from(driveServer.files.values()).filter(
        (f) => f.parents.includes(webClipsRootId) && f.name === 'index.md',
      );
      const rootLogFiles = Array.from(driveServer.files.values()).filter(
        (f) => f.parents.includes(webClipsRootId) && f.name === 'log.md',
      );
      expect(rootIndexFiles).toHaveLength(1);
      expect(rootLogFiles).toHaveLength(1);

      const concurrentIndexText = rootIndexFiles[0].content?.toString('utf8') ?? '';
      expect(concurrentIndexText).toContain('okf_version: "0.2"');
      expect(concurrentIndexText).toContain('## Clips');
      const concurrentIndexLines = concurrentIndexText
        .split('\n')
        .filter((line) => line.startsWith('- ['));
      expect(concurrentIndexLines).toHaveLength(5);

      const concurrentLogText = rootLogFiles[0].content?.toString('utf8') ?? '';
      expect(concurrentLogText.startsWith('# Clip Log\n')).toBe(true);
      expect(concurrentLogText).not.toContain('---');
      const concurrentLogLines = concurrentLogText
        .split('\n')
        .filter((line) => line.startsWith('- '));
      expect(concurrentLogLines).toHaveLength(5);

      for (let i = 1; i <= 5; i += 1) {
        const expectedUrl = `${fixtureServer.baseUrl}/articles/queue-${i}`;
        const matchingIndexLine = concurrentIndexLines.find((line) =>
          line.includes(`<!-- clip-source: ${expectedUrl} -->`),
        );
        expect(
          matchingIndexLine,
          `index.md missing entry for concurrent Tab ${i} (${expectedUrl})`,
        ).toBeDefined();

        const relMatch = /\]\(\.\/([^/]+)\/([^)]+\.md)\)/.exec(matchingIndexLine!);
        expect(relMatch, `index.md link for Tab ${i} must point to ./<folder>/<folder>.md`).not.toBeNull();
        expect(relMatch![2]).toBe(`${relMatch![1]}.md`);

        const matchingFolder = driveServer.folderCreations.find((f) => f.name === relMatch![1]);
        expect(matchingFolder).toBeDefined();
        const matchingArticleFile = Array.from(driveServer.files.values()).find(
          (f) => f.parents.includes(matchingFolder!.id) && f.name === relMatch![2],
        );
        expect(matchingArticleFile).toBeDefined();

        expect(
          concurrentLogLines.some(
            (line) =>
              line.includes('| clipped |') &&
              line.includes(`./${relMatch![1]}/${relMatch![2]}`) &&
              line.includes(expectedUrl),
          ),
          `log.md missing chronological entry for Tab ${i}`,
        ).toBe(true);
      }

      // 10. Verify unified toolbar badge transitioned through active counts -> green OK
      expect(
        harness.badgeUpdates.some((b) => b.text === '2' || b.text === '3'),
      ).toBe(true);
      expect(
        harness.badgeUpdates.some((b) => b.text === 'OK' && b.color === '#16a34a'),
      ).toBe(true);

      // 11. Verify single-job dismiss and Clear done in Popup UI
      await popupLive.page.locator('#clip-queue-list [data-dismiss-job]').first().click();
      await expect(popupLive.page.locator('#clip-queue-list .queue-item')).toHaveCount(4);

      await popupLive.page.locator('#clear-done-jobs-btn').click();
      await expect(popupLive.page.locator('#clip-queue-panel')).toBeHidden();

      // Assert zero console/page errors across all pages
      expect(popupTab3.consoleErrors).toEqual([]);
      expect(popupTab3.pageErrors).toEqual([]);
      expect(popupLive.consoleErrors).toEqual([]);
      expect(popupLive.pageErrors).toEqual([]);
      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

      await harness.close();
    } finally {
      tab3UploadGate.release();
      tab4DownloadGate.release();
      await context.close();
      await Promise.all([
        fixtureServer.close(),
        driveServer.close(),
        distServer.close(),
      ]);
    }
  });

  test('keeps image filenames deterministic when an earlier image fails/recovers and avoids PATCH collisions when a new image is prepended on re-clip', async ({
    browser,
  }) => {
    const fixtureServer = await startFixtureServer();
    const driveServer = await startMockDriveServer();
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    try {
      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
        initialTabs: [
          { tabId: 401, url: `${fixtureServer.baseUrl}/articles/shift-proof` },
        ],
        ignoredConsoleUrls: [`${fixtureServer.baseUrl}/media/first/photo.png`],
      });

      const waitForAllDone = async (expectedCount: number) => {
        await expect
          .poll(
            async () => {
              const res = (await harness.sendToServiceWorker({
                type: 'GET_CLIP_JOBS',
              })) as { ok: boolean; data: Array<{ status: string }> };
              return res.data.filter((j) => j.status === 'done').length;
            },
            { timeout: 15_000 },
          )
          .toBe(expectedCount);
      };

      // Run 1: image #1 fails (HTTP 500), image #2 succeeds -> MUST keep index 02 (`02-diagram.png`)!
      fixtureServer.state.shiftFirstImageStatus = 500;
      fixtureServer.state.shiftArticleVariant = 'run1';
      await harness.sendToServiceWorker({
        type: 'START_CLIP',
        request: { tabId: 401, mode: 'full' },
      });
      await waitForAllDone(1);

      const imagesFolder = driveServer.folderCreations.find((f) => f.name === 'images')!;
      const run1ImageFiles = Array.from(driveServer.files.values()).filter((f) =>
        f.parents.includes(imagesFolder.id),
      );
      expect(run1ImageFiles.map((f) => f.name)).toEqual(['02-diagram.png']);
      const secondImgFileId = run1ImageFiles[0].id;

      // Run 2: image #1 recovers (HTTP 200) -> image #1 gets `01-photo.png` (POST), image #2 PATCHes `02-diagram.png` in place (same fileId, zero duplicates)!
      fixtureServer.state.shiftFirstImageStatus = 200;
      await harness.sendToServiceWorker({
        type: 'START_CLIP',
        request: { tabId: 401, mode: 'full' },
      });
      await waitForAllDone(2);

      const run2ImageFiles = Array.from(driveServer.files.values()).filter((f) =>
        f.parents.includes(imagesFolder.id),
      );
      expect(run2ImageFiles.map((f) => f.name).sort()).toEqual([
        '01-photo.png',
        '02-diagram.png',
      ]);
      const run2Second = run2ImageFiles.find((f) => f.name === '02-diagram.png')!;
      expect(run2Second.id).toBe(secondImgFileId);
      const originalFirstFileId = run2ImageFiles.find((f) => f.name === '01-photo.png')!.id;

      // Run 3: a brand-new image (`/media/prepend/photo.png`) is prepended as `01-photo.png`,
      // shifting original `/media/first/photo.png` to `02-photo.png` and diagram to `03-diagram.png`!
      // All 3 distinct images MUST exist in Drive without PATCH colliding on `originalFirstFileId`!
      fixtureServer.state.shiftArticleVariant = 'run3-prepended';
      await harness.tabsById.get(401)!.page.reload({ waitUntil: 'networkidle' });
      await harness.sendToServiceWorker({
        type: 'START_CLIP',
        request: { tabId: 401, mode: 'full' },
      });
      await waitForAllDone(3);

      const run3ImageFiles = Array.from(driveServer.files.values()).filter((f) =>
        f.parents.includes(imagesFolder.id),
      );
      expect(run3ImageFiles.map((f) => f.name).sort()).toEqual([
        '01-photo.png',
        '02-photo.png',
        '03-diagram.png',
      ]);
      // Original first photo was renamed/PATCHed in place to 02-photo.png; prepended photo got a distinct fileId!
      const shiftedFirst = run3ImageFiles.find((f) => f.name === '02-photo.png')!;
      const prependedFirst = run3ImageFiles.find((f) => f.name === '01-photo.png')!;
      expect(shiftedFirst.id).toBe(originalFirstFileId);
      expect(prependedFirst.id).not.toBe(originalFirstFileId);
      expect(prependedFirst.content?.toString('utf8')).toContain('PREPENDED');
      expect(shiftedFirst.content?.toString('utf8')).toContain('FIRST');

      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

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

  test('extracts, fetches (at name=large), and uploads X.com tweet images with empty alt="" and video posters while excluding avatars and replies', async ({
    browser,
  }) => {
    const fixtureServer = await startFixtureServer();
    const driveServer = await startMockDriveServer();
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    const xTweetUrl = 'https://x.com/e2eauthor/status/2125132076768985599';
    const fetchedTwimgUrls: string[] = [];

    const xTweetHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>E2E Author on X: "Testing empty-alt X photos and video poster"</title>
  </head>
  <body>
    <main>
      <div data-testid="cellInnerDiv">
        <article data-testid="tweet">
          <div data-testid="Tweet-User-Avatar">
            <img src="https://pbs.twimg.com/profile_images/42/avatar_bigger.jpg" alt="E2E Author" />
          </div>
          <div data-testid="User-Name">
            <a href="/e2eauthor">E2E Author</a>
            <a href="/e2eauthor">@e2eauthor</a>
            <a href="/e2eauthor/status/2125132076768985599"><time datetime="2026-11-24T08:00:00.000Z">Nov 24</time></a>
          </div>
          <div data-testid="tweetText">
            <span>Clipping an X post whose photos have empty alt text and an embedded video poster.</span>
            <img src="https://abs-0.twimg.com/emoji/v2/svg/1f680.svg" alt="🚀" />
          </div>
          <div data-testid="tweetPhoto">
            <div style="background-image: url(&quot;https://pbs.twimg.com/media/AbCdEfG?format=jpg&amp;name=small&quot;);"></div>
            <img src="https://pbs.twimg.com/media/AbCdEfG?format=jpg&amp;name=small" alt="" />
          </div>
          <div data-testid="tweetPhoto">
            <img src="https://pbs.twimg.com/media/SecondPhoto9?format=png&amp;name=small" />
          </div>
          <div data-testid="tweetPhoto">
            <div data-testid="videoPlayer">
              <video
                aria-label="Embedded demo video"
                poster="https://pbs.twimg.com/amplify_video_thumb/2125132076768985599/img/PosterFrame1.jpg"
                src="blob:https://x.com/mock-blob-id"
              ></video>
            </div>
          </div>
        </article>
      </div>
      <div data-testid="cellInnerDiv">
        <article data-testid="tweet">
          <div data-testid="User-Name">
            <a href="/commenter">Commenter</a>
            <a href="/commenter">@commenter</a>
            <a href="/commenter/status/2125132076768985600"><time datetime="2026-11-24T08:05:00.000Z">Nov 24</time></a>
          </div>
          <div data-testid="tweetText"><span>Nice post!</span></div>
          <div data-testid="tweetPhoto">
            <img src="https://pbs.twimg.com/media/ReplyIgnored99?format=jpg&amp;name=small" alt="" />
          </div>
        </article>
      </div>
    </main>
  </body>
</html>`;

    try {
      await context.route('https://x.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: xTweetHtml,
        });
      });

      await context.route('https://pbs.twimg.com/**', async (route) => {
        const reqUrl = route.request().url();
        fetchedTwimgUrls.push(reqUrl);
        const isPng = reqUrl.includes('format=png');
        const body = isPng ? VALID_PNG_BYTES : VALID_JPEG_BYTES;
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': isPng ? 'image/png' : 'image/jpeg',
            'Content-Length': String(body.byteLength),
            'Access-Control-Allow-Origin': '*',
          },
          body,
        });
      });

      await context.route('https://abs-0.twimg.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'image/svg+xml' },
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>',
        });
      });

      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
        initialTabs: [{ tabId: 501, url: xTweetUrl }],
      });

      // Open Popup on the X.com tab to verify cleaned X title and `<folderName>/<folderName>.md` preview
      const xPopup = await harness.openPopup();
      await expect(xPopup.page.locator('#title-input')).toHaveValue(
        'Testing empty-alt X photos and video poster',
      );
      await expect(xPopup.page.locator('#folder-preview')).toHaveText(
        /^\d{4}-\d{2}-\d{2}-x-testing-empty-alt-x-photos-and-video-poster\/\d{4}-\d{2}-\d{2}-x-testing-empty-alt-x-photos-and-video-poster\.md$/,
      );

      // Clear page-load image requests so we measure only Service Worker fetches below
      fetchedTwimgUrls.length = 0;

      await xPopup.page.locator('#clip-submit-btn').click();
      await expect(
        xPopup.page.locator('#clip-queue-list .queue-item').first(),
      ).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
      await xPopup.page.close();

      // Service worker fetched the two media photos upgraded to name=large + the video poster (never avatar or reply image)
      expect(fetchedTwimgUrls.sort()).toEqual([
        'https://pbs.twimg.com/amplify_video_thumb/2125132076768985599/img/PosterFrame1.jpg',
        'https://pbs.twimg.com/media/AbCdEfG?format=jpg&name=large',
        'https://pbs.twimg.com/media/SecondPhoto9?format=png&name=large',
      ]);

      // Clean deterministic filenames uploaded BEFORE `<folderName>.md`, followed by root `index.md` + `log.md`
      const xFolder = driveServer.folderCreations.find((f) =>
        /^\d{4}-\d{2}-\d{2}-x-testing-empty-alt-x-photos-and-video-poster$/.test(f.name),
      );
      expect(xFolder, 'Expected clean X.com folder YYYY-MM-DD-x-<clean-slug>').toBeDefined();
      const xFileName = `${xFolder!.name}.md`;

      expect(driveServer.uploadOrder).toHaveLength(6);
      expect(driveServer.uploadOrder[3]).toBe(xFileName);
      expect(driveServer.uploadOrder.slice(4, 6).sort()).toEqual(['index.md', 'log.md']);
      expect(driveServer.uploadOrder.slice(0, 3).sort()).toEqual([
        '01-abcdefg.jpg',
        '02-secondphoto9.png',
        '03-posterframe1.jpg',
      ]);

      const xArticleUpload = driveServer.uploads.find((u) => u.metadata.name === xFileName)!;
      expect(xArticleUpload).toBeDefined();
      const xArticleText = xArticleUpload.contentBytes.toString('utf8');
      expect(xArticleText).toContain('type: "web-clip"');
      expect(xArticleText).toContain('title: "Testing empty-alt X photos and video poster"');
      expect(xArticleText).toContain('status: "raw"');
      expect(xArticleText).toContain('description: "');
      expect(xArticleText).toContain('site: "X (Twitter)"');
      expect(xArticleText).toContain('author: "@e2eauthor"');
      expect(xArticleText).toContain('./images/01-abcdefg.jpg');
      expect(xArticleText).toContain('./images/02-secondphoto9.png');
      expect(xArticleText).toContain('./images/03-posterframe1.jpg');
      expect(xArticleText).not.toContain('ReplyIgnored99');
      expect(xArticleText).not.toContain('profile_images');
      expect(xArticleText).not.toContain('abs-0.twimg.com');

      // Post images sit before ## Comments
      const commentsIdx = xArticleText.indexOf('## Comments');
      expect(commentsIdx).toBeGreaterThan(xArticleText.indexOf('./images/03-posterframe1.jpg'));

      // Root index.md links directly to `./<xFolder>/<xFolder>.md` with `x` source tag
      const xRootId = driveServer.folderCreations[0].id;
      const xIndexFile = Array.from(driveServer.files.values()).find(
        (f) => f.parents.includes(xRootId) && f.name === 'index.md',
      );
      const xIndexText = xIndexFile?.content?.toString('utf8') ?? '';
      expect(xIndexText).toContain('okf_version: "0.2"');
      expect(xIndexText).toContain(`./${xFolder!.name}/${xFileName}`);
      expect(xIndexText).toContain('`x`');

      expect(xPopup.consoleErrors).toEqual([]);
      expect(xPopup.pageErrors).toEqual([]);
      expect(harness.activeDnrRules.size).toBe(0);
      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

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

  test('persists Popup sticky tags across reload and reopen, including empty [] without snapping back to defaultTags', async ({
    browser,
  }) => {
    const fixtureServer = await startFixtureServer();
    const driveServer = await startMockDriveServer();
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    try {
      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
        initialTabs: [
          { tabId: 601, url: `${fixtureServer.baseUrl}/articles/year-2026` },
        ],
      });

      const readChipLabels = async (popupPage: Page): Promise<string[]> =>
        popupPage
          .locator('#tags-container .tag-chip-label')
          .allTextContents();

      // 1. Initial Popup open seeds defaultTags (['web-clip'])
      const popup1 = await harness.openPopup();
      await expect(popup1.page.locator('#tags-container .tag-chip-label')).toHaveText([
        'web-clip',
      ]);

      // 2. Add custom tags -> persisted immediately and restored on fresh Popup reopen
      await popup1.page.locator('#tags-input').fill('ai, knowledge-base');
      await popup1.page.locator('#tags-input').press('Enter');
      await expect(popup1.page.locator('#tags-container .tag-chip-label')).toHaveText([
        'web-clip',
        'ai',
        'knowledge-base',
      ]);
      await expect
        .poll(async () => {
          const res = (await harness.sendToServiceWorker({
            type: 'GET_SETTINGS',
          })) as { ok: boolean; data: { stickyTags: string[] | null } };
          return res.data.stickyTags;
        })
        .toEqual(['web-clip', 'ai', 'knowledge-base']);
      await popup1.page.close();

      const popup2 = await harness.openPopup();
      expect(await readChipLabels(popup2.page)).toEqual([
        'web-clip',
        'ai',
        'knowledge-base',
      ]);

      // 3. Click × on EVERY tag so the list becomes empty []
      await popup2.page.locator('[data-remove-tag="web-clip"]').click();
      await popup2.page.locator('[data-remove-tag="ai"]').click();
      await popup2.page.locator('[data-remove-tag="knowledge-base"]').click();
      await expect(popup2.page.locator('#tags-container .tag-chip')).toHaveCount(0);
      await expect
        .poll(async () => {
          const res = (await harness.sendToServiceWorker({
            type: 'GET_SETTINGS',
          })) as { ok: boolean; data: { stickyTags: string[] | null } };
          return res.data.stickyTags;
        })
        .toEqual([]);

      // 4. Reload AND close/reopen Popup -> MUST remain empty [] (NEVER snap back to ['web-clip'])
      await popup2.page.reload({ waitUntil: 'networkidle' });
      await expect(popup2.page.locator('#title-input')).toHaveValue(
        '(2026) Annual Systems Architecture Report',
      );
      await expect(popup2.page.locator('#tags-container .tag-chip')).toHaveCount(0);
      await popup2.page.close();

      const popup3 = await harness.openPopup();
      await expect(popup3.page.locator('#title-input')).toHaveValue(
        '(2026) Annual Systems Architecture Report',
      );
      await expect(popup3.page.locator('#tags-container .tag-chip')).toHaveCount(0);

      // 5. Clip with empty tags -> uploaded `<folderName>.md` records `tags: []`
      await popup3.page.locator('#clip-submit-btn').click();
      await expect(
        popup3.page.locator('#clip-queue-list .queue-item').first(),
      ).toHaveAttribute('data-status', 'done', { timeout: 15_000 });

      const uploadedArticle = driveServer.uploads.find((u) => {
        const name = String(u.metadata.name);
        return name.endsWith('.md') && name !== 'index.md' && name !== 'log.md';
      });
      expect(uploadedArticle).toBeDefined();
      expect(uploadedArticle!.contentBytes.toString('utf8')).toContain('tags: []');
      await popup3.page.close();

      // 6. Editing defaultTags in Options leaves stickyTags: [] untouched
      const optionsPage = await context.newPage();
      await optionsPage.setViewportSize({ width: 900, height: 960 });
      await harness.attachUiChromeBridge(optionsPage);
      await optionsPage.goto(`${distServer.baseUrl}/options.html`, {
        waitUntil: 'networkidle',
      });
      await optionsPage.locator('#default-tags-input').fill('reading-list');
      await optionsPage.locator('#default-tags-input').press('Enter');
      await optionsPage.locator('#save-preferences-btn').click();
      await expect(optionsPage.locator('#preferences-feedback')).toHaveText('Preferences saved.');
      await optionsPage.close();

      const popup4 = await harness.openPopup();
      await expect(popup4.page.locator('#title-input')).toHaveValue(
        '(2026) Annual Systems Architecture Report',
      );
      await expect(popup4.page.locator('#tags-container .tag-chip')).toHaveCount(0);

      expect(popup1.consoleErrors).toEqual([]);
      expect(popup1.pageErrors).toEqual([]);
      expect(popup2.consoleErrors).toEqual([]);
      expect(popup2.pageErrors).toEqual([]);
      expect(popup3.consoleErrors).toEqual([]);
      expect(popup3.pageErrors).toEqual([]);
      expect(popup4.consoleErrors).toEqual([]);
      expect(popup4.pageErrors).toEqual([]);
      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

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

  test('renders consumer onboarding Connect Google Drive popup card, transitions to clip form on sign-in, keeps Options Advanced collapsed by default, and routes BYO Custom Web OAuth Client ID through launchWebAuthFlow', async ({
    browser,
  }) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const fixtureServer = await startFixtureServer();
    const driveServer = await startMockDriveServer();
    const distServer = await startStaticDistServer();
    const context = await browser.newContext();

    try {
      const harness = await createExtensionHarness({
        context,
        distBaseUrl: distServer.baseUrl,
        fixtureServer,
        driveServer,
        initialSignedIn: false,
      });

      // 1. Popup consumer onboarding welcome card when signed out
      const popup = await harness.openPopup();
      await expect(popup.page.locator('.brand-title')).toHaveText('OKF Clipper');
      await expect(popup.page.locator('#auth-pill-label')).toHaveText('Signed out');
      await expect(popup.page.locator('#onboarding-banner')).toBeVisible();
      await expect(popup.page.locator('#onboarding-banner')).toHaveClass(/banner--welcome/);
      await expect(popup.page.locator('#banner-title')).toHaveText('Connect Google Drive');
      await expect(popup.page.locator('#banner-description')).toContainText('WebClips/');
      await expect(popup.page.locator('#banner-description')).toContainText(
        'No third-party servers',
      );
      await expect(popup.page.locator('#banner-description')).toContainText(
        'only access files it creates',
      );

      // Zero internal dev jargon visible to regular signed-out Chrome Web Store users
      const bannerText = await popup.page.locator('#onboarding-banner').innerText();
      expect(bannerText).not.toMatch(/config\.local\.json|chrome\.identity|googleapis\.com/i);

      // Single clear Connect CTA; clip form hidden while signed out
      await expect(popup.page.locator('#banner-signin-btn')).toBeVisible();
      await expect(popup.page.locator('#banner-signin-btn')).toHaveText('Connect Google Drive');
      await expect(popup.page.locator('#banner-options-btn')).toBeHidden();
      await expect(popup.page.locator('#clip-form')).toBeHidden();

      // Clean 360px popup width with zero horizontal overflow
      const signedOutPopupOverflow = await popup.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(signedOutPopupOverflow).toBeLessThanOrEqual(0);

      // Fit viewport tightly to popup content height before capturing crisp onboarding screenshot
      const popupContentHeight = await popup.page.evaluate(() =>
        Math.ceil(document.documentElement.getBoundingClientRect().height),
      );
      await popup.page.setViewportSize({
        width: 360,
        height: Math.max(260, popupContentHeight),
      });
      const onboardingScreenshotPath = path.join(
        SCREENSHOT_DIR,
        'popup-consumer-onboarding.png',
      );
      await popup.page.screenshot({ path: onboardingScreenshotPath, fullPage: true });
      expect(statSync(onboardingScreenshotPath).size).toBeGreaterThan(0);

      // Clicking Connect Google Drive signs in and immediately transitions to the clip form
      await popup.page.locator('#banner-signin-btn').click();
      await expect(popup.page.locator('#onboarding-banner')).toBeHidden();
      await expect(popup.page.locator('#auth-pill-label')).toHaveText('Connected');
      await expect(popup.page.locator('#clip-form')).toBeVisible();
      await expect(popup.page.locator('#title-input')).toHaveValue(
        'Drive Clipper End-to-End Architecture',
      );
      await expect(popup.page.locator('#clip-submit-btn')).toBeEnabled();
      await popup.page.close();

      // 2. Options page: Advanced & Self-hosting collapsed by default when OAuth is configured
      const options = await harness.openOptions();
      await expect(options.page.locator('.page-title')).toHaveText('OKF Clipper Settings');
      await expect(options.page.locator('#auth-status-text')).toHaveText('Connected');
      await expect(options.page.locator('#custom-client-pill')).toBeHidden();
      await expect(options.page.locator('#oauth-unconfigured-callout')).toBeHidden();

      const accountCardText = await options.page
        .locator('section[aria-labelledby="auth-heading"]')
        .innerText();
      expect(accountCardText).not.toMatch(
        /config\.local\.json|chrome\.identity|drive\.file|googleapis\.com/i,
      );

      const advancedDetails = options.page.locator('#advanced-section');
      await expect(advancedDetails).toBeVisible();
      expect(await advancedDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
      await expect(options.page.locator('#custom-client-id-input')).toBeHidden();

      const optionsOverflow = await options.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(optionsOverflow).toBeLessThanOrEqual(0);

      const optionsScreenshotPath = path.join(
        SCREENSHOT_DIR,
        'options-clean-collapsed-advanced.png',
      );
      await options.page.screenshot({ path: optionsScreenshotPath, fullPage: true });
      expect(statSync(optionsScreenshotPath).size).toBeGreaterThan(0);

      // 3. Expand Advanced & Self-hosting -> shows Custom Web OAuth Client ID + diagnostics
      await options.page.locator('#advanced-section > summary').click();
      expect(await advancedDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
      await expect(options.page.locator('#custom-client-id-input')).toBeVisible();
      await expect(options.page.locator('#extension-id-value')).toHaveText(
        'lliikkoebahbliapkdchhdahfodpcach',
      );
      await expect(options.page.locator('#oauth-redirect-uri-value')).toHaveText(
        'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org',
      );
      await expect(advancedDetails).toContainText(REQUIRED_DRIVE_SCOPE);

      // 4. Save BYO Custom Web OAuth Client ID -> evicts cached token, routes SIGN_IN via launchWebAuthFlow (bypassing getAuthToken!)
      const customByoClientId = '999888777666-e2ebyo.apps.googleusercontent.com';
      await options.page.locator('#custom-client-id-input').fill(customByoClientId);
      await options.page.locator('#save-custom-client-btn').click();

      await expect(options.page.locator('#custom-client-feedback')).toContainText(
        'Custom OAuth client saved',
      );
      await expect(options.page.locator('#auth-status-text')).toHaveText('Not connected');
      await expect(options.page.locator('#custom-client-pill')).toBeVisible();
      await expect(options.page.locator('#advanced-custom-badge')).toBeVisible();
      await expect(options.page.locator('#sign-in-btn')).toBeVisible();

      const getAuthCallsBeforeByoSignIn = harness.recordedGetAuthTokenCalls.length;
      const webAuthCallsBeforeByoSignIn = harness.recordedWebAuthFlowCalls.length;

      await options.page.locator('#sign-in-btn').click();
      await expect(options.page.locator('#auth-status-text')).toHaveText('Connected');
      await expect(options.page.locator('#custom-client-pill')).toBeVisible();

      // Critical BYO invariant: getAuthToken was NOT invoked; launchWebAuthFlow received the custom Client ID + drive.file scope
      expect(harness.recordedGetAuthTokenCalls.length).toBe(getAuthCallsBeforeByoSignIn);
      expect(harness.recordedWebAuthFlowCalls.length).toBe(webAuthCallsBeforeByoSignIn + 1);
      const byoFlowCall = harness.recordedWebAuthFlowCalls.at(-1)!;
      expect(byoFlowCall.interactive).toBe(true);
      expect(byoFlowCall.clientId).toBe(customByoClientId);
      expect(byoFlowCall.scope).toBe(REQUIRED_DRIVE_SCOPE);
      expect(byoFlowCall.redirectUri).toBe(
        'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org',
      );
      expect(byoFlowCall.state).toBeTruthy();

      // 5. Clicking "Use built-in" clears customWebAuthClientId, evicts custom web token, and reverts to getAuthToken
      await options.page.locator('#reset-custom-client-btn').click();
      await expect(options.page.locator('#custom-client-feedback')).toContainText(
        'Switched back to the built-in OAuth client.',
      );
      await expect(options.page.locator('#custom-client-id-input')).toHaveValue('');
      await expect(options.page.locator('#custom-client-pill')).toBeHidden();
      await expect(options.page.locator('#auth-status-text')).toHaveText('Not connected');

      const getAuthCallsBeforeBuiltInSignIn = harness.recordedGetAuthTokenCalls.length;
      const webAuthCallsBeforeBuiltInSignIn = harness.recordedWebAuthFlowCalls.length;

      await options.page.locator('#sign-in-btn').click();
      await expect(options.page.locator('#auth-status-text')).toHaveText('Connected');
      expect(harness.recordedGetAuthTokenCalls.length).toBe(
        getAuthCallsBeforeBuiltInSignIn + 1,
      );
      expect(harness.recordedWebAuthFlowCalls.length).toBe(webAuthCallsBeforeBuiltInSignIn);

      expect(popup.consoleErrors).toEqual([]);
      expect(popup.pageErrors).toEqual([]);
      expect(options.consoleErrors).toEqual([]);
      expect(options.pageErrors).toEqual([]);
      expect(harness.swErrors).toEqual([]);
      expect(harness.getAllArticleErrors()).toEqual([]);

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
