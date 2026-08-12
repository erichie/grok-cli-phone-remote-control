import {
  mergeHostHistory,
  dropForeignJobTurns,
  ensureActiveJobBotMessages,
} from "./history-merge.mjs";
import { buildThinkingHtml } from "./thinking-ui.mjs";
import {
  normalizeSelectedAgentId,
  agentStatusLine,
  agentDotKind,
  jobPreviewText,
  jobStatusLabel,
  jobIsActive,
  partitionJobs,
  activityBadgeCount,
  chatAgentIdPayload,
} from "./activity-ui.mjs";
import {
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  isMediaRecorderDictationSupported,
  isAnyDictationSupported,
  isSecureDictationContext,
  isAppleMobileSpeech,
  preferServerDictation,
  preferContinuousRecognition,
  pickAudioRecorderMime,
  mergeDictationText,
  consumeRecognitionResults,
  speechRecognitionErrorMessage,
  dictationBlockedReason,
  hasGetUserMedia,
  isNativeAudioFileDictationSupported,
  selectDictationPath,
  buildComposerDraft,
  buildFreeHttpsMicUrl,
  matchSendTrigger,
  DEFAULT_SEND_TRIGGERS,
  parseSendTriggerInput,
  formatSendTriggersForInput,
  primarySendTrigger,
} from "./voice-ui.mjs";

const $ = (id) => document.getElementById(id);

const gate = $("gate");
const chat = $("chat");
const messages = $("messages");
const scrollBottomBtn = $("scroll-bottom-btn");
const connEl = $("conn");
const resetBtn = $("reset-btn");
const menuBtn = $("menu-btn");
const menuBadge = $("menu-badge");
const activityDrawer = $("activity-drawer");
const activityBackdrop = $("activity-backdrop");
const activityClose = $("activity-close");
const activitySpawn = $("activity-spawn");
const activityRefresh = $("activity-refresh");
const activityAgents = $("activity-agents");
const activityJobs = $("activity-jobs");
const agentChipBar = $("agent-chip-bar");
const agentChip = $("agent-chip");
const secretInput = $("secret");
const unlockBtn = $("unlock");
const input = $("input");
const sendBtn = $("send");
const actionsBtn = $("actions-btn");
const micBtn = $("mic");
const dictationHint = $("dictation-hint");
const filePhotos = $("file-photos");
const fileAudio = $("file-audio");
const previews = $("previews");
const slashMenu = $("slash-menu");
const actionsSheet = $("actions-sheet");
const actionsBackdrop = $("actions-backdrop");
const actionPhoto = $("action-photo");
const actionTools = $("action-tools");
const actionsCancel = $("actions-cancel");
const dictationSheet = $("dictation-sheet");
const dictationBackdrop = $("dictation-backdrop");
const dictationKeyboardBtn = $("dictation-keyboard");
const dictationHttpsBtn = $("dictation-https");
const dictationMemoBtn = $("dictation-memo");
const dictationCancelBtn = $("dictation-cancel");
const voiceTriggerInput = $("voice-trigger-input");
const voiceTriggerSave = $("voice-trigger-save");
const voiceTriggerReset = $("voice-trigger-reset");
const voiceTriggerStatus = $("voice-trigger-status");

/** @type {string|null} free self-signed HTTPS URL from /api/status */
let freeHttpsMicUrl = null;
/** Prevent double auto-send from rapid STT events */
let autoSendInFlight = false;
const SEND_TRIGGER_KEY = "phone_chat_send_triggers";

/** Base key — actual storage is per-agent: `${HISTORY_KEY}:${agentId}`. */
const HISTORY_KEY = "phone_chat_history_v1";
const CONVERSATION_ID_KEY = "phone_chat_conversation_id";
const SELECTED_AGENT_KEY = "phone_chat_selected_agent";
const MAX_HISTORY = 80;
/** Cap total stored image data (~2MB JSON safety for localStorage) */
const MAX_IMAGE_CHARS = 1_800_000;
/** Poll menu badge + agent list while connected. */
const ACTIVITY_POLL_MS = 4000;

/** @type {{ mimeType: string, data: string, previewUrl: string }[]} */
let pendingImages = [];
let busy = false;

/** @type {{ role: 'user'|'bot', text: string, images?: string[], tools?: string, jobId?: string, jobStatus?: string }[]} */
let history = [];

/** @type {import('./activity-ui.mjs').AgentInfo[]} */
let knownAgents = [];
/** @type {import('./activity-ui.mjs').JobInfo[]} */
let knownJobs = [];
/** Selected session / send target: "main" | agent uuid (not "auto" for history) */
let selectedAgentId =
  localStorage.getItem(SELECTED_AGENT_KEY) || "main";
/** @type {ReturnType<typeof setInterval> | null} */
let activityPollTimer = null;
let activityOpen = false;
let activityBusy = false;

/** Normalize agent id used for local history buckets. */
function historyAgentId(agentId) {
  const id = String(agentId || "main").trim() || "main";
  if (id === "default" || id === "auto") return "main";
  return id;
}

function historyStorageKey(agentId = selectedAgentId) {
  return `${HISTORY_KEY}:${historyAgentId(agentId)}`;
}

function conversationStorageKey(agentId = selectedAgentId) {
  return `${CONVERSATION_ID_KEY}:${historyAgentId(agentId)}`;
}

/** One-time: move pre-multi-agent history into main's bucket. */
function migrateLegacyHistory() {
  try {
    const legacy = localStorage.getItem(HISTORY_KEY);
    const mainKey = historyStorageKey("main");
    if (legacy && !localStorage.getItem(mainKey)) {
      localStorage.setItem(mainKey, legacy);
    }
    const legacyConv = localStorage.getItem(CONVERSATION_ID_KEY);
    const mainConv = conversationStorageKey("main");
    if (legacyConv && !localStorage.getItem(mainConv)) {
      localStorage.setItem(mainConv, legacyConv);
    }
  } catch {
    /* ignore */
  }
}
migrateLegacyHistory();

