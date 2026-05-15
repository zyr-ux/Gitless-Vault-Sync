import { App, PluginSettingTab, Setting } from "obsidian";
import type GitlessVaultSyncPlugin from "./main";
import { detectDeviceName } from "./main";
import { GitHubClient } from "./github/GitHubClient";

export type NoticeLevelSetting = "ALL" | "WARNING" | "ERROR";

export interface GitlessVaultSyncSettings {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  repoPathPrefix: string;
  deviceName: string;
  debounceMs: number;
  syncIntervalSec: number;
  ignorePatterns: string[];
  noticeLevel: NoticeLevelSetting;
  showSyncSuccessNotice: boolean;
  autoSync: boolean;
  lastVerifiedRepoUrl: string;
}

export const DEFAULT_SETTINGS: GitlessVaultSyncSettings = {
  githubToken: "",
  repoOwner: "",
  repoName: "",
  branch: "main",
  repoPathPrefix: "",
  deviceName: "",
  debounceMs: 3000,
  syncIntervalSec: 300,
  ignorePatterns: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    ".obsidian/logs",
    ".trash",
    ".DS_Store"
  ],
  noticeLevel: "ALL",
  showSyncSuccessNotice: true,
  autoSync: true,
  lastVerifiedRepoUrl: ""
};

export class GitlessVaultSyncSettingTab extends PluginSettingTab {
  plugin: GitlessVaultSyncPlugin;
  private vaultLinkEl?: HTMLElement;

