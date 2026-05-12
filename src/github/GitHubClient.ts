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
}

export class GitHubApiError extends Error {
  status: number;
  requestId?: string;
  retryAfter?: number;
  rateLimitResetAt?: number;

  constructor(details: GitHubApiErrorDetails) {
    super(details.message);
    this.status = details.status;
    this.requestId = details.requestId;
    this.retryAfter = details.retryAfter;
    this.rateLimitResetAt = details.rateLimitResetAt;
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

  async getBranchRef(): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>(
      "GET",
      this.buildPath(`/git/ref/heads/${encodeURIComponent(this.branch)}`)
    );
    return ref.object.sha;
  }

  async getCommit(sha: string): Promise<GitCommitResponse> {
    return this.request<GitCommitResponse>(
      "GET",
      this.buildPath(`/git/commits/${sha}`)
    );
  }

  async getTree(sha: string, recursive = true): Promise<GitTreeResponse> {
    const query = recursive ? "?recursive=1" : "";
    return this.request<GitTreeResponse>(
      "GET",
      this.buildPath(`/git/trees/${sha}${query}`)
    );
  }

  async getLatestTree(): Promise<{ commitSha: string; tree: GitTreeResponse }> {
    const commitSha = await this.getBranchRef();
    const commit = await this.getCommit(commitSha);
    const tree = await this.getTree(commit.tree.sha, true);
    return { commitSha, tree };
  }

  async listRemoteFiles(): Promise<RemoteFile[]> {
    const { tree } = await this.getLatestTree();
    return tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => {
        const path = this.stripPrefix(item.path);
        return path ? { path, sha: item.sha, size: item.size ?? 0 } : null;
      })
      .filter((item): item is RemoteFile => item !== null);
  }

  async getBlob(sha: string): Promise<{ content: string; encoding: string }> {
    return this.request<{ content: string; encoding: string }>(
      "GET",
      this.buildPath(`/git/blobs/${sha}`)
    );
  }

  async createTextBlob(content: string): Promise<string> {
    const response = await this.request<{ sha: string }>(
      "POST",
      this.buildPath("/git/blobs"),
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
      this.buildPath("/git/blobs"),
      {
        content: arrayBufferToBase64(data),
        encoding: "base64"
      }
    );
    return response.sha;
  }

  async createTree(
    baseTreeSha: string,
    entries: GitCreateTreeEntry[]
  ): Promise<string> {
    const response = await this.request<{ sha: string }>(
      "POST",
      this.buildPath("/git/trees"),
      {
        base_tree: baseTreeSha,
        tree: entries.map((entry) => ({
          ...entry,
          path: this.addPrefix(normalizeVaultPath(entry.path))
        }))
      }
    );
    return response.sha;
  }

  async createCommit(
    message: string,
    treeSha: string,
    parentShas: string[]
  ): Promise<string> {
    const response = await this.request<{ sha: string }>(
      "POST",
      this.buildPath("/git/commits"),
      {
        message,
        tree: treeSha,
        parents: parentShas
      }
    );
    return response.sha;
  }

  async updateBranchRef(newSha: string, force = false): Promise<void> {
    await this.request(
      "PATCH",
      this.buildPath(`/git/refs/heads/${encodeURIComponent(this.branch)}`),
      {
        sha: newSha,
        force
      }
    );
  }

  private buildPath(path: string): string {
    return `${this.apiBaseUrl}/repos/${this.owner}/${this.repo}${path}`;
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

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      await this.throwRequestError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
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

    throw new GitHubApiError({
      status: response.status,
      message,
      requestId,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
      rateLimitResetAt: Number.isFinite(rateLimitReset)
        ? rateLimitReset * 1000
        : undefined
    });
  }
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\//, "");
}

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
