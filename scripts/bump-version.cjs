#!/usr/bin/env node

/**
 * Automated Version Bump Script for TalkEcho
 *
 * Usage:
 *   node scripts/bump-version.js <new-version> [--no-commit]
 *   npm run bump <new-version> [--no-commit]
 *
 * Examples:
 *   node scripts/bump-version.js 0.1.3
 *   npm run bump 0.1.3
 *   npm run bump 0.2.0 --no-commit
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function error(message) {
  log(`❌ Error: ${message}`, colors.red);
  process.exit(1);
}

function success(message) {
  log(`✅ ${message}`, colors.green);
}

function info(message) {
  log(`ℹ️  ${message}`, colors.cyan);
}

function warning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

// Validate version format
function validateVersion(version) {
  const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
  if (!versionRegex.test(version)) {
    error(`Invalid version format: ${version}. Expected format: X.Y.Z or X.Y.Z-suffix`);
  }
  return true;
}

// Get current version from package.json
function getCurrentVersion() {
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

// Update a JSON file
function updateJsonFile(filePath, updateFn) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    updateFn(data);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    error(`Failed to update ${filePath}: ${err.message}`);
    return false;
  }
}

// Update a text file with regex replacement
function updateTextFile(filePath, pattern, replacement) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const updated = content.replace(pattern, replacement);
    if (content === updated) {
      warning(`No changes made to ${filePath} - pattern not found`);
      return false;
    }
    fs.writeFileSync(filePath, updated, 'utf8');
    return true;
  } catch (err) {
    error(`Failed to update ${filePath}: ${err.message}`);
    return false;
  }
}

// Main version bump function
function bumpVersion(newVersion, shouldCommit = true) {
  const currentVersion = getCurrentVersion();

  log('', colors.bright);
  log('═══════════════════════════════════════════════', colors.blue);
  log('   TalkEcho Version Bump Script', colors.bright + colors.blue);
  log('═══════════════════════════════════════════════', colors.blue);
  log('');

  info(`Current version: ${currentVersion}`);
  info(`New version: ${newVersion}`);
  log('');

  if (currentVersion === newVersion) {
    warning('New version is the same as current version. Aborting.');
    process.exit(0);
  }

  // Define files to update
  const filesToUpdate = [
    {
      name: 'package.json',
      path: path.join(__dirname, '..', 'package.json'),
      update: () => updateJsonFile(
        path.join(__dirname, '..', 'package.json'),
        data => { data.version = newVersion; }
      ),
    },
    {
      name: 'package-lock.json',
      path: path.join(__dirname, '..', 'package-lock.json'),
      update: () => updateJsonFile(
        path.join(__dirname, '..', 'package-lock.json'),
        data => {
          data.version = newVersion;
          if (data.packages && data.packages['']) {
            data.packages[''].version = newVersion;
          }
        }
      ),
    },
    {
      name: 'src-tauri/Cargo.toml',
      path: path.join(__dirname, '..', 'src-tauri', 'Cargo.toml'),
      update: () => updateTextFile(
        path.join(__dirname, '..', 'src-tauri', 'Cargo.toml'),
        /^version = ".*"$/m,
        `version = "${newVersion}"`
      ),
    },
    {
      name: 'src-tauri/tauri.conf.json',
      path: path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'),
      update: () => updateJsonFile(
        path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'),
        data => { data.version = newVersion; }
      ),
    },
  ];

  // Update all files
  log('📝 Updating version in files...', colors.bright);
  log('');

  let allSuccess = true;
  for (const file of filesToUpdate) {
    info(`Updating ${file.name}...`);
    const result = file.update();
    if (result) {
      success(`  ✓ ${file.name} updated`);
    } else {
      allSuccess = false;
    }
  }

  log('');

  if (!allSuccess) {
    error('Some files failed to update. Please check the errors above.');
  }

  // Update Cargo.lock by running cargo update
  info('Updating Cargo.lock...');
  try {
    execSync('cargo update -p talkecho', {
      cwd: path.join(__dirname, '..', 'src-tauri'),
      stdio: 'inherit',
    });
    success('  ✓ Cargo.lock updated');
  } catch (err) {
    warning('  ⚠ Failed to update Cargo.lock automatically. Please run "cargo update -p talkecho" manually.');
  }

  log('');
  success(`🎉 Version bumped from ${currentVersion} to ${newVersion}`);
  log('');

  // Create git commit if requested
  if (shouldCommit) {
    info('Creating git commit...');
    try {
      // Check if there are changes to commit
      execSync('git diff --quiet', { cwd: path.join(__dirname, '..') });
      warning('  No changes to commit. Skipping git commit.');
    } catch {
      // There are changes, proceed with commit
      try {
        execSync(`git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json`, {
          cwd: path.join(__dirname, '..'),
          stdio: 'inherit',
        });

        execSync(`git commit -m "chore: bump version to ${newVersion}"`, {
          cwd: path.join(__dirname, '..'),
          stdio: 'inherit',
        });

        success('  ✓ Git commit created');
        log('');
        info('Next steps:');
        info(`  1. Review the changes: git show`);
        info(`  2. Push the changes: git push`);
        info(`  3. Create a tag: git tag v${newVersion} && git push --tags`);
      } catch (err) {
        warning('  ⚠ Failed to create git commit. Please commit manually.');
      }
    }
  } else {
    info('Skipping git commit (--no-commit flag)');
    log('');
    info('Next steps:');
    info('  1. Review the changes: git diff');
    info('  2. Commit manually: git add . && git commit -m "chore: bump version to ' + newVersion + '"');
    info('  3. Create a tag: git tag v' + newVersion + ' && git push --tags');
  }

  log('');
}

// Parse command line arguments
const args = process.argv.slice(2);
const newVersion = args[0];
const shouldCommit = !args.includes('--no-commit');

if (!newVersion) {
  error('Please provide a version number.\n\nUsage: node scripts/bump-version.js <version> [--no-commit]\nExample: node scripts/bump-version.js 0.1.3');
}

validateVersion(newVersion);
bumpVersion(newVersion, shouldCommit);
