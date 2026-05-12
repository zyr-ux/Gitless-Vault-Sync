import type { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../settings";

export interface SyncIndexEntry {
  path: string;
  remoteSha: string;
  lastSynced: number;
  lastRemoteCommitTime: number;
  localMtime: number;
  deletedLocally?: boolean;
  localDeletedAt?: number;
}

export interface SyncIndexState {
  entries: Record<string, SyncIndexEntry>;
}

export interface PluginData {
  settings: VaultSyncSettings;
  index: SyncIndexState;
}

const EMPTY_INDEX: SyncIndexState = { entries: {} };

export class IndexStore {
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  async load(): Promise<SyncIndexState> {
    const raw = await this.plugin.loadData();
    return normalizePluginData(raw, DEFAULT_SETTINGS).index;
  }

  async save(index: SyncIndexState): Promise<void> {
    const raw = await this.plugin.loadData();
    const data = normalizePluginData(raw, DEFAULT_SETTINGS);
    data.index = index;
    await this.plugin.saveData(data);
  }
}

export function normalizePluginData(
  raw: unknown,
  fallbackSettings: VaultSyncSettings
): PluginData {
  const record = isRecord(raw) ? raw : {};
  const hasSettings = "settings" in record;

  const rawSettings = hasSettings
    ? isRecord(record.settings)
      ? record.settings
      : {}
    : record;
  const rawIndex = hasSettings
    ? isRecord(record.index)
      ? record.index
      : {}
    : {};

  const settings = Object.assign({}, fallbackSettings, rawSettings) as VaultSyncSettings;
  const index = normalizeIndex(rawIndex);

  return { settings, index };
}

function normalizeIndex(raw: unknown): SyncIndexState {
  if (!isRecord(raw) || !isRecord(raw.entries)) {
    return { entries: {} };
  }

  const entries: Record<string, SyncIndexEntry> = {};
  for (const [path, value] of Object.entries(raw.entries)) {
    if (!isRecord(value)) {
      continue;
    }

    entries[path] = {
      path,
      remoteSha: String(value.remoteSha ?? ""),
      lastSynced: numberOrZero(value.lastSynced),
      lastRemoteCommitTime: numberOrZero(value.lastRemoteCommitTime),
      localMtime: numberOrZero(value.localMtime),
      deletedLocally: value.deletedLocally === true,
      localDeletedAt: value.localDeletedAt
        ? numberOrZero(value.localDeletedAt)
        : undefined
    };
  }

  return { entries };
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function emptyIndex(): SyncIndexState {
  return { entries: {} };
}

export function ensureEntry(
  index: SyncIndexState,
  path: string,
  initial?: Partial<SyncIndexEntry>
): SyncIndexEntry {
  const existing = index.entries[path];
  if (existing) {
    return existing;
  }

  const entry: SyncIndexEntry = {
    path,
    remoteSha: "",
    lastSynced: 0,
    lastRemoteCommitTime: 0,
    localMtime: 0,
    ...initial
  };

  index.entries[path] = entry;
  return entry;
}

export function removeEntry(index: SyncIndexState, path: string): void {
  delete index.entries[path];
}
