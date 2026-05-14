# Gitless Vault Sync

> Sync your Obsidian vault to a GitHub repository — no Git installation required.

Gitless Vault Sync is an Obsidian community plugin that syncs your vault to a private or public GitHub repository using the **GitHub REST API** directly. It works on **desktop and mobile** without needing Git, a terminal, or any external tooling.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Setup](#setup)
  - [1. Create a GitHub Repository](#1-create-a-github-repository)
  - [2. Generate a GitHub Personal Access Token](#2-generate-a-github-personal-access-token)
  - [3. Install the Plugin](#3-install-the-plugin)
  - [4. Configure the Plugin](#4-configure-the-plugin)
- [Usage](#usage)
  - [Ribbon Icon](#ribbon-icon)
  - [Command Palette](#command-palette)
  - [Auto Sync on Edit](#auto-sync-on-edit)
  - [Auto Sync Interval](#auto-sync-interval)
  - [Auto Sync on Startup](#auto-sync-on-startup)
- [Settings Reference](#settings-reference)
- [Sync Logic](#sync-logic)
  - [Conflict Resolution](#conflict-resolution)
  - [File Deletions](#file-deletions)
  - [Ignored Files](#ignored-files)
  - [File Size Limit](#file-size-limit)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)

---

## Features

- **Bi-directional sync** — push local changes and pull remote changes in one operation
- **No Git required** — communicates with GitHub via the REST API; works on mobile too
- **Auto sync on edit** — debounced sync is triggered automatically when you save a file
- **Auto sync interval** — configurable background polling to keep your vault in sync
- **Auto sync on startup** — optionally sync with remote as soon as Obsidian loads
- **Repository path prefix** — store your vault inside a subfolder of the repo
- **Configurable notice levels** — suppress noisy notifications during background sync
- **Cross-platform** — tested on Windows, macOS, Linux, iOS, and Android
- **Auto-initialize empty repos** — the plugin handles the very first commit for you
- **Auto-detect device name** — used in commit messages so you know which device pushed

---

## How It Works

Gitless Vault Sync maintains a local **sync index** (stored in `data.json`) that tracks which files have been synced and their last-known remote SHA. On each sync, it:

1. Fetches the latest commit and file tree from GitHub
2. Compares local files against the remote snapshot and the index
3. Determines what to upload, download, or delete
4. Batches all uploads into a single Git tree/commit, minimizing API calls
5. Updates the local index to reflect the new state

This approach is fast, atomic on the push side, and works without ever calling `git` locally.

When multiple devices sync around the same time, Gitless Vault Sync retries on non-fast-forward errors and re-plans the sync so it can complete cleanly without leaving partial state.

---

## Setup

### 1. Create a GitHub Repository

Create a new **private** (recommended) or public repository on GitHub to use as your vault's remote. It can be completely empty — Vault Sync will initialize it automatically on the first push.

> [!TIP]
> Using a **private** repository keeps your notes confidential.

### 2. Generate a GitHub Personal Access Token

Vault Sync authenticates with GitHub using a **Fine-grained Personal Access Token (PAT)**.

1. Go to **GitHub → Settings → Developer Settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set a name (e.g. `Obsidian Vault Sync`) and an expiration date
4. Under **Repository access**, select **Only select repositories** and choose your vault repo
5. Under **Permissions → Repository permissions**, grant:
   - **Contents** → `Read and write`
   - **Metadata** → `Read-only` *(required automatically)*
6. Click **Generate token** and **copy the token immediately** — you won't see it again

> [!CAUTION]
> Never share your PAT. It grants write access to your repository.

### 3. Install the Plugin

Since this plugin is not yet on the Obsidian community plugin directory, install it manually via the GitHub Releases page:

1. Go to the [**Releases**](../../releases/latest) page of this repository
2. Under the latest release, download `Gitless-Vault-Sync-vX.X.X.zip`
3. Extract the zip — you will get a folder named `gitless-vault-sync`
4. Move the `gitless-vault-sync` folder into `.obsidian/plugins/` inside your vault
5. In Obsidian, go to **Settings → Community plugins → Installed plugins** and enable **Gitless Vault Sync**

> [!NOTE]
> You may need to enable **Community plugins** first under Settings → Community plugins → Turn on community plugins.

**Updating to a newer version:**

1. Download the new `Gitless-Vault-Sync-vX.X.X.zip` from the Releases page
2. Extract it and replace the contents of your existing `gitless-vault-sync` folder
3. Reload Obsidian (or disable and re-enable the plugin)

### 4. Configure the Plugin

Open **Settings → Gitless Vault Sync** and fill in the following fields:

| Setting | Description |
|---|---|
| **GitHub token** | Your fine-grained PAT (stored locally in `data.json`, never transmitted elsewhere) |
| **Repository owner** | Your GitHub username or organization. **Leave blank** to auto-detect from the PAT. |
| **Repository name** | The name of your vault repository (e.g. `my-vault`) |
| **Branch** | Branch to sync against. Defaults to `main`. |
| **Repository path prefix** | Optional — if your vault lives inside a subfolder of the repo (e.g. `notes/`) |
| **Device name** | Label used in commit messages. **Leave blank** to auto-detect (hostname on desktop, "iOS"/"Android" on mobile) |

That's it — no `git init`, no terminal. Click the GitHub ribbon icon to do your first sync.

---

## Usage

### Ribbon Icon

Click the **GitHub icon** in the left ribbon to perform a full **Sync** (pull + push). This is the most common operation: it fetches any remote changes and pushes any local changes in a single step.

Manual syncs show a short **"Syncing notes"** spinner notice that disappears once the sync completes. This is visible on both **desktop and mobile**.

### Command Palette

Open the command palette (`Ctrl/Cmd + P`) and search for **Gitless Vault Sync** to access these commands:

| Command | Description |
|---|---|
| `Gitless Vault Sync: Sync now` | Full bidirectional sync (pull + push) |
| `Gitless Vault Sync: Open Gitless Vault Sync settings` | Open the settings tab directly |

### Auto Sync on Edit

Whenever you **create, modify, delete, or rename** a file in your vault, a sync is automatically scheduled. There is a configurable **debounce delay** (default: 3 seconds) to batch rapid edits into a single sync instead of syncing on every keystroke.

> [!NOTE]
> The debounce window restarts on each file event. A sync only fires after the delay passes with no further changes.

### Auto Sync Interval

Set **Auto sync interval (sec)** in settings to a positive number (e.g. `60` for every minute). The plugin will silently perform a full sync on that interval, keeping your vault up to date across devices.

Set the value to `0` to disable automatic polling.

> [!NOTE]
> Background syncs run quietly and do not show the manual sync spinner.

### Auto Sync on Startup

Enable **Auto sync on startup** to automatically sync with GitHub when Obsidian loads. This ensures your vault is up to date before you start editing.

---

## Settings Reference

| Setting | Default | Description |
|---|---|---|
| **GitHub token** | *(empty)* | Fine-grained PAT with Contents read/write permission |
| **Repository owner** | *(empty)* | GitHub username/org. Auto-detected from PAT if blank. |
| **Repository name** | *(empty)* | Name of the target GitHub repository |
| **Branch** | `main` | Branch to sync against |
| **Repository path prefix** | *(empty)* | Subfolder within the repo (e.g. `notes/`). Leave blank for root. |
| **Device name** | *(auto)* | Label in commit messages. Auto-detected if blank. |
| **Auto sync interval (sec)** | `60` | Seconds between background syncs. `0` disables polling. |
| **Notice level** | `ALL` | Controls which notices are shown: `ALL`, `WARNING`, or `ERROR` |
| **Hide Success Message** | Off | Suppress the confirmation notice after a successful sync |
| **Auto sync on startup** | On | Pull from remote when Obsidian starts |

### Notice Levels Explained

| Level | What you see |
|---|---|
| `ALL` | Every sync event, including successful operations |
| `WARNING` | Only warnings (e.g. skipped files) and errors |
| `ERROR` | Only error notices — sync runs silently in the background |

---

## Sync Logic

### Conflict Resolution

Vault Sync uses a **timestamp-based** conflict resolution strategy:

- If a file was changed **both locally and remotely** since the last sync, the version with the **newer modification time** wins.
  - Local mtime > remote commit time → **upload** local version
  - Remote commit time > local mtime → **download** remote version

Vault Sync adjusts local timestamps using the GitHub server time to reduce incorrect decisions caused by device clock drift.

This is a simple, last-write-wins approach. It works well for personal note-taking workflows where you typically edit on one device at a time.

### File Deletions

- If you **delete a file locally** and it has not changed remotely since the last sync, the file is **deleted from GitHub** on the next push.
- If a file was **deleted remotely** and hasn't changed locally, it is **deleted from your vault** on the next pull.
- If a file was deleted locally but **also changed remotely** after the deletion, the remote version is restored (safe recovery).
- If a file was deleted remotely but **also changed locally** before the next sync, the local version is re-uploaded (local changes win).

### Ignored Files

The following paths are always excluded from sync (where `{configDir}` is your vault's config folder, typically `.obsidian`):

```
{configDir}/workspace
{configDir}/workspace.json
{configDir}/workspace-mobile.json
{configDir}/cache
{configDir}/logs
.git/**
.stfolder/**
.gitless-vault-sync-init
.trash
.DS_Store
{configDir}/plugins/gitless-vault-sync/data.json
{configDir}/plugins/**/data.json
```

Vault Sync also supports custom **Ignore patterns** in settings. These follow `.gitignore` rules:
- Patterns with a slash (like `folder/file.md` or `/root.md`) are **root-relative**.
- Simple patterns (like `node_modules` or `*.tmp`) are **basename matches** and apply anywhere in the vault.
- `**` can be used to match multiple directory levels.

> [!IMPORTANT]
> `data.json` (the plugin's sync index and settings, including your token) is always excluded. It is **never uploaded to GitHub**.

Everything else under `.obsidian/` is synced by default, including themes, plugins, snippets, and configuration JSON files.

### File Size Limit

Files larger than **100 MB** are skipped and reported in the console. This matches GitHub's file size limit for the Git Data API. A warning notice is shown if any files are skipped during a sync.

---

## Limitations

- **No merge / diff** — conflict resolution is last-write-wins based on timestamps
- **Single branch** — all syncs target one configured branch; branching workflows are not supported
- **No binary diff** — binary files are uploaded as full blobs each time they change
- **GitHub only** — the plugin is designed specifically for the GitHub REST API; other hosts are not supported
- **Rate limits** — GitHub API rate limits apply. Large vaults or very frequent syncs may hit them. Vault Sync retries with backoff and reports the reset time in the notice when it still fails.

---

## Contributing

Contributions are welcome! Before opening a pull request, please read [**CONTRIBUTING.md**](CONTRIBUTING.md) for:

- Local development setup and build instructions
- Coding conventions and naming rules
- Commit message format
- What must never be changed (version files, `main.js`, etc.)

For a deep-dive into how the plugin is structured internally, see [**ARCHITECTURE.md**](ARCHITECTURE.md).

If you are using an AI coding agent to contribute, it should read [**AGENTS.md**](AGENTS.md) first — it contains hard rules specific to this codebase.

---

## Acknowledgements

This plugin was heavily inspired by — and would not exist without — **[Obsidian GitHub Sync](https://github.com/kevinmkchin/Obsidian-GitHub-Sync)** by [Kevin Chin](https://kevin.gd/). I frequently used his plugin to sync my notes across devices but the lack of mobile integration led me to create this plugin. Whats different from that plugin is, his plugin uses git and git commands to sync file changes but this plugin uses github's rest APIs directly leading to full compatbility across desktop and mobile.

The key differences in Vault Sync are:

- Uses the **GitHub REST API** directly (no local Git binary needed — works on mobile)
- Maintains a **local sync index** for smarter conflict and deletion handling
- Supports **auto sync on edit** with a debounce window
- Supports storing the vault in a **repository subfolder**
- Auto-detects the **repository owner** from the PAT (no need to fill it in manually)
- Auto-initializes **empty repositories** on the first sync

---

*Built with ❤️ for Obsidian.*
