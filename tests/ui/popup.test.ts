// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTENSION_SETTINGS,
  type AuthStatus,
  type BackgroundResponse,
  type ClipHistoryItem,
  type ClipJob,
  type ClipProgressEvent,
  type ClipResult,
  type ExtensionSettings,
  type PageInfo,
  type UiMessageResponseMap,
  type UiToBackgroundMessage,
} from '../../src/types.js';
import {
  describeClipJob,
  formatQueueSummary,
  mountPopup,
  type PopupController,
} from '../../src/ui/popup.js';
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

function makeClipResult(overrides: Partial<ClipResult> = {}): ClipResult {
  return {
    folderId: 'fld-1',
    folderUrl: 'https://drive.google.com/drive/folders/fld-1',
    folderName: '2026-11-24-how-v8-compiles-javascript',
    readmeFileId: 'file-1',
    title: 'How V8 Compiles JavaScript',
    sourceUrl: 'https://example.com/articles/v8-compiler',
    clippedAt: FIXED_NOW.toISOString(),
    uploadedImages: [],
    failedImages: [],
    warnings: [],
    reusedFolder: false,
    ...overrides,
  };
}

function makeJob(overrides: Partial<ClipJob> = {}): ClipJob {
  return {
    id: 'job-1',
    tabId: 42,
    url: 'https://example.com/articles/v8-compiler',
    title: 'How V8 Compiles JavaScript',
    folderName: '2026-11-24-how-v8-compiles-javascript',
    mode: 'full',
    status: 'queued',
    message: 'Queued for background upload',
    createdAt: '2026-11-24T10:29:00.000Z',
    updatedAt: '2026-11-24T10:29:01.000Z',
    ...overrides,
  };
}

interface MockRuntimeConfig {
  settings?: ExtensionSettings;
  authStatus?: AuthStatus;
  pageInfo?: BackgroundResponse<PageInfo>;
  history?: ClipHistoryItem[];
  jobs?: ClipJob[];
  manifestOAuthConfigured?: boolean | null;
  onStartClip?: (
    message: Extract<UiToBackgroundMessage, { type: 'START_CLIP' }>,
    helpers: {
      emitJobs: (jobs: ClipJob[]) => void;
      emitProgress: (event: ClipProgressEvent) => void;
    },
  ) => Promise<BackgroundResponse<ClipJob>>;
  onDismissJob?: (jobId: string, currentJobs: ClipJob[]) => Promise<BackgroundResponse<ClipJob[]>>;
  onClearCompleted?: (currentJobs: ClipJob[]) => Promise<BackgroundResponse<ClipJob[]>>;
  onSignIn?: () => Promise<BackgroundResponse<AuthStatus>>;
}

