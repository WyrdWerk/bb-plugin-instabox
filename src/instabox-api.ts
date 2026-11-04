// Minimal InstaBox REST client (https://instabox.sh/docs/api).
//
// Only the calls this plugin needs. The API key goes in X-API-Key and is never
// logged. Mutations carry an Idempotency-Key; exec and activity leases do not
// (the API says they are not idempotent and takes no key for them).

export const DEFAULT_API_URL = "https://api.instabox.sh";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
  operationId?: string | null;
  retryAfterSeconds?: number;
  hint?: string;
  docs_url?: string;
}

export interface MachineSpec {
  vcpus: number;
  memMiB: number;
  persistentDiskGiB: number;
  rootDiskGiB?: number;
}

export interface Machine {
  id: string;
  name: string;
  state: string;
  desiredState?: string;
  operationId: string | null;
  revision?: number;
  runtime?: { ready?: boolean; processesPreserved?: boolean };
  metadata?: Record<string, string>;
  guestUser?: string;
  orgId?: string;
  free?: boolean;
  autoSuspendAfterSeconds?: number | null;
  autoSuspendedAt?: string | null;
  maxRunMinutes?: number | null;
  runStartedAt?: string | null;
  archiveAt?: string | null;
  deleteAt?: string | null;
  cooldownUntil?: string | null;
  createdAt?: string;
  updatedAt?: string;
  spec?: MachineSpec;
  storage?: { mountPath?: string; persistent?: boolean; sizeGiB?: number; snapshotSeq?: number; synced?: boolean };
  template?: { id: string; version: string; digest: string; kernel?: string };
  snapshot?: { id: string } | null;
  lastError?: ApiErrorBody | null;
  vault?: boolean;
}

export interface Operation {
  id: string;
  machineId: string | null;
  type: string;
  state: string;
  error: { code?: string; message?: string } | null;
}

export interface Snapshot {
  id: string;
  name: string;
  status: "pending" | "ready" | "failed";
  sourceMachineId: string;
  sourceSnapshotSeq?: number;
  orgId?: string;
  createdAt: string;
  dataSizeBytes?: number | null;
  rootSizeBytes?: number | null;
  description?: string | null;
  error?: string | null;
  guestUser?: string;
  template?: { id: string; version: string; digest: string };
  visibility?: "private" | "community" | "official" | null;
}

export interface Template {
  id: string;
  version: string;
  digest: string;
  description?: string;
  arch?: string;
  defaultSpec?: MachineSpec;
  capabilities?: string[];
  creatable?: boolean;
  hidden?: boolean;
  default?: boolean;
  latest?: boolean;
  runtime?: Record<string, string>;
}

export interface Me {
  userId?: number;
  login: string;
  email?: string;
  activated?: boolean;
  manualLifecycle?: boolean;
  alwaysOnAllowed?: boolean;
  machineMetrics?: boolean;
  idleChoicesSeconds?: number[];
  fixedAutoSuspendSeconds?: number;
  allowedSpecs?: MachineSpec[];
  plans?: { tier: string; monthlyFeeUSD: number; maxMachines: number; maxRunning: number; maxVCPUs: number; maxDiskGiB: number }[];
  org?: { id: string; name: string; tier: string; kind: string };
  orgId?: string;
  csrfToken?: string;
}

export interface UsageLimits {
  maxMachines: number;
  maxSnapshots: number;
  maxStoredGiB: number;
  maxImages?: number;
  unlimited?: string[] | null;
  liveSnapshots?: boolean;
  machineSpec?: MachineSpec;
  machineSpecs?: MachineSpec[];
  orgSecrets?: boolean;
  vault?: { maxItems?: number; maxBytes?: number };
}

