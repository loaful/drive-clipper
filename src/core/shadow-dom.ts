/**
 * Bounded-timeout Shadow DOM flattener modeled on obsidian-clipper.
 *
 * Clones a source DOM tree into a detached Document while inlining open
 * ShadowRoot subtrees and resolving `<slot>` projections, without mutating
 * the live page. Preserves live `<img>` runtime metadata (`currentSrc`,
 * `naturalWidth`, `naturalHeight`) via internal `data-clipper-*` attributes
 * on the clone so downstream image discovery remains accurate in detached DOMs.
 */

export const LIVE_IMG_ATTRS = {
  currentSrc: 'data-clipper-current-src',
  naturalWidth: 'data-clipper-natural-width',
  naturalHeight: 'data-clipper-natural-height',
} as const;

export interface FlattenShadowDomOptions {
  /** Maximum wall-clock time spent flattening before gracefully bailing out. */
  timeoutMs?: number;
  /** Maximum Shadow DOM nesting depth to prevent pathological recursion. */
  maxDepth?: number;
  /** Maximum total DOM nodes visited before truncating further shadow expansion. */
  maxNodes?: number;
  /** Clock function injected for deterministic timeout testing. */
  now?: () => number;
}

export interface FlattenShadowDomResult {
  document: Document;
  flattenedShadowRoots: number;
  timedOut: boolean;
  truncated: boolean;
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 50_000;

const SHADOW_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

interface FlattenState {
  targetDoc: Document;
  deadline: number;
  maxDepth: number;
  maxNodes: number;
  now: () => number;
  visitedNodes: number;
  flattenedShadowRoots: number;
  timedOut: boolean;
  truncated: boolean;
}

function isBudgetExceeded(state: FlattenState): boolean {
  if (state.timedOut || state.truncated) {
    return true;
  }
  if (state.visitedNodes >= state.maxNodes) {
    state.truncated = true;
    return true;
  }
  // Poll the clock every 32 nodes (and on every shadow root boundary) to keep overhead low.
  if ((state.visitedNodes & 31) === 0 && state.now() >= state.deadline) {
    state.timedOut = true;
    return true;
  }
  return false;
}

function copyLiveImageMetadata(sourceEl: Element, clonedEl: Element): void {
  if (sourceEl.tagName.toUpperCase() !== 'IMG') {
    return;
  }
  const img = sourceEl as HTMLImageElement;
  if (typeof img.currentSrc === 'string' && img.currentSrc.length > 0) {
    clonedEl.setAttribute(LIVE_IMG_ATTRS.currentSrc, img.currentSrc);
  }
  if (typeof img.naturalWidth === 'number' && img.naturalWidth > 0) {
    clonedEl.setAttribute(LIVE_IMG_ATTRS.naturalWidth, String(img.naturalWidth));
  }
  if (typeof img.naturalHeight === 'number' && img.naturalHeight > 0) {
    clonedEl.setAttribute(LIVE_IMG_ATTRS.naturalHeight, String(img.naturalHeight));
  }
}

function resolveSlotNodes(
  slotEl: Element,
  hostEl: Element,
): Node[] {
  const maybeSlot = slotEl as HTMLSlotElement;
  if (typeof maybeSlot.assignedNodes === 'function') {
    try {
      const assigned = maybeSlot.assignedNodes({ flatten: true });
      if (assigned.length > 0) {
        return assigned;
      }
    } catch {
      // Fall back to attribute-based slot matching below.
    }
  }

  const slotName = slotEl.getAttribute('name') ?? '';
  const matched: Node[] = [];
  for (const child of Array.from(hostEl.childNodes)) {
    if (child.nodeType === 1) {
      const childSlot = (child as Element).getAttribute('slot') ?? '';
      if (childSlot === slotName) {
        matched.push(child);
      }
    } else if (slotName === '' && child.nodeType === 3) {
      matched.push(child);
    }
  }

  if (matched.length > 0) {
    return matched;
  }

  return Array.from(slotEl.childNodes);
}

function cloneNodeWithShadow(
  sourceNode: Node,
  state: FlattenState,
  depth: number,
  hostForSlots: Element | null,
  insideShadow: boolean,
): Node | null {
  state.visitedNodes += 1;

  // Text, comment, CDATA nodes
  if (sourceNode.nodeType !== 1) {
    return state.targetDoc.importNode(sourceNode, false);
  }

  const sourceEl = sourceNode as Element;
  const tagName = sourceEl.tagName.toUpperCase();

  if (insideShadow && SHADOW_SKIP_TAGS.has(tagName)) {
    return null;
  }

  if (insideShadow && tagName === 'SLOT' && hostForSlots !== null) {
    const fragment = state.targetDoc.createDocumentFragment();
    const projectedNodes = resolveSlotNodes(sourceEl, hostForSlots);
    for (const projected of projectedNodes) {
      if (isBudgetExceeded(state)) {
        break;
      }
      const clonedProjected = cloneNodeWithShadow(
        projected,
        state,
        depth,
        null,
        false,
      );
      if (clonedProjected) {
        fragment.appendChild(clonedProjected);
      }
    }
    return fragment;
  }

  // If budget is already exhausted, fall back to standard DOM deep clone without further shadow expansion.
  if (isBudgetExceeded(state)) {
    const fallbackClone = state.targetDoc.importNode(sourceEl, true);
    copyLiveImageMetadata(sourceEl, fallbackClone);
    return fallbackClone;
  }

  const shadowRoot = sourceEl.shadowRoot;
  if (shadowRoot && depth < state.maxDepth) {
    if (state.now() >= state.deadline) {
      state.timedOut = true;
    } else {
      state.flattenedShadowRoots += 1;
      // Replace custom element shadow hosts (hyphenated tag names) with a neutral <div>
      // so content extractors score them normally and they cannot re-upgrade if reinserted.
      let hostClone: Element;
      if (tagName.includes('-')) {
        hostClone = state.targetDoc.createElement('div');
        hostClone.setAttribute('data-shadow-host', sourceEl.tagName.toLowerCase());
        for (const attr of Array.from(sourceEl.attributes)) {
          if (!attr.name.toLowerCase().startsWith('on')) {
            try {
              hostClone.setAttribute(attr.name, attr.value);
            } catch {
              // Ignore invalid attribute names copied from malformed markup.
            }
          }
        }
      } else {
        hostClone = state.targetDoc.importNode(sourceEl, false);
      }

      for (const shadowChild of Array.from(shadowRoot.childNodes)) {
        if (isBudgetExceeded(state)) {
          break;
        }
        const clonedChild = cloneNodeWithShadow(
          shadowChild,
          state,
          depth + 1,
          sourceEl,
          true,
        );
        if (clonedChild) {
          hostClone.appendChild(clonedChild);
        }
      }
      return hostClone;
    }
  } else if (shadowRoot && depth >= state.maxDepth) {
    state.truncated = true;
  }

  const clonedEl = state.targetDoc.importNode(sourceEl, false);
  copyLiveImageMetadata(sourceEl, clonedEl);

  for (const child of Array.from(sourceEl.childNodes)) {
    if (isBudgetExceeded(state)) {
      const remaining = state.targetDoc.importNode(child, true);
      if (child.nodeType === 1) {
        copyLiveImageMetadata(child as Element, remaining as Element);
      }
      clonedEl.appendChild(remaining);
      continue;
    }
    const clonedChild = cloneNodeWithShadow(
      child,
      state,
      depth,
      hostForSlots,
      insideShadow,
    );
    if (clonedChild) {
      clonedEl.appendChild(clonedChild);
    }
  }

  return clonedEl;
}

/**
 * Clones `sourceDoc` into a detached Document with all reachable open Shadow DOM
 * subtrees flattened into regular light DOM within a bounded time/node budget.
 */
export function flattenShadowDom(
  sourceDoc: Document,
  options: FlattenShadowDomOptions = {},
): FlattenShadowDomResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const now = options.now ?? (() => Date.now());

  const targetDoc = sourceDoc.implementation.createHTMLDocument(
    sourceDoc.title || '',
  );

  const state: FlattenState = {
    targetDoc,
    deadline: now() + timeoutMs,
    maxDepth,
    maxNodes,
    now,
    visitedNodes: 0,
    flattenedShadowRoots: 0,
    timedOut: false,
    truncated: false,
  };

  if (sourceDoc.documentElement) {
    const clonedRoot = cloneNodeWithShadow(
      sourceDoc.documentElement,
      state,
      0,
      null,
      false,
    );
    if (clonedRoot && clonedRoot.nodeType === 1) {
      targetDoc.replaceChild(clonedRoot, targetDoc.documentElement);
    }
  }

  const warnings: string[] = [];
  if (state.timedOut) {
    warnings.push(
      `Shadow DOM flattening timed out after ${timeoutMs}ms; remaining shadow trees were skipped.`,
    );
  }
  if (state.truncated) {
    warnings.push(
      'Shadow DOM flattening reached its safety depth/node limit; some nested shadow content may be omitted.',
    );
  }

  return {
    document: targetDoc,
    flattenedShadowRoots: state.flattenedShadowRoots,
    timedOut: state.timedOut,
    truncated: state.truncated,
    warnings,
  };
}
