// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTENSION_SETTINGS,
  type AuthStatus,
  type BackgroundResponse,
  type ClipHistoryItem,
  type ClipProgressEvent,
  type ClipResult,
  type ExtensionSettings,
  type PageInfo,
  type UiMessageResponseMap,
  type UiToBackgroundMessage,
} from '../../src/types.js';
import { mountPopup, type PopupController } from '../../src/ui/popup.js';
import type { UiRuntimeClient } from '../../src/ui/shared.js';

const POPUP_HTML = readFileSync(
  path.resolve(process.cwd(), 'src/ui/popup.html'),
  'utf8',
);

const FIXED_NOW = new Date('2026-11-24T10:30:00Z');

function loadPopupDom(): HTMLElement {
  const bodyMatch = POPUP_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) {
    throw new Error('Failed to parse <body> from src/ui/popup.html');
  }
  document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '');
  const root = document.querySelector<HTMLElement>('[data-app="popup"]');
  if (!root) {
    throw new Error('Popup root [data-app="popup"] not found');
  }
  return root;
}

interface MockRuntimeConfig {
  settings?: ExtensionSettings;
  authStatus?: AuthStatus;
  pageInfo?: BackgroundResponse<PageInfo>;
  history?: ClipHistoryItem[];
  manifestOAuthConfigured?: boolean | null;
  onStartClip?: (
    message: Extract<UiToBackgroundMessage, { type: 'START_CLIP' }>,
    emitProgress: (event: ClipProgressEvent) => void,
  ) => Promise<BackgroundResponse<ClipResult>>;
  onSignIn?: () => Promise<BackgroundResponse<AuthStatus>>;
}

