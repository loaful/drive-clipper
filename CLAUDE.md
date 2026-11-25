# CLAUDE.md

OKF Clipper for Google Drive (`drive-clipper`) is a Chrome Manifest V3 extension that extracts web pages into Open Knowledge Format (OKF v0.2) Markdown bundles with local images and uploads them to Google Drive under an extension-owned root folder.

## Architecture and module boundaries

| Path | Ownership |
| --- | --- |
| `src/manifest.template.json` | MV3 manifest template (`OKF Clipper for Google Drive`, `short_name: "OKF Clipper"`, placeholder OAuth Client ID, single `drive.file` scope, strict `script-src 'self'; object-src 'self'` CSP). |
| `src/types.ts` | Shared domain models (`ExtensionSettings` including `stickyTags: string[] \| null` and `customWebAuthClientId: string \| null`, `AuthMode`, `AuthStatus` with optional `authMode`/`usingCustomClientId`, `ClipResult`/`ClipHistoryItem` with `fileName`/`articleFileName`/`articleFileId`), storage keys, settings defaults, and UI/content/background message unions. |
| `src/core/shadow-dom.ts` | Bounded-timeout Shadow DOM flattening prior to article extraction. |
| `src/core/extract.ts` | Page extraction using `defuddle/full` (`parseAsync()` with timeout fallback to `parse()`), X.com media supplementation via `src/core/x-media.ts`, title cleanup via `cleanPageTitle()`, plain-text `description` excerpt fallback via `extractPlainTextExcerpt()`, full-page and selection modes. |
| `src/core/x-media.ts` | X.com / Twitter post media extraction and normalization (`pbs.twimg.com/media/` high-res `name=large`, empty/missing `alt`, CSS `background-image` fallbacks, video posters, card images, self-thread & quoted tweets) with strict avatar/emoji/reply exclusion and Markdown deduplication. |
| `src/core/frontmatter.ts` | OKF v0.2 YAML frontmatter generation (`type: "web-clip"`, `description`, `status: "raw"`, `generated`, `sources`, plus top-level compatibility fields), `cleanPageTitle()` (unread prefixes, trailing site suffixes, X/Twitter wrappers, `t.co` URLs), `deriveSourceSlug()`, `buildArticleFolderName()` (`YYYY-MM-DD-<source>-<slug>`), `buildArticleFileName()` (`<folderName>.md`), `extractPlainTextExcerpt()`, and deterministic root `index.md` / `log.md` builders (`upsertRootIndexMarkdown`, `appendClipLogMarkdown`). |
| `src/core/images.ts` | DOM lazy-load image resolution, placeholder/tracking-pixel filtering, URL deduplication, and Markdown `./images/<name>` rewriting. |
| `src/content/content.ts` | Content script injected via `chrome.scripting.executeScript` to report page info and run extraction. |
| `src/background/image-fetcher.ts` | Service worker image downloader with bounded concurrency, `Content-Type` + magic-byte format detection, shift-proof pre-allocated filename stems, per-URL temporary `declarativeNetRequest` `Referer` session rules (with non-colliding rule IDs and startup orphan cleanup), and per-image fallback results. |
| `src/drive/drive-client.ts` | Google Drive API v3 client (`chrome.identity.getAuthToken` with automatic `launchWebAuthFlow` + `chrome.storage.session` fallback for non-Sync Chromium browsers, runtime `customWebAuthClientId` bypass directly to `launchWebAuthFlow` with per-client session token isolation, extension-owned root folder tracked by `rootFolderId`, `appProperties.sourceUrl` + `appProperties.imageUrl` + `appProperties.driveClipperRole` idempotency, `uploadType=multipart` up to 4.5 MiB and automatic `uploadType=resumable` above 4.5 MiB with retry, graceful per-image upload fallback, images uploaded before `<folderName>.md` with legacy `README.md` in-place rename on re-clip, and `updateBundleIndexAndLog()` for root `index.md` and `log.md`). |
| `src/background/service-worker.ts` | Orchestrates popup/context-menu clips via a bounded background job queue (`maxConcurrentJobs = 2`, persisted in `chrome.storage.session` under `clipJobs` with SW-restart orphan recovery), 15s MV3 keepalive heartbeat while active jobs run, single-flight `ensureRootFolder`, serialized `indexWriteChain` mutex for non-fatal root `index.md` / `log.md` updates, unified toolbar icon badge (blue count / green `OK` / red `!`), settings (preserving `stickyTags` `null` vs `[]` vs `string[]`, normalizing `customWebAuthClientId` and evicting cached auth tokens + root folder cache when it changes) and history persistence, auth actions, and `CLIP_JOBS_UPDATED` / `CLIP_PROGRESS` broadcasts. |
| `src/ui/` | Popup UI (`popup.{html,css,ts}` branded `OKF Clipper`, consumer-first `Connect Google Drive` welcome card hiding the clip form until signed in, developer unconfigured setup card, sticky tag persistence via `stickyTags`, live `<rootFolder>/<folderName>/<folderName>.md` preview + full-path tooltip, unified multi-tab `Clip queue` process list, and duplicate-active-URL guard), Options UI (`options.{html,css,ts}` branded `OKF Clipper Settings`, plain-English everyday Account / Save Folder / Tags & Frontmatter cards, and collapsible `<details id="advanced-section">` `Advanced & Self-hosting` drawer auto-opened only when unconfigured with runtime BYO `customWebAuthClientId` input + OAuth diagnostics), and shared UI runtime/tag helpers (`shared.ts`). |
| `src/icons/` | Vector source (`icon.svg`) and raster PNG extension icons (`icon16.png`, `icon48.png`, `icon128.png`). |
| `scripts/build.mjs` | esbuild bundler for the four entrypoints (injecting optional gitignored `webAuthClientId` at build time), static UI/icon copier, and `manifest.json` generator with scope and remote-script checks. Supports `--out-dir <dir>`, `--store` (omits `"key"`, disables inline sourcemaps, rejects placeholder `oauthClientId`), and `--allow-placeholder`. |
| `scripts/pack-store.mjs` | Store release packager (`npm run pack:store`): builds with `--store` into a temporary staging dir without modifying local `dist/`, validates MV3 / no `"key"` / exact `drive.file` scope / CSP / no remote scripts / no secret files, and zips into `release/okf-clipper-store-v<version>.zip` (`--allow-placeholder`, `--out <zip>` supported). |
| `tests/` | Unit tests (`tests/core/`, `tests/background/`, `tests/drive/`, `tests/ui/`) and Playwright E2E suite (`tests/e2e/`). |
| `PRIVACY.md`, `STORE_LISTING.md` | Chrome Web Store privacy policy (`drive.file`, zero servers/telemetry, Limited Use) and Store listing/permission justification/zero-billing GCP publishing playbook. |

