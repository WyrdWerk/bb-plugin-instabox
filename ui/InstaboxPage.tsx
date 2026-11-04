// The InstaBox page (navPanel component). Layout is the section list in the
// render below: account, machines, snapshots, templates, run command.
//
// Every action opens ActionDialog first. A request id is created when the
// dialog opens and travels to the server as the Idempotency-Key (or bb
// creation key), so a double submit or a retried request cannot do the work
// twice. Destructive actions need the resource name typed.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ExecResultDto, MachineDto, OverviewDto, SnapshotDto, TemplateDto } from "../src/dashboard.ts";
import { ActionDialog, type DialogSpec, type DialogValues } from "./dialogs.tsx";
import { ago, idleText, labelsText, parseLabels, suggestSnapshotName } from "./format.ts";
import { AccountSection, MachinesSection, RunCommandSection, SnapshotsSection, TemplatesSection, type MachineAction } from "./sections.tsx";
import { ImportSection } from "./ImportSection.tsx";
import { NO_PROJECTS_TEXT } from "./NoProjectsHint.tsx";
import { ProjectsSection } from "./ProjectsSection.tsx";
import { useIdleChoices, useInstaboxOverview, useInstaboxRunning, useProjectNames } from "./useInstabox.ts";

function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type Notice = { message: string; hostId?: string | null };

