# OKF Clipper for Google Drive

OKF Clipper for Google Drive is a Chrome Manifest V3 extension that extracts web pages into agent-friendly Open Knowledge Format (OKF v0.2) Markdown bundles with local images and uploads them directly from your browser to Google Drive.

No developer backend servers, analytics, or tracking exist. The extension requests only the minimal `drive.file` permission, so it can access only the `WebClips` folder and clips it creates.

## Quick start (10-second onboarding)

1. Install **OKF Clipper for Google Drive** (from the Chrome Web Store, or by loading a local build).
2. Click the **OKF Clipper** icon in the Chrome toolbar.
3. Click **Connect Google Drive** and approve access to files created by this extension.
4. Click **Clip to Google Drive** on any article or web page.

Your clip is saved into `WebClips/YYYY-MM-DD-<source>-<slug>/` inside Google Drive with local images, YAML frontmatter, and an automatically updated `index.md` and `log.md`.

## Key features

- **Multi-tab background queue:** Clicking **Clip to Google Drive** runs fast page extraction while the tab is open, queues image download and Drive upload in the background (up to 2 concurrent jobs), keeps the MV3 service worker alive with a 15-second heartbeat until the queue finishes, and lets you switch tabs or close the popup immediately.
- **Unified Clip queue & toolbar badge:** Reopening the popup from any tab restores live progress from `chrome.storage.session` (`clipJobs`), showing `Queued`, `Extracting...`, `Downloading`, `Uploading`, and `Saved` with `Open ↗` links, collapsible warnings, single-job dismiss, and `Clear done`. The toolbar badge shows the active job count in blue, a brief green `OK` when finished cleanly, or a red `!` if an undismissed clip failed.
- **Automatic title & slug cleanup:** Default page titles strip leading notification counters such as Zhihu `(20 封私信 / 17 条消息) ...`, `(3) ...`, `(99+) ...`, and `[12] ...`, trailing site brand suffixes (`- 知乎`, `- 知乎专栏`, `/ X`, `/ Twitter`, `| Medium`), X/Twitter wrappers (`<name> on X: "..."`), and inline `https://t.co/...` links before generating the title, folder name, and `<folderName>.md` filename. Legitimate prefixes like `(2026) Annual Report` and `(Part 1) Guide` as well as manual popup edits stay untouched.
- **Sticky Popup tags:** On first use, the popup seeds tags from Settings (`defaultTags`, default `['web-clip']`). Adding or removing tags persists `stickyTags` in `chrome.storage.sync` immediately so future popup opens remember your last-used tags, including clearing all tags to `[]`.
- **Full page, selection & X.com media:** Clip full pages via `defuddle/full` (including Shadow DOM content and dedicated X.com post/thread media extraction), or clip selected text from the popup toggle or the right-click **Clip selection to Google Drive** context menu.

## Output folder structure (OKF v0.2)

Each clip creates a dated, source-prefixed subfolder inside your save folder (default `WebClips`) and updates root `index.md` and `log.md`:

```text
WebClips/
├── index.md
├── log.md
└── 2026-11-24-example-how-v8-compiles-javascript/
    ├── 2026-11-24-example-how-v8-compiles-javascript.md
    └── images/
        ├── 01-pipeline.webp
        └── 02-benchmark.png
```

- **Article Markdown (`<folderName>/<folderName>.md`):** Named after its folder so OpenKnowledge (`ok`), Obsidian quick-switcher, Google Drive search, and agent glob tools see readable basenames. Starts with OKF v0.2 YAML frontmatter (`type: "web-clip"`, `title`, `description` with a plain-text excerpt fallback, `status: "raw"`, `tags`, `generated: { by: "drive-clipper", at }`, `sources: [{ url, site, author, published }]`) plus top-level compatibility fields (`url`, `author`, `published`, `clipped`, `site`, `images`, and optional `warnings`).
- **Auto-maintained `WebClips/index.md`:** Starts with OKF v0.2 bundle root frontmatter (`okf_version: "0.2"`) and keeps a newest-first `## Clips` catalog keyed by `<!-- clip-source: <url> -->` so re-clipping updates entries in place without duplicates. Root index and log writes serialize through an async mutex (`indexWriteChain`).
- **Auto-maintained `WebClips/log.md`:** Lowercase append-only chronological clip log (`# Clip Log`, no frontmatter per OKF v0.2) linking to `./<folderName>/<folderName>.md`.

Images keep their original format (detected from `Content-Type` and magic bytes) and upload before `<folderName>.md`, using `uploadType=multipart` up to 4.5 MiB and switching automatically to `uploadType=resumable` for larger files. If an individual image fails to download or upload, `<folderName>.md` still uploads with that image's remote URL preserved and a warning recorded in frontmatter. Re-clipping the same URL reuses the existing folder by `appProperties.sourceUrl`, updates images in place using shift-proof filenames and `appProperties.imageUrl` matching, and refreshes `<folderName>.md`, `index.md`, and `log.md`.

## Privacy & why `WebClips` is created by the extension

