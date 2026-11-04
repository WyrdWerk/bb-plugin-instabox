// Repo and branch picker data from `gh` on the hub (it must be logged in there).
// Never returns tokens: only owner / name / URL (credentials stripped) / private
// flag / default branch, and branch names. Cached ~10 min. gh missing or not
// logged in → "unavailable", and the page keeps manual URL and branch entry.
// Ported from bb-plugin-boat (src/github-repos.ts), plus branches and default owners.
import { z } from "zod";
import { stripCredentials } from "./projects.ts";

export type GhRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RepoListing {
  owner: string;
  name: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string | null;
}

export type RepoListResult = { status: "ok"; owners: string[]; repos: RepoListing[]; fetchedAt: number; cached: boolean } | { status: "unavailable"; reason: string };
export type BranchListResult = { status: "ok"; defaultBranch: string | null; branches: string[] } | { status: "unavailable"; reason: string };

/** Owners whose repos are offered when the githubOwners setting is empty. */
export const DEFAULT_OWNERS = ["WyrdWerk"];
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const ghRepoSchema = z.object({
  name: z.string(),
  url: z.string(),
  isPrivate: z.boolean().optional(),
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
});

export function parseGhRepoList(owner: string, stdout: string): RepoListing[] {
  const raw = z.array(z.unknown()).parse(JSON.parse(stdout));
  return raw.map((r) => {
    const p = ghRepoSchema.parse(r);
    return { owner, name: p.name, url: stripCredentials(p.url), isPrivate: p.isPrivate ?? false, defaultBranch: p.defaultBranchRef?.name || null };
  });
}

/** gh's failure as a short, safe reason (no stderr passthrough). */
export function unavailableReason(err: unknown, stderr = ""): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") return "gh is not installed on the bb server";
  if (/auth login|not logged|authentication|HTTP 401/i.test(stderr)) return "gh on the bb server is not logged in (run `gh auth login` there)";
  if (/HTTP 404|Not Found|Could not resolve/i.test(stderr)) return "not found, or gh on the bb server has no access";
  return "gh failed on the bb server";
}

/**
 * The owners to list: the setting's comma list, or (empty) DEFAULT_OWNERS plus
 * the account gh is logged in as. Invalid names are dropped; case-insensitive dedupe.
 */
export async function resolveOwners(setting: string, ghLogin: () => Promise<string | null>): Promise<string[]> {
  const configured = setting.split(",").map((o) => o.trim()).filter(Boolean);
  const list = configured.length > 0 ? configured : [...DEFAULT_OWNERS, (await ghLogin().catch(() => null)) ?? ""];
  const seen = new Set<string>();
  return list.filter((o) => OWNER_RE.test(o) && !seen.has(o.toLowerCase()) && (seen.add(o.toLowerCase()), true));
}

export function createRepoLister(opts: { runGh: GhRun; owners: () => Promise<string[]>; now: () => number; ttlMs?: number }) {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  let cache: { key: string; at: number; repos: RepoListing[] } | null = null;
  const branchCache = new Map<string, { at: number; value: BranchListResult & { status: "ok" } }>();

  async function repos(force = false): Promise<RepoListResult> {
    const owners = await opts.owners();
    if (owners.length === 0) return { status: "unavailable", reason: "no valid GitHub owners (setting githubOwners)" };
    const key = owners.join(",");
    if (!force && cache && cache.key === key && opts.now() - cache.at < ttl) return { status: "ok", owners, repos: cache.repos, fetchedAt: cache.at, cached: true };
    const out: RepoListing[] = [];
    for (const owner of owners) {
      let res;
      try {
        res = await opts.runGh(["repo", "list", owner, "--limit", "300", "--json", "name,url,isPrivate,defaultBranchRef"]);
      } catch (err) {
        return { status: "unavailable", reason: unavailableReason(err) };
      }
      if (res.code !== 0) return { status: "unavailable", reason: `${owner}: ${unavailableReason(null, res.stderr)}` };
      try {
        out.push(...parseGhRepoList(owner, res.stdout));
      } catch {
        return { status: "unavailable", reason: "gh returned output the plugin could not read" };
      }
    }
    out.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
    cache = { key, at: opts.now(), repos: out };
    return { status: "ok", owners, repos: out, fetchedAt: cache.at, cached: false };
  }

  /** Branches of github.com/<owner>/<repo> (default branch first), via `gh api`. */
  async function branches(owner: string, repo: string, force = false): Promise<BranchListResult> {
    if (!OWNER_RE.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return { status: "unavailable", reason: "not a GitHub owner/repo" };
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = branchCache.get(key);
    if (!force && hit && opts.now() - hit.at < ttl) return hit.value;
    let def, list;
    try {
      def = await opts.runGh(["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"]);
      list = await opts.runGh(["api", "--paginate", `repos/${owner}/${repo}/branches?per_page=100`, "--jq", ".[].name"]);
    } catch (err) {
      return { status: "unavailable", reason: unavailableReason(err) };
    }
    if (def.code !== 0 || list.code !== 0) return { status: "unavailable", reason: unavailableReason(null, `${def.stderr}\n${list.stderr}`) };
    const defaultBranch = def.stdout.trim() || null;
    const names = [...new Set(list.stdout.split("\n").map((s) => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const ordered = defaultBranch && names.includes(defaultBranch) ? [defaultBranch, ...names.filter((n) => n !== defaultBranch)] : names;
    const value = { status: "ok" as const, defaultBranch, branches: ordered.slice(0, 500) };
    branchCache.set(key, { at: opts.now(), value });
    return value;
  }

  return { repos, branches };
}
