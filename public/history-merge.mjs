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

/** Normalize message body for fuzzy de-dupe (trim + collapse whitespace). */
export function normalizeHistoryText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Text fingerprint for messages that never got a jobId on the phone
 * (common for user bubbles until the Mac returns a job id).
 * @param {{ role?: string, text?: string }} m
 */
export function historyTextKey(m) {
  if (!m || (m.role !== "user" && m.role !== "bot")) return "";
  const role = m.role === "user" ? "user" : "bot";
  const t = normalizeHistoryText(m.text);
  if (!t) return "";
  return `${role}::${t}`;
}

/**
 * Merge host-backed conversation over local history.
 * Host is source of truth for job-backed turns so reconnect always loads text.
 *
 * Critical: local user rows often lack jobId until after send completes.
 * Without text de-dupe they reappear at the end after force-close/reopen.
 *
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
  const byJobKey = new Map();
  /** @type {Map<string, object>} */
  const byTextKey = new Map();
  /** @type {object[]} */
  const out = [];

  const indexEntry = (entry) => {
    const jk = historyEntryKey(entry);
    if (jk) byJobKey.set(jk, entry);
    const tk = historyTextKey(entry);
    if (tk) byTextKey.set(tk, entry);
  };

  const pushOrMerge = (m) => {
    if (!m || (m.role !== "user" && m.role !== "bot")) return;
    const role = m.role === "user" ? "user" : "bot";
    const jobKey = historyEntryKey(m);
    const textKey = historyTextKey(m);

    // 1) Same role+jobId
    if (jobKey && byJobKey.has(jobKey)) {
      const prev = byJobKey.get(jobKey);
      if ((m.text || "").length >= (prev.text || "").length) {
        prev.text = m.text;
      }
      if (m.jobStatus) prev.jobStatus = m.jobStatus;
      if (m.tools) prev.tools = m.tools;
      if (m.images?.length && !prev.images?.length) prev.images = m.images;
      // Keep text index in sync if body grew
      const tk = historyTextKey(prev);
      if (tk) byTextKey.set(tk, prev);
      return;
    }

    // 2) Same role + same text (local user without jobId vs host with jobId)
    if (textKey && byTextKey.has(textKey)) {
      const prev = byTextKey.get(textKey);
      // Prefer jobId from either side
      if (!prev.jobId && m.jobId) {
        prev.jobId = m.jobId;
        const jk = historyEntryKey(prev);
        if (jk) byJobKey.set(jk, prev);
      }
      if (m.jobStatus) prev.jobStatus = m.jobStatus;
      if (m.tools) prev.tools = m.tools;
      if (m.images?.length && !prev.images?.length) prev.images = m.images;
      if ((m.text || "").length > (prev.text || "").length) {
        prev.text = m.text;
      }
      return;
    }

    const entry = {
      role,
      text: m.text || "",
      jobId: m.jobId,
      jobStatus: m.jobStatus,
      tools: m.tools,
      images: m.images,
    };
    out.push(entry);
    indexEntry(entry);
  };

  // Host first (survives phone cache wipe)
  for (const m of host) pushOrMerge(m);

  // Local enriches or adds only true new turns
  for (const m of local || []) {
    pushOrMerge(m);
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