export interface OrgUsage {
  periodStart: string;
  periodEnd: string;
  machines: number;
  freeMachines: number;
  freeSandboxHours: number;
  snapshots: number;
  vcpuHours: number;
  memGiBHours: number;
  storageGiBHours: number;
  egressGiB: number;
  runtimeUSD: number;
  vcpuUSD: number;
  memUSD: number;
  storageUSD: number;
  egressUSD: number;
  costUSD: number;
  allowanceUSD: number;
  creditRemainingUSD: number;
  overageUSD: number;
  remainingUSD: number;
  ratedUntil: string;
  billableDiskGiB: number;
  allocatedDiskGiB: number;
  includedDiskGiB?: number;
  freeDiskGiBPerSandbox?: number;
  creditsUSD?: number;
  creditsUsedUSD?: number;
  creditsExpireAt?: string;
}

export interface Usage {
  computedAt: string | null;
  logicalBytes: number;
  storedBytes: number;
  machines: number;
  snapshots: number;
  allocatedDiskGiB?: number;
  limits: UsageLimits;
  cost?: OrgUsage;
  org?: { id: string; name: string; tier: string; kind: string };
}

export interface MachineMetric {
  timestamp: string;
  cpuUsedPct: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  diskTotal: number;
  diskUsed?: number;
  netInBytesPerSec?: number;
  netOutBytesPerSec?: number;
  diskReadBytesPerSec?: number;
  diskWriteBytesPerSec?: number;
}

export interface MachineMetrics {
  metrics: MachineMetric[];
  disk?: { measuredAt: string; filesystems: { mountPath?: string; sizeBytes?: number; usedBytes?: number }[] };
}

export interface ActivityLease {
  id: string;
  machineId: string;
  expiresAt: string;
}

/** "all" includes current and future proxy Secrets; an array names them explicitly. */
export type SecretSelection = "all" | string[];

export interface OrgSecret {
  id: string;
  orgId: string;
  name: string;
  delivery: "proxy" | "env";
  hosts?: string[];
  version: number;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface MachineSecrets {
  secrets: SecretSelection;
  envSecrets: string[];
  directSecrets: unknown[];
  items: OrgSecret[];
  version: number;
  guest?: { state: "inactive" | "pending" | "applied" | "error"; revision?: number; appliedRevision?: number; error?: string };
  proxy?: { state: "inactive" | "pending" | "applied" | "expired" | "error"; revision?: number; appliedRevision?: number; expiresAt?: string };
}

/** POST /connections answer: the gateway and a short-lived user certificate. */
export interface SshConnection {
  host: string;
  port: number;
  username: string;
  certificate: string;
  expiresAt: string;
  hostTrust: { type: string; publicKey: string };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  invalidUtf8?: boolean;
  oomKilled?: boolean;
}

export class InstaboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly operationId: string | null;
  constructor(status: number, code: string, message: string, retryable: boolean, requestId: string | null = null, operationId: string | null = null) {
    super(`InstaBox API ${status} ${code}: ${message}`);
    this.name = "InstaboxApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
    this.operationId = operationId;
  }
}

export const isNotFound = (err: unknown) => err instanceof InstaboxApiError && err.status === 404;

const RUNNING = "running";
export const SUSPENDED_STATES = new Set(["suspended"]);
export const STOPPED_STATES = new Set(["stopped"]);
export const TRANSITIONAL_STATES = new Set(["creating", "starting", "stopping", "suspending", "resuming", "deleting"]);

export interface RequestOptions {
  /** null: this call takes no key (exec, activity leases). */
  idempotencyKey?: string | null;
  signal?: AbortSignal;
  /** X-Confirm-Delete: the resource id or exact name. */
  confirmDelete?: string;
}

export class InstaboxApi {
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(apiKey: string, fetchImpl: FetchLike, baseUrl = DEFAULT_API_URL, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.sleep = sleep;
  }

