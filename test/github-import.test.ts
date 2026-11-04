import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BbProjectLite, hubCloneArgs, type ImportDeps, importListing, importRepo } from "../src/github-import.ts";

function deps(over: Partial<ImportDeps> & { projects?: BbProjectLite[]; origins?: Record<string, string>; remoteAfterCreate?: string | null } = {}) {
  const projects: BbProjectLite[] = [...(over.projects ?? [])];
  const calls: string[] = [];
  const d: ImportDeps = {
    checkoutDir: "/hub/checkouts/",
    listProjects: async () => projects.map((p) => ({ ...p })),
    originOf: async (path) => (over.origins && path in over.origins ? over.origins[path]! : null),
    clone: async (url, path) => void calls.push(`clone ${url} ${path}`),
    createProject: async ({ name, path }) => {
      calls.push(`create ${name} ${path}`);
      projects.push({ id: "proj_new", name, gitRemoteUrl: over.remoteAfterCreate === undefined ? "https://github.com/acme/app.git" : over.remoteAfterCreate });
      return { id: "proj_new" };
    },
    sleep: async () => {},
    ...over,
  };
  return { d, calls };
}

const app = { owner: "acme", name: "app", url: "https://github.com/acme/app" };

test("import skips a repo that already is a bb project, matched by remote", async () => {
  const { d, calls } = deps({ projects: [{ id: "p1", name: "my-app", gitRemoteUrl: "git@github.com:Acme/App.git" }] });
  assert.deepEqual(await importRepo(app, d), { repo: "acme/app", status: "exists", projectId: "p1", projectName: "my-app" });
  assert.deepEqual(calls, []);
});

test("import reuses a matching checkout, clones when absent, and refuses a foreign path", async () => {
  const reuse = deps({ origins: { "/hub/checkouts/app": "https://github.com/acme/app" } });
  assert.deepEqual(await importRepo(app, reuse.d), { repo: "acme/app", status: "created", projectId: "proj_new", path: "/hub/checkouts/app", checkout: "existing", gitRemoteUrl: "https://github.com/acme/app.git" });
  assert.deepEqual(reuse.calls, ["create app /hub/checkouts/app"]);

  const fresh = deps();
  const r = await importRepo(app, fresh.d);
  assert.equal(r.status === "created" && r.checkout, "cloned");
  assert.deepEqual(fresh.calls, ["clone https://github.com/acme/app.git /hub/checkouts/app", "create app /hub/checkouts/app"]);

  // <dir>/app holds another owner's app: clone (or reuse) <dir>/acme/app instead.
  const sameName = deps({ origins: { "/hub/checkouts/app": "https://github.com/other/app.git" } });
  const sn = await importRepo(app, sameName.d);
  assert.ok(sn.status === "created" && sn.path === "/hub/checkouts/acme/app" && sn.checkout === "cloned", JSON.stringify(sn));
  assert.deepEqual(sameName.calls, ["clone https://github.com/acme/app.git /hub/checkouts/acme/app", "create app /hub/checkouts/acme/app"]);
  const reuseOwner = deps({ origins: { "/hub/checkouts/app": "https://github.com/other/app.git", "/hub/checkouts/acme/app": "https://github.com/acme/app.git" } });
  const ro = await importRepo(app, reuseOwner.d);
  assert.ok(ro.status === "created" && ro.path === "/hub/checkouts/acme/app" && ro.checkout === "existing");

  for (const origin of ["https://github.com/other/app.git", ""]) {
    const foreign = deps({ origins: { "/hub/checkouts/app": origin, "/hub/checkouts/acme/app": origin } });
    const f = await importRepo(app, foreign.d);
    assert.equal(f.status, "failed");
    assert.deepEqual(foreign.calls, [], "nothing cloned or created over a foreign path");
  }
  const leaky = deps({ origins: { "/hub/checkouts/app": "https://x-access-token:secret@github.com/acme/app.git" } });
  const l = await importRepo(app, leaky.d);
  assert.ok(l.status === "failed" && /credentials/.test(l.message));
  assert.deepEqual(leaky.calls, []);
});

test("import reports failure when bb never records the GitHub remote", async () => {
  const { d } = deps({ remoteAfterCreate: null });
  const r = await importRepo(app, d);
  assert.ok(r.status === "failed" && /not recorded its GitHub remote/.test(r.message), JSON.stringify(r));
});

test("listing marks repos that already are bb projects", () => {
  const l = importListing(
    [
      { owner: "acme", name: "app", url: "https://github.com/acme/app", isPrivate: true },
      { owner: "acme", name: "lib", url: "https://github.com/acme/lib", isPrivate: false },
    ],
    [{ id: "p1", name: "app", gitRemoteUrl: "https://github.com/acme/app.git" }],
  );
  assert.deepEqual(l.map((x) => x.bbProject?.id ?? null), ["p1", null]);
});

test("a hub clone writes no credential helper or token into the checkout", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ib-import-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  execFileSync("git", ["init", "-q", "-b", "main", join(tmp, "src")], { env });
  execFileSync("git", ["-C", join(tmp, "src"), "commit", "-q", "--allow-empty", "-m", "x"], { env });
  execFileSync("git", ["clone", "-q", "--bare", join(tmp, "src"), join(tmp, "o.git")], { env });
  execFileSync("git", hubCloneArgs(join(tmp, "o.git"), join(tmp, "out")), { env });
  const cfg = readFileSync(join(tmp, "out/.git/config"), "utf8");
  assert.doesNotMatch(cfg, /credential|token|helper/);
});