function getStoredConversationId(agentId = selectedAgentId) {
  try {
    return localStorage.getItem(conversationStorageKey(agentId)) || "";
  } catch {
    return "";
  }
}
function setStoredConversationId(id, agentId = selectedAgentId) {
  try {
    const key = conversationStorageKey(agentId);
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Wipe phone UI history for the current agent session only. */
function clearLocalChatHistory() {
  history = [];
  try {
    localStorage.removeItem(historyStorageKey());
  } catch {
    /* ignore */
  }
  if (messages) messages.innerHTML = "";
  for (const [jobId] of activePolls) stopJobPoll(jobId);
  clearHeaderJobActions();
}

/** Wipe every agent session's phone history (Reset). */
function clearAllAgentHistories() {
  history = [];
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k === HISTORY_KEY ||
        k === CONVERSATION_ID_KEY ||
        (k && k.startsWith(HISTORY_KEY + ":")) ||
        (k && k.startsWith(CONVERSATION_ID_KEY + ":"))
      ) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  if (messages) messages.innerHTML = "";
  for (const [jobId] of activePolls) stopJobPoll(jobId);
  clearHeaderJobActions();
}

/** Active Mac jobs for the currently selected agent session. */
function jobsForSelectedAgent(jobs = knownJobs) {
  const aid = historyAgentId(selectedAgentId);
  return (jobs || []).filter((j) => historyAgentId(j.agentId || "main") === aid);
}

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
 * Inline thinking block on a bot message (breathing gradient + dots).
 * Markup from shared thinking-ui.mjs (same path unit tests drive).
 * @param {HTMLElement | null} thinkingEl
 * @param {{ phase?: string, tools?: string, thought?: string, hide?: boolean, jobId?: string }} opts
 */
function setThinking(thinkingEl, opts = {}) {
  if (!thinkingEl) return;
  if (opts.hide) {
    thinkingEl.innerHTML = "";
    thinkingEl.hidden = true;
    thinkingEl.classList.remove("thinking-live");
    return;
  }
  thinkingEl.hidden = false;
  thinkingEl.classList.add("thinking-live");
  thinkingEl.innerHTML = buildThinkingHtml({
    phase: opts.phase,
    tools: opts.tools,
    thought: opts.thought,
  });
  // Job progress; recovery (if needed) lives in Menu → Jobs
  if (opts.jobId) {
    syncHeaderJobActions(opts.jobId, "running");
  }
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

function loadHistory(agentId = selectedAgentId) {
  try {
    const raw = localStorage.getItem(historyStorageKey(agentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory(agentId = selectedAgentId) {
  try {
    const key = historyStorageKey(agentId);
    // trim oldest until it fits
    let slice = history.slice(-MAX_HISTORY);
    for (let attempt = 0; attempt < 20; attempt++) {
      const json = JSON.stringify(slice);
      try {
        localStorage.setItem(key, json);
        if (historyAgentId(agentId) === historyAgentId(selectedAgentId)) {
          history = slice;
        }
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

  // Reply stream first; thinking status sits below it (typical AI chat layout)
  const body = document.createElement("div");
  body.className = "body";
  setBodyContent(body, text || "", role);
  el.appendChild(body);

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
        jobId: opts.jobId,
      });
    } else if (opts.jobStatus === "done" || opts.jobStatus === "error") {
      setThinking(thinkingEl, { hide: true });
    } else if (opts.tools) {
      setThinking(thinkingEl, {
        phase: "Working…",
        tools: opts.tools,
        jobId: opts.jobId,
      });
    } else {
      setThinking(thinkingEl, { hide: true });
    }
  }

  messages.appendChild(el);
  // New user messages pin to bottom; bot stream only follows if user is already there
  scrollBottom({ force: role === "user" || opts.forceScroll === true });

  // Job recovery lives in Menu → Jobs, not under each bubble
  if (role === "bot" && opts.jobId) {
    syncHeaderJobActions(opts.jobId, opts.jobStatus);
  }

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

  return { el, body, thinkingEl };
}

function isTerminalJobStatus(st) {
  return st === "done" || st === "error" || st === "cancelled";
}

/**
 * Find the bot message element for a job.
 * @param {string} jobId
 */
function findBotMsgEl(jobId) {
  if (!jobId || !messages) return null;
  return (
    messages.querySelector(`.msg.bot[data-job-id="${jobId}"]`) ||
    messages.querySelector(`.msg.bot[data-job-id='${jobId}']`)
  );
}

/**
 * Header no longer hosts job recovery buttons (jobs live in Menu).
 * Keep stubs so call sites stay simple / no-op.
 */
function syncHeaderJobActions(_jobId, _jobStatus) {
  /* no-op */
}

function clearHeaderJobActions() {
  /* no-op */
}

/** Hide any legacy per-message job-actions rows if present. */
function syncJobActions(msgEl, _jobId, _jobStatus) {
  if (msgEl) {
    const legacy = msgEl.querySelector(".job-actions");
    if (legacy) {
      legacy.classList.add("hidden");
      legacy.innerHTML = "";
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

/**
 * Tag the latest unmatched user + bot history rows with a jobId once the Mac
 * accepts the chat (prevents reconnect duplicates without jobId on user).
 * @param {string} jobId
 */
function attachJobIdToLatestPair(jobId) {
  if (!jobId) return;
  let botHit = false;
  let userHit = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!botHit && m.role === "bot" && !m.jobId) {
      m.jobId = jobId;
      if (!m.jobStatus) m.jobStatus = "running";
      botHit = true;
      continue;
    }
    if (botHit && !userHit && m.role === "user" && !m.jobId) {
      m.jobId = jobId;
      userHit = true;
      break;
    }
    if (botHit && m.role === "bot") break;
  }
  // Also stamp the live DOM bubbles
  const botEls = messages.querySelectorAll(".msg.bot:not([data-job-id])");
  const lastBot = botEls[botEls.length - 1];
  if (lastBot) lastBot.dataset.jobId = jobId;
  const userEls = messages.querySelectorAll(".msg.user:not([data-job-id])");
  const lastUser = userEls[userEls.length - 1];
  if (lastUser) lastUser.dataset.jobId = jobId;
  persistHistory();
}

function renderHistory() {
  messages.innerHTML = "";
  // stop old polls
  for (const [, p] of activePolls) clearInterval(p.timer);
  activePolls.clear();

  // Prefer in-memory history when already rehydrated from host (avoid clobber)
  if (!history.length) history = loadHistory();
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
    syncHeaderJobActions(jobId, job.status);
    return { toolsLine, imageUrls, reply };
  };

  const finishWithJob = (job) => {
    if (closed) return;
    applyJobToUi(job);
    setThinking(thinkingEl, { hide: true });
    syncHeaderJobActions(jobId, job.status);
    if (!(job.reply || "").trim() && !job.error) {
      setBodyContent(
        bodyEl,
        "_(No reply text received. Open Menu → Jobs, or send again.)_",
        "bot"
      );
    }
    // /clear or /new on Mac embeds this marker — wipe phone history to match
    const reply = job.reply || "";
    if (reply.includes("phone-clear-history")) {
      const keep = {
        role: "bot",
        text: reply.replace(/\n*<!--\s*phone-clear-history\s*-->\s*/g, "\n").trim(),
        jobId,
        jobStatus: job.status || "done",
      };
      clearLocalChatHistory();
      history = [keep];
      persistHistory();
      renderHistory();
      // pull new conversationId from host
      void loadHostConversation().then((host) => {
        if (host?.conversationId) setStoredConversationId(host.conversationId);
      });
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
      jobId,
    });
    syncHeaderJobActions(jobId, job.status);
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
        // Job is gone on the Mac
        syncHeaderJobActions(jobId, "error");
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
  syncHeaderJobActions(jobId, "running");
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
    if (host) {
      if (Array.isArray(host.activeJobs)) knownJobs = host.activeJobs;
      if (Array.isArray(host.agents)) knownAgents = host.agents;
      const prevLen = history.length;
      const prevId = getStoredConversationId();
      applyHostConversation(host);
      if (
        history.length !== prevLen ||
        host.conversationId !== prevId ||
        (host.messages || []).length !== prevLen
      ) {
        renderHistory();
      }
      reattachActiveJobs(jobsForSelectedAgent(host.activeJobs || knownJobs));
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

// ── Left menu: agents + jobs (Activity) ─────────────────────────────────────

/**
 * Switch the active session: saves current chat, loads that agent's history.
 * Tap an agent card to call this (no separate "Send here" button).
 * @param {string} id
 * @param {{ closeMenu?: boolean }} [opts]
 */
function setSelectedAgentId(id, opts = {}) {
  const next = historyAgentId(
    normalizeSelectedAgentId(knownAgents, id || "main")
  );
  const prev = historyAgentId(selectedAgentId);
  if (next === prev) {
    updateAgentChip();
    if (activityOpen) renderActivityAgents();
    if (opts.closeMenu) closeActivityMenu();
    return;
  }

  // Persist outgoing session, then load the new one
  persistHistory(prev);
  for (const [jobId] of activePolls) stopJobPoll(jobId);
  clearHeaderJobActions();

  selectedAgentId = next;
  try {
    localStorage.setItem(SELECTED_AGENT_KEY, selectedAgentId);
  } catch {
    /* ignore */
  }

  history = loadHistory(next);
  // Rehydrate unfinished jobs for this agent into the transcript
  const agentJobs = jobsForSelectedAgent(knownJobs);
  history = ensureActiveJobBotMessages(history, agentJobs);
  renderHistory();
  reattachActiveJobs(agentJobs);
  updateAgentChip();
  if (activityOpen) renderActivityAgents();
  if (opts.closeMenu !== false) closeActivityMenu();
}

function updateAgentChip() {
  if (!agentChip || !agentChipBar) return;
  const id = normalizeSelectedAgentId(knownAgents, selectedAgentId);
  if (id !== selectedAgentId) selectedAgentId = id;
  const agent = knownAgents.find((a) => a.id === id);
  const label =
    id === "auto"
      ? "Auto (idle)"
      : agent?.label || (id === "main" ? "Main" : id.slice(0, 8));
  agentChip.textContent = label;
  const busy =
    !!agent && (agent.processing || !!agent.currentJobId || (agent.queueLength || 0) > 0);
  agentChip.classList.toggle("busy", busy);
  // Show chip when chat is visible
  const show = chat && chat.classList.contains("active");
  agentChipBar.classList.toggle("hidden", !show);
}

function updateMenuBadge() {
  if (!menuBadge) return;
  // Only when an agent finished a turn and is idle / ready for the user
  // (not while working, not "you have N agents")
  const n = activityBadgeCount(knownJobs, knownAgents, {
    selectedAgentId: historyAgentId(selectedAgentId),
  });
  if (n > 0) {
    menuBadge.textContent = n > 99 ? "99+" : String(n);
    menuBadge.classList.remove("hidden");
    menuBadge.setAttribute("aria-hidden", "false");
  } else {
    menuBadge.textContent = "0";
    menuBadge.classList.add("hidden");
    menuBadge.setAttribute("aria-hidden", "true");
  }
}

function openActivityMenu() {
  if (!activityDrawer) return;
  activityOpen = true;
  activityDrawer.classList.remove("hidden");
  activityDrawer.setAttribute("aria-hidden", "false");
  if (menuBtn) menuBtn.setAttribute("aria-expanded", "true");
  syncVoiceTriggerForm({ clearStatus: true });
  void refreshActivity({ force: true });
}

function closeActivityMenu() {
  if (!activityDrawer) return;
  activityOpen = false;
  activityDrawer.classList.add("hidden");
  activityDrawer.setAttribute("aria-hidden", "true");
  if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
}

function toggleActivityMenu() {
  if (activityOpen) closeActivityMenu();
  else openActivityMenu();
}

function startActivityPoll() {
  stopActivityPoll();
  activityPollTimer = setInterval(() => {
    void refreshActivity({ quiet: true });
  }, ACTIVITY_POLL_MS);
  void refreshActivity({ quiet: true });
}

function stopActivityPoll() {
  if (activityPollTimer) {
    clearInterval(activityPollTimer);
    activityPollTimer = null;
  }
}

/**
 * Fetch agents + jobs from the Mac. Updates badge always; full list when menu open.
 * @param {{ quiet?: boolean, force?: boolean }} [opts]
 */
async function refreshActivity(opts = {}) {
  const secret = getSecret();
  if (!secret) return;
  if (activityBusy && !opts.force) return;
  activityBusy = true;
  try {
    const res = await fetch("/api/jobs", {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    if (!res.ok) return;
    const j = await res.json();
    knownJobs = Array.isArray(j.jobs) ? j.jobs : [];
    knownAgents = Array.isArray(j.agents) ? j.agents : knownAgents;
    const nextSel = historyAgentId(
      normalizeSelectedAgentId(knownAgents, selectedAgentId)
    );
    // Agent was removed on Mac — fall back to main and swap chat history
    if (nextSel !== historyAgentId(selectedAgentId)) {
      setSelectedAgentId(nextSel, { closeMenu: false });
    } else {
      selectedAgentId = nextSel;
      updateMenuBadge();
      updateAgentChip();
    }
    if (activityOpen || opts.force) {
      renderActivityAgents();
      renderActivityJobs();
    }
  } catch {
    /* offline — leave last snapshot */
  } finally {
    activityBusy = false;
  }
}

function renderActivityAgents() {
  if (!activityAgents) return;
  activityAgents.innerHTML = "";
  const list = knownAgents.length
    ? knownAgents
    : [{ id: "main", label: "Main", isMain: true, alive: false }];
  const currentId = historyAgentId(selectedAgentId);
  for (const agent of list) {
    const isSelected = historyAgentId(agent.id) === currentId;
    const card = document.createElement("div");
    card.className = "activity-card selectable" + (isSelected ? " selected" : "");
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.setAttribute(
      "aria-label",
      isSelected
        ? `${agent.label || "Main"} — current session`
        : `Switch to ${agent.label || agent.id}`
    );
    card.onclick = (e) => {
      // Ignore clicks on action buttons (Stop)
      if (e.target.closest(".activity-action")) return;
      setSelectedAgentId(agent.id, { closeMenu: true });
    };
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSelectedAgentId(agent.id, { closeMenu: true });
      }
    };

    const top = document.createElement("div");
    top.className = "activity-card-top";
    const title = document.createElement("div");
    title.className = "activity-card-title";
    const dot = document.createElement("span");
    dot.className = `activity-dot ${agentDotKind(agent)}`;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = agent.label || (agent.isMain ? "Main" : agent.id.slice(0, 8));
    title.append(dot, name);
    top.appendChild(title);
    if (isSelected) {
      const pill = document.createElement("span");
      pill.className = "activity-pill running";
      pill.textContent = "Current";
      top.appendChild(pill);
    }

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    const pid = agent.pid ? ` · pid ${agent.pid}` : "";
    meta.textContent = `${agentStatusLine(agent)}${pid}`;

    const actions = document.createElement("div");
    actions.className = "activity-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "activity-action";
    renameBtn.textContent = "Rename";
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      void renameAgentFromMenu(agent);
    };
    actions.appendChild(renameBtn);

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "activity-action danger";
    stopBtn.textContent = agent.isMain ? "Stop & reset" : "Stop & close";
    stopBtn.onclick = (e) => {
      e.stopPropagation();
      void stopAgentFromMenu(agent);
    };
    actions.appendChild(stopBtn);

    card.append(top, meta, actions);
    activityAgents.appendChild(card);
  }
}

function renderActivityJobs() {
  if (!activityJobs) return;
  activityJobs.innerHTML = "";
  const { active, recent } = partitionJobs(knownJobs);
  if (!active.length && !recent.length) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = "No jobs yet.";
    activityJobs.appendChild(empty);
    return;
  }
  if (active.length) {
    const head = document.createElement("div");
    head.className = "activity-subhead";
    head.textContent = "Active";
    activityJobs.appendChild(head);
    for (const job of active) activityJobs.appendChild(jobCard(job));
  }
  if (recent.length) {
    const head = document.createElement("div");
    head.className = "activity-subhead";
    head.textContent = "Recent";
    activityJobs.appendChild(head);
    for (const job of recent) activityJobs.appendChild(jobCard(job));
  }
}

function jobCard(job) {
  const card = document.createElement("div");
  card.className = "activity-card";

  const top = document.createElement("div");
  top.className = "activity-card-top";
  const title = document.createElement("div");
  title.className = "activity-card-title";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = job.agentLabel || job.agentId || "Main";
  title.appendChild(name);
  const pill = document.createElement("span");
  pill.className = `activity-pill ${job.status || ""}`;
  pill.textContent = jobStatusLabel(job);
  top.append(title, pill);

  const preview = document.createElement("div");
  preview.className = "activity-preview";
  preview.textContent = jobPreviewText(job);

  card.append(top, preview);

  if (jobIsActive(job)) {
    const actions = document.createElement("div");
    actions.className = "activity-actions";

    const stopShow = document.createElement("button");
    stopShow.type = "button";
    stopShow.className = "activity-action primary";
    stopShow.textContent = "Stop & show";
    stopShow.onclick = () => void finalizeJobFromMenu(job.id);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "activity-action danger";
    cancel.textContent = "Cancel";
    cancel.onclick = () => void cancelJobFromMenu(job.id);

    actions.append(stopShow, cancel);
    card.appendChild(actions);
  }

  return card;
}

async function spawnAgentFromMenu() {
  const secret = getSecret();
  if (!secret) {
    showGate();
    return;
  }
  const name = window.prompt("Name for the new agent (optional):", "");
  // Cancel on prompt cancel — do not spawn
  if (name === null) return;

  if (activitySpawn) activitySpawn.disabled = true;
  try {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        label: String(name || "").trim() || undefined,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    if (Array.isArray(j.agents)) knownAgents = j.agents;
    else if (j.agent) {
      knownAgents = [
        ...knownAgents.filter((a) => a.id !== j.agent.id),
        j.agent,
      ];
    }
    // Switch into the new agent session (its own empty chat history)
    if (j.agent?.id) {
      setSelectedAgentId(j.agent.id, { closeMenu: true });
    } else {
      updateMenuBadge();
      renderActivityAgents();
      updateAgentChip();
    }
  } catch (e) {
    alert(`Could not start agent: ${e.message || e}`);
  } finally {
    if (activitySpawn) activitySpawn.disabled = false;
  }
}

/**
 * Rename main or an extra agent (Mac registry label).
 * @param {{ id: string, label?: string, isMain?: boolean }} agent
 */
async function renameAgentFromMenu(agent) {
  const secret = getSecret();
  if (!secret || !agent?.id) return;
  const current =
    agent.label || (agent.isMain ? "Main" : agent.id.slice(0, 8));
  const next = window.prompt("Rename agent:", current);
  if (next === null) return; // cancelled
  const label = String(next).trim();
  if (!label) {
    alert("Name can’t be empty.");
    return;
  }
  if (label === current) return;
  try {
    const res = await fetch(
      `/api/agents/${encodeURIComponent(agent.id)}/rename`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label }),
      }
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    if (Array.isArray(j.agents)) knownAgents = j.agents;
    else if (j.agent) {
      knownAgents = knownAgents.map((a) =>
        a.id === j.agent.id ? { ...a, ...j.agent } : a
      );
    }
    updateAgentChip();
    renderActivityAgents();
    // Jobs list shows agentLabel from last poll — refresh for new names
    void refreshActivity({ force: true });
  } catch (e) {
    alert(`Rename failed: ${e.message || e}`);
  }
}

/**
 * Hard-stop agent on the Mac (cancels jobs + kills process / process group).
 * Extras are removed; main is reset.
 */
async function stopAgentFromMenu(agent) {
  const secret = getSecret();
  if (!secret || !agent?.id) return;
  const label = agent.label || agent.id;
  const msg = agent.isMain
    ? `Stop & reset Main on the Mac?\n\nCancels Main's jobs and restarts the agent process.`
    : `Stop & close "${label}" on the Mac?\n\nCancels its jobs and kills the process (including child shells).`;
  if (!confirm(msg)) return;
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ remove: !agent.isMain }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    if (Array.isArray(j.agents)) knownAgents = j.agents;
    // Drop local history for a removed extra agent
    if (!agent.isMain) {
      try {
        localStorage.removeItem(historyStorageKey(agent.id));
        localStorage.removeItem(conversationStorageKey(agent.id));
      } catch {
        /* ignore */
      }
    }
    if (historyAgentId(selectedAgentId) === historyAgentId(agent.id)) {
      if (agent.isMain) {
        // Main reset — clear main chat on phone
        clearLocalChatHistory();
        history = [];
        renderHistory();
      } else {
        setSelectedAgentId("main", { closeMenu: false });
      }
    }
    // Drop local polls for jobs on this agent
    for (const job of knownJobs) {
      if (
        historyAgentId(job.agentId || "main") === historyAgentId(agent.id) &&
        jobIsActive(job)
      ) {
        stopJobPoll(job.id);
      }
    }
    await refreshActivity({ force: true });
  } catch (e) {
    alert(`Stop failed: ${e.message || e}`);
  }
}

async function cancelJobFromMenu(jobId) {
  const secret = getSecret();
  if (!secret || !jobId) return;
  if (!confirm("Cancel this job on the Mac?\n\nStops work and frees the agent queue.")) {
    return;
  }
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    stopJobPoll(jobId);
    // Update chat bubble if present
    const msgEl = messages?.querySelector(`.msg.bot[data-job-id="${jobId}"]`);
    const bodyEl = msgEl?.querySelector(".body");
    const thinkingEl = msgEl?.querySelector(".thinking");
    if (thinkingEl) setThinking(thinkingEl, { hide: true });
    if (bodyEl) {
      setBodyContent(bodyEl, j.reply || "_(cancelled)_", "bot");
    }
    clearHeaderJobActions();
    await refreshActivity({ force: true });
  } catch (e) {
    alert(`Cancel failed: ${e.message || e}`);
  }
}

