import { Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  VaultSyncSettingTab,
  type VaultSyncSettings
} from "./settings";
import { normalizePluginData } from "./sync/IndexStore";

export default class VaultSyncPlugin extends Plugin {
  settings!: VaultSyncSettings;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));
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
  }
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
