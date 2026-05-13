import { App, TFile } from "obsidian";
import {
  GitHubApiError,
  type GitHubClient,
  type RemoteFile
} from "../github/GitHubClient";
import { IgnoreMatcher } from "./IgnoreMatcher";
import {
  IndexStore,
  ensureEntry,
  removeEntry,
  type SyncIndexEntry,
  type SyncIndexState
} from "./IndexStore";
import type { VaultSyncSettings } from "../settings";
import { detectDeviceName } from "../main";

const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_PUSH_RETRIES = 2;

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  skipped: number;
  skippedFiles: string[];
}

interface RemoteSnapshot {
  commitSha: string;
  commitTime: number;
  treeSha: string;
  files: RemoteFile[];
}

interface SyncPlan {
  toDownload: Map<string, RemoteFile>;
  toUpload: Map<string, TFile>;
  toDeleteLocal: Set<string>;
  toDeleteRemote: Set<string>;
}

interface PushResult {
  uploaded: number;
  deletedRemote: number;
  skipped: number;
}

class StaleRemoteHeadError extends Error {
  readonly cause: GitHubApiError;

  constructor(cause: GitHubApiError) {
    super("Remote branch advanced during push");
    this.name = "StaleRemoteHeadError";
    this.cause = cause;
  }
}

export class SyncEngine {
  private app: App;
  private client: GitHubClient;
  private indexStore: IndexStore;
  private settings: VaultSyncSettings;

  constructor(
    app: App,
    client: GitHubClient,
    indexStore: IndexStore,
    settings: VaultSyncSettings
  ) {
    this.app = app;
    this.client = client;
    this.indexStore = indexStore;
    this.settings = settings;
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
  }

  async sync(): Promise<SyncResult> {
    return this.runSync({ allowPull: true, allowPush: true });
  }

  async pull(): Promise<SyncResult> {
    return this.runSync({ allowPull: true, allowPush: false });
  }

  async push(): Promise<SyncResult> {
    return this.runSync({ allowPull: false, allowPush: true });
  }

  private async runSync(options: {
    allowPull: boolean;
    allowPush: boolean;
  }): Promise<SyncResult> {
    const now = Date.now();
    // Hardcode critical ignores since the UI is hidden for now
    const ALWAYS_IGNORE = [
      ".obsidian/workspace",
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/cache",
      ".obsidian/logs",
      ".trash",
      ".DS_Store",
      ".obsidian/plugins/vault-sync/data.json"
    ];
    const ignore = new IgnoreMatcher(ALWAYS_IGNORE);

    const baseIndex = await this.indexStore.load();
    const localFiles = this.collectLocalFiles(ignore);
    let snapshot = await this.getRemoteSnapshot();

    let skipped = 0;
    const skippedFiles: string[] = [];

    if (!snapshot.commitSha && options.allowPush) {
      try {
        await this.client.initializeRepository();
        snapshot = await this.getRemoteSnapshot();
      } catch (e) {
        console.warn("Failed to initialize empty repository", e);
      }
    }

    let index = cloneIndexState(baseIndex);
    let plan = this.planSync(options, index, localFiles, snapshot, ignore, now);

    let uploaded = 0;
    let deletedRemote = 0;
    let pushAttempts = 0;

    while (
      options.allowPush &&
      (plan.toUpload.size > 0 || plan.toDeleteRemote.size > 0)
    ) {
      try {
        const pushResult = await this.pushPlan(
          plan,
          snapshot,
          index,
          skippedFiles
        );
        uploaded += pushResult.uploaded;
        deletedRemote += pushResult.deletedRemote;
        skipped += pushResult.skipped;
        break;
      } catch (error) {
        if (error instanceof StaleRemoteHeadError && pushAttempts < MAX_PUSH_RETRIES) {
          pushAttempts += 1;
          snapshot = await this.getRemoteSnapshot();
          index = cloneIndexState(baseIndex);
          plan = this.planSync(options, index, localFiles, snapshot, ignore, now);
          continue;
        }
        throw error;
      }
    }

    if (options.allowPush && (uploaded > 0 || deletedRemote > 0)) {
      await this.indexStore.save(index);
    }

    let downloaded = 0;
    let deletedLocal = 0;
    if (options.allowPull) {
      for (const path of plan.toDeleteLocal) {
        const target = this.app.vault.getAbstractFileByPath(path);
        if (target instanceof TFile) {
          await this.app.vault.delete(target);
          deletedLocal += 1;
        }
        removeEntry(index, path);
      }

      if (deletedLocal > 0) {
        await this.indexStore.save(index);
      }

      for (const remote of plan.toDownload.values()) {
        if (remote.size > MAX_BLOB_BYTES) {
          skipped += 1;
          skippedFiles.push(remote.path);
          continue;
        }
        const file = await this.writeRemoteFile(remote);
        if (!file) {
          skipped += 1;
          continue;
        }

        const entry = ensureEntry(index, normalizeVaultPath(remote.path));
        entry.remoteSha = remote.sha;
        entry.lastRemoteCommitTime = snapshot.commitTime;
        entry.lastSynced = now;
        entry.localMtime = file.stat.mtime;
        entry.deletedLocally = false;
        entry.localDeletedAt = undefined;
        downloaded += 1;
        await this.indexStore.save(index);
      }
    }

    await this.indexStore.save(index);

    return {
      uploaded,
      downloaded,
      deletedLocal,
      deletedRemote,
      skipped,
      skippedFiles
    };
  }

