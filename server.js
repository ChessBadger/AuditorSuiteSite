// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
const JSON_DIR = path.resolve(__dirname, "..");

// NEW: report export directory (one level up from audit-site)
const REPORT_DIR = path.resolve(__dirname, "..", "Report-Site");

// Existing audit cache (keep name if you want; this is your current "reportCache")
const reportCache = new Map();

// NEW: report-export cache (area json files)
const reportExportCache = new Map();

let skuMaster = [];
const CUST_MASTER_FILE = path.join(JSON_DIR, "cust_master.json");

// --- Persistent location actions store (survives server restarts / export regeneration) ---
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

const LOCATION_ACTIONS_FILE = path.join(REPORT_DIR, "location_actions.json");
// Shape:
// {
//   "<file>": [
//     {
//       area_num,
//       loc_num,
//       action,      // "recount" | "question"
//       text,        // reason or question
//       timestamp,   // when the action was created
//       reply,       // optional: manager reply to a question
//       reply_at     // optional: when reply was added
//     },
//   ]
// }
let locationActionsStore = {};
let locationActionsStoreMtimeMs = -1;

function normalizeJsonText(raw) {
  return String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .trim();
}

function readJsonFile(filePath) {
  const raw = normalizeJsonText(fs.readFileSync(filePath, "utf8"));
  return JSON.parse(raw);
}

function loadLocationActionsFromDisk() {
  try {
    if (!fs.existsSync(LOCATION_ACTIONS_FILE)) {
      locationActionsStore = {};
      locationActionsStoreMtimeMs = -1;
      return;
    }
    const raw = normalizeJsonText(
      fs.readFileSync(LOCATION_ACTIONS_FILE, "utf8"),
    );
    if (!raw) {
      locationActionsStore = {};
      locationActionsStoreMtimeMs = fs.statSync(LOCATION_ACTIONS_FILE).mtimeMs;
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      locationActionsStore = parsed;
      locationActionsStoreMtimeMs = fs.statSync(LOCATION_ACTIONS_FILE).mtimeMs;
    } else {
      locationActionsStore = {};
      locationActionsStoreMtimeMs = fs.statSync(LOCATION_ACTIONS_FILE).mtimeMs;
    }
  } catch (e) {
    console.warn("Failed to load location_actions.json:", e.message);
    locationActionsStore = {};
    locationActionsStoreMtimeMs = -1;
  }
}

function saveLocationActionsToDisk() {
  const tmp = LOCATION_ACTIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(locationActionsStore, null, 2), "utf8");
  fs.renameSync(tmp, LOCATION_ACTIONS_FILE);
  try {
    locationActionsStoreMtimeMs = fs.statSync(LOCATION_ACTIONS_FILE).mtimeMs;
  } catch {
    locationActionsStoreMtimeMs = Date.now();
  }
}

function syncLocationActionsStoreFromDiskIfChanged() {
  let diskMtimeMs = -1;
  try {
    if (fs.existsSync(LOCATION_ACTIONS_FILE)) {
      diskMtimeMs = fs.statSync(LOCATION_ACTIONS_FILE).mtimeMs;
    }
  } catch {
    diskMtimeMs = -1;
  }

  if (diskMtimeMs < 0) {
    if (Object.keys(locationActionsStore).length > 0) {
      locationActionsStore = {};
    }
    locationActionsStoreMtimeMs = -1;
    return;
  }

  if (locationActionsStoreMtimeMs === diskMtimeMs) return;
  loadLocationActionsFromDisk();
}

function getStoredActionsForFile(file) {
  syncLocationActionsStoreFromDiskIfChanged();
  const arr = locationActionsStore[file];
  return Array.isArray(arr) ? arr : [];
}

