import { buildArticleFolderName, cleanPageTitle } from '../core/frontmatter.js';
import {
  DriveApiError,
  DriveClient,
  clearAllCachedChromeAuthTokens,
  getChromeDriveAuthToken,
  removeCachedChromeAuthToken,
  revokeChromeAuthToken,
} from '../drive/drive-client.js';
import {
  DEFAULT_EXTENSION_SETTINGS,
  STORAGE_KEYS,
  getBuildWebAuthClientId,
  isActiveClipJobStatus,
  isConfiguredOAuthClientIdValue,
  type AuthStatus,
  type BackgroundErrorCode,
  type BackgroundPushMessage,
  type BackgroundResponse,
  type ClipHistoryItem,
  type ClipJob,
  type ClipJobStatus,
  type ClipProgressEvent,
  type ClipRequest,
  type ClipResult,
  type ContentRequestMessage,
  type ContentResponseMessage,
  type ExtensionSettings,
  type ExtractedPage,
  type PageInfo,
  type RootFolderInfo,
  type UiToBackgroundMessage,
} from '../types.js';
import {
  cleanupOrphanedRefererSessionRules,
  fetchImages,
  type ImageFetchOptions,
} from './image-fetcher.js';

export const CONTEXT_MENU_CLIP_SELECTION_ID = 'drive-clipper-clip-selection';
export const MAX_CLIP_HISTORY_ITEMS = 10;
export const MAX_CLIP_JOBS = 20;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_BADGE_CLEAR_DELAY_MS = 8_000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
export const ORPHANED_JOB_ERROR_MESSAGE =
  'Background worker restarted before upload finished. Re-open the tab and clip again.';

const CONTENT_SCRIPT_FILE = 'content.js';
const SW_LISTENER_SENTINEL = '__driveClipperServiceWorkerRegistered__';
const ROOT_FOLDER_CACHE_TTL_MS = 5 * 60_000;

const BADGE_COLOR_ACTIVE = '#2563eb';
const BADGE_COLOR_DONE = '#16a34a';
const BADGE_COLOR_ERROR = '#dc2626';

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
  storageSession?: StorageAreaLike;
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
  /** Maximum concurrent background download+upload jobs. Defaults to 2. */
  maxConcurrentJobs?: number;
  /** Delay in ms before auto-clearing the green "OK" badge back to "". Defaults to 8000. */
  badgeClearDelayMs?: number;
  /** Interval in ms for MV3 Service Worker keepalive pings while active jobs remain. Defaults to 15000. */
  keepaliveIntervalMs?: number;
  /** Lightweight extension API ping invoked on each keepalive tick while active jobs remain. */
  keepalivePing?: () => Promise<void>;
  now?: () => Date;
  createClipId?: () => string;
  imageFetchOptions?: Partial<ImageFetchOptions>;
}

export interface ServiceWorkerController {
  handleMessage(message: unknown): Promise<BackgroundResponse<unknown>>;
  enqueueClip(request: ClipRequest): Promise<BackgroundResponse<ClipJob>>;
  runClip(request: ClipRequest): Promise<BackgroundResponse<ClipResult>>;
  handleContextMenuClick(
    info: Pick<chrome.contextMenus.OnClickData, 'menuItemId'>,
    tab?: Pick<chrome.tabs.Tab, 'id' | 'url'>,
  ): Promise<void>;
  getClipJobs(): Promise<ClipJob[]>;
  dismissClipJob(jobId: string): Promise<ClipJob[]>;
  clearCompletedJobs(): Promise<ClipJob[]>;
  whenIdle(): Promise<void>;
  getSettings(): Promise<ExtensionSettings>;
  updateSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
  getHistory(): Promise<ClipHistoryItem[]>;
}

type BadgeSyncReason =
  | 'hydrate'
  | 'active-updated'
  | 'job-completed'
  | 'job-failed'
  | 'dismissed'
  | 'cleared';

interface QueuedUploadTask {
  jobId: string;
  request: ClipRequest;
  extracted: ExtractedPage;
  settings: ExtensionSettings;
  effectiveFolderName: string;
  resolveResult: (result: BackgroundResponse<ClipResult>) => void;
}

