import {
  DriveApiError,
  DriveClient,
  getChromeDriveAuthToken,
  revokeChromeAuthToken,
} from '../drive/drive-client.js';
import {
  DEFAULT_EXTENSION_SETTINGS,
  OAUTH_CLIENT_ID_PLACEHOLDER,
  STORAGE_KEYS,
  type AuthStatus,
  type BackgroundErrorCode,
  type BackgroundPushMessage,
  type BackgroundResponse,
  type ClipHistoryItem,
  type ClipProgressEvent,
  type ClipRequest,
  type ClipResult,
  type ContentRequestMessage,
  type ContentResponseMessage,
  type ExtensionSettings,
  type PageInfo,
  type RootFolderInfo,
  type UiToBackgroundMessage,
} from '../types.js';
import { fetchImages, type ImageFetchOptions } from './image-fetcher.js';

export const CONTEXT_MENU_CLIP_SELECTION_ID = 'drive-clipper-clip-selection';
export const MAX_CLIP_HISTORY_ITEMS = 10;
const CONTENT_SCRIPT_FILE = 'content.js';
const SW_LISTENER_SENTINEL = '__driveClipperServiceWorkerRegistered__';

export interface StorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ServiceWorkerDependencies {
  driveClient?: DriveClient;
  fetchImagesImpl?: typeof fetchImages;
  fetchImpl?: typeof fetch;
  getAuthToken?: (options: { interactive: boolean }) => Promise<string>;
  revokeAuthToken?: (token: string) => Promise<void>;
  clearAllCachedAuthTokens?: () => Promise<void>;
  getManifest?: () => chrome.runtime.Manifest;
  storageSync?: StorageAreaLike;
  storageLocal?: StorageAreaLike;
  tabs?: {
    query: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
    get: (tabId: number) => Promise<chrome.tabs.Tab>;
    sendMessage: (
      tabId: number,
      message: ContentRequestMessage,
    ) => Promise<ContentResponseMessage>;
  };
  scripting?: {
    executeScript: (
      injection: chrome.scripting.ScriptInjection<unknown[], unknown>,
    ) => Promise<unknown>;
  };
  emitPushMessage?: (message: BackgroundPushMessage) => Promise<void>;
  setBadge?: (text: string, color: string) => Promise<void>;
  now?: () => Date;
  createClipId?: () => string;
  imageFetchOptions?: Partial<ImageFetchOptions>;
}

export interface ServiceWorkerController {
  handleMessage(message: unknown): Promise<BackgroundResponse<unknown>>;
  runClip(request: ClipRequest): Promise<BackgroundResponse<ClipResult>>;
  handleContextMenuClick(
    info: Pick<chrome.contextMenus.OnClickData, 'menuItemId'>,
    tab?: Pick<chrome.tabs.Tab, 'id' | 'url'>,
  ): Promise<void>;
  getSettings(): Promise<ExtensionSettings>;
  updateSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
  getHistory(): Promise<ClipHistoryItem[]>;
}

export function isConfiguredOAuthClientId(clientId: unknown): boolean {
  if (typeof clientId !== 'string') {
    return false;
  }
  const trimmed = clientId.trim();
  if (trimmed.length === 0 || trimmed === OAUTH_CLIENT_ID_PLACEHOLDER) {
    return false;
  }
  return !trimmed.startsWith('YOUR_');
}