## Commands

```bash
npm run typecheck
npm run build
npm run pack:store
npm test
npx vitest run tests/ui
npm run test:e2e
```

`vitest.config.ts` defaults to `environment: 'node'`. Any test file touching DOM APIs must declare `// @vitest-environment jsdom` on its first line.

## Invariants

- **Single minimal OAuth scope.** `manifest.oauth2.scopes` must contain only `["https://www.googleapis.com/auth/drive.file"]`. Both `scripts/build.mjs` and `scripts/pack-store.mjs` fail if the scope list changes. Never request broad `drive` scopes.
- **Zero committed credentials.** Real OAuth Client IDs, extension private keys, and tokens must never enter git. `src/manifest.template.json` keeps the placeholder `YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`; local overrides live in gitignored `config.local.json`.
- **Store vs. local manifest `"key"` separation.** Local `npm run build` preserves `manifestKey` as `"key"` in `dist/manifest.json` for deterministic unpacked dev IDs, while `scripts/build.mjs --store` and `npm run pack:store` strip `"key"` in a separate staging directory so Chrome Web Store uploads never fail and local `dist/` stays intact.
- **Runtime BYO custom OAuth isolation.** Setting `ExtensionSettings.customWebAuthClientId` bypasses `chrome.identity.getAuthToken()` and routes directly through `chrome.identity.launchWebAuthFlow()` with per-client cached session tokens; changing or clearing `customWebAuthClientId` in `UPDATE_SETTINGS` immediately evicts cached auth tokens and cached root folder info.
- **No remote scripts in MV3.** `content_security_policy.extension_pages` stays `script-src 'self'; object-src 'self'`. Do not load Google Picker or any external `<script>` in `popup.html` or `options.html`; `scripts/build.mjs` and `scripts/pack-store.mjs` reject remote script URLs in HTML files.
- **Root folder tracked by ID.** Always persist and query the extension-owned root folder by `rootFolderId` so users can move or rename `WebClips` in Google Drive without breaking clips.
- **Upload ordering and graceful image fallback.** All downloaded images upload before `<folderName>.md` is written (using `uploadType=multipart` for `<= 4.5 MiB` and `uploadType=resumable` above `4.5 MiB`, with shift-proof filenames and `appProperties.imageUrl` dedup on re-clip). Per-image download or upload failures (other than cancellation or 401 auth errors) never abort `<folderName>.md`; keep the remote URL in Markdown and record a warning in YAML frontmatter.
- **Serialized OKF v0.2 bundle root index & log.** Root `index.md` (`okf_version: "0.2"`) and lowercase `log.md` (no frontmatter) updates run through `indexWriteChain` so concurrent multi-tab clips never lose entries; transient Drive index errors log a warning and attach to `result.warnings` without failing the uploaded article.
- **Clean DNR rule lifecycle.** Every temporary `declarativeNetRequest` session rule added for anti-hotlink `Referer` headers must use unique non-colliding IDs scoped per URL, be removed in a `finally` block, and sweep any orphaned SW rules on startup.
- **Single source of truth for title cleanup and folder/file naming.** Extraction, Drive upload, and UI previews import `cleanPageTitle`, `buildArticleFolderName`, and `buildArticleFileName` from `src/core/frontmatter.ts` instead of duplicating regex or slugification logic.
- **Non-blocking multi-tab queue safety.** `START_CLIP` runs fast extraction while the tab is open, persists `ClipJob` state in `chrome.storage.session` (`clipJobs`, capped at 20), bounds background download/upload concurrency (`maxConcurrentJobs = 2`), maintains a 15s MV3 service-worker keepalive heartbeat strictly while active jobs run, deduplicates concurrent `ensureRootFolder()` calls via single-flight promises, and marks orphaned active jobs as errors after a service worker restart.
