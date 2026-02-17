// script.js
document.addEventListener("DOMContentLoaded", () => {
  const btnEmp = document.getElementById("btn-employee");
  const btnLoc = document.getElementById("btn-location");
  const btnRefresh = document.getElementById("btn-refresh");
  const listEl = document.getElementById("item-list");
  const recContainer = document.getElementById("record-container");
  const container = document.querySelector(".container");

  let currentView = "employee";
  const btnSKU = document.getElementById("btn-sku");
  const skuInput = document.getElementById("sku-input");

  const banner = document.getElementById("server-status-banner");
  const logoEl = document.getElementById("logo");
  const fullscreenBtn = document.getElementById("btn-fullscreen");
  const adminBadge = document.getElementById("admin-badge");

  // In-memory cache for last-known-good API data (no localStorage).
  const memCache = new Map();
  const recordsByLocation = new Map();
  const pendingWrites = [];
  let flushInFlight = false;

  async function fetchJsonWithMemCache(url) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      memCache.set(url, data);
      return { data, fromCache: false };
    } catch (err) {
      if (memCache.has(url)) {
        return { data: memCache.get(url), fromCache: true };
      }
      throw err;
    }
  }

  function getLocationKey(row) {
    return `${row.LOC_NUM} - ${row.loc_desc}`;
  }

  function indexRecordsByLocation(data) {
    if (!Array.isArray(data)) return;
    const touched = new Set();
    data.forEach((row) => {
      if (!row || row.LOC_NUM == null || row.loc_desc == null) return;
      const key = getLocationKey(row);
      if (!touched.has(key)) {
        recordsByLocation.set(key, []);
        touched.add(key);
      }
      recordsByLocation.get(key).push(row);
    });
  }

  function getCachedRecordsForLocation(locString) {
    const rows = recordsByLocation.get(locString);
    return Array.isArray(rows) ? rows : null;
  }

  async function postJsonQueued(url, body) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { res, queued: false };
    } catch (err) {
      pendingWrites.push({ url, body });
      return { res: null, queued: true };
    }
  }

  async function flushPendingWrites() {
    if (flushInFlight || pendingWrites.length === 0) return;
    flushInFlight = true;

    const remaining = [];
    for (const item of pendingWrites) {
      try {
        const res = await fetch(item.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.body),
        });
        if (!res.ok) remaining.push(item);
      } catch {
        remaining.push(item);
      }
    }

    pendingWrites.length = 0;
    pendingWrites.push(...remaining);
    flushInFlight = false;
  }

  // --------------------
  // Admin mode / hidden fullscreen control
  // - Tap logo 5x -> PIN prompt (0213) -> admin mode
  // - In admin mode: show fullscreen button
  // - Tap logo once while in admin mode -> exit admin mode (hide again)
  // --------------------

  const ADMIN_PIN = "0213";
  let adminMode = false;
  let wantsBrowserFullscreen = true;

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

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) showFsOverlayIfNeeded();
  });
  window.addEventListener("pageshow", showFsOverlayIfNeeded);

  fullscreenBtn?.addEventListener("click", () => {
    toggleFullscreen();
  });

  logoEl?.addEventListener("click", () => {
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

  refreshFullscreenBtnLabel();

  const DISCONNECT_BANNER_AFTER_MS = 5 * 60 * 1000; // 5 minutes
  let disconnectedSince = null;

  function showBanner() {
    banner.classList.remove("hidden");
  }
  function hideBanner() {
    banner.classList.add("hidden");
  }

  function markDisconnected() {
    if (!disconnectedSince) {
      disconnectedSince = Date.now();
    }
  }

  function markConnected() {
    disconnectedSince = null;
    hideBanner();
    flushPendingWrites();
  }

  function updateDisconnectUI() {
    if (!disconnectedSince) {
      hideBanner();
      return;
    }
    const elapsed = Date.now() - disconnectedSince;
    if (elapsed >= DISCONNECT_BANNER_AFTER_MS) showBanner();
    else hideBanner();
  }

  async function checkServer() {
    // create a controller and abort after 2s
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch("/ping", {
        cache: "no-cache",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        markConnected();
      } else {
        markDisconnected();
        updateDisconnectUI();
      }
    } catch (err) {
      clearTimeout(timeoutId);
      markDisconnected();
      updateDisconnectUI();
    }
  }

  // run on load, then every 3s
  window.addEventListener("load", () => {
    checkServer();
    updateDisconnectUI();
  });
  setInterval(checkServer, 3000);
  setInterval(updateDisconnectUI, 2500);
  window.addEventListener("online", () => {
    markConnected();
  });

  const currencyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  });

  const ALL_COLUMNS = [
    { key: "RECORD", label: "Record" },
    { key: "SKU", label: "SKU" },
    { key: "DESCRIPTIO", label: "Description" }, // or 'DESCRIPTION' if that's the real key
    { key: "CAT_NUM", label: "Category" },
    { key: "EXT_QTY", label: "Qty" },
    { key: "PRICE", label: "Price" },
    { key: "EXT_PRICE", label: "Total Price" },
  ];

  // Sidebar show/hide
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const containerEl = document.querySelector(".container");

  // Read last state from localStorage (optional)
  if (localStorage.getItem("sidebarCollapsed") === "true") {
    containerEl.classList.add("collapsed");
  }

  document.addEventListener("focusin", (e) => {
    if (e.target.tagName === "INPUT") {
      e.target.select();
    }
  });

  document
    .querySelector("#record-container")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
        e.target.blur();
      }
    });

  btnSKU.addEventListener("click", () => {
    currentView = "sku";
    // clear active states on the other buttons
    [btnEmp, btnLoc].forEach((b) => b.classList.remove("active"));
    btnSKU.classList.add("active");
    recContainer.innerHTML =
      '<p class="placeholder">Enter a SKU and click Search</p>';
  });

  fetch("/api/YesNoOption.json")
    .then((res) => {
      if (!res.ok) throw new Error("Cannot load YesNoOption.json");
      return res.json();
    })
    .then((config) => {
      if (config.YesNo === false) {
        // Hide “By Employee” button
        btnEmp.style.display = "none";

        // Programmatically toggle “By Location”
        btnLoc.classList.add("active");
        currentView = "location";

        // load location sidebar immediately:
        loadSidebarItems();
      }
    })
    .catch((err) => {
      console.warn("Could not load YesNoOption.json:", err);
    });

  function searchBySKU() {
    const sku = skuInput.value.trim();
    if (!sku) return alert("Please enter a SKU.");
    skuInput.value = "";
    const prevHtml = recContainer.innerHTML;
    recContainer.innerHTML = '<p class="placeholder">Searching for SKU…</p>';

    fetchJsonWithMemCache(`/api/records?sku=${encodeURIComponent(sku)}`)
      .then(({ data }) => data)
      .then((data) => {
        indexRecordsByLocation(data);
        if (!data.length) {
          recContainer.innerHTML =
            '<p class="placeholder">No records found for that SKU</p>';
          return;
        }

        // Group records by "LOC_NUM - loc_desc"
        const byLoc = data.reduce((acc, row) => {
          const locKey = `${row.LOC_NUM} - ${row.loc_desc}`;
          if (!acc[locKey]) acc[locKey] = [];
          acc[locKey].push(row);
          return acc;
        }, {});

        recContainer.innerHTML = "";

        // For each location, render a header + table
        Object.entries(byLoc).forEach(([loc, rows]) => {
          // Location header
          const header = document.createElement("div");
          header.classList.add("record-header");
          header.textContent = loc;
          recContainer.appendChild(header);

          // Table of rows for this location
          const table = buildRecordTable(rows);
          recContainer.appendChild(table);
        });
      })
      .catch(() => {
        recContainer.innerHTML = prevHtml;
      });

    setView("location");
  }

  // Helper: given an array of record‐objects, build the same table your
  // showLocationTable() does, but without refetching.
  function buildRecordTable(data) {
    // figure out which columns actually have data
    const visibleCols = ALL_COLUMNS.filter((col) =>
      data.some(
        (row) => row[col.key] != null && String(row[col.key]).trim() !== ""
      )
    );

    const table = document.createElement("table");
    table.classList.add("record-table");

    // build header
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    visibleCols.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // build body
    const tbody = document.createElement("tbody");
    let grandTotal = 0;
    data.forEach((row) => {
      const tr = document.createElement("tr");
      visibleCols.forEach((col) => {
        const td = document.createElement("td");
        if (col.key === "EXT_PRICE") {
          const val = (row.EXT_QTY || 0) * (row.PRICE || 0);
          grandTotal += val;
          row.EXT_PRICE = grandTotal;
          td.textContent = currencyFormatter.format(val);
        } else {
          td.textContent = row[col.key] ?? "";
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    // grand total row if needed
    if (visibleCols.some((c) => c.key === "EXT_PRICE")) {
      const trTot = document.createElement("tr");
      trTot.classList.add("record-total-row");
      const tdLabel = document.createElement("td");
      tdLabel.textContent = "Grand Total";
      tdLabel.colSpan = visibleCols.length - 1;
      trTot.appendChild(tdLabel);

      const tdTotal = document.createElement("td");
      tdTotal.textContent = currencyFormatter.format(grandTotal);
      trTot.appendChild(tdTotal);
      tbody.appendChild(trTot);
    }

    table.appendChild(tbody);
    makeTableSortable(table);
    return table;
  }

  // hook up the SKU search button
  btnSKU.addEventListener("click", searchBySKU);

  btnLoc.addEventListener("click", () => {
    containerEl.classList.remove("collapsed");
  });

  btnRefresh.addEventListener("click", () => {
    containerEl.classList.remove("collapsed");
  });

  btnEmp.addEventListener("click", () => {
    containerEl.classList.remove("collapsed");
  });
  // Toggle on click
  sidebarToggle.addEventListener("click", () => {
    containerEl.classList.toggle("collapsed");
    const isCollapsed = containerEl.classList.contains("collapsed");
    localStorage.setItem("sidebarCollapsed", isCollapsed);
  });

  btnEmp.addEventListener("click", () => setView("employee"));
  btnLoc.addEventListener("click", () => setView("location"));

  btnRefresh.addEventListener("click", () => setView("current"));

  function setView(view) {
    if (view == "current") {
      currentView = currentView;
    } else {
      currentView = view;
    }
    btnEmp.classList.toggle("active", view === "employee");
    btnLoc.classList.toggle("active", view === "location");
    recContainer.innerHTML =
      '<p class="placeholder">Select an item to view details</p>';
    loadSidebarItems();
  }

  // 1) Sort helper: call this on any <table class="record-table">
  /**
   * Makes a <table class="record-table"> sortable, even if some cells contain <input> elements.
   */
  function makeTableSortable(table) {
    // helper: extract the “value” from a cell
    function getCellValue(cell) {
      const input = cell.querySelector("input");
      if (input) return input.value.trim();
      return cell.textContent.trim();
    }

    const headers = table.querySelectorAll("thead th");
    headers.forEach((header, colIndex) => {
      let asc = true;
      header.style.cursor = "pointer";
      header.addEventListener("click", () => {
        const tbody = table.tBodies[0];
        const rows = Array.from(tbody.rows);
        // pull out any “total” row so it stays at the bottom
        let totalRow = null;
        const ti = rows.findIndex((r) =>
          r.classList.contains("record-total-row")
        );
        if (ti !== -1) totalRow = rows.splice(ti, 1)[0];

        rows.sort((rowA, rowB) => {
          const aVal = getCellValue(rowA.cells[colIndex]);
          const bVal = getCellValue(rowB.cells[colIndex]);
          // try numeric
          const aNum = parseFloat(aVal.replace(/[^0-9.-]/g, ""));
          const bNum = parseFloat(bVal.replace(/[^0-9.-]/g, ""));
          let diff;
          if (!isNaN(aNum) && !isNaN(bNum)) {
            diff = aNum - bNum;
          } else {
            diff = aVal.localeCompare(bVal, undefined, { numeric: true });
          }
          return asc ? diff : -diff;
        });

        // re‑append in order, then the total row
        rows.forEach((r) => tbody.appendChild(r));
        if (totalRow) tbody.appendChild(totalRow);
        asc = !asc;
      });
    });
  }

  function loadSidebarItems() {
    const prevHtml = listEl.innerHTML;
    listEl.innerHTML = "<li>Loading…</li>";
    const endpoint = currentView === "employee" ? "employees" : "locations";
    fetchJsonWithMemCache(`/api/${endpoint}`)
      .then(({ data }) => data)
      .then((items) => {
        listEl.innerHTML = "";

        // ── Grouped by area_desc, with collapsible sections ──
        if (currentView === "location") {
          listEl.innerHTML = ""; // clear loading…
          items.forEach((group) => {
            const groupLi = document.createElement("li");
            groupLi.classList.add("area-group");

            // header
            const header = document.createElement("div");
            header.classList.add("area-header");
            const arrow = document.createElement("span");
            arrow.classList.add("arrow");
            // ← collapsed by default:
            arrow.textContent = "";
            header.appendChild(arrow);
            const title = document.createElement("strong");
            title.textContent = group.area_desc;
            header.appendChild(title);
            groupLi.appendChild(header);

            // nested list, collapsed initially:
            const nestedUl = document.createElement("ul");
            nestedUl.classList.add("nested-locations", "hidden");
            group.locations.forEach((loc) => {
              const locLi = document.createElement("li");
              const btn = document.createElement("button");
              btn.textContent = loc;
              btn.addEventListener("click", () => {
                listEl
                  .querySelectorAll("button")
                  .forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                showLocationTable(loc);
              });
              locLi.appendChild(btn);
              nestedUl.appendChild(locLi);
            });
            groupLi.appendChild(nestedUl);

            // toggle on click
            header.addEventListener("click", () => {
              nestedUl.classList.toggle("hidden");
              arrow.textContent = nestedUl.classList.contains("hidden")
                ? ""
                : "↓";
            });

            listEl.appendChild(groupLi);
          });
        } else {
          // ── “By Employee” as before ──
          items.forEach((item) => {
            const li = document.createElement("li");
            const btn = document.createElement("button");

            let name = item;
            let completed = false;
            if (typeof item === "object") {
              name = item.name;
              completed = item.completed;
            }
            if (!name || !name.toString().trim()) return;

            btn.textContent = name;
            if (completed) {
              btn.disabled = true;
              const chk = document.createElement("span");
              chk.classList.add("checkmark");
              chk.textContent = " ✓";
              btn.appendChild(chk);
            } else {
              btn.addEventListener("click", () => {
                listEl
                  .querySelectorAll("button")
                  .forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                loadEmployeeLocations(name);
              });
            }

            li.appendChild(btn);
            listEl.appendChild(li);
          });
        }
      })
      .catch(() => {
        listEl.innerHTML = prevHtml;
      });
  }

  function loadEmployeeLocations(employee) {
    const prevHtml = recContainer.innerHTML;
    recContainer.innerHTML = '<p class="placeholder">Loading locations…</p>';
    fetchJsonWithMemCache(`/api/records?employee=${encodeURIComponent(employee)}`)
      .then(({ data }) => data)
      .then((data) => {
        indexRecordsByLocation(data);
        if (!data.length) {
          recContainer.innerHTML =
            '<p class="placeholder">No locations found</p>';
          return;
        }
        // unique “LOC_NUM – loc_desc” strings
        const locations = Array.from(
          new Set(data.map((r) => `${r.LOC_NUM} - ${r.loc_desc}`))
        );
        recContainer.innerHTML = "";
        const ul = document.createElement("ul");
        ul.classList.add("record-list");
        locations.forEach((loc) => {
          const li = document.createElement("li");
          const btn = document.createElement("button");
          btn.textContent = loc;
          btn.addEventListener("click", () => showLocationTable(loc));
          li.appendChild(btn);
          ul.appendChild(li);
        });
        recContainer.appendChild(ul);
      })
      .catch(() => {
        recContainer.innerHTML = prevHtml;
      });
  }

  function showLocationTable(locString) {
    const prevHtml = recContainer.innerHTML;
    recContainer.innerHTML = '<p class="placeholder">Loading records...</p>';
    container.classList.add("collapsed");

    function renderLocationRecords(data) {
      data.forEach((r) => {
        r.deleted = Boolean(r.deleted);
        r.isNew = Boolean(r.isNew);
      });

      if (!data.length) {
        recContainer.innerHTML =
          '<p class="placeholder">No records found</p>';
        return;
      }

      const visibleCols = ALL_COLUMNS.filter((col) =>
        data.some((row) => {
          const v = row[col.key];
          return v !== null && v !== undefined && String(v).trim() !== "";
        })
      );

      const skuVisible = visibleCols.some((c) => c.key === "SKU");
      if (!skuVisible) {
        btnSKU.style.display = "none";
        skuInput.style.display = "none";
      } else {
        btnSKU.style.display = "";
        skuInput.style.display = "";
      }
      const descVisible = visibleCols.some((c) => c.key === "DESCRIPTIO");
      const catEditable =
        !skuVisible &&
        !descVisible &&
        visibleCols.some((c) => c.key === "CAT_NUM");
      const priceEditable =
        !skuVisible && visibleCols.some((c) => c.key === "PRICE");

      const fileName = data[0].file;
      let saveTimeout = null;
      function saveData() {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
          const toSend = data
            .filter((r) => !(r.isNew && r.deleted))
            .map((r) => ({
              ...r,
              deleted: r.deleted,
              isNew: r.isNew,
            }));
          postJsonQueued(`/api/reports/${encodeURIComponent(fileName)}`, {
            records: toSend,
          }).then(({ queued }) => {
            if (queued) console.warn("Autosave queued (offline).");
          });
        }, 500);
      }

      recContainer.innerHTML = "";

      const btnGroup = document.createElement("div");
      btnGroup.classList.add("record-header");

      // Add New Record at top
      const addBtn = document.createElement("button");
      addBtn.textContent = "Add Record";
      addBtn.classList.add("complete-btn");
      addBtn.style.marginRight = "1rem";
      addBtn.addEventListener("click", () => {
        // 1) Build a blank record object that has all the same keys as data[0],
        //    initializing every property to "" (empty string).
        const newRec = {};

        if (data.length > 0) {
          // Copy every key from the first existing record into newRec
          Object.keys(data[0]).forEach((key) => {
            newRec[key] = "";
          });

          // 2) Immediately overwrite these three so they match the other rows:
          newRec.file = data[1].file;
          newRec.AREA_NUM = data[1].AREA_NUM;
          newRec.LOC_NUM = data[1].LOC_NUM;
          newRec.area_desc = data[1].area_desc;
          newRec.loc_desc = data[1].loc_desc;

          newRec.deleted = false;
          newRec.isNew = true;
        } else {
          // (Fallback: if somehow data[] is empty, at least include the columns we know about)
          ALL_COLUMNS.forEach((col) => {
            newRec[col.key] = "";
          });
        }

        // 3) Add the required flags for a new row
        newRec.deleted = false;
        newRec.isNew = true;

        // 4) Insert at the front of the array, rebuild, and scroll into view:
        data.unshift(newRec);
        saveData();
        rebuildTable();
        recContainer.querySelector("table");
      });

      btnGroup.appendChild(addBtn);

      const completeBtn = document.createElement("button");
      completeBtn.textContent = "Mark Location Complete";
      completeBtn.classList.add("complete-btn");

      completeBtn.addEventListener("click", () => {
        // validate all inputs
        const tableEl = recContainer.querySelector("table");
        const allInputs = tableEl ? tableEl.querySelectorAll("input") : [];
        for (let inp of allInputs) {
          if (!inp.checkValidity()) {
            inp.reportValidity();
            return;
          }
        }

        if (!confirm("Are you sure you want to mark this location complete?"))
          return;

        // filter out records that were added and then deleted
        const toSend = data
          .filter((r) => !(r.isNew && r.deleted))
          .map((r) => ({
            ...r,
            deleted: r.deleted || undefined,
            isNew: r.isNew || undefined,
          }));

        const payload = { records: toSend };
        console.log("Sending complete payload:", payload);
        postJsonQueued(
          `/api/reports/${encodeURIComponent(fileName)}/complete`,
          payload,
        )
          .then(({ res, queued }) => {
            if (queued) {
              alert("Offline. Completion queued and will send when reconnected.");
              return;
            }
            return res.json();
          })
          .then((resp) => {
            if (!resp) return;
            if (resp.success) {
              alert("Location marked complete.");
              setView(currentView);
            } else {
              alert("Error: " + (resp.error || "Unknown"));
            }
          })
          .catch(() => alert("Network error"));
        containerEl.classList.remove("collapsed");
      });
      btnGroup.appendChild(completeBtn);
      recContainer.appendChild(btnGroup);

      const header = document.createElement("div");
      header.classList.add("record-header");
      header.textContent = `Area: ${data[0].area_desc} | Location: ${data[0].loc_desc}`;
      recContainer.appendChild(header);

      let table, tbody, totalCell;

      function rebuildTable() {
        if (table) table.remove();

        table = document.createElement("table");
        table.classList.add("record-table");

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        visibleCols.forEach((col) => {
          const th = document.createElement("th");
          th.textContent = col.label;
          headRow.appendChild(th);
        });
        const thDel = document.createElement("th");
        thDel.textContent = "X";
        thDel.classList.add("delete-col");
        headRow.appendChild(thDel);

        thead.appendChild(headRow);
        table.appendChild(thead);

        tbody = document.createElement("tbody");
        let grandTotal = 0;

        data.forEach((rowData, rowIdx) => {
          const tr = document.createElement("tr");
          if (rowData.deleted) tr.classList.add("deleted");

          visibleCols.forEach((col) => {
            const td = document.createElement("td");
            if (col.key === "SKU") {
              const inp = document.createElement("input");
              inp.type = "number";
              // inp.required = true;
              inp.value = rowData.SKU || "";
              inp.style.whiteSpace = "nowrap";
              inp.addEventListener("change", () => {
                rowData.SKU = inp.value.trim();

                fetch(`/api/sku/${encodeURIComponent(rowData.SKU)}`)
                  .then((r) => (r.ok ? r.json() : null))
                  .then((master) => {
                    if (master) {
                      Object.keys(rowData).forEach((locKey) => {
                        // If the master record has the same field, overwrite:
                        if (
                          master.hasOwnProperty(locKey) &&
                          master[locKey] != null
                        ) {
                          rowData[locKey] = master[locKey];
                        }
                      });
                      // If your master JSON uses different property names than your
                      // location JSON, you still need to map them explicitly:
                      if (master.STORE_PRIC != null) {
                        rowData.PRICE = master.STORE_PRIC;
                      }
                      if (master.DEPT != null) {
                        rowData.CAT_NUM = master.DEPT;
                      }

                      rowData.EXT_PRICE = rowData.PRICE * rowData.EXT_QTY;
                      rowData.FOUND_STAT = "Y";
                      inp.classList.remove("sku-error");
                      saveData();
                      rebuildTable();
                    } else {
                      rowData.FOUND_STAT = "F";
                      inp.classList.add("sku-error");
                    }
                  });
              });
              td.appendChild(inp);
            } else if (col.key === "EXT_QTY") {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.min = "0";
              inp.step = "any";
              inp.required = true;
              inp.value = rowData.EXT_QTY || 0;
              inp.addEventListener("input", () => {
                rowData.EXT_QTY = parseFloat(inp.value) || 0;
                updateExtended(rowIdx);
                saveData();

                rowData.UNITS = rowData.EXT_QTY;
                rowData.QUANTITY2 = 1;
              });
              td.appendChild(inp);
            } else if (col.key === "PRICE" && priceEditable) {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.min = "0";
              inp.step = "0.01";
              inp.required = true;
              inp.value = parseFloat(rowData.PRICE || 0).toFixed(2);
              inp.addEventListener("input", () => {
                rowData.PRICE = parseFloat(inp.value) || 0;
                updateExtended(rowIdx);
                saveData();
              });
              td.appendChild(inp);
            } else if (col.key === "CAT_NUM" && catEditable) {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.required = true;
              inp.value = rowData.CAT_NUM || "";
              inp.addEventListener("change", () => {
                rowData.CAT_NUM = inp.value;
                saveData();
              });
              td.appendChild(inp);
            } else if (col.key === "EXT_PRICE") {
              const extVal = rowData.EXT_QTY * rowData.PRICE || 0;
              td.textContent = currencyFormatter.format(extVal);
              grandTotal += extVal;
            } else if (col.key === "DESCRIPTIO") {
              const span = document.createElement("span");
              span.textContent = rowData[col.key] ?? "";
              span.classList.add("description-cell");

              span.addEventListener("click", () => {
                span.classList.toggle("expanded");
              });

              td.appendChild(span);
            } else {
              td.textContent = rowData[col.key] ?? "";
            }

            tr.appendChild(td);
          });

          const tdDel = document.createElement("td");
          tdDel.classList.add("delete-col");
          const delBtn = document.createElement("button");
          delBtn.innerHTML = "X";
          delBtn.classList.add("delete-btn");
          if (rowData.deleted) delBtn.classList.add("deleted");
          saveData();
          delBtn.addEventListener("click", () => {
            // If this row was just added (isNew), remove it from `data` entirely:
            if (rowData.isNew) {
              // Find the index of this record in the `data` array and remove it
              const idx = data.indexOf(rowData);
              if (idx !== -1) {
                data.splice(idx, 1);
                rebuildTable();
                saveData();
              }
            } else {
              // Otherwise, toggle the "deleted" flag and CSS class as before
              rowData.deleted = !rowData.deleted;
              if (rowData.deleted) {
                tr.classList.add("deleted");
                delBtn.classList.add("deleted");
                saveData();
              } else {
                tr.classList.remove("deleted");
                delBtn.classList.remove("deleted");
                saveData();
              }
            }
          });
          tdDel.appendChild(delBtn);
          tr.appendChild(tdDel);

          tbody.appendChild(tr);
        });

        if (visibleCols.some((c) => c.key === "EXT_PRICE")) {
          const trTotal = document.createElement("tr");
          trTotal.classList.add("record-total-row");
          const tdLabel = document.createElement("td");
          tdLabel.textContent = "Grand Total";
          tdLabel.colSpan = visibleCols.length;
          trTotal.appendChild(tdLabel);
          totalCell = document.createElement("td");
          totalCell.textContent = currencyFormatter.format(grandTotal);
          trTotal.appendChild(totalCell);
          tbody.appendChild(trTotal);
        }

        table.appendChild(tbody);
        recContainer.appendChild(table);
        makeTableSortable(table);
      }

      function updateExtended(rowIdx) {
        const rd = data[rowIdx];
        const newExt = rd.EXT_QTY * rd.PRICE || 0;
        rd.EXT_PRICE = newExt;
        const colIndex = visibleCols.findIndex((c) => c.key === "EXT_PRICE");
        const cell = tbody.querySelectorAll("tr")[rowIdx].children[colIndex];
        cell.textContent = currencyFormatter.format(newExt);
        let sum = 0;
        data.forEach((d) => (sum += d.EXT_QTY * d.PRICE || 0));
        if (totalCell) totalCell.textContent = currencyFormatter.format(sum);
      }

      rebuildTable();
    }

    fetchJsonWithMemCache(`/api/records?location=${encodeURIComponent(locString)}`)
      .then(({ data }) => data)
      .then((data) => {
        indexRecordsByLocation(data);
        renderLocationRecords(data);
      })
      .catch(() => {
        const cached = getCachedRecordsForLocation(locString);
        if (cached) {
          renderLocationRecords(cached);
          return;
        }
        recContainer.innerHTML = prevHtml;
        container.classList.remove("collapsed");
      });
  }

  // kick things off
  setView("employee");

  // Jump-to-Top button setup
  const jumpBtn = document.getElementById("jump-to-top");

  // Scroll the record container to top when clicked
  jumpBtn.addEventListener("click", () => {
    recContainer.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Show/hide based on record-container scroll position
  function toggleJumpBtn() {
    jumpBtn.style.display = recContainer.scrollTop > 100 ? "block" : "none";
  }
  recContainer.addEventListener("scroll", toggleJumpBtn);
  toggleJumpBtn();
});
