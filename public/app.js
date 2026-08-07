import {
  mergeHostHistory,
  ensureActiveJobBotMessages,
} from "./history-merge.mjs";

const $ = (id) => document.getElementById(id);

const gate = $("gate");
const chat = $("chat");
const messages = $("messages");
const scrollBottomBtn = $("scroll-bottom-btn");
const connEl = $("conn");
const resetBtn = $("reset-btn");
const secretInput = $("secret");
const unlockBtn = $("unlock");
const input = $("input");
const sendBtn = $("send");
const attachBtn = $("attach");
const fileLibrary = $("file-library");
const fileCamera = $("file-camera");
const previews = $("previews");
const slashMenu = $("slash-menu");
const attachSheet = $("attach-sheet");
const attachBackdrop = $("attach-backdrop");
const pickLibrary = $("pick-library");
const pickCamera = $("pick-camera");
const attachCancel = $("attach-cancel");

const HISTORY_KEY = "phone_chat_history_v1";
const MAX_HISTORY = 80;
/** Cap total stored image data (~2MB JSON safety for localStorage) */
const MAX_IMAGE_CHARS = 1_800_000;

/** @type {{ mimeType: string, data: string, previewUrl: string }[]} */
let pendingImages = [];
let busy = false;

/** @type {{ role: 'user'|'bot', text: string, images?: string[], tools?: string, jobId?: string, jobStatus?: string }[]} */
let history = [];

/** @type {{ id: string, slash: string, label: string, description: string, insert: string }[]} */
let toolsCatalog = [];
let slashActiveIndex = 0;

/** Active job watchers: jobId → { bodyEl, thinkingEl, timer, es, closed } */
const activePolls = new Map();
/** Backup poll while SSE is live (SSE is primary). */
const POLL_MS = 2500;
/** Extra confirmation polls after terminal status (race: status flips before reply flush). */
const TERMINAL_CONFIRM_POLLS = 2;

function getSecret() {
  return localStorage.getItem("phone_chat_secret") || "";
}
function setSecret(s) {
  localStorage.setItem("phone_chat_secret", s);
}

/** Header: connection only (not thinking). */
function setConn(text, kind = "") {
  if (!connEl) return;
  connEl.textContent = text;
  connEl.className = "status " + kind;
}

/**
 * Inline thinking block on a bot message.
 * @param {HTMLElement | null} thinkingEl
 * @param {{ phase?: string, tools?: string, thought?: string, hide?: boolean }} opts
 */
function setThinking(thinkingEl, opts = {}) {
  if (!thinkingEl) return;
  if (opts.hide) {
    thinkingEl.innerHTML = "";
    thinkingEl.hidden = true;
    return;
  }
  thinkingEl.hidden = false;
  const phase = opts.phase || "Working…";
  const tools = (opts.tools || "").trim();
  const thought = (opts.thought || "").trim();
  const parts = [];
  parts.push(`<span class="think-label">${escapeHtml(phase)}</span>`);
  if (tools) {
    parts.push(`<div class="think-tools">${escapeHtml(tools)}</div>`);
  }
  if (thought) {
    // show trailing thought so it feels live
    const clip =
      thought.length > 900 ? "…" + thought.slice(-900) : thought;
    parts.push(`<div class="think-body">${escapeHtml(clip)}</div>`);
  }
  thinkingEl.innerHTML = parts.join("");
}

/**
 * Auto-scroll only while the user is near the bottom so they can read older
 * messages while a reply is streaming. Jump-to-bottom button when scrolled up.
 */
const NEAR_BOTTOM_PX = 80;
/** @type {boolean} stick follow mode — false after the user scrolls up */
let stickToBottom = true;

function distanceFromBottom() {
  if (!messages) return 0;
  return (
    messages.scrollHeight - messages.scrollTop - messages.clientHeight
  );
}

function isNearBottom() {
  return distanceFromBottom() <= NEAR_BOTTOM_PX;
}

function updateScrollBottomBtn() {
  if (!scrollBottomBtn || !messages) return;
  const hasOverflow =
    messages.scrollHeight > messages.clientHeight + 8;
  const show = hasOverflow && !isNearBottom();
  scrollBottomBtn.classList.toggle("hidden", !show);
  scrollBottomBtn.setAttribute("aria-hidden", show ? "false" : "true");
}

/**
 * @param {{ force?: boolean }} [opts]
 *   force: always jump (send, history load, jump button)
 *   otherwise only if stickToBottom (user is following the live stream)
 */
function scrollBottom(opts = {}) {
  if (!messages) return;
  const force = opts.force === true;
  if (!force && !stickToBottom) {
    updateScrollBottomBtn();
    return;
  }
  messages.scrollTop = messages.scrollHeight;
  stickToBottom = true;
  updateScrollBottomBtn();
}

function onMessagesScroll() {
  stickToBottom = isNearBottom();
  updateScrollBottomBtn();
}

