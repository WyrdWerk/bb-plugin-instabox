// Inputs control for the InstaBox machine provider: the New Thread / machine
// picker can carry a project, a snapshot override and an idle pause. All are non-secret
// and persisted with the machine selection; the plugin settings hold the
// defaults and the API key.
import { useEffect, useRef, useState } from "react";
import type { JsonValue, PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Input } from "@/components/ui/input";
import { idleText } from "./format.ts";
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

  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-sm">
        <span>Project (optional)</span>
        <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">None</option>
          {projectNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {project !== "" && !projectNames.includes(project) ? <option value={project}>{project}</option> : null}
        </select>
        <span className="text-xs text-muted-foreground">Clones each repo of the project (Settings: InstaBox page → Projects) at its branch and registers it as a bb project source on this runner.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Snapshot id (optional)</span>
        <Input
          autoComplete="off"
          placeholder="sn_… — overrides the plugin's template/snapshot"
          value={snapshot}
          onChange={(e) => setSnapshot(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">Leave empty to use the plugin's configured template or snapshot.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Idle pause</span>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={idle}
          onChange={(e) => setIdle(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">While a bb thread is working the plugin holds an activity lease, so a busy turn is not paused.</span>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </label>
    </div>
  );
}
