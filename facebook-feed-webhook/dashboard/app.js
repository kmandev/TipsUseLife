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

  const state = { authenticated: null, tab: "overview", mode: null, products: [], toast: null };

  function toast(message, kind = "ok") {
    state.toast = { message, kind };
    const el = $("#toast");
    if (el) { el.textContent = message; el.className = "toast show " + kind; }
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { const t = $("#toast"); if (t) t.className = "toast"; }, 3500);
  }

  function badge(text, kind) { return h("span", { class: "badge " + (kind || ""), text }); }

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
    ["activity", "กิจกรรมคอมเมนต์"],
    ["settings", "ตั้งค่า"],
  ];

  function renderShell(root) {
    const nav = h("nav", { class: "tabs" }, TABS.map(([key, label]) =>
      h("button", { class: "tab" + (state.tab === key ? " active" : ""), text: label, onclick: () => { state.tab = key; render(); } })));
    const modeBadge = state.mode ? badge(state.mode === "LIVE" ? "LIVE — ตอบจริง" : "DRY_RUN — ไม่โพสต์จริง", state.mode === "LIVE" ? "red" : "blue") : null;
    const logout = h("button", { class: "btn ghost", text: "ออกจากระบบ", onclick: async () => { await fetch("/admin/logout", { method: "POST", credentials: "same-origin" }); state.authenticated = false; render(); } });
    root.appendChild(h("header", { class: "topbar" },
      h("div", { class: "brand" }, h("div", { class: "logo", text: "T" }), h("div", null, h("strong", { text: "TipsUseLife AI" }), h("div", { class: "muted", text: "Facebook Page Comment Agent" }))),
      h("div", { class: "topbar-right" }, modeBadge, logout)));
    root.appendChild(nav);
    const main = h("main", { id: "view" }, h("p", { class: "muted", text: "กำลังโหลด…" }));
    root.appendChild(main);
    root.appendChild(h("div", { id: "toast", class: "toast" }));
    const views = { overview: viewOverview, products: viewProducts, content: viewContent, activity: viewActivity, settings: viewSettings };
    views[state.tab](main).catch((e) => { main.replaceChildren(h("p", { class: "error", text: e.message })); });
  }

  /* ----------------------------- overview ---------------------------- */
  async function viewOverview(main) {
    const [ov, recent, health, attention] = await Promise.all([api("/admin/api/overview"), api("/admin/comments?limit=10"), api("/admin/api/health"), api("/admin/api/recovery")]);
    state.mode = ov.mode;
    const d = ov.data || {};
    const tiles = [
      ["คอมเมนต์ที่รับ", d.comments_received], ["AI เลือกตอบ", d.ai_replies], ["AI ข้าม (SKIP)", d.ai_skipped],
      ["ร่างคำตอบ DRY_RUN (GENERATED)", d.replies_generated_dry_run], ["LIVE ค้างสถานะ GENERATED", d.replies_generated_live], ["ส่งจริง (SENT)", d.replies_sent],
      ["คำตอบที่แนบลิงก์", d.replies_with_link], ["สินค้าเปิดใช้", (d.products_active ?? 0) + " / " + (d.products_total ?? 0)],
      ["Mapping เปิดใช้", (d.mappings_active ?? 0) + " / " + (d.mappings_total ?? 0)], ["ข้อผิดพลาด", d.errors],
    ];
    main.replaceChildren(
      h("h2", { text: "ภาพรวม" }),
      h("div", { class: "tiles" }, tiles.map(([label, value]) => h("div", { class: "tile" }, h("div", { class: "tile-value", text: value ?? 0 }), h("div", { class: "tile-label", text: label })))),
      opsSection(health.data || {}, attention.data || [], () => viewOverview(main)),
      h("h3", { text: "กิจกรรมล่าสุด" }),
      activityTable(recent.data || []));
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
    const tiles = [
      ["ERROR ที่กู้คืนได้", hd.recoverable_errors], ["RECEIVED ค้างที่กู้คืนได้", hd.recoverable_stale_received],
      ["LIVE ผลส่งไม่แน่นอน", hd.live_outcome_unknown], ["LIVE กำลังส่ง (ค้าง)", hd.live_send_in_progress],
      ["LIVE Facebook 4xx", hd.live_failed_4xx], ["LIVE ส่งแล้ว (SENT)", hd.live_sent],
      ["ERROR 1 ชม. / 24 ชม.", (hd.errors_1h ?? 0) + " / " + (hd.errors_24h ?? 0)],
    ];
    return h("div", null,
      h("h3", { text: "สถานะการทำงาน" }),
      h("div", { class: "tiles" }, tiles.map(([label, value]) => h("div", { class: "tile" }, h("div", { class: "tile-value", text: value ?? 0 }), h("div", { class: "tile-label", text: label })))),
      rows.length ? h("table", null,
        h("thead", null, h("tr", null, ["เวลา", "คอมเมนต์", "สถานะ", "คำตอบล่าสุด", "การกู้คืน"].map((t) => h("th", { text: t })))),
        h("tbody", null, rows.map((r) => h("tr", null,
          h("td", { class: "nowrap small", text: fmtTime(r.created_at) }),
          h("td", { class: "mono small", text: r.facebook_comment_id || "" }),
          h("td", null, badge(r.status, STATUS_KIND[r.status])),
          h("td", { class: "small", text: r.reply ? r.reply.mode + " " + r.reply.status + (r.reply.reason ? " · " + r.reply.reason : "") : "-" }),
          h("td", null, recoveryCell(r, refresh)))))) : h("p", { class: "muted", text: "ไม่มีรายการที่ต้องดูแล" }));
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

  function renderModeInHeader() {
    const right = $(".topbar-right");
    if (!right || !state.mode) return;
    const existing = right.querySelector(".badge");
    const b = badge(state.mode === "LIVE" ? "LIVE — ตอบจริง" : "DRY_RUN — ไม่โพสต์จริง", state.mode === "LIVE" ? "red" : "blue");
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

  async function viewProducts(main) {
    const search = h("input", { placeholder: "ค้นหาชื่อ / คีย์เวิร์ด", class: "search" });
    const filter = h("select", null, h("option", { value: "", text: "ทั้งหมด" }), h("option", { value: "1", text: "เปิดใช้" }), h("option", { value: "0", text: "ปิดอยู่" }));
    const formSlot = h("div");
    const tableSlot = h("div");
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
    return h("table", null,
      h("thead", null, h("tr", null, ["", "สินค้า", "แพลตฟอร์ม", "คีย์เวิร์ด", "ลิงก์", "ผูกโพสต์", "สถานะ", ""].map((t) => h("th", { text: t })))),
      h("tbody", null, rows.map((p) => h("tr", null,
        h("td", null, p.image_url ? h("img", { src: p.image_url, alt: "", class: "thumb", referrerpolicy: "no-referrer", loading: "lazy" }) : h("div", { class: "thumb empty" })),
        h("td", null, h("strong", { text: p.name }), p.description ? h("div", { class: "muted small", text: p.description.slice(0, 80) }) : null),
        h("td", { text: p.platform || "-" }),
        h("td", { class: "small", text: p.keywords || "-" }),
        h("td", null, p.affiliate_url ? h("a", { href: p.affiliate_url, target: "_blank", rel: "noopener noreferrer", class: "mono small", text: "ทดสอบลิงก์ ↗" }) : "-"),
        h("td", { text: p.mapping_count ?? 0 }),
        h("td", null, h("label", { class: "switch" }, h("input", { type: "checkbox", checked: Number(p.active) === 1, onchange: async (e) => {
          try { await api("/admin/api/products/" + p.id, { method: "PATCH", body: { active: e.target.checked } }); toast(e.target.checked ? "เปิดใช้สินค้าแล้ว" : "ปิดสินค้าแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); e.target.checked = !e.target.checked; }
        } }), h("span", { text: Number(p.active) === 1 ? "เปิด" : "ปิด" }))),
        h("td", { class: "nowrap" },
          h("button", { class: "btn small", text: "แก้ไข", onclick: () => formSlot.replaceChildren(productForm(p, () => { formSlot.replaceChildren(); refresh(); })) }),
          h("button", { class: "btn small danger", text: "ลบ", onclick: async () => {
            const msg = Number(p.mapping_count) > 0 ? "สินค้านี้ผูกกับ " + p.mapping_count + " โพสต์ — การลบจะปิด mapping เหล่านั้นด้วย ยืนยัน?" : "ลบสินค้านี้? (เก็บประวัติไว้ ไม่ลบถาวร)";
            if (!window.confirm(msg)) return;
            try { await api("/admin/api/products/" + p.id, { method: "DELETE" }); toast("ลบสินค้าแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); }
          } }))))));
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
      mappings.length ? h("table", null,
        h("thead", null, h("tr", null, ["โพสต์", "ประเภท", "สินค้า", "คอมเมนต์", "สถานะ", ""].map((t) => h("th", { text: t })))),
        h("tbody", null, mappings.map((m) => {
          const sel = h("select", { onchange: async (e) => { try { await api("/admin/api/content/" + m.id, { method: "PATCH", body: { product_id: Number(e.target.value) } }); toast("เปลี่ยนสินค้าแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); } } }, productOptions(m.product_id));
          const unusable = Number(m.product_active) !== 1 || m.product_deleted_at;
          return h("tr", null,
            h("td", null, m.permalink ? h("a", { href: m.permalink, target: "_blank", rel: "noopener noreferrer", class: "mono small", text: m.facebook_post_id }) : h("span", { class: "mono small", text: m.facebook_post_id }), m.note ? h("div", { class: "muted small", text: m.note }) : null),
            h("td", { text: m.facebook_content_type === "REEL" ? "Reel" : "โพสต์" }),
            h("td", null, products.some((p) => Number(p.id) === Number(m.product_id)) ? sel : h("span", { text: m.product_name }), unusable ? h("div", { class: "error small", text: "สินค้าถูกปิด/ลบ — จะไม่แนบลิงก์" }) : null),
            h("td", { text: m.comment_count ?? 0 }),
            h("td", null, h("label", { class: "switch" }, h("input", { type: "checkbox", checked: Number(m.active) === 1, onchange: async (e) => { try { await api("/admin/api/content/" + m.id, { method: "PATCH", body: { active: e.target.checked } }); toast("อัปเดตแล้ว"); } catch (ex) { toast(ex.message, "err"); e.target.checked = !e.target.checked; } } }), h("span", { text: Number(m.active) === 1 ? "เปิด" : "ปิด" }))),
            h("td", null, h("button", { class: "btn small danger", text: "ยกเลิก", onclick: async () => { if (!window.confirm("ยกเลิกการผูกสินค้ากับโพสต์นี้?")) return; try { await api("/admin/api/content/" + m.id, { method: "DELETE" }); toast("ยกเลิกแล้ว"); refresh(); } catch (ex) { toast(ex.message, "err"); } } })));
        }))) : h("p", { class: "muted", text: "ยังไม่มี mapping" }),
      h("h3", { text: "โพสต์ที่มีคอมเมนต์แต่ยังไม่ผูกสินค้า" }),
      h("p", { class: "muted small", text: "โพสต์เหล่านี้จะไม่ได้รับลิงก์ Affiliate อัตโนมัติ ผูกโพสต์/Reel กับสินค้าก่อน จึงจะใช้ CTA และลิงก์ได้" }),
      unmapped.length ? h("table", null,
        h("thead", null, h("tr", null, ["โพสต์", "คอมเมนต์", "ล่าสุด", ""].map((t) => h("th", { text: t })))),
        h("tbody", null, unmapped.map((u) => h("tr", null,
          h("td", null, u.permalink ? h("a", { href: u.permalink, target: "_blank", rel: "noopener noreferrer", class: "mono small", text: u.facebook_post_id }) : h("span", { class: "mono small", text: u.facebook_post_id })),
          h("td", { text: u.comment_count }), h("td", { text: fmtTime(u.last_comment_at) }),
          h("td", null, h("button", { class: "btn small", text: "ผูกสินค้า", onclick: () => { postId.value = u.facebook_post_id; product.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); } })))))) : h("p", { class: "muted", text: "ไม่มี" }));
  }

  /* ----------------------------- activity ---------------------------- */
  function activityTable(rows) {
    if (!rows.length) return h("p", { class: "muted", text: "ยังไม่มีคอมเมนต์" });
    return h("table", null,
      h("thead", null, h("tr", null, ["เวลา", "คอมเมนต์", "AI", "คำตอบ", "สินค้า", "โหมด", "สถานะ"].map((t) => h("th", { text: t })))),
      h("tbody", null, rows.map((c) => h("tr", null,
        h("td", { class: "nowrap small", text: fmtTime(c.created_at) }),
        h("td", null, h("div", { class: "small muted", text: c.author_name || "" }), h("div", { text: c.comment_text || "" })),
        h("td", null, c.ai_action ? badge(c.ai_action, c.ai_action === "REPLY" ? "blue" : "gray") : "-"),
        h("td", { class: "reply" }, c.reply && c.reply.response_text ? h("div", { class: "pre", text: c.reply.response_text }) : h("span", { class: "muted small", text: (c.reply && c.reply.reason) || "-" })),
        h("td", null, c.matched_product ? h("div", null, h("div", { text: c.matched_product.name }), h("div", { class: "muted small", text: SOURCE_LABEL[c.product_source] || "" })) : "-"),
        h("td", null, c.reply ? badge(c.reply.mode, c.reply.mode === "LIVE" ? "red" : "blue") : "-"),
        h("td", null, badge(c.status, STATUS_KIND[c.status]), c.reply ? h("div", null, badge(c.reply.status, STATUS_KIND[c.reply.status])) : null)))));
  }

  async function viewActivity(main) {
    const filter = h("select", null, ["", "PROCESSED", "REPLIED", "SKIPPED", "ERROR", "RECEIVED"].map((s) => h("option", { value: s, text: s || "ทุกสถานะ" })));
    const slot = h("div");
    const more = h("button", { class: "btn ghost", text: "โหลดเพิ่ม" });
    let cursor = null; let rows = [];
    const load = async (reset) => {
      if (reset) { cursor = null; rows = []; }
      const qs = new URLSearchParams({ limit: "30" });
      if (filter.value) qs.set("status", filter.value);
      if (cursor) qs.set("cursor", cursor);
      const res = await api("/admin/comments?" + qs);
      rows = rows.concat(res.data || []); cursor = res.next_cursor;
      slot.replaceChildren(activityTable(rows));
      more.style.display = res.has_more ? "" : "none";
    };
    filter.addEventListener("change", () => load(true));
    more.addEventListener("click", () => load(false));
    main.replaceChildren(h("div", { class: "row-between" }, h("h2", { text: "กิจกรรมคอมเมนต์" }), filter), slot, more);
    await load(true);
  }

  /* ----------------------------- settings ---------------------------- */
  async function viewSettings(main) {
    const res = await api("/admin/api/settings");
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

  document.addEventListener("DOMContentLoaded", render);
})();
