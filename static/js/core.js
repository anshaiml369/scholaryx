/* ==========================================================================
   Research UI core — shared vanilla-JS helpers for the portfolio projects.
   Canonical copy lives in AI_ML_PROJECTS/_design_system/core.js and is
   copied into each project's static/js/ by _design_system/sync.sh.
   Exposes a single global: window.RUI
   ========================================================================== */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Small DOM builder: el("div", {class: "x", onclick: fn}, [children]) */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /* ------------------------------------------------------------------------ */
  /* HTTP                                                                     */
  /* ------------------------------------------------------------------------ */
  class ApiError extends Error {
    constructor(message, { status = 0, detail = null, kind = "http" } = {}) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.detail = detail;
      this.kind = kind; // "http" | "network" | "timeout" | "parse"
    }
  }

  /** Turn FastAPI's `detail` (string | validation-error array | object) into readable text. */
  function formatDetail(detail) {
    if (!detail) return "";
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
          return loc ? `${loc}: ${d.msg}` : d.msg || JSON.stringify(d);
        })
        .join("; ");
    }
    if (typeof detail === "object" && detail.message) return detail.message;
    return JSON.stringify(detail);
  }

  async function api(path, { method = "GET", body, timeout = 30000, headers = {}, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), timeout);
    if (signal) signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
    const init = { method, headers: { Accept: "application/json", ...headers }, signal: ctrl.signal };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      clearTimeout(timer);
      if (ctrl.signal.aborted && ctrl.signal.reason === "timeout") {
        throw new ApiError(`The request timed out after ${Math.round(timeout / 1000)} s.`, { kind: "timeout" });
      }
      if (ctrl.signal.aborted) throw new ApiError("Request cancelled.", { kind: "abort" });
      throw new ApiError("Cannot reach the backend. Check that the API server is running.", { kind: "network" });
    }
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const detail = data && data.detail !== undefined ? data.detail : null;
      const msg = formatDetail(detail) || `${res.status} ${res.statusText || "error"}`;
      throw new ApiError(msg, { status: res.status, detail });
    }
    if (text && data === null) throw new ApiError("The server returned a response that is not valid JSON.", { kind: "parse", status: res.status });
    return data;
  }

  /* ------------------------------------------------------------------------ */
  /* UI behaviours                                                            */
  /* ------------------------------------------------------------------------ */

  /** WAI-ARIA tabs: [role=tablist] > [role=tab][aria-controls]. Arrow/Home/End keys. */
  function initTabs(tablist, { onChange, hash = false } = {}) {
    const tabs = $$('[role="tab"]', tablist);
    function select(tab, focus = false) {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      }
      if (focus) tab.focus();
      if (hash && tab.dataset.hash) history.replaceState(null, "", `#${tab.dataset.hash}`);
      if (onChange) onChange(tab);
    }
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab));
      tab.addEventListener("keydown", (e) => {
        let next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
    const fromHash = hash && location.hash ? tabs.find((t) => `#${t.dataset.hash}` === location.hash) : null;
    select(fromHash || tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0]);
    return { select: (idOrTab) => select(typeof idOrTab === "string" ? tabs.find((t) => t.id === idOrTab || t.dataset.hash === idOrTab) : idOrTab) };
  }

  /** Mobile header navigation toggle + close on link click / Escape. */
  function initHeader() {
    const toggle = $(".nav-toggle");
    const nav = $(".header-nav");
    if (!toggle || !nav) return;
    const close = () => { nav.classList.remove("is-open"); toggle.setAttribute("aria-expanded", "false"); };
    toggle.addEventListener("click", () => {
      const open = !nav.classList.contains("is-open");
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    const label = button.querySelector(".btn-label");
    if (busy) {
      if (label && !button.dataset.idleLabel) button.dataset.idleLabel = label.textContent;
      if (label && busyLabel) label.textContent = busyLabel;
      button.classList.add("is-loading");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    } else {
      if (label && button.dataset.idleLabel) label.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
      button.classList.remove("is-loading");
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function setStatus(node, state, text) {
    if (!node) return;
    node.dataset.state = state;
    const label = node.querySelector(".status-text");
    if (label) label.textContent = text;
    node.title = text;
  }

  function callout(kind, title, body) {
    const content = el("div", {}, [title ? el("div", { class: "callout-title", text: title }) : null]);
    for (const part of [].concat(body || [])) {
      content.append(part instanceof Node ? part : el("p", { text: part }));
    }
    return el("div", { class: `callout callout-${kind}`, role: kind === "err" ? "alert" : "status" }, [content]);
  }

  let toastRegion = null;
  function toast(message, kind = "info", ms = 4000) {
    if (!toastRegion) {
      toastRegion = el("div", { class: "toast-region", role: "status", "aria-live": "polite" });
      document.body.append(toastRegion);
    }
    const t = el("div", { class: "toast", "data-kind": kind, text: message });
    toastRegion.append(t);
    setTimeout(() => t.remove(), ms);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "ok", 2000);
    } catch {
      toast("Clipboard is not available in this browser context", "err");
    }
  }

  function download(filename, text, type = "text/plain") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ------------------------------------------------------------------------ */
  /* Formatting                                                               */
  /* ------------------------------------------------------------------------ */
  const fmt = {
    pct: (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`),
    num: (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "—" : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })),
    fixed: (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "—" : Number(x).toFixed(d)),
    secs: (s) => (s === null || s === undefined ? "—" : s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`),
    time: (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    label: (s) => String(s).replace(/_/g, " "),
  };

  /* ------------------------------------------------------------------------ */
  /* Charts (dependency-free)                                                 */
  /* ------------------------------------------------------------------------ */

  /** Horizontal bars. items: [{label, value (0..1), color?, top?}] */
  function renderBars(container, items, { valueFormat = (v) => fmt.pct(v, 1), sort = false, ariaLabel = "" } = {}) {
    const rows = sort ? [...items].sort((a, b) => b.value - a.value) : items;
    const list = el("ul", { class: "bars", "aria-label": ariaLabel || null });
    for (const it of rows) {
      const fill = el("div", { class: "bar-fill", style: { background: it.color || "" } });
      list.append(
        el("li", { class: `bar-row${it.top ? " is-top" : ""}` }, [
          el("span", { class: "bar-label" }, [
            it.color ? el("span", { class: "bar-swatch", style: { background: it.color }, "aria-hidden": "true" }) : null,
            el("span", { text: it.label, title: it.label }),
          ]),
          el("span", { class: "bar-track", role: "img", "aria-label": `${it.label}: ${valueFormat(it.value)}` }, [fill]),
          el("span", { class: "bar-value", text: valueFormat(it.value) }),
        ])
      );
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.max(0, Math.min(1, it.value)) * 100}%`; }));
    }
    container.replaceChildren(list);
    return list;
  }

  /**
   * Confusion matrix as an accessible table.
   * matrix[i][j] = count with true label i, predicted j.
   */
  function renderMatrix(container, matrix, labels, { normalize = false, color = "#1f3a5f", caption = "" } = {}) {
    const rowSums = matrix.map((r) => r.reduce((a, b) => a + b, 0));
    const values = matrix.map((r, i) => r.map((v) => (normalize ? (rowSums[i] ? v / rowSums[i] : 0) : v)));
    const max = Math.max(...values.flat(), 1e-9);
    const table = el("table", { class: "matrix" });
    if (caption) table.append(el("caption", { class: "sr-only", text: caption }));
    const head = el("tr", {}, [el("th", { class: "matrix-axis", text: "true ↓ / pred →" })]);
    labels.forEach((l) => head.append(el("th", { scope: "col" }, [el("span", { text: l })])));
    table.append(el("thead", {}, [head]));
    const body = el("tbody");
    values.forEach((row, i) => {
      const tr = el("tr", {}, [el("th", { scope: "row", text: labels[i] })]);
      row.forEach((v, j) => {
        const t = v / max;
        const bg = `color-mix(in srgb, ${color} ${Math.round(t * 92)}%, var(--surface-2))`;
        const fg = t > 0.55 ? "#fff" : "var(--text)";
        const shown = normalize ? (v * 100).toFixed(0) + "%" : String(v);
        tr.append(
          el("td", {
            class: i === j ? "diag" : "",
            style: { background: bg, color: fg },
            title: `true ${labels[i]} → predicted ${labels[j]}: ${matrix[i][j]}${normalize ? ` (${(v * 100).toFixed(1)}% of row)` : ""}`,
            text: shown,
          })
        );
      });
      body.append(tr);
    });
    table.append(body);
    container.replaceChildren(el("div", { class: "matrix-wrap" }, [table]));
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  /**
   * Line/scatter plot.
   * series: [{name, color, points: [[x,y],...], dashed?, markers?}]
   * marks: [{x?, y?, label, color}] vertical/horizontal reference lines
   */
  function plotXY(container, series, { xLabel = "", yLabel = "", xDomain = [0, 1], yDomain = [0, 1], width = 520, height = 320, ticks = 5, marks = [], ariaLabel = "" } = {}) {
    const m = { t: 14, r: 16, b: 44, l: 52 };
    const iw = width - m.l - m.r, ih = height - m.t - m.b;
    const sx = (x) => m.l + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * iw;
    const sy = (y) => m.t + ih - ((y - yDomain[0]) / (yDomain[1] - yDomain[0])) * ih;
    const root = svg("svg", { class: "plot", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": ariaLabel || `${yLabel} vs ${xLabel}` });
    const grid = svg("g", { class: "grid" });
    const axis = svg("g", { class: "axis" });
    for (let i = 0; i <= ticks; i++) {
      const xv = xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / ticks;
      const yv = yDomain[0] + ((yDomain[1] - yDomain[0]) * i) / ticks;
      grid.append(svg("line", { x1: sx(xv), x2: sx(xv), y1: m.t, y2: m.t + ih }));
      grid.append(svg("line", { x1: m.l, x2: m.l + iw, y1: sy(yv), y2: sy(yv) }));
      const tx = svg("text", { x: sx(xv), y: m.t + ih + 16, "text-anchor": "middle" }); tx.textContent = +xv.toFixed(2);
      const ty = svg("text", { x: m.l - 8, y: sy(yv) + 3, "text-anchor": "end" }); ty.textContent = +yv.toFixed(2);
      axis.append(tx, ty);
    }
    axis.append(svg("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih }));
    axis.append(svg("line", { x1: m.l, x2: m.l, y1: m.t, y2: m.t + ih }));
    const xt = svg("text", { class: "axis-title", x: m.l + iw / 2, y: height - 8, "text-anchor": "middle" }); xt.textContent = xLabel;
    const yt = svg("text", { class: "axis-title", x: -(m.t + ih / 2), y: 14, transform: "rotate(-90)", "text-anchor": "middle" }); yt.textContent = yLabel;
    root.append(grid, axis, xt, yt);
    for (const mk of marks) {
      const g = svg("g");
      if (mk.x !== undefined) g.append(svg("line", { x1: sx(mk.x), x2: sx(mk.x), y1: m.t, y2: m.t + ih, stroke: mk.color || "currentColor", "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
      if (mk.y !== undefined) g.append(svg("line", { x1: m.l, x2: m.l + iw, y1: sy(mk.y), y2: sy(mk.y), stroke: mk.color || "currentColor", "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
      if (mk.label) {
        const t = svg("text", { x: mk.x !== undefined ? sx(mk.x) + 4 : m.l + iw - 4, y: mk.y !== undefined ? sy(mk.y) - 5 : m.t + 10, "text-anchor": mk.x !== undefined ? "start" : "end", fill: mk.color || "currentColor" });
        t.textContent = mk.label;
        g.append(t);
      }
      root.append(g);
    }
    for (const s of series) {
      if (!s.points || !s.points.length) continue;
      const d = s.points.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("");
      if (s.line !== false) root.append(svg("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-dasharray": s.dashed ? "5 4" : null, "stroke-linejoin": "round" }));
      if (s.markers) for (const [x, y] of s.points) root.append(svg("circle", { cx: sx(x), cy: sy(y), r: s.markerSize || 3, fill: s.color }));
      if (s.highlight) {
        const [x, y] = s.highlight;
        root.append(svg("circle", { cx: sx(x), cy: sy(y), r: 5.5, fill: "var(--surface)", stroke: s.color, "stroke-width": 2.5 }));
      }
    }
    container.replaceChildren(root);
    return root;
  }

  function legend(items) {
    return el("div", { class: "legend" }, items.map((it) =>
      el("span", { class: "legend-item" }, [el("span", { class: `legend-swatch${it.dot ? " dot" : ""}`, style: { background: it.color }, "aria-hidden": "true" }), it.label])
    ));
  }

  /* ------------------------------------------------------------------------ */
  /* Minimal, safe Markdown renderer (escape-first; http(s) links only)       */
  /* ------------------------------------------------------------------------ */
  function inlineMd(text) {
    let s = escapeHtml(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
  }

  function markdown(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let list = null; // {type, items}
    let para = [];
    let code = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(" "))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.type}>`); list = null; } };
    for (const raw of lines) {
      if (code !== null) {
        if (/^\s*```/.test(raw)) { out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = null; }
        else code.push(raw);
        continue;
      }
      if (/^\s*```/.test(raw)) { flushPara(); flushList(); code = []; continue; }
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); flushList(); continue; }
      let m;
      if ((m = line.match(/^\s*(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const n = m[1].length + 1; out.push(`<h${Math.min(n, 4)}>${inlineMd(m[2].replace(/#+\s*$/, ""))}</h${Math.min(n, 4)}>`); continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }
      if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`); continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; } list.items.push(m[1]); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; } list.items.push(m[1]); continue; }
      if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
      flushList();
      para.push(line.trim());
    }
    if (code !== null) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    flushPara(); flushList();
    return out.join("\n");
  }

  function debounce(fn, ms = 200) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const storage = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
  };

  document.addEventListener("DOMContentLoaded", initHeader);

  window.RUI = {
    $, $$, el, svg, escapeHtml, api, ApiError, formatDetail, initTabs, setBusy, setStatus, callout,
    toast, copyText, download, fmt, renderBars, renderMatrix, plotXY, legend, markdown, debounce, storage,
  };
})();
