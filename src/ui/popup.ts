import { buildArticleFolderName } from '../core/frontmatter.js';
import {
  DEFAULT_EXTENSION_SETTINGS,
  type AuthStatus,
  type BackgroundErrorCode,
  type ClipHistoryItem,
  type ClipMode,
  type ClipProgressEvent,
  type ClipResult,
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

export type ClipProgressViewState =
  | { status: 'idle' }
  | { status: 'extracting'; message: string }
  | { status: 'downloading'; message: string; completed: number; total: number }
  | { status: 'uploading'; message: string; completed: number; total: number }
  | { status: 'done'; result: ClipResult }
  | { status: 'error'; message: string; code?: BackgroundErrorCode };

export interface ProgressPresentation {
  label: string;
  detail: string;
  badge: string;
  activeStep: number;
  percent: number | null;
  stateAttr: 'running' | 'done' | 'error';
}

export interface PopupMountOptions {
  runtime?: UiRuntimeClient;
  now?: () => Date;
}

export interface PopupController {
  refresh(): Promise<void>;
  getProgressState(): ClipProgressViewState;
  getBannerState(): PopupBannerState;
  destroy(): void;
}

const MAX_RECENT_CLIPS = 10;

export function progressEventToViewState(
  event: ClipProgressEvent,
): ClipProgressViewState {
  switch (event.stage) {
    case 'extracting':
      return { status: 'extracting', message: event.message };
    case 'downloading':
      return {
        status: 'downloading',
        message: event.message,
        completed: event.completed,
        total: event.total,
      };
    case 'uploading':
      return {
        status: 'uploading',
        message: event.message,
        completed: event.completed,
        total: event.total,
      };
    case 'done':
      return { status: 'done', result: event.result };
    case 'error':
      return { status: 'error', message: event.error || event.message };
  }
}

export function describeProgressState(
  state: Exclude<ClipProgressViewState, { status: 'idle' }>,
): ProgressPresentation {
  switch (state.status) {
    case 'extracting':
      return {
        label: 'Extracting page...',
        detail: state.message && state.message !== 'Extracting page...' ? state.message : '',
        badge: 'Step 1 of 3',
        activeStep: 0,
        percent: null,
        stateAttr: 'running',
      };
    case 'downloading': {
      const countText =
        state.total > 0 ? ` (${state.completed}/${state.total})` : '';
      const percent =
        state.total > 0
          ? Math.max(0, Math.min(100, Math.round((state.completed / state.total) * 100)))
          : null;
      return {
        label: `Downloading images${countText}...`,
        detail: '',
        badge: 'Step 2 of 3',
        activeStep: 1,
        percent,
        stateAttr: 'running',
      };
    }
    case 'uploading': {
      const countText =
        state.total > 0 ? ` (${state.completed}/${state.total})` : '';
      const percent =
        state.total > 0
          ? Math.max(0, Math.min(100, Math.round((state.completed / state.total) * 100)))
          : null;
      return {
        label: `Uploading to Google Drive${countText}...`,
        detail: '',
        badge: 'Step 3 of 3',
        activeStep: 2,
        percent,
        stateAttr: 'running',
      };
    }
    case 'done': {
      const imageCount = state.result.uploadedImages.length;
      const imageSummary =
        imageCount === 1 ? '1 image uploaded' : `${imageCount} images uploaded`;
      const detail = state.result.reusedFolder
        ? `Updated existing folder · ${imageSummary}`
        : `${state.result.folderName} · ${imageSummary}`;
      return {
        label: 'Saved',
        detail,
        badge: state.result.reusedFolder ? 'Updated' : 'Complete',
        activeStep: 3,
        percent: 100,
        stateAttr: 'done',
      };
    }
    case 'error':
      return {
        label: formatErrorHeading(state.code),
        detail: formatFriendlyErrorMessage(state.message, state.code),
        badge: 'Failed',
        activeStep: -1,
        percent: null,
        stateAttr: 'error',
      };
  }
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

  const progressPanel = queryRequired<HTMLElement>(root, '#progress-panel');
  const stageSteps = Array.from(
    root.querySelectorAll<HTMLLIElement>('.stage-step'),
  );
  const progressStatusLabel = queryRequired<HTMLSpanElement>(
    root,
    '#progress-status-label',
  );
  const progressBadge = queryRequired<HTMLSpanElement>(root, '#progress-badge');
  const progressBarTrack = queryRequired<HTMLDivElement>(
    root,
    '#progress-bar-track',
  );
  const progressBarFill = queryRequired<HTMLDivElement>(
    root,
    '#progress-bar-fill',
  );
  const progressDetail = queryRequired<HTMLParagraphElement>(
    root,
    '#progress-detail',
  );
  const progressResultActions = queryRequired<HTMLDivElement>(
    root,
    '#progress-result-actions',
  );
  const resultDriveLink = queryRequired<HTMLAnchorElement>(
    root,
    '#result-drive-link',
  );
  const warningsDetails = queryRequired<HTMLDetailsElement>(
    root,
    '#warnings-details',
  );
  const warningsSummary = queryRequired<HTMLElement>(root, '#warnings-summary');
  const warningsList = queryRequired<HTMLUListElement>(root, '#warnings-list');

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
  let isClipping = false;
  let isSigningIn = false;
  let bannerState: PopupBannerState = { kind: 'none' };
  let progressState: ClipProgressViewState = { status: 'idle' };

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
    modeFullBtn.disabled = isClipping;
    modeSelectionBtn.disabled = isClipping || !hasSelection;
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

    const canSubmit =
      !isClipping &&
      oauthConfigured &&
      !pageUnsupported &&
      (!authStatus || authStatus.authenticated);

    clipSubmitBtn.disabled = !canSubmit;
    titleInput.disabled = isClipping;
    tagEditor.setDisabled(isClipping);
    clipBtnSpinner.hidden = !isClipping;
    clipBtnLabel.textContent = isClipping
      ? 'Clipping...'
      : 'Clip to Google Drive';
    renderModeSwitch();
  };

  const renderProgress = (): void => {
    if (progressState.status === 'idle') {
      progressPanel.hidden = true;
      return;
    }

    const presentation = describeProgressState(progressState);
    progressPanel.hidden = false;
    progressPanel.dataset.state = presentation.stateAttr;
    progressStatusLabel.textContent = presentation.label;

    progressBadge.hidden = presentation.badge.length === 0;
    progressBadge.textContent = presentation.badge;

    progressDetail.hidden = presentation.detail.length === 0;
    progressDetail.textContent = presentation.detail;

    if (presentation.percent !== null && progressState.status !== 'done') {
      progressBarTrack.hidden = false;
      progressBarFill.style.width = `${presentation.percent}%`;
    } else {
      progressBarTrack.hidden = true;
      progressBarFill.style.width = '0%';
    }

    for (const stepEl of stageSteps) {
      const index = Number(stepEl.dataset.step);
      if (progressState.status === 'error') {
        stepEl.dataset.stepStatus = 'error';
      } else if (progressState.status === 'done' || index < presentation.activeStep) {
        stepEl.dataset.stepStatus = 'complete';
      } else if (index === presentation.activeStep) {
        stepEl.dataset.stepStatus = 'active';
      } else {
        stepEl.dataset.stepStatus = 'pending';
      }
    }

    if (progressState.status === 'done') {
      progressResultActions.hidden = false;
      resultDriveLink.href = progressState.result.folderUrl;

      const warnings = progressState.result.warnings;
      warningsList.replaceChildren();
      if (warnings.length > 0) {
        warningsDetails.hidden = false;
        warningsDetails.open = false;
        warningsSummary.textContent =
          warnings.length === 1
            ? '1 warning (image fell back to remote URL)'
            : `${warnings.length} warnings (images fell back to remote URLs)`;
        for (const warning of warnings) {
          const item = document.createElement('li');
          item.textContent = warning;
          warningsList.append(item);
        }
      } else {
        warningsDetails.hidden = true;
      }
    } else {
      progressResultActions.hidden = true;
      warningsDetails.hidden = true;
      warningsList.replaceChildren();
    }
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
      link.setAttribute('aria-label', `Open ${item.title || item.folderName} in Google Drive`);

      li.append(info, link);
      recentClipsList.append(li);
    }
  };

  const refreshHistory = async (): Promise<void> => {
    const historyRes = await runtime.sendMessage({ type: 'GET_HISTORY' });
    if (historyRes.ok) {
      renderHistory(historyRes.data);
    }
  };

  const refresh = async (): Promise<void> => {
    const [settingsRes, authRes, pageRes, historyRes] = await Promise.all([
      runtime.sendMessage({ type: 'GET_SETTINGS' }),
      runtime.sendMessage({ type: 'GET_AUTH_STATUS' }),
      runtime.sendMessage({ type: 'GET_PAGE_INFO' }),
      runtime.sendMessage({ type: 'GET_HISTORY' }),
    ]);

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
      titleInput.value = pageRes.data.title || '';
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
    renderAuthAndBanner();
    renderProgress();
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
    isSigningIn = false;

    if (response.ok) {
      authStatus = response.data;
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
    if (isClipping) {
      return;
    }
    if (mode === 'selection' && !pageInfo?.hasSelection) {
      return;
    }
    clipMode = mode;
    renderModeSwitch();
  };

  const handleClipSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (isClipping || clipSubmitBtn.disabled) {
      return;
    }

    const tags = tagEditor.commitPendingInput();
    const title = titleInput.value.trim() || pageInfo?.title || 'Untitled';
    const folderName = buildArticleFolderName(title, now());

    isClipping = true;
    progressState = { status: 'extracting', message: 'Extracting page...' };
    renderAuthAndBanner();
    renderProgress();

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

    isClipping = false;

    if (response.ok) {
      progressState = { status: 'done', result: response.data };
      renderAuthAndBanner();
      renderProgress();
      await refreshHistory();
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

    progressState = {
      status: 'error',
      message: response.error,
      code: response.code,
    };
    renderAuthAndBanner();
    renderProgress();
  };

  const unsubscribeProgress = runtime.onClipProgress((event) => {
    const wasClippingFromPopup = isClipping;
    progressState = progressEventToViewState(event);
    if (event.stage === 'done' || event.stage === 'error') {
      isClipping = false;
      renderAuthAndBanner();
      if (event.stage === 'done' && !wasClippingFromPopup) {
        void refreshHistory();
      }
    }
    renderProgress();
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

  await refresh();

  return {
    refresh,
    getProgressState: () => progressState,
    getBannerState: () => bannerState,
    destroy: () => {
      unsubscribeProgress();
      tagEditor.destroy();
      titleInput.removeEventListener('input', updateFolderPreview);
      openOptionsHeaderBtn.removeEventListener('click', handleOpenOptions);
      bannerOptionsBtn.removeEventListener('click', handleOpenOptions);
      bannerSignInBtn.removeEventListener('click', handleBannerSignIn);
      modeFullBtn.removeEventListener('click', onModeFullClick);
      modeSelectionBtn.removeEventListener('click', onModeSelectionClick);
      form.removeEventListener('submit', handleClipSubmit);
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