export function isConfiguredOAuthClientId(clientId: unknown): boolean {
  return isConfiguredOAuthClientIdValue(clientId);
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

function createInMemoryStorageArea(): StorageAreaLike {
  const store: Record<string, unknown> = {};
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
  };
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

function isClipJobStatus(value: unknown): value is ClipJobStatus {
  return (
    value === 'extracting' ||
    value === 'queued' ||
    value === 'downloading' ||
    value === 'uploading' ||
    value === 'done' ||
    value === 'error'
  );
}

function cloneClipJob(job: ClipJob): ClipJob {
  return {
    ...job,
    ...(job.result
      ? {
          result: {
            ...job.result,
            uploadedImages: job.result.uploadedImages.map((img) => ({ ...img })),
            failedImages: job.result.failedImages.map((fail) => ({
              ...fail,
              sourceUrls: [...fail.sourceUrls],
            })),
            warnings: [...job.result.warnings],
          },
        }
      : {}),
  };
}

function normalizeClipJobs(raw: unknown): ClipJob[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: ClipJob[] = [];
  const seenIds = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as Partial<ClipJob>;
    if (
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      seenIds.has(candidate.id) ||
      typeof candidate.url !== 'string' ||
      typeof candidate.title !== 'string' ||
      typeof candidate.folderName !== 'string' ||
      (candidate.mode !== 'full' && candidate.mode !== 'selection') ||
      !isClipJobStatus(candidate.status) ||
      typeof candidate.message !== 'string' ||
      typeof candidate.createdAt !== 'string' ||
      typeof candidate.updatedAt !== 'string'
    ) {
      continue;
    }

    seenIds.add(candidate.id);
    normalized.push(
      cloneClipJob({
        id: candidate.id,
        ...(typeof candidate.tabId === 'number' ? { tabId: candidate.tabId } : {}),
        url: candidate.url,
        title: candidate.title,
        folderName: candidate.folderName,
        mode: candidate.mode,
        status: candidate.status,
        message: candidate.message,
        ...(typeof candidate.completed === 'number'
          ? { completed: candidate.completed }
          : {}),
        ...(typeof candidate.total === 'number' ? { total: candidate.total } : {}),
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        ...(candidate.result ? { result: candidate.result } : {}),
        ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
        ...(typeof candidate.errorCode === 'string'
          ? { errorCode: candidate.errorCode }
          : {}),
      }),
    );
  }

  return pruneClipJobs(normalized);
}

/**
 * Caps stored clip jobs to `MAX_CLIP_JOBS`, always retaining every active/queued
 * job plus the most recent finished/failed jobs.
 */
function pruneClipJobs(
  jobs: readonly ClipJob[],
  maxJobs = MAX_CLIP_JOBS,
): ClipJob[] {
  if (jobs.length <= maxJobs) {
    return jobs.map(cloneClipJob);
  }

  const activeCount = jobs.reduce(
    (count, job) => count + (isActiveClipJobStatus(job.status) ? 1 : 0),
    0,
  );
  let terminalBudget = Math.max(0, maxJobs - activeCount);

  const kept: ClipJob[] = [];
  for (const job of jobs) {
    if (isActiveClipJobStatus(job.status)) {
      kept.push(cloneClipJob(job));
    } else if (terminalBudget > 0) {
      kept.push(cloneClipJob(job));
      terminalBudget -= 1;
    }
  }
  return kept;
}

function isUiToBackgroundMessage(value: unknown): value is UiToBackgroundMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === 'GET_PAGE_INFO' ||
    type === 'START_CLIP' ||
    type === 'GET_CLIP_JOBS' ||
    type === 'DISMISS_CLIP_JOB' ||
    type === 'CLEAR_COMPLETED_JOBS' ||
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

