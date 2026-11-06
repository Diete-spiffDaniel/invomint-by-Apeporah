"use strict";

const DB_NAME = "apeporah-workspace";
const DB_VERSION = 1;
const STORES = ["documents", "customers", "products", "settings"];
const CURRENCY_LOCALES = { NGN: "en-NG", USD: "en-US", GBP: "en-GB", EUR: "en-IE" };
const DEFAULT_PROFILE = { currency: "NGN", invoicePrefix: "INV", theme: "system", template: "modern" };
const views = [...document.querySelectorAll(".view")];
const navItems = [...document.querySelectorAll(".nav-item")];
const frames = [...document.querySelectorAll("iframe")];
let database;
let profile = { ...DEFAULT_PROFILE };
let documentCache = [];
let customerCache = [];
let productCache = [];
let installPrompt;
let toastTimeout;

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("documents")) {
        const store = db.createObjectStore("documents", { keyPath: "id" });
        store.createIndex("kind", "kind");
        store.createIndex("number", "number", { unique: true });
      }
      if (!db.objectStoreNames.contains("customers")) db.createObjectStore("customers", { keyPath: "id" });
      if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close other InvoMint tabs to update local storage."));
  });
}

function store(name, mode = "readonly") {
  return database.transaction(name, mode).objectStore(name);
}

async function getAll(name) {
  return requestResult(store(name).getAll());
}

async function put(name, value) {
  return requestResult(store(name, "readwrite").put(value));
}

async function remove(name, key) {
  return requestResult(store(name, "readwrite").delete(key));
}

async function loadSetting(key, fallback) {
  const record = await requestResult(store("settings").get(key));
  return record ? record.value : fallback;
}

