// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
const JSON_DIR = path.resolve(__dirname, "..");

// ——— In‑memory cache for all JSON files ———
const reportCache = new Map();

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

// Preload at startup
preloadReports();

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
app.get("/api/locations", (req, res) => {
  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });
    const locs = new Set();
    reps.forEach((r) => {
      r.data.records?.forEach((rec) => {
        if (rec.LOC_NUM && rec.loc_desc) {
          locs.add(`${rec.LOC_NUM} - ${rec.loc_desc}`);
        }
      });
    });
    res.json(Array.from(locs).sort());
  });
});

// near the top, after your other route definitions
app.get("/ping", (req, res) => {
  res.sendStatus(200);
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
