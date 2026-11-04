// One confirmation dialog for every state-changing InstaBox action. It says
// what will happen, collects the action's fields, and only then calls the
// server. Destructive actions use a destructive button and type-the-name
// confirmation.
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type DialogField =
  | { kind: "text" | "number" | "textarea"; key: string; label: string; initial?: string; placeholder?: string; hint?: string; required?: boolean; rows?: number }
  | { kind: "select"; key: string; label: string; initial: string; options: { value: string; label: string }[]; hint?: string }
  | { kind: "checkbox"; key: string; label: string; initial: boolean; hint?: string }
  | { kind: "confirm"; key: string; label: string; expected: string; hint?: string };

export type DialogValues = Record<string, string | boolean>;

export interface DialogSpec {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  fields: DialogField[];
  run(values: DialogValues): Promise<{ message: string; hostId?: string | null }>;
}

export function initialValues(spec: DialogSpec): DialogValues {
  return Object.fromEntries(
    spec.fields.map((f) => [f.key, f.kind === "checkbox" ? f.initial : f.kind === "confirm" ? "" : f.kind === "select" ? f.initial : (f.initial ?? "")]),
  );
}

export function ActionDialog({
  spec,
  onClose,
  onRun,
}: {
  spec: DialogSpec | null;
  onClose: () => void;
  onRun: (spec: DialogSpec, values: DialogValues) => Promise<void>;
}) {
  const [values, setValues] = useState<DialogValues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValues(spec ? initialValues(spec) : {});
    setError(null);
    setBusy(false);
  }, [spec]);

  if (!spec) return null;
  const set = (key: string, value: string | boolean) => setValues((v) => ({ ...v, [key]: value }));

  const submit = async () => {
    for (const f of spec.fields) {
      const v = values[f.key];
      if (f.kind === "confirm" && String(v ?? "").trim() !== f.expected) {
        setError(`Type ${f.expected} exactly to confirm`);
        return;
      }
      if ((f.kind === "text" || f.kind === "textarea" || f.kind === "number") && f.required && String(v ?? "").trim() === "") {
        setError(`${f.label} is required`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await onRun(spec, values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{spec.description}</div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {spec.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              {f.kind !== "checkbox" ? <span>{f.label}</span> : null}
              {f.kind === "select" ? (
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={String(values[f.key] ?? f.initial)}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea
                  className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  rows={f.rows ?? 4}
                  placeholder={f.placeholder}
                  value={String(values[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : f.kind === "checkbox" ? (
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 rounded border border-input"
                    checked={Boolean(values[f.key])}
                    onChange={(e) => set(f.key, e.target.checked)}
                  />
                  {f.label}
                </span>
              ) : (
                <Input
                  type={f.kind === "number" ? "number" : "text"}
                  autoComplete="off"
                  placeholder={f.kind === "confirm" ? f.expected : f.placeholder}
                  value={String(values[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {f.hint ? <span className="text-xs text-muted-foreground">{f.hint}</span> : null}
            </label>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={spec.destructive ? "destructive" : "default"} onClick={submit} disabled={busy}>
            {busy ? "Working…" : spec.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