function mergeLocationActions(baseArr, storedArr, opts = {}) {
  const minTimestampMs = Number(opts.minTimestampMs || 0);
  // Dedupe by (loc_num, action, timestamp, text) while preserving reply fields.
  // Important: If a later version of the same action gains a reply, we must
  // keep that reply so the UI can show it under the Questions tab.

  const map = new Map();

  const norm = (a) => {
    if (!a || typeof a !== "object") return null;
    const loc_num = String(a.loc_num ?? "").trim();
    const action = String(a.action ?? a.type ?? "")
      .trim()
      .toLowerCase();
    const text = String(a.text ?? a.message ?? a.question ?? "");
    const timestamp = String(a.timestamp ?? a.ts ?? "");
    const reply = typeof a.reply === "string" ? a.reply : undefined;
    const reply_at = typeof a.reply_at === "string" ? a.reply_at : undefined;

    if (!loc_num || !action) return null;

    return {
      area_num: a.area_num,
      loc_num,
      action,
      text,
      timestamp,
      reply,
      reply_at,
    };
  };

  const add = (a) => {
    const n = norm(a);
    if (!n) return;

    // Optional freshness guard: ignore actions older than the export file.
    if (minTimestampMs > 0) {
      const tsMs = Date.parse(String(n.timestamp || ""));
      if (!Number.isFinite(tsMs) || tsMs < minTimestampMs) return;
    }

    const key = `${n.loc_num}::${n.action}::${n.timestamp}::${n.text}`;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, n);
      return;
    }

    // Merge: prefer reply/reply_at if either version has it.
    if (typeof prev.reply !== "string" || !prev.reply.trim()) {
      if (typeof n.reply === "string" && n.reply.trim()) prev.reply = n.reply;
    }

    if (typeof prev.reply_at !== "string" || !prev.reply_at.trim()) {
      if (typeof n.reply_at === "string" && n.reply_at.trim())
        prev.reply_at = n.reply_at;
    }

    // If area_num is missing on the older one but present on the newer, fill it.
    if ((prev.area_num === undefined || prev.area_num === null) && n.area_num) {
      prev.area_num = n.area_num;
    }
  };

  (Array.isArray(baseArr) ? baseArr : []).forEach(add);
  (Array.isArray(storedArr) ? storedArr : []).forEach(add);

  // Return in a stable order: by loc_num, then timestamp, then action.
  const out = Array.from(map.values());
  out.sort((a, b) => {
    const la = String(a.loc_num).localeCompare(String(b.loc_num));
    if (la) return la;
    const ta = String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
    if (ta) return ta;
    return String(a.action).localeCompare(String(b.action));
  });

  return out;
}

/**
 * Preload every .json in JSON_DIR into reportCache
 */
function preloadReports() {
  const files = fs
    .readdirSync(REPORT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .filter((f) => f.toLowerCase() !== "chatlog.json");

  files.forEach((f) => {
    try {
      const raw = fs.readFileSync(path.join(JSON_DIR, f), "utf8");
      const data = JSON.parse(raw);
      reportCache.set(f, data);
    } catch (err) {
      console.warn(`Skipping invalid JSON ${f}: ${err.message}`);
    }
  });

  console.log(`Preloaded ${reportCache.size} JSON files into memory`);
}

// Watch for changes in JSON_DIR and reload individual files
fs.watch(JSON_DIR, (event, filename) => {
  if (!filename || !filename.toLowerCase().endsWith(".json")) return;
  if (filename.toLowerCase() === "chatlog.json") return;

  const filePath = path.join(JSON_DIR, filename);
  if (fs.existsSync(filePath)) {
    // file added or changed → reload
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      reportCache.set(filename, JSON.parse(raw));
      console.log(`Reloaded ${filename} into cache`);
    } catch (err) {
      console.warn(`Failed to reload ${filename}: ${err.message}`);
    }
  } else {
    // file deleted → remove from cache
    reportCache.delete(filename);
    console.log(`Removed ${filename} from cache`);
  }
});

function preloadCustMaster() {
  try {
    const raw = fs.readFileSync(CUST_MASTER_FILE, "utf8");
    skuMaster = JSON.parse(raw);
    console.log(`Preloaded ${skuMaster.length} SKUs into memory`);
  } catch (err) {
    console.warn("Failed to preload cust_master.json:", err.message);
  }
}

fs.watchFile(CUST_MASTER_FILE, () => {
  console.log("cust_master.json changed — reloading");
  preloadCustMaster();
});