if (messages) {
  messages.addEventListener("scroll", onMessagesScroll, { passive: true });
  // Content growth while scrolled up should refresh the jump button
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (stickToBottom) scrollBottom();
      else updateScrollBottomBtn();
    });
    ro.observe(messages);
  }
}

if (scrollBottomBtn) {
  scrollBottomBtn.addEventListener("click", () => {
    scrollBottom({ force: true });
  });
}

/** Configure marked once (UMD global from marked.min.js). */
function setupMarked() {
  if (typeof marked === "undefined") return;
  if (marked.use) {
    marked.use({
      gfm: true,
      breaks: true,
    });
  } else if (marked.setOptions) {
    marked.setOptions({ gfm: true, breaks: true });
  }
}
setupMarked();

/**
 * Render markdown → safe HTML for Grok replies.
 * Falls back to plain text if libs missing.
 * @param {string} md
 * @returns {string}
 */
/**
 * Auth token for <img src> (Bearer headers don't apply to image tags).
 */
function withAuthToken(url) {
  if (!url) return url;
  const secret = getSecret();
  if (!secret) return url;
  // only our API media paths
  if (!String(url).startsWith("/api/")) return url;
  const sep = url.includes("?") ? "&" : "?";
  // avoid double-token
  if (/[?&]token=/.test(url)) return url;
  return `${url}${sep}token=${encodeURIComponent(secret)}`;
}

function renderMarkdown(md) {
  const raw = md == null ? "" : String(md);
  if (!raw) return "";
  try {
    if (typeof marked === "undefined") {
      return escapeHtml(raw).replace(/\n/g, "<br>");
    }
    const html =
      typeof marked.parse === "function"
        ? marked.parse(raw)
        : marked(raw);
    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["target", "rel", "src", "alt", "class"],
        ADD_TAGS: ["img"],
      });
    }
    return html;
  } catch {
    return escapeHtml(raw).replace(/\n/g, "<br>");
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {'user'|'bot'} role
 */
/**
 * Attach generated reply images as <img> thumbnails under a message body.
 * @param {HTMLElement} msgEl message root (.msg)
 * @param {string[]} urls absolute or relative image URLs
 */
function setReplyImages(msgEl, urls) {
  if (!msgEl) return;
  msgEl.querySelectorAll("img.reply-img").forEach((n) => n.remove());
  if (!urls?.length) return;
  const body = msgEl.querySelector(".body");
  const anchor = body || msgEl;
  for (const url of urls) {
    const img = document.createElement("img");
    img.className = "thumb reply-img";
    img.src = withAuthToken(url);
    img.alt = "Generated image";
    img.loading = "lazy";
    // insert images before the text body for photo-first UX
    msgEl.insertBefore(img, anchor);
  }
}

function setBodyContent(el, text, role) {
  if (role === "bot") {
    el.classList.add("md");
    el.innerHTML = renderMarkdown(text || "");
    // open links in new tab
    el.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
    // rewrite /api/... media img src with auth token
    el.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("/api/")) {
        img.setAttribute("src", withAuthToken(src));
        img.classList.add("thumb", "reply-img");
      }
    });
  } else {
    el.classList.remove("md");
    el.textContent = text || "";
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory() {
  try {
    // trim oldest until it fits
    let slice = history.slice(-MAX_HISTORY);
    for (let attempt = 0; attempt < 20; attempt++) {
      const json = JSON.stringify(slice);
      try {
        localStorage.setItem(HISTORY_KEY, json);
        history = slice;
        return;
      } catch {
        // quota — drop oldest, or strip images from oldest
        if (slice.length <= 1) {
          const last = slice[slice.length - 1];
          if (last?.images?.length) {
            slice = [{ ...last, images: undefined }];
            continue;
          }
          return;
        }
        slice = slice.slice(1);
      }
    }
  } catch {
    /* ignore */
  }
}

function dataUrlFromImage(img) {
  return `data:${img.mimeType};base64,${img.data}`;
}

function estimateImageBudget(imgs) {
  return imgs.reduce((n, u) => n + (u?.length || 0), 0);
}

/**
 * @param {'user'|'bot'} role
 * @param {string} text
 * @param {{ images?: string[], thinkingEl?: HTMLElement, persist?: boolean, tools?: string, jobId?: string, jobStatus?: string, showThinking?: boolean }} opts
 */
function addMsg(role, text, opts = {}) {
  const persist = opts.persist !== false;
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (opts.jobId) el.dataset.jobId = opts.jobId;
  if (opts.images?.length) {
    for (const url of opts.images) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = url;
      img.alt = "";
      el.appendChild(img);
    }
  }

  let thinkingEl = opts.thinkingEl;
  if (role === "bot") {
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking";
    }
    el.appendChild(thinkingEl);
    if (opts.showThinking) {
      setThinking(thinkingEl, {
        phase:
          opts.jobStatus === "queued"
            ? "Queued…"
            : opts.jobStatus === "running"
              ? "Thinking…"
              : "Working…",
        tools: opts.tools,
      });
    } else if (opts.jobStatus === "done" || opts.jobStatus === "error") {
      setThinking(thinkingEl, { hide: true });
    } else if (opts.tools) {
      setThinking(thinkingEl, { phase: "Working…", tools: opts.tools });
    } else {
      setThinking(thinkingEl, { hide: true });
    }
  }

  const body = document.createElement("div");
  body.className = "body";
  setBodyContent(body, text || "", role);
  el.appendChild(body);

  // Job recovery actions when status may not flip to done on its own
  let actionsEl = null;
  if (role === "bot") {
    actionsEl = document.createElement("div");
    actionsEl.className = "job-actions hidden";
    el.appendChild(actionsEl);
    syncJobActions(el, opts.jobId, opts.jobStatus);
  }

  messages.appendChild(el);
  // New user messages pin to bottom; bot stream only follows if user is already there
  scrollBottom({ force: role === "user" || opts.forceScroll === true });

  if (persist) {
    const entry = {
      role,
      text: text || "",
      images: opts.images?.length ? opts.images.slice() : undefined,
      tools: opts.tools || undefined,
      jobId: opts.jobId,
      jobStatus: opts.jobStatus,
    };
    if (entry.images && estimateImageBudget(entry.images) > MAX_IMAGE_CHARS) {
      entry.images = entry.images.slice(0, 1);
      if (estimateImageBudget(entry.images) > MAX_IMAGE_CHARS) {
        delete entry.images;
      }
    }
    history.push(entry);
    persistHistory();
  }

  return { el, body, thinkingEl, actionsEl };
}

