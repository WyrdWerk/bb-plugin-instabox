import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRepoLister, resolveOwners } from "../src/github-repos.ts";
import { ProjectStore } from "../src/project-store.ts";
import { branchError, branchMismatch, cloneInput, cloneRepoScript, normalizeRemote, parseCloneResult, planSources, validateRepo } from "../src/projects.ts";
import { checkRepoForm } from "../ui/projects-ui.ts";

function memKv() {
  const m = new Map<string, unknown>();
  return { get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
}

test("project store: create, repos with branches, rename, typed-name delete", async () => {
  const s = new ProjectStore(memKv());
  await s.create("Demo");
  await assert.rejects(s.create("demo"), /already exists/);
  await assert.rejects(s.create("bad name"), /lowercase/);
  await s.addRepo("demo", { name: "app", url: "https://github.com/acme/app", branch: " release/1.2 " });
  await s.addRepo("demo", { name: "lib", url: "https://github.com/acme/lib.git", branch: "" });
  await assert.rejects(s.addRepo("demo", { name: "app", url: "https://github.com/acme/other.git" }), /already has a repo named app/);
  assert.deepEqual((await s.get("demo"))?.repos, [
    { name: "app", url: "https://github.com/acme/app.git", branch: "release/1.2" },
    { name: "lib", url: "https://github.com/acme/lib.git" },
  ]);
  await s.updateRepo("demo", "lib", { name: "lib", url: "https://github.com/acme/lib.git", branch: "dev" });
  await assert.rejects(s.updateRepo("demo", "lib", { name: "app", url: "https://github.com/acme/lib.git" }), /already has a repo named app/);
  await s.rename("demo", "demo2");
  assert.equal(await s.get("demo"), null);
  assert.equal((await s.get("demo2"))?.repos[1]?.branch, "dev");
  await s.removeRepo("demo2", "app");
  await assert.rejects(s.delete("demo2", "demo"), /type demo2 exactly/);
  await s.delete("demo2", "demo2");
  assert.deepEqual(await s.list(), []);
});

test("repo and branch validation refuses credentials, other hosts and option-like branches", () => {
  assert.throws(() => validateRepo({ name: "x", url: "https://user:tok@github.com/acme/x.git" }), /credentials/);
  assert.throws(() => validateRepo({ name: "x", url: "https://gitlab.com/acme/x.git" }), /github\.com/);
  assert.throws(() => validateRepo({ name: "x", url: "http://github.com/acme/x.git" }), /https/);
  assert.throws(() => validateRepo({ name: "../x", url: "https://github.com/acme/x.git" }), /Repo name/);
  for (const bad of ["-upload-pack=x", "a..b", "a b", "a/", "x.lock", ".hidden", "a//b", "a/.b", "a;rm"]) assert.notEqual(branchError(bad), null, bad);
  for (const ok of ["main", "release/1.2", "feat_x-y.z"]) assert.equal(branchError(ok), null, ok);
  assert.equal(cloneInput({ name: "app", url: "https://github.com/acme/app", branch: "dev" }), "app https://github.com/acme/app.git dev\n");
  assert.equal(cloneInput({ name: "app", url: "https://github.com/acme/app.git" }), "app https://github.com/acme/app.git -\n");
  assert.deepEqual(checkRepoForm({ name: "app", url: "https://github.com/acme/app.git", branch: "--x" }), { ok: false, error: "Branch must not start with -, / or ." });
  assert.deepEqual(checkRepoForm({ name: "", url: "https://github.com/acme/app", branch: " dev " }), { ok: true, repo: { name: "app", url: "https://github.com/acme/app.git", branch: "dev" } });
});

test("branch mismatch is reported only when a branch was asked for", () => {
  const res = parseCloneResult("noise\nrepo present app main abc1234 /home/u/workspace/repos/app\n");
  assert.deepEqual(res, { state: "present", name: "app", branch: "main", sha: "abc1234", detail: "/home/u/workspace/repos/app" });
  assert.equal(branchMismatch({ name: "app", url: "u" }, res!), null);
  assert.equal(branchMismatch({ name: "app", url: "u", branch: "main" }, res!), null);
  assert.match(branchMismatch({ name: "app", url: "u", branch: "dev" }, res!) ?? "", /on main, not dev/);
  assert.equal(parseCloneResult("garbage"), null);
});

function sh(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

test("clone script clones at the chosen branch or the default, keeps an existing clone, and writes no credentials", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ib-clone-"));
  const work = join(tmp, "src");
  execFileSync("mkdir", ["-p", work]);
  sh(work, "init", "-q", "-b", "trunk");
  sh(work, "commit", "-q", "--allow-empty", "-m", "one");
  sh(work, "checkout", "-q", "-b", "feature/x");
  sh(work, "commit", "-q", "--allow-empty", "-m", "two");
  sh(work, "checkout", "-q", "trunk");
  const bare = join(tmp, "origin.git");
  sh(tmp, "clone", "-q", "--bare", work, bare);
  const home = join(tmp, "home");
  execFileSync("mkdir", ["-p", home]);
  const run = (stdin: string) => {
    const r = spawnSync("bash", ["-c", cloneRepoScript()], { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, GH_TOKEN: "ibsec_placeholder_test" } });
    return { code: r.status, res: parseCloneResult(r.stdout), out: r.stdout + r.stderr };
  };
  const a = run(`app ${bare} feature/x\n`);
  assert.equal(a.code, 0, a.out);
  assert.equal(a.res?.state, "cloned");
  assert.equal(a.res?.branch, "feature/x");
  assert.equal(a.res?.detail, join(home, "workspace/repos/app"));
  const b = run(`lib ${bare} -\n`);
  assert.equal(b.res?.branch, "trunk", b.out);
  const again = run(`app ${bare} trunk\n`);
  assert.equal(again.res?.state, "present");
  assert.equal(again.res?.branch, "feature/x");
  const bad = run(`bad ${bare} no-such-branch\n`);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.res?.state, "failed");
  assert.equal(spawnSync("test", ["-e", join(home, "workspace/repos/bad")]).status, 1, "a failed clone leaves nothing behind");
  assert.notEqual(run(`../x ${bare} -\n`).code, 0);
  for (const r of ["app", "lib"]) {
    const cfg = readFileSync(join(home, "workspace/repos", r, ".git/config"), "utf8");
    assert.doesNotMatch(cfg, /ibsec_|credential|x-access-token/);
    assert.match(cfg, new RegExp(`url = ${bare.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n`));
  }
  assert.equal(spawnSync("test", ["-e", join(home, ".gitconfig")]).status, 1, "no global git config written");
});

