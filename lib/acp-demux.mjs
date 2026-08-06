/**
 * Classify a parsed ACP JSON-RPC line from the agent process.
 *
 * Critical demux rule (JSON-RPC 2.0):
 * - Messages **with** `method` are peer→client requests or notifications.
 *   They must NEVER be treated as responses to our pending outbound requests,
 *   even when `id` collides with an in-flight session/prompt id.
 * - Messages **without** `method` (but with `id`) are responses to our requests.
 *
 * Root hang: agent terminal/* ids restart at 0 while our session/prompt may be
 * id=3; if terminal/create {id:3, method:...} is misread as prompt success,
 * we never answer terminal/create and the agent blocks mid-tool forever.
 */

/**
 * @typedef {'session_update'|'agent_request'|'agent_notification'|'response'|'ignore'} AcpLineType
 * @typedef {{
 *   type: AcpLineType,
 *   update?: object,
 *   id?: string|number,
 *   method?: string,
 *   params?: object,
 *   error?: object,
 *   result?: object,
 *   raw?: object,
 * }} AcpLineClass
 */

/**
 * @param {object|null|undefined} data parsed JSON-RPC object
 * @returns {AcpLineClass}
 */
export function classifyAcpLine(data) {
  if (!data || typeof data !== "object") {
    return { type: "ignore" };
  }

  // Peer request or notification — always classified by method first
  if (typeof data.method === "string") {
    if (
      data.method === "session/update" ||
      data.method === "x.ai/session/update"
    ) {
      const params = data.params || {};
      return {
        type: "session_update",
        update: params.update || params,
        raw: data,
      };
    }
    if (data.id != null) {
      return {
        type: "agent_request",
        id: data.id,
        method: data.method,
        params: data.params,
        raw: data,
      };
    }
    return {
      type: "agent_notification",
      method: data.method,
      params: data.params,
      raw: data,
    };
  }

  // Our request's response (no method field)
  if (data.id != null) {
    return {
      type: "response",
      id: data.id,
      error: data.error,
      result: data.result ?? {},
      raw: data,
    };
  }

  return { type: "ignore", raw: data };
}

/**
 * Apply demux to a pending map the same way GrokAcp does.
 * Pure helper for unit tests of the collision path.
 *
 * @param {object} data
 * @param {Map<string|number, {resolve: Function, reject: Function}>} pending
 * @param {{
 *   onSessionUpdate?: (update: object) => void,
 *   onAgentRequest?: (msg: object) => void,
 *   onAgentNotification?: (msg: object) => void,
 * }} handlers
 * @returns {{ kind: string, resolvedPending?: boolean, agentRequest?: object }}
 */
export function dispatchAcpLine(data, pending, handlers = {}) {
  const c = classifyAcpLine(data);

  if (c.type === "session_update") {
    handlers.onSessionUpdate?.(c.update);
    return { kind: "session_update" };
  }

  if (c.type === "agent_request") {
    // MUST handle before checking pending — id may collide with session/prompt
    handlers.onAgentRequest?.(c.raw || data);
    return {
      kind: "agent_request",
      agentRequest: c.raw || data,
      resolvedPending: false,
      pendingStillHasId: pending.has(c.id),
    };
  }

  if (c.type === "agent_notification") {
    handlers.onAgentNotification?.(c.raw || data);
    return { kind: "agent_notification" };
  }

  if (c.type === "response" && pending.has(c.id)) {
    const p = pending.get(c.id);
    pending.delete(c.id);
    if (c.error) {
      p.reject(
        new Error(c.error.message || JSON.stringify(c.error))
      );
    } else {
      p.resolve(c.result ?? {});
    }
    return { kind: "response", resolvedPending: true, id: c.id };
  }

  return { kind: c.type || "ignore", resolvedPending: false };
}
