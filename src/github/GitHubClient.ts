export type GitObjectType = "blob" | "tree";

export interface GitTreeItem {
  path: string;
  mode: string;
  type: GitObjectType;
  sha: string;
  size?: number;
  url: string;
}

export interface GitTreeResponse {
  sha: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

export interface GitCommitResponse {
  sha: string;
  tree: { sha: string; url: string };
  parents: Array<{ sha: string; url: string }>;
  committer?: { date: string };
  author?: { date: string };
}

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  pathPrefix?: string;
  apiBaseUrl?: string;
}

export interface GitHubApiErrorDetails {
  status: number;
  message: string;
  requestId?: string;
  retryAfter?: number;
  rateLimitResetAt?: number;
  isAbuseLimit?: boolean;
}

export class GitHubApiError extends Error {
  status: number;
  requestId?: string;
  retryAfter?: number;
  rateLimitResetAt?: number;
  isAbuseLimit: boolean;

  constructor(details: GitHubApiErrorDetails) {
    super(details.message);
    this.status = details.status;
    this.requestId = details.requestId;
    this.retryAfter = details.retryAfter;
    this.rateLimitResetAt = details.rateLimitResetAt;
    this.isAbuseLimit = details.isAbuseLimit ?? false;
  }
}

export interface RemoteFile {
  path: string;
  sha: string;
  size: number;
}

export interface GitCreateTreeEntry {
  path: string;
  mode: string;
  type: GitObjectType;
  sha?: string | null;
  content?: string;
}

export class GitHubClient {
  private token: string;
  private owner: string;
  private repo: string;
  private branch: string;
  private pathPrefix: string;
  private apiBaseUrl: string;
  private cachedOwner?: string;
  private lastServerTimeMs?: number;
  private commitChainPromise: Promise<any> = Promise.resolve();

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch;
    this.pathPrefix = normalizePathPrefix(options.pathPrefix ?? "");
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  updateOptions(options: Partial<GitHubClientOptions>): void {
    if (options.token !== undefined) {
      this.token = options.token;
    }
    if (options.owner !== undefined) {
      this.owner = options.owner;
      this.cachedOwner = undefined; // Reset cache if owner changes
    }
    if (options.repo !== undefined) {
      this.repo = options.repo;
    }
    if (options.branch !== undefined) {
      this.branch = options.branch;
    }
    if (options.pathPrefix !== undefined) {
      this.pathPrefix = normalizePathPrefix(options.pathPrefix);
    }
    if (options.apiBaseUrl !== undefined) {
      this.apiBaseUrl = options.apiBaseUrl;
    }
  }

  resetCommitChain(): void {
    this.commitChainPromise = Promise.resolve();
  }

  getLastServerTimeMs(): number | null {
    return this.lastServerTimeMs ?? null;
  }