function preloadReportExports() {
  if (!fs.existsSync(REPORT_DIR)) {
    console.warn(`REPORT_DIR does not exist: ${REPORT_DIR}`);
    return;
  }

  const files = fs
    .readdirSync(REPORT_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  files.forEach((f) => {
    try {
      const data = readJsonFile(path.join(REPORT_DIR, f));
      reportExportCache.set(f, data);
    } catch (err) {
      console.warn(`Skipping invalid report export JSON ${f}: ${err.message}`);
    }
  });

  console.log(
    `Preloaded ${reportExportCache.size} report-export JSON files into memory`,
  );
}

// Watch for changes in REPORT_DIR and reload individual files
if (fs.existsSync(REPORT_DIR)) {
  fs.watch(REPORT_DIR, (event, filename) => {
    if (!filename || !filename.toLowerCase().endsWith(".json")) return;

    const filePath = path.join(REPORT_DIR, filename);
    if (fs.existsSync(filePath)) {
      try {
        reportExportCache.set(filename, readJsonFile(filePath));
        console.log(`Reloaded report export ${filename} into cache`);
      } catch (err) {
        console.warn(
          `Failed to reload report export ${filename}: ${err.message}`,
        );
      }
    } else {
      reportExportCache.delete(filename);
      console.log(`Removed report export ${filename} from cache`);
    }
  });
}

// --- Chat log (Report-Site/chatlog.json) ---
// Canonical format:
// { "messages": [ { "timestamp": "...", "user": "...", "message": "..." } ] }
const CHATLOG_FILE = path.join(REPORT_DIR, "chatlog.json");
let chatLog = { messages: [] };

function normalizeJsonText(raw) {
  return String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .trim();
}

function normalizeChatMessage(m) {
  // Accept either {user,message,timestamp} or legacy {from,text,timestamp}
  const timestamp =
    String(m?.timestamp ?? "").trim() || new Date().toISOString();
  const user = String(m?.user ?? m?.from ?? "").trim();
  const message = String(m?.message ?? m?.text ?? "").trim();

  if (!user || !message) return null;

  return { timestamp, user, message };
}

function loadChatLogFromDisk() {
  try {
    if (!fs.existsSync(REPORT_DIR)) return;

    if (!fs.existsSync(CHATLOG_FILE)) {
      chatLog = { messages: [] };
      saveChatLogToDisk();
      return;
    }

    const raw = normalizeJsonText(fs.readFileSync(CHATLOG_FILE, "utf8"));
    if (!raw) {
      chatLog = { messages: [] };
      saveChatLogToDisk();
      return;
    }

    const parsed = JSON.parse(raw);

    let msgs = [];
    if (Array.isArray(parsed)) {
      msgs = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.messages)
    ) {
      msgs = parsed.messages;
    }

    const normalized = [];
    for (const m of msgs) {
      const nm = normalizeChatMessage(m);
      if (nm) normalized.push(nm);
    }

    chatLog = { messages: normalized };
  } catch (e) {
    console.warn("Failed to load chatlog.json:", e.message);
    chatLog = { messages: [] };
  }
}

function saveChatLogToDisk() {
  const tmp = CHATLOG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(chatLog, null, 2), "utf8");
  fs.renameSync(tmp, CHATLOG_FILE);
}

// Reload chat in memory if edited externally
if (fs.existsSync(REPORT_DIR)) {
  fs.watch(REPORT_DIR, (event, filename) => {
    if (!filename) return;
    if (String(filename).toLowerCase() === "chatlog.json") {
      loadChatLogFromDisk();
    }
  });
}

// Preload at startup
preloadReports();
preloadReportExports();
preloadCustMaster();
loadChatLogFromDisk();
loadLocationActionsFromDisk();

// allow up to 10 MB of JSON
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// serve static assets
app.use(express.static(path.join(__dirname, "public")));

// server.js (near top)
const EMP_FILE = path.join(JSON_DIR, "employees.json");

