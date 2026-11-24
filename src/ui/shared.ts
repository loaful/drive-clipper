import {
  getBuildWebAuthClientId,
  isConfiguredOAuthClientIdValue,
  normalizeWebAuthRedirectUri,
  type AuthStatus,
  type BackgroundPushMessage,
  type BackgroundResponse,
  type ClipJob,
  type ClipProgressEvent,
  type UiMessageResponseMap,
  type UiToBackgroundMessage,
} from '../types.js';

export interface ExtensionIdentityInfo {
  extensionId: string | null;
  redirectUri: string | null;
}

export interface UiRuntimeClient {
  sendMessage<K extends UiToBackgroundMessage['type']>(
    message: Extract<UiToBackgroundMessage, { type: K }>,
  ): Promise<BackgroundResponse<UiMessageResponseMap[K]>>;
  onClipProgress(listener: (event: ClipProgressEvent) => void): () => void;
  onClipJobsUpdated(listener: (jobs: ClipJob[]) => void): () => void;
  openOptionsPage(): void;
  getManifestOAuthConfigured(): boolean | null;
  getExtensionIdentityInfo?: () => ExtensionIdentityInfo;
}

const TAG_SPLIT_RE = /[,;\r\n]+/;
const INVALID_TAG_CHARS_RE = /[^\p{L}\p{N}_/-]+/gu;

export function isConfiguredOAuthClientId(clientId: unknown): boolean {
  return isConfiguredOAuthClientIdValue(clientId);
}

export function resolveOAuthConfigured(
  authStatus: AuthStatus | null,
  manifestFlag: boolean | null,
): boolean {
  if (authStatus !== null) {
    return authStatus.oauthConfigured;
  }
  if (manifestFlag !== null) {
    return manifestFlag;
  }
  return false;
}

export function isSupportedClipUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeTag(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(INVALID_TAG_CHARS_RE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
  return cleaned;
}

export function parseTagsInput(raw: string): string[] {
  if (raw.trim().length === 0) {
    return [];
  }
  return mergeTags([], raw.split(TAG_SPLIT_RE));
}

export function mergeTags(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const source of [existing, incoming]) {
    for (const raw of source) {
      const normalized = normalizeTag(raw);
      if (normalized.length === 0 || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function removeTag(
  existing: readonly string[],
  tagToRemove: string,
): string[] {
  const target = normalizeTag(tagToRemove);
  return existing.filter((tag) => normalizeTag(tag) !== target);
}

export function formatClipTimestamp(
  isoString: string,
  now: Date = new Date(),
): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }

  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) {
    return date.toISOString().slice(0, 10);
  }

  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) {
    return 'Just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return date.toISOString().slice(0, 10);
}

export interface TagEditorOptions {
  container: HTMLElement;
  input: HTMLInputElement;
  initialTags?: readonly string[];
  onChange?: (tags: string[]) => void;
}

export interface TagEditorController {
  getTags(): string[];
  setTags(tags: readonly string[]): void;
  commitPendingInput(): string[];
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

export function createTagEditor(options: TagEditorOptions): TagEditorController {
  const { container, input, onChange } = options;
  let tags = mergeTags([], options.initialTags ?? []);
  let disabled = false;

  const render = (): void => {
    const existingChips = container.querySelectorAll('.tag-chip');
    existingChips.forEach((chip) => chip.remove());

    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.tag = tag;

      const label = document.createElement('span');
      label.className = 'tag-chip-label';
      label.textContent = tag;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tag-chip-remove';
      removeBtn.dataset.removeTag = tag;
      removeBtn.setAttribute('aria-label', `Remove tag ${tag}`);
      removeBtn.textContent = '×';
      removeBtn.disabled = disabled;

      chip.append(label, removeBtn);
      container.insertBefore(chip, input);
    }

    input.disabled = disabled;
    input.placeholder = tags.length === 0 ? 'Add tags (comma or Enter)...' : 'Add tag...';
  };

  const notifyChange = (): void => {
    onChange?.([...tags]);
  };

  const commitPendingInput = (): string[] => {
    const parsed = parseTagsInput(input.value);
    input.value = '';
    if (parsed.length > 0) {
      const next = mergeTags(tags, parsed);
      const changed = next.length !== tags.length;
      tags = next;
      render();
      if (changed) {
        notifyChange();
      }
    }
    return [...tags];
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (disabled) {
      return;
    }

    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitPendingInput();
      return;
    }

    if (event.key === 'Tab' && input.value.trim().length > 0) {
      event.preventDefault();
      commitPendingInput();
      return;
    }

    if (event.key === 'Backspace' && input.value.length === 0 && tags.length > 0) {
      event.preventDefault();
      tags = tags.slice(0, -1);
      render();
      notifyChange();
    }
  };

  const handleBlur = (): void => {
    if (!disabled && input.value.trim().length > 0) {
      commitPendingInput();
    }
  };

  const handlePaste = (event: ClipboardEvent): void => {
    if (disabled) {
      return;
    }
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (TAG_SPLIT_RE.test(pasted)) {
      event.preventDefault();
      const parsed = parseTagsInput(`${input.value},${pasted}`);
      input.value = '';
      if (parsed.length > 0) {
        const next = mergeTags(tags, parsed);
        const changed = next.length !== tags.length;
        tags = next;
        render();
        if (changed) {
          notifyChange();
        }
      }
    }
  };

  const handleContainerClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const removeBtn = target?.closest<HTMLButtonElement>('[data-remove-tag]');
    if (removeBtn) {
      if (disabled) {
        return;
      }
      const tagToRemove = removeBtn.dataset.removeTag;
      if (tagToRemove) {
        tags = removeTag(tags, tagToRemove);
        render();
        notifyChange();
      }
      input.focus();
      return;
    }

    if (!disabled && event.target === container) {
      input.focus();
    }
  };

  input.addEventListener('keydown', handleKeyDown);
  input.addEventListener('blur', handleBlur);
  input.addEventListener('paste', handlePaste);
  container.addEventListener('click', handleContainerClick);

  render();

  return {
    getTags: () => [...tags],
    setTags: (nextTags: readonly string[]) => {
      tags = mergeTags([], nextTags);
      render();
    },
    commitPendingInput,
    setDisabled: (nextDisabled: boolean) => {
      disabled = nextDisabled;
      render();
    },
    destroy: () => {
      input.removeEventListener('keydown', handleKeyDown);
      input.removeEventListener('blur', handleBlur);
      input.removeEventListener('paste', handlePaste);
      container.removeEventListener('click', handleContainerClick);
    },
  };
}

