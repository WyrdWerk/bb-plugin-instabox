// Project runners: a plugin-owned project is a name plus a set of GitHub repos,
// each with an optional branch. A runner created with a project gets every repo
// cloned at its branch under ~/workspace/repos/<name> (cloneRepoScript), and each
// clone is registered as a bb project source on that machine (planSources), so
// bb's checkout setup reuses it instead of cloning again.
//
// Ported from bb-plugin-boat (src/projects.ts), which stores `branch` but does
// not use it; here the clone honours it.
import { z } from "zod";

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Where the clones go, relative to the machine user's home. */
export const REPOS_SUBDIR = "workspace/repos";

export interface ProjectRepo {
  /** Directory name under ~/workspace/repos. */
  name: string;
  /** https://github.com/<owner>/<repo>.git, no credentials. */
  url: string;
  /** Branch to clone and check out; empty or absent: the repo's default branch. */
  branch?: string;
}

export interface Project {
  name: string;
  repos: ProjectRepo[];
}

/** Only plain https GitHub repo URLs: no credentials, query, fragment or port. Returns the canonical form. */
export function validateRepoUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Not a URL. Use https://github.com/<owner>/<repo>.git" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Only https:// URLs are allowed" };
  if (u.username || u.password || s.includes("@")) return { ok: false, error: "URLs must not contain credentials (no user:token@)" };
  if (u.hostname.toLowerCase() !== "github.com") return { ok: false, error: "Only github.com repositories are allowed" };
  if (u.search || u.hash || u.port) return { ok: false, error: "No port, query or fragment allowed" };
  const m = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(u.pathname);
  if (!m) return { ok: false, error: "Expected https://github.com/<owner>/<repo>.git" };
  return { ok: true, url: `https://github.com/${m[1]}/${m[2]}.git` };
}

/**
 * A branch name git accepts and that is safe as a single shell word and git
 * argument: no leading "-" (option injection), no "..", "//", "@{", trailing
 * "/" or ".", or ".lock" suffix.
 */
export function branchError(branch: string): string | null {
  const b = branch;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(b)) return "Branch: letters, digits, . _ / - only (max 200)";
  if (b.startsWith("-") || b.startsWith("/") || b.startsWith(".")) return "Branch must not start with -, / or .";
  if (b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return "Branch must not end with /, . or .lock";
  if (b.includes("..") || b.includes("//") || b.includes("/.")) return "Branch must not contain .., // or /.";
  return null;
}

export const repoInputSchema = z.object({
  name: z.string(),
  url: z.string(),
  branch: z.string().optional(),
});

export function validateRepo(r: unknown): ProjectRepo {
  const p = repoInputSchema.parse(r);
  const name = p.name.trim();
  if (!REPO_NAME_RE.test(name) || name === "." || name === "..") throw new Error(`Repo name "${p.name}": letters, digits, . _ - only`);
  const v = validateRepoUrl(p.url);
  if (!v.ok) throw new Error(`${name}: ${v.error}`);
  const branch = (p.branch ?? "").trim();
  if (branch) {
    const e = branchError(branch);
    if (e) throw new Error(`${name}: ${e}`);
  }
  return { name, url: v.url, ...(branch ? { branch } : {}) };
}

/** Defence in depth: never keep credentials from a URL. */
export function stripCredentials(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, "$1");
}

/** "github.com/owner/repo" regardless of scheme, credentials, scp form, .git, case. */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  u = u.replace(/^[^@/]*@/, "");
  u = u.replace(/:\d+(?=\/)/, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  u = u.toLowerCase();
  return u.length > 0 && u.includes("/") ? u : null;
}

// ---------------------------------------------------------------- clone on the runner

/**
 * Clone one repo on the machine (as its user), from stdin `name url branch`
 * (branch `-` = the repo's default). Auth: the machine's GH_TOKEN org Secret
 * placeholder, offered through a one-off credential helper given with `git -c`,
 * so nothing is written into the remote URL or any git config; InstaBox's proxy
 * swaps in the real token for github.com. Public repos clone without it.
 * An existing clone is left as it is (it may hold work) and reported with the
 * branch it is on. Prints one line and exits non-zero on failure:
 *   repo cloned|present|failed <name> <branch|-> <sha|-> <path|reason>
 */
