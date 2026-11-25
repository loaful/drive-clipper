# Chrome Web Store Listing & Publishing Playbook

Copy-paste metadata, privacy justifications, and the zero-billing Google Cloud publish checklist for **OKF Clipper for Google Drive**.

## Store listing copy

### Extension name

```text
OKF Clipper for Google Drive
```

### Short summary (108 / 132 characters)

```text
Clip web pages into clean Markdown with local images and save directly to your Google Drive WebClips folder.
```

### Category & language

- **Category:** Productivity
- **Primary language:** English

### Full store description

```text
Save any web article, thread, or selected passage as a clean Markdown bundle with local images directly inside your Google Drive.

OKF Clipper for Google Drive extracts readable content locally in your browser using Defuddle, downloads the page's images in their original formats, rewrites links to local ./images/ paths, and uploads everything straight from Chrome to your own WebClips/ folder.

KEY FEATURES
- 10-second setup: Connect Google Drive once and start clipping immediately.
- Clean Markdown + YAML frontmatter: Preserves headings, code blocks, links, author, site, published date, tags, and source metadata in Open Knowledge Format (OKF v0.2).
- Offline-ready local images: Downloads WebP, PNG, JPEG, GIF, and SVG assets (including lazy-loaded images and X.com post media) into each clip's images/ subfolder before uploading the Markdown file. Large images over 4.5 MB automatically switch to Google Drive resumable upload.
- Multi-tab background queue: Click Clip to Google Drive and switch tabs right away. Up to 2 clips process concurrently in the background with live progress, toolbar badge status, and retry-safe idempotent updates.
- Organized Google Drive vault: Every clip lands in WebClips/YYYY-MM-DD-<source>-<slug>/<folder>.md alongside an automatically maintained index.md catalog and append-only log.md.
- Full page or selection: Clip an entire article from the toolbar popup, or highlight text and right-click "Clip selection to Google Drive".
- Sticky tags & automatic title cleanup: Remembers your last-used tags across opens and strips unread notification counters and site suffixes from default titles.

PRIVACY FIRST
- No third-party backend servers. Everything runs locally in your browser and uploads directly to Google Drive.
- Zero analytics, tracking, or ads.
- Least-privilege Google Drive access (drive.file): OKF Clipper can only access the WebClips folder and clips it creates. It cannot read or list your other Google Drive files.
- You can freely move or rename your WebClips folder anywhere in Google Drive without breaking future clips.
- Power users can optionally connect their own Google Cloud Web OAuth Client ID at runtime under Settings > Advanced & Self-hosting without rebuilding.
```

## Privacy practices & permission justifications

Paste these into the **Privacy practices** tab in the Chrome Web Store Developer Dashboard.

### Single purpose description

```text
Clip web pages or selected text into Open Knowledge Format (OKF v0.2) Markdown files with locally archived images and upload them directly to the user's Google Drive folder.
```

### Permission justifications

| Permission | Copy-paste justification |
| --- | --- |
| `identity` | Used to authenticate the user with Google OAuth 2.0 under the minimal `https://www.googleapis.com/auth/drive.file` scope via `chrome.identity.getAuthToken()` (or `chrome.identity.launchWebAuthFlow()` when Chrome Sync is unavailable or a user supplies a custom OAuth client). |
| `storage` | Used to persist user preferences (save folder name and folder ID, default and sticky tags, YAML frontmatter options, optional custom Web OAuth Client ID) in `chrome.storage.sync`, recent clip history (up to 10 items) in `chrome.storage.local`, and active background clip queue status plus short-lived web-auth session tokens in `chrome.storage.session`. |
| `activeTab` | Used to read the URL and title of the active tab and access it only when the user explicitly clicks the toolbar icon or invokes the clip action. |
| `scripting` | Used to inject the local content script (`content.js`) into the active tab on demand when the user opens the popup or triggers a clip, so page content and text selections can be extracted locally with Defuddle without requiring persistent content scripts on every page. |
| `contextMenus` | Used to provide the right-click **Clip selection to Google Drive** context menu item when text is selected on a web page. |
| `declarativeNetRequestWithHostAccess` | Used exclusively to attach a temporary per-request HTTP `Referer` header when the background service worker downloads images from anti-hotlink CDNs on a page the user chose to clip. Each temporary session rule is scoped to a single image URL and removed immediately in a `finally` block once the fetch finishes. |
| `host_permissions` (`https://*/*`, `http://*/*`) | Required so the background service worker can download images referenced by any web page the user explicitly chooses to clip (often hosted on third-party image CDNs different from the article domain), and apply temporary `Referer` rules when needed. The extension never accesses hosts in the background unless the user initiates a clip. |

### Data usage & certification answers

- **Are you using remote code?** No. All scripts are bundled inside the extension package (`content_security_policy.extension_pages: "script-src 'self'; object-src 'self'"`).
- **Developer data collection:** None of the user data types are collected or transmitted to the developer. All extraction happens locally in Chrome, and uploads go directly from Chrome to Google Drive.
- **Google API Limited Use certification:** Check the certification boxes confirming compliance with the Chrome Web Store Developer Program Policies and Google API Services User Data Policy.
- **Privacy Policy URL:** `https://github.com/loaful/drive-clipper/blob/main/PRIVACY.md`
- **Homepage / Support URL:** `https://github.com/loaful/drive-clipper`

