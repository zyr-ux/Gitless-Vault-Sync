import { Platform, Plugin, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  VaultSyncSettingTab,
  type VaultSyncSettings
} from "./settings";
import { normalizePluginData } from "./sync/IndexStore";
import { GitHubClient } from "./github/GitHubClient";
import { IndexStore } from "./sync/IndexStore";
import { SyncEngine } from "./sync/SyncEngine";

type SyncMode = "pull" | "push" | "sync";

export default class VaultSyncPlugin extends Plugin {
  settings!: VaultSyncSettings;
  private githubClient?: GitHubClient;
  private syncEngine?: SyncEngine;
  private indexStore?: IndexStore;
  private debounceTimer: number | null = null;
  private intervalId: number | null = null;
  private syncInFlight = false;
  private pendingMode: SyncMode | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));
    this.initializeSync();
    this.registerVaultEvents();
    this.startAutoPull();
    this.requestSync("pull");
  }

  onunload(): void {
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
    this.startAutoPull();
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.schedulePush();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.schedulePush();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.schedulePush();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (file instanceof TFile) {
          this.schedulePush();
        }
      })
    );
  }

  private startAutoPull(): void {
    this.clearInterval();

    if (!this.shouldAutoPull()) {
      return;
    }

    this.intervalId = window.setInterval(() => {
      this.requestSync("pull");
    }, this.settings.syncIntervalSec * 1000);
  }

  private shouldAutoPull(): boolean {
    return (
      this.settings.syncIntervalSec > 0 &&
      Platform.isMobileApp &&
      this.isConfigured()
    );
  }

  private schedulePush(): void {
    if (!this.isConfigured()) {
      return;
    }

    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.requestSync("push");
    }, this.settings.debounceMs);
  }

  private requestSync(mode: SyncMode): void {
    if (!this.isConfigured() || !this.syncEngine) {
      return;
    }

    this.pendingMode = mergeModes(this.pendingMode, mode);
    void this.runNextSync();
  }

  private async runNextSync(): Promise<void> {
    if (this.syncInFlight || !this.syncEngine) {
      return;
    }

    const mode = this.pendingMode;
    if (!mode) {
      return;
    }

    this.pendingMode = null;
    this.syncInFlight = true;

    try {
      if (mode === "pull") {
        await this.syncEngine.pull();
      } else if (mode === "push") {
        await this.syncEngine.push();
      } else {
        await this.syncEngine.sync();
      }
    } catch (error) {
      console.error("Vault Sync error", error);
    } finally {
      this.syncInFlight = false;
      if (this.pendingMode) {
        void this.runNextSync();
      }
    }
  }

  private isConfigured(): boolean {
    return Boolean(
      this.settings.githubToken &&
        this.settings.repoOwner &&
        this.settings.repoName
    );
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.clearInterval();
  }

  private clearInterval(): void {
    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

function mergeModes(current: SyncMode | null, next: SyncMode): SyncMode {
  if (!current) {
    return next;
  }
  if (current === "sync" || next === "sync") {
    return "sync";
  }
  if (current !== next) {
    return "sync";
  }
  return current;
}

function detectDeviceName(): string {
  if (typeof navigator === "undefined") {
    return "Device";
  }

  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";

  if (/Android/i.test(ua)) {
    return "Android";
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return "iOS";
  }
  if (/Win/i.test(platform)) {
    return "Windows";
  }
  if (/Mac/i.test(platform)) {
    return "macOS";
  }
  if (/Linux/i.test(platform)) {
    return "Linux";
  }

  return "Device";
}
