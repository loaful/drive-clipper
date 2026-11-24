import { extractPage, getPageInfo } from '../core/extract.js';
import type { ContentRequestMessage, ContentResponseMessage } from '../types.js';

const LISTENER_SENTINEL = '__driveClipperContentScriptRegistered__';

function isContentRequestMessage(value: unknown): value is ContentRequestMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === 'CONTENT_GET_PAGE_INFO' || type === 'CONTENT_EXTRACT_PAGE';
}

/**
 * Handles extraction and page-info messages from the background service worker.
 */
export async function handleContentMessage(
  message: ContentRequestMessage,
  doc: Document = document,
  url: string = globalThis.location?.href ?? doc.URL,
): Promise<ContentResponseMessage> {
  try {
    if (message.type === 'CONTENT_GET_PAGE_INFO') {
      const info = getPageInfo(doc, url);
      return { ok: true, type: 'CONTENT_PAGE_INFO', data: info };
    }

    if (message.type === 'CONTENT_EXTRACT_PAGE') {
      const extracted = await extractPage(doc, url, { mode: message.mode });
      return { ok: true, type: 'CONTENT_EXTRACTED_PAGE', data: extracted };
    }

    return { ok: false, error: 'Unsupported content script message.' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: reason };
  }
}

function registerContentListener(): void {
  const scope = globalThis as Record<string, unknown>;
  if (scope[LISTENER_SENTINEL]) {
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }

  scope[LISTENER_SENTINEL] = true;

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ContentResponseMessage) => void,
    ): boolean | undefined => {
      if (!isContentRequestMessage(message)) {
        return undefined;
      }

      void handleContentMessage(message).then(sendResponse, (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: reason });
      });

      return true;
    },
  );
}

registerContentListener();