  private planSync(
    options: { allowPull: boolean; allowPush: boolean },
    index: SyncIndexState,
    localFiles: Map<string, TFile>,
    snapshot: RemoteSnapshot,
    ignore: IgnoreMatcher,
    now: number
  ): SyncPlan {
    const toDownload = new Map<string, RemoteFile>();
    const toUpload = new Map<string, TFile>();
    const toDeleteLocal = new Set<string>();
    const toDeleteRemote = new Set<string>();

    let snapshotFiles = snapshot.files;
    const initFile = snapshotFiles.find((file) => file.path === ".vault-sync-init");
    if (initFile) {
      snapshotFiles = snapshotFiles.filter((file) => file.path !== ".vault-sync-init");
      if (options.allowPush) {
        toDeleteRemote.add(".vault-sync-init");
      }
    }

    const remoteMap = new Map<string, RemoteFile>(
      snapshotFiles.map((file) => [normalizeVaultPath(file.path), file])
    );

    const queueDownload = (remote: RemoteFile): void => {
      const path = normalizeVaultPath(remote.path);
      toUpload.delete(path);
      toDeleteRemote.delete(path);
      if (options.allowPull) {
        toDownload.set(path, remote);
      }
    };

    const queueUpload = (file: TFile): void => {
      const path = normalizeVaultPath(file.path);
      toDownload.delete(path);
      toDeleteLocal.delete(path);
      if (options.allowPush) {
        toUpload.set(path, file);
      }
    };

    const queueDeleteRemote = (path: string): void => {
      const normalized = normalizeVaultPath(path);
      toDownload.delete(normalized);
      toUpload.delete(normalized);
      if (options.allowPush) {
        toDeleteRemote.add(normalized);
      }
    };

    const queueDeleteLocal = (path: string): void => {
      const normalized = normalizeVaultPath(path);
      toUpload.delete(normalized);
      if (options.allowPull) {
        toDeleteLocal.add(normalized);
      }
    };

    for (const [path, entry] of Object.entries(index.entries)) {
      if (ignore.ignores(path)) {
        continue;
      }

      const remote = remoteMap.get(path);
      const local = localFiles.get(path) ?? null;

      if (!remote) {
        if (options.allowPull) {
          if (local) {
            queueDeleteLocal(path);
          }
          removeEntry(index, path);
        }
        continue;
      }

      if (!local) {
        if (options.allowPull && !options.allowPush) {
          entry.deletedLocally = false;
          entry.localDeletedAt = undefined;
          queueDownload(remote);
          continue;
        }

        entry.deletedLocally = true;
        entry.localDeletedAt = entry.localDeletedAt ?? now;

        const remoteChanged = entry.remoteSha !== remote.sha;
        const deleteTime = entry.localDeletedAt ?? now;

        if (remoteChanged && snapshot.commitTime > deleteTime) {
          entry.deletedLocally = false;
          entry.localDeletedAt = undefined;
          queueDownload(remote);
        } else {
          queueDeleteRemote(path);
        }
        continue;
      }

      const localChanged = local.stat.mtime > entry.localMtime;
      const remoteChanged = entry.remoteSha !== remote.sha;

      if (remoteChanged && localChanged) {
        if (local.stat.mtime >= snapshot.commitTime) {
          queueUpload(local);
        } else {
          queueDownload(remote);
        }
      } else if (remoteChanged) {
        queueDownload(remote);
      } else if (localChanged) {
        queueUpload(local);
      }
    }

    for (const [path, remote] of remoteMap.entries()) {
      if (ignore.ignores(path)) {
        continue;
      }

      const entry = index.entries[path];
      const local = localFiles.get(path) ?? null;

      if (!entry) {
        if (!local) {
          queueDownload(remote);
        } else if (local.stat.mtime >= snapshot.commitTime) {
          queueUpload(local);
        } else {
          queueDownload(remote);
        }
      }
    }

    for (const [path, local] of localFiles.entries()) {
      if (ignore.ignores(path)) {
        continue;
      }

      if (!index.entries[path] && !remoteMap.has(path)) {
        queueUpload(local);
      }
    }

    return { toDownload, toUpload, toDeleteLocal, toDeleteRemote };
  }

