// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAUTH_CLIENT_ID_PLACEHOLDER,
  type ClipProgressEvent,
} from '../../src/types.js';
import {
  createChromeRuntimeClient,
  formatClipTimestamp,
  isConfiguredOAuthClientId,
  isSupportedClipUrl,
  mergeTags,
  normalizeTag,
  parseTagsInput,
  removeTag,
  resolveOAuthConfigured,
} from '../../src/ui/shared.js';

describe('shared UI helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes and parses comma, semicolon, and newline separated tags', () => {
    expect(normalizeTag('  #Web Clip  ')).toBe('web-clip');
    expect(normalizeTag('Design/UI')).toBe('design/ui');
    expect(normalizeTag('机器学习')).toBe('机器学习');

    expect(
      parseTagsInput(' #Web-Clip, reading list; AI\nweb-clip, 机器学习,   '),
    ).toEqual(['web-clip', 'reading-list', 'ai', '机器学习']);
  });

  it('merges and removes tags case-insensitively without duplicates', () => {
    const merged = mergeTags(['web-clip', 'notes'], ['WEB-CLIP', '#Docs', '']);
    expect(merged).toEqual(['web-clip', 'notes', 'docs']);
    expect(removeTag(merged, 'NOTES')).toEqual(['web-clip', 'docs']);
  });

  it('detects placeholder vs configured OAuth client IDs', () => {
    expect(isConfiguredOAuthClientId(OAUTH_CLIENT_ID_PLACEHOLDER)).toBe(false);
    expect(isConfiguredOAuthClientId('YOUR_CUSTOM_PLACEHOLDER')).toBe(false);
    expect(isConfiguredOAuthClientId('   ')).toBe(false);
    expect(isConfiguredOAuthClientId(null)).toBe(false);
    expect(
      isConfiguredOAuthClientId('1234567890-abc.apps.googleusercontent.com'),
    ).toBe(true);
  });

  it('resolves OAuth configuration status with authStatus taking precedence', () => {
    expect(
      resolveOAuthConfigured({ oauthConfigured: true, authenticated: false }, false),
    ).toBe(true);
    expect(
      resolveOAuthConfigured({ oauthConfigured: false, authenticated: false }, true),
    ).toBe(false);
    expect(resolveOAuthConfigured(null, true)).toBe(true);
    expect(resolveOAuthConfigured(null, null)).toBe(false);
  });

  it('accepts only http and https URLs as clippable pages', () => {
    expect(isSupportedClipUrl('https://example.com/post')).toBe(true);
    expect(isSupportedClipUrl('http://localhost:3000/article')).toBe(true);
    expect(isSupportedClipUrl('chrome://extensions')).toBe(false);
    expect(isSupportedClipUrl('chrome-extension://abc/popup.html')).toBe(false);
    expect(isSupportedClipUrl('about:blank')).toBe(false);
    expect(isSupportedClipUrl('not-a-url')).toBe(false);
  });

  it('formats clip timestamps into relative labels or ISO dates', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(formatClipTimestamp('2026-11-24T11:59:30Z', now)).toBe('Just now');
    expect(formatClipTimestamp('2026-11-24T11:45:00Z', now)).toBe('15m ago');
    expect(formatClipTimestamp('2026-11-24T09:00:00Z', now)).toBe('3h ago');
    expect(formatClipTimestamp('2026-11-21T12:00:00Z', now)).toBe('3d ago');
    expect(formatClipTimestamp('2026-10-01T12:00:00Z', now)).toBe('2026-10-01');
    expect(formatClipTimestamp('invalid-date', now)).toBe('invalid-date');
  });

  it('handles both callback-based and Promise-based chrome.runtime.sendMessage', async () => {
    const callbackSend = vi.fn(
      (_msg: unknown, cb: (response: unknown) => void) => {
        cb({ ok: true, data: { oauthConfigured: true, authenticated: true } });
      },
    );
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: callbackSend,
        lastError: undefined,
      },
    });

    const client = createChromeRuntimeClient();
    const res1 = await client.sendMessage({ type: 'GET_AUTH_STATUS' });
    expect(res1).toEqual({
      ok: true,
      data: { oauthConfigured: true, authenticated: true },
    });

    const promiseSend = vi.fn(async () => ({
      ok: true,
      data: { oauthConfigured: false, authenticated: false },
    }));
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: promiseSend,
      },
    });

    const res2 = await client.sendMessage({ type: 'GET_AUTH_STATUS' });
    expect(res2).toEqual({
      ok: true,
      data: { oauthConfigured: false, authenticated: false },
    });
  });

  it('subscribes and unsubscribes to CLIP_PROGRESS push messages only', () => {
    const listeners: Array<(message: unknown) => void> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: (fn: (message: unknown) => void) => listeners.push(fn),
          removeListener: (fn: (message: unknown) => void) => {
            const idx = listeners.indexOf(fn);
            if (idx >= 0) listeners.splice(idx, 1);
          },
        },
      },
    });

    const received: ClipProgressEvent[] = [];
    const client = createChromeRuntimeClient();
    const unsubscribe = client.onClipProgress((event) => received.push(event));

    for (const listener of listeners) {
      listener({ type: 'UNRELATED_EVENT', payload: 1 });
      listener({
        type: 'CLIP_PROGRESS',
        event: {
          clipId: 'clip-1',
          stage: 'extracting',
          message: 'Extracting page...',
        },
      });
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.stage).toBe('extracting');

    unsubscribe();
    expect(listeners).toHaveLength(0);
  });
});
