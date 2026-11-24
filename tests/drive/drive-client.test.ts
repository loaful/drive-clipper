import { describe, expect, it, vi } from 'vitest';
import {
  DRIVE_FOLDER_MIME_TYPE,
  DriveApiError,
  DriveClient,
  MULTIPART_UPLOAD_MAX_BYTES,
  buildGoogleWebAuthUrl,
  clearAllCachedChromeAuthTokens,
  encodeSourceUrlProperty,
  escapeDriveQueryValue,
  getChromeDriveAuthToken,
  parseWebAuthFlowRedirect,
  removeCachedChromeAuthToken,
  resolveWebAuthClientId,
  shouldFallbackToWebAuthFlow,
} from '../../src/drive/drive-client.js';
import {
  DRIVE_FILE_SCOPE,
  type ExtractedPage,
  type FetchedImage,
  type ImageFetchFailure,
} from '../../src/types.js';

interface RecordedMultipart {
  method: string;
  uploadType: 'multipart' | 'resumable';
  fileId?: string;
  metadata: Record<string, unknown>;
  contentType: string;
  contentBytes: Uint8Array;
  declaredContentLength?: number;
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20,
]);

function parseMultipartBody(
  body: Uint8Array,
  contentTypeHeader: string,
): {
  metadata: Record<string, unknown>;
  contentType: string;
  contentBytes: Uint8Array;
} {
  const match = /boundary=([^\s;]+)/i.exec(contentTypeHeader);
  if (!match) {
    throw new Error(`Missing boundary in Content-Type: ${contentTypeHeader}`);
  }
  const boundary = match[1];
  const latin1 = new TextDecoder('latin1').decode(body);
  const delimiter = `--${boundary}`;
  const parts = latin1.split(delimiter).slice(1, -1);
  expect(parts).toHaveLength(2);

  const metaPart = parts[0].replace(/^\r\n/, '');
  const metaSplit = metaPart.indexOf('\r\n\r\n');
  const metadataJson = metaPart.slice(metaSplit + 4).replace(/\r\n$/, '');
  const metadata = JSON.parse(metadataJson) as Record<string, unknown>;

  const mediaHeaderStart =
    latin1.indexOf(delimiter, latin1.indexOf(delimiter) + delimiter.length) +
    delimiter.length +
    2;
  const mediaHeaderEnd = latin1.indexOf('\r\n\r\n', mediaHeaderStart);
  const mediaHeaders = latin1.slice(mediaHeaderStart, mediaHeaderEnd);
  const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(mediaHeaders);
  const contentType = ctMatch?.[1].trim() ?? '';

  const contentStart = mediaHeaderEnd + 4;
  const closingIdx = latin1.indexOf(`\r\n${delimiter}--`, contentStart);
  const contentBytes = body.slice(contentStart, closingIdx);

  return { metadata, contentType, contentBytes };
}

interface MockDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties: Record<string, string>;
  content?: Uint8Array;
}

