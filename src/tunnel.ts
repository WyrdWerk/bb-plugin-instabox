// Hub side of the box → hub route, without Tailscale or a relay.
//
// InstaBox's SSH gateway allows local forwarding (-L) but not remote (-R). So per
// machine the hub runs:
//   ssh -N -L 127.0.0.1:<local>:127.0.0.1:9000 <machine>@<gateway>   (API-issued cert)
//   chisel client http://127.0.0.1:<local> R:127.0.0.1:<boxHubPort>:127.0.0.1:<hubPort>
// and the chisel server on the box (box-scripts.ts) opens <boxHubPort> on the box's
// loopback, carried back to the hub. The bb daemon on the box talks to
// http://127.0.0.1:<boxHubPort> (bb's direct machine access).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CHISEL, BOX_CHISEL_PORT } from "./box-scripts.ts";
import type { InstaboxApi } from "./instabox-api.ts";

/** Gateway certificates: the API allows up to 24 h; renew when less than this is left. */
export const CERT_TTL_SECONDS = 24 * 3600;
const RENEW_BEFORE_MS = 60 * 60_000;

export interface TunnelOptions {
  /** Plugin-private directory for the SSH key, certificates and the chisel binary. */
  dir: string;
  /** Local port of this bb server. */
  hubPort: () => number;
  /** Port the box's bb daemon uses on its own loopback. */
  boxHubPort: number;
  log: (m: string) => void;
  fetch: typeof fetch;
  /** Per-machine chisel credential (`user:pass`), created once and kept by the caller. */
  auth: (machineId: string) => Promise<string>;
}

interface Tunnel {
  ssh: ChildProcess | null;
  chisel: ChildProcess | null;
  certExpiresAt: number;
  localPort: number;
  stopping: boolean;
}