export function InstaboxPage(_props: PluginNavPanelProps) {
  const { rpc, data, error, loading, refetch } = useInstaboxOverview();
  const { choices } = useIdleChoices();
  const projectNames = useProjectNames();
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [execResult, setExecResult] = useState<ExecResultDto | null>(null);
  const now = useNow();

  const open = useCallback((s: DialogSpec) => {
    setNotice(null);
    setSpec(s);
  }, []);

  const run = useCallback(
    async (s: DialogSpec, values: DialogValues) => {
      const result = await s.run(values);
      if (result.message) setNotice({ message: result.message, hostId: result.hostId ?? null });
      refetch();
    },
    [refetch],
  );

  const idleOptions = (current: number | null) => {
    const all = [...(choices?.choices ?? [])];
    if (all.length === 0) all.push(300);
    if (current !== null && !all.includes(current)) all.push(current);
    all.sort((a, b) => a - b);
    return all.map((s) => ({ value: String(s), label: idleText(s) }));
  };

  const machineLifecycle = (m: MachineDto, action: "start" | "stop" | "suspend" | "resume"): DialogSpec => {
    const copy = {
      start: {
        title: `Start ${m.name}`,
        description: m.state === "suspended" ? "Start resumes the paused machine (memory and processes are kept when InstaBox can restore them)." : "Start boots the machine and brings its files back.",
        confirmLabel: "Start",
        destructive: false,
      },
      resume: {
        title: `Resume ${m.name}`,
        description: "Resume wakes the paused machine and keeps its memory and processes when InstaBox can restore them. On a paid plan this bills running time.",
        confirmLabel: "Resume",
        destructive: false,
      },
      suspend: {
        title: `Pause ${m.name}`,
        description: "Pause keeps memory, processes and files. Threads connected to it stop until it is resumed; bb will resume it on the next message.",
        confirmLabel: "Pause",
        destructive: false,
      },
      stop: {
        title: `Stop ${m.name}`,
        description: "Stop ends every process. Files are kept, but a running agent turn and its terminal state are lost. InstaBox refuses Stop on a paused machine: start it first.",
        confirmLabel: "Stop",
        destructive: true,
      },
    }[action];
    return {
      title: copy.title,
      description: copy.description,
      confirmLabel: copy.confirmLabel,
      destructive: copy.destructive,
      fields: [],
      run: async () => {
        const r = await rpc.call("instabox_lifecycle", { machineId: m.id, action, requestId: crypto.randomUUID() });
        return { message: r.message };
      },
    };
  };

  const snapshotMachine = (m: MachineDto): DialogSpec => ({
    title: `Snapshot ${m.name}`,
    description: (
      <>
        <p>
          Saves the machine's system files and <code className="font-mono">/data</code>. A running machine is saved live; a stopped one is quick.
        </p>
        <p className="text-destructive">The snapshot includes /data/home, so agent logins, keys and git credentials in it go with the snapshot.</p>
      </>
    ),
    confirmLabel: "Save snapshot",
    fields: [
      { kind: "text", key: "name", label: "Snapshot name", initial: suggestSnapshotName(m.name), hint: "lowercase letters, digits and dashes", required: true },
      { kind: "textarea", key: "description", label: "Description (optional)", initial: "", rows: 2 },
    ],
    run: async (v) => {
      const name = String(v.name).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Snapshot name: lowercase letters, digits and dashes");
      const description = String(v.description ?? "").trim();
      const r = await rpc.call("instabox_save_snapshot", { machineId: m.id, name, ...(description ? { description } : {}), requestId: crypto.randomUUID() });
      return { message: r.message };
    },
  });

  const setIdle = (m: MachineDto): DialogSpec => ({
    title: `Idle pause for ${m.name}`,
    description: (
      <>
        <p>
          The machine pauses after this much idle time. The current value is <strong>{idleText(m.autoSuspendAfterSeconds)}</strong>.
        </p>
        {m.bbMachine ? (
          <p>
            This is a bb runner: InstaBox counts its tunnel as activity, so the plugin pauses it once no bb thread on it has been working for this long, and the next message resumes it. A
            turn that runs longer is not paused.
          </p>
        ) : (
          <p>InstaBox pauses it after this long with no agent, terminal or SSH traffic, or CPU load.</p>
        )}
        {choices && !choices.canDisable ? <p className="text-muted-foreground">This account does not allow turning the idle pause off.</p> : null}
      </>
    ),
    confirmLabel: "Set idle pause",
    fields: [
      {
        kind: "select",
        key: "seconds",
        label: "Pause after",
        initial: String(m.autoSuspendAfterSeconds ?? idleOptions(m.autoSuspendAfterSeconds)[0]?.value ?? 300),
        options: [
          ...idleOptions(m.autoSuspendAfterSeconds),
          ...(choices?.canDisable ? [{ value: "0", label: "Off (never pause)" }] : []),
        ],
      },
    ],
    run: async (v) => {
      const r = await rpc.call("instabox_set_idle", { machineId: m.id, seconds: Number(v.seconds), requestId: crypto.randomUUID() });
      return { message: r.message };
    },
  });

  const rename = (m: MachineDto): DialogSpec => ({
    title: `Rename ${m.name}`,
    description: (
      <>
        <p>Names are lowercase letters, digits and dashes, starting with a letter or digit. Labels are key=value lines, one per line; bb's own labels are kept.</p>
      </>
    ),
    confirmLabel: "Save",
    fields: [
      { kind: "text", key: "name", label: "Name", initial: m.name, required: true },
      { kind: "textarea", key: "labels", label: "Labels", initial: labelsText(m.metadata), placeholder: "team=agents\nowner=yash", rows: 4 },
    ],
    run: async (v) => {
      const name = String(v.name).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Name: lowercase letters, digits and dashes, starting with a letter or digit");
      const labels = parseLabels(String(v.labels ?? ""));
      const r = await rpc.call("instabox_rename", { machineId: m.id, name, labels, requestId: crypto.randomUUID() });
      return { message: r.message };
    },
  });

  const deleteMachine = (m: MachineDto): DialogSpec => ({
    title: `Delete ${m.name}`,
    description: (
      <>
        <p className="font-medium text-destructive">Permanent. The machine's disk is deleted; its snapshots are kept.</p>
        {m.bbMachine ? (
          <p>
            This machine is bb machine <strong>{m.bbMachine.name}</strong>. Remove it from bb first (Machines → {m.bbMachine.name}) so bb can tear down its environments.
          </p>
        ) : null}
      </>
    ),
    confirmLabel: "Delete machine",
    destructive: true,
    fields: [{ kind: "confirm", key: "confirm", label: `Type ${m.name} to confirm`, expected: m.name }],
    run: async (v) => {
      const r = await rpc.call("instabox_delete_machine", { machineId: m.id, confirmName: String(v.confirm), requestId: crypto.randomUUID() });
      return { message: r.message };
    },
  });

  const deleteSnapshot = (s: SnapshotDto): DialogSpec => ({
    title: `Delete snapshot ${s.name}`,
    description: (
      <>
        <p className="font-medium text-destructive">Permanent. Machines already created from it are not affected.</p>
        <p>Its stored data is cleaned up once no machine needs it.</p>
        {s.configured ? (
          <p className="font-medium">This is the plugin's configured runner snapshot. Deleting it means new machines fall back to the template until you set another snapshotId.</p>
        ) : null}
      </>
    ),
    confirmLabel: "Delete snapshot",
    destructive: true,
    fields: [{ kind: "confirm", key: "confirm", label: `Type ${s.name} to confirm`, expected: s.name }],
    run: async (v) => {
      const r = await rpc.call("instabox_delete_snapshot", { snapshotId: s.id, confirmName: String(v.confirm), requestId: crypto.randomUUID() });
      return { message: r.message };
    },
  });

  /** The plugin's runner snapshot, else the agent-browser template (the plugin default). */
  const configuredSource = (templates: TemplateDto[], snapshots: SnapshotDto[]) => {
    const snap = snapshots.find((x) => x.configured);
    if (snap) return `snapshot:${snap.id}`;
    const t = templates.find((x) => x.id === "agent-browser");
    return t ? `template:${t.id}@${t.version}` : null;
  };

  const createMachine = (preset?: { template?: TemplateDto; snapshot?: SnapshotDto }): DialogSpec => {
    const templates = data?.templates.items ?? [];
    const snapshots = (data?.snapshots.items ?? []).filter((s) => s.status === "ready");
    const options = [
      ...templates.map((t) => ({ value: `template:${t.id}@${t.version}`, label: `template · ${t.id} @ ${t.version}` })),
      ...snapshots.map((s) => ({ value: `snapshot:${s.id}`, label: `snapshot · ${s.name}${s.configured ? " (runner source)" : ""}` })),
    ];
    const initial = preset?.snapshot
      ? `snapshot:${preset.snapshot.id}`
      : preset?.template
        ? `template:${preset.template.id}@${preset.template.version}`
        : (configuredSource(templates, snapshots) ?? options[0]?.value ?? "");
    const defaultIdle = choices?.defaultSeconds ?? null;
    const idle = [...(choices?.choices ?? [])];
    if (defaultIdle !== null && !idle.includes(defaultIdle)) idle.unshift(defaultIdle);
    idle.sort((a, b) => a - b);
    const idleOpts = [
      ...(defaultIdle !== null
        ? [{ value: String(defaultIdle), label: `${idleText(defaultIdle)} (plugin default)` }]
        : [{ value: "", label: "InstaBox account default" }]),
      ...idle.filter((s) => s !== defaultIdle).map((s) => ({ value: String(s), label: idleText(s) })),
      ...(defaultIdle !== null ? [{ value: "", label: "InstaBox account default" }] : []),
      ...(choices?.canDisable ? [{ value: "0", label: "Off (never pause)" }] : []),
    ];
    return {
      title: preset?.snapshot ? `New machine from ${preset.snapshot.name}` : preset?.template ? `New machine from ${preset.template.id}` : "New InstaBox machine",
      description: (
        <>
          <p>Creates a machine on the WYRD1 InstaBox account. It bills while it runs; pause or delete it when done.</p>
          <p>With <strong>as bb runner</strong> the machine is enrolled through bb's normal provider path and appears in Machines. A plain machine is just a VM.</p>
        </>
      ),
      confirmLabel: "Create",
      fields: [
        { kind: "select", key: "source", label: "Start from", initial, options },
        { kind: "text", key: "name", label: "Name", initial: "", placeholder: "lowercase-name", hint: "Required for a plain machine; a bb runner gets bb-<hash>", required: false },
        { kind: "select", key: "idle", label: "Idle pause", initial: idleOpts[0]?.value ?? "", options: idleOpts, hint: "While a bb thread works, the plugin holds an activity lease regardless of this value." },
        { kind: "checkbox", key: "asRunner", label: "Create as a bb runner (enroll it)", initial: false },
        {
          kind: "select",
          key: "project",
          label: "Project (bb runners only)",
          initial: "",
          options: [{ value: "", label: "None" }, ...projectNames.map((n) => ({ value: n, label: n }))],
          hint: projectNames.length === 0 ? NO_PROJECTS_TEXT : "Clones each repo of the project at its branch into ~/workspace/repos and registers it as a bb project source on the runner.",
        },
      ],
      run: async (v) => {
        const source = String(v.source);
        const asRunner = Boolean(v.asRunner);
        const name = String(v.name ?? "").trim();
        if (!asRunner && name === "") throw new Error("A machine name is required");
        if (name !== "" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Name: lowercase letters, digits and dashes, starting with a letter or digit");
        if (source === "") throw new Error("Choose a template or snapshot");
        const project = String(v.project ?? "");
        if (project !== "" && !asRunner) throw new Error("A project needs \"Create as a bb runner\" checked");
        const idleSeconds = String(v.idle ?? "") === "" ? null : Number(v.idle);
        const parsed = source.startsWith("template:")
          ? ({ kind: "template" as const, templateId: source.slice("template:".length).split("@")[0]! })
          : ({ kind: "snapshot" as const, snapshotId: source.slice("snapshot:".length) });
        const r = await rpc.call("instabox_create_machine", {
          name: name === "" ? null : name,
          source: parsed,
          idleSeconds,
          asRunner,
          ...(project !== "" ? { project } : {}),
          requestId: crypto.randomUUID(),
        });
        return { message: r.message, hostId: r.hostId };
      },
    };
  };

  const runCommand = (machineId: string, cmd: string, timeoutSeconds: number): DialogSpec => {
    const m = (data?.machines.items ?? []).find((x) => x.id === machineId);
    return {
      title: `Run on ${m?.name ?? machineId}`,
      description: (
        <>
          <p>The command runs as the machine's user with <code className="font-mono">bash -lc</code>. stdout and stderr are returned when it exits (max 600 s, 1 MiB each).</p>
          {m && m.state !== "running" ? <p className="font-medium">This machine is {m.state}; running wakes it and bills running time.</p> : null}
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-secondary/40 px-2 py-1 font-mono text-xs text-foreground">{cmd}</pre>
          <p className="text-xs">InstaBox API keys and org Secret placeholders are replaced with <code className="font-mono">[redacted …]</code> in the output. Other secrets are not detected.</p>
        </>
      ),
      confirmLabel: "Run command",
      fields: [],
      run: async () => {
        const r = await rpc.call("instabox_exec", { machineId, cmd, timeoutSeconds });
        setExecResult(r);
        return { message: "" };
      },
    };
  };

  const onMachineAction = (action: MachineAction, m: MachineDto) => {
    if (action === "idle") open(setIdle(m));
    else if (action === "snapshot") open(snapshotMachine(m));
    else if (action === "rename") open(rename(m));
    else if (action === "delete") open(deleteMachine(m));
    else open(machineLifecycle(m, action));
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-2xl text-sm text-muted-foreground">
            InstaBox machines and snapshots on this account. Pause keeps memory; stop ends processes; deletes need the name typed. The API key stays on the server.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {data ? <span>updated {ago(data.fetchedAt, now)}</span> : null}
            <Button variant="ghost" size="sm" onClick={refetch} disabled={loading} aria-label="Refresh">
              <Icon name="RefreshCw" className={loading ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-3 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
            {notice.message}
            {notice.hostId ? (
              <>
                {" "}
                <a className="underline underline-offset-4" href={`/settings/machines/${encodeURIComponent(notice.hostId)}`}>
                  Open the new machine
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {data?.hubWarning ? (
          <div role="alert" className="mt-3 rounded-md border border-destructive px-3 py-2 text-sm text-destructive">
            {data.hubWarning}
          </div>
        ) : null}

        {data === null ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
        ) : !data.configured ? (
          <div className="mt-6 rounded-lg border border-dashed border-border px-4 py-6 text-sm">
            <p>{data.setupMessage}</p>
            <p className="mt-2 text-muted-foreground">
              Settings → Plugins → InstaBox, or <code className="font-mono">bb plugin config instabox</code>. Use the paid WYRD1 account key. Then point bb at the tunnel:
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-secondary/50 px-2 py-1 font-mono text-xs">bb settings general defaultMachineAccess direct{"\n"}bb settings general machineServerUrl http://127.0.0.1:38886</pre>
          </div>
        ) : (
          <>
            <AccountSection data={data} />
            <MachinesSection data={data} now={now} onAction={onMachineAction} onNew={() => open(createMachine())} />
            <SnapshotsSection
              data={data}
              now={now}
              onNewFrom={(s) => open(createMachine({ snapshot: s }))}
              onDelete={(s) => open(deleteSnapshot(s))}
            />
            <ProjectsSection />
            <ImportSection />
            <TemplatesSection data={data} onNew={(t) => open(createMachine({ template: t }))} />
            <RunCommandSection data={data} result={execResult} onRun={(id, cmd, t) => open(runCommand(id, cmd, t))} onClear={() => setExecResult(null)} />
          </>
        )}
      </div>
      <ActionDialog spec={spec} onClose={() => setSpec(null)} onRun={run} />
    </div>
  );
}

/** Sidebar badge: running InstaBox machines. */
export function useInstaboxBadge(): { count: number; label: string } | null {
  const running = useInstaboxRunning();
  return running === null || running === 0 ? null : { count: running, label: `${running} InstaBox machine${running === 1 ? "" : "s"} running` };
}