function createMockRuntime(config: MockRuntimeConfig = {}) {
  const progressListeners = new Set<(event: ClipProgressEvent) => void>();
  const jobsListeners = new Set<(jobs: ClipJob[]) => void>();
  const sentMessages: UiToBackgroundMessage[] = [];
  const openOptionsPage = vi.fn();
  let currentSettings: ExtensionSettings = {
    ...DEFAULT_EXTENSION_SETTINGS,
    ...config.settings,
    frontmatter: {
      ...DEFAULT_EXTENSION_SETTINGS.frontmatter,
      ...config.settings?.frontmatter,
    },
  };
  let currentHistory = [...(config.history ?? [])];
  let currentJobs = [...(config.jobs ?? [])];

  const emitProgress = (event: ClipProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  const emitJobs = (jobs: ClipJob[]): void => {
    currentJobs = [...jobs];
    for (const listener of jobsListeners) {
      listener([...currentJobs]);
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
            data: {
              ...currentSettings,
              defaultTags: [...currentSettings.defaultTags],
              stickyTags: currentSettings.stickyTags
                ? [...currentSettings.stickyTags]
                : null,
              frontmatter: { ...currentSettings.frontmatter },
            } as UiMessageResponseMap[K],
          };
        case 'UPDATE_SETTINGS':
          currentSettings = {
            ...currentSettings,
            ...msg.patch,
            stickyTags:
              msg.patch.stickyTags === undefined
                ? currentSettings.stickyTags
                : msg.patch.stickyTags === null
                  ? null
                  : [...msg.patch.stickyTags],
            frontmatter: {
              ...currentSettings.frontmatter,
              ...(msg.patch.frontmatter ?? {}),
            },
          };
          return {
            ok: true,
            data: {
              ...currentSettings,
              defaultTags: [...currentSettings.defaultTags],
              stickyTags: currentSettings.stickyTags
                ? [...currentSettings.stickyTags]
                : null,
              frontmatter: { ...currentSettings.frontmatter },
            } as UiMessageResponseMap[K],
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
        case 'GET_CLIP_JOBS':
          return {
            ok: true,
            data: [...currentJobs] as UiMessageResponseMap[K],
          };
        case 'DISMISS_CLIP_JOB':
          if (config.onDismissJob) {
            return (await config.onDismissJob(
              msg.jobId,
              currentJobs,
            )) as BackgroundResponse<UiMessageResponseMap[K]>;
          }
          currentJobs = currentJobs.filter((job) => job.id !== msg.jobId);
          return {
            ok: true,
            data: [...currentJobs] as UiMessageResponseMap[K],
          };
        case 'CLEAR_COMPLETED_JOBS':
          if (config.onClearCompleted) {
            return (await config.onClearCompleted(currentJobs)) as BackgroundResponse<
              UiMessageResponseMap[K]
            >;
          }
          currentJobs = currentJobs.filter(
            (job) => job.status !== 'done' && job.status !== 'error',
          );
          return {
            ok: true,
            data: [...currentJobs] as UiMessageResponseMap[K],
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
            return (await config.onStartClip(msg, {
              emitJobs,
              emitProgress,
            })) as BackgroundResponse<UiMessageResponseMap[K]>;
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
    onClipJobsUpdated(listener) {
      jobsListeners.add(listener);
      return () => {
        jobsListeners.delete(listener);
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
    emitJobs,
    setHistory(items: ClipHistoryItem[]) {
      currentHistory = [...items];
    },
    setJobs(jobs: ClipJob[]) {
      currentJobs = [...jobs];
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

  it('renders cleaned page title preview and updates <folderName>/<folderName>.md preview with full-path tooltip live', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        rootFolderName: 'MyArchive',
      },
      pageInfo: {
        ok: true,
        data: {
          tabId: 42,
          url: 'https://www.zhihu.com/question/12345',
          title: '(20 封私信 / 17 条消息) 华硕 ProArt 显示器评测 - 知乎',
          hasSelection: false,
          selectionLength: 0,
          site: 'zhihu.com',
        },
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const titleInput = root.querySelector<HTMLInputElement>('#title-input')!;
    const folderPreview = root.querySelector<HTMLElement>('#folder-preview')!;
    const folderPreviewRow = root.querySelector<HTMLElement>('#folder-preview-row')!;
    const rootPrefix = root.querySelector<HTMLElement>('#root-folder-prefix')!;

    expect(titleInput.value).toBe('华硕 ProArt 显示器评测');
    expect(rootPrefix.textContent).toBe('MyArchive/');
    expect(folderPreview.textContent).toBe(
      '2026-11-24-zhihu-华硕-proart-显示器评测/2026-11-24-zhihu-华硕-proart-显示器评测.md',
    );
    expect(folderPreview.title).toBe(
      'MyArchive/2026-11-24-zhihu-华硕-proart-显示器评测/2026-11-24-zhihu-华硕-proart-显示器评测.md',
    );
    expect(folderPreviewRow.title).toBe(folderPreview.title);

    // Preserves legitimate parenthetical years and never alters manual edits
    titleInput.value = '(2026) 深入理解 Chrome MV3 & OAuth!';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(folderPreview.textContent).toBe(
      '2026-11-24-zhihu-2026-深入理解-chrome-mv3-oauth/2026-11-24-zhihu-2026-深入理解-chrome-mv3-oauth.md',
    );
    expect(folderPreview.title).toBe(
      'MyArchive/2026-11-24-zhihu-2026-深入理解-chrome-mv3-oauth/2026-11-24-zhihu-2026-深入理解-chrome-mv3-oauth.md',
    );

    titleInput.value = '   ';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(folderPreview.textContent).toBe(
      '2026-11-24-zhihu-untitled/2026-11-24-zhihu-untitled.md',
    );
  });

  it('previews and submits clean X.com slugs as <folderName>/<folderName>.md', async () => {
    const root = loadPopupDom();
    const clipRequests: Array<Extract<UiToBackgroundMessage, { type: 'START_CLIP' }>> = [];
    const mock = createMockRuntime({
      pageInfo: {
        ok: true,
        data: {
          tabId: 88,
          url: 'https://x.com/jakevin/status/2125132076768985501',
          title: 'jakevin on X: "Shipping OKF v0.2 bundles https://t.co/xyz123" / X',
          hasSelection: false,
          selectionLength: 0,
          site: 'X (Twitter)',
        },
      },
      onStartClip: async (msg) => {
        clipRequests.push(msg);
        return {
          ok: true,
          data: makeJob({
            id: 'job-x',
            url: 'https://x.com/jakevin/status/2125132076768985501',
            title: msg.request.title ?? 'Untitled',
            folderName: msg.request.folderName ?? '2026-11-24-x-shipping-okf-v0-2-bundles',
            status: 'queued',
          }),
        };
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const titleInput = root.querySelector<HTMLInputElement>('#title-input')!;
    const folderPreview = root.querySelector<HTMLElement>('#folder-preview')!;

    expect(titleInput.value).toBe('Shipping OKF v0.2 bundles');
    expect(folderPreview.textContent).toBe(
      '2026-11-24-x-shipping-okf-v0-2-bundles/2026-11-24-x-shipping-okf-v0-2-bundles.md',
    );
    expect(folderPreview.title).toBe(
      'WebClips/2026-11-24-x-shipping-okf-v0-2-bundles/2026-11-24-x-shipping-okf-v0-2-bundles.md',
    );

    root
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(clipRequests).toHaveLength(1));
    expect(clipRequests[0]?.request.folderName).toBe(
      '2026-11-24-x-shipping-okf-v0-2-bundles',
    );
  });

  it('persists sticky tags on add, chip removal, Backspace, and submit — preserving empty [] across reopen', async () => {
    const mock = createMockRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        defaultTags: ['web-clip', 'engineering'],
        stickyTags: null,
      },
      onStartClip: async (msg) => ({
        ok: true,
        data: makeJob({
          id: 'job-sticky',
          title: msg.request.title ?? 'Untitled',
          folderName: msg.request.folderName ?? '2026-11-24-example-how-v8-compiles-javascript',
          status: 'queued',
        }),
      }),
    });

    const getChipLabels = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('.tag-chip-label')).map((el) => el.textContent);

    const getStickyUpdates = () =>
      mock.sentMessages
        .filter(
          (m): m is Extract<UiToBackgroundMessage, { type: 'UPDATE_SETTINGS' }> =>
            m.type === 'UPDATE_SETTINGS' && m.patch.stickyTags !== undefined,
        )
        .map((m) => m.patch.stickyTags);

    // 1. First open (stickyTags: null) seeds from defaultTags
    const root1 = loadPopupDom();
    controller = await mountPopup(root1, { runtime: mock.runtime, now: () => FIXED_NOW });
    expect(getChipLabels(root1)).toEqual(['web-clip', 'engineering']);
    expect(getStickyUpdates()).toEqual([]);

    // 2. Adding tags immediately persists stickyTags
    const tagsInput1 = root1.querySelector<HTMLInputElement>('#tags-input')!;
    tagsInput1.value = '#AI, knowledge-base';
    tagsInput1.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(getStickyUpdates()).toEqual([
        ['web-clip', 'engineering', 'ai', 'knowledge-base'],
      ]),
    );

    // Reopen Popup -> restores stickyTags instead of snapping back to defaultTags
    controller.destroy();
    const root2 = loadPopupDom();
    controller = await mountPopup(root2, { runtime: mock.runtime, now: () => FIXED_NOW });
    expect(getChipLabels(root2)).toEqual([
      'web-clip',
      'engineering',
      'ai',
      'knowledge-base',
    ]);

    // 3. Removing chips via × and Backspace persists immediately, including empty []
    root2.querySelector<HTMLButtonElement>('[data-remove-tag="web-clip"]')!.click();
    root2.querySelector<HTMLButtonElement>('[data-remove-tag="engineering"]')!.click();
    root2.querySelector<HTMLButtonElement>('[data-remove-tag="ai"]')!.click();

    const tagsInput2 = root2.querySelector<HTMLInputElement>('#tags-input')!;
    tagsInput2.value = '';
    tagsInput2.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    );
    expect(getChipLabels(root2)).toEqual([]);

    await vi.waitFor(() => expect(getStickyUpdates().at(-1)).toEqual([]));

    // 4. Crucial edge case: reopening Popup with stickyTags: [] stays empty [] (NEVER snaps back to defaultTags!)
    controller.destroy();
    const root3 = loadPopupDom();
    controller = await mountPopup(root3, { runtime: mock.runtime, now: () => FIXED_NOW });
    expect(getChipLabels(root3)).toEqual([]);

    // 5. Clicking × on the ONLY remaining chip also persists [] and survives reopen
    const tagsInput3 = root3.querySelector<HTMLInputElement>('#tags-input')!;
    tagsInput3.value = 'solo';
    tagsInput3.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(getStickyUpdates().at(-1)).toEqual(['solo']));

    root3.querySelector<HTMLButtonElement>('[data-remove-tag="solo"]')!.click();
    await vi.waitFor(() => expect(getStickyUpdates().at(-1)).toEqual([]));

    controller.destroy();
    const root4 = loadPopupDom();
    controller = await mountPopup(root4, { runtime: mock.runtime, now: () => FIXED_NOW });
    expect(getChipLabels(root4)).toEqual([]);

    // 6. Submitting persists current tags (including empty []) via UPDATE_SETTINGS
    const countBeforeSubmit = getStickyUpdates().length;
    root4
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(getStickyUpdates().length).toBe(countBeforeSubmit + 1));
    expect(getStickyUpdates().at(-1)).toEqual([]);
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
          data: makeJob({
            id: 'job-tags',
            title: msg.request.title ?? 'Untitled',
            folderName: msg.request.folderName ?? '2026-11-24-how-v8-compiles-javascript',
            status: 'queued',
          }),
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

  it('hydrates active and finished multi-tab jobs immediately from GET_CLIP_JOBS when reopening popup mid-clip', async () => {
    const root = loadPopupDom();
    const jobs: ClipJob[] = [
      makeJob({
        id: 'job-dl',
        tabId: 10,
        url: 'https://tab-a.example.com/post',
        title: 'Tab A Deep Dive',
        status: 'downloading',
        completed: 14,
        total: 29,
      }),
      makeJob({
        id: 'job-up',
        tabId: 11,
        url: 'https://tab-b.example.com/post',
        title: 'Tab B Architecture',
        status: 'uploading',
        completed: 8,
        total: 30,
      }),
      makeJob({
        id: 'job-queued',
        tabId: 12,
        url: 'https://tab-c.example.com/post',
        title: 'Tab C Waiting',
        status: 'queued',
      }),
      makeJob({
        id: 'job-done',
        tabId: 13,
        url: 'https://tab-d.example.com/post',
        title: 'Tab D Finished',
        status: 'done',
        result: makeClipResult({
          folderId: 'drive-folder-d',
          folderUrl: 'https://drive.google.com/drive/folders/drive-folder-d',
          uploadedImages: Array.from({ length: 29 }, (_, idx) => ({
            id: `img-${idx}`,
            filename: `${idx}.png`,
            fileId: `f-${idx}`,
            mimeType: 'image/png',
            resolvedUrl: `https://tab-d.example.com/${idx}.png`,
          })),
          warnings: ['Kept remote URL for https://tab-d.example.com/missing.png (HTTP 404)'],
        }),
      }),
      makeJob({
        id: 'job-err',
        tabId: 14,
        url: 'https://tab-e.example.com/post',
        title: 'Tab E Failed',
        status: 'error',
        error: 'Drive quota exceeded',
        errorCode: 'DRIVE_ERROR',
      }),
    ];

    const mock = createMockRuntime({
      jobs,
      pageInfo: {
        ok: true,
        data: {
          tabId: 99,
          url: 'https://fresh-tab.example.com/article',
          title: 'Fresh Unclipped Tab',
          hasSelection: false,
          selectionLength: 0,
          site: 'fresh-tab.example.com',
        },
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    expect(mock.sentMessages.some((m) => m.type === 'GET_CLIP_JOBS')).toBe(true);
    expect(controller.getJobs()).toHaveLength(5);

    const queuePanel = root.querySelector<HTMLElement>('#clip-queue-panel')!;
    const summary = root.querySelector<HTMLElement>('#clip-queue-summary')!;
    const clearBtn = root.querySelector<HTMLButtonElement>('#clear-done-jobs-btn')!;
    const rows = Array.from(root.querySelectorAll<HTMLLIElement>('.queue-item'));

    expect(queuePanel.hidden).toBe(false);
    expect(summary.textContent).toBe('2 running · 1 queued');
    expect(clearBtn.hidden).toBe(false);
    expect(rows).toHaveLength(5);

    // Downloading row with progress bar and no dismiss button
    expect(rows[0]?.querySelector('.queue-item-title')?.textContent).toBe('Tab A Deep Dive');
    expect(rows[0]?.querySelector('.queue-item-detail')?.textContent).toBe('Downloading 14/29');
    expect(rows[0]?.querySelector<HTMLElement>('.queue-progress-fill')?.style.width).toBe('48%');
    expect(rows[0]?.querySelector('[data-dismiss-job]')).toBeNull();

    // Uploading row
    expect(rows[1]?.querySelector('.queue-item-detail')?.textContent).toBe('Uploading 8/30');
    expect(rows[1]?.querySelector<HTMLElement>('.queue-progress-fill')?.style.width).toBe('27%');

    // Queued row
    expect(rows[2]?.querySelector('.queue-item-detail')?.textContent).toBe('Queued');
    expect(rows[2]?.querySelector('.queue-progress-track')).toBeNull();

    // Done row with Open ↗ link, collapsible warning badge, and dismiss button
    expect(rows[3]?.querySelector('.queue-item-detail')?.textContent).toBe('Saved · 29 images');
    expect(rows[3]?.querySelector<HTMLAnchorElement>('.queue-open-link')?.href).toBe(
      'https://drive.google.com/drive/folders/drive-folder-d',
    );
    expect(rows[3]?.querySelector('.queue-open-link')?.textContent).toBe('Open ↗');
    const warnDetails = rows[3]?.querySelector<HTMLDetailsElement>('.queue-warnings')!;
    expect(warnDetails.open).toBe(false);
    expect(warnDetails.querySelector('.queue-warning-badge')?.textContent).toContain('1 warning');
    expect(warnDetails.querySelectorAll('.queue-warnings-list li')).toHaveLength(1);
    expect(rows[3]?.querySelector('[data-dismiss-job="job-done"]')).not.toBeNull();

    // Error row with error detail and dismiss button
    expect(rows[4]?.querySelector('.queue-item-detail')?.textContent).toBe('Drive quota exceeded');
    expect(rows[4]?.querySelector('.queue-open-link')).toBeNull();
    expect(rows[4]?.querySelector('[data-dismiss-job="job-err"]')).not.toBeNull();

    // Opening Popup on an unclipped tab allows clipping immediately while others run
    expect(root.querySelector<HTMLButtonElement>('#clip-submit-btn')!.disabled).toBe(false);
    expect(root.querySelector<HTMLElement>('#clip-submit-hint')!.hidden).toBe(true);
  });

  it('tracks live CLIP_JOBS_UPDATED transitions, refreshes Recent clips on done, and preserves expanded warnings', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime();

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const queuePanel = root.querySelector<HTMLElement>('#clip-queue-panel')!;
    expect(queuePanel.hidden).toBe(true);

    // Push live extracting -> downloading -> uploading -> done transitions
    mock.emitJobs([
      makeJob({
        id: 'job-live',
        url: 'https://other.example.com/live',
        title: 'Live Streaming Clip',
        status: 'extracting',
      }),
    ]);

    expect(queuePanel.hidden).toBe(false);
    expect(root.querySelector('#clip-queue-summary')?.textContent).toBe('1 running');
    expect(root.querySelector('.queue-item-detail')?.textContent).toBe('Extracting...');

    mock.emitJobs([
      makeJob({
        id: 'job-live',
        url: 'https://other.example.com/live',
        title: 'Live Streaming Clip',
        status: 'downloading',
        completed: 2,
        total: 5,
      }),
    ]);
    expect(root.querySelector('.queue-item-detail')?.textContent).toBe('Downloading 2/5');
    expect(root.querySelector<HTMLElement>('.queue-progress-fill')?.style.width).toBe('40%');

    mock.emitJobs([
      makeJob({
        id: 'job-live',
        url: 'https://other.example.com/live',
        title: 'Live Streaming Clip',
        status: 'uploading',
        completed: 4,
        total: 5,
      }),
    ]);
    expect(root.querySelector('.queue-item-detail')?.textContent).toBe('Uploading 4/5');
    expect(root.querySelector<HTMLElement>('.queue-progress-fill')?.style.width).toBe('80%');

    // Update history store before transitioning job to done
    mock.setHistory([
      {
        id: 'hist-live',
        title: 'Live Streaming Clip',
        sourceUrl: 'https://other.example.com/live',
        folderId: 'drive-folder-live',
        folderUrl: 'https://drive.google.com/drive/folders/drive-folder-live',
        folderName: '2026-11-24-live-streaming-clip',
        clippedAt: FIXED_NOW.toISOString(),
        imageCount: 1,
        warningCount: 1,
      },
    ]);

    const doneJob = makeJob({
      id: 'job-live',
      url: 'https://other.example.com/live',
      title: 'Live Streaming Clip',
      status: 'done',
      result: makeClipResult({
        folderId: 'drive-folder-live',
        folderUrl: 'https://drive.google.com/drive/folders/drive-folder-live',
        title: 'Live Streaming Clip',
        uploadedImages: [
          {
            id: 'img-1',
            filename: '01-hero.webp',
            fileId: 'f1',
            mimeType: 'image/webp',
            resolvedUrl: 'https://other.example.com/hero.webp',
          },
        ],
        warnings: ['Kept remote URL for https://other.example.com/missing.png (HTTP 404)'],
      }),
    });
    mock.emitJobs([doneJob]);

    expect(root.querySelector('#clip-queue-summary')?.textContent).toBe('1 saved');
    expect(root.querySelector('.queue-item-detail')?.textContent).toBe('Saved · 1 image');
    expect(root.querySelector<HTMLAnchorElement>('.queue-open-link')?.href).toBe(
      'https://drive.google.com/drive/folders/drive-folder-live',
    );

    // Recent clips auto-refreshed when job transitioned to done
    await vi.waitFor(() =>
      expect(root.querySelector('#recent-clips-count')?.textContent).toBe('1'),
    );

    // Expand warnings on job-live, then push a progress tick for a second job and verify details stays open
    const details = root.querySelector<HTMLDetailsElement>(
      '[data-job-warnings="job-live"]',
    )!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));

    mock.emitJobs([
      makeJob({
        id: 'job-second',
        url: 'https://second.example.com/post',
        title: 'Second Tab',
        status: 'downloading',
        completed: 1,
        total: 4,
      }),
      doneJob,
    ]);

    const reRenderedDetails = root.querySelector<HTMLDetailsElement>(
      '[data-job-warnings="job-live"]',
    )!;
    expect(reRenderedDetails.open).toBe(true);
  });

  it('supports non-blocking submit, guards duplicate active URL on current tab, and re-enables once finished', async () => {
    const root = loadPopupDom();
    let resolveStartClip!: (res: BackgroundResponse<ClipJob>) => void;

    const mock = createMockRuntime({
      onStartClip: async () =>
        new Promise<BackgroundResponse<ClipJob>>((resolve) => {
          resolveStartClip = resolve;
        }),
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const submitBtn = root.querySelector<HTMLButtonElement>('#clip-submit-btn')!;
    const submitLabel = root.querySelector<HTMLElement>('#clip-btn-label')!;
    const submitSpinner = root.querySelector<HTMLElement>('#clip-btn-spinner')!;
    const submitHint = root.querySelector<HTMLElement>('#clip-submit-hint')!;
    const titleInput = root.querySelector<HTMLInputElement>('#title-input')!;

    root
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Brief submitting state while START_CLIP is accepted
    expect(submitBtn.disabled).toBe(true);
    expect(submitSpinner.hidden).toBe(false);
    expect(submitLabel.textContent).toBe('Starting clip...');

    const acceptedJob = makeJob({
      id: 'job-current',
      tabId: 42,
      url: 'https://example.com/articles/v8-compiler#intro',
      title: 'How V8 Compiles JavaScript',
      status: 'queued',
      updatedAt: '2026-11-24T10:30:01.000Z',
    });

    resolveStartClip({ ok: true, data: acceptedJob });

    await vi.waitFor(() => expect(submitSpinner.hidden).toBe(true));
    expect(submitLabel.textContent).toBe('Clip to Google Drive');
    // Inputs re-enabled immediately, while button stays guarded for duplicate active URL
    expect(titleInput.disabled).toBe(false);
    expect(submitBtn.disabled).toBe(true);
    expect(submitHint.hidden).toBe(false);
    expect(submitHint.textContent).toBe('Already clipping this page');
    expect(root.querySelectorAll('.queue-item')).toHaveLength(1);

    // Once job completes, submit button automatically re-enables for idempotent re-clip
    mock.emitJobs([
      {
        ...acceptedJob,
        status: 'done',
        updatedAt: '2026-11-24T10:30:10.000Z',
        result: makeClipResult({ reusedFolder: true }),
      },
    ]);

    expect(submitBtn.disabled).toBe(false);
    expect(submitHint.hidden).toBe(true);
    expect(root.querySelector('.queue-item-detail')?.textContent).toBe('Updated');
  });

  it('does not regress a newer CLIP_JOBS_UPDATED state when START_CLIP resolves later', async () => {
    const root = loadPopupDom();
    let resolveStartClip!: (res: BackgroundResponse<ClipJob>) => void;
    let pushJobs!: (jobs: ClipJob[]) => void;

    const mock = createMockRuntime({
      onStartClip: async (_msg, helpers) => {
        pushJobs = helpers.emitJobs;
        return new Promise((resolve) => {
          resolveStartClip = resolve;
        });
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    root
      .querySelector<HTMLFormElement>('#clip-form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Newer push arrives before START_CLIP RPC callback resolves
    pushJobs([
      makeJob({
        id: 'job-race',
        status: 'downloading',
        completed: 3,
        total: 10,
        updatedAt: '2026-11-24T10:30:05.000Z',
      }),
    ]);

    resolveStartClip({
      ok: true,
      data: makeJob({
        id: 'job-race',
        status: 'queued',
        updatedAt: '2026-11-24T10:30:01.000Z',
      }),
    });

    await vi.waitFor(() =>
      expect(root.querySelector<HTMLElement>('#clip-btn-spinner')!.hidden).toBe(true),
    );
    expect(root.querySelector('.queue-item-detail')?.textContent).toBe('Downloading 3/10');
  });

  it('renders 12 concurrent multi-tab jobs cleanly and supports single-job dismiss and Clear done', async () => {
    const root = loadPopupDom();
    const twelveJobs: ClipJob[] = Array.from({ length: 12 }, (_, idx) => {
      const n = idx + 1;
      if (idx < 2) {
        return makeJob({
          id: `job-${n}`,
          tabId: 100 + n,
          url: `https://site-${n}.example.com/article`,
          title: `Concurrent Article ${n} with a very long headline that truncates cleanly`,
          status: idx === 0 ? 'downloading' : 'uploading',
          completed: n * 3,
          total: 20,
        });
      }
      if (idx < 9) {
        return makeJob({
          id: `job-${n}`,
          tabId: 100 + n,
          url: `https://site-${n}.example.com/article`,
          title: `Queued Article ${n}`,
          status: 'queued',
        });
      }
      if (idx < 11) {
        return makeJob({
          id: `job-${n}`,
          tabId: 100 + n,
          url: `https://site-${n}.example.com/article`,
          title: `Finished Article ${n}`,
          status: 'done',
          result: makeClipResult({
            folderId: `fld-${n}`,
            folderUrl: `https://drive.google.com/drive/folders/fld-${n}`,
            title: `Finished Article ${n}`,
          }),
        });
      }
      return makeJob({
        id: `job-${n}`,
        tabId: 100 + n,
        url: `https://site-${n}.example.com/article`,
        title: `Failed Article ${n}`,
        status: 'error',
        error: 'Network timeout',
      });
    });

    const mock = createMockRuntime({ jobs: twelveJobs });
    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const summary = root.querySelector<HTMLElement>('#clip-queue-summary')!;
    const clearBtn = root.querySelector<HTMLButtonElement>('#clear-done-jobs-btn')!;
    const rows = root.querySelectorAll<HTMLLIElement>('.queue-item');

    expect(rows).toHaveLength(12);
    expect(summary.textContent).toBe('2 running · 7 queued');
    expect(clearBtn.hidden).toBe(false);
    expect(rows[0]?.querySelector<HTMLElement>('.queue-item-title')?.title).toContain(
      'Concurrent Article 1',
    );
    // Only finished/failed rows (jobs 10, 11, 12) have dismiss buttons
    expect(root.querySelectorAll('[data-dismiss-job]')).toHaveLength(3);
    // Only done rows (jobs 10, 11) have Open links
    expect(root.querySelectorAll('.queue-open-link')).toHaveLength(2);

    // Dismiss single failed job
    root.querySelector<HTMLButtonElement>('[data-dismiss-job="job-12"]')!.click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('.queue-item')).toHaveLength(11),
    );
    expect(mock.sentMessages).toContainEqual({
      type: 'DISMISS_CLIP_JOB',
      jobId: 'job-12',
    });

    // Clear remaining completed jobs
    clearBtn.click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('.queue-item')).toHaveLength(9),
    );
    expect(mock.sentMessages).toContainEqual({ type: 'CLEAR_COMPLETED_JOBS' });
    expect(clearBtn.hidden).toBe(true);
    expect(summary.textContent).toBe('2 running · 7 queued');
  });

  it('hides Clip queue when the final completed job is cleared', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      jobs: [
        makeJob({
          id: 'job-only',
          status: 'done',
          result: makeClipResult(),
        }),
      ],
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const panel = root.querySelector<HTMLElement>('#clip-queue-panel')!;
    expect(panel.hidden).toBe(false);
    expect(root.querySelector('#clip-queue-summary')?.textContent).toBe('1 saved');

    root.querySelector<HTMLButtonElement>('#clear-done-jobs-btn')!.click();
    await vi.waitFor(() => expect(panel.hidden).toBe(true));
  });

  it('shows friendly unconfigured developer setup card, hides clip form, and opens Settings', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      authStatus: { oauthConfigured: false, authenticated: false },
      manifestOAuthConfigured: false,
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const brandTitle = root.querySelector<HTMLElement>('.brand-title')!;
    const banner = root.querySelector<HTMLElement>('#onboarding-banner')!;
    const bannerTitle = root.querySelector<HTMLElement>('#banner-title')!;
    const bannerDesc = root.querySelector<HTMLElement>('#banner-description')!;
    const bannerSignInBtn =
      root.querySelector<HTMLButtonElement>('#banner-signin-btn')!;
    const bannerOptionsBtn =
      root.querySelector<HTMLButtonElement>('#banner-options-btn')!;
    const form = root.querySelector<HTMLFormElement>('#clip-form')!;
    const clipBtn = root.querySelector<HTMLButtonElement>('#clip-submit-btn')!;
    const recentSection = root.querySelector<HTMLElement>('#recent-clips-section')!;

    expect(brandTitle.textContent).toBe('OKF Clipper');
    expect(controller.getBannerState()).toEqual({ kind: 'oauth-unconfigured' });
    expect(banner.hidden).toBe(false);
    expect(bannerTitle.textContent).toBe('Set up Google OAuth to get started');
    expect(bannerDesc.textContent).toContain('Custom Web OAuth Client ID');
    expect(bannerSignInBtn.hidden).toBe(true);
    expect(bannerOptionsBtn.hidden).toBe(false);
    expect(bannerOptionsBtn.textContent).toBe('Open Settings');
    expect(form.hidden).toBe(true);
    expect(clipBtn.disabled).toBe(true);
    expect(recentSection.hidden).toBe(true);

    bannerOptionsBtn.click();
    expect(mock.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('shows consumer Connect Google Drive welcome card without jargon, hides clip form until connected, and reveals form on sign-in', async () => {
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

    const brandTitle = root.querySelector<HTMLElement>('.brand-title')!;
    const banner = root.querySelector<HTMLElement>('#onboarding-banner')!;
    const bannerTitle = root.querySelector<HTMLElement>('#banner-title')!;
    const bannerDesc = root.querySelector<HTMLElement>('#banner-description')!;
    const signInBtn =
      root.querySelector<HTMLButtonElement>('#banner-signin-btn')!;
    const bannerOptionsBtn =
      root.querySelector<HTMLButtonElement>('#banner-options-btn')!;
    const bannerError = root.querySelector<HTMLElement>('#banner-error')!;
    const form = root.querySelector<HTMLFormElement>('#clip-form')!;
    const clipBtn = root.querySelector<HTMLButtonElement>('#clip-submit-btn')!;
    const recentSection = root.querySelector<HTMLElement>('#recent-clips-section')!;

    expect(brandTitle.textContent).toBe('OKF Clipper');
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains('banner--welcome')).toBe(true);
    expect(bannerTitle.textContent).toBe('Connect Google Drive');
    expect(bannerDesc.textContent).toContain('WebClips/');
    expect(bannerDesc.textContent).toContain('No third-party servers');
    expect(bannerDesc.textContent).toContain('only access files it creates');
    // Zero internal jargon for consumer Chrome Web Store onboarding
    expect(banner.textContent).not.toMatch(/chrome\.identity|config\.local\.json|googleapis\.com/i);
    expect(signInBtn.hidden).toBe(false);
    expect(signInBtn.textContent).toBe('Connect Google Drive');
    expect(bannerOptionsBtn.hidden).toBe(true);
    expect(bannerError.hidden).toBe(true);
    expect(form.hidden).toBe(true);
    expect(clipBtn.disabled).toBe(true);
    expect(recentSection.hidden).toBe(true);

    signInBtn.click();
    await vi.waitFor(() => expect(banner.hidden).toBe(true));
    expect(form.hidden).toBe(false);
    expect(clipBtn.disabled).toBe(false);
    expect(recentSection.hidden).toBe(false);
  });

  it('keeps existing Clip queue and Recent clips accessible while signed out and sanitizes raw sign-in errors', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      authStatus: { oauthConfigured: true, authenticated: false },
      jobs: [
        makeJob({
          id: 'job-prev-done',
          status: 'done',
          result: makeClipResult(),
        }),
      ],
      history: [
        {
          id: 'clip-existing',
          title: 'Existing Saved Clip',
          sourceUrl: 'https://example.com/saved',
          folderId: 'fld-existing',
          folderUrl: 'https://drive.google.com/drive/folders/fld-existing',
          folderName: '2026-11-24-existing',
          clippedAt: FIXED_NOW.toISOString(),
          imageCount: 2,
          warningCount: 0,
        },
      ],
      onSignIn: async () => ({
        ok: false,
        code: 'AUTH_REQUIRED',
        error: 'Unexpected config.local.json chrome.identity failure',
      }),
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const form = root.querySelector<HTMLFormElement>('#clip-form')!;
    const queuePanel = root.querySelector<HTMLElement>('#clip-queue-panel')!;
    const recentSection = root.querySelector<HTMLElement>('#recent-clips-section')!;
    const signInBtn = root.querySelector<HTMLButtonElement>('#banner-signin-btn')!;
    const bannerError = root.querySelector<HTMLElement>('#banner-error')!;

    expect(form.hidden).toBe(true);
    expect(queuePanel.hidden).toBe(false);
    expect(recentSection.hidden).toBe(false);
    expect(root.querySelector('#recent-clips-count')?.textContent).toBe('1');

    signInBtn.click();
    await vi.waitFor(() => expect(bannerError.hidden).toBe(false));
    expect(bannerError.textContent).not.toMatch(/config\.local\.json|chrome\.identity/i);
    expect(bannerError.textContent).toContain('try connecting Google Drive again');
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
        rootError.querySelector<HTMLElement>('#submit-error-title')!.textContent,
      ).toBe('Sign in required'),
    );
    expect(
      rootError.querySelector<HTMLElement>('#submit-error-panel')!.hidden,
    ).toBe(false);
    expect(controller.getBannerState().kind).toBe('signed-out');
    expect(
      rootError.querySelector<HTMLButtonElement>('#banner-signin-btn')!.hidden,
    ).toBe(false);

    // Dismissing inline submit error hides it cleanly
    rootError.querySelector<HTMLButtonElement>('#submit-error-dismiss-btn')!.click();
    expect(
      rootError.querySelector<HTMLElement>('#submit-error-panel')!.hidden,
    ).toBe(true);
  });

  it('formats queue summaries and job presentations accurately across all states', () => {
    expect(
      formatQueueSummary([
        makeJob({ id: '1', status: 'done' }),
        makeJob({ id: '2', status: 'done' }),
        makeJob({ id: '3', status: 'error' }),
      ]),
    ).toBe('2 saved · 1 failed');

    const authErrPresentation = describeClipJob(
      makeJob({
        id: 'err-auth',
        status: 'error',
        error: 'raw',
        errorCode: 'AUTH_REQUIRED',
      }),
    );
    expect(authErrPresentation.detail).toContain('Sign in to Google Drive');
    expect(authErrPresentation.canDismiss).toBe(true);
    expect(authErrPresentation.canOpen).toBe(false);
  });

  it('supports keyboard arrow navigation on clip scope radiogroup and polite live announcements for job transitions', async () => {
    const root = loadPopupDom();
    const mock = createMockRuntime({
      pageInfo: {
        ok: true,
        data: {
          tabId: 19,
          url: 'https://example.com/a11y',
          title: 'Accessible Article',
          hasSelection: true,
          selectionLength: 120,
          site: 'example.com',
        },
      },
    });

    controller = await mountPopup(root, {
      runtime: mock.runtime,
      now: () => FIXED_NOW,
    });

    const fullBtn = root.querySelector<HTMLButtonElement>('#mode-full-btn')!;
    const selBtn = root.querySelector<HTMLButtonElement>('#mode-selection-btn')!;
    const liveRegion = root.querySelector<HTMLElement>('#queue-live-region')!;

    // Selection is auto-checked with roving tabindex
    expect(selBtn.getAttribute('aria-checked')).toBe('true');
    expect(selBtn.tabIndex).toBe(0);
    expect(fullBtn.tabIndex).toBe(-1);

    // ArrowLeft toggles to Full page and moves roving tabindex
    selBtn.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(fullBtn.getAttribute('aria-checked')).toBe('true');
    expect(fullBtn.tabIndex).toBe(0);
    expect(selBtn.tabIndex).toBe(-1);

    // ArrowRight toggles back to Selection
    fullBtn.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(selBtn.getAttribute('aria-checked')).toBe('true');
    expect(selBtn.tabIndex).toBe(0);

    // Progress bar includes accessible label, and terminal transitions announce via live region
    mock.emitJobs([
      makeJob({
        id: 'job-a11y',
        title: 'Accessible Article',
        status: 'downloading',
        completed: 2,
        total: 4,
      }),
    ]);
    const progressBar = root.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(progressBar.getAttribute('aria-label')).toContain('Accessible Article');
    expect(progressBar.getAttribute('aria-valuenow')).toBe('50');

    mock.emitJobs([
      makeJob({
        id: 'job-a11y',
        title: 'Accessible Article',
        status: 'done',
        result: makeClipResult({ title: 'Accessible Article' }),
      }),
    ]);
    expect(liveRegion.textContent).toContain('Accessible Article');
    expect(liveRegion.textContent).toContain('Saved');
  });
});
