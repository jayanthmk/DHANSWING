"use strict";

const el = (id) => document.getElementById(id);
let combinedFile = null;
let positionsFile = null;
let pricesFile = null;

const aliases = {
  symbol: ["symbol", "tradingsymbol", "stock", "scrip", "ticker"],
  quantity: ["quantity", "qty", "totalqty", "netqty", "shares"],
  avgCost: ["avgcost", "averagecost", "avgcostprice", "averageprice", "buyaverage"],
  managed: ["managed", "strategymanaged", "strategyowned", "instrategy"],
  lastAverageDate: ["lastaveragedate", "lastadddate", "lastaverage", "lastbuydate"],
  date: ["date", "tradedate", "timestamp", "datetime"],
  open: ["open", "openprice"],
  high: ["high", "highprice"],
  low: ["low", "lowprice"],
  close: ["close", "closeprice", "closingprice"],
  volume: ["volume", "vol"]
};

function normalizedKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function field(row, key) {
  const keys = aliases[key] || [key];
  const map = new Map(Object.entries(row || {}).map(([k, v]) => [normalizedKey(k), v]));
  for (const candidate of keys) {
    if (map.has(candidate)) return map.get(candidate);
  }
  return "";
}

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const cleaned = String(value ?? "").replace(/[₹,\s]/g, "");
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : NaN;
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 20000 && value < 90000) {
    const milliseconds = Math.round((value - 25569) * 86400 * 1000);
    return new Date(milliseconds).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return iso[1] + "-" + iso[2].padStart(2, "0") + "-" + iso[3].padStart(2, "0");
  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return dmy[3] + "-" + dmy[2].padStart(2, "0") + "-" + dmy[1].padStart(2, "0");
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function rowsFromSheet(workbook, preferred) {
  const name = workbook.SheetNames.find((x) => normalizedKey(x) === normalizedKey(preferred)) || workbook.SheetNames[0];
  if (!name) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "", raw: false });
}

async function readWorkbook(file) {
  if (!window.XLSX) throw new Error("Excel reader did not load. Refresh the page while online, or use CSV files.");
  const bytes = await file.arrayBuffer();
  return XLSX.read(bytes, { type: "array", cellDates: true });
}

function parsePositions(rows) {
  return rows.map((row, index) => {
    const symbol = String(field(row, "symbol")).trim().toUpperCase();
    const quantity = numeric(field(row, "quantity"));
    const average = numeric(field(row, "avgCost"));
    const managedValue = normalizedKey(field(row, "managed"));
    const managed = ["yes", "y", "true", "1", "managed"].includes(managedValue);
    const lastAverageDate = parseDate(field(row, "lastAverageDate"));
    if (!symbol && !Number.isFinite(quantity)) return null;
    if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Positions row " + (index + 2) + " needs a Symbol and a positive Quantity.");
    }
    return { symbol, quantity, average: Number.isFinite(average) ? average : 0, managed, lastAverageDate };
  }).filter(Boolean);
}

function parsePrices(rows) {
  const out = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const symbol = String(field(row, "symbol")).trim().toUpperCase();
    const day = parseDate(field(row, "date"));
    const open = numeric(field(row, "open"));
    const high = numeric(field(row, "high"));
    const low = numeric(field(row, "low"));
    const close = numeric(field(row, "close"));
    if (!symbol && !day) continue;
    if (!symbol || !day || ![high, low, close].every(Number.isFinite)) {
      throw new Error("Prices row " + (index + 2) + " needs Symbol, Date, High, Low and Close.");
    }
    out.push({ symbol, date: day, open: Number.isFinite(open) ? open : close, high, low, close });
  }
  return out;
}

function groupedBars(rows) {
  const grouped = new Map();
  for (const bar of rows) {
    if (!grouped.has(bar.symbol)) grouped.set(bar.symbol, new Map());
    grouped.get(bar.symbol).set(bar.date, bar);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const timeParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":");
  const beforeClose = Number(timeParts[0]) * 60 + Number(timeParts[1]) < (15 * 60 + 35);
  const result = new Map();
  for (const [symbol, byDate] of grouped) {
    let bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (beforeClose && bars.length && bars[bars.length - 1].date === today) bars = bars.slice(0, -1);
    result.set(symbol, bars);
  }
  return result;
}

