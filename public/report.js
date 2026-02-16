// public/report.js

const areaList = document.getElementById("area-list");
const content = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("btn-refresh");
const chatBtn = document.getElementById("btn-chat");

const tabToReviewBtn = document.getElementById("tab-to-review");
const tabReviewedBtn = document.getElementById("tab-reviewed");
const tabRecountsBtn = document.getElementById("tab-recounts");
const tabQuestionsBtn = document.getElementById("tab-questions");

const logoEl = document.getElementById("logo");
const fullscreenBtn = document.getElementById("btn-fullscreen");
const adminBadge = document.getElementById("admin-badge");

// --------------------
// Offline cache + queued writes
// --------------------

const CACHE_NS = "report_cache_v1";
const CACHE_KEYS = {
  LIST: `${CACHE_NS}:GET:/api/report-exports`,
  FILE: (file) =>
    `${CACHE_NS}:GET:/api/report-exports/${encodeURIComponent(file)}`,
  CHAT: `${CACHE_NS}:GET:/api/chatlog`,
  PENDING: `${CACHE_NS}:PENDING_QUEUE`,
  DISCONNECTED_SINCE: `${CACHE_NS}:DISCONNECTED_SINCE`,
};

const SEEN_KEYS = {
  CHAT_LAST_SEEN_MS: `${CACHE_NS}:SEEN_CHAT_LAST_SEEN_MS`,
  QUESTIONS_REPLY_LAST_SEEN_MS: `${CACHE_NS}:SEEN_QUESTIONS_REPLY_LAST_SEEN_MS`,
};

let latestChatMsgMs = 0;
let latestQuestionsReplyMs = 0;
let latestReviewMs = 0;

const AGING_KEYS = {
  UNREVIEWED_FIRST_SEEN_BY_FILE: `${CACHE_NS}:UNREVIEWED_FIRST_SEEN_BY_FILE`,
};

let unreviewedFirstSeenByFile = loadUnreviewedFirstSeenMap();

function toMs(ts) {
  const n = Date.parse(String(ts || ""));
  return Number.isFinite(n) ? n : 0;
}

function loadUnreviewedFirstSeenMap() {
  try {
    const raw = localStorage.getItem(AGING_KEYS.UNREVIEWED_FIRST_SEEN_BY_FILE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistUnreviewedFirstSeenMap() {
  try {
    localStorage.setItem(
      AGING_KEYS.UNREVIEWED_FIRST_SEEN_BY_FILE,
      JSON.stringify(unreviewedFirstSeenByFile),
    );
  } catch (e) {
    console.warn("persistUnreviewedFirstSeenMap failed", e);
  }
}

function syncUnreviewedFirstSeen(enriched, nowMs = Date.now()) {
  const filesNow = new Set();
  let changed = false;

  for (const e of enriched || []) {
    const file = String(e?.file || "");
    if (!file) continue;
    filesNow.add(file);

    if (e.reviewed === true) {
      if (Object.prototype.hasOwnProperty.call(unreviewedFirstSeenByFile, file)) {
        delete unreviewedFirstSeenByFile[file];
        changed = true;
      }
      continue;
    }

    const existing = Number(unreviewedFirstSeenByFile[file] || 0);
    if (!Number.isFinite(existing) || existing <= 0) {
      unreviewedFirstSeenByFile[file] = nowMs;
      changed = true;
    }
  }

  for (const file of Object.keys(unreviewedFirstSeenByFile)) {
    if (!filesNow.has(file)) {
      delete unreviewedFirstSeenByFile[file];
      changed = true;
    }
  }

  if (changed) persistUnreviewedFirstSeenMap();
}

function markFileReviewedForAging(file) {
  if (!file) return;
  if (!Object.prototype.hasOwnProperty.call(unreviewedFirstSeenByFile, file)) return;
  delete unreviewedFirstSeenByFile[file];
  persistUnreviewedFirstSeenMap();
}

function getUnreviewedFirstSeenMs(file, fallbackMs = Date.now()) {
  const n = Number(unreviewedFirstSeenByFile[String(file || "")] || 0);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function formatAgeShortFromMs(ageMs) {
  const mins = Math.max(0, Math.floor(Number(ageMs || 0) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs}h` : `${hrs}h ${rem}m`;
}

function getAgingClass(ageMs) {
  if (ageMs >= 30 * 60000) return "age-hot";
  if (ageMs >= 15 * 60000) return "age-warn";
  return "age-fresh";
}

function ensureLastReviewEl() {
  let el = document.getElementById("last-review-age");
  if (el) return el;

  const topbar = document.querySelector(".topbar");
  if (!topbar) return null;

  el = document.createElement("span");
  el.id = "last-review-age";
  el.className = "muted mono";

  if (statusEl && statusEl.parentElement === topbar) {
    topbar.insertBefore(el, statusEl);
  } else {
    topbar.appendChild(el);
  }
  return el;
}

function renderLastReviewAge() {
  const el = ensureLastReviewEl();
  if (!el) return;

  if (!latestReviewMs) {
    el.textContent = "Last review: none yet";
    return;
  }

  const delta = Math.max(0, Date.now() - latestReviewMs);
  const mins = Math.floor(delta / 60000);

  if (mins < 1) {
    el.textContent = "Last review just now";
    return;
  }

  if (mins < 60) {
    el.textContent = `Last review ${mins} minute${mins === 1 ? "" : "s"} ago`;
    return;
  }

  const hours = Math.floor(mins / 60);
  el.textContent = `Last review ${hours} hour${hours === 1 ? "" : "s"} ago`;
}

// --------------------
// "Seen" persistence (localStorage + foolproof in-memory fallback)
// --------------------

const __seenMem = Object.create(null);

let __storageOk = null;
let __storageWarned = false;

function storageOk() {
  if (__storageOk !== null) return __storageOk;
  try {
    const k = `${CACHE_NS}:__ls_test__`;
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    __storageOk = true;
  } catch {
    __storageOk = false;
  }
  return __storageOk;
}

function getSeenMs(key) {
  // Always allow in-memory fallback (works even if storage is blocked)
  const mem = __seenMem[key];
  const memN = mem ? Number(mem) : 0;
  const memMs = Number.isFinite(memN) ? memN : 0;

  if (!storageOk()) return memMs;

  try {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : 0;
    const lsMs = Number.isFinite(n) ? n : 0;
    return Math.max(lsMs, memMs);
  } catch {
    return memMs;
  }
}

function setSeenMs(key, ms) {
  const v = String(Number(ms) || 0);

  // Always update memory (so behavior is correct even when LS is broken)
  __seenMem[key] = v;

  if (!storageOk()) {
    if (!__storageWarned) {
      __storageWarned = true;
      console.warn("[SEEN] localStorage unavailable; using in-memory fallback");
    }
    return;
  }

  try {
    localStorage.setItem(key, v);
  } catch (e) {
    if (!__storageWarned) {
      __storageWarned = true;
      console.warn(
        "[SEEN] localStorage write failed; using in-memory fallback",
        e,
      );
    }
  }
}

function setNotif(el, on) {
  if (!el) return;

  const before = el.classList.contains("has-notif");
  el.classList.toggle("has-notif", !!on);
  const after = el.classList.contains("has-notif");

  // Only log when something actually changes
  if (before !== after) {
    const id = el.id ? `#${el.id}` : el.tagName;
    const seenChat = getSeenMs(SEEN_KEYS.CHAT_LAST_SEEN_MS);
    const seenQ = getSeenMs(SEEN_KEYS.QUESTIONS_REPLY_LAST_SEEN_MS);

    console.log("[NOTIF]", id, "=>", after ? "ON" : "OFF", {
      onArg: !!on,
      latestChatMsgMs,
      seenChat,
      chatOpen: chatState?.open,
      latestQuestionsReplyMs,
      seenQuestionsReplyMs: seenQ,
      currentTab,
      stack: new Error().stack,
    });
  }
}

function getChatMessages(chatObj) {
  if (Array.isArray(chatObj)) return chatObj;
  if (chatObj && Array.isArray(chatObj.messages)) return chatObj.messages;
  return [];
}

function computeLatestChatMs(chatObj) {
  const msgs = getChatMessages(chatObj);
  let max = 0;
  for (const m of msgs) {
    const ms = toMs(m?.timestamp ?? m?.ts ?? m?.time ?? "");
    if (ms > max) max = ms;
  }
  return max;
}

function computeLatestQuestionsReplyMs(enriched) {
  let max = 0;
  for (const e of enriched || []) {
    const qs = Array.isArray(e?.questions) ? e.questions : [];
    for (const q of qs) {
      if (!q || typeof q !== "object") continue;
      if (!String(q.reply || "").trim()) continue;
      const ms = toMs(q.reply_at ?? q.replyAt ?? "");
      if (ms > max) max = ms;
    }
  }
  return max;
}

async function refreshChatNotification() {
  try {
    const out = await fetchJsonWithCache("/api/chatlog", CACHE_KEYS.CHAT);
    latestChatMsgMs = computeLatestChatMs(out.data);

    // If the user is viewing chat, it is "seen" immediately.
    if (chatState.open) {
      markChatSeen();
      return;
    }

    const seen = getSeenMs(SEEN_KEYS.CHAT_LAST_SEEN_MS);
    setNotif(chatBtn, latestChatMsgMs > seen);
  } catch {
    // ignore
  }
}

function refreshQuestionsNotification() {
  const seen = getSeenMs(SEEN_KEYS.QUESTIONS_REPLY_LAST_SEEN_MS);
  setNotif(
    tabQuestionsBtn,
    latestQuestionsReplyMs > seen && currentTab !== TABS.QUESTIONS,
  );
}

function markQuestionsRepliesSeen() {
  setSeenMs(SEEN_KEYS.QUESTIONS_REPLY_LAST_SEEN_MS, latestQuestionsReplyMs);
  setNotif(tabQuestionsBtn, false);
}

function markChatSeen() {
  setSeenMs(SEEN_KEYS.CHAT_LAST_SEEN_MS, latestChatMsgMs);
  setNotif(chatBtn, false);
}

const DISCONNECT_BANNER_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const BANNER_POLL_MS = 2500;

let disconnectedSince = (() => {
  const raw = localStorage.getItem(CACHE_KEYS.DISCONNECTED_SINCE);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : null;
})();

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function cacheGet(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const obj = safeJsonParse(raw);
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

function cacheSet(key, valueObj) {
  try {
    localStorage.setItem(key, JSON.stringify(valueObj));
  } catch (e) {
    // localStorage may be full; best-effort
    console.warn("cacheSet failed", e);
  }
}

function ensureOfflineBanner() {
  if (document.getElementById("offline-banner")) return;

  const el = document.createElement("div");
  el.id = "offline-banner";
  el.setAttribute("role", "status");
  el.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 200000;
    display: none;
    padding: 10px 14px;
    font-family: Inter, system-ui, sans-serif;
    font-size: 16px;
    font-weight: 800;
    text-align: center;
    border-bottom: 2px solid #111;
    background: #ffeb3b;
    color: #111;
  `;
  el.textContent =
    "Disconnected for over 5 minutes. Please return to the station.";

  document.body.appendChild(el);
}

function showOfflineBanner(show) {
  ensureOfflineBanner();
  const el = document.getElementById("offline-banner");
  if (!el) return;
  el.style.display = show ? "block" : "none";
}

function markDisconnected() {
  if (!disconnectedSince) {
    disconnectedSince = Date.now();
    localStorage.setItem(
      CACHE_KEYS.DISCONNECTED_SINCE,
      String(disconnectedSince),
    );
  }
  // Do not show banner until 5 minutes have elapsed.
}

function markConnected() {
  disconnectedSince = null;
  localStorage.removeItem(CACHE_KEYS.DISCONNECTED_SINCE);
  showOfflineBanner(false);
}

function updateDisconnectUI() {
  if (!disconnectedSince) {
    showOfflineBanner(false);
    return;
  }
  const elapsed = Date.now() - disconnectedSince;
  if (elapsed >= DISCONNECT_BANNER_AFTER_MS) showOfflineBanner(true);
  else showOfflineBanner(false);
}

setInterval(updateDisconnectUI, BANNER_POLL_MS);
window.addEventListener("online", () => {
  // "online" doesn't guarantee server availability, but it's a good time to try.
  flushPendingQueue();
});
window.addEventListener("offline", () => {
  // browser-level offline signal
  markDisconnected();
  updateDisconnectUI();
});

function getPendingQueue() {
  const raw = localStorage.getItem(CACHE_KEYS.PENDING);
  const arr = safeJsonParse(raw);
  return Array.isArray(arr) ? arr : [];
}

function setPendingQueue(arr) {
  cacheSet(CACHE_KEYS.PENDING, arr);
}

function enqueueRequest(req) {
  const q = getPendingQueue();
  q.push(req);
  setPendingQueue(q);
}

function looksLikeNetworkError(err) {
  // fetch() network failures typically throw TypeError in browsers
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return (
    err.name === "TypeError" ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("load failed") ||
    msg.includes("fetch")
  );
}

function installVisualViewportFixForChat() {
  const setVars = () => {
    const vv = window.visualViewport;

    const innerH = window.innerHeight;
    const vvH = vv ? vv.height : innerH;

    // Android keyboards often reduce vv.height and may also change offsetTop.
    // "Covered" area is the difference between layout viewport and visual viewport.
    const kb = Math.max(0, innerH - vvH - (vv?.offsetTop || 0));

    // vvh for general sizing
    const h = vv ? vvH : innerH;
    document.documentElement.style.setProperty("--vvh", `${h * 0.01}px`);

    // keyboard inset for lifting composer
    document.documentElement.style.setProperty("--kb", `${kb}px`);
  };

  setVars();
  window.addEventListener("resize", setVars);
  window.visualViewport?.addEventListener("resize", setVars);
  window.visualViewport?.addEventListener("scroll", setVars);

  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target && e.target.id === "chat-input") {
        setTimeout(() => {
          setVars();
          // bring the composer into view (end is better than center here)
          e.target.scrollIntoView({ block: "end", behavior: "smooth" });
        }, 100);
      }
    },
    true,
  );

  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target && e.target.id === "chat-input") {
        // when keyboard closes, reset soon after
        setTimeout(setVars, 100);
      }
    },
    true,
  );
}

async function fetchJsonWithCache(url, cacheKey) {
  // classify for eviction policy
  const metaType =
    cacheKey === CACHE_KEYS.LIST
      ? "list"
      : cacheKey === CACHE_KEYS.CHAT
        ? "chat"
        : "file"; // most are per-area files

  try {
    const res = await fetch(url, { method: "GET" });

    // Server responded: we are connected (even if error status).
    markConnected();

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${t}`.trim());
      err.httpStatus = res.status;
      throw err;
    }

    const data = await res.json();

    await cacheSetLarge(
      cacheKey,
      {
        ts: Date.now(),
        data,
      },
      metaType,
    );

    // on successful contact, try flushing any queued writes
    flushPendingQueue();

    return { data, fromCache: false };
  } catch (err) {
    // If it's network-ish, we can use cache.
    if (looksLikeNetworkError(err)) {
      markDisconnected();
      updateDisconnectUI();

      const cached = await cacheGetLarge(cacheKey);
      if (cached && cached.data !== undefined) {
        return { data: cached.data, fromCache: true };
      }
    }
    throw err;
  }
}

async function postJsonQueued(url, bodyObj, { applyLocal } = {}) {
  const payload = JSON.stringify(bodyObj ?? {});
  const headers = { "Content-Type": "application/json" };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
    });

    // Server responded: connected
    markConnected();

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${t}`.trim());
    }

    // On success, try flushing any older pending writes too
    flushPendingQueue();

    return { ok: true, queued: false };
  } catch (err) {
    if (looksLikeNetworkError(err)) {
      markDisconnected();
      updateDisconnectUI();

      // Apply optimistic local changes (cache) so user can continue navigating.
      try {
        if (typeof applyLocal === "function") applyLocal();
      } catch (e) {
        console.warn("applyLocal failed", e);
      }

      enqueueRequest({
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        url,
        method: "POST",
        headers,
        body: payload,
        queuedAt: new Date().toISOString(),
      });

      return { ok: true, queued: true };
    }

    throw err;
  }
}

let flushing = false;
async function flushPendingQueue() {
  if (flushing) return;
  flushing = true;

  try {
    const q = getPendingQueue();
    if (q.length === 0) return;

    // Try in-order; stop on first network failure.
    const remaining = [];
    for (const item of q) {
      try {
        const res = await fetch(item.url, {
          method: item.method || "POST",
          headers: item.headers || { "Content-Type": "application/json" },
          body: item.body,
        });

        // Any response means we can clear disconnected state.
        markConnected();

        if (!res.ok) {
          // Server reachable but rejected; keep it (so it isn't silently lost)
          remaining.push(item);
        }
      } catch (err) {
        if (looksLikeNetworkError(err)) {
          markDisconnected();
          updateDisconnectUI();

          // Can't reach server right now; keep current + rest.
          remaining.push(item);
          const idx = q.indexOf(item);
          for (let i = idx + 1; i < q.length; i++) remaining.push(q[i]);
          break;
        } else {
          // Unknown error: keep it
          remaining.push(item);
        }
      }
    }

    setPendingQueue(remaining);
  } finally {
    flushing = false;
  }
}

function patchCachedFile(file, mutator) {
  const key = CACHE_KEYS.FILE(file);
  const cached = cacheGet(key);
  if (!cached || cached.data === undefined) return;

  const data = cached.data;
  if (!data || typeof data !== "object") return;

  try {
    mutator(data);
    cacheSet(key, { ...cached, ts: Date.now(), data });
  } catch (e) {
    console.warn("patchCachedFile mutator failed", e);
  }
}

function patchCachedListReviewedFlag(file, reviewed, reviewed_at) {
  // The list endpoint cache holds array of items; in this app the list is enriched later,
  // so patching isn't strictly required, but it helps keep things coherent.
  const cached = cacheGet(CACHE_KEYS.LIST);
  if (!cached || !Array.isArray(cached.data)) return;

  const list = cached.data.slice();
  let changed = false;

  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    if (String(it.file || "") !== String(file || "")) continue;
    // list items don't necessarily include reviewed; leave if not present.
    if ("reviewed" in it) it.reviewed = !!reviewed;
    if ("reviewed_at" in it) it.reviewed_at = reviewed_at || it.reviewed_at;
    changed = true;
  }

  if (changed)
    cacheSet(CACHE_KEYS.LIST, { ...cached, ts: Date.now(), data: list });
}

// --------------------
// Admin mode / hidden fullscreen control
// - Tap logo 5x -> PIN prompt (0213) -> admin mode
// - In admin mode: show fullscreen button
// - Tap logo once while in admin mode -> exit admin mode (hide again)
// --------------------

const ADMIN_PIN = "0213";
let adminMode = false;
// Remember intent: user wanted fullscreen
let wantsBrowserFullscreen = true;

// Simple overlay prompting user to tap to re-enter fullscreen
function ensureFsOverlay() {
  if (document.getElementById("fs-overlay")) return;

  const el = document.createElement("div");
  el.id = "fs-overlay";
  el.style.cssText = `
    position: fixed; inset: 0;
    display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.55);
    z-index: 100000;
    padding: 20px;
  `;
  el.innerHTML = `
    <button id="fs-overlay-btn" class="btn btn-primary" type="button"
      style="font-size:17px; padding:16px 18px; border-radius:14px;">
      Tap to resume
    </button>
  `;
  document.body.appendChild(el);

  document
    .getElementById("fs-overlay-btn")
    .addEventListener("click", async () => {
      el.style.display = "none";
      await requestBrowserFullscreenFromGesture();
    });
}

async function requestBrowserFullscreenFromGesture() {
  const docEl = document.documentElement;
  try {
    const req =
      docEl.requestFullscreen ||
      docEl.webkitRequestFullscreen ||
      docEl.msRequestFullscreen;
    if (req) await req.call(docEl);
  } catch (e) {
    console.error(e);
  } finally {
    refreshFullscreenBtnLabel();
  }
}

function showFsOverlayIfNeeded() {
  ensureFsOverlay();

  const inFs = !!(
    document.fullscreenElement || document.webkitFullscreenElement
  );
  const overlay = document.getElementById("fs-overlay");

  if (wantsBrowserFullscreen && !inFs) {
    overlay.style.display = "flex";
  } else {
    overlay.style.display = "none";
  }
}

let logoTapCount = 0;
let logoTapResetTimer = null;
const LOGO_TAP_WINDOW_MS = 1800;

function setAdminMode(on) {
  adminMode = !!on;
  document.body.classList.toggle("admin-mode", adminMode);

  // Keep aria in sync with visibility.
  if (fullscreenBtn)
    fullscreenBtn.setAttribute("aria-hidden", adminMode ? "false" : "true");
  if (adminBadge)
    adminBadge.setAttribute("aria-hidden", adminMode ? "false" : "true");
}

function refreshFullscreenBtnLabel() {
  if (!fullscreenBtn) return;
  const inFs = !!(
    document.fullscreenElement || document.webkitFullscreenElement
  );
  fullscreenBtn.textContent = inFs ? "Exit Fullscreen" : "Fullscreen";
}
async function toggleFullscreen() {
  const docEl = document.documentElement;

  try {
    const inFs = !!(
      document.fullscreenElement || document.webkitFullscreenElement
    );

    // record what the user wants
    wantsBrowserFullscreen = !inFs;

    if (!inFs) {
      const req =
        docEl.requestFullscreen ||
        docEl.webkitRequestFullscreen ||
        docEl.msRequestFullscreen;
      if (req) await req.call(docEl);
    } else {
      const exit =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.msExitFullscreen;
      if (exit) await exit.call(document);
    }
  } catch (e) {
    console.error(e);
    alert("Fullscreen could not be started (browser may block it).");
  } finally {
    refreshFullscreenBtnLabel();
    showFsOverlayIfNeeded();
  }
}

document.addEventListener("fullscreenchange", () => {
  refreshFullscreenBtnLabel();
  showFsOverlayIfNeeded();
});
document.addEventListener("webkitfullscreenchange", () => {
  refreshFullscreenBtnLabel();
  showFsOverlayIfNeeded();
});

// When returning from sleep/background, fullscreen is often gone.
// We can't auto-reenter, but we can prompt.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) showFsOverlayIfNeeded();
});
window.addEventListener("pageshow", showFsOverlayIfNeeded);

document.addEventListener("fullscreenchange", refreshFullscreenBtnLabel);
document.addEventListener("webkitfullscreenchange", refreshFullscreenBtnLabel);

fullscreenBtn?.addEventListener("click", () => {
  toggleFullscreen();
});

logoEl?.addEventListener("click", () => {
  // If already in admin mode, a single tap exits admin mode.
  if (adminMode) {
    setAdminMode(false);
    return;
  }

  logoTapCount += 1;

  if (logoTapResetTimer) clearTimeout(logoTapResetTimer);
  logoTapResetTimer = setTimeout(() => {
    logoTapCount = 0;
  }, LOGO_TAP_WINDOW_MS);

  if (logoTapCount >= 5) {
    logoTapCount = 0;
    if (logoTapResetTimer) clearTimeout(logoTapResetTimer);

    const pin = window.prompt("Enter admin PIN");
    if (pin === ADMIN_PIN) {
      setAdminMode(true);
      refreshFullscreenBtnLabel();
    } else if (pin !== null) {
      alert("Incorrect PIN.");
    }
  }
});

// --------------------
// Tabs
// --------------------

const TABS = {
  TO_REVIEW: "to_review",
  REVIEWED: "reviewed",
  RECOUNTS: "recounts",
  QUESTIONS: "questions",
};

let currentTab = TABS.TO_REVIEW;

function setActiveTab(tab) {
  currentTab = tab;

  const defs = [
    [tabToReviewBtn, TABS.TO_REVIEW],
    [tabReviewedBtn, TABS.REVIEWED],
    [tabRecountsBtn, TABS.RECOUNTS],
    [tabQuestionsBtn, TABS.QUESTIONS],
  ];

  defs.forEach(([btn, t]) => {
    if (!btn) return;
    const active = t === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  // Reload list view if we're currently on the list screen.
  if (currentView.type === "list") {
    loadAreaList();
  }

  // Keep notification dots in sync when switching tabs.
  refreshQuestionsNotification();
  refreshChatNotification();
}

// --------------------
// Layout mode helper
// Makes listmode/fullscreen mutually exclusive
// --------------------

function setSplitMode(mode) {
  const split = document.querySelector(".split");
  if (!split) return;

  split.classList.remove("listmode", "fullscreen");

  if (mode === "list") split.classList.add("listmode");
  if (mode === "fullscreen") split.classList.add("fullscreen");
}

// --------------------
// Formatting / helpers
// --------------------

function fmtMoney(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "0";
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : String(n);
}

function varianceClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "var-zero";
  return n > 0 ? "var-pos" : "var-neg";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeAreaNum(a) {
  if (a === null || a === undefined) return "";
  const s = String(a).trim();
  if (/^\d+$/.test(s)) return s.padStart(5, "0");
  return s;
}

function summarizeAreaNumbers(areaNums, maxToShow = 6) {
  const nums = (areaNums || []).map(normalizeAreaNum).filter(Boolean);
  if (nums.length <= maxToShow) return nums.join(", ");
  const shown = nums.slice(0, maxToShow).join(", ");
  return `${shown} (+${nums.length - maxToShow} more)`;
}

function buildGroupTitleFromDescriptions(members) {
  const descs = members.map((m) => (m.area_desc || "").trim()).filter(Boolean);
  const unique = Array.from(new Set(descs));
  if (unique.length === 0) return "Grouped areas";
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} / ${unique[1]}`;
  return `${unique[0]} / ${unique[1]} (+${unique.length - 2} more)`;
}

