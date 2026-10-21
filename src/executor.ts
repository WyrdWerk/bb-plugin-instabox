// MachineExecutor over InstaBox's exec API, used by bb core's bootstrap.
//
// InstaBox runs one shell string with `bash -lc` as the machine user (HOME
// /data/home, systemd user session available), takes stdin natively (≤1 MiB) and
// returns output only when the command exits (≤600 s). So: quote argv, pass
// stdin through, and hand the whole output to onOutput once.
import type { MachineExecutor, MachineExecutorRequest } from "@get-bb/plugin-sdk";
import type { InstaboxApi } from "./instabox-api.ts";

export const MAX_COMMAND_SECONDS = 600;
export const MAX_STDIN_BYTES = 1024 * 1024;

/** POSIX single-quote each argument. */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

export class InstaboxExecutor implements MachineExecutor {
  private readonly api: InstaboxApi;
  private readonly machineId: string;

  constructor(api: InstaboxApi, machineId: string) {
    this.api = api;
    this.machineId = machineId;
  }

  async exec(req: MachineExecutorRequest): Promise<{ exitCode: number }> {
    req.signal.throwIfAborted();
    if (req.command.length === 0) throw new Error("empty command");
    if (Buffer.byteLength(req.stdin) > MAX_STDIN_BYTES) throw new Error("stdin is larger than InstaBox's 1 MiB exec limit");
    const timeoutSeconds = Math.min(MAX_COMMAND_SECONDS, Math.max(1, Math.ceil(req.timeoutMs / 1000)));
    const res = await this.api.exec(
      this.machineId,
      { cmd: shellQuote(req.command), stdin: req.stdin.length > 0 ? req.stdin : undefined, timeoutSeconds },
      req.signal,
    );
    if (res.stdout) req.onOutput(res.stdout);
    if (res.stderr) req.onOutput(res.stderr);
    if (res.timedOut) return { exitCode: 124 };
    return { exitCode: res.exitCode };
  }
}

/** Run a script (as `bash -c`) and collect its output; throws on a non-zero exit. */
export async function runScript(
  executor: MachineExecutor,
  script: string,
  signal: AbortSignal,
  opts: { stdin?: string; timeoutMs?: number; what?: string } = {},
): Promise<string> {
  let out = "";
  const { exitCode } = await executor.exec({
    command: ["bash", "-c", script],
    stdin: opts.stdin ?? "",
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal,
    onOutput: (c) => {
      out += c;
    },
  });
  if (exitCode !== 0) {
    throw new Error(`${opts.what ?? "box script"} failed (exit ${exitCode}): ${out.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  }
  return out;
}