function supertrend(bars, period = 10, multiplier = 3) {
  if (bars.length < period + 2) return null;
  const tr = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i += 1) {
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  const atr = [tr.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < tr.length; i += 1) atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
  const upper = [], lower = [], green = [], value = [];
  for (let j = 0; j < atr.length; j += 1) {
    const i = j + period - 1;
    const middle = (bars[i].high + bars[i].low) / 2;
    const basicUpper = middle + multiplier * atr[j];
    const basicLower = middle - multiplier * atr[j];
    let finalUpper, finalLower, isGreen;
    if (j === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      isGreen = bars[i].close >= middle;
    } else {
      finalUpper = basicUpper < upper[j - 1] || bars[i - 1].close > upper[j - 1] ? basicUpper : upper[j - 1];
      finalLower = basicLower > lower[j - 1] || bars[i - 1].close < lower[j - 1] ? basicLower : lower[j - 1];
      isGreen = green[j - 1] ? bars[i].close >= finalLower : bars[i].close > upper[j - 1];
    }
    upper.push(finalUpper);
    lower.push(finalLower);
    green.push(isGreen);
    value.push(isGreen ? finalLower : finalUpper);
  }
  return { green: green.at(-1), flippedGreen: !green.at(-2) && green.at(-1), flippedRed: green.at(-2) && !green.at(-1), value: value.at(-1), close: bars.at(-1).close, date: bars.at(-1).date };
}

function combinePositions(rows) {
  const map = new Map();
  for (const position of rows.filter((x) => x.managed)) {
    const old = map.get(position.symbol);
    if (!old) {
      map.set(position.symbol, { ...position });
    } else {
      const total = old.quantity + position.quantity;
      old.average = total ? ((old.average * old.quantity) + (position.average * position.quantity)) / total : 0;
      old.quantity = total;
      if (position.lastAverageDate && (!old.lastAverageDate || position.lastAverageDate > old.lastAverageDate)) old.lastAverageDate = position.lastAverageDate;
    }
  }
  return map;
}