function createFakeDriveServer(options?: {
  onMultipartUpload?: (upload: RecordedMultipart) => Promise<void> | void;
  failNextUploads?: Array<{ status: number; retryAfter?: string; body?: string }>;
  failUploadNames?: Record<string, { status: number; body?: string }>;
}) {
  let idCounter = 0;
  let resumableSessionCounter = 0;
  const files = new Map<string, MockDriveFile>();
  const uploadOrder: string[] = [];
  const uploads: RecordedMultipart[] = [];
  const queries: string[] = [];
  const queuedFailures = [...(options?.failNextUploads ?? [])];
  const resumableSessions = new Map<
    string,
    {
      method: 'POST' | 'PATCH';
      existingId?: string;
      metadata: Record<string, unknown>;
      contentType: string;
      declaredLength: number;
    }
  >();

  const addFile = (file: Omit<MockDriveFile, 'id'> & { id?: string }): MockDriveFile => {
    idCounter += 1;
    const id = file.id ?? `drive-id-${idCounter}`;
    const stored: MockDriveFile = { ...file, id };
    files.set(id, stored);
    return stored;
  };

  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer /);

    // Metadata GET /drive/v3/files/:id
    if (method === 'GET' && url.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
      const found = files.get(id);
      if (!found) {
        return new Response(JSON.stringify({ error: { message: 'File not found' } }), {
          status: 404,
        });
      }
      return new Response(
        JSON.stringify({
          id: found.id,
          name: found.name,
          mimeType: found.mimeType,
          trashed: found.trashed,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // List/query GET /drive/v3/files?q=...
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      queries.push(q);

      const parentMatch = /'((?:\\.|[^'])+)' in parents/.exec(q);
      const nameMatch = /name = '((?:\\.|[^'])+)'/.exec(q);
      const sourceUrlMatch =
        /appProperties has \{ key='sourceUrl' and value='((?:\\.|[^'])+)' \}/.exec(q);
      const onlyFolders = q.includes(`mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`);
      const excludeFolders = q.includes(`mimeType != '${DRIVE_FOLDER_MIME_TYPE}'`);

      const unescape = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

      const matched = Array.from(files.values()).filter((f) => {
        if (q.includes('trashed = false') && f.trashed) return false;
        if (onlyFolders && f.mimeType !== DRIVE_FOLDER_MIME_TYPE) return false;
        if (excludeFolders && f.mimeType === DRIVE_FOLDER_MIME_TYPE) return false;
        if (parentMatch && !f.parents.includes(unescape(parentMatch[1]))) return false;
        if (nameMatch && f.name !== unescape(nameMatch[1])) return false;
        if (
          sourceUrlMatch &&
          f.appProperties.sourceUrl !== unescape(sourceUrlMatch[1])
        ) {
          return false;
        }
        return true;
      });

      return new Response(
        JSON.stringify({
          files: matched.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            trashed: f.trashed,
            appProperties: f.appProperties,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Folder creation POST /drive/v3/files
    if (method === 'POST' && url.pathname === '/drive/v3/files') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        name: string;
        mimeType: string;
        parents?: string[];
        appProperties?: Record<string, string>;
      };
      const created = addFile({
        name: payload.name,
        mimeType: payload.mimeType,
        parents: payload.parents ?? [],
        trashed: false,
        appProperties: payload.appProperties ?? {},
      });
      return new Response(
        JSON.stringify({
          id: created.id,
          name: created.name,
          mimeType: created.mimeType,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Resumable upload Step 2: PUT raw bytes to session URI
    if (
      method === 'PUT' &&
      url.pathname.startsWith('/upload/drive/v3/resumable-sessions/')
    ) {
      const sessionId = url.pathname.slice('/upload/drive/v3/resumable-sessions/'.length);
      const session = resumableSessions.get(sessionId);
      if (!session) {
        return new Response('Unknown resumable upload session', { status: 404 });
      }
      const rawBytes = new Uint8Array(init?.body as Uint8Array);
      const putContentType = headers.get('content-type') ?? '';
      expect(putContentType).toBe(session.contentType);
      expect(rawBytes.byteLength).toBe(session.declaredLength);

      const fileName = String(session.metadata.name);
      const namedFailure = options?.failUploadNames?.[fileName];
      if (namedFailure) {
        return new Response(
          namedFailure.body ??
            JSON.stringify({ error: { message: `Forced upload error for ${fileName}` } }),
          { status: namedFailure.status, headers: { 'content-type': 'application/json' } },
        );
      }

      const recorded: RecordedMultipart = {
        method: session.method,
        uploadType: 'resumable',
        fileId: session.existingId,
        metadata: session.metadata,
        contentType: session.contentType,
        contentBytes: rawBytes,
        declaredContentLength: session.declaredLength,
      };
      await options?.onMultipartUpload?.(recorded);
      uploads.push(recorded);
      uploadOrder.push(fileName);
      resumableSessions.delete(sessionId);

      if (session.method === 'PATCH' && session.existingId) {
        expect(session.metadata.parents).toBeUndefined();
        const existing = files.get(session.existingId);
        if (!existing) {
          return new Response('Not found', { status: 404 });
        }
        existing.name = fileName;
        existing.mimeType = session.contentType;
        existing.content = rawBytes;
        if (session.metadata.appProperties) {
          existing.appProperties = {
            ...existing.appProperties,
            ...(session.metadata.appProperties as Record<string, string>),
          };
        }
        return new Response(
          JSON.stringify({
            id: existing.id,
            name: existing.name,
            mimeType: existing.mimeType,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      const created = addFile({
        name: fileName,
        mimeType: session.contentType,
        parents: (session.metadata.parents as string[]) ?? [],
        trashed: false,
        appProperties:
          (session.metadata.appProperties as Record<string, string>) ?? {},
        content: rawBytes,
      });
      return new Response(
        JSON.stringify({
          id: created.id,
          name: created.name,
          mimeType: created.mimeType,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Multipart or Resumable Step 1 create/update /upload/drive/v3/files(/:id)
    if (
      (method === 'POST' || method === 'PATCH') &&
      url.pathname.startsWith('/upload/drive/v3/files')
    ) {
      if (queuedFailures.length > 0) {
        const failure = queuedFailures.shift()!;
        const respHeaders: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (failure.retryAfter) {
          respHeaders['retry-after'] = failure.retryAfter;
        }
        return new Response(
          failure.body ?? JSON.stringify({ error: { message: 'Transient error' } }),
          { status: failure.status, headers: respHeaders },
        );
      }

      const uploadType = url.searchParams.get('uploadType');
      const isPatch = method === 'PATCH';
      const existingId = isPatch
        ? decodeURIComponent(url.pathname.slice('/upload/drive/v3/files/'.length))
        : undefined;

      if (uploadType === 'resumable') {
        const metadata = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        if (isPatch) {
          expect(metadata.parents).toBeUndefined();
        }
        const xContentType = headers.get('x-upload-content-type') ?? '';
        const xContentLength = Number(headers.get('x-upload-content-length') ?? 'NaN');
        expect(xContentType.length).toBeGreaterThan(0);
        expect(Number.isFinite(xContentLength)).toBe(true);

        const sessionId = `session-${++resumableSessionCounter}`;
        resumableSessions.set(sessionId, {
          method,
          existingId,
          metadata,
          contentType: xContentType,
          declaredLength: xContentLength,
        });
        return new Response('', {
          status: 200,
          headers: {
            Location: `${url.origin}/upload/drive/v3/resumable-sessions/${sessionId}`,
          },
        });
      }

      const rawBody = init?.body as Uint8Array;
      const parsed = parseMultipartBody(
        rawBody,
        headers.get('content-type') ?? '',
      );

      const fileName = String(parsed.metadata.name);
      const namedFailure = options?.failUploadNames?.[fileName];
      if (namedFailure) {
        return new Response(
          namedFailure.body ??
            JSON.stringify({ error: { message: `Forced upload error for ${fileName}` } }),
          { status: namedFailure.status, headers: { 'content-type': 'application/json' } },
        );
      }

      const recorded: RecordedMultipart = {
        method,
        uploadType: 'multipart',
        fileId: existingId,
        metadata: parsed.metadata,
        contentType: parsed.contentType,
        contentBytes: parsed.contentBytes,
      };
      await options?.onMultipartUpload?.(recorded);
      uploads.push(recorded);

      uploadOrder.push(fileName);

      if (isPatch && existingId) {
        // Drive v3 PATCH must NOT send `parents` in metadata.
        expect(parsed.metadata.parents).toBeUndefined();
        const existing = files.get(existingId);
        if (!existing) {
          return new Response('Not found', { status: 404 });
        }
        existing.name = fileName;
        existing.mimeType = parsed.contentType;
        existing.content = parsed.contentBytes;
        if (parsed.metadata.appProperties) {
          existing.appProperties = {
            ...existing.appProperties,
            ...(parsed.metadata.appProperties as Record<string, string>),
          };
        }
        return new Response(
          JSON.stringify({
            id: existing.id,
            name: existing.name,
            mimeType: existing.mimeType,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      const created = addFile({
        name: fileName,
        mimeType: parsed.contentType,
        parents: (parsed.metadata.parents as string[]) ?? [],
        trashed: false,
        appProperties:
          (parsed.metadata.appProperties as Record<string, string>) ?? {},
        content: parsed.contentBytes,
      });
      return new Response(
        JSON.stringify({
          id: created.id,
          name: created.name,
          mimeType: created.mimeType,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    throw new Error(`Unhandled mock Drive request: ${method} ${url.toString()}`);
  });

  return { fetchImpl, files, uploadOrder, uploads, queries, addFile };
}

function makeSamplePage(overrides?: Partial<ExtractedPage>): ExtractedPage {
  return {
    url: "https://example.com/posts/o'reilly-guide",
    title: 'Architecture Guide',
    author: 'Ada Lovelace',
    published: '2026-11-20',
    site: 'Example Blog',
    description: 'Deep dive',
    markdown:
      '# Intro\n\n![Hero](https://cdn.example.com/hero.webp)\n\n![Diagram](https://cdn.example.com/diagram.png)\n\n![Broken](https://cdn.example.com/missing.jpg)\n',
    mode: 'full',
    hasSelection: false,
    images: [],
    warnings: [],
    extractedAt: '2026-11-24T04:00:00.000Z',
    ...overrides,
  };
}

describe('DriveClient root folder management', () => {
  it('auto-creates WebClips root folder on first use, reuses moved/renamed folder by ID, and recreates if trashed or missing', async () => {
    const server = createFakeDriveServer();
    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
    });

    // 1. First use: creates WebClips folder.
    const created = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });
    expect(created.created).toBe(true);
    expect(created.folderName).toBe('WebClips');
    expect(created.folderUrl).toBe(
      `https://drive.google.com/drive/folders/${created.folderId}`,
    );

    // 2. User renames and moves folder in Drive -> ID lookup succeeds transparently.
    const stored = server.files.get(created.folderId)!;
    stored.name = 'My Reading Archive';
    stored.parents = ['some-other-parent'];

    const verified = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: created.folderId,
    });
    expect(verified.created).toBe(false);
    expect(verified.folderId).toBe(created.folderId);
    expect(verified.folderName).toBe('My Reading Archive');

    // 3. User trashes folder -> recreated cleanly with a new ID.
    stored.trashed = true;
    const recreated = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: created.folderId,
    });
    expect(recreated.created).toBe(true);
    expect(recreated.folderId).not.toBe(created.folderId);

    // 4. Stored ID deleted (404) -> recreated cleanly.
    server.files.delete(recreated.folderId);
    const recreatedAfter404 = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: recreated.folderId,
    });
    expect(recreatedAfter404.created).toBe(true);
    expect(recreatedAfter404.folderId).not.toBe(recreated.folderId);
  });
});

describe('DriveClient uploadArticle', () => {
  it('uploads ALL images with bounded concurrency strictly BEFORE README.md, rewrites Markdown links, and preserves failed image URLs + frontmatter warnings', async () => {
    let activeImageUploads = 0;
    let peakImageUploads = 0;
    let readmeStartedWhileImageInFlight = false;

    const server = createFakeDriveServer({
      onMultipartUpload: async (upload) => {
        const name = String(upload.metadata.name);
        if (name === 'README.md') {
          if (activeImageUploads > 0) {
            readmeStartedWhileImageInFlight = true;
          }
          return;
        }
        activeImageUploads += 1;
        peakImageUploads = Math.max(peakImageUploads, activeImageUploads);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeImageUploads -= 1;
      },
    });

    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    const fetchedImages: FetchedImage[] = Array.from({ length: 7 }, (_, i) => ({
      id: `img-${i + 1}`,
      originalUrl:
        i === 0
          ? 'https://cdn.example.com/hero.webp'
          : i === 1
            ? 'https://cdn.example.com/diagram.png'
            : `https://cdn.example.com/extra-${i + 1}.png`,
      resolvedUrl:
        i === 0
          ? 'https://cdn.example.com/hero.webp'
          : i === 1
            ? 'https://cdn.example.com/diagram.png'
            : `https://cdn.example.com/extra-${i + 1}.png`,
      sourceUrls: [
        i === 0
          ? 'https://cdn.example.com/hero.webp'
          : i === 1
            ? 'https://cdn.example.com/diagram.png'
            : `https://cdn.example.com/extra-${i + 1}.png`,
      ],
      filename:
        i === 0
          ? '01-hero.webp'
          : i === 1
            ? '02-diagram.png'
            : `0${i + 1}-extra.png`,
      mimeType: i === 0 ? 'image/webp' : 'image/png',
      bytes: i === 0 ? WEBP_BYTES : PNG_BYTES,
      byteLength: i === 0 ? WEBP_BYTES.byteLength : PNG_BYTES.byteLength,
    }));

    const failedImages: ImageFetchFailure[] = [
      {
        id: 'img-8',
        originalUrl: 'https://cdn.example.com/missing.jpg',
        resolvedUrl: 'https://cdn.example.com/missing.jpg',
        sourceUrls: ['https://cdn.example.com/missing.jpg'],
        reason: 'HTTP 404 Not Found',
        status: 404,
      },
    ];

    const result = await client.uploadArticle({
      rootFolderId: root.folderId,
      page: makeSamplePage(),
      fetchedImages,
      failedImages,
      tags: ['architecture', 'web-clip'],
      clippedAt: '2026-11-24T04:00:00.000Z',
    });

    expect(readmeStartedWhileImageInFlight).toBe(false);
    expect(peakImageUploads).toBeLessThanOrEqual(5);
    expect(peakImageUploads).toBeGreaterThan(1);

    // README.md MUST be strictly the last uploaded file.
    expect(server.uploadOrder).toHaveLength(8);
    expect(server.uploadOrder[server.uploadOrder.length - 1]).toBe('README.md');
    expect(server.uploadOrder.slice(0, 7).every((name) => name !== 'README.md')).toBe(
      true,
    );

    // Verify binary WebP bytes survived multipart upload intact.
    const webpUpload = server.uploads.find(
      (u) => u.metadata.name === '01-hero.webp',
    );
    expect(webpUpload?.contentType).toBe('image/webp');
    expect(Array.from(webpUpload?.contentBytes ?? [])).toEqual(Array.from(WEBP_BYTES));

    // Verify README.md content: rewritten local links + failed remote URL kept + warnings in frontmatter.
    const readmeUpload = server.uploads.find((u) => u.metadata.name === 'README.md');
    const readmeText = new TextDecoder().decode(readmeUpload!.contentBytes);
    expect(readmeText).toContain('![Hero](./images/01-hero.webp)');
    expect(readmeText).toContain('![Diagram](./images/02-diagram.png)');
    expect(readmeText).toContain('![Broken](https://cdn.example.com/missing.jpg)');
    expect(readmeText).toContain('warnings:');
    expect(readmeText).toContain('https://cdn.example.com/missing.jpg');

    expect(result.reusedFolder).toBe(false);
    expect(result.folderName).toBe('2026-11-24-architecture-guide');
    expect(result.folderUrl).toBe(
      `https://drive.google.com/drive/folders/${result.folderId}`,
    );
    expect(result.uploadedImages).toHaveLength(7);
    expect(result.warnings).toHaveLength(1);
  });

  it('reuses existing article folder via escaped appProperties.sourceUrl and updates existing files on re-clip', async () => {
    const server = createFakeDriveServer();
    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    const page = makeSamplePage();
    const img: FetchedImage = {
      id: 'img-1',
      originalUrl: 'https://cdn.example.com/hero.webp',
      resolvedUrl: 'https://cdn.example.com/hero.webp',
      sourceUrls: ['https://cdn.example.com/hero.webp'],
      filename: '01-hero.webp',
      mimeType: 'image/webp',
      bytes: WEBP_BYTES,
      byteLength: WEBP_BYTES.byteLength,
    };

    const first = await client.uploadArticle({
      rootFolderId: root.folderId,
      page,
      fetchedImages: [img],
      clippedAt: '2026-11-24T04:00:00.000Z',
    });

    const second = await client.uploadArticle({
      rootFolderId: root.folderId,
      page,
      fetchedImages: [img],
      clippedAt: '2026-11-24T04:05:00.000Z',
    });

    expect(first.reusedFolder).toBe(false);
    expect(second.reusedFolder).toBe(true);
    expect(second.folderId).toBe(first.folderId);
    expect(second.readmeFileId).toBe(first.readmeFileId);
    expect(second.uploadedImages[0].fileId).toBe(first.uploadedImages[0].fileId);

    // Second run must PATCH existing files instead of duplicating them.
    const secondRunUploads = server.uploads.slice(2);
    expect(secondRunUploads).toHaveLength(2);
    expect(secondRunUploads.every((u) => u.method === 'PATCH')).toBe(true);

    // Verify single quote in URL was properly escaped in the Drive `q` query.
    expect(
      server.queries.some((q) =>
        q.includes(escapeDriveQueryValue("https://example.com/posts/o'reilly-guide")),
      ),
    ).toBe(true);
  });

  it('retries HTTP 429 and 5xx with exponential backoff (respecting Retry-After) and fails cleanly on non-retryable 400', async () => {
    const sleepCalls: number[] = [];
    const server = createFakeDriveServer({
      failNextUploads: [
        { status: 429, retryAfter: '1' },
        { status: 503 },
        { status: 500 },
      ],
    });

    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      baseRetryDelayMs: 100,
      maxRetries: 4,
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    const result = await client.uploadArticle({
      rootFolderId: root.folderId,
      page: makeSamplePage({ markdown: '# Text only' }),
      fetchedImages: [],
    });

    expect(result.readmeFileId).toBeTruthy();
    // 1st failure: Retry-After: 1 -> 1000ms; 2nd: 100 * 2^1 = 200ms; 3rd: 100 * 2^2 = 400ms
    expect(sleepCalls).toEqual([1000, 200, 400]);

    // Non-retryable 400 must fail immediately without sleeping.
    const failingServer = createFakeDriveServer({
      failNextUploads: [{ status: 400, body: JSON.stringify({ error: { message: 'Bad request' } }) }],
    });
    const failingSleep = vi.fn(async () => undefined);
    const failingClient = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: failingServer.fetchImpl,
      tokenProvider: async () => 'test-token',
      sleep: failingSleep,
    });
    const root2 = await failingClient.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    await expect(
      failingClient.uploadArticle({
        rootFolderId: root2.folderId,
        page: makeSamplePage({ markdown: '# Text only' }),
        fetchedImages: [],
      }),
    ).rejects.toBeInstanceOf(DriveApiError);
    expect(failingSleep).not.toHaveBeenCalled();
  });

  it('hashes URLs exceeding Drive appProperties 124-byte limit deterministically while keeping short URLs verbatim', async () => {
    const shortUrl = 'https://example.com/posts/hello';
    expect(await encodeSourceUrlProperty(shortUrl)).toBe(shortUrl);

    const longUrl = `https://example.com/articles/${'very-long-segment-'.repeat(10)}end`;
    const encoded1 = await encodeSourceUrlProperty(longUrl);
    const encoded2 = await encodeSourceUrlProperty(longUrl);
    expect(encoded1).toBe(encoded2);
    expect(encoded1.startsWith('sha256:')).toBe(true);
    expect(new TextEncoder().encode(`sourceUrl${encoded1}`).byteLength).toBeLessThanOrEqual(
      124,
    );
  });

  it('refreshes a stale 401 token once via onUnauthorizedToken and fails cleanly if 401 persists', async () => {
    const invalidated: string[] = [];
    let tokenCalls = 0;

    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer stale-token') {
        return new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({ id: 'root-fresh', name: 'WebClips', mimeType: DRIVE_FOLDER_MIME_TYPE }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl,
      tokenProvider: async () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? 'stale-token' : 'fresh-token';
      },
      onUnauthorizedToken: async (tok) => {
        invalidated.push(tok);
      },
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });
    expect(root.folderId).toBe('root-fresh');
    expect(invalidated).toEqual(['stale-token']);
    expect(tokenCalls).toBe(2);

    // Persistent 401 must not loop forever.
    const always401Client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: vi.fn(async () => new Response('Unauthorized', { status: 401 })),
      tokenProvider: async () => 'bad-token',
      onUnauthorizedToken: vi.fn(async () => undefined),
    });

    await expect(
      always401Client.ensureRootFolder({
        rootFolderName: 'WebClips',
        rootFolderId: null,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
  });

  it('requests ONLY drive.file scope when using chrome.identity.getAuthToken', async () => {
    const getAuthTokenSpy = vi.fn(async () => ({ token: 'chrome-token' }));
    const originalChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      identity: { getAuthToken: getAuthTokenSpy },
    };

    try {
      const token = await getChromeDriveAuthToken({ interactive: true });
      expect(token).toBe('chrome-token');
      expect(getAuthTokenSpy).toHaveBeenCalledWith({
        interactive: true,
        scopes: [DRIVE_FILE_SCOPE],
      });
    } finally {
      if (originalChrome === undefined) {
        delete (globalThis as Record<string, unknown>).chrome;
      } else {
        (globalThis as Record<string, unknown>).chrome = originalChrome;
      }
    }
  });

  it('falls back to launchWebAuthFlow with strict drive.file scope and session caching when browser sign-in is disabled', async () => {
    const sessionStore: Record<string, unknown> = {};
    const rawRedirectUri = 'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org/';
    const expectedRedirectUri = 'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org';
    const getAuthTokenSpy = vi.fn(async () => {
      throw new Error('The user turned off browser signin');
    });
    const launchWebAuthFlowSpy = vi.fn(
      async (details: chrome.identity.WebAuthFlowDetails) => {
        const parsed = new URL(details.url);
        expect(parsed.origin + parsed.pathname).toBe(
          'https://accounts.google.com/o/oauth2/v2/auth',
        );
        expect(parsed.searchParams.get('client_id')).toBe(
          '123456-webapp.apps.googleusercontent.com',
        );
        expect(parsed.searchParams.get('response_type')).toBe('token');
        expect(parsed.searchParams.get('redirect_uri')).toBe(expectedRedirectUri);
        expect(parsed.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
        expect(parsed.searchParams.get('include_granted_scopes')).toBeNull();
        const state = parsed.searchParams.get('state');
        expect(state).toBeTruthy();
        return `${rawRedirectUri}#access_token=webauth-tok-1&expires_in=3600&token_type=Bearer&state=${encodeURIComponent(state!)}`;
      },
    );
    const clearAllSpy = vi.fn(async () => {
      throw new Error('Not available without Chrome Sync');
    });

    const originalChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        getManifest: () => ({
          oauth2: {
            client_id: '123456-webapp.apps.googleusercontent.com',
            scopes: [DRIVE_FILE_SCOPE],
          },
        }),
      },
      identity: {
        getAuthToken: getAuthTokenSpy,
        getRedirectURL: () => rawRedirectUri,
        launchWebAuthFlow: launchWebAuthFlowSpy,
        removeCachedAuthToken: vi.fn(async () => undefined),
        clearAllCachedAuthTokens: clearAllSpy,
      },
      storage: {
        session: {
          get: async (key: string) =>
            key in sessionStore ? { [key]: sessionStore[key] } : {},
          set: async (items: Record<string, unknown>) => {
            Object.assign(sessionStore, items);
          },
          remove: async (key: string) => {
            delete sessionStore[key];
          },
        },
      },
    };

    try {
      await clearAllCachedChromeAuthTokens();

      // Non-interactive check before sign-in must NOT launch a popup or fallback flow.
      await expect(
        getChromeDriveAuthToken({ interactive: false }),
      ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
      expect(launchWebAuthFlowSpy).not.toHaveBeenCalled();

      // Interactive sign-in falls back to launchWebAuthFlow and caches token in chrome.storage.session.
      const token1 = await getChromeDriveAuthToken({ interactive: true });
      expect(token1).toBe('webauth-tok-1');
      expect(launchWebAuthFlowSpy).toHaveBeenCalledTimes(1);

      // Subsequent non-interactive check reuses cached session token cleanly.
      const token2 = await getChromeDriveAuthToken({ interactive: false });
      expect(token2).toBe('webauth-tok-1');
      expect(launchWebAuthFlowSpy).toHaveBeenCalledTimes(1);

      // Removing cached token invalidates the session cache (used on HTTP 401 refresh).
      await removeCachedChromeAuthToken('webauth-tok-1');
      await expect(
        getChromeDriveAuthToken({ interactive: false }),
      ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });

      // clearAllCachedChromeAuthTokens survives Chromium throwing on clearAllCachedAuthTokens().
      await expect(clearAllCachedChromeAuthTokens()).resolves.toBeUndefined();
    } finally {
      await clearAllCachedChromeAuthTokens();
      if (originalChrome === undefined) {
        delete (globalThis as Record<string, unknown>).chrome;
      } else {
        (globalThis as Record<string, unknown>).chrome = originalChrome;
      }
    }
  });

  it('rejects launchWebAuthFlow CSRF state mismatch and does not fall back when user cancels getAuthToken', async () => {
    const authUrl = buildGoogleWebAuthUrl({
      clientId: '123456-webapp.apps.googleusercontent.com',
      redirectUri: 'https://abc.chromiumapp.org/',
      state: 'expected-nonce',
    });
    expect(new URL(authUrl).searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);

    expect(() =>
      parseWebAuthFlowRedirect(
        'https://abc.chromiumapp.org/#access_token=tok&state=wrong-nonce',
        'expected-nonce',
      ),
    ).toThrow(/state/i);

    expect(() =>
      parseWebAuthFlowRedirect(
        'https://abc.chromiumapp.org/#error=access_denied&error_description=User+cancelled',
        'expected-nonce',
      ),
    ).toThrow(/access_denied/i);

    expect(shouldFallbackToWebAuthFlow('The user turned off browser signin')).toBe(true);
    expect(shouldFallbackToWebAuthFlow('The user did not approve access.')).toBe(false);
    expect(shouldFallbackToWebAuthFlow('User canceled the sign-in flow')).toBe(false);

    const launchWebAuthFlowSpy = vi.fn();
    const originalChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        getManifest: () => ({
          oauth2: { client_id: '123456-webapp.apps.googleusercontent.com' },
        }),
      },
      identity: {
        getAuthToken: vi.fn(async () => {
          throw new Error('The user did not approve access.');
        }),
        getRedirectURL: () => 'https://abc.chromiumapp.org/',
        launchWebAuthFlow: launchWebAuthFlowSpy,
      },
    };

    try {
      await clearAllCachedChromeAuthTokens();
      await expect(
        getChromeDriveAuthToken({ interactive: true }),
      ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
      expect(launchWebAuthFlowSpy).not.toHaveBeenCalled();
    } finally {
      if (originalChrome === undefined) {
        delete (globalThis as Record<string, unknown>).chrome;
      } else {
        (globalThis as Record<string, unknown>).chrome = originalChrome;
      }
    }
  });

  it('prefers webAuthClientId over manifest oauth2.client_id during launchWebAuthFlow fallback', async () => {
    expect(
      resolveWebAuthClientId({
        webAuthClientId: '111-web.apps.googleusercontent.com',
        manifestClientId: '222-ext.apps.googleusercontent.com',
      }),
    ).toBe('111-web.apps.googleusercontent.com');

    expect(
      resolveWebAuthClientId({
        webAuthClientId: '',
        manifestClientId: '222-ext.apps.googleusercontent.com',
      }),
    ).toBe('222-ext.apps.googleusercontent.com');

    expect(
      resolveWebAuthClientId({
        webAuthClientId: 'YOUR_PLACEHOLDER.apps.googleusercontent.com',
        manifestClientId: '222-ext.apps.googleusercontent.com',
      }),
    ).toBe('222-ext.apps.googleusercontent.com');

    expect(
      resolveWebAuthClientId({
        webAuthClientId: '',
        manifestClientId: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com',
      }),
    ).toBeNull();

    const rawRedirectUri = 'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org/';
    const seenClientIds: string[] = [];
    const originalChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        getManifest: () => ({
          oauth2: {
            client_id: '222-chromeext.apps.googleusercontent.com',
            scopes: [DRIVE_FILE_SCOPE],
          },
        }),
      },
      identity: {
        getAuthToken: vi.fn(async () => {
          throw new Error('The user turned off browser signin');
        }),
        getRedirectURL: () => rawRedirectUri,
        launchWebAuthFlow: vi.fn(
          async (details: chrome.identity.WebAuthFlowDetails) => {
            const parsed = new URL(details.url);
            seenClientIds.push(parsed.searchParams.get('client_id') ?? '');
            const state = parsed.searchParams.get('state')!;
            return `${rawRedirectUri}#access_token=dual-client-token&expires_in=3600&state=${encodeURIComponent(state)}`;
          },
        ),
      },
    };

    try {
      await clearAllCachedChromeAuthTokens();
      const token = await getChromeDriveAuthToken({
        interactive: true,
        webAuthClientId: '111-webapp.apps.googleusercontent.com',
      });
      expect(token).toBe('dual-client-token');
      expect(seenClientIds).toEqual(['111-webapp.apps.googleusercontent.com']);
    } finally {
      await clearAllCachedChromeAuthTokens();
      if (originalChrome === undefined) {
        delete (globalThis as Record<string, unknown>).chrome;
      } else {
        (globalThis as Record<string, unknown>).chrome = originalChrome;
      }
    }
  });

  it('automatically switches files > 4.5 MiB to uploadType=resumable (both POST create and PATCH update) while keeping <= 4.5 MiB on multipart', async () => {
    const server = createFakeDriveServer();
    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    const largeBytes = new Uint8Array(MULTIPART_UPLOAD_MAX_BYTES + 1024);
    largeBytes.set(PNG_BYTES, 0);
    largeBytes[largeBytes.byteLength - 1] = 0x7f;

    const smallBytes = new Uint8Array(PNG_BYTES);

    const fetchedImages: FetchedImage[] = [
      {
        id: 'img-large',
        originalUrl: 'https://cdn.example.com/hero.webp',
        resolvedUrl: 'https://cdn.example.com/hero.webp',
        sourceUrls: ['https://cdn.example.com/hero.webp'],
        filename: '01-hero-hires.png',
        mimeType: 'image/png',
        bytes: largeBytes,
        byteLength: largeBytes.byteLength,
      },
      {
        id: 'img-small',
        originalUrl: 'https://cdn.example.com/diagram.png',
        resolvedUrl: 'https://cdn.example.com/diagram.png',
        sourceUrls: ['https://cdn.example.com/diagram.png'],
        filename: '02-diagram.png',
        mimeType: 'image/png',
        bytes: smallBytes,
        byteLength: smallBytes.byteLength,
      },
    ];

    // Run 1: POST create (large -> resumable, small -> multipart, README -> multipart)
    const first = await client.uploadArticle({
      rootFolderId: root.folderId,
      page: makeSamplePage(),
      fetchedImages,
      clippedAt: '2026-11-24T04:00:00.000Z',
    });

    const firstLarge = server.uploads.find(
      (u) => u.metadata.name === '01-hero-hires.png',
    );
    const firstSmall = server.uploads.find(
      (u) => u.metadata.name === '02-diagram.png',
    );
    expect(firstLarge?.uploadType).toBe('resumable');
    expect(firstLarge?.method).toBe('POST');
    expect(firstLarge?.declaredContentLength).toBe(largeBytes.byteLength);
    expect(firstLarge?.contentBytes.byteLength).toBe(largeBytes.byteLength);
    expect(firstLarge?.contentBytes[0]).toBe(PNG_BYTES[0]);
    expect(firstLarge?.contentBytes[largeBytes.byteLength - 1]).toBe(0x7f);
    expect(firstSmall?.uploadType).toBe('multipart');
    expect(first.uploadedImages).toHaveLength(2);
    expect(first.readmeFileId).toBeTruthy();

    // Run 2: PATCH update reuses file IDs via resumable PATCH for the >4.5 MiB image.
    const second = await client.uploadArticle({
      rootFolderId: root.folderId,
      page: makeSamplePage(),
      fetchedImages,
      clippedAt: '2026-11-24T04:10:00.000Z',
    });

    const secondLarge = server.uploads
      .slice(3)
      .find((u) => u.metadata.name === '01-hero-hires.png');
    expect(secondLarge?.uploadType).toBe('resumable');
    expect(secondLarge?.method).toBe('PATCH');
    expect(secondLarge?.fileId).toBe(first.uploadedImages[0].fileId);
    expect(second.uploadedImages[0].fileId).toBe(first.uploadedImages[0].fileId);
  });

  it('degrades gracefully on single-image Drive upload errors so README.md ALWAYS uploads with remote URL fallback and warning, while still aborting on 401/AbortError', async () => {
    const server = createFakeDriveServer({
      failUploadNames: {
        '02-diagram.png': {
          status: 400,
          body: JSON.stringify({ error: { message: 'Invalid image payload' } }),
        },
      },
    });

    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
      sleep: async () => undefined,
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    const fetchedImages: FetchedImage[] = [
      {
        id: 'img-1',
        originalUrl: 'https://cdn.example.com/hero.webp',
        resolvedUrl: 'https://cdn.example.com/hero.webp',
        sourceUrls: ['https://cdn.example.com/hero.webp'],
        filename: '01-hero.webp',
        mimeType: 'image/webp',
        bytes: WEBP_BYTES,
        byteLength: WEBP_BYTES.byteLength,
      },
      {
        id: 'img-2',
        originalUrl: 'https://cdn.example.com/diagram.png',
        resolvedUrl: 'https://cdn.example.com/diagram.png',
        sourceUrls: ['https://cdn.example.com/diagram.png'],
        filename: '02-diagram.png',
        mimeType: 'image/png',
        bytes: PNG_BYTES,
        byteLength: PNG_BYTES.byteLength,
      },
    ];

    const result = await client.uploadArticle({
      rootFolderId: root.folderId,
      page: makeSamplePage(),
      fetchedImages,
      clippedAt: '2026-11-24T04:00:00.000Z',
    });

    // README.md MUST still be uploaded even though 02-diagram.png failed!
    expect(result.readmeFileId).toBeTruthy();
    expect(server.uploadOrder).toEqual(['01-hero.webp', 'README.md']);
    expect(result.uploadedImages).toHaveLength(1);
    expect(result.uploadedImages[0].filename).toBe('01-hero.webp');
    expect(result.failedImages).toHaveLength(1);
    expect(result.failedImages[0].resolvedUrl).toBe('https://cdn.example.com/diagram.png');
    expect(result.failedImages[0].reason).toMatch(/Drive upload failed/i);
    expect(result.failedImages[0].status).toBe(400);

    const readmeUpload = server.uploads.find((u) => u.metadata.name === 'README.md');
    const readmeText = new TextDecoder().decode(readmeUpload!.contentBytes);
    expect(readmeText).toContain('![Hero](./images/01-hero.webp)');
    // Failed upload keeps original remote URL instead of a broken ./images/ link!
    expect(readmeText).toContain('![Diagram](https://cdn.example.com/diagram.png)');
    expect(readmeText).not.toContain('./images/02-diagram.png');
    expect(readmeText).toContain('warnings:');
    expect(readmeText).toContain('Image upload failed for https://cdn.example.com/diagram.png');

    // Auth error (401) during image upload MUST still abort without uploading README.md.
    const authFailServer = createFakeDriveServer({
      failUploadNames: {
        '02-diagram.png': {
          status: 401,
          body: JSON.stringify({ error: { message: 'Invalid Credentials' } }),
        },
      },
    });
    const authFailClient = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: authFailServer.fetchImpl,
      tokenProvider: async () => 'expired-token',
    });
    const root2 = await authFailClient.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    await expect(
      authFailClient.uploadArticle({
        rootFolderId: root2.folderId,
        page: makeSamplePage(),
        fetchedImages,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(authFailServer.uploadOrder).not.toContain('README.md');
  });

  it('deduplicates re-clipped images by appProperties.imageUrl even if a filename index shifts', async () => {
    const server = createFakeDriveServer();
    const client = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: server.fetchImpl,
      tokenProvider: async () => 'test-token',
    });

    const root = await client.ensureRootFolder({
      rootFolderName: 'WebClips',
      rootFolderId: null,
    });

    const page = makeSamplePage();
    const run1Img: FetchedImage = {
      id: 'img-2',
      originalUrl: 'https://cdn.example.com/hero.webp',
      resolvedUrl: 'https://cdn.example.com/hero.webp',
      sourceUrls: ['https://cdn.example.com/hero.webp'],
      filename: '02-v2-e5c7.webp',
      mimeType: 'image/webp',
      bytes: WEBP_BYTES,
      byteLength: WEBP_BYTES.byteLength,
    };

    const first = await client.uploadArticle({
      rootFolderId: root.folderId,
      page,
      fetchedImages: [run1Img],
    });

    // Simulate index shifting from 02 -> 03 on Run 2 for the same image URL.
    const run2Img: FetchedImage = {
      ...run1Img,
      id: 'img-3',
      filename: '03-v2-e5c7.webp',
    };

    const second = await client.uploadArticle({
      rootFolderId: root.folderId,
      page,
      fetchedImages: [run2Img],
    });

    // Must PATCH the existing file ID in place instead of creating a duplicate file!
    expect(second.uploadedImages[0].fileId).toBe(first.uploadedImages[0].fileId);
    const imagesInDrive = Array.from(server.files.values()).filter(
      (f) => f.mimeType === 'image/webp',
    );
    expect(imagesInDrive).toHaveLength(1);
    expect(imagesInDrive[0].name).toBe('03-v2-e5c7.webp');
  });
});
