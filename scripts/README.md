# TalkEcho Scripts

This directory contains utility scripts for maintaining the TalkEcho project.

## Release Script

**Location**: `scripts/release.cjs`

Runs an entire release in one command: preflight checks → version bump → local
build → push → tag → GitHub Release with the installers attached.

### Usage

```bash
npm run release <new-version>
```

### Examples

```bash
npm run release 0.1.9                     # the whole thing
npm run release 0.1.9 -- --dry-run        # print every step, change nothing
npm run release 0.1.9 -- --skip-build     # reuse installers already in target/
npm run release 0.1.9 -- --draft          # publish the release as a draft
```

### What it does

1. **Preflight** — verifies you are on `main`, the working tree is clean, `gh` is
   installed and authenticated, and no release with that tag exists yet. It also
   resolves the push remote *by URL*, so it can never push to `upstream`
   (iamsrikanthnani/pluely) by mistake.
2. **Bump** — delegates to `bump-version.cjs` (skipped if already at that version).
3. **Build** — `npm run tauri build`.
4. **Verify** — checks that both installers actually landed in
   `src-tauri/target/release/bundle/{nsis,msi}/` and prints their sizes.
5. **Push** — pushes `main`.
6. **Tag** — creates `v<version>` *on the bump commit* and pushes it. It refuses
   to tag if `package.json` at HEAD disagrees with the version being released.
7. **Publish** — `gh release create` with `--generate-notes`, uploading the
   `.exe`, the `.msi`, and any `.sig` files if updater signing is ever enabled.

The script is resumable: if it fails partway through, re-running the same command
detects and skips the steps that already succeeded.

### Options

- `--dry-run`: print every command without executing the ones that change state
- `--skip-build`: don't rebuild, use whatever is already in `target/`
- `--draft`: create the GitHub Release as a draft
- `--allow-dirty`: proceed with an unclean working tree
- `--allow-branch`: release from a branch other than `main`

### Notes

- Releases are cut from **`main`**. The `master` branch is a mirror of the
  upstream Pluely repo — `.github/workflows/publish.yml` only triggers on pushes
  to `master`, so it is inherited from upstream and plays no part in TalkEcho
  releases.
- If `src-tauri/.env` is missing, the build still succeeds but `API_ACCESS_KEY`,
  `PAYMENT_ENDPOINT`, `APP_ENDPOINT` and `POSTHOG_API_KEY` compile to empty
  values (they are read through `option_env!`), disabling activation, payment
  and analytics in the shipped binary. The script warns when this is the case.

## Version Bump Script

**Location**: `scripts/bump-version.cjs`

Automatically updates the version number across all necessary files in the project.
`release.cjs` calls this for you — run it directly only when you want to bump
without releasing.

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
   git push talkecho main
   ```

3. Create and push a git tag — **on the bump commit, not before it**:
   ```bash
   git tag v0.1.3
   git push talkecho v0.1.3
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
   git push talkecho v0.1.3
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