function getExportGrouping(data) {
  const eg = data?.export_grouping;
  if (!eg || typeof eg !== "object")
    return { enabled: false, group_id: null, group_members: null };
  return {
    enabled: !!eg.enabled,
    group_id: eg.group_id ?? null,
    group_members: Array.isArray(eg.group_members) ? eg.group_members : null,
  };
}

// --------------------
// DYNAMIC COLUMN WIDTH CALCULATION
// --------------------

// Estimates char width for 17px font + padding
const CHAR_WIDTH_PX = 9.5;
const COL_PADDING_PX = 14;

function calculateDynamicGrid(locations, reportType, headerLabels) {
  const isScanReport = reportType === "scan_report";

  if (isScanReport) {
    // User requested optimization based on max chars:
    // $ cols: 9 chars (~100px)
    // Qty cols: 5 chars (~62px, but 'Pieces' header needs ~72px)
    // SKU: 3 chars (~44px, but 'SKUs' header needs ~52px)
    // Col structure: [Desc] [Cur$] [Prior1$] [Var$] [Pieces] [PriorPieces] [VarPieces] [SKUs]
    // 100 100 100 72 62 62 52
    return `style="padding:2px 6px; column-gap:8px; grid-template-columns: minmax(0, 1fr) 92px 92px 92px 64px 56px 56px 48px;"`;
  }

  // Fallback / Standard report dynamic calculation
  const numCols = 4;

  // Initialize max length with the length of the headers
  const maxLens = new Array(numCols).fill(0);
  (headerLabels || []).forEach((label, i) => {
    if (i < numCols)
      maxLens[i] = Math.max(maxLens[i], String(label || "").length);
  });

  // Scan data
  for (const l of locations) {
    // 0: Current $
    // 1: Prior 1 $
    // 2: Prior 2 $
    // 3: Prior 3 $
    maxLens[0] = Math.max(
      maxLens[0],
      fmtMoney(l.ext_price_total_current).length,
    );
    maxLens[1] = Math.max(
      maxLens[1],
      fmtMoney(l.ext_price_total_prior1).length,
    );
    maxLens[2] = Math.max(
      maxLens[2],
      fmtMoney(l.ext_price_total_prior2).length,
    );
    maxLens[3] = Math.max(
      maxLens[3],
      fmtMoney(l.ext_price_total_prior3).length,
    );
  }

  // Convert chars to px
  const widths = maxLens.map((len) =>
    Math.ceil(len * CHAR_WIDTH_PX + COL_PADDING_PX),
  );

  // Ensure minimum width (e.g. 50px) so headers don't squish too much if data is empty
  const safeWidths = widths.map((w) => Math.max(w, 56));

  const colsStr = safeWidths.map((w) => `${w}px`).join(" ");
  return `style="padding:2px 6px; grid-template-columns: minmax(0, 1fr) ${colsStr};"`;
}

