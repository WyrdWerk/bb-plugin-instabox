// Shell scripts run on the InstaBox machine through the exec API (as its user).
// Secrets only ever arrive on stdin; scripts print names, counts and booleans.

/** chisel (github.com/jpillora/chisel), pinned: the gunzipped linux_amd64 binary. */
export const CHISEL = {
  version: "1.12.0",
  url: "https://github.com/jpillora/chisel/releases/download/v1.12.0/chisel_1.12.0_linux_amd64.gz",
  sha256: "811362311f13ac4bdc42fe4e7650aca618a68e3a40f930de88536d18b14d2b52",
} as const;

/** Loopback port of the chisel server on the box (the hub reaches it with ssh -L). */
export const BOX_CHISEL_PORT = 9000;
export const TUNNEL_UNIT = "bb-instabox-tunnel.service";
const CONF = "$HOME/.config/bb-instabox";

/**
 * Install chisel (verified), write the auth file from stdin (`AUTH=user:pass`),
 * and run the chisel server as an enabled user unit (the machine user lingers,
 * so it also comes back after a stop/start). Loopback only. Last line:
 * `tunnel=ok installed=yes|no changed=yes|no`.
 */
export function tunnelSetupScript(): string {
  return `set -euo pipefail
umask 077
bin="$HOME/.local/bin/chisel"
installed=no
if [ "$(sha256sum "$bin" 2>/dev/null | cut -d' ' -f1)" != "${CHISEL.sha256}" ]; then
  mkdir -p "$HOME/.local/bin"
  tmp=$(mktemp)
  curl -fsSL --retry 3 "${CHISEL.url}" | gunzip > "$tmp"
  [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "${CHISEL.sha256}" ] || { rm -f "$tmp"; echo "tunnel=failed reason=chisel-checksum"; exit 1; }
  chmod 755 "$tmp"; mv -f "$tmp" "$bin"; installed=yes
fi
mkdir -p "${CONF}" "$HOME/.config/systemd/user"
new=$(mktemp "${CONF}/.chisel.env.XXXXXX")
cat > "$new"
changed=yes
if cmp -s "$new" "${CONF}/chisel.env"; then changed=no; rm -f "$new"; else mv -f "$new" "${CONF}/chisel.env"; fi
unit="$HOME/.config/systemd/user/${TUNNEL_UNIT}"
want=$(cat <<'UNIT'
[Unit]
Description=bb InstaBox tunnel endpoint (chisel server, loopback only)
After=network-online.target

[Service]
EnvironmentFile=%h/.config/bb-instabox/chisel.env
ExecStart=%h/.local/bin/chisel server --host 127.0.0.1 --port ${BOX_CHISEL_PORT} --reverse
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
)
if [ "$(cat "$unit" 2>/dev/null)" != "$want" ]; then printf '%s\\n' "$want" > "$unit"; changed=yes; fi
systemctl --user daemon-reload
systemctl --user enable ${TUNNEL_UNIT} >/dev/null 2>&1
if [ "$changed" = yes ] || [ "$installed" = yes ]; then systemctl --user restart ${TUNNEL_UNIT}; else systemctl --user start ${TUNNEL_UNIT}; fi
for i in $(seq 1 20); do
  if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${BOX_CHISEL_PORT} "; then echo "tunnel=ok installed=$installed changed=$changed"; exit 0; fi
  sleep 0.5
done
echo "tunnel=failed reason=not-listening"; exit 1
`;
}

/**
 * Agent credentials for the bb daemon, from stdin (KEY=value lines), applied to
 * every bb-host-daemon-*.service through a prefix drop-in. Restarts running
 * daemon units only when the content changed. Last line:
 * `agent-env=ok vars=<n> changed=yes|no restarted=<n>`.
 */
export function agentEnvScript(): string {
  return `set -euo pipefail
umask 077
mkdir -p "${CONF}" "$HOME/.config/systemd/user/bb-host-daemon-.service.d"
f="${CONF}/agent.env"
new=$(mktemp "${CONF}/.agent.env.XXXXXX")
cat > "$new"
changed=yes
if cmp -s "$new" "$f"; then changed=no; rm -f "$new"; else mv -f "$new" "$f"; fi
d="$HOME/.config/systemd/user/bb-host-daemon-.service.d/20-bb-instabox-agent-env.conf"
want='[Service]
EnvironmentFile=-%h/.config/bb-instabox/agent.env'
if [ "$(cat "$d" 2>/dev/null)" != "$want" ]; then printf '%s\\n' "$want" > "$d"; changed=yes; fi
systemctl --user daemon-reload
restarted=0
if [ "$changed" = yes ]; then
  for u in $(systemctl --user list-units 'bb-host-daemon-*.service' --state=running --no-legend --plain | awk '{print $1}'); do
    systemctl --user restart "$u" && restarted=$((restarted + 1))
  done
fi
echo "agent-env=ok vars=$(grep -c . "$f") changed=$changed restarted=$restarted"
`;
}

/**
 * A new machine must not carry a bb runner identity (one restored from a
 * snapshot of another runner would impersonate it). Stops and removes copied
 * daemon units and ~/.bb-machines. Last line: `identity=clean removed=<n>`.
 */