function isClipProgressPushMessage(
  value: unknown,
): value is Extract<BackgroundPushMessage, { type: 'CLIP_PROGRESS' }> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'CLIP_PROGRESS' &&
    Boolean(candidate.event) &&
    typeof candidate.event === 'object'
  );
}

function isClipJobsUpdatedPushMessage(
  value: unknown,
): value is Extract<BackgroundPushMessage, { type: 'CLIP_JOBS_UPDATED' }> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'CLIP_JOBS_UPDATED' && Array.isArray(candidate.jobs);
}

export function createChromeRuntimeClient(): UiRuntimeClient {
  return {
    sendMessage<K extends UiToBackgroundMessage['type']>(
      message: Extract<UiToBackgroundMessage, { type: K }>,
    ): Promise<BackgroundResponse<UiMessageResponseMap[K]>> {
      return new Promise((resolve) => {
        const runtime = globalThis.chrome?.runtime;
        if (!runtime?.sendMessage) {
          resolve({
            ok: false,
            error: 'Chrome extension runtime is unavailable in this context.',
          });
          return;
        }

        let settled = false;
        const finish = (response: BackgroundResponse<UiMessageResponseMap[K]>) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(response);
        };

        try {
          const maybePromise = (
            runtime.sendMessage as (
              msg: unknown,
              cb: (res?: unknown) => void,
            ) => unknown
          )(message, (response) => {
            const lastError = runtime.lastError;
            if (lastError) {
              finish({
                ok: false,
                error: lastError.message || 'Extension messaging failed.',
              });
              return;
            }
            if (!response || typeof response !== 'object') {
              finish({
                ok: false,
                error: 'No response from the background service worker.',
              });
              return;
            }
            finish(response as BackgroundResponse<UiMessageResponseMap[K]>);
          });

          if (
            maybePromise &&
            typeof (maybePromise as Promise<unknown>).then === 'function'
          ) {
            (maybePromise as Promise<unknown>).then(
              (response) => {
                if (!response || typeof response !== 'object') {
                  finish({
                    ok: false,
                    error: 'No response from the background service worker.',
                  });
                  return;
                }
                finish(response as BackgroundResponse<UiMessageResponseMap[K]>);
              },
              (err: unknown) => {
                finish({
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              },
            );
          }
        } catch (err) {
          finish({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },

    onClipProgress(listener: (event: ClipProgressEvent) => void): () => void {
      const onMessage = globalThis.chrome?.runtime?.onMessage;
      if (!onMessage?.addListener) {
        return () => undefined;
      }

      const handler = (message: unknown): void => {
        if (isClipProgressPushMessage(message)) {
          listener(message.event);
        }
      };

      onMessage.addListener(handler);
      return () => {
        onMessage.removeListener?.(handler);
      };
    },

    onClipJobsUpdated(listener: (jobs: ClipJob[]) => void): () => void {
      const onMessage = globalThis.chrome?.runtime?.onMessage;
      if (!onMessage?.addListener) {
        return () => undefined;
      }

      const handler = (message: unknown): void => {
        if (isClipJobsUpdatedPushMessage(message)) {
          listener(message.jobs);
        }
      };

      onMessage.addListener(handler);
      return () => {
        onMessage.removeListener?.(handler);
      };
    },

    openOptionsPage(): void {
      const runtime = globalThis.chrome?.runtime;
      if (runtime?.openOptionsPage) {
        runtime.openOptionsPage();
        return;
      }
      if (typeof window !== 'undefined') {
        window.open('options.html', '_blank', 'noopener,noreferrer');
      }
    },

    getManifestOAuthConfigured(): boolean | null {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.getManifest) {
        return null;
      }
      try {
        const manifest = runtime.getManifest();
        return (
          isConfiguredOAuthClientId(manifest.oauth2?.client_id) ||
          getBuildWebAuthClientId() !== null
        );
      } catch {
        return null;
      }
    },

    getExtensionIdentityInfo(): ExtensionIdentityInfo {
      const runtime = globalThis.chrome?.runtime;
      const identity = globalThis.chrome?.identity;
      const extensionId =
        typeof runtime?.id === 'string' && runtime.id.trim().length > 0
          ? runtime.id.trim()
          : null;
      let redirectUri: string | null = null;
      if (typeof identity?.getRedirectURL === 'function') {
        try {
          const url = identity.getRedirectURL();
          if (typeof url === 'string' && url.trim().length > 0) {
            redirectUri = normalizeWebAuthRedirectUri(url);
          }
        } catch {
          redirectUri = null;
        }
      }
      return { extensionId, redirectUri };
    },
  };
}
