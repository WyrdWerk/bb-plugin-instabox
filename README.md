# bb-plugin-instabox (experimental)

> **Status: experimental, v0.1.0.** Live acceptance passed on 2026-10-21; see
> [Live acceptance status](#live-acceptance-status).

A bb machine provider that runs bb threads on [InstaBox](https://instabox.sh)
machines. It has the same shape as [`bb-plugin-boat`](https://github.com/WyrdWerk/bb-plugin-boat), with one difference: the
connection from the machine back to the bb hub uses **no Tailscale and no bb
Connect**. It needs only the InstaBox API key.

## How the machine reaches the hub

InstaBox's SSH gateway allows local forwarding (`-L`) but not remote
forwarding (`-R`). For each running machine, the hub therefore runs two processes:

```text
hub: ssh -N -L 127.0.0.1:<free>:127.0.0.1:9000 <machine>@<gateway>    (cert from POST /connections)
hub: chisel client http://127.0.0.1:<free> R:127.0.0.1:38886:127.0.0.1:<bb port>
box: chisel server --host 127.0.0.1 --port 9000 --reverse             (user unit, password-protected)
box: bb daemon → http://127.0.0.1:38886  ──tunnel──▶  hub
```

Everything is loopback-only and runs inside InstaBox's authenticated SSH.
chisel v1.12.0 is pinned by SHA-256 on both ends. Each machine gets a random
chisel password, stored in plugin KV and delivered to the box over stdin.

## Setup

### 1. The hub

An always-on machine running bb ≥ 0.45 (the "hub"). It needs:

- `node`/`npm`, `ssh` and `ssh-keygen` on the bb server's PATH (chisel is downloaded by the plugin);
- about 4 GiB of free memory or more (a 3 GiB machine OOM-killed bb once during a create);
- `gh auth login` on the hub if runners should clone **private** repos: bb passes the hub's
  `gh` login to remote machines (`bb machine env list` shows `builtInGit: logged in`).
  A `GH_TOKEN` machine variable (`bb machine env set GH_TOKEN`) overrides it.

No Tailscale, no bb Connect and no public port are needed.

### 2. Install the plugin

```bash
git clone https://github.com/WyrdWerk/bb-plugin-instabox && cd bb-plugin-instabox
npm ci
bb plugin build .
bb plugin install "$PWD" --yes
```

(Installing straight from the Git URL has not been tested.)

### 3. Credentials and hub settings

Either export `INSTABOX_API_KEY` (and `ZAI_API_KEY`) in the bb server's environment,
or store them as plugin secrets:

```bash
bb plugin config instabox set apiKey 'ibk_…'
bb plugin config instabox set zaiApiKey '…'                      # optional: claude-code and pi on Z.ai
bb plugin config instabox set agentSecrets '{"OPENAI_API_KEY":"…"}'  # optional: any other agent env
```

(`bb plugin config … set` takes the value as an argument; the bb Settings page can
edit the same secret fields.) Then point machines at the tunnel; the plugin shows
"setup required" with this exact command until it is done:

```bash
bb settings general defaultMachineAccess direct
bb settings general machineServerUrl http://127.0.0.1:38886
```

### 4. A basic runner snapshot (recommended)

See [A basic runner snapshot](#a-basic-runner-snapshot), then
`bb plugin config instabox set snapshotId sn_…`. Without it, machines start from the
`agent-browser` template (claude-code and codex only).

### 5. Use it

```bash
# a runner on its own
bb machine create --provider instabox --key <stable-key>
# a project's repo on that runner (bb clones the GitHub remote, not the hub's copy)
bb project source add <projectId> --clone --machine <hostId>
bb thread spawn --project <projectId> --machine <hostId> --new-environment worktree --provider claude-code --prompt '…'
# or: a new machine per thread, created, cloned and started in one step
bb thread spawn --project <projectId> --environment-provider instabox --provider pi --model zai/glm-5.2 --prompt '…'
# done with a runner
bb machine remove <hostId> --yes
```

Per-project secrets: `printf %s "$VALUE" | bb machine env set NAME --project <projectId>`
(encrypted by bb, passed to that project's machines on each turn).

| Setting | Default | Notes |
|---|---|---|
| `apiKey` (secret) | the server's `INSTABOX_API_KEY` | `ibk_…` |
| `template` | `agent-browser` | The free plan allows only this template |
| `snapshotId` | empty | Create machines from a snapshot instead |
| `zaiApiKey` (secret) | the server's `ZAI_API_KEY` | Given to the daemon as `ANTHROPIC_AUTH_TOKEN` (claude-code on Z.ai) and as `ZAI_API_KEY`. pi: pick `zai/<model>`, e.g. `zai/glm-5.2` (bb's model list does not show these). OpenCode: see `opencodeProviders` |
| `agentSecrets` (secret) | empty | One-line JSON `{"NAME":"value",…}` added to every machine's bb daemon environment. Re-applied to running machines when it changes (their daemon restarts). For per-project values use `bb machine env set NAME --project <id>` |
| `opencodeProviders` | Z.ai coding plan, zro, coralbricks, neuralwatt | JSON array `[{"id","name"?,"baseURL","keyEnv"}]` of OpenAI-compatible providers for OpenCode. On each machine the plugin calls `<baseURL>/models` with the key from `keyEnv` (from `zaiApiKey` or `agentSecrets`) and writes `~/.config/opencode/opencode.json` from the live list: `apiKey` is `{env:NAME}`, never the value. No key: skipped. A failed fetch keeps that provider's last list. A user-owned opencode.json is left alone: the plugin records a sha256 of what it wrote in `~/.config/bb-instabox/opencode.owned` and only rewrites a file that is missing or still matches it (so an edited file, a JSONC file or one without providers is never touched). Refreshed on create, resume and any credential/provider setting change; when the file changes, running bb daemons restart so bb's model picker shows the new list. The coralbricks and neuralwatt `keyEnv` names are assumed, not verified |
| `zaiBaseUrl` | `https://api.z.ai/api/anthropic` | |
| `boxHubPort` | `38886` | Must match `machineServerUrl`; reload the plugin after changing it |

Environment compositions `instabox` (git worktree) and `instabox-checkout`
(project checkout) appear in the environment picker. One command creates a box,
clones the project's git remote on it and starts the thread:

```bash
bb thread spawn --project <proj> --environment-provider instabox \
  --machine-inputs '{"snapshotId":"sn_…"}' --provider claude-code --prompt '…'
```

Snapshots of an enrolled box also work (create wipes the copied bb identity, so the
new box enrolls as a new host), but they carry that box's agent env file; prefer a
clean snapshot as below.

## A basic runner snapshot

Machines are faster to set up from a snapshot that already has the agents. Build one
from a plain machine that was never enrolled (no bb identity, repos, logins or secrets):

```bash
H="X-API-Key: $INSTABOX_API_KEY"; API=https://api.instabox.sh/v1
# 1. a plain machine, outside bb
curl -s -X POST $API/machines -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"name":"runner-base-build","templateId":"agent-browser"}' | jq -r .machineId     # → m_…
# 2. install pi and OpenCode on it (claude and codex ship with agent-browser)
cat > install.sh <<'SH'
sudo -n env HOME=/root npm --prefix /usr/local install -g @earendil-works/pi-coding-agent@latest
curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path
sudo -n ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode
for b in pi opencode claude codex; do $b --version | head -1; done
SH
jq -n --rawfile c install.sh '{cmd:$c,timeoutSeconds:300}' | curl -s -X POST $API/machines/m_…/exec -H "$H" -H 'Content-Type: application/json' -d @- | jq -r .stdout
# 3. save, then delete the build machine
curl -s -X POST $API/machines/m_…/snapshots -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' -d '{"name":"bb-runner-basic-v1"}' | jq -r .id
curl -s -X DELETE $API/machines/m_… -H "$H" -H "Idempotency-Key: $(uuidgen)"
```

Do not sign anything in on the build machine: everything in `/data` (home included) is
saved into the snapshot. A machine from this snapshot takes about 2.5 min to connect
(about 30 s from the template).
bb then offers claude-code, codex, pi and OpenCode (`acp-opencode`) on every new machine.
With `zaiApiKey` set, claude-code, pi and OpenCode run on Z.ai out of the box. codex and
subscription logins (Claude, ChatGPT) are not set up yet.

## Repos and secrets

bb itself clones each project's git remote on the machine (`bb project source add <proj>
--clone --machine <host>`, or automatically for `--environment-provider instabox`), so
machines get GitHub's current code, not the hub's copy. Private repos use the hub's `gh`
login, which bb passes to remote machines, or a `GH_TOKEN` machine variable.

## Lifecycle

- **create:** InstaBox create with a key-derived Idempotency-Key and
  `bb-provider`/`bb-key` metadata. Checkpoint the machine ID, remove any copied bb
  identity, install the chisel unit and agent env, open the tunnel, require the hub's
  `/health` from inside the box, then `bootstrap`.
- **suspend:** stop the tunnel, then InstaBox `suspend`, which keeps memory.
- **resume:** InstaBox `resume` (or `start`), close outbound HTTP(S) connections that
  were open before the pause, redo the box setup, reopen the tunnel with a new
  certificate, then `bootstrap` with the same key, which keeps the same host. Without
  the close step, a claude-code process that was alive across the pause reused its dead
  keep-alive socket to the model API, so the next turn hung (`API_TIMEOUT_MS` is 50 min).
- **remove / reconcileCleanup:** delete the VM and wait for a 404, then delete the
  certificate files, tunnel password and create record. Cleanup finds machines by the
  recorded ID, the create operation, or the key metadata.
- **supervisor (every 30 s):** reopens the tunnel for active hosts whose processes
  died or whose certificate is under 1 hour from expiry. If InstaBox paused a machine
  on its own (30 min idle pause on the free plan), it marks that host suspended in bb.

## Tests

`npm test` covers argv quoting, env-line injection, idempotent create,
key-scoped cleanup, and the OpenCode model sync against a fake `/models` server (key never
written or shell-expanded, last list kept on a failed fetch, user file left alone). `npx tsc --noEmit -p .` checks the types. `bb plugin build .` builds the plugin.

## Live acceptance status

Two runs on 2026-10-21 with bb 0.45 hubs in Amp orbs, claude-code on Z.ai, and the
InstaBox free plan. Each thread's answer was checked against a value computed
independently.

| Path | Result |
|---|---|
| `bb machine create --provider instabox` → enrolled over the tunnel | Passed (connected in about 30 s) |
| claude-code thread in a worktree on the box, via Z.ai | Passed |
| `bb machine suspend` → `resume`, same host, more work after resume | Passed (two runs) |
| Snapshot of an enrolled box → `bb thread spawn --environment-provider instabox` with `snapshotId` → git remote cloned → thread | Passed; the copied identity was wiped, so the new box enrolled as a new host |
| Pause from outside bb (stands in for the idle pause) → supervisor marks the host suspended → `bb thread tell` resumes it | Passed after a fix: the first run hung on a stale model-API socket; resume now closes outbound HTTP(S) connections |
| `bb machine remove` → VM gone (API 404), tunnel processes and credentials removed | Passed (three runs) |
| Basic snapshot (pi, OpenCode, claude-code, codex) → new machine → private repo cloned at GitHub HEAD → claude-code (`claude-sonnet-5-5` via Z.ai), pi (`zai/glm-5.2`) and OpenCode (`zai-coding-plan/glm-5.3`) threads, then suspend/resume and a follow-up turn on pi and OpenCode | Passed (all answers matched values computed independently) |
| OpenCode models from the live `/models` list: 11 Z.ai models written on the box (key not in the file); `zai-coding-plan/glm-5.1` (not in any fixed list) answered on the existing runner and on a new one-step box, whose picker listed all of them | Passed |
| `bb thread spawn --environment-provider instabox --provider acp-opencode --model zai-coding-plan/glm-5.3` → new box from the snapshot → private repo cloned → answer → `bb machine remove` | Passed (about 40 s to provision) |
| `agentSecrets` changed → re-applied to running machines → visible to the agent | Passed (hash of the value matched) |

## Known limits

- The tunnel processes are children of the bb server. After a bb restart, the
  supervisor reopens them within about 30 s.
- The bb server needs `ssh` and `ssh-keygen`. chisel is downloaded once into the
  plugin's data directory.
- Idle-pause handling was tested by pausing through the API, not by waiting 30 min.
  Certificate renewal at 23 h and cleanup after an interrupted create are not tested live.
- A snapshot of an enrolled box contains its `~/.config/bb-instabox/agent.env`
  (the Z.ai key). Snapshots are private to the account; create overwrites the file.
- In one of two one-step runs (`--environment-provider instabox`), OpenCode with GLM-5.3
  answered bb's injected tool notice instead of the prompt; the rerun answered correctly.
- One create out of six failed inside bb's own enrollment (`Could not exchange machine
  enrollment credential`) after the plugin's setup had succeeded; bb rolled it back cleanly
  (VM deleted) and the next create worked. Cause not found; retry the create.
- The hub's memory use matters: on a 3 GiB orb, bb was OOM-killed once during
  bootstrap, and the create still completed after the restart.