  async getBranchRef(): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>(
      "GET",
      await this.buildPath(`/git/ref/heads/${encodeURIComponent(this.branch)}`)
    );
    return ref.object.sha;
  }

  async getCommit(sha: string): Promise<GitCommitResponse> {
    return this.request<GitCommitResponse>(
      "GET",
      await this.buildPath(`/git/commits/${sha}`)
    );
  }

  async getTree(sha: string, recursive = true): Promise<GitTreeResponse> {
    const query = recursive ? "?recursive=1" : "";
    return this.request<GitTreeResponse>(
      "GET",
      await this.buildPath(`/git/trees/${sha}${query}`)
    );
  }

  async getLatestTree(): Promise<{
    commitSha: string;
    tree: GitTreeResponse;
    commitTime: number;
  }> {
    const commitSha = await this.getBranchRef();
    const commit = await this.getCommit(commitSha);
    const tree = await this.getTree(commit.tree.sha, true);
    return { commitSha, tree, commitTime: parseCommitTime(commit) };
  }

  async getLatestSnapshot(): Promise<{
    commitSha: string;
    commitTime: number;
    treeSha: string;
    files: RemoteFile[];
  }> {
    const latest = await this.getLatestTree();
    if (latest.tree.truncated) {
      throw new Error(
        "Remote tree is truncated. Vault Sync cannot safely list all files."
      );
    }
    const files = latest.tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => {
        const path = this.stripPrefix(item.path);
        return path ? { path, sha: item.sha, size: item.size ?? 0 } : null;
      })
      .filter((item): item is RemoteFile => item !== null);

    return {
      commitSha: latest.commitSha,
      commitTime: latest.commitTime,
      treeSha: latest.tree.sha,
      files
    };
  }

  async listRemoteFiles(): Promise<RemoteFile[]> {
    const snapshot = await this.getLatestSnapshot();
    return snapshot.files;
  }

  async getBlob(sha: string): Promise<{ content: string; encoding: string }> {
    return this.request<{ content: string; encoding: string }>(
      "GET",
      await this.buildPath(`/git/blobs/${sha}`)
    );
  }

  async createTextBlob(content: string): Promise<string> {
    const response = await this.request<{ sha: string }>(
      "POST",
      await this.buildPath("/git/blobs"),
      {
        content,
        encoding: "utf-8"
      }
    );
    return response.sha;
  }

  async createBinaryBlob(data: ArrayBuffer): Promise<string> {
    const response = await this.request<{ sha: string }>(
      "POST",
      await this.buildPath("/git/blobs"),
      {
        content: arrayBufferToBase64(data),
        encoding: "base64"
      }
    );
    return response.sha;
  }

  async createTree(
    baseTreeSha: string | undefined,
    entries: GitCreateTreeEntry[]
  ): Promise<string> {
    return this.serializeCommitChain(async () => {
      const payload: Record<string, unknown> = {
        tree: entries.map((entry) => ({
          ...entry,
          path: this.addPrefix(normalizeVaultPath(entry.path))
        }))
      };

      if (baseTreeSha) {
        payload.base_tree = baseTreeSha;
      }

      const response = await this.request<{ sha: string }>(
        "POST",
        await this.buildPath("/git/trees"),
        payload
      );
      return response.sha;
    });
  }

  async createCommit(
    message: string,
    treeSha: string,
    parentShas: string[]
  ): Promise<string> {
    return this.serializeCommitChain(async () => {
      const response = await this.request<{ sha: string }>(
        "POST",
        await this.buildPath("/git/commits"),
        {
          message,
          tree: treeSha,
          parents: parentShas
        }
      );
      return response.sha;
    });
  }

  async updateBranchRef(newSha: string, force = false): Promise<void> {
    await this.serializeCommitChain(async () => {
      await this.request(
        "PATCH",
        await this.buildPath(`/git/refs/heads/${encodeURIComponent(this.branch)}`),
        {
          sha: newSha,
          force
        }
      );
    });
  }

  async createBranchRef(newSha: string): Promise<void> {
    await this.serializeCommitChain(async () => {
      await this.request(
        "POST",
        await this.buildPath("/git/refs"),
        {
          ref: `refs/heads/${this.branch}`,
          sha: newSha
        }
      );
    });
  }

  async initializeRepository(): Promise<void> {
    await this.request(
      "PUT",
      await this.buildPath("/contents/.vault-sync-init"),
      {
        message: "Initial commit by Vault Sync",
        content: btoa("Vault Sync initialization file"),
        branch: this.branch
      }
    );
  }

  private async getOwner(): Promise<string> {
    if (this.owner) {
      return this.owner;
    }
    if (!this.cachedOwner) {
      const user = await this.request<{ login: string }>("GET", `${this.apiBaseUrl}/user`);
      this.cachedOwner = user.login;
    }
    return this.cachedOwner;
  }

  private async buildPath(path: string): Promise<string> {
    const owner = await this.getOwner();
    return `${this.apiBaseUrl}/repos/${owner}/${this.repo}${path}`;
  }

  private stripPrefix(path: string): string | null {
    if (!this.pathPrefix) {
      return path;
    }
    if (path.startsWith(this.pathPrefix)) {
      return path.slice(this.pathPrefix.length);
    }
    return null;
  }

  private addPrefix(path: string): string {
    if (!this.pathPrefix) {
      return path;
    }
    return `${this.pathPrefix}${path}`;
  }

  private serializeCommitChain<T>(work: () => Promise<T>): Promise<T> {
    const next = this.commitChainPromise.then(work);
    this.commitChainPromise = next.then(() => {});
    return next;
  }

  private async request<T = unknown>(
    method: string,
    url: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const payload = body ? JSON.stringify(body) : undefined;
    let attempt = 0;

    while (true) {
      const response = await fetch(url, {
        method,
        headers,
        body: payload,
        cache: "no-store"
      });

      const serverTimeMs = parseServerTimeMs(response.headers.get("date"));
      if (serverTimeMs !== null) {
        this.lastServerTimeMs = serverTimeMs;
      }

      if (response.ok) {
        if (response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      }

      const retryDelay = getRetryDelayMs(response, attempt);
      if (retryDelay !== null && attempt < MAX_REQUEST_RETRIES) {
        attempt += 1;
        await delay(retryDelay);
        continue;
      }

      await this.throwRequestError(response);
    }
  }

  private async throwRequestError(response: Response): Promise<never> {
    let message = `GitHub API error (${response.status})`;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) {
        message = payload.message;
      }
    } else {
      const text = await response.text();
      if (text) {
        message = text;
      }
    }

    const requestId = response.headers.get("x-github-request-id") ?? undefined;
    const retryAfter = parseInt(
      response.headers.get("retry-after") ?? "",
      10
    );
    const rateLimitReset = parseInt(
      response.headers.get("x-ratelimit-reset") ?? "",
      10
    );

    const lowerMessage = message.toLowerCase();
    const isAbuseLimit =
      response.status === 403 &&
      (lowerMessage.includes("secondary rate limit") ||
        lowerMessage.includes("abuse detection"));

    throw new GitHubApiError({
      status: response.status,
      message,
      requestId,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
      rateLimitResetAt: Number.isFinite(rateLimitReset)
        ? rateLimitReset * 1000
        : undefined,
      isAbuseLimit
    });
  }
}

