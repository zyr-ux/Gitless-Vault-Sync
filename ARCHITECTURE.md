# Vault Sync — Architecture

This document describes the internal architecture of the Vault Sync Obsidian plugin and the automated release workflow used to build and publish new versions.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Repository Layout](#repository-layout)
3. [Module Architecture](#module-architecture)
   - [Entry Point — `VaultSyncPlugin`](#entry-point--vaultsyncplugin)
   - [Settings — `VaultSyncSettings` & `VaultSyncSettingTab`](#settings--vaultsyncsettings--vaultsyncsettingtab)
   - [GitHub API Layer — `GitHubClient`](#github-api-layer--githubclient)
   - [Sync Engine — `SyncEngine`](#sync-engine--syncengine)
   - [Index Store — `IndexStore`](#index-store--indexstore)
   - [Ignore Matcher — `IgnoreMatcher`](#ignore-matcher--ignorematcher)
4. [Data Flow](#data-flow)
   - [Plugin Startup](#plugin-startup)
   - [Sync Lifecycle](#sync-lifecycle)
   - [Conflict Resolution](#conflict-resolution)
   - [Push Path (Upload)](#push-path-upload)
   - [Pull Path (Download)](#pull-path-download)
5. [Versioning Files](#versioning-files)
6. [Build System](#build-system)
7. [Release Workflow](#release-workflow)
   - [Trigger](#trigger)
   - [Steps Breakdown](#steps-breakdown)
   - [Version Bumping Logic](#version-bumping-logic)
   - [Release Artifact Structure](#release-artifact-structure)

---

## Project Overview

Vault Sync is an Obsidian plugin that synchronises a vault's files with a GitHub repository using the **GitHub REST API directly** — no `git` binary, no shell, no local clone required. It works by comparing a local sync index against the remote Git tree and reconciling differences using a last-write-wins strategy.

---

## Repository Layout

```
Vault Sync/
├── .github/
│   └── workflows/
│       └── release.yml         # Automated release workflow
├── src/
│   ├── main.ts                 # Plugin entry point & orchestration
│   ├── settings.ts             # Settings schema, defaults, UI tab
│   ├── github/
│   │   └── GitHubClient.ts     # GitHub REST API client
│   └── sync/
│       ├── SyncEngine.ts       # Core sync logic & conflict resolution
│       ├── IndexStore.ts       # Persistent local sync index
│       └── IgnoreMatcher.ts    # Gitignore-style path filtering
├── esbuild.config.mjs          # Build configuration
├── manifest.json               # Obsidian plugin manifest
├── package.json                # npm metadata & scripts
├── versions.json               # Version → minAppVersion compatibility map
├── styles.css                  # Plugin CSS (injected into Obsidian)
└── tsconfig.json               # TypeScript compiler config
```

---

## Module Architecture

```
┌─────────────────────────────────────┐
│          VaultSyncPlugin            │  ← Obsidian Plugin lifecycle
│   (onload / onunload / commands)    │
└──────┬──────────────────────────────┘
       │ owns
       ├──────────────────┬────────────────────────────┐
       ▼                  ▼                            ▼
┌─────────────┐   ┌──────────────┐            ┌──────────────┐
│  IndexStore │   │  SyncEngine  │            │ GitHubClient │
│  (data.json)│◄──│  (logic)     │───────────►│  (REST API)  │
└─────────────┘   └──────────────┘            └──────────────┘
                        │
                        ▼
                  ┌─────────────┐
                  │IgnoreMatcher│
                  └─────────────┘
```

---

### Entry Point — `VaultSyncPlugin`

**File:** `src/main.ts`

`VaultSyncPlugin` extends Obsidian's `Plugin` class and acts as the top-level orchestrator. It is responsible for:

- **Loading and saving settings** — merging persisted data with defaults via `normalizePluginData`.
- **Device name detection** — on first load, if `deviceName` is blank, `detectDeviceName()` is called. It attempts `os.hostname()` on desktop, falls back to User-Agent parsing, and uses platform constants (`Platform.isAndroidApp`, `Platform.isIosApp`) on mobile.
- **Instantiating subsystems** — creates `IndexStore`, `GitHubClient`, and `SyncEngine`.
- **Registering Obsidian hooks:**
  - Ribbon icon (GitHub icon) → triggers `sync` mode.
  - Commands: `Sync now`, `Pull from GitHub`, `Push to GitHub`, `Open Vault Sync settings`.
  - Vault events: `modify`, `create`, `delete`, `rename` on any `TFile` → triggers debounced push.
- **Auto-pull timer** — starts a `setInterval` that fires a pull on the configured interval (default 60 s). Restarted any time settings change.
- **Sync-on-start** — if `syncOnStart` is enabled, queues a pull immediately after load.
- **Foreground pull** — on mobile, a pull is requested when Obsidian becomes active again (debounced) to compensate for background timer throttling.

#### Sync request queuing

To avoid concurrent syncs, the plugin uses a simple in-flight guard with a pending-mode queue:

```
requestSync(mode)
  └─ mergeModes(pendingMode, mode) → "sync" wins over "push"/"pull"
       └─ runNextSync()
             ├─ if syncInFlight → return (will retry in finally block)
             └─ set syncInFlight = true → call SyncEngine → finally { syncInFlight = false; runNextSync() }
```

`mergeModes` promotes any conflicting pair to `"sync"` (bidirectional) — e.g. if a pull is pending and a push arrives, it becomes a full sync.

---

### Settings — `VaultSyncSettings` & `VaultSyncSettingTab`

**File:** `src/settings.ts`

#### Schema

| Field | Type | Default | Purpose |
|---|---|---|---|
| `githubToken` | `string` | `""` | PAT with `repo` scope |
| `repoOwner` | `string` | `""` | GitHub user/org; blank = auto-detect via `/user` |
| `repoName` | `string` | `""` | Target repository name |
| `branch` | `string` | `"main"` | Branch to sync against |
| `repoPathPrefix` | `string` | `""` | Optional subfolder in the repo root |
| `deviceName` | `string` | `""` | Used in commit messages; auto-detected if blank |
| `debounceMs` | `number` | `3000` | Delay after last file change before auto-push |
| `syncIntervalSec` | `number` | `60` | Auto-pull interval; `0` disables |
| `ignorePatterns` | `string[]` | (see below) | Gitignore-style paths to exclude |
| `noticeLevel` | `"ALL"\|"WARNING"\|"ERROR"` | `"ALL"` | Controls which Obsidian notices are shown |
| `showSyncSuccessNotice` | `boolean` | `true` | Whether a success toast is shown |
| `syncOnStart` | `boolean` | `true` | Pull on Obsidian startup |

**Default ignore patterns:** `.obsidian/workspace`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/cache`, `.obsidian/logs`, `.trash`, `.DS_Store`

All other `.obsidian/` content (themes, plugins, snippets, config JSON files) is synced by default, except for the always-ignored files listed in the Sync Engine section.

Settings and the sync index are co-persisted in Obsidian's `data.json` under a single `PluginData` envelope `{ settings, index }`, managed by `normalizePluginData` to handle schema migrations gracefully.

---

### GitHub API Layer — `GitHubClient`

**File:** `src/github/GitHubClient.ts`

A self-contained REST client that talks exclusively to `https://api.github.com`. It uses the browser `fetch` API (Obsidian exposes this on all platforms).

#### Owner resolution

If `repoOwner` is left blank in settings, the client calls `GET /user` once and caches the result in `this.cachedOwner` for the session. This allows the PAT alone to be sufficient for most setups.

#### Key methods

| Method | API call | Purpose |
|---|---|---|
| `getBranchRef()` | `GET /git/ref/heads/{branch}` | Get tip commit SHA |
| `getCommit(sha)` | `GET /git/commits/{sha}` | Fetch commit metadata (tree SHA, timestamp) |
| `getTree(sha)` | `GET /git/trees/{sha}?recursive=1` | Flat list of all blobs in the tree |
| `getLatestSnapshot()` | (above three combined) | Returns `{ commitSha, commitTime, treeSha, files[] }` |
| `getBlob(sha)` | `GET /git/blobs/{sha}` | Fetch raw file content (base64 or utf-8) |
| `createBinaryBlob(data)` | `POST /git/blobs` | Upload file content, get blob SHA |
| `createTree(base, entries)` | `POST /git/trees` | Create new Git tree from base + delta |
| `createCommit(msg, tree, parents)` | `POST /git/commits` | Create commit object |
| `updateBranchRef(sha)` | `PATCH /git/refs/heads/{branch}` | Fast-forward branch to new commit |
| `createBranchRef(sha)` | `POST /git/refs` | Create branch for the first time |
| `initializeRepository()` | `PUT /contents/.vault-sync-init` | Bootstrap an empty repo with a placeholder file |

#### Path prefix support

If `repoPathPrefix` is set (e.g. `notes/`), all paths are prefixed on upload (`addPrefix`) and the prefix is stripped on download (`stripPrefix`). Files outside the prefix in the repo are invisible to the plugin.

#### Error handling

All non-2xx responses are parsed into a typed `GitHubApiError` that surfaces:
- HTTP status code
- GitHub's error message body
- `x-github-request-id` for debugging
- `retry-after` (for abuse rate limits)
- `x-ratelimit-reset` (for primary rate limits, converted to ms epoch)

The client retries on rate-limited responses (429/403 with reset headers) with a bounded backoff. It also tracks the GitHub server time from the `Date` response header so the sync engine can compensate for clock skew.

---

### Sync Engine — `SyncEngine`

**File:** `src/sync/SyncEngine.ts`

The `SyncEngine` is the brain of the plugin. It implements a three-way merge between the **local vault**, the **remote Git tree**, and a **local sync index** (the last known agreed-upon state).

The three public methods are thin wrappers over a single private `runSync(options)`:

```ts
sync()  → runSync({ allowPull: true,  allowPush: true  })
pull()  → runSync({ allowPull: true,  allowPush: false })
push()  → runSync({ allowPull: false, allowPush: true  })
```

#### Always-ignore list

Regardless of user settings, these paths are always excluded from sync:

```
.obsidian/workspace
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.obsidian/logs
.trash
.DS_Store
.obsidian/plugins/vault-sync/data.json   ← prevents syncing the plugin's own state
```

#### Empty repository bootstrap

If `getRemoteSnapshot()` returns an empty result (404 or 409 on a brand-new repo) and a push is allowed, `initializeRepository()` is called to create a placeholder `.vault-sync-init` file so the branch and first commit exist. The init file is then queued for deletion in the same sync run.

#### Push retry

Pushes are prepared from a snapshot of the remote tree. If the branch advances during the push, `updateBranchRef` returns a non-fast-forward error. The engine treats this as a stale-head signal, re-fetches the snapshot, re-plans, and retries a small number of times.

#### Incremental index saves

The index is persisted after successful push work and incrementally after downloads/deletions. This avoids losing partial work if the sync is interrupted.

#### Concurrency

Uploads and downloads run through a small concurrency pool to improve throughput without overwhelming mobile devices.

#### File size limit

Files larger than **100 MB** are skipped and counted in `SyncResult.skipped`. Their paths are logged to the console.

---

### Index Store — `IndexStore`

**File:** `src/sync/IndexStore.ts`

The index is a `SyncIndexState` — a flat map of vault path → `SyncIndexEntry`:

```ts
interface SyncIndexEntry {
  path: string;
  remoteSha: string;           // Git blob SHA of last known remote version
  lastSynced: number;          // Timestamp of last successful sync (ms)
  lastRemoteCommitTime: number; // Commit timestamp of last known remote state (ms)
  localMtime: number;          // mtime of file at last sync
  deletedLocally?: boolean;    // True if file was deleted locally since last sync
  localDeletedAt?: number;     // Timestamp of local deletion
}
```

This is persisted inside Obsidian's `data.json` alongside settings under the key `index`. `normalizePluginData` handles the case where old data stored settings at the top level (migration from a flat format).

---

### Ignore Matcher — `IgnoreMatcher`

**File:** `src/sync/IgnoreMatcher.ts`

Converts gitignore-style glob patterns to `RegExp` objects. Supports:
- `*` — matches any character except `/`
- `**` — matches anything including `/`
- `?` — matches any single character except `/`
- Trailing `/` — expanded to `/**` (matches directory and all contents)

Paths are normalised to forward-slash format before matching.

---

## Data Flow

### Plugin Startup

```
onload()
  ├─ loadSettings()                    → merge data.json with DEFAULT_SETTINGS
  │    └─ detectDeviceName()           → hostname / platform / UA fallback
  ├─ addSettingTab()
  ├─ registerCommands()
  ├─ addRibbonIcon()
  ├─ initializeSync()                  → new IndexStore, GitHubClient, SyncEngine
  ├─ registerVaultEvents()             → modify/create/delete/rename → schedulePush()
  ├─ startAutoPull()                   → setInterval → requestSync("pull")
  └─ if syncOnStart → requestSync("pull")
```

### Sync Lifecycle

```
requestSync(mode)
  └─ pendingMode = mergeModes(pendingMode, mode)
       └─ runNextSync()
             ├─ guard: syncInFlight? → return
             ├─ capture and clear pendingMode
             ├─ syncInFlight = true
             ├─ SyncEngine.pull() / push() / sync()
             │     └─ runSync(options)
             │           ├─ load IndexStore
             │           ├─ collectLocalFiles (filtered by IgnoreMatcher)
             │           ├─ getRemoteSnapshot (branch ref → commit → tree)
             │           ├─ classify every file → toDownload / toUpload / toDeleteLocal / toDeleteRemote
             │           ├─ execute downloads (writeRemoteFile)
             │           ├─ execute uploads (createBinaryBlob → createTree → createCommit → updateBranchRef)
             │           └─ save updated IndexStore
             ├─ show notice (if requested)
             └─ finally: syncInFlight = false → runNextSync() (drain queue)
```

### Conflict Resolution

For each file that exists in the index, the engine evaluates two boolean flags:
- `localChanged` = `file.stat.mtime > entry.localMtime`
- `remoteChanged` = `entry.remoteSha !== remote.sha`

| localChanged | remoteChanged | Action |
|:---:|:---:|---|
| ✗ | ✗ | No-op |
| ✓ | ✗ | Upload local → remote |
| ✗ | ✓ | Download remote → local |
| ✓ | ✓ | **Last write wins:** if `local.mtime >= snapshot.commitTime` → upload, else download |

For files **locally deleted** since the last sync:
- If the remote has changed since the deletion timestamp → **restore from remote** (remote wins)
- Otherwise → **delete from remote** (local deletion wins)

For files **not in the index** at all:
- Remote-only → download
- Local-only → upload
- Both present, no index → use last-write-wins on `mtime` vs `commitTime`

### Push Path (Upload)

All uploads in a single sync run are batched into **one commit**:

1. Read each file as `ArrayBuffer` via `vault.readBinary()`
2. `POST /git/blobs` for each file → collect blob SHAs
3. `POST /git/trees` with all blob entries (deletions use `sha: null`) on top of `baseTreeSha`
4. `POST /git/commits` with the new tree SHA and current HEAD as parent
5. `PATCH /git/refs/heads/{branch}` to advance the branch pointer

This means N file changes = exactly 1 commit, regardless of file count.

### Pull Path (Download)

Downloads are executed file-by-file:
1. `GET /git/blobs/{sha}` → returns `{ content, encoding }`
2. If `encoding === "base64"` → decode to `ArrayBuffer` and write via `vault.modifyBinary()` or `vault.createBinary()`
3. Otherwise write as UTF-8 text via `vault.modify()` or `vault.create()`
4. Parent folders are created recursively if missing

---

## Versioning Files

Three files must stay in sync with each other and all are updated automatically by the release workflow:

| File | Field | Example | Reader |
|---|---|---|---|
| `manifest.json` | `"version"` | `"1.0.0"` | Obsidian (displayed in plugin list) |
| `package.json` | `"version"` | `"1.0.0"` | npm tooling |
| `versions.json` | key entry | `"1.0.0": "1.5.0"` | Obsidian (compatibility check) |

`versions.json` maps each released version to the minimum Obsidian app version required to run it. When bumping, the new version inherits the `minAppVersion` currently set in `manifest.json`. To change the minimum Obsidian requirement for future releases, update `manifest.json`'s `minAppVersion` field manually before tagging.

---

## Build System

**File:** `esbuild.config.mjs`

| Mode | Command | Output |
|---|---|---|
| Development | `npm run dev` | `main.js` with inline source maps, no minification, watching for changes |
| Production | `npm run build` | `main.js` minified, no source maps |

Entry point: `src/main.ts` → bundled as CommonJS, targeting ES2018, for `platform: "browser"`. The `obsidian` module is marked external (provided by the host at runtime).

`main.js` is listed in `.gitignore` — it is never committed to the repository and is only produced during CI.

---

## Release Workflow

**File:** `.github/workflows/release.yml`

### Trigger

The workflow fires on any tag push matching the pattern `v[0-9]+.[0-9]+.[0-9]+` (e.g. `v1.0.0`, `v2.3.11`). To publish a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The `v` prefix is part of the tag name and the zip filename, but is **stripped** for the version string written into the JSON files (Obsidian does not expect a `v` prefix in `manifest.json`).

### Steps Breakdown

| Step | Name | What it does |
|---|---|---|
| 1 | Checkout repository | Full clone (`fetch-depth: 0`) using `GITHUB_TOKEN` so the bot can push back |
| 2 | Set up Node.js | Installs Node 20 on the runner |
| 3 | Extract version from tag | Splits `v1.0.0` → `tag=v1.0.0`, `version=1.0.0`; outputs both as step outputs |
| 4 | Bump versions | Reads and rewrites `manifest.json`, `package.json`, `versions.json` using inline Node.js |
| 5 | Commit and push | Commits the three bumped files as `workflow: bumped version to 1.0.0` and force-pushes to `main` |
| 6 | Install dependencies | `npm ci` — uses `package-lock.json` for reproducible installs |
| 7 | Build plugin | `npm run build` → produces `main.js` in the repo root |
| 8 | Package release zip | Creates `vault-sync/` with the four distributable files and zips it as `Vault-Sync-v1.0.0.zip` |
| 9 | Create GitHub Release | Uses `softprops/action-gh-release@v2` to create a release on the tag and attach the zip |

### Version Bumping Logic

The bump step runs three separate Node.js one-liners in the same shell script:

1. **Read `minAppVersion`** from `manifest.json` before any edits (stored in a shell variable).
2. **`manifest.json`** — parse JSON, set `.version = NEW_VERSION`, write back with 2-space indent.
3. **`package.json`** — parse JSON, set `.version = NEW_VERSION`, write back.
4. **`versions.json`** — parse JSON, add `versions[NEW_VERSION] = MIN_APP_VERSION`, write back. The new entry is **appended** — all prior version entries are preserved.

The `NEW_VERSION` value is passed via the `env` block so it is safely available to all Node.js child processes as `process.env.NEW_VERSION`.

> **Note:** If your default branch is not `main`, update the `git push origin HEAD:main` line in step 5 to match.

### Release Artifact Structure

```
Vault-Sync-v1.0.0.zip
└── vault-sync/
    ├── main.js          ← compiled plugin bundle
    ├── manifest.json    ← plugin metadata (version, id, name, minAppVersion)
    ├── styles.css       ← plugin stylesheet
    └── versions.json    ← version compatibility history
```

Users install by extracting the zip into `.obsidian/plugins/` in their vault. The `vault-sync` folder name matches the plugin `id` field in `manifest.json`, which is the directory name Obsidian uses to load the plugin.
