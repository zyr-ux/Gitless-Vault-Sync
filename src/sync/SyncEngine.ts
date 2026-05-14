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
import type { GitlessVaultSyncSettings } from "../settings";
import { detectDeviceName } from "../main";
import { BlobReader, ZipReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_PUSH_RETRIES = 2;
const MAX_FILE_IO_CONCURRENCY = 3;
const HASH_THRESHOLD_BYTES = 25 * 1024 * 1024;
  // Moved to getAlwaysIgnore() to support dynamic configDir

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
  serverTimeMs: number;
}

interface SyncPlan {
  toDownload: Map<string, RemoteFile>;
  toUpload: Map<string, LocalFileEntry>;
  toDeleteLocal: Set<string>;
  toDeleteRemote: Set<string>;
}

interface PushResult {
  uploaded: number;
  deletedRemote: number;
  skipped: number;
}

interface LocalFileEntry {
  path: string;
  stat: { mtime: number; size: number };
  readBinary: () => Promise<ArrayBuffer>;
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
  private settings: GitlessVaultSyncSettings;

  constructor(
    app: App,
    client: GitHubClient,
    indexStore: IndexStore,
    settings: GitlessVaultSyncSettings
  ) {
    this.app = app;
    this.client = client;
    this.indexStore = indexStore;
    this.settings = settings;
  }

  updateSettings(settings: GitlessVaultSyncSettings): void {
    this.settings = settings;
  }

  async sync(): Promise<SyncResult> {
    return this.runSync({ allowPull: true, allowPush: true });
  }

  async hasLocalChanges(): Promise<boolean> {
    return this.indexStore.readIndex(async (index) => {
      const ignore = this.getIgnoreMatcher();
      return this.detectLocalChanges(index, ignore);
    });
  }

  async hasPendingChanges(options: {
    allowPull: boolean;
    allowPush: boolean;
  }): Promise<boolean> {
    return this.indexStore.readIndex(async (baseIndex) => {
      const now = Date.now();
      const ignore = this.getIgnoreMatcher();

      const indexCount = Object.keys(baseIndex.entries).length;
      console.warn(
        `[Sync] Index entries: ${indexCount}, lastKnownRemoteHeadSha: ${baseIndex.lastKnownRemoteHeadSha || "(empty)"}`
      );
      const localFiles = await this.collectLocalFiles(ignore);
      console.warn(`[Sync] Local files considered: ${localFiles.size}`);
      const snapshot = await this.getRemoteSnapshot();

      const index = cloneIndexState(baseIndex);
      const plan = await this.planSync(options, index, localFiles, snapshot, ignore, now);

      return (
        plan.toDownload.size > 0 ||
        plan.toUpload.size > 0 ||
        plan.toDeleteLocal.size > 0 ||
        plan.toDeleteRemote.size > 0
      );
    });
  }

