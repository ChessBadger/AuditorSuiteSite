// public/report.js

const areaList = document.getElementById("area-list");
const content = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("btn-refresh");

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
  <div class="report-grid report-sub" style="padding:2px 0;">
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
  <div class="report-grid report-sub" style="padding:2px 0;">
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
        <div class="report-grid-sub report-sub">
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
        <div class="report-grid-sub report-sub">
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
// Modal (location action)
// --------------------

const modalState = {
  open: false,
  // context about what row was clicked
  context: null, // { file, area_num, area_desc, loc_num, loc_desc }
  // view state: "choose" | "recount" | "question"
  step: "choose",
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
    // clicking backdrop closes
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

  // UI: disable buttons while submitting
  const footer = document.getElementById("lam-footer");
  footer.querySelectorAll("button").forEach((b) => (b.disabled = true));
  statusEl.textContent = "Saving…";

  try {
    // NEW endpoint you add server-side
    // POST /api/report-exports/:file/location-action
    const res = await fetch(
      `/api/report-exports/${encodeURIComponent(ctx.file)}/location-action`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          area_num: ctx.area_num,
          loc_num: ctx.loc_num,
          action, // "recount" | "question"
          text, // reason or question message
          timestamp: new Date().toISOString(),
        }),
      }
    );

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${t}`.trim());
    }

    statusEl.textContent = `Saved ${action} for location ${String(
      ctx.loc_num
    ).padStart(5, "0")}.`;

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
    // re-enable
    footer.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

// --------------------
// Row click wiring
// --------------------

function wireLocationRowClicks(root, viewContext) {
  // viewContext: { type: "area", file, area_num, area_desc } or { type:"group" ... } per row uses data attributes
  (root || document)
    .querySelectorAll(".report-row.report-main")
    .forEach((row) => {
      // Avoid double-binding if re-rendered: simplest guard
      if (row.dataset.boundClick === "1") return;
      row.dataset.boundClick = "1";

      row.addEventListener("click", (e) => {
        // If later you add other buttons inside row, ignore clicks on them
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
  document.querySelector(".split")?.classList.remove("fullscreen");

  const res = await fetch("/api/report-exports");
  if (!res.ok) {
    statusEl.textContent = `Failed to load areas. HTTP ${res.status}`;
    return;
  }

  const items = await res.json();

  // Enrich with grouping info by fetching each JSON once
  const enriched = await Promise.all(
    items.map(async (it) => {
      try {
        const r = await fetch(
          `/api/report-exports/${encodeURIComponent(it.file)}`
        );
        if (!r.ok) throw new Error("bad fetch");
        const data = await r.json();
        const eg = getExportGrouping(data);
        return {
          area_num: normalizeAreaNum(it.area_num ?? data.area_num ?? ""),
          area_desc: it.area_desc ?? data.area_desc ?? "",
          location_count:
            it.location_count ??
            (Array.isArray(data.locations) ? data.locations.length : 0),
          file: it.file,
          group_id: eg.group_id,
        };
      } catch {
        return {
          area_num: normalizeAreaNum(it.area_num ?? ""),
          area_desc: it.area_desc ?? "",
          location_count: it.location_count ?? 0,
          file: it.file,
          group_id: null,
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

  statusEl.textContent = `${items.length} export(s) loaded — ${groupEntries.length} group(s), ${singles.length} single area(s).`;

  // Render groups
  for (const [gid, members] of groupEntries) {
    const li = document.createElement("li");

    const areaNums = members.map((m) => m.area_num).filter(Boolean);
    const areaLabel = summarizeAreaNumbers(areaNums, 2);

    const locationCount = members.reduce(
      (acc, m) => acc + Number(m.location_count || 0),
      0
    );

    const title = buildGroupTitleFromDescriptions(members);

    li.innerHTML = `
      <div><strong>${escapeHtml(title)}</strong></div>
      <div class="mono muted">${escapeHtml(areaLabel)}</div>
      <div class="muted">${
        members.length
      } areas • ${locationCount} locations</div>
    `;

    li.addEventListener("click", () => loadAreaGroup(gid, members));
    areaList.appendChild(li);
  }

  // Render singles
  for (const item of singles) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><strong>${escapeHtml(item.area_desc || "")}</strong></div>
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
    members.map(async (m) => {
      const res = await fetch(
        `/api/report-exports/${encodeURIComponent(m.file)}`
      );
      if (!res.ok) throw new Error(`Failed to load ${m.file}`);
      const data = await res.json();
      return { meta: m, data };
    })
  );

  document.querySelector(".split")?.classList.add("fullscreen");

  const first = results[0]?.data || {};
  const dates = first.dates || {};

  function fmtDateLabel(iso, fallback) {
    if (!iso) return fallback;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return fallback;
    return d.toLocaleDateString();
  }

  const col1 = fmtDateLabel(dates.current, "Current");
  const col2 = fmtDateLabel(dates.prior1, "Prior 1");
  const col3 = fmtDateLabel(dates.prior2, "Prior 2");
  const col4 = fmtDateLabel(dates.prior3, "Prior 3");

  const headerHtml = `
    <div class="report-header">
      <button id="back-to-areas" class="btn" style="margin-bottom:10px;">← Areas</button>

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

          // NOTE: These data-* fields are what the row click uses for the modal.
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
                )}</div>
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
                ${renderBreakdown(l.report_breakdown)}
              </div>
            </div>
          `;
        })
        .join("");

      const areaFooter = `
        <div style="border-top:1px solid #bbb; margin-top:6px;"></div>
        <div class="report-grid" style="padding:8px 6px; font-weight:800;">
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
      <div class="report-grid">
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

  statusEl.textContent = `Loaded group ${groupId}`;

  document.getElementById("back-to-areas")?.addEventListener("click", () => {
    document.querySelector(".split")?.classList.remove("fullscreen");
    loadAreaList();
  });
}

async function loadArea(file) {
  currentView.type = "area";
  currentView.file = file;
  currentView.groupId = null;
  currentView.members = null;

  statusEl.textContent = `Loading…`;
  const res = await fetch(`/api/report-exports/${encodeURIComponent(file)}`);
  if (!res.ok) {
    statusEl.textContent = `Failed to load report. HTTP ${res.status}`;
    return;
  }

  const data = await res.json();
  const locs = Array.isArray(data.locations) ? data.locations : [];

  document.querySelector(".split")?.classList.add("fullscreen");

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
      <button id="back-to-areas" class="btn" style="margin-bottom:10px;">← Areas</button>

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
            )}</div>
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
            ${renderBreakdown(l.report_breakdown)}
          </div>
        </div>
      `;
    })
    .join("");

  const footerHtml = `
    <div class="report-footer">
      <div class="report-grid">
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

  statusEl.textContent = `Loaded area ${data.area_num}`;

  document.getElementById("back-to-areas")?.addEventListener("click", () => {
    document.querySelector(".split")?.classList.remove("fullscreen");
    loadAreaList();
  });
}

refreshBtn?.addEventListener("click", loadAreaList);
loadAreaList();