function loadEmployees() {
  if (fs.existsSync(EMP_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(EMP_FILE, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveEmployees(empData) {
  fs.writeFileSync(EMP_FILE, JSON.stringify(empData, null, 2), "utf8");
}

/**
 * Helper: returns only those cached JSON entries
 * whose parsed object has enabled === true.
 *
 * callback signature: (err, [ { file, data }, … ])
 */
function loadEnabledReports(callback) {
  try {
    const results = [];
    for (const [file, data] of reportCache.entries()) {
      if (data && data.enabled === true) {
        results.push({ file, data });
      }
    }
    // simulate async
    process.nextTick(() => callback(null, results));
  } catch (err) {
    process.nextTick(() => callback(err));
  }
}
// Lookup a single SKU from cust_master.json
app.get("/api/sku/:sku", (req, res) => {
  const sku = String(req.params.sku);
  const match = skuMaster.find((item) => String(item.SKU) === sku);
  if (match) return res.json(match);
  res.status(404).json({ error: "SKU not found" });
});

// ——— list enabled JSON filenames ———
app.get("/api/reports", (req, res) => {
  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(reps.map((r) => r.file));
  });
});

// serve YesNoOption.json from the JSON_DIR
app.get("/api/YesNoOption.json", (req, res) => {
  res.sendFile(path.join(JSON_DIR, "YesNoOption.json"));
});

// serve cust_master.json from the JSON_DIR
app.get("/api/cust_master.json", (req, res) => {
  res.sendFile(path.join(JSON_DIR, "cust_master.json"));
});

// ——— list all employees across enabled reports ———
app.get("/api/employees", (req, res) => {
  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });

    // 1. collect all names still present in enabled reports
    const names = new Set();
    reps.forEach((r) => {
      r.data.records?.forEach((rec) => {
        if (rec.employee_name) names.add(rec.employee_name);
      });
    });

    // 2. load or initialize employees.json
    const empData = loadEmployees();

    // 3. for any employee that now has audits, clear the completed flag
    names.forEach((n) => {
      empData[n] = false;
    });
    // 4. save any additions
    saveEmployees(empData);

    // 5. respond with sorted array of { name, completed }
    const out = Object.keys(empData)
      .sort()
      .map((n) => ({ name: n, completed: empData[n] }));
    res.json(out);
  });
});

// ——— list all locations across enabled reports ———
// server.js

app.get("/api/locations", (req, res) => {
  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });

    // Build a map: area_desc → { area_num, locations:Set }
    const grouped = {};
    reps.forEach(({ data }) => {
      data.records?.forEach((rec) => {
        const { area_desc, AREA_NUM, LOC_NUM, loc_desc } = rec;
        if (!area_desc || AREA_NUM == null || !LOC_NUM || !loc_desc) return;

        if (!grouped[area_desc]) {
          grouped[area_desc] = {
            area_num: AREA_NUM,
            locations: new Set(),
          };
        }
        // In case the same area_desc appears with different AREA_NUMs,
        // keep the lowest one
        grouped[area_desc].area_num = Math.min(
          grouped[area_desc].area_num,
          AREA_NUM,
        );
        grouped[area_desc].locations.add(`${LOC_NUM} - ${loc_desc}`);
      });
    });

    // Convert to array, sort by area_num, then strip area_num before sending
    const result = Object.entries(grouped)
      .map(([area_desc, { area_num, locations }]) => ({
        area_desc,
        area_num,
        locations: Array.from(locations).sort(),
      }))
      .sort((a, b) => a.area_num - b.area_num)
      .map(({ area_desc, locations }) => ({ area_desc, locations }));

    res.json(result);
  });
});

// near the top, after your other route definitions
app.get("/ping", (req, res) => {
  res.sendStatus(200);
});

app.get("/api/report-exports-test", (req, res) => {
  res.json({ ok: true, count: reportExportCache.size });
});

// ——— fetch records filtered by employee, location, or SKU (only from enabled) ———
app.get("/api/records", (req, res) => {
  const { employee, location, sku } = req.query;
  if (!employee && !location && !sku) {
    return res
      .status(400)
      .json({ error: "Must specify ?employee=… or ?location=… or ?sku=…" });
  }

  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });

    const matches = [];
    reps.forEach((r) => {
      r.data.records?.forEach((rec) => {
        if (
          (employee && rec.employee_name === employee) ||
          (location && `${rec.LOC_NUM} - ${rec.loc_desc}` === location) ||
          (sku && String(rec.SKU) === String(sku))
        ) {
          matches.push(Object.assign({ file: r.file }, rec));
        }
      });
    });

    res.json(matches);
  });
});

// List available area exports (EXCLUDES chatlog.json)
app.get("/api/report-exports", (req, res) => {
  const list = Array.from(reportExportCache.entries())
    .filter(([file, data]) => {
      if (!data || !data.area_num) return false;
      if (String(file).toLowerCase() === "chatlog.json") return false;
      return true;
    })
    .map(([file, data]) => ({
      file,
      area_num: data.area_num,
      area_desc: data.area_desc || "",
      location_count: Array.isArray(data.locations) ? data.locations.length : 0,
    }))
    .sort((a, b) => String(a.area_num).localeCompare(String(b.area_num)));

  res.json(list);
});

// --------------------
// Chatlog API
// GET returns { messages: [...] }
// POST appends a message and persists to Report-Site/chatlog.json
// --------------------

app.get("/api/chatlog", (req, res) => {
  res.json(chatLog);
});

