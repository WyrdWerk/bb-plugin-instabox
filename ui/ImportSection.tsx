// InstaBox page → Import from GitHub: tick repos from the hub's gh login to
// create them as bb projects (they then show in New thread's Project picker).
// Repos that already are bb projects (same git remote) are shown and skipped.
import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { DashboardRpc } from "../src/dashboard.ts";
import { SectionFrame } from "./sections.tsx";

type Listing = { owner: string; name: string; url: string; isPrivate: boolean; bbProject: { id: string; name: string } | null };
type Result =
  | { repo: string; status: "exists"; projectId: string; projectName: string }
  | { repo: string; status: "created"; projectId: string; path: string; checkout: "existing" | "cloned"; gitRemoteUrl: string }
  | { repo: string; status: "failed"; message: string };

export function ImportSection() {
  const rpc = useRpc<DashboardRpc>();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ status: "loading" } | { status: "ok"; checkoutDir: string; repos: Listing[] } | { status: "unavailable"; reason: string }>({ status: "loading" });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (refresh: boolean) => {
      setList({ status: "loading" });
      rpc.call("github_import_list", { refresh }).then(setList, (e: unknown) => setList({ status: "unavailable", reason: e instanceof Error ? e.message : String(e) }));
    },
    [rpc],
  );
  const start = () => {
    setPicked(new Set());
    setResults(null);
    setError(null);
    setQ("");
    setOpen(true);
    load(false);
  };
  const key = (r: Listing) => `${r.owner}/${r.name}`;
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const repos = [...picked].map((k) => ({ owner: k.split("/")[0]!, name: k.split("/")[1]! }));
      const r = await rpc.call("github_import", { repos });
      setResults(r.results);
      setPicked(new Set());
      load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = list.status === "ok" ? list.repos.filter((r) => key(r).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200) : [];

  return (
    <SectionFrame
      title="Import from GitHub"
      right={
        <Button variant="ghost" size="sm" onClick={start}>
          <Icon name="Download" className="size-4" />
          Import from GitHub
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">
        Create bb projects from GitHub repos so they show in New thread's Project picker. Each project gets a checkout on this bb server (reused when one already exists), and InstaBox runners clone it from GitHub.
      </p>
      {open ? (
        <Dialog open onOpenChange={(o) => (o ? undefined : busy ? undefined : setOpen(false))}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Import from GitHub</DialogTitle>
              <DialogDescription>
                Tick repos to create as bb projects. Repos that already are bb projects are marked and skipped.
                {list.status === "ok" ? ` Checkouts live in ${list.checkoutDir}.` : ""}
              </DialogDescription>
            </DialogHeader>
            {list.status === "loading" ? <p className="text-sm text-muted-foreground">Loading repos…</p> : null}
            {list.status === "unavailable" ? <p className="text-sm text-destructive">Repo list unavailable: {list.reason}</p> : null}
            {list.status === "ok" ? (
              <>
                <div className="flex gap-2">
                  <Input value={q} placeholder="Search repos" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
                  <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={busy} aria-label="Refresh repo list">
                    <Icon name="RefreshCw" className="size-4" />
                  </Button>
                </div>
                <ul className="max-h-72 overflow-y-auto rounded border border-border text-sm">
                  {shown.map((r) => (
                    <li key={key(r)} className="flex items-center gap-2 px-2 py-1">
                      <input type="checkbox" aria-label={`Import ${key(r)}`} disabled={r.bbProject !== null || busy} checked={picked.has(key(r))} onChange={() => toggle(key(r))} />
                      <span className={r.bbProject ? "text-muted-foreground" : ""}>
                        {key(r)}
                        {r.isPrivate ? <span className="text-xs text-muted-foreground"> (private)</span> : null}
                      </span>
                      {r.bbProject ? <span className="ml-auto text-xs text-muted-foreground">bb project: {r.bbProject.name}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {results ? (
              <ul className="space-y-1 text-xs">
                {results.map((r) => (
                  <li key={r.repo} className={r.status === "failed" ? "text-destructive" : ""}>
                    {r.repo}:{" "}
                    {r.status === "created"
                      ? `created (${r.checkout === "cloned" ? "cloned to" : "existing checkout"} ${r.path}; remote ${r.gitRemoteUrl})`
                      : r.status === "exists"
                        ? `already the bb project ${r.projectName}`
                        : r.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Close
              </Button>
              <Button onClick={run} disabled={busy || picked.size === 0}>
                {busy ? "Importing…" : `Import ${picked.size || ""}`.trim()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </SectionFrame>
  );
}
