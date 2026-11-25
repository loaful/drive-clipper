// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTENSION_SETTINGS,
  type AuthStatus,
  type BackgroundResponse,
  type ExtensionSettings,
  type RootFolderInfo,
  type UiMessageResponseMap,
  type UiToBackgroundMessage,
} from '../../src/types.js';
import { mountOptions, type OptionsController } from '../../src/ui/options.js';
import type { UiRuntimeClient } from '../../src/ui/shared.js';

const OPTIONS_HTML = readFileSync(
  path.resolve(process.cwd(), 'src/ui/options.html'),
  'utf8',
);

function loadOptionsDom(): HTMLElement {
  const bodyMatch = OPTIONS_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) {
    throw new Error('Failed to parse <body> from src/ui/options.html');
  }
  document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '');
  const root = document.querySelector<HTMLElement>('[data-app="options"]');
  if (!root) {
    throw new Error('Options root [data-app="options"] not found');
  }
  return root;
}

interface MockOptionsRuntimeConfig {
  settings?: ExtensionSettings;
  authStatus?: AuthStatus;
  manifestOAuthConfigured?: boolean | null;
  onEnsureRootFolder?: (
    msg: Extract<UiToBackgroundMessage, { type: 'ENSURE_ROOT_FOLDER' }>,
  ) => Promise<BackgroundResponse<RootFolderInfo>>;
  onUpdateSettings?: (
    patch: Partial<ExtensionSettings>,
    current: ExtensionSettings,
  ) => Promise<BackgroundResponse<ExtensionSettings>>;
}

function createMockOptionsRuntime(config: MockOptionsRuntimeConfig = {}) {
  let currentSettings: ExtensionSettings = {
    ...DEFAULT_EXTENSION_SETTINGS,
    ...config.settings,
    frontmatter: {
      ...DEFAULT_EXTENSION_SETTINGS.frontmatter,
      ...config.settings?.frontmatter,
    },
  };
  let currentAuth: AuthStatus = config.authStatus ?? {
    oauthConfigured: true,
    authenticated: true,
  };

  const sentMessages: UiToBackgroundMessage[] = [];

  const syncAuthForCustomClientChange = (): void => {
    const manifestConfigured = config.manifestOAuthConfigured ?? true;
    const customId = currentSettings.customWebAuthClientId;
    if (customId) {
      currentAuth = {
        oauthConfigured: true,
        authenticated: false,
        authMode: 'custom-client',
        usingCustomClientId: true,
      };
    } else {
      currentAuth = {
        oauthConfigured: Boolean(manifestConfigured),
        authenticated: false,
      };
    }
  };

  const runtime: UiRuntimeClient = {
    async sendMessage<K extends UiToBackgroundMessage['type']>(
      message: Extract<UiToBackgroundMessage, { type: K }>,
    ): Promise<BackgroundResponse<UiMessageResponseMap[K]>> {
      const msg: UiToBackgroundMessage = message;
      sentMessages.push(msg);

      switch (msg.type) {
        case 'GET_AUTH_STATUS':
          return {
            ok: true,
            data: currentAuth as UiMessageResponseMap[K],
          };
        case 'SIGN_IN':
          currentAuth = {
            ...currentAuth,
            oauthConfigured: true,
            authenticated: true,
          };
          return {
            ok: true,
            data: currentAuth as UiMessageResponseMap[K],
          };
        case 'SIGN_OUT':
          currentAuth = {
            ...currentAuth,
            oauthConfigured: currentAuth.oauthConfigured,
            authenticated: false,
          };
          return {
            ok: true,
            data: currentAuth as UiMessageResponseMap[K],
          };
        case 'GET_SETTINGS':
          return {
            ok: true,
            data: currentSettings as UiMessageResponseMap[K],
          };
        case 'UPDATE_SETTINGS': {
          const prevCustomClientId = currentSettings.customWebAuthClientId;
          if (config.onUpdateSettings) {
            const res = await config.onUpdateSettings(
              msg.patch,
              currentSettings,
            );
            if (res.ok) {
              currentSettings = res.data;
              if (currentSettings.customWebAuthClientId !== prevCustomClientId) {
                syncAuthForCustomClientChange();
              }
            }
            return res as BackgroundResponse<UiMessageResponseMap[K]>;
          }
          currentSettings = {
            ...currentSettings,
            ...msg.patch,
            customWebAuthClientId:
              msg.patch.customWebAuthClientId === undefined
                ? currentSettings.customWebAuthClientId
                : msg.patch.customWebAuthClientId,
            frontmatter: {
              ...currentSettings.frontmatter,
              ...msg.patch.frontmatter,
            },
          };
          if (currentSettings.customWebAuthClientId !== prevCustomClientId) {
            syncAuthForCustomClientChange();
          }
          return {
            ok: true,
            data: currentSettings as UiMessageResponseMap[K],
          };
        }
        case 'ENSURE_ROOT_FOLDER':
          if (config.onEnsureRootFolder) {
            return (await config.onEnsureRootFolder(
              msg,
            )) as BackgroundResponse<UiMessageResponseMap[K]>;
          }
          {
            const name = msg.folderName ?? currentSettings.rootFolderName;
            const id = msg.forceNew ? 'folder-switched-2' : 'folder-created-1';
            currentSettings = {
              ...currentSettings,
              rootFolderName: name,
              rootFolderId: id,
            };
            return {
              ok: true,
              data: {
                folderId: id,
                folderName: name,
                folderUrl: `https://drive.google.com/drive/folders/${id}`,
                created: true,
              } as UiMessageResponseMap[K],
            };
          }
        default:
          return { ok: false, error: `Unhandled message: ${msg.type}` };
      }
    },
    onClipProgress: () => () => undefined,
    onClipJobsUpdated: () => () => undefined,
    openOptionsPage: vi.fn(),
    getManifestOAuthConfigured: () => config.manifestOAuthConfigured ?? true,
  };

  return { runtime, sentMessages };
}

