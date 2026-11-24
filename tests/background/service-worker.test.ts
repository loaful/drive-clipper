import { describe, expect, it, vi } from 'vitest';
import type { DeclarativeNetRequestLike } from '../../src/background/image-fetcher.js';
import {
  CONTEXT_MENU_CLIP_SELECTION_ID,
  MAX_CLIP_HISTORY_ITEMS,
  MAX_CLIP_JOBS,
  ORPHANED_JOB_ERROR_MESSAGE,
  createServiceWorkerController,
} from '../../src/background/service-worker.js';
import {
  DRIVE_FOLDER_MIME_TYPE,
  DriveClient,
  type UploadArticleParams,
} from '../../src/drive/drive-client.js';
import {
  OAUTH_CLIENT_ID_PLACEHOLDER,
  STORAGE_KEYS,
  type BackgroundPushMessage,
  type ClipJob,
  type ClipProgressEvent,
  type ClipResult,
  type ContentRequestMessage,
  type ContentResponseMessage,
  type DiscoveredImage,
  type ExtractedPage,
} from '../../src/types.js';

function createMemoryStorage() {
  const store: Record<string, unknown> = {};
  return {
    store,
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (!keys) {
        return { ...store };
      }
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: store[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const result: Record<string, unknown> = {};
        for (const k of keys) {
          if (k in store) result[k] = store[k];
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const [k, fallback] of Object.entries(keys)) {
        result[k] = k in store ? store[k] : fallback;
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
  };
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function makeExtractedPage(url = 'https://blog.example.com/post-1'): ExtractedPage {
  return {
    url,
    title: 'Sample Post',
    author: 'Grace Hopper',
    published: '2026-11-20',
    site: 'Example Blog',
    description: null,
    markdown: 'Hello ![pic](https://cdn.example.com/pic.png)',
    mode: 'full',
    hasSelection: true,
    images: [
      {
        id: 'img-01',
        originalUrl: 'https://cdn.example.com/pic.png',
        resolvedUrl: 'https://cdn.example.com/pic.png',
        sourceUrls: ['https://cdn.example.com/pic.png'],
        alt: 'pic',
        suggestedName: '01-pic',
      },
    ],
    warnings: [],
    extractedAt: '2026-11-24T04:00:00.000Z',
  };
}

function makeConfiguredManifest(
  clientId = '123456-realclient.apps.googleusercontent.com',
): chrome.runtime.Manifest {
  return {
    manifest_version: 3,
    name: 'Drive Clipper',
    version: '0.1.0',
    oauth2: {
      client_id: clientId,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    },
  };
}

describe('service-worker controller', () => {
  it('orchestrates executeScript -> extract -> fetchImages -> uploadArticle, emits ordered ClipProgressEvents, and caps clip history to 10', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const pushEvents: ClipProgressEvent[] = [];
    const jobSnapshots: ClipJob[][] = [];
    const executedInjections: chrome.scripting.ScriptInjection<unknown[], unknown>[] = [];
    const sentContentMessages: ContentRequestMessage[] = [];

    let clipCounter = 0;
    const driveClient = {
      ensureRootFolder: vi.fn(async ({ rootFolderName, rootFolderId }) => ({
        folderId: rootFolderId ?? 'root-1',
        folderName: rootFolderName,
        folderUrl: `https://drive.google.com/drive/folders/${rootFolderId ?? 'root-1'}`,
        created: !rootFolderId,
      })),
      uploadArticle: vi.fn(async (params: UploadArticleParams) => {
        clipCounter += 1;
        params.onProgress?.(0, params.fetchedImages.length + 1);
        params.onProgress?.(params.fetchedImages.length, params.fetchedImages.length + 1);
        params.onProgress?.(
          params.fetchedImages.length + 1,
          params.fetchedImages.length + 1,
        );
        const result: ClipResult = {
          folderId: `article-folder-${clipCounter}`,
          folderUrl: `https://drive.google.com/drive/folders/article-folder-${clipCounter}`,
          folderName: `2026-11-24-post-${clipCounter}`,
          readmeFileId: `readme-${clipCounter}`,
          title: params.title ?? params.page.title,
          sourceUrl: params.page.url,
          clippedAt: params.clippedAt ?? '2026-11-24T04:00:00.000Z',
          uploadedImages: params.fetchedImages.map((img) => ({
            id: img.id,
            filename: img.filename,
            fileId: `file-${img.id}`,
            mimeType: img.mimeType,
            resolvedUrl: img.resolvedUrl,
          })),
          failedImages: [...(params.failedImages ?? [])],
          warnings: [],
          reusedFolder: false,
        };
        return result;
      }),
      updateBundleIndexAndLog: vi.fn(async () => ({
        indexFileId: 'idx-1',
        logFileId: 'log-1',
      })),
    } as unknown as DriveClient;

    const controller = createServiceWorkerController({
      driveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'valid-token',
      tabs: {
        query: async () => [
          { id: 7, url: 'https://blog.example.com/post-1' } as chrome.tabs.Tab,
        ],
        get: async (tabId) =>
          ({ id: tabId, url: `https://blog.example.com/post-${tabId}` }) as chrome.tabs.Tab,
        sendMessage: async (_tabId, message): Promise<ContentResponseMessage> => {
          sentContentMessages.push(message);
          if (message.type === 'CONTENT_GET_PAGE_INFO') {
            return {
              ok: true,
              type: 'CONTENT_PAGE_INFO',
              data: {
                url: 'https://blog.example.com/post-1',
                title: 'Sample Post',
                hasSelection: true,
                selectionLength: 42,
                site: 'Example Blog',
              },
            };
          }
          return {
            ok: true,
            type: 'CONTENT_EXTRACTED_PAGE',
            data: makeExtractedPage(),
          };
        },
      },
      scripting: {
        executeScript: async (injection) => {
          executedInjections.push(injection);
          return [];
        },
      },
      fetchImagesImpl: vi.fn(async (images: readonly DiscoveredImage[], _pageUrl, opts) => {
        opts?.onProgress?.(1, images.length);
        return {
          succeeded: images.map((img) => ({
            id: img.id,
            originalUrl: img.originalUrl,
            resolvedUrl: img.resolvedUrl,
            sourceUrls: img.sourceUrls,
            filename: `${img.suggestedName}.png`,
            mimeType: 'image/png',
            bytes: PNG_BYTES,
            byteLength: PNG_BYTES.byteLength,
          })),
          failed: [],
        };
      }),
      emitPushMessage: async (msg: BackgroundPushMessage) => {
        if (msg.type === 'CLIP_PROGRESS') {
          pushEvents.push(msg.event);
        } else if (msg.type === 'CLIP_JOBS_UPDATED') {
          jobSnapshots.push(msg.jobs);
        }
      },
      createClipId: () => `clip-test-id-${clipCounter + 1}`,
    });

    const response = await controller.handleMessage({
      type: 'START_CLIP',
      request: { mode: 'full', tags: ['tech'] },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const acceptedJob = response.data as ClipJob;
      expect(acceptedJob.status).toBe('queued');
      expect(acceptedJob.title).toBe('Sample Post');
    }

    await controller.whenIdle();

    expect(executedInjections).toHaveLength(1);
    expect(executedInjections[0]).toEqual({
      target: { tabId: 7 },
      files: ['content.js'],
    });
    expect(sentContentMessages).toEqual([
      { type: 'CONTENT_EXTRACT_PAGE', mode: 'full' },
    ]);

    // Verify structured progress sequence: extracting -> downloading -> uploading -> done
    const stages = pushEvents.map((e) => e.stage);
    expect(stages[0]).toBe('extracting');
    expect(stages).toContain('downloading');
    expect(stages).toContain('uploading');
    expect(stages[stages.length - 1]).toBe('done');

    // Verify live job snapshot transitions: extracting -> queued -> downloading -> uploading -> done
    const observedStatuses = jobSnapshots.map((snapshot) => snapshot[0]?.status);
    expect(observedStatuses).toContain('extracting');
    expect(observedStatuses).toContain('queued');
    expect(observedStatuses).toContain('downloading');
    expect(observedStatuses).toContain('uploading');
    expect(observedStatuses[observedStatuses.length - 1]).toBe('done');

    // Root folder ID persisted in chrome.storage.sync.
    const savedSettings = await controller.getSettings();
    expect(savedSettings.rootFolderId).toBe('root-1');

    // Clip 11 more times -> history must stay capped at MAX_CLIP_HISTORY_ITEMS (10), newest first.
    for (let i = 0; i < 11; i += 1) {
      const res = await controller.runClip({ mode: 'full' });
      expect(res.ok).toBe(true);
    }

    const history = await controller.getHistory();
    expect(history).toHaveLength(MAX_CLIP_HISTORY_ITEMS);
    expect(history[0].folderId).toBe('article-folder-12');
    expect(history[history.length - 1].folderId).toBe('article-folder-3');
  });

  it('handles unconfigured OAuth placeholder, auth status, sign-out token revocation, and Options root-folder reset', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();

    // 1. Placeholder client_id reports oauthConfigured: false cleanly.
    const unconfiguredController = createServiceWorkerController({
      storageSync: syncStorage,
      storageLocal: localStorage,
      getManifest: () => makeConfiguredManifest(OAUTH_CLIENT_ID_PLACEHOLDER),
    });

    const unconfiguredAuth = await unconfiguredController.handleMessage({
      type: 'GET_AUTH_STATUS',
    });
    expect(unconfiguredAuth).toEqual({
      ok: true,
      data: { oauthConfigured: false, authenticated: false },
    });

    const blockedClip = await unconfiguredController.handleMessage({
      type: 'START_CLIP',
      request: { mode: 'full' },
    });
    expect(blockedClip.ok).toBe(false);
    if (!blockedClip.ok) {
      expect(blockedClip.code).toBe('OAUTH_NOT_CONFIGURED');
    }

    // 2. Configured OAuth: sign-out revokes cached token and clears cache; ENSURE_ROOT_FOLDER persists new folder.
    const revokeSpy = vi.fn(async () => undefined);
    const clearCacheSpy = vi.fn(async () => undefined);
    let rootCount = 0;
    const driveClient = {
      ensureRootFolder: vi.fn(async ({ rootFolderName, forceNew }) => {
        rootCount += 1;
        return {
          folderId: `root-${rootCount}`,
          folderName: rootFolderName,
          folderUrl: `https://drive.google.com/drive/folders/root-${rootCount}`,
          created: Boolean(forceNew || rootCount === 1),
        };
      }),
    } as unknown as DriveClient;

    const controller = createServiceWorkerController({
      driveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'cached-access-token',
      revokeAuthToken: revokeSpy,
      clearAllCachedAuthTokens: clearCacheSpy,
    });

    const signOutRes = await controller.handleMessage({ type: 'SIGN_OUT' });
    expect(signOutRes).toEqual({
      ok: true,
      data: { oauthConfigured: true, authenticated: false },
    });
    expect(revokeSpy).toHaveBeenCalledWith('cached-access-token');
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);

    const resetRootRes = await controller.handleMessage({
      type: 'ENSURE_ROOT_FOLDER',
      folderName: 'ResearchClips',
      forceNew: true,
    });
    expect(resetRootRes).toEqual({
      ok: true,
      data: {
        folderId: 'root-1',
        folderName: 'ResearchClips',
        folderUrl: 'https://drive.google.com/drive/folders/root-1',
        created: true,
      },
    });

    const settings = await controller.getSettings();
    expect(settings.rootFolderName).toBe('ResearchClips');
    expect(settings.rootFolderId).toBe('root-1');
  });

  it('triggers selection-mode clip from the context menu and sets badge feedback', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const badgeCalls: Array<[string, string]> = [];
    const sentMessages: ContentRequestMessage[] = [];

    const driveClient = {
      ensureRootFolder: vi.fn(async () => ({
        folderId: 'root-1',
        folderName: 'WebClips',
        folderUrl: 'https://drive.google.com/drive/folders/root-1',
        created: false,
      })),
      uploadArticle: vi.fn(async (params) => ({
        folderId: 'sel-folder',
        folderUrl: 'https://drive.google.com/drive/folders/sel-folder',
        folderName: '2026-11-24-selection',
        readmeFileId: 'readme-sel',
        title: params.page.title,
        sourceUrl: params.page.url,
        clippedAt: '2026-11-24T04:00:00.000Z',
        uploadedImages: [],
        failedImages: [],
        warnings: [],
        reusedFolder: false,
      })),
      updateBundleIndexAndLog: vi.fn(async () => ({
        indexFileId: 'idx-sel',
        logFileId: 'log-sel',
      })),
    } as unknown as DriveClient;

    const controller = createServiceWorkerController({
      driveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'tok',
      tabs: {
        query: async () => [],
        get: async (tabId) =>
          ({ id: tabId, url: 'https://docs.example.com/spec' }) as chrome.tabs.Tab,
        sendMessage: async (_tabId, msg): Promise<ContentResponseMessage> => {
          sentMessages.push(msg);
          return {
            ok: true,
            type: 'CONTENT_EXTRACTED_PAGE',
            data: { ...makeExtractedPage('https://docs.example.com/spec'), mode: 'selection', images: [] },
          };
        },
      },
      scripting: {
        executeScript: async () => [],
      },
      fetchImagesImpl: async () => ({ succeeded: [], failed: [] }),
      emitPushMessage: async () => undefined,
      setBadge: async (text, color) => {
        badgeCalls.push([text, color]);
      },
    });

    await controller.handleContextMenuClick(
      { menuItemId: CONTEXT_MENU_CLIP_SELECTION_ID },
      { id: 99, url: 'https://docs.example.com/spec' },
    );

    expect(sentMessages).toEqual([
      { type: 'CONTENT_EXTRACT_PAGE', mode: 'selection' },
    ]);
    expect(badgeCalls).toEqual([
      ['1', '#2563eb'],
      ['OK', '#16a34a'],
    ]);
  });

  it('rejects unsupported non-http(s) tabs (e.g. chrome://extensions) cleanly', async () => {
    const controller = createServiceWorkerController({
      storageSync: createMemoryStorage(),
      storageLocal: createMemoryStorage(),
      getManifest: () => makeConfiguredManifest(),
      tabs: {
        query: async () => [
          { id: 1, url: 'chrome://extensions' } as chrome.tabs.Tab,
        ],
        get: async () => ({ id: 1, url: 'chrome://extensions' }) as chrome.tabs.Tab,
        sendMessage: vi.fn(),
      },
      scripting: { executeScript: vi.fn() },
    });

    const infoRes = await controller.handleMessage({ type: 'GET_PAGE_INFO' });
    expect(infoRes.ok).toBe(false);
    if (!infoRes.ok) {
      expect(infoRes.code).toBe('UNSUPPORTED_PAGE');
    }
  });

  it('refreshes a stale 401 token via chrome.identity.removeCachedAuthToken under default production wiring', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    let tokenIndex = 0;
    const tokens = ['stale-sw-token', 'fresh-sw-token'];

    const getAuthTokenSpy = vi.fn(async () => ({
      token: tokens[Math.min(tokenIndex++, tokens.length - 1)],
    }));
    const removeCachedAuthTokenSpy = vi.fn(async () => undefined);

    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer stale-sw-token') {
        return new Response(
          JSON.stringify({ error: { message: 'Invalid Credentials' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      if (auth === 'Bearer fresh-sw-token') {
        return new Response(
          JSON.stringify({ id: 'root-after-refresh', name: 'WebClips' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected auth header: ${auth}`);
    });

    const originalChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).chrome = {
      identity: {
        getAuthToken: getAuthTokenSpy,
        removeCachedAuthToken: removeCachedAuthTokenSpy,
      },
    };

    try {
      // Omit both `driveClient` and `getAuthToken` to exercise default production wiring.
      const controller = createServiceWorkerController({
        fetchImpl,
        storageSync: syncStorage,
        storageLocal: localStorage,
        getManifest: () => makeConfiguredManifest(),
      });

      const res = await controller.handleMessage({
        type: 'ENSURE_ROOT_FOLDER',
        folderName: 'WebClips',
      });

      expect(res).toEqual({
        ok: true,
        data: {
          folderId: 'root-after-refresh',
          folderName: 'WebClips',
          folderUrl: 'https://drive.google.com/drive/folders/root-after-refresh',
          created: true,
        },
      });
      expect(removeCachedAuthTokenSpy).toHaveBeenCalledWith({
        token: 'stale-sw-token',
      });
      expect(getAuthTokenSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (originalChrome === undefined) {
        delete (globalThis as Record<string, unknown>).chrome;
      } else {
        (globalThis as Record<string, unknown>).chrome = originalChrome;
      }
    }
  });

  it('queues 5 concurrent tab clips with maxConcurrentJobs=2, single-flight ensureRootFolder, isolated DNR rules, tab-close resilience, storage.session persistence, and aggregate badge lifecycle', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    const badgeCalls: Array<[string, string]> = [];
    const jobSnapshots: ClipJob[][] = [];

    const activeDnrRules = new Map<number, chrome.declarativeNetRequest.Rule>();
    const observedDnrOverlaps: chrome.declarativeNetRequest.Rule[][] = [];
    const dnr: DeclarativeNetRequestLike = {
      async getSessionRules() {
        return Array.from(activeDnrRules.values());
      },
      async updateSessionRules(options) {
        if (options.removeRuleIds) {
          for (const id of options.removeRuleIds) {
            activeDnrRules.delete(id);
          }
        }
        if (options.addRules) {
          for (const rule of options.addRules) {
            if (activeDnrRules.has(rule.id)) {
              throw new Error(`DNR rule ID collision: ${rule.id}`);
            }
            activeDnrRules.set(rule.id, rule);
          }
        }
      },
    };

    let tabsClosed = false;
    let activeWorkers = 0;
    let peakActiveWorkers = 0;
    let maxSimultaneousQueued = 0;
    let rootFolderCalls = 0;
    let clipSeq = 0;

    // Gate first two fetches until all 5 START_CLIP calls have returned so queue depth reaches 5.
    let releaseDownloads!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownloads = resolve;
    });

    const fetchImpl: typeof fetch = vi.fn(async () => {
      observedDnrOverlaps.push(Array.from(activeDnrRules.values()));
      await downloadGate;
      await new Promise((r) => setTimeout(r, 15));
      const copy = new Uint8Array(PNG_BYTES.byteLength);
      copy.set(PNG_BYTES);
      return new Response(copy, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(copy.byteLength),
        },
      });
    });

    const driveClient = {
      ensureRootFolder: vi.fn(async ({ rootFolderName }) => {
        rootFolderCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          folderId: 'root-single-flight',
          folderName: rootFolderName,
          folderUrl: 'https://drive.google.com/drive/folders/root-single-flight',
          created: true,
        };
      }),
      uploadArticle: vi.fn(async (params: UploadArticleParams) => {
        activeWorkers += 1;
        peakActiveWorkers = Math.max(peakActiveWorkers, activeWorkers);
        await new Promise((r) => setTimeout(r, 15));
        activeWorkers -= 1;

        const folderId = `folder-${params.page.url.split('/').pop()}`;
        return {
          folderId,
          folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
          folderName: params.folderName ?? '2026-11-24-article',
          readmeFileId: `readme-${folderId}`,
          title: params.title ?? params.page.title,
          sourceUrl: params.page.url,
          clippedAt: params.clippedAt ?? '2026-11-24T04:00:00.000Z',
          uploadedImages: params.fetchedImages.map((img) => ({
            id: img.id,
            filename: img.filename,
            fileId: `file-${folderId}-${img.id}`,
            mimeType: img.mimeType,
            resolvedUrl: img.resolvedUrl,
          })),
          failedImages: [...(params.failedImages ?? [])],
          warnings: [],
          reusedFolder: false,
        };
      }),
      updateBundleIndexAndLog: vi.fn(async () => ({
        indexFileId: 'idx-multi',
        logFileId: 'log-multi',
      })),
    } as unknown as DriveClient;

    const controller = createServiceWorkerController({
      driveClient,
      fetchImpl,
      storageSync: syncStorage,
      storageLocal: localStorage,
      storageSession: sessionStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'valid-token',
      maxConcurrentJobs: 2,
      badgeClearDelayMs: 30,
      imageFetchOptions: { dnr },
      now: () => new Date('2026-11-24T05:00:00.000Z'),
      createClipId: () => `job-${++clipSeq}`,
      tabs: {
        query: async () => [],
        get: async (tabId) => {
          if (tabsClosed) {
            throw new Error(`Tab ${tabId} was already closed`);
          }
          return {
            id: tabId,
            url: `https://zhuanlan.zhihu.com/p/${tabId}`,
            title: `(20 封私信 / 17 条消息) 华硕 ProArt 评测 ${tabId}`,
          } as chrome.tabs.Tab;
        },
        sendMessage: async (tabId): Promise<ContentResponseMessage> => {
          if (tabsClosed) {
            throw new Error(`Tab ${tabId} was already closed`);
          }
          const pageUrl = `https://zhuanlan.zhihu.com/p/${tabId}`;
          const imgUrl = `https://pic1.zhimg.com/v2-pic-${tabId}.png?source=1`;
          return {
            ok: true,
            type: 'CONTENT_EXTRACTED_PAGE',
            data: {
              ...makeExtractedPage(pageUrl),
              title: `华硕 ProArt 评测 ${tabId}`,
              images: [
                {
                  id: `img-${tabId}`,
                  originalUrl: imgUrl,
                  resolvedUrl: imgUrl,
                  sourceUrls: [imgUrl],
                  alt: `pic ${tabId}`,
                  suggestedName: `01-pic-${tabId}`,
                },
              ],
            },
          };
        },
      },
      scripting: {
        executeScript: async () => [],
      },
      emitPushMessage: async (msg: BackgroundPushMessage) => {
        if (msg.type === 'CLIP_JOBS_UPDATED') {
          jobSnapshots.push(msg.jobs);
          const queuedCount = msg.jobs.filter((j) => j.status === 'queued').length;
          maxSimultaneousQueued = Math.max(maxSimultaneousQueued, queuedCount);
        }
      },
      setBadge: async (text, color) => {
        badgeCalls.push([text, color]);
      },
    });

    // Fire 5 concurrent START_CLIP requests across 5 different tabs.
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((tabId) =>
        controller.handleMessage({
          type: 'START_CLIP',
          request: { tabId, mode: 'full' },
        }),
      ),
    );

    // Every START_CLIP resolves non-blocking with status === 'queued' before downloads complete.
    for (const res of responses) {
      expect(res.ok).toBe(true);
      if (res.ok) {
        const job = res.data as ClipJob;
        expect(job.status).toBe('queued');
        expect(job.title).not.toContain('封私信');
        expect(job.folderName).not.toContain('封私信');
      }
    }

    // Simulate user immediately closing all 5 tabs after clicking Clip!
    tabsClosed = true;

    // Inspect live jobs while downloads are paused: 2 downloading, 3 queued.
    const midJobsRes = await controller.handleMessage({ type: 'GET_CLIP_JOBS' });
    expect(midJobsRes.ok).toBe(true);
    if (midJobsRes.ok) {
      const midJobs = midJobsRes.data as ClipJob[];
      expect(midJobs).toHaveLength(5);
      expect(midJobs.filter((j) => j.status === 'downloading')).toHaveLength(2);
      expect(midJobs.filter((j) => j.status === 'queued')).toHaveLength(3);
    }

    // Unblock downloads and wait for all 5 background jobs to finish.
    releaseDownloads();
    await controller.whenIdle();

    // Queue concurrency stayed strictly bounded at 2, while 3 waited in 'queued'.
    expect(peakActiveWorkers).toBeLessThanOrEqual(2);
    expect(maxSimultaneousQueued).toBeGreaterThanOrEqual(3);

    // Single-flight + burst cache: ensureRootFolder called exactly ONCE across all 5 clips!
    expect(rootFolderCalls).toBe(1);
    expect((await controller.getSettings()).rootFolderId).toBe('root-single-flight');

    // Concurrent DNR rules never collided, used specific URLs (not host wildcards), and cleaned up.
    expect(activeDnrRules.size).toBe(0);
    const overlappingBatch = observedDnrOverlaps.find((rules) => rules.length === 2);
    expect(overlappingBatch).toBeDefined();
    if (overlappingBatch) {
      const referers = overlappingBatch.map(
        (r) => r.action.requestHeaders?.[0]?.value,
      );
      expect(new Set(referers).size).toBe(2);
      for (const rule of overlappingBatch) {
        expect(rule.condition.urlFilter).toMatch(
          /^\|https:\/\/pic1\.zhimg\.com\/v2-pic-\d+\.png\?source=1\|$/,
        );
      }
    }

    // All 5 clips completed, persisted in chrome.storage.session, and recorded in history without race loss.
    const persistedJobs = sessionStorage.store[STORAGE_KEYS.clipJobs] as ClipJob[];
    expect(persistedJobs).toHaveLength(5);
    expect(persistedJobs.every((j) => j.status === 'done')).toBe(true);

    const history = await controller.getHistory();
    expect(history).toHaveLength(5);

    // Aggregate badge reached '5', counted down through '1', showed green 'OK', then auto-cleared to ''.
    expect(badgeCalls).toContainEqual(['5', '#2563eb']);
    expect(badgeCalls).toContainEqual(['1', '#2563eb']);
    expect(badgeCalls[badgeCalls.length - 1]).toEqual(['OK', '#16a34a']);

    await new Promise((r) => setTimeout(r, 60));
    expect(badgeCalls[badgeCalls.length - 1]).toEqual(['', '']);
  });

  it('shows red "!" badge on error, preserves manual user title, supports dismiss/clear, and caps stored jobs at MAX_CLIP_JOBS', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    const badgeCalls: Array<[string, string]> = [];
    let shouldFailUpload = false;
    let idSeq = 0;

    const driveClient = {
      ensureRootFolder: vi.fn(async () => ({
        folderId: 'root-1',
        folderName: 'WebClips',
        folderUrl: 'https://drive.google.com/drive/folders/root-1',
        created: false,
      })),
      uploadArticle: vi.fn(async (params: UploadArticleParams) => {
        if (shouldFailUpload) {
          throw new Error('Drive quota temporarily exceeded');
        }
        const id = ++idSeq;
        return {
          folderId: `f-${id}`,
          folderUrl: `https://drive.google.com/drive/folders/f-${id}`,
          folderName: params.folderName ?? `2026-11-24-doc-${id}`,
          readmeFileId: `r-${id}`,
          title: params.title ?? params.page.title,
          sourceUrl: params.page.url,
          clippedAt: '2026-11-24T05:00:00.000Z',
          uploadedImages: [],
          failedImages: [],
          warnings: [],
          reusedFolder: false,
        };
      }),
      updateBundleIndexAndLog: vi.fn(async () => ({
        indexFileId: 'idx-multi',
        logFileId: 'log-multi',
      })),
    } as unknown as DriveClient;

    let clipIdCounter = 0;
    const controller = createServiceWorkerController({
      driveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      storageSession: sessionStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'tok',
      badgeClearDelayMs: 5_000,
      createClipId: () => `c-${++clipIdCounter}`,
      tabs: {
        query: async () => [
          { id: 10, url: 'https://example.com/a' } as chrome.tabs.Tab,
        ],
        get: async (tabId) =>
          ({ id: tabId, url: `https://example.com/p/${tabId}` }) as chrome.tabs.Tab,
        sendMessage: async (tabId): Promise<ContentResponseMessage> => ({
          ok: true,
          type: 'CONTENT_EXTRACTED_PAGE',
          data: {
            ...makeExtractedPage(`https://example.com/p/${tabId}`),
            title: `Extracted Title ${tabId}`,
            images: [],
          },
        }),
      },
      scripting: { executeScript: async () => [] },
      fetchImagesImpl: async () => ({ succeeded: [], failed: [] }),
      emitPushMessage: async () => undefined,
      setBadge: async (text, color) => {
        badgeCalls.push([text, color]);
      },
    });

    // 1. User's manually edited title starting with "(3) " is preserved verbatim!
    const manualRes = await controller.runClip({
      tabId: 10,
      mode: 'full',
      title: '(3) My Manual Title',
    });
    expect(manualRes.ok).toBe(true);
    if (manualRes.ok) {
      expect(manualRes.data.title).toBe('(3) My Manual Title');
    }

    // 2. A failing job turns the badge to red "!" when active count returns to 0.
    shouldFailUpload = true;
    const failRes = await controller.runClip({ tabId: 11, mode: 'full' });
    expect(failRes.ok).toBe(false);
    await controller.whenIdle();
    expect(badgeCalls[badgeCalls.length - 1]).toEqual(['!', '#dc2626']);

    const jobsAfterFailure = await controller.getClipJobs();
    const errorJob = jobsAfterFailure.find((j) => j.status === 'error');
    expect(errorJob).toBeDefined();

    // 3. Dismissing the failed job removes it from storage.session and clears "!" badge.
    const dismissRes = await controller.handleMessage({
      type: 'DISMISS_CLIP_JOB',
      jobId: errorJob!.id,
    });
    expect(dismissRes.ok).toBe(true);
    if (dismissRes.ok) {
      expect((dismissRes.data as ClipJob[]).some((j) => j.id === errorJob!.id)).toBe(
        false,
      );
    }
    expect(badgeCalls[badgeCalls.length - 1]).toEqual(['', '']);

    // 4. Clearing completed jobs empties all finished jobs.
    const clearRes = await controller.handleMessage({
      type: 'CLEAR_COMPLETED_JOBS',
    });
    expect(clearRes.ok).toBe(true);
    if (clearRes.ok) {
      expect(clearRes.data).toEqual([]);
    }

    // 5. Persisted clip jobs stay capped at MAX_CLIP_JOBS (20).
    shouldFailUpload = false;
    for (let i = 0; i < MAX_CLIP_JOBS + 5; i += 1) {
      await controller.runClip({ tabId: 100 + i, mode: 'full' });
    }
    await controller.whenIdle();
    const capped = await controller.getClipJobs();
    expect(capped).toHaveLength(MAX_CLIP_JOBS);
    expect(
      (sessionStorage.store[STORAGE_KEYS.clipJobs] as ClipJob[]).length,
    ).toBe(MAX_CLIP_JOBS);
  });

  it('recovers orphaned active jobs from chrome.storage.session as errors after a Service Worker cold restart', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    const badgeCalls: Array<[string, string]> = [];
    const pushedMessages: BackgroundPushMessage[] = [];

    const makeStoredJob = (
      id: string,
      status: ClipJob['status'],
      extra: Partial<ClipJob> = {},
    ): ClipJob => ({
      id,
      tabId: 1,
      url: `https://example.com/${id}`,
      title: `Article ${id}`,
      folderName: `2026-11-24-${id}`,
      mode: 'full',
      status,
      message: `In ${status}`,
      createdAt: '2026-11-24T04:00:00.000Z',
      updatedAt: '2026-11-24T04:01:00.000Z',
      ...extra,
    });

    sessionStorage.store[STORAGE_KEYS.clipJobs] = [
      makeStoredJob('orphan-extracting', 'extracting'),
      makeStoredJob('orphan-queued', 'queued'),
      makeStoredJob('orphan-downloading', 'downloading', { completed: 3, total: 10 }),
      makeStoredJob('orphan-uploading', 'uploading', { completed: 1, total: 4 }),
      makeStoredJob('already-done', 'done', {
        message: 'Saved to Google Drive',
        result: {
          folderId: 'done-folder',
          folderUrl: 'https://drive.google.com/drive/folders/done-folder',
          folderName: '2026-11-24-already-done',
          readmeFileId: 'readme-done',
          title: 'Article already-done',
          sourceUrl: 'https://example.com/already-done',
          clippedAt: '2026-11-24T04:01:00.000Z',
          uploadedImages: [],
          failedImages: [],
          warnings: [],
          reusedFolder: false,
        },
      }),
      makeStoredJob('prior-error', 'error', {
        message: 'Previous failure',
        error: 'Previous failure',
      }),
    ];

    // Instantiate a fresh SW controller (simulating Chrome waking a restarted Service Worker).
    const restartedController = createServiceWorkerController({
      storageSync: syncStorage,
      storageLocal: localStorage,
      storageSession: sessionStorage,
      getManifest: () => makeConfiguredManifest(),
      emitPushMessage: async (msg) => {
        pushedMessages.push(msg);
      },
      setBadge: async (text, color) => {
        badgeCalls.push([text, color]);
      },
    });

    const response = await restartedController.handleMessage({
      type: 'GET_CLIP_JOBS',
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      const recovered = response.data as ClipJob[];
      expect(recovered).toHaveLength(6);

      for (const orphanId of [
        'orphan-extracting',
        'orphan-queued',
        'orphan-downloading',
        'orphan-uploading',
      ]) {
        const job = recovered.find((j) => j.id === orphanId);
        expect(job?.status).toBe('error');
        expect(job?.message).toBe(ORPHANED_JOB_ERROR_MESSAGE);
        expect(job?.error).toBe(ORPHANED_JOB_ERROR_MESSAGE);
      }

      const doneJob = recovered.find((j) => j.id === 'already-done');
      expect(doneJob?.status).toBe('done');
      expect(doneJob?.result?.folderId).toBe('done-folder');

      const priorErr = recovered.find((j) => j.id === 'prior-error');
      expect(priorErr?.status).toBe('error');
      expect(priorErr?.error).toBe('Previous failure');
    }

    // Recovered state persisted back to storage.session, broadcast to UI, and badge turned red "!".
    const persisted = sessionStorage.store[STORAGE_KEYS.clipJobs] as ClipJob[];
    expect(
      persisted.filter((j) => j.error === ORPHANED_JOB_ERROR_MESSAGE),
    ).toHaveLength(4);
    expect(
      pushedMessages.some((m) => m.type === 'CLIP_JOBS_UPDATED'),
    ).toBe(true);
    expect(badgeCalls[badgeCalls.length - 1]).toEqual(['!', '#dc2626']);
  });

  it('runs MV3 keepalive heartbeat only while active clip jobs are in flight and stops cleanly when the queue drains to 0', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    const keepalivePing = vi.fn(async () => undefined);

    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });

    const driveClient = {
      ensureRootFolder: vi.fn(async () => ({
        folderId: 'root-1',
        folderName: 'WebClips',
        folderUrl: 'https://drive.google.com/drive/folders/root-1',
        created: false,
      })),
      uploadArticle: vi.fn(async (params: UploadArticleParams) => {
        await uploadGate;
        return {
          folderId: 'ka-folder',
          folderUrl: 'https://drive.google.com/drive/folders/ka-folder',
          folderName: params.folderName ?? '2026-11-24-ka',
          readmeFileId: 'readme-ka',
          title: params.page.title,
          sourceUrl: params.page.url,
          clippedAt: '2026-11-24T05:00:00.000Z',
          uploadedImages: [],
          failedImages: [],
          warnings: [],
          reusedFolder: false,
        };
      }),
      updateBundleIndexAndLog: vi.fn(async () => ({
        indexFileId: 'idx-multi',
        logFileId: 'log-multi',
      })),
    } as unknown as DriveClient;

    const controller = createServiceWorkerController({
      driveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      storageSession: sessionStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'tok',
      keepaliveIntervalMs: 15,
      keepalivePing,
      tabs: {
        query: async () => [
          { id: 42, url: 'https://example.com/long-article' } as chrome.tabs.Tab,
        ],
        get: async (tabId) =>
          ({ id: tabId, url: 'https://example.com/long-article' }) as chrome.tabs.Tab,
        sendMessage: async (): Promise<ContentResponseMessage> => ({
          ok: true,
          type: 'CONTENT_EXTRACTED_PAGE',
          data: {
            ...makeExtractedPage('https://example.com/long-article'),
            images: [],
          },
        }),
      },
      scripting: { executeScript: async () => [] },
      fetchImagesImpl: async () => ({ succeeded: [], failed: [] }),
      emitPushMessage: async () => undefined,
      setBadge: async () => undefined,
    });

    // Idle before any job starts: zero keepalive pings.
    await new Promise((r) => setTimeout(r, 40));
    expect(keepalivePing).not.toHaveBeenCalled();

    // Enqueue a long-running clip job: keepalive ticks repeatedly while active.
    const accepted = await controller.handleMessage({
      type: 'START_CLIP',
      request: { tabId: 42, mode: 'full' },
    });
    expect(accepted.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 65));
    expect(keepalivePing.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Finish the job -> queue drains to 0 -> keepalive interval stops cleanly with no further ticks!
    releaseUpload();
    await controller.whenIdle();

    const countAfterIdle = keepalivePing.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(keepalivePing.mock.calls.length).toBe(countAfterIdle);
  });

  it('serializes concurrent bundle index.md/log.md updates via indexWriteChain with zero lost updates across 5 concurrent tabs and degrades non-fatally on index errors', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();

    // Minimal in-memory Drive v3 HTTP mock supporting folders, multipart uploads, and ?alt=media downloads.
    let idSeq = 0;
    const driveFiles = new Map<
      string,
      {
        id: string;
        name: string;
        mimeType: string;
        parents: string[];
        trashed: boolean;
        appProperties: Record<string, string>;
        content?: Uint8Array;
      }
    >();
    let failIndexWrites = false;
    let activeIndexMediaReadsOrWrites = 0;
    let peakIndexConcurrency = 0;

    const parseMultipart = (raw: Uint8Array, ctHeader: string) => {
      const boundary = /boundary=([^\s;]+)/i.exec(ctHeader)![1];
      const latin1 = new TextDecoder('latin1').decode(raw);
      const delim = `--${boundary}`;
      const parts = latin1.split(delim).slice(1, -1);
      const metaPart = parts[0].replace(/^\r\n/, '');
      const meta = JSON.parse(
        metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''),
      ) as Record<string, unknown>;
      const mediaStart =
        latin1.indexOf(delim, latin1.indexOf(delim) + delim.length) + delim.length + 2;
      const mediaHeaderEnd = latin1.indexOf('\r\n\r\n', mediaStart);
      const contentStart = mediaHeaderEnd + 4;
      const closeIdx = latin1.indexOf(`\r\n${delim}--`, contentStart);
      const contentBytes = raw.slice(contentStart, closeIdx);
      const mediaCt =
        /Content-Type:\s*([^\r\n]+)/i.exec(latin1.slice(mediaStart, mediaHeaderEnd))?.[1]?.trim() ??
        'application/octet-stream';
      return { meta, contentBytes, mediaCt };
    };

    const driveFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);

      if (method === 'GET' && url.pathname.startsWith('/drive/v3/files/')) {
        const id = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
        const found = driveFiles.get(id);
        if (!found) {
          return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
        }
        if (url.searchParams.get('alt') === 'media') {
          if (found.name === 'index.md') {
            activeIndexMediaReadsOrWrites += 1;
            peakIndexConcurrency = Math.max(peakIndexConcurrency, activeIndexMediaReadsOrWrites);
            await new Promise((r) => setTimeout(r, 15));
            activeIndexMediaReadsOrWrites -= 1;
          }
          const copy = new Uint8Array(found.content ?? []);
          return new Response(copy, {
            status: 200,
            headers: { 'content-type': found.mimeType },
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

      if (method === 'GET' && url.pathname === '/drive/v3/files') {
        const q = url.searchParams.get('q') ?? '';
        const parentMatch = /'((?:\\.|[^'])+)' in parents/.exec(q);
        const sourceUrlMatch =
          /appProperties has \{ key='sourceUrl' and value='((?:\\.|[^'])+)' \}/.exec(q);
        const onlyFolders = q.includes(`mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`);
        const excludeFolders = q.includes(`mimeType != '${DRIVE_FOLDER_MIME_TYPE}'`);
        const unescape = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

        const matched = Array.from(driveFiles.values()).filter((f) => {
          if (f.trashed) return false;
          if (onlyFolders && f.mimeType !== DRIVE_FOLDER_MIME_TYPE) return false;
          if (excludeFolders && f.mimeType === DRIVE_FOLDER_MIME_TYPE) return false;
          if (parentMatch && !f.parents.includes(unescape(parentMatch[1]))) return false;
          if (sourceUrlMatch && f.appProperties.sourceUrl !== unescape(sourceUrlMatch[1])) {
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

      if (method === 'POST' && url.pathname === '/drive/v3/files') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          name: string;
          mimeType: string;
          parents?: string[];
          appProperties?: Record<string, string>;
        };
        const id = `d-${++idSeq}`;
        driveFiles.set(id, {
          id,
          name: body.name,
          mimeType: body.mimeType,
          parents: body.parents ?? [],
          trashed: false,
          appProperties: body.appProperties ?? {},
        });
        return new Response(
          JSON.stringify({ id, name: body.name, mimeType: body.mimeType }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (
        (method === 'POST' || method === 'PATCH') &&
        url.pathname.startsWith('/upload/drive/v3/files')
      ) {
        const { meta, contentBytes, mediaCt } = parseMultipart(
          init?.body as Uint8Array,
          headers.get('content-type') ?? '',
        );
        const name = String(meta.name);
        if ((name === 'index.md' || name === 'log.md') && failIndexWrites) {
          return new Response(
            JSON.stringify({ error: { message: 'Simulated index write outage' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        if (name === 'index.md') {
          activeIndexMediaReadsOrWrites += 1;
          peakIndexConcurrency = Math.max(peakIndexConcurrency, activeIndexMediaReadsOrWrites);
          await new Promise((r) => setTimeout(r, 15));
          activeIndexMediaReadsOrWrites -= 1;
        }
        if (method === 'PATCH') {
          const id = decodeURIComponent(url.pathname.slice('/upload/drive/v3/files/'.length));
          const existing = driveFiles.get(id)!;
          existing.name = name;
          existing.mimeType = mediaCt;
          existing.content = contentBytes;
          return new Response(
            JSON.stringify({ id: existing.id, name: existing.name, mimeType: existing.mimeType }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const id = `d-${++idSeq}`;
        driveFiles.set(id, {
          id,
          name,
          mimeType: mediaCt,
          parents: (meta.parents as string[]) ?? [],
          trashed: false,
          appProperties: (meta.appProperties as Record<string, string>) ?? {},
          content: contentBytes,
        });
        return new Response(
          JSON.stringify({ id, name, mimeType: mediaCt }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      throw new Error(`Unhandled request: ${method} ${url.toString()}`);
    });

    const realDriveClient = new DriveClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: driveFetch,
      tokenProvider: async () => 'tok',
      maxRetries: 0,
    });

    let seq = 0;
    const controller = createServiceWorkerController({
      driveClient: realDriveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      storageSession: sessionStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'tok',
      maxConcurrentJobs: 3,
      now: () => new Date(`2026-11-24T05:00:0${Math.min(++seq, 9)}.000Z`),
      createClipId: () => `idx-job-${++seq}`,
      tabs: {
        query: async () => [],
        get: async (tabId) =>
          ({
            id: tabId,
            url: `https://zhuanlan.zhihu.com/p/${tabId}`,
            title: `(5 条消息) Article ${tabId} - 知乎`,
          }) as chrome.tabs.Tab,
        sendMessage: async (tabId): Promise<ContentResponseMessage> => ({
          ok: true,
          type: 'CONTENT_EXTRACTED_PAGE',
          data: {
            ...makeExtractedPage(`https://zhuanlan.zhihu.com/p/${tabId}`),
            title: `Article ${tabId}`,
            description: `Summary for article ${tabId}.`,
            site: '知乎',
            images: [],
          },
        }),
      },
      scripting: { executeScript: async () => [] },
      fetchImagesImpl: async () => ({ succeeded: [], failed: [] }),
      emitPushMessage: async () => undefined,
      setBadge: async () => undefined,
    });

    // Fire 5 concurrent clips (3 concurrent workers!) -> indexWriteChain must serialize index.md/log.md writes.
    await Promise.all(
      [1, 2, 3, 4, 5].map((tabId) =>
        controller.handleMessage({
          type: 'START_CLIP',
          request: { tabId, mode: 'full', tags: ['batch'] },
        }),
      ),
    );
    await controller.whenIdle();

    expect(peakIndexConcurrency).toBe(1);

    const indexFile = Array.from(driveFiles.values()).find((f) => f.name === 'index.md');
    const logFile = Array.from(driveFiles.values()).find((f) => f.name === 'log.md');
    expect(indexFile).toBeDefined();
    expect(logFile).toBeDefined();

    const indexText = new TextDecoder().decode(indexFile!.content!);
    const logText = new TextDecoder().decode(logFile!.content!);

    const indexLines = indexText.split('\n').filter((l) => l.startsWith('- ['));
    const logLines = logText.split('\n').filter((l) => l.startsWith('- '));
    expect(indexLines).toHaveLength(5);
    expect(logLines).toHaveLength(5);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(indexText).toContain(`https://zhuanlan.zhihu.com/p/${id}`);
      expect(indexText).toContain(`./2026-11-24-zhihu-article-${id}/2026-11-24-zhihu-article-${id}.md`);
      expect(logText).toContain(`https://zhuanlan.zhihu.com/p/${id}`);
    }

    // History items record canonical article filename and ID.
    const history = await controller.getHistory();
    expect(history[0].fileName).toMatch(/^2026-11-24-zhihu-article-\d+\.md$/);
    expect(history[0].articleFileId).toBeTruthy();

    // Transient index write failure must NOT fail the already-uploaded article, and must emit a warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      failIndexWrites = true;
      const degraded = await controller.runClip({ tabId: 6, mode: 'full' });
      expect(degraded.ok).toBe(true);
      if (degraded.ok) {
        expect(degraded.data.fileName).toBe('2026-11-24-zhihu-article-6.md');
        expect(
          degraded.data.warnings.some((w) => w.includes('index.md/log.md')),
        ).toBe(true);
      }
      expect(warnSpy).toHaveBeenCalled();

      // Subsequent clip after outage recovers cleanly (indexWriteChain not poisoned!).
      failIndexWrites = false;
      const recovered = await controller.runClip({ tabId: 7, mode: 'full' });
      expect(recovered.ok).toBe(true);
      const afterRecoveryIndex = new TextDecoder().decode(
        driveFiles.get(indexFile!.id)!.content!,
      );
      expect(afterRecoveryIndex).toContain('https://zhuanlan.zhihu.com/p/7');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('persists stickyTags in settings distinguishing null (unset), [] (explicitly empty), and non-empty lists', async () => {
    const syncStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    const uploadedTagBatches: Array<readonly string[] | undefined> = [];

    const driveClient = {
      ensureRootFolder: vi.fn(async () => ({
        folderId: 'root-1',
        folderName: 'WebClips',
        folderUrl: 'https://drive.google.com/drive/folders/root-1',
        created: false,
      })),
      uploadArticle: vi.fn(async (params: UploadArticleParams) => {
        uploadedTagBatches.push(params.tags);
        return {
          folderId: 'f-tags',
          folderUrl: 'https://drive.google.com/drive/folders/f-tags',
          folderName: params.folderName ?? '2026-11-24-example-sample-post',
          fileName: `${params.folderName ?? '2026-11-24-example-sample-post'}.md`,
          articleFileName: `${params.folderName ?? '2026-11-24-example-sample-post'}.md`,
          articleFileId: 'art-1',
          readmeFileId: 'art-1',
          title: params.page.title,
          sourceUrl: params.page.url,
          clippedAt: params.clippedAt ?? '2026-11-24T04:00:00.000Z',
          uploadedImages: [],
          failedImages: [],
          warnings: [],
          reusedFolder: false,
        };
      }),
      updateBundleIndexAndLog: vi.fn(async () => ({
        indexFileId: 'idx-1',
        logFileId: 'log-1',
      })),
    } as unknown as DriveClient;

    const controller = createServiceWorkerController({
      driveClient,
      storageSync: syncStorage,
      storageLocal: localStorage,
      getManifest: () => makeConfiguredManifest(),
      getAuthToken: async () => 'tok',
      tabs: {
        query: async () => [
          { id: 1, url: 'https://example.com/post-1' } as chrome.tabs.Tab,
        ],
        get: async (tabId) =>
          ({ id: tabId, url: 'https://example.com/post-1' }) as chrome.tabs.Tab,
        sendMessage: async (): Promise<ContentResponseMessage> => ({
          ok: true,
          type: 'CONTENT_EXTRACTED_PAGE',
          data: { ...makeExtractedPage('https://example.com/post-1'), images: [] },
        }),
      },
      scripting: { executeScript: async () => [] },
      fetchImagesImpl: async () => ({ succeeded: [], failed: [] }),
      emitPushMessage: async () => undefined,
      setBadge: async () => undefined,
    });

    // 1. Default state: stickyTags is null, falls back to defaultTags (['web-clip']).
    const initial = await controller.getSettings();
    expect(initial.stickyTags).toBeNull();
    expect(initial.defaultTags).toEqual(['web-clip']);

    await controller.runClip({ mode: 'full' });
    expect(uploadedTagBatches.at(-1)).toEqual(['web-clip']);

    // 2. Custom stickyTags persists deduplicated trimmed tags and survives unrelated Options updates.
    const afterSet = await controller.updateSettings({
      stickyTags: ['ai', 'agents', 'ai', '  '],
    });
    expect(afterSet.stickyTags).toEqual(['ai', 'agents']);

    const afterOptionsSave = await controller.updateSettings({
      defaultTags: ['reading-list'],
    });
    expect(afterOptionsSave.defaultTags).toEqual(['reading-list']);
    expect(afterOptionsSave.stickyTags).toEqual(['ai', 'agents']);

    await controller.runClip({ mode: 'full' });
    expect(uploadedTagBatches.at(-1)).toEqual(['ai', 'agents']);

    // 3. Explicit empty array [] MUST stay [] (NOT snap back to null or defaultTags!).
    const afterClearAll = await controller.updateSettings({ stickyTags: [] });
    expect(afterClearAll.stickyTags).toEqual([]);
    expect((await controller.getSettings()).stickyTags).toEqual([]);

    await controller.runClip({ mode: 'full' });
    expect(uploadedTagBatches.at(-1)).toEqual([]);

    // 4. Explicit null resets stickyTags back to null -> falls back to defaultTags again.
    const afterReset = await controller.updateSettings({ stickyTags: null });
    expect(afterReset.stickyTags).toBeNull();
    expect((await controller.getSettings()).stickyTags).toBeNull();

    await controller.runClip({ mode: 'full' });
    expect(uploadedTagBatches.at(-1)).toEqual(['reading-list']);
  });
});
