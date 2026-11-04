// Inputs control for the InstaBox machine provider: the New Thread / machine
// picker can carry a project, a snapshot override and an idle pause. All are non-secret
// and persisted with the machine selection; the plugin settings hold the
// defaults and the API key.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { JsonValue, PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Input } from "@/components/ui/input";
import { idleText } from "./format.ts";
import { NoProjectsHint } from "./NoProjectsHint.tsx";
import { useIdleChoices, useProjectNames } from "./useInstabox.ts";

export function InstaboxMachineInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const { choices, error } = useIdleChoices();
  const v = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const [snapshot, setSnapshot] = useState(typeof v.snapshotId === "string" ? v.snapshotId : "");
  const [idle, setIdle] = useState(typeof v.autoSuspendAfterSeconds === "number" ? String(v.autoSuspendAfterSeconds) : "");
  const [project, setProject] = useState(typeof v.project === "string" ? v.project : "");
  const projectNames = useProjectNames();
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    const next: Record<string, unknown> = {};
    const s = snapshot.trim();
    if (s !== "") next.snapshotId = s;
    if (idle !== "") next.autoSuspendAfterSeconds = Number(idle);
    if (project !== "") next.project = project;
    change.current({ status: "ready", value: next as JsonValue });
  }, [snapshot, idle, project]);

  const options = [
    { value: "", label: `Plugin default${choices?.defaultSeconds != null ? ` (${idleText(choices.defaultSeconds)})` : ""}` },
    ...(choices?.choices ?? []).map((s) => ({ value: String(s), label: idleText(s) })),
    ...(choices?.canDisable ? [{ value: "0", label: "Off (never pause)" }] : []),
  ];

  // bb shows these inline in the New Thread toolbar, next to the project and
  // environment pickers, so they sit behind one small trigger like bb's own
  // pickers and open as a panel.
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const idleLabel = options.find((o) => o.value === idle)?.label ?? "";
  const summary = [project !== "" ? project : "no repos", snapshot.trim() !== "" ? "snapshot" : null, idle !== "" ? idleLabel : null].filter(Boolean).join(" · ");
  const select = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="flex h-8 max-w-56 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-expanded={open}
        title="InstaBox runner options: repos to clone, snapshot, idle pause"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">Repos: {summary}</span>
        <Icon name="ChevronDown" className="size-3.5 shrink-0" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-80 space-y-3 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
          <label className="flex flex-col gap-1">
            <span>Repos (InstaBox project)</span>
            <select className={select} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">None</option>
              {projectNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              {project !== "" && !projectNames.includes(project) ? <option value={project}>{project}</option> : null}
            </select>
            {projectNames.length === 0 ? (
              <NoProjectsHint link />
            ) : (
              <span className="text-xs text-muted-foreground">Clones each repo of the project (InstaBox page → Projects) at its branch into ~/workspace/repos and registers it as a bb project source on the new runner.</span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span>Snapshot id (optional)</span>
            <Input className="h-8" autoComplete="off" placeholder="sn_… (empty: the plugin's default)" value={snapshot} onChange={(e) => setSnapshot(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span>Idle pause</span>
            <select className={select} value={idle} onChange={(e) => setIdle(e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">While a bb thread is working the plugin holds an activity lease, so a busy turn is not paused.</span>
          </label>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
