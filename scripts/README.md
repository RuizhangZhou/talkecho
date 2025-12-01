# TalkEcho Scripts

This directory contains utility scripts for maintaining the TalkEcho project.

## Version Bump Script

**Location**: `scripts/bump-version.cjs`

Automatically updates the version number across all necessary files in the project.

### What it does

The script updates the version in the following files:
- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

It also optionally creates a git commit with the changes.

### Usage

#### Using npm script (recommended):

```bash
npm run bump <new-version>
```

#### Direct execution:

```bash
node scripts/bump-version.cjs <new-version>
```

### Examples

**Bump to version 0.1.3:**
```bash
npm run bump 0.1.3
```

**Bump to version 0.2.0 without creating a commit:**
```bash
npm run bump 0.2.0 -- --no-commit
```

**Bump to a pre-release version:**
```bash
npm run bump 0.1.3-beta.1
```

### Options

- `<new-version>` (required): The new version number in format `X.Y.Z` or `X.Y.Z-suffix`
- `--no-commit`: Skip automatic git commit creation

### After running the script

If you used the default behavior (with commit):

1. Review the commit:
   ```bash
   git show
   ```

2. Push the changes:
   ```bash
   git push
   ```

3. Create and push a git tag:
   ```bash
   git tag v0.1.3
   git push --tags
   ```

If you used `--no-commit`:

1. Review the changes:
   ```bash
   git diff
   ```

2. Commit manually:
   ```bash
   git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
   git commit -m "chore: bump version to 0.1.3"
   ```

3. Create and push a git tag:
   ```bash
   git tag v0.1.3
   git push --tags
   ```

### Version Format

The script validates that the version follows semantic versioning:

✅ Valid formats:
- `0.1.3`
- `1.0.0`
- `0.1.3-beta.1`
- `1.0.0-rc.1`

❌ Invalid formats:
- `0.1` (missing patch version)
- `v0.1.3` (no 'v' prefix)
- `1.0.0.1` (too many version parts)

### Troubleshooting

**Error: "Failed to update Cargo.lock"**

If the script fails to update `Cargo.lock` automatically, run:
```bash
cd src-tauri
cargo update -p talkecho
```

**Error: "No changes to commit"**

This means the version hasn't actually changed in any files. Make sure you're using a different version number than the current one.
