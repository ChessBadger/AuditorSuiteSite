// public/report.js

const areaList = document.getElementById("area-list");
const content = document.getElementById("content");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("btn-refresh");

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

function renderBreakdown(bd) {
  if (!bd || typeof bd !== "object") {
    return `<div class="muted">No breakdown available.</div>`;
  }

  // Normalize to arrays so .map never crashes
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

  // If mode missing/unknown, try best-effort:
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

async function loadAreaList() {
  statusEl.textContent = "Loading…";
  areaList.innerHTML = "";
  content.innerHTML = `<p class="muted">Select an area to view locations + totals.</p>`;

  // Ensure we are not stuck in fullscreen report mode
  document.querySelector(".split")?.classList.remove("fullscreen");

  const res = await fetch("/api/report-exports");
  if (!res.ok) {
    statusEl.textContent = `Failed to load areas. HTTP ${res.status}`;
    return;
  }

  const items = await res.json();
  statusEl.textContent = `${items.length} area export(s) loaded.`;

  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><span class="mono">${escapeHtml(
        item.area_num ?? ""
      )}</span> — ${escapeHtml(item.area_desc || "")}</div>
      <div class="muted">${item.location_count ?? 0} locations</div>
    `;
    // IMPORTANT: attach to li (not window)
    li.addEventListener("click", () => loadArea(item.file));
    areaList.appendChild(li);
  }
}

async function loadArea(file) {
  statusEl.textContent = `Loading…`;
  const res = await fetch(`/api/report-exports/${encodeURIComponent(file)}`);
  if (!res.ok) {
    statusEl.textContent = `Failed to load report. HTTP ${res.status}`;
    return;
  }

  const data = await res.json();
  const locs = Array.isArray(data.locations) ? data.locations : [];

  // fullscreen report view on tablets
  document.querySelector(".split")?.classList.add("fullscreen");

  // Column labels (if you later export real dates, swap these)
  const col1 = "Current";
  const col2 = "Prior 1";
  const col3 = "Prior 2";
  const col4 = "Prior 3";

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

  // Grand totals across all locations
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
<div class="report-row report-grid report-main" data-target="${id}">
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
<div style="grid-column: 1 / span 2; font-size:16px;">
  GRAND TOTAL
</div>
        <div class="num">${fmtMoney(grand.c)}</div>
        <div class="num">${fmtMoney(grand.p1)}</div>
        <div class="num">${fmtMoney(grand.p2)}</div>
        <div class="num">${fmtMoney(grand.p3)}</div>
      </div>
    </div>
  `;

  content.innerHTML = headerHtml + `<div>${rowsHtml}</div>` + footerHtml;
  statusEl.textContent = `Loaded area ${data.area_num}`;

  // Back to areas
  document.getElementById("back-to-areas")?.addEventListener("click", () => {
    document.querySelector(".split")?.classList.remove("fullscreen");
    loadAreaList();
  });

  // click-to-expand breakdown
  content.querySelectorAll(".report-row").forEach((row) => {
    row.addEventListener("click", () => {
      const target = document.getElementById(row.dataset.target);
      if (!target) return;
      target.style.display = target.style.display === "none" ? "block" : "none";
    });
  });
}

refreshBtn?.addEventListener("click", loadAreaList);
loadAreaList();
