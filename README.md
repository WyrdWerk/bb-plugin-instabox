# bb-plugin-instabox (experimental)

> **Status: experimental, v0.1.0.** Live acceptance passed on 2026-10-21; see
> [Live acceptance status](#live-acceptance-status).

A bb machine provider that runs bb threads on [InstaBox](https://instabox.sh)
machines. It has the same shape as [`bb-plugin-boat`](https://github.com/WyrdWerk/bb-plugin-boat), with one difference: the
connection from the machine back to the bb hub uses **no Tailscale and no bb
Connect**. It needs only the InstaBox API key. It also adds an **InstaBox** page to bb
(see [The InstaBox page](#the-instabox-page)).

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
  With a `GH_TOKEN` org Secret (see [Keys on runners](#keys-on-runners)), runners also
  have `gh` and HTTPS git access of their own.

No Tailscale, no bb Connect and no public port are needed.

### 2. Install the plugin

```bash
git clone https://github.com/WyrdWerk/bb-plugin-instabox && cd bb-plugin-instabox
npm ci
bb plugin build .
bb plugin install "$PWD" --yes
```

(Installing straight from the Git URL has not been tested.)

### 3. The InstaBox API key and hub settings

Open **Settings → Plugins → InstaBox** in bb and paste an `ibk_…` key from the InstaBox
dashboard into **InstaBox API key**. It is stored as a secret on the hub and shown
masked after saving. There is no environment-variable or command-line way to supply it;
until it is set, the plugin and the InstaBox page show "setup required" pointing to that
settings page.

Then point machines at the tunnel; the plugin shows "setup required" with this exact
command until it is done:

```bash
bb settings general defaultMachineAccess direct
bb settings general machineServerUrl http://127.0.0.1:38886
```

### 4. A basic runner snapshot (recommended)

See [A basic runner snapshot](#a-basic-runner-snapshot), then
set **Snapshot id** in the plugin settings to `sn_…`. Without it, machines start from the
`agent-browser` template (claude-code and codex only).

### 5. Use it

```bash
# a runner on its own
bb machine create --provider instabox --key <stable-key>
# a project's repo on that runner (bb clones the GitHub remote, not the hub's copy)
bb project source add <projectId> --clone --machine <hostId>
bb thread spawn --project <projectId> --machine <hostId> --new-environment worktree --provider pi --model zai/glm-5.2 --prompt '…'
# or: a new machine per thread, created, cloned and started in one step
bb thread spawn --project <projectId> --environment-provider instabox --provider acp-opencode --model zai-coding-plan/glm-5.3 --prompt '…'
# done with a runner
bb machine remove <hostId> --yes
```

Per-project secrets: `printf %s "$VALUE" | bb machine env set NAME --project <projectId>`
(encrypted by bb, passed to that project's machines on each turn).

| Setting | Default | Notes |
|---|---|---|
| `apiKey` (secret) | empty | `ibk_…`. Required; set it on the settings page |
| `template` | `agent-browser` | The free plan allows only this template |
| `snapshotId` | empty | Create machines from a snapshot instead |
| `idlePauseSeconds` | `300` | `autoSuspendAfterSeconds` for new machines. `0` sends nothing (InstaBox's account default); it does not turn the pause off. Each machine can be changed on the InstaBox page |
| `opencodeProviders` | the eight org-Secret providers below | JSON array `[{"id","name"?,"baseURL","keyEnv"}]` of OpenAI-compatible providers for Pi and OpenCode (see [Keys on runners](#keys-on-runners)) |
| `githubOwners` | empty | Comma list of GitHub owners for the Projects repo picker. Empty: `WyrdWerk` plus the account `gh` on the hub is logged in as |
| `createMissingProjects` | off | Project runners: create a bb project for a cloned repo whose remote matches none |
| `boxHubPort` | `38886` | Must match `machineServerUrl`; reload the plugin after changing it |

Environment compositions `instabox` (git worktree) and `instabox-checkout`
(project checkout) appear in the environment picker. One command creates a box,
clones the project's git remote on it and starts the thread:

```bash
bb thread spawn --project <proj> --environment-provider instabox \
  --machine-inputs '{"snapshotId":"sn_…"}' --provider claude-code --prompt '…'
```

Snapshots of an enrolled box also work (create wipes the copied bb identity, so the
new box enrolls as a new host), but prefer a clean snapshot as below.

## A basic runner snapshot

Machines are faster to set up from a snapshot that already has the agents. Build one
from a plain machine that was never enrolled (no bb identity, repos, logins or secrets):

```bash
read -rs IBK; H="X-API-Key: $IBK"; API=https://api.instabox.sh/v1
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
Pi and OpenCode run on the org's Secrets out of the box. The plugin does not configure
Claude Code, Codex or Grok Build at all (no env vars, no config files): sign in to them by
hand on each machine if you want them.

## Keys on runners

No real key values reach a runner. Every machine the plugin creates is created with
`"secrets": "all"`: it gets **all** of the org's InstaBox proxy Secrets, now and any added
later. Inside the machine each Secret is a placeholder (`ibsec_…`) in
`/run/instabox/secrets/env`; InstaBox swaps in the real value on HTTPS requests to that
Secret's allowed hosts.

- The plugin copies that file's variables into `~/.config/bb-instabox/secrets.env` and adds
  a systemd drop-in so the bb daemon (and every agent it starts) has them. Re-done on
  create and resume.
- **Pi and OpenCode** get provider configs that reference env var names only:
  `~/.pi/agent/models.json` (`"apiKey": "$ZRO_API_KEY"`; Z.ai uses Pi's built-in `zai`
  provider) and `~/.config/opencode/opencode.json` (`"apiKey": "{env:ZRO_API_KEY}"`). Model
  lists come from each provider's live `<baseURL>/models`, called on the machine with the
  placeholder. A provider whose Secret is missing is skipped; a failed fetch keeps the last
  list. Defaults:

  | Provider id | Base URL | Secret env var |
  |---|---|---|
  | `zai-coding-plan` (Pi: `zai`) | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` |
  | `zro` | `https://zro.moonmath.ai/v1` | `ZRO_API_KEY` |
  | `coralbricks` | `https://inference.coralbricks.ai/v1` | `CORALBRICKS_API_KEY` |
  | `neuralwatt` | `https://api.neuralwatt.com/v1` | `NEURALWATT_API_KEY` |
  | `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
  | `hypercharm` | `https://hyper.charm.land/v1` | `HYPERCHARM_API_KEY` |
  | `singularity` | `https://api.singularityapi.dev/v1` | `SINGULARITY_API_KEY` |
  | `runinfra` | `https://api.runinfra.ai/v1` | `RUNINFRA_GATEWAY_KEY` |

- A user's own config is never overwritten: the plugin records a sha256 of what it wrote
  (`~/.config/bb-instabox/opencode.owned`, `pi-models.owned`) and only rewrites a file that
  is missing or still matches. The `agent-browser` template rewrites `opencode.json` (MCP
  servers only) at every boot; that exact file is also treated as the plugin's, so
  providers come back after a reboot and the template's MCP servers are kept.
- When a config changes, running bb daemons restart so bb's model picker shows the list
  (this interrupts a turn in progress).
- **Claude Code, Codex and Grok Build** are installed in the runner snapshot only. Log in
  to them on each machine yourself.

### Repos

bb itself clones each project's git remote on the machine (`bb project source add <proj>
--clone --machine <host>`, or automatically for `--environment-provider instabox`), so
machines get GitHub's current code, not the hub's copy. Private repos use the hub's `gh`
login, which bb passes to remote machines; with a `GH_TOKEN` org Secret, `gh` works on the
machine too.

### Project runners

A **project** (InstaBox page → Projects) is a name plus a set of GitHub repos, each with an
optional branch. The repo picker lists `gh repo list <owner>` on the hub for the
`githubOwners` setting, and the branch picker lists that repo's branches through `gh api`
(default branch first); `gh` must be logged in on the hub, and no token reaches the page.
Manual URL and branch entry works when `gh` is unavailable.

Choose a project when creating a bb runner on the InstaBox page, or in the Project field of
bb's machine inputs (New Thread / machine create, or `--machine-inputs '{"project":"<name>"}'`).
After enrolling, the plugin clones every repo into `~/workspace/repos/<name>` at its branch
(the default branch when empty) and registers each clone as a source of the bb project with
the same git remote on that machine (`createMissingProjects` creates one when none matches).
A failed clone fails the create. An existing clone is left as it is, and a branch mismatch
is only reported.

Private repos clone through the machine's `GH_TOKEN` org Secret placeholder, offered by a
one-off `git -c credential.helper=…` for that clone only; InstaBox's proxy swaps in the
real token. Nothing is written into the remote URL or any git config.

## The InstaBox page

The plugin adds an **InstaBox** page to bb's sidebar. It shows the account (tier, usage),
machines (with the bb host each one backs), snapshots, templates and projects, and offers: pause,
resume, stop, start, snapshot, create (plain, or as a bb runner), rename, the idle pause
per machine (the choices from InstaBox's `GET /v1/me`; "off" only on accounts with manual
lifecycle), delete a machine or a snapshot (type its name to confirm), and a command box
that runs one command on a machine and redacts InstaBox keys and Secret placeholders from
the output. The API key never leaves the hub. There are no SSH certificates, ports,
desktop links or terminals on the page.

## Lifecycle

- **create:** InstaBox create with a key-derived Idempotency-Key and
  `bb-provider`/`bb-key` metadata. Checkpoint the machine ID, remove any copied bb
  identity, select all org Secrets and wait until they are applied, install the chisel
  unit, the Secret env and the Pi/OpenCode configs, open the tunnel, require the hub's
  `/health` from inside the box, then `bootstrap`.
- **suspend:** stop the tunnel and the bb daemon on the machine, then InstaBox `suspend`,
  which keeps memory. The daemon is stopped first because bb's shutdown of it can outlive
  its unit and keep the daemon port; paused in that state, it blocked the port for over a
  minute after resume and the resume failed.
- **resume:** InstaBox `resume` (or `start`), stop any daemon left from before the pause,
  close outbound HTTP(S) connections that were open before the pause, redo the box setup, reopen the tunnel with a new
  certificate, then `bootstrap` with the same key, which keeps the same host. Without
  the close step, a claude-code process that was alive across the pause reused its dead
  keep-alive socket to the model API, so the next turn hung.
- **remove / reconcileCleanup:** delete the VM and wait for a 404, then delete the
  certificate files, tunnel password and create record. Cleanup finds machines by the
  recorded ID, the create operation, or the key metadata.
- **supervisor (every 30 s):** reopens the tunnel for active hosts whose processes
  died or whose certificate is under 1 hour from expiry (tunnels of a create or resume in
  progress are left to that call). It also runs the idle pause, see below. If InstaBox
  paused or stopped a machine on its own, it marks that host suspended in bb, and the next
  message resumes it.

### Idle pause

InstaBox's own idle pause never fires on a connected runner: it counts SSH traffic as
activity, and the tunnel carries the bb daemon's heartbeats. So the plugin applies each
machine's idle time (`autoSuspendAfterSeconds`, default 5 min, changeable per machine on
the InstaBox page) itself: once no bb thread on the runner has been starting or active
for that long, the supervisor pauses it through bb, and the next message to one of its
threads resumes it. A turn that runs longer than the idle time is never paused, because
its thread is active; the plugin also holds an InstaBox activity lease while a thread
works. The idle clock restarts when the plugin or bb restarts. Plain machines created on
the InstaBox page (not bb runners) have no tunnel and use InstaBox's own idle pause.

## Tests

`npm test` covers argv quoting, the Secret env copy, idempotent create with
`secrets: "all"`, key-scoped cleanup, the dashboard handlers (confirmations, redaction,
idle choices), activity leases, and the Pi/OpenCode model sync against a fake `/models`
server (key never written or shell-expanded, last list kept on a failed fetch, user file
left alone, template file taken over). `npx tsc --noEmit -p .` checks the types. `bb plugin build .` builds the plugin.

## Live acceptance status

### 2026-11-04: bb 0.48.1 hub (lucky-fox), paid InstaBox account, org proxy Secrets

Runners came from the `bb-runner-basic-wyrd1-v2` snapshot (Claude Code, Codex, Grok Build,
Pi, OpenCode installed; no logins or keys). Answers were checked against values read on
the box directly.

| Path | Result |
|---|---|
| `bb machine create --provider instabox` → connected | Passed (about 55 s) after two fixes: the hub's SSH key inherited a group-readable ACL (ssh refused it; now chmod 600), and the supervisor stopped the tunnel of a machine still being created |
| Machine Secrets: selection `all`, guest and proxy `applied`; names in the bb daemon's environment compared with a fresh list of the org's proxy Secrets | Passed: all 17 present, values are `ibsec_` placeholders |
| Pi and OpenCode configs | Passed: 8 providers each from live `/models`; only `$NAME` / `{env:NAME}` references, no placeholder or key in either file; the template's MCP servers kept |
| Claude Code, Codex, Grok Build | Installed (2.1.288, 0.160.0, 1.0.70); no plugin env vars or config files; their first-run state files hold no logins |
| `gh api user` with the `GH_TOKEN` placeholder; HTTPS clone of a private repo | Passed |
| Pi (`zai/glm-5.3`, `zro/glm-5.3-flash`) and OpenCode (`zai-coding-plan/glm-5.3`, `zro/glm-5.3-flash`) threads | Passed (4/4 correct) |
| `bb machine suspend` → `resume` → follow-up turns on Pi and OpenCode | Passed after a fix: a daemon left from the suspend held its port after resume (EADDRINUSE); suspend and resume now stop it |
| Stop outside bb (a reboot) → host marked suspended → message → start → OpenCode turn | Passed; the provider config survived. The first OpenCode turn after the boot failed once with `database is locked`; the retry answered |
| Idle pause, 5 min: no thread busy → paused by the plugin → `bb thread tell` resumes it and answers | Passed (paused 5 min after the idle clock started; answered 39 s after the message) |
| A 7-minute turn on a runner with a 5-minute idle pause | Passed: not paused (sampled every 30 s) |
| Captain thread (Pi, on the hub) → Pi worker and OpenCode worker on two InstaBox runners → combined answer | Passed |
| `systemctl --user restart bb.service` → both runners reconnect → turns on both | Passed (reconnected in about 20 s) |
| InstaBox page: overview, run command with redaction, create plain and as bb runner, pause, resume, stop, start, idle change, rename, snapshot, delete snapshot and delete machine with typed confirmation (a wrong name is refused) | Passed |

### 2026-10-21: bb 0.45, free plan

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
| `agentSecrets` changed → re-applied to running machines → visible to the agent | Passed (hash of the value matched); this setting has since been removed in favour of org Secrets |

The 2026-10-21 runs used plugin-held keys and claude-code on Z.ai; both have since been
removed.

## Known limits

- The tunnel processes are children of the bb server. After a bb restart, the
  supervisor reopens them within about 30 s.
- The bb server needs `ssh` and `ssh-keygen`. chisel is downloaded once into the
  plugin's data directory.
- InstaBox's own idle pause never fires on a connected runner (the tunnel's SSH traffic
  counts as activity); the plugin pauses idle runners itself, see [Idle pause](#idle-pause).
  Certificate renewal at 23 h and cleanup after an interrupted create are not tested live.
- bb itself sets `GH_TOKEN` and git credentials for each thread from the hub's `gh` login
  (its machine-git environment, shown in the thread log), so inside threads that login is
  what git and `gh` use, presumably over the `GH_TOKEN` org Secret placeholder. A shell on
  the box (and the plugin's checks) uses the placeholder.
- A plugin reload stops every tunnel; the supervisor reopens them within about 30 s, and
  runners show "disconnected" until then.
- A snapshot of an enrolled box contains its `~/.config/bb-instabox/secrets.env`
  (placeholders only, which are useless outside that machine). Create rewrites it.
- In one of two one-step runs (`--environment-provider instabox`), OpenCode with GLM-5.3
  answered bb's injected tool notice instead of the prompt; the rerun answered correctly.
- One create out of six failed inside bb's own enrollment (`Could not exchange machine
  enrollment credential`) after the plugin's setup had succeeded; bb rolled it back cleanly
  (VM deleted) and the next create worked. Cause not found; retry the create.
- The hub's memory use matters: on a 3 GiB orb, bb was OOM-killed once during
  bootstrap, and the create still completed after the restart.