function renderBreakdown(bd, reportType, gridStyleOverride) {
  if (!bd || typeof bd !== "object") {
    return `<div class="muted">No breakdown available.</div>`;
  }

  const mode = bd.mode || "";
  const groups = Array.isArray(bd.groups) ? bd.groups : [];
  const categories = Array.isArray(bd.categories) ? bd.categories : [];
  const isScanReport = reportType === "scan_report";

  // If no override passed, fallback to defaults (using tuned widths for scan_report)
  const gridStyle =
    gridStyleOverride ||
    (isScanReport
      ? 'style="padding:2px 6px; column-gap:8px; grid-template-columns: minmax(0, 1fr) 92px 92px 92px 64px 56px 56px 48px;"'
      : 'style="padding:2px 6px;"');

  // Helper to generate the right columns based on type
  const renderCols = (item) => {
    if (isScanReport) {
      return `
        <div class="num">${fmtMoney(item.ext_price_total_current)}</div>
        <div class="num">${fmtMoney(item.ext_price_total_prior1)}</div>
        <div class="num variance ${varianceClass(item.price_variance)}">${fmtMoney(item.price_variance)}</div>
        <div class="num">${fmtNum(item.ext_qty_total_current)}</div>
        <div class="num">${fmtNum(item.ext_qty_total_prior1)}</div>
        <div class="num variance ${varianceClass(item.pieces_variance)}">${fmtNum(item.pieces_variance)}</div>
        <div class="num">${fmtNum(item.unique_sku)}</div>
      `;
    } else {
      // Standard 4-column
      return `
        <div class="num">${fmtMoney(item.ext_price_total_current)}</div>
        <div class="num">${fmtMoney(item.ext_price_total_prior1)}</div>
        <div class="num">${fmtMoney(item.ext_price_total_prior2)}</div>
        <div class="num">${fmtMoney(item.ext_price_total_prior3)}</div>
      `;
    }
  };

  if (mode === "category_groups") {
    if (groups.length === 0)
      return `<div class="muted">No category groups.</div>`;

    return groups
      .map(
        (g) => `
  <div class="report-grid report-sub" ${gridStyle}>
    <div class="desc">
      <span class="catcell">
        <span class="mono catnum">${escapeHtml(g.cat_group_num ?? "")}</span>
        <span class="catdesc" title="${escapeHtml(g.group_desc ?? "")}">${escapeHtml(g.group_desc ?? "")}</span>
      </span>
    </div>
    ${renderCols(g)}
  </div>
`,
      )
      .join("");
  }

  if (mode === "categories") {
    if (categories.length === 0)
      return `<div class="muted">No categories.</div>`;

    return categories
      .map(
        (c) => `
  <div class="report-grid report-sub" ${gridStyle}>
    <div class="desc">
      <span class="catcell">
        <span class="mono catnum">${escapeHtml(c.cat_num ?? "")}</span>
        <span class="catdesc" title="${escapeHtml(c.cat_desc ?? "")}">${escapeHtml(c.cat_desc ?? "")}</span>
      </span>
    </div>
    ${renderCols(c)}
  </div>
`,
      )
      .join("");
  }

  // Best-effort fallback (default to standard columns if ambiguous)
  if (groups.length > 0) {
    return groups
      .map(
        (g) => `
        <div class="report-grid report-sub" ${gridStyle}>
          <div class="desc" title="${escapeHtml(g.group_desc ?? "")}">${escapeHtml(g.group_desc ?? "")}</div>
          ${renderCols(g)}
        </div>
      `,
      )
      .join("");
  }

  if (categories.length > 0) {
    return categories
      .map(
        (c) => `
        <div class="report-grid report-sub" ${gridStyle}>
          <div class="desc" title="${escapeHtml(c.cat_desc ?? "")}">${escapeHtml(c.cat_desc ?? "")}</div>
          ${renderCols(c)}
        </div>
      `,
      )
      .join("");
  }

  return `<div class="muted">No breakdown available.</div>`;
}

// --------------------
// Recount extraction
// Supports per-location location_action object + top-level location_action(s)
// --------------------

function extractRecountLocations(reportJson, file) {
  const data = reportJson || {};
  const area_num = normalizeAreaNum(data.area_num ?? "");
  const area_desc = data.area_desc || "";
  const locs = Array.isArray(data.locations) ? data.locations : [];

  const isRecountAction = (a) =>
    !!a &&
    typeof a === "object" &&
    String(a.action || a.type || "").toLowerCase() === "recount";

  const getActionText = (a) =>
    a && typeof a === "object" ? String(a.text || a.reason || "") : "";

  const getLocNum = (loc) => String(loc?.loc_num ?? "");
  const findLocByNum = (locNum) =>
    locs.find((l) => getLocNum(l) === String(locNum ?? ""));

  // 1) top-level actions -> rows
  const topRows = [];

  if (isRecountAction(data.location_action || data.locationAction)) {
    const a = data.location_action || data.locationAction;
    const match = findLocByNum(a?.loc_num ?? "");
    topRows.push({
      file,
      area_num,
      area_desc,
      loc_num: match?.loc_num ?? a?.loc_num ?? "",
      loc_desc: match?.loc_desc || "",
      reason: getActionText(a),
    });
  }

  const topActions =
    data.location_actions ||
    data.locationActions ||
    data.actions ||
    (Array.isArray(data.location_action) ? data.location_action : null) ||
    null;

  if (Array.isArray(topActions)) {
    for (const a of topActions) {
      if (!isRecountAction(a)) continue;
      const match = findLocByNum(a?.loc_num ?? "");
      topRows.push({
        file,
        area_num,
        area_desc,
        loc_num: match?.loc_num ?? a?.loc_num ?? "",
        loc_desc: match?.loc_desc || "",
        reason: getActionText(a),
      });
    }
  }

  // 2) per-location flags
  const isRecountFlag = (loc) => {
    if (!loc || typeof loc !== "object") return false;

    if (loc.recount === true || loc.needs_recount === true) return true;
    if (String(loc.status || "").toLowerCase() === "recount") return true;
    if (String(loc.action || "").toLowerCase() === "recount") return true;

    // per-location single object
    const one = loc.location_action || loc.locationAction;
    if (isRecountAction(one)) return true;

    // per-location arrays
    const actions =
      loc.actions ||
      loc.location_actions ||
      loc.locationActions ||
      (Array.isArray(loc.location_action) ? loc.location_action : null) ||
      null;

    if (Array.isArray(actions)) return actions.some(isRecountAction);

    return false;
  };

  const recountReason = (loc) => {
    if (!loc || typeof loc !== "object") return "";

    const one = loc.location_action || loc.locationAction;
    if (isRecountAction(one)) return getActionText(one);

    if (typeof loc.recount_reason === "string") return loc.recount_reason;
    if (typeof loc.recountReason === "string") return loc.recountReason;
    if (typeof loc.recount_text === "string") return loc.recount_text;

    const actions =
      loc.actions ||
      loc.location_actions ||
      loc.locationActions ||
      (Array.isArray(loc.location_action) ? loc.location_action : null) ||
      null;

    if (Array.isArray(actions)) {
      const a = actions.slice().reverse().find(isRecountAction);
      return getActionText(a);
    }

    return "";
  };

  const perLocRows = locs.filter(isRecountFlag).map((l) => ({
    file,
    area_num,
    area_desc,
    loc_num: l.loc_num ?? "",
    loc_desc: l.loc_desc || "",
    reason: recountReason(l),
  }));

  // 3) merge + dedupe
  const all = [...topRows, ...perLocRows];
  const seen = new Set();
  const out = [];
  for (const r of all) {
    const key = `${String(r.area_num || "")}::${String(r.loc_num || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function extractQuestionLocations(reportJson, file) {
  const data = reportJson || {};
  const area_num = normalizeAreaNum(data.area_num ?? "");
  const area_desc = data.area_desc || "";
  const locs = Array.isArray(data.locations) ? data.locations : [];

  const isQuestionAction = (a) =>
    !!a &&
    typeof a === "object" &&
    String(a.action || a.type || "").toLowerCase() === "question";

  const getActionText = (a) =>
    a && typeof a === "object"
      ? String(a.text ?? a.message ?? a.question ?? "")
      : "";

  const getActionTs = (a) =>
    a && typeof a === "object" ? String(a.timestamp ?? a.ts ?? "") : "";

  const getActionReply = (a) =>
    a && typeof a === "object" ? String(a.reply ?? a.answer ?? "") : "";

  const getActionReplyAt = (a) =>
    a && typeof a === "object" ? String(a.reply_at ?? a.replyAt ?? "") : "";

  const getLocNum = (loc) => String(loc?.loc_num ?? "");
  const findLocByNum = (locNum) =>
    locs.find((l) => getLocNum(l) === String(locNum ?? ""));

  const rows = [];

  // 1) top-level single action
  if (isQuestionAction(data.location_action || data.locationAction)) {
    const a = data.location_action || data.locationAction;
    const match = findLocByNum(a?.loc_num ?? "");
    rows.push({
      file,
      area_num,
      area_desc,
      loc_num: match?.loc_num ?? a?.loc_num ?? "",
      loc_desc: match?.loc_desc || "",
      message: getActionText(a),
      timestamp: getActionTs(a),
      reply: getActionReply(a),
      reply_at: getActionReplyAt(a),
    });
  }

  // 2) top-level arrays
  const topActions =
    data.location_actions ||
    data.locationActions ||
    data.actions ||
    (Array.isArray(data.location_action) ? data.location_action : null) ||
    null;

  if (Array.isArray(topActions)) {
    for (const a of topActions) {
      if (!isQuestionAction(a)) continue;
      const match = findLocByNum(a?.loc_num ?? "");
      rows.push({
        file,
        area_num,
        area_desc,
        loc_num: match?.loc_num ?? a?.loc_num ?? "",
        loc_desc: match?.loc_desc || "",
        message: getActionText(a),
        timestamp: getActionTs(a),
        reply: getActionReply(a),
        reply_at: getActionReplyAt(a),
      });
    }
  }

  // 3) per-location actions
  const perLocActions = (loc) => {
    if (!loc || typeof loc !== "object") return [];

    const one = loc.location_action || loc.locationAction;
    const list =
      loc.actions ||
      loc.location_actions ||
      loc.locationActions ||
      (Array.isArray(loc.location_action) ? loc.location_action : null) ||
      null;

    const out = [];
    if (isQuestionAction(one)) out.push(one);
    if (Array.isArray(list)) out.push(...list.filter(isQuestionAction));
    return out;
  };

  for (const l of locs) {
    const acts = perLocActions(l);
    if (acts.length === 0) continue;

    // keep the latest by timestamp ordering if present; otherwise last in array
    const last = acts
      .slice()
      .sort((a, b) =>
        String(getActionTs(a)).localeCompare(String(getActionTs(b))),
      )
      .pop();

    rows.push({
      file,
      area_num,
      area_desc,
      loc_num: l.loc_num ?? "",
      loc_desc: l.loc_desc || "",
      message: getActionText(last),
      timestamp: getActionTs(last),
      reply: getActionReply(last),
      reply_at: getActionReplyAt(last),
    });
  }

  // 4) dedupe by area+loc, keep newest timestamp (or last encountered)
  const bestByKey = new Map();
  for (const r of rows) {
    const key = `${String(r.area_num || "")}::${String(r.loc_num || "")}`;
    const prev = bestByKey.get(key);
    if (!prev) {
      bestByKey.set(key, r);
      continue;
    }

    const a = String(prev.timestamp || "");
    const b = String(r.timestamp || "");
    if (b && (!a || b.localeCompare(a) > 0)) bestByKey.set(key, r);
    else if (!a && !b) bestByKey.set(key, r);
  }

  return Array.from(bestByKey.values());
}

function jumpToLocationInView(loc_num) {
  const target = String(loc_num ?? "");
  if (!target) return;

  const row = content.querySelector(
    `.report-row.report-main[data-loc-num="${CSS.escape(target)}"]`,
  );

  if (!row) return;

  row.classList.add("highlight");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => row.classList.remove("highlight"), 1600);
}

// --------------------
// Modal (location action)
// --------------------

const modalState = {
  open: false,
  context: null, // { file, area_num, area_desc, loc_num, loc_desc }
  step: "choose", // "choose" | "recount" | "question"
};

function ensureActionModal() {
  if (document.getElementById("loc-action-modal")) return;

  const modalHtml = `
<div id="loc-action-modal" class="modal-backdrop" style="display:none;">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div id="lam-title" style="font-weight:800; font-size:20px;">Location</div>
        <div id="lam-subtitle" class="muted mono" style="margin-top:4px;"></div>
      </div>
      <button id="lam-close" class="btn" type="button">✕</button>
    </div>

    <div id="lam-body" class="modal-body"></div>

    <div id="lam-footer" class="modal-footer"></div>
  </div>
</div>
`;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  document
    .getElementById("lam-close")
    .addEventListener("click", closeActionModal);
  document.getElementById("loc-action-modal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "loc-action-modal") closeActionModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalState.open) closeActionModal();
  });
}

function openActionModal(ctx) {
  ensureActionModal();
  modalState.open = true;
  modalState.context = ctx;
  modalState.step = "choose";

  const modal = document.getElementById("loc-action-modal");
  modal.style.display = "flex";

  renderActionModal();
}

function closeActionModal() {
  modalState.open = false;
  modalState.context = null;
  modalState.step = "choose";
  const modal = document.getElementById("loc-action-modal");
  if (modal) modal.style.display = "none";
}

function setModalStep(step) {
  modalState.step = step;
  renderActionModal();
}

function renderActionModal() {
  const ctx = modalState.context;
  if (!ctx) return;

  const title = document.getElementById("lam-title");
  const subtitle = document.getElementById("lam-subtitle");
  const body = document.getElementById("lam-body");
  const footer = document.getElementById("lam-footer");

  title.textContent = `Location ${String(ctx.loc_num || "").padStart(5, "0")}`;
  subtitle.textContent = `AREA ${normalizeAreaNum(ctx.area_num)} • ${
    ctx.area_desc || ""
  }`;
  const priorDesc = String(ctx.prior_desc || "").trim();
  const locationMessage = String(ctx.location_message || "").trim();
  const showPrior = String(ctx.show_prior_desc || "") === "1" &&
    priorDesc.length > 0 &&
    priorDesc !== String(ctx.loc_desc || "").trim();
  const showMsg = locationMessage.length > 0;
  const noteBlocks = [];
  if (showPrior) {
    noteBlocks.push(`
      <div style="margin-bottom:8px;">
        <div style="font-weight:700; margin-bottom:4px;">Prior Description</div>
        <div class="loc-msg-body">${escapeHtml(priorDesc)}</div>
      </div>
    `);
  }
  if (showMsg) {
    noteBlocks.push(`
      <div>
        <div style="font-weight:700; margin-bottom:4px;">Message</div>
        <div class="loc-msg-body">${escapeHtml(locationMessage)}</div>
      </div>
    `);
  }
  const extraInfoHtml = noteBlocks.length > 0
    ? `
    <div style="margin-top:12px; border-top:1px dashed #d0d7e2; padding-top:10px;">
      <div style="font-size:12px; font-weight:800; letter-spacing:0.02em; color:#5f6b7a; text-transform:uppercase; margin-bottom:6px;">Location Notes</div>
      ${noteBlocks.join("")}
    </div>
  `
    : "";

  if (modalState.step === "choose") {
    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <div style="font-weight:700; margin-bottom:6px;">${escapeHtml(
          ctx.loc_desc || "",
        )}</div>
        <div class="muted">What would you like to do?</div>
      </div>

      <div class="modal-actions">
        <button id="lam-btn-recount" class="btn btn-primary" type="button">Recount</button>
        <button id="lam-btn-question" class="btn" type="button">Question</button>
      </div>
      ${extraInfoHtml}
    `;

    footer.innerHTML = `
      <div class="muted">Choose an action for this location.</div>
    `;

    document.getElementById("lam-btn-recount").onclick = () =>
      setModalStep("recount");
    document.getElementById("lam-btn-question").onclick = () =>
      setModalStep("question");
    return;
  }

  if (modalState.step === "recount") {
    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <div class="muted" style="margin-bottom:6px;">Optional: add a reason (can be blank)</div>
        <textarea id="lam-reason" class="modal-textarea" rows="4" placeholder="Reason (optional)"></textarea>
      </div>
      ${extraInfoHtml}
    `;

    footer.innerHTML = `
      <div class="modal-actions">
        <button id="lam-back" class="btn" type="button">Back</button>
        <button id="lam-submit-recount" class="btn btn-primary" type="button">Submit Recount</button>
      </div>
    `;

    document.getElementById("lam-back").onclick = () => setModalStep("choose");
    document.getElementById("lam-submit-recount").onclick = async () => {
      const reason = document.getElementById("lam-reason").value || "";
      await submitLocationAction({
        action: "recount",
        text: reason,
      });
    };
    return;
  }

  if (modalState.step === "question") {
    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <div class="muted" style="margin-bottom:6px;">Enter a message for this location</div>
        <textarea id="lam-question" class="modal-textarea" rows="5" placeholder="Type your question..."></textarea>
      </div>
      ${extraInfoHtml}
    `;

    footer.innerHTML = `
      <div class="modal-actions">
        <button id="lam-back" class="btn" type="button">Back</button>
        <button id="lam-submit-question" class="btn btn-primary" type="button">Submit Question</button>
      </div>
    `;

    document.getElementById("lam-back").onclick = () => setModalStep("choose");
    document.getElementById("lam-submit-question").onclick = async () => {
      const msg = document.getElementById("lam-question").value || "";
      if (msg.trim().length === 0) {
        alert("Please enter a message (or go Back).");
        return;
      }
      await submitLocationAction({
        action: "question",
        text: msg,
      });
    };
    return;
  }
}

