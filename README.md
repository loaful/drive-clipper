# Drive Clipper

Drive Clipper is a Chrome Manifest V3 extension that extracts web pages into Markdown with local images and uploads each clip to Google Drive. It uses `defuddle/full` for article extraction, downloads page images in the background service worker, rewrites image links to relative paths, and authenticates through `chrome.identity` with the minimal `drive.file` OAuth scope.

## Output folder structure

Each clip creates a dated subfolder inside your Drive Clipper root folder (default `WebClips`):

```text
WebClips/
└── 2026-11-24-how-v8-compiles-javascript/
    ├── README.md
    └── images/
        ├── 01-pipeline.webp
        └── 02-benchmark.png
```

`README.md` starts with YAML frontmatter (`title`, `url`, `author`, `published`, `clipped`, `site`, `tags`, `images`, and optional `warnings`) followed by the extracted Markdown body. All downloaded images keep their original format (sniffed from `Content-Type` and magic bytes) and upload before `README.md`.

If an individual image fails to download, the clip still completes. The Markdown keeps the original remote URL for that image and appends a warning to frontmatter. Re-clipping the same URL reuses the existing folder by matching `appProperties.sourceUrl` instead of creating duplicates.

## Five-minute Google Cloud OAuth setup

The repository ships with a placeholder OAuth Client ID in `src/manifest.template.json` so no credentials enter git. Local values live in `config.local.json`, which is gitignored and merged into `dist/manifest.json` during `npm run build`.

1. Install dependencies and copy the local config template:

   ```bash
   npm install
   cp config.local.example.json config.local.json
   ```

2. Generate a pinned extension key (recommended, see the next section) or load `dist/` once to obtain a Chrome Extension ID.

3. In [Google Cloud Console](https://console.cloud.google.com/):
   - Create or select a project.
   - Enable the **Google Drive API** (`APIs & Services` > `Library` > `Google Drive API` > `Enable`).
   - Configure the **OAuth consent screen** (`Google Auth Platform` > `Branding` / `Audience`). Add your Google account as a Test User while the app is in Testing status, and add the single scope `https://www.googleapis.com/auth/drive.file`.
   - Create one or both OAuth Client IDs (`Clients` > `Create Client`) — never copy or store any `client_secret`:
     - **Chrome Extension client** (`oauthClientId` in `config.local.json`, for Google Chrome with Chrome Sync signed in):
       - Application type: **Chrome Extension**
       - Item ID: your 32-character Chrome Extension ID
       - Used by Chrome's native `chrome.identity.getAuthToken()`.
     - **Web application client** (`webAuthClientId` in `config.local.json`, for Chromium browsers without Chrome Sync such as Ego Lite, Brave, Arc, Dia, or Edge):
       - Application type: **Web application**
       - Authorized redirect URIs: `https://<your-32-character-extension-id>.chromiumapp.org` (no trailing slash; also displayed inside Drive Clipper's Options page)
       - Used automatically by `chrome.identity.launchWebAuthFlow()` when browser sign-in is disabled (caching the short-lived token in `chrome.storage.session`). If you configure only a Web application client, you may put it in either `webAuthClientId` or `oauthClientId`.

4. Put your Client ID(s) into `config.local.json`:

   ```json
   {
     "oauthClientId": "1234567890-chromeext.apps.googleusercontent.com",
     "webAuthClientId": "1234567890-webapp.apps.googleusercontent.com",
     "manifestKey": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
   }
   ```

   Setting both `oauthClientId` and `webAuthClientId` lets a single `dist/` build authenticate natively in official Google Chrome (`getAuthToken`) and seamlessly fall back to `launchWebAuthFlow` in Ego Lite / non-Sync Chromium.

5. Build the extension and load it in Chrome:

   ```bash
   npm run build
   ```

   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `dist/` directory.

## Pinning a deterministic extension ID with `manifestKey`

Chrome derives an unpacked extension's ID from the directory path unless `manifest.json` contains a `"key"` field. Without `"key"`, moving the repo or cloning on another machine changes the Extension ID and breaks OAuth token exchange with Google Cloud.

Generate a local RSA keypair outside the repo (never commit the `.pem` file), extract the base64 public key for `manifestKey`, and compute the deterministic Extension ID up front:

```bash
# 1. Generate a private key outside the repository
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out ~/.config/drive-clipper-key.pem

# 2. Print the single-line base64 public key (paste into config.local.json -> "manifestKey")
openssl rsa -in ~/.config/drive-clipper-key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A; echo

# 3. Compute the exact 32-character Chrome Extension ID (paste into Google Cloud OAuth Client ID)
openssl rsa -in ~/.config/drive-clipper-key.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 \
  | xxd -p -c 16 \
  | tr '0-9a-f' 'a-p'; echo
```

When `config.local.json` sets `manifestKey`, `scripts/build.mjs` writes it to `dist/manifest.json` as `"key"`. Every machine that builds with the same `manifestKey` gets the exact same Extension ID.

## Why `drive.file` creates its own `WebClips` root folder

Drive Clipper requests only `https://www.googleapis.com/auth/drive.file`. Under this scope, the extension cannot list, read, or modify arbitrary files already in your Google Drive; it can access only folders and files it created itself.

On first use (or when you click **Create / Switch Folder** in Options), Drive Clipper creates a root folder named `WebClips` (configurable) and stores its Google Drive folder ID (`rootFolderId`) in `chrome.storage.sync`.

Because all subsequent queries and uploads address that folder by its `rootFolderId` rather than its path or name, you can move `WebClips` into any parent folder in Google Drive or rename it at any time without breaking clips. If you delete or trash that folder, Drive Clipper detects the missing or trashed ID and creates a fresh root folder automatically.

## Development commands

```bash
# Type-check all source and test files
npm run typecheck

# Bundle dist/ (background.js, content.js, popup.js, options.js, assets, manifest.json)
npm run build

# Run all Vitest unit tests (core, background, drive, ui)
npm test

# Run Vitest in watch mode
npm run test:watch

# Run Playwright real-browser E2E tests against built dist/ artifacts
npm run test:e2e
```