async function saveSetting(key, value) {
  await put("settings", { key, value });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatCurrency(minor, code = profile.currency || "NGN") {
  const amount = Number(minor || 0) / 100;
  const currency = Object.hasOwn(CURRENCY_LOCALES, code) ? code : "NGN";
  return new Intl.NumberFormat(CURRENCY_LOCALES[currency], {
    style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function announce(message) {
  const toast = document.querySelector("#app-toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3200);
}

function setView(name) {
  const target = document.querySelector(`#view-${name}`);
  if (!target) return;
  views.forEach((view) => view.classList.toggle("active", view === target));
  navItems.forEach((item) => {
    const active = item.dataset.view === name;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelector("#fab-menu").hidden = true;
  document.querySelector("#create-fab").setAttribute("aria-expanded", "false");
  frames.forEach(resizeFrame);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function resizeFrame(frame) {
  const child = frame.contentDocument;
  if (!child?.documentElement || !frame.closest(".view")?.classList.contains("active")) return;
  const height = Math.max(
    child.documentElement.scrollHeight,
    child.body?.scrollHeight || 0,
    child.documentElement.offsetHeight,
    child.body?.offsetHeight || 0,
    650
  );
  frame.style.height = `${Math.min(height, 100000)}px`;
}

function postWorkspaceData(frame) {
  if (!frame.contentWindow) return;
  frame.contentWindow.postMessage({
    type: "workspace-data",
    profile,
    customers: customerCache,
    products: productCache
  }, window.location.origin);
}

function openEditor(kind, invoice = null, mode = "duplicate") {
  const view = document.querySelector("#view-create");
  const invoiceEditor = document.querySelector("#invoice-editor");
  const receiptEditor = document.querySelector("#receipt-editor");
  const frame = frames.find((item) => item.title.toLowerCase().includes(kind));
  invoiceEditor.classList.toggle("active", kind === "invoice");
  receiptEditor.classList.toggle("active", kind === "receipt");
  document.querySelector("#create-title").textContent = invoice
    ? mode === "edit" ? "Edit invoice" : "Duplicate invoice"
    : `Create ${kind}`;
  setView("create");
  postWorkspaceData(frame);
  if (invoice) {
    const type = mode === "edit" ? "workspace-edit-invoice" : "workspace-fill-invoice";
    const loadInvoice = () => frame.contentWindow.postMessage({ type, invoice }, window.location.origin);
    if (frame.contentDocument?.readyState === "complete") loadInvoice();
    else frame.addEventListener("load", loadInvoice, { once: true });
  }
}

function isOverdue(invoice) {
  return invoice.kind === "invoice" && invoice.status !== "paid" && invoice.dueDate &&
    invoice.dueDate < new Date().toISOString().slice(0, 10);
}

function statusFor(documentRecord) {
  return isOverdue(documentRecord) ? "overdue" : documentRecord.status || "paid";
}

function renderEmpty(container, message) {
  container.innerHTML = `<p class="empty-state">${escapeHTML(message)}</p>`;
}

function renderTransactions(container, records, emptyMessage) {
  if (!records.length) {
    renderEmpty(container, emptyMessage);
    return;
  }
  container.innerHTML = records.map((record) => {
    const status = statusFor(record);
    const name = record.customerName || "Walk-in customer";
    return `<article class="transaction-row">
      <div class="row-main"><strong>${escapeHTML(record.number || "Document")} · ${escapeHTML(name)}</strong><small>${record.kind === "receipt" ? "Receipt" : "Invoice"} · ${escapeHTML(formatDate(record.date))}</small></div>
      <div class="row-side"><span class="row-amount">${escapeHTML(record.totalFormatted || formatCurrency(record.totalMinor))}</span><span class="status-pill status-${status}">${status === "overdue" ? "Overdue" : escapeHTML(status)}</span></div>
    </article>`;
  }).join("");
}

function renderDocumentList(container, kind, query = "", filter = "all") {
  const matching = documentCache.filter((record) => {
    if (record.kind !== kind) return false;
    const status = statusFor(record);
    const matchesStatus = filter === "all" || (filter === "overdue" ? status === "overdue" : status === filter);
    const text = `${record.number} ${record.customerName}`.toLowerCase();
    return matchesStatus && text.includes(query.toLowerCase());
  });
  if (!matching.length) {
    renderEmpty(container, `No ${kind}s yet. Use Create ${kind} to get started.`);
    return;
  }
  container.innerHTML = matching.map((record) => {
    const status = statusFor(record);
    const canMark = kind === "invoice" && record.status !== "paid";
    return `<article class="document-row">
      <div class="row-main"><strong>${escapeHTML(record.number || kind)}</strong><small>${escapeHTML(record.customerName || "Walk-in customer")} · ${escapeHTML(formatDate(record.date))}${kind === "invoice" ? ` · Due ${escapeHTML(formatDate(record.dueDate))}` : ""}</small></div>
      <div class="row-side"><span class="row-amount">${escapeHTML(record.totalFormatted || formatCurrency(record.totalMinor, record.currency))}</span><span class="status-pill status-${status}">${status === "overdue" ? "Overdue" : escapeHTML(status)}</span><div class="row-actions">
        ${canMark ? `<button type="button" data-action="paid" data-id="${escapeHTML(record.id)}">Mark paid</button>` : ""}
        ${kind === "invoice" ? `<button type="button" data-action="edit" data-id="${escapeHTML(record.id)}">Edit</button><button type="button" data-action="duplicate" data-id="${escapeHTML(record.id)}">Duplicate</button>` : ""}
        <button type="button" data-action="share" data-id="${escapeHTML(record.id)}">Share</button>
        <button type="button" data-action="delete" data-id="${escapeHTML(record.id)}">Delete</button>
      </div></div>
    </article>`;
  }).join("");
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function renderChart(period) {
  const chart = document.querySelector("#revenue-chart");
  const now = new Date();
  const months = [];
  for (let offset = period - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push({ key: monthKey(date), label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date), amount: 0 });
  }
  const totals = new Map(months.map((month) => [month.key, month]));
  for (const record of documentCache) {
    if (record.status !== "paid" && record.kind !== "receipt") continue;
    const month = totals.get((record.date || "").slice(0, 7));
    if (month) month.amount += Number(record.totalMinor || 0);
  }
  const maximum = Math.max(...months.map((month) => month.amount), 1);
  chart.setAttribute("aria-label", months.map((month) => `${month.label}: ${formatCurrency(month.amount)}`).join(", "));
  chart.innerHTML = months.map((month) => {
    const height = Math.max(3, Math.round(month.amount / maximum * 100));
    return `<div class="chart-column" title="${escapeHTML(`${month.label}: ${formatCurrency(month.amount)}`)}"><span class="chart-value">${month.amount ? escapeHTML(formatCurrency(month.amount)) : "—"}</span><div class="chart-bar-wrap"><div class="chart-bar" style="height:${height}%"></div></div><span class="chart-month">${escapeHTML(month.label)}</span></div>`;
  }).join("");
}

function renderDashboard() {
  const invoices = documentCache.filter((item) => item.kind === "invoice");
  const paidInvoices = invoices.filter((item) => item.status === "paid");
  const unpaidInvoices = invoices.filter((item) => item.status !== "paid");
  const overdueInvoices = invoices.filter(isOverdue);
  const receipts = documentCache.filter((item) => item.kind === "receipt");
  const paidRevenue = [...paidInvoices, ...receipts].reduce((sum, item) => sum + Number(item.totalMinor || 0), 0);
  document.querySelector("#metric-revenue").textContent = formatCurrency(paidRevenue);
  document.querySelector("#metric-invoices").textContent = invoices.length;
  document.querySelector("#metric-paid").textContent = paidInvoices.length;
  document.querySelector("#metric-unpaid").textContent = unpaidInvoices.length;
  document.querySelector("#metric-overdue").textContent = overdueInvoices.length;
  document.querySelector("#welcome-name").textContent = profile.businessName ? `, ${profile.businessName}` : "";
  const recent = [...documentCache].sort((a, b) => (b.updatedAt || b.date || "").localeCompare(a.updatedAt || a.date || "")).slice(0, 5);
  renderTransactions(document.querySelector("#recent-transactions"), recent, "Your saved invoices and receipts will appear here.");
  renderChart(Number(document.querySelector("#dashboard-period").value));
}

function renderAll() {
  renderDashboard();
  renderDocumentList(document.querySelector("#invoice-list"), "invoice", document.querySelector("#invoice-search").value, document.querySelector("#invoice-filter").value);
  renderDocumentList(document.querySelector("#receipt-list"), "receipt", document.querySelector("#receipt-search").value);
  renderCustomers();
  renderProducts();
}

function openCustomerEditor(customer = null) {
  const form = document.querySelector("#customer-form");
  form.hidden = false;
  document.querySelector("#customer-form-title").textContent = customer ? "Edit customer" : "Add a customer";
  document.querySelector("#customer-id").value = customer?.id || "";
  document.querySelector("#customer-name").value = customer?.name || "";
  document.querySelector("#customer-phone").value = customer?.phone || "";
  document.querySelector("#customer-email").value = customer?.email || "";
  document.querySelector("#customer-address").value = customer?.address || "";
  document.querySelector("#customer-name").focus();
}

function renderCustomers() {
  const query = document.querySelector("#customer-search").value.toLowerCase();
  const target = document.querySelector("#customer-list");
  const customers = customerCache.filter((customer) => `${customer.name} ${customer.email} ${customer.phone}`.toLowerCase().includes(query));
  if (!customers.length) {
    renderEmpty(target, "No customers saved yet. Add a customer to keep their details handy.");
    return;
  }
  target.innerHTML = customers.map((customer) => {
    const name = String(customer.name || "");
    const transactions = documentCache.filter((record) =>
      String(record.customerName || "").toLowerCase() === name.toLowerCase()).length;
    return `<article class="customer-row"><div class="row-main"><strong>${escapeHTML(customer.name)}</strong><small>${escapeHTML([customer.phone, customer.email, customer.address].filter(Boolean).join(" · ") || "No contact details")} · ${transactions} transactions</small></div><div class="row-actions"><button type="button" data-action="customer-history" data-id="${escapeHTML(customer.id)}">History</button><button type="button" data-action="edit-customer" data-id="${escapeHTML(customer.id)}">Edit</button><button type="button" data-action="delete-customer" data-id="${escapeHTML(customer.id)}">Delete</button></div></article>`;
  }).join("");
}

function openProductEditor(product = null) {
  const form = document.querySelector("#product-form");
  form.hidden = false;
  document.querySelector("#product-id").value = product?.id || "";
  document.querySelector("#product-name").value = product?.name || "";
  document.querySelector("#product-category").value = product?.category || "Product";
  document.querySelector("#product-price").value = product?.price ?? "";
  document.querySelector("#product-description").value = product?.description || "";
  document.querySelector("#product-name").focus();
}

function renderProducts() {
  const target = document.querySelector("#product-list");
  if (!productCache.length) {
    renderEmpty(target, "No saved products or services. Add reusable items here.");
    return;
  }
  target.innerHTML = productCache.map((product) => `<article class="product-row"><div class="row-main"><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category || "Product")} · ${escapeHTML(product.description || "No description")}</small></div><div class="row-side"><span class="row-amount">${escapeHTML(formatCurrency(Math.round(Number(product.price || 0) * 100)))}</span><div class="row-actions"><button type="button" data-action="edit-product" data-id="${escapeHTML(product.id)}">Edit</button><button type="button" data-action="delete-product" data-id="${escapeHTML(product.id)}">Delete</button></div></div></article>`).join("");
}

async function refreshData() {
  [documentCache, customerCache, productCache] = await Promise.all([
    getAll("documents"), getAll("customers"), getAll("products")
  ]);
  renderAll();
}

function legacyInvoiceTotal(invoice) {
  const toScaledInteger = (value, scale) => {
    const match = /^(\d{1,15})(?:\.(\d*))?$/.exec(String(value ?? "").trim());
    if (!match) return null;
    const fraction = match[2] || "";
    let result = BigInt(match[1]) * (10n ** BigInt(scale));
    result += BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
    if (Number(fraction[scale] || "0") >= 5) result += 1n;
    return result;
  };
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  let subtotal = 0n;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (!String(line.description || "").trim() && !String(line.unitPrice || "").trim()) continue;
    const price = toScaledInteger(line.unitPrice || "0", 2);
    const quantity = toScaledInteger(line.quantity || "0", 4);
    if (price === null || quantity === null) return null;
    subtotal += (price * quantity + 5_000n) / 10_000n;
  }
  const discount = toScaledInteger(invoice.discount || "0", 2);
  const taxRate = toScaledInteger(invoice.taxRate || "0", 2);
  if (discount === null || taxRate === null) return null;
  const taxable = subtotal - (discount > subtotal ? subtotal : discount);
  const total = taxable + (taxable * taxRate + 5_000n) / 10_000n;
  return total.toString();
}

async function migrateLegacyInvoiceHistory() {
  let stored;
  try {
    stored = localStorage.getItem("apeporah.invoice.history.v1");
  } catch (error) {
    console.error("Could not access earlier invoice history for migration.", error);
    return 0;
  }
  if (!stored) return 0;

  let history;
  try {
    history = JSON.parse(stored);
  } catch (error) {
    console.error("Earlier invoice history could not be read for migration.", error);
    return 0;
  }
  if (!Array.isArray(history)) {
    console.error("Earlier invoice history is not a list and was not migrated.");
    return 0;
  }

  const existingNumbers = new Set((await getAll("documents")).map((record) => record.number));
  let migrated = 0;
  for (const invoice of history) {
    if (!invoice || typeof invoice.invoiceNumber !== "string" ||
        !invoice.invoiceNumber.trim() || existingNumbers.has(invoice.invoiceNumber)) continue;
    const totalMinor = legacyInvoiceTotal(invoice);
    if (totalMinor === null) {
      console.warn(`Earlier invoice ${invoice.invoiceNumber} has invalid totals and was not migrated.`);
      continue;
    }
    const currency = Object.hasOwn(CURRENCY_LOCALES, invoice.currency) ? invoice.currency : "NGN";
    await put("documents", {
      id: crypto.randomUUID(),
      kind: "invoice",
      number: invoice.invoiceNumber,
      customerName: invoice.clientName || "",
      customerEmail: invoice.clientEmail || "",
      customerAddress: invoice.clientAddress || "",
      date: invoice.invoiceDate || "",
      dueDate: invoice.dueDate || "",
      currency,
      totalMinor,
      totalFormatted: formatCurrency(totalMinor, currency),
      status: "unpaid",
      lines: Array.isArray(invoice.lines) ? invoice.lines : [],
      snapshot: invoice,
      createdAt: invoice.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    existingNumbers.add(invoice.invoiceNumber);
    migrated += 1;
  }
  return migrated;
}

function readFormProfile() {
  return {
    ...profile,
    businessName: document.querySelector("#business-name").value.trim(),
    phone: document.querySelector("#business-phone").value.trim(),
    email: document.querySelector("#business-email").value.trim(),
    website: document.querySelector("#business-website").value.trim(),
    address: document.querySelector("#business-address").value.trim(),
    taxId: document.querySelector("#business-tax-id").value.trim(),
    currency: document.querySelector("#business-currency").value,
    signature: document.querySelector("#business-signature").value.trim()
  };
}

function populateProfileForm() {
  document.querySelector("#business-name").value = profile.businessName || "";
  document.querySelector("#business-phone").value = profile.phone || "";
  document.querySelector("#business-email").value = profile.email || "";
  document.querySelector("#business-website").value = profile.website || "";
  document.querySelector("#business-address").value = profile.address || "";
  document.querySelector("#business-tax-id").value = profile.taxId || "";
  document.querySelector("#business-currency").value = profile.currency || "NGN";
  document.querySelector("#business-signature").value = profile.signature || "";
  document.querySelector("#invoice-prefix").value = profile.invoicePrefix || "INV";
  document.querySelector("#theme-setting").value = profile.theme || "system";
  document.querySelector("#template-setting").value = profile.template || "modern";
}

async function initializeTheme() {
  const dark = profile.theme === "dark" ||
    (profile.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("dark", dark);
  document.querySelector("#theme-toggle").textContent = dark ? "☀" : "☾";
  document.querySelector("#theme-toggle").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
}

function safeRecordMessage(event) {
  if (event.origin !== window.location.origin || !frames.some((frame) => frame.contentWindow === event.source)) return null;
  if (event.data?.type !== "workspace-save-document" || !event.data.document) return null;
  return event.data.document;
}

async function handleFrameMessage(event) {
  const payload = safeRecordMessage(event);
  if (payload) {
    try {
      if (!["invoice", "receipt"].includes(payload.kind) || typeof payload.number !== "string" ||
          !payload.number.trim() || typeof payload.totalMinor !== "string" || !/^\d+$/.test(payload.totalMinor)) {
        throw new Error("The document is missing a valid type, number, or total.");
      }
      const existing = documentCache.find((record) => record.number === payload.number);
      if (existing && existing.kind !== payload.kind) {
        throw new Error(`Document number ${payload.number} is already used by a different document type.`);
      }
      const record = {
        ...payload,
        id: existing?.id || payload.id || crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
        status: existing?.status || payload.status || (payload.kind === "receipt" ? "paid" : "unpaid")
      };
      await put("documents", record);
      await refreshData();
      announce(`${payload.kind === "receipt" ? "Receipt" : "Invoice"} ${payload.number} saved on this device.`);
    } catch (error) {
      console.error("Could not save a document from its editor.", error);
      announce(error.message || "Could not save the document on this device.");
    }
  }
}

function shareDocument(record) {
  const message = `${record.kind === "receipt" ? "Receipt" : "Invoice"} ${record.number}\n${record.customerName || "Customer"}\nAmount: ${record.totalFormatted || formatCurrency(record.totalMinor, record.currency)}${record.dueDate ? `\nDue: ${record.dueDate}` : ""}`;
  const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

async function handleDocumentAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const record = documentCache.find((item) => item.id === button.dataset.id);
  if (!record) return;
  if (button.dataset.action === "delete") {
    if (!window.confirm(`Delete ${record.kind} ${record.number}? This cannot be undone.`)) return;
    await remove("documents", record.id);
    await refreshData();
    announce("Document deleted.");
  } else if (button.dataset.action === "paid") {
    await put("documents", { ...record, status: "paid", paidAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await refreshData();
    announce("Invoice marked as paid.");
  } else if (button.dataset.action === "share") {
    shareDocument(record);
  } else if (button.dataset.action === "edit") {
    openEditor("invoice", record, "edit");
  } else if (button.dataset.action === "duplicate") {
    openEditor("invoice", record);
  }
}

function bindNavigation() {
  navItems.forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  document.querySelectorAll("[data-view]").forEach((item) => {
    if (item.classList.contains("nav-item")) return;
    item.addEventListener("click", () => setView(item.dataset.view));
  });
  document.querySelectorAll("[data-create]").forEach((button) => button.addEventListener("click", () => {
    openEditor(button.dataset.create);
    document.querySelector("#fab-menu").hidden = true;
  }));
  document.querySelector("#close-create").addEventListener("click", () => setView("home"));
  document.querySelector("#create-fab").addEventListener("click", () => {
    const menu = document.querySelector("#fab-menu");
    menu.hidden = !menu.hidden;
    document.querySelector("#create-fab").setAttribute("aria-expanded", String(!menu.hidden));
  });
}

function bindLists() {
  document.querySelector("#invoice-search").addEventListener("input", () => renderDocumentList(document.querySelector("#invoice-list"), "invoice", document.querySelector("#invoice-search").value, document.querySelector("#invoice-filter").value));
  document.querySelector("#invoice-filter").addEventListener("change", () => renderDocumentList(document.querySelector("#invoice-list"), "invoice", document.querySelector("#invoice-search").value, document.querySelector("#invoice-filter").value));
  document.querySelector("#receipt-search").addEventListener("input", () => renderDocumentList(document.querySelector("#receipt-list"), "receipt", document.querySelector("#receipt-search").value));
  document.querySelector("#customer-search").addEventListener("input", renderCustomers);
  document.querySelector("#dashboard-period").addEventListener("change", renderDashboard);
  document.querySelector("#invoice-list").addEventListener("click", handleDocumentAction);
  document.querySelector("#receipt-list").addEventListener("click", handleDocumentAction);
  document.querySelector("#recent-transactions").addEventListener("click", handleDocumentAction);
  document.querySelector("#add-customer-button").addEventListener("click", () => openCustomerEditor());
  document.querySelector("#close-customer-form").addEventListener("click", () => { document.querySelector("#customer-form").hidden = true; });
  document.querySelector("#cancel-customer").addEventListener("click", () => { document.querySelector("#customer-form").hidden = true; });
  document.querySelector("#customer-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const customer = customerCache.find((item) => item.id === button.dataset.id);
    if (!customer) return;
    if (button.dataset.action === "customer-history") {
      document.querySelector("#customer-history-title").textContent = `${customer.name} · transaction history`;
      const transactions = documentCache.filter((record) =>
        String(record.customerName || "").toLowerCase() === String(customer.name || "").toLowerCase());
      renderTransactions(document.querySelector("#customer-history-list"), transactions, "No transactions for this customer yet.");
      document.querySelector("#customer-history").hidden = false;
      document.querySelector("#customer-history").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (button.dataset.action === "edit-customer") openCustomerEditor(customer);
    if (button.dataset.action === "delete-customer") {
      if (!window.confirm(`Delete ${customer.name}? Existing transaction history will remain.`)) return;
      await remove("customers", customer.id);
      await refreshData();
    }
  });
  document.querySelector("#close-customer-history").addEventListener("click", () => {
    document.querySelector("#customer-history").hidden = true;
  });
  document.querySelector("#customer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = document.querySelector("#customer-id").value || crypto.randomUUID();
    await put("customers", {
      id,
      name: document.querySelector("#customer-name").value.trim(),
      phone: document.querySelector("#customer-phone").value.trim(),
      email: document.querySelector("#customer-email").value.trim(),
      address: document.querySelector("#customer-address").value.trim(),
      updatedAt: new Date().toISOString()
    });
    form.hidden = true;
    await refreshData();
    frames.forEach(postWorkspaceData);
    announce("Customer saved.");
  });
}

function bindProducts() {
  document.querySelector("#add-product-button").addEventListener("click", () => openProductEditor());
  document.querySelector("#cancel-product").addEventListener("click", () => { document.querySelector("#product-form").hidden = true; });
  document.querySelector("#product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = document.querySelector("#product-id").value || crypto.randomUUID();
    await put("products", {
      id,
      name: document.querySelector("#product-name").value.trim(),
      category: document.querySelector("#product-category").value,
      price: Number(document.querySelector("#product-price").value),
      description: document.querySelector("#product-description").value.trim()
    });
    form.hidden = true;
    await refreshData();
    frames.forEach(postWorkspaceData);
    announce("Product or service saved.");
  });
  document.querySelector("#product-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const product = productCache.find((item) => item.id === button.dataset.id);
    if (!product) return;
    if (button.dataset.action === "edit-product") openProductEditor(product);
    if (button.dataset.action === "delete-product") {
      if (!window.confirm(`Delete ${product.name}?`)) return;
      await remove("products", product.id);
      await refreshData();
      frames.forEach(postWorkspaceData);
    }
  });
}

function bindSettings() {
  document.querySelector("#business-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    profile = readFormProfile();
    profile.invoicePrefix = document.querySelector("#invoice-prefix").value.trim().toUpperCase() || "INV";
    profile.theme = document.querySelector("#theme-setting").value;
    profile.template = document.querySelector("#template-setting").value;
    const logoFile = document.querySelector("#business-logo").files?.[0];
    if (logoFile) {
      if (!logoFile.type.startsWith("image/") || logoFile.size > 1024 * 1024) {
        announce("Choose an image no larger than 1 MB.");
        return;
      }
      try {
        profile.logo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error || new Error("Could not read the logo file."));
          reader.readAsDataURL(logoFile);
        });
      } catch (error) {
        console.error("Could not load the business logo.", error);
        announce(error.message || "Could not load the business logo.");
        return;
      }
    }
    await saveSetting("profile", profile);
    await initializeTheme();
    frames.forEach(postWorkspaceData);
    document.querySelector("#business-feedback").textContent = "Profile saved.";
    document.querySelector("#welcome-name").textContent = profile.businessName ? `, ${profile.businessName}` : "";
  });
  document.querySelector("#theme-setting").addEventListener("change", async (event) => {
    profile.theme = event.target.value;
    await saveSetting("profile", profile);
    await initializeTheme();
  });
  document.querySelector("#template-setting").addEventListener("change", async (event) => {
    profile.template = event.target.value;
    await saveSetting("profile", profile);
  });
  document.querySelector("#invoice-prefix").addEventListener("change", async (event) => {
    profile.invoicePrefix = event.target.value.trim().toUpperCase() || "INV";
    event.target.value = profile.invoicePrefix;
    await saveSetting("profile", profile);
  });
  document.querySelector("#theme-toggle").addEventListener("click", async () => {
    profile.theme = document.body.classList.contains("dark") ? "light" : "dark";
    await saveSetting("profile", profile);
    await initializeTheme();
    document.querySelector("#theme-setting").value = profile.theme;
  });
  document.querySelector("#export-backup").addEventListener("click", exportBackup);
  document.querySelector("#import-backup").addEventListener("change", importBackup);
}

function exportBackup() {
  Promise.all(STORES.map((name) => getAll(name))).then((tables) => {
    const backup = {
      format: "apeporah-workspace-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: Object.fromEntries(STORES.map((name, index) => [name, tables[index]]))
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `invomint-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    document.querySelector("#backup-feedback").textContent = "Backup downloaded. Store it somewhere safe.";
  }).catch((error) => {
    console.error("Could not export the workspace backup.", error);
    announce("Could not create a backup.");
  });
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("Backup files must be 20 MB or smaller.");
    const backup = JSON.parse(await file.text());
    if (backup.format !== "apeporah-workspace-backup" || backup.version !== 1 || !backup.data ||
        STORES.some((name) => !Array.isArray(backup.data[name]))) {
      throw new Error("This is not a supported InvoMint backup file.");
    }
    for (const name of STORES) {
      const seenIds = new Set();
      for (const record of backup.data[name]) {
        const key = name === "settings" ? record?.key : record?.id;
        if (!record || typeof record !== "object" || Array.isArray(record) ||
            typeof key !== "string" || !key.trim() || seenIds.has(key)) {
          throw new Error(`The backup contains an invalid or duplicate ${name} record.`);
        }
        if (name === "customers" && (typeof record.name !== "string" || !record.name.trim())) {
          throw new Error("The backup contains a customer without a valid name.");
        }
        if (name === "products" && (typeof record.name !== "string" || !record.name.trim() ||
            !Number.isFinite(Number(record.price)) || Number(record.price) < 0)) {
          throw new Error("The backup contains a product with an invalid name or price.");
        }
        seenIds.add(key);
      }
    }
    const seenNumbers = new Set();
    for (const record of backup.data.documents) {
      if (!["invoice", "receipt"].includes(record.kind) || typeof record.number !== "string" ||
          !record.number.trim() || typeof record.totalMinor !== "string" || !/^\d+$/.test(record.totalMinor) ||
          seenNumbers.has(record.number)) {
        throw new Error("The backup contains an invalid or duplicate document number.");
      }
      seenNumbers.add(record.number);
    }
    if (!window.confirm("Restore this backup? It will replace all current customers, products, settings, invoices and receipts.")) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORES, "readwrite");
      for (const name of STORES) {
        const objectStore = transaction.objectStore(name);
        objectStore.clear();
        for (const record of backup.data[name]) objectStore.put(record);
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Backup restore was cancelled."));
    });
    profile = await loadSetting("profile", { ...DEFAULT_PROFILE });
    populateProfileForm();
    await initializeTheme();
    await refreshData();
    frames.forEach(postWorkspaceData);
    document.querySelector("#backup-feedback").textContent = "Backup restored.";
  } catch (error) {
    console.error("Could not restore the workspace backup.", error);
    document.querySelector("#backup-feedback").textContent = error.message || "Could not restore the backup.";
  } finally {
    event.target.value = "";
  }
}

function bindFrames() {
  frames.forEach((frame) => {
    frame.addEventListener("load", () => {
      frame.dataset.resizeObserved = "";
      const doc = frame.contentDocument;
      if (doc?.documentElement) {
        const schedule = () => requestAnimationFrame(() => resizeFrame(frame));
        new ResizeObserver(schedule).observe(doc.documentElement);
        if (doc.body) {
          new ResizeObserver(schedule).observe(doc.body);
          new MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true, attributes: true });
        }
        resizeFrame(frame);
      }
      postWorkspaceData(frame);
    });
  });
  window.addEventListener("message", handleFrameMessage);
}

function bindInstallAndServiceWorker() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    document.querySelector("#install-app").hidden = false;
  });
  document.querySelector("#install-app").addEventListener("click", async () => {
    if (!installPrompt) {
      announce("Use your browser menu and choose Install app or Add to Home Screen.");
      return;
    }
    installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    installPrompt = null;
    document.querySelector("#install-app").hidden = true;
    if (choice.outcome === "accepted") announce("InvoMint is being installed.");
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    document.querySelector("#install-app").hidden = true;
    announce("InvoMint installed.");
  });
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Could not register the offline app worker.", error);
    });
  }
}

async function initialize() {
  database = await openDatabase();
  profile = { ...DEFAULT_PROFILE, ...(await loadSetting("profile", {})) };
  const migratedInvoices = await migrateLegacyInvoiceHistory();
  populateProfileForm();
  await initializeTheme();
  bindNavigation();
  bindLists();
  bindProducts();
  bindSettings();
  bindFrames();
  bindInstallAndServiceWorker();
  await refreshData();
  if (migratedInvoices) announce(`${migratedInvoices} earlier invoice${migratedInvoices === 1 ? "" : "s"} added to InvoMint.`);
}

initialize().catch((error) => {
  console.error("InvoMint could not start.", error);
  const main = document.querySelector("#main-content");
  main.innerHTML = `<section class="view active"><div class="card"><h1>Workspace could not start</h1><p>${escapeHTML(error.message || "Local storage is unavailable in this browser.")}</p><p>Your information was not removed. Try a current browser with IndexedDB enabled.</p></div></section>`;
});
