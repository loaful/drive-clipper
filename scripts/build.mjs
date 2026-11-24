import { build } from 'esbuild';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const REMOTE_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']\s*(?:https?:|\/\/)/i;

const ENTRYPOINTS = [
  { entry: path.join(srcDir, 'background', 'service-worker.ts'), outfile: path.join(distDir, 'background.js') },
  { entry: path.join(srcDir, 'content', 'content.ts'), outfile: path.join(distDir, 'content.js') },
  { entry: path.join(srcDir, 'ui', 'popup.ts'), outfile: path.join(distDir, 'popup.js') },
  { entry: path.join(srcDir, 'ui', 'options.ts'), outfile: path.join(distDir, 'options.js') },
];

const STATIC_UI_FILES = [
  'popup.html',
  'popup.css',
  'options.html',
  'options.css',
];

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readLocalConfig() {
  const localConfigPath = path.join(rootDir, 'config.local.json');
  if (!existsSync(localConfigPath)) {
    return {};
  }
  return readJsonFile(localConfigPath);
}

function buildManifest(localConfig) {
  const templatePath = path.join(srcDir, 'manifest.template.json');
  const manifest = readJsonFile(templatePath);

  if (typeof localConfig.oauthClientId === 'string' && localConfig.oauthClientId.trim().length > 0) {
    manifest.oauth2 = manifest.oauth2 ?? {};
    manifest.oauth2.client_id = localConfig.oauthClientId.trim();
  }
  if (typeof localConfig.manifestKey === 'string' && localConfig.manifestKey.trim().length > 0) {
    manifest.key = localConfig.manifestKey.trim();
  }

  const scopes = manifest.oauth2?.scopes;
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== REQUIRED_DRIVE_SCOPE) {
    throw new Error(
      `Invalid oauth2.scopes in manifest: expected exactly ["${REQUIRED_DRIVE_SCOPE}"], got ${JSON.stringify(scopes)}`,
    );
  }

  writeFileSync(
    path.join(distDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function copyStaticAssets() {
  const uiDir = path.join(srcDir, 'ui');
  for (const filename of STATIC_UI_FILES) {
    const from = path.join(uiDir, filename);
    if (!existsSync(from)) {
      continue;
    }
    const content = readFileSync(from, 'utf8');
    if (filename.endsWith('.html') && REMOTE_SCRIPT_RE.test(content)) {
      throw new Error(`Remote <script> URL detected in ${from}; MV3 forbids remote scripts.`);
    }
    writeFileSync(path.join(distDir, filename), content, 'utf8');
  }

  const iconsDir = path.join(srcDir, 'icons');
  if (existsSync(iconsDir)) {
    const entries = readdirSync(iconsDir);
    if (entries.length > 0) {
      const targetIconsDir = path.join(distDir, 'icons');
      mkdirSync(targetIconsDir, { recursive: true });
      cpSync(iconsDir, targetIconsDir, { recursive: true });
    }
  }
}

async function bundleScripts(localConfig) {
  const missing = ENTRYPOINTS.filter(({ entry }) => !existsSync(entry));
  if (missing.length > 0) {
    const names = missing.map(({ entry }) => path.relative(rootDir, entry)).join(', ');
    throw new Error(`Missing required build entrypoints: ${names}`);
  }

  const sourcemap = process.env.BUILD_SOURCEMAP === '1' ? 'inline' : false;
  const webAuthClientId =
    typeof localConfig.webAuthClientId === 'string'
      ? localConfig.webAuthClientId.trim()
      : '';

  await Promise.all(
    ENTRYPOINTS.map(({ entry, outfile }) =>
      build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome120'],
        sourcemap,
        define: {
          __DRIVE_CLIPPER_WEB_AUTH_CLIENT_ID__: JSON.stringify(webAuthClientId),
        },
        logLevel: 'silent',
      }),
    ),
  );
}

async function main() {
  const localConfig = readLocalConfig();
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  await bundleScripts(localConfig);
  copyStaticAssets();
  buildManifest(localConfig);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
