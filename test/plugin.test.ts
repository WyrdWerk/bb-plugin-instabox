import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPENCODE_TEMPLATE_HASHES, opencodeSyncScript, parseOpencodeProviders, secretsEnvScript } from "../src/box-scripts.ts";
import { shellQuote } from "../src/executor.ts";
import type { InstaboxApi, Machine, Operation } from "../src/instabox-api.ts";
import { InstaboxMachineOps, metadataFor, type ProjectsDeps, tunnelGrant } from "../src/provider.ts";
import type { TunnelManager } from "../src/tunnel.ts";

test("shellQuote: bash sees exactly the original argv", () => {
  const argv = ["printf", "%s\\n", "it's", "$HOME", "a b", "`id`", "", "x\ny", "--opt=\"q\""];
  const out = execFileSync("bash", ["-c", `for a in ${shellQuote(argv.slice(1))}; do printf '<%s>' "$a"; done`]).toString();
  assert.equal(out, argv.slice(1).map((a) => `<${a}>`).join(""));
});

test("secretsEnvScript turns the guest's shell-syntax Secret file into plain daemon env lines and drops the old agent env", () => {
  const home = mkdtempSync(join(tmpdir(), "ib-se-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const guest = join(home, "guest.env");
  writeFileSync(guest, 'export ZAI_API_KEY=ibsec_zai\nGH_TOKEN="ibsec_gh"\nODD=\'a"b\'\n');
  mkdirSync(join(home, ".config/bb-instabox"), { recursive: true });
  writeFileSync(join(home, ".config/bb-instabox/agent.env"), "ANTHROPIC_AUTH_TOKEN=old\n");
  const run = () =>
    execFileSync("bash", ["-c", secretsEnvScript()], { cwd: home, env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, BB_INSTABOX_SECRETS_FILE: guest } }).toString().trim();
  assert.match(run(), /^secrets-env=ok vars=2 skipped=1 changed=yes/);
  assert.equal(readFileSync(join(home, ".config/bb-instabox/secrets.env"), "utf8"), "GH_TOKEN=ibsec_gh\nZAI_API_KEY=ibsec_zai\n");
  assert.ok(!existsSync(join(home, ".config/bb-instabox/agent.env")));
  const dropin = readFileSync(join(home, ".config/systemd/user/bb-host-daemon-.service.d/20-bb-instabox-secrets-env.conf"), "utf8");
  assert.equal(dropin, "[Service]\nEnvironmentFile=-%h/.config/bb-instabox/secrets.env\n");
  assert.match(run(), /changed=no restarted=0$/);
});

/** Fake InstaBox: records calls; machines appear when their create op is read. */
function fakeApi() {
  const machines = new Map<string, Machine>();
  const calls: string[] = [];
  const createBodies: Record<string, unknown>[] = [];
  let n = 0;
  const api = {
    createMachine: async (body: { name: string; metadata: Record<string, string> }, idem: string): Promise<Operation> => {
      calls.push(`create ${idem}`);
      createBodies.push(body as unknown as Record<string, unknown>);
      const id = `m_${++n}`;
      machines.set(id, { id, name: body.name, state: "running", operationId: null, runtime: { ready: true }, metadata: body.metadata });
      return { id: `op_${n}`, machineId: id, type: "create", state: "succeeded", error: null };
    },
    getOperation: async (id: string): Promise<Operation> => ({ id, machineId: `m_${id.slice(3)}`, type: "create", state: "succeeded", error: null }),
    findMachine: async (id: string) => machines.get(id) ?? null,
    listMachines: async (md: Record<string, string>) => [...machines.values()].filter((m) => Object.entries(md).every(([k, v]) => m.metadata?.[k] === v)),
    me: async () => ({ login: "test", manualLifecycle: false, alwaysOnAllowed: true, idleChoicesSeconds: [300, 600, 900, 1200, 1500, 1800] }),
    getSecrets: async () => {
      calls.push("secrets-get");
      return { secrets: "all", envSecrets: [], directSecrets: [], items: [], version: 1, guest: { state: "applied" }, proxy: { state: "applied" } };
    },
    updateSecrets: async (_id: string, body: { secrets?: string }) => {
      calls.push(`secrets-update ${body.secrets}`);
      return { secrets: "all", envSecrets: [], directSecrets: [], items: [], version: 1, guest: { state: "pending" }, proxy: { state: "pending" } };
    },
    pushSecrets: async () => {
      calls.push("secrets-push");
      return { secrets: "all", envSecrets: [], directSecrets: [], items: [], version: 1, guest: { state: "applied" }, proxy: { state: "applied" } };
    },
    deleteMachine: async (id: string) => {
      calls.push(`delete ${id}`);
      machines.delete(id);
      return null;
    },
    exec: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, truncated: false }),
  };
  return { api: api as unknown as InstaboxApi, machines, calls, createBodies };
}

