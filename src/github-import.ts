// "Import from GitHub": make bb projects from GitHub repos so they show in bb's
// New thread Project picker. bb creates a project only from a local_path source
// on a host, and reads the project's git remote from that checkout, so each
// import needs a checkout on the hub: an existing one at <hubCheckoutDir>/<repo>
// when its origin is that repo, else a fresh clone there (or, when that path
// holds another repo, the same at <hubCheckoutDir>/<owner>/<repo>). Clones use the hub's
// gh login through a one-off credential helper; no token is written into the
// remote URL or git config. Repos that already are bb projects (matched by
// remote) are skipped. Nothing is deleted.
import { normalizeRemote, REPO_NAME_RE, stripCredentials } from "./projects.ts";

export interface ImportCandidate {
  owner: string;
  name: string;
  /** https://github.com/<owner>/<name>(.git), no credentials. */
  url: string;
}

export interface BbProjectLite {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
}

export type ImportResult =
  | { repo: string; status: "exists"; projectId: string; projectName: string }
  | { repo: string; status: "created"; projectId: string; path: string; checkout: "existing" | "cloned"; gitRemoteUrl: string }
  | { repo: string; status: "failed"; message: string };

export interface ImportDeps {
  /** Absolute directory on the hub for checkouts. */
  checkoutDir: string;
  listProjects(): Promise<BbProjectLite[]>;
  /** null: the path does not exist. "" : exists but has no origin (or is not a git repo). */
  originOf(path: string): Promise<string | null>;
  clone(url: string, path: string): Promise<void>;
  createProject(a: { name: string; path: string }): Promise<{ id: string }>;
  sleep(ms: number): Promise<void>;
}

/** The bb project (if any) whose git remote is this repo. */
export function existingProject(repoUrl: string, projects: BbProjectLite[]): BbProjectLite | null {
  const key = normalizeRemote(repoUrl);
  return projects.find((p) => key !== null && normalizeRemote(p.gitRemoteUrl) === key) ?? null;
}

export async function importRepo(repo: ImportCandidate, d: ImportDeps): Promise<ImportResult> {
  const label = `${repo.owner}/${repo.name}`;
  if (!REPO_NAME_RE.test(repo.name) || repo.name === "." || repo.name === "..") return { repo: label, status: "failed", message: "not a repo name" };
  const url = `https://github.com/${repo.owner}/${repo.name}.git`;
  const have = existingProject(url, await d.listProjects());
  if (have) return { repo: label, status: "exists", projectId: have.id, projectName: have.name };

  // <dir>/<repo> first (reused when it is this repo, else cloned there when
  // free); when it holds another repo, e.g. a same-named repo of another owner,
  // fall back to <dir>/<owner>/<repo> the same way.
  const base = d.checkoutDir.replace(/\/+$/, "");
  let path = "";
  let checkout: "existing" | "cloned" | null = null;
  for (const candidate of [`${base}/${repo.name}`, `${base}/${repo.owner}/${repo.name}`]) {
    const origin = await d.originOf(candidate);
    if (origin === null) {
      try {
        await d.clone(url, candidate);
      } catch (err) {
        return { repo: label, status: "failed", message: `clone into ${candidate} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      path = candidate;
      checkout = "cloned";
      break;
    }
    if (normalizeRemote(origin) === normalizeRemote(url)) {
      if (stripCredentials(origin) !== origin) return { repo: label, status: "failed", message: `${candidate} has credentials in its origin URL; fix that checkout first` };
      path = candidate;
      checkout = "existing";
      break;
    }
  }
  if (checkout === null) {
    return { repo: label, status: "failed", message: `${base}/${repo.name} and ${base}/${repo.owner}/${repo.name} hold other content; move one or change hubCheckoutDir` };
  }

  let created: { id: string };
  try {
    created = await d.createProject({ name: repo.name, path });
  } catch (err) {
    return { repo: label, status: "failed", message: `bb refused the project: ${err instanceof Error ? err.message : String(err)}` };
  }
  // bb reads the remote from the checkout best-effort; wait for it so the project
  // is known to have its GitHub anchor (runners clone from it).
  for (let i = 0; i < 10; i++) {
    const p = (await d.listProjects()).find((x) => x.id === created.id);
    if (p?.gitRemoteUrl && normalizeRemote(p.gitRemoteUrl) === normalizeRemote(url)) {
      return { repo: label, status: "created", projectId: created.id, path, checkout, gitRemoteUrl: stripCredentials(p.gitRemoteUrl) };
    }
    await d.sleep(1000);
  }
  return { repo: label, status: "failed", message: `bb project ${created.id} was created from ${path} but bb has not recorded its GitHub remote; check the project in Settings → Projects` };
}

/** git args for a hub clone: the hub's gh login supplies credentials for this command only. */
export function hubCloneArgs(url: string, path: string): string[] {
  return ["-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential", "clone", "--quiet", "--", url, path];
}

export interface ImportListing {
  owner: string;
  name: string;
  url: string;
  isPrivate: boolean;
  /** The bb project that already has this repo's remote, if any. */
  bbProject: { id: string; name: string } | null;
}

/** The picker's repos, each marked with the bb project that already has its remote. */
export function importListing(repos: { owner: string; name: string; url: string; isPrivate: boolean }[], projects: BbProjectLite[]): ImportListing[] {
  return repos.map((r) => {
    const p = existingProject(r.url, projects);
    return { owner: r.owner, name: r.name, url: stripCredentials(r.url), isPrivate: r.isPrivate, bbProject: p ? { id: p.id, name: p.name } : null };
  });
}