app.post("/api/chatlog", (req, res) => {
  // Accept either canonical or legacy post body:
  // canonical: { user, message, timestamp }
  // legacy:    { from, text, timestamp }
  const user = "Store Manager";
  const message = String(req.body?.message ?? req.body?.text ?? "").trim();
  const timestamp =
    String(req.body?.timestamp ?? "").trim() || new Date().toISOString();

  if (!user) return res.status(400).json({ error: "Missing user" });
  if (!message) return res.status(400).json({ error: "Missing message" });

  const msg = { timestamp, user, message };

  if (!Array.isArray(chatLog.messages)) chatLog.messages = [];
  chatLog.messages.push(msg);

  // cap growth
  if (chatLog.messages.length > 2000) {
    chatLog.messages = chatLog.messages.slice(chatLog.messages.length - 2000);
  }

  try {
    saveChatLogToDisk();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ success: true, message: msg });
});

// Fetch one area export by filename (e.g. 40051.json)
app.get("/api/report-exports/:file", (req, res) => {
  const file = req.params.file;
  const base = reportExportCache.get(file);
  if (!base) return res.status(404).json({ error: "Report export not found" });

  // clone so we don't permanently mutate the cached base export object
  const out = JSON.parse(JSON.stringify(base));

  const stored = getStoredActionsForFile(file);

  // Use the dedicated actions store as source-of-truth.
  // This keeps area export files immutable and allows a true reset by
  // clearing/deleting location_actions.json.
  out.location_actions = mergeLocationActions([], stored);

  res.json(out);
});