  /**
   * One call. Only 429 / `retryable` errors are retried (bounded): those are
   * refused before running. Mutations always carry an Idempotency-Key unless
   * the route takes none, so the retry of a mutation is a replay, not a second
   * action.
   */
  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { "X-API-Key": this.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && opts.idempotencyKey !== null) headers["Idempotency-Key"] = opts.idempotencyKey ?? `bb-${crypto.randomUUID()}`;
    if (opts.confirmDelete !== undefined) headers["X-Confirm-Delete"] = opts.confirmDelete;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opts.signal,
      });
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (res.ok) return json as T;
      const e = (json as { error?: ApiErrorBody } | null)?.error;
      const err = new InstaboxApiError(
        res.status,
        e?.code ?? "http_error",
        e?.message ?? text.slice(0, 200),
        e?.retryable ?? res.status === 429,
        e?.requestId ?? null,
        e?.operationId ?? null,
      );
      if ((err.retryable || res.status === 429) && attempt < 5) {
        const wait = e?.retryAfterSeconds ? e.retryAfterSeconds * 1000 : 2000 * (attempt + 1);
        await this.sleep(wait);
        continue;
      }
      throw err;
    }
  }

  getMachine(id: string, signal?: AbortSignal) {
    return this.request<Machine>("GET", `/v1/machines/${enc(id)}`, undefined, { signal });
  }

  /** null when the machine does not exist. */
  async findMachine(id: string, signal?: AbortSignal): Promise<Machine | null> {
    try {
      return await this.getMachine(id, signal);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Every machine in the org, following nextCursor (limit 100 per page). */
  async listAllMachines(signal?: AbortSignal): Promise<Machine[]> {
    const out: Machine[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 10; n++) {
      const q: string = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: { machines: Machine[]; nextCursor: string | null } = await this.request<{ machines: Machine[]; nextCursor: string | null }>("GET", `/v1/machines?${q}`, undefined, { signal });
      out.push(...res.machines);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async listMachines(metadata: Record<string, string>, signal?: AbortSignal): Promise<Machine[]> {
    const q = Object.entries(metadata).map(([k, v]) => `metadata=${encodeURIComponent(`${k}:${v}`)}`).join("&");
    const out: Machine[] = [];
    let cursor: string | null = null;
    do {
      const page: { machines: Machine[]; nextCursor: string | null } = await this.request("GET", `/v1/machines?${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, { signal });
      out.push(...page.machines);
      cursor = page.nextCursor;
    } while (cursor);
    // Filter again locally: never act on a machine that lacks our labels.
    return out.filter((m) => Object.entries(metadata).every(([k, v]) => m.metadata?.[k] === v));
  }

  me(signal?: AbortSignal) {
    return this.request<Me>("GET", "/v1/me", undefined, { signal });
  }

  usage(signal?: AbortSignal) {
    return this.request<Usage>("GET", "/v1/usage", undefined, { signal });
  }

  async listSnapshots(signal?: AbortSignal): Promise<Snapshot[]> {
    const res = await this.request<{ snapshots: Snapshot[] }>("GET", "/v1/snapshots", undefined, { signal });
    return res.snapshots;
  }

  async listTemplates(signal?: AbortSignal): Promise<Template[]> {
    const res = await this.request<{ templates: Template[] }>("GET", "/v1/templates", undefined, { signal });
    return res.templates;
  }

  metrics(id: string, since?: string, signal?: AbortSignal) {
    const q = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<MachineMetrics>("GET", `/v1/machines/${enc(id)}/metrics${q}`, undefined, { signal });
  }

  /** 202: an operation; with the same Idempotency-Key the same operation comes back. */
  createMachine(
    body: {
      name: string;
      templateId?: string;
      snapshotId?: string;
      metadata: Record<string, string>;
      autoSuspendAfterSeconds?: number;
      /** Proxy Secrets from the org; "all" covers current and future ones. */
      secrets?: SecretSelection;
      vcpus?: number;
      memMiB?: number;
    },
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.request<Operation>("POST", "/v1/machines", body, { idempotencyKey, signal });
  }

  /** Sync 200. Rename, labels and the idle pause. */
  updateMachine(id: string, body: { name?: string; metadata?: Record<string, string> | null; autoSuspendAfterSeconds?: number }, idempotencyKey: string, signal?: AbortSignal) {
    return this.request<Machine>("PATCH", `/v1/machines/${enc(id)}`, body, { idempotencyKey, signal });
  }

  /** Proxy Secret selection and delivery status. Metadata only; never values. */
  getSecrets(id: string, signal?: AbortSignal) {
    return this.request<MachineSecrets>("GET", `/v1/machines/${enc(id)}/secrets`, undefined, { signal });
  }

  /** Select (or clear) Secrets. Reconciliation is background; POST to refresh a running machine. */
  updateSecrets(id: string, body: { secrets?: SecretSelection; envSecrets?: string[] }, signal?: AbortSignal) {
    return this.request<MachineSecrets>("PATCH", `/v1/machines/${enc(id)}/secrets`, body, { signal, idempotencyKey: null });
  }

  /** Re-install env values, proxy placeholders and the public CA in a running machine. */
  pushSecrets(id: string, signal?: AbortSignal) {
    return this.request<MachineSecrets>("POST", `/v1/machines/${enc(id)}/secrets`, undefined, { signal, idempotencyKey: null });
  }

  lifecycle(id: string, action: "start" | "stop" | "suspend" | "resume", signal?: AbortSignal, idempotencyKey?: string) {
    return this.request<Operation>("POST", `/v1/machines/${enc(id)}/${action}`, {}, { signal, idempotencyKey });
  }

  deleteMachine(id: string, signal?: AbortSignal, opts: { idempotencyKey?: string; confirm?: string } = {}) {
    return this.request<Operation | null>("DELETE", `/v1/machines/${enc(id)}`, undefined, {
      signal,
      idempotencyKey: opts.idempotencyKey,
      confirmDelete: opts.confirm,
    });
  }

  getOperation(id: string, signal?: AbortSignal) {
    return this.request<Operation>("GET", `/v1/operations/${enc(id)}`, undefined, { signal });
  }

  createSnapshot(machineId: string, body: { name: string; description?: string; rootOnly?: boolean }, idempotencyKey: string, signal?: AbortSignal) {
    return this.request<Snapshot>("POST", `/v1/machines/${enc(machineId)}/snapshots`, body, { idempotencyKey, signal });
  }

  async deleteSnapshot(id: string, confirm: string, idempotencyKey: string, signal?: AbortSignal): Promise<void> {
    await this.request<null>("DELETE", `/v1/snapshots/${enc(id)}`, undefined, { idempotencyKey, signal, confirmDelete: confirm });
  }

  /** Runs with `bash -lc` as the machine's user; output only at exit; ≤600 s; stdin ≤1 MiB. */
  exec(id: string, req: { cmd: string; stdin?: string; timeoutSeconds: number; cwd?: string }, signal?: AbortSignal) {
    return this.request<ExecResult>("POST", `/v1/machines/${enc(id)}/exec`, req, { signal, idempotencyKey: null });
  }

  /** Keep a machine awake while a bb thread works. Wakes a paused machine; no Idempotency-Key. */
  putActivityLease(id: string, leaseId: string, ttlSeconds: number, signal?: AbortSignal) {
    return this.request<ActivityLease>("PUT", `/v1/machines/${enc(id)}/activity-leases/${enc(leaseId)}`, { ttlSeconds }, { signal, idempotencyKey: null });
  }

  /** Idempotent: 204 whether the lease existed or not. No Idempotency-Key. */
  async deleteActivityLease(id: string, leaseId: string, signal?: AbortSignal): Promise<void> {
    await this.request<null>("DELETE", `/v1/machines/${enc(id)}/activity-leases/${enc(leaseId)}`, undefined, { signal, idempotencyKey: null });
  }

  sshConnection(id: string, publicKey: string, ttlSeconds: number, signal?: AbortSignal) {
    return this.request<SshConnection>("POST", `/v1/machines/${enc(id)}/connections`, { publicKey, ttlSeconds }, { signal });
  }
}

export const isRunning = (m: Machine) => m.state === RUNNING && m.runtime?.ready !== false;

function enc(s: string) {
  return encodeURIComponent(s);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "bad_json", message: text.slice(0, 200) } };
  }
}
