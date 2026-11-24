import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_MENU_CLIP_SELECTION_ID,
  MAX_CLIP_HISTORY_ITEMS,
  createServiceWorkerController,
} from '../../src/background/service-worker.js';
import { DriveClient, type UploadArticleParams } from '../../src/drive/drive-client.js';
import {
  OAUTH_CLIENT_ID_PLACEHOLDER,
  type BackgroundPushMessage,
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
        pushEvents.push(msg.event);
      },
      createClipId: () => 'clip-test-id',
    });

    const response = await controller.handleMessage({
      type: 'START_CLIP',
      request: { mode: 'full', tags: ['tech'] },
    });

    expect(response.ok).toBe(true);
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
      ['...', '#2563eb'],
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
});