async function submitLocationAction({ action, text }) {
  const ctx = modalState.context;
  if (!ctx) return;

  const footer = document.getElementById("lam-footer");
  footer.querySelectorAll("button").forEach((b) => (b.disabled = true));
  statusEl.textContent = "Saving…";

  const url = `/api/report-exports/${encodeURIComponent(
    ctx.file,
  )}/location-action`;
  const payload = {
    area_num: ctx.area_num,
    loc_num: ctx.loc_num,
    action, // "recount" | "question"
    text, // reason or question message
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await postJsonQueued(url, payload, {
      applyLocal: () => {
        // Update cached file so user can continue navigating with accurate local state
        patchCachedFile(ctx.file, (data) => {
          // store in a top-level actions array compatible with existing extraction
          const keyNames = ["location_actions", "locationActions", "actions"];
          let arr = null;
          let targetKey = "location_actions";

          for (const k of keyNames) {
            if (Array.isArray(data[k])) {
              arr = data[k];
              targetKey = k;
              break;
            }
          }
          if (!arr) {
            data[targetKey] = [];
            arr = data[targetKey];
          }

          arr.push({
            area_num: ctx.area_num,
            loc_num: ctx.loc_num,
            action,
            text,
            timestamp: payload.timestamp,
          });
        });
      },
    });

    if (result.queued) {
      statusEl.textContent = `Saved offline (queued).`;
    } else {
      statusEl.textContent = `Saved ${action} for location ${String(
        ctx.loc_num,
      ).padStart(5, "0")}.`;
    }

    closeActionModal();

    // Refresh current view so it reflects updated JSON
    if (currentView.type === "area") {
      await loadArea(currentView.file);
    } else if (currentView.type === "group") {
      await loadAreaGroup(currentView.groupId, currentView.members);
    }
  } catch (err) {
    console.error(err);
    alert(`Could not save: ${err.message || err}`);
    statusEl.textContent = "Save failed.";
    footer.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

// --------------------
// Prior location description (show_prior_loc_desc)
// When a location has show_prior_loc_desc=true, we show a small icon next to
// the location number. Clicking toggles an inline block that displays the
// prior location description (if present in the export).
// --------------------

function getPriorLocDesc(loc) {
  if (!loc || typeof loc !== "object") return "";

  // Common export field names (best-effort)
  const candidates = [
    loc.prior_loc_desc,
    loc.priorLocDesc,
    loc.prior_location_desc,
    loc.priorLocationDesc,
    loc.loc_desc_prior,
    loc.locDescPrior,
    loc.loc_desc_prior1,
    loc.locDescPrior1,
    loc.prior_desc,
    loc.priorDesc,
  ];

  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  return "";
}

// --------------------
// Location message (location_message)
// If a location has a non-empty message, show a small icon next to the loc number.
// Clicking opens a modal to view the message.
// --------------------

function getLocationMessage(loc) {
  if (!loc || typeof loc !== "object") return "";

  const candidates = [
    loc.location_message,
    loc.locationMessage,
    loc.location_note,
    loc.locationNote,
    loc.message,
    loc.note,
  ];

  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  return "";
}

function ensureLocationMessageModal() {
  if (document.getElementById("loc-msg-modal")) return;

  const modalHtml = `
<div id="loc-msg-modal" class="modal-backdrop" style="display:none;">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div id="lmm-title" style="font-weight:800; font-size:20px;">Location Message</div>
        <div id="lmm-subtitle" class="muted mono" style="margin-top:4px;"></div>
      </div>
      <button id="lmm-close" class="btn" type="button">✕</button>
    </div>

    <div class="modal-body">
      <div id="lmm-locdesc" style="font-weight:700; margin-bottom:10px;"></div>
      <div id="lmm-body" class="loc-msg-body"></div>
    </div>

    <div class="modal-footer">
      <div class="modal-actions">
        <button id="lmm-ok" class="btn btn-primary" type="button">OK</button>
      </div>
    </div>
  </div>
</div>
`;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const close = () => {
    const m = document.getElementById("loc-msg-modal");
    if (m) m.style.display = "none";
  };

  document.getElementById("lmm-close").addEventListener("click", close);
  document.getElementById("lmm-ok").addEventListener("click", close);

  document.getElementById("loc-msg-modal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "loc-msg-modal") close();
  });

  document.addEventListener("keydown", (e) => {
    const m = document.getElementById("loc-msg-modal");
    if (e.key === "Escape" && m && m.style.display === "flex") close();
  });
}

function openLocationMessageModal({
  area_num,
  area_desc,
  loc_num,
  loc_desc,
  message,
}) {
  ensureLocationMessageModal();

  const m = document.getElementById("loc-msg-modal");
  const title = document.getElementById("lmm-title");
  const subtitle = document.getElementById("lmm-subtitle");
  const locdescEl = document.getElementById("lmm-locdesc");
  const body = document.getElementById("lmm-body");

  title.textContent = `Message — LOC ${String(loc_num || "").padStart(5, "0")}`;
  subtitle.textContent = `AREA ${normalizeAreaNum(area_num)} • ${
    area_desc || ""
  }`;
  locdescEl.textContent = String(loc_desc || "");

  body.textContent = String(message || "");

  m.style.display = "flex";
}

function wireLocationMessageButtons(root) {
  (root || document).querySelectorAll(".loc-msg-btn").forEach((btn) => {
    if (btn.dataset.boundMsg === "1") return;
    btn.dataset.boundMsg = "1";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const message = btn.dataset.msg || "";
      if (!message.trim()) return;

      openLocationMessageModal({
        area_num: btn.dataset.areaNum || "",
        area_desc: btn.dataset.areaDesc || "",
        loc_num: btn.dataset.locNum || "",
        loc_desc: btn.dataset.locDesc || "",
        message,
      });
    });
  });
}

function wirePriorDescButtons(root) {
  (root || document).querySelectorAll(".prior-desc-btn").forEach((btn) => {
    if (btn.dataset.boundPrior === "1") return;
    btn.dataset.boundPrior = "1";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const targetId = btn.dataset.priorTarget || "";
      const desc = btn.dataset.priorDesc || "";

      if (!targetId) return;

      const box = document.getElementById(targetId);
      if (!box) return;

      if (!desc) {
        alert("Prior location description not found in this export.");
        return;
      }

      // Toggle
      const isOpen = box.style.display !== "none";
      if (isOpen) {
        box.style.display = "none";
        box.textContent = "";
      } else {
        box.innerHTML = `<strong>Prior Description:</strong> ${desc}`;
        box.style.display = "block";
      }
    });
  });
}

function setBreakdownExpanded(btn, panel, nextOpen) {
  btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  btn.classList.toggle("open", nextOpen);
  btn.setAttribute(
    "aria-label",
    nextOpen ? "Collapse category breakdown" : "Expand category breakdown",
  );
  btn.setAttribute(
    "title",
    nextOpen ? "Hide category breakdown" : "Show category breakdown",
  );

  panel.hidden = !nextOpen;
  const row = btn.closest(".report-row.report-main");
  if (row) row.classList.toggle("expanded", nextOpen);
}

const BREAKDOWN_PREF_COOKIE = "report_breakdown_pref_v1";

function readCookie(name) {
  const parts = String(document.cookie || "").split(";");
  for (const p of parts) {
    const [k, ...rest] = p.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

function writeCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function parseBreakdownPrefs() {
  const raw = readCookie(BREAKDOWN_PREF_COOKIE);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function getPreferredBreakdownExpanded(reportTypeKey) {
  const prefs = parseBreakdownPrefs();
  if (Object.prototype.hasOwnProperty.call(prefs, reportTypeKey)) {
    return !!prefs[reportTypeKey];
  }
  // Default policy:
  // - standard reports (non scan_report): expanded
  // - scan_report: collapsed
  return reportTypeKey !== "scan_report";
}

function savePreferredBreakdownExpanded(reportTypeKey, expanded) {
  const prefs = parseBreakdownPrefs();
  prefs[reportTypeKey] = !!expanded;
  writeCookie(BREAKDOWN_PREF_COOKIE, JSON.stringify(prefs));
}

function applyBreakdownPreference(root, reportTypeKey) {
  const scope = root || document;
  const shouldOpen = getPreferredBreakdownExpanded(reportTypeKey);
  const buttons = Array.from(scope.querySelectorAll(".row-disclosure-btn"));

  buttons.forEach((btn) => {
    const targetId = btn.dataset.target || "";
    const panel = targetId ? document.getElementById(targetId) : null;
    if (!panel) return;
    setBreakdownExpanded(btn, panel, shouldOpen);
  });

  refreshToggleAllBreakdownsButton(scope);
}

function refreshToggleAllBreakdownsButton(root) {
  const toggleBtn = document.getElementById("toggle-all-breakdowns");
  if (!toggleBtn) return;

  const buttons = Array.from(
    (root || document).querySelectorAll(".row-disclosure-btn"),
  );

  if (buttons.length === 0) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = "Expand All";
    return;
  }

  toggleBtn.disabled = false;
  const allOpen = buttons.every((b) => b.getAttribute("aria-expanded") === "true");
  toggleBtn.textContent = allOpen ? "Collapse All" : "Expand All";
}

function wireBreakdownDisclosureButtons(root, reportTypeKey = "standard") {
  (root || document).querySelectorAll(".row-disclosure-btn").forEach((btn) => {
    if (btn.dataset.boundDisclosure === "1") return;
    btn.dataset.boundDisclosure = "1";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const targetId = btn.dataset.target || "";
      if (!targetId) return;

      const panel = document.getElementById(targetId);
      if (!panel) return;

      const nextOpen = btn.getAttribute("aria-expanded") !== "true";
      setBreakdownExpanded(btn, panel, nextOpen);
      const scope = root || document;
      refreshToggleAllBreakdownsButton(scope);

      // If user ends up with everything open/closed by individual toggles,
      // treat that as their preference for this report type.
      const buttons = Array.from(scope.querySelectorAll(".row-disclosure-btn"));
      const allOpen = buttons.length > 0 &&
        buttons.every((b) => b.getAttribute("aria-expanded") === "true");
      const allClosed = buttons.length > 0 &&
        buttons.every((b) => b.getAttribute("aria-expanded") !== "true");
      if (allOpen || allClosed) {
        savePreferredBreakdownExpanded(reportTypeKey, allOpen);
      }
    });
  });
}