function isTerminalJobStatus(st) {
  return st === "done" || st === "error" || st === "cancelled";
}

/**
 * Show Get result / Stop & show under in-progress bot messages.
 */
function syncJobActions(msgEl, jobId, jobStatus) {
  if (!msgEl) return;
  let actions = msgEl.querySelector(".job-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "job-actions hidden";
    msgEl.appendChild(actions);
  }
  if (!jobId || isTerminalJobStatus(jobStatus)) {
    actions.classList.add("hidden");
    actions.innerHTML = "";
    return;
  }
  actions.classList.remove("hidden");
  if (actions.dataset.wired === jobId) return;
  actions.dataset.wired = jobId;
  actions.innerHTML = "";

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "job-action-btn";
  refreshBtn.textContent = "Get result";
  refreshBtn.title = "Pull the latest status/reply from the Mac right now";
  refreshBtn.onclick = () => void pullJobResult(jobId, msgEl);

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "job-action-btn job-action-stop";
  stopBtn.textContent = "Stop & show";
  stopBtn.title =
    "Stop the job on the Mac and show whatever reply it has so far";
  stopBtn.onclick = () => void stopAndShowJob(jobId, msgEl);

  actions.appendChild(refreshBtn);
  actions.appendChild(stopBtn);
}

async function pullJobResult(jobId, msgEl) {
  const secret = getSecret();
  if (!secret) return;
  const bodyEl = msgEl?.querySelector(".body");
  const thinkingEl = msgEl?.querySelector(".thinking");
  const actions = msgEl?.querySelector(".job-actions");
  if (actions) {
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
  }
  try {
    const res = await fetch(`/api/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || res.statusText);

    // Reuse the same UI path as SSE/poll
    const toolsLine = job.tools?.length
      ? job.tools.map((t) => `${t.name} (${t.status})`).join(" · ")
      : "";
    if (job.reply) setBodyContent(bodyEl, job.reply, "bot");
    else if (job.error) setBodyContent(bodyEl, `Error: ${job.error}`, "bot");

    const imageUrls = Array.isArray(job.images)
      ? job.images.map((im) => im.path || im.url).filter(Boolean)
      : [];
    if (imageUrls.length) setReplyImages(msgEl, imageUrls);

    updateHistoryByJobId(jobId, {
      text: job.reply || (job.error ? `Error: ${job.error}` : "") || "",
      tools: toolsLine || undefined,
      jobStatus: job.status,
      images: imageUrls.length ? imageUrls : undefined,
    });

    if (isTerminalJobStatus(job.status)) {
      setThinking(thinkingEl, { hide: true });
      syncJobActions(msgEl, jobId, job.status);
      stopJobPoll(jobId);
      if (!(job.reply || "").trim() && !job.error) {
        setBodyContent(
          bodyEl,
          "_(Still no reply on the Mac. Try Stop & show, or send again.)_",
          "bot"
        );
      }
    } else {
      setThinking(thinkingEl, {
        phase: "Pulled latest — still running on Mac…",
        tools: toolsLine,
        thought: job.thought || "",
      });
      syncJobActions(msgEl, jobId, job.status);
      // Ensure watcher is alive
      if (!activePolls.has(jobId) && bodyEl && thinkingEl) {
        startJobPoll(jobId, bodyEl, thinkingEl);
      }
    }
    setConn("connected", "ok");
    scrollBottom();
  } catch (e) {
    alert(`Could not pull result: ${e.message || e}`);
  } finally {
    if (actions) {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
}

async function stopAndShowJob(jobId, msgEl) {
  const secret = getSecret();
  if (!secret) return;
  if (
    !confirm(
      "Stop this job on the Mac and show whatever it has so far?\n\nThis frees the queue for new messages."
    )
  ) {
    return;
  }
  const bodyEl = msgEl?.querySelector(".body");
  const thinkingEl = msgEl?.querySelector(".thinking");
  const actions = msgEl?.querySelector(".job-actions");
  if (actions) {
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
  }
  try {
    const res = await fetch(`/api/jobs/${jobId}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || res.statusText);

    setThinking(thinkingEl, { hide: true });
    if (job.reply) setBodyContent(bodyEl, job.reply, "bot");
    else setBodyContent(bodyEl, "_(Stopped — no reply yet.)_", "bot");

    const imageUrls = Array.isArray(job.images)
      ? job.images.map((im) => im.path || im.url).filter(Boolean)
      : [];
    if (imageUrls.length) setReplyImages(msgEl, imageUrls);

    updateHistoryByJobId(jobId, {
      text: job.reply || "",
      jobStatus: job.status,
      images: imageUrls.length ? imageUrls : undefined,
    });
    syncJobActions(msgEl, jobId, job.status);
    stopJobPoll(jobId);
    setConn("connected", "ok");
    scrollBottom();
  } catch (e) {
    alert(`Stop failed: ${e.message || e}`);
  } finally {
    if (actions) {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
}

function updateHistoryByJobId(jobId, patch) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].jobId === jobId) {
      Object.assign(history[i], patch);
      persistHistory();
      return;
    }
  }
}

