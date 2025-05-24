// script.js
document.addEventListener("DOMContentLoaded", () => {
  const btnEmp = document.getElementById("btn-employee");
  const btnLoc = document.getElementById("btn-location");
  const listEl = document.getElementById("item-list");
  const recContainer = document.getElementById("record-container");

  let currentView = "employee";
  const btnSKU = document.getElementById("btn-sku");
  const skuInput = document.getElementById("sku-input");

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

  btnSKU.addEventListener("click", () => {
    currentView = "sku";
    // clear active states on the other buttons
    [btnEmp, btnLoc].forEach((b) => b.classList.remove("active"));
    btnSKU.classList.add("active");
    recContainer.innerHTML =
      '<p class="placeholder">Enter a SKU and click Search</p>';
  });

  function searchBySKU() {
    const sku = skuInput.value.trim();
    if (!sku) return alert("Please enter a SKU.");
    skuInput.value = "";
    recContainer.innerHTML = '<p class="placeholder">Searching for SKU…</p>';

    fetch(`/api/records?sku=${encodeURIComponent(sku)}`)
      .then((r) => r.json())
      .then((data) => {
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
        recContainer.innerHTML =
          '<p class="placeholder">Error searching for SKU</p>';
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
      tdLabel.colSpan = visibleCols.length;
      trTot.appendChild(tdLabel);

      const tdTotal = document.createElement("td");
      tdTotal.textContent = currencyFormatter.format(grandTotal);
      trTot.appendChild(tdTotal);
      tbody.appendChild(trTot);
    }

    table.appendChild(tbody);
    return table;
  }

  // hook up the SKU search button
  btnSKU.addEventListener("click", searchBySKU);

  // Toggle on click
  sidebarToggle.addEventListener("click", () => {
    containerEl.classList.toggle("collapsed");
    const isCollapsed = containerEl.classList.contains("collapsed");
    localStorage.setItem("sidebarCollapsed", isCollapsed);
  });

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
            if (currentView === "sku") {
              setView("location");
            }
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
    recContainer.innerHTML = '<p class="placeholder">Loading records…</p>';

    fetch(`/api/records?location=${encodeURIComponent(locString)}`)
      .then((r) => r.json())
      .then((data) => {
        data.forEach((r) => {
          r.deleted = false;
          r.isNew = false;
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
        const descVisible = visibleCols.some((c) => c.key === "DESCRIPTIO");
        const catEditable =
          !skuVisible &&
          !descVisible &&
          visibleCols.some((c) => c.key === "CAT_NUM");
        const priceEditable =
          !skuVisible && visibleCols.some((c) => c.key === "PRICE");

        const fileName = data[0].file;
        recContainer.innerHTML = "";

        const btnGroup = document.createElement("div");
        btnGroup.classList.add("record-header");

        // Add New Record at top
        const addBtn = document.createElement("button");
        addBtn.textContent = "Add Record";
        addBtn.classList.add("complete-btn");
        addBtn.style.marginRight = "1rem";
        addBtn.addEventListener("click", () => {
          const newRec = {};
          ALL_COLUMNS.forEach((c) => (newRec[c.key] = ""));
          newRec.EXT_QTY = 0;
          newRec.PRICE = 0;
          newRec.deleted = false;
          newRec.isNew = true;
          data.unshift(newRec); // insert at top
          rebuildTable();
          recContainer
            .querySelector("table")
            .scrollIntoView({ behavior: "smooth" });
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
            if (inp.value.trim() === "") {
              alert("All fields must be filled.");
              inp.focus();
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
          console.log("▶ Sending complete payload:", payload);
          fetch(`/api/reports/${encodeURIComponent(fileName)}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
            .then((r) => r.json())
            .then((resp) => {
              if (resp.success) {
                alert("Location marked complete.");
                setView(currentView);
              } else {
                alert("Error: " + (resp.error || "Unknown"));
              }
            })
            .catch(() => alert("Network error"));
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
          thDel.textContent = "🗑";
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
                inp.required = true;
                inp.value = rowData.SKU || "";
                inp.style.whiteSpace = "nowrap";
                inp.addEventListener("change", () => {
                  rowData.SKU = inp.value;
                });
                td.appendChild(inp);
              } else if (col.key === "EXT_QTY") {
                const inp = document.createElement("input");
                inp.type = "number";
                inp.min = "0";
                inp.step = "1";
                inp.required = true;
                inp.value = rowData.EXT_QTY || 0;
                inp.addEventListener("input", () => {
                  rowData.EXT_QTY = parseInt(inp.value) || 0;
                  updateExtended(rowIdx);
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
                });
                td.appendChild(inp);
              } else if (col.key === "CAT_NUM" && catEditable) {
                const inp = document.createElement("input");
                inp.type = "number";
                inp.required = true;
                inp.value = rowData.CAT_NUM || "";
                inp.addEventListener("change", () => {
                  rowData.CAT_NUM = inp.value;
                });
                td.appendChild(inp);
              } else if (col.key === "EXT_PRICE") {
                const extVal = rowData.EXT_QTY * rowData.PRICE || 0;
                td.textContent = currencyFormatter.format(extVal);
                grandTotal += extVal;
              } else {
                td.textContent = rowData[col.key] ?? "";
              }

              tr.appendChild(td);
            });

            const tdDel = document.createElement("td");
            tdDel.classList.add("delete-col");
            const delBtn = document.createElement("button");
            delBtn.innerHTML = "×";
            delBtn.classList.add("delete-btn");
            if (rowData.deleted) delBtn.classList.add("deleted");
            delBtn.addEventListener("click", () => {
              rowData.deleted = !rowData.deleted;
              if (rowData.deleted) {
                tr.classList.add("deleted");
                delBtn.classList.add("deleted");
              } else {
                tr.classList.remove("deleted");
                delBtn.classList.remove("deleted");
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
        }

        function updateExtended(rowIdx) {
          const rd = data[rowIdx];
          const newExt = rd.EXT_QTY * rd.PRICE || 0;
          const colIndex = visibleCols.findIndex((c) => c.key === "EXT_PRICE");
          const cell = tbody.querySelectorAll("tr")[rowIdx].children[colIndex];
          cell.textContent = currencyFormatter.format(newExt);
          let sum = 0;
          data.forEach((d) => (sum += d.EXT_QTY * d.PRICE || 0));
          if (totalCell) totalCell.textContent = currencyFormatter.format(sum);
        }

        rebuildTable();
      })
      .catch(() => {
        recContainer.innerHTML =
          '<p class="placeholder">Error loading records</p>';
      });
  }

  // kick things off
  setView("employee");
});