export function cloneRepoScript(): string {
  return `set -uo pipefail
root="$HOME/${REPOS_SUBDIR}"
mkdir -p "$root"
read -r name url branch || true
case "$name" in ""|.|..|*/*) echo "repo failed - - - bad-name"; exit 2;; esac
dir="$root/$name"
if [ -z "\${GH_TOKEN:-}" ] && [ -r "$HOME/.config/bb-instabox/secrets.env" ]; then
  GH_TOKEN=$(sed -n 's/^GH_TOKEN=//p' "$HOME/.config/bb-instabox/secrets.env" | head -1)
fi
export GH_TOKEN="\${GH_TOKEN:-}"
state=present
if [ ! -d "$dir/.git" ]; then
  [ -e "$dir" ] && { echo "repo failed $name - - path-exists-not-a-repo"; exit 3; }
  args=(clone --quiet)
  [ "$branch" != "-" ] && args+=(--branch "$branch")
  err=$(mktemp)
  if GIT_TERMINAL_PROMPT=0 git -c credential.helper= \\
      -c 'credential.helper=!f() { test "$1" = get || exit 0; [ -n "$GH_TOKEN" ] || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \\
      "\${args[@]}" -- "$url" "$dir" 2>"$err"; then
    state=cloned
  else
    why=$(tail -n 1 "$err" | sed -E 's/ibsec_[A-Za-z0-9_-]+/[redacted]/g; s/[^A-Za-z0-9 ._:\\/-]//g' | tr ' ' '_' | cut -c1-160)
    rm -f "$err"; rm -rf "$dir"
    echo "repo failed $name - - \${why:-clone-failed}"; exit 4
  fi
  rm -f "$err"
fi
cur=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null || echo detached)
sha=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo -)
echo "repo $state $name $cur $sha $dir"
`;
}

/** stdin for cloneRepoScript (validated, so every field is one shell-safe word). */
export function cloneInput(r: ProjectRepo): string {
  const v = validateRepo(r);
  return `${v.name} ${v.url} ${v.branch ?? "-"}\n`;
}

export interface CloneResult {
  state: "cloned" | "present" | "failed";
  name: string;
  branch: string | null;
  sha: string | null;
  /** Absolute path on the machine, or the failure reason. */
  detail: string;
}

export function parseCloneResult(stdout: string): CloneResult | null {
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("repo ")).pop();
  const m = line ? /^repo (cloned|present|failed) (\S+) (\S+) (\S+) (.+)$/.exec(line) : null;
  if (!m) return null;
  return { state: m[1] as CloneResult["state"], name: m[2]!, branch: m[3] === "-" ? null : m[3]!, sha: m[4] === "-" ? null : m[4]!, detail: m[5]! };
}

/** The wanted branch is checked out (no branch wanted: any). A present clone on another branch is left alone but reported. */
export function branchMismatch(repo: ProjectRepo, res: CloneResult): string | null {
  if (!repo.branch || res.state === "failed") return null;
  return res.branch === repo.branch ? null : `${repo.name} is on ${res.branch ?? "?"}, not ${repo.branch} (an existing clone is not switched)`;
}

// ---------------------------------------------------------------- bb project sources

export interface ProjectLite {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  sources: { hostId: string; path: string }[];
}

export interface ClonedRepo {
  name: string;
  url: string;
  path: string;
}

export type SourceAction =
  | { kind: "add"; repo: string; projectId: string; projectName: string; path: string }
  | { kind: "present"; repo: string; projectId: string; projectName: string; path: string }
  | { kind: "create"; repo: string; path: string }
  | { kind: "unmatched"; repo: string; url: string }
  | { kind: "ambiguous"; repo: string; projectNames: string[] };

/** What to register on this host for each cloned repo, matching bb projects by git remote (pure). */
export function planSources(repos: ClonedRepo[], projects: ProjectLite[], hostId: string, createMissing: boolean): SourceAction[] {
  const byRemote = new Map<string, ProjectLite[]>();
  for (const p of projects) {
    const key = normalizeRemote(p.gitRemoteUrl);
    if (key) byRemote.set(key, [...(byRemote.get(key) ?? []), p]);
  }
  return repos.map((r): SourceAction => {
    const key = normalizeRemote(r.url);
    const hits = key ? (byRemote.get(key) ?? []) : [];
    if (hits.length > 1) return { kind: "ambiguous", repo: r.name, projectNames: hits.map((p) => p.name) };
    const p = hits[0];
    if (!p) return createMissing ? { kind: "create", repo: r.name, path: r.path } : { kind: "unmatched", repo: r.name, url: r.url };
    const existing = p.sources.find((s) => s.hostId === hostId);
    if (existing) return { kind: "present", repo: r.name, projectId: p.id, projectName: p.name, path: existing.path };
    return { kind: "add", repo: r.name, projectId: p.id, projectName: p.name, path: r.path };
  });
}