  private async runSync(options: {
    allowPull: boolean;
    allowPush: boolean;
  }): Promise<SyncResult> {
    this.client.resetCommitChain();

    return this.indexStore.withIndex(async (baseIndex) => {
      const count = Object.keys(baseIndex.entries).length;
      console.warn(`[Sync] Starting sync with ${count} indexed files`);

      const now = Date.now();
      const ignore = this.getIgnoreMatcher();

      // Short-circuit: Check head before doing anything else
      if (options.allowPull) {
        try {
          const headSha = await this.client.getBranchRef();
          if (baseIndex.lastKnownRemoteHeadSha === headSha && headSha !== "") {
            if (!options.allowPush) {
              console.log(
                `[Sync] Short-circuit: Remote head unchanged (${headSha}). Skipping pull.`
              );
              return {
                uploaded: 0,
                downloaded: 0,
                deletedLocal: 0,
                deletedRemote: 0,
                skipped: 0,
                skippedFiles: []
              };
            }

            const hasLocalChanges = await this.detectLocalChanges(baseIndex, ignore);
            if (!hasLocalChanges) {
              console.log(
                `[Sync] Short-circuit: Remote head unchanged (${headSha}) and no local changes. Skipping sync.`
              );
              return {
                uploaded: 0,
                downloaded: 0,
                deletedLocal: 0,
                deletedRemote: 0,
                skipped: 0,
                skippedFiles: []
              };
            }
          }
        } catch (e) {
          // Fall back to full sync if head check fails
        }
      }

      const localFiles = await this.collectLocalFiles(ignore);
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

      // High-efficiency ZIP initial sync detection
      const configDir = this.app.vault.configDir || ".obsidian";
      const hasUserFiles = Array.from(localFiles.keys()).some(
        (p) => !p.startsWith(`${configDir}/`)
      );

      if (
        options.allowPull &&
        Object.keys(baseIndex.entries).length === 0 &&
        !hasUserFiles &&
        snapshot.files.length > 50
      ) {
        console.warn(
          `[Sync] Detected vault with only configuration files and non-empty remote (${snapshot.files.length} files). Performing ZIP-based initial sync.`
        );
        return this.performZipInitialSync(snapshot, baseIndex, ignore);
      }

      // Update the base index with the latest remote head we just found
      if (snapshot.commitSha) {
        baseIndex.lastKnownRemoteHeadSha = snapshot.commitSha;
      }

      let index = cloneIndexState(baseIndex);
      let plan = await this.planSync(options, index, localFiles, snapshot, ignore, now);

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
            // Update baseIndex head too for consistency if we retry
            if (snapshot.commitSha) {
              baseIndex.lastKnownRemoteHeadSha = snapshot.commitSha;
            }
            index = cloneIndexState(baseIndex);
            plan = await this.planSync(options, index, localFiles, snapshot, ignore, now);
            continue;
          }
          throw error;
        }
      }