  private async pushPlan(
    plan: SyncPlan,
    snapshot: RemoteSnapshot,
    index: SyncIndexState,
    skippedFiles: string[]
  ): Promise<PushResult> {
    const treeEntries: Array<{
      path: string;
      mode: string;
      type: "blob";
      sha: string | null;
    }> = [];
    const pendingIndexUpdates: Array<{
      path: string;
      localMtime: number;
      blobSha: string;
    }> = [];

    let skipped = 0;

    for (const file of plan.toUpload.values()) {
      const filePath = normalizeVaultPath(file.path);
      const blobData = await this.readFileBinary(file, skippedFiles);
      if (!blobData) {
        skipped += 1;
        continue;
      }

      const blobSha = await this.client.createBinaryBlob(blobData);
      treeEntries.push({
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: blobSha
      });
      pendingIndexUpdates.push({
        path: filePath,
        localMtime: file.stat.mtime,
        blobSha
      });
    }

    for (const path of plan.toDeleteRemote.values()) {
      treeEntries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: null
      });
    }

    if (treeEntries.length === 0) {
      return { uploaded: 0, deletedRemote: 0, skipped };
    }

    const treeSha = await this.client.createTree(
      snapshot.treeSha || undefined,
      treeEntries
    );
    const parents = snapshot.commitSha ? [snapshot.commitSha] : [];
    const message = `Vault Sync : edited by ${this.settings.deviceName || detectDeviceName()
      }`;
    const commitSha = await this.client.createCommit(message, treeSha, parents);

    try {
      if (snapshot.commitSha) {
        await this.client.updateBranchRef(commitSha);
      } else {
        await this.client.createBranchRef(commitSha);
      }
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        throw new StaleRemoteHeadError(error);
      }
      throw error;
    }

    const commitTime = Date.now();
    let uploaded = 0;
    for (const update of pendingIndexUpdates) {
      const entry = ensureEntry(index, update.path);
      entry.remoteSha = update.blobSha;
      entry.localMtime = update.localMtime;
      entry.lastRemoteCommitTime = commitTime;
      entry.lastSynced = commitTime;
      entry.deletedLocally = false;
      entry.localDeletedAt = undefined;
      uploaded += 1;
    }

    let deletedRemote = 0;
    for (const path of plan.toDeleteRemote) {
      removeEntry(index, path);
      deletedRemote += 1;
    }

    return { uploaded, deletedRemote, skipped };
  }

  private collectLocalFiles(ignore: IgnoreMatcher): Map<string, TFile> {
    const files = this.app.vault.getFiles();
    const map = new Map<string, TFile>();

    for (const file of files) {
      const path = normalizeVaultPath(file.path);
      if (ignore.ignores(path)) {
        continue;
      }
      map.set(path, file);
    }

    return map;
  }

  private async getRemoteSnapshot(): Promise<RemoteSnapshot> {
    try {
      return await this.client.getLatestSnapshot();
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 404 || error.status === 409)
      ) {
        return { commitSha: "", commitTime: 0, treeSha: "", files: [] };
      }
      throw error;
    }
  }

  private async writeRemoteFile(remote: RemoteFile): Promise<TFile | null> {
    const blob = await this.client.getBlob(remote.sha);
    const path = normalizeVaultPath(remote.path);

    await this.ensureParentFolder(path);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (blob.encoding === "base64") {
      const data = base64ToArrayBuffer(blob.content);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, data);
        return existing;
      }
      return this.app.vault.createBinary(path, data);
    }

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, blob.content);
      return existing;
    }
    return this.app.vault.create(path, blob.content);
  }

  private async readFileBinary(
    file: TFile,
    skippedFiles: string[]
  ): Promise<ArrayBuffer | null> {
    if (file.stat.size > MAX_BLOB_BYTES) {
      skippedFiles.push(file.path);
      return null;
    }

    return this.app.vault.readBinary(file);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) {
      return;
    }

    const parent = path.slice(0, lastSlash);
    const parts = parent.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\//, "");
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function cloneIndexState(index: SyncIndexState): SyncIndexState {
  const entries: Record<string, SyncIndexEntry> = {};
  for (const [path, entry] of Object.entries(index.entries)) {
    entries[path] = { ...entry };
  }
  return { entries };
}