function opsWith(api: InstaboxApi, intents = new Map<string, unknown>(), projects?: ProjectsDeps) {
  return new InstaboxMachineOps({
    ...(projects ? { projects } : {}),
    config: async () => ({ api, template: "agent-browser", snapshotId: null, autoSuspendAfterSeconds: 300, opencodeProviders: [] }),
    tunnels: { ensure: async () => {}, stop: () => {} } as unknown as TunnelManager,
    boxHubPort: 38886,
    bootstrap: async () => ({ hostId: "host_1" }),
    intents: {
      get: async (k) => intents.get(k) as never,
      set: async (k, v) => void intents.set(k, v),
      delete: async (k) => void intents.delete(k),
    },
    tunnelAuth: { get: async () => "bb:x", delete: async () => {} },
    log: () => {},
    sleep: async () => {},
    pollMs: 0,
  });
}

const progress = { step() {}, log() {} };

test("a retried create reuses the recorded machine instead of allocating another", async () => {
  const { api, machines, calls, createBodies } = fakeApi();
  const intents = new Map<string, unknown>();
  const ops = opsWith(api, intents);
  const a = await ops.create("key-1", null, async () => {}, progress, new AbortController().signal);
  const b = await ops.create("key-1", null, async () => {}, progress, new AbortController().signal);
  assert.equal(b.resource.machineId, a.resource.machineId);
  assert.equal(calls.filter((c) => c.startsWith("create")).length, 1);
  assert.equal(machines.size, 1);
  // API creates select no org Secrets unless asked; every machine gets all proxy Secrets.
  assert.equal(createBodies.length, 1);
  assert.equal(createBodies[0].secrets, "all");
  assert.equal(createBodies[0].autoSuspendAfterSeconds, 300);
  assert.equal(calls.filter((c) => c === "secrets-get").length, 2);
});

test("a project runner: an unknown or empty project fails before allocating; clones run per repo with the branch and register sources", async () => {
  const { api, calls } = fakeApi();
  const added: string[] = [];
  const projects: ProjectsDeps = {
    getProject: async (n) => (n === "demo" ? { name: "demo", repos: [{ name: "app", url: "https://github.com/acme/app.git", branch: "dev" }, { name: "lib", url: "https://github.com/acme/lib.git" }] } : n === "empty" ? { name: "empty", repos: [] } : null),
    listProjects: async () => [{ id: "p_app", name: "app", gitRemoteUrl: "https://github.com/acme/app", sources: [] }],
    addProjectSource: async (a) => void added.push(`${a.projectId} ${a.hostId} ${a.path}`),
    createProject: async () => {
      throw new Error("createMissingProjects is off");
    },
  };
  const ops = opsWith(api, new Map(), projects);
  await assert.rejects(ops.create("k1", { project: "nope" }, async () => {}, progress, new AbortController().signal), /Unknown project "nope"/);
  await assert.rejects(ops.create("k2", { project: "empty" }, async () => {}, progress, new AbortController().signal), /no repos/);
  assert.equal(calls.filter((c) => c.startsWith("create")).length, 0);
  assert.equal(await opsWith(api).create("k3", { project: "demo" }, async () => {}, progress, new AbortController().signal).catch((e: Error) => e.message), "Project runners are not available in this plugin build");

  const stdins: string[] = [];
  const executor = {
    exec: async (a: { stdin?: string; onOutput?: (t: string) => void }) => {
      stdins.push(a.stdin ?? "");
      const [name, , branch] = (a.stdin ?? "").trim().split(" ");
      a.onOutput?.(`repo cloned ${name} ${branch === "-" ? "main" : branch} abc1234 /home/u/workspace/repos/${name}\n`);
      return { exitCode: 0 };
    },
  };
  const config = { api, template: "t", snapshotId: null, autoSuspendAfterSeconds: 300, opencodeProviders: [] };
  await ops.provisionProject(config as never, executor as never, "host_1", (await projects.getProject("demo"))!, progress, new AbortController().signal);
  assert.deepEqual(stdins, ["app https://github.com/acme/app.git dev\n", "lib https://github.com/acme/lib.git -\n"]);
  assert.deepEqual(added, ["p_app host_1 /home/u/workspace/repos/app"]);

  const failing = { exec: async (a: { onOutput?: (t: string) => void }) => (a.onOutput?.("repo failed app - - fatal:_Remote_branch_dev_not_found\n"), { exitCode: 4 }) };
  await assert.rejects(ops.provisionProject(config as never, failing as never, "host_1", (await projects.getProject("demo"))!, progress, new AbortController().signal), /Cloning app .* failed: fatal:_Remote_branch_dev_not_found/);
});