export function isSupportedPageUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSettings(raw: unknown): ExtensionSettings {
  const input =
    raw && typeof raw === 'object' ? (raw as Partial<ExtensionSettings>) : {};
  const rawFrontmatter: Partial<ExtensionSettings['frontmatter']> =
    input.frontmatter && typeof input.frontmatter === 'object'
      ? input.frontmatter
      : {};

  const rootFolderName =
    typeof input.rootFolderName === 'string' &&
    input.rootFolderName.trim().length > 0
      ? input.rootFolderName.trim()
      : DEFAULT_EXTENSION_SETTINGS.rootFolderName;

  const rootFolderId =
    typeof input.rootFolderId === 'string' &&
    input.rootFolderId.trim().length > 0
      ? input.rootFolderId.trim()
      : null;

  const defaultTags = Array.isArray(input.defaultTags)
    ? Array.from(
        new Set(
          input.defaultTags
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0),
        ),
      )
    : [...DEFAULT_EXTENSION_SETTINGS.defaultTags];

  const maxImageSizeBytes =
    typeof input.maxImageSizeBytes === 'number' &&
    Number.isFinite(input.maxImageSizeBytes) &&
    input.maxImageSizeBytes >= 1024
      ? Math.floor(input.maxImageSizeBytes)
      : DEFAULT_EXTENSION_SETTINGS.maxImageSizeBytes;

  const imageConcurrency =
    typeof input.imageConcurrency === 'number' &&
    Number.isFinite(input.imageConcurrency)
      ? Math.min(10, Math.max(1, Math.floor(input.imageConcurrency)))
      : DEFAULT_EXTENSION_SETTINGS.imageConcurrency;

  return {
    rootFolderName,
    rootFolderId,
    defaultTags,
    frontmatter: {
      includeAuthor:
        typeof rawFrontmatter.includeAuthor === 'boolean'
          ? rawFrontmatter.includeAuthor
          : DEFAULT_EXTENSION_SETTINGS.frontmatter.includeAuthor,
      includePublished:
        typeof rawFrontmatter.includePublished === 'boolean'
          ? rawFrontmatter.includePublished
          : DEFAULT_EXTENSION_SETTINGS.frontmatter.includePublished,
      includeSite:
        typeof rawFrontmatter.includeSite === 'boolean'
          ? rawFrontmatter.includeSite
          : DEFAULT_EXTENSION_SETTINGS.frontmatter.includeSite,
      includeImages:
        typeof rawFrontmatter.includeImages === 'boolean'
          ? rawFrontmatter.includeImages
          : DEFAULT_EXTENSION_SETTINGS.frontmatter.includeImages,
      includeWarnings:
        typeof rawFrontmatter.includeWarnings === 'boolean'
          ? rawFrontmatter.includeWarnings
          : DEFAULT_EXTENSION_SETTINGS.frontmatter.includeWarnings,
    },
    maxImageSizeBytes,
    imageConcurrency,
  };
}

function normalizeHistory(raw: unknown): ClipHistoryItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (item): item is ClipHistoryItem =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as ClipHistoryItem).folderId === 'string' &&
        typeof (item as ClipHistoryItem).folderUrl === 'string' &&
        typeof (item as ClipHistoryItem).title === 'string',
    )
    .slice(0, MAX_CLIP_HISTORY_ITEMS);
}

function isUiToBackgroundMessage(value: unknown): value is UiToBackgroundMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === 'GET_PAGE_INFO' ||
    type === 'START_CLIP' ||
    type === 'GET_SETTINGS' ||
    type === 'UPDATE_SETTINGS' ||
    type === 'GET_HISTORY' ||
    type === 'GET_AUTH_STATUS' ||
    type === 'SIGN_IN' ||
    type === 'SIGN_OUT' ||
    type === 'ENSURE_ROOT_FOLDER'
  );
}

function classifyErrorCode(error: unknown): BackgroundErrorCode {
  if (error instanceof DriveApiError) {
    return error.code === 'AUTH_REQUIRED' || error.status === 401
      ? 'AUTH_REQUIRED'
      : 'DRIVE_ERROR';
  }
  return 'DRIVE_ERROR';
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultEmitPushMessage(
  message: BackgroundPushMessage,
): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return;
  }
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup or options view may be closed (e.g. context-menu clip); ignore no-receiver errors.
  }
}

async function defaultSetBadge(text: string, color: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.action) {
    return;
  }
  try {
    await chrome.action.setBadgeText({ text });
    if (text.length > 0) {
      await chrome.action.setBadgeBackgroundColor({ color });
    }
  } catch {
    // Badge updates are non-critical UI feedback.
  }
}

/**
 * Creates the Background Service Worker controller with injectable Chrome /
 * Drive / fetch dependencies for unit and E2E testing.
 */