function createMockRuntime(config: MockRuntimeConfig = {}) {
  const progressListeners = new Set<(event: ClipProgressEvent) => void>();
  const sentMessages: UiToBackgroundMessage[] = [];
  const openOptionsPage = vi.fn();
  let currentHistory = [...(config.history ?? [])];

  const emitProgress = (event: ClipProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  const defaultPageInfo: PageInfo = {
    tabId: 42,
    url: 'https://example.com/articles/v8-compiler',
    title: 'How V8 Compiles JavaScript',
    hasSelection: false,
    selectionLength: 0,
    site: 'example.com',
  };

  const defaultAuth: AuthStatus = {
    oauthConfigured: true,
    authenticated: true,
  };

  const runtime: UiRuntimeClient = {
    async sendMessage<K extends UiToBackgroundMessage['type']>(
      message: Extract<UiToBackgroundMessage, { type: K }>,
    ): Promise<BackgroundResponse<UiMessageResponseMap[K]>> {
      const msg: UiToBackgroundMessage = message;
      sentMessages.push(msg);

      switch (msg.type) {
        case 'GET_SETTINGS':
          return {
            ok: true,
            data: (config.settings ?? DEFAULT_EXTENSION_SETTINGS) as UiMessageResponseMap[K],
          };
        case 'GET_AUTH_STATUS':
          return {
            ok: true,
            data: (config.authStatus ?? defaultAuth) as UiMessageResponseMap[K],
          };
        case 'GET_PAGE_INFO':
          return (config.pageInfo ?? {
            ok: true,
            data: defaultPageInfo,
          }) as BackgroundResponse<UiMessageResponseMap[K]>;
        case 'GET_HISTORY':
          return {
            ok: true,
            data: currentHistory as UiMessageResponseMap[K],
          };
        case 'SIGN_IN':
          if (config.onSignIn) {
            return (await config.onSignIn()) as BackgroundResponse<
              UiMessageResponseMap[K]
            >;
          }
          return {
            ok: true,
            data: {
              oauthConfigured: true,
              authenticated: true,
            } as UiMessageResponseMap[K],
          };
        case 'START_CLIP':
          if (config.onStartClip) {
            return (await config.onStartClip(
              msg,
              emitProgress,
            )) as BackgroundResponse<UiMessageResponseMap[K]>;
          }
          return {
            ok: false,
            error: 'Unexpected START_CLIP in test without handler',
          };
        default:
          return { ok: false, error: `Unhandled message ${msg.type}` };
      }
    },
    onClipProgress(listener) {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },
    openOptionsPage,
    getManifestOAuthConfigured: () => config.manifestOAuthConfigured ?? true,
  };

  return {
    runtime,
    sentMessages,
    openOptionsPage,
    emitProgress,
    setHistory(items: ClipHistoryItem[]) {
      currentHistory = [...items];
    },
  };
}

describe('Popup UI', () => {
  let controller: PopupController | null = null;

  afterEach(() => {
    controller?.destroy();
    controller = null;
    document.body.innerHTML = '';
  });

  it('renders page title and updates YYYY-MM-DD-<slug> folder preview live', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        rootFolderName: 'MyArchive',
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const titleInput = root.querySelector<HTMLInputElement>('#title-input')!;
    const folderPreview = root.querySelector<HTMLElement>('#folder-preview')!;
    const rootPrefix = root.querySelector<HTMLElement>('#root-folder-prefix')!;

    expect(titleInput.value).toBe('How V8 Compiles JavaScript');
    expect(rootPrefix.textContent).toBe('MyArchive/');
    expect(folderPreview.textContent).toBe(
      '2026-11-24-how-v8-compiles-javascript',
    );

    titleInput.value = '深入理解 Chrome MV3 & OAuth!';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(folderPreview.textContent).toBe('2026-11-24-深入理解-chrome-mv3-oauth');

    titleInput.value = '   ';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(folderPreview.textContent).toBe('2026-11-24-untitled');
  });

  it('seeds default tags, supports keyboard tag editing, and commits pending tag on clip', async () => {
    const root = loadPopupDom();
    const clipRequests: Array<Extract<UiToBackgroundMessage, { type: 'START_CLIP' }>> = [];

    const mock = createMockRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        defaultTags: ['web-clip', 'engineering'],
      },
      onStartClip: async (msg) => {
        clipRequests.push(msg);
        return {
          ok: true,
          data: {
            folderId: 'fld-1',
            folderUrl: 'https://drive.google.com/drive/folders/fld-1',
            folderName: '2026-11-24-how-v8-compiles-javascript',
            readmeFileId: 'file-1',
            title: msg.request.title ?? '',
            sourceUrl: 'https://example.com/articles/v8-compiler',
            clippedAt: FIXED_NOW.toISOString(),
            uploadedImages: [],
            failedImages: [],
            warnings: [],
            reusedFolder: false,
          },
        };
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const chipLabels = () =>
      Array.from(root.querySelectorAll('.tag-chip-label')).map(
        (el) => el.textContent,
      );
    expect(chipLabels()).toEqual(['web-clip', 'engineering']);

    // Add tags via comma key
    const tagsInput = root.querySelector<HTMLInputElement>('#tags-input')!;
    tagsInput.value = '#JavaScript, V8 Engine';
    tagsInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', bubbles: true, cancelable: true }),
    );
    expect(chipLabels()).toEqual([
      'web-clip',
      'engineering',
      'javascript',
      'v8-engine',
    ]);

    // Remove a specific chip by clicking its × button
    const removeEngineering = root.querySelector<HTMLButtonElement>(
      '[data-remove-tag="engineering"]',
    )!;
    removeEngineering.click();
    expect(chipLabels()).toEqual(['web-clip', 'javascript', 'v8-engine']);

    // Type a pending tag without pressing Enter, then submit the form
    tagsInput.value = 'compilers';
    root
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(clipRequests).toHaveLength(1));
    expect(clipRequests[0]?.request.tags).toEqual([
      'web-clip',
      'javascript',
      'v8-engine',
      'compilers',
    ]);
  });

  it('auto-selects selection mode when text is selected and disables selection when none exists', async () => {
    const rootWithSelection = loadPopupDom();
    const mockSelected = createMockRuntime({
      pageInfo: {
        ok: true,
        data: {
          tabId: 7,
          url: 'https://example.com/doc',
          title: 'Selected Note',
          hasSelection: true,
          selectionLength: 245,
          site: 'example.com',
        },
      },
    });

    controller = await mountPopup(rootWithSelection, {
      runtime: mockSelected.runtime,
      now: () => FIXED_NOW,
    });

    const fullBtn =
      rootWithSelection.querySelector<HTMLButtonElement>('#mode-full-btn')!;
    const selBtn =
      rootWithSelection.querySelector<HTMLButtonElement>('#mode-selection-btn')!;
    const hint = rootWithSelection.querySelector<HTMLElement>('#selection-hint')!;

    expect(selBtn.getAttribute('aria-checked')).toBe('true');
    expect(selBtn.disabled).toBe(false);
    expect(fullBtn.getAttribute('aria-checked')).toBe('false');
    expect(hint.textContent).toContain('245 chars');

    fullBtn.click();
    expect(fullBtn.getAttribute('aria-checked')).toBe('true');
    expect(selBtn.getAttribute('aria-checked')).toBe('false');

    controller.destroy();

    const rootNoSelection = loadPopupDom();
    const mockFull = createMockRuntime({
      pageInfo: {
        ok: true,
        data: {
          tabId: 8,
          url: 'https://example.com/doc',
          title: 'Full Page Only',
          hasSelection: false,
          selectionLength: 0,
          site: 'example.com',
        },
      },
    });

    controller = await mountPopup(rootNoSelection, {
      runtime: mockFull.runtime,
      now: () => FIXED_NOW,
    });

    const fullBtn2 =
      rootNoSelection.querySelector<HTMLButtonElement>('#mode-full-btn')!;
    const selBtn2 =
      rootNoSelection.querySelector<HTMLButtonElement>('#mode-selection-btn')!;
    expect(fullBtn2.getAttribute('aria-checked')).toBe('true');
    expect(selBtn2.getAttribute('aria-checked')).toBe('false');
    expect(selBtn2.disabled).toBe(true);
  });

  it('tracks live stage transitions and renders saved Drive link with collapsible warnings', async () => {
    const root = loadPopupDom();
    let resolveClip!: (res: BackgroundResponse<ClipResult>) => void;
    let pushProgress!: (event: ClipProgressEvent) => void;

    const mock = createMockRuntime({
      onStartClip: async (_msg, emitProgress) => {
        pushProgress = emitProgress;
        return new Promise((resolve) => {
          resolveClip = resolve;
        });
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const submitBtn = root.querySelector<HTMLButtonElement>('#clip-submit-btn')!;
    const panel = root.querySelector<HTMLElement>('#progress-panel')!;
    const statusLabel = root.querySelector<HTMLElement>('#progress-status-label')!;
    const barFill = root.querySelector<HTMLElement>('#progress-bar-fill')!;
    const driveLink = root.querySelector<HTMLAnchorElement>('#result-drive-link')!;
    const warningsDetails =
      root.querySelector<HTMLDetailsElement>('#warnings-details')!;
    const warningsSummary = root.querySelector<HTMLElement>('#warnings-summary')!;
    const warningsList = root.querySelector<HTMLUListElement>('#warnings-list')!;

    expect(panel.hidden).toBe(true);

    root
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(panel.hidden).toBe(false);
    expect(submitBtn.disabled).toBe(true);
    expect(statusLabel.textContent).toBe('Extracting page...');

    pushProgress({
      clipId: 'c1',
      stage: 'downloading',
      message: 'Downloading images...',
      completed: 2,
      total: 5,
    });
    expect(statusLabel.textContent).toBe('Downloading images (2/5)...');
    expect(barFill.style.width).toBe('40%');

    pushProgress({
      clipId: 'c1',
      stage: 'uploading',
      message: 'Uploading to Drive...',
      completed: 4,
      total: 5,
    });
    expect(statusLabel.textContent).toBe('Uploading to Google Drive (4/5)...');
    expect(barFill.style.width).toBe('80%');

    mock.setHistory([
      {
        id: 'hist-1',
        title: 'How V8 Compiles JavaScript',
        sourceUrl: 'https://example.com/articles/v8-compiler',
        folderId: 'drive-folder-99',
        folderUrl: 'https://drive.google.com/drive/folders/drive-folder-99',
        folderName: '2026-11-24-how-v8-compiles-javascript',
        clippedAt: FIXED_NOW.toISOString(),
        imageCount: 4,
        warningCount: 1,
      },
    ]);

    resolveClip({
      ok: true,
      data: {
        folderId: 'drive-folder-99',
        folderUrl: 'https://drive.google.com/drive/folders/drive-folder-99',
        folderName: '2026-11-24-how-v8-compiles-javascript',
        readmeFileId: 'readme-1',
        title: 'How V8 Compiles JavaScript',
        sourceUrl: 'https://example.com/articles/v8-compiler',
        clippedAt: FIXED_NOW.toISOString(),
        uploadedImages: [
          {
            id: 'img-01',
            filename: '01-hero.webp',
            fileId: 'f1',
            mimeType: 'image/webp',
            resolvedUrl: 'https://example.com/hero.webp',
          },
        ],
        failedImages: [
          {
            id: 'img-02',
            originalUrl: 'https://example.com/missing.png',
            resolvedUrl: 'https://example.com/missing.png',
            sourceUrls: ['https://example.com/missing.png'],
            reason: 'HTTP 404',
            status: 404,
          },
        ],
        warnings: ['Kept remote URL for https://example.com/missing.png (HTTP 404)'],
        reusedFolder: false,
      },
    });

    await vi.waitFor(() => expect(statusLabel.textContent).toBe('Saved'));
    expect(submitBtn.disabled).toBe(false);
    expect(driveLink.href).toBe(
      'https://drive.google.com/drive/folders/drive-folder-99',
    );
    expect(warningsDetails.hidden).toBe(false);
    expect(warningsDetails.open).toBe(false);
    expect(warningsSummary.textContent).toContain('1 warning');
    expect(warningsList.querySelectorAll('li')).toHaveLength(1);
    expect(warningsList.textContent).toContain('HTTP 404');

    // History refreshed after save
    await vi.waitFor(() =>
      expect(root.querySelector('#recent-clips-count')?.textContent).toBe('1'),
    );
  });

  it('shows first-run onboarding banner for unconfigured OAuth and opens Options', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      authStatus: { oauthConfigured: false, authenticated: false },
      manifestOAuthConfigured: false,
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const banner = root.querySelector<HTMLElement>('#onboarding-banner')!;
    const bannerTitle = root.querySelector<HTMLElement>('#banner-title')!;
    const bannerDesc = root.querySelector<HTMLElement>('#banner-description')!;
    const bannerOptionsBtn =
      root.querySelector<HTMLButtonElement>('#banner-options-btn')!;
    const clipBtn = root.querySelector<HTMLButtonElement>('#clip-submit-btn')!;

    expect(controller.getBannerState()).toEqual({ kind: 'oauth-unconfigured' });
    expect(banner.hidden).toBe(false);
    expect(bannerTitle.textContent).toContain('OAuth');
    expect(bannerDesc.textContent).toContain('config.local.json');
    expect(clipBtn.disabled).toBe(true);

    bannerOptionsBtn.click();
    expect(mock.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('shows sign-in onboarding banner when signed out and unlocks clipping after sign-in', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      authStatus: { oauthConfigured: true, authenticated: false },
      onSignIn: async () => ({
        ok: true,
        data: { oauthConfigured: true, authenticated: true },
      }),
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const banner = root.querySelector<HTMLElement>('#onboarding-banner')!;
    const signInBtn =
      root.querySelector<HTMLButtonElement>('#banner-signin-btn')!;
    const clipBtn = root.querySelector<HTMLButtonElement>('#clip-submit-btn')!;

    expect(banner.hidden).toBe(false);
    expect(signInBtn.hidden).toBe(false);
    expect(clipBtn.disabled).toBe(true);

    signInBtn.click();
    await vi.waitFor(() => expect(banner.hidden).toBe(true));
    expect(clipBtn.disabled).toBe(false);
  });

  it('renders up to 10 recent clips inside the collapsible Recent clips section', async () => {
    const root = loadPopupDom();
    const items: ClipHistoryItem[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `clip-${idx + 1}`,
      title: `Article ${idx + 1}`,
      sourceUrl: `https://example.com/${idx + 1}`,
      folderId: `fld-${idx + 1}`,
      folderUrl: `https://drive.google.com/drive/folders/fld-${idx + 1}`,
      folderName: `2026-11-24-article-${idx + 1}`,
      clippedAt: new Date(FIXED_NOW.getTime() - (idx + 1) * 60_000).toISOString(),
      imageCount: idx,
      warningCount: idx === 0 ? 1 : 0,
    }));

    const mock = createMockRuntime({ history: items });
    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const countBadge = root.querySelector<HTMLElement>('#recent-clips-count')!;
    const rows = root.querySelectorAll<HTMLLIElement>('.recent-clip-item');
    expect(countBadge.textContent).toBe('10');
    expect(rows).toHaveLength(10);
    expect(rows[0]?.querySelector('.recent-clip-title')?.textContent).toBe(
      'Article 1',
    );
    expect(rows[0]?.querySelector('.recent-clip-meta')?.textContent).toContain(
      '1m ago',
    );
    expect(
      rows[0]?.querySelector<HTMLAnchorElement>('.recent-clip-link')?.href,
    ).toBe('https://drive.google.com/drive/folders/fld-1');
  });

  it('handles unsupported browser pages, Backspace tag deletion, and clip errors cleanly', async () => {
    const rootUnsupported = loadPopupDom();
    const mockUnsupported = createMockRuntime({
      pageInfo: {
        ok: true,
        data: {
          tabId: 1,
          url: 'chrome://extensions',
          title: 'Extensions',
          hasSelection: false,
          selectionLength: 0,
          site: null,
        },
      },
    });

    controller = await mountPopup(rootUnsupported, {
      runtime: mockUnsupported.runtime,
      now: () => FIXED_NOW,
    });

    expect(controller.getBannerState()).toEqual({
      kind: 'unsupported-page',
      url: 'chrome://extensions',
    });
    expect(
      rootUnsupported.querySelector<HTMLButtonElement>('#clip-submit-btn')!
        .disabled,
    ).toBe(true);
    controller.destroy();

    // Error handling and Backspace removal on a clippable page
    const rootError = loadPopupDom();
    const mockError = createMockRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        defaultTags: ['alpha', 'beta'],
      },
      onStartClip: async () => ({
        ok: false,
        code: 'AUTH_REQUIRED',
        error: 'Token expired',
      }),
    });

    controller = await mountPopup(rootError, {
      runtime: mockError.runtime,
      now: () => FIXED_NOW,
    });

    const tagsInput = rootError.querySelector<HTMLInputElement>('#tags-input')!;
    tagsInput.value = '';
    tagsInput.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      Array.from(rootError.querySelectorAll('.tag-chip-label')).map(
        (el) => el.textContent,
      ),
    ).toEqual(['alpha']);

    rootError
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(
        rootError.querySelector<HTMLElement>('#progress-status-label')!
          .textContent,
      ).toBe('Sign in required'),
    );
    expect(controller.getBannerState().kind).toBe('signed-out');
    expect(
      rootError.querySelector<HTMLButtonElement>('#banner-signin-btn')!.hidden,
    ).toBe(false);
  });
});
