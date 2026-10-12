"use strict";
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  /** Element factory. Text is always set via textContent, never parsed as markup. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = Boolean(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
    return el;
  }

  async function api(path, options = {}) {
    const init = { method: options.method || "GET", headers: {}, credentials: "same-origin" };
    if (options.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) { state.authenticated = false; render(); throw new Error("กรุณาเข้าสู่ระบบ"); }
    if (!res.ok) throw new Error((data && data.error && data.error.message) || "เกิดข้อผิดพลาด (" + res.status + ")");
    return data;
  }

  const fmtTime = (v) => {
    if (!v) return "-";
    const d = new Date(String(v).replace(" ", "T") + (String(v).includes("Z") || String(v).includes("+") ? "" : "Z"));
    return isNaN(d) ? String(v) : d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
  };

  const state = { authenticated: null, tab: "overview", mode: null, products: [], toast: null, nav: null };

  function toast(message, kind = "ok") {
    state.toast = { message, kind };
    const el = $("#toast");
    if (el) { el.textContent = message; el.className = "toast show " + kind; }
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { const t = $("#toast"); if (t) t.className = "toast"; }, 3500);
  }

  function badge(text, kind) { return h("span", { class: "badge " + (kind || ""), text }); }

  /* ------------------------------ icons ------------------------------ */
  // Inline SVG line icons (stroke paths only); built with createElementNS, never parsed markup.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    chat: ["M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"],
    zap: ["M13 2L3 14h9l-1 8 10-12h-9l1-8z"],
    send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
    link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
    alert: ["M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z", "M12 9v4", "M12 17h.01"],
    box: ["M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z", "M3.27 6.96L12 12.01l8.73-5.05", "M12 22.08V12"],
    file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8"],
    skip: ["M5 4l10 8-10 8V4z", "M19 5v14"],
    clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
    check: ["M22 11.08V12a10 10 0 1 1-5.93-9.14", "M22 4L12 14.01l-3-3"],
    refresh: ["M23 4v6h-6", "M1 20v-6h6", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"],
    ext: ["M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", "M15 3h6v6", "M10 14L21 3"],
    arrow: ["M5 12h14", "M12 5l7 7-7 7"],
  };
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    for (const d of ICONS[name] || []) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  /* --------------------------- Facebook links --------------------------- */
  /** Only real Facebook https links become anchors; anything else is shown as text. */
  const isFacebookUrl = (u) => /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(String(u || ""));
  const FB_BASE = "https://www.facebook.com/";
  /**
   * A clickable Facebook URL for a post/Reel. A stored Facebook permalink wins;
   * otherwise it is built from the numeric id only (`<page>_<post>` ->
   * /<page>/posts/<post>; a bare Reel/video id -> /reel/<id> or /<id>).
   * Anything that is not purely numeric gives null (rendered as plain text).
   */
  function fbPostUrl(postId, permalink, type) {
    if (isFacebookUrl(permalink)) return String(permalink);
    const id = String(postId || "");
    const pair = /^([0-9]+)_([0-9]+)$/.exec(id);
    if (pair) return FB_BASE + pair[1] + "/posts/" + pair[2];
    if (/^[0-9]+$/.test(id)) return FB_BASE + (type === "REEL" ? "reel/" : "") + id;
    return null;
  }
  /** The post URL with `?comment_id=` so Facebook scrolls to / highlights that comment. */
  function fbCommentUrl(commentId, postId, permalink) {
    const base = fbPostUrl(postId, permalink);
    const m = /^(?:[0-9]+_)?([0-9]+)$/.exec(String(commentId || ""));
    if (!base || !m) return base;
    try { const u = new URL(base); u.searchParams.set("comment_id", m[1]); return u.toString(); } catch { return base; }
  }
  /** Text with every https:// URL turned into a real link (built as text nodes + anchors, never markup). */
  function linkify(text, cls) {
    const el = h("div", { class: cls || "" });
    const str = String(text || "");
    const re = /https:\/\/[^\s<>"']+/g;
    let last = 0; let m;
    while ((m = re.exec(str))) {
      const url = m[0].replace(/[).,!?…]+$/, "");
      if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
      el.appendChild(h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "ext", text: url }));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
    return el;
  }
  /** External link (new tab, no referrer/opener) or plain text when there is no safe URL. */
  function extLink(url, text, cls) {
    if (!url) return h("span", { class: cls || "", text });
    return h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "ext " + (cls || ""), text });
  }

  /* --------------------------- in-app navigation --------------------------- */
  const tabFromHash = () => { const k = String(location.hash || "").replace(/^#/, ""); return TABS.some(([key]) => key === k) ? k : "overview"; };
  /** Switch tab (keeps the URL hash in sync so tabs are real, shareable links). `nav` carries a one-shot filter. */
  function goTo(tab, nav) {
    state.nav = nav || null;
    if (location.hash !== "#" + tab) location.hash = tab; // hashchange -> render()
    else { state.tab = tab; render(); }
  }
  /** Internal link to the product catalog, pre-filtered by name. */
  function productLink(name) {
    if (!name) return h("span", { class: "muted", text: "-" });
    return h("a", { href: "#products", class: "plink", text: name, onclick: (e) => { e.preventDefault(); goTo("products", { search: name }); } });
  }

  /* ------------------------------ pagination ------------------------------ */
  const PAGE_SIZES = [10, 25, 50, 100];
  function pageSizeSelect(value, onChange) {
    return h("select", { class: "page-size", "aria-label": "จำนวนต่อหน้า", onchange: (e) => onChange(Number(e.target.value)) },
      PAGE_SIZES.map((n) => h("option", { value: n, text: n + " / หน้า", selected: n === value })));
  }
  /**
   * Pager bar. With `pages` known: numbered buttons (1 … p-1 p p+1 … last).
   * Without (cursor APIs): previous / "หน้า N" / next, next enabled by `hasMore`.
   */
  function pagerBar({ page, pages, from, to, total, count, hasMore, size, onPage, onSize }) {
    const btn = (label, target, opts = {}) => h("button", { type: "button", class: "pg-btn" + (opts.active ? " active" : ""), text: label, disabled: Boolean(opts.disabled), "aria-current": opts.active ? "page" : null, "aria-label": opts.label || null, onclick: () => onPage(target) });
    const nums = [];
    if (pages) {
      const shown = [...new Set([1, pages, page - 1, page, page + 1])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
      let prev = 0;
      for (const n of shown) {
        if (n - prev > 1) nums.push(h("span", { class: "pg-gap", text: "…" }));
        nums.push(btn(String(n), n, { active: n === page }));
        prev = n;
      }
    } else {
      nums.push(h("span", { class: "pg-current", text: "หน้า " + page }));
    }
    const info = total !== undefined ? from + "–" + to + " จาก " + total + " รายการ" : "แสดง " + (count ?? 0) + " รายการ" + (hasMore ? "" : " · หน้าสุดท้าย");
    return h("div", { class: "pager" },
      h("span", { class: "pg-info", text: info }),
      h("div", { class: "pg-nav" },
        btn("‹", page - 1, { disabled: page <= 1, label: "หน้าก่อนหน้า" }),
        ...nums,
        btn("›", page + 1, { disabled: pages ? page >= pages : !hasMore, label: "หน้าถัดไป" })),
      onSize ? pageSizeSelect(size, onSize) : null);
  }
  /** Client-side pagination over a list already in memory. */
  function pagedList(items, renderPage, size = 25) {
    const wrap = h("div", { class: "paged" });
    let page = 1;
    const draw = () => {
      const pages = Math.max(1, Math.ceil(items.length / size));
      if (page > pages) page = pages;
      const start = (page - 1) * size;
      const pager = items.length > PAGE_SIZES[0] ? pagerBar({ page, pages, from: start + 1, to: Math.min(start + size, items.length), total: items.length, size,
          onPage: (n) => { page = n; draw(); }, onSize: (n) => { size = n; page = 1; draw(); } }) : null;
      wrap.replaceChildren(...[renderPage(items.slice(start, start + size)), pager].filter(Boolean)); // replaceChildren(null) would print "null"
    };
    draw();
    return wrap;
  }
  /**
   * Page-by-page navigation over a cursor API ({data, next_cursor, has_more}).
   * The cursor of every visited page is kept, so "previous" returns exactly.
   */
  function cursorPaging(fetchPage, onRows, initialSize = 25) {
    let size = initialSize; let page = 1; let cursors = [null];
    const bar = h("div", { class: "pager-slot" });
    const go = async (n) => {
      const res = await fetchPage(cursors[n - 1] || null, size);
      page = n;
      cursors[n] = res.next_cursor || null;
      cursors.length = n + 1;
      onRows(res.data || []);
      const hasMore = Boolean(res.has_more);
      bar.replaceChildren(page > 1 || hasMore ? pagerBar({ page, hasMore, size, count: (res.data || []).length,
        onPage: (k) => { go(k).then(() => bar.scrollIntoView({ block: "nearest" })).catch((ex) => toast(ex.message, "err")); },
        onSize: (k) => { size = k; reset().catch((ex) => toast(ex.message, "err")); } }) : h("span"));
    };
    const reset = () => { cursors = [null]; return go(1); };
    return { bar, reset, reload: () => go(page) };
  }

  const STATUS_KIND = { PROCESSED: "blue", REPLIED: "green", SKIPPED: "gray", ERROR: "red", RECEIVED: "gray", GENERATED: "blue", SENT: "green", FAILED: "red" };
  const SOURCE_LABEL = { MAPPING: "ผูกกับโพสต์", KEYWORD: "คีย์เวิร์ด (ข้อมูลเก่า)", NONE: "ไม่มี" };

  /* ------------------------------ login ------------------------------ */
  function renderLogin(root) {
    const input = h("input", { type: "password", id: "pw", placeholder: "รหัสผ่านผู้ดูแล", autocomplete: "current-password" });
    const err = h("p", { class: "error" });
    const submit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const res = await fetch("/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: input.value }), credentials: "same-origin" });
      if (res.ok) { state.authenticated = true; render(); } else { err.textContent = "รหัสผ่านไม่ถูกต้อง"; }
    };
    root.appendChild(h("div", { class: "login" },
      h("form", { class: "card login-card", onsubmit: submit },
        h("div", { class: "brand" }, h("div", { class: "logo", text: "T" }), h("div", null, h("strong", { text: "TipsUseLife AI" }), h("div", { class: "muted", text: "Facebook Comment Agent" }))),
        h("label", { text: "รหัสผ่าน" }), input, err,
        h("button", { class: "btn primary", type: "submit", text: "เข้าสู่ระบบ" }))));
    input.focus();
  }

  /* ------------------------------ shell ------------------------------ */
  const TABS = [
    ["overview", "ภาพรวม"],
    ["products", "สินค้า Affiliate"],
    ["content", "โพสต์ / Reel"],
    ["discovered", "โพสต์ที่ค้นพบ"],
    ["suggestions", "สินค้าแนะนำ"],
    ["activity", "กิจกรรมคอมเมนต์"],
    ["performance", "ผลงาน"],
    ["settings", "ตั้งค่า"],
  ];

  function renderShell(root) {
    // Tabs are real links (#overview, #products, …): bookmarkable, back/forward works.
    const nav = h("nav", { class: "tabs", "aria-label": "เมนูหลัก" }, TABS.map(([key, label]) =>
      h("a", { class: "tab" + (state.tab === key ? " active" : ""), href: "#" + key, text: label, "aria-current": state.tab === key ? "page" : null })));
    const modeBadge = state.mode ? modePill(state.mode) : null;
    const logout = h("button", { class: "btn ghost", text: "ออกจากระบบ", onclick: async () => { await fetch("/admin/logout", { method: "POST", credentials: "same-origin" }); state.authenticated = false; render(); } });
    root.appendChild(h("header", { class: "topbar" },
      h("div", { class: "topbar-inner" },
        h("a", { class: "brand", href: "#overview" }, h("div", { class: "logo", text: "T" }), h("div", null, h("strong", { text: "TipsUseLife AI" }), h("div", { class: "muted small", text: "Facebook Page Comment Agent" }))),
        h("div", { class: "topbar-right" }, modeBadge, logout)),
      nav));
    const main = h("main", { id: "view" }, h("p", { class: "muted", text: "กำลังโหลด…" }));
    root.appendChild(main);
    root.appendChild(h("div", { id: "toast", class: "toast" }));
    const views = { overview: viewOverview, products: viewProducts, content: viewContent, discovered: viewDiscovered, suggestions: viewSuggestions, activity: viewActivity, performance: viewPerformance, settings: viewSettings };
    views[state.tab](main).catch((e) => { main.replaceChildren(h("p", { class: "error", text: e.message })); });
  }

  /* ------------------------------ SVG + trend chart (U3) ------------------------------ */
  function svgEl(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
    for (const c of children.flat()) if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return el;
  }
  // Validated categorical slots 1-3 (blue / orange / aqua), light + dark, see app.css --s1..--s3.
  const TREND_SERIES = [["comments", "คอมเมนต์ที่รับ", "s1"], ["ai_replies", "AI เลือกตอบ", "s2"], ["sent", "ส่งจริง (SENT)", "s3"]];
  const niceMax = (v) => { if (v <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
  const dayLabel = (d) => { const [, m, dd] = String(d).split("-"); return Number(dd) + "/" + Number(m); };

  /** Line chart: one shared y-axis (all counts), crosshair + tooltip, legend, keyboard, table view. */
  function trendChart(rows) {
    const W = 760, H = 240, L = 40, R = 46, T = 14, B = 28;
    const iw = W - L - R, ih = H - T - B;
    const max = niceMax(Math.max(1, ...rows.flatMap((r) => TREND_SERIES.map(([k]) => Number(r[k]) || 0))));
    const x = (i) => L + (rows.length <= 1 ? iw / 2 : (i * iw) / (rows.length - 1));
    const y = (v) => T + ih - (v / max) * ih;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => svgEl("g", null,
      svgEl("line", { x1: L, x2: W - R, y1: y(max * f), y2: y(max * f), class: f === 0 ? "axis" : "grid" }),
      svgEl("text", { x: L - 8, y: y(max * f) + 4, class: "tick", "text-anchor": "end" }, fmtNum(Math.round(max * f)))));
    const step = Math.max(1, Math.ceil(rows.length / 8));
    const lastTick = rows.length - 1;
    const xticks = rows.map((r, i) => ((i % step === 0 && lastTick - i >= step / 2) || i === lastTick) ? svgEl("text", { x: x(i), y: H - 8, class: "tick", "text-anchor": "middle" }, dayLabel(r.day)) : null);
    const lines = TREND_SERIES.map(([k, , cls]) => svgEl("path", { class: "line " + cls, d: rows.map((r, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(Number(r[k]) || 0).toFixed(1)).join(" ") }));
    // Direct labels: last value at the line end (text in text tokens, a short colored key beside it).
    const last = rows.length - 1;
    const ends = TREND_SERIES.map(([k, , cls]) => ({ k, cls, v: Number(rows[last]?.[k]) || 0 })).sort((a, b) => b.v - a.v);
    let prevY = -99;
    const endLabels = ends.map((e) => { let ly = Math.max(y(e.v) + 4, prevY + 13); prevY = ly; return svgEl("g", null, svgEl("line", { x1: W - R + 4, x2: W - R + 12, y1: ly - 4, y2: ly - 4, class: "key " + e.cls }), svgEl("text", { x: W - R + 15, y: ly, class: "end-label" }, fmtNum(e.v))); });
    const hair = svgEl("line", { y1: T, y2: T + ih, class: "hair", visibility: "hidden" });
    const dots = TREND_SERIES.map(([, , cls]) => svgEl("circle", { r: 4.5, class: "dot " + cls, visibility: "hidden" }));
    const hit = svgEl("rect", { x: L, y: T, width: iw, height: ih, class: "hit" });
    const chart = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "trend", role: "img", "aria-label": "แนวโน้มรายวัน: คอมเมนต์ที่รับ AI เลือกตอบ และส่งจริง" }, grid, xticks, lines, endLabels, hair, dots, hit);
    const tip = h("div", { class: "chart-tip", role: "status" });
    const wrap = h("div", { class: "chart-wrap", tabindex: "0", "aria-label": "เลื่อนดูค่ารายวันด้วยปุ่มลูกศรซ้าย/ขวา" }, chart, tip);
    let cur = -1;
    const show = (i) => {
      if (i < 0 || i >= rows.length) return;
      cur = i;
      const r = rows[i];
      hair.setAttribute("x1", x(i)); hair.setAttribute("x2", x(i)); hair.setAttribute("visibility", "visible");
      TREND_SERIES.forEach(([k], j) => { dots[j].setAttribute("cx", x(i)); dots[j].setAttribute("cy", y(Number(r[k]) || 0)); dots[j].setAttribute("visibility", "visible"); });
      tip.replaceChildren(...[h("div", { class: "tip-day", text: r.day }),
        ...TREND_SERIES.map(([k, label, cls]) => h("div", { class: "tip-row" }, h("span", { class: "tip-key " + cls }), h("strong", { text: fmtNum(r[k]) }), h("span", { class: "muted", text: label }))),
        h("div", { class: "tip-row" }, h("span", { class: "tip-key none" }), h("strong", { text: fmtNum(r.sent_with_link) }), h("span", { class: "muted", text: "แนบลิงก์" })),
        Number(r.errors) ? h("div", { class: "tip-row" }, h("span", { class: "tip-key none" }), h("strong", { text: fmtNum(r.errors) }), h("span", { class: "muted", text: "ERROR" })) : null].filter(Boolean));
      tip.classList.add("show");
      const box = chart.getBoundingClientRect();
      const px = (x(i) / W) * box.width;
      tip.style.left = Math.min(Math.max(px + 12, 0), box.width - 170) + "px";
      if (px + 12 > box.width - 170) tip.style.left = Math.max(px - 182, 0) + "px";
    };
    const hide = () => { cur = -1; hair.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); tip.classList.remove("show"); };
    hit.addEventListener("pointermove", (e) => {
      const box = chart.getBoundingClientRect();
      const vx = ((e.clientX - box.left) / box.width) * W;
      show(Math.round(((vx - L) / iw) * (rows.length - 1)));
    });
    hit.addEventListener("pointerleave", hide);
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); show(cur < 0 ? rows.length - 1 : Math.min(rows.length - 1, cur + 1)); }
      if (e.key === "ArrowLeft") { e.preventDefault(); show(cur < 0 ? rows.length - 1 : Math.max(0, cur - 1)); }
      if (e.key === "Escape") hide();
    });
    wrap.addEventListener("blur", hide);
    const legend = h("div", { class: "legend" }, TREND_SERIES.map(([, label, cls]) => h("span", { class: "legend-item" }, h("span", { class: "legend-key " + cls }), label)));
    return { legend, wrap };
  }

  function trendTable(rows) {
    return h("table", { class: "compact" },
      h("thead", null, h("tr", null, ["วัน", "คอมเมนต์", "AI ตอบ", "ส่งจริง", "แนบลิงก์", "ERROR"].map((t, i) => h("th", { text: t, class: i ? "num" : null })))),
      h("tbody", null, rows.slice().reverse().map((r) => h("tr", null, h("td", { class: "mono small", text: r.day }), ...["comments", "ai_replies", "sent", "sent_with_link", "errors"].map((k) => h("td", { class: "num", text: fmtNum(r[k]) }))))));
  }

  function trendCard() {
    const body = h("div", { class: "trend-body" }, h("p", { class: "muted small", text: "กำลังโหลด…" }));
    let days = 30; let asTable = false; let rows = [];
    const draw = () => {
      if (!rows.length) { body.replaceChildren(h("p", { class: "muted", text: "ยังไม่มีข้อมูล" })); return; }
      if (asTable) { body.replaceChildren(trendTable(rows)); return; }
      const c = trendChart(rows);
      body.replaceChildren(c.legend, c.wrap);
    };
    const load = async () => {
      body.classList.add("loading");
      try { rows = (await api("/admin/api/stats/daily?days=" + days)).data || []; draw(); }
      catch (ex) { body.replaceChildren(h("p", { class: "error", text: ex.message })); }
      body.classList.remove("loading");
    };
    const seg = h("div", { class: "seg", role: "group", "aria-label": "ช่วงเวลา" });
    const segBtns = [7, 30, 90].map((n) => h("button", { type: "button", class: "seg-btn" + (n === days ? " active" : ""), text: n + " วัน", "aria-pressed": n === days ? "true" : "false", onclick: () => {
      days = n; segBtns.forEach((b, i) => { const on = [7, 30, 90][i] === n; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false"); }); load();
    } }));
    seg.replaceChildren(...segBtns);
    const toggle = h("button", { type: "button", class: "btn small ghost", text: "ดูเป็นตาราง", onclick: (e) => { asTable = !asTable; e.target.textContent = asTable ? "ดูเป็นกราฟ" : "ดูเป็นตาราง"; draw(); } });
    load();
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", { text: "แนวโน้มรายวัน" }), h("div", { class: "head-tools" }, seg, toggle)),
      h("p", { class: "muted small", text: "นับตามวันเวลาไทย (UTC+7) · ส่งจริง = คำตอบ LIVE ที่ Facebook รับแล้ว" }),
      body);
  }

  /* ------------------------------ comment drawer (U6) ------------------------------ */
  const REPLY_STATUS_TEXT = { GENERATED: "ร่างแล้ว / กำลังส่ง", SENT: "ส่งแล้ว", FAILED: "ส่งไม่สำเร็จ", SKIPPED: "ข้าม" };
  function closeDrawer() { const d = $("#drawer"); if (d) d.remove(); document.removeEventListener("keydown", drawerKey); }
  function drawerKey(e) { if (e.key === "Escape") closeDrawer(); }
  async function openComment(id) {
    closeDrawer();
    const panel = h("aside", { class: "drawer-panel", role: "dialog", "aria-modal": "true", "aria-label": "รายละเอียดคอมเมนต์", tabindex: "-1" }, h("p", { class: "muted", text: "กำลังโหลด…" }));
    const root = h("div", { id: "drawer", class: "drawer" }, h("div", { class: "drawer-scrim", onclick: closeDrawer }), panel);
    document.body.appendChild(root);
    document.addEventListener("keydown", drawerKey);
    panel.focus();
    let c;
    try { c = (await api("/admin/api/comments/" + id)).data; } catch (ex) { panel.replaceChildren(h("p", { class: "error", text: ex.message })); return; }
    const kv = (k, v) => h("div", { class: "dkv" }, h("div", { class: "dk", text: k }), h("div", { class: "dv" }, v));
    panel.replaceChildren(...[ // filter(Boolean): replaceChildren(null) would print "null"
      h("div", { class: "drawer-head" }, h("h3", { text: "คอมเมนต์ #" + c.id }), h("button", { class: "btn small ghost", text: "ปิด ✕", onclick: closeDrawer })),
      h("div", { class: "feed-top" }, h("strong", { text: c.author_name || "ไม่ทราบชื่อ" }), badge(c.status, STATUS_KIND[c.status]), c.ai_action ? badge(c.ai_action, c.ai_action === "REPLY" ? "blue" : "gray") : null),
      h("div", { class: "quote pre", text: c.comment_text || "" }),
      h("div", { class: "feed-links" }, commentLinks({ facebook_comment_id: c.facebook_comment_id, facebook_post_id: c.facebook_post_id })),
      kv("เวลาที่รับ", h("span", { text: fmtTime(c.created_at) })),
      kv("Comment ID", extLink(fbCommentUrl(c.facebook_comment_id, c.facebook_post_id, c.facebook_post_permalink), c.facebook_comment_id || "-", "mono small")),
      kv("โพสต์", extLink(fbPostUrl(c.facebook_post_id, c.facebook_post_permalink), c.facebook_post_id || "-", "mono small")),
      c.facebook_parent_id ? kv("ตอบกลับคอมเมนต์", h("span", { class: "mono small", text: c.facebook_parent_id })) : null,
      kv("สินค้าของโพสต์", c.mapping ? h("span", null, productLink(c.mapping.product_name), Number(c.mapping.active) === 1 ? null : h("span", { class: "muted small", text: " (mapping ปิดอยู่)" }), c.mapping.product_usable ? null : h("div", { class: "error small", text: "สินค้าถูกปิด/ลบ — จะไม่แนบลิงก์" })) : h("span", { class: "muted", text: "ยังไม่ผูกสินค้า" })),
      kv("สินค้าที่ใช้ตอบ", c.matched_product ? productLink(c.matched_product.name) : h("span", { class: "muted", text: "-" })),
      h("h3", { text: "ประวัติคำตอบ (" + (c.replies || []).length + ")" }),
      (c.replies || []).length ? h("ol", { class: "timeline" }, c.replies.map((r) => h("li", null,
        h("div", { class: "feed-top" }, badge(r.mode, r.mode === "LIVE" ? "red" : "blue"), badge(REPLY_STATUS_TEXT[r.status] || r.status, STATUS_KIND[r.status]), h("span", { class: "muted small", text: fmtTime(r.created_at) })),
        r.response_text ? linkify(r.response_text, "pre reply-text") : null,
        r.reason ? h("div", { class: "small muted mono", text: r.reason }) : null,
        r.facebook_reply_id ? h("div", { class: "small" }, "Reply ID: ", extLink(fbCommentUrl(r.facebook_reply_id, c.facebook_post_id, c.facebook_post_permalink), r.facebook_reply_id, "mono small")) : null))) : h("p", { class: "muted small", text: "ยังไม่มีคำตอบ" }),
      c.ai_response ? h("details", null, h("summary", { text: "ผลลัพธ์ดิบจาก AI" }), h("div", { class: "pre small mono raw", text: c.ai_response })) : null].filter(Boolean));
  }

  /* ----------------------------- overview ---------------------------- */
  const fmtNum = (v) => Number(v || 0).toLocaleString("th-TH");
  const num = (v) => Number(v) || 0;
  const pct = (a, b) => (num(b) > 0 ? Math.round((num(a) / num(b)) * 100) : 0);

  /** A KPI card is a real link to the list behind the number. */
  function kpiCard(k) {
    return h("a", { class: "kpi tone-" + k.tone, href: "#" + k.to[0], onclick: (e) => { e.preventDefault(); goTo(k.to[0], k.to[1]); } },
      h("div", { class: "kpi-icon" }, icon(k.icon)),
      h("div", { class: "kpi-body" },
        h("div", { class: "kpi-label", text: k.label }),
        h("div", { class: "kpi-value", text: fmtNum(k.value) }),
        h("div", { class: "kpi-sub", text: k.sub })));
  }

  function bar(value, max, tone) {
    const fill = h("span", { class: "bar-fill tone-" + (tone || "blue") });
    fill.style.width = Math.max(0, Math.min(100, pct(value, max))) + "%"; // CSSOM, allowed by the CSP
    return h("span", { class: "bar" }, fill);
  }

  function funnel(d) {
    const total = num(d.comments_received);
    const steps = [
      ["คอมเมนต์ที่รับ", d.comments_received, "blue"],
      ["AI เลือกตอบ", d.ai_replies, "violet"],
      ["ส่งจริง (SENT)", d.replies_sent, "green"],
      ["คำตอบที่แนบลิงก์", d.replies_with_link, "amber"],
    ];
    return h("div", { class: "funnel" }, steps.map(([label, value, tone]) => h("div", { class: "funnel-row" },
      h("div", { class: "funnel-label" }, h("span", { text: label }), h("span", { class: "funnel-num", text: fmtNum(value) + (total ? " · " + pct(value, total) + "%" : "") })),
      bar(value, total, tone))));
  }

  function meterRow(label, active, total, tab) {
    return h("a", { class: "meter", href: "#" + tab, onclick: (e) => { e.preventDefault(); goTo(tab); } },
      h("div", { class: "meter-head" }, h("span", { text: label }), h("strong", { text: fmtNum(active) + " / " + fmtNum(total) })),
      bar(active, total, "green"),
      h("div", { class: "muted small", text: "เปิดใช้ " + pct(active, total) + "%" }));
  }

  function miniStat(label, value, tone, to) {
    return h("a", { class: "mini tone-" + tone, href: "#" + to[0], onclick: (e) => { e.preventDefault(); goTo(to[0], to[1]); } },
      h("span", { class: "mini-value", text: fmtNum(value) }), h("span", { class: "mini-label", text: label }));
  }

  /** Links to the comment (and its post) on Facebook; omitted when no safe URL can be built. */
  function commentLinks(c) {
    const cu = fbCommentUrl(c.facebook_comment_id, c.facebook_post_id);
    const pu = fbPostUrl(c.facebook_post_id);
    const out = [];
    if (cu) out.push(extLink(cu, "ดูคอมเมนต์ ↗", "small"));
    if (pu) out.push(extLink(pu, "ดูโพสต์ ↗", "small"));
    return out.length ? h("span", { class: "links" }, out) : null;
  }

  function recentFeed(rows) {
    if (!rows.length) return h("p", { class: "muted", text: "ยังไม่มีคอมเมนต์" });
    return h("ul", { class: "feed" }, rows.map((c) => h("li", { class: "feed-item clickable", tabindex: "0", role: "button", "aria-label": "ดูรายละเอียดคอมเมนต์", onclick: (e) => { if (!e.target.closest("a")) openComment(c.id); }, onkeydown: (e) => { if (e.key === "Enter") openComment(c.id); } },
      h("div", { class: "avatar", text: (String(c.author_name || "").trim().charAt(0) || "?").toUpperCase() }),
      h("div", { class: "feed-body" },
        h("div", { class: "feed-top" },
          h("strong", { text: c.author_name || "ไม่ทราบชื่อ" }),
          h("span", { class: "muted small", text: fmtTime(c.created_at) }),
          badge(c.status, STATUS_KIND[c.status]),
          c.reply ? badge(c.reply.mode, c.reply.mode === "LIVE" ? "red" : "blue") : null),
        h("div", { class: "feed-text", text: c.comment_text || "" }),
        c.reply && c.reply.response_text ? h("div", { class: "feed-reply" }, icon("send", "sm"), linkify(c.reply.response_text, "pre")) : null,
        h("div", { class: "feed-links" }, commentLinks(c), c.matched_product ? h("span", { class: "small" }, "สินค้า: ", productLink(c.matched_product.name)) : null)))));
  }

  async function viewOverview(main) {
    const [ov, recent, health, attention] = await Promise.all([api("/admin/api/overview"), api("/admin/comments?limit=10"), api("/admin/api/health"), api("/admin/api/recovery")]);
    state.mode = ov.mode;
    const d = ov.data || {};
    const kpis = [
      { icon: "chat", tone: "blue", label: "คอมเมนต์ที่รับ", value: d.comments_received, sub: "ดูกิจกรรมทั้งหมด →", to: ["activity"] },
      { icon: "zap", tone: "violet", label: "AI เลือกตอบ", value: d.ai_replies, sub: pct(d.ai_replies, d.comments_received) + "% ของคอมเมนต์", to: ["activity", { status: "PROCESSED" }] },
      { icon: "send", tone: "green", label: "ส่งจริง (SENT)", value: d.replies_sent, sub: "แนบลิงก์ " + fmtNum(d.replies_with_link) + " ครั้ง", to: ["activity", { status: "REPLIED" }] },
      { icon: "alert", tone: num(d.errors) > 0 ? "red" : "gray", label: "ข้อผิดพลาด", value: d.errors, sub: num(d.errors) > 0 ? "ดูรายการ ERROR →" : "ไม่มีข้อผิดพลาด", to: ["activity", { status: "ERROR" }] },
    ];
    const refreshBtn = h("button", { class: "btn ghost icon-btn", "aria-label": "รีเฟรช", onclick: () => viewOverview(main).catch((e) => toast(e.message, "err")) }, icon("refresh"), "รีเฟรช");
    main.replaceChildren(
      h("section", { class: "hero" },
        h("div", null,
          h("h2", { text: "ภาพรวม" }),
          h("p", { class: "muted", text: "สรุปการทำงานของระบบตอบคอมเมนต์ · อัปเดต " + new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) })),
        h("div", { class: "hero-actions" }, refreshBtn)),
      h("div", { class: "kpi-grid" }, kpis.map(kpiCard)),
      trendCard(),
      h("div", { class: "ov-grid" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { text: "เส้นทางคอมเมนต์" }), h("span", { class: "muted small", text: "เทียบกับคอมเมนต์ที่รับ" })), funnel(d),
          h("div", { class: "mini-row" },
            miniStat("AI ข้าม (SKIP)", d.ai_skipped, "gray", ["activity", { status: "SKIPPED" }]),
            miniStat("ร่างคำตอบ DRY_RUN (GENERATED)", d.replies_generated_dry_run, "blue", ["activity", { status: "PROCESSED" }]),
            miniStat("LIVE ค้างสถานะ GENERATED", d.replies_generated_live, num(d.replies_generated_live) > 0 ? "amber" : "gray", ["activity"]))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { text: "แคตตาล็อกและการผูกสินค้า" })),
          meterRow("สินค้าเปิดใช้", d.products_active, d.products_total, "products"),
          meterRow("Mapping เปิดใช้", d.mappings_active, d.mappings_total, "content"),
          h("div", { class: "quick" },
            h("a", { class: "btn small", href: "#discovered", text: "โพสต์ที่ค้นพบ" }),
            h("a", { class: "btn small", href: "#suggestions", text: "สินค้าแนะนำ" }),
            h("a", { class: "btn small", href: "#content", text: "ผูกสินค้ากับโพสต์" })))),
      opsSection(health.data || {}, attention.data || [], () => viewOverview(main)),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", { text: "กิจกรรมล่าสุด" }), h("a", { class: "link-more", href: "#activity" }, "ดูทั้งหมด ", icon("arrow", "sm"))),
        recentFeed(recent.data || [])));
    renderModeInHeader();
  }

  /* ------------------------ operational status ----------------------- */
  const CHECK_FACEBOOK_TEXT = "ตรวจสอบโพสต์บน Facebook ก่อน — ห้าม Retry";
  const RECOVERY_REASON_TEXT = {
    ELIGIBLE: "กู้คืนได้",
    PROTECTED_AMBIGUOUS_SEND: CHECK_FACEBOOK_TEXT,
    PROTECTED_SEND_IN_PROGRESS: CHECK_FACEBOOK_TEXT,
    ALREADY_SENT: "ส่งแล้ว",
    PROTECTED_GRAPH_FAILED: "Facebook ปฏิเสธ (4xx) — ตรวจสอบด้วยตนเอง",
    EXISTING_REPLY: "มีคำตอบแล้ว",
    UNEXPECTED_REPLY_STATE: "สถานะไม่ปกติ — ตรวจสอบด้วยตนเอง",
    TOO_OLD: "เก่ากว่า 24 ชม. — ไม่กู้คืน",
    RECENT_RECEIVED: "กำลังประมวลผล",
    ALREADY_CLAIMED: "กำลังกู้คืนอยู่",
    NOT_ELIGIBLE_STATUS: "-",
  };

  function opsSection(hd, rows, refresh) {
    // [label, value, tone when non-zero] -- a problem metric turns amber/red only when it is > 0.
    const tiles = [
      ["ERROR ที่กู้คืนได้", hd.recoverable_errors, "amber"], ["RECEIVED ค้างที่กู้คืนได้", hd.recoverable_stale_received, "amber"],
      ["LIVE ผลส่งไม่แน่นอน", hd.live_outcome_unknown, "red"], ["LIVE กำลังส่ง (ค้าง)", hd.live_send_in_progress, "amber"],
      ["LIVE Facebook 4xx", hd.live_failed_4xx, "red"], ["LIVE ส่งแล้ว (SENT)", hd.live_sent, "green"],
      ["ERROR 1 ชม. / 24 ชม.", (hd.errors_1h ?? 0) + " / " + (hd.errors_24h ?? 0), num(hd.errors_1h) > 0 ? "red" : num(hd.errors_24h) > 0 ? "amber" : "gray"],
    ];
    const tone = (value, hot) => (hot === "green" || hot === "gray" ? hot : num(value) > 0 ? hot : "ok");
    const table = (page) => h("table", null,
      h("thead", null, h("tr", null, ["เวลา", "คอมเมนต์", "สถานะ", "คำตอบล่าสุด", "การกู้คืน"].map((t) => h("th", { text: t })))),
      h("tbody", null, page.map((r) => h("tr", null,
        h("td", { class: "nowrap small", text: fmtTime(r.created_at) }),
        h("td", null, extLink(fbCommentUrl(r.facebook_comment_id, r.facebook_post_id), r.facebook_comment_id || "", "mono small")),
        h("td", null, badge(r.status, STATUS_KIND[r.status])),
        h("td", { class: "small", text: r.reply ? r.reply.mode + " " + r.reply.status + (r.reply.reason ? " · " + r.reply.reason : "") : "-" }),
        h("td", null, recoveryCell(r, refresh))))));
    const attentionCount = rows.length;
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", { text: "สถานะการทำงาน" }),
        attentionCount ? badge(attentionCount + " รายการต้องดูแล", "red") : h("span", { class: "badge green" }, "ปกติ")),
      h("div", { class: "health-grid" }, tiles.map(([label, value, hot]) => h("div", { class: "health tone-" + tone(value, hot) },
        h("div", { class: "health-value", text: value ?? 0 }), h("div", { class: "health-label", text: label })))),
      attentionCount ? pagedList(rows, table, 10) : h("p", { class: "muted small ok-line" }, icon("check", "sm"), " ไม่มีรายการที่ต้องดูแล"));
  }

  function recoveryCell(r, refresh) {
    const action = r.recovery && r.recovery.action;
    if (action === "RETRY") {
      return h("button", { class: "btn small", text: "Retry", onclick: async (e) => {
        e.target.disabled = true;
        try {
          const res = await fetch("/admin/api/comments/" + r.id + "/retry", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
          const data = await res.json().catch(() => null);
          const d = (data && data.data) || {};
          toast(res.ok ? "กู้คืนแล้ว: " + (d.outcome || "-") : "ไม่สามารถกู้คืน: " + (d.reason || (data && data.error && data.error.code) || res.status), res.ok ? "ok" : "err");
        } catch (ex) { toast(ex.message, "err"); }
        refresh();
      } });
    }
    if (action === "CHECK_FACEBOOK_NO_RETRY") return h("span", { class: "error small", text: CHECK_FACEBOOK_TEXT });
    return h("span", { class: "muted small", text: RECOVERY_REASON_TEXT[r.recovery && r.recovery.reason] || "-" });
  }

  function modePill(mode) {
    return h("span", { class: "badge mode " + (mode === "LIVE" ? "red live" : "blue") }, h("span", { class: "dot" }), mode === "LIVE" ? "LIVE — ตอบจริง" : "DRY_RUN — ไม่โพสต์จริง");
  }

  function renderModeInHeader() {
    const right = $(".topbar-right");
    if (!right || !state.mode) return;
    const existing = right.querySelector(".badge");
    const b = modePill(state.mode);
    if (existing) existing.replaceWith(b); else right.prepend(b);
  }

  /* ----------------------------- products ---------------------------- */
  async function loadProducts(params = "") {
    const res = await api("/admin/api/products" + params);
    state.products = res.data || [];
    return state.products;
  }

  function productForm(product, onDone) {
    const p = product || { name: "", affiliate_url: "", platform: "shopee", keywords: "", description: "", image_url: "", active: 1 };
    const f = {
      name: h("input", { value: p.name || "", maxlength: 200, required: true }),
      affiliate_url: h("input", { value: p.affiliate_url || "", type: "url", placeholder: "https://s.shopee.co.th/...", required: true }),
      platform: h("select", null, ["shopee", "lazada", "tiktok", "other"].map((x) => h("option", { value: x, text: x, selected: p.platform === x }))),
      keywords: h("input", { value: p.keywords || "", placeholder: "คั่นด้วย , เช่น ที่ชาร์จ, หัวชาร์จ" }),
      description: h("textarea", { rows: 3, maxlength: 2000 }, p.description || ""),
      image_url: h("input", { value: p.image_url || "", type: "url", placeholder: "https://… (ไม่บังคับ)" }),
      active: h("input", { type: "checkbox", checked: Number(p.active) === 1 }),
    };
    const err = h("p", { class: "error" });
    const save = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const body = { name: f.name.value, affiliate_url: f.affiliate_url.value, platform: f.platform.value, keywords: f.keywords.value, description: f.description.value, image_url: f.image_url.value || null, active: f.active.checked };
      try {
        if (product) await api("/admin/api/products/" + product.id, { method: "PATCH", body });
        else await api("/admin/api/products", { method: "POST", body });
        toast(product ? "บันทึกสินค้าแล้ว" : "เพิ่มสินค้าแล้ว");
        onDone();
      } catch (ex) { err.textContent = ex.message; }
    };
    const row = (label, el, hint) => h("div", { class: "field" }, h("label", { text: label }), el, hint ? h("div", { class: "hint", text: hint }) : null);
    return h("form", { class: "card form", onsubmit: save },
      h("h3", { text: product ? "แก้ไขสินค้า" : "เพิ่มสินค้า" }),
      row("ชื่อสินค้า *", f.name),
      row("Affiliate URL *", f.affiliate_url, "ระบบจะแนบลิงก์นี้เอง — AI ไม่เห็นและแก้ไขลิงก์ไม่ได้"),
      row("แพลตฟอร์ม", f.platform),
      row("คีย์เวิร์ด", f.keywords, "ข้อมูลประกอบให้ AI เท่านั้น — ระบบไม่ใช้คีย์เวิร์ดเลือกสินค้า ลิงก์ Affiliate ใช้ได้เฉพาะโพสต์/Reel ที่ผูกกับสินค้านี้"),
      row("คำอธิบาย (AI ใช้เป็นข้อมูลจริงเท่านั้น)", f.description),
      row("รูปภาพ", f.image_url),
      h("label", { class: "check" }, f.active, " เปิดใช้งาน"),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit", text: "บันทึก" }), h("button", { class: "btn ghost", type: "button", text: "ยกเลิก", onclick: onDone })));
  }

  /* productToggleHandler (AM-2.6-B) -- product list on/off switch.
   * Turning OFF a product that still has active mapped posts asks first: those
   * posts stop getting a link (the mappings themselves stay as they are).
   * Cancel restores the switch to the persisted state and sends nothing.
   * Turning ON, or OFF with no mapped posts, sends the PATCH directly. */
  function productToggleHandler(p, refresh) {
    return async (e) => {
      const next = e.target.checked;
      const mapped = Number(p.mapping_count) || 0;
      if (!next && Number(p.active) === 1 && mapped > 0) {
        const ok = window.confirm("ปิดสินค้า “" + p.name + "” ?\nโพสต์ที่ผูกสินค้านี้ " + mapped + " โพสต์จะไม่ได้รับลิงก์สินค้าในคำตอบคอมเมนต์อีก จนกว่าจะเปิดสินค้าอีกครั้ง\n(การผูกสินค้ายังคงอยู่ ไม่ถูกลบ)");
        if (!ok) { e.target.checked = Number(p.active) === 1; return; }
      }
      try { await api("/admin/api/products/" + p.id, { method: "PATCH", body: { active: next } }); toast(next ? "เปิดใช้สินค้าแล้ว" : "ปิดสินค้าแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); e.target.checked = !next; }
    };
  }
  /* end productToggleHandler */

  async function viewProducts(main) {
    const search = h("input", { placeholder: "ค้นหาชื่อ / คีย์เวิร์ด", class: "search" });
    const filter = h("select", null, h("option", { value: "", text: "ทั้งหมด" }), h("option", { value: "1", text: "เปิดใช้" }), h("option", { value: "0", text: "ปิดอยู่" }));
    const formSlot = h("div");
    const tableSlot = h("div");
    const nav = state.nav; state.nav = null;
    if (nav && nav.search) search.value = nav.search;
    const refresh = async () => {
      const qs = new URLSearchParams();
      if (search.value.trim()) qs.set("search", search.value.trim());
      if (filter.value) qs.set("active", filter.value);
      const rows = await loadProducts(qs.toString() ? "?" + qs : "");
      tableSlot.replaceChildren(productTable(rows, refresh, formSlot));
    };
    search.addEventListener("input", () => { clearTimeout(search._t); search._t = setTimeout(refresh, 250); });
    filter.addEventListener("change", refresh);
    main.replaceChildren(
      h("div", { class: "row-between" }, h("h2", { text: "สินค้า Affiliate" }),
        h("button", { class: "btn primary", text: "+ เพิ่มสินค้า", onclick: () => formSlot.replaceChildren(productForm(null, () => { formSlot.replaceChildren(); refresh(); })) })),
      h("div", { class: "toolbar" }, search, filter), formSlot, tableSlot);
    await refresh();
  }

  function productTable(rows, refresh, formSlot) {
    if (!rows.length) return h("p", { class: "muted", text: "ยังไม่มีสินค้า — กด “เพิ่มสินค้า”" });
    return pagedList(rows, (page) => h("table", null,
      h("thead", null, h("tr", null, ["", "สินค้า", "แพลตฟอร์ม", "คีย์เวิร์ด", "ลิงก์", "ผูกโพสต์", "สถานะ", ""].map((t) => h("th", { text: t })))),
      h("tbody", null, page.map((p) => h("tr", null,
        h("td", null, p.image_url ? h("img", { src: p.image_url, alt: "", class: "thumb", referrerpolicy: "no-referrer", loading: "lazy" }) : h("div", { class: "thumb empty" })),
        h("td", null, h("strong", { text: p.name }), p.description ? h("div", { class: "muted small", text: p.description.slice(0, 80) }) : null),
        h("td", { text: p.platform || "-" }),
        h("td", { class: "small", text: p.keywords || "-" }),
        h("td", null, p.affiliate_url ? h("a", { href: p.affiliate_url, target: "_blank", rel: "noopener noreferrer", class: "mono small", text: "ทดสอบลิงก์ ↗" }) : "-"),
        h("td", null, Number(p.mapping_count) > 0 ? h("a", { href: "#content", text: String(p.mapping_count), onclick: (e) => { e.preventDefault(); goTo("content"); } }) : h("span", { class: "muted", text: "0" })),
        h("td", null, h("label", { class: "switch" }, h("input", { type: "checkbox", checked: Number(p.active) === 1, onchange: productToggleHandler(p, refresh) }), h("span", { text: Number(p.active) === 1 ? "เปิด" : "ปิด" }))),
        h("td", { class: "nowrap" },
          h("button", { class: "btn small", text: "แก้ไข", onclick: () => formSlot.replaceChildren(productForm(p, () => { formSlot.replaceChildren(); refresh(); })) }),
          h("button", { class: "btn small danger", text: "ลบ", onclick: async () => {
            const msg = Number(p.mapping_count) > 0 ? "สินค้านี้ผูกกับ " + p.mapping_count + " โพสต์ — การลบจะปิด mapping เหล่านั้นด้วย ยืนยัน?" : "ลบสินค้านี้? (เก็บประวัติไว้ ไม่ลบถาวร)";
            if (!window.confirm(msg)) return;
            try { await api("/admin/api/products/" + p.id, { method: "DELETE" }); toast("ลบสินค้าแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); }
          } })))))), 25);
  }

  /* ----------------------------- content ----------------------------- */
  async function viewContent(main) {
    const [content, products] = await Promise.all([api("/admin/api/content"), loadProducts("?active=1")]);
    const { mappings = [], unmapped = [] } = content.data || {};
    const productOptions = (selected) => [h("option", { value: "", text: "— เลือกสินค้า —" }), ...products.map((p) => h("option", { value: p.id, text: p.name, selected: Number(selected) === Number(p.id) }))];

    const postId = h("input", { placeholder: "เช่น 853313081388711_1234567890", class: "mono" });
    const type = h("select", null, h("option", { value: "POST", text: "โพสต์" }), h("option", { value: "REEL", text: "Reel" }));
    const product = h("select", null, productOptions(null));
    const note = h("input", { placeholder: "บันทึก (ไม่บังคับ)" });
    // AM-2.3: "ผูกสินค้า" from a suggestion only PRE-FILLS this form; the operator still saves.
    if (state.prefill) {
      postId.value = state.prefill.post_id;
      type.value = state.prefill.type === "POST" ? "POST" : "REEL";
      product.value = String(state.prefill.product_id);
      note.value = "จากสินค้าแนะนำ #" + state.prefill.suggestion_id;
      state.prefill = null;
    }
    const err = h("p", { class: "error" });
    const refresh = () => viewContent(main);
    const add = async (e) => {
      e.preventDefault(); err.textContent = "";
      try { await api("/admin/api/content", { method: "POST", body: { facebook_post_id: postId.value.trim(), facebook_content_type: type.value, product_id: Number(product.value), note: note.value || null, active: true } }); toast("ผูกสินค้ากับโพสต์แล้ว"); refresh(); }
      catch (ex) { err.textContent = ex.message; }
    };

    main.replaceChildren(
      h("h2", { text: "โพสต์ / Reel ↔ สินค้า" }),
      h("p", { class: "muted", text: "Facebook Graph API ไม่เปิดให้อ่านสินค้าที่แท็กในโพสต์/Reel ของเพจ จึงกำหนดสินค้าของแต่ละโพสต์ที่นี่ ระบบจะแนบลิงก์ Affiliate ของสินค้านั้นเมื่อ AI ตัดสินใจใส่ CTA — การผูกโพสต์/Reel เป็นแหล่งเดียวที่กำหนดสินค้า ระบบไม่เลือกสินค้าจากคีย์เวิร์ดในคอมเมนต์" }),
      h("form", { class: "card form inline", onsubmit: add }, h("div", { class: "field" }, h("label", { text: "Post / Reel ID" }), postId), h("div", { class: "field" }, h("label", { text: "ประเภท" }), type), h("div", { class: "field" }, h("label", { text: "สินค้า" }), product), h("div", { class: "field" }, h("label", { text: "บันทึก" }), note), h("button", { class: "btn primary", type: "submit", text: "ผูกสินค้า" }), err),
      h("h3", { text: "โพสต์ที่ผูกสินค้าแล้ว" }),
      mappings.length ? pagedList(mappings, (page) => h("table", null,
        h("thead", null, h("tr", null, ["โพสต์", "ประเภท", "สินค้า", "คอมเมนต์", "สถานะ", ""].map((t) => h("th", { text: t })))),
        h("tbody", null, page.map((m) => {
          // AM-2.5: changing a live mapping's product needs an explicit confirmation.
          // Cancel restores the persisted value and sends nothing; an error reloads the persisted state.
          const sel = h("select", { onchange: async (e) => {
            const next = products.find((p) => String(p.id) === String(e.target.value));
            const current = products.find((p) => Number(p.id) === Number(m.product_id));
            const ok = window.confirm("เปลี่ยนสินค้าของโพสต์ " + m.facebook_post_id + "\nจาก: " + ((current && current.name) || m.product_name || ("#" + m.product_id)) + "\nเป็น: " + ((next && next.name) || ("#" + e.target.value)) + "\nคำตอบคอมเมนต์ถัดไปของโพสต์นี้จะใช้ลิงก์สินค้าใหม่");
            if (!ok) { e.target.value = String(m.product_id); return; }
            try { await api("/admin/api/content/" + m.id, { method: "PATCH", body: { product_id: Number(e.target.value) } }); toast("เปลี่ยนสินค้าแล้ว"); }
            catch (ex) { toast(ex.message, "err"); }
            refresh();
          } }, productOptions(m.product_id));
          const unusable = Number(m.product_active) !== 1 || m.product_deleted_at;
          return h("tr", null,
            h("td", null, extLink(fbPostUrl(m.facebook_post_id, m.permalink, m.facebook_content_type), m.facebook_post_id, "mono small"), m.note ? h("div", { class: "muted small", text: m.note }) : null),
            h("td", { text: m.facebook_content_type === "REEL" ? "Reel" : "โพสต์" }),
            h("td", null, products.some((p) => Number(p.id) === Number(m.product_id)) ? sel : h("span", { text: m.product_name }), unusable ? h("div", { class: "error small", text: "สินค้าถูกปิด/ลบ — จะไม่แนบลิงก์" }) : null),
            h("td", null, Number(m.comment_count) > 0 ? h("a", { href: "#activity", text: String(m.comment_count), onclick: (e) => { e.preventDefault(); goTo("activity"); } }) : h("span", { class: "muted", text: "0" })),
            h("td", null, h("label", { class: "switch" }, h("input", { type: "checkbox", checked: Number(m.active) === 1, onchange: async (e) => { try { await api("/admin/api/content/" + m.id, { method: "PATCH", body: { active: e.target.checked } }); toast("อัปเดตแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); e.target.checked = !e.target.checked; } } }), h("span", { text: Number(m.active) === 1 ? "เปิด" : "ปิด" }))),
            h("td", null, h("button", { class: "btn small danger", text: "ยกเลิก", onclick: async () => { if (!window.confirm("ยกเลิกการผูกสินค้ากับโพสต์นี้?")) return; try { await api("/admin/api/content/" + m.id, { method: "DELETE" }); toast("ยกเลิกแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); } } })));
        }))), 25) : h("p", { class: "muted", text: "ยังไม่มี mapping" }),
      h("h3", { text: "โพสต์ที่มีคอมเมนต์แต่ยังไม่ผูกสินค้า" }),
      h("p", { class: "muted small", text: "โพสต์เหล่านี้จะไม่ได้รับลิงก์ Affiliate อัตโนมัติ ผูกโพสต์/Reel กับสินค้าก่อน จึงจะใช้ CTA และลิงก์ได้" }),
      unmapped.length ? pagedList(unmapped, (page) => h("table", null,
        h("thead", null, h("tr", null, ["โพสต์", "คอมเมนต์", "ล่าสุด", ""].map((t) => h("th", { text: t })))),
        h("tbody", null, page.map((u) => h("tr", null,
          h("td", null, extLink(fbPostUrl(u.facebook_post_id, u.permalink), u.facebook_post_id, "mono small")),
          h("td", { text: u.comment_count }), h("td", { text: fmtTime(u.last_comment_at) }),
          h("td", null, h("button", { class: "btn small", text: "ผูกสินค้า", onclick: () => { postId.value = u.facebook_post_id; product.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); } })))))), 10) : h("p", { class: "muted", text: "ไม่มี" }));
  }

  /* ------------------------- discovered posts (AM-2) ------------------------- */
  const CANDIDATE_STATUS_LABEL = { DISCOVERED: "ค้นพบใหม่", UPDATED: "ข้อความถูกแก้ไข" };
  const MAPPING_STATE_LABEL = { ACTIVE: "ผูกสินค้าแล้ว", INACTIVE: "ผูกแต่ปิดอยู่", NONE: "ยังไม่ผูก" };
  const MAPPING_STATE_KIND = { ACTIVE: "green", INACTIVE: "gray", NONE: "blue" };
  const RUN_STATUS_KIND = { OK: "green", PARTIAL: "blue", FAILED: "red", RUNNING: "gray" };
  const ERROR_TEXT = {
    TOKEN_MISSING: "ยังไม่ได้ตั้งค่า Page access token",
    TOKEN_INVALID: "Token หมดอายุ/ไม่ถูกต้อง",
    PERMISSION_DENIED: "ไม่มีสิทธิ์อ่านโพสต์ (ตรวจ permission ของแอป)",
    RATE_LIMITED: "Facebook จำกัดอัตราการเรียก — ลองใหม่ภายหลัง",
    TRANSIENT: "Facebook ขัดข้องชั่วคราว — ลองใหม่",
    GRAPH_REJECTED: "Facebook ปฏิเสธคำขอ",
    NETWORK: "เครือข่ายขัดข้อง",
    TIMEOUT: "หมดเวลา",
    MALFORMED: "ข้อมูลจาก Facebook ไม่ถูกต้อง",
    ALREADY_RUNNING: "มีการค้นหาที่กำลังทำงานอยู่",
    RUN_ABANDONED: "การค้นหาถูกยกเลิกกลางคัน",
    ITEM_WRITE_FAILED: "บันทึกบางรายการไม่สำเร็จ",
    INTERNAL_ERROR: "ข้อผิดพลาดภายใน",
  };
  const errText = (code) => (code ? ERROR_TEXT[code] || code : "");
  const preview = (t) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > 140 ? s.slice(0, 140) + "…" : s; };

  async function viewDiscovered(main) {
    const status = h("select", null, h("option", { value: "", text: "ทุกสถานะ" }), ...Object.entries(CANDIDATE_STATUS_LABEL).map(([v, t]) => h("option", { value: v, text: t })));
    const mapping = h("select", null, h("option", { value: "", text: "ทุกการผูก" }), h("option", { value: "unmapped", text: "ยังไม่ผูกสินค้า" }), h("option", { value: "mapped", text: "ผูกสินค้าแล้ว" }), h("option", { value: "inactive", text: "ผูกแต่ปิดอยู่" }));
    const summarySlot = h("div");
    const runsSlot = h("div");
    const tableSlot = h("div");
    let rows = [];

    const table = () => !rows.length ? h("p", { class: "muted", text: "ยังไม่มีโพสต์ที่ค้นพบ — กด “ค้นหาโพสต์ใหม่”" }) : h("table", null,
      h("thead", null, h("tr", null, ["ข้อความ", "ประเภท", "สร้างเมื่อ", "สถานะ", "การผูกสินค้า", "ลิงก์"].map((t) => h("th", { text: t })))),
      h("tbody", null, rows.map((c) => h("tr", null,
        h("td", null, h("div", { text: preview(c.message) || "(ไม่มีข้อความ)", class: c.message ? "" : "muted" }), h("div", null, extLink(fbPostUrl(c.post_id, c.permalink, c.content_type), c.post_id, "mono small")), Number(c.source_count) > 1 ? h("div", { class: "muted small", text: "รวม " + c.source_count + " แหล่งข้อมูล (Reel เดียวกัน)" }) : null),
        h("td", { text: c.content_type === "REEL" ? "Reel" : c.content_type === "POST" ? "โพสต์" : "ไม่ทราบ" }),
        h("td", { class: "nowrap small", text: fmtTime(c.fb_created_time) }),
        h("td", null, badge(CANDIDATE_STATUS_LABEL[c.status] || c.status, c.status === "UPDATED" ? "blue" : "gray")),
        h("td", null, badge(MAPPING_STATE_LABEL[c.mapping_state] || c.mapping_state, MAPPING_STATE_KIND[c.mapping_state])),
        h("td", null, isFacebookUrl(c.permalink) ? h("a", { href: c.permalink, target: "_blank", rel: "noopener noreferrer", class: "small", text: "เปิดบน Facebook ↗" }) : h("span", { class: "muted small", text: "-" }))))));

    const paging = cursorPaging((cursor, size) => {
      const qs = new URLSearchParams({ limit: String(size) });
      if (status.value) qs.set("status", status.value);
      if (mapping.value) qs.set("mapping", mapping.value);
      if (cursor) qs.set("cursor", cursor);
      return api("/admin/api/post-candidates?" + qs);
    }, (data) => { rows = data; tableSlot.replaceChildren(table()); }, 25);
    const load = () => paging.reset();

    const runsTable = (runs) => !runs.length ? h("p", { class: "muted small", text: "ยังไม่เคยค้นหา" }) : h("table", null,
      h("thead", null, h("tr", null, ["เวลา", "ผล", "พบ", "ใหม่", "แก้ไข", "ไม่เปลี่ยน", "ข้าม", "ล้มเหลว", "ข้อผิดพลาด"].map((t) => h("th", { text: t })))),
      h("tbody", null, runs.map((r) => h("tr", null,
        h("td", { class: "nowrap small", text: fmtTime(r.started_at) }),
        h("td", null, badge(r.status, RUN_STATUS_KIND[r.status]), Number(r.truncated) === 1 ? h("div", { class: "muted small", text: "ถึงขีดจำกัดแล้ว" }) : null),
        h("td", { text: r.discovered }), h("td", { text: r.inserted }), h("td", { text: r.updated }), h("td", { text: r.unchanged }), h("td", { text: r.skipped }), h("td", { text: r.failed }),
        h("td", { class: "small" }, r.error_code ? h("div", { class: "error", text: errText(r.error_code) }) : null,
          ...(r.sources || []).filter((s) => !s.ok).map((s) => h("div", { class: "muted", text: s.source + ": " + errText(s.error_code) + (s.graph_code ? " (code " + s.graph_code + ")" : "") })))))));

    const loadRuns = async () => { const res = await api("/admin/api/discovery/runs"); runsSlot.replaceChildren(runsTable(res.data || [])); };

    const run = h("button", { class: "btn primary", text: "ค้นหาโพสต์ใหม่", onclick: async (e) => {
      e.target.disabled = true; summarySlot.replaceChildren(h("p", { class: "muted", text: "กำลังอ่านโพสต์จาก Facebook (อ่านอย่างเดียว)…" }));
      try {
        const res = await fetch("/admin/api/discovery/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
        const data = await res.json().catch(() => null);
        const d = data && data.data;
        if (res.ok && d) {
          summarySlot.replaceChildren(h("p", { class: d.status === "OK" ? "" : "error", text: "ผล: " + d.status + " · พบ " + d.discovered + " · ใหม่ " + d.inserted + " · แก้ไข " + d.updated + " · ไม่เปลี่ยน " + d.unchanged + " · ข้าม " + d.skipped + " · ล้มเหลว " + d.failed + (d.truncated ? " · ถึงขีดจำกัด (อาจยังมีโพสต์เก่ากว่านี้)" : "") + (d.error_code ? " · " + errText(d.error_code) : "") }));
        } else {
          const code = (d && d.error_code) || (data && data.error && data.error.code) || String(res.status);
          summarySlot.replaceChildren(h("p", { class: "error", text: "ค้นหาไม่สำเร็จ: " + errText(code) }));
        }
      } catch (ex) { summarySlot.replaceChildren(h("p", { class: "error", text: ex.message })); }
      e.target.disabled = false;
      try { await Promise.all([load(), loadRuns()]); } catch (ex) { toast(ex.message, "err"); }
    } });

    status.addEventListener("change", () => load().catch((ex) => toast(ex.message, "err")));
    mapping.addEventListener("change", () => load().catch((ex) => toast(ex.message, "err")));
    main.replaceChildren(
      h("div", { class: "row-between" }, h("h2", { text: "โพสต์ที่ค้นพบ" }), run),
      h("p", { class: "muted", text: "อ่านโพสต์/Reel ของเพจจาก Facebook แบบอ่านอย่างเดียวและเก็บไว้เป็นรายการ — ขั้นนี้ไม่ผูกสินค้า ไม่ตอบคอมเมนต์ และไม่แก้ไข mapping ใด ๆ ทั้งสิ้น ผูกสินค้าได้ที่แท็บ “โพสต์ / Reel”" }),
      summarySlot,
      h("div", { class: "toolbar" }, status, mapping),
      tableSlot, paging.bar,
      h("h3", { text: "ประวัติการค้นหา" }), runsSlot);
    await Promise.all([load(), loadRuns()]);
  }

  /* --------------------------- suggestions (AM-2.3) --------------------------- */
  const SUGGESTION_STATUS_LABEL = { PENDING: "รอตรวจสอบ", REJECTED: "ปฏิเสธแล้ว", SUPERSEDED: "ล้าสมัย", APPROVED: "อนุมัติแล้ว" };
  const CONFIDENCE_KIND = { HIGH: "green", MEDIUM: "blue", LOW: "gray" };

  async function viewSuggestions(main) {
    const status = h("select", null, h("option", { value: "PENDING", text: "รอตรวจสอบ" }), h("option", { value: "", text: "ทุกสถานะ" }), h("option", { value: "REJECTED", text: "ปฏิเสธแล้ว" }), h("option", { value: "SUPERSEDED", text: "ล้าสมัย" }), h("option", { value: "APPROVED", text: "อนุมัติแล้ว" }));
    const summarySlot = h("div");
    const tableSlot = h("div");
    let rows = [];

    // AM-2.4: explicit human approval (confirmation dialog) -> server creates ONE mapping.
    const mapButton = (s) => s.mappable ? h("span", null,
      h("button", { class: "btn small primary", text: "ผูกสินค้านี้", onclick: async (e) => {
        if (!window.confirm("ยืนยันผูกสินค้า “" + (s.product_name || ("#" + s.product_id)) + "” กับโพสต์ " + s.representative_post_id + " ?\nระบบจะสร้าง mapping จริง และคำตอบคอมเมนต์ถัดไปของโพสต์นี้จะแนบลิงก์สินค้านี้")) return;
        e.target.disabled = true;
        try { await api("/admin/api/suggestions/" + s.id + "/approve", { method: "POST", body: {} }); toast("ผูกสินค้าแล้ว"); await load(); }
        catch (ex) { toast(ex.message, "err"); e.target.disabled = false; }
      } }),
      h("button", { class: "btn small ghost", text: "แก้ไขในฟอร์ม", onclick: () => {
        state.prefill = { post_id: s.representative_post_id, product_id: s.product_id, type: s.content_type, suggestion_id: s.id };
        goTo("content");
      } })) : h("span", { class: "muted small", text: s.status === "APPROVED" ? "ผูกสินค้าแล้ว" : s.status !== "PENDING" ? "-" : !s.product_id ? "ไม่มีสินค้าที่ตรง" : !s.product_usable ? "สินค้าถูกปิด/ลบ" : "ยังไม่มีรหัสโพสต์ของเพจ" });

    const rejectButton = (s) => s.status === "PENDING" ? h("button", { class: "btn small danger", text: "ปฏิเสธ", onclick: async (e) => {
      e.target.disabled = true;
      try { await api("/admin/api/suggestions/" + s.id + "/reject", { method: "POST", body: {} }); toast("ปฏิเสธแล้ว"); await load(); } catch (ex) { toast(ex.message, "err"); e.target.disabled = false; }
    } }) : null;

    const table = () => !rows.length ? h("p", { class: "muted", text: "ยังไม่มีสินค้าแนะนำ — กด “สร้างคำแนะนำ”" }) : h("table", null,
      h("thead", null, h("tr", null, ["โพสต์", "สินค้าแนะนำ", "ความมั่นใจ", "เหตุผล", "คะแนนคัดกรอง", "สถานะ", "เวลา", ""].map((t) => h("th", { text: t })))),
      h("tbody", null, rows.map((s) => h("tr", null,
        h("td", null, h("div", { text: preview(s.message) || "(ไม่มีข้อความ)" }), isFacebookUrl(s.permalink) ? h("a", { href: s.permalink, target: "_blank", rel: "noopener noreferrer", class: "ext mono small", text: s.representative_post_id }) : extLink(fbPostUrl(s.representative_post_id, null, s.content_type), s.representative_post_id, "mono small")),
        h("td", null, s.product_id ? productLink(s.product_name || ("#" + s.product_id)) : h("span", { class: "muted", text: "ไม่มีสินค้าที่ตรง" })),
        h("td", null, badge(s.confidence, CONFIDENCE_KIND[s.confidence])),
        h("td", { class: "small", text: s.reason || "" }),
        h("td", { text: s.prefilter_score }),
        h("td", null, badge(SUGGESTION_STATUS_LABEL[s.status] || s.status, s.status === "PENDING" ? "blue" : "gray")),
        h("td", { class: "nowrap small", text: fmtTime(s.created_at) }),
        h("td", { class: "nowrap" }, mapButton(s), rejectButton(s))))));

    const paging = cursorPaging((cursor, size) => {
      const qs = new URLSearchParams({ limit: String(size) });
      if (status.value) qs.set("status", status.value);
      if (cursor) qs.set("cursor", cursor);
      return api("/admin/api/suggestions?" + qs);
    }, (data) => { rows = data; tableSlot.replaceChildren(table()); }, 25);
    // After approve/reject, stay on the current page (rows change status, not position).
    const load = () => paging.reload();

    const generate = h("button", { class: "btn primary", text: "สร้างคำแนะนำ", onclick: async (e) => {
      e.target.disabled = true; summarySlot.replaceChildren(h("p", { class: "muted", text: "กำลังวิเคราะห์ (สูงสุด 5 โพสต์ต่อครั้ง)…" }));
      try {
        const res = await fetch("/admin/api/suggestions/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
        const data = await res.json().catch(() => null);
        const d = data && data.data;
        if (d) summarySlot.replaceChildren(h("p", { class: d.status === "OK" ? "" : "error", text: "ผล: " + d.status + " · เข้าเกณฑ์ " + d.eligible + " · วิเคราะห์ " + d.processed + " · แนะนำ " + d.suggested + " · ไม่ตรง " + d.no_match + " · ข้าม " + d.skipped + " · ล้มเหลว " + d.failed + " · ล้าสมัย " + d.superseded + (d.error_code ? " · " + d.error_code : "") }));
        else summarySlot.replaceChildren(h("p", { class: "error", text: "สร้างคำแนะนำไม่สำเร็จ: " + ((data && data.error && data.error.code) || res.status) }));
      } catch (ex) { summarySlot.replaceChildren(h("p", { class: "error", text: ex.message })); }
      e.target.disabled = false;
      try { await paging.reset(); } catch (ex) { toast(ex.message, "err"); }
    } });

    status.addEventListener("change", () => paging.reset().catch((ex) => toast(ex.message, "err")));
    main.replaceChildren(
      h("div", { class: "row-between" }, h("h2", { text: "สินค้าแนะนำ" }), generate),
      h("p", { class: "muted", text: "AI แนะนำสินค้าจากรายการที่ระบบคัดกรองแล้วเท่านั้น สำหรับโพสต์/Reel ที่ยังไม่ผูกสินค้า — เป็นคำแนะนำให้ตรวจสอบเท่านั้น ระบบไม่ผูกสินค้าเอง “ผูกสินค้านี้” จะถามยืนยันก่อน แล้วจึงสร้าง mapping ให้ (หรือกด “แก้ไขในฟอร์ม” เพื่อเปิดฟอร์มเดิม)" }),
      summarySlot, h("div", { class: "toolbar" }, status), tableSlot, paging.bar);
    await paging.reset();
  }

  /* ----------------------------- activity ---------------------------- */
  function activityTable(rows) {
    if (!rows.length) return h("p", { class: "muted", text: "ยังไม่มีคอมเมนต์" });
    return h("table", null,
      h("thead", null, h("tr", null, ["เวลา", "คอมเมนต์", "AI", "คำตอบ", "สินค้า", "โหมด", "สถานะ"].map((t) => h("th", { text: t })))),
      h("tbody", null, rows.map((c) => h("tr", { class: "clickable", tabindex: "0", title: "คลิกเพื่อดูรายละเอียด", onclick: (e) => { if (!e.target.closest("a,button")) openComment(c.id); }, onkeydown: (e) => { if (e.key === "Enter") openComment(c.id); } },
        h("td", { class: "nowrap small", text: fmtTime(c.created_at) }),
        h("td", null, h("div", { class: "small muted", text: c.author_name || "" }), h("div", { text: c.comment_text || "" }), commentLinks(c)),
        h("td", null, c.ai_action ? badge(c.ai_action, c.ai_action === "REPLY" ? "blue" : "gray") : "-"),
        h("td", { class: "reply" }, c.reply && c.reply.response_text ? linkify(c.reply.response_text, "pre") : h("span", { class: "muted small", text: (c.reply && c.reply.reason) || "-" })),
        h("td", null, c.matched_product ? h("div", null, h("div", null, productLink(c.matched_product.name)), h("div", { class: "muted small", text: SOURCE_LABEL[c.product_source] || "" })) : "-"),
        h("td", null, c.reply ? badge(c.reply.mode, c.reply.mode === "LIVE" ? "red" : "blue") : "-"),
        h("td", null, badge(c.status, STATUS_KIND[c.status]), c.reply ? h("div", null, badge(c.reply.status, STATUS_KIND[c.reply.status])) : null)))));
  }

  async function viewActivity(main) {
    const filter = h("select", null, ["", "PROCESSED", "REPLIED", "SKIPPED", "ERROR", "RECEIVED"].map((s) => h("option", { value: s, text: s || "ทุกสถานะ" })));
    const nav = state.nav; state.nav = null;
    if (nav && nav.status) filter.value = nav.status;
    // U4: search -- text/author/comment id, date range (Thai local days), post.
    const q = h("input", { type: "search", class: "search", placeholder: "ค้นหาข้อความ / ชื่อ / Comment ID", maxlength: 100 });
    const from = h("input", { type: "date", "aria-label": "ตั้งแต่วันที่" });
    const to = h("input", { type: "date", "aria-label": "ถึงวันที่" });
    const post = h("input", { class: "mono", placeholder: "Post ID (ไม่บังคับ)", maxlength: 60 });
    if (nav && nav.post) post.value = nav.post;
    const clear = h("button", { type: "button", class: "btn small ghost", text: "ล้างตัวกรอง" });
    const slot = h("div");
    const paging = cursorPaging((cursor, size) => {
      const qs = new URLSearchParams({ limit: String(size) });
      if (filter.value) qs.set("status", filter.value);
      if (q.value.trim()) qs.set("q", q.value.trim());
      if (from.value) qs.set("from", from.value);
      if (to.value) qs.set("to", to.value);
      if (post.value.trim()) qs.set("post", post.value.trim());
      if (cursor) qs.set("cursor", cursor);
      return api("/admin/api/comments?" + qs);
    }, (rows) => slot.replaceChildren(activityTable(rows)), 25);
    const reload = () => paging.reset().catch((ex) => toast(ex.message, "err"));
    let t = null;
    q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(reload, 300); });
    post.addEventListener("input", () => { clearTimeout(t); t = setTimeout(reload, 400); });
    for (const el of [filter, from, to]) el.addEventListener("change", reload);
    clear.addEventListener("click", () => { q.value = ""; from.value = ""; to.value = ""; post.value = ""; filter.value = ""; reload(); });
    main.replaceChildren(
      h("div", { class: "row-between" }, h("h2", { text: "กิจกรรมคอมเมนต์" })),
      h("div", { class: "toolbar filters" }, q, filter, h("label", { class: "inline-field" }, "ตั้งแต่ ", from), h("label", { class: "inline-field" }, "ถึง ", to), post, clear),
      h("p", { class: "muted small", text: "คลิกแถวเพื่อดูรายละเอียดและประวัติคำตอบทั้งหมด" }),
      slot, paging.bar);
    await paging.reset();
  }

  /* ----------------------------- performance (U5) ---------------------------- */
  async function viewPerformance(main) {
    const [posts, products] = await Promise.all([api("/admin/api/stats/posts"), api("/admin/api/stats/products")]);
    const rate = (a, b) => (num(b) ? pct(a, b) + "%" : "-");
    const postTable = (page) => h("table", null,
      h("thead", null, h("tr", null, ["โพสต์", "สินค้า", "คอมเมนต์", "AI ตอบ", "ส่งจริง", "แนบลิงก์", "อัตราตอบ", "ล่าสุด"].map((t, i) => h("th", { text: t, class: i >= 2 && i <= 6 ? "num" : null })))),
      h("tbody", null, page.map((r) => h("tr", null,
        h("td", null, extLink(fbPostUrl(r.post_id, r.permalink), r.post_id, "mono small")),
        h("td", null, r.product_name ? h("span", null, productLink(r.product_name), r.mapping_active === 0 ? h("span", { class: "muted small", text: " (ปิด)" }) : null) : h("a", { href: "#content", class: "small", text: "ยังไม่ผูก → ผูกสินค้า", onclick: (e) => { e.preventDefault(); goTo("content"); } })),
        h("td", { class: "num" }, h("a", { href: "#activity", text: fmtNum(r.comments), title: "ดูคอมเมนต์ของโพสต์นี้", onclick: (e) => { e.preventDefault(); goTo("activity", { post: r.post_id }); } })),
        h("td", { class: "num", text: fmtNum(r.ai_replies) }),
        h("td", { class: "num", text: fmtNum(r.sent) }),
        h("td", { class: "num", text: fmtNum(r.sent_with_link) }),
        h("td", { class: "num", text: rate(r.ai_replies, r.comments) }),
        h("td", { class: "nowrap small", text: fmtTime(r.last_comment_at) })))));
    const productTable = (page) => h("table", null,
      h("thead", null, h("tr", null, ["สินค้า", "สถานะ", "โพสต์ที่ผูก", "คอมเมนต์", "AI ตอบ", "ส่งจริง", "แนบลิงก์"].map((t, i) => h("th", { text: t, class: i >= 2 ? "num" : null })))),
      h("tbody", null, page.map((r) => h("tr", null,
        h("td", null, productLink(r.name)),
        h("td", null, r.deleted_at ? badge("ลบแล้ว", "gray") : r.active === 1 ? badge("เปิด", "green") : badge("ปิด", "gray")),
        h("td", { class: "num" }, r.mapped_posts ? h("a", { href: "#content", text: fmtNum(r.mapped_posts), onclick: (e) => { e.preventDefault(); goTo("content"); } }) : h("span", { class: "muted", text: "0" })),
        h("td", { class: "num", text: fmtNum(r.comments) }),
        h("td", { class: "num", text: fmtNum(r.ai_replies) }),
        h("td", { class: "num", text: fmtNum(r.sent) }),
        h("td", { class: "num", text: fmtNum(r.sent_with_link) })))));
    const p = posts.data || []; const pr = products.data || [];
    main.replaceChildren(
      h("h2", { text: "ผลงานรายโพสต์และรายสินค้า" }),
      h("p", { class: "muted", text: "ดูว่าโพสต์/สินค้าไหนมีคนคอมเมนต์มาก ตอบไปกี่ครั้ง และแนบลิงก์ Affiliate ไปกี่ครั้ง (นับเฉพาะคำตอบ LIVE ที่ส่งสำเร็จ) — ยังไม่รวมจำนวนคลิกลิงก์" }),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { text: "รายโพสต์" }), h("span", { class: "muted small", text: fmtNum(p.length) + " โพสต์" })),
        p.length ? pagedList(p, postTable, 10) : h("p", { class: "muted", text: "ยังไม่มีข้อมูล" })),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", { text: "รายสินค้า" }), h("span", { class: "muted small", text: fmtNum(pr.length) + " สินค้า" })),
        pr.length ? pagedList(pr, productTable, 10) : h("p", { class: "muted", text: "ยังไม่มีข้อมูล" })));
  }

  /* ----------------------------- settings ---------------------------- */
  /* Upgrade U1: Telegram alerts + Page-token health (read-only check). */
  const TOKEN_STATUS_TEXT = { OK: ["ใช้งานได้", "green"], MISSING: ["ยังไม่ได้ตั้งค่า", "red"], INVALID: ["หมดอายุ/ถูกยกเลิก", "red"], PERMISSION_DENIED: ["สิทธิ์ไม่พอ", "red"], PAGE_MISMATCH: ["ไม่ใช่ token ของเพจนี้", "red"] };
  const ALERT_ERROR_TEXT = { NOT_CONFIGURED: "ยังไม่ได้ตั้งค่า Telegram", TELEGRAM_BAD_TOKEN: "Bot token ไม่ถูกต้อง", TELEGRAM_BAD_CHAT: "Chat ID ไม่ถูกต้อง หรือยังไม่ได้กด Start กับบอท", TELEGRAM_RATE_LIMITED: "Telegram จำกัดอัตราการส่ง", TELEGRAM_TIMEOUT: "Telegram ไม่ตอบ (หมดเวลา)", TELEGRAM_NETWORK: "เชื่อมต่อ Telegram ไม่ได้" };

  function alertsCard(a, reload) {
    const st = a.state || {};
    const tok = TOKEN_STATUS_TEXT[st.token_status];
    const kv = (k, v) => h("tr", null, h("th", { text: k }), h("td", null, v));
    const btn = (label, path, okText) => h("button", { class: "btn small", text: label, onclick: async (e) => {
      e.target.disabled = true;
      try {
        const r = await api(path, { method: "POST", body: {} });
        const d = r.data || {};
        toast(okText(d));
      } catch (ex) { toast(ex.message, "err"); }
      e.target.disabled = false;
      reload();
    } });
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", { text: "การแจ้งเตือน (Telegram) และสุขภาพ Page token" }),
        a.telegram_configured ? badge("Telegram พร้อมใช้", "green") : badge("ยังไม่ได้ตั้งค่า Telegram", "gray")),
      h("p", { class: "muted small", text: "ระบบตรวจทุก 5 นาที (อ่านอย่างเดียว) และส่งข้อความเฉพาะเมื่อมีปัญหาใหม่ เช่น ERROR ใหม่ ผลส่ง LIVE ไม่แน่นอน Facebook ปฏิเสธ คอมเมนต์ค้าง หรือ token ใช้ไม่ได้ — และแจ้งอีกครั้งเมื่อกลับมาปกติ ระบบไม่ Retry และไม่แก้ข้อมูลใด ๆ" }),
      h("table", { class: "kv" }, h("tbody", null,
        kv("Page access token", tok ? badge(tok[0], tok[1]) : h("span", { class: "muted", text: "ยังไม่ได้ตรวจ" })),
        kv("ตรวจ token ล่าสุด", h("span", { text: fmtTime(st.token_checked_at) })),
        kv("ตรวจสุขภาพล่าสุด", h("span", { text: fmtTime(st.last_check_at) })),
        kv("ส่งแจ้งเตือนล่าสุด", h("span", { text: fmtTime(st.last_sent_at) })),
        kv("ปัญหาการส่งล่าสุด", st.last_error ? h("span", { class: "error small", text: ALERT_ERROR_TEXT[st.last_error] || st.last_error }) : h("span", { class: "muted", text: "-" })))),
      h("div", { class: "actions" },
        btn("ตรวจตอนนี้", "/admin/api/alerts/check", (d) => "ตรวจแล้ว: แจ้งเตือน " + (d.alerts || 0) + " · กลับมาปกติ " + (d.recovered || 0) + (d.send_error ? " · " + (ALERT_ERROR_TEXT[d.send_error] || d.send_error) : "")),
        a.telegram_configured ? btn("ส่งข้อความทดสอบ", "/admin/api/alerts/test", () => "ส่งข้อความทดสอบแล้ว — ตรวจใน Telegram") : null),
      a.telegram_configured ? null : h("p", { class: "hint", text: "ตั้งค่า: สร้างบอทกับ @BotFather แล้วรัน npx wrangler secret put TELEGRAM_BOT_TOKEN และ npx wrangler secret put TELEGRAM_CHAT_ID บน Pi (ดู docs/OPERATIONS.md)" }));
  }

  /* Upgrade U7: daily housekeeping (discovery + review-only suggestions). */
  function dailyCard(dj, reload) {
    const st = dj.state || {};
    const d = st.discovery; const s = st.suggestions;
    const kv = (k, v) => h("tr", null, h("th", { text: k }), h("td", null, v));
    const run = h("button", { class: "btn small", text: "รันตอนนี้", onclick: async (e) => {
      if (!window.confirm("รันค้นหาโพสต์ใหม่และสร้างคำแนะนำสินค้าตอนนี้?\n(อ่านโพสต์จาก Facebook แบบอ่านอย่างเดียว และเรียก AI สูงสุด 5 ครั้ง — ไม่ผูกสินค้าเอง)")) return;
      e.target.disabled = true;
      try { const r = (await api("/admin/api/daily/run", { method: "POST", body: {} })).data || {}; toast("เสร็จแล้ว: โพสต์ใหม่ " + ((r.discovery && r.discovery.inserted) || 0) + " · คำแนะนำใหม่ " + ((r.suggestions && r.suggestions.suggested) || 0)); }
      catch (ex) { toast(ex.message, "err"); }
      e.target.disabled = false; reload();
    } });
    return h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", { text: "งานประจำวันอัตโนมัติ (ทุกวัน " + (dj.schedule || "06:17") + ")" }),
        h("span", null, badge(dj.auto_discovery ? "ค้นหาโพสต์: เปิด" : "ค้นหาโพสต์: ปิด", dj.auto_discovery ? "green" : "gray"), " ", badge(dj.auto_suggestions ? "คำแนะนำ AI: เปิด" : "คำแนะนำ AI: ปิด", dj.auto_suggestions ? "green" : "gray"))),
      h("p", { class: "muted small", text: "ค้นหาโพสต์/Reel ใหม่ (อ่านอย่างเดียว) แล้วให้ AI แนะนำสินค้า จากนั้นส่งสรุปเข้า Telegram — การผูกสินค้ายังต้องให้คุณกดอนุมัติเองทุกครั้ง" }),
      h("table", { class: "kv" }, h("tbody", null,
        kv("รันล่าสุด", h("span", { text: fmtTime(st.ran_at) })),
        kv("ค้นหาโพสต์", d ? h("span", { text: d.status + " · ใหม่ " + d.inserted + " · แก้ไข " + d.updated + (d.error ? " · " + d.error : "") }) : h("span", { class: "muted", text: "-" })),
        kv("คำแนะนำ AI", s ? h("span", { text: s.status + " · แนะนำ " + s.suggested + " · ไม่ตรง " + s.no_match + (s.error ? " · " + s.error : "") }) : h("span", { class: "muted", text: "-" })),
        kv("รออนุมัติ", st.pending ? h("a", { href: "#suggestions", text: st.pending + " รายการ →" }) : h("span", { class: "muted", text: st.pending === 0 ? "0" : "-" })))),
      h("div", { class: "actions" }, run));
  }

  async function viewSettings(main) {
    const [res, alerts, daily] = await Promise.all([api("/admin/api/settings"), api("/admin/api/alerts").catch(() => ({ data: { telegram_configured: false, state: null } })), api("/admin/api/daily").catch(() => ({ data: {} }))]);
    const s = res.data || {};
    state.mode = s.reply_mode;
    const kv = (k, v) => h("tr", null, h("th", { text: k }), h("td", { class: "mono", text: v }));
    main.replaceChildren(
      h("h2", { text: "ตั้งค่า (อ่านอย่างเดียว)" }),
      h("div", { class: "card" }, h("table", { class: "kv" }, h("tbody", null,
        kv("REPLY_MODE (มีผลจริง)", s.reply_mode), kv("REPLY_MODE (ที่ตั้งไว้)", s.reply_mode_requested), kv("PAGE_ID", s.page_id), kv("Hermes", s.hermes_host),
        kv("HERMES_TIMEOUT_MS", s.hermes_timeout_ms), kv("GRAPH_API_VERSION", s.graph_api_version), kv("MAX_REPLY_LENGTH", s.max_reply_length),
        kv("โดเมนลิงก์ที่อนุญาต", (s.affiliate_allowed_hosts || []).join(", ")),
        ...Object.entries(s.secrets_present || {}).map(([k, v]) => kv(k, v ? "ตั้งค่าแล้ว" : "ยังไม่ตั้งค่า"))))),
      alertsCard(alerts.data || {}, () => viewSettings(main)),
      dailyCard(daily.data || {}, () => viewSettings(main)),
      h("div", { class: "card note" }, h("h3", { text: "การเปิด LIVE" }), h("p", { text: "ระบบจะตอบคอมเมนต์จริงเฉพาะเมื่อ REPLY_MODE = LIVE และตั้งค่า PAGE_ACCESS_TOKEN แล้วเท่านั้น การเปลี่ยนโหมดทำได้โดยการ deploy อย่างตั้งใจ (ดู docs/OPERATIONS.md) ไม่สามารถเปิดจากหน้านี้ได้" })));
    renderModeInHeader();
  }

  /* ------------------------------ render ----------------------------- */
  async function render() {
    const root = $("#app");
    root.replaceChildren();
    if (state.authenticated === null) {
      try { const r = await fetch("/admin/session", { credentials: "same-origin" }); state.authenticated = (await r.json()).authenticated === true; } catch { state.authenticated = false; }
    }
    if (!state.authenticated) return renderLogin(root);
    renderShell(root);
  }

  window.addEventListener("hashchange", () => { state.tab = tabFromHash(); render(); window.scrollTo(0, 0); });
  document.addEventListener("DOMContentLoaded", () => { state.tab = tabFromHash(); render(); });
})();