export function createServiceWorkerController(
  deps: ServiceWorkerDependencies = {},
): ServiceWorkerController {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const getAuthToken = deps.getAuthToken ?? getChromeDriveAuthToken;
  const revokeAuthToken =
    deps.revokeAuthToken ??
    ((token: string) => revokeChromeAuthToken(token, fetchImpl));
  const clearAllCachedAuthTokens =
    deps.clearAllCachedAuthTokens ??
    (async () => {
      if (
        typeof chrome !== 'undefined' &&
        chrome.identity &&
        typeof chrome.identity.clearAllCachedAuthTokens === 'function'
      ) {
        await chrome.identity.clearAllCachedAuthTokens();
      }
    });
  const driveClient =
    deps.driveClient ??
    new DriveClient({
      fetchImpl,
      tokenProvider: getAuthToken,
    });
  const fetchImagesImpl = deps.fetchImagesImpl ?? fetchImages;
  const emitPushMessage = deps.emitPushMessage ?? defaultEmitPushMessage;
  const setBadge = deps.setBadge ?? defaultSetBadge;
  const now = deps.now ?? (() => new Date());
  const createClipId = deps.createClipId ?? (() => crypto.randomUUID());

  const getManifest = (): chrome.runtime.Manifest | null => {
    if (deps.getManifest) {
      return deps.getManifest();
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      return chrome.runtime.getManifest();
    }
    return null;
  };

  const getStorageSync = (): StorageAreaLike => {
    if (deps.storageSync) {
      return deps.storageSync;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
      return {
        get: (keys: string) => chrome.storage.sync.get(keys),
        set: (items: Record<string, unknown>) => chrome.storage.sync.set(items),
      };
    }
    throw new Error('chrome.storage.sync is unavailable.');
  };

  const getStorageLocal = (): StorageAreaLike => {
    if (deps.storageLocal) {
      return deps.storageLocal;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return {
        get: (keys: string) => chrome.storage.local.get(keys),
        set: (items: Record<string, unknown>) => chrome.storage.local.set(items),
      };
    }
    throw new Error('chrome.storage.local is unavailable.');
  };

  const getTabsApi = () => {
    if (deps.tabs) {
      return deps.tabs;
    }
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      return {
        query: (q: chrome.tabs.QueryInfo) => chrome.tabs.query(q),
        get: (tabId: number) => chrome.tabs.get(tabId),
        sendMessage: (tabId: number, msg: ContentRequestMessage) =>
          chrome.tabs.sendMessage<ContentRequestMessage, ContentResponseMessage>(
            tabId,
            msg,
          ),
      };
    }
    throw new Error('chrome.tabs API is unavailable.');
  };

  const getScriptingApi = () => {
    if (deps.scripting) {
      return deps.scripting;
    }
    if (typeof chrome !== 'undefined' && chrome.scripting) {
      return chrome.scripting;
    }
    throw new Error('chrome.scripting API is unavailable.');
  };

  const isOAuthConfigured = (): boolean => {
    const manifest = getManifest();
    return isConfiguredOAuthClientId(manifest?.oauth2?.client_id);
  };

  const emitProgress = async (event: ClipProgressEvent): Promise<void> => {
    await emitPushMessage({ type: 'CLIP_PROGRESS', event });
  };

  const getSettings = async (): Promise<ExtensionSettings> => {
    const stored = await getStorageSync().get(STORAGE_KEYS.settings);
    return normalizeSettings(stored[STORAGE_KEYS.settings]);
  };

  const updateSettings = async (
    patch: Partial<ExtensionSettings>,
  ): Promise<ExtensionSettings> => {
    const current = await getSettings();
    const merged: ExtensionSettings = normalizeSettings({
      ...current,
      ...patch,
      frontmatter: {
        ...current.frontmatter,
        ...(patch.frontmatter ?? {}),
      },
    });
    await getStorageSync().set({ [STORAGE_KEYS.settings]: merged });
    return merged;
  };

  const getHistory = async (): Promise<ClipHistoryItem[]> => {
    const stored = await getStorageLocal().get(STORAGE_KEYS.history);
    return normalizeHistory(stored[STORAGE_KEYS.history]);
  };

  const recordClipHistory = async (result: ClipResult): Promise<void> => {
    const existing = await getHistory();
    const entry: ClipHistoryItem = {
      id: `${result.folderId}:${result.clippedAt}`,
      title: result.title,
      sourceUrl: result.sourceUrl,
      folderId: result.folderId,
      folderUrl: result.folderUrl,
      folderName: result.folderName,
      clippedAt: result.clippedAt,
      imageCount: result.uploadedImages.length,
      warningCount: result.warnings.length,
    };

    const next = [
      entry,
      ...existing.filter((item) => item.folderId !== result.folderId),
    ].slice(0, MAX_CLIP_HISTORY_ITEMS);

    await getStorageLocal().set({ [STORAGE_KEYS.history]: next });
  };

  const resolveTargetTab = async (
    requestedTabId?: number,
  ): Promise<
    | { ok: true; tabId: number; url: string }
    | { ok: false; code: BackgroundErrorCode; error: string }
  > => {
    const tabsApi = getTabsApi();
    let tab: chrome.tabs.Tab | undefined;

    if (typeof requestedTabId === 'number') {
      tab = await tabsApi.get(requestedTabId);
    } else {
      const queried = await tabsApi.query({
        active: true,
        currentWindow: true,
      });
      tab = queried[0];
    }

    if (!tab || typeof tab.id !== 'number') {
      return {
        ok: false,
        code: 'UNSUPPORTED_PAGE',
        error: 'No active browser tab found to clip.',
      };
    }

    if (!isSupportedPageUrl(tab.url)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_PAGE',
        error:
          'This page cannot be clipped. Navigate to an http:// or https:// web page.',
      };
    }

    return { ok: true, tabId: tab.id, url: tab.url };
  };

  const injectAndSendContentMessage = async (
    tabId: number,
    message: ContentRequestMessage,
  ): Promise<ContentResponseMessage> => {
    await getScriptingApi().executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });

    const response = await getTabsApi().sendMessage(tabId, message);
    if (!response || typeof response !== 'object') {
      return { ok: false, error: 'Content script returned an empty response.' };
    }
    return response;
  };

  const getPageInfo = async (
    tabId?: number,
  ): Promise<BackgroundResponse<PageInfo>> => {
    const target = await resolveTargetTab(tabId);
    if (!target.ok) {
      return target;
    }

    try {
      const response = await injectAndSendContentMessage(target.tabId, {
        type: 'CONTENT_GET_PAGE_INFO',
      });
      if (!response.ok || response.type !== 'CONTENT_PAGE_INFO') {
        return {
          ok: false,
          code: 'EXTRACTION_FAILED',
          error: response.ok
            ? 'Unexpected content script response.'
            : response.error,
        };
      }

      return {
        ok: true,
        data: {
          tabId: target.tabId,
          ...response.data,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'EXTRACTION_FAILED',
        error: `Failed to inspect page: ${errorToMessage(error)}`,
      };
    }
  };

  const getAuthStatus = async (): Promise<BackgroundResponse<AuthStatus>> => {
    const oauthConfigured = isOAuthConfigured();
    if (!oauthConfigured) {
      return {
        ok: true,
        data: {
          oauthConfigured: false,
          authenticated: false,
        },
      };
    }

    try {
      await getAuthToken({ interactive: false });
      return {
        ok: true,
        data: {
          oauthConfigured: true,
          authenticated: true,
        },
      };
    } catch {
      return {
        ok: true,
        data: {
          oauthConfigured: true,
          authenticated: false,
        },
      };
    }
  };

  const signIn = async (): Promise<BackgroundResponse<AuthStatus>> => {
    if (!isOAuthConfigured()) {
      return {
        ok: false,
        code: 'OAUTH_NOT_CONFIGURED',
        error:
          'Google OAuth Client ID is still set to the template placeholder. Configure config.local.json and rebuild.',
      };
    }

    try {
      await getAuthToken({ interactive: true });
      return {
        ok: true,
        data: {
          oauthConfigured: true,
          authenticated: true,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        error: errorToMessage(error),
      };
    }
  };

  const signOut = async (): Promise<BackgroundResponse<AuthStatus>> => {
    const oauthConfigured = isOAuthConfigured();

    if (oauthConfigured) {
      let currentToken: string | null = null;
      try {
        currentToken = await getAuthToken({ interactive: false });
      } catch {
        currentToken = null;
      }

      if (currentToken) {
        await revokeAuthToken(currentToken);
      }
      await clearAllCachedAuthTokens();
    }

    return {
      ok: true,
      data: {
        oauthConfigured,
        authenticated: false,
      },
    };
  };

  const ensureRootFolderAction = async (options: {
    folderName?: string;
    forceNew?: boolean;
  }): Promise<BackgroundResponse<RootFolderInfo>> => {
    if (!isOAuthConfigured()) {
      return {
        ok: false,
        code: 'OAUTH_NOT_CONFIGURED',
        error:
          'Google OAuth Client ID is not configured. Add config.local.json and rebuild.',
      };
    }

    try {
      const settings = await getSettings();
      const targetName =
        options.folderName?.trim() || settings.rootFolderName || 'WebClips';
      const folderInfo = await driveClient.ensureRootFolder({
        rootFolderName: targetName,
        rootFolderId: settings.rootFolderId,
        forceNew: options.forceNew,
        interactive: true,
      });

      await updateSettings({
        rootFolderName: folderInfo.folderName,
        rootFolderId: folderInfo.folderId,
      });

      return { ok: true, data: folderInfo };
    } catch (error) {
      return {
        ok: false,
        code: classifyErrorCode(error),
        error: errorToMessage(error),
      };
    }
  };

  const runClip = async (
    request: ClipRequest,
  ): Promise<BackgroundResponse<ClipResult>> => {
    if (!isOAuthConfigured()) {
      return {
        ok: false,
        code: 'OAUTH_NOT_CONFIGURED',
        error:
          'Google OAuth Client ID is not configured. Open Options for setup instructions.',
      };
    }

    const target = await resolveTargetTab(request.tabId);
    if (!target.ok) {
      return target;
    }

    const clipId = createClipId();

    try {
      const settings = await getSettings();

      await emitProgress({
        clipId,
        stage: 'extracting',
        message: 'Extracting page content...',
      });

      const extractResponse = await injectAndSendContentMessage(target.tabId, {
        type: 'CONTENT_EXTRACT_PAGE',
        mode: request.mode,
      });

      if (!extractResponse.ok || extractResponse.type !== 'CONTENT_EXTRACTED_PAGE') {
        const message = extractResponse.ok
          ? 'Unexpected extraction response from content script.'
          : extractResponse.error;
        await emitProgress({
          clipId,
          stage: 'error',
          message,
          error: message,
        });
        return {
          ok: false,
          code: 'EXTRACTION_FAILED',
          error: message,
        };
      }

      const extracted = extractResponse.data;
      const totalImages = extracted.images.length;

      await emitProgress({
        clipId,
        stage: 'downloading',
        message:
          totalImages > 0
            ? `Downloading images (0/${totalImages})...`
            : 'No images to download',
        completed: 0,
        total: totalImages,
      });

      const batch = await fetchImagesImpl(extracted.images, extracted.url, {
        concurrency: settings.imageConcurrency,
        maxBytes: settings.maxImageSizeBytes,
        fetchImpl,
        ...deps.imageFetchOptions,
        onProgress: (completed, total) => {
          void emitProgress({
            clipId,
            stage: 'downloading',
            message: `Downloading images (${completed}/${total})...`,
            completed,
            total,
          });
        },
      });

      const rootFolder = await driveClient.ensureRootFolder({
        rootFolderName: settings.rootFolderName,
        rootFolderId: settings.rootFolderId,
        interactive: true,
      });

      if (
        rootFolder.folderId !== settings.rootFolderId ||
        rootFolder.folderName !== settings.rootFolderName
      ) {
        await updateSettings({
          rootFolderId: rootFolder.folderId,
          rootFolderName: rootFolder.folderName,
        });
      }

      const totalUploads = batch.succeeded.length + 1;
      const clippedAt = now().toISOString();

      const result = await driveClient.uploadArticle({
        rootFolderId: rootFolder.folderId,
        page: extracted,
        fetchedImages: batch.succeeded,
        failedImages: batch.failed,
        title: request.title,
        tags: request.tags ?? settings.defaultTags,
        folderName: request.folderName,
        clippedAt,
        frontmatterPreferences: settings.frontmatter,
        uploadConcurrency: settings.imageConcurrency,
        interactive: true,
        onProgress: (completed, total) => {
          void emitProgress({
            clipId,
            stage: 'uploading',
            message:
              completed < total
                ? `Uploading to Google Drive (${completed}/${total})...`
                : 'Finalizing README.md...',
            completed,
            total: total || totalUploads,
          });
        },
      });

      await recordClipHistory(result);

      await emitProgress({
        clipId,
        stage: 'done',
        message: 'Saved to Google Drive',
        result,
      });

      return { ok: true, data: result };
    } catch (error) {
      const message = errorToMessage(error);
      await emitProgress({
        clipId,
        stage: 'error',
        message,
        error: message,
      });
      return {
        ok: false,
        code: classifyErrorCode(error),
        error: message,
      };
    }
  };

  const handleMessage = async (
    rawMessage: unknown,
  ): Promise<BackgroundResponse<unknown>> => {
    if (!isUiToBackgroundMessage(rawMessage)) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        error: 'Unsupported message payload.',
      };
    }

    switch (rawMessage.type) {
      case 'GET_PAGE_INFO':
        return getPageInfo(rawMessage.tabId);
      case 'START_CLIP':
        return runClip(rawMessage.request);
      case 'GET_SETTINGS':
        return { ok: true, data: await getSettings() };
      case 'UPDATE_SETTINGS':
        return { ok: true, data: await updateSettings(rawMessage.patch) };
      case 'GET_HISTORY':
        return { ok: true, data: await getHistory() };
      case 'GET_AUTH_STATUS':
        return getAuthStatus();
      case 'SIGN_IN':
        return signIn();
      case 'SIGN_OUT':
        return signOut();
      case 'ENSURE_ROOT_FOLDER':
        return ensureRootFolderAction({
          folderName: rawMessage.folderName,
          forceNew: rawMessage.forceNew,
        });
    }
  };

  const handleContextMenuClick = async (
    info: Pick<chrome.contextMenus.OnClickData, 'menuItemId'>,
    tab?: Pick<chrome.tabs.Tab, 'id' | 'url'>,
  ): Promise<void> => {
    if (info.menuItemId !== CONTEXT_MENU_CLIP_SELECTION_ID) {
      return;
    }

    await setBadge('...', '#2563eb');
    const result = await runClip({
      tabId: tab?.id,
      mode: 'selection',
    });

    if (result.ok) {
      await setBadge('OK', '#16a34a');
    } else {
      await setBadge('!', '#dc2626');
    }
  };

  return {
    handleMessage,
    runClip,
    handleContextMenuClick,
    getSettings,
    updateSettings,
    getHistory,
  };
}

export function registerContextMenus(): void {
  if (typeof chrome === 'undefined' || !chrome.contextMenus) {
    return;
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_CLIP_SELECTION_ID,
      title: 'Clip selection to Google Drive',
      contexts: ['selection'],
    });
  });
}

function registerServiceWorkerListeners(): void {
  const scope = globalThis as Record<string, unknown>;
  if (scope[SW_LISTENER_SENTINEL]) {
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }

  scope[SW_LISTENER_SENTINEL] = true;
  const controller = createServiceWorkerController();

  chrome.runtime.onInstalled?.addListener(() => {
    registerContextMenus();
  });

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    void controller.handleContextMenuClick(info, tab);
  });

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: BackgroundResponse<unknown>) => void,
    ): boolean | undefined => {
      if (!isUiToBackgroundMessage(message)) {
        return undefined;
      }

      void controller.handleMessage(message).then(sendResponse, (error: unknown) => {
        sendResponse({
          ok: false,
          code: classifyErrorCode(error),
          error: errorToMessage(error),
        });
      });

      return true;
    },
  );
}

registerServiceWorkerListeners();
