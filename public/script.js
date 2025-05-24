// script.js
document.addEventListener("DOMContentLoaded", () => {
  const btnEmp = document.getElementById("btn-employee");
  const btnLoc = document.getElementById("btn-location");
  const listEl = document.getElementById("item-list");
  const recContainer = document.getElementById("record-container");

  let currentView = "employee";

  const ALL_COLUMNS = [
    { key: "RECORD", label: "Record" },
    { key: "SKU", label: "SKU" },
    { key: "DESCRIPTIO", label: "Description" }, // or 'DESCRIPTION' if that's the real key
    { key: "cat_desc", label: "Category" },
    { key: "EXT_QTY", label: "Qty" },
    { key: "PRICE", label: "Price" },
    { key: "EXT_PRICE", label: "Total Price" },
  ];

  btnEmp.addEventListener("click", () => setView("employee"));
  btnLoc.addEventListener("click", () => setView("location"));

  function setView(view) {
    currentView = view;
    btnEmp.classList.toggle("active", view === "employee");
    btnLoc.classList.toggle("active", view === "location");
    recContainer.innerHTML =
      '<p class="placeholder">Select an item to view details</p>';
    loadSidebarItems();
  }

  function loadSidebarItems() {
    listEl.innerHTML = "<li>Loading…</li>";
    const endpoint = currentView === "employee" ? "employees" : "locations";
    fetch(`/api/${endpoint}`)
      .then((r) => r.json())
      .then((items) => {
        listEl.innerHTML = "";
        items.forEach((item) => {
          const li = document.createElement("li");
          const btn = document.createElement("button");
          btn.textContent = item;
          btn.addEventListener("click", () => {
            // highlight
            listEl
              .querySelectorAll("button")
              .forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            if (currentView === "employee") {
              loadEmployeeLocations(item);
            } else {
              showLocationTable(item);
            }
          });
          li.appendChild(btn);
          listEl.appendChild(li);
        });
      })
      .catch(() => {
        listEl.innerHTML = "<li>Error loading items</li>";
      });
  }

  function loadEmployeeLocations(employee) {
    recContainer.innerHTML = '<p class="placeholder">Loading locations…</p>';
    fetch(`/api/records?employee=${encodeURIComponent(employee)}`)
      .then((r) => r.json())
      .then((data) => {
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
        recContainer.innerHTML =
          '<p class="placeholder">Error loading locations</p>';
      });
  }

  function showLocationTable(locString) {
    // 1) Show loading state
    recContainer.innerHTML = '<p class="placeholder">Loading records…</p>';

    // 2) Fetch records for this location
    fetch(`/api/records?location=${encodeURIComponent(locString)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.length) {
          recContainer.innerHTML =
            '<p class="placeholder">No records found</p>';
          return;
        }

        // 3) Determine which columns actually have data
        const visibleCols = ALL_COLUMNS.filter((col) =>
          data.some((row) => {
            const v = row[col.key];
            return v !== null && v !== undefined && String(v).trim() !== "";
          })
        );

        // 4) Decide editability rules
        const skuVisible = visibleCols.some((c) => c.key === "SKU");
        const priceEditable =
          !skuVisible && visibleCols.some((c) => c.key === "PRICE");

        // 5) Grab the source JSON filename for “complete” API
        const fileName = data[0].file;

        // 6) Clear container & add “Mark Complete” button
        recContainer.innerHTML = "";
        const completeBtn = document.createElement("button");
        completeBtn.textContent = "Mark Location Complete";
        completeBtn.classList.add("complete-btn");
        completeBtn.addEventListener("click", () => {
          if (!confirm("Are you sure you want to mark this location complete?"))
            return;

          // LOG the payload
          console.log("▶ Sending complete payload:", { records: data });

          fetch(`/api/reports/${encodeURIComponent(fileName)}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ records: data }),
          })
            .then((r) => r.json())
            .then((resp) => {
              /* … */
            })
            .catch(() => alert("Network error"));
        });
        recContainer.appendChild(completeBtn);

        // 7) Header with Area & Location
        const header = document.createElement("div");
        header.classList.add("record-header");
        header.textContent = `Area: ${data[0].area_desc} | Location: ${data[0].loc_desc}`;
        recContainer.appendChild(header);

        // 8) Build the table
        const table = document.createElement("table");
        table.classList.add("record-table");

        // 8a) THEAD
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        visibleCols.forEach((col) => {
          const th = document.createElement("th");
          th.textContent = col.label;
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        // 8b) TBODY
        const tbody = document.createElement("tbody");
        let grandTotal = 0;
        let totalCell = null;

        data.forEach((rowData, rowIdx) => {
          const tr = document.createElement("tr");

          visibleCols.forEach((col) => {
            const td = document.createElement("td");

            // Editable SKU
            if (col.key === "SKU") {
              const inp = document.createElement("input");
              inp.type = "text";
              inp.value = rowData.SKU || "";
              inp.addEventListener("change", () => {
                rowData.SKU = inp.value;
              });
              td.appendChild(inp);

              // Editable Qty
            } else if (col.key === "EXT_QTY") {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.min = "0";
              inp.step = "1";
              inp.value = rowData.EXT_QTY || 0;
              inp.addEventListener("input", () => {
                rowData.EXT_QTY = parseInt(inp.value) || 0;
                updateExtended(rowIdx);
              });
              td.appendChild(inp);

              // Editable Price only if SKU is hidden
            } else if (col.key === "PRICE" && priceEditable) {
              const inp = document.createElement("input");
              inp.type = "number";
              inp.min = "0";
              inp.step = "0.01";
              inp.value = parseFloat(rowData.PRICE || 0).toFixed(2);
              inp.addEventListener("input", () => {
                rowData.PRICE = parseFloat(inp.value) || 0;
                updateExtended(rowIdx);
              });
              td.appendChild(inp);

              // Computed Extended
            } else if (col.key === "EXT_PRICE") {
              const extVal = rowData.EXT_QTY * rowData.PRICE || 0;
              td.textContent = extVal.toFixed(2);
              grandTotal += extVal;

              // Static cells
            } else {
              td.textContent = rowData[col.key] ?? "";
            }

            tr.appendChild(td);
          });

          tbody.appendChild(tr);
        });

        // 8c) Grand Total row (if EXT_PRICE shown)
        if (visibleCols.some((c) => c.key === "EXT_PRICE")) {
          const trTotal = document.createElement("tr");
          trTotal.classList.add("record-total-row");

          const tdLabel = document.createElement("td");
          tdLabel.textContent = "Grand Total";
          tdLabel.colSpan = visibleCols.length - 1;
          trTotal.appendChild(tdLabel);

          totalCell = document.createElement("td");
          totalCell.textContent = grandTotal.toFixed(2);
          trTotal.appendChild(totalCell);

          tbody.appendChild(trTotal);
        }

        table.appendChild(tbody);
        recContainer.appendChild(table);

        // 9) Helper to update one row’s Extended and the Grand Total
        function updateExtended(rowIdx) {
          // Recompute this row’s extended value
          const rd = data[rowIdx];
          const newExt = rd.EXT_QTY * rd.PRICE || 0;
          const extColIndex = visibleCols.findIndex(
            (c) => c.key === "EXT_PRICE"
          );
          const extCell =
            tbody.querySelectorAll("tr")[rowIdx].children[extColIndex];
          extCell.textContent = newExt.toFixed(2);

          // Recompute grand total
          let sum = 0;
          data.forEach((d) => (sum += d.EXT_QTY * d.PRICE || 0));
          if (totalCell) totalCell.textContent = sum.toFixed(2);
        }
      })
      .catch(() => {
        recContainer.innerHTML =
          '<p class="placeholder">Error loading records</p>';
      });
  }

  // kick things off
  setView("employee");
});
