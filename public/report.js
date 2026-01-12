// public/report.js

const areaList = document.getElementById("area-list");
const content = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("btn-refresh");

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
  PENDING: `${CACHE_NS}:PENDING_QUEUE`,
  DISCONNECTED_SINCE: `${CACHE_NS}:DISCONNECTED_SINCE`,
};

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
      String(disconnectedSince)
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

async function fetchJsonWithCache(url, cacheKey) {
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

    cacheSet(cacheKey, {
      ts: Date.now(),
      data,
    });

    // on successful contact, try flushing any queued writes
    flushPendingQueue();

    return { data, fromCache: false };
  } catch (err) {
    // If it's network-ish, we can use cache.
    if (looksLikeNetworkError(err)) {
      markDisconnected();
      updateDisconnectUI();

      const cached = cacheGet(cacheKey);
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
      style="font-size:22px; padding:16px 18px; border-radius:14px;">
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

function renderBreakdown(bd) {
  if (!bd || typeof bd !== "object") {
    return `<div class="muted">No breakdown available.</div>`;
  }

  const mode = bd.mode || "";
  const groups = Array.isArray(bd.groups) ? bd.groups : [];
  const categories = Array.isArray(bd.categories) ? bd.categories : [];

  if (mode === "category_groups") {
    if (groups.length === 0)
      return `<div class="muted">No category groups.</div>`;

    return groups
      .map(
        (g) => `
  <div class="report-grid report-sub" style="padding:2px 6px;">
    <div></div>
    <div class="desc">
      <span class="catcell">
        <span class="mono catnum">${escapeHtml(g.cat_group_num ?? "")}</span>
        <span class="catdesc">${escapeHtml(g.group_desc ?? "")}</span>
      </span>
    </div>

    <div class="num">${fmtMoney(g.ext_price_total_current)}</div>
    <div class="num">${fmtMoney(g.ext_price_total_prior1)}</div>
    <div class="num">${fmtMoney(g.ext_price_total_prior2)}</div>
    <div class="num">${fmtMoney(g.ext_price_total_prior3)}</div>
  </div>
`
      )
      .join("");
  }

  if (mode === "categories") {
    if (categories.length === 0)
      return `<div class="muted">No categories.</div>`;

    return categories
      .map(
        (c) => `
  <div class="report-grid report-sub" style="padding:2px 6px;">
    <div></div>
    <div class="desc">
      <span class="catcell">
        <span class="mono catnum">${escapeHtml(c.cat_num ?? "")}</span>
        <span class="catdesc">${escapeHtml(c.cat_desc ?? "")}</span>
      </span>
    </div>

    <div class="num">${fmtMoney(c.ext_price_total_current)}</div>
    <div class="num">${fmtMoney(c.ext_price_total_prior1)}</div>
    <div class="num">${fmtMoney(c.ext_price_total_prior2)}</div>
    <div class="num">${fmtMoney(c.ext_price_total_prior3)}</div>
  </div>
`
      )
      .join("");
  }

  // Best-effort fallback
  if (groups.length > 0) {
    return groups
      .map(
        (g) => `
        <div class="report-grid report-sub" style="padding:2px 6px;">
          <div class="mono">${escapeHtml(g.cat_group_num ?? "")}</div>
          <div class="desc">${escapeHtml(g.group_desc ?? "")}</div>

          <div class="num">${fmtMoney(g.ext_price_total_current)}</div>
          <div class="num">${fmtMoney(g.ext_price_total_prior1)}</div>
          <div class="num">${fmtMoney(g.ext_price_total_prior2)}</div>
          <div class="num">${fmtMoney(g.ext_price_total_prior3)}</div>
        </div>
      `
      )
      .join("");
  }

  if (categories.length > 0) {
    return categories
      .map(
        (c) => `
        <div class="report-grid report-sub" style="padding:2px 6px;">
          <div class="mono">${escapeHtml(c.cat_num ?? "")}</div>
          <div class="desc">${escapeHtml(c.cat_desc ?? "")}</div>

          <div class="num">${fmtMoney(c.ext_price_total_current)}</div>
          <div class="num">${fmtMoney(c.ext_price_total_prior1)}</div>
          <div class="num">${fmtMoney(c.ext_price_total_prior2)}</div>
          <div class="num">${fmtMoney(c.ext_price_total_prior3)}</div>
        </div>
      `
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
        String(getActionTs(a)).localeCompare(String(getActionTs(b)))
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

  return Array.from(bestByKey.values()).map(({ timestamp, ...rest }) => rest);
}

function jumpToLocationInView(loc_num) {
  const target = String(loc_num ?? "");
  if (!target) return;

  const row = content.querySelector(
    `.report-row.report-main[data-loc-num="${CSS.escape(target)}"]`
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

  if (modalState.step === "choose") {
    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <div style="font-weight:700; margin-bottom:6px;">${escapeHtml(
          ctx.loc_desc || ""
        )}</div>
        <div class="muted">What would you like to do?</div>
      </div>

      <div class="modal-actions">
        <button id="lam-btn-recount" class="btn btn-primary" type="button">Recount</button>
        <button id="lam-btn-question" class="btn" type="button">Question</button>
      </div>
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
    ctx.file
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
        ctx.loc_num
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

        openActionModal({
          file,
          area_num,
          area_desc,
          loc_num,
          loc_desc,
        });
      });
    });
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
      CACHE_KEYS.LIST
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
          recounts: [],
          questions: [],
        };
      }
    })
  );

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
    String(a[0]).localeCompare(String(b[0]))
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
        r.loc_desc || ""
      )}</strong></div>
        <div class="mono muted">AREA ${escapeHtml(
          r.area_num || ""
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
      <div><strong>LOC ${escapeHtml(locLabel)} — ${escapeHtml(
        q.loc_desc || ""
      )}</strong></div>
      <div class="mono muted">AREA ${escapeHtml(
        q.area_num || ""
      )} • ${escapeHtml(q.area_desc || "")}</div>
      ${msg ? `<div class="muted">${escapeHtml(msg)}</div>` : ""}
    `;

      li.addEventListener("click", async () => {
        await loadArea(q.file);
        jumpToLocationInView(q.loc_num);
      });

      areaList.appendChild(li);
    }
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
    keepGroup(members)
  );
  const visibleSingles = singles.filter((s) => keepSingle(s));

  statusEl.textContent = `${visibleGroups.length} group(s), ${
    visibleSingles.length
  } single area(s) — tab: ${
    currentTab === TABS.REVIEWED ? "Reviewed" : "To Be Reviewed"
  }.`;

  // Render groups
  for (const [gid, members] of visibleGroups) {
    const li = document.createElement("li");

    const areaNums = members.map((m) => m.area_num).filter(Boolean);
    const areaLabel = summarizeAreaNumbers(areaNums, 2);

    const locationCount = members.reduce(
      (acc, m) => acc + Number(m.location_count || 0),
      0
    );

    const title = buildGroupTitleFromDescriptions(members);
    const allReviewed = members.every((m) => m.reviewed);

    li.innerHTML = `
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">
        <strong>${escapeHtml(title)}</strong>
        ${allReviewed ? `<span class="muted">Reviewed ✓</span>` : ""}
      </div>
      <div class="mono muted">${escapeHtml(areaLabel)}</div>
      <div class="muted">${
        members.length
      } areas • ${locationCount} locations</div>
    `;

    li.addEventListener("click", () => loadAreaGroup(gid, members));
    areaList.appendChild(li);
  }

  // Render singles
  for (const item of visibleSingles) {
    const li = document.createElement("li");
    const reviewed = item.reviewed === true;

    li.innerHTML = `
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">
        <strong>${escapeHtml(item.area_desc || "")}</strong>
        ${reviewed ? `<span class="muted">Reviewed ✓</span>` : ""}
      </div>
      <div class="mono muted">${escapeHtml(item.area_num ?? "")}</div>
      <div class="muted">${item.location_count ?? 0} locations</div>
    `;

    li.addEventListener("click", () => loadArea(item.file));
    areaList.appendChild(li);
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
    })
  );

  // report view: fullscreen
  setSplitMode("fullscreen");

  const first = results[0]?.data || {};
  const dates = first.dates || {};

  function fmtDateLabel(iso, fallback) {
    if (!iso) return fallback;
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { timeZone: "UTC" });
  }

  const col1 = fmtDateLabel(dates.current, "Current");
  const col2 = fmtDateLabel(dates.prior1, "Prior 1");
  const col3 = fmtDateLabel(dates.prior2, "Prior 2");
  const col4 = fmtDateLabel(dates.prior3, "Prior 3");

  const headerHtml = `
    <div class="report-header">
      <div class="row" style="margin-bottom:10px;">
        <button id="back-to-areas" class="btn" type="button">← Areas</button>
        <button id="mark-reviewed" class="btn btn-primary" type="button">Mark Reviewed</button>
      </div>

      <div class="report-grid" style="font-weight:700; font-size:19px;">
        <div style="grid-column: 1 / span 2;"></div>
        <div class="num">${col1}</div>
        <div class="num">${col2}</div>
        <div class="num">${col3}</div>
        <div class="num">${col4}</div>
      </div>
    </div>
  `;

  let groupGrand = { c: 0, p1: 0, p2: 0, p3: 0 };

  const sectionsHtml = results
    .sort((a, b) =>
      String(a.data.area_num ?? "").localeCompare(String(b.data.area_num ?? ""))
    )
    .map(({ meta, data }) => {
      const locs = Array.isArray(data.locations) ? data.locations : [];

      const areaGrand = locs.reduce(
        (acc, l) => {
          acc.c += Number(l.ext_price_total_current || 0);
          acc.p1 += Number(l.ext_price_total_prior1 || 0);
          acc.p2 += Number(l.ext_price_total_prior2 || 0);
          acc.p3 += Number(l.ext_price_total_prior3 || 0);
          return acc;
        },
        { c: 0, p1: 0, p2: 0, p3: 0 }
      );

      groupGrand.c += areaGrand.c;
      groupGrand.p1 += areaGrand.p1;
      groupGrand.p2 += areaGrand.p2;
      groupGrand.p3 += areaGrand.p3;

      const areaTitle = `
        <div class="report-grid" style="padding:10px 6px; font-weight:800;">
          <div style="grid-column: 1 / span 6; font-size:18px;">
            AREA <span class="mono">${escapeHtml(data.area_num ?? "")}</span>
            &nbsp;&nbsp; ${escapeHtml(data.area_desc || "")}
          </div>
        </div>
        <div style="border-bottom:1px solid #bbb;"></div>
      `;

      const rowsHtml = locs
        .map((l, idx) => {
          const id = `g-${escapeHtml(data.area_num ?? "area")}-loc-${idx}`;

          const priorDesc = getPriorLocDesc(l);
          const showPrior = l?.show_prior_loc_desc === true;
          const priorBtn = showPrior
            ? `<button class="prior-desc-btn" type="button" title="Show prior location description" data-prior-target="${id}-prior" data-prior-desc="${escapeHtml(
                priorDesc || ""
              )}">↩</button>`
            : "";
          const priorBlock = showPrior
            ? `<div id="${id}-prior" class="prior-desc" style="display:none;"></div>`
            : "";

          return `
            <div class="report-block">
              <div class="report-row report-grid report-main"
                   data-target="${id}"
                   data-file="${escapeHtml(meta.file)}"
                   data-area-num="${escapeHtml(data.area_num ?? "")}"
                   data-area-desc="${escapeHtml(data.area_desc || "")}"
                   data-loc-num="${escapeHtml(l.loc_num ?? "")}"
                   data-loc-desc="${escapeHtml(l.loc_desc || "")}">
                <div class="mono" style="font-size:16px; font-weight:800;">${escapeHtml(
                  l.loc_num ?? ""
                )}${priorBtn}</div>
                <div class="desc" style="font-size:16px; font-weight:800;">${escapeHtml(
                  l.loc_desc || ""
                )}</div>

                <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
                  l.ext_price_total_current
                )}</div>
                <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
                  l.ext_price_total_prior1
                )}</div>
                <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
                  l.ext_price_total_prior2
                )}</div>
                <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
                  l.ext_price_total_prior3
                )}</div>
              </div>

              <div id="${id}" class="report-indent" style="display:block;">
                ${priorBlock}${renderBreakdown(l.report_breakdown)}
              </div>
            </div>
          `;
        })
        .join("");

      const areaFooter = `
        <div style="border-top:1px solid #bbb; margin-top:6px;"></div>
        <div class="report-grid" style="padding:8px 6px; font-weight:800; font-size:16px;">
          <div style="grid-column: 1 / span 2;">AREA TOTAL</div>
          <div class="num">${fmtMoney(areaGrand.c)}</div>
          <div class="num">${fmtMoney(areaGrand.p1)}</div>
          <div class="num">${fmtMoney(areaGrand.p2)}</div>
          <div class="num">${fmtMoney(areaGrand.p3)}</div>
        </div>
      `;

      return `
        <div style="margin-top: 10px;">
          ${areaTitle}
          <div>${rowsHtml}</div>
          ${areaFooter}
        </div>
      `;
    })
    .join("");

  const footerHtml = `
    <div class="report-footer">
      <div class="report-grid" style="font-size:16px;">
        <div style="grid-column: 1 / span 2; font-size:16px;">GROUP GRAND TOTAL</div>
        <div class="num">${fmtMoney(groupGrand.c)}</div>
        <div class="num">${fmtMoney(groupGrand.p1)}</div>
        <div class="num">${fmtMoney(groupGrand.p2)}</div>
        <div class="num">${fmtMoney(groupGrand.p3)}</div>
      </div>
    </div>
  `;

  content.innerHTML = headerHtml + `<div>${sectionsHtml}</div>` + footerHtml;

  // Wire row clicks to open modal
  wireLocationRowClicks(content, {
    type: "group",
    file: null,
    area_num: null,
    area_desc: null,
  });

  wirePriorDescButtons(content);
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
                meta.file
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
            })
          );

          markBtn.textContent = "Reviewed ✓";
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
      CACHE_KEYS.FILE(file)
    );
    data = out.data;
    if (out.fromCache) statusEl.textContent = `Loading… (cached)`;
  } catch (e) {
    statusEl.textContent = `Failed to load report. ${e.message || e}`;
    return;
  }

  const locs = Array.isArray(data.locations) ? data.locations : [];

  // report view: fullscreen
  setSplitMode("fullscreen");

  function fmtDateLabel(iso, fallback) {
    if (!iso) return fallback;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return fallback;
    return d.toLocaleDateString();
  }

  const dates = data.dates || {};
  const col1 = fmtDateLabel(dates.current, "Current");
  const col2 = fmtDateLabel(dates.prior1, "Prior 1");
  const col3 = fmtDateLabel(dates.prior2, "Prior 2");
  const col4 = fmtDateLabel(dates.prior3, "Prior 3");

  const headerHtml = `
    <div class="report-header">
      <div class="row" style="margin-bottom:10px;">
        <button id="back-to-areas" class="btn" type="button">← Areas</button>
        <button id="mark-reviewed" class="btn btn-primary" type="button">Mark Reviewed</button>
      </div>

      <div class="report-grid" style="font-weight:700; font-size:19px;">
        <div style="grid-column: 1 / span 2; font-size:22px;">
          AREA <span class="mono">${escapeHtml(data.area_num ?? "")}</span>
          &nbsp;&nbsp; ${escapeHtml(data.area_desc || "")}
        </div>

        <div class="num">${col1}</div>
        <div class="num">${col2}</div>
        <div class="num">${col3}</div>
        <div class="num">${col4}</div>
      </div>
    </div>
  `;

  const grand = locs.reduce(
    (acc, l) => {
      acc.c += Number(l.ext_price_total_current || 0);
      acc.p1 += Number(l.ext_price_total_prior1 || 0);
      acc.p2 += Number(l.ext_price_total_prior2 || 0);
      acc.p3 += Number(l.ext_price_total_prior3 || 0);
      return acc;
    },
    { c: 0, p1: 0, p2: 0, p3: 0 }
  );

  const rowsHtml = locs
    .map((l, idx) => {
      const id = `loc-${idx}`;

      const priorDesc = getPriorLocDesc(l);
      const showPrior = l?.show_prior_loc_desc === true;
      const priorBtn = showPrior
        ? `<button class="prior-desc-btn" type="button" title="Show prior location description" data-prior-target="${id}-prior" data-prior-desc="${escapeHtml(
            priorDesc || ""
          )}">↩</button>`
        : "";
      const priorBlock = showPrior
        ? `<div id="${id}-prior" class="prior-desc" style="display:none;"></div>`
        : "";

      const locMsg = getLocationMessage(l);
      const msgBtn = locMsg
        ? `<button class="loc-msg-btn" type="button" title="View location message"
              data-msg="${escapeHtml(locMsg)}"
              data-area-num="${escapeHtml(data.area_num ?? "")}"
              data-area-desc="${escapeHtml(data.area_desc || "")}"
              data-loc-num="${escapeHtml(l.loc_num ?? "")}"
              data-loc-desc="${escapeHtml(l.loc_desc || "")}">📝</button>`
        : "";

      return `
        <div class="report-block">
          <div class="report-row report-grid report-main"
               data-target="${id}"
               data-file="${escapeHtml(file)}"
               data-area-num="${escapeHtml(data.area_num ?? "")}"
               data-area-desc="${escapeHtml(data.area_desc || "")}"
               data-loc-num="${escapeHtml(l.loc_num ?? "")}"
               data-loc-desc="${escapeHtml(l.loc_desc || "")}">
            <div class="mono" style="font-size:16px; font-weight:800;">${escapeHtml(
              l.loc_num ?? ""
            )}<span class="loc-icon-row">${msgBtn}${priorBtn}</span></div>
            <div class="desc" style="font-size:16px; font-weight:800;">${escapeHtml(
              l.loc_desc || ""
            )}</div>

            <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
              l.ext_price_total_current
            )}</div>
            <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
              l.ext_price_total_prior1
            )}</div>
            <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
              l.ext_price_total_prior2
            )}</div>
            <div class="num" style="font-size:16px; font-weight:800;">${fmtMoney(
              l.ext_price_total_prior3
            )}</div>
          </div>

          <div id="${id}" class="report-indent" style="display:block;">
            ${priorBlock}${renderBreakdown(l.report_breakdown)}
          </div>
        </div>
      `;
    })
    .join("");

  const footerHtml = `
    <div class="report-footer">
      <div class="report-grid" style="font-size:16px;">
        <div style="grid-column: 1 / span 2; font-size:16px;">GRAND TOTAL</div>
        <div class="num">${fmtMoney(grand.c)}</div>
        <div class="num">${fmtMoney(grand.p1)}</div>
        <div class="num">${fmtMoney(grand.p2)}</div>
        <div class="num">${fmtMoney(grand.p3)}</div>
      </div>
    </div>
  `;

  content.innerHTML = headerHtml + `<div>${rowsHtml}</div>` + footerHtml;

  // Wire row clicks to open modal
  wireLocationRowClicks(content, {
    type: "area",
    file,
    area_num: data.area_num ?? "",
    area_desc: data.area_desc || "",
  });

  wirePriorDescButtons(content);
  wireLocationMessageButtons(content);

  statusEl.textContent = `Loaded area ${data.area_num}`;

  document.getElementById("back-to-areas")?.addEventListener("click", () => {
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
            }
          );

          markBtn.textContent = "Reviewed ✓";
          statusEl.textContent = "Marked reviewed.";
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

refreshBtn?.addEventListener("click", loadAreaList);

tabToReviewBtn?.addEventListener("click", () => setActiveTab(TABS.TO_REVIEW));
tabReviewedBtn?.addEventListener("click", () => setActiveTab(TABS.REVIEWED));
tabRecountsBtn?.addEventListener("click", () => setActiveTab(TABS.RECOUNTS));
tabQuestionsBtn?.addEventListener("click", () => setActiveTab(TABS.QUESTIONS));

// Ensure tab UI is in sync on first load
setActiveTab(currentTab);

// One more: on initial load, if we already have pending writes, try to flush.
flushPendingQueue();
updateDisconnectUI();
