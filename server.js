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
    const names = new Set();
    reps.forEach((r) => {
      r.data.records?.forEach((rec) => {
        if (rec.employee_name) names.add(rec.employee_name);
      });
    });
    res.json(Array.from(names).sort());
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

// ——— fetch records filtered by employee or location (only from enabled) ———
app.get("/api/records", (req, res) => {
  const { employee, location } = req.query;
  if (!employee && !location) {
    return res
      .status(400)
      .json({ error: "Must specify ?employee=… or ?location=…" });
  }

  loadEnabledReports((err, reps) => {
    if (err) return res.status(500).json({ error: err.message });

    const matches = [];
    reps.forEach((r) => {
      r.data.records?.forEach((rec) => {
        if (
          (employee && rec.employee_name === employee) ||
          (location && `${rec.LOC_NUM} - ${rec.loc_desc}` === location)
        ) {
          matches.push(Object.assign({ file: r.file }, rec));
        }
      });
    });

    res.json(matches);
  });
});

// ─── POST /api/reports/:name/complete ───
app.post("/api/reports/:name/complete", (req, res) => {
  console.log("req.body:", req.body); // you should now see { records: [...] }
  const fileName = req.params.name;
  const srcPath = path.join(JSON_DIR, fileName);
  const COMPLETE_DIR = path.join(JSON_DIR, "Complete");
  const dstPath = path.join(COMPLETE_DIR, fileName);

  if (!fs.existsSync(srcPath)) {
    return res.status(404).json({ error: "File not found" });
  }
  fs.mkdirSync(COMPLETE_DIR, { recursive: true });

  try {
    const obj = JSON.parse(fs.readFileSync(srcPath, "utf8"));

    // now this will be true _iff_ your client sent edits
    if (Array.isArray(req.body.records)) {
      obj.records = req.body.records;
    }

    obj.enabled = false;
    obj.completedAt = new Date().toISOString();

    const tempPath = dstPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tempPath, dstPath);
    fs.unlinkSync(srcPath);

    return res.json({ success: true });
  } catch (err) {
    console.error("Complete error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
