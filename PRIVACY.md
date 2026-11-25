# Privacy Policy for OKF Clipper for Google Drive

Effective date: November 24, 2026

OKF Clipper for Google Drive ("OKF Clipper", "the extension") is an open-source Chrome Manifest V3 browser extension that converts web pages into Markdown bundles with local images and saves them directly to your own Google Drive.

## Summary

- No developer backend servers exist. Clipped pages, images, tags, OAuth tokens, and Google Drive file IDs never pass through any third-party or developer-controlled server.
- No analytics, telemetry, tracking pixels, crash reporters, or ads exist in this extension.
- The extension requests only the least-privilege Google Drive scope (`https://www.googleapis.com/auth/drive.file`), so it can access only the folder and clip files it creates.

## Information the extension processes

### 1. Active web page content (on demand only)

OKF Clipper reads a web page only when you explicitly start a clip from the extension popup or the right-click **Clip selection to Google Drive** menu. It never runs background scrapers or monitors your browsing history.

When you trigger a clip:
- The content script runs locally inside your browser to extract the page title, metadata (author, site name, published date, description), main article content or selected text, and image URLs using Defuddle.
- The extension service worker fetches the images referenced by that page directly from their image hosts so they can be saved alongside the Markdown file. When an image host checks the HTTP `Referer` header, the extension registers a temporary `declarativeNetRequest` session rule for that image request and removes the rule immediately after the fetch completes.

### 2. Google account authorization and Google Drive uploads

OKF Clipper signs you in with Google OAuth 2.0 using the single scope `https://www.googleapis.com/auth/drive.file`.

Under `drive.file`:
- OKF Clipper can create its own save folder (named `WebClips` by default) and create or update the article subfolders, Markdown files, images, `index.md`, and `log.md` inside it.
- OKF Clipper cannot list, read, search, modify, or delete arbitrary files already stored in your Google Drive.

All uploads go directly from your browser to the Google Drive API (`https://www.googleapis.com`). The extension never requests your Google password, and no OAuth client secret is stored in or transmitted by the extension.

### 3. Local browser storage

OKF Clipper stores settings and short-lived operational state locally in Chrome extension storage:

- **`chrome.storage.sync`**: Save folder name (`rootFolderName`), created Google Drive folder ID (`rootFolderId`), default tags (`defaultTags`), last-used popup tags (`stickyTags`), YAML frontmatter toggle preferences, image size/concurrency settings, and an optional user-supplied Web Application OAuth Client ID (`customWebAuthClientId`).
- **`chrome.storage.local`**: Up to 10 recent clip entries (title, source URL, Google Drive folder link, clip timestamp, image count, and warning count) shown in the popup's Recent clips list.
- **`chrome.storage.session`**: Active and recent background clip queue items (`clipJobs`, capped at 20) and, when using the browser web auth flow, a short-lived OAuth access token. Session storage is cleared automatically when the browser session ends or when you sign out.

## No remote code or third-party sharing

All JavaScript, HTML, and CSS runs locally from the installed extension package under a strict Manifest V3 Content Security Policy (`script-src 'self'; object-src 'self'`). OKF Clipper never loads remote scripts, and it never sells, rents, or transfers user data to advertisers, data brokers, or third parties.

## Google API Services User Data Policy (Limited Use)

OKF Clipper's use and transfer of information received from Google APIs to any other app adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements:

- Google user data is used strictly to create and update your clipped Markdown bundles in your own Google Drive at your request.
- Google user data is never transferred to external servers, never used for advertising, never sold, never read by humans, and never used to train generalized AI or machine learning models.

## Revoking access and deleting your data

You stay in full control of your authorization and saved files:

1. **Sign out inside the extension:** Open OKF Clipper Settings and click **Sign out**. This revokes the active OAuth token with Google and clears cached tokens from Chrome.
2. **Revoke access in Google Account:** Visit [Google Account Third-Party Connections](https://myaccount.google.com/permissions), select **OKF Clipper for Google Drive**, and remove access.
3. **Delete saved clips:** Delete the `WebClips` folder (or any individual clip subfolder) directly in your Google Drive.
4. **Delete local browser data:** Remove OKF Clipper from `chrome://extensions` to delete all local and synced extension storage.

## Source code and contact

OKF Clipper is open source. You can inspect the complete source code or report privacy questions and issues on GitHub:

- Repository: https://github.com/loaful/drive-clipper
- Issues: https://github.com/loaful/drive-clipper/issues
