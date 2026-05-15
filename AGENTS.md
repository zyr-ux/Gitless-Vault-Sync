# Agents

This file provides guidance for AI coding agents (such as GitHub Copilot, Claude, Codex, Cursor, etc.) working in this repository.

For full contribution rules, conventions, and setup instructions, read **[CONTRIBUTING.md](CONTRIBUTING.md)** first. Everything in that document applies to AI-generated changes equally.

---

## Key files to understand before making changes

| File | Purpose |
|---|---|
| `src/main.ts` | Plugin entry point — owns lifecycle, event registration, sync queue |
| `src/settings.ts` | Settings schema and defaults — any new setting must be added here |
| `src/github/GitHubClient.ts` | All GitHub REST API calls — do not call `fetch` directly anywhere else |
| `src/sync/SyncEngine.ts` | Core sync logic — three-way merge, conflict resolution, sync batching |
| `src/sync/IndexStore.ts` | Sync index schema and persistence — do not read/write `data.json` outside this class |
| `src/sync/IgnoreMatcher.ts` | Glob-to-regex path filtering |
| `ARCHITECTURE.md` | Deep-dive into module architecture, data flow, and the release workflow |

---

## Hard rules — never violate these

- **Do not modify `manifest.json` version or `versions.json`** — these are managed exclusively by the release workflow on tag push.
- **Do not commit `main.js`** — it is in `.gitignore` and must never be committed.
- **Do not add runtime `dependencies` to `package.json`** — the plugin runs in a browser-like environment inside Obsidian; only `devDependencies` (build tools, type definitions) are acceptable.
- **Do not use Node.js built-ins at runtime** (e.g. `fs`, `path`) — the only exception is `os.hostname()` in `detectDeviceName()` which is guarded by `Platform.isDesktop`.
- **Do not bypass `IndexStore`** — all reads and writes to the sync index must go through `IndexStore.load()` and `IndexStore.save()`.
- **Do not call the GitHub API outside `GitHubClient`** — all API interactions must go through the existing client methods or new methods added to that class.
- **Do not remove `.obsidian/plugins/gitless-vault-sync/data.json` from the `ALWAYS_IGNORE` list** in `SyncEngine.ts` — this file must never be uploaded to GitHub. (Note: The GitHub token is stored securely in the Obsidian keychain and is NOT in this file).

---

## Commit message format

```
<prefix>: <short description>
```

Accepted prefixes: `feat`, `fix`, `refactor`, `chore`, `docs`, `workflow`

Example: `fix: handle 409 on empty repository initialization`

---

## Architecture summary

The plugin is structured as a pipeline:

```
GitlessVaultSyncPlugin (orchestration)
  └── SyncEngine (three-way merge logic)
        ├── GitHubClient (REST API)
        ├── IndexStore (local sync index)
        └── IgnoreMatcher (path filtering)
```

Settings and the sync index are co-persisted in Obsidian's `data.json` under a single `{ settings, index }` envelope (the **GitHub token** is an exception and is stored securely in the keychain). See [ARCHITECTURE.md](ARCHITECTURE.md) for full details including the sync algorithm, conflict resolution rules, and the sync batching strategy.
