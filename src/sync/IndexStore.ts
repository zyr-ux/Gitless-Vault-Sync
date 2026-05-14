import type { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type GitlessVaultSyncSettings } from "../settings";

export interface SyncIndexEntry {
  path: string;
  remoteSha: string | null;
  lastSynced: number;
  lastRemoteCommitTime: number;
  localMtime: number;
  localHash: string | null;
  size: number;
  deletedLocally?: boolean;
  localDeletedAt?: number;
}

export interface SyncIndexState {
  entries: Record<string, SyncIndexEntry>;
  lastKnownRemoteHeadSha: string;
}

export interface PluginData {
  settings: GitlessVaultSyncSettings;
  index: SyncIndexState;
}

const EMPTY_INDEX: SyncIndexState = { entries: {}, lastKnownRemoteHeadSha: "" };

export class IndexStore {
  private plugin: Plugin;
  private queue: Promise<void> = Promise.resolve();

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  async load(): Promise<SyncIndexState> {
    const raw = await this.plugin.loadData();
    const index = normalizePluginData(raw, DEFAULT_SETTINGS).index;
    const count = Object.keys(index.entries).length;
    console.warn(`[Sync] Index load: ${count} entries`);
    return index;
  }

  async save(index: SyncIndexState): Promise<void> {
    const raw = await this.plugin.loadData();
    const data = normalizePluginData(raw, DEFAULT_SETTINGS);
    data.index = index;
    await this.plugin.saveData(data);
    const count = Object.keys(index.entries).length;
    console.warn(`[Sync] Index save: ${count} entries`);
  }

  /**
   * Performs a transaction-like operation on the sync index.
   * Ensures that the index is loaded, modified by the callback, and saved atomically
   * relative to other withIndex calls.
   */
  async withIndex<T>(
    callback: (index: SyncIndexState) => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          try {
            const index = await this.load();
            const result = await callback(index);
            await this.save(index);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        })
        .catch((error) => {
          // Ensure the queue continues even if one operation fails
          reject(error);
        });
    });
  }

  /**
   * Performs a serialized read of the index.
   * Waits for any pending writes to complete before loading and providing the index.
   */
  async readIndex<T>(
    callback: (index: SyncIndexState) => Promise<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          try {
            const index = await this.load();
            const result = await callback(index);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  }
}

export function normalizePluginData(
  raw: unknown,
  fallbackSettings: GitlessVaultSyncSettings
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

  const settings = Object.assign({}, fallbackSettings, rawSettings) as GitlessVaultSyncSettings;
  const index = normalizeIndex(rawIndex);

  return { settings, index };
}

function normalizeIndex(raw: unknown): SyncIndexState {
  if (!isRecord(raw) || !isRecord(raw.entries)) {
    return { entries: {}, lastKnownRemoteHeadSha: "" };
  }

  const entries: Record<string, SyncIndexEntry> = {};
  for (const [path, value] of Object.entries(raw.entries)) {
    if (!isRecord(value)) {
      continue;
    }

    entries[path] = {
      path,
      remoteSha: value.remoteSha ? String(value.remoteSha) : null,
      lastSynced: numberOrZero(value.lastSynced),
      lastRemoteCommitTime: numberOrZero(value.lastRemoteCommitTime),
      localMtime: numberOrZero(value.localMtime),
      localHash: value.localHash ? String(value.localHash) : null,
      size: numberOrZero(value.size),
      deletedLocally: value.deletedLocally === true,
      localDeletedAt: value.localDeletedAt
        ? numberOrZero(value.localDeletedAt)
        : undefined
    };
  }

  return {
    entries,
    lastKnownRemoteHeadSha: raw.lastKnownRemoteHeadSha ? String(raw.lastKnownRemoteHeadSha) : ""
  };
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function emptyIndex(): SyncIndexState {
  return { entries: {}, lastKnownRemoteHeadSha: "" };
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
    remoteSha: null,
    lastSynced: 0,
    lastRemoteCommitTime: 0,
    localMtime: 0,
    localHash: null,
    size: 0,
    ...initial
  };

  index.entries[path] = entry;
  return entry;
}

export function removeEntry(index: SyncIndexState, path: string): void {
  delete index.entries[path];
}
