/**
 * Shared ACP line demux + agent→client request handling.
 * Used by the live GrokAcp bridge and unit tests (id-collision path).
 */
import { classifyAcpLine } from "./acp-demux.mjs";
import { autoApprovePermission } from "./terminal-manager.mjs";
import { readTextFile, writeTextFile } from "./fs-handlers.mjs";

/**
 * @typedef {object} AcpLineHandlerOptions
 * @property {import('./terminal-manager.mjs').TerminalManager} terminals
 * @property {string[]} allowedRoots
 * @property {(obj: object) => void} writeMessage  write JSON-RPC to agent stdin
 * @property {(update: object) => void} [onSessionUpdate]
 * @property {(msg: string) => void} [onWarn]
 */

export class AcpLineHandler {
  /**
   * @param {AcpLineHandlerOptions} opts
   */
  constructor(opts) {
    this.terminals = opts.terminals;
    this.allowedRoots = opts.allowedRoots || [];
    this.writeMessage = opts.writeMessage;
    this.onSessionUpdate = opts.onSessionUpdate || (() => {});
    this.onWarn = opts.onWarn || (() => {});
    /** @type {Map<string|number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
  }

  /**
   * Register an outbound client→agent request.
   * @param {string|number} id
   * @param {{resolve: Function, reject: Function}} handlers
   */
  trackPending(id, handlers) {
    this.pending.set(id, handlers);
  }

  /** @param {string|number} id */
  hasPending(id) {
    return this.pending.has(id);
  }

  clearPending(reason = "cleared") {
    for (const [, p] of this.pending) {
      try {
        p.reject(new Error(reason));
      } catch {
        /* ignore */
      }
    }
    this.pending.clear();
  }

  /**
   * Process one NDJSON line from the agent (the real demux entrypoint).
   * @param {string} line
   */
  onLine(line) {
    if (!line || !String(line).trim()) return;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    this.onMessage(data);
  }

  /**
   * Process a parsed JSON-RPC object (same rules as onLine).
   * @param {object} data
   */
  onMessage(data) {
    const kind = classifyAcpLine(data);

    if (kind.type === "session_update") {
      this.onSessionUpdate(kind.update);
      return;
    }

    if (kind.type === "agent_request") {
      // Always treat as agent→client request — even if id collides with pending
      void this.handleAgentRequest(kind.raw || data);
      return;
    }

    if (kind.type === "agent_notification") {
      return;
    }

    if (kind.type === "response" && this.pending.has(kind.id)) {
      const p = this.pending.get(kind.id);
      this.pending.delete(kind.id);
      if (kind.error) {
        p.reject(
          new Error(kind.error.message || JSON.stringify(kind.error))
        );
      } else {
        p.resolve(kind.result ?? {});
      }
    }
  }

  _replyResult(id, result) {
    this.writeMessage({ jsonrpc: "2.0", id, result: result ?? {} });
  }

  _replyError(id, message, code = -32000) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message: String(message || "error") },
    });
  }

  /**
   * Answer agent→client methods (terminal/*, fs/*, permission, elicitation).
   * @param {object} msg
   */
  async handleAgentRequest(msg) {
    const { id, method, params } = msg;
    try {
      switch (method) {
        case "terminal/create": {
          const result = this.terminals.create(params || {});
          this._replyResult(id, result);
          return;
        }
        case "terminal/output": {
          // After agent reset, the model may poll stale terminal ids — answer
          // softly so the turn can finish instead of spinning on errors.
          try {
            this._replyResult(id, this.terminals.output(params?.terminalId));
          } catch {
            this._replyResult(id, {
              output: "",
              truncated: false,
              exitStatus: { exitCode: 1, signal: null },
            });
          }
          return;
        }
        case "terminal/wait_for_exit": {
          try {
            const exit = await this.terminals.waitForExit(params?.terminalId);
            this._replyResult(id, exit);
          } catch {
            this._replyResult(id, { exitCode: 1, signal: null });
          }
          return;
        }
        case "terminal/kill": {
          try {
            await this.terminals.kill(params?.terminalId);
          } catch {
            /* already gone */
          }
          this._replyResult(id, {});
          return;
        }
        case "terminal/release": {
          try {
            await this.terminals.release(params?.terminalId);
          } catch {
            /* already gone */
          }
          this._replyResult(id, {});
          return;
        }
        case "fs/read_text_file": {
          const result = await readTextFile(params || {}, this.allowedRoots);
          this._replyResult(id, result);
          return;
        }
        case "fs/write_text_file": {
          const result = await writeTextFile(params || {}, this.allowedRoots);
          this._replyResult(id, result);
          return;
        }
        case "session/request_permission": {
          const outcome = autoApprovePermission(params?.options || []);
          this._replyResult(id, { outcome });
          return;
        }
        case "elicitation/create": {
          this._replyResult(id, { action: "cancel" });
          return;
        }
        default: {
          this.onWarn(`unhandled agent request: ${method}`);
          this._replyError(id, `Method not found: ${method}`, -32601);
        }
      }
    } catch (e) {
      const code = e && typeof e.code === "number" ? e.code : -32000;
      this.onWarn(
        `${method} failed: ${e instanceof Error ? e.message : e}`
      );
      this._replyError(
        id,
        e instanceof Error ? e.message : String(e),
        code
      );
    }
  }
}
