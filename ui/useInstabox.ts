// Data for the InstaBox page: one overview fetch, refreshed by the server's
// "instabox-changed" signal, a slow timer (machines also change on their own:
// idle pause, operations finishing), and after every action.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DashboardRpc, IdleChoicesDto, OverviewDto } from "../src/dashboard.ts";

export const INSTABOX_CHANGED = "instabox-changed";
const REFRESH_MS = 20_000;

export function useInstaboxOverview() {
  const rpc = useRpc<DashboardRpc>();
  const [data, setData] = useState<OverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(() => {
    setLoading(true);
    rpc.call("instabox_overview", null).then(
      (o) => {
        setData(o);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(t);
  }, [refetch]);
  useRealtime(INSTABOX_CHANGED, refetch);

  return { rpc, data, error, loading, refetch };
}

/** Running-machine count for the sidebar badge. */
export function useInstaboxRunning(): number | null {
  const rpc = useRpc<DashboardRpc>();
  const [running, setRunning] = useState<number | null>(null);
  const refetch = useCallback(() => {
    rpc.call("instabox_summary", null).then((s) => setRunning(s.running), () => setRunning(null));
  }, [rpc]);
  useEffect(() => {
    refetch();
    const t = setInterval(refetch, 60_000);
    return () => clearInterval(t);
  }, [refetch]);
  useRealtime(INSTABOX_CHANGED, refetch);
  return running;
}

/** The account's idle choices, for the new-machine picker and machine inputs. */
export function useIdleChoices(): { choices: IdleChoicesDto | null; error: string | null } {
  const rpc = useRpc<DashboardRpc>();
  const [choices, setChoices] = useState<IdleChoicesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("instabox_idle_choices", null).then(
      (c) => {
        setChoices(c);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  return { choices, error };
}

/** Names of the plugin's projects (with at least one repo), for project pickers. */
export function useProjectNames(): string[] {
  const rpc = useRpc<DashboardRpc>();
  const [names, setNames] = useState<string[]>([]);
  const refetch = useCallback(() => {
    rpc.call("projects_list", null).then(
      (r) => setNames(r.projects.filter((p) => p.repos.length > 0).map((p) => p.name)),
      () => setNames([]),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(INSTABOX_CHANGED, refetch);
  return names;
}