function renderHistory() {
  messages.innerHTML = "";
  // stop old polls
  for (const [, p] of activePolls) clearInterval(p.timer);
  activePolls.clear();

  history = loadHistory();
  for (const m of history) {
    // Bot images from API are /api/jobs/... paths — add token when rendering.
    // User photos are data: URLs and pass through.
    const imgs = (m.images || []).map((u) =>
      typeof u === "string" && u.startsWith("/api/") ? withAuthToken(u) : u
    );
    const { el, body, thinkingEl } = addMsg(m.role, m.text, {
      images: imgs,
      tools: m.tools,
      jobId: m.jobId,
      jobStatus: m.jobStatus,
      showThinking:
        m.role === "bot" &&
        m.jobId &&
        m.jobStatus &&
        m.jobStatus !== "done" &&
        m.jobStatus !== "error" &&
        m.jobStatus !== "cancelled",
      persist: false,
    });
    // ensure bot reply imgs get thumb class
    if (m.role === "bot") {
      el.querySelectorAll("img").forEach((img) => {
        img.classList.add("thumb", "reply-img");
      });
    }
    // resume incomplete jobs after refresh / unlock
    if (
      m.role === "bot" &&
      m.jobId &&
      m.jobStatus &&
      m.jobStatus !== "done" &&
      m.jobStatus !== "error" &&
      m.jobStatus !== "cancelled"
    ) {
      startJobPoll(m.jobId, body, thinkingEl);
    }
  }
  scrollBottom({ force: true });
}

/**
 * Watch a job until done.
 * Primary: Server-Sent Events push (`/api/jobs/:id/stream`) so final replies
 * arrive the moment the Mac finishes — no waiting for the next poll tick.
 * Backup: light polling (SSE can drop when iOS suspends the page).
 */
