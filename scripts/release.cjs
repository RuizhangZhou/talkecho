#!/usr/bin/env node

/**
 * One-shot Release Script for TalkEcho
 *
 * Runs the whole release: preflight -> bump -> build -> tag -> push -> GitHub Release.
 *
 * Usage:
 *   npm run release <version> [options]
 *
 * Examples:
 *   npm run release 0.1.9
 *   npm run release 0.1.9 -- --dry-run       # print every step, change nothing
 *   npm run release 0.1.9 -- --skip-build    # reuse installers already in target/
 *   npm run release 0.1.9 -- --draft         # create the release as a draft
 *
 * The script is resumable: re-running it after a failure skips the steps that
 * already succeeded (bump / tag / push are all detected before being applied).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO = 'RuizhangZhou/talkecho';
const RELEASE_BRANCH = 'main';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = (msg = '', color = colors.reset) => console.log(`${color}${msg}${colors.reset}`);
const info = (msg) => log(`i  ${msg}`, colors.cyan);
const success = (msg) => log(`OK ${msg}`, colors.green);
const warning = (msg) => log(`!  ${msg}`, colors.yellow);
const skipped = (msg) => log(`-> ${msg}`, colors.dim);

function error(msg) {
  log(`XX Error: ${msg}`, colors.red);
  process.exit(1);
}

function step(n, total, title) {
  log('');
  log(`--- [${n}/${total}] ${title} ${'-'.repeat(Math.max(3, 46 - title.length))}`, colors.blue);
}

// -- shell helpers -----------------------------------------------------------

/** Run a command, streaming its output. Honours --dry-run. */
function run(cmd, opts = {}) {
  if (DRY_RUN && !opts.evenInDryRun) {
    log(`   $ ${cmd}`, colors.dim + colors.yellow);
    return;
  }
  log(`   $ ${cmd}`, colors.dim);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

/** Run a command and return trimmed stdout. Never affected by --dry-run. */
function capture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Run a command, returning null instead of throwing on failure. */
function tryCapture(cmd) {
  try {
    return capture(cmd);
  } catch {
    return null;
  }
}

// -- argument parsing --------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const version = args.find((a) => !a.startsWith('--'));

const DRY_RUN = flags.has('--dry-run');
const SKIP_BUILD = flags.has('--skip-build');
const DRAFT = flags.has('--draft');
const ALLOW_DIRTY = flags.has('--allow-dirty');
const ALLOW_BRANCH = flags.has('--allow-branch');

const KNOWN_FLAGS = ['--dry-run', '--skip-build', '--draft', '--allow-dirty', '--allow-branch'];
for (const flag of flags) {
  if (!KNOWN_FLAGS.includes(flag)) {
    error(`Unknown flag: ${flag}\n   Known flags: ${KNOWN_FLAGS.join(', ')}`);
  }
}

if (!version) {
  error(
    'Please provide a version number.\n\n' +
      '   Usage: npm run release <version> [--dry-run] [--skip-build] [--draft]\n' +
      '   Example: npm run release 0.1.9'
  );
}

if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(version)) {
  error(`Invalid version format: ${version}. Expected X.Y.Z or X.Y.Z-suffix (no "v" prefix).`);
}

const TAG = `v${version}`;
const ARTIFACTS = [
  path.join('src-tauri', 'target', 'release', 'bundle', 'nsis', `TalkEcho_${version}_x64-setup.exe`),
  path.join('src-tauri', 'target', 'release', 'bundle', 'msi', `TalkEcho_${version}_x64_en-US.msi`),
];

const readVersion = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// -- main --------------------------------------------------------------------

const TOTAL = 7;

log('');
log('=======================================================', colors.blue);
log(`   TalkEcho Release - ${TAG}`, colors.bright + colors.blue);
log('=======================================================', colors.blue);
if (DRY_RUN) warning('DRY RUN - no command that changes anything will actually execute.');

// -- 1. preflight ------------------------------------------------------------

step(1, TOTAL, 'Preflight checks');

const branch = capture('git rev-parse --abbrev-ref HEAD');
if (branch !== RELEASE_BRANCH) {
  if (!ALLOW_BRANCH) {
    error(
      `You are on "${branch}", but releases are cut from "${RELEASE_BRANCH}".\n` +
        `   Run: git checkout ${RELEASE_BRANCH} && git pull\n` +
        `   (or pass --allow-branch if you really mean to release from "${branch}")`
    );
  }
  warning(`Releasing from "${branch}" instead of "${RELEASE_BRANCH}" (--allow-branch).`);
}
success(`On branch ${branch}`);

const dirty = capture('git status --porcelain');
if (dirty && !ALLOW_DIRTY) {
  error(`Working tree is not clean. Commit or stash first:\n\n${dirty}\n`);
}
if (dirty) warning('Working tree is dirty (--allow-dirty).');
else success('Working tree is clean');

// Pick the remote that actually points at the release repo. "origin" here is a
// redirect from the pre-rename pluely URL, and "upstream" is someone else's
// repo entirely - matching on the URL avoids pushing to the wrong one.
const remotes = capture('git remote -v')
  .split('\n')
  .filter((l) => l.includes('(push)'))
  .map((l) => ({ name: l.split(/\s+/)[0], url: l.split(/\s+/)[1] }));
const remote = remotes.find((r) => /talkecho/i.test(r.url));
if (!remote) {
  error(
    `No git remote points at ${REPO}. Remotes found:\n` +
      remotes.map((r) => `   ${r.name} -> ${r.url}`).join('\n')
  );
}
success(`Push remote: ${remote.name} -> ${remote.url}`);

