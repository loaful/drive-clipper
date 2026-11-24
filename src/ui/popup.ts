import { buildArticleFolderName, cleanPageTitle } from '../core/frontmatter.js';
import {
  DEFAULT_EXTENSION_SETTINGS,
  isActiveClipJobStatus,
  type AuthStatus,
  type BackgroundErrorCode,
  type ClipHistoryItem,
  type ClipJob,
  type ClipJobStatus,
  type ClipMode,
  type ExtensionSettings,
  type PageInfo,
} from '../types.js';
import {
  createChromeRuntimeClient,
  createTagEditor,
  formatClipTimestamp,
  isSupportedClipUrl,
  resolveOAuthConfigured,
  type TagEditorController,
  type UiRuntimeClient,
} from './shared.js';

export type PopupBannerState =
  | { kind: 'none' }
  | { kind: 'oauth-unconfigured' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'unsupported-page'; url: string };

export type QueueSummaryState = 'active' | 'done' | 'error';

export type JobIndicatorKind = 'queued' | 'active' | 'done' | 'error';

export interface ClipJobPresentation {
  title: string;
  detail: string;
  percent: number | null;
  indicatorKind: JobIndicatorKind;
  canOpen: boolean;
  canDismiss: boolean;
  folderUrl: string | null;
  warnings: readonly string[];
}

export interface PopupMountOptions {
  runtime?: UiRuntimeClient;
  now?: () => Date;
}

export interface PopupController {
  refresh(): Promise<void>;
  getJobs(): ClipJob[];
  getBannerState(): PopupBannerState;
  destroy(): void;
}

const MAX_RECENT_CLIPS = 10;

const JOB_STATUS_RANK: Record<ClipJobStatus, number> = {
  extracting: 0,
  queued: 1,
  downloading: 2,
  uploading: 3,
  done: 4,
  error: 4,
};

function isExistingJobNewerOrEqual(existing: ClipJob, incoming: ClipJob): boolean {
  if (existing.updatedAt !== incoming.updatedAt) {
    return existing.updatedAt > incoming.updatedAt;
  }
  const existingRank = JOB_STATUS_RANK[existing.status];
  const incomingRank = JOB_STATUS_RANK[incoming.status];
  if (existingRank !== incomingRank) {
    return existingRank > incomingRank;
  }
  return (existing.completed ?? -1) >= (incoming.completed ?? -1);
}

export function normalizeComparableUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return trimmed;
  }
}

export function findActiveJobForUrl(
  jobs: readonly ClipJob[],
  url: string | null | undefined,
): ClipJob | null {
  if (!url) {
    return null;
  }
  const target = normalizeComparableUrl(url);
  if (target.length === 0) {
    return null;
  }
  return (
    jobs.find(
      (job) =>
        isActiveClipJobStatus(job.status) &&
        normalizeComparableUrl(job.url) === target,
    ) ?? null
  );
}