function startJobPoll(jobId, bodyEl, thinkingEl) {
  if (activePolls.has(jobId)) return;

  let terminalConfirms = 0;
  let lastReplyLen = -1;
  let closed = false;
  /** @type {EventSource | null} */
  let es = null;

  const applyJobToUi = (job) => {
    const toolsLine = job.tools?.length
      ? job.tools.map((t) => `${t.name} (${t.status})`).join(" · ")
      : "";
    const imageUrls = Array.isArray(job.images)
      ? job.images.map((im) => im.path || im.url).filter(Boolean)
      : [];
    const msgEl = bodyEl.closest(".msg");
    const reply = job.reply || "";
    if (reply) setBodyContent(bodyEl, reply, "bot");
    else if (job.status === "error" && job.error) {
      setBodyContent(bodyEl, `Error: ${job.error}`, "bot");
    }
    if (imageUrls.length) setReplyImages(msgEl, imageUrls);
    updateHistoryByJobId(jobId, {
      text: reply || (job.error ? `Error: ${job.error}` : "") || "",
      tools: toolsLine || undefined,
      jobStatus: job.status,
      images: imageUrls.length ? imageUrls : undefined,
    });
    syncJobActions(msgEl, jobId, job.status);
    return { toolsLine, imageUrls, reply };
  };

  const finishWithJob = (job) => {
    if (closed) return;
    applyJobToUi(job);
    setThinking(thinkingEl, { hide: true });
    const msgEl = bodyEl.closest(".msg");
    syncJobActions(msgEl, jobId, job.status);
    if (!(job.reply || "").trim() && !job.error) {
      setBodyContent(
        bodyEl,
        "_(No reply text received. Tap Get result, or send again.)_",
        "bot"
      );
    }
    stopJobPoll(jobId);
    setConn("connected", "ok");
    scrollBottom();
  };

  const handleJobSnapshot = (job) => {
    if (closed || !job) return;
    const reallyQueued =
      job.status === "queued" && (job.queuePosition || 0) > 0;
    const { toolsLine, reply } = applyJobToUi(job);

    if (
      job.status === "done" ||
      job.status === "error" ||
      job.status === "cancelled"
    ) {
      const replyLen = (reply || "").length;
      const grew = replyLen > lastReplyLen;
      lastReplyLen = replyLen;
      // One extra tick if empty/grew, then commit (SSE already has final state)
      if (terminalConfirms < TERMINAL_CONFIRM_POLLS && (grew || !reply)) {
        terminalConfirms += 1;
        setThinking(thinkingEl, {
          phase: reply ? "Finishing…" : "Almost done…",
        });
        setConn("connected", "ok");
        scrollBottom();
        // SSE end event or next poll will finalize
        if (job.status === "done" || job.status === "error") {
          // Prefer immediate finish when we already have a non-empty reply
          if (reply && replyLen > 0 && !grew) {
            finishWithJob(job);
          }
        }
        return;
      }
      finishWithJob(job);
      return;
    }

    terminalConfirms = 0;
    lastReplyLen = (reply || "").length;

    const updatedMs = Date.parse(job.updatedAt || job.startedAt || 0) || 0;
    const staleSec = updatedMs
      ? Math.floor((Date.now() - updatedMs) / 1000)
      : 0;
    const stale =
      !reallyQueued && job.status === "running" && staleSec > 120;
    const phase = reallyQueued
      ? `Queued (#${job.queuePosition})`
      : stale
        ? `Still working… (${Math.floor(staleSec / 60)}m)`
        : job.tools?.length
          ? "Working…"
          : "Thinking…";
    setThinking(thinkingEl, {
      phase,
      tools: toolsLine,
      thought: job.thought || "",
    });
    setConn("connected", "ok");
    scrollBottom();
  };

  const tick = async () => {
    const secret = getSecret();
    if (!secret || closed) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${secret}` },
        cache: "no-store",
      });
      if (res.status === 404) {
        stopJobPoll(jobId);
        setThinking(thinkingEl, { hide: true });
        setBodyContent(bodyEl, "Job expired or missing on Mac.", "bot");
        updateHistoryByJobId(jobId, {
          text: "Job expired or missing on Mac.",
          jobStatus: "error",
        });
        return;
      }
      if (!res.ok) return;
      handleJobSnapshot(await res.json());
    } catch {
      // network blip / phone asleep — keep polling / SSE will reconnect on focus
    }
  };

  // —— SSE primary path (push) ——
  try {
    const secret = getSecret();
    if (secret && typeof EventSource !== "undefined") {
      const url = `/api/jobs/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(secret)}`;
      es = new EventSource(url);
      es.addEventListener("job", (ev) => {
        try {
          handleJobSnapshot(JSON.parse(ev.data));
        } catch {
          /* ignore bad frame */
        }
      });
      es.addEventListener("end", (ev) => {
        try {
          const job = JSON.parse(ev.data);
          // Force terminal UI immediately on SSE end
          terminalConfirms = TERMINAL_CONFIRM_POLLS;
          handleJobSnapshot(job);
          finishWithJob(job);
        } catch {
          void tick();
        }
      });
      es.onerror = () => {
        // iOS often closes SSE when backgrounded; poll continues
        try {
          es.close();
        } catch {
          /* ignore */
        }
        es = null;
        const w = activePolls.get(jobId);
        if (w) w.es = null;
      };
    }
  } catch {
    es = null;
  }

  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  activePolls.set(jobId, { bodyEl, thinkingEl, timer, es, closed: false });
}

function stopJobPoll(jobId) {
  const p = activePolls.get(jobId);
  if (!p) return;
  p.closed = true;
  if (p.timer) clearInterval(p.timer);
  if (p.es) {
    try {
      p.es.close();
    } catch {
      /* ignore */
    }
  }
  activePolls.delete(jobId);
}

// Resume polls + refresh host transcript when phone unlocks / tab visible
async function onForegroundResume() {
  try {
    const host = await loadHostConversation();
    if (host?.messages?.length || host?.activeJobs?.length) {
      let merged = mergeHostHistory(history, host.messages || [], MAX_HISTORY);
      merged = ensureActiveJobBotMessages(merged, host.activeJobs || []);
      const before = history
        .map((m) => (m.text || "").length)
        .reduce((a, b) => a + b, 0);
      const after = merged
        .map((m) => (m.text || "").length)
        .reduce((a, b) => a + b, 0);
      if (after > before || merged.length !== history.length) {
        history = merged;
        persistHistory();
        renderHistory();
      }
      reattachActiveJobs(host.activeJobs || []);
    }
  } catch {
    /* offline */
  }
  for (const [jobId, p] of activePolls) {
    clearInterval(p.timer);
    activePolls.delete(jobId);
    startJobPoll(jobId, p.bodyEl, p.thinkingEl);
  }
  checkStatus();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void onForegroundResume();
  }
});
window.addEventListener("focus", () => {
  void onForegroundResume();
});

function renderPreviews() {
  previews.innerHTML = "";
  pendingImages.forEach((img, i) => {
    const wrap = document.createElement("div");
    wrap.className = "pv";
    const im = document.createElement("img");
    im.src = img.previewUrl;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.onclick = () => {
      URL.revokeObjectURL(img.previewUrl);
      pendingImages.splice(i, 1);
      renderPreviews();
    };
    wrap.append(im, x);
    previews.appendChild(wrap);
  });
}

async function fileToImage(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const data = btoa(binary);
  return {
    mimeType: file.type || "image/jpeg",
    data,
    previewUrl: URL.createObjectURL(file),
  };
}

async function checkStatus() {
  const secret = getSecret();
  if (!secret) {
    setConn("locked", "bad");
    return false;
  }
  try {
    const res = await fetch("/api/status", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      setConn("auth failed", "bad");
      return false;
    }
    const j = await res.json();
    setConn(j.agentReady ? "connected" : "starting…", j.agentReady ? "ok" : "");
    return true;
  } catch {
    setConn("offline", "bad");
    return false;
  }
}

/**
 * Load durable transcript + active jobs from the Mac (reconnect path).
 * @returns {Promise<{ messages: Array, activeJobs: Array }|null>}
 */
async function loadHostConversation() {
  const secret = getSecret();
  if (!secret) return null;
  try {
    const res = await fetch("/api/conversation", {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Re-subscribe to non-terminal Mac jobs (bot bubbles with thinking el).
 * @param {Array} activeJobs
 */
function reattachActiveJobs(activeJobs) {
  for (const job of activeJobs || []) {
    if (
      !job?.id ||
      job.status === "done" ||
      job.status === "error" ||
      job.status === "cancelled"
    ) {
      continue;
    }
    if (activePolls.has(job.id)) continue;
    // Must be the bot bubble — user bubble has same data-job-id, no thinking
    const msgEl =
      messages.querySelector(`.msg.bot[data-job-id="${job.id}"]`) ||
      messages.querySelector(`.msg.bot[data-job-id='${job.id}']`);
    const bodyEl = msgEl?.querySelector(".body");
    const thinkingEl = msgEl?.querySelector(".thinking");
    if (bodyEl && thinkingEl) {
      startJobPoll(job.id, bodyEl, thinkingEl);
    }
  }
}

async function showChat() {
  gate.classList.add("hidden");
  chat.classList.add("active");
  // Host-backed history first — like remote-control apps that always restore session text
  const host = await loadHostConversation();
  if (host?.messages?.length || host?.activeJobs?.length) {
    let merged = mergeHostHistory(
      loadHistory(),
      host.messages || [],
      MAX_HISTORY
    );
    // Guarantee bot rows for mid-flight jobs so poll can attach thinking UI
    merged = ensureActiveJobBotMessages(merged, host.activeJobs || []);
    history = merged;
    persistHistory();
  }
  renderHistory();
  reattachActiveJobs(host?.activeJobs || []);
  checkStatus();
}

function showGate() {
  chat.classList.remove("active");
  gate.classList.remove("hidden");
}

async function doUnlock() {
  const s = (secretInput?.value || "").trim();
  if (!s) {
    alert("Paste the PHONE_CHAT_SECRET from the Mac first.");
    return;
  }
  setSecret(s);
  setConn("connecting…", "");
  try {
    if (await checkStatus()) {
      await loadTools();
      await showChat();
    } else {
      alert(
        "Could not connect — check the secret and that the Mac server is running."
      );
    }
  } catch (e) {
    setConn("offline", "bad");
    alert(`Connect failed: ${e.message || e}`);
  }
}

if (unlockBtn) {
  unlockBtn.onclick = () => void doUnlock();
}
// Enter / Go on the secret field
if (secretInput) {
  secretInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void doUnlock();
    }
  });
}

// ── Attach: library + camera ───────────────────────────────────────────────

function openAttachSheet() {
  attachSheet.classList.remove("hidden");
  attachSheet.setAttribute("aria-hidden", "false");
}
function closeAttachSheet() {
  attachSheet.classList.add("hidden");
  attachSheet.setAttribute("aria-hidden", "true");
}

attachBtn.onclick = () => openAttachSheet();
attachBackdrop.onclick = () => closeAttachSheet();
attachCancel.onclick = () => closeAttachSheet();
pickLibrary.onclick = () => {
  closeAttachSheet();
  fileLibrary.click();
};
pickCamera.onclick = () => {
  closeAttachSheet();
  fileCamera.click();
};

async function onFilesSelected(fileList) {
  const files = [...(fileList || [])];
  for (const f of files.slice(0, 4)) {
    if (!f.type.startsWith("image/")) continue;
    pendingImages.push(await fileToImage(f));
  }
  renderPreviews();
}

fileLibrary.onchange = async () => {
  await onFilesSelected(fileLibrary.files);
  fileLibrary.value = "";
};
fileCamera.onchange = async () => {
  await onFilesSelected(fileCamera.files);
  fileCamera.value = "";
};

// ── Slash tool menu ────────────────────────────────────────────────────────

async function loadTools() {
  const secret = getSecret();
  if (!secret) return;
  try {
    const res = await fetch("/api/tools", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return;
    const j = await res.json();
    toolsCatalog = Array.isArray(j.tools) ? j.tools : [];
  } catch {
    toolsCatalog = [];
  }
}

/**
 * Detect `/query` at end of input (slash command filter).
 * @returns {{ start: number, query: string } | null}
 */
function slashQueryFromInput() {
  const val = input.value;
  const caret = input.selectionStart ?? val.length;
  const before = val.slice(0, caret);
  // Match `/something` at start of a line or after whitespace
  const m = before.match(/(^|\s)\/([^\s]*)$/);
  if (!m) return null;
  const query = m[2] || "";
  const start = before.length - query.length - 1; // position of `/`
  return { start, query };
}

function filteredTools(query) {
  const q = (query || "").toLowerCase();
  if (!q) return toolsCatalog;
  return toolsCatalog.filter((t) => {
    const hay = `${t.slash} ${t.label} ${t.description} ${t.id}`.toLowerCase();
    return hay.includes(q) || t.slash.replace(/^\//, "").startsWith(q);
  });
}

function hideSlashMenu() {
  slashMenu.classList.add("hidden");
  slashMenu.innerHTML = "";
  slashActiveIndex = 0;
}

function showSlashMenu(items) {
  slashMenu.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty";
    empty.textContent = toolsCatalog.length
      ? "No matching tools"
      : "Loading tools…";
    slashMenu.appendChild(empty);
    slashMenu.classList.remove("hidden");
    return;
  }
  items.forEach((t, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-item" + (i === slashActiveIndex ? " active" : "");
    btn.setAttribute("role", "option");
    const kind = t.kind === "tool" ? "tool" : "cli";
    btn.innerHTML = `
      <span class="slash-name">${escapeHtml(t.label)} <span class="slash-kind">${kind}</span></span>
      <span class="slash-cmd">${escapeHtml(t.slash)}</span>
      <span class="slash-desc">${escapeHtml(t.description || "")}</span>
    `;
    btn.onclick = () => applySlashTool(t);
    slashMenu.appendChild(btn);
  });
  slashMenu.classList.remove("hidden");
}

function applySlashTool(tool) {
  const sq = slashQueryFromInput();
  const val = input.value;
  const caret = input.selectionStart ?? val.length;
  if (!sq) {
    input.value = (tool.insert || tool.slash + " ") + val;
  } else {
    // Replace `/query` with insert text
    const before = val.slice(0, sq.start);
    const after = val.slice(caret);
    const insert = tool.insert || tool.slash + " ";
    input.value = before + insert + after;
    const pos = before.length + insert.length;
    input.setSelectionRange(pos, pos);
  }
  hideSlashMenu();
  input.focus();
  input.dispatchEvent(new Event("input"));
}

function updateSlashMenu() {
  const sq = slashQueryFromInput();
  if (!sq) {
    hideSlashMenu();
    return;
  }
  const items = filteredTools(sq.query);
  if (slashActiveIndex >= items.length) slashActiveIndex = Math.max(0, items.length - 1);
  showSlashMenu(items);
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
  updateSlashMenu();
});

input.addEventListener("keydown", (e) => {
  if (slashMenu.classList.contains("hidden")) return;
  const sq = slashQueryFromInput();
  if (!sq) return;
  const items = filteredTools(sq.query);
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    slashActiveIndex = (slashActiveIndex + 1) % items.length;
    showSlashMenu(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    slashActiveIndex = (slashActiveIndex - 1 + items.length) % items.length;
    showSlashMenu(items);
  } else if (e.key === "Enter" && !e.shiftKey) {
    // pick tool instead of send when menu open
    e.preventDefault();
    applySlashTool(items[slashActiveIndex] || items[0]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    hideSlashMenu();
  } else if (e.key === "Tab") {
    e.preventDefault();
    applySlashTool(items[slashActiveIndex] || items[0]);
  }
});

/**
 * Enqueue a message on the Mac immediately.
 * You can send many in a row (queue). Phone lock won't cancel Mac work.
 */
async function send() {
  const text = input.value.trim();
  if (!text && !pendingImages.length) return;
  const secret = getSecret();
  if (!secret) {
    showGate();
    return;
  }

  const imgs = pendingImages.slice();
  const imageDataUrls = imgs.map(dataUrlFromImage);
  addMsg("user", text || "(photo)", { images: imageDataUrls });
  input.value = "";
  input.style.height = "auto";
  pendingImages = [];
  renderPreviews();
  hideSlashMenu();

  const { body, thinkingEl } = addMsg("bot", "", {
    showThinking: true,
    jobStatus: "running",
    forceScroll: true,
  });
  setThinking(thinkingEl, { phase: "Sending…" });
  // Always jump to the new turn when the user sends (even if they were scrolled up)
  scrollBottom({ force: true });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        images: imgs.map(({ mimeType, data }) => ({ mimeType, data })),
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = j.error || res.statusText || String(res.status);
      setThinking(thinkingEl, { hide: true });
      setBodyContent(body, `Error: ${err}`, "bot");
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === "bot" && !history[i].jobId) {
          history[i].text = `Error: ${err}`;
          history[i].jobStatus = "error";
          persistHistory();
          break;
        }
      }
      setConn("connected", "ok");
      return;
    }

    const jobId = j.jobId;
    const isQueued = j.status === "queued" && (j.queuePosition || 0) > 0;
    setThinking(thinkingEl, {
      phase: isQueued ? `Queued (#${j.queuePosition})` : "Thinking…",
    });
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "bot" && !history[i].jobId) {
        history[i].jobId = jobId;
        history[i].jobStatus = isQueued ? "queued" : "running";
        history[i].text = "";
        persistHistory();
        break;
      }
    }
    const botEl = body.closest(".msg");
    if (botEl) botEl.dataset.jobId = jobId;

    startJobPoll(jobId, body, thinkingEl);
  } catch (e) {
    setThinking(thinkingEl, { hide: true });
    setBodyContent(
      body,
      `Could not reach Mac (message not queued): ${e.message || e}\n\nUnlock phone / reconnect and try again.`,
      "bot"
    );
    setConn("offline", "bad");
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "bot" && !history[i].jobId) {
        history[i].text = body.innerText;
        history[i].jobStatus = "error";
        persistHistory();
        break;
      }
    }
  }
}