test("planSources matches bb projects by remote and only creates when asked", () => {
  const projects = [
    { id: "p1", name: "app", gitRemoteUrl: "git@github.com:Acme/App.git", sources: [] },
    { id: "p2", name: "lib", gitRemoteUrl: "https://github.com/acme/lib", sources: [{ hostId: "h1", path: "/x/lib" }] },
    { id: "p3", name: "dup-a", gitRemoteUrl: "https://github.com/acme/dup.git", sources: [] },
    { id: "p4", name: "dup-b", gitRemoteUrl: "https://github.com/acme/dup", sources: [] },
  ];
  const repos = ["app", "lib", "dup", "new"].map((n) => ({ name: n, url: `https://github.com/acme/${n}.git`, path: `/r/${n}` }));
  assert.deepEqual(
    planSources(repos, projects, "h1", false).map((a) => a.kind),
    ["add", "present", "ambiguous", "unmatched"],
  );
  assert.equal(planSources(repos, projects, "h1", true)[3]?.kind, "create");
  assert.equal(planSources(repos, projects, "h2", false)[1]?.kind, "add");
  assert.equal(normalizeRemote("https://x-access-token:t@github.com/Acme/App.git/"), "github.com/acme/app");
});

test("owners default to WyrdWerk plus the gh login; the lister caches and orders the default branch first", async () => {
  assert.deepEqual(await resolveOwners("", async () => "someone"), ["WyrdWerk", "someone"]);
  assert.deepEqual(await resolveOwners("", async () => "wyrdwerk"), ["WyrdWerk"]);
  assert.deepEqual(await resolveOwners("", async () => { throw new Error("no gh"); }), ["WyrdWerk"]);
  assert.deepEqual(await resolveOwners(" acme, bad owner!, Acme ,beta", async () => "x"), ["acme", "beta"]);
  const calls: string[] = [];
  let now = 0;
  const lister = createRepoLister({
    owners: async () => ["acme"],
    now: () => now,
    runGh: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "repo") return { code: 0, stderr: "", stdout: JSON.stringify([{ name: "app", url: "https://tok@github.com/acme/app", isPrivate: true, defaultBranchRef: { name: "main" } }]) };
      if (args.includes("--paginate")) return { code: 0, stderr: "", stdout: "zeta\nmain\nalpha\n" };
      return { code: 0, stderr: "", stdout: "main\n" };
    },
  });
  const r = await lister.repos();
  assert.equal(r.status, "ok");
  assert.deepEqual(r.status === "ok" && r.repos, [{ owner: "acme", name: "app", url: "https://github.com/acme/app", isPrivate: true, defaultBranch: "main" }]);
  assert.deepEqual(await lister.branches("acme", "app"), { status: "ok", defaultBranch: "main", branches: ["main", "alpha", "zeta"] });
  await lister.repos();
  await lister.branches("acme", "app");
  assert.equal(calls.length, 3, "second calls hit the cache");
  now = 11 * 60_000;
  await lister.repos();
  assert.equal(calls.length, 4);
  assert.equal((await lister.branches("-x", "app")).status, "unavailable");
  const down = createRepoLister({ owners: async () => ["acme"], now: () => 0, runGh: async () => ({ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }) });
  assert.deepEqual(await down.repos(), { status: "unavailable", reason: "acme: gh on the bb server is not logged in (run `gh auth login` there)" });
});
