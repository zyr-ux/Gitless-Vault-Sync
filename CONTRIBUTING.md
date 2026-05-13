# Contributing to Vault Sync

Thank you for your interest in contributing! This document covers everything you need to get the project running locally, the conventions used throughout the codebase, and the process for submitting changes.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Conventions](#coding-conventions)
- [Making Changes](#making-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Release Process](#release-process)

---

## Development Setup

### Prerequisites

- **Node.js** ≥ 18 (20 recommended)
- **npm** ≥ 9
- An Obsidian vault for local testing

### Steps

1. **Clone the repository**

   ```bash
   git clone https://github.com/<your-fork>/vault-sync.git
   cd vault-sync
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Link to your vault for live testing**

   Symlink (or copy) the project folder into your vault's plugin directory:

   ```bash
   # Windows (run as Administrator)
   mklink /D "C:\path\to\vault\.obsidian\plugins\vault-sync" "C:\path\to\vault-sync"

   # macOS / Linux
   ln -s /path/to/vault-sync /path/to/vault/.obsidian/plugins/vault-sync
   ```

4. **Start the dev build watcher**

   ```bash
   npm run dev
   ```

   This compiles `src/main.ts` into `main.js` with inline source maps and watches for changes. Reload Obsidian (or use the **Reload app without saving** command) after each change.

5. **Production build**

   ```bash
   npm run build
   ```

   Produces a minified `main.js` with no source maps. This is what gets packaged in releases.

> [!NOTE]
> `main.js` is listed in `.gitignore` and is never committed. It is only produced at build time.

---

## Project Structure

```
src/
├── main.ts                 # Plugin entry point — lifecycle, event registration, sync orchestration
├── settings.ts             # Settings schema, defaults, and the settings UI tab
├── github/
│   └── GitHubClient.ts     # All GitHub REST API interactions
└── sync/
    ├── SyncEngine.ts       # Core three-way merge logic
    ├── IndexStore.ts       # Persistent sync index (co-stored in data.json with settings)
    └── IgnoreMatcher.ts    # Gitignore-style glob path filtering
```

For a deep-dive into how these modules interact, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Coding Conventions

### TypeScript

- **Strict mode is on** — no implicit `any`, no unchecked nulls. Keep it clean.
- Prefer `const` over `let`; avoid `var` entirely.
- Use `interface` for data shapes, `type` for unions/aliases.
- All async functions must be explicitly typed with their return type.
- Avoid casting with `as` unless there is no alternative; prefer type guards.

### Error handling

- Catch errors at the highest appropriate level (usually `VaultSyncPlugin.runNextSync`).
- Use the typed `GitHubApiError` class — do not swallow API errors silently.
- Always log unexpected errors with `console.error` before re-throwing or reporting.

### File I/O

- Always use Obsidian's `vault` API for file operations — never use Node `fs` at runtime (esbuild bundles for the browser target).
- Use `vault.readBinary` / `vault.modifyBinary` / `vault.createBinary` for all file types so binary files are handled correctly.

### Sync index

- Never mutate `IndexStore` directly outside of `SyncEngine`. All reads go through `IndexStore.load()` and all writes through `IndexStore.save()`.
- Do not store UI state or ephemeral data in `data.json` — it is the source of truth for sync state.

### Naming

- Classes: `PascalCase`
- Functions and variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE` for module-level values (e.g. `MAX_BLOB_BYTES`)
- Files: `PascalCase.ts` for class files, `camelCase.ts` otherwise

---

## Making Changes

### Branching

- Branch off `main` for all changes.
- Use a descriptive branch name, e.g. `fix/conflict-resolution-edge-case` or `feat/subfolder-support`.

### Commit messages

Use the following prefixes to keep the history readable:

| Prefix | When to use |
|---|---|
| `feat:` | New feature or behaviour |
| `fix:` | Bug fix |
| `refactor:` | Code change with no behaviour difference |
| `chore:` | Tooling, dependencies, config |
| `docs:` | Documentation only |
| `workflow:` | CI / release pipeline changes |

Example: `fix: handle 409 on empty repository initialization`

### What to keep in mind

- **Do not change `manifest.json` version or `versions.json` manually.** These are managed automatically by the release workflow when a tag is pushed.
- **Do not commit `main.js`.** It is in `.gitignore` for a reason.
- **Do not add runtime Node.js dependencies.** The plugin runs inside Obsidian's browser-like environment. Only devDependencies (build tools, types) are acceptable.
- **Always ignore `data.json`** — it is in the hardcoded `ALWAYS_IGNORE` list in `SyncEngine` and must stay excluded from sync.

---

## Submitting a Pull Request

1. Fork the repository and create your branch from `main`.
2. Make your changes following the conventions above.
3. Test manually in Obsidian on at least one platform (desktop or mobile).
4. Open a pull request against `main` with a clear description of what changed and why.
5. Reference any related issues in the PR body.

---

## Release Process

Releases are fully automated via the GitHub Actions workflow in `.github/workflows/release.yml`. As a contributor you do not need to manage releases — that is the maintainer's responsibility.

For reference, a release is triggered by pushing a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow then:
1. Bumps the version in `manifest.json`, `package.json`, and `versions.json`
2. Commits those changes back to `main`
3. Builds the plugin
4. Packages `Vault-Sync-v1.0.0.zip` containing the `vault-sync/` folder
5. Creates a GitHub Release with the zip attached

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full breakdown of the release workflow steps.
