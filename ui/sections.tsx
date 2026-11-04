// Presentational sections of the InstaBox page. Each takes the overview data
// and callbacks; no RPC calls happen here.
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AccountDto, ExecResultDto, MachineDto, OverviewDto, SnapshotDto, TemplateDto } from "../src/dashboard.ts";
import { ago, bytes, gib, idleText, limit, money, num, pct, specText, stateBadge, type Tone } from "./format.ts";

const TONE: Record<Tone, string> = {
  ok: "bg-secondary text-foreground",
  busy: "bg-secondary text-muted-foreground",
  idle: "text-muted-foreground",
  warn: "border border-border text-foreground",
  bad: "border border-destructive text-destructive",
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs", TONE[tone])}>
      {children}
    </span>
  );
}

export function SectionFrame({ title, count, error, right, children }: { title: string; count?: number; error?: string | null; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {title}
          {count !== undefined ? <span className="ml-1.5 text-muted-foreground">{count}</span> : null}
        </h2>
        {right}
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function AccountSection({ data }: { data: OverviewDto }) {
  const a: AccountDto | null = data.account;
  return (
    <SectionFrame title="Account" error={data.accountError}>
      {a === null ? (
        <Empty>No account data.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Plan" value={<span className="capitalize">{a.tier}</span>} detail={a.orgName} />
          <Stat label="Machines" value={`${a.machinesUsed} / ${limit(a.maxMachines)}`} detail={`${limit(a.maxRunning)} running at once`} />
          <Stat label="Snapshots" value={`${a.snapshotsUsed} / ${limit(a.maxSnapshots)}`} detail={`stored ${bytes(a.storedBytes)}`} />
          <Stat label="This month" value={money(a.costUSD)} detail={`${money(a.allowanceUSD)} allowance · ${money(a.creditRemainingUSD)} left`} />
          <Stat
            label="Running time"
            value={`${num(a.vcpuHours, 1)} vCPU-h`}
            detail={`${num(a.memGiBHours, 1)} GiB-h · ${num(a.storageGiBHours, 1)} GiB-h disk`}
          />
          <Stat label="Allocated disk" value={a.allocatedDiskGiB === null ? "—" : `${a.allocatedDiskGiB} GiB`} detail={`${num(a.egressGiB, 2)} GiB egress`} />
          <Stat label="Idle pause default" value={idleText(a.defaultIdleSeconds)} detail="new machines this plugin creates" />
          <Stat
            label="Idle choices"
            value={a.idleChoicesSeconds.length ? a.idleChoicesSeconds.map((s) => `${s / 60}m`).join(" · ") : "—"}
            detail={a.canDisableIdle ? "off is allowed on this account" : "off is not offered"}
          />
          <Stat label="Storage" value={bytes(a.storedBytes)} detail={`${bytes(a.logicalBytes)} logical`} />
          <Stat
            label="Billing period"
            value={a.periodStart ? ago(a.periodStart, Date.now()) : "—"}
            detail={a.periodEnd ? `ends ${new Date(a.periodEnd).toLocaleDateString()}` : undefined}
          />
        </div>
      )}
    </SectionFrame>
  );
}

export type MachineAction = "start" | "stop" | "suspend" | "resume" | "snapshot" | "rename" | "idle" | "delete";

function ActionButton({ icon, label, onClick, destructive, disabled }: { icon: string; label: string; onClick: () => void; destructive?: boolean; disabled?: boolean }) {
  return (
    <span title={label} className="inline-flex">
      <Button variant="ghost" size="sm" className={cn("h-7 px-1.5", destructive && "text-destructive hover:text-destructive")} onClick={onClick} disabled={disabled} aria-label={label}>
        <Icon name={icon} className="size-4" />
      </Button>
    </span>
  );
}

export function MachinesSection({
  data,
  now,
  onAction,
  onNew,
}: {
  data: OverviewDto;
  now: number;
  onAction: (action: MachineAction, machine: MachineDto) => void;
  onNew: () => void;
}) {
  const machines = data.machines.items;
  return (
    <SectionFrame
      title="Machines"
      count={machines?.length}
      error={data.machines.error}
      right={
        <Button size="sm" variant="outline" onClick={onNew}>
          <Icon name="Plus" className="size-4" />
          New machine
        </Button>
      }
    >
      {machines === null ? (
        <Empty>No machine data.</Empty>
      ) : machines.length === 0 ? (
        <Empty>No machines on this account.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Machine</th>
                <th className="px-3 py-2 font-normal">State</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">Size</th>
                <th className="px-3 py-2 font-normal">Idle pause</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">Source</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">bb machine</th>
                <th className="hidden px-3 py-2 font-normal xl:table-cell">CPU / memory</th>
                <th className="hidden px-3 py-2 font-normal xl:table-cell">Created</th>
                <th className="px-3 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {machines.map((m) => {
                const s = stateBadge(m.state);
                const running = m.state === "running";
                const paused = m.state === "suspended";
                const stopped = m.state === "stopped";
                const busy = s.tone === "busy";
                return (
                  <tr key={m.id} className="align-middle">
                    <td className="px-3 py-2">
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{m.id}</div>
                      {Object.keys(m.metadata).filter((k) => !k.startsWith("bb-") && k !== "source").length > 0 ? (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {Object.entries(m.metadata)
                            .filter(([k]) => !k.startsWith("bb-") && k !== "source")
                            .map(([k, v]) => (
                              <span key={k} className="rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground">
                                {k}={v}
                              </span>
                            ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Badge tone={s.tone}>{s.label}</Badge>
                      {m.autoSuspendedAt ? <div className="mt-0.5 text-xs text-muted-foreground">auto-paused {ago(m.autoSuspendedAt, now)}</div> : null}
                      {m.cooldownUntil ? (
                        <div className="mt-0.5">
                          <Badge tone="bad" title={`Cool-down until ${m.cooldownUntil}`}>
                            cool-down
                          </Badge>
                        </div>
                      ) : null}
                      {m.lastError ? (
                        <div className="mt-0.5 max-w-48 truncate text-xs text-destructive" title={`${m.lastError.code}: ${m.lastError.message}`}>
                          {m.lastError.code}
                        </div>
                      ) : null}
                      {paused ? <div className="mt-0.5 text-[11px] text-muted-foreground">start before stop</div> : null}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 md:table-cell">
                      <div>{specText(m.vcpus, m.memMiB)}</div>
                      <div className="text-xs text-muted-foreground">{m.diskGiB === null ? "—" : `${m.diskGiB} GiB disk`}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className={cn(m.autoSuspendAfterSeconds === null && "text-muted-foreground")}>{m.free ? "30 min (free)" : idleText(m.autoSuspendAfterSeconds)}</span>
                        {!m.free ? <ActionButton icon="Clock" label="Change idle pause" onClick={() => onAction("idle", m)} disabled={m.state === "deleting"} /> : null}
                      </div>
                    </td>
                    <td className="hidden px-3 py-2 lg:table-cell">
                      <div className="whitespace-nowrap font-mono text-xs" title={m.templateVersion ? `${m.templateId} @${m.templateVersion}` : undefined}>
                        {m.templateId ?? "—"}
                      </div>
                      {m.snapshotId ? <div className="font-mono text-xs text-muted-foreground">{m.snapshotId}</div> : null}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 lg:table-cell">
                      {m.bbMachine ? (
                        <a className="underline-offset-4 hover:underline" href={`/settings/machines/${encodeURIComponent(m.bbMachine.hostId)}`}>
                          {m.bbMachine.name} <span className="text-xs text-muted-foreground">{m.bbMachine.status}</span>
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2 xl:table-cell">
                      {running && m.metrics ? (
                        <div className="whitespace-nowrap text-xs">
                          <div>{pct(m.metrics.cpuUsedPct)} CPU</div>
                          <div className="text-muted-foreground">
                            {/* InstaBox metrics report memory in bytes (8 GiB machine: memTotal 8589934592). */}
                            {gib(m.metrics.memUsed / 1048576)} / {gib(m.metrics.memTotal / 1048576)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground xl:table-cell">{ago(m.createdAt, now)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-0.5">
                        {running ? (
                          <>
                            <ActionButton icon="Pause" label="Pause (keep memory and processes)" onClick={() => onAction("suspend", m)} disabled={busy} />
                            <ActionButton icon="Square" label="Stop (processes end; files stay)" onClick={() => onAction("stop", m)} disabled={busy} />
                          </>
                        ) : null}
                        {paused ? <ActionButton icon="Play" label="Resume" onClick={() => onAction("resume", m)} disabled={busy} /> : null}
                        {stopped || m.state === "error" ? <ActionButton icon="Play" label="Start" onClick={() => onAction("start", m)} disabled={busy} /> : null}
                        {!busy ? <ActionButton icon="Camera" label="Save snapshot" onClick={() => onAction("snapshot", m)} /> : null}
                        {!busy ? <ActionButton icon="Pencil" label="Rename and labels" onClick={() => onAction("rename", m)} /> : null}
                        {!busy && !m.bbMachine ? <ActionButton icon="Trash2" label="Delete machine" onClick={() => onAction("delete", m)} destructive /> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionFrame>
  );
}

export function SnapshotsSection({
  data,
  now,
  onNewFrom,
  onDelete,
}: {
  data: OverviewDto;
  now: number;
  onNewFrom: (snapshot: SnapshotDto) => void;
  onDelete: (snapshot: SnapshotDto) => void;
}) {
  const snaps = data.snapshots.items;
  return (
    <SectionFrame title="Snapshots" count={snaps?.length} error={data.snapshots.error}>
      {snaps === null ? (
        <Empty>No snapshot data.</Empty>
      ) : snaps.length === 0 ? (
        <Empty>No snapshots on this account.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Snapshot</th>
                <th className="px-3 py-2 font-normal">Status</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">Source machine</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">Disk</th>
                <th className="px-3 py-2 font-normal">Created</th>
                <th className="px-3 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snaps.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{s.name}</span>
                      {s.configured ? <Badge tone="ok" title="The plugin creates new machines from this snapshot">runner source</Badge> : null}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{s.id}</div>
                    {s.description ? <div className="text-xs text-muted-foreground">{s.description}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={s.status === "ready" ? "ok" : s.status === "failed" ? "bad" : "busy"}>{s.status}</Badge>
                    {s.error ? <div className="max-w-48 truncate text-xs text-destructive" title={s.error}>{s.error}</div> : null}
                  </td>
                  <td className="hidden px-3 py-2 font-mono text-xs md:table-cell">{s.sourceMachineId}</td>
                  <td className="hidden px-3 py-2 text-xs lg:table-cell">{bytes(s.dataSizeBytes ?? s.rootSizeBytes)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{ago(s.createdAt, now)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-0.5">
                      <ActionButton icon="Plus" label="New machine from this snapshot" onClick={() => onNewFrom(s)} disabled={s.status !== "ready"} />
                      <ActionButton icon="Trash2" label="Delete snapshot" onClick={() => onDelete(s)} destructive disabled={s.status === "pending"} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionFrame>
  );
}

export function TemplatesSection({ data, onNew }: { data: OverviewDto; onNew: (template: TemplateDto) => void }) {
  const templates = data.templates.items;
  return (
    <SectionFrame title="Templates" count={templates?.length} error={data.templates.error}>
      {templates === null ? (
        <Empty>No template data.</Empty>
      ) : templates.length === 0 ? (
        <Empty>No templates available to this account.</Empty>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <div key={`${t.id}@${t.version}`} className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{t.id}</span>
                    {t.default ? <Badge tone="ok">default</Badge> : null}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">{t.version}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => onNew(t)} aria-label={`New machine from ${t.id}@${t.version}`}>
                  <Icon name="Plus" className="size-4" />
                </Button>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{specText(t.vcpus, t.memMiB)}</div>
              {t.description ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.description}</div> : null}
            </div>
          ))}
        </div>
      )}
    </SectionFrame>
  );
}

export function RunCommandSection({
  data,
  result,
  onRun,
  onClear,
}: {
  data: OverviewDto;
  result: ExecResultDto | null;
  onRun: (machineId: string, cmd: string, timeoutSeconds: number) => void;
  onClear: () => void;
}) {
  const machines = data.machines.items ?? [];
  const [machineId, setMachineId] = useState("");
  const [cmd, setCmd] = useState("");
  const [timeout, setTimeoutText] = useState("60");
  const selected = machineId || machines[0]?.id || "";
  const machine = machines.find((m) => m.id === selected);
  return (
    <SectionFrame title="Run a command" error={null}>
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Runs <code className="font-mono">bash -lc</code> on the machine as its user. A paused or stopped machine is woken and billed. InstaBox API keys and org Secret
          placeholders are redacted from the output; other secrets are not detected, so don't paste it somewhere public.
        </p>
        {machines.length === 0 ? (
          <Empty>No machines to run on.</Empty>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Machine"
                className="h-9 min-w-48 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selected}
                onChange={(e) => setMachineId(e.target.value)}
              >
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.state}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                timeout
                <Input className="h-8 w-16 px-2 py-0" type="number" min={1} max={600} value={timeout} onChange={(e) => setTimeoutText(e.target.value)} />
                s
              </label>
              <Button
                size="sm"
                onClick={() => onRun(selected, cmd, Math.max(1, Math.min(600, Number(timeout) || 60)))}
                disabled={cmd.trim() === "" || !machine}
              >
                <Icon name="Terminal" className="size-4" />
                Run…
              </Button>
            </div>
            <textarea
              aria-label="Command"
              className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={'e.g. uname -a\nls -la /data/home'}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
            />
          </div>
        )}
        {result ? (
          <div className="mt-3 rounded-md border border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
              <Badge tone={result.exitCode === 0 ? "ok" : "bad"}>exit {result.exitCode}</Badge>
              <span className="text-muted-foreground">{result.machineName}</span>
              {result.timedOut ? <Badge tone="bad">timed out</Badge> : null}
              {result.truncated ? <Badge tone="warn">output truncated</Badge> : null}
              {result.woke ? <Badge tone="warn">woke the machine</Badge> : null}
              {result.redacted > 0 ? <Badge tone="warn">{result.redacted} secret{result.redacted === 1 ? "" : "s"} redacted</Badge> : null}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={onClear}>
                Clear
              </Button>
            </div>
            {result.stdout ? (
              <div>
                <div className="px-3 pt-2 text-xs text-muted-foreground">stdout</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-xs">{result.stdout}</pre>
              </div>
            ) : null}
            {result.stderr ? (
              <div>
                <div className="px-3 pt-2 text-xs text-muted-foreground">stderr</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-xs text-destructive">{result.stderr}</pre>
              </div>
            ) : null}
            {!result.stdout && !result.stderr ? <div className="px-3 py-2 text-xs text-muted-foreground">No output.</div> : null}
          </div>
        ) : null}
      </div>
    </SectionFrame>
  );
}