## Zero-billing GCP project (`okf-clipper`) & draft-to-production publish checklist

Follow this exact sequence to publish OKF Clipper with zero Google Cloud billing risk and a clean OAuth verification path.

### 1. Create an unbilled Google Cloud project (`okf-clipper`)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a new project named **`okf-clipper`**.
2. **Do NOT link any Billing Account to this project.** Google Drive API v3 and Google OAuth 2.0 require no billing account, which guarantees $0 billing risk and prevents any accidental charges.
3. Enable only the **Google Drive API** (`APIs & Services` > `Library` > search `Google Drive API` > **Enable**).

### 2. Configure and publish the OAuth consent screen (`In production`)

1. Open **Google Auth Platform** (`APIs & Services` > `OAuth consent screen` / `Branding` and `Audience`).
2. Set User Type / Audience to **External**.
3. Fill Branding details:
   - App name: `OKF Clipper for Google Drive`
   - User support email: your developer email
   - Application home page: `https://github.com/loaful/drive-clipper`
   - Application privacy policy link: `https://github.com/loaful/drive-clipper/blob/main/PRIVACY.md`
   - Developer contact email: your developer email
4. Under **Data Access** (Scopes), add **only** the single non-sensitive scope:
   - `https://www.googleapis.com/auth/drive.file`
   - Because `drive.file` is a **non-sensitive** per-file scope (not a restricted broad Drive scope), Google does not require a paid CASA security assessment.
5. Under **Audience**, click **Publish App** so status moves from `Testing` to **`In production`**. (While in `Testing`, only manually added Test Users can sign in.)

### 3. Upload a Draft package to obtain the permanent Store Extension ID

Chrome Web Store assigns its own permanent 32-character Extension ID on first upload and rejects packages containing a manifest `"key"` field.

1. Build a draft store zip (without modifying local `dist/`):
   ```bash
   # If config.local.json already has a real oauthClientId:
   npm run pack:store

   # Or for an initial placeholder draft before creating Store OAuth clients:
   node scripts/pack-store.mjs --allow-placeholder
   ```
   This writes `release/okf-clipper-store-v0.1.0.zip` with `"key"` stripped and automated manifest/CSP/secret checks enabled.
2. Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), click **New Item**, and upload `release/okf-clipper-store-v0.1.0.zip`.
3. **Save as Draft** (do not submit yet).
4. Copy the permanent 32-character **Item ID** (Store Extension ID) shown at the top of the item page.

### 4. Bind Chrome Extension + Web Application OAuth clients to the Store Extension ID

In the `okf-clipper` Google Cloud project (`Google Auth Platform` > `Clients` > **Create Client**), create two OAuth Client IDs. Never copy or commit any `client_secret`.

1. **Chrome Extension client** (for zero-config sign-in in Google Chrome via `chrome.identity.getAuthToken()`):
   - Application type: **Chrome Extension**
   - Name: `OKF Clipper Store (Chrome Extension)`
   - Item ID: `<your permanent 32-character Store Extension ID>`
2. **Web application client** (for Chromium browsers without Chrome Sync via `chrome.identity.launchWebAuthFlow()`):
   - Application type: **Web application**
   - Name: `OKF Clipper Store (Web Auth Flow)`
   - Authorized redirect URIs: `https://<your-permanent-store-extension-id>.chromiumapp.org` (no trailing slash)

### 5. Update `config.local.json` and build the final production archive

1. Put the two Store Client IDs into gitignored `config.local.json` (leave `manifestKey` intact if you keep a separate local dev build, because `--store` omits `"key"` automatically):
   ```json
   {
     "oauthClientId": "<store-chrome-extension-client-id>.apps.googleusercontent.com",
     "webAuthClientId": "<store-web-app-client-id>.apps.googleusercontent.com",
     "manifestKey": "<optional-local-dev-key-ignored-by-pack-store>"
   }
   ```
2. Run the production pack command:
   ```bash
   npm run pack:store
   ```
3. Verify the generated zip in `release/okf-clipper-store-v0.1.0.zip`:
   ```bash
   unzip -l release/okf-clipper-store-v0.1.0.zip
   unzip -p release/okf-clipper-store-v0.1.0.zip manifest.json
   ```
   Confirm:
   - `manifest_version` is `3`
   - No `"key"` property exists in `manifest.json`
   - `name` is `"OKF Clipper for Google Drive"`
   - `oauth2.client_id` is your real Store Chrome Extension Client ID (not the placeholder)
   - `oauth2.scopes` is strictly `["https://www.googleapis.com/auth/drive.file"]`
   - Zero `config.local.json`, `.pem`, `.key`, `.env`, or `client_secret` files appear in the archive

### 6. Upload final zip and submit for review

1. In the Chrome Web Store Developer Dashboard, open your Draft item and click **Package** > **Upload new package** with `release/okf-clipper-store-v0.1.0.zip`.
2. Fill in **Store listing** (title, short summary, description, category, 1280x800 screenshots, 128x128 icon) and **Privacy practices** (single purpose, permission justifications, privacy policy URL `https://github.com/loaful/drive-clipper/blob/main/PRIVACY.md`).
3. Click **Submit for Review**.
