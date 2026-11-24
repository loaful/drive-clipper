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
const defaultDistDir = path.join(rootDir, 'dist');

const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const OAUTH_CLIENT_ID_PLACEHOLDER =
  'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
const REMOTE_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']\s*(?:https?:|\/\/)/i;

const STATIC_UI_FILES = [
  'popup.html',
  'popup.css',
  'options.html',
  'options.css',
];

function isValidOAuthClientId(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === OAUTH_CLIENT_ID_PLACEHOLDER) {
    return false;
  }
  return !trimmed.startsWith('YOUR_');
}

function parseCliArgs(argv) {
  let outDir = defaultDistDir;
  let store = false;
  let allowPlaceholder = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--store') {
      store = true;
      continue;
    }
    if (arg === '--allow-placeholder') {
      allowPlaceholder = true;
      continue;
    }
    if (arg === '--out-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing directory argument after --out-dir.');
      }
      outDir = path.resolve(rootDir, next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      const value = arg.slice('--out-dir='.length).trim();
      if (value.length === 0) {
        throw new Error('Empty directory argument for --out-dir=');
      }
      outDir = path.resolve(rootDir, value);
      continue;
    }
    throw new Error(`Unknown build argument: ${arg}`);
  }

  const normalizedOut = path.resolve(outDir);
  if (
    normalizedOut === rootDir ||
    normalizedOut === srcDir ||
    normalizedOut === path.parse(normalizedOut).root
  ) {
    throw new Error(`Refusing to build into unsafe --out-dir: ${normalizedOut}`);
  }

  return { outDir: normalizedOut, store, allowPlaceholder };
}

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

function buildManifest(localConfig, outDir, options) {
  const templatePath = path.join(srcDir, 'manifest.template.json');
  const manifest = readJsonFile(templatePath);

  if (
    typeof localConfig.oauthClientId === 'string' &&
    localConfig.oauthClientId.trim().length > 0
  ) {
    manifest.oauth2 = manifest.oauth2 ?? {};
    manifest.oauth2.client_id = localConfig.oauthClientId.trim();
  }

  if (options.store) {
    // Chrome Web Store rejects upload zips that include a manifest "key" field.
    delete manifest.key;
    if (
      !options.allowPlaceholder &&
      !isValidOAuthClientId(manifest.oauth2?.client_id)
    ) {
      throw new Error(
        'Store build (--store) requires a real oauthClientId in config.local.json ' +
          '(found placeholder). Configure config.local.json or pass --allow-placeholder ' +
          'for dry-run/test builds.',
      );
    }
  } else if (
    typeof localConfig.manifestKey === 'string' &&
    localConfig.manifestKey.trim().length > 0
  ) {
    manifest.key = localConfig.manifestKey.trim();
  }

  const scopes = manifest.oauth2?.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length !== 1 ||
    scopes[0] !== REQUIRED_DRIVE_SCOPE
  ) {
    throw new Error(
      `Invalid oauth2.scopes in manifest: expected exactly ["${REQUIRED_DRIVE_SCOPE}"], got ${JSON.stringify(scopes)}`,
    );
  }

  writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function copyStaticAssets(outDir) {
  const uiDir = path.join(srcDir, 'ui');
  for (const filename of STATIC_UI_FILES) {
    const from = path.join(uiDir, filename);
    if (!existsSync(from)) {
      continue;
    }
    const content = readFileSync(from, 'utf8');
    if (filename.endsWith('.html') && REMOTE_SCRIPT_RE.test(content)) {
      throw new Error(
        `Remote <script> URL detected in ${from}; MV3 forbids remote scripts.`,
      );
    }
    writeFileSync(path.join(outDir, filename), content, 'utf8');
  }

  const iconsDir = path.join(srcDir, 'icons');
  if (existsSync(iconsDir)) {
    const entries = readdirSync(iconsDir).filter((name) => name !== '.DS_Store');
    if (entries.length > 0) {
      const targetIconsDir = path.join(outDir, 'icons');
      mkdirSync(targetIconsDir, { recursive: true });
      cpSync(iconsDir, targetIconsDir, {
        recursive: true,
        filter: (src) => path.basename(src) !== '.DS_Store',
      });
    }
  }
}

async function bundleScripts(localConfig, outDir, options) {
  const entrypoints = [
    {
      entry: path.join(srcDir, 'background', 'service-worker.ts'),
      outfile: path.join(outDir, 'background.js'),
    },
    {
      entry: path.join(srcDir, 'content', 'content.ts'),
      outfile: path.join(outDir, 'content.js'),
    },
    {
      entry: path.join(srcDir, 'ui', 'popup.ts'),
      outfile: path.join(outDir, 'popup.js'),
    },
    {
      entry: path.join(srcDir, 'ui', 'options.ts'),
      outfile: path.join(outDir, 'options.js'),
    },
  ];

  const missing = entrypoints.filter(({ entry }) => !existsSync(entry));
  if (missing.length > 0) {
    const names = missing
      .map(({ entry }) => path.relative(rootDir, entry))
      .join(', ');
    throw new Error(`Missing required build entrypoints: ${names}`);
  }

  const sourcemap =
    !options.store && process.env.BUILD_SOURCEMAP === '1' ? 'inline' : false;
  const webAuthClientId =
    typeof localConfig.webAuthClientId === 'string'
      ? localConfig.webAuthClientId.trim()
      : '';

  await Promise.all(
    entrypoints.map(({ entry, outfile }) =>
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
  const options = parseCliArgs(process.argv.slice(2));
  const localConfig = readLocalConfig();
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  await bundleScripts(localConfig, options.outDir, options);
  copyStaticAssets(options.outDir);
  buildManifest(localConfig, options.outDir, options);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
