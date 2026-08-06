/**
 * ACP client-side terminal/* implementation.
 * Agents request shell commands when the client advertises terminal: true.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * @typedef {object} ManagedTerminal
 * @property {string} id
 * @property {import('node:child_process').ChildProcess} proc
 * @property {string} output
 * @property {boolean} truncated
 * @property {number|null} outputByteLimit
 * @property {{ exitCode: number|null, signal: string|null }|null} exitStatus
 * @property {Promise<{ exitCode: number|null, signal: string|null }>} exitPromise
 * @property {boolean} released
 */

export class TerminalManager {
  constructor() {
    /** @type {Map<string, ManagedTerminal>} */
    this.terminals = new Map();
  }

  /**
   * @param {object} params CreateTerminalRequest
   * @returns {{ terminalId: string }}
   */
  create(params = {}) {
    const terminalId = randomUUID();
    const command = params.command;
    if (!command || typeof command !== "string") {
      throw Object.assign(new Error("terminal/create requires command"), {
        code: -32602,
      });
    }
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const cwd =
      typeof params.cwd === "string" && params.cwd
        ? params.cwd
        : process.cwd();
    const env = { ...process.env };
    for (const e of params.env || []) {
      if (e && typeof e.name === "string") {
        env[e.name] = e.value == null ? "" : String(e.value);
      }
    }
    const outputByteLimit =
      params.outputByteLimit == null ? null : Number(params.outputByteLimit);

    // Grok often sends a full shell string as `command` with empty args
    // (e.g. `/bin/bash -lc 'echo hi'`). Use shell only when args are empty
    // and the command looks like a shell invocation line.
    const useShell =
      args.length === 0 &&
      (/[\s|&;<>$`"']/.test(command) || command.includes("/bin/bash"));

    const proc = spawn(command, args, {
      cwd,
      env,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    /** @type {ManagedTerminal} */
    const term = {
      id: terminalId,
      proc,
      output: "",
      truncated: false,
      outputByteLimit:
        Number.isFinite(outputByteLimit) && outputByteLimit >= 0
          ? outputByteLimit
          : null,
      exitStatus: null,
      released: false,
      exitPromise: null,
    };

    const append = (chunk) => {
      if (term.released) return;
      const s = chunk.toString("utf8");
      term.output += s;
      if (
        term.outputByteLimit != null &&
        Buffer.byteLength(term.output, "utf8") > term.outputByteLimit
      ) {
        // Truncate from the beginning at a character boundary
        let buf = Buffer.from(term.output, "utf8");
        buf = buf.subarray(buf.length - term.outputByteLimit);
        // walk forward to next char boundary if mid-sequence
        let i = 0;
        while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
        term.output = buf.subarray(i).toString("utf8");
        term.truncated = true;
      }
    };

    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    term.exitPromise = new Promise((resolve) => {
      const finish = (code, signal) => {
        if (term.exitStatus) {
          resolve(term.exitStatus);
          return;
        }
        term.exitStatus = {
          exitCode: typeof code === "number" ? code : null,
          signal: signal ? String(signal) : null,
        };
        resolve(term.exitStatus);
      };
      proc.on("error", (err) => {
        append(`\n[spawn error] ${err.message}\n`);
        finish(1, null);
      });
      proc.on("exit", (code, signal) => finish(code, signal));
    });

    this.terminals.set(terminalId, term);
    return { terminalId };
  }

  /**
   * @param {string} terminalId
   * @returns {{ output: string, truncated: boolean, exitStatus: object|null }}
   */
  output(terminalId) {
    const term = this._get(terminalId);
    return {
      output: term.output,
      truncated: term.truncated,
      exitStatus: term.exitStatus
        ? {
            exitCode: term.exitStatus.exitCode,
            signal: term.exitStatus.signal,
          }
        : null,
    };
  }

  /**
   * @param {string} terminalId
   * @returns {Promise<{ exitCode: number|null, signal: string|null }>}
   */
  async waitForExit(terminalId) {
    const term = this._get(terminalId);
    return term.exitPromise;
  }

  /**
   * Kill without releasing (terminal id remains valid for output).
   * @param {string} terminalId
   */
  async kill(terminalId) {
    const term = this._get(terminalId);
    if (term.exitStatus) return {};
    await this._killProc(term.proc);
    // wait briefly for exit handler
    try {
      await Promise.race([
        term.exitPromise,
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    } catch {
      /* ignore */
    }
    if (!term.exitStatus) {
      term.exitStatus = { exitCode: null, signal: "SIGKILL" };
    }
    return {};
  }

  /**
   * Kill if needed and drop the terminal id.
   * @param {string} terminalId
   */
  async release(terminalId) {
    const term = this.terminals.get(terminalId);
    if (!term) return {};
    term.released = true;
    if (!term.exitStatus) {
      await this._killProc(term.proc);
    }
    this.terminals.delete(terminalId);
    return {};
  }

  /** Kill and drop every managed terminal (agent reset). */
  async releaseAll() {
    const ids = [...this.terminals.keys()];
    for (const id of ids) {
      try {
        await this.release(id);
      } catch {
        /* ignore */
      }
    }
  }

  _get(terminalId) {
    const term = this.terminals.get(terminalId);
    if (!term || term.released) {
      throw Object.assign(new Error(`unknown terminalId: ${terminalId}`), {
        code: -32602,
      });
    }
    return term;
  }

  async _killProc(proc) {
    if (!proc || proc.killed || proc.exitCode != null) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 250));
    try {
      if (!proc.killed && proc.exitCode == null) proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Auto-approve session/request_permission (yolo / phone always-approve mode).
 * @param {Array<{ optionId: string, kind?: string, name?: string }>} options
 */
export function autoApprovePermission(options) {
  const list = Array.isArray(options) ? options : [];
  const prefer =
    list.find((o) => o.kind === "allow_always") ||
    list.find((o) => o.kind === "allow_once") ||
    list.find((o) => /allow/i.test(String(o.kind || ""))) ||
    list.find((o) => /allow|yes|approve/i.test(String(o.name || ""))) ||
    list[0];
  if (!prefer?.optionId) {
    return { outcome: "cancelled" };
  }
  return { outcome: "selected", optionId: prefer.optionId };
}