function wireToggleAllBreakdownsButton(root, reportTypeKey = "standard") {
  const toggleBtn = document.getElementById("toggle-all-breakdowns");
  if (!toggleBtn || toggleBtn.dataset.boundToggleAll === "1") {
    refreshToggleAllBreakdownsButton(root || document);
    return;
  }
  toggleBtn.dataset.boundToggleAll = "1";

  toggleBtn.addEventListener("click", (e) => {
    e.preventDefault();

    const scope = root || document;
    const buttons = Array.from(scope.querySelectorAll(".row-disclosure-btn"));
    if (buttons.length === 0) return;

    const shouldOpen = buttons.some(
      (b) => b.getAttribute("aria-expanded") !== "true",
    );

    buttons.forEach((btn) => {
      const targetId = btn.dataset.target || "";
      const panel = targetId ? document.getElementById(targetId) : null;
      if (!panel) return;
      setBreakdownExpanded(btn, panel, shouldOpen);
    });

    savePreferredBreakdownExpanded(reportTypeKey, shouldOpen);
    refreshToggleAllBreakdownsButton(scope);
  });

  refreshToggleAllBreakdownsButton(root || document);
}

// --------------------
// Review close prompt modal
// --------------------

function ensureReviewCloseModal() {
  if (document.getElementById("review-close-modal")) return;

  const modalHtml = `
<div id="review-close-modal" class="modal-backdrop" style="display:none;">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div style="font-weight:800; font-size:20px;">Mark Area Reviewed?</div>
        <div class="muted" style="margin-top:4px;">This area is not marked as reviewed.</div>
      </div>
      <button id="review-close-x" class="btn" type="button">✕</button>
    </div>
    <div class="modal-body">
      Mark this area as reviewed before closing?
    </div>
    <div class="modal-footer">
      <div class="modal-actions">
        <button id="review-close-skip" class="btn" type="button">Close Without Review</button>
        <button id="review-close-mark" class="btn btn-primary" type="button">Mark Reviewed</button>
      </div>
    </div>
  </div>
</div>
`;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
}

function promptMarkReviewedBeforeClose() {
  ensureReviewCloseModal();

  return new Promise((resolve) => {
    const modal = document.getElementById("review-close-modal");
    const btnX = document.getElementById("review-close-x");
    const btnSkip = document.getElementById("review-close-skip");
    const btnMark = document.getElementById("review-close-mark");

    const onEsc = (e) => {
      if (e.key === "Escape") finalize(false);
    };

    const onBackdrop = (e) => {
      if (e.target && e.target.id === "review-close-modal") finalize(false);
    };

    const finalize = (val) => {
      modal.style.display = "none";
      btnX.removeEventListener("click", onX);
      btnSkip.removeEventListener("click", onSkip);
      btnMark.removeEventListener("click", onMark);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEsc);
      resolve(val);
    };

    const onX = () => finalize(false);
    const onSkip = () => finalize(false);
    const onMark = () => finalize(true);

    btnX.addEventListener("click", onX);
    btnSkip.addEventListener("click", onSkip);
    btnMark.addEventListener("click", onMark);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEsc);

    modal.style.display = "flex";
  });
}

// --------------------
// Row click wiring
// --------------------

function wireLocationRowClicks(root, viewContext) {
  (root || document)
    .querySelectorAll(".report-row.report-main")
    .forEach((row) => {
      if (row.dataset.boundClick === "1") return;
      row.dataset.boundClick = "1";

      row.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;

        const file = row.getAttribute("data-file") || viewContext.file;
        const area_num =
          row.getAttribute("data-area-num") || viewContext.area_num;
        const area_desc =
          row.getAttribute("data-area-desc") || viewContext.area_desc;

        const loc_num = row.getAttribute("data-loc-num") || "";
        const loc_desc = row.getAttribute("data-loc-desc") || "";
        const prior_desc = row.getAttribute("data-prior-desc") || "";
        const location_message = row.getAttribute("data-location-message") || "";
        const show_prior_desc = row.getAttribute("data-show-prior-desc") || "";

        openActionModal({
          file,
          area_num,
          area_desc,
          loc_num,
          loc_desc,
          prior_desc,
          location_message,
          show_prior_desc,
        });
      });
    });
}

// --------------------
// IndexedDB cache (for large GET responses)
// --------------------

// Tune these if you want more/less offline history
const IDB_NAME = "report_cache_db_v1";
const IDB_KV_STORE = "kv";
const IDB_META_STORE = "meta";
const MAX_CACHED_FILES = 60; // keep last N area JSON files on-device

let __idbPromise = null;

function openIdb() {
  if (__idbPromise) return __idbPromise;
  __idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_KV_STORE)) {
        db.createObjectStore(IDB_KV_STORE);
      }
      if (!db.objectStoreNames.contains(IDB_META_STORE)) {
        db.createObjectStore(IDB_META_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
  return __idbPromise;
}

function idbTx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let outReq;
    try {
      outReq = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(outReq?.result);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB tx aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB tx error"));
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return idbTx(db, IDB_KV_STORE, "readonly", (store) => store.get(key));
}

async function idbSet(key, valueObj) {
  const db = await openIdb();
  // Save data
  await idbTx(db, IDB_KV_STORE, "readwrite", (store) =>
    store.put(valueObj, key),
  );
}

async function idbDel(key) {
  const db = await openIdb();
  await idbTx(db, IDB_KV_STORE, "readwrite", (store) => store.delete(key));
}

async function idbMetaSet(key, metaObj) {
  const db = await openIdb();
  await idbTx(db, IDB_META_STORE, "readwrite", (store) =>
    store.put(metaObj, key),
  );
}

async function idbMetaGetAllEntries() {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_META_STORE, "readonly");
    const store = tx.objectStore(IDB_META_STORE);
    const req = store.getAll(); // values
    const reqKeys = store.getAllKeys(); // keys
    tx.oncomplete = () => {
      const keys = reqKeys.result || [];
      const vals = req.result || [];
      const entries = keys.map((k, i) => [k, vals[i]]);
      resolve(entries);
    };
    tx.onerror = () =>
      reject(tx.error || new Error("IndexedDB meta read failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB meta aborted"));
  });
}

function isLargeCacheKey(key) {
  // Only move the big GET payloads into IndexedDB
  // LIST, FILE, CHAT all start with `${CACHE_NS}:GET:`
  return typeof key === "string" && key.startsWith(`${CACHE_NS}:GET:`);
}

async function cacheGetLarge(key) {
  if (!isLargeCacheKey(key)) return cacheGet(key); // your existing localStorage cacheGet
  try {
    const obj = await idbGet(key);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch (e) {
    console.warn("idb cacheGet failed", e);
    return null;
  }
}

async function cacheSetLarge(key, valueObj, metaType) {
  if (!isLargeCacheKey(key)) {
    cacheSet(key, valueObj); // your existing localStorage cacheSet
    return;
  }

  try {
    await idbSet(key, valueObj);
    // Track for eviction
    await idbMetaSet(key, {
      ts: valueObj?.ts || Date.now(),
      type: metaType || "get",
    });
    if (metaType === "file") await evictOldFilesIfNeeded();
  } catch (e) {
    console.warn("idb cacheSet failed", e);
  }
}

async function evictOldFilesIfNeeded() {
  try {
    const entries = await idbMetaGetAllEntries();
    const fileEntries = entries
      .filter(([k, v]) => v && v.type === "file")
      .map(([k, v]) => ({ key: k, ts: Number(v.ts) || 0 }))
      .sort((a, b) => a.ts - b.ts); // oldest first

    const excess = fileEntries.length - MAX_CACHED_FILES;
    if (excess <= 0) return;

    const toDelete = fileEntries.slice(0, excess);
    for (const it of toDelete) {
      await idbDel(it.key);
      // also delete meta
      const db = await openIdb();
      await idbTx(db, IDB_META_STORE, "readwrite", (store) =>
        store.delete(it.key),
      );
    }
  } catch (e) {
    console.warn("evictOldFilesIfNeeded failed", e);
  }
}

// Optional: ask the browser to keep storage persistent (helps on Android)
(async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {}
})();

// --------------------
// Chat log (view + send) backed by /api/chatlog (Report-Site/chatlog.json)
// No search; tablet-optimized modal.
// --------------------
const CHAT_USER = "Store Manager";

const chatState = {
  open: false,
  loading: false,
};

function ensureChatModal() {
  if (document.getElementById("chatlog-modal")) return;

  const html = `
<div id="chatlog-modal" class="modal-backdrop" style="display:none;">
  <div class="modal chat-modal">
    <div class="modal-header">
      <div>
        <div style="font-weight:900; font-size:20px;">Chat Log</div>
      </div>
      <button id="chat-close" class="btn" type="button">✕</button>
    </div>

    <div id="chat-body" class="chat-body" aria-live="polite"></div>

    <div class="chat-compose">
      <div class="chat-compose-row">
        <textarea id="chat-input" class="chat-input" rows="2" placeholder="Type a message…"></textarea>
        <button id="chat-send" class="btn btn-primary chat-send" type="button">Send</button>
      </div>
    </div>
  </div>
</div>
`;
  document.body.insertAdjacentHTML("beforeend", html);

  const close = () => closeChatModal();

  document.getElementById("chat-close").addEventListener("click", close);
  document.getElementById("chatlog-modal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "chatlog-modal") close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chatState.open) close();
  });

  document
    .getElementById("chat-send")
    .addEventListener("click", sendChatMessage);

  // Enter to send; Shift+Enter for newline
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

function openChatModal() {
  ensureChatModal();
  installVisualViewportFixForChat();

  chatState.open = true;
  const m = document.getElementById("chatlog-modal");
  m.style.display = "flex";

  loadAndRenderChat({ scrollToBottom: true });

  setTimeout(() => {
    const ta = document.getElementById("chat-input");
    ta?.focus();
  }, 50);
}

function closeChatModal() {
  chatState.open = false;
  const m = document.getElementById("chatlog-modal");
  if (m) m.style.display = "none";
}

function groupByDay(messages) {
  const out = [];
  let lastDay = null;

  for (const msg of messages) {
    const ts = String(msg.timestamp || "");
    const d = new Date(ts);
    const dayKey = Number.isNaN(d.getTime())
      ? "Unknown date"
      : d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });

    if (dayKey !== lastDay) {
      out.push({ kind: "day", label: dayKey });
      lastDay = dayKey;
    }
    out.push({ kind: "msg", msg });
  }

  return out;
}

function renderChat(chatObj, { scrollToBottom } = {}) {
  const body = document.getElementById("chat-body");
  if (!body) return;

  const msgs = Array.isArray(chatObj?.messages) ? chatObj.messages : [];
  const sorted = msgs.slice().sort((a, b) => {
    const ta = Date.parse(a.timestamp || "");
    const tb = Date.parse(b.timestamp || "");

    // If both parse, sort by actual time (oldest -> newest)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;

    // Fallback: stable-ish string compare if timestamps aren't ISO
    return String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
  });

  if (sorted.length === 0) {
    body.innerHTML = `<div class="muted" style="padding:10px;">No messages yet.</div>`;
    return;
  }

  const items = groupByDay(sorted);

  body.innerHTML = items
    .map((it) => {
      if (it.kind === "day") {
        return `<div class="chat-day">${escapeHtml(it.label)}</div>`;
      }

      const m = it.msg || {};
      const from = String(m.user || m.from || "Unknown");
      const text = String(m.message || m.text || "");
      const d = new Date(String(m.timestamp || ""));
      const time = Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          });

      const isMe =
        String(from).trim().toLowerCase() ===
        String(CHAT_USER).trim().toLowerCase();
      const whoClass = isMe ? "chat-me" : "chat-them";

      return `
<div class="chat-msg ${whoClass}">
  <div class="chat-meta">
    <div class="chat-from">${escapeHtml(from)}</div>
    <div class="chat-time mono">${escapeHtml(time)}</div>
  </div>
  <div class="chat-bubble">${escapeHtml(text)}</div>
</div>`;
    })
    .join("");

  if (scrollToBottom) {
    body.scrollTop = body.scrollHeight;
  }
}