export function identityResetScript(): string {
  return `set -uo pipefail
n=0
for f in "$HOME"/.config/systemd/user/bb-host-daemon-*.service; do
  [ -e "$f" ] || continue
  u=$(basename "$f")
  systemctl --user disable --now "$u" >/dev/null 2>&1
  rm -f "$f"; rm -rf "$f.d"; n=$((n + 1))
done
[ -d "$HOME/.bb-machines" ] && { rm -rf "$HOME/.bb-machines"; n=$((n + 1)); }
systemctl --user daemon-reload
echo "identity=clean removed=$n"
`;
}

/**
 * After a pause, outbound TCP connections that were open are dead (the NAT state
 * is gone), but clients still reuse them: claude-code sent its next request into a
 * stale keep-alive socket to the model API and hung until timeout. Destroy outbound
 * HTTP(S) connections so clients reconnect. Inbound ssh (the exec API) is untouched.
 * Best effort (needs passwordless sudo). Last line: `stale-conns closed=<n> left=<n>`.
 */
export function staleConnectionsScript(): string {
  return `set -uo pipefail
count() { ss -Htn state established '( dport = :443 or dport = :80 )' 2>/dev/null | wc -l; }
before=$(count)
sudo -n ss -K state established '( dport = :443 or dport = :80 )' >/dev/null 2>&1
after=$(count)
echo "stale-conns closed=$((before - after)) left=$after"
`;
}

/** An OpenAI-compatible provider OpenCode should offer. Never holds a key: only the env var name. */
export interface OpencodeProvider {
  id: string;
  name?: string;
  baseURL: string;
  /** Env var (in the bb daemon env on the machine) that holds this provider's key. */
  keyEnv: string;
}

/** Defaults for the `opencodeProviders` setting. A provider whose key env is unset is skipped. */
export const DEFAULT_OPENCODE_PROVIDERS: OpencodeProvider[] = [
  { id: "zai-coding-plan", name: "Z.AI Coding Plan", baseURL: "https://api.z.ai/api/coding/paas/v4", keyEnv: "ZAI_API_KEY" },
  { id: "zro", name: "ZRO", baseURL: "https://zro.moonmath.ai/v1", keyEnv: "ZRO_API_KEY" },
  { id: "coralbricks", name: "Coral Bricks", baseURL: "https://inference.coralbricks.ai/v1", keyEnv: "CORALBRICKS_API_KEY" },
  { id: "neuralwatt", name: "Neuralwatt", baseURL: "https://api.neuralwatt.com/v1", keyEnv: "NEURALWATT_API_KEY" },
];

/** Parse and check the `opencodeProviders` setting (JSON array). Empty: the defaults. */
export function parseOpencodeProviders(raw: string): OpencodeProvider[] {
  if (!raw.trim()) return DEFAULT_OPENCODE_PROVIDERS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("opencodeProviders must be a JSON array");
  }
  if (!Array.isArray(v)) throw new Error("opencodeProviders must be a JSON array");
  return v.map((x, i) => {
    const p = x as Partial<OpencodeProvider>;
    if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(p.id)) throw new Error(`opencodeProviders[${i}].id: lowercase letters, digits, _ and -`);
    if (typeof p.keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.keyEnv)) throw new Error(`opencodeProviders[${i}].keyEnv must be an env var name`);
    let u: URL;
    try {
      u = new URL(String(p.baseURL));
    } catch {
      throw new Error(`opencodeProviders[${i}].baseURL is not a URL`);
    }
    if (u.protocol !== "https:" || u.username || u.password || u.search) throw new Error(`opencodeProviders[${i}].baseURL: https, no credentials or query`);
    return { id: p.id, name: typeof p.name === "string" ? p.name : p.id, baseURL: u.toString().replace(/\/+$/, ""), keyEnv: p.keyEnv };
  });
}

/** Marks a provider entry as written by this plugin (so a user's own opencode.json is never overwritten). */
export const OPENCODE_MARK = "(bb-plugin-instabox)";

/**
 * Node program run on the machine. stdin: JSON array of OpencodeProvider.
 * For each provider whose key env is set, GET <baseURL>/models with that key
 * and build an @ai-sdk/openai-compatible provider entry from the returned ids
 * (apiKey stays "{env:NAME}", so no secret is written). A failed fetch keeps
 * that provider's models from the previous file. Leaves a user-owned file alone.
 * Last line: `opencode-config=written|unchanged|kept-user-file <id>:<n|skip-reason> …`.
 */
