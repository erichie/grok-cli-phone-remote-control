/**
 * Host/local chat history merge for phone reconnect.
 * Shipped to the browser and unit-tested as the real merge path.
 */

/**
 * Stable key: role + jobId so user and assistant turns for the same job
 * never collapse into one message.
 * @param {{ role?: string, jobId?: string }} m
 */
export function historyEntryKey(m) {
  if (!m) return "";
  if (m.jobId) {
    const role = m.role === "user" ? "user" : "bot";
    return `${role}:${m.jobId}`;
  }
  return "";
}

/**
 * Merge host-backed conversation over local history.
 * Host is source of truth for job-backed turns so reconnect always loads text.
 * @param {Array} local
 * @param {Array} hostMessages
 * @param {number} [maxHistory=80]
 * @returns {Array}
 */
export function mergeHostHistory(local, hostMessages, maxHistory = 80) {
  const host = Array.isArray(hostMessages) ? hostMessages : [];
  if (!host.length) {
    return Array.isArray(local) ? local.slice(-maxHistory) : [];
  }

  /** @type {Map<string, object>} */
  const byKey = new Map();
  /** @type {object[]} */
  const out = [];

  const pushOrMerge = (m) => {
    if (!m || (m.role !== "user" && m.role !== "bot")) return;
    const key = historyEntryKey(m);
    if (key) {
      const prev = byKey.get(key);
      if (prev) {
        // Same role+jobId: prefer longer body; always take fresher jobStatus/tools
        if ((m.text || "").length >= (prev.text || "").length) {
          prev.text = m.text;
        }
        if (m.jobStatus) prev.jobStatus = m.jobStatus;
        if (m.tools) prev.tools = m.tools;
        if (m.images?.length && !prev.images?.length) prev.images = m.images;
        return;
      }
      const entry = {
        role: m.role === "user" ? "user" : "bot",
        text: m.text || "",
        jobId: m.jobId,
        jobStatus: m.jobStatus,
        tools: m.tools,
        images: m.images,
      };
      byKey.set(key, entry);
      out.push(entry);
      return;
    }
    // No jobId: append as local-only (do not de-dupe by text)
    out.push({
      role: m.role === "user" ? "user" : "bot",
      text: m.text || "",
      tools: m.tools,
      images: m.images,
    });
  };

  // Host first (survives phone cache wipe)
  for (const m of host) pushOrMerge(m);

  // Local can enrich images / longer text for same role+jobId
  for (const m of local || []) {
    const key = historyEntryKey(m);
    if (key && byKey.has(key)) {
      const prev = byKey.get(key);
      if ((m.text || "").length > (prev.text || "").length) {
        prev.text = m.text;
      }
      if (m.images?.length && !prev.images?.length) prev.images = m.images;
      if (m.jobStatus && !prev.jobStatus) prev.jobStatus = m.jobStatus;
      continue;
    }
    if (!key) pushOrMerge(m);
    else pushOrMerge(m);
  }

  return out.slice(-maxHistory);
}

/**
 * Ensure every non-terminal active job has a bot history entry so the UI can
 * attach startJobPoll (needs role=bot + thinking el).
 * @param {Array} messages merge result
 * @param {Array<{ id: string, status: string, reply?: string, text?: string, tools?: Array }>} activeJobs
 * @returns {Array}
 */
export function ensureActiveJobBotMessages(messages, activeJobs) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const jobs = Array.isArray(activeJobs) ? activeJobs : [];

  for (const job of jobs) {
    if (!job?.id) continue;
    if (
      job.status === "done" ||
      job.status === "error" ||
      job.status === "cancelled"
    ) {
      continue;
    }
    const botKey = `bot:${job.id}`;
    const hasBot = list.some(
      (m) => m.role === "bot" && m.jobId === job.id
    );
    const toolsLine = Array.isArray(job.tools)
      ? job.tools.map((t) => `${t.name} (${t.status})`).join(" · ")
      : undefined;

    if (!hasBot) {
      // Ensure user turn exists if we only have job metadata
      const hasUser = list.some(
        (m) => m.role === "user" && m.jobId === job.id
      );
      if (!hasUser && (job.text || job.prompt)) {
        list.push({
          role: "user",
          text: job.text || job.prompt || "",
          jobId: job.id,
        });
      }
      list.push({
        role: "bot",
        text: job.reply || "",
        jobId: job.id,
        jobStatus: job.status || "running",
        tools: toolsLine,
      });
    } else {
      // Refresh status/partial reply on existing bot bubble
      for (const m of list) {
        if (m.role === "bot" && m.jobId === job.id) {
          m.jobStatus = job.status || m.jobStatus || "running";
          if ((job.reply || "").length >= (m.text || "").length) {
            m.text = job.reply || m.text || "";
          }
          if (toolsLine) m.tools = toolsLine;
        }
      }
    }
  }
  return list;
}