test("cleanup by key deletes only machines labelled with that key", async () => {
  const { api, machines, calls } = fakeApi();
  const ops = opsWith(api);
  await ops.create("key-a", null, async () => {}, progress, new AbortController().signal);
  await ops.create("key-b", null, async () => {}, progress, new AbortController().signal);
  machines.set("m_foreign", { id: "m_foreign", name: "base", state: "running", operationId: null, metadata: {} });
  await ops.reconcileCleanup("key-a", new AbortController().signal);
  assert.deepEqual(calls.filter((c) => c.startsWith("delete")), ["delete m_1"]);
  assert.ok(machines.has("m_2") && machines.has("m_foreign"));
  assert.equal(metadataFor("key-a")["bb-key"].length, 32);
});

test("OpenCode sync builds providers from live /models, keeps keys out of the file, survives a failed fetch, and leaves a user file alone", async (t) => {
  let status = 200;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify({ data: [{ id: "glm-b" }, { id: "glm-a" }, { id: "glm-b" }] }) : "{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const home = mkdtempSync(join(tmpdir(), "ib-oc-"));
  mkdirSync(join(home, ".config/bb-instabox"), { recursive: true });
  const key = "k1 $(touch pwned) `id`";
  writeFileSync(join(home, ".config/bb-instabox/secrets.env"), `ZAI_API_KEY=${key}
`);
  const providers = JSON.stringify([
    { id: "zai", name: "Z", baseURL: base, keyEnv: "ZAI_API_KEY" },
    { id: "zro", name: "ZRO", baseURL: base, keyEnv: "ZRO_API_KEY" },
  ]);
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const c = execFile("bash", ["-c", opencodeSyncScript()], { cwd: home, env: { HOME: home, PATH: process.env.PATH } }, (e, out) => (e ? reject(e) : resolve(out.trim())));
      c.stdin!.end(providers);
    });
  const file = join(home, ".config/opencode/opencode.json");
  const piFile = join(home, ".pi/agent/models.json");

  const first = await run();
  assert.match(first, /^opencode-config=written zai:2 zro:skip-no-key$/m);
  assert.match(first, /^pi-models=written zai:2 zro:skip-no-key restarted=0$/m);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(cfg.provider), ["zai"]);
  assert.deepEqual(Object.keys(cfg.provider.zai.models), ["glm-a", "glm-b"]);
  assert.equal(cfg.provider.zai.options.apiKey, "{env:ZAI_API_KEY}");
  assert.ok(!readFileSync(file, "utf8").includes("k1"), "key must not be written");
  const piCfg = JSON.parse(readFileSync(piFile, "utf8"));
  assert.deepEqual(Object.keys(piCfg.providers), ["zai"]);
  assert.deepEqual(piCfg.providers.zai.models.map((m: { id: string }) => m.id), ["glm-a", "glm-b"]);
  assert.ok(!readFileSync(piFile, "utf8").includes("k1"), "key must not be written to pi models");
  assert.deepEqual(seen, [`Bearer ${key}`], "key is passed verbatim, never shell-expanded");
  assert.ok(!existsSync(join(home, "pwned")));

  status = 500;
  const failed = await run();
  assert.match(failed, /zai:2-kept\(http 500\)/);
  assert.match(failed, /^pi-models=unchanged zai:2-kept\(http 500\)/m);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).provider.zai.models), ["glm-a", "glm-b"]);

  // A user's own files are never touched: a normal config, one without providers, and JSONC.
  for (const mine of ['{"provider":{"x":{"name":"mine"}}}', '{"theme":"dark"}', '// mine\n{"theme":"dark"}']) {
    writeFileSync(file, mine);
    assert.match(await run(), /^opencode-config=kept-user-file(?: |$)/m);
    assert.equal(readFileSync(file, "utf8"), mine);
  }
});

