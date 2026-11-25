import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const buildScriptPath = path.join(__dirname, 'build.mjs');

const REQUIRED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const OAUTH_CLIENT_ID_PLACEHOLDER =
  'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
const REMOTE_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']\s*(?:https?:|\/\/)/i;

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
  let allowPlaceholder = false;
  let outZip = null;
  let configPath = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-placeholder') {
      allowPlaceholder = true;
      continue;
    }
    if (arg === '--config') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing config file path after --config.');
      }
      configPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length).trim();
      if (value.length === 0) {
        throw new Error('Empty config file path for --config=');
      }
      configPath = path.resolve(process.cwd(), value);
      continue;
    }
    if (arg === '--out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing output zip path after --out.');
      }
      outZip = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length).trim();
      if (value.length === 0) {
        throw new Error('Empty output zip path for --out=');
      }
      outZip = path.resolve(process.cwd(), value);
      continue;
    }
    throw new Error(`Unknown pack-store argument: ${arg}`);
  }

  return { allowPlaceholder, outZip, configPath };
}

function listFilesRecursively(dirPath, baseDir = dirPath) {
  const results = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push({
        fullPath,
        relPath: path.relative(baseDir, fullPath),
        name: entry.name,
      });
    }
  }
  return results;
}

function isForbiddenStagedFile(filename) {
  const lower = filename.toLowerCase();
  if (
    lower === 'config.local.json' ||
    lower === 'config.store.json' ||
    lower === '.ds_store' ||
    lower === '.env' ||
    lower.startsWith('.env.')
  ) {
    return true;
  }
  if (lower.endsWith('.pem') || lower.endsWith('.key')) {
    return true;
  }
  if (lower.includes('client_secret')) {
    return true;
  }
  return false;
}

function validateStagedExtension(stagingDir, options) {
  const manifestPath = path.join(stagingDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Staged store build is missing manifest.json.');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.manifest_version !== 3) {
    throw new Error(
      `Store manifest must have manifest_version === 3, got ${JSON.stringify(manifest.manifest_version)}.`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(manifest, 'key')) {
    throw new Error(
      'Store manifest must NOT contain a "key" field (Chrome Web Store rejects zips with "key").',
    );
  }

  const scopes = manifest.oauth2?.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length !== 1 ||
    scopes[0] !== REQUIRED_DRIVE_SCOPE
  ) {
    throw new Error(
      `Store manifest oauth2.scopes must be exactly ["${REQUIRED_DRIVE_SCOPE}"], got ${JSON.stringify(scopes)}.`,
    );
  }

  if (
    !options.allowPlaceholder &&
    !isValidOAuthClientId(manifest.oauth2?.client_id)
  ) {
    throw new Error(
      'Store manifest oauth2.client_id is still a placeholder. Configure config.local.json or pass --allow-placeholder for dry-run packaging.',
    );
  }

  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    throw new Error('Store manifest is missing a valid version string.');
  }

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("script-src 'self'") || /https?:|unsafe-eval/i.test(csp)) {
    throw new Error(`Unexpected MV3 extension_pages CSP in store manifest: ${csp}`);
  }

  const requiredAssets = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
  ].filter((item) => typeof item === 'string' && item.length > 0);

  for (const relAsset of requiredAssets) {
    const assetPath = path.join(stagingDir, relAsset);
    if (!existsSync(assetPath)) {
      throw new Error(`Store manifest references missing staged file: ${relAsset}`);
    }
  }

  const stagedFiles = listFilesRecursively(stagingDir);
  for (const file of stagedFiles) {
    if (isForbiddenStagedFile(file.name)) {
      throw new Error(
        `Forbidden secret or local config file detected in store staging dir: ${file.relPath}`,
      );
    }
    if (file.name.toLowerCase().endsWith('.html')) {
      const html = readFileSync(file.fullPath, 'utf8');
      if (REMOTE_SCRIPT_RE.test(html)) {
        throw new Error(
          `Remote <script> tag detected in staged HTML file: ${file.relPath}`,
        );
      }
    }
  }

  return manifest;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const stagingDir = mkdtempSync(path.join(os.tmpdir(), 'okf-clipper-store-'));

  try {
    const buildArgs = [buildScriptPath, '--store', '--out-dir', stagingDir];
    if (options.allowPlaceholder) {
      buildArgs.push('--allow-placeholder');
    }
    if (options.configPath) {
      buildArgs.push('--config', options.configPath);
    }

    execFileSync(process.execPath, buildArgs, {
      cwd: rootDir,
      stdio: 'inherit',
    });

    const manifest = validateStagedExtension(stagingDir, options);

    const outZipPath =
      options.outZip ??
      path.join(
        rootDir,
        'release',
        `okf-clipper-store-v${manifest.version.trim()}.zip`,
      );

    mkdirSync(path.dirname(outZipPath), { recursive: true });
    rmSync(outZipPath, { force: true });

    const topLevelEntries = readdirSync(stagingDir).sort();
    if (topLevelEntries.length === 0) {
      throw new Error('Store staging directory is empty; nothing to zip.');
    }

    execFileSync('zip', ['-r', '-X', '-q', outZipPath, ...topLevelEntries], {
      cwd: stagingDir,
      stdio: 'inherit',
    });

    const stats = statSync(outZipPath);
    const sizeKb = (stats.size / 1024).toFixed(1);
    console.log(
      `Packed Chrome Web Store archive: ${outZipPath} (${stats.size} bytes / ${sizeKb} KB)`,
    );
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
