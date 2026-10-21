import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentEnvContent, opencodeSyncScript, parseAgentSecrets, parseOpencodeProviders } from "../src/box-scripts.ts";
import { shellQuote } from "../src/executor.ts";
import type { InstaboxApi, Machine, Operation } from "../src/instabox-api.ts";
import { InstaboxMachineOps, metadataFor } from "../src/provider.ts";
import type { TunnelManager } from "../src/tunnel.ts";

test("shellQuote: bash sees exactly the original argv", () => {
  const argv = ["printf", "%s\\n", "it's", "$HOME", "a b", "`id`", "", "x\ny", "--opt=\"q\""];
  const out = execFileSync("bash", ["-c", `for a in ${shellQuote(argv.slice(1))}; do printf '<%s>' "$a"; done`]).toString();
  assert.equal(out, argv.slice(1).map((a) => `<${a}>`).join(""));
});

test("agentEnvContent refuses values that would inject extra lines", () => {
  assert.equal(agentEnvContent({ A: "x.y", B: "z" }), "A=x.y\nB=z\n");
  assert.throws(() => agentEnvContent({ A: "x\nEVIL=1" }));
  assert.throws(() => agentEnvContent({ "A B": "x" }));
});

test("parseAgentSecrets accepts a JSON object of strings and rejects anything that could smuggle lines", () => {
  assert.deepEqual(parseAgentSecrets(""), {});
  assert.deepEqual(parseAgentSecrets('{"GH_TOKEN":"ghp_x","B":"a=b c"}'), { GH_TOKEN: "ghp_x", B: "a=b c" });
  assert.throws(() => parseAgentSecrets("GH_TOKEN=x"));
  assert.throws(() => parseAgentSecrets('["x"]'));
  assert.throws(() => parseAgentSecrets('{"N":1}'));
  assert.throws(() => parseAgentSecrets('{"A":"x\\nEVIL=1"}'));
  assert.throws(() => parseAgentSecrets('{"A;rm":"x"}'));
});

/** Fake InstaBox: records calls; machines appear when their create op is read. */
function fakeApi() {
  const machines = new Map<string, Machine>();
  const calls: string[] = [];
  let n = 0;
  const api = {
    createMachine: async (body: { name: string; metadata: Record<string, string> }, idem: string): Promise<Operation> => {
      calls.push(`create ${idem}`);
      const id = `m_${++n}`;
      machines.set(id, { id, name: body.name, state: "running", operationId: null, runtime: { ready: true }, metadata: body.metadata });
      return { id: `op_${n}`, machineId: id, type: "create", state: "succeeded", error: null };
    },
    getOperation: async (id: string): Promise<Operation> => ({ id, machineId: `m_${id.slice(3)}`, type: "create", state: "succeeded", error: null }),
    findMachine: async (id: string) => machines.get(id) ?? null,
    listMachines: async (md: Record<string, string>) => [...machines.values()].filter((m) => Object.entries(md).every(([k, v]) => m.metadata?.[k] === v)),
    deleteMachine: async (id: string) => {
      calls.push(`delete ${id}`);
      machines.delete(id);
      return null;
    },
    exec: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, truncated: false }),
  };
  return { api: api as unknown as InstaboxApi, machines, calls };
}

function opsWith(api: InstaboxApi, intents = new Map<string, unknown>()) {
  return new InstaboxMachineOps({
    config: async () => ({ api, template: "agent-browser", snapshotId: null, agentEnv: {}, opencodeProviders: [] }),
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
  const { api, machines, calls } = fakeApi();
  const intents = new Map<string, unknown>();
  const ops = opsWith(api, intents);
  const a = await ops.create("key-1", null, async () => {}, progress, new AbortController().signal);
  const b = await ops.create("key-1", null, async () => {}, progress, new AbortController().signal);
  assert.equal(b.resource.machineId, a.resource.machineId);
  assert.equal(calls.filter((c) => c.startsWith("create")).length, 1);
  assert.equal(machines.size, 1);
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
  writeFileSync(join(home, ".config/bb-instabox/agent.env"), agentEnvContent({ ZAI_API_KEY: key }));
  const providers = JSON.stringify([
    { id: "zai", name: "Z", baseURL: base, keyEnv: "ZAI_API_KEY" },
    { id: "zro", name: "ZRO", baseURL: base, keyEnv: "ZRO_API_KEY" },
  ]);
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const c = execFile("bash", ["-c", opencodeSyncScript()], { cwd: home, env: { HOME: home, PATH: process.env.PATH } }, (e, out) => (e ? reject(e) : resolve(out.trim().split("\n").pop() ?? "")));
      c.stdin!.end(providers);
    });
  const file = join(home, ".config/opencode/opencode.json");

  assert.match(await run(), /^opencode-config=written zai:2 zro:skip-no-key restarted=0$/);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(cfg.provider), ["zai"]);
  assert.deepEqual(Object.keys(cfg.provider.zai.models), ["glm-a", "glm-b"]);
  assert.equal(cfg.provider.zai.options.apiKey, "{env:ZAI_API_KEY}");
  assert.ok(!readFileSync(file, "utf8").includes("k1"), "key must not be written");
  assert.deepEqual(seen, [`Bearer ${key}`], "key is passed verbatim, never shell-expanded");
  assert.ok(!existsSync(join(home, "pwned")));

  status = 500;
  assert.match(await run(), /zai:2-kept\(http 500\)/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).provider.zai.models), ["glm-a", "glm-b"]);

  const mine = '{"provider":{"x":{"name":"mine"}}}';
  writeFileSync(file, mine);
  assert.equal(await run(), "opencode-config=kept-user-file restarted=0");
  assert.equal(readFileSync(file, "utf8"), mine);
});

test("parseOpencodeProviders defaults when empty and rejects unsafe entries", () => {
  assert.ok(parseOpencodeProviders("").some((p) => p.id === "zai-coding-plan"));
  assert.deepEqual(parseOpencodeProviders('[{"id":"zro","baseURL":"https://zro.moonmath.ai/v1/","keyEnv":"ZRO_API_KEY"}]'), [
    { id: "zro", name: "zro", baseURL: "https://zro.moonmath.ai/v1", keyEnv: "ZRO_API_KEY" },
  ]);
  assert.throws(() => parseOpencodeProviders('[{"id":"x","baseURL":"http://a.b/v1","keyEnv":"K"}]'));
  assert.throws(() => parseOpencodeProviders('[{"id":"x","baseURL":"https://u:p@a.b/v1","keyEnv":"K"}]'));
  assert.throws(() => parseOpencodeProviders('[{"id":"x","baseURL":"https://a.b/v1","keyEnv":"K;rm"}]'));
});
