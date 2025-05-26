// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
const JSON_DIR = path.resolve(__dirname, "..");

// ← THIS MUST COME BEFORE YOUR ROUTES:
app.use(express.json());

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
 * Helper: reads every .json in JSON_DIR and returns only
 * those whose parsed object has enabled === true.
 *
 * callback signature: (err, [ { file: '01010.json', data: {…} }, … ])
 */
function loadEnabledReports(callback) {
  fs.readdir(JSON_DIR, (err, files) => {
    if (err) return callback(err);
    const jsonFiles = files.filter((f) => f.toLowerCase().endsWith(".json"));
    const results = [];
    let remaining = jsonFiles.length;
    if (!remaining) return callback(null, results);

    jsonFiles.forEach((f) => {
      const fullPath = path.join(JSON_DIR, f);
      fs.readFile(fullPath, "utf8", (err, raw) => {
        remaining--;
        if (!err) {
          try {
            const obj = JSON.parse(raw);
            if (obj.enabled === true) {
              results.push({ file: f, data: obj });
            }
          } catch (_) {
            /* ignore parse errors */
          }
        }
        if (remaining === 0) {
          callback(null, results);
        }
      });
    });
  });
}

// ——— list enabled JSON filenames ———
app.get("/api/reports", (req, res) => {
  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(reps.map((r) => r.file));
  });
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

    // 3. add any brand‐new employees with completed=false
    names.forEach((n) => {
      if (!empData.hasOwnProperty(n)) empData[n] = false;
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

// ─── POST /api/reports/:name/complete ───
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
