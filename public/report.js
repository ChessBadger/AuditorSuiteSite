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

function normalizeAreaNum(a) {
  // expect "00012" from export; best-effort if number sneaks in
  if (a === null || a === undefined) return "";
  const s = String(a).trim();
  if (/^\d+$/.test(s)) return s.padStart(5, "0");
  return s;
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

  // Pull grouping info by fetching each JSON once (keeps server unchanged)
  // Map: area_num -> { file, area_desc, location_count, group_id }
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
          grouping_enabled: eg.enabled,
        };
      } catch {
        // Fall back gracefully if an item fails
        return {
          area_num: normalizeAreaNum(it.area_num ?? ""),
          area_desc: it.area_desc ?? "",
          location_count: it.location_count ?? 0,
          file: it.file,
          group_id: null,
          grouping_enabled: false,
        };
      }
    })
  );

  // Build groups: group_id -> members[]
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

  // Sort members within groups
  for (const [gid, arr] of groups.entries()) {
    arr.sort((a, b) => String(a.area_num).localeCompare(String(b.area_num)));
  }

  // Prepare display list:
  // - group entries first (sorted by group id)
  // - then ungrouped areas (sorted by area)
  const groupEntries = Array.from(groups.entries()).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]))
  );
  singles.sort((a, b) => String(a.area_num).localeCompare(String(b.area_num)));

  const totalCount = groupEntries.length + singles.length;
  statusEl.textContent = `${items.length} export(s) loaded — ${groupEntries.length} group(s), ${singles.length} single area(s).`;

  // Render grouped entries
  for (const [gid, members] of groupEntries) {
    const li = document.createElement("li");

    const areaNums = members.map((m) => m.area_num).filter(Boolean);
    const areaLabel = summarizeAreaNumbers(areaNums, 2); // <-- tweak 6 if you want

    const locationCount = members.reduce(
      (acc, m) => acc + Number(m.location_count || 0),
      0
    );

    const title = buildGroupTitleFromDescriptions(members);

    li.innerHTML = `
  <div><strong>${escapeHtml(title)}</strong></div>
  <div class="mono muted">${escapeHtml(areaLabel)}</div>
  <div class="muted">${members.length} areas • ${locationCount} locations</div>
`;

    li.addEventListener("click", () => loadAreaGroup(gid, members));
    areaList.appendChild(li);
  }

  // Render single entries (unchanged behavior)
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
  statusEl.textContent = `Loading group…`;

  // Fetch all member JSONs
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

  // fullscreen report view on tablets (same behavior as single-area view)
  document.querySelector(".split")?.classList.add("fullscreen");

  // Use the first area's dates for the column headers (simple + consistent)
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

  // Render each area as its own section (header + locations)
  let groupGrand = { c: 0, p1: 0, p2: 0, p3: 0 };

  const sectionsHtml = results
    .sort((a, b) =>
      String(a.data.area_num ?? "").localeCompare(String(b.data.area_num ?? ""))
    )
    .map(({ data }) => {
      const locs = Array.isArray(data.locations) ? data.locations : [];

      // area totals
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

      const areaFooter = `
        <div style="border-top:1px solid #bbb; margin-top:6px;"></div>
        <div class="report-grid" style="padding:8px 6px; font-weight:800;">
          <div style="grid-column: 1 / span 2;">
            AREA TOTAL
          </div>
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
        <div style="grid-column: 1 / span 2; font-size:16px;">
          GROUP GRAND TOTAL
        </div>
        <div class="num">${fmtMoney(groupGrand.c)}</div>
        <div class="num">${fmtMoney(groupGrand.p1)}</div>
        <div class="num">${fmtMoney(groupGrand.p2)}</div>
        <div class="num">${fmtMoney(groupGrand.p3)}</div>
      </div>
    </div>
  `;

  content.innerHTML = headerHtml + `<div>${sectionsHtml}</div>` + footerHtml;
  statusEl.textContent = `Loaded group ${groupId}`;

  // Back to areas (same behavior as single-area view)
  document.getElementById("back-to-areas")?.addEventListener("click", () => {
    document.querySelector(".split")?.classList.remove("fullscreen");
    loadAreaList();
  });
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
}

refreshBtn?.addEventListener("click", loadAreaList);
loadAreaList();