async function loadAndRenderChat({ scrollToBottom } = {}) {
  const body = document.getElementById("chat-body");
  if (!body) return;

  try {
    chatState.loading = true;
    body.innerHTML = `<div class="muted" style="padding:10px;">Loading chat…</div>`;

    const out = await fetchJsonWithCache("/api/chatlog", CACHE_KEYS.CHAT);
    renderChat(out.data, { scrollToBottom });
    latestChatMsgMs = computeLatestChatMs(out.data);
    if (chatState.open) markChatSeen();
    else {
      const seen = getSeenMs(SEEN_KEYS.CHAT_LAST_SEEN_MS);
      setNotif(chatBtn, latestChatMsgMs > seen);
    }
    if (out.fromCache) {
      // if cached, be explicit but unobtrusive
      statusEl.textContent = "Chat loaded (cached).";
    }
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="muted" style="padding:10px;">Could not load chat.</div>`;
  } finally {
    chatState.loading = false;
  }
}

function patchCachedChat(mutator) {
  const cached = cacheGet(CACHE_KEYS.CHAT);
  if (!cached || cached.data === undefined) return;

  const data = cached.data;
  if (!data || typeof data !== "object") return;

  try {
    mutator(data);
    cacheSet(CACHE_KEYS.CHAT, { ...cached, ts: Date.now(), data });
  } catch (e) {
    console.warn("patchCachedChat failed", e);
  }
}

async function sendChatMessage() {
  const name = CHAT_USER;

  const ta = document.getElementById("chat-input");
  const btn = document.getElementById("chat-send");
  if (!ta || !btn) return;

  const text = String(ta.value || "").trim();
  if (!text) return;

  btn.disabled = true;
  ta.disabled = true;

  const payload = {
    user: name,
    message: text,
    timestamp: new Date().toISOString(),
  };

  try {
    const result = await postJsonQueued("/api/chatlog", payload, {
      applyLocal: () => {
        // Optimistic update so chat works offline
        patchCachedChat((data) => {
          if (Array.isArray(data)) {
            data.push({ id: `${Date.now()}_local`, ...payload });
            return;
          }
          if (!Array.isArray(data.messages)) data.messages = [];
          data.messages.push({ id: `${Date.now()}_local`, ...payload });
        });
      },
    });

    ta.value = "";

    if (result.queued) {
      statusEl.textContent = "Message saved offline (queued).";
      // render from cache after optimistic append
      const cached = cacheGet(CACHE_KEYS.CHAT);
      renderChat(cached?.data, { scrollToBottom: true });
    } else {
      statusEl.textContent = "Message sent.";
      await loadAndRenderChat({ scrollToBottom: true });
    }
  } catch (e) {
    console.error(e);
    alert(`Could not send: ${e.message || e}`);
    statusEl.textContent = "Send failed.";
  } finally {
    btn.disabled = false;
    ta.disabled = false;
    ta.focus();
  }
}

// --------------------
// Views / navigation
// --------------------

const currentView = {
  type: "list", // "list" | "area" | "group"
  file: null,
  groupId: null,
  members: null,
};

async function loadAreaList() {
  currentView.type = "list";
  currentView.file = null;
  currentView.groupId = null;
  currentView.members = null;

  statusEl.textContent = "Loading…";
  areaList.innerHTML = "";
  content.innerHTML = `<p class="muted">Select an area to view locations + totals.</p>`;

  // list mode = sidebar takes full width; main hidden by CSS
  setSplitMode("list");

  let items;
  try {
    const out = await fetchJsonWithCache(
      "/api/report-exports",
      CACHE_KEYS.LIST,
    );
    items = out.data;
    if (!Array.isArray(items)) items = [];
    if (out.fromCache) {
      // show it's cached, but keep behavior minimal
      statusEl.textContent = "Loading… (cached)";
    }
  } catch (e) {
    statusEl.textContent = `Failed to load areas. ${e.message || e}`;
    return;
  }

  // Enrich by fetching each JSON once (grouping, recounts, reviewed flag)
  const enriched = await Promise.all(
    items.map(async (it) => {
      try {
        const url = `/api/report-exports/${encodeURIComponent(it.file)}`;
        const out = await fetchJsonWithCache(url, CACHE_KEYS.FILE(it.file));
        const data = out.data;
        const eg = getExportGrouping(data);

        return {
          area_num: normalizeAreaNum(it.area_num ?? data.area_num ?? ""),
          area_desc: it.area_desc ?? data.area_desc ?? "",
          location_count:
            it.location_count ??
            (Array.isArray(data.locations) ? data.locations.length : 0),
          file: it.file,
          group_id: eg.group_id,

          // ✅ reviewed comes from JSON
          reviewed: data.reviewed === true,
          reviewed_at: data.reviewed_at || "",

          recounts: extractRecountLocations(data, it.file),
          questions: extractQuestionLocations(data, it.file),
        };
      } catch {
        return {
          area_num: normalizeAreaNum(it.area_num ?? ""),
          area_desc: it.area_desc ?? "",
          location_count: it.location_count ?? 0,
          file: it.file,
          group_id: null,
          reviewed: false,
          reviewed_at: "",
          recounts: [],
          questions: [],
        };
      }
    }),
  );

  syncUnreviewedFirstSeen(enriched);
  latestReviewMs = enriched.reduce(
    (max, e) => Math.max(max, toMs(e?.reviewed_at || "")),
    0,
  );
  renderLastReviewAge();

  // Update notification state (new replies / new chat)
  latestQuestionsReplyMs = computeLatestQuestionsReplyMs(enriched);

  // If the user is on the Questions tab, those replies are now "seen".
  if (currentTab === TABS.QUESTIONS) {
    markQuestionsRepliesSeen();
  } else {
    refreshQuestionsNotification();
  }

  refreshChatNotification();

  // group_id -> members[]
  const groups = new Map();
  const singles = [];

  for (const e of enriched) {
    if (e.group_id) {
      if (!groups.has(e.group_id)) groups.set(e.group_id, []);
      groups.get(e.group_id).push(e);
    } else {
      singles.push(e);
    }
  }

  for (const [gid, arr] of groups.entries()) {
    arr.sort((a, b) => String(a.area_num).localeCompare(String(b.area_num)));
  }

  const groupEntries = Array.from(groups.entries()).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  );
  singles.sort((a, b) => String(a.area_num).localeCompare(String(b.area_num)));

  // ---- Recounts tab ----
  if (currentTab === TABS.RECOUNTS) {
    const recountRows = enriched
      .flatMap((e) => e.recounts || [])
      .sort((a, b) => {
        const aa = String(a.area_num || "");
        const ba = String(b.area_num || "");
        if (aa !== ba) return aa.localeCompare(ba);
        return String(a.loc_num || "").localeCompare(String(b.loc_num || ""));
      });

    statusEl.textContent = `${recountRows.length} recount location(s).`;

    if (recountRows.length === 0) {
      areaList.innerHTML = `<li class="muted">No recounts.</li>`;
      return;
    }

    for (const r of recountRows) {
      const li = document.createElement("li");
      const locLabel = String(r.loc_num || "").padStart(5, "0");
      const reason = (r.reason || "").trim();

      li.innerHTML = `
        <div><strong>LOC ${escapeHtml(locLabel)} — ${escapeHtml(
          r.loc_desc || "",
        )}</strong></div>
        <div class="mono muted">AREA ${escapeHtml(
          r.area_num || "",
        )} • ${escapeHtml(r.area_desc || "")}</div>
        ${reason ? `<div class="muted">${escapeHtml(reason)}</div>` : ""}
      `;

      li.addEventListener("click", async () => {
        await loadArea(r.file);
        jumpToLocationInView(r.loc_num);
      });

      areaList.appendChild(li);
    }
    return;
  }

  // ---- Questions tab ----
  if (currentTab === TABS.QUESTIONS) {
    const questionRows = enriched
      .flatMap((e) => e.questions || [])
      .sort((a, b) => {
        const aa = String(a.area_num || "");
        const ba = String(b.area_num || "");
        if (aa !== ba) return aa.localeCompare(ba);
        return String(a.loc_num || "").localeCompare(String(b.loc_num || ""));
      });

    statusEl.textContent = `${questionRows.length} question location(s).`;

    if (questionRows.length === 0) {
      areaList.innerHTML = `<li class="muted">No questions.</li>`;
      return;
    }

    for (const q of questionRows) {
      const li = document.createElement("li");
      const locLabel = String(q.loc_num || "").padStart(5, "0");
      const msg = (q.message || "").trim();

      li.innerHTML = `
  <div><strong>LOC ${escapeHtml(locLabel)} — ${escapeHtml(q.loc_desc || "")}</strong></div>
  <div class="mono muted">AREA ${escapeHtml(q.area_num || "")} • ${escapeHtml(q.area_desc || "")}</div>
  ${msg ? `<div class="muted">${escapeHtml(msg)}</div>` : ""}
  ${
    String(q.reply || "").trim()
      ? `<div class="muted" style="margin-top:6px;">
          <strong>ANSWER: </strong>${escapeHtml(q.reply)}
        </div>`
      : ""
  }
`;

      li.addEventListener("click", async () => {
        await loadArea(q.file);
        jumpToLocationInView(q.loc_num);
      });
      areaList.appendChild(li);
    }
    markQuestionsRepliesSeen();

    return;
  }

  // ---- To Be Reviewed / Reviewed tabs ----

  const keepGroup = (members) => {
    const allReviewed = members.every((m) => m.reviewed);
    if (currentTab === TABS.REVIEWED) return allReviewed;
    // TO_REVIEW: keep group until every member is reviewed
    return !allReviewed;
  };

  const keepSingle = (it) => {
    if (currentTab === TABS.REVIEWED) return it.reviewed;
    return !it.reviewed;
  };

  const visibleGroups = groupEntries.filter(([, members]) =>
    keepGroup(members),
  );
  const visibleSingles = singles.filter((s) => keepSingle(s));

  if (currentTab === TABS.TO_REVIEW) {
    const nowMs = Date.now();
    const groupOldestMs = (members) => {
      const unreviewed = (members || []).filter((m) => m.reviewed !== true);
      if (unreviewed.length === 0) return nowMs;
      return unreviewed.reduce(
        (min, m) => Math.min(min, getUnreviewedFirstSeenMs(m.file, nowMs)),
        nowMs,
      );
    };

    visibleGroups.sort((a, b) => {
      const byAge = groupOldestMs(a[1]) - groupOldestMs(b[1]); // oldest first
      if (byAge !== 0) return byAge;
      return String(a[0]).localeCompare(String(b[0]));
    });

    visibleSingles.sort((a, b) => {
      const byAge =
        getUnreviewedFirstSeenMs(a.file, nowMs) -
        getUnreviewedFirstSeenMs(b.file, nowMs); // oldest first
      if (byAge !== 0) return byAge;
      return String(a.area_num).localeCompare(String(b.area_num));
    });
  }

  statusEl.textContent = `${visibleGroups.length} group(s), ${
    visibleSingles.length
  } single area(s) — tab: ${
    currentTab === TABS.REVIEWED ? "Reviewed" : "To Be Reviewed"
  }.`;

  const renderGroupItem = (gid, members) => {
    const li = document.createElement("li");
    const areaNums = members.map((m) => m.area_num).filter(Boolean);
    const areaLabel = summarizeAreaNumbers(areaNums, 2);
    const locationCount = members.reduce(
      (acc, m) => acc + Number(m.location_count || 0),
      0,
    );
    const title = buildGroupTitleFromDescriptions(members);
    const allReviewed = members.every((m) => m.reviewed);
    const oldestMs = members
      .filter((m) => m.reviewed !== true)
      .reduce(
        (min, m) => Math.min(min, getUnreviewedFirstSeenMs(m.file)),
        Date.now(),
      );
    const ageMs = Math.max(0, Date.now() - oldestMs);
    const agingClass = getAgingClass(ageMs);
    if (currentTab === TABS.TO_REVIEW) li.classList.add(agingClass);

    li.innerHTML = `
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">
        <strong>${escapeHtml(title)}</strong>
        ${
          allReviewed
            ? `<span class="muted">Reviewed &#10003;</span>`
            : currentTab === TABS.TO_REVIEW
              ? `<span class="age-pill ${agingClass}">&#128339; ${escapeHtml(formatAgeShortFromMs(ageMs))}</span>`
              : ""
        }
      </div>
      <div class="mono muted">${escapeHtml(areaLabel)}</div>
      <div class="muted">${members.length} areas &bull; ${locationCount} locations</div>
    `;

    li.addEventListener("click", () => loadAreaGroup(gid, members));
    return { li, sortMs: oldestMs, sortLabel: title };
  };

  const renderSingleItem = (item) => {
    const li = document.createElement("li");
    const reviewed = item.reviewed === true;
    const firstSeenMs = getUnreviewedFirstSeenMs(item.file);
    const ageMs = Math.max(0, Date.now() - firstSeenMs);
    const agingClass = getAgingClass(ageMs);
    if (currentTab === TABS.TO_REVIEW && !reviewed) li.classList.add(agingClass);

    li.innerHTML = `
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">
        <strong>${escapeHtml(item.area_desc || "")}</strong>
        ${
          reviewed
            ? `<span class="muted">Reviewed &#10003;</span>`
            : currentTab === TABS.TO_REVIEW
              ? `<span class="age-pill ${agingClass}">&#128339; ${escapeHtml(formatAgeShortFromMs(ageMs))}</span>`
              : ""
        }
      </div>
      <div class="mono muted">${escapeHtml(item.area_num ?? "")}</div>
      <div class="muted">${item.location_count ?? 0} locations</div>
    `;

    li.addEventListener("click", () => loadArea(item.file));
    return { li, sortMs: firstSeenMs, sortLabel: item.area_desc || "" };
  };

  if (currentTab === TABS.TO_REVIEW) {
    const merged = [
      ...visibleGroups.map(([gid, members]) => renderGroupItem(gid, members)),
      ...visibleSingles.map((item) => renderSingleItem(item)),
    ];

    merged.sort((a, b) => {
      const byAge = a.sortMs - b.sortMs; // oldest first
      if (byAge !== 0) return byAge;
      return String(a.sortLabel).localeCompare(String(b.sortLabel));
    });

    merged.forEach((x) => areaList.appendChild(x.li));
    return;
  }

  for (const [gid, members] of visibleGroups) {
    areaList.appendChild(renderGroupItem(gid, members).li);
  }
  for (const item of visibleSingles) {
    areaList.appendChild(renderSingleItem(item).li);
  }
}

async function loadAreaGroup(groupId, members) {
  currentView.type = "group";
  currentView.groupId = groupId;
  currentView.members = members;
  currentView.file = null;

  statusEl.textContent = `Loading group…`;

  const results = await Promise.all(
    (members || []).map(async (m) => {
      const url = `/api/report-exports/${encodeURIComponent(m.file)}`;
      const out = await fetchJsonWithCache(url, CACHE_KEYS.FILE(m.file));
      const data = out.data;
      return { meta: m, data };
    }),
  );

  // report view: fullscreen
  setSplitMode("fullscreen");

  const first = results[0]?.data || {};
  const dates = first.dates || {};
  const isScanReport = first.report_type === "scan_report";
  const reportTypeKey = isScanReport ? "scan_report" : "standard";

  function fmtDateLabel(iso, fallback) {
    if (!iso) return fallback;
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { timeZone: "UTC" });
  }

  let headerColumns, groupGrand;

  // Gather all locations from all areas to calc widths globally
  const allLocs = results.flatMap((r) =>
    Array.isArray(r.data?.locations) ? r.data.locations : [],
  );

  let gridStyle = ""; // Will be computed

  if (isScanReport) {
    const col1 = fmtDateLabel(dates.current, "Current");
    const col2 = fmtDateLabel(dates.prior1, "Prior 1");

    // Dynamic width calculation
    gridStyle = calculateDynamicGrid(allLocs, "scan_report", [
      col1,
      col2,
      "+/-",
      "Pieces",
      "Prior",
      "+/-",
      "SKUs",
    ]);

    headerColumns = `
      <div class="report-grid" ${gridStyle} style="font-weight:700; font-size:17px;">
        <div style="grid-column: 1 / span 1;"></div>
        <div class="num">${col1}</div>
        <div class="num">${col2}</div>
        <div class="num">+/-</div>
        <div class="num">Pieces</div>
        <div class="num">Prior</div>
        <div class="num">+/-</div>
        <div class="num">SKUs</div>
      </div>
    `;

    groupGrand = { c: 0, p1: 0, v: 0, qc: 0, qp1: 0, qv: 0, sku: 0 };
  } else {
    // Standard 4 col
    const col1 = fmtDateLabel(dates.current, "Current");
    const col2 = fmtDateLabel(dates.prior1, "Prior 1");
    const col3 = fmtDateLabel(dates.prior2, "Prior 2");
    const col4 = fmtDateLabel(dates.prior3, "Prior 3");

    // Dynamic width calculation
    gridStyle = calculateDynamicGrid(allLocs, "standard", [
      col1,
      col2,
      col3,
      col4,
    ]);

    headerColumns = `
      <div class="report-grid" ${gridStyle} style="font-weight:700; font-size:17px;">
        <div style="grid-column: 1 / span 1;"></div>
        <div class="num">${col1}</div>
        <div class="num">${col2}</div>
        <div class="num">${col3}</div>
        <div class="num">${col4}</div>
      </div>
    `;

    groupGrand = { c: 0, p1: 0, p2: 0, p3: 0 };
  }

  const headerHtml = `
    <div class="report-header">
      <div class="row" style="margin-bottom:10px;">
        <button id="back-to-areas" class="btn" type="button">← Areas</button>
        <button id="toggle-all-breakdowns" class="btn" type="button">Expand All</button>
        <button id="mark-reviewed" class="btn btn-primary" type="button">Mark Reviewed</button>
      </div>
      ${headerColumns}
    </div>
  `;

  const sectionsHtml = results
    .sort((a, b) =>
      String(a.data.area_num ?? "").localeCompare(
        String(b.data.area_num ?? ""),
      ),
    )
    .map(({ meta, data }) => {
      const locs = Array.isArray(data.locations) ? data.locations : [];

      let areaGrand;
      let areaFooter;
      let rowsHtml;

      if (isScanReport) {
        areaGrand = locs.reduce(
          (acc, l) => {
            acc.c += Number(l.ext_price_total_current || 0);
            acc.p1 += Number(l.ext_price_total_prior1 || 0);
            acc.v += Number(l.price_variance || 0);
            acc.qc += Number(l.ext_qty_total_current || 0);
            acc.qp1 += Number(l.ext_qty_total_prior1 || 0);
            acc.qv += Number(l.pieces_variance || 0);
            acc.sku += Number(l.unique_sku || 0);
            return acc;
          },
          { c: 0, p1: 0, v: 0, qc: 0, qp1: 0, qv: 0, sku: 0 },
        );

        groupGrand.c += areaGrand.c;
        groupGrand.p1 += areaGrand.p1;
        groupGrand.v += areaGrand.v;
        groupGrand.qc += areaGrand.qc;
        groupGrand.qp1 += areaGrand.qp1;
        groupGrand.qv += areaGrand.qv;
        groupGrand.sku += areaGrand.sku;

        rowsHtml = locs
          .map((l, idx) => {
            const id = `g-${escapeHtml(data.area_num ?? "area")}-loc-${idx}`;
            const priorDesc = getPriorLocDesc(l);
            const showPrior = l?.show_prior_loc_desc === true;
            const priorIcon = showPrior
              ? `<span class="loc-indicator loc-indicator-prior" title="Has prior location description" aria-hidden="true">↩</span>`
              : "";
            const disclosureBtn = `<button class="row-disclosure-btn" type="button" aria-expanded="false" aria-label="Expand category breakdown" title="Show category breakdown" data-target="${id}">▾</button>`;
            const locMsg = getLocationMessage(l);
            const msgIcon = locMsg
              ? `<span class="loc-indicator loc-indicator-msg" title="Has location message" aria-hidden="true">📝</span>`
              : "";

            return `
            <div class="report-block">
              <div class="report-row report-grid report-main" ${gridStyle}
                   data-target="${id}"
                   data-file="${escapeHtml(meta.file)}"
                   data-area-num="${escapeHtml(data.area_num ?? "")}"
                   data-area-desc="${escapeHtml(data.area_desc || "")}"
                   data-loc-num="${escapeHtml(l.loc_num ?? "")}"
                   data-loc-desc="${escapeHtml(l.loc_desc || "")}"
                   data-show-prior-desc="${showPrior ? "1" : "0"}"
                   data-prior-desc="${escapeHtml(priorDesc || "")}"
                   data-location-message="${escapeHtml(locMsg || "")}">
                
                <div class="desc" title="${escapeHtml(l.loc_desc || "")}"><span class="desc-text">${escapeHtml(l.loc_desc || "")}</span><span class="loc-icon-row">${disclosureBtn}${msgIcon}${priorIcon}</span></div>

                <div class="num">${fmtMoney(l.ext_price_total_current)}</div>
                <div class="num">${fmtMoney(l.ext_price_total_prior1)}</div>
                <div class="num variance ${varianceClass(l.price_variance)}">${fmtMoney(l.price_variance)}</div>
                <div class="num">${fmtNum(l.ext_qty_total_current)}</div>
                <div class="num">${fmtNum(l.ext_qty_total_prior1)}</div>
                <div class="num variance ${varianceClass(l.pieces_variance)}">${fmtNum(l.pieces_variance)}</div>
                <div class="num">${fmtNum(l.unique_sku)}</div>
              </div>

              <div id="${id}" class="report-indent" hidden>
                ${renderBreakdown(l.report_breakdown, "scan_report", gridStyle)}
              </div>
            </div>
          `;
          })
          .join("");

        areaFooter = `
        <div style="border-top:1px solid #bbb; margin-top:6px;"></div>
        <div class="report-grid" ${gridStyle} style="padding:8px 6px; font-weight:800; font-size:16px;">
          <div style="grid-column: 1 / span 1;">AREA TOTAL</div>
          <div class="num">${fmtMoney(areaGrand.c)}</div>
          <div class="num">${fmtMoney(areaGrand.p1)}</div>
          <div class="num variance ${varianceClass(areaGrand.v)}">${fmtMoney(areaGrand.v)}</div>
          <div class="num">${fmtNum(areaGrand.qc)}</div>
          <div class="num">${fmtNum(areaGrand.qp1)}</div>
          <div class="num variance ${varianceClass(areaGrand.qv)}">${fmtNum(areaGrand.qv)}</div>
          <div class="num">${fmtNum(areaGrand.sku)}</div>
        </div>
      `;
      } else {
        // Standard 4 col logic
        areaGrand = locs.reduce(
          (acc, l) => {
            acc.c += Number(l.ext_price_total_current || 0);
            acc.p1 += Number(l.ext_price_total_prior1 || 0);
            acc.p2 += Number(l.ext_price_total_prior2 || 0);
            acc.p3 += Number(l.ext_price_total_prior3 || 0);
            return acc;
          },
          { c: 0, p1: 0, p2: 0, p3: 0 },
        );

        groupGrand.c += areaGrand.c;
        groupGrand.p1 += areaGrand.p1;
        groupGrand.p2 += areaGrand.p2;
        groupGrand.p3 += areaGrand.p3;

        rowsHtml = locs
          .map((l, idx) => {
            const id = `g-${escapeHtml(data.area_num ?? "area")}-loc-${idx}`;
            const priorDesc = getPriorLocDesc(l);
            const showPrior = l?.show_prior_loc_desc === true;
            const priorIcon = showPrior
              ? `<span class="loc-indicator loc-indicator-prior" title="Has prior location description" aria-hidden="true">↩</span>`
              : "";
            const disclosureBtn = `<button class="row-disclosure-btn" type="button" aria-expanded="false" aria-label="Expand category breakdown" title="Show category breakdown" data-target="${id}">▾</button>`;
            const locMsg = getLocationMessage(l);
            const msgIcon = locMsg
              ? `<span class="loc-indicator loc-indicator-msg" title="Has location message" aria-hidden="true">📝</span>`
              : "";

            return `
            <div class="report-block">
              <div class="report-row report-grid report-main" ${gridStyle}
                   data-target="${id}"
                   data-file="${escapeHtml(meta.file)}"
                   data-area-num="${escapeHtml(data.area_num ?? "")}"
                   data-area-desc="${escapeHtml(data.area_desc || "")}"
                   data-loc-num="${escapeHtml(l.loc_num ?? "")}"
                   data-loc-desc="${escapeHtml(l.loc_desc || "")}"
                   data-show-prior-desc="${showPrior ? "1" : "0"}"
                   data-prior-desc="${escapeHtml(priorDesc || "")}"
                   data-location-message="${escapeHtml(locMsg || "")}">
                
                <div class="desc" title="${escapeHtml(l.loc_desc || "")}"><span class="desc-text">${escapeHtml(l.loc_desc || "")}</span><span class="loc-icon-row">${disclosureBtn}${msgIcon}${priorIcon}</span></div>

                <div class="num">${fmtMoney(l.ext_price_total_current)}</div>
                <div class="num">${fmtMoney(l.ext_price_total_prior1)}</div>
                <div class="num">${fmtMoney(l.ext_price_total_prior2)}</div>
                <div class="num">${fmtMoney(l.ext_price_total_prior3)}</div>
              </div>

              <div id="${id}" class="report-indent" hidden>
                ${renderBreakdown(l.report_breakdown, "standard", gridStyle)}
              </div>
            </div>
          `;
          })
          .join("");

        areaFooter = `
        <div style="border-top:1px solid #bbb; margin-top:6px;"></div>
        <div class="report-grid" ${gridStyle} style="padding:8px 6px; font-weight:800; font-size:16px;">
          <div style="grid-column: 1 / span 1;">AREA TOTAL</div>
          <div class="num">${fmtMoney(areaGrand.c)}</div>
          <div class="num">${fmtMoney(areaGrand.p1)}</div>
          <div class="num">${fmtMoney(areaGrand.p2)}</div>
          <div class="num">${fmtMoney(areaGrand.p3)}</div>
        </div>
      `;
      }

      const areaTitle = `
        <div class="report-grid" style="padding:10px 6px; font-weight:800;">
          <div style="grid-column: 1 / span 6; font-size:18px;">
            ${escapeHtml(data.area_desc || "")}
          </div>
        </div>
        <div style="border-bottom:1px solid #bbb;"></div>
      `;

      return `
        <div class="report-area-section">
          ${areaTitle}
          <div>${rowsHtml}</div>
          ${areaFooter}
        </div>
      `;
    })
    .join("");

  let footerHtml;
  if (isScanReport) {
    footerHtml = `
    <div class="report-footer">
      <div class="report-grid" ${gridStyle} style="font-size:16px;">
        <div style="grid-column: 1 / span 1; font-size:16px;">GROUP GRAND TOTAL</div>
        <div class="num">${fmtMoney(groupGrand.c)}</div>
        <div class="num">${fmtMoney(groupGrand.p1)}</div>
        <div class="num variance ${varianceClass(groupGrand.v)}">${fmtMoney(groupGrand.v)}</div>
        <div class="num">${fmtNum(groupGrand.qc)}</div>
        <div class="num">${fmtNum(groupGrand.qp1)}</div>
        <div class="num variance ${varianceClass(groupGrand.qv)}">${fmtNum(groupGrand.qv)}</div>
        <div class="num">${fmtNum(groupGrand.sku)}</div>
      </div>
    </div>
  `;
  } else {
    footerHtml = `
    <div class="report-footer">
      <div class="report-grid" ${gridStyle} style="font-size:16px;">
        <div style="grid-column: 1 / span 1; font-size:16px;">GROUP GRAND TOTAL</div>
        <div class="num">${fmtMoney(groupGrand.c)}</div>
        <div class="num">${fmtMoney(groupGrand.p1)}</div>
        <div class="num">${fmtMoney(groupGrand.p2)}</div>
        <div class="num">${fmtMoney(groupGrand.p3)}</div>
      </div>
    </div>
  `;
  }

  content.innerHTML =
    headerHtml + `<div class="report-body">${sectionsHtml}</div>` + footerHtml;

  // Wire row clicks to open modal
  wireLocationRowClicks(content, {
    type: "group",
    file: null,
    area_num: null,
    area_desc: null,
  });

  wireBreakdownDisclosureButtons(content, reportTypeKey);
  wireToggleAllBreakdownsButton(content, reportTypeKey);
  applyBreakdownPreference(content, reportTypeKey);
  statusEl.textContent = `Loaded group ${groupId}`;

  document.getElementById("back-to-areas")?.addEventListener("click", () => {
    setSplitMode("list");
    loadAreaList();
  });

  // Mark entire group reviewed (server-side)
  const markBtn = document.getElementById("mark-reviewed");
  if (markBtn) {
    const allReviewed = results.every((r) => r.data?.reviewed === true);

    if (allReviewed) {
      markBtn.textContent = "Reviewed ✓";
      markBtn.disabled = true;
    } else {
      markBtn.addEventListener("click", async () => {
        markBtn.disabled = true;
        statusEl.textContent = "Marking group reviewed…";

        try {
          const reviewed_at = new Date().toISOString();

          await Promise.all(
            results.map(({ meta }) => {
              const url = `/api/report-exports/${encodeURIComponent(
                meta.file,
              )}/reviewed`;
              const body = { reviewed: true, reviewed_at };

              return postJsonQueued(url, body, {
                applyLocal: () => {
                  patchCachedFile(meta.file, (data) => {
                    data.reviewed = true;
                    data.reviewed_at = reviewed_at;
                  });
                  patchCachedListReviewedFlag(meta.file, true, reviewed_at);
                },
              }).then((r) => {
                // If server rejected (non-network) it throws above; queued counts as ok.
                return r;
              });
            }),
          );

          markBtn.textContent = "Reviewed ✓";
          for (const { meta } of results) markFileReviewedForAging(meta.file);
          latestReviewMs = toMs(reviewed_at) || Date.now();
          renderLastReviewAge();
          statusEl.textContent = "Marked group as reviewed.";
        } catch (e) {
          console.error(e);
          markBtn.disabled = false;
          alert(`Could not Mark Reviewed: ${e.message || e}`);
          statusEl.textContent = "Mark Reviewed failed.";
        }
      });
    }
  }
}

async function loadArea(file) {
  currentView.type = "area";
  currentView.file = file;
  currentView.groupId = null;
  currentView.members = null;

  statusEl.textContent = `Loading…`;

  let data;
  try {
    const out = await fetchJsonWithCache(
      `/api/report-exports/${encodeURIComponent(file)}`,
      CACHE_KEYS.FILE(file),
    );
    data = out.data;
    if (out.fromCache) statusEl.textContent = `Loading… (cached)`;
  } catch (e) {
    statusEl.textContent = `Failed to load report. ${e.message || e}`;
    return;
  }

  const locs = Array.isArray(data.locations) ? data.locations : [];
  const isScanReport = data.report_type === "scan_report";
  const reportTypeKey = isScanReport ? "scan_report" : "standard";

  // report view: fullscreen
  setSplitMode("fullscreen");

  function fmtDateLabel(iso, fallback) {
    if (!iso) return fallback;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return fallback;
    return d.toLocaleDateString();
  }

  const dates = data.dates || {};
  let headerColumns, grand, rowsHtml;
  let gridStyle = ""; // Computed dynamically

  if (isScanReport) {
    // 7 Columns for Scan Report
    const col1 = fmtDateLabel(dates.current, "Current");
    const col2 = fmtDateLabel(dates.prior1, "Prior 1");

    // Dynamic width calculation
    gridStyle = calculateDynamicGrid(locs, "scan_report", [
      col1,
      col2,
      "+/-",
      "Pieces",
      "Prior",
      "+/-",
      "SKUs",
    ]);

    headerColumns = `
      <div class="report-grid" ${gridStyle} style="font-weight:700; font-size:17px;">
        <div style="grid-column: 1 / span 1; font-size:17px;">
          ${escapeHtml(data.area_desc || "")}
        </div>
        <div class="num">${col1}</div>
        <div class="num">${col2}</div>
        <div class="num">+/-</div>
        <div class="num">Pieces</div>
        <div class="num">Prior</div>
        <div class="num">+/-</div>
        <div class="num">SKUs</div>
      </div>
    `;

    // Calculate totals for all 7 columns
    grand = locs.reduce(
      (acc, l) => {
        acc.c += Number(l.ext_price_total_current || 0);
        acc.p1 += Number(l.ext_price_total_prior1 || 0);
        acc.v += Number(l.price_variance || 0);
        acc.qc += Number(l.ext_qty_total_current || 0);
        acc.qp1 += Number(l.ext_qty_total_prior1 || 0);
        acc.qv += Number(l.pieces_variance || 0);
        acc.sku += Number(l.unique_sku || 0);
        return acc;
      },
      { c: 0, p1: 0, v: 0, qc: 0, qp1: 0, qv: 0, sku: 0 },
    );

    rowsHtml = locs
      .map((l, idx) => {
        const id = `loc-${idx}`;
        const priorDesc = getPriorLocDesc(l);
        const showPrior = l?.show_prior_loc_desc === true;
        const priorIcon = showPrior
          ? `<span class="loc-indicator loc-indicator-prior" title="Has prior location description" aria-hidden="true">↩</span>`
          : "";
        const disclosureBtn = `<button class="row-disclosure-btn" type="button" aria-expanded="false" aria-label="Expand category breakdown" title="Show category breakdown" data-target="${id}">▾</button>`;

        const locMsg = getLocationMessage(l);
        const msgIcon = locMsg
          ? `<span class="loc-indicator loc-indicator-msg" title="Has location message" aria-hidden="true">📝</span>`
          : "";

        return `
        <div class="report-block">
          <div class="report-row report-grid report-main" ${gridStyle}
               data-target="${id}"
               data-file="${escapeHtml(file)}"
               data-area-num="${escapeHtml(data.area_num ?? "")}"
               data-area-desc="${escapeHtml(data.area_desc || "")}"
               data-loc-num="${escapeHtml(l.loc_num ?? "")}"
               data-loc-desc="${escapeHtml(l.loc_desc || "")}"
               data-show-prior-desc="${showPrior ? "1" : "0"}"
               data-prior-desc="${escapeHtml(priorDesc || "")}"
               data-location-message="${escapeHtml(locMsg || "")}">
            
            <div class="desc" title="${escapeHtml(l.loc_desc || "")}"><span class="desc-text">${escapeHtml(l.loc_desc || "")}</span><span class="loc-icon-row">${disclosureBtn}${msgIcon}${priorIcon}</span></div>

            <div class="num">${fmtMoney(l.ext_price_total_current)}</div>
            <div class="num">${fmtMoney(l.ext_price_total_prior1)}</div>
            <div class="num variance ${varianceClass(l.price_variance)}">${fmtMoney(l.price_variance)}</div>
            <div class="num">${fmtNum(l.ext_qty_total_current)}</div>
            <div class="num">${fmtNum(l.ext_qty_total_prior1)}</div>
            <div class="num variance ${varianceClass(l.pieces_variance)}">${fmtNum(l.pieces_variance)}</div>
            <div class="num">${fmtNum(l.unique_sku)}</div>
          </div>

          <div id="${id}" class="report-indent" hidden>
            ${renderBreakdown(l.report_breakdown, "scan_report", gridStyle)}
          </div>
        </div>
      `;
      })
      .join("");
  } else {
    // Standard 4 Column Layout
    const col1 = fmtDateLabel(dates.current, "Current");
    const col2 = fmtDateLabel(dates.prior1, "Prior 1");
    const col3 = fmtDateLabel(dates.prior2, "Prior 2");
    const col4 = fmtDateLabel(dates.prior3, "Prior 3");

    // Dynamic width calculation
    gridStyle = calculateDynamicGrid(locs, "standard", [
      col1,
      col2,
      col3,
      col4,
    ]);

    headerColumns = `
      <div class="report-grid" ${gridStyle} style="font-weight:700; font-size:17px;">
        <div style="grid-column: 1 / span 1; font-size:17px;">
          ${escapeHtml(data.area_desc || "")}
        </div>
        <div class="num">${col1}</div>
        <div class="num">${col2}</div>
        <div class="num">${col3}</div>
        <div class="num">${col4}</div>
      </div>
    `;

    grand = locs.reduce(
      (acc, l) => {
        acc.c += Number(l.ext_price_total_current || 0);
        acc.p1 += Number(l.ext_price_total_prior1 || 0);
        acc.p2 += Number(l.ext_price_total_prior2 || 0);
        acc.p3 += Number(l.ext_price_total_prior3 || 0);
        return acc;
      },
      { c: 0, p1: 0, p2: 0, p3: 0 },
    );

    rowsHtml = locs
      .map((l, idx) => {
        const id = `loc-${idx}`;
        const priorDesc = getPriorLocDesc(l);
        const showPrior = l?.show_prior_loc_desc === true;
        const priorIcon = showPrior
          ? `<span class="loc-indicator loc-indicator-prior" title="Has prior location description" aria-hidden="true">↩</span>`
          : "";
        const disclosureBtn = `<button class="row-disclosure-btn" type="button" aria-expanded="false" aria-label="Expand category breakdown" title="Show category breakdown" data-target="${id}">▾</button>`;

        const locMsg = getLocationMessage(l);
        const msgIcon = locMsg
          ? `<span class="loc-indicator loc-indicator-msg" title="Has location message" aria-hidden="true">📝</span>`
          : "";

        return `
        <div class="report-block">
          <div class="report-row report-grid report-main" ${gridStyle}
               data-target="${id}"
               data-file="${escapeHtml(file)}"
               data-area-num="${escapeHtml(data.area_num ?? "")}"
               data-area-desc="${escapeHtml(data.area_desc || "")}"
               data-loc-num="${escapeHtml(l.loc_num ?? "")}"
               data-loc-desc="${escapeHtml(l.loc_desc || "")}"
               data-show-prior-desc="${showPrior ? "1" : "0"}"
               data-prior-desc="${escapeHtml(priorDesc || "")}"
               data-location-message="${escapeHtml(locMsg || "")}">
            
            <div class="desc" title="${escapeHtml(l.loc_desc || "")}"><span class="desc-text">${escapeHtml(l.loc_desc || "")}</span><span class="loc-icon-row">${disclosureBtn}${msgIcon}${priorIcon}</span></div>

            <div class="num">${fmtMoney(l.ext_price_total_current)}</div>
            <div class="num">${fmtMoney(l.ext_price_total_prior1)}</div>
            <div class="num">${fmtMoney(l.ext_price_total_prior2)}</div>
            <div class="num">${fmtMoney(l.ext_price_total_prior3)}</div>
          </div>

          <div id="${id}" class="report-indent" hidden>
            ${renderBreakdown(l.report_breakdown, "standard", gridStyle)}
          </div>
        </div>
      `;
      })
      .join("");
  }

  const headerHtml = `
    <div class="report-header">
      <div class="row" style="margin-bottom:10px;">
        <button id="back-to-areas" class="btn" type="button">← Areas</button>
        <button id="toggle-all-breakdowns" class="btn" type="button">Expand All</button>
        <button id="mark-reviewed" class="btn btn-primary" type="button">Mark Reviewed</button>
      </div>
      ${headerColumns}
    </div>
  `;

  let footerHtml;
  if (isScanReport) {
    footerHtml = `
      <div class="report-footer">
        <div class="report-grid" ${gridStyle} style="font-size:16px;">
          <div style="grid-column: 1 / span 1; font-size:16px;">GRAND TOTAL</div>
          <div class="num">${fmtMoney(grand.c)}</div>
          <div class="num">${fmtMoney(grand.p1)}</div>
          <div class="num variance ${varianceClass(grand.v)}">${fmtMoney(grand.v)}</div>
          <div class="num">${fmtNum(grand.qc)}</div>
          <div class="num">${fmtNum(grand.qp1)}</div>
          <div class="num variance ${varianceClass(grand.qv)}">${fmtNum(grand.qv)}</div>
          <div class="num">${fmtNum(grand.sku)}</div>
        </div>
      </div>
    `;
  } else {
    footerHtml = `
      <div class="report-footer">
        <div class="report-grid" ${gridStyle} style="font-size:16px;">
          <div style="grid-column: 1 / span 1; font-size:16px;">GRAND TOTAL</div>
          <div class="num">${fmtMoney(grand.c)}</div>
          <div class="num">${fmtMoney(grand.p1)}</div>
          <div class="num">${fmtMoney(grand.p2)}</div>
          <div class="num">${fmtMoney(grand.p3)}</div>
        </div>
      </div>
    `;
  }

  content.innerHTML =
    headerHtml + `<div class="report-body">${rowsHtml}</div>` + footerHtml;

  // Wire row clicks to open modal
  wireLocationRowClicks(content, {
    type: "area",
    file,
    area_num: data.area_num ?? "",
    area_desc: data.area_desc || "",
  });

  wireBreakdownDisclosureButtons(content, reportTypeKey);
  wireToggleAllBreakdownsButton(content, reportTypeKey);
  applyBreakdownPreference(content, reportTypeKey);

  statusEl.textContent = `Loaded area ${data.area_num}`;
  let closeAfterMark = false;

  document.getElementById("back-to-areas")?.addEventListener("click", async () => {
    if (data.reviewed !== true) {
      const shouldMark = await promptMarkReviewedBeforeClose();
      if (shouldMark) {
        const markBtn = document.getElementById("mark-reviewed");
        if (markBtn && !markBtn.disabled) {
          closeAfterMark = true;
          markBtn.click();
          return;
        }
      }
    }
    setSplitMode("list");
    loadAreaList();
  });

  // Mark as reviewed (server-side)
  const markBtn = document.getElementById("mark-reviewed");
  if (markBtn) {
    if (data.reviewed === true) {
      markBtn.textContent = "Reviewed ✓";
      markBtn.disabled = true;
    } else {
      markBtn.addEventListener("click", async () => {
        markBtn.disabled = true;
        statusEl.textContent = "Marking reviewed…";

        try {
          const reviewed_at = new Date().toISOString();

          await postJsonQueued(
            `/api/report-exports/${encodeURIComponent(file)}/reviewed`,
            { reviewed: true, reviewed_at },
            {
              applyLocal: () => {
                patchCachedFile(file, (d) => {
                  d.reviewed = true;
                  d.reviewed_at = reviewed_at;
                });
                patchCachedListReviewedFlag(file, true, reviewed_at);
              },
            },
          );

          markBtn.textContent = "Reviewed ✓";
          data.reviewed = true;
          markFileReviewedForAging(file);
          latestReviewMs = toMs(reviewed_at) || Date.now();
          renderLastReviewAge();
          statusEl.textContent = "Marked reviewed.";
          if (closeAfterMark) {
            closeAfterMark = false;
            setSplitMode("list");
            loadAreaList();
          }
        } catch (e) {
          console.error(e);
          closeAfterMark = false;
          markBtn.disabled = false;
          alert(`Could not Mark Reviewed: ${e.message || e}`);
          statusEl.textContent = "Mark Reviewed failed.";
        }
      });
    }
  }
}

refreshBtn?.addEventListener("click", loadAreaList);

tabToReviewBtn?.addEventListener("click", () => setActiveTab(TABS.TO_REVIEW));
tabReviewedBtn?.addEventListener("click", () => setActiveTab(TABS.REVIEWED));
tabRecountsBtn?.addEventListener("click", () => setActiveTab(TABS.RECOUNTS));
tabQuestionsBtn?.addEventListener("click", () => setActiveTab(TABS.QUESTIONS));
chatBtn?.addEventListener("click", () => openChatModal());

renderLastReviewAge();
setInterval(renderLastReviewAge, 30000);

// Ensure tab UI is in sync on first load
setActiveTab(currentTab);

// One more: on initial load, if we already have pending writes, try to flush.
flushPendingQueue();
updateDisconnectUI();