async function defaultKeepalivePing(): Promise<void> {
  if (typeof chrome === 'undefined') {
    return;
  }
  try {
    if (typeof chrome.runtime?.getPlatformInfo === 'function') {
      await chrome.runtime.getPlatformInfo();
      return;
    }
    if (typeof chrome.storage?.session?.get === 'function') {
      await chrome.storage.session.get(STORAGE_KEYS.clipJobs);
    }
  } catch {
    // Keepalive heartbeat is best-effort; never interrupt active clip jobs.
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
    deps.clearAllCachedAuthTokens ?? clearAllCachedChromeAuthTokens;
  const driveClient =
    deps.driveClient ??
    new DriveClient({
      fetchImpl,
      ...(deps.getAuthToken
        ? { tokenProvider: deps.getAuthToken }
        : { onUnauthorizedToken: removeCachedChromeAuthToken }),
    });
  const fetchImagesImpl = deps.fetchImagesImpl ?? fetchImages;
  const emitPushMessage = deps.emitPushMessage ?? defaultEmitPushMessage;
  const setBadge = deps.setBadge ?? defaultSetBadge;
  const now = deps.now ?? (() => new Date());
  const createClipId = deps.createClipId ?? (() => crypto.randomUUID());
  const maxConcurrentJobs = Math.max(
    1,
    Math.floor(deps.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS),
  );
  const badgeClearDelayMs = Math.max(
    0,
    deps.badgeClearDelayMs ?? DEFAULT_BADGE_CLEAR_DELAY_MS,
  );
  const keepaliveIntervalMs = Math.max(
    1,
    deps.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
  );
  const keepalivePing = deps.keepalivePing ?? defaultKeepalivePing;

  // Fallback in-memory session store only used outside Chrome when no storageSession is injected.
  let fallbackSessionStorage: StorageAreaLike | null = null;

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

  const getStorageSession = (): StorageAreaLike => {
    if (deps.storageSession) {
      return deps.storageSession;
    }
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      return {
        get: (keys: string) => chrome.storage.session.get(keys),
        set: (items: Record<string, unknown>) => chrome.storage.session.set(items),
      };
    }
    if (!fallbackSessionStorage) {
      fallbackSessionStorage = createInMemoryStorageArea();
    }
    return fallbackSessionStorage;
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
    return (
      isConfiguredOAuthClientId(manifest?.oauth2?.client_id) ||
      getBuildWebAuthClientId() !== null
    );
  };

  // --- Serialized settings & history state ---

  let settingsWriteChain: Promise<void> = Promise.resolve();
  let historyWriteChain: Promise<void> = Promise.resolve();

  let cachedRootFolder: {
    info: RootFolderInfo;
    rootFolderName: string;
    verifiedAtMs: number;
  } | null = null;
  const inFlightRootFolders = new Map<string, Promise<RootFolderInfo>>();

  const getSettings = async (): Promise<ExtensionSettings> => {
    const stored = await getStorageSync().get(STORAGE_KEYS.settings);
    return normalizeSettings(stored[STORAGE_KEYS.settings]);
  };

  const updateSettings = async (
    patch: Partial<ExtensionSettings>,
  ): Promise<ExtensionSettings> => {
    const operation = settingsWriteChain.then(async () => {
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
      if (
        patch.rootFolderName !== undefined ||
        patch.rootFolderId !== undefined
      ) {
        cachedRootFolder = null;
      }
      return merged;
    });
    settingsWriteChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const getHistory = async (): Promise<ClipHistoryItem[]> => {
    const stored = await getStorageLocal().get(STORAGE_KEYS.history);
    return normalizeHistory(stored[STORAGE_KEYS.history]);
  };

  const recordClipHistory = async (result: ClipResult): Promise<void> => {
    const operation = historyWriteChain.then(async () => {
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
    });
    historyWriteChain = operation.catch(() => undefined);
    await operation;
  };

  // --- Single-flight root folder resolution ---

  const ensureRootFolderForClip = (interactive = true): Promise<RootFolderInfo> => {
    const key = '__clip_root__';
    const existing = inFlightRootFolders.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<RootFolderInfo> => {
      const settings = await getSettings();
      if (
        cachedRootFolder &&
        cachedRootFolder.rootFolderName === settings.rootFolderName &&
        cachedRootFolder.info.folderId === settings.rootFolderId &&
        now().getTime() - cachedRootFolder.verifiedAtMs < ROOT_FOLDER_CACHE_TTL_MS
      ) {
        return cachedRootFolder.info;
      }

      const folderInfo = await driveClient.ensureRootFolder({
        rootFolderName: settings.rootFolderName,
        rootFolderId: settings.rootFolderId,
        interactive,
      });

      if (
        folderInfo.folderId !== settings.rootFolderId ||
        folderInfo.folderName !== settings.rootFolderName
      ) {
        await updateSettings({
          rootFolderId: folderInfo.folderId,
          rootFolderName: folderInfo.folderName,
        });
      }

      cachedRootFolder = {
        info: folderInfo,
        rootFolderName: folderInfo.folderName,
        verifiedAtMs: now().getTime(),
      };
      return folderInfo;
    })().finally(() => {
      if (inFlightRootFolders.get(key) === promise) {
        inFlightRootFolders.delete(key);
      }
    });

    inFlightRootFolders.set(key, promise);
    return promise;
  };

  // --- Clip Job Queue, persistence, unified badge, and orphan recovery ---

  let jobs: ClipJob[] = [];
  const liveJobIds = new Set<string>();
  const jobCompletions = new Map<string, Promise<BackgroundResponse<ClipResult>>>();
  const pendingQueue: QueuedUploadTask[] = [];
  let runningWorkers = 0;

  let hydrationPromise: Promise<void> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let pendingPersistSnapshot: ClipJob[] | null = null;
  let pushChain: Promise<void> = Promise.resolve();
  let badgeChain: Promise<void> = Promise.resolve();
  let lastBadge: { text: string; color: string } | null = null;
  let okBadgeTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const inFlightEffects = new Set<Promise<void>>();
  const idleWaiters = new Set<() => void>();

  const stopKeepalive = (): void => {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  const syncKeepalive = (): void => {
    if (liveJobIds.size === 0) {
      stopKeepalive();
      return;
    }
    if (keepaliveTimer !== null) {
      return;
    }
    const timer = setInterval(() => {
      if (liveJobIds.size === 0) {
        stopKeepalive();
        return;
      }
      void keepalivePing().catch(() => undefined);
    }, keepaliveIntervalMs);
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof (timer as { unref?: unknown }).unref === 'function'
    ) {
      (timer as { unref: () => void }).unref();
    }
    keepaliveTimer = timer;
  };

  const trackEffect = (promise: Promise<void>): Promise<void> => {
    const tracked = promise.catch(() => undefined);
    inFlightEffects.add(tracked);
    void tracked.finally(() => {
      inFlightEffects.delete(tracked);
      notifyIdleWaiters();
    });
    return tracked;
  };

  const notifyIdleWaiters = (): void => {
    if (liveJobIds.size === 0) {
      stopKeepalive();
    }
    if (
      liveJobIds.size === 0 &&
      pendingQueue.length === 0 &&
      runningWorkers === 0 &&
      inFlightEffects.size === 0
    ) {
      for (const resolve of idleWaiters) {
        resolve();
      }
      idleWaiters.clear();
    }
  };

  const getJobsSnapshot = (): ClipJob[] => jobs.map(cloneClipJob);

  const findJob = (jobId: string): ClipJob | undefined =>
    jobs.find((job) => job.id === jobId);

  const getActiveJobCount = (): number =>
    jobs.reduce(
      (count, job) => count + (isActiveClipJobStatus(job.status) ? 1 : 0),
      0,
    );

  const hasErrorJob = (): boolean => jobs.some((job) => job.status === 'error');

  const clearOkBadgeTimer = (): void => {
    if (okBadgeTimer !== null) {
      clearTimeout(okBadgeTimer);
      okBadgeTimer = null;
    }
  };

  const applyBadge = (text: string, color: string): Promise<void> => {
    if (lastBadge && lastBadge.text === text && lastBadge.color === color) {
      return badgeChain;
    }
    lastBadge = { text, color };
    const next = badgeChain.then(() => setBadge(text, color));
    badgeChain = next.catch(() => undefined);
    return trackEffect(next);
  };

  const syncBadge = (reason: BadgeSyncReason): Promise<void> => {
    const activeCount = getActiveJobCount();
    if (activeCount > 0) {
      clearOkBadgeTimer();
      return applyBadge(String(activeCount), BADGE_COLOR_ACTIVE);
    }

    if (hasErrorJob()) {
      clearOkBadgeTimer();
      return applyBadge('!', BADGE_COLOR_ERROR);
    }

    if (reason === 'job-completed') {
      clearOkBadgeTimer();
      const promise = applyBadge('OK', BADGE_COLOR_DONE);
      const timer = setTimeout(() => {
        okBadgeTimer = null;
        if (getActiveJobCount() === 0 && !hasErrorJob()) {
          void applyBadge('', '');
        }
      }, badgeClearDelayMs);
      if (
        typeof timer === 'object' &&
        timer !== null &&
        'unref' in timer &&
        typeof (timer as { unref?: unknown }).unref === 'function'
      ) {
        (timer as { unref: () => void }).unref();
      }
      okBadgeTimer = timer;
      return promise;
    }

    if (reason === 'dismissed' || reason === 'cleared') {
      clearOkBadgeTimer();
      return applyBadge('', '');
    }

    // On hydrate with no active jobs and no errors, keep any existing empty state clean.
    if (okBadgeTimer === null && lastBadge && lastBadge.text.length > 0) {
      return applyBadge('', '');
    }
    return badgeChain;
  };

  const emitPushOrdered = (message: BackgroundPushMessage): Promise<void> => {
    const next = pushChain.then(() => emitPushMessage(message));
    pushChain = next.catch(() => undefined);
    return trackEffect(next);
  };

  const emitProgress = (event: ClipProgressEvent): Promise<void> =>
    emitPushOrdered({ type: 'CLIP_PROGRESS', event });

  const commitJobs = (reason: BadgeSyncReason): Promise<void> => {
    jobs = pruneClipJobs(jobs);
    const snapshot = getJobsSnapshot();
    pendingPersistSnapshot = snapshot;

    const persistOp = persistChain.then(async () => {
      const toWrite = pendingPersistSnapshot;
      if (!toWrite) {
        return;
      }
      pendingPersistSnapshot = null;
      await getStorageSession().set({ [STORAGE_KEYS.clipJobs]: toWrite });
    });
    persistChain = persistOp.catch(() => undefined);

    const badgeOp = syncBadge(reason);
    const broadcastOp = emitPushOrdered({
      type: 'CLIP_JOBS_UPDATED',
      jobs: snapshot,
    });

    return trackEffect(
      Promise.all([persistOp, badgeOp, broadcastOp]).then(() => undefined),
    );
  };

  const updateJobSync = (
    jobId: string,
    patch: Partial<Omit<ClipJob, 'id' | 'createdAt'>>,
  ): ClipJob | null => {
    const idx = jobs.findIndex((job) => job.id === jobId);
    if (idx === -1) {
      return null;
    }
    const updated: ClipJob = {
      ...jobs[idx],
      ...patch,
      updatedAt: now().toISOString(),
    };
    jobs[idx] = updated;
    return updated;
  };

  const ensureHydrated = (): Promise<void> => {
    if (!hydrationPromise) {
      hydrationPromise = (async () => {
        const stored = await getStorageSession().get(STORAGE_KEYS.clipJobs);
        const restored = normalizeClipJobs(stored[STORAGE_KEYS.clipJobs]);

        let recoveredOrphans = false;
        const recoveryTimestamp = now().toISOString();

        const reconciled = restored.map((job) => {
          if (isActiveClipJobStatus(job.status) && !liveJobIds.has(job.id)) {
            recoveredOrphans = true;
            return {
              ...job,
              status: 'error' as const,
              message: ORPHANED_JOB_ERROR_MESSAGE,
              error: ORPHANED_JOB_ERROR_MESSAGE,
              updatedAt: recoveryTimestamp,
            };
          }
          return job;
        });

        // Merge any live jobs created concurrently (if any) ahead of restored ones.
        if (jobs.length === 0) {
          jobs = pruneClipJobs(reconciled);
        } else {
          const existingIds = new Set(jobs.map((job) => job.id));
          jobs = pruneClipJobs([
            ...jobs,
            ...reconciled.filter((job) => !existingIds.has(job.id)),
          ]);
        }

        if (recoveredOrphans) {
          await commitJobs('hydrate');
        } else if (hasErrorJob() || getActiveJobCount() > 0) {
          await syncBadge('hydrate');
        }
      })().catch((error) => {
        hydrationPromise = null;
        throw error;
      });
    }
    return hydrationPromise;
  };

  // --- Worker execution ---

  const executeQueuedTask = async (task: QueuedUploadTask): Promise<void> => {
    const { jobId, request, extracted, settings, effectiveFolderName, resolveResult } =
      task;

    try {
      const totalImages = extracted.images.length;
      const downloadMessage =
        totalImages > 0
          ? `Downloading images (0/${totalImages})...`
          : 'No images to download';

      updateJobSync(jobId, {
        status: 'downloading',
        message: downloadMessage,
        completed: 0,
        total: totalImages,
      });
      await commitJobs('active-updated');
      await emitProgress({
        clipId: jobId,
        stage: 'downloading',
        message: downloadMessage,
        completed: 0,
        total: totalImages,
      });

      const batch = await fetchImagesImpl(extracted.images, extracted.url, {
        concurrency: settings.imageConcurrency,
        maxBytes: settings.maxImageSizeBytes,
        fetchImpl,
        ...deps.imageFetchOptions,
        onProgress: (completed, total) => {
          const current = findJob(jobId);
          if (!current || current.status !== 'downloading') {
            return;
          }
          const progressMsg = `Downloading images (${completed}/${total})...`;
          updateJobSync(jobId, {
            message: progressMsg,
            completed,
            total,
          });
          void commitJobs('active-updated');
          void emitProgress({
            clipId: jobId,
            stage: 'downloading',
            message: progressMsg,
            completed,
            total,
          });
        },
      });

      const rootFolder = await ensureRootFolderForClip(true);

      const totalUploads = batch.succeeded.length + 1;
      const initialUploadMsg = `Uploading to Google Drive (0/${totalUploads})...`;
      updateJobSync(jobId, {
        status: 'uploading',
        message: initialUploadMsg,
        completed: 0,
        total: totalUploads,
      });
      await commitJobs('active-updated');
      await emitProgress({
        clipId: jobId,
        stage: 'uploading',
        message: initialUploadMsg,
        completed: 0,
        total: totalUploads,
      });

      const clippedAt = now().toISOString();
      const explicitTitle = request.title?.trim();

      const result = await driveClient.uploadArticle({
        rootFolderId: rootFolder.folderId,
        page: extracted,
        fetchedImages: batch.succeeded,
        failedImages: batch.failed,
        ...(explicitTitle ? { title: explicitTitle } : {}),
        tags: request.tags ?? settings.defaultTags,
        folderName: effectiveFolderName,
        clippedAt,
        frontmatterPreferences: settings.frontmatter,
        uploadConcurrency: settings.imageConcurrency,
        interactive: true,
        onProgress: (completed, total) => {
          const current = findJob(jobId);
          if (!current || current.status !== 'uploading') {
            return;
          }
          const resolvedTotal = total || totalUploads;
          const progressMsg =
            completed < resolvedTotal
              ? `Uploading to Google Drive (${completed}/${resolvedTotal})...`
              : 'Finalizing README.md...';
          updateJobSync(jobId, {
            message: progressMsg,
            completed,
            total: resolvedTotal,
          });
          void commitJobs('active-updated');
          void emitProgress({
            clipId: jobId,
            stage: 'uploading',
            message: progressMsg,
            completed,
            total: resolvedTotal,
          });
        },
      });

      await recordClipHistory(result);

      liveJobIds.delete(jobId);
      syncKeepalive();
      updateJobSync(jobId, {
        status: 'done',
        title: result.title,
        folderName: result.folderName,
        message: 'Saved to Google Drive',
        completed: totalUploads,
        total: totalUploads,
        result,
        error: undefined,
        errorCode: undefined,
      });
      await commitJobs('job-completed');
      await emitProgress({
        clipId: jobId,
        stage: 'done',
        message: 'Saved to Google Drive',
        result,
      });

      resolveResult({ ok: true, data: result });
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) {
        cachedRootFolder = null;
      }

      const message = errorToMessage(error);
      const code = classifyErrorCode(error);

      liveJobIds.delete(jobId);
      syncKeepalive();
      updateJobSync(jobId, {
        status: 'error',
        message,
        error: message,
        errorCode: code,
      });
      await commitJobs('job-failed');
      await emitProgress({
        clipId: jobId,
        stage: 'error',
        message,
        error: message,
      });

      resolveResult({
        ok: false,
        code,
        error: message,
      });
    } finally {
      jobCompletions.delete(jobId);
    }
  };

  const drainQueue = (): void => {
    while (runningWorkers < maxConcurrentJobs && pendingQueue.length > 0) {
      const nextTask = pendingQueue.shift();
      if (!nextTask) {
        break;
      }
      runningWorkers += 1;
      void executeQueuedTask(nextTask).finally(() => {
        runningWorkers -= 1;
        drainQueue();
        notifyIdleWaiters();
      });
    }
    notifyIdleWaiters();
  };

  // --- Tab resolution and content script messaging ---

  const resolveTargetTab = async (
    requestedTabId?: number,
  ): Promise<
    | { ok: true; tabId: number; url: string; title?: string }
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

    return {
      ok: true,
      tabId: tab.id,
      url: tab.url,
      ...(typeof tab.title === 'string' && tab.title.trim().length > 0
        ? { title: tab.title }
        : {}),
    };
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
    cachedRootFolder = null;

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

      cachedRootFolder = {
        info: folderInfo,
        rootFolderName: folderInfo.folderName,
        verifiedAtMs: now().getTime(),
      };

      return { ok: true, data: folderInfo };
    } catch (error) {
      return {
        ok: false,
        code: classifyErrorCode(error),
        error: errorToMessage(error),
      };
    }
  };

  // --- Public Clip Job Queue operations ---

  const enqueueClip = async (
    request: ClipRequest,
  ): Promise<BackgroundResponse<ClipJob>> => {
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

    await ensureHydrated();

    const clipId = createClipId();
    const createdAt = now().toISOString();
    const explicitTitle = request.title?.trim();
    const initialTitle =
      explicitTitle ||
      (target.title ? cleanPageTitle(target.title) : '') ||
      target.url;
    const explicitFolderName = request.folderName?.trim();
    const initialFolderName =
      explicitFolderName || buildArticleFolderName(initialTitle, createdAt);

    const initialJob: ClipJob = {
      id: clipId,
      tabId: target.tabId,
      url: target.url,
      title: initialTitle,
      folderName: initialFolderName,
      mode: request.mode,
      status: 'extracting',
      message: 'Extracting page content...',
      createdAt,
      updatedAt: createdAt,
    };

    liveJobIds.add(clipId);
    syncKeepalive();
    jobs.unshift(initialJob);
    await commitJobs('active-updated');
    await emitProgress({
      clipId,
      stage: 'extracting',
      message: 'Extracting page content...',
    });

    let settings: ExtensionSettings;
    let extracted: ExtractedPage;

    try {
      settings = await getSettings();
      const extractResponse = await injectAndSendContentMessage(target.tabId, {
        type: 'CONTENT_EXTRACT_PAGE',
        mode: request.mode,
      });

      if (!extractResponse.ok || extractResponse.type !== 'CONTENT_EXTRACTED_PAGE') {
        const message = extractResponse.ok
          ? 'Unexpected extraction response from content script.'
          : extractResponse.error;

        liveJobIds.delete(clipId);
        syncKeepalive();
        updateJobSync(clipId, {
          status: 'error',
          message,
          error: message,
          errorCode: 'EXTRACTION_FAILED',
        });
        await commitJobs('job-failed');
        await emitProgress({
          clipId,
          stage: 'error',
          message,
          error: message,
        });
        notifyIdleWaiters();
        return {
          ok: false,
          code: 'EXTRACTION_FAILED',
          error: message,
        };
      }

      extracted = extractResponse.data;
    } catch (error) {
      const message = errorToMessage(error);
      liveJobIds.delete(clipId);
      syncKeepalive();
      updateJobSync(clipId, {
        status: 'error',
        message,
        error: message,
        errorCode: 'EXTRACTION_FAILED',
      });
      await commitJobs('job-failed');
      await emitProgress({
        clipId,
        stage: 'error',
        message,
        error: message,
      });
      notifyIdleWaiters();
      return {
        ok: false,
        code: 'EXTRACTION_FAILED',
        error: message,
      };
    }

    const effectiveTitle = explicitTitle || extracted.title || initialTitle;
    const effectiveFolderName =
      explicitFolderName || buildArticleFolderName(effectiveTitle, createdAt);

    const queuedJob = updateJobSync(clipId, {
      url: extracted.url || target.url,
      title: effectiveTitle,
      folderName: effectiveFolderName,
      mode: extracted.mode,
      status: 'queued',
      message: 'Queued for background upload...',
    });
    await commitJobs('active-updated');

    const acceptedJob = cloneClipJob(queuedJob ?? initialJob);

    let resolveResult!: (result: BackgroundResponse<ClipResult>) => void;
    const completionPromise = new Promise<BackgroundResponse<ClipResult>>(
      (resolve) => {
        resolveResult = resolve;
      },
    );
    jobCompletions.set(clipId, completionPromise);

    pendingQueue.push({
      jobId: clipId,
      request,
      extracted,
      settings,
      effectiveFolderName,
      resolveResult,
    });
    drainQueue();

    return { ok: true, data: acceptedJob };
  };

  const runClip = async (
    request: ClipRequest,
  ): Promise<BackgroundResponse<ClipResult>> => {
    const enqueued = await enqueueClip(request);
    if (!enqueued.ok) {
      return enqueued;
    }

    const completion = jobCompletions.get(enqueued.data.id);
    if (completion) {
      return completion;
    }

    const finished = findJob(enqueued.data.id);
    if (finished?.status === 'done' && finished.result) {
      return { ok: true, data: finished.result };
    }
    return {
      ok: false,
      code: finished?.errorCode ?? 'DRIVE_ERROR',
      error: finished?.error ?? 'Clip job did not complete.',
    };
  };

  const getClipJobs = async (): Promise<ClipJob[]> => {
    await ensureHydrated();
    return getJobsSnapshot();
  };

  const dismissClipJob = async (jobId: string): Promise<ClipJob[]> => {
    await ensureHydrated();
    const target = findJob(jobId);
    if (target && !isActiveClipJobStatus(target.status)) {
      jobs = jobs.filter((job) => job.id !== jobId);
      await commitJobs('dismissed');
    }
    return getJobsSnapshot();
  };

  const clearCompletedJobs = async (): Promise<ClipJob[]> => {
    await ensureHydrated();
    const before = jobs.length;
    jobs = jobs.filter((job) => isActiveClipJobStatus(job.status));
    if (jobs.length !== before) {
      await commitJobs('cleared');
    }
    return getJobsSnapshot();
  };

  const whenIdle = async (): Promise<void> => {
    for (;;) {
      if (
        liveJobIds.size === 0 &&
        pendingQueue.length === 0 &&
        runningWorkers === 0 &&
        inFlightEffects.size === 0
      ) {
        await Promise.all([
          persistChain,
          pushChain,
          badgeChain,
          historyWriteChain,
          settingsWriteChain,
        ]);
        if (
          liveJobIds.size === 0 &&
          pendingQueue.length === 0 &&
          runningWorkers === 0 &&
          inFlightEffects.size === 0
        ) {
          return;
        }
      }
      await new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
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
        return enqueueClip(rawMessage.request);
      case 'GET_CLIP_JOBS':
        return { ok: true, data: await getClipJobs() };
      case 'DISMISS_CLIP_JOB': {
        if (
          typeof rawMessage.jobId !== 'string' ||
          rawMessage.jobId.trim().length === 0
        ) {
          return {
            ok: false,
            code: 'INVALID_MESSAGE',
            error: 'Missing jobId for DISMISS_CLIP_JOB.',
          };
        }
        return { ok: true, data: await dismissClipJob(rawMessage.jobId) };
      }
      case 'CLEAR_COMPLETED_JOBS':
        return { ok: true, data: await clearCompletedJobs() };
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

    const result = await runClip({
      tabId: tab?.id,
      mode: 'selection',
    });

    if (!result.ok && getActiveJobCount() === 0 && !hasErrorJob()) {
      clearOkBadgeTimer();
      await applyBadge('!', BADGE_COLOR_ERROR);
    }
  };

  return {
    handleMessage,
    enqueueClip,
    runClip,
    handleContextMenuClick,
    getClipJobs,
    dismissClipJob,
    clearCompletedJobs,
    whenIdle,
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

  // Eagerly recover orphaned jobs and DNR session rules after a cold SW restart.
  void cleanupOrphanedRefererSessionRules().catch(() => undefined);
  void controller.getClipJobs().catch(() => undefined);

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