export class TunnelManager {
  private readonly o: TunnelOptions;
  private readonly tunnels = new Map<string, Tunnel>();
  private chiselPath: Promise<string> | null = null;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(o: TunnelOptions) {
    this.o = o;
    mkdirSync(join(o.dir, "ssh"), { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
  }

  /** Random `user:pass` for a new machine's chisel server. */
  static newAuth(): string {
    return `bb:${randomBytes(24).toString("base64url")}`;
  }

  /** Both processes running and the certificate not about to expire. */
  healthy(machineId: string): boolean {
    const t = this.tunnels.get(machineId);
    return !!t && alive(t.ssh) && alive(t.chisel) && t.certExpiresAt - Date.now() > RENEW_BEFORE_MS;
  }

  active(): string[] {
    return [...this.tunnels.keys()];
  }

  /** Start (or repair) the tunnel for a running machine. Idempotent; one at a time per machine. */
  ensure(api: InstaboxApi, machineId: string, signal?: AbortSignal): Promise<void> {
    if (this.healthy(machineId)) return Promise.resolve();
    const running = this.pending.get(machineId);
    if (running) return running;
    const p = this.open(api, machineId, signal).finally(() => this.pending.delete(machineId));
    this.pending.set(machineId, p);
    return p;
  }

  private async open(api: InstaboxApi, machineId: string, signal?: AbortSignal): Promise<void> {
    const prev = this.tunnels.get(machineId);
    if (prev) this.kill(machineId);
    const chisel = await this.chisel();
    const key = this.keyPair();
    const conn = await api.sshConnection(machineId, key.publicKey, CERT_TTL_SECONDS, signal);
    const base = join(this.o.dir, "ssh", safe(machineId));
    writePrivate(`${base}-cert.pub`, `${conn.certificate.trim()}\n`);
    writePrivate(`${base}.known_hosts`, `@cert-authority [${conn.host}]:${conn.port} ${conn.hostTrust.publicKey.trim()}\n`);
    const localPort = prev?.localPort ?? (await freePort());
    const t: Tunnel = { ssh: null, chisel: null, certExpiresAt: Date.parse(conn.expiresAt) || Date.now() + CERT_TTL_SECONDS * 1000, localPort, stopping: false };
    this.tunnels.set(machineId, t);
    t.ssh = this.spawn(machineId, "ssh", "ssh", [
      "-N",
      "-p", String(conn.port),
      "-i", key.path,
      "-o", `CertificateFile=${base}-cert.pub`,
      "-o", `UserKnownHostsFile=${base}.known_hosts`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-F", "/dev/null",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${BOX_CHISEL_PORT}`,
      `${conn.username}@${conn.host}`,
    ], {});
    await waitForPort(localPort, 20_000);
    // AUTH via the environment, not argv (argv is visible in ps).
    t.chisel = this.spawn(machineId, "chisel", chisel, [
      "client",
      "--keepalive", "25s",
      "--max-retry-interval", "10s",
      `http://127.0.0.1:${localPort}`,
      `R:127.0.0.1:${this.o.boxHubPort}:127.0.0.1:${this.o.hubPort()}`,
    ], { AUTH: await this.o.auth(machineId) });
    this.o.log(`tunnel ${machineId}: ssh -L ${localPort} → box:${BOX_CHISEL_PORT}, reverse box:${this.o.boxHubPort} → hub:${this.o.hubPort()}`);
  }

  /** Stop the tunnel (suspend/remove). Keeps nothing running for the machine. */
  stop(machineId: string, forget = false): void {
    this.kill(machineId);
    this.tunnels.delete(machineId);
    if (forget) {
      const base = join(this.o.dir, "ssh", safe(machineId));
      rmSync(`${base}-cert.pub`, { force: true });
      rmSync(`${base}.known_hosts`, { force: true });
    }
  }

  stopAll(): void {
    for (const id of this.active()) this.stop(id);
  }

  private kill(machineId: string) {
    const t = this.tunnels.get(machineId);
    if (!t) return;
    t.stopping = true;
    t.chisel?.kill("SIGTERM");
    t.ssh?.kill("SIGTERM");
  }

  private spawn(machineId: string, what: string, cmd: string, args: string[], env: Record<string, string>): ChildProcess {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...env } });
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-600);
    });
    child.on("exit", (code, sig) => {
      const t = this.tunnels.get(machineId);
      if (t && !t.stopping) this.o.log(`tunnel ${machineId}: ${what} exited (${sig ?? code}); last output: ${redact(tail.trim().split("\n").slice(-2).join(" | "))}`);
    });
    return child;
  }

  /** One Ed25519 key for this hub (ssh-keygen); certificates are per machine. */
  private keyPair(): { path: string; publicKey: string } {
    const path = join(this.o.dir, "ssh", "id_ed25519");
    if (!existsSync(path) || !existsSync(`${path}.pub`)) {
      rmSync(path, { force: true });
      rmSync(`${path}.pub`, { force: true });
      const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "bb-plugin-instabox", "-f", path], { stdio: "ignore" });
      if (r.status !== 0) throw new Error("ssh-keygen failed (is OpenSSH installed on the bb server?)");
    }
    return { path, publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
  }

  /** The pinned chisel binary in the plugin directory, downloaded and verified once. */
  private chisel(): Promise<string> {
    this.chiselPath ??= (async () => {
      const path = join(this.o.dir, `chisel-${CHISEL.version}`);
      if (existsSync(path) && sha256(readFileSync(path)) === CHISEL.sha256) return path;
      const res = await this.o.fetch(CHISEL.url);
      if (!res.ok) throw new Error(`chisel download failed: HTTP ${res.status}`);
      const bin = gunzipSync(Buffer.from(await res.arrayBuffer()));
      if (sha256(bin) !== CHISEL.sha256) throw new Error("chisel download failed its checksum");
      writeFileSync(`${path}.tmp`, bin, { mode: 0o700 });
      renameSync(`${path}.tmp`, path);
      return path;
    })().catch((err) => {
      this.chiselPath = null;
      throw err;
    });
    return this.chiselPath;
  }
}

function alive(p: ChildProcess | null): boolean {
  return !!p && p.exitCode === null && p.signalCode === null;
}

function sha256(b: Buffer) {
  return createHash("sha256").update(b).digest("hex");
}

function safe(id: string) {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function writePrivate(path: string, content: string) {
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function redact(s: string) {
  return s.replace(/bb:[A-Za-z0-9_-]{8,}/g, "bb:<redacted>");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

async function waitForPort(port: number, maxMs: number): Promise<void> {
  const { connect } = await import("node:net");
  const until = Date.now() + maxMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = connect(port, "127.0.0.1");
      c.once("connect", () => (c.destroy(), resolve(true)));
      c.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error(`SSH forward to the box did not open within ${Math.round(maxMs / 1000)} s`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
