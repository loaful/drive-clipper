/**
 * Shared domain contracts and message protocols across content script,
 * background service worker, Drive client, and popup/options UI.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const OAUTH_CLIENT_ID_PLACEHOLDER =
  'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
export const DRIVE_FOLDER_URL_PREFIX = 'https://drive.google.com/drive/folders/';

export const STORAGE_KEYS = {
  settings: 'driveClipper.settings',
  history: 'driveClipper.history',
  webAuthToken: 'driveClipper.webAuthToken',
  clipJobs: 'clipJobs',
} as const;

export type ClipMode = 'full' | 'selection';

export interface DiscoveredImage {
  /** Stable identifier within a single clip (e.g. "img-01"). */
  id: string;
  /** Primary URL string as it appears in the extracted Markdown. */
  originalUrl: string;
  /** Normalized absolute URL fetched by the background image downloader. */
  resolvedUrl: string;
  /** All raw/markdown URL variants deduplicated onto this image (always includes originalUrl). */
  sourceUrls: string[];
  /** Alt text captured from the image element or Markdown syntax. */
  alt: string;
  /** Extensionless sanitized base filename (e.g. "01-architecture-diagram"). */
  suggestedName: string;
  width?: number;
  height?: number;
}

export interface ExtractedPage {
  url: string;
  title: string;
  author: string | null;
  published: string | null;
  site: string | null;
  description: string | null;
  markdown: string;
  mode: ClipMode;
  hasSelection: boolean;
  images: DiscoveredImage[];
  warnings: string[];
  /** ISO-8601 UTC timestamp when extraction completed. */
  extractedAt: string;
}

export interface PageInfo {
  tabId: number;
  url: string;
  title: string;
  hasSelection: boolean;
  selectionLength: number;
  site: string | null;
}

export interface FetchedImage {
  id: string;
  originalUrl: string;
  resolvedUrl: string;
  sourceUrls: string[];
  /** Final filename with extension sniffed from Content-Type / magic bytes (e.g. "01-hero.webp"). */
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  byteLength: number;
}

export interface ImageFetchFailure {
  id: string;
  originalUrl: string;
  resolvedUrl: string;
  sourceUrls: string[];
  reason: string;
  status?: number;
}

export interface ImageFetchBatchResult {
  succeeded: FetchedImage[];
  failed: ImageFetchFailure[];
}

export interface UploadedImageInfo {
  id: string;
  filename: string;
  fileId: string;
  mimeType: string;
  resolvedUrl: string;
}

export interface ClipRequest {
  tabId?: number;
  title?: string;
  tags?: string[];
  mode: ClipMode;
  /** Optional explicit folder name; defaults to YYYY-MM-DD-<slug>. */
  folderName?: string;
}

export interface ClipResult {
  folderId: string;
  folderUrl: string;
  folderName: string;
  /** Canonical article Markdown filename inside the folder (`<folderName>.md`). */
  fileName?: string;
  /** Alias for `fileName` (`<folderName>.md`). */
  articleFileName?: string;
  /** Drive file ID of the uploaded article Markdown file (`<folderName>.md`). */
  articleFileId?: string;
  /** Backward-compatible alias for `articleFileId`. */
  readmeFileId: string;
  title: string;
  sourceUrl: string;
  clippedAt: string;
  uploadedImages: UploadedImageInfo[];
  failedImages: ImageFetchFailure[];
  warnings: string[];
  reusedFolder: boolean;
}

export type ClipStage =
  | 'extracting'
  | 'downloading'
  | 'uploading'
  | 'done'
  | 'error';

export type ClipJobStatus =
  | 'extracting'
  | 'queued'
  | 'downloading'
  | 'uploading'
  | 'done'
  | 'error';

export type ActiveClipJobStatus =
  | 'extracting'
  | 'queued'
  | 'downloading'
  | 'uploading';

export interface ClipJob {
  id: string;
  tabId?: number;
  url: string;
  title: string;
  folderName: string;
  mode: ClipMode;
  status: ClipJobStatus;
  message: string;
  completed?: number;
  total?: number;
  createdAt: string;
  updatedAt: string;
  result?: ClipResult;
  error?: string;
  errorCode?: BackgroundErrorCode;
}

export function isActiveClipJobStatus(
  status: ClipJobStatus,
): status is ActiveClipJobStatus {
  return (
    status === 'extracting' ||
    status === 'queued' ||
    status === 'downloading' ||
    status === 'uploading'
  );
}

export type ClipProgressEvent =
  | {
      clipId: string;
      stage: 'extracting';
      message: string;
    }
  | {
      clipId: string;
      stage: 'downloading';
      message: string;
      completed: number;
      total: number;
    }
  | {
      clipId: string;
      stage: 'uploading';
      message: string;
      completed: number;
      total: number;
    }
  | {
      clipId: string;
      stage: 'done';
      message: string;
      result: ClipResult;
    }
  | {
      clipId: string;
      stage: 'error';
      message: string;
      error: string;
    };

export interface ClipHistoryItem {
  id: string;
  title: string;
  sourceUrl: string;
  folderId: string;
  folderUrl: string;
  folderName: string;
  fileName?: string;
  articleFileName?: string;
  articleFileId?: string;
  readmeFileId?: string;
  clippedAt: string;
  imageCount: number;
  warningCount: number;
}

export interface FrontmatterPreferences {
  includeAuthor: boolean;
  includePublished: boolean;
  includeSite: boolean;
  includeImages: boolean;
  includeWarnings: boolean;
}