if (!tryCapture('gh --version')) {
  error('GitHub CLI ("gh") not found. Install it from https://cli.github.com/');
}
if (tryCapture('gh auth status') === null) {
  error('GitHub CLI is not authenticated. Run: gh auth login');
}
success('GitHub CLI ready');

if (tryCapture(`gh release view ${TAG} --repo ${REPO}`)) {
  error(
    `Release ${TAG} already exists:\n` +
      `   https://github.com/${REPO}/releases/tag/${TAG}\n` +
      '   Delete it first, or pick a new version.'
  );
}
success(`No existing release named ${TAG}`);

info(`Current version: ${readVersion()}  ->  new version: ${version}`);

// -- 2. bump -----------------------------------------------------------------

step(2, TOTAL, 'Bump version');

if (readVersion() === version) {
  skipped(`package.json already at ${version} - skipping bump.`);
} else {
  run(`node "${path.join('scripts', 'bump-version.cjs')}" ${version}`);
  success(`Bumped to ${version} and committed`);
}

// -- 3. build ----------------------------------------------------------------

step(3, TOTAL, 'Build installers');

// Set before the build so step 4 can tell a freshly produced installer from a
// leftover one with the same version in its filename.
const buildStartedAt = Date.now();
let buildError = null;

if (SKIP_BUILD) {
  skipped('Skipping build (--skip-build).');
} else {
  if (!fs.existsSync(path.join(ROOT, 'src-tauri', '.env'))) {
    warning('src-tauri/.env is missing. The build still succeeds, but API_ACCESS_KEY,');
    warning('PAYMENT_ENDPOINT, APP_ENDPOINT and POSTHOG_API_KEY compile to empty values');
    warning('(they are read via option_env!), so activation / payment / analytics stay off.');
  }
  info('This takes a while (a full Rust release build)...');
  try {
    run('npm run tauri build');
  } catch (err) {
    // `tauri build` exits non-zero when updater signing fails, which it always
    // does while TAURI_SIGNING_PRIVATE_KEY is unset - but it fails *after*
    // writing both installers. Defer the verdict to the artifact check below
    // so a signing-only failure doesn't abort an otherwise good release.
    buildError = err;
    warning('`npm run tauri build` exited non-zero - checking whether the installers were still produced...');
  }
}

// -- 4. verify artifacts -----------------------------------------------------

step(4, TOTAL, 'Verify artifacts');

const missing = ARTIFACTS.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
if (missing.length && !DRY_RUN) {
  if (buildError) {
    log('');
    error(
      'The build failed and did not produce the installers:\n' +
        missing.map((m) => `   ${m}`).join('\n') +
        `\n\n   Build error: ${buildError.message}`
    );
  }
  error(`Expected installers were not produced:\n${missing.map((m) => `   ${m}`).join('\n')}`);
}
for (const rel of ARTIFACTS) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    const stale = !SKIP_BUILD && stat.mtimeMs < buildStartedAt;
    if (stale) {
      error(
        `${path.basename(rel)} is older than this build (last written ${stat.mtime.toISOString()}).\n` +
          '   The build did not actually regenerate it - refusing to ship a stale installer.'
      );
    }
    success(`${path.basename(rel)}  (${mb} MB)`);
  } else {
    warning(`${path.basename(rel)} - not found (dry run)`);
  }
}

if (buildError) {
  warning('Both installers exist despite the non-zero build exit - continuing.');
  warning('This is expected while updater signing is unconfigured (no TAURI_SIGNING_PRIVATE_KEY).');
}

// Updater signatures, if signing is ever wired up (createUpdaterArtifacts is on
// in tauri.conf.json, but it only emits .sig files when a signing key is set).
const signatures = ARTIFACTS.map((rel) => `${rel}.sig`).filter((rel) =>
  fs.existsSync(path.join(ROOT, rel))
);
if (signatures.length) {
  signatures.forEach((s) => success(`${path.basename(s)}  (updater signature)`));
} else {
  info('No .sig files - in-app updater signatures are not being produced.');
}

// -- 5. push commits ---------------------------------------------------------

step(5, TOTAL, `Push ${branch}`);

run(`git push ${remote.name} ${branch}`);
success(`Pushed ${branch} to ${remote.name}`);

// -- 6. tag ------------------------------------------------------------------

step(6, TOTAL, 'Create and push tag');

// The tag must land on the bump commit, so that checking out the tag rebuilds
// the same version number the release advertises. v0.1.8 originally missed this.
const headVersion = readVersion();
if (headVersion !== version && !DRY_RUN) {
  error(`HEAD says version ${headVersion} but we are tagging ${TAG}. Refusing to create a mismatched tag.`);
}

if (tryCapture(`git rev-parse -q --verify refs/tags/${TAG}`)) {
  skipped(`Tag ${TAG} already exists locally.`);
} else {
  run(`git tag ${TAG}`);
  success(`Tagged ${TAG} at HEAD`);
}
run(`git push ${remote.name} ${TAG}`);
success(`Pushed tag ${TAG}`);

// -- 7. publish --------------------------------------------------------------

step(7, TOTAL, 'Create GitHub Release');

const uploads = [...ARTIFACTS, ...signatures].map((rel) => `"${rel}"`).join(' ');
const draftFlag = DRAFT ? ' --draft' : '';
run(`gh release create ${TAG} --repo ${REPO} --title ${TAG} --generate-notes${draftFlag} ${uploads}`);

log('');
log('=======================================================', colors.green);
success(`Release ${TAG} published`);
log(`   https://github.com/${REPO}/releases/tag/${TAG}`, colors.cyan);
log('=======================================================', colors.green);
log('');