test("OpenCode sync still owns its file after writing one with no providers", async () => {
  const home = mkdtempSync(join(tmpdir(), "ib-oc-"));
  const file = join(home, ".config/opencode/opencode.json");
  const run = (providers: string) =>
    new Promise<string>((resolve, reject) => {
      const c = execFile("bash", ["-c", opencodeSyncScript()], { cwd: home, env: { HOME: home, PATH: process.env.PATH } }, (e, out) => (e ? reject(e) : resolve(out.trim())));
      c.stdin!.end(providers);
    });
  // No key anywhere: the plugin writes a config with no providers.
  assert.match(await run('[{"id":"zai","baseURL":"https://127.0.0.1:1/v1","keyEnv":"ZAI_API_KEY"}]'), /^opencode-config=written zai:skip-no-key/);
  // Next sync with nothing to fetch must not call it a user file.
  assert.match(await run("[]"), /^opencode-config=unchanged/);
  // Once the user edits it, it is theirs.
  writeFileSync(file, '{"theme":"dark"}');
  assert.match(await run("[]"), /^opencode-config=kept-user-file/m);
});

test("OpenCode sync takes over the template's own opencode.json and keeps its MCP servers", async () => {
  const home = mkdtempSync(join(tmpdir(), "ib-oc-"));
  const file = join(home, ".config/opencode/opencode.json");
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  // Byte-for-byte what /usr/local/lib/instabox/data-init.d/opencode writes at boot.
  const template = `{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "mcp": {
    "open-computer-use": {
      "type": "local",
      "command": ["/usr/local/bin/instabox-computer-use", "mcp"]
    },
    "instabox": {
      "type": "local",
      "command": ["/usr/local/bin/instabox-mcp", "mcp"]
    }
  }
}
`;
  assert.ok(OPENCODE_TEMPLATE_HASHES.includes(createHash("sha256").update(template).digest("hex")), "template hash matches the fixture");
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const c = execFile("bash", ["-c", opencodeSyncScript()], { cwd: home, env: { HOME: home, PATH: process.env.PATH } }, (e, out) => (e ? reject(e) : resolve(out.trim())));
      c.stdin!.end("[]");
    });
  // Fresh machine (no opencode.owned) and after a reboot that rewrote the file over ours.
  for (let i = 0; i < 2; i++) {
    writeFileSync(file, template);
    assert.match(await run(), /^opencode-config=written/);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(cfg.mcp), ["open-computer-use", "instabox"]);
    assert.equal(cfg.autoupdate, false);
    assert.deepEqual(cfg.provider, {});
  }
  // A template-shaped file the user edited is theirs.
  writeFileSync(file, template.replace("false", "true"));
  assert.match(await run(), /^opencode-config=kept-user-file/m);
});

test("parseOpencodeProviders defaults when empty and rejects unsafe entries", () => {
  const defaults = parseOpencodeProviders("");
  assert.equal(defaults.length, 8);
  assert.ok(defaults.some((p) => p.id === "zai-coding-plan" && p.keyEnv === "ZAI_API_KEY"));
  assert.ok(defaults.some((p) => p.id === "zro" && p.keyEnv === "ZRO_API_KEY"));
  assert.ok(defaults.some((p) => p.id === "coralbricks" && p.keyEnv === "CORALBRICKS_API_KEY"));
  assert.deepEqual(parseOpencodeProviders('[{"id":"zro","baseURL":"https://zro.moonmath.ai/v1/","keyEnv":"ZRO_API_KEY"}]'), [
    { id: "zro", name: "zro", baseURL: "https://zro.moonmath.ai/v1", keyEnv: "ZRO_API_KEY" },
  ]);
  assert.throws(() => parseOpencodeProviders('[{"id":"x","baseURL":"http://a.b/v1","keyEnv":"K"}]'));
  assert.throws(() => parseOpencodeProviders('[{"id":"x","baseURL":"https://u:p@a.b/v1","keyEnv":"K"}]'));
  assert.throws(() => parseOpencodeProviders('[{"id":"x","baseURL":"https://a.b/v1","keyEnv":"K;rm"}]'));
});

test("the InstaBox tunnel access grants the loopback URL only to machines this plugin created", () => {
  const url = "http://127.0.0.1:38886";
  assert.deepEqual(tunnelGrant("instabox", JSON.stringify(["instabox", "launch-1"]), "host_a", url), { id: "instabox-tunnel:host_a", serverUrl: url });
  for (const key of [JSON.stringify(["boat", "launch-1"]), "host_a", "not json", JSON.stringify({ 0: "instabox" })]) {
    const g = tunnelGrant("instabox", key, "host_a", url);
    assert.ok("status" in g && g.status === "failed", key);
  }
});
