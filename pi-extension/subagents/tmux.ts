/**
 * herdr surface layer — the only terminal multiplexer this fork supports.
 *
 * Local port of the upstream tmux surface. Everything the extension does to a
 * pane goes through the small API in this file: create/split a pane, type a
 * command into it, read its screen, close it, and poll for exit. Keeping the
 * herdr calls isolated here means index.ts stays untouched from upstream.
 *
 * Panes are identified by herdr pane ids (e.g. `wM:pA`). Splits target the
 * newest live subagent pane, falling back to the parent pi pane
 * (`$HERDR_PANE_ID`), so the parent keeps half the width no matter how many
 * subagents are running and pane creation never steals keyboard focus.
 *
 * herdr CLI mapping (all JSON on stdout, non-zero exit + {"error":…} on failure):
 *   split   → herdr pane split --pane <p> --direction right --no-focus
 *   type    → herdr pane send-text <p> <text> ; herdr pane send-keys <p> enter
 *   read    → herdr pane read <p> --source visible --lines <n>
 *   close   → herdr pane close <p>
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside herdr with the herdr binary on PATH.
 * HERDR_ENV/HERDR_PANE_ID are set by herdr in every pane process.
 */
export function isHerdrAvailable(): boolean {
  return (
    process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasCommand("herdr")
  );
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside herdr (`herdr`, then run `pi` in a pane).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── herdr CLI ──

/** Run a herdr subcommand and return its parsed JSON result payload. */
function herdr(args: string[]): any {
  requireHerdr();
  let stdout: string;
  try {
    stdout = execFileSync("herdr", args, { encoding: "utf8" });
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim();
    throw new Error(`herdr ${args.join(" ")} failed: ${out || e?.message || "unknown error"}`);
  }
  return parseHerdrJson(stdout, args);
}

function parseHerdrJson(stdout: string, args: string[]): any {
  const trimmed = stdout.trim();
  if (trimmed === "") return {};
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
  if (parsed?.error) {
    throw new Error(`herdr ${args.join(" ")} failed: ${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed.result ?? parsed;
}

export const __herdrTest__ = { parseHerdrJson };

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * Newest live subagent pane, used as the split source so the parent pi pane is
 * only ever halved once. herdr has no named-layout command (no tmux
 * `select-layout` equivalent), so chaining splits off the previous subagent is
 * what keeps the parent readable.
 *
 * ponytail: chained splits, so the Nth subagent pane is half the width of the
 * (N-1)th. Switch to explicit `herdr pane resize` passes if you routinely run
 * more than ~3 subagents at once.
 */
let lastSubagentSurface: string | undefined;

function splitSource(explicit?: string): string {
  if (explicit) return explicit;
  if (lastSubagentSurface && surfaceExists(lastSubagentSurface)) {
    return lastSubagentSurface;
  }
  const parent = process.env.HERDR_PANE_ID;
  if (!parent) {
    throw new Error("HERDR_PANE_ID is not set — cannot locate the parent pane to split.");
  }
  return parent;
}

/** True when the pane still exists; a closed pane makes `pane get` fail. */
function surfaceExists(surface: string): boolean {
  try {
    herdr(["pane", "get", surface]);
    return true;
  } catch {
    return false;
  }
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split that does not take focus.
 * Returns the new pane id (e.g. `wM:pA`).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right");
}

/**
 * Create a new split in the given direction from an optional source pane.
 * herdr only splits `right` or `down`; `left`/`up` map onto those (herdr has no
 * before-split flag), which only affects placement, not behaviour.
 * Returns the new pane id.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const source = splitSource(fromSurface);
  const herdrDirection = direction === "up" || direction === "down" ? "down" : "right";

  const result = herdr([
    "pane",
    "split",
    "--pane",
    source,
    "--direction",
    herdrDirection,
    "--no-focus",
  ]);
  const pane = result?.pane?.pane_id;
  if (typeof pane !== "string" || pane === "") {
    throw new Error(`Unexpected herdr pane split output: ${JSON.stringify(result).slice(0, 200)}`);
  }

  // herdr panes carry a label — unlike tmux, so show the subagent's name.
  if (name) {
    try {
      herdr(["pane", "rename", pane, name]);
    } catch {
      // Cosmetic; never fail a spawn over a label.
    }
  }

  lastSubagentSurface = pane;
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`send-text`) so special characters are not interpreted as
 * keys, then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  herdr(["pane", "send-text", surface, command]);
  herdr(["pane", "send-keys", surface, "enter"]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 * `--source visible` is the herdr equivalent of `tmux capture-pane -p`; the
 * `recent` source can come back empty for a freshly split pane.
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    "herdr",
    ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  herdr(["pane", "close", surface]);
  if (lastSubagentSurface === surface) {
    lastSubagentSurface = undefined;
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
