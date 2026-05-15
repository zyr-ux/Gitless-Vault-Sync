import { Notice, Platform, Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  GitlessVaultSyncSettingTab,
  type GitlessVaultSyncSettings
} from "./settings";
import { ensureEntry, normalizePluginData } from "./sync/IndexStore";
import { GitHubApiError, GitHubClient } from "./github/GitHubClient";
import { IndexStore } from "./sync/IndexStore";
import { IgnoreMatcher } from "./sync/IgnoreMatcher";
import { SyncEngine, type SyncResult } from "./sync/SyncEngine";

type NoticeSeverity = "INFO" | "WARNING" | "ERROR";

const FOREGROUND_SYNC_COOLDOWN_MS = 15000;
const MIN_SYNC_COOLDOWN_MS = 30000;
const ABUSE_PAUSE_DURATION_MS = 15 * 60 * 1000;

export default class GitlessVaultSyncPlugin extends Plugin {
  settings!: GitlessVaultSyncSettings;
  private githubClient?: GitHubClient;
  private syncEngine?: SyncEngine;
  private indexStore?: IndexStore;
  private debounceTimer: number | null = null;
  private intervalId: number | null = null;
  private settingsSaveTimer: number | null = null;
  private syncInFlight = false;
  private syncPending = false;
  private pendingNotice = false;
  private lastForegroundSyncAt = 0;
  private lastAutoSyncAt = 0;
  private pausedUntil = 0;
  private syncingNotice?: Notice;
  private suppressAutoPush = false;
  private eventIgnoreMatcher?: IgnoreMatcher;
  private isUnloaded = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new GitlessVaultSyncSettingTab(this.app, this));
    this.registerCommands();
    const ribbonIconEl = this.addRibbonIcon(
      "github",
      "Sync with Remote",
      () => {
        this.requestSync(true);
      }
    );
    ribbonIconEl.addClass("gitless-vault-sync-ribbon");
    this.initializeSync();
    this.registerVaultEvents();
    this.startAutoPull();
    if (this.settings.autoSync) {
      this.requestSync();
    } else {
      // Suppression of the immediate foreground pull from the initial active-leaf-change event.
      this.lastForegroundSyncAt = Date.now();
    }
  }

  onunload(): void {
    this.isUnloaded = true;
    this.clearTimers();
  }

  async loadSettings(): Promise<void> {
    const data = normalizePluginData(await this.loadData(), DEFAULT_SETTINGS);
    this.settings = data.settings;

    if (!Array.isArray(this.settings.ignorePatterns)) {
      this.settings.ignorePatterns = DEFAULT_SETTINGS.ignorePatterns.slice();
    }

    if (!this.settings.deviceName.trim()) {
      this.settings.deviceName = detectDeviceName();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    const data = normalizePluginData(await this.loadData(), DEFAULT_SETTINGS);
    data.settings = this.settings;
    await this.saveData(data);
    this.applySettings();
  }

  queueSaveSettings(): void {
    if (this.settingsSaveTimer) {
      window.clearTimeout(this.settingsSaveTimer);
    }

    this.settingsSaveTimer = window.setTimeout(() => {
      this.settingsSaveTimer = null;
      void this.saveSettings();
    }, 400);
  }

  private initializeSync(): void {
    this.indexStore = new IndexStore(this);
    this.githubClient = new GitHubClient({
      token: this.settings.githubToken,
      owner: this.settings.repoOwner,
      repo: this.settings.repoName,
      branch: this.settings.branch,
      pathPrefix: this.settings.repoPathPrefix
    });
    this.syncEngine = new SyncEngine(
      this.app,
      this.githubClient,
      this.indexStore,
      this.settings
    );
    this.rebuildEventIgnoreMatcher();
  }

  private applySettings(): void {
    if (!this.githubClient || !this.syncEngine) {
      return;
    }

    this.githubClient.updateOptions({
      token: this.settings.githubToken,
      owner: this.settings.repoOwner,
      repo: this.settings.repoName,
      branch: this.settings.branch,
      pathPrefix: this.settings.repoPathPrefix
    });
    this.syncEngine.updateSettings(this.settings);
    this.rebuildEventIgnoreMatcher();
    this.startAutoPull();
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          if (this.shouldIgnorePath(file.path)) {
            return;
          }
          this.schedulePush();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          if (this.shouldIgnorePath(file.path)) {
            return;
          }
          this.schedulePush();
          void this.markCreated(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          if (this.shouldIgnorePath(file.path)) {
            return;
          }
          this.schedulePush();
          void this.markDeleted(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          if (this.shouldIgnorePath(file.path) || this.shouldIgnorePath(oldPath)) {
            return;
          }
          this.schedulePush();
          if (oldPath) {
            void this.markRenamed(file, oldPath);
          }
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.requestForegroundPull();
      })
    );
  }

  private requestForegroundPull(): void {
    if (!this.settings.autoSync || this.settings.syncIntervalSec <= 0 || !this.isConfigured()) {
      return;
    }

    const now = Date.now();
    if (now - this.lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS) {
      return;
    }

    this.lastForegroundSyncAt = now;
    this.requestSync();
  }

  private startAutoPull(): void {
    this.clearInterval();

    if (!this.shouldAutoPull()) {
      return;
    }

    const scheduleNext = () => {
      if (this.isUnloaded) {
        return;
      }

      this.intervalId = window.setTimeout(async () => {
        if (this.isUnloaded) {
          return;
        }

        const start = Date.now();
        await this.requestSync();
        const duration = Date.now() - start;

        // Base interval + jitter (0-30s) - duration compensation
        const baseMs = this.settings.syncIntervalSec * 1000;
        const jitterMs = Math.random() * 30000;
        const nextDelay = Math.max(MIN_SYNC_COOLDOWN_MS, baseMs + jitterMs - duration);

        scheduleNext();
      }, this.settings.syncIntervalSec * 1000) as unknown as number;
    };

    scheduleNext();
  }

  private shouldAutoPull(): boolean {
    return (
      this.settings.autoSync &&
      this.settings.syncIntervalSec > 0 &&
      this.isConfigured()
    );
  }

  private schedulePush(): void {
    if (!this.settings.autoSync || !this.isConfigured()) {
      return;
    }

    if (this.suppressAutoPush) {
      return;
    }

    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(async () => {
      this.debounceTimer = null;
      if (this.syncEngine && (await this.syncEngine.hasLocalChanges())) {
        this.requestSync();
      }
    }, this.settings.debounceMs);
  }

  private requestSync(showNotice = false): void {
    if (!this.isConfigured() || !this.syncEngine) {
      if (showNotice) {
        this.showNotice("Gitless Vault Sync is not configured.", "WARNING");
      }
      return;
    }

    if (showNotice && this.pausedUntil > Date.now()) {
      const waitMins = Math.ceil((this.pausedUntil - Date.now()) / 60000);
      this.showNotice(
        `GitHub has temporarily rate-limited automated syncing. Manual sync may still fail until the cooldown expires (approx. ${waitMins}m).`,
        "WARNING",
        10000
      );
    }

    this.syncPending = true;
    this.pendingNotice = this.pendingNotice || showNotice;
    void this.runNextSync();
  }

  private async runNextSync(): Promise<void> {
    if (this.syncInFlight || !this.syncEngine) {
      return;
    }

    if (!this.syncPending) {
      return;
    }

    const isManual = this.pendingNotice;
    const now = Date.now();

    // Check abuse pause for automated syncs
    if (!isManual && this.pausedUntil > now) {
      this.syncPending = false;
      this.pendingNotice = false;
      return;
    }

    // Check independent cooldown for automated syncs
    if (!isManual && now - this.lastAutoSyncAt < MIN_SYNC_COOLDOWN_MS) {
      return; // Keep syncPending true to try again via debounce or interval
    }

    this.syncPending = false;
    const shouldNotify = this.pendingNotice;
    this.pendingNotice = false;
    this.syncInFlight = true;
    this.suppressAutoPush = true;

    if (shouldNotify) {
      this.showSyncingNotice();
    }

    try {
      const result = await this.syncEngine.sync();
      this.lastAutoSyncAt = Date.now();

      const hadSpinner = !!this.syncingNotice;
      this.hideSyncingNotice();
      if (hadSpinner) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }

      if (shouldNotify) {
        this.showSyncNotice(result);
      }
    } catch (error) {
      const hadSpinner = !!this.syncingNotice;
      this.hideSyncingNotice();
      if (hadSpinner) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }

      console.error("Gitless Vault Sync error details:", error);
      if (error instanceof GitHubApiError) {
        if (error.isAbuseLimit) {
          this.pausedUntil = Date.now() + ABUSE_PAUSE_DURATION_MS;
          this.showNotice(
            "GitHub secondary rate limit triggered. Automated syncing paused for 15 minutes.",
            "ERROR",
            10000
          );
        }

        if (error.status === 401 || error.status === 403) {
          this.syncPending = false;
        }
        this.showNotice(`Sync failed: ${this.formatGitHubError(error)}`, "ERROR", 10000);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.showNotice(`Sync failed: ${msg}`, "ERROR", 10000);
      }
    } finally {
      this.hideSyncingNotice();
      this.syncInFlight = false;
      this.suppressAutoPush = false;
      if (this.syncPending) {
        void this.runNextSync();
      }
    }
  }

  private isConfigured(): boolean {
    return Boolean(
      this.settings.githubToken &&
      this.settings.repoName
    );
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.settingsSaveTimer) {
      window.clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
    }
    this.clearInterval();
  }

  private clearInterval(): void {
    if (this.intervalId) {
      window.clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private shouldShowNotice(severity: NoticeSeverity): boolean {
    switch (this.settings.noticeLevel) {
      case "ERROR":
        return severity === "ERROR";
      case "WARNING":
        return severity === "WARNING" || severity === "ERROR";
      case "ALL":
      default:
        return true;
    }
  }

  private showNotice(
    message: unknown,
    severity: NoticeSeverity,
    timeout?: number
  ): void {
    if (!this.shouldShowNotice(severity)) {
      return;
    }

    const text = message instanceof Error ? message.message : String(message);
    new Notice(text, timeout);
  }

  private showSyncingNotice(): void {
    if (this.syncingNotice) {
      return;
    }

    const notice = new Notice("Syncing notes", 0);
    const noticeEl = (notice as { noticeEl?: HTMLElement }).noticeEl;
    if (noticeEl) {
      noticeEl.addClass("gitless-vault-sync-spinner");
    }
    this.syncingNotice = notice;
  }

  private hideSyncingNotice(): void {
    if (!this.syncingNotice) {
      return;
    }

    const notice = this.syncingNotice as unknown as { hide?: () => void };
    if (typeof notice.hide === "function") {
      notice.hide();
    }
    this.syncingNotice = undefined;
  }

  private registerCommands(): void {
    this.addCommand({
      id: "gitless-vault-sync-sync-now",
      name: "Sync Now",
      callback: () => this.requestSync(true)
    });

    this.addCommand({
      id: "gitless-vault-sync-open-settings",
      name: "Open Settings",
      callback: () => this.openSettings()
    });
  }

  private openSettings(): void {
    const settings = (
      this.app as unknown as {
        setting?: { open: () => void; openTabById: (id: string) => void };
      }
    ).setting;

    if (!settings) {
      return;
    }

    settings.open();
    settings.openTabById(this.manifest.id);
  }

  private async markDeleted(file: TFile): Promise<void> {
    if (!this.indexStore) {
      return;
    }
    if (this.shouldIgnorePath(file.path)) {
      return;
    }

    await this.indexStore.withIndex(async (index) => {
      const path = normalizeVaultPath(file.path);
      const entry = index.entries[path];
      if (entry) {
        entry.deletedLocally = true;
        entry.localDeletedAt = Date.now();
      }
    }, false);
  }

  private async markRenamed(file: TFile, oldPath: string): Promise<void> {
    if (!this.indexStore) {
      return;
    }
    if (this.shouldIgnorePath(file.path) || this.shouldIgnorePath(oldPath)) {
      return;
    }

    await this.indexStore.withIndex(async (index) => {
      const normalizedOldPath = normalizeVaultPath(oldPath);
      const normalizedNewPath = normalizeVaultPath(file.path);
      const now = Date.now();

      const oldEntry = index.entries[normalizedOldPath];
      if (oldEntry) {
        oldEntry.deletedLocally = true;
        oldEntry.localDeletedAt = oldEntry.localDeletedAt ?? now;

        // Carry over the entry to the new path if it was already synced
        const newEntry = ensureEntry(index, normalizedNewPath, {
          remoteSha: oldEntry.remoteSha,
          lastSynced: oldEntry.lastSynced,
          lastRemoteCommitTime: oldEntry.lastRemoteCommitTime,
          size: oldEntry.size
        });
        newEntry.deletedLocally = false;
        newEntry.localDeletedAt = undefined;
      }
    }, false);
  }

  private rebuildEventIgnoreMatcher(): void {
    const configDir = this.app.vault.configDir || ".obsidian";
    const alwaysIgnore = [
      `${configDir}/workspace`,
      `${configDir}/workspace.json`,
      `${configDir}/workspace-mobile.json`,
      `${configDir}/cache`,
      `${configDir}/logs`,
      ".git/**",
      ".stfolder/**",
      ".gitless-vault-sync-init",
      ".trash",
      ".DS_Store",
      `${configDir}/plugins/gitless-vault-sync/data.json`,
      `${configDir}/plugins/**/data.json`
    ];
    const userIgnorePatterns = this.settings.ignorePatterns ?? [];
    const ignorePatterns = [...alwaysIgnore, ...userIgnorePatterns];
    this.eventIgnoreMatcher = new IgnoreMatcher(ignorePatterns);
  }

  private async markCreated(file: TFile): Promise<void> {
    if (!this.indexStore) {
      return;
    }
    if (this.shouldIgnorePath(file.path)) {
      return;
    }

    await this.indexStore.withIndex(async (index) => {
      const path = normalizeVaultPath(file.path);
      const entry = index.entries[path];
      if (entry) {
        entry.deletedLocally = false;
        entry.localDeletedAt = undefined;
      }
    }, false);
  }

  private shouldIgnorePath(path: string | null | undefined): boolean {
    if (!path || !this.eventIgnoreMatcher) {
      return false;
    }
    return this.eventIgnoreMatcher.ignores(normalizeVaultPath(path));
  }
  private showSyncNotice(result: SyncResult): void {
    const changes =
      result.uploaded +
      result.downloaded +
      result.deletedLocal +
      result.deletedRemote;

    const severity: NoticeSeverity =
      result.skipped > 0 ? "WARNING" : "INFO";

    if (severity === "INFO" && !this.settings.showSyncSuccessNotice) {
      return;
    }

    if (changes === 0 && result.skipped === 0) {
      this.showNotice(`No changes.`, "INFO");
      return;
    }

    if (result.skipped > 0) {
      if (result.skippedFiles.length > 0) {
        console.warn("Gitless Vault Sync skipped files:", result.skippedFiles);
      }
      this.showNotice(
        `Sync successful (${result.skipped} files skipped).`,
        severity
      );
    } else {
      this.showNotice(`Sync successful.`, severity);
    }
  }

  private formatGitHubError(error: GitHubApiError): string {
    if (error.retryAfter) {
      return `Rate limited. Retry after ${error.retryAfter}s.`;
    }

    if (error.rateLimitResetAt) {
      const resetAt = new Date(error.rateLimitResetAt);
      return `Rate limited. Retry at ${resetAt.toLocaleTimeString()}.`;
    }

    return error.message;
  }
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\//, "");
}

// isObsidianPattern removed as it's no longer needed in main.ts

export function detectDeviceName(): string {
  // Mobile: use Obsidian's Platform API for reliable detection.
  // isIosApp is true on both iPhone and iPad (same app).
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isIosApp) return "iOS";

  // Desktop: try to get the real hostname via Node.js.
  if (Platform.isDesktop) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require("os");
      const hostname = os.hostname();
      if (hostname) {
        return hostname;
      }
    } catch (_) {
      // Fall through to UA detection
    }

    // UA fallback for desktop if hostname is unavailable.
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent || "";
      if (/Win/i.test(ua)) return "Windows";
      if (/Mac/i.test(ua)) return "macOS";
      if (/Linux/i.test(ua)) return "Linux";
    }
  }

  return "Device";
}
