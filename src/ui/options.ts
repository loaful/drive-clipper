import {
  buildDriveFolderUrl,
  DEFAULT_EXTENSION_SETTINGS,
  type AuthStatus,
  type ExtensionSettings,
  type FrontmatterPreferences,
} from '../types.js';
import {
  createChromeRuntimeClient,
  createTagEditor,
  resolveOAuthConfigured,
  type TagEditorController,
  type UiRuntimeClient,
} from './shared.js';

export interface OptionsMountOptions {
  runtime?: UiRuntimeClient;
}

export interface OptionsController {
  refresh(): Promise<void>;
  getSettings(): ExtensionSettings;
  getAuthStatus(): AuthStatus | null;
  destroy(): void;
}

type FeedbackTone = 'neutral' | 'success' | 'error';

function queryRequired<T extends HTMLElement>(
  root: HTMLElement,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Options markup missing required element: ${selector}`);
  }
  return element;
}

function setFeedback(
  el: HTMLElement,
  message: string,
  tone: FeedbackTone = 'neutral',
): void {
  if (message.trim().length === 0) {
    el.hidden = true;
    el.textContent = '';
    delete el.dataset.tone;
    return;
  }
  el.hidden = false;
  el.dataset.tone = tone;
  el.textContent = message;
}

export async function mountOptions(
  root: HTMLElement,
  options: OptionsMountOptions = {},
): Promise<OptionsController> {
  const runtime = options.runtime ?? createChromeRuntimeClient();

  const authStatusBadge = queryRequired<HTMLSpanElement>(
    root,
    '#auth-status-badge',
  );
  const authStatusText = queryRequired<HTMLSpanElement>(
    root,
    '#auth-status-text',
  );
  const oauthUnconfiguredCallout = queryRequired<HTMLDivElement>(
    root,
    '#oauth-unconfigured-callout',
  );
  const signInBtn = queryRequired<HTMLButtonElement>(root, '#sign-in-btn');
  const signOutBtn = queryRequired<HTMLButtonElement>(root, '#sign-out-btn');
  const reauthBtn = queryRequired<HTMLButtonElement>(root, '#reauth-btn');
  const authFeedback = queryRequired<HTMLParagraphElement>(
    root,
    '#auth-feedback',
  );

  const rootFolderNameInput = queryRequired<HTMLInputElement>(
    root,
    '#root-folder-name-input',
  );
  const createSwitchFolderBtn = queryRequired<HTMLButtonElement>(
    root,
    '#create-switch-folder-btn',
  );
  const rootFolderIdValue = queryRequired<HTMLElement>(
    root,
    '#root-folder-id-value',
  );
  const openRootFolderLink = queryRequired<HTMLAnchorElement>(
    root,
    '#open-root-folder-link',
  );
  const folderFeedback = queryRequired<HTMLParagraphElement>(
    root,
    '#folder-feedback',
  );

  const preferencesForm = queryRequired<HTMLFormElement>(
    root,
    '#preferences-form',
  );
  const defaultTagsContainer = queryRequired<HTMLDivElement>(
    root,
    '#default-tags-container',
  );
  const defaultTagsInput = queryRequired<HTMLInputElement>(
    root,
    '#default-tags-input',
  );
  const fmIncludeAuthor = queryRequired<HTMLInputElement>(
    root,
    '#fm-include-author',
  );
  const fmIncludePublished = queryRequired<HTMLInputElement>(
    root,
    '#fm-include-published',
  );
  const fmIncludeSite = queryRequired<HTMLInputElement>(
    root,
    '#fm-include-site',
  );
  const fmIncludeImages = queryRequired<HTMLInputElement>(
    root,
    '#fm-include-images',
  );
  const fmIncludeWarnings = queryRequired<HTMLInputElement>(
    root,
    '#fm-include-warnings',
  );
  const savePreferencesBtn = queryRequired<HTMLButtonElement>(
    root,
    '#save-preferences-btn',
  );
  const preferencesFeedback = queryRequired<HTMLParagraphElement>(
    root,
    '#preferences-feedback',
  );

  let settings: ExtensionSettings = {
    ...DEFAULT_EXTENSION_SETTINGS,
    frontmatter: { ...DEFAULT_EXTENSION_SETTINGS.frontmatter },
  };
  let authStatus: AuthStatus | null = null;
  let busyAuth = false;
  let busyFolder = false;
  let busySave = false;

  const tagEditor: TagEditorController = createTagEditor({
    container: defaultTagsContainer,
    input: defaultTagsInput,
    initialTags: settings.defaultTags,
  });

  const renderAuth = (): void => {
    const oauthConfigured = resolveOAuthConfigured(
      authStatus,
      runtime.getManifestOAuthConfigured(),
    );
    const authenticated = Boolean(oauthConfigured && authStatus?.authenticated);

    authStatusBadge.classList.remove(
      'status-pill--neutral',
      'status-pill--ok',
      'status-pill--warn',
    );

    if (!oauthConfigured) {
      authStatusBadge.classList.add('status-pill--warn');
      authStatusBadge.dataset.status = 'unconfigured';
      authStatusText.textContent = 'OAuth setup required';
      oauthUnconfiguredCallout.hidden = false;
      signInBtn.hidden = false;
      signInBtn.disabled = true;
      signOutBtn.hidden = true;
      reauthBtn.hidden = true;
    } else if (authenticated) {
      authStatusBadge.classList.add('status-pill--ok');
      authStatusBadge.dataset.status = 'connected';
      authStatusText.textContent = 'Connected';
      oauthUnconfiguredCallout.hidden = true;
      signInBtn.hidden = true;
      signOutBtn.hidden = false;
      reauthBtn.hidden = false;
      signOutBtn.disabled = busyAuth;
      reauthBtn.disabled = busyAuth;
    } else {
      authStatusBadge.classList.add('status-pill--warn');
      authStatusBadge.dataset.status = 'signed-out';
      authStatusText.textContent = 'Signed out';
      oauthUnconfiguredCallout.hidden = true;
      signInBtn.hidden = false;
      signInBtn.disabled = busyAuth;
      signOutBtn.hidden = true;
      reauthBtn.hidden = true;
    }

    createSwitchFolderBtn.disabled = busyFolder || !oauthConfigured;
  };

  const renderSettings = (): void => {
    rootFolderNameInput.value = settings.rootFolderName;

    if (settings.rootFolderId) {
      rootFolderIdValue.textContent = settings.rootFolderId;
      openRootFolderLink.href = buildDriveFolderUrl(settings.rootFolderId);
      openRootFolderLink.hidden = false;
    } else {
      rootFolderIdValue.textContent =
        'Not created yet (created automatically on first clip)';
      openRootFolderLink.removeAttribute('href');
      openRootFolderLink.hidden = true;
    }

    tagEditor.setTags(settings.defaultTags);
    fmIncludeAuthor.checked = settings.frontmatter.includeAuthor;
    fmIncludePublished.checked = settings.frontmatter.includePublished;
    fmIncludeSite.checked = settings.frontmatter.includeSite;
    fmIncludeImages.checked = settings.frontmatter.includeImages;
    fmIncludeWarnings.checked = settings.frontmatter.includeWarnings;
    savePreferencesBtn.disabled = busySave;
  };

  const refresh = async (): Promise<void> => {
    const [authRes, settingsRes] = await Promise.all([
      runtime.sendMessage({ type: 'GET_AUTH_STATUS' }),
      runtime.sendMessage({ type: 'GET_SETTINGS' }),
    ]);

    if (authRes.ok) {
      authStatus = authRes.data;
      if (authRes.data.error) {
        setFeedback(authFeedback, authRes.data.error, 'error');
      } else {
        setFeedback(authFeedback, '');
      }
    } else if (authRes.code === 'OAUTH_NOT_CONFIGURED') {
      authStatus = { oauthConfigured: false, authenticated: false };
      setFeedback(authFeedback, '');
    } else {
      authStatus = {
        oauthConfigured: runtime.getManifestOAuthConfigured() ?? false,
        authenticated: false,
        error: authRes.error,
      };
      setFeedback(authFeedback, authRes.error, 'error');
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
    }

    renderAuth();
    renderSettings();
  };

  const handleSignIn = async (): Promise<void> => {
    if (busyAuth) {
      return;
    }
    busyAuth = true;
    setFeedback(authFeedback, 'Signing in to Google Drive...');
    renderAuth();

    const response = await runtime.sendMessage({ type: 'SIGN_IN' });
    busyAuth = false;

    if (response.ok) {
      authStatus = response.data;
      if (response.data.authenticated) {
        setFeedback(authFeedback, 'Signed in to Google Drive.', 'success');
      } else {
        setFeedback(
          authFeedback,
          response.data.error || 'Sign-in did not complete.',
          'error',
        );
      }
    } else {
      if (response.code === 'OAUTH_NOT_CONFIGURED') {
        authStatus = { oauthConfigured: false, authenticated: false };
      }
      setFeedback(authFeedback, response.error, 'error');
    }

    renderAuth();
  };

  const handleSignOut = async (): Promise<void> => {
    if (busyAuth) {
      return;
    }
    busyAuth = true;
    setFeedback(authFeedback, 'Signing out...');
    renderAuth();

    const response = await runtime.sendMessage({ type: 'SIGN_OUT' });
    busyAuth = false;

    if (response.ok) {
      authStatus = response.data;
      setFeedback(authFeedback, 'Signed out and cleared cached token.', 'success');
    } else {
      setFeedback(authFeedback, response.error, 'error');
    }

    renderAuth();
  };

  const handleReauth = async (): Promise<void> => {
    if (busyAuth) {
      return;
    }
    busyAuth = true;
    setFeedback(authFeedback, 'Clearing token and re-authenticating...');
    renderAuth();

    const signOutRes = await runtime.sendMessage({ type: 'SIGN_OUT' });
    if (!signOutRes.ok) {
      busyAuth = false;
      setFeedback(authFeedback, signOutRes.error, 'error');
      renderAuth();
      return;
    }

    const signInRes = await runtime.sendMessage({ type: 'SIGN_IN' });
    busyAuth = false;

    if (signInRes.ok) {
      authStatus = signInRes.data;
      if (signInRes.data.authenticated) {
        setFeedback(
          authFeedback,
          'Re-authenticated with Google Drive.',
          'success',
        );
      } else {
        setFeedback(
          authFeedback,
          signInRes.data.error || 'Re-authentication did not complete.',
          'error',
        );
      }
    } else {
      setFeedback(authFeedback, signInRes.error, 'error');
    }

    renderAuth();
  };

  const handleCreateOrSwitchFolder = async (): Promise<void> => {
    if (busyFolder) {
      return;
    }

    const folderName = rootFolderNameInput.value.trim();
    if (folderName.length === 0) {
      setFeedback(folderFeedback, 'Enter a folder name before creating or switching.', 'error');
      rootFolderNameInput.focus();
      return;
    }

    const hadExistingFolder = Boolean(settings.rootFolderId);
    busyFolder = true;
    setFeedback(
      folderFeedback,
      hadExistingFolder
        ? `Creating and switching to "${folderName}"...`
        : `Creating "${folderName}" in Google Drive...`,
    );
    renderAuth();

    const response = await runtime.sendMessage({
      type: 'ENSURE_ROOT_FOLDER',
      folderName,
      forceNew: hadExistingFolder,
    });
    busyFolder = false;

    if (response.ok) {
      settings = {
        ...settings,
        rootFolderName: response.data.folderName,
        rootFolderId: response.data.folderId,
      };
      renderSettings();
      const verb = hadExistingFolder ? 'Switched to folder' : 'Ready to clip into';
      setFeedback(
        folderFeedback,
        `${verb} "${response.data.folderName}" (${response.data.folderId}).`,
        'success',
      );
    } else {
      if (response.code === 'AUTH_REQUIRED') {
        authStatus = {
          oauthConfigured: true,
          authenticated: false,
          error: response.error,
        };
      }
      setFeedback(folderFeedback, response.error, 'error');
    }

    renderAuth();
  };

  const readFrontmatterPreferences = (): FrontmatterPreferences => ({
    includeAuthor: fmIncludeAuthor.checked,
    includePublished: fmIncludePublished.checked,
    includeSite: fmIncludeSite.checked,
    includeImages: fmIncludeImages.checked,
    includeWarnings: fmIncludeWarnings.checked,
  });

  const handleSavePreferences = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (busySave) {
      return;
    }

    const defaultTags = tagEditor.commitPendingInput();
    const rootFolderName =
      rootFolderNameInput.value.trim() || DEFAULT_EXTENSION_SETTINGS.rootFolderName;
    const frontmatter = readFrontmatterPreferences();

    busySave = true;
    savePreferencesBtn.disabled = true;
    setFeedback(preferencesFeedback, 'Saving preferences...');

    const response = await runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      patch: {
        rootFolderName,
        defaultTags,
        frontmatter,
      },
    });

    busySave = false;

    if (response.ok) {
      settings = {
        ...settings,
        ...response.data,
        frontmatter: {
          ...settings.frontmatter,
          ...response.data.frontmatter,
        },
      };
      renderSettings();
      setFeedback(preferencesFeedback, 'Preferences saved.', 'success');
    } else {
      savePreferencesBtn.disabled = false;
      setFeedback(preferencesFeedback, response.error, 'error');
    }
  };

  signInBtn.addEventListener('click', handleSignIn);
  signOutBtn.addEventListener('click', handleSignOut);
  reauthBtn.addEventListener('click', handleReauth);
  createSwitchFolderBtn.addEventListener('click', handleCreateOrSwitchFolder);
  preferencesForm.addEventListener('submit', handleSavePreferences);

  await refresh();

  return {
    refresh,
    getSettings: () => ({
      ...settings,
      defaultTags: [...settings.defaultTags],
      frontmatter: { ...settings.frontmatter },
    }),
    getAuthStatus: () => (authStatus ? { ...authStatus } : null),
    destroy: () => {
      tagEditor.destroy();
      signInBtn.removeEventListener('click', handleSignIn);
      signOutBtn.removeEventListener('click', handleSignOut);
      reauthBtn.removeEventListener('click', handleReauth);
      createSwitchFolderBtn.removeEventListener(
        'click',
        handleCreateOrSwitchFolder,
      );
      preferencesForm.removeEventListener('submit', handleSavePreferences);
    },
  };
}

function maybeAutoMount(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const mount = (): void => {
    const root = document.querySelector<HTMLElement>('[data-app="options"]');
    if (root && !root.dataset.mounted) {
      root.dataset.mounted = 'true';
      void mountOptions(root);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

maybeAutoMount();