  constructor(app: App, plugin: GitlessVaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Gitless Vault Sync Settings" });


    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Personal access token with repo access.")
      .addText((text) => {
        text.setPlaceholder("ghp_...");
        text.inputEl.type = "password";
        text.inputEl.addClass("gitless-vault-sync-setting-input");
        text.setValue(this.plugin.settings.githubToken);
        text.onChange(async (value) => {
          this.plugin.settings.githubToken = value.trim();
          this.plugin.queueSaveSettings();
          this.updateVaultLink();
        });
      });

    new Setting(containerEl)
      .setName("Repository owner")
      .setDesc("GitHub user or organization. Leave blank to auto-detect from your PAT.")
      .addText((text) => {
        text.setPlaceholder("owner");
        text.inputEl.addClass("gitless-vault-sync-setting-input");
        text.setValue(this.plugin.settings.repoOwner);
        text.onChange(async (value) => {
          this.plugin.settings.repoOwner = value.trim();
          this.plugin.queueSaveSettings();
          this.updateVaultLink();
        });
      });

    new Setting(containerEl)
      .setName("Repository name")
      .setDesc("Name of your remote repository.")
      .addText((text) => {
        text.setPlaceholder("vault");
        text.inputEl.addClass("gitless-vault-sync-setting-input");
        text.setValue(this.plugin.settings.repoName);
        text.onChange(async (value) => {
          this.plugin.settings.repoName = value.trim();
          this.plugin.queueSaveSettings();
          this.updateVaultLink();
        });
      });

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch to sync against.")
      .addText((text) => {
        text.setPlaceholder("main");
        text.inputEl.addClass("gitless-vault-sync-setting-input");
        text.setValue(this.plugin.settings.branch);
        text.onChange(async (value) => {
          this.plugin.settings.branch = value.trim() || "main";
          this.plugin.queueSaveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Repository path prefix")
      .setDesc("Optional subfolder in the repo (leave blank for root).")
      .addText((text) => {
        text.setPlaceholder("notes/");
        text.inputEl.addClass("gitless-vault-sync-setting-input");
        text.setValue(this.plugin.settings.repoPathPrefix);
        text.onChange(async (value) => {
          this.plugin.settings.repoPathPrefix = value.trim();
          this.plugin.queueSaveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in commit messages. Leave blank to auto-detect.")
      .addText((text) => {
        text.setPlaceholder(detectDeviceName());
        text.inputEl.addClass("gitless-vault-sync-setting-input");
        text.setValue(this.plugin.settings.deviceName);
        text.onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          this.plugin.queueSaveSettings();
        });
      });


    new Setting(containerEl)
      .setName("Auto-sync interval (sec)")
      .setDesc("Automatically sync with remote on this interval. Set to 0 to disable.")
      .addText((text) => {
        text.inputEl.addClass("gitless-vault-sync-setting-input-small");
        text.setValue(String(this.plugin.settings.syncIntervalSec));
        text.onChange(async (value) => {
          this.plugin.settings.syncIntervalSec = toNonNegativeInt(
            value,
            DEFAULT_SETTINGS.syncIntervalSec
          );
          this.plugin.queueSaveSettings();
        });
      });


    new Setting(containerEl)
      .setName("Notice level")
      .setDesc("Choose which Gitless Vault Sync notices are shown in the UI.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("ALL", "ALL")
          .addOption("WARNING", "WARNING")
          .addOption("ERROR", "ERROR")
          .setValue(this.plugin.settings.noticeLevel)
          .onChange(async (value) => {
            this.plugin.settings.noticeLevel = isNoticeLevelSetting(value)
              ? value
              : "ALL";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Hide Success Message")
      .setDesc("Hide the single success notice shown when a sync completes.")
      .addToggle((toggle) =>
        toggle
          .setValue(!this.plugin.settings.showSyncSuccessNotice)
          .onChange(async (value) => {
            this.plugin.settings.showSyncSuccessNotice = !value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Enable all automatic synchronization triggers (startup, edits, and interval).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          })
      );

    const footer = containerEl.createEl("div", { cls: "gitless-vault-sync-footer" });
    const readmeEl = footer.createEl("span");
    readmeEl.createEl("span", { text: "To know how to set up, visit the " });
    readmeEl.createEl("a", {
      href: "https://github.com/zyr-ux/Gitless-Vault-Sync/blob/main/README.md",
      text: "README"
    });
    readmeEl.createEl("span", { text: "." });
    
    this.vaultLinkEl = footer.createEl("div");
    this.updateVaultLink();
  }

  private async updateVaultLink() {
    if (!this.vaultLinkEl) return;
    const { settings } = this.plugin;
    const repo = settings.repoName;
    let owner = settings.repoOwner;

    if (!repo || !settings.githubToken) {
      this.vaultLinkEl.empty();
      this.plugin.settings.lastVerifiedRepoUrl = "";
      this.plugin.queueSaveSettings();
      return;
    }

    // Use cached URL if it matches current config
    if (settings.lastVerifiedRepoUrl) {
      try {
        const url = new URL(settings.lastVerifiedRepoUrl);
        const parts = url.pathname.split("/").filter((p) => p);
        if (parts.length >= 2) {
          const cachedOwner = parts[0];
          const cachedRepo = parts[1];
          if (cachedRepo === repo && (!owner || owner === cachedOwner)) {
            this.renderVaultLink(settings.lastVerifiedRepoUrl);
            return;
          }
        }
      } catch (e) {
        // Invalid URL, ignore cache
      }
    }

    // Verify repository
    this.vaultLinkEl.setText("Verifying repository...");
    try {
      const client = new GitHubClient({
        token: settings.githubToken,
        owner: owner,
        repo: repo,
        branch: settings.branch
      });

      if (!owner) {
        owner = await client.getOwner();
      }

      const exists = await client.checkRepoExists();
      if (exists) {
        const url = `https://github.com/${owner}/${repo}`;
        this.plugin.settings.lastVerifiedRepoUrl = url;
        this.plugin.queueSaveSettings();
        this.renderVaultLink(url);
      } else {
        this.vaultLinkEl.empty();
        this.plugin.settings.lastVerifiedRepoUrl = "";
        this.plugin.queueSaveSettings();
      }
    } catch (e) {
      this.vaultLinkEl.empty();
      this.plugin.settings.lastVerifiedRepoUrl = "";
      this.plugin.queueSaveSettings();
    }
  }

  private renderVaultLink(url: string) {
    if (!this.vaultLinkEl) return;
    this.vaultLinkEl.empty();
    const linkContainer = this.vaultLinkEl.createEl("div");
    linkContainer.createEl("span", { text: "Your vault repository: " });
    linkContainer.createEl("a", {
      href: url,
      text: url.replace("https://github.com/", "")
    });
  }
}

function parseIgnorePatterns(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function serializeIgnorePatterns(patterns: string[]): string {
  return patterns.join("\n");
}

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function toNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.round(parsed);
}

function isNoticeLevelSetting(value: string): value is NoticeLevelSetting {
  return value === "ALL" || value === "WARNING" || value === "ERROR";
}