sendBtn.onclick = () => {
  if (!slashMenu.classList.contains("hidden")) return;
  void send();
};

// Enter to send when slash menu closed (menu handler runs first for pick)
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && slashMenu.classList.contains("hidden")) {
    e.preventDefault();
    void send();
  }
});

/**
 * Reset hung agent + cancel all Mac jobs. Use when everything says Thinking….
 */
async function resetAgent() {
  const secret = getSecret();
  if (!secret) {
    showGate();
    return;
  }
  if (
    !confirm(
      "Reset the Mac agent?\n\nCancels all queued/running jobs and starts a fresh session."
    )
  ) {
    return;
  }
  setConn("resetting…", "");
  // stop local polls
  for (const [jobId] of activePolls) stopJobPoll(jobId);

  try {
    const res = await fetch("/api/reset", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);

    // mark incomplete history as cancelled
    for (const m of history) {
      if (
        m.role === "bot" &&
        m.jobId &&
        m.jobStatus &&
        m.jobStatus !== "done" &&
        m.jobStatus !== "error" &&
        m.jobStatus !== "cancelled"
      ) {
        m.jobStatus = "cancelled";
        m.text = m.text || "_(reset)_";
      }
    }
    persistHistory();
    // refresh UI thinking blocks
    document.querySelectorAll(".msg.bot .thinking").forEach((el) => {
      setThinking(el, { hide: true });
    });
    setConn("connected", "ok");
    addMsg("bot", "_Agent reset. You can send a new message._", {
      jobStatus: "done",
      showThinking: false,
    });
  } catch (e) {
    setConn("offline", "bad");
    alert(`Reset failed: ${e.message || e}`);
  }
}

if (resetBtn) resetBtn.onclick = () => void resetAgent();

// boot
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
if (getSecret()) {
  secretInput.value = getSecret();
  checkStatus().then(async (ok) => {
    if (ok) {
      await loadTools();
      await showChat();
    }
  });
} else {
  setConn("locked", "bad");
}
