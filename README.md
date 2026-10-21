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

```bash
bb plugin install /path/to/bb-plugin-instabox --yes
bb settings general defaultMachineAccess direct
bb settings general machineServerUrl http://127.0.0.1:38886
bb machine create --provider instabox --key <stable-key>
```

| Setting | Default | Notes |
|---|---|---|
| `apiKey` (secret) | the server's `INSTABOX_API_KEY` | `ibk_…` |
| `template` | `agent-browser` | The free plan allows only this template |
| `snapshotId` | empty | Create machines from a snapshot instead |
| `zaiApiKey` (secret) | the server's `ZAI_API_KEY` | Given to the daemon as `ANTHROPIC_AUTH_TOKEN` (claude-code on Z.ai) and as `ZAI_API_KEY` (pi: pick `zai/<model>`, e.g. `zai/glm-5.2`; bb's model list does not show these) |
| `agentSecrets` (secret) | empty | One-line JSON `{"NAME":"value",…}` added to every machine's bb daemon environment. Re-applied to running machines when it changes (their daemon restarts). For per-project values use `bb machine env set NAME --project <id>` |
| `zaiBaseUrl` | `https://api.z.ai/api/anthropic` | |
| `boxHubPort` | `38886` | Must match `machineServerUrl`; reload the plugin after changing it |

Environment compositions `instabox` (git worktree) and `instabox-checkout`
(project checkout) appear in the environment picker. One command creates a box,
clones the project's git remote on it and starts the thread:

```bash
bb thread spawn --project <proj> --environment-provider instabox \
  --machine-inputs '{"snapshotId":"sn_…"}' --provider claude-code --prompt '…'
```

Snapshots of an enrolled box work: create wipes the copied bb identity, so the new
box enrolls as a new host.

## A basic runner snapshot

Machines are faster to set up from a snapshot that already has the agents. Build one
from a plain machine that was never enrolled (no bb identity, repos, logins or secrets):

```bash
sudo npm --prefix /usr/local install -g @earendil-works/pi-coding-agent@latest
curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path
sudo ln -sf ~/.opencode/bin/opencode /usr/local/bin/opencode   # claude and codex ship with agent-browser
```

Save it (`POST /v1/machines/{id}/snapshots`), delete the machine, and set `snapshotId`.
bb then offers claude-code, codex, pi and OpenCode (`acp-opencode`) on every new machine.
Model credentials other than Z.ai are not set up: OpenCode's free models are rate
limited, and codex needs its own login or key (`agentSecrets`).

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

`npm test` covers argv quoting, env-line injection, idempotent create and
key-scoped cleanup. `npx tsc --noEmit -p .` checks the types. `bb plugin build .` builds the plugin.

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
| Basic snapshot (pi, OpenCode, claude-code, codex) → new machine → private repo cloned at GitHub HEAD → claude-code and pi (`zai/glm-5.2`) threads | Passed; OpenCode starts but its free model was rate limited |
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
- The hub's memory use matters: on a 3 GiB orb, bb was OOM-killed once during
  bootstrap, and the create still completed after the restart.
