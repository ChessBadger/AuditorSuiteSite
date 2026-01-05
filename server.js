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
/**
 * Preload every .json in JSON_DIR into reportCache
 */
function preloadReports() {
  const files = fs
    .readdirSync(JSON_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"));

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
      const raw = fs.readFileSync(path.join(REPORT_DIR, f), "utf8");
      const data = JSON.parse(raw);
      reportExportCache.set(f, data);
    } catch (err) {
      console.warn(`Skipping invalid report export JSON ${f}: ${err.message}`);
    }
  });

  console.log(
    `Preloaded ${reportExportCache.size} report-export JSON files into memory`
  );
}

// Watch for changes in REPORT_DIR and reload individual files
if (fs.existsSync(REPORT_DIR)) {
  fs.watch(REPORT_DIR, (event, filename) => {
    if (!filename || !filename.toLowerCase().endsWith(".json")) return;

    const filePath = path.join(REPORT_DIR, filename);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        reportExportCache.set(filename, JSON.parse(raw));
        console.log(`Reloaded report export ${filename} into cache`);
      } catch (err) {
        console.warn(
          `Failed to reload report export ${filename}: ${err.message}`
        );
      }
    } else {
      reportExportCache.delete(filename);
      console.log(`Removed report export ${filename} from cache`);
    }
  });
}

// Preload at startup
preloadReports();
preloadReportExports();
preloadCustMaster();

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
          AREA_NUM
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

// List available area exports
app.get("/api/report-exports", (req, res) => {
  const list = Array.from(reportExportCache.entries())
    .filter(([_, data]) => !!data && !!data.area_num)
    .map(([file, data]) => ({
      file,
      area_num: data.area_num,
      area_desc: data.area_desc || "",
      location_count: Array.isArray(data.locations) ? data.locations.length : 0,
    }))
    .sort((a, b) => String(a.area_num).localeCompare(String(b.area_num)));

  res.json(list);
});

// Fetch one area export by filename (e.g. 40051.json)
app.get("/api/report-exports/:file", (req, res) => {
  const file = req.params.file;
  const data = reportExportCache.get(file);
  if (!data) return res.status(404).json({ error: "Report export not found" });
  res.json(data);
});

// ─── POST location actions (recount / question) ───
app.post("/api/report-exports/:file/location-action", (req, res) => {
  const file = req.params.file; // e.g. "40061.json"
  const data = reportExportCache.get(file);

  if (!data) {
    return res.status(404).json({ error: "Report export not found" });
  }

  const { area_num, loc_num, action, text, timestamp } = req.body;

  if (!loc_num || !action) {
    return res.status(400).json({ error: "Missing loc_num or action" });
  }

  if (!["recount", "question"].includes(action)) {
    return res.status(400).json({ error: "Invalid action type" });
  }

  // Ensure actions array exists
  if (!Array.isArray(data.location_actions)) {
    data.location_actions = [];
  }

  // Record the action
  data.location_actions.push({
    area_num,
    loc_num,
    action,
    text: text || "",
    timestamp: timestamp || new Date().toISOString(),
  });

  // Persist to disk
  const filePath = path.join(REPORT_DIR, file);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Update in-memory cache
  reportExportCache.set(file, data);

  res.json({ success: true });
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
          r.data.records?.some((r2) => r2.employee_name === nm)
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