OKF Clipper requests only `https://www.googleapis.com/auth/drive.file`. Under this scope, the extension cannot list, read, or modify arbitrary files already in your Google Drive; it can access only folders and files it created.

On first clip (or when you click **Create / Switch Folder** in Settings), the extension creates `WebClips` (configurable) and stores its Google Drive folder ID (`rootFolderId`) in `chrome.storage.sync`. Because all queries and uploads target that `rootFolderId`, you can move or rename `WebClips` anywhere in Google Drive without breaking future clips. If you delete or trash that folder, OKF Clipper detects the missing folder and creates a fresh one automatically.

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy.

## Bring your own Google Cloud OAuth Client (no rebuild required)

Power users and self-hosters who prefer to route OAuth through their own free, unbilled Google Cloud project can configure a Custom Web OAuth Client ID directly at runtime:

1. Open **OKF Clipper Settings** and expand **Advanced & Self-hosting** at the bottom.
2. Copy the **OAuth Redirect URI** shown under Technical diagnostics (`https://<extension-id>.chromiumapp.org`).
3. In your own Google Cloud project (no billing account required), enable **Google Drive API**, configure the OAuth consent screen with scope `https://www.googleapis.com/auth/drive.file`, and create a **Web application** OAuth Client ID with that Redirect URI.
4. Paste the Client ID (`*.apps.googleusercontent.com`, never a client secret) into **Custom Web OAuth Client ID** and click **Save custom client**.
5. Click **Connect Google Drive** at the top of Settings.

When a custom Client ID is set, OKF Clipper bypasses Chrome's built-in `getAuthToken()` and authenticates directly through `chrome.identity.launchWebAuthFlow()` using your project. Click **Use built-in** at any time to clear it and revert to the extension's default OAuth client (switching automatically clears cached auth tokens).

## Self-hosting & local development builds

The repository ships with a placeholder OAuth Client ID in `src/manifest.template.json` so no credentials enter git. Local build credentials live in gitignored `config.local.json`.

### Local OAuth setup (`config.local.json`)

1. Install dependencies and copy the template:

   ```bash
   npm install
   cp config.local.example.json config.local.json
   ```

2. Pin a deterministic Extension ID with `manifestKey` (recommended, see below) or load `dist/` once to inspect your Extension ID.

3. In [Google Cloud Console](https://console.cloud.google.com/) (no billing account needed):
   - Create or select a project and enable **Google Drive API**.
   - Configure the OAuth consent screen with the single scope `https://www.googleapis.com/auth/drive.file` (add yourself as a Test User if kept in `Testing`).
   - Create one or both OAuth Client IDs (never store any `client_secret`):
     - **Chrome Extension** (`oauthClientId`): set Item ID to your 32-character Extension ID for Chrome's native `chrome.identity.getAuthToken()`.
     - **Web application** (`webAuthClientId`): add Authorized redirect URI `https://<extension-id>.chromiumapp.org` (no trailing slash) for Chromium browsers without Chrome Sync (Ego Lite, Brave, Arc, Dia, Edge).

4. Populate `config.local.json`:

   ```json
   {
     "oauthClientId": "1234567890-chromeext.apps.googleusercontent.com",
     "webAuthClientId": "1234567890-webapp.apps.googleusercontent.com",
     "manifestKey": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
   }
   ```

5. Build and load unpacked:

   ```bash
   npm run build
   ```

   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `dist/`.

### Pinning a deterministic Extension ID with `manifestKey`

Chrome derives an unpacked extension's ID from its directory path unless `manifest.json` contains a `"key"` field. Generate a local RSA keypair outside the repo (never commit the `.pem` file), extract the base64 public key for `manifestKey`, and compute the deterministic Extension ID:

```bash
# 1. Generate a private key outside the repository
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out ~/.config/drive-clipper-key.pem

# 2. Print the single-line base64 public key (paste into config.local.json -> "manifestKey")
openssl rsa -in ~/.config/drive-clipper-key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A; echo

# 3. Compute the exact 32-character Chrome Extension ID
openssl rsa -in ~/.config/drive-clipper-key.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 \
  | xxd -p -c 16 \
  | tr '0-9a-f' 'a-p'; echo
```

Local `npm run build` writes `manifestKey` into `dist/manifest.json` as `"key"`. Chrome Web Store packaging (`npm run pack:store`) builds into a temporary staging directory with `--store`, strips `"key"`, validates the archive, and writes `release/okf-clipper-store-v<version>.zip` without touching local `dist/`.

See [STORE_LISTING.md](./STORE_LISTING.md) for the complete Chrome Web Store publishing checklist and copy-paste listing/privacy answers.

### Development commands

```bash
# Type-check all source and test files
npm run typecheck

# Bundle local unpacked dist/ (keeps manifestKey for deterministic dev ID)
npm run build

# Build and validate Chrome Web Store upload zip under release/ (omits "key")
npm run pack:store

# Run all Vitest unit tests (core, background, drive, ui)
npm test

# Run Vitest in watch mode
npm run test:watch

# Run Playwright real-browser E2E tests against built dist/ artifacts
npm run test:e2e
```
