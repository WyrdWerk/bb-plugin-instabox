// Minimal InstaBox REST client (https://instabox.sh/docs/api). Only the calls the
// provider needs. The API key goes in X-API-Key and is never logged.

export const DEFAULT_API_URL = "https://api.instabox.sh";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Machine {
  id: string;
  name: string;
  state: string;
  operationId: string | null;
  runtime?: { ready?: boolean };
  metadata?: Record<string, string>;
  guestUser?: string;
  autoSuspendAfterSeconds?: number | null;
}

export interface Operation {
  id: string;
  machineId: string | null;
  type: string;
  state: string;
  error: { code?: string; message?: string } | null;
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
}

export class InstaboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(`InstaBox API ${status} ${code}: ${message}`);
    this.name = "InstaboxApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export const isNotFound = (err: unknown) => err instanceof InstaboxApiError && err.status === 404;

const RUNNING = "running";
export const SUSPENDED_STATES = new Set(["suspended"]);
export const STOPPED_STATES = new Set(["stopped"]);
export const TRANSITIONAL_STATES = new Set(["creating", "starting", "stopping", "suspending", "resuming"]);

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
   * refused before running. Mutations always carry an Idempotency-Key, so the
   * retry of a mutation is a replay, not a second action.
   */
  async request<T>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { "X-API-Key": this.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["Idempotency-Key"] = opts.idempotencyKey ?? `bb-${crypto.randomUUID()}`;
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
      const e = (json as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
      const err = new InstaboxApiError(res.status, e?.code ?? "http_error", e?.message ?? text.slice(0, 200), e?.retryable ?? res.status === 429);
      if ((err.retryable || res.status === 429) && attempt < 5) {
        await this.sleep(2000 * (attempt + 1));
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

  /** 202: an operation; with the same Idempotency-Key the same operation comes back. */
  createMachine(body: { name: string; templateId?: string; snapshotId?: string; metadata: Record<string, string> }, idempotencyKey: string, signal?: AbortSignal) {
    return this.request<Operation>("POST", "/v1/machines", body, { idempotencyKey, signal });
  }

  lifecycle(id: string, action: "start" | "stop" | "suspend" | "resume", signal?: AbortSignal) {
    return this.request<Operation>("POST", `/v1/machines/${enc(id)}/${action}`, {}, { signal });
  }

  deleteMachine(id: string, signal?: AbortSignal) {
    return this.request<Operation | null>("DELETE", `/v1/machines/${enc(id)}`, undefined, { signal });
  }

  getOperation(id: string, signal?: AbortSignal) {
    return this.request<Operation>("GET", `/v1/operations/${enc(id)}`, undefined, { signal });
  }

  /** Runs with `bash -lc` as the machine's user; output only at exit; ≤600 s; stdin ≤1 MiB. */
  exec(id: string, req: { cmd: string; stdin?: string; timeoutSeconds: number; cwd?: string }, signal?: AbortSignal) {
    return this.request<ExecResult>("POST", `/v1/machines/${enc(id)}/exec`, req, { signal });
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