export const OPENCODE_SYNC_JS = String.raw`
const fs = require("node:fs"), path = require("node:path");
const file = process.env.OPENCODE_CONFIG_FILE || path.join(process.env.HOME, ".config/opencode/opencode.json");
const MARK = ${JSON.stringify(OPENCODE_MARK)};
const providers = JSON.parse(fs.readFileSync(0, "utf8"));
// The daemon's agent env (KEY=value lines, as written by agentEnvScript); parsed, never sourced by a shell.
const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(process.env.HOME, ".config/bb-instabox/agent.env"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
} catch {}
// Ownership: the sha256 of exactly what this plugin last wrote, kept beside the agent env.
// The config is ours only if it is missing, matches that hash, or (older plugin) carries MARK.
const crypto = require("node:crypto");
const ownFile = path.join(process.env.HOME, ".config/bb-instabox/opencode.owned");
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
let raw = null, prev = null, owned = null;
try { raw = fs.readFileSync(file, "utf8"); } catch {}
try { prev = JSON.parse(raw); } catch {}
try { owned = fs.readFileSync(ownFile, "utf8").trim(); } catch {}
const ours = raw === null || (owned !== null && owned === sha(raw)) ||
  (owned === null && prev !== null && Object.values(prev.provider || {}).some((p) => String(p && p.name).endsWith(MARK)));
const report = [];
(async () => {
  if (!ours) { console.log("opencode-config=kept-user-file"); return; }
  const out = { $schema: "https://opencode.ai/config.json", provider: {} };
  for (const p of providers) {
    const key = env[p.keyEnv];
    if (!key) { report.push(p.id + ":skip-no-key"); continue; }
    let ids = null;
    try {
      const r = await fetch(p.baseURL + "/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      ids = [...new Set((j.data || j.models || []).map((m) => (typeof m === "string" ? m : m && m.id)).filter((x) => typeof x === "string" && x))].sort();
      if (!ids.length) throw new Error("empty");
    } catch (e) {
      const old = prev && prev.provider && prev.provider[p.id] && prev.provider[p.id].models;
      if (old && Object.keys(old).length) { ids = Object.keys(old); report.push(p.id + ":" + ids.length + "-kept(" + e.message + ")"); }
      else { report.push(p.id + ":skip-" + String(e.message).replace(/\s+/g, "-")); continue; }
    }
    if (!report.some((x) => x.startsWith(p.id + ":"))) report.push(p.id + ":" + ids.length);
    out.provider[p.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: (p.name || p.id) + " " + MARK,
      options: { baseURL: p.baseURL, apiKey: "{env:" + p.keyEnv + "}" },
      models: Object.fromEntries(ids.map((id) => [id, { name: id }])),
    };
  }
  const text = JSON.stringify(out, null, 2) + "\n";
  let state = "unchanged";
  if (raw !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp" + process.pid;
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.renameSync(tmp, file);
    state = "written";
  }
  if (owned !== sha(text)) {
    fs.mkdirSync(path.dirname(ownFile), { recursive: true });
    fs.writeFileSync(ownFile, sha(text) + "\n", { mode: 0o600 });
  }
  console.log("opencode-config=" + state + " " + report.join(" "));
})().catch((e) => { console.log("opencode-config=failed " + e.message); process.exit(1); });
`;

/**
 * Bash wrapper that runs the sync on the machine (keys stay on the box) and,
 * when the config changed, restarts running bb daemons so bb's model picker
 * sees the new list (this interrupts a turn in progress). stdin: providers JSON.
 */
export function opencodeSyncScript(): string {
  if (OPENCODE_SYNC_JS.includes("BB_OPENCODE_SYNC_EOF")) throw new Error("heredoc marker in script");
  return `set -euo pipefail
umask 077
js=$(mktemp)
trap 'rm -f "$js"' EXIT
cat > "$js" <<'BB_OPENCODE_SYNC_EOF'
${OPENCODE_SYNC_JS}
BB_OPENCODE_SYNC_EOF
out=$(PATH=/usr/local/bin:$PATH node "$js")
# bb caches each provider's model list until its daemon restarts; restart it only when the config changed.
restarted=0
case "$out" in
  opencode-config=written*)
    for u in $(systemctl --user list-units 'bb-host-daemon-*.service' --state=running --no-legend --plain 2>/dev/null | awk '{print $1}'); do
      systemctl --user restart "$u" && restarted=$((restarted + 1))
    done;;
esac
echo "$out restarted=$restarted"
`;
}

/** Exit 0 when the hub answers /health on the box's loopback end of the tunnel. */
export function hubHealthScript(boxHubPort: number): string {
  return `curl -fsS -m 5 -o /dev/null http://127.0.0.1:${boxHubPort}/health`;
}

/**
 * The `agentSecrets` setting: a one-line JSON object of NAME → string value
 * (bb secret settings cannot be multi-line). Empty means none. Throws on
 * anything else; names and values are checked again by agentEnvContent.
 */
export function parseAgentSecrets(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('agentSecrets must be a JSON object, e.g. {"GH_TOKEN":"…"}');
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("agentSecrets must be a JSON object");
  for (const [k, x] of Object.entries(v)) if (typeof x !== "string") throw new Error(`agentSecrets.${k} must be a string`);
  const out = v as Record<string, string>;
  agentEnvContent(out);
  return out;
}

/** KEY=value lines for the agent env file. Values must be single-line. */
export function agentEnvContent(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`);
      if (/[\r\n]/.test(v)) throw new Error(`env ${k} must be one line`);
      return `${k}=${v}\n`;
    })
    .join("");
}