export interface ExtensionSettings {
  rootFolderName: string;
  rootFolderId: string | null;
  defaultTags: string[];
  /**
   * Last-used Popup tag list persisted across Popup opens.
   * `null` means not yet customized in Popup (fall back to `defaultTags`).
   * An empty array `[]` is preserved as an explicit user choice ("no tags").
   */
  stickyTags: string[] | null;
  frontmatter: FrontmatterPreferences;
  maxImageSizeBytes: number;
  imageConcurrency: number;
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  rootFolderName: 'WebClips',
  rootFolderId: null,
  defaultTags: ['web-clip'],
  stickyTags: null,
  frontmatter: {
    includeAuthor: true,
    includePublished: true,
    includeSite: true,
    includeImages: true,
    includeWarnings: true,
  },
  maxImageSizeBytes: 15 * 1024 * 1024,
  imageConcurrency: 5,
};

export interface AuthStatus {
  oauthConfigured: boolean;
  authenticated: boolean;
  error?: string;
}

export interface RootFolderInfo {
  folderId: string;
  folderName: string;
  folderUrl: string;
  created: boolean;
}

export type BackgroundErrorCode =
  | 'OAUTH_NOT_CONFIGURED'
  | 'AUTH_REQUIRED'
  | 'UNSUPPORTED_PAGE'
  | 'EXTRACTION_FAILED'
  | 'DRIVE_ERROR'
  | 'INVALID_MESSAGE';

export type BackgroundResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: BackgroundErrorCode };

export type ContentRequestMessage =
  | { type: 'CONTENT_GET_PAGE_INFO' }
  | { type: 'CONTENT_EXTRACT_PAGE'; mode: ClipMode };

export type ContentResponseMessage =
  | { ok: true; type: 'CONTENT_PAGE_INFO'; data: Omit<PageInfo, 'tabId'> }
  | { ok: true; type: 'CONTENT_EXTRACTED_PAGE'; data: ExtractedPage }
  | { ok: false; error: string };

export type UiToBackgroundMessage =
  | { type: 'GET_PAGE_INFO'; tabId?: number }
  | { type: 'START_CLIP'; request: ClipRequest }
  | { type: 'GET_CLIP_JOBS' }
  | { type: 'DISMISS_CLIP_JOB'; jobId: string }
  | { type: 'CLEAR_COMPLETED_JOBS' }
  | { type: 'GET_SETTINGS' }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<ExtensionSettings> }
  | { type: 'GET_HISTORY' }
  | { type: 'GET_AUTH_STATUS' }
  | { type: 'SIGN_IN' }
  | { type: 'SIGN_OUT' }
  | { type: 'ENSURE_ROOT_FOLDER'; folderName?: string; forceNew?: boolean };

export interface UiMessageResponseMap {
  GET_PAGE_INFO: PageInfo;
  /**
   * Non-blocking: resolves once fast page extraction finishes and the job is
   * enqueued for background download/upload (returning the created `ClipJob`).
   * Track live progress via `GET_CLIP_JOBS` and `CLIP_JOBS_UPDATED`.
   */
  START_CLIP: ClipJob;
  GET_CLIP_JOBS: ClipJob[];
  DISMISS_CLIP_JOB: ClipJob[];
  CLEAR_COMPLETED_JOBS: ClipJob[];
  GET_SETTINGS: ExtensionSettings;
  UPDATE_SETTINGS: ExtensionSettings;
  GET_HISTORY: ClipHistoryItem[];
  GET_AUTH_STATUS: AuthStatus;
  SIGN_IN: AuthStatus;
  SIGN_OUT: AuthStatus;
  ENSURE_ROOT_FOLDER: RootFolderInfo;
}

export type BackgroundPushMessage =
  | {
      type: 'CLIP_PROGRESS';
      event: ClipProgressEvent;
    }
  | {
      type: 'CLIP_JOBS_UPDATED';
      jobs: ClipJob[];
    };

declare const __DRIVE_CLIPPER_WEB_AUTH_CLIENT_ID__: string | undefined;

export function isConfiguredOAuthClientIdValue(clientId: unknown): clientId is string {
  if (typeof clientId !== 'string') {
    return false;
  }
  const trimmed = clientId.trim();
  if (trimmed.length === 0 || trimmed === OAUTH_CLIENT_ID_PLACEHOLDER) {
    return false;
  }
  return !trimmed.startsWith('YOUR_');
}

/**
 * Returns the optional Web Application OAuth Client ID injected at build time
 * from gitignored `config.local.json` (`webAuthClientId`), or `null` if unset.
 */
export function getBuildWebAuthClientId(): string | null {
  const raw =
    typeof __DRIVE_CLIPPER_WEB_AUTH_CLIENT_ID__ === 'string'
      ? __DRIVE_CLIPPER_WEB_AUTH_CLIENT_ID__
      : '';
  return isConfiguredOAuthClientIdValue(raw) ? raw.trim() : null;
}

export function buildDriveFolderUrl(folderId: string): string {
  return `${DRIVE_FOLDER_URL_PREFIX}${encodeURIComponent(folderId)}`;
}

/**
 * Normalizes `chrome.identity.getRedirectURL()` by stripping a trailing slash
 * so `launchWebAuthFlow` and the Options UI match origin-form Authorized
 * Redirect URIs registered in Google Cloud Console (e.g.
 * `https://<extension-id>.chromiumapp.org`).
 */
export function normalizeWebAuthRedirectUri(redirectUri: string): string {
  return redirectUri.trim().replace(/\/+$/, '');
}