async function finalizeJobFromMenu(jobId) {
  const secret = getSecret();
  if (!secret || !jobId) return;
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/finalize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    stopJobPoll(jobId);
    const msgEl = messages?.querySelector(`.msg.bot[data-job-id="${jobId}"]`);
    const bodyEl = msgEl?.querySelector(".body");
    const thinkingEl = msgEl?.querySelector(".thinking");
    if (thinkingEl) setThinking(thinkingEl, { hide: true });
    if (bodyEl) {
      setBodyContent(bodyEl, j.reply || "_(Stopped — no reply yet.)_", "bot");
    }
    clearHeaderJobActions();
    await refreshActivity({ force: true });
  } catch (e) {
    alert(`Stop failed: ${e.message || e}`);
  }
}

function cycleSendTarget() {
  const ids = knownAgents.map((a) => a.id);
  if (!ids.length) ids.push("main");
  const cur = historyAgentId(selectedAgentId);
  const idx = ids.findIndex((id) => historyAgentId(id) === cur);
  const next = ids[(idx + 1) % ids.length] || "main";
  setSelectedAgentId(next, { closeMenu: false });
}

if (menuBtn) menuBtn.onclick = () => toggleActivityMenu();
if (activityClose) activityClose.onclick = () => closeActivityMenu();
if (activityBackdrop) activityBackdrop.onclick = () => closeActivityMenu();
if (activitySpawn) activitySpawn.onclick = () => void spawnAgentFromMenu();
if (activityRefresh) activityRefresh.onclick = () => void refreshActivity({ force: true });
if (voiceTriggerSave) voiceTriggerSave.onclick = () => saveVoiceTriggerFromForm();
if (voiceTriggerReset) voiceTriggerReset.onclick = () => resetVoiceTriggerForm();
if (voiceTriggerInput) {
  voiceTriggerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveVoiceTriggerFromForm();
      voiceTriggerInput.blur();
    }
  });
}
if (agentChip) agentChip.onclick = () => {
  if (knownAgents.length > 1) cycleSendTarget();
  else openActivityMenu();
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activityOpen) {
    e.preventDefault();
    closeActivityMenu();
  }
});