describe('Options UI', () => {
  let controller: OptionsController | null = null;

  afterEach(() => {
    controller?.destroy();
    controller = null;
    document.body.innerHTML = '';
  });

  it('shows OAuth setup guidance, disables sign-in, and auto-opens Advanced when client_id is unconfigured', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      authStatus: { oauthConfigured: false, authenticated: false },
      manifestOAuthConfigured: false,
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const pageTitle = root.querySelector<HTMLElement>('.page-title')!;
    const callout = root.querySelector<HTMLElement>('#oauth-unconfigured-callout')!;
    const signInBtn = root.querySelector<HTMLButtonElement>('#sign-in-btn')!;
    const folderBtn =
      root.querySelector<HTMLButtonElement>('#create-switch-folder-btn')!;
    const statusText = root.querySelector<HTMLElement>('#auth-status-text')!;
    const advancedSection =
      root.querySelector<HTMLDetailsElement>('#advanced-section')!;

    expect(pageTitle.textContent).toBe('OKF Clipper Settings');
    expect(statusText.textContent).toBe('Setup required');
    expect(callout.hidden).toBe(false);
    expect(signInBtn.disabled).toBe(true);
    expect(folderBtn.disabled).toBe(true);
    expect(advancedSection.open).toBe(true);
  });

  it('keeps Advanced collapsed by default when configured and supports Connect, Sign out, and Reconnect transitions', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      authStatus: { oauthConfigured: true, authenticated: false },
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const authCard = root.querySelector<HTMLElement>('section[aria-labelledby="auth-heading"]')!;
    const signInBtn = root.querySelector<HTMLButtonElement>('#sign-in-btn')!;
    const signOutBtn = root.querySelector<HTMLButtonElement>('#sign-out-btn')!;
    const reauthBtn = root.querySelector<HTMLButtonElement>('#reauth-btn')!;
    const statusText = root.querySelector<HTMLElement>('#auth-status-text')!;
    const customPill = root.querySelector<HTMLElement>('#custom-client-pill')!;
    const advancedSection =
      root.querySelector<HTMLDetailsElement>('#advanced-section')!;

    expect(advancedSection.open).toBe(false);
    expect(statusText.textContent).toBe('Not connected');
    expect(customPill.hidden).toBe(true);
    expect(signInBtn.hidden).toBe(false);
    expect(signInBtn.textContent?.trim()).toBe('Connect Google Drive');
    expect(signOutBtn.hidden).toBe(true);
    expect(reauthBtn.textContent?.trim()).toBe('Reconnect');
    // Plain-English everyday Account card hides internal OAuth jargon
    expect(authCard.querySelector('.card-description')?.textContent).toContain(
      'directly from your browser to your Google Drive',
    );
    expect(authCard.querySelector('.card-description')?.textContent).not.toMatch(
      /chrome\.identity|drive\.file|config\.local\.json/i,
    );

    signInBtn.click();
    await vi.waitFor(() => expect(statusText.textContent).toBe('Connected'));
    expect(signOutBtn.hidden).toBe(false);
    expect(reauthBtn.hidden).toBe(false);

    mock.sentMessages.length = 0;
    reauthBtn.click();
    await vi.waitFor(() =>
      expect(mock.sentMessages.map((m) => m.type)).toEqual([
        'SIGN_OUT',
        'SIGN_IN',
      ]),
    );
    expect(statusText.textContent).toBe('Connected');

    signOutBtn.click();
    await vi.waitFor(() => expect(statusText.textContent).toBe('Not connected'));
    expect(signInBtn.hidden).toBe(false);
  });

  it('saves, validates, and resets customWebAuthClientId inside Advanced & Self-hosting', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      authStatus: { oauthConfigured: false, authenticated: false },
      manifestOAuthConfigured: false,
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const advancedSection =
      root.querySelector<HTMLDetailsElement>('#advanced-section')!;
    const customForm = root.querySelector<HTMLFormElement>('#custom-client-form')!;
    const customInput = root.querySelector<HTMLInputElement>(
      '#custom-client-id-input',
    )!;
    const resetBtn = root.querySelector<HTMLButtonElement>(
      '#reset-custom-client-btn',
    )!;
    const customFeedback = root.querySelector<HTMLElement>(
      '#custom-client-feedback',
    )!;
    const customPill = root.querySelector<HTMLElement>('#custom-client-pill')!;
    const advancedBadge = root.querySelector<HTMLElement>('#advanced-custom-badge')!;
    const statusText = root.querySelector<HTMLElement>('#auth-status-text')!;
    const signInBtn = root.querySelector<HTMLButtonElement>('#sign-in-btn')!;
    const callout = root.querySelector<HTMLElement>('#oauth-unconfigured-callout')!;

    expect(advancedSection.open).toBe(true);
    expect(resetBtn.disabled).toBe(true);
    expect(customPill.hidden).toBe(true);
    expect(advancedBadge.hidden).toBe(true);

    // Rejects empty value and client secrets without sending UPDATE_SETTINGS
    customInput.value = '   ';
    customForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(customFeedback.dataset.tone).toBe('error');
    expect(mock.sentMessages.some((m) => m.type === 'UPDATE_SETTINGS')).toBe(false);

    customInput.value = 'GOCSPX-secret-value';
    customForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(customFeedback.dataset.tone).toBe('error');
    expect(customFeedback.textContent).toContain('Client Secret');
    expect(mock.sentMessages.some((m) => m.type === 'UPDATE_SETTINGS')).toBe(false);

    // Saving a valid BYO Web OAuth Client ID unlocks OAuth and shows custom pill
    const byoClientId = '9999999999-byo.apps.googleusercontent.com';
    customInput.value = `  ${byoClientId}  `;
    customForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(statusText.textContent).toBe('Not connected'));
    expect(mock.sentMessages).toContainEqual({
      type: 'UPDATE_SETTINGS',
      patch: { customWebAuthClientId: byoClientId },
    });
    expect(controller.getSettings().customWebAuthClientId).toBe(byoClientId);
    expect(callout.hidden).toBe(true);
    expect(signInBtn.disabled).toBe(false);
    expect(customPill.hidden).toBe(false);
    expect(advancedBadge.hidden).toBe(false);
    expect(resetBtn.disabled).toBe(false);
    expect(advancedSection.open).toBe(true);
    expect(customFeedback.dataset.tone).toBe('success');

    // Clicking "Use built-in" clears customWebAuthClientId and hides custom pills
    resetBtn.click();
    await vi.waitFor(() => expect(statusText.textContent).toBe('Setup required'));
    expect(mock.sentMessages).toContainEqual({
      type: 'UPDATE_SETTINGS',
      patch: { customWebAuthClientId: null },
    });
    expect(controller.getSettings().customWebAuthClientId).toBeNull();
    expect(customInput.value).toBe('');
    expect(customPill.hidden).toBe(true);
    expect(advancedBadge.hidden).toBe(true);
    expect(resetBtn.disabled).toBe(true);
  });

  it('displays persisted rootFolderId, Open in Drive link, moving/renaming note, and creates/switches folders', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        rootFolderName: 'WebClips',
        rootFolderId: null,
      },
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const folderNameInput = root.querySelector<HTMLInputElement>(
      '#root-folder-name-input',
    )!;
    const folderIdEl = root.querySelector<HTMLElement>('#root-folder-id-value')!;
    const openLink =
      root.querySelector<HTMLAnchorElement>('#open-root-folder-link')!;
    const createSwitchBtn =
      root.querySelector<HTMLButtonElement>('#create-switch-folder-btn')!;
    const note = root.querySelector<HTMLElement>('#drive-file-note')!;

    expect(folderNameInput.value).toBe('WebClips');
    expect(openLink.hidden).toBe(true);
    expect(note.textContent).toContain('Google Drive ID');
    expect(note.textContent).toContain('move or rename');

    // First creation uses forceNew: false
    createSwitchBtn.click();
    await vi.waitFor(() =>
      expect(folderIdEl.textContent).toBe('folder-created-1'),
    );
    expect(openLink.hidden).toBe(false);
    expect(openLink.href).toBe(
      'https://drive.google.com/drive/folders/folder-created-1',
    );
    expect(mock.sentMessages.at(-1)).toEqual({
      type: 'ENSURE_ROOT_FOLDER',
      folderName: 'WebClips',
      forceNew: false,
    });

    // Switching to a new folder name uses forceNew: true
    folderNameInput.value = 'ResearchClips';
    createSwitchBtn.click();
    await vi.waitFor(() =>
      expect(folderIdEl.textContent).toBe('folder-switched-2'),
    );
    expect(openLink.href).toBe(
      'https://drive.google.com/drive/folders/folder-switched-2',
    );
    expect(mock.sentMessages.at(-1)).toEqual({
      type: 'ENSURE_ROOT_FOLDER',
      folderName: 'ResearchClips',
      forceNew: true,
    });
  });

  it('persists default tags and frontmatter preferences via UPDATE_SETTINGS without touching customWebAuthClientId', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        rootFolderName: 'WebClips',
        rootFolderId: 'existing-root-1',
        defaultTags: ['web-clip'],
        customWebAuthClientId: '1234567890-keep.apps.googleusercontent.com',
        frontmatter: {
          includeAuthor: true,
          includePublished: true,
          includeSite: true,
          includeImages: true,
          includeWarnings: true,
        },
      },
      authStatus: {
        oauthConfigured: true,
        authenticated: true,
        authMode: 'custom-client',
        usingCustomClientId: true,
      },
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const tagsInput = root.querySelector<HTMLInputElement>('#default-tags-input')!;
    const authorToggle =
      root.querySelector<HTMLInputElement>('#fm-include-author')!;
    const warningsToggle =
      root.querySelector<HTMLInputElement>('#fm-include-warnings')!;
    const form = root.querySelector<HTMLFormElement>('#preferences-form')!;
    const feedback = root.querySelector<HTMLElement>('#preferences-feedback')!;

    tagsInput.value = 'reading-list, #Reference';
    authorToggle.checked = false;
    warningsToggle.checked = false;

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(feedback.textContent).toBe('Preferences saved.'),
    );

    const updateMsg = mock.sentMessages.find(
      (m): m is Extract<UiToBackgroundMessage, { type: 'UPDATE_SETTINGS' }> =>
        m.type === 'UPDATE_SETTINGS',
    );
    expect(updateMsg).toEqual({
      type: 'UPDATE_SETTINGS',
      patch: {
        rootFolderName: 'WebClips',
        defaultTags: ['web-clip', 'reading-list', 'reference'],
        frontmatter: {
          includeAuthor: false,
          includePublished: true,
          includeSite: true,
          includeImages: true,
          includeWarnings: false,
        },
      },
    });

    expect(controller.getSettings().defaultTags).toEqual([
      'web-clip',
      'reading-list',
      'reference',
    ]);
    expect(controller.getSettings().frontmatter.includeAuthor).toBe(false);
    expect(controller.getSettings().frontmatter.includeWarnings).toBe(false);
    expect(controller.getSettings().customWebAuthClientId).toBe(
      '1234567890-keep.apps.googleusercontent.com',
    );
  });

  it('leaves stickyTags untouched when saving defaultTags and explains sticky Popup tags', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        defaultTags: ['web-clip'],
        stickyTags: [],
      },
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    expect(root.querySelector('#default-tags-help')?.textContent).toContain(
      'Popup remembers your last-used tags',
    );

    const tagsInput = root.querySelector<HTMLInputElement>('#default-tags-input')!;
    const form = root.querySelector<HTMLFormElement>('#preferences-form')!;
    const feedback = root.querySelector<HTMLElement>('#preferences-feedback')!;

    tagsInput.value = 'reading-list';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(feedback.textContent).toBe('Preferences saved.'),
    );

    const updateMsg = mock.sentMessages.find(
      (m): m is Extract<UiToBackgroundMessage, { type: 'UPDATE_SETTINGS' }> =>
        m.type === 'UPDATE_SETTINGS',
    );
    expect(updateMsg).toBeDefined();
    expect('stickyTags' in (updateMsg?.patch ?? {})).toBe(false);
    expect(controller.getSettings().defaultTags).toEqual([
      'web-clip',
      'reading-list',
    ]);
    expect(controller.getSettings().stickyTags).toEqual([]);
  });

  it('validates non-empty folder name and surfaces AUTH_REQUIRED errors cleanly', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      onEnsureRootFolder: async () => ({
        ok: false,
        code: 'AUTH_REQUIRED',
        error: 'Please sign in before creating a folder.',
      }),
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const folderInput = root.querySelector<HTMLInputElement>(
      '#root-folder-name-input',
    )!;
    const createSwitchBtn =
      root.querySelector<HTMLButtonElement>('#create-switch-folder-btn')!;
    const feedback = root.querySelector<HTMLElement>('#folder-feedback')!;
    const statusText = root.querySelector<HTMLElement>('#auth-status-text')!;

    folderInput.value = '   ';
    createSwitchBtn.click();
    expect(feedback.textContent).toContain('Enter a folder name');
    expect(
      mock.sentMessages.some((m) => m.type === 'ENSURE_ROOT_FOLDER'),
    ).toBe(false);

    folderInput.value = 'WorkClips';
    createSwitchBtn.click();
    await vi.waitFor(() =>
      expect(feedback.textContent).toBe(
        'Please sign in before creating a folder.',
      ),
    );
    expect(statusText.textContent).toBe('Not connected');
  });

  it('houses technical diagnostics (OAuth Scope, Extension ID, Redirect URI) inside Advanced & Self-hosting', async () => {
    const root = loadOptionsDom();
    const mock = createMockOptionsRuntime({
      authStatus: { oauthConfigured: false, authenticated: false },
      manifestOAuthConfigured: false,
    });
    mock.runtime.getExtensionIdentityInfo = () => ({
      extensionId: 'lliikkoebahbliapkdchhdahfodpcach',
      redirectUri: 'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org',
    });

    controller = await mountOptions(root, { runtime: mock.runtime });

    const advancedSection =
      root.querySelector<HTMLDetailsElement>('#advanced-section')!;
    const extMeta = advancedSection.querySelector<HTMLElement>('#extension-id-meta')!;
    const extVal = advancedSection.querySelector<HTMLElement>('#extension-id-value')!;
    const redirectMeta = advancedSection.querySelector<HTMLElement>(
      '#oauth-redirect-uri-meta',
    )!;
    const redirectVal = advancedSection.querySelector<HTMLElement>(
      '#oauth-redirect-uri-value',
    )!;

    expect(advancedSection.textContent).toContain(
      'https://www.googleapis.com/auth/drive.file',
    );
    expect(extMeta.hidden).toBe(false);
    expect(extVal.textContent).toBe('lliikkoebahbliapkdchhdahfodpcach');
    expect(redirectMeta.hidden).toBe(false);
    expect(redirectVal.textContent).toBe(
      'https://lliikkoebahbliapkdchhdahfodpcach.chromiumapp.org',
    );
  });
});