      // Partial save after push if we uploaded anything
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
          } else {
            // Handle files outside vault index (e.g. .obsidian/ or hidden files)
            const stat = await this.app.vault.adapter.stat(path);
            if (stat && stat.type === "file") {
              await this.app.vault.adapter.remove(path);
              deletedLocal += 1;
            }
          }
          removeEntry(index, path);
        }

        // Partial save after deletes
        if (deletedLocal > 0) {
          await this.indexStore.save(index);
        }

        const downloadTargets = Array.from(plan.toDownload.values());
        const downloadResults = await runWithConcurrency(
          downloadTargets,
          MAX_FILE_IO_CONCURRENCY,
          async (remote) => {
            if (remote.size > MAX_BLOB_BYTES) {
              skippedFiles.push(remote.path);
              return { remote, file: null };
            }
            const file = await this.writeRemoteFile(remote);
            return { remote, file };
          }
        );

        for (const result of downloadResults) {
          if (!result.file) {
            skipped += 1;
            continue;
          }

          const entry = ensureEntry(index, normalizeVaultPath(result.remote.path));
          entry.remoteSha = result.remote.sha;
          entry.localHash = result.remote.sha; // For downloads, we know the local hash matches remote
          entry.size = result.remote.size;
          entry.lastRemoteCommitTime = snapshot.commitTime;
          entry.lastSynced = now;
          entry.localMtime = result.file.stat.mtime;
          entry.deletedLocally = false;
          entry.localDeletedAt = undefined;
          downloaded += 1;
          // Redundant saves removed here (Issue 3)
        }
      }

      // Final state update to baseIndex for withIndex to save
      baseIndex.entries = { ...index.entries };
      baseIndex.lastKnownRemoteHeadSha = index.lastKnownRemoteHeadSha;

      return {
        uploaded,
        downloaded,
        deletedLocal,
        deletedRemote,
        skipped,
        skippedFiles
      };
    });
  }

  private async performZipInitialSync(
    snapshot: RemoteSnapshot,
    index: SyncIndexState,
    ignore: IgnoreMatcher
  ): Promise<SyncResult> {
    const zipData = await this.client.downloadRepositoryArchive();
    const zipBlob = new Blob([zipData]);
    const reader = new ZipReader(new BlobReader(zipBlob));
    const entries = await reader.getEntries();

    let downloaded = 0;
    const now = Date.now();

    const remoteMap = new Map<string, RemoteFile>(
      snapshot.files.map((f) => [normalizeVaultPath(f.path), f])
    );

    for (const entry of entries) {
      if (entry.directory || !entry.getData) {
        continue;
      }

      // GitHub ZIPs have a root folder segment like "owner-repo-sha/"
      const parts = entry.filename.split("/");
      if (parts.length <= 1) {
        continue;
      }
      const path = parts.slice(1).join("/");

      const normalizedPath = normalizeVaultPath(path);
      if (ignore.ignores(normalizedPath)) {
        continue;
      }

      await this.ensureParentFolder(normalizedPath);

      const writer = new Uint8ArrayWriter();
      await entry.getData(writer);
      const data = await writer.getData();

      // Obsidian createBinary expects ArrayBuffer
      await this.app.vault.adapter.writeBinary(normalizedPath, data.buffer);

      const remote = remoteMap.get(normalizedPath);
      if (remote) {
        const entryRecord = ensureEntry(index, normalizedPath);
        entryRecord.remoteSha = remote.sha;
        entryRecord.localHash = remote.sha;
        entryRecord.size = remote.size;
        entryRecord.lastSynced = now;
        entryRecord.lastRemoteCommitTime = snapshot.commitTime;

        const stat = await this.app.vault.adapter.stat(normalizedPath);
        entryRecord.localMtime = stat?.mtime ?? now;
      }
      downloaded++;
    }

    await reader.close();

    // Final head state update
    if (snapshot.commitSha) {
      index.lastKnownRemoteHeadSha = snapshot.commitSha;
    }
    await this.indexStore.save(index);

    return {
      uploaded: 0,
      downloaded,
      deletedLocal: 0,
      deletedRemote: 0,
      skipped: 0,
      skippedFiles: []
    };
  }

  private async planSync(
    options: { allowPull: boolean; allowPush: boolean },
    index: SyncIndexState,
    localFiles: Map<string, LocalFileEntry>,
    snapshot: RemoteSnapshot,
    ignore: IgnoreMatcher,
    now: number
  ): Promise<SyncPlan> {
    const toDownload = new Map<string, RemoteFile>();
    const toUpload = new Map<string, LocalFileEntry>();
    const toDeleteLocal = new Set<string>();
    const toDeleteRemote = new Set<string>();

    let snapshotFiles = snapshot.files;
    const initFile = snapshotFiles.find((file) => file.path === ".gitless-vault-sync-init");
    if (initFile) {
      snapshotFiles = snapshotFiles.filter((file) => file.path !== ".gitless-vault-sync-init");
      if (options.allowPush) {
        toDeleteRemote.add(".gitless-vault-sync-init");
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

    const queueUpload = (file: LocalFileEntry): void => {
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

    const clockSkewMs = now - snapshot.serverTimeMs;

    for (const [path, entry] of Object.entries(index.entries)) {
      if (ignore.ignores(path)) {
        continue;
      }

      const remote = remoteMap.get(path);
      const local = localFiles.get(path) ?? null;

      if (!remote) {
        if (options.allowPull) {
          if (local) {
            const localChanged = local.stat.mtime > entry.localMtime;
            if (localChanged && options.allowPush) {
              queueUpload(local);
            } else {
              queueDeleteLocal(path);
            }
          } else {
            removeEntry(index, path);
          }
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
        const adjustedDeleteTime = Math.max(0, deleteTime - clockSkewMs);

        if (remoteChanged && snapshot.commitTime > adjustedDeleteTime) {
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
        const adjustedLocalMtime = Math.max(0, local.stat.mtime - clockSkewMs);
        if (adjustedLocalMtime >= snapshot.commitTime) {
          queueUpload(local);
        } else {
          queueDownload(remote);
        }
      } else if (remoteChanged) {
        queueDownload(remote);
      } else if (localChanged) {
        if (local.stat.size === entry.size) {
          if (local.stat.size > HASH_THRESHOLD_BYTES) {
            queueUpload(local);
          } else {
            const currentHash = await calculateGitSha(await local.readBinary());
            if (currentHash === entry.localHash) {
              console.log(`[Sync] Skipping upload for ${path}: content hash unchanged`);
              // Update mtime so we don't check again next time if nothing changes
              entry.localMtime = local.stat.mtime;
            } else {
              queueUpload(local);
            }
          }
        } else {
          // Size changed, definitely changed
          queueUpload(local);
        }
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
        } else {
          if (local.stat.size === remote.size && local.stat.size <= HASH_THRESHOLD_BYTES) {
            const currentHash = await calculateGitSha(await local.readBinary());
            if (currentHash === remote.sha) {
              const newEntry = ensureEntry(index, path);
              newEntry.remoteSha = remote.sha;
              newEntry.localHash = currentHash;
              newEntry.size = remote.size;
              newEntry.lastRemoteCommitTime = snapshot.commitTime;
              newEntry.lastSynced = now;
              newEntry.localMtime = local.stat.mtime;
              newEntry.deletedLocally = false;
              newEntry.localDeletedAt = undefined;
              continue;
            }
          }
          const adjustedLocalMtime = Math.max(0, local.stat.mtime - clockSkewMs);
          if (adjustedLocalMtime >= snapshot.commitTime) {
            queueUpload(local);
          } else {
            queueDownload(remote);
          }
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
      size: number;
      localHash: string;
      remoteSha: string;
    }> = [];
    const invalidTreePaths: string[] = [];

    let skipped = 0;

    const uploadTargets = Array.from(plan.toUpload.values());
    if (uploadTargets.length > 0) {
      const sample = uploadTargets.slice(0, 10).map((file) => file.path);
      console.warn(
        `[Sync] Uploading ${uploadTargets.length} file(s). Sample: ${sample.join(", ")}`
      );
    }
    const uploadResults = await runWithConcurrency(
      uploadTargets,
      MAX_FILE_IO_CONCURRENCY,
      async (file) => {
        const filePath = normalizeVaultPath(file.path);
        if (!isValidGitPath(filePath)) {
          if (invalidTreePaths.length < 5) {
            invalidTreePaths.push(filePath || file.path);
          }
          return null;
        }
        const blobData = await this.readFileBinary(file, skippedFiles);
        if (!blobData) {
          return null;
        }

        const blobSha = await this.client.createBinaryBlob(blobData);
        const localHash = await calculateGitSha(blobData);
        return {
          filePath,
          localMtime: file.stat.mtime,
          size: file.stat.size,
          localHash,
          remoteSha: blobSha
        };
      }
    );

    for (const result of uploadResults) {
      if (!result) {
        skipped += 1;
        continue;
      }

      treeEntries.push({
        path: result.filePath,
        mode: "100644",
        type: "blob",
        sha: result.remoteSha
      });
      pendingIndexUpdates.push({
        path: result.filePath,
        localMtime: result.localMtime,
        size: result.size,
        localHash: result.localHash,
        remoteSha: result.remoteSha
      });
    }

    for (const path of plan.toDeleteRemote.values()) {
      if (!isValidGitPath(path)) {
        if (invalidTreePaths.length < 5) {
          invalidTreePaths.push(path);
        }
        continue;
      }
      treeEntries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: null
      });
    }

    if (invalidTreePaths.length > 0) {
      console.warn("Gitless Vault Sync: skipped invalid tree paths", invalidTreePaths);
    }

    if (treeEntries.length === 0) {
      return { uploaded: 0, deletedRemote: 0, skipped };
    }

    const treeSha = await this.client.createTree(
      snapshot.treeSha || undefined,
      treeEntries
    );
    const parents = snapshot.commitSha ? [snapshot.commitSha] : [];
    const device = this.settings.deviceName || detectDeviceName();
    const date = new Date().toLocaleString(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
    const message = `Edited by ${device} on ${date}`;
    const commitSha = await this.client.createCommit(message, treeSha, parents);

    try {
      if (snapshot.commitSha) {
        await this.client.updateBranchRef(commitSha);
      } else {
        await this.client.createBranchRef(commitSha);
      }
      index.lastKnownRemoteHeadSha = commitSha;
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
      entry.remoteSha = update.remoteSha;
      entry.localHash = update.localHash;
      entry.size = update.size;
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

  private async collectLocalFiles(
    ignore: IgnoreMatcher
  ): Promise<Map<string, LocalFileEntry>> {
    const files = await this.listAllVaultFiles();
    const candidates = files.filter((path) => !ignore.ignores(path));
    const entries = await runWithConcurrency(
      candidates,
      MAX_FILE_IO_CONCURRENCY,
      async (path) => this.buildLocalFileEntry(path)
    );

    const map = new Map<string, LocalFileEntry>();
    for (const entry of entries) {
      if (!entry) {
        continue;
      }
      map.set(entry.path, entry);
    }

    return map;
  }

  private async buildLocalFileEntry(
    path: string
  ): Promise<LocalFileEntry | null> {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (target instanceof TFile) {
      return {
        path,
        stat: { mtime: target.stat.mtime, size: target.stat.size },
        readBinary: () => this.app.vault.readBinary(target)
      };
    }

    const stat = await this.app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      return null;
    }

    return {
      path,
      stat: { mtime: stat.mtime ?? 0, size: stat.size ?? 0 },
      readBinary: () => this.app.vault.adapter.readBinary(path)
    };
  }

  private async listAllVaultFiles(): Promise<string[]> {
    const results = new Set<string>();
    const invalidPaths: string[] = [];

    for (const file of this.app.vault.getFiles()) {
      const normalized = normalizeVaultPath(file.path);
      if (!isValidGitPath(normalized)) {
        if (invalidPaths.length < 5) {
          invalidPaths.push(normalized || file.path);
        }
        continue;
      }
      results.add(normalized);
    }

    const configDir = this.app.vault.configDir || ".obsidian";
    const obsidianFiles = await this.collectFilesInFolder(configDir);
    for (const path of obsidianFiles) {
      results.add(path);
    }

    if (invalidPaths.length > 0) {
      console.warn("Gitless Vault Sync: skipped invalid paths", invalidPaths);
    }

    return Array.from(results);
  }

  private async collectFilesInFolder(folderPath: string): Promise<string[]> {
    const results: string[] = [];
    const pending: string[] = [folderPath];

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        continue;
      }

      try {
        const listing = await this.app.vault.adapter.list(current);
        for (const file of listing.files) {
          const normalized = normalizeVaultPath(file);
          if (isValidGitPath(normalized)) {
            results.push(normalized);
          }
        }

        for (const folder of listing.folders) {
          const normalized = normalizeVaultPath(folder);
          if (isValidGitPath(normalized)) {
            pending.push(normalized);
          }
        }
      } catch (error) {
        console.warn(`[Sync] Failed to list contents of folder: ${current}. Skipping.`, error);
      }
    }

    return results;
  }

  public async detectLocalChanges(
    index: SyncIndexState,
    ignore: IgnoreMatcher
  ): Promise<boolean> {
    const localFiles = await this.collectLocalFiles(ignore);

    for (const [path, entry] of Object.entries(index.entries)) {
      if (ignore.ignores(path)) {
        continue;
      }
      if (entry.deletedLocally) {
        return true;
      }

      const local = localFiles.get(path);
      if (!local) {
        return true;
      }

      if (local.stat.size !== entry.size) {
        return true;
      }

      if (local.stat.mtime > entry.localMtime) {
        return true;
      }
    }

    for (const path of localFiles.keys()) {
      if (!index.entries[path]) {
        return true;
      }
    }

    return false;
  }

  private async getRemoteSnapshot(): Promise<RemoteSnapshot> {
    try {
      const snapshot = await this.client.getLatestSnapshot();
      const serverTimeMs = this.client.getLastServerTimeMs() ?? Date.now();
      return { ...snapshot, serverTimeMs };
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 404 || error.status === 409)
      ) {
        return {
          commitSha: "",
          commitTime: 0,
          treeSha: "",
          files: [],
          serverTimeMs: Date.now()
        };
      }
      throw error;
    }
  }

  private async writeRemoteFile(
    remote: RemoteFile
  ): Promise<{ stat: { mtime: number } } | null> {
    const blob = await this.client.getBlob(remote.sha);
    const path = normalizeVaultPath(remote.path);

    await this.ensureParentFolder(path);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if (blob.encoding === "base64") {
        const data = base64ToArrayBuffer(blob.content);
        await this.app.vault.modifyBinary(existing, data);
      } else {
        await this.app.vault.modify(existing, blob.content);
      }
      return existing;
    }

    // Check disk directly for files not in vault index (e.g. .obsidian/ files)
    const diskStat = await this.app.vault.adapter.stat(path);
    if (diskStat) {
      if (diskStat.type === "folder") {
        throw new Error(`Cannot write file ${path}: a folder exists at this path.`);
      }

      if (blob.encoding === "base64") {
        const data = base64ToArrayBuffer(blob.content);
        await this.app.vault.adapter.writeBinary(path, data);
      } else {
        await this.app.vault.adapter.write(path, blob.content);
      }

      const newStat = await this.app.vault.adapter.stat(path);
      return { stat: { mtime: newStat?.mtime ?? Date.now() } };
    }

    // Doesn't exist on disk, use vault.create to ensure it's added to the index if supported
    if (blob.encoding === "base64") {
      const data = base64ToArrayBuffer(blob.content);
      return this.app.vault.createBinary(path, data);
    }

    return this.app.vault.create(path, blob.content);
  }

  private async readFileBinary(
    file: LocalFileEntry,
    skippedFiles: string[]
  ): Promise<ArrayBuffer | null> {
    if (file.stat.size > MAX_BLOB_BYTES) {
      skippedFiles.push(file.path);
      return null;
    }

    return file.readBinary();
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
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          // Ignore errors where the folder was created by a concurrent task
          if (!(error instanceof Error && error.message.includes("already exists"))) {
            throw error;
          }
        }
      }
    }
  }
 
  private getIgnoreMatcher(): IgnoreMatcher {
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
    return new IgnoreMatcher(ignorePatterns);
  }
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\//, "");
}

// isObsidianPattern removed as it's no longer needed in SyncEngine

function isValidGitPath(path: string): boolean {
  if (!path) {
    return false;
  }
  if (path.includes(":")) {
    return false;
  }
  const parts = path.split("/");
  return !parts.some((part) => part.length === 0 || part === "." || part === "..");
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
  return {
    entries,
    lastKnownRemoteHeadSha: index.lastKnownRemoteHeadSha
  };
}

async function calculateGitSha(data: ArrayBuffer): Promise<string> {
  const header = `blob ${data.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);
  const fullBytes = new Uint8Array(headerBytes.byteLength + data.byteLength);
  fullBytes.set(headerBytes);
  fullBytes.set(new Uint8Array(data), headerBytes.byteLength);
  const hashBuffer = await crypto.subtle.digest("SHA-1", fullBytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, limit);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const current = nextIndex;
      if (current >= items.length) {
        return;
      }
      nextIndex += 1;
      results[current] = await worker(items[current]);
    }
  };

  const workers = Array.from(
    { length: Math.min(safeLimit, items.length) },
    () => runWorker()
  );

  await Promise.all(workers);
  return results;
}