async function checkStatus() {
  const secret = getSecret();
  if (!secret) {
    setConn("locked", "bad");
    stopActivityPoll();
    return false;
  }
  try {
    const res = await fetch("/api/status", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) {
      setConn("auth failed", "bad");
      stopActivityPoll();
      return false;
    }
    const j = await res.json();
    freeHttpsMicUrl = buildFreeHttpsMicUrl(j, window.location);
    if (Array.isArray(j.agents)) {
      knownAgents = j.agents;
      selectedAgentId = normalizeSelectedAgentId(knownAgents, selectedAgentId);
      updateAgentChip();
      updateMenuBadge();
    }
    setConn(j.agentReady ? "connected" : "starting…", j.agentReady ? "ok" : "");
    startActivityPoll();
    return true;
  } catch {
    setConn("offline", "bad");
    stopActivityPoll();
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

/**
 * Apply host conversation as source of truth for the **main** agent only.
 * Extra concurrent agents keep phone-local histories (unique per agent).
 * @param {object} host
 */
function applyHostConversation(host) {
  if (!host) return;
  const aid = historyAgentId(selectedAgentId);
  const agentJobs = (host.activeJobs || []).filter(
    (j) => historyAgentId(j.agentId || "main") === aid
  );

  // Non-main sessions: phone-local history only + rehydrate this agent's jobs
  if (aid !== "main") {
    history = loadHistory(aid);
    history = ensureActiveJobBotMessages(history, agentJobs);
    persistHistory(aid);
    return;
  }

  const hostId = host.conversationId || "";
  const prevId = getStoredConversationId("main");
  const hostMsgs = Array.isArray(host.messages) ? host.messages : [];
  const epochChanged = !!(hostId && prevId && hostId !== prevId);
  const freshEpoch = !!(hostId && !prevId && host.clearedAt);

  if (epochChanged || freshEpoch) {
    // Mac started a new conversation — discard local copy
    history = mergeHostHistory([], hostMsgs, MAX_HISTORY);
  } else if (hostMsgs.length || agentJobs.length) {
    history = mergeHostHistory(loadHistory("main"), hostMsgs, MAX_HISTORY);
  } else if (hostId && host.clearedAt) {
    // Explicit empty transcript after clear
    history = [];
  } else {
    history = loadHistory("main");
  }

  // Host transcript is main-only. Drop leftover extra-agent turns that
  // previously leaked into the main localStorage bucket.
  history = dropForeignJobTurns(history, hostMsgs, agentJobs);

  history = ensureActiveJobBotMessages(history, agentJobs);
  if (hostId) setStoredConversationId(hostId, "main");
  persistHistory("main");
}

async function showChat() {
  gate.classList.add("hidden");
  chat.classList.add("active");
  // Host-backed history first for main; extras use per-agent localStorage
  const host = await loadHostConversation();
  if (Array.isArray(host?.agents)) {
    knownAgents = host.agents;
    selectedAgentId = historyAgentId(
      normalizeSelectedAgentId(knownAgents, selectedAgentId)
    );
  }
  if (Array.isArray(host?.activeJobs)) {
    knownJobs = host.activeJobs;
  }
  if (host) applyHostConversation(host);
  else history = loadHistory();
  renderHistory();
  reattachActiveJobs(
    (host?.activeJobs || []).filter(
      (j) =>
        historyAgentId(j.agentId || "main") === historyAgentId(selectedAgentId)
    )
  );
  updateAgentChip();
  checkStatus();
  startActivityPoll();
}

function showGate() {
  chat.classList.remove("active");
  gate.classList.remove("hidden");
  stopActivityPoll();
  closeActivityMenu();
  if (agentChipBar) agentChipBar.classList.add("hidden");
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
      await maybeAutoStartMicFromQuery();
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

// ── Voice dictation (speech → text) ─────────────────────────────────────────
// iOS home-screen PWAs do NOT expose webkitSpeechRecognition. Primary path:
// MediaRecorder → POST /api/dictation → Mac Speech / whisper. Fallback: Web Speech.

/** @type {SpeechRecognition | null} */
let speechRec = null;
/** @type {MediaRecorder | null} */
let mediaRecorder = null;
/** @type {MediaStream | null} */
let mediaStream = null;
/** @type {Blob[]} */
let mediaChunks = [];
/** "browser" | "server" | null */
let dictationMode = null;
let dictationActive = false;
let dictationBase = "";
/** @type {string[]} */
let dictationFinals = [];
let dictationResultIndex = 0;
let dictationWantListening = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let dictationRestartTimer = null;
let dictationUploading = false;

function setDictationHint(text, live = false) {
  if (!dictationHint) return;
  if (!text) {
    dictationHint.textContent = "";
    dictationHint.classList.add("hidden");
    dictationHint.classList.remove("live");
    return;
  }
  dictationHint.textContent = text;
  dictationHint.classList.remove("hidden");
  dictationHint.classList.toggle("live", !!live);
}

function resizeComposerInput() {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
}

function applyDictationToInput(interim = "") {
  if (!input) return;
  input.value = mergeDictationText(dictationBase, dictationFinals, interim);
  resizeComposerInput();
  try {
    const n = input.value.length;
    input.setSelectionRange(n, n);
  } catch {
    /* ignore */
  }
}

/** Spoken send triggers (localStorage override: JSON string array). */
function getSendTriggers() {
  try {
    const raw = localStorage.getItem(SEND_TRIGGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const list = parsed.map(String).filter(Boolean);
        if (list.length) return list;
      }
      // Plain string from older hand-edits
      if (typeof parsed === "string" && parsed.trim()) {
        return parseSendTriggerInput(parsed);
      }
    }
  } catch {
    /* ignore */
  }
  return [...DEFAULT_SEND_TRIGGERS];
}

/** First phrase — used in listening hints. */
function getPrimarySendPhrase() {
  return primarySendTrigger(getSendTriggers());
}

/**
 * Persist send phrases on this device.
 * @param {string[]} triggers
 * @returns {string[]}
 */
function setSendTriggers(triggers) {
  const list = parseSendTriggerInput(
    Array.isArray(triggers) ? triggers.join(", ") : String(triggers || "")
  );
  try {
    localStorage.setItem(SEND_TRIGGER_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota */
  }
  return list;
}

function clearSendTriggersToDefault() {
  try {
    localStorage.removeItem(SEND_TRIGGER_KEY);
  } catch {
    /* ignore */
  }
  return [...DEFAULT_SEND_TRIGGERS];
}

/**
 * @param {{ clearStatus?: boolean }} [opts]
 */
function syncVoiceTriggerForm(opts = {}) {
  if (!voiceTriggerInput) return;
  voiceTriggerInput.value = formatSendTriggersForInput(getSendTriggers());
  if (opts.clearStatus && voiceTriggerStatus) {
    voiceTriggerStatus.textContent = "";
    voiceTriggerStatus.classList.remove("is-error");
  }
}

/**
 * @param {string} msg
 * @param {boolean} [isError]
 */
function setVoiceTriggerStatus(msg, isError = false) {
  if (!voiceTriggerStatus) return;
  voiceTriggerStatus.textContent = msg || "";
  voiceTriggerStatus.classList.toggle("is-error", Boolean(isError && msg));
}

function saveVoiceTriggerFromForm() {
  if (!voiceTriggerInput) return;
  const list = setSendTriggers(voiceTriggerInput.value);
  voiceTriggerInput.value = formatSendTriggersForInput(list);
  const primary = primarySendTrigger(list);
  setVoiceTriggerStatus(`Saved — say “${primary}” to send`);
}

function resetVoiceTriggerForm() {
  const list = clearSendTriggersToDefault();
  if (voiceTriggerInput) {
    voiceTriggerInput.value = formatSendTriggersForInput(list);
  }
  setVoiceTriggerStatus(`Default — “${primarySendTrigger(list)}”`);
}

/**
 * If finalized speech ends with a send trigger, strip it and auto-send.
 * Only uses finals (not pure interim) to avoid sending on half-heard "send…".
 * @param {boolean} [allowInterim=false]
 */
function maybeAutoSendFromSpeech(allowInterim = false) {
  if (autoSendInFlight || !input) return false;
  const finalsText = mergeDictationText(dictationBase, dictationFinals, "");
  let hit = matchSendTrigger(finalsText, getSendTriggers());
  if (!hit?.autoSend && allowInterim) {
    const full = mergeDictationText(dictationBase, dictationFinals, "");
    // also check current input (includes interim after apply)
    hit = matchSendTrigger(input.value, getSendTriggers());
    // Prefer not interim-only unless finals empty and full ends with trigger
    if (hit?.autoSend && !finalsText.trim()) {
      // wait for finalization
      return false;
    }
  }
  if (!hit?.autoSend) return false;
  void autoSendFromDictation(hit.message, hit.trigger);
  return true;
}

/**
 * Stop listening, put cleaned text in the box, send.
 * @param {string} message
 * @param {string} [trigger]
 */
async function autoSendFromDictation(message, trigger) {
  if (autoSendInFlight) return;
  const text = String(message || "").trim();
  if (!text) {
    setDictationHint(
      trigger
        ? `Heard “${trigger}” but nothing to send.`
        : "Nothing to send."
    );
    return;
  }
  autoSendInFlight = true;
  try {
    dictationWantListening = false;
    clearDictationRestart();
    stopDictation({ keepHint: true });
    if (input) {
      input.value = text;
      resizeComposerInput();
      clearDictationDraftUi();
    }
    setDictationHint(
      trigger ? `Sending (heard “${trigger}”)…` : "Sending…",
      true
    );
    await send();
    setDictationHint("Sent.");
    setTimeout(() => {
      if (!dictationActive) setDictationHint("");
    }, 1500);
  } catch (e) {
    setDictationHint(e?.message ? `Send failed: ${e.message}` : "Send failed.");
  } finally {
    autoSendInFlight = false;
  }
}

/**
 * Put transcribed words into the composer as a draft — never auto-sends.
 * Highlights the new text so you can review/edit before tapping ↑.
 * @param {string} text
 */
function appendTranscriptToInput(text) {
  if (!input) return;
  const t = String(text || "").trim();
  if (!t) return;
  const before = input.value || "";
  const next = buildComposerDraft(before, t);
  const trimmedBefore = String(before).replace(/\s+$/u, "");
  const start = trimmedBefore.length ? trimmedBefore.length + 1 : 0;
  input.value = next;
  resizeComposerInput();
  // Mark as draft ready (visible ring) so it's obvious this is pre-send
  input.classList.add("dictation-draft");
  try {
    input.focus({ preventScroll: true });
  } catch {
    try {
      input.focus();
    } catch {
      /* ignore */
    }
  }
  try {
    // Select just the new words so you can read / retype / keep them
    input.setSelectionRange(start, input.value.length);
  } catch {
    /* ignore */
  }
  // Soften highlight after a moment so you can keep typing
  setTimeout(() => {
    try {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } catch {
      /* ignore */
    }
  }, 2200);
}

function clearDictationDraftUi() {
  input?.classList.remove("dictation-draft");
}

function setMicUi(listening) {
  dictationActive = !!listening;
  if (!micBtn) return;
  micBtn.classList.toggle("mic-listening", dictationActive);
  micBtn.setAttribute("aria-pressed", dictationActive ? "true" : "false");
  micBtn.setAttribute(
    "aria-label",
    dictationActive ? "Stop dictation" : "Dictate"
  );
  micBtn.title = dictationActive
    ? "Listening… tap to stop"
    : "Dictate with your voice";
}

function clearDictationRestart() {
  if (dictationRestartTimer) {
    clearTimeout(dictationRestartTimer);
    dictationRestartTimer = null;
  }
}

function detachSpeechRec() {
  if (!speechRec) return;
  try {
    speechRec.onstart = null;
    speechRec.onresult = null;
    speechRec.onerror = null;
    speechRec.onend = null;
  } catch {
    /* ignore */
  }
  speechRec = null;
}

function stopMediaTracks() {
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    mediaStream = null;
  }
}

function stopDictation({ keepHint = false } = {}) {
  dictationWantListening = false;
  clearDictationRestart();

  if (mediaRecorder && (dictationMode === "server" || mediaRecorder.state !== "inactive")) {
    const rec = mediaRecorder;
    // onstop handler uploads + clears tracks
    if (rec.state === "recording" || rec.state === "paused") {
      try {
        rec.stop();
      } catch {
        stopMediaTracks();
        mediaRecorder = null;
        dictationMode = null;
        setMicUi(false);
      }
    } else {
      stopMediaTracks();
      mediaRecorder = null;
      dictationMode = null;
      setMicUi(false);
    }
  } else {
    const rec = speechRec;
    detachSpeechRec();
    try {
      rec?.stop?.();
    } catch {
      /* ignore */
    }
    dictationMode = null;
    setMicUi(false);
  }

  if (!keepHint && !dictationUploading) setDictationHint("");
}

function promoteDictationBaseFromInput() {
  dictationBase = (input?.value || "").replace(/\s+$/u, "");
  dictationFinals = [];
  dictationResultIndex = 0;
}

// ── Server path (MediaRecorder → Mac) — works in iOS PWA ───────────────────

async function uploadDictationBlob(blob) {
  const secret = getSecret();
  if (!secret) {
    showGate();
    return;
  }
  if (!blob || !blob.size) {
    setDictationHint("No audio captured. Tap mic and try again.");
    return;
  }
  dictationUploading = true;
  setDictationHint("Transcribing on Mac…", true);
  try {
    const locale =
      (typeof navigator !== "undefined" && navigator.language) || "en-US";
    const res = await fetch(
      `/api/dictation?locale=${encodeURIComponent(locale)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": blob.type || "application/octet-stream",
        },
        body: blob,
      }
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(j.error || res.statusText || String(res.status));
    }
    const text = String(j.text || "").trim();
    if (!text) {
      setDictationHint("Heard nothing — try again a bit louder.");
      return;
    }
    // Land in composer; auto-send if transcript ends with a send trigger
    appendTranscriptToInput(text);
    const hit = matchSendTrigger(input?.value || "", getSendTriggers());
    if (hit?.autoSend) {
      void autoSendFromDictation(hit.message, hit.trigger);
    } else {
      setDictationHint(
        `Draft ready — tap ↑, or next time say “${getPrimarySendPhrase()}” while dictating.`
      );
    }
  } catch (e) {
    setDictationHint(
      e?.message
        ? `Dictation failed: ${e.message}`
        : "Dictation failed. Is the Mac bridge running?"
    );
  } finally {
    dictationUploading = false;
  }
}

async function requestMicStream() {
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
    video: false,
  };
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    return md.getUserMedia(constraints);
  }
  // Very old prefixes (unlikely on modern iOS)
  const legacy =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia;
  if (typeof legacy === "function") {
    return new Promise((resolve, reject) => {
      legacy.call(navigator, constraints, resolve, reject);
    });
  }
  const err = new Error(
    "getUserMedia missing — open this app over HTTPS (not plain http://)."
  );
  err.name = "NotSupportedError";
  throw err;
}

async function startServerDictation() {
  if (!isSecureDictationContext()) {
    // Auto-record needs free HTTPS — jump there if we know the URL
    if (!freeHttpsMicUrl) await refreshFreeHttpsMicUrl();
    if (freeHttpsMicUrl && navigateToFreeHttpsAutoMic()) return;
    setDictationHint(
      "Live auto-record needs free HTTPS on the Mac bridge. Restart npm start (openssl), or use Keyboard dictate."
    );
    openDictationSheet();
    return;
  }
  hideSlashMenu();
  closeDictationSheet();
  setMicUi(true);
  // getUserMedia must be among the first awaits after the tap (iOS gesture)
  setDictationHint("Listening… tap mic again when done.", true);

  try {
    mediaStream = await requestMicStream();
  } catch (e) {
    setMicUi(false);
    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      setDictationHint(speechRecognitionErrorMessage("not-allowed"));
    } else if (name === "NotFoundError") {
      setDictationHint(speechRecognitionErrorMessage("audio-capture"));
    } else if (
      name === "NotSupportedError" ||
      name === "TypeError" ||
      /getUserMedia|mediaDevices/i.test(String(e?.message || ""))
    ) {
      setDictationHint(speechRecognitionErrorMessage("insecure-context"));
    } else {
      setDictationHint(
        e?.message
          ? `Mic error: ${e.message}`
          : "Could not open microphone."
      );
    }
    return;
  }

  mediaChunks = [];
  const mime = pickAudioRecorderMime();
  let rec;
  try {
    rec = mime
      ? new MediaRecorder(mediaStream, { mimeType: mime })
      : new MediaRecorder(mediaStream);
  } catch {
    try {
      rec = new MediaRecorder(mediaStream);
    } catch (e2) {
      stopMediaTracks();
      setMicUi(false);
      setDictationHint(
        e2?.message
          ? `Recorder error: ${e2.message}`
          : "MediaRecorder not available."
      );
      return;
    }
  }

  mediaRecorder = rec;
  dictationMode = "server";
  dictationWantListening = true;

  rec.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) mediaChunks.push(ev.data);
  };

  rec.onerror = () => {
    setDictationHint("Recording error. Try again.");
  };

  rec.onstop = () => {
    const type = rec.mimeType || mime || "audio/webm";
    const blob = new Blob(mediaChunks, { type });
    mediaChunks = [];
    mediaRecorder = null;
    stopMediaTracks();
    setMicUi(false);
    dictationMode = null;
    dictationWantListening = false;
    void uploadDictationBlob(blob);
  };

  try {
    // timeslice helps some iOS builds flush data
    rec.start(250);
    setDictationHint(
      "Recording… tap mic again to stop — text appears to review before send.",
      true
    );
  } catch (e) {
    stopMediaTracks();
    mediaRecorder = null;
    dictationMode = null;
    dictationWantListening = false;
    setMicUi(false);
    setDictationHint(
      e?.message ? `Could not record: ${e.message}` : "Could not start recorder."
    );
  }
}

// ── Browser Web Speech path (Chrome / some Safari tabs — not iOS PWA) ───────

function createSpeechRecognition() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = preferContinuousRecognition();
  rec.interimResults = true;
  try {
    rec.maxAlternatives = 1;
  } catch {
    /* ignore */
  }
  rec.lang =
    (typeof navigator !== "undefined" && navigator.language) || "en-US";

  rec.onstart = () => {
    setMicUi(true);
    setDictationHint(
      `Listening… say “${getPrimarySendPhrase()}” to send, or tap mic to stop.`,
      true
    );
  };

  rec.onresult = (ev) => {
    // REPLACE session finals every event (full scan). Do not push + cursor past
    // interim — that dropped finalized words when the next interim arrived.
    const { finals, interim } = consumeRecognitionResults(ev);
    dictationFinals = finals;
    dictationResultIndex = finals.length;
    applyDictationToInput(interim);
    // Auto-send only when trigger is in finalized speech (stable)
    maybeAutoSendFromSpeech(false);
  };

  rec.onerror = (ev) => {
    const code = ev?.error || "";
    if (code === "aborted" || (code === "no-speech" && dictationWantListening)) {
      return;
    }
    const msg = speechRecognitionErrorMessage(code);
    if (msg) setDictationHint(msg, false);
    if (
      code === "not-allowed" ||
      code === "service-not-allowed" ||
      code === "audio-capture"
    ) {
      dictationWantListening = false;
      clearDictationRestart();
      setMicUi(false);
    }
  };

  rec.onend = () => {
    promoteDictationBaseFromInput();
    // Catch trigger that landed on last final of the segment
    if (maybeAutoSendFromSpeech(false)) return;
    if (!dictationWantListening) {
      setMicUi(false);
      return;
    }
    clearDictationRestart();
    const delay = isAppleMobileSpeech() ? 280 : 120;
    dictationRestartTimer = setTimeout(() => {
      dictationRestartTimer = null;
      if (!dictationWantListening) return;
      beginBrowserRecognitionSession();
    }, delay);
  };

  return rec;
}

function beginBrowserRecognitionSession() {
  if (!dictationWantListening) return;
  detachSpeechRec();
  const rec = createSpeechRecognition();
  if (!rec) {
    dictationWantListening = false;
    setMicUi(false);
    // Fall back to record→Mac only if live STT API is missing
    if (isMediaRecorderDictationSupported() || hasGetUserMedia()) {
      setDictationHint("Browser STT unavailable — using on-device recording…", true);
      void startServerDictation();
      return;
    }
    setDictationHint("Browser speech unavailable — try Keyboard dictate.");
    return;
  }
  speechRec = rec;
  dictationMode = "browser";
  try {
    speechRec.start();
    setMicUi(true);
    setDictationHint(
      `Listening… speak now. Say “${getPrimarySendPhrase()}” to send, or tap mic to stop.`,
      true
    );
  } catch (e) {
    if (e?.name === "InvalidStateError" && dictationWantListening) {
      setMicUi(true);
      return;
    }
    dictationWantListening = false;
    setMicUi(false);
    detachSpeechRec();
    if (isMediaRecorderDictationSupported() || hasGetUserMedia()) {
      void startServerDictation();
      return;
    }
    setDictationHint(
      e?.message
        ? `Could not start mic: ${e.message}`
        : "Could not start speech recognition."
    );
  }
}

async function startBrowserDictation() {
  if (!isSecureDictationContext()) {
    if (!freeHttpsMicUrl) await refreshFreeHttpsMicUrl();
    if (freeHttpsMicUrl && navigateToFreeHttpsAutoMic()) return;
    setDictationHint(speechRecognitionErrorMessage("insecure-context"));
    return;
  }
  hideSlashMenu();
  closeDictationSheet();
  promoteDictationBaseFromInput();
  dictationWantListening = true;
  dictationMode = "browser";
  setMicUi(true);
  setDictationHint(
    `Listening… words appear live. Say “${getPrimarySendPhrase()}” to send.`,
    true
  );
  beginBrowserRecognitionSession();
}

/**
 * Real iPhone speech-to-text via the system keyboard mic.
 * Works on plain http:// PWA — Apple’s own STT, words appear live in the box.
 */
function startKeyboardDictationMode() {
  closeDictationSheet();
  hideSlashMenu();
  clearDictationDraftUi();
  if (!input) return;
  input.classList.add("dictation-draft");
  try {
    input.focus({ preventScroll: false });
  } catch {
    try {
      input.focus();
    } catch {
      /* ignore */
    }
  }
  // Nudge keyboard open on iOS
  try {
    const len = input.value.length;
    input.setSelectionRange(len, len);
  } catch {
    /* ignore */
  }
  setDictationHint(
    "Keyboard speech-to-text: tap 🎤 on the iPhone keyboard and speak. Words appear here live — then ↑ to send.",
    true
  );
}

function startNativeAudioFileDictation() {
  closeDictationSheet();
  if (!fileAudio) {
    setDictationHint("Audio picker missing — hard-refresh the app.");
    return;
  }
  hideSlashMenu();
  setDictationHint(
    "Pick or record audio — Mac will turn it into text in the box.",
    true
  );
  fileAudio.click();
}

if (fileAudio) {
  fileAudio.onchange = async () => {
    const file = fileAudio.files && fileAudio.files[0];
    fileAudio.value = "";
    if (!file) {
      setDictationHint("");
      return;
    }
    setDictationHint("Transcribing on Mac…", true);
    try {
      await uploadDictationBlob(file);
    } catch (e) {
      setDictationHint(
        e?.message ? `Dictation failed: ${e.message}` : "Dictation failed."
      );
    }
  };
}

function openDictationSheet() {
  if (!dictationSheet) {
    startKeyboardDictationMode();
    return;
  }
  // Update HTTPS row
  if (dictationHttpsBtn) {
    if (freeHttpsMicUrl) {
      dictationHttpsBtn.disabled = false;
      dictationHttpsBtn.classList.remove("sheet-btn-disabled");
      const sub = dictationHttpsBtn.querySelector(".sheet-btn-sub");
      if (sub) {
        sub.textContent = `Open ${freeHttpsMicUrl} — free self-signed cert, no paid plan`;
      }
    } else {
      dictationHttpsBtn.disabled = true;
      const sub = dictationHttpsBtn.querySelector(".sheet-btn-sub");
      if (sub) {
        sub.textContent =
          "Restart Mac bridge with openssl for free HTTPS live mic";
      }
    }
  }
  dictationSheet.classList.remove("hidden");
  dictationSheet.setAttribute("aria-hidden", "false");
}

function closeDictationSheet() {
  if (!dictationSheet) return;
  dictationSheet.classList.add("hidden");
  dictationSheet.setAttribute("aria-hidden", "true");
}

/**
 * Jump to free self-signed HTTPS with automic=1 so recording starts on load.
 * @returns {boolean} true if navigation started
 */
function navigateToFreeHttpsAutoMic() {
  if (!freeHttpsMicUrl) return false;
  try {
    const url = new URL(freeHttpsMicUrl);
    url.searchParams.set("automic", "1");
    setDictationHint("Starting live mic…", true);
    window.location.href = url.toString();
    return true;
  } catch {
    return false;
  }
}

/**
 * One-tap dictation:
 * - HTTPS + Web Speech API → live browser STT (preferred — no Mac)
 * - HTTPS without Web Speech → record + Mac STT fallback
 * - HTTP → free HTTPS for live paths, else keyboard Apple STT
 */
async function startDictation() {
  if (dictationUploading) {
    setDictationHint("Still transcribing…");
    return;
  }

  // Toggle off (browser live or recording)
  if (dictationActive || dictationWantListening || mediaRecorder) {
    const wasServer = dictationMode === "server" || !!mediaRecorder;
    const wasBrowser = dictationMode === "browser";
    stopDictation({ keepHint: wasServer });
    if (wasServer) setDictationHint("Stopping…", true);
    else if (wasBrowser) {
      setDictationHint(
        input?.value?.trim()
          ? "Draft ready — edit, then tap ↑ to send."
          : ""
      );
    }
    return;
  }

  const path = selectDictationPath();

  // Prefer real browser speech-to-text (live words, no Mac upload)
  if (path === "browser-speech") {
    await startBrowserDictation();
    return;
  }
  if (path === "server-media") {
    // Only when Web Speech is missing (typical older WebKit)
    await startServerDictation();
    return;
  }

  // On plain http://, jump to free HTTPS so browser STT / live mic can work
  if (!freeHttpsMicUrl) {
    await refreshFreeHttpsMicUrl();
  }
  if (freeHttpsMicUrl && navigateToFreeHttpsAutoMic()) {
    return;
  }

  if (path === "keyboard-stt" || path === "native-audio-file") {
    openDictationSheet();
    return;
  }

  setDictationHint(
    dictationBlockedReason() || "Voice dictation isn’t available here."
  );
}

/**
 * After landing on free HTTPS with ?automic=1, start dictation once.
 * Prefers browser STT when available.
 */
async function maybeAutoStartMicFromQuery() {
  let want = false;
  try {
    const u = new URL(window.location.href);
    want = u.searchParams.get("automic") === "1";
    if (want) {
      u.searchParams.delete("automic");
      const qs = u.searchParams.toString();
      history.replaceState(
        null,
        "",
        u.pathname + (qs ? `?${qs}` : "") + u.hash
      );
    }
  } catch {
    return;
  }
  if (!want) return;
  if (!isSecureDictationContext()) {
    setDictationHint(
      "Live mic needs the free HTTPS page. Restart npm start on the Mac (openssl)."
    );
    return;
  }
  if (!getSecret()) {
    setDictationHint("Connect with your secret, then tap the mic.");
    return;
  }
  setDictationHint("Starting…", true);
  // Prefer browser STT over Mac transcription
  const path = selectDictationPath();
  if (path === "browser-speech") {
    await startBrowserDictation();
  } else {
    await startServerDictation();
  }
}

function initMicButton() {
  if (!micBtn) return;
  micBtn.classList.remove("mic-unsupported");
  micBtn.title = "Hold-free: tap to record, tap again to stop";
  micBtn.addEventListener("click", (e) => {
    e.preventDefault();
    void startDictation();
  });
  if (dictationBackdrop) {
    dictationBackdrop.onclick = () => closeDictationSheet();
  }
  if (dictationCancelBtn) {
    dictationCancelBtn.onclick = () => closeDictationSheet();
  }
  if (dictationKeyboardBtn) {
    dictationKeyboardBtn.onclick = () => startKeyboardDictationMode();
  }
  if (dictationMemoBtn) {
    dictationMemoBtn.onclick = () => startNativeAudioFileDictation();
  }
  if (dictationHttpsBtn) {
    dictationHttpsBtn.onclick = () => {
      closeDictationSheet();
      if (!freeHttpsMicUrl) {
        setDictationHint(
          "Free HTTPS not running. On the Mac: restart npm start (needs openssl)."
        );
        return;
      }
      navigateToFreeHttpsAutoMic();
    };
  }
}
initMicButton();

/** Refresh free HTTPS URL from status (for live mic on iPhone). */
async function refreshFreeHttpsMicUrl() {
  const secret = getSecret();
  if (!secret) return;
  try {
    const res = await fetch("/api/status", {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    if (!res.ok) return;
    const j = await res.json();
    freeHttpsMicUrl = buildFreeHttpsMicUrl(j, window.location);
  } catch {
    /* offline */
  }
}

// ── Attach: library + camera ───────────────────────────────────────────────

// ── Composer actions (＋): photo + tools ────────────────────────────────────

function openActionsSheet() {
  if (!actionsSheet) return;
  actionsSheet.classList.remove("hidden");
  actionsSheet.setAttribute("aria-hidden", "false");
  if (actionsBtn) actionsBtn.setAttribute("aria-expanded", "true");
}

function closeActionsSheet() {
  if (!actionsSheet) return;
  actionsSheet.classList.add("hidden");
  actionsSheet.setAttribute("aria-hidden", "true");
  if (actionsBtn) actionsBtn.setAttribute("aria-expanded", "false");
}

/** Open the slash-tools panel (same list as typing `/`). */
async function openToolsMenu() {
  closeActionsSheet();
  if (!toolsCatalog.length) {
    await loadTools();
  }
  slashActiveIndex = 0;
  // Empty composer: seed `/` so typing filters the list like a slash command
  if (input && !String(input.value || "").trim() && !slashQueryFromInput()) {
    input.value = "/";
    try {
      input.setSelectionRange(1, 1);
    } catch {
      /* ignore */
    }
  }
  showSlashMenu(filteredTools(slashQueryFromInput()?.query || ""));
  try {
    input?.focus({ preventScroll: true });
  } catch {
    try {
      input?.focus();
    } catch {
      /* ignore */
    }
  }
  if (typeof resizeComposerInput === "function") resizeComposerInput();
}

if (actionsBtn) {
  actionsBtn.onclick = () => {
    if (actionsSheet && !actionsSheet.classList.contains("hidden")) {
      closeActionsSheet();
    } else {
      openActionsSheet();
    }
  };
}
if (actionsBackdrop) actionsBackdrop.onclick = () => closeActionsSheet();
if (actionsCancel) actionsCancel.onclick = () => closeActionsSheet();
if (actionPhoto) {
  actionPhoto.onclick = () => {
    closeActionsSheet();
    filePhotos?.click();
  };
}
if (actionTools) {
  actionTools.onclick = () => {
    void openToolsMenu();
  };
}

async function onFilesSelected(fileList) {
  const files = [...(fileList || [])];
  for (const f of files.slice(0, 4)) {
    if (!f.type.startsWith("image/")) continue;
    pendingImages.push(await fileToImage(f));
  }
  renderPreviews();
}

if (filePhotos) {
  filePhotos.onchange = async () => {
    await onFilesSelected(filePhotos.files);
    filePhotos.value = "";
  };
}

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
  // User is editing the draft — drop the highlight ring
  clearDictationDraftUi();
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

  // Stop mic so we don't keep appending after send
  if (dictationActive || dictationWantListening || mediaRecorder || speechRec) {
    dictationWantListening = false;
    stopDictation();
  }

  const imgs = pendingImages.slice();
  const imageDataUrls = imgs.map(dataUrlFromImage);
  addMsg("user", text || "(photo)", { images: imageDataUrls });
  input.value = "";
  input.style.height = "auto";
  clearDictationDraftUi();
  pendingImages = [];
  renderPreviews();
  hideSlashMenu();
  setDictationHint("");

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
        agentId: chatAgentIdPayload(selectedAgentId),
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
    const agentHint = j.agentLabel || j.agentId;
    setThinking(thinkingEl, {
      phase: isQueued
        ? `Queued (#${j.queuePosition})${agentHint ? ` · ${agentHint}` : ""}`
        : agentHint && agentHint !== "Main"
          ? `Thinking… · ${agentHint}`
          : "Thinking…",
      jobId,
    });
    attachJobIdToLatestPair(jobId);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "bot" && history[i].jobId === jobId) {
        history[i].jobStatus = isQueued ? "queued" : "running";
        if (!history[i].text) history[i].text = "";
        persistHistory();
        break;
      }
    }
    const botEl = body.closest(".msg");
    if (botEl) {
      botEl.dataset.jobId = jobId;
      if (j.agentId) botEl.dataset.agentId = j.agentId;
    }

    startJobPoll(jobId, body, thinkingEl);
    void refreshActivity({ quiet: true });
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

    // New conversation epoch on Mac — wipe all per-agent phone histories
    clearAllAgentHistories();
    selectedAgentId = "main";
    try {
      localStorage.setItem(SELECTED_AGENT_KEY, "main");
    } catch {
      /* ignore */
    }
    if (j.conversationId) setStoredConversationId(j.conversationId, "main");
    if (Array.isArray(j.agents)) knownAgents = j.agents;
    knownJobs = [];
    history = [];
    renderHistory();
    updateMenuBadge();
    updateAgentChip();
    closeActivityMenu();
    setConn("connected", "ok");
    addMsg("bot", "_Agent reset. Chat history cleared. You can send a new message._", {
      jobStatus: "done",
      showThinking: false,
    });
    void refreshActivity({ force: true });
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
      // Free HTTPS landing with ?automic=1 → start recording immediately
      await maybeAutoStartMicFromQuery();
    }
  });
} else {
  setConn("locked", "bad");
}
