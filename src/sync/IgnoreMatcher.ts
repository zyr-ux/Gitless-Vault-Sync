export class IgnoreMatcher {
  private rules: RegExp[];

  constructor(patterns: string[]) {
    this.rules = patterns
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0)
      .map((pattern) => toRegex(normalizePath(pattern)));
  }

  ignores(path: string): boolean {
    const normalized = normalizePath(path);
    return this.rules.some((rule) => rule.test(normalized));
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\//, "");
}

function toRegex(pattern: string): RegExp {
  let normalized = pattern;
  if (normalized.endsWith("/")) {
    normalized = `${normalized}**`;
  }

  let regex = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        regex += ".*";
        i += 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(char);
  }

  return new RegExp(`^${regex}(/.*)?$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
