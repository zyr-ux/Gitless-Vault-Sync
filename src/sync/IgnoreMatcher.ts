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
  let p = pattern.trim();
  if (p.length === 0) {
    return /^$/; // Should not happen due to filter
  }

  const startsWithSlash = p.startsWith("/");
  if (startsWithSlash) {
    p = p.slice(1);
  }

  const endsWithSlash = p.endsWith("/");
  if (endsWithSlash) {
    p = p.slice(0, -1);
  }

  // Check for internal slashes (excluding leading/trailing)
  const hasInternalSlash = p.includes("/");

  let regex = "";
  for (let i = 0; i < p.length; i += 1) {
    const char = p[i];
    if (char === "*") {
      if (p[i + 1] === "*") {
        // Handle **/ or /** or /**/
        if (i === 0 && p[i + 2] === "/") {
          regex += "(.*\/)?";
          i += 2;
        } else if (i + 2 === p.length && p[i - 1] === "/") {
          regex += ".*";
          i += 1;
        } else if (p[i - 1] === "/" && p[i + 2] === "/") {
          regex += "(.*/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
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

  // If pattern has an internal slash or started with a slash, it's relative to root.
  // Otherwise, it can match anywhere (basename match).
  const base = hasInternalSlash || startsWithSlash ? `^${regex}` : `(^|.*/)${regex}`;
  return new RegExp(`${base}(/.*)?$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
