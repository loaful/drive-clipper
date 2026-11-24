# CLAUDE.md

Drive Clipper is a Chrome Manifest V3 extension that extracts web pages into Markdown with local images and uploads them to Google Drive under an extension-owned root folder.

## Architecture and module boundaries

| Path | Ownership |
| --- | --- |
| `src/types.ts` | Shared domain models, storage keys, settings defaults, and UI/content/background message unions. |
| `src/core/shadow-dom.ts` | Bounded-timeout Shadow DOM flattening prior to article extraction. |
| `src/core/extract.ts` | Page extraction using `defuddle/full` (`parseAsync()` with timeout fallback to `parse()`), full-page and selection modes. |
| `src/core/frontmatter.ts` | YAML frontmatter generation, Unicode title slugification, and canonical `YYYY-MM-DD-<slug>` folder naming. |
| `src/core/images.ts` | DOM lazy-load image resolution, placeholder/tracking-pixel filtering, URL deduplication, and Markdown `./images/<name>` rewriting. |
| `src/content/content.ts` | Content script injected via `chrome.scripting.executeScript` to report page info and run extraction. |
| `src/background/image-fetcher.ts` | Service worker image downloader with bounded concurrency, `Content-Type` + magic-byte format detection, temporary `declarativeNetRequest` `Referer` session rules, and per-image fallback results. |
| `src/drive/drive-client.ts` | Google Drive API v3 client (`chrome.identity.getAuthToken` with automatic `launchWebAuthFlow` + `chrome.storage.session` fallback for non-Sync Chromium browsers, extension-owned root folder tracked by `rootFolderId`, `appProperties.sourceUrl` idempotency, `multipart/related` uploads with retry, images uploaded before `README.md`). |
| `src/background/service-worker.ts` | Orchestrates popup/context-menu clips, settings/history persistence, auth actions, and `CLIP_PROGRESS` broadcasts. |
| `src/ui/` | Popup UI (`popup.{html,css,ts}`), Options UI (`options.{html,css,ts}`), and shared UI runtime/tag helpers (`shared.ts`). |
| `src/icons/` | Vector source (`icon.svg`) and raster PNG extension icons (`icon16.png`, `icon48.png`, `icon128.png`). |
| `scripts/build.mjs` | esbuild bundler for the four entrypoints (injecting optional gitignored `webAuthClientId` at build time), static UI/icon copier, and `dist/manifest.json` generator with scope and remote-script checks. |
| `tests/` | Unit tests (`tests/core/`, `tests/background/`, `tests/drive/`, `tests/ui/`) and Playwright E2E suite (`tests/e2e/`). |

## Commands

```bash
npm run typecheck
npm run build
npm test
npx vitest run tests/ui
npm run test:e2e
```

`vitest.config.ts` defaults to `environment: 'node'`. Any test file touching DOM APIs must declare `// @vitest-environment jsdom` on its first line.

## Invariants

- **Single minimal OAuth scope.** `manifest.oauth2.scopes` must contain only `["https://www.googleapis.com/auth/drive.file"]`. `scripts/build.mjs` fails the build if the scope list changes. Never request broad `drive` scopes.
- **Zero committed credentials.** Real OAuth Client IDs, extension private keys, and tokens must never enter git. `src/manifest.template.json` keeps the placeholder `YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`; local overrides live in gitignored `config.local.json`.
- **No remote scripts in MV3.** `content_security_policy.extension_pages` stays `script-src 'self'; object-src 'self'`. Do not load Google Picker or any external `<script>` in `popup.html` or `options.html`; `scripts/build.mjs` rejects remote script URLs in HTML files.
- **Root folder tracked by ID.** Always persist and query the extension-owned root folder by `rootFolderId` so users can move or rename `WebClips` in Google Drive without breaking clips.
- **Upload ordering and graceful image fallback.** All downloaded images upload before `README.md` is written. Per-image download failures never abort the clip; keep the remote URL in Markdown and record a warning in YAML frontmatter.
- **Clean DNR rule lifecycle.** Every temporary `declarativeNetRequest` session rule added for anti-hotlink `Referer` headers must be removed in a `finally` block using unique rule IDs.
- **Single source of truth for folder slugs.** UI folder previews import `buildArticleFolderName` from `src/core/frontmatter.ts` instead of duplicating slugification logic.
