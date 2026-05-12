import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";

export type NoticeLevelSetting = "ALL" | "WARNING" | "ERROR";

export interface VaultSyncSettings {
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
  syncOnStart: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  githubToken: "",
  repoOwner: "",
  repoName: "",
  branch: "main",
  repoPathPrefix: "",
  deviceName: "",
  debounceMs: 3000,
  syncIntervalSec: 60,
  ignorePatterns: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/cache",
    ".obsidian/plugins",
    ".trash",
    ".DS_Store"
  ],
  noticeLevel: "ALL",
  showSyncSuccessNotice: true,
  syncOnStart: true
};

export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Sync" });

    const howto = containerEl.createEl("div", { cls: "howto" });
    howto.createEl("div", {
      text: "How to use this plugin",
      cls: "howto_title"
    });
    howto.createEl("small", {
      text:
        "Enter your GitHub repo owner/name and a personal access token with repo scope. Vault Sync uses GitHub's REST API and does not require git.",
      cls: "howto_text"
    });
    howto.createEl("br");
    const linkEl = howto.createEl("p");
    linkEl.createEl("span", { text: "See the " });
    linkEl.createEl("a", {
      href:
        "https://github.com/kevinmkchin/Obsidian-GitHub-Sync/blob/main/README.md",
      text: "README"
    });
    linkEl.createEl("span", {
      text: " for a UI reference and setup walkthrough."
    });

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Personal access token with repo access.")
      .addText((text) => {
        text.setPlaceholder("ghp_...");
        text.inputEl.type = "password";
        text.inputEl.addClass("my-plugin-setting-text");
        text.setValue(this.plugin.settings.githubToken);
        text.onChange(async (value) => {
          this.plugin.settings.githubToken = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Repository owner")
      .setDesc("GitHub user or organization name.")
      .addText((text) => {
        text.setPlaceholder("owner");
        text.inputEl.addClass("my-plugin-setting-text");
        text.setValue(this.plugin.settings.repoOwner);
        text.onChange(async (value) => {
          this.plugin.settings.repoOwner = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Repository name")
      .setDesc("Repository name without the owner.")
      .addText((text) => {
        text.setPlaceholder("vault");
        text.inputEl.addClass("my-plugin-setting-text");
        text.setValue(this.plugin.settings.repoName);
        text.onChange(async (value) => {
          this.plugin.settings.repoName = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch to sync against.")
      .addText((text) => {
        text.setPlaceholder("main");
        text.inputEl.addClass("my-plugin-setting-text");
        text.setValue(this.plugin.settings.branch);
        text.onChange(async (value) => {
          this.plugin.settings.branch = value.trim() || "main";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Repository path prefix")
      .setDesc("Optional subfolder in the repo (leave blank for root).")
      .addText((text) => {
        text.setPlaceholder("notes/");
        text.inputEl.addClass("my-plugin-setting-text");
        text.setValue(this.plugin.settings.repoPathPrefix);
        text.onChange(async (value) => {
          this.plugin.settings.repoPathPrefix = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in commit messages. Leave blank to auto-detect.")
      .addText((text) => {
        text.setPlaceholder("Desktop");
        text.inputEl.addClass("my-plugin-setting-text");
        text.setValue(this.plugin.settings.deviceName);
        text.onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Change debounce (ms)")
      .setDesc("Delay before uploading edits.")
      .addText((text) => {
        text.inputEl.addClass("my-plugin-setting-text2");
        text.setValue(String(this.plugin.settings.debounceMs));
        text.onChange(async (value) => {
          this.plugin.settings.debounceMs = toPositiveInt(
            value,
            DEFAULT_SETTINGS.debounceMs
          );
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-sync interval (sec)")
      .setDesc("Mobile auto-pull interval. Set to 0 to disable.")
      .addText((text) => {
        text.inputEl.addClass("my-plugin-setting-text2");
        text.setValue(String(this.plugin.settings.syncIntervalSec));
        text.onChange(async (value) => {
          this.plugin.settings.syncIntervalSec = toNonNegativeInt(
            value,
            DEFAULT_SETTINGS.syncIntervalSec
          );
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc("One path per line, matched relative to vault root.")
      .addTextArea((area) => {
        area.setValue(serializeIgnorePatterns(this.plugin.settings.ignorePatterns));
        area.onChange(async (value) => {
          this.plugin.settings.ignorePatterns = parseIgnorePatterns(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Notice level")
      .setDesc("Choose which Vault Sync notices are shown in the UI.")
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
      .setName("Auto sync on startup")
      .setDesc("Automatically sync with remote when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStart)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStart = value;
            await this.plugin.saveSettings();
          })
      );
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