function money(value) {
  return "₹" + Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function td(tr, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : String(value);
  if (className) cell.className = className;
  tr.appendChild(cell);
  return cell;
}
function addTable(container, headers, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((x) => td(headerRow, x));
  head.appendChild(headerRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  rows.forEach((x) => body.appendChild(x));
  table.appendChild(body);
  wrap.appendChild(table);
  container.appendChild(wrap);
}
function sectionTitle(container, title) {
  const node = document.createElement("div");
  node.className = "section-title";
  node.textContent = title;
  container.appendChild(node);
}

function renderTableData(positions, barMap) {
  const managed = combinePositions(positions);
  const openCount = managed.size;
  const maximum = Math.max(1, Number(el("maxPositions").value) || 200);
  let slots = Math.max(0, maximum - openCount);
  const alreadyHeld = new Set(positions.filter((x) => x.quantity > 0).map((x) => x.symbol));
  const actions = [];
  const entries = [];
  const warnings = [];
  const symbols = new Set([...barMap.keys(), ...managed.keys()]);

  for (const symbol of symbols) {
    const bars = barMap.get(symbol) || [];
    const position = managed.get(symbol);
    const st = supertrend(bars);
    if (!bars.length) {
      if (position) warnings.push(symbol + ": no matching price history");
      continue;
    }
    if (bars.length < 253 && !position) {
      warnings.push(symbol + ": " + bars.length + " daily candles; need 253 for a 52-week breakout check");
    }
    if (position) {
      if (!st) {
        warnings.push(symbol + ": not enough candles to calculate Supertrend");
        continue;
      }
      let action = "HOLD", reason = "Supertrend is green; the −6% average trigger is not met.";
      let addQty = 0, addValue = 0;
      const lossPct = position.average > 0 ? (st.close / position.average - 1) * 100 : 0;
      if (!st.green) {
        action = "EXIT FULL";
        reason = "Supertrend is red. Exit the entire managed position regardless of profit or loss.";
      } else if (position.average > 0 && st.close <= position.average * 0.94) {
        const elapsed = position.lastAverageDate ? Math.floor((Date.parse(st.date) - Date.parse(position.lastAverageDate)) / 86400000) : 7;
        if (elapsed >= 7) {
          action = "AVERAGE";
          addQty = Math.max(1, Math.ceil(position.quantity / 10));
          addValue = addQty * st.close;
          reason = "Down " + Math.abs(lossPct).toFixed(1) + "% from average; add " + addQty + " share(s), about one tenth, once this week.";
        } else {
          action = "WAIT";
          reason = "Average trigger met; wait " + Math.max(0, 7 - elapsed) + " more day(s) after the last add.";
        }
      }
      actions.push({ symbol, action, reason, close: st.close, indicator: st.green ? "GREEN" : "RED", avg: position.average, quantity: position.quantity, addQty, addValue, date: st.date });
    } else if (bars.length >= 253 && !alreadyHeld.has(symbol)) {
      const previousHigh = Math.max(...bars.slice(-253, -1).map((x) => x.high));
      const last = bars.at(-1);
      if (last.close > previousHigh) {
        const shares = Math.floor(1000 / last.close);
        const breakoutPct = (last.close / previousHigh - 1) * 100;
        entries.push({ symbol, close: last.close, previousHigh, breakoutPct, shares, date: last.date });
      }
    }
  }

  entries.sort((a, b) => b.breakoutPct - a.breakoutPct || a.symbol.localeCompare(b.symbol));
  const accepted = new Set(entries.filter((x) => x.shares > 0).slice(0, slots).map((x) => x.symbol));
  const result = el("results");
  result.replaceChildren();

  const kpis = document.createElement("div");
  kpis.className = "kpis";
  const values = [
    [openCount, "managed open positions"],
    [maximum, "maximum positions"],
    [Math.max(0, maximum - openCount), "slots available"],
    [barMap.size, "symbols in price file"]
  ];
  values.forEach(([value, label]) => {
    const box = document.createElement("div");
    box.className = "kpi";
    const b = document.createElement("b");
    b.textContent = String(value);
    const s = document.createElement("span");
    s.textContent = label;
    box.append(b, s);
    kpis.appendChild(box);
  });
  result.appendChild(kpis);

  sectionTitle(result, "Managed positions");
  if (actions.length) {
    const rows = actions.map((x) => {
      const row = document.createElement("tr");
      td(row, x.symbol);
      td(row, x.quantity);
      td(row, money(x.avg));
      td(row, money(x.close));
      td(row, x.indicator, x.indicator === "GREEN" ? "green" : "red");
      td(row, x.action, x.action === "EXIT FULL" ? "red" : x.action === "AVERAGE" ? "green" : "");
      td(row, x.action === "AVERAGE" ? x.addQty + " share(s) · about " + money(x.addValue) : x.reason);
      td(row, x.date);
      return row;
    });
    addTable(result, ["Symbol", "Qty", "Avg cost", "Latest close", "Supertrend", "Action", "Reason / suggested add", "Bar date"], rows);
  } else {
    const empty = document.createElement("p");
    empty.textContent = "No managed positions in the uploaded file. Set Managed to Yes for positions this strategy controls.";
    result.appendChild(empty);
  }

  sectionTitle(result, "New 52-week high candidates");
  if (entries.length) {
    const rows = entries.map((x) => {
      const row = document.createElement("tr");
      const allowed = accepted.has(x.symbol);
      const action = x.shares === 0 ? "SKIP: share over ₹1,000" : allowed ? "ENTRY SIGNAL" : "MAX POSITIONS";
      td(row, x.symbol);
      td(row, money(x.close));
      td(row, money(x.previousHigh));
      td(row, "+" + x.breakoutPct.toFixed(2) + "%");
      td(row, x.shares ? x.shares + " share(s) · about " + money(x.shares * x.close) : "0");
      td(row, action, action === "ENTRY SIGNAL" ? "green" : "amber");
      td(row, x.date);
      return row;
    });
    addTable(result, ["Symbol", "Close", "Prior 52w high", "Breakout", "₹1,000 size", "Recommendation", "Bar date"], rows);
  } else {
    const empty = document.createElement("p");
    empty.textContent = "No new 52-week closing highs found in the uploaded price history.";
    result.appendChild(empty);
  }

  if (warnings.length) {
    const box = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = warnings.length + " data notes";
    const pre = document.createElement("pre");
    pre.className = "errors";
    pre.textContent = warnings.join("\n");
    box.append(summary, pre);
    result.appendChild(box);
  }
  el("summary").textContent = "Price bars through " + ([...barMap.values()].flat().map((x) => x.date).sort().at(-1) || "—") + ". Data is processed locally.";
}

function showStatus(message, kind = "") {
  const node = el("fileStatus");
  node.textContent = message;
  node.className = "status " + kind;
}

async function readSelectedData() {
  if (!window.XLSX) throw new Error("Excel/CSV reader is unavailable. Refresh while connected to the internet.");
  let rawPositions = [];
  let rawPrices = [];
  if (combinedFile) {
    const wb = await readWorkbook(combinedFile);
    const posSheet = wb.SheetNames.find((x) => normalizedKey(x) === "positions");
    const priceSheet = wb.SheetNames.find((x) => normalizedKey(x) === "prices");
    if (!posSheet || !priceSheet) throw new Error("Combined workbook needs sheets named Positions and Prices.");
    rawPositions = rowsFromSheet(wb, "Positions");
    rawPrices = rowsFromSheet(wb, "Prices");
  }
  if (positionsFile) rawPositions = rowsFromSheet(await readWorkbook(positionsFile), "Positions");
  if (pricesFile) rawPrices = rowsFromSheet(await readWorkbook(pricesFile), "Prices");
  if (!rawPrices.length) throw new Error("Upload daily price history. A Positions file alone is not enough to calculate signals.");
  const parsedPositions = parsePositions(rawPositions);
  const parsedPrices = parsePrices(rawPrices);
  if (!parsedPrices.length) throw new Error("No valid price rows found.");
  return { positions: parsedPositions, bars: groupedBars(parsedPrices) };
}

el("combinedFile").addEventListener("change", (event) => { combinedFile = event.target.files[0] || null; });
el("positionsFile").addEventListener("change", (event) => { positionsFile = event.target.files[0] || null; });
el("pricesFile").addEventListener("change", (event) => { pricesFile = event.target.files[0] || null; });

el("analyzeBtn").addEventListener("click", async () => {
  showStatus("Reading the selected files in this browser…");
  try {
    const data = await readSelectedData();
    renderTableData(data.positions, data.bars);
    showStatus("Loaded " + data.positions.length + " position row(s) and " + [...data.bars.values()].reduce((n, x) => n + x.length, 0) + " daily price row(s). Nothing was uploaded.", "ok");
  } catch (error) {
    showStatus(error.message, "bad");
  }
});

el("clearBtn").addEventListener("click", () => {
  combinedFile = positionsFile = pricesFile = null;
  ["combinedFile", "positionsFile", "pricesFile"].forEach((id) => { el(id).value = ""; });
  el("results").innerHTML = '<div class="empty">Your recommendations will appear here.</div>';
  el("summary").textContent = "Upload data, then analyze.";
  showStatus("Files cleared from this page.");
});

el("templateBtn").addEventListener("click", () => {
  if (!window.XLSX) return showStatus("Excel template generator is unavailable. Refresh while connected to the internet.", "bad");
  const wb = XLSX.utils.book_new();
  const pos = XLSX.utils.aoa_to_sheet([
    ["Symbol", "Quantity", "AvgCost", "Managed", "LastAverageDate"],
    ["EXAMPLE", 10, 950, "Yes", ""]
  ]);
  const prices = XLSX.utils.aoa_to_sheet([
    ["Symbol", "Date", "Open", "High", "Low", "Close", "Volume"],
    ["EXAMPLE", "2025-01-01", 950, 960, 940, 955, 100000]
  ]);
  XLSX.utils.book_append_sheet(wb, pos, "Positions");
  XLSX.utils.book_append_sheet(wb, prices, "Prices");
  XLSX.writeFile(wb, "DHANSWING-upload-template.xlsx");
});