export function formatQueueSummary(jobs: readonly ClipJob[]): string {
  let running = 0;
  let queued = 0;
  let done = 0;
  let failed = 0;

  for (const job of jobs) {
    switch (job.status) {
      case 'extracting':
      case 'downloading':
      case 'uploading':
        running += 1;
        break;
      case 'queued':
        queued += 1;
        break;
      case 'done':
        done += 1;
        break;
      case 'error':
        failed += 1;
        break;
    }
  }

  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (queued > 0) {
    parts.push(`${queued} queued`);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }

  if (done > 0) {
    parts.push(`${done} saved`);
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  return parts.join(' · ');
}

export function getQueueSummaryState(jobs: readonly ClipJob[]): QueueSummaryState {
  if (jobs.some((job) => isActiveClipJobStatus(job.status))) {
    return 'active';
  }
  if (jobs.some((job) => job.status === 'error')) {
    return 'error';
  }
  return 'done';
}

function formatErrorHeading(code?: BackgroundErrorCode): string {
  switch (code) {
    case 'OAUTH_NOT_CONFIGURED':
      return 'Google OAuth setup required';
    case 'AUTH_REQUIRED':
      return 'Sign in required';
    case 'UNSUPPORTED_PAGE':
      return 'Page cannot be clipped';
    default:
      return 'Clip failed';
  }
}

function formatFriendlyErrorMessage(
  rawMessage: string,
  code?: BackgroundErrorCode,
): string {
  if (code === 'OAUTH_NOT_CONFIGURED') {
    return 'Configure your Google OAuth Client ID in config.local.json, rebuild, and reload the extension.';
  }
  if (code === 'AUTH_REQUIRED') {
    return 'Sign in to Google Drive before clipping this page.';
  }
  if (code === 'UNSUPPORTED_PAGE') {
    return 'Chrome blocks extensions from reading internal browser pages. Switch to an http:// or https:// tab.';
  }
  return rawMessage || 'An unexpected error occurred while clipping this page.';
}

function computeProgressPercent(
  completed: number | undefined,
  total: number | undefined,
): number | null {
  if (typeof total !== 'number' || total <= 0) {
    return null;
  }
  const safeCompleted =
    typeof completed === 'number' && Number.isFinite(completed) && completed >= 0
      ? completed
      : 0;
  return Math.max(0, Math.min(100, Math.round((safeCompleted / total) * 100)));
}

export function describeClipJob(job: ClipJob): ClipJobPresentation {
  const title = job.title.trim() || job.folderName || job.url || 'Untitled';

  switch (job.status) {
    case 'queued':
      return {
        title,
        detail: 'Queued',
        percent: null,
        indicatorKind: 'queued',
        canOpen: false,
        canDismiss: false,
        folderUrl: null,
        warnings: [],
      };
    case 'extracting':
      return {
        title,
        detail: 'Extracting...',
        percent: null,
        indicatorKind: 'active',
        canOpen: false,
        canDismiss: false,
        folderUrl: null,
        warnings: [],
      };
    case 'downloading': {
      const percent = computeProgressPercent(job.completed, job.total);
      const detail =
        typeof job.total === 'number' && job.total > 0
          ? `Downloading ${job.completed ?? 0}/${job.total}`
          : 'Downloading images...';
      return {
        title,
        detail,
        percent,
        indicatorKind: 'active',
        canOpen: false,
        canDismiss: false,
        folderUrl: null,
        warnings: [],
      };
    }
    case 'uploading': {
      const percent = computeProgressPercent(job.completed, job.total);
      const detail =
        typeof job.total === 'number' && job.total > 0
          ? `Uploading ${job.completed ?? 0}/${job.total}`
          : 'Uploading...';
      return {
        title,
        detail,
        percent,
        indicatorKind: 'active',
        canOpen: false,
        canDismiss: false,
        folderUrl: null,
        warnings: [],
      };
    }
    case 'done': {
      const result = job.result;
      let detail = job.message || 'Saved';
      if (result) {
        const imageCount = result.uploadedImages.length;
        const verb = result.reusedFolder ? 'Updated' : 'Saved';
        detail =
          imageCount > 0
            ? `${verb} · ${imageCount === 1 ? '1 image' : `${imageCount} images`}`
            : verb;
      }
      const folderUrl = result?.folderUrl || null;
      return {
        title,
        detail,
        percent: null,
        indicatorKind: 'done',
        canOpen: folderUrl !== null,
        canDismiss: true,
        folderUrl,
        warnings: result?.warnings ?? [],
      };
    }
    case 'error':
      return {
        title,
        detail: formatFriendlyErrorMessage(job.error || job.message, job.errorCode),
        percent: null,
        indicatorKind: 'error',
        canOpen: false,
        canDismiss: true,
        folderUrl: null,
        warnings: [],
      };
  }
}

function queryRequired<T extends HTMLElement>(
  root: HTMLElement,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Popup markup missing required element: ${selector}`);
  }
  return element;
}

function createWarningChevron(): SVGSVGElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'queue-warnings-chevron');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'm6 4 4 4-4 4');
  svg.append(path);
  return svg;
}

export async function mountPopup(
  root: HTMLElement,
  options: PopupMountOptions = {},
): Promise<PopupController> {
  const runtime = options.runtime ?? createChromeRuntimeClient();
  const now = options.now ?? (() => new Date());

  const authPill = queryRequired<HTMLSpanElement>(root, '#auth-pill');
  const authPillLabel = queryRequired<HTMLSpanElement>(root, '#auth-pill-label');
  const openOptionsHeaderBtn = queryRequired<HTMLButtonElement>(
    root,
    '#open-options-header-btn',
  );
  const onboardingBanner = queryRequired<HTMLElement>(root, '#onboarding-banner');
  const bannerTitle = queryRequired<HTMLParagraphElement>(root, '#banner-title');
  const bannerDescription = queryRequired<HTMLParagraphElement>(
    root,
    '#banner-description',
  );
  const bannerSignInBtn = queryRequired<HTMLButtonElement>(
    root,
    '#banner-signin-btn',
  );
  const bannerOptionsBtn = queryRequired<HTMLButtonElement>(
    root,
    '#banner-options-btn',
  );

  const form = queryRequired<HTMLFormElement>(root, '#clip-form');
  const titleInput = queryRequired<HTMLInputElement>(root, '#title-input');
  const rootFolderPrefix = queryRequired<HTMLSpanElement>(
    root,
    '#root-folder-prefix',
  );
  const folderPreview = queryRequired<HTMLElement>(root, '#folder-preview');
  const selectionHint = queryRequired<HTMLSpanElement>(root, '#selection-hint');
  const modeFullBtn = queryRequired<HTMLButtonElement>(root, '#mode-full-btn');
  const modeSelectionBtn = queryRequired<HTMLButtonElement>(
    root,
    '#mode-selection-btn',
  );
  const tagsContainer = queryRequired<HTMLDivElement>(root, '#tags-container');
  const tagsInput = queryRequired<HTMLInputElement>(root, '#tags-input');
  const clipSubmitBtn = queryRequired<HTMLButtonElement>(
    root,
    '#clip-submit-btn',
  );
  const clipBtnSpinner = queryRequired<HTMLSpanElement>(
    root,
    '#clip-btn-spinner',
  );
  const clipBtnLabel = queryRequired<HTMLSpanElement>(root, '#clip-btn-label');
  const clipSubmitHint = queryRequired<HTMLParagraphElement>(
    root,
    '#clip-submit-hint',
  );

  const submitErrorPanel = queryRequired<HTMLElement>(root, '#submit-error-panel');
  const submitErrorTitle = queryRequired<HTMLParagraphElement>(
    root,
    '#submit-error-title',
  );
  const submitErrorMessage = queryRequired<HTMLParagraphElement>(
    root,
    '#submit-error-message',
  );
  const submitErrorDismissBtn = queryRequired<HTMLButtonElement>(
    root,
    '#submit-error-dismiss-btn',
  );

  const clipQueuePanel = queryRequired<HTMLElement>(root, '#clip-queue-panel');
  const clipQueueSummary = queryRequired<HTMLSpanElement>(
    root,
    '#clip-queue-summary',
  );
  const clearDoneJobsBtn = queryRequired<HTMLButtonElement>(
    root,
    '#clear-done-jobs-btn',
  );
  const clipQueueList = queryRequired<HTMLUListElement>(root, '#clip-queue-list');

  const recentClipsCount = queryRequired<HTMLSpanElement>(
    root,
    '#recent-clips-count',
  );
  const recentClipsEmpty = queryRequired<HTMLParagraphElement>(
    root,
    '#recent-clips-empty',
  );
  const recentClipsList = queryRequired<HTMLUListElement>(
    root,
    '#recent-clips-list',
  );

  let settings: ExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
  let authStatus: AuthStatus | null = null;
  let pageInfo: PageInfo | null = null;
  let pageUnsupported = false;
  let pageUnsupportedUrl = '';
  let clipMode: ClipMode = 'full';
  let isSubmitting = false;
  let isSigningIn = false;
  let isClearingDone = false;
  let destroyed = false;
  let jobsPushVersion = 0;
  let bannerState: PopupBannerState = { kind: 'none' };
  let clipJobs: ClipJob[] = [];
  let submitError: { message: string; code?: BackgroundErrorCode } | null = null;
  const lastKnownJobStatuses = new Map<string, ClipJobStatus>();
  const expandedWarningJobIds = new Set<string>();
  const dismissingJobIds = new Set<string>();

  const tagEditor: TagEditorController = createTagEditor({
    container: tagsContainer,
    input: tagsInput,
    initialTags: DEFAULT_EXTENSION_SETTINGS.defaultTags,
  });

  const updateFolderPreview = (): void => {
    const folderPrefix = `${settings.rootFolderName.trim() || 'WebClips'}/`;
    rootFolderPrefix.textContent = folderPrefix;
    folderPreview.textContent = buildArticleFolderName(titleInput.value, now());
  };

  const renderSubmitError = (): void => {
    if (!submitError) {
      submitErrorPanel.hidden = true;
      submitErrorTitle.textContent = '';
      submitErrorMessage.textContent = '';
      return;
    }

    submitErrorPanel.hidden = false;
    submitErrorTitle.textContent = formatErrorHeading(submitError.code);
    submitErrorMessage.textContent = formatFriendlyErrorMessage(
      submitError.message,
      submitError.code,
    );
  };

  const renderModeSwitch = (): void => {
    const hasSelection = Boolean(pageInfo?.hasSelection);
    if (!hasSelection && clipMode === 'selection') {
      clipMode = 'full';
    }

    modeFullBtn.setAttribute('aria-checked', String(clipMode === 'full'));
    modeSelectionBtn.setAttribute(
      'aria-checked',
      String(clipMode === 'selection'),
    );
    modeFullBtn.disabled = isSubmitting;
    modeSelectionBtn.disabled = isSubmitting || !hasSelection;
    modeSelectionBtn.title = hasSelection
      ? 'Clip only the selected text on this page'
      : 'Select text on the page first';

    if (hasSelection && pageInfo) {
      selectionHint.textContent =
        pageInfo.selectionLength > 0
          ? `Selection detected (${pageInfo.selectionLength} chars)`
          : 'Selection detected';
    } else {
      selectionHint.textContent = 'No text selected';
    }
  };

  const computeBannerState = (): PopupBannerState => {
    const oauthConfigured = resolveOAuthConfigured(
      authStatus,
      runtime.getManifestOAuthConfigured(),
    );
    if (!oauthConfigured) {
      return { kind: 'oauth-unconfigured' };
    }
    if (authStatus && !authStatus.authenticated) {
      return { kind: 'signed-out', message: authStatus.error };
    }
    if (pageUnsupported) {
      return { kind: 'unsupported-page', url: pageUnsupportedUrl };
    }
    return { kind: 'none' };
  };

  const renderAuthAndBanner = (): void => {
    const oauthConfigured = resolveOAuthConfigured(
      authStatus,
      runtime.getManifestOAuthConfigured(),
    );
    const authenticated = Boolean(oauthConfigured && authStatus?.authenticated);

    authPill.classList.remove(
      'status-pill--neutral',
      'status-pill--ok',
      'status-pill--warn',
    );
    if (!oauthConfigured) {
      authPill.classList.add('status-pill--warn');
      authPill.dataset.status = 'unconfigured';
      authPillLabel.textContent = 'Setup needed';
    } else if (authenticated) {
      authPill.classList.add('status-pill--ok');
      authPill.dataset.status = 'connected';
      authPillLabel.textContent = 'Connected';
    } else {
      authPill.classList.add('status-pill--warn');
      authPill.dataset.status = 'signed-out';
      authPillLabel.textContent = 'Signed out';
    }

    bannerState = computeBannerState();
    onboardingBanner.classList.remove('banner--info', 'banner--neutral');

    switch (bannerState.kind) {
      case 'none':
        onboardingBanner.hidden = true;
        break;
      case 'oauth-unconfigured':
        onboardingBanner.hidden = false;
        bannerTitle.textContent = 'Finish Google OAuth setup first';
        bannerDescription.textContent =
          'This build still uses the placeholder OAuth Client ID. Add your Client ID in config.local.json, rebuild, and open Options for setup steps.';
        bannerSignInBtn.hidden = true;
        bannerOptionsBtn.hidden = false;
        bannerOptionsBtn.textContent = 'Open Options';
        break;
      case 'signed-out':
        onboardingBanner.hidden = false;
        onboardingBanner.classList.add('banner--info');
        bannerTitle.textContent = 'Connect your Google Drive';
        bannerDescription.textContent =
          bannerState.message ||
          'Sign in with Google to save pages to your WebClips folder using the minimal drive.file scope.';
        bannerSignInBtn.hidden = false;
        bannerSignInBtn.disabled = isSigningIn;
        bannerSignInBtn.textContent = isSigningIn
          ? 'Signing in...'
          : 'Sign in with Google';
        bannerOptionsBtn.hidden = false;
        bannerOptionsBtn.textContent = 'Options';
        break;
      case 'unsupported-page':
        onboardingBanner.hidden = false;
        onboardingBanner.classList.add('banner--neutral');
        bannerTitle.textContent = 'This browser page cannot be clipped';
        bannerDescription.textContent =
          'Open an http:// or https:// web page to clip its content to Google Drive.';
        bannerSignInBtn.hidden = true;
        bannerOptionsBtn.hidden = true;
        break;
    }

    const activeJobForCurrentPage = !pageUnsupported
      ? findActiveJobForUrl(clipJobs, pageInfo?.url)
      : null;

    const canSubmit =
      !isSubmitting &&
      !activeJobForCurrentPage &&
      oauthConfigured &&
      !pageUnsupported &&
      (!authStatus || authStatus.authenticated);

    clipSubmitBtn.disabled = !canSubmit;
    titleInput.disabled = isSubmitting;
    tagEditor.setDisabled(isSubmitting);
    clipBtnSpinner.hidden = !isSubmitting;
    clipBtnLabel.textContent = isSubmitting
      ? 'Starting clip...'
      : 'Clip to Google Drive';

    if (!isSubmitting && activeJobForCurrentPage) {
      clipSubmitHint.hidden = false;
      clipSubmitHint.textContent = 'Already clipping this page';
    } else {
      clipSubmitHint.hidden = true;
      clipSubmitHint.textContent = '';
    }

    renderModeSwitch();
    renderSubmitError();
  };

  const renderClipQueue = (): void => {
    if (clipJobs.length === 0) {
      clipQueuePanel.hidden = true;
      clipQueueSummary.textContent = '';
      clearDoneJobsBtn.hidden = true;
      clipQueueList.replaceChildren();
      return;
    }

    const prevScrollTop = clipQueueList.scrollTop;
    const hasFinishedJobs = clipJobs.some(
      (job) => job.status === 'done' || job.status === 'error',
    );

    clipQueuePanel.hidden = false;
    clipQueueSummary.textContent = formatQueueSummary(clipJobs);
    clipQueueSummary.dataset.state = getQueueSummaryState(clipJobs);
    clearDoneJobsBtn.hidden = !hasFinishedJobs;
    clearDoneJobsBtn.disabled = isClearingDone;

    const fragment = document.createDocumentFragment();
    for (const job of clipJobs) {
      const presentation = describeClipJob(job);

      const li = document.createElement('li');
      li.className = 'queue-item';
      li.dataset.jobId = job.id;
      li.dataset.status = job.status;

      const mainRow = document.createElement('div');
      mainRow.className = 'queue-item-main';

      const indicator = document.createElement('span');
      indicator.className = `queue-status-indicator queue-status-indicator--${presentation.indicatorKind}`;
      indicator.setAttribute('aria-hidden', 'true');

      const body = document.createElement('div');
      body.className = 'queue-item-body';

      const titleEl = document.createElement('div');
      titleEl.className = 'queue-item-title';
      titleEl.textContent = presentation.title;
      titleEl.title = presentation.title;

      const detailEl = document.createElement('div');
      detailEl.className = 'queue-item-detail';
      detailEl.textContent = presentation.detail;
      if (job.status === 'error') {
        detailEl.title = presentation.detail;
      }

      body.append(titleEl, detailEl);

      if (presentation.percent !== null) {
        const track = document.createElement('div');
        track.className = 'queue-progress-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(presentation.percent));

        const fill = document.createElement('div');
        fill.className = 'queue-progress-fill';
        fill.style.width = `${presentation.percent}%`;

        track.append(fill);
        body.append(track);
      }

      mainRow.append(indicator, body);

      if (presentation.canOpen || presentation.canDismiss) {
        const actions = document.createElement('div');
        actions.className = 'queue-item-actions';

        if (presentation.canOpen && presentation.folderUrl) {
          const openLink = document.createElement('a');
          openLink.className = 'queue-open-link';
          openLink.href = presentation.folderUrl;
          openLink.target = '_blank';
          openLink.rel = 'noopener noreferrer';
          openLink.textContent = 'Open ↗';
          openLink.setAttribute(
            'aria-label',
            `Open ${presentation.title} in Google Drive`,
          );
          actions.append(openLink);
        }

        if (presentation.canDismiss) {
          const dismissBtn = document.createElement('button');
          dismissBtn.type = 'button';
          dismissBtn.className = 'queue-dismiss-btn';
          dismissBtn.dataset.dismissJob = job.id;
          dismissBtn.textContent = '×';
          dismissBtn.title = 'Dismiss';
          dismissBtn.setAttribute('aria-label', `Dismiss ${presentation.title}`);
          dismissBtn.disabled = dismissingJobIds.has(job.id);
          actions.append(dismissBtn);
        }

        mainRow.append(actions);
      }

      li.append(mainRow);

      if (presentation.warnings.length > 0) {
        const details = document.createElement('details');
        details.className = 'queue-warnings';
        details.dataset.jobWarnings = job.id;
        details.open = expandedWarningJobIds.has(job.id);

        const summary = document.createElement('summary');
        summary.className = 'queue-warnings-summary';

        const badge = document.createElement('span');
        badge.className = 'queue-warning-badge';
        badge.append(
          createWarningChevron(),
          document.createTextNode(
            presentation.warnings.length === 1
              ? '1 warning'
              : `${presentation.warnings.length} warnings`,
          ),
        );
        summary.append(badge);

        const list = document.createElement('ul');
        list.className = 'queue-warnings-list';
        for (const warning of presentation.warnings) {
          const warnLi = document.createElement('li');
          warnLi.textContent = warning;
          list.append(warnLi);
        }

        details.addEventListener('toggle', () => {
          if (details.open) {
            expandedWarningJobIds.add(job.id);
          } else {
            expandedWarningJobIds.delete(job.id);
          }
        });

        details.append(summary, list);
        li.append(details);
      }

      fragment.append(li);
    }

    clipQueueList.replaceChildren(fragment);
    clipQueueList.scrollTop = prevScrollTop;
  };

  const renderHistory = (items: readonly ClipHistoryItem[]): void => {
    const visibleItems = items.slice(0, MAX_RECENT_CLIPS);
    recentClipsCount.textContent = String(visibleItems.length);
    recentClipsList.replaceChildren();

    if (visibleItems.length === 0) {
      recentClipsEmpty.hidden = false;
      recentClipsList.hidden = true;
      return;
    }

    recentClipsEmpty.hidden = true;
    recentClipsList.hidden = false;

    const currentNow = now();
    for (const item of visibleItems) {
      const li = document.createElement('li');
      li.className = 'recent-clip-item';

      const info = document.createElement('div');
      info.className = 'recent-clip-info';

      const titleEl = document.createElement('span');
      titleEl.className = 'recent-clip-title';
      titleEl.textContent = item.title || item.folderName;
      titleEl.title = item.title || item.folderName;

      const metaParts = [formatClipTimestamp(item.clippedAt, currentNow)];
      if (item.imageCount > 0) {
        metaParts.push(
          item.imageCount === 1 ? '1 image' : `${item.imageCount} images`,
        );
      }
      if (item.warningCount > 0) {
        metaParts.push(
          item.warningCount === 1
            ? '1 warning'
            : `${item.warningCount} warnings`,
        );
      }

      const metaEl = document.createElement('span');
      metaEl.className = 'recent-clip-meta';
      metaEl.textContent = metaParts.join(' · ');

      info.append(titleEl, metaEl);

      const link = document.createElement('a');
      link.className = 'recent-clip-link';
      link.href = item.folderUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open';
      link.setAttribute(
        'aria-label',
        `Open ${item.title || item.folderName} in Google Drive`,
      );

      li.append(info, link);
      recentClipsList.append(li);
    }
  };

  const refreshHistory = async (): Promise<void> => {
    const historyRes = await runtime.sendMessage({ type: 'GET_HISTORY' });
    if (!destroyed && historyRes.ok) {
      renderHistory(historyRes.data);
    }
  };

  const applyJobsUpdate = (
    incomingJobs: readonly ClipJob[],
    updateOptions: { isInitialHydration: boolean },
  ): void => {
    if (destroyed) {
      return;
    }

    let anyNewlyCompleted = false;
    let newlyAuthFailedJob: ClipJob | null = null;
    const nextIds = new Set<string>();

    for (const job of incomingJobs) {
      nextIds.add(job.id);
      const prevStatus = lastKnownJobStatuses.get(job.id);
      if (job.status === 'done' && prevStatus !== 'done') {
        anyNewlyCompleted = true;
      }
      if (
        job.status === 'error' &&
        prevStatus !== 'error' &&
        (job.errorCode === 'AUTH_REQUIRED' ||
          job.errorCode === 'OAUTH_NOT_CONFIGURED')
      ) {
        newlyAuthFailedJob = job;
      }
    }

    lastKnownJobStatuses.clear();
    for (const job of incomingJobs) {
      lastKnownJobStatuses.set(job.id, job.status);
    }

    for (const id of expandedWarningJobIds) {
      if (!nextIds.has(id)) {
        expandedWarningJobIds.delete(id);
      }
    }

    clipJobs = incomingJobs.map((job) => ({ ...job }));

    if (!updateOptions.isInitialHydration) {
      if (newlyAuthFailedJob?.errorCode === 'OAUTH_NOT_CONFIGURED') {
        authStatus = { oauthConfigured: false, authenticated: false };
      } else if (newlyAuthFailedJob?.errorCode === 'AUTH_REQUIRED') {
        authStatus = {
          oauthConfigured: true,
          authenticated: false,
          error: newlyAuthFailedJob.error || newlyAuthFailedJob.message,
        };
      }
    }

    renderAuthAndBanner();
    renderClipQueue();

    if (!updateOptions.isInitialHydration && anyNewlyCompleted) {
      void refreshHistory();
    }
  };

  const upsertAcceptedJob = (job: ClipJob): void => {
    const existingIndex = clipJobs.findIndex((item) => item.id === job.id);
    if (
      existingIndex !== -1 &&
      isExistingJobNewerOrEqual(clipJobs[existingIndex]!, job)
    ) {
      renderAuthAndBanner();
      return;
    }

    const nextJobs =
      existingIndex === -1
        ? [job, ...clipJobs]
        : clipJobs.map((item, idx) => (idx === existingIndex ? job : item));

    jobsPushVersion += 1;
    applyJobsUpdate(nextJobs, { isInitialHydration: false });
  };

  const refresh = async (): Promise<void> => {
    const versionAtStart = jobsPushVersion;
    const [settingsRes, authRes, pageRes, historyRes, jobsRes] = await Promise.all([
      runtime.sendMessage({ type: 'GET_SETTINGS' }),
      runtime.sendMessage({ type: 'GET_AUTH_STATUS' }),
      runtime.sendMessage({ type: 'GET_PAGE_INFO' }),
      runtime.sendMessage({ type: 'GET_HISTORY' }),
      runtime.sendMessage({ type: 'GET_CLIP_JOBS' }),
    ]);

    if (destroyed) {
      return;
    }

    if (settingsRes.ok) {
      settings = {
        ...DEFAULT_EXTENSION_SETTINGS,
        ...settingsRes.data,
        frontmatter: {
          ...DEFAULT_EXTENSION_SETTINGS.frontmatter,
          ...settingsRes.data.frontmatter,
        },
      };
      tagEditor.setTags(settings.defaultTags);
    }

    if (authRes.ok) {
      authStatus = authRes.data;
    } else if (authRes.code === 'OAUTH_NOT_CONFIGURED') {
      authStatus = { oauthConfigured: false, authenticated: false };
    } else {
      const manifestFlag = runtime.getManifestOAuthConfigured();
      authStatus = {
        oauthConfigured: manifestFlag ?? false,
        authenticated: false,
        error: authRes.error,
      };
    }

    if (pageRes.ok) {
      pageInfo = pageRes.data;
      pageUnsupported = !isSupportedClipUrl(pageRes.data.url);
      pageUnsupportedUrl = pageRes.data.url;
      const cleanedTitle = cleanPageTitle(pageRes.data.title || '');
      titleInput.value = cleanedTitle || pageRes.data.title || '';
      clipMode = pageRes.data.hasSelection ? 'selection' : 'full';
    } else if (pageRes.code === 'UNSUPPORTED_PAGE') {
      pageInfo = null;
      pageUnsupported = true;
      pageUnsupportedUrl = '';
      titleInput.value = '';
      clipMode = 'full';
    } else {
      pageInfo = null;
      pageUnsupported = false;
      titleInput.value = titleInput.value || '';
      clipMode = 'full';
    }

    if (historyRes.ok) {
      renderHistory(historyRes.data);
    }

    updateFolderPreview();

    if (jobsRes.ok && jobsPushVersion === versionAtStart) {
      applyJobsUpdate(jobsRes.data, { isInitialHydration: true });
    } else {
      renderAuthAndBanner();
      renderClipQueue();
    }
  };

  const handleOpenOptions = (): void => {
    runtime.openOptionsPage();
  };

  const handleBannerSignIn = async (): Promise<void> => {
    if (isSigningIn) {
      return;
    }
    isSigningIn = true;
    renderAuthAndBanner();

    const response = await runtime.sendMessage({ type: 'SIGN_IN' });
    if (destroyed) {
      return;
    }
    isSigningIn = false;

    if (response.ok) {
      authStatus = response.data;
      if (response.data.authenticated) {
        submitError = null;
      }
    } else if (response.code === 'OAUTH_NOT_CONFIGURED') {
      authStatus = { oauthConfigured: false, authenticated: false };
    } else {
      authStatus = {
        oauthConfigured: authStatus?.oauthConfigured ?? true,
        authenticated: false,
        error: response.error,
      };
    }
    renderAuthAndBanner();
  };

  const handleModeClick = (mode: ClipMode): void => {
    if (isSubmitting) {
      return;
    }
    if (mode === 'selection' && !pageInfo?.hasSelection) {
      return;
    }
    clipMode = mode;
    renderModeSwitch();
  };

  const handleDismissSubmitError = (): void => {
    submitError = null;
    renderSubmitError();
  };

  const handleClearCompletedJobs = async (): Promise<void> => {
    if (isClearingDone) {
      return;
    }
    isClearingDone = true;
    clearDoneJobsBtn.disabled = true;

    const versionBefore = jobsPushVersion;
    const response = await runtime.sendMessage({ type: 'CLEAR_COMPLETED_JOBS' });
    if (destroyed) {
      return;
    }
    isClearingDone = false;

    if (response.ok) {
      if (jobsPushVersion === versionBefore) {
        jobsPushVersion += 1;
        applyJobsUpdate(response.data, { isInitialHydration: false });
      } else {
        const survivingIds = new Set(response.data.map((job) => job.id));
        const reconciled = clipJobs.filter(
          (job) => isActiveClipJobStatus(job.status) || survivingIds.has(job.id),
        );
        applyJobsUpdate(reconciled, { isInitialHydration: false });
      }
    } else {
      renderClipQueue();
    }
  };

  const handleDismissJob = async (jobId: string): Promise<void> => {
    if (dismissingJobIds.has(jobId)) {
      return;
    }
    dismissingJobIds.add(jobId);
    renderClipQueue();

    const versionBefore = jobsPushVersion;
    const response = await runtime.sendMessage({
      type: 'DISMISS_CLIP_JOB',
      jobId,
    });
    if (destroyed) {
      return;
    }
    dismissingJobIds.delete(jobId);

    if (response.ok) {
      if (jobsPushVersion === versionBefore) {
        jobsPushVersion += 1;
        applyJobsUpdate(response.data, { isInitialHydration: false });
      } else {
        const reconciled = clipJobs.filter((job) => job.id !== jobId);
        applyJobsUpdate(reconciled, { isInitialHydration: false });
      }
    } else {
      renderClipQueue();
    }
  };

  const handleQueueListClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const dismissBtn = target?.closest<HTMLButtonElement>('[data-dismiss-job]');
    const jobId = dismissBtn?.dataset.dismissJob;
    if (jobId) {
      void handleDismissJob(jobId);
    }
  };

  const handleClipSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (isSubmitting || clipSubmitBtn.disabled) {
      return;
    }
    if (findActiveJobForUrl(clipJobs, pageInfo?.url)) {
      renderAuthAndBanner();
      return;
    }

    const tags = tagEditor.commitPendingInput();
    const title = titleInput.value.trim() || pageInfo?.title || 'Untitled';
    const folderName = buildArticleFolderName(title, now());
    const errorIdsBeforeSubmit = new Set(
      clipJobs.filter((job) => job.status === 'error').map((job) => job.id),
    );

    isSubmitting = true;
    submitError = null;
    renderAuthAndBanner();

    const response = await runtime.sendMessage({
      type: 'START_CLIP',
      request: {
        tabId: pageInfo?.tabId,
        title,
        tags,
        mode: clipMode,
        folderName,
      },
    });

    if (destroyed) {
      return;
    }
    isSubmitting = false;

    if (response.ok) {
      upsertAcceptedJob(response.data);
      return;
    }

    if (response.code === 'OAUTH_NOT_CONFIGURED') {
      authStatus = { oauthConfigured: false, authenticated: false };
    } else if (response.code === 'AUTH_REQUIRED') {
      authStatus = {
        oauthConfigured: true,
        authenticated: false,
        error: response.error,
      };
    }

    const currentComparableUrl = pageInfo?.url
      ? normalizeComparableUrl(pageInfo.url)
      : '';
    const jobRowCapturedError =
      currentComparableUrl.length > 0 &&
      clipJobs.some(
        (job) =>
          job.status === 'error' &&
          !errorIdsBeforeSubmit.has(job.id) &&
          normalizeComparableUrl(job.url) === currentComparableUrl,
      );

    if (!jobRowCapturedError) {
      submitError = {
        message: response.error,
        code: response.code,
      };
    }

    renderAuthAndBanner();
  };

  const unsubscribeJobs = runtime.onClipJobsUpdated((jobs) => {
    jobsPushVersion += 1;
    applyJobsUpdate(jobs, { isInitialHydration: false });
  });

  const onModeFullClick = (): void => handleModeClick('full');
  const onModeSelectionClick = (): void => handleModeClick('selection');

  titleInput.addEventListener('input', updateFolderPreview);
  openOptionsHeaderBtn.addEventListener('click', handleOpenOptions);
  bannerOptionsBtn.addEventListener('click', handleOpenOptions);
  bannerSignInBtn.addEventListener('click', handleBannerSignIn);
  modeFullBtn.addEventListener('click', onModeFullClick);
  modeSelectionBtn.addEventListener('click', onModeSelectionClick);
  form.addEventListener('submit', handleClipSubmit);
  submitErrorDismissBtn.addEventListener('click', handleDismissSubmitError);
  clearDoneJobsBtn.addEventListener('click', handleClearCompletedJobs);
  clipQueueList.addEventListener('click', handleQueueListClick);

  await refresh();

  return {
    refresh,
    getJobs: () => clipJobs.map((job) => ({ ...job })),
    getBannerState: () => bannerState,
    destroy: () => {
      destroyed = true;
      unsubscribeJobs();
      tagEditor.destroy();
      titleInput.removeEventListener('input', updateFolderPreview);
      openOptionsHeaderBtn.removeEventListener('click', handleOpenOptions);
      bannerOptionsBtn.removeEventListener('click', handleOpenOptions);
      bannerSignInBtn.removeEventListener('click', handleBannerSignIn);
      modeFullBtn.removeEventListener('click', onModeFullClick);
      modeSelectionBtn.removeEventListener('click', onModeSelectionClick);
      form.removeEventListener('submit', handleClipSubmit);
      submitErrorDismissBtn.removeEventListener('click', handleDismissSubmitError);
      clearDoneJobsBtn.removeEventListener('click', handleClearCompletedJobs);
      clipQueueList.removeEventListener('click', handleQueueListClick);
    },
  };
}

function maybeAutoMount(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const mount = (): void => {
    const root = document.querySelector<HTMLElement>('[data-app="popup"]');
    if (root && !root.dataset.mounted) {
      root.dataset.mounted = 'true';
      void mountPopup(root);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

maybeAutoMount();