// ─── POST location actions (recount / question) ───
app.post("/api/report-exports/:file/location-action", (req, res) => {
  const file = req.params.file; // e.g. "40061.json"
  const data = reportExportCache.get(file);

  if (!data) {
    return res.status(404).json({ error: "Report export not found" });
  }

  const { area_num, loc_num, action, text } = req.body;

  const locNumStr = String(loc_num ?? "").trim();
  const actionStr = String(action ?? "")
    .trim()
    .toLowerCase();

  if (!locNumStr || !actionStr) {
    return res.status(400).json({ error: "Missing loc_num or action" });
  }

  if (!["recount", "question"].includes(actionStr)) {
    return res.status(400).json({ error: "Invalid action type" });
  }

  const actionObj = {
    area_num,
    loc_num: locNumStr,
    action: actionStr,
    text: String(text ?? ""),
    // Use server timestamp so ordering/freshness is stable regardless of
    // client device clock drift.
    timestamp: new Date().toISOString(),
  };

  // 1) Persist into the dedicated store (survives restarts / export regeneration)
  syncLocationActionsStoreFromDiskIfChanged();
  if (!Array.isArray(locationActionsStore[file]))
    locationActionsStore[file] = [];
  locationActionsStore[file].push(actionObj);

  // optional cap so the store file can't grow forever
  if (locationActionsStore[file].length > 5000) {
    locationActionsStore[file] = locationActionsStore[file].slice(-5000);
  }

  try {
    saveLocationActionsToDisk();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // 2) Also update the cached export object so area JSON reflects the action.
  if (!Array.isArray(data.location_actions)) data.location_actions = [];
  data.location_actions.push(actionObj);

  // 2b) Mirror onto the specific location entry.
  const locs = Array.isArray(data.locations) ? data.locations : [];
  const normLoc = (v) =>
    String(v ?? "")
      .trim()
      .replace(/,/g, "")
      .replace(/\.0+$/, "")
      .replace(/^0+(\d)/, "$1");
  const wanted = normLoc(locNumStr);
  const targetLoc = locs.find((l) => {
    if (!l || typeof l !== "object") return false;
    const locKey = normLoc(l.loc_num ?? l.LOC_NUM ?? l.locNum ?? "");
    return locKey === wanted;
  });

  if (targetLoc && typeof targetLoc === "object") {
    targetLoc.action = actionStr;
    if (!Array.isArray(targetLoc.actions)) targetLoc.actions = [];
    targetLoc.actions.push(actionObj);
  }

  // 3) Write back the export file atomically.
  const filePath = path.join(REPORT_DIR, file);
  try {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  reportExportCache.set(file, data);

  return res.json({ success: true, action: actionObj });
});

// ─── POST /api/reports/:name ───
// Autosave without marking complete (leaves enabled/completedAt untouched)
app.post("/api/reports/:name", (req, res) => {
  const fileName = req.params.name;
  const filePath = path.join(JSON_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Report not found" });
  }
  try {
    // 1) Load the existing JSON
    const obj = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // 2) Replace only the records array
    if (Array.isArray(req.body.records)) {
      obj.records = req.body.records;
    } else {
      return res.status(400).json({ error: "Missing records array" });
    }

    // 3) Atomically write back to disk
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);

    // 4) Let the existing fs.watch(JSON_DIR) reload it into reportCache :contentReference[oaicite:0]{index=0}

    return res.json({ success: true });
  } catch (err) {
    console.error("Autosave error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST reviewed flag ───
// Body: { reviewed: true/false, reviewed_at?: ISO string }
app.post("/api/report-exports/:file/reviewed", (req, res) => {
  const file = req.params.file; // e.g. "20100.json"
  const data = reportExportCache.get(file);

  if (!data) {
    return res.status(404).json({ error: "Report export not found" });
  }

  const reviewed = req.body?.reviewed === true;
  const reviewed_at =
    typeof req.body?.reviewed_at === "string"
      ? req.body.reviewed_at
      : new Date().toISOString();

  // Update JSON in memory
  data.reviewed = reviewed;

  // Only set reviewed_at when marking reviewed=true (optional preference)
  if (reviewed) data.reviewed_at = reviewed_at;

  // Persist to disk
  const filePath = path.join(REPORT_DIR, file);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Update in-memory cache
  reportExportCache.set(file, data);

  return res.json({
    success: true,
    file,
    reviewed,
    reviewed_at: data.reviewed_at,
  });
});

// --------------------
// Chatlog API
// --------------------
app.get("/api/chatlog", (req, res) => {
  res.json(chatLog);
});

app.post("/api/chatlog", (req, res) => {
  const from = String(req.body?.from ?? "").trim();
  const text = String(req.body?.text ?? "").trim();
  const timestamp =
    String(req.body?.timestamp ?? "").trim() || new Date().toISOString();

  if (!from) return res.status(400).json({ error: "Missing from" });
  if (!text) return res.status(400).json({ error: "Missing text" });

  const msg = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    from,
    text,
    timestamp,
  };

  if (!Array.isArray(chatLog.messages)) chatLog.messages = [];
  chatLog.messages.push(msg);

  if (chatLog.messages.length > 2000) {
    chatLog.messages = chatLog.messages.slice(chatLog.messages.length - 2000);
  }

  try {
    saveChatLogToDisk();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ success: true, message: msg });
});

// ─── POST /api/reports/:name/complete ───
app.post("/api/reports/:name/complete", (req, res) => {
  const fileName = req.params.name;
  const srcPath = path.join(JSON_DIR, fileName);
  const COMPLETE_DIR = path.join(JSON_DIR, "Complete");
  const dstPath = path.join(COMPLETE_DIR, fileName);

  // 1) Ensure the source file exists
  if (!fs.existsSync(srcPath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // 2) Create the “Complete” directory if needed
  fs.mkdirSync(COMPLETE_DIR, { recursive: true });

  try {
    // 3) Load and update the JSON
    const obj = JSON.parse(fs.readFileSync(srcPath, "utf8"));
    if (Array.isArray(req.body.records)) {
      obj.records = req.body.records;
    }
    obj.enabled = false;
    obj.completedAt = new Date().toISOString();

    // 4) Atomically write to the new file, delete the old
    const tempPath = dstPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tempPath, dstPath);
    fs.unlinkSync(srcPath);

    // remove from the in-memory cache so it’s no longer treated as “enabled”
    reportCache.delete(fileName);

    // 5) Update employee‑completion flags
    const empData = loadEmployees();
    req.body.records.forEach((rec) => {
      const nm = rec.employee_name;
      if (nm && !empData.hasOwnProperty(nm)) {
        empData[nm] = false;
      }
    });

    // 6) Re‐scan enabled reports and finalize each employee’s status
    loadEnabledReports((err2, reps2) => {
      if (err2) {
        console.error("loadEnabledReports failed:", err2);
        return res.status(500).json({ error: err2.message });
      }

      req.body.records.forEach((rec) => {
        const nm = rec.employee_name;
        const stillHas = reps2.some((r) =>
          r.data.records?.some((r2) => r2.employee_name === nm),
        );
        if (!stillHas) {
          empData[nm] = true;
        }
      });

      saveEmployees(empData);

      // 7) Send exactly one success response
      return res.json({ success: true });
    });
  } catch (err) {
    console.error("Error completing report:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