const MAX_REQUEST_RETRIES = 3;
const MIN_RETRY_DELAY_MS = 1000;

function getRetryDelayMs(response: Response, attempt: number): number | null {
  const retryAfter = parseRetryAfterHeader(response.headers.get("retry-after"));
  const resetAt = parseRateLimitResetHeader(
    response.headers.get("x-ratelimit-reset")
  );

  if (response.status === 429) {
    if (retryAfter !== null) {
      return Math.max(MIN_RETRY_DELAY_MS, retryAfter * 1000);
    }
    return Math.max(MIN_RETRY_DELAY_MS, 1000 * Math.pow(2, attempt));
  }

  if (response.status === 403 && (retryAfter !== null || resetAt !== null)) {
    if (retryAfter !== null) {
      return Math.max(MIN_RETRY_DELAY_MS, retryAfter * 1000);
    }
    if (resetAt !== null) {
      const delayMs = resetAt * 1000 - Date.now();
      return Math.max(MIN_RETRY_DELAY_MS, delayMs);
    }
  }

  return null;
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRateLimitResetHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseServerTimeMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\//, "");
}

function parseCommitTime(commit: GitCommitResponse): number {
  const dateValue = commit.committer?.date ?? commit.author?.date;
  const parsed = dateValue ? Date.parse(dateValue) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunkSize = 0x8000;
  const parts: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    parts.push(String.fromCharCode(...chunk));
  }

  return btoa(parts.join(""));
}
