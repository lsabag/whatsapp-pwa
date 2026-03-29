// ── State ────────────────────────────────────────────────────────────────────
const VERSION = "v2.0.1";
const state = {
  view: "home",       // home | summary | cross | dashboard
  apiKey: "",
  groups: [],         // local groups (parsed, not yet uploaded)
  dbGroups: [],       // groups from DB
  summaries: {},      // current session summaries (groupId -> result)
  crossResult: null,
  activeGroupId: null,
  activeSummary: null,
  processing: false,
  crossLoading: false,
  progress: {},
  dashboard: null,
};

// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3500) {
  const t = document.getElementById("toast");
  t.style.whiteSpace = msg.length > 60 ? "normal" : "nowrap";
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), duration);
}

// ── File Processing ──────────────────────────────────────────────────────────
async function processFile(file) {
  const addGroup = (text, fname) => {
    const messages = parseWhatsApp(text);
    if (!messages.length) return;
    const dateRange = getDateRange(messages);
    state.groups.push({
      id: `${fname}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: file.name || fname,
      messages, messageCount: messages.length,
      topSenders: getTopSenders(messages),
      weeklyBuckets: getWeeklyBuckets(messages),
      silent: detectSilence(messages),
      name: (file.name || fname).replace(/\.(zip|txt)$/i, "").replace(/[_-]/g, " "),
      context: "", focus: "",
      dateFrom: dateRange.min, dateTo: dateRange.max,
      dateMin: dateRange.min, dateMax: dateRange.max,
    });
  };

  if ((file.name || "").toLowerCase().endsWith(".zip")) {
    const buf = await file.arrayBuffer();
    (await extractTxtFromZip(buf)).forEach(t => addGroup(t.content, t.filename));
  } else {
    addGroup(await file.text(), file.name || "chat.txt");
  }
}

async function processBase64(base64, fileName) {
  const buf = base64ToArrayBuffer(base64);
  const isZip = fileName.toLowerCase().endsWith(".zip");

  const addGroup = (text, fname) => {
    const messages = parseWhatsApp(text);
    if (!messages.length) return;
    const dateRange = getDateRange(messages);
    state.groups.push({
      id: `${fname}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: fileName, messages, messageCount: messages.length,
      topSenders: getTopSenders(messages),
      weeklyBuckets: getWeeklyBuckets(messages),
      silent: detectSilence(messages),
      name: fileName.replace(/\.(zip|txt)$/i, "").replace(/[_-]/g, " "),
      context: "", focus: "",
      dateFrom: dateRange.min, dateTo: dateRange.max,
      dateMin: dateRange.min, dateMax: dateRange.max,
    });
  };

  if (isZip) {
    const txtFiles = await extractTxtFromZip(buf);
    txtFiles.forEach(t => addGroup(t.content, t.filename));
  } else {
    addGroup(new TextDecoder("utf-8").decode(buf), fileName);
  }

  if (state.groups.length) showToast(`✓ ${fileName} התקבל`);
  render();
}

// ── Upload group to backend ──────────────────────────────────────────────────
async function uploadGroup(group) {
  const result = await API.createGroup({
    id: group.id,
    name: group.name,
    filename: group.filename,
    context: group.context,
    focus: group.focus,
    messages: group.messages,
  });
  return result;
}

// ── Render Router ────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById("app");
  if (state.view === "summary") { renderSummary(app); return; }
  if (state.view === "cross") { renderCross(app); return; }
  if (state.view === "dashboard") { renderDashboard(app); return; }
  renderHome(app);
}

// ── Home View ────────────────────────────────────────────────────────────────
function renderHome(app) {
  const hasGroups = state.groups.length > 0;
  const hasDbGroups = state.dbGroups.length > 0;

  app.innerHTML = `
    <div class="header">
      <div class="header-icon">💬</div>
      <div>
        <div class="header-title">WhatsApp Summarizer</div>
        <div class="header-sub">סיכום חכם לקבוצות עסקיות</div>
      </div>
      <div class="header-actions">
        ${hasDbGroups ? `<button class="header-btn" id="dash-btn">📊 דשבורד</button>` : ""}
      </div>
    </div>
    <div class="main">
      ${!state.apiKey ? renderSetup() : renderKeyReady()}
      ${state.apiKey ? renderDropZone() : ""}
      ${hasGroups ? renderGroups() : ""}
      ${hasDbGroups ? renderDbGroups() : ""}
      ${!hasGroups && !hasDbGroups && state.apiKey ? `<div style="text-align:center;padding:32px 0;color:var(--muted);font-size:13px;">
        <div style="margin-bottom:8px;">ייצא קבוצה מוואצאפ ושתף לאפליקציה</div>
        <div style="font-size:11px;">פתח קבוצה → ⋮ → ייצוא צ׳אט → ללא מדיה</div>
      </div>` : ""}
      <div style="text-align:center;padding:24px 0 8px;font-size:10px;color:var(--muted)">${VERSION}</div>
    </div>`;

  bindHomeEvents();
}

function renderSetup() {
  return `<div class="setup-card">
    <div class="setup-title">🔑 הגדרת Groq API Key</div>
    <div class="setup-desc">
      קבל API Key חינמי ב-<a class="setup-link" href="https://console.groq.com/keys" target="_blank">console.groq.com</a> — נדרש רק פעם אחת.
    </div>
    <input class="input" id="api-key-input" type="password" placeholder="gsk_..." value="" dir="ltr"/>
    <div style="height:10px"></div>
    <button class="btn btn-primary" id="save-key-btn">המשך</button>
  </div>`;
}

function renderKeyReady() {
  return `<div class="setup-card" style="padding:14px 18px;display:flex;align-items:center;justify-content:space-between">
    <div style="font-size:13px;color:var(--green)">🔑 API Key מוגדר</div>
    <button class="btn-sm btn-outline" id="change-key-btn" style="padding:6px 12px;border-radius:10px;font-size:12px;font-family:inherit;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--dim)">שנה</button>
  </div>`;
}

function renderDropZone() {
  return `<div class="drop-zone" id="drop-zone">
    <div class="drop-zone-icon">📁</div>
    <div class="drop-zone-title">גרור קבצים או לחץ לבחירה</div>
    <div class="drop-zone-sub">ZIP או TXT מוואצאפ · מספר קבצים</div>
    <div class="drop-zone-hint">פתח קבוצה ← ⋮ ← ייצוא צ׳אט ← ללא מדיה</div>
  </div>`;
}

function renderGroups() {
  const groupsHtml = state.groups.map(g => {
    const st = state.progress[g.id];
    const badge = st ? (st.includes("✓") ? `<span class="badge badge-green">${st}</span>` : st.includes("❌") ? `<span class="badge badge-red">${st}</span>` : `<span class="badge badge-amber">${st}</span>`) : "";
    return `<div class="group-card">
      <div class="group-card-header">
        <div class="group-avatar">${(g.name || g.filename).charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="group-filename">${g.filename}</div>
          <div class="group-count">${g.messageCount} הודעות${g.silent?.length ? ` · 🔇 ${g.silent.length} נעלמו` : ""}</div>
        </div>
        ${badge}
        <button class="group-remove" data-remove="${g.id}">✕</button>
      </div>
      <input class="input" style="margin-bottom:8px" data-field="name" data-id="${g.id}" placeholder="שם הקבוצה" value="${g.name || ""}" />
      <input class="input" style="margin-bottom:8px" data-field="context" data-id="${g.id}" placeholder="הקשר / נושא (לקוחות, ספקים, צוות...)" value="${g.context || ""}" />
      <input class="input" data-field="focus" data-id="${g.id}" placeholder="מה לשים דגש? (הזדמנויות, בעיות...)" value="${g.focus || ""}" />
      <div class="date-range">
        <input type="date" class="input" data-field="dateFrom" data-id="${g.id}" value="${g.dateFrom || ""}" min="${g.dateMin || ""}" max="${g.dateMax || ""}" />
        <input type="date" class="input" data-field="dateTo" data-id="${g.id}" value="${g.dateTo || ""}" min="${g.dateMin || ""}" max="${g.dateMax || ""}" />
      </div>
      <div class="date-range-info">${g.dateMin ? `טווח: ${g.dateMin} עד ${g.dateMax}` : ""}</div>
    </div>`;
  }).join("");

  return `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700;color:var(--muted)">קבוצות חדשות (${state.groups.length})</div>
        <button style="font-size:12px;color:var(--dim);background:none;border:none;cursor:pointer" id="clear-all">נקה</button>
      </div>
      ${groupsHtml}
      <button class="btn btn-primary" id="run-btn" ${state.processing || !state.groups.length ? "disabled" : ""} style="margin-top:4px">
        ${state.processing ? `<span class="spinner"></span> מעבד...` : `✨ העלה וסכם ${state.groups.length} קבוצה${state.groups.length !== 1 ? "ות" : ""}`}
      </button>
    </div>`;
}

function renderDbGroups() {
  if (!state.dbGroups.length) return "";
  return `<div style="margin-top:16px">
    <div class="section-sep">קבוצות שמורות</div>
    ${state.dbGroups.map(g => {
      const lastSummary = g.lastSummary;
      return `<div class="ready-card" data-db-group="${g.id}">
        <div class="ready-card-row">
          <span class="ready-card-name">${g.name}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="badge badge-blue">${g.message_count} הודעות</span>
            <span class="ready-card-arrow">פתח ←</span>
          </div>
        </div>
        ${lastSummary ? `<div class="ready-card-preview">${lastSummary}</div>` : `<div class="ready-card-preview" style="color:var(--dim)">לא סוכם עדיין</div>`}
      </div>`;
    }).join("")}
  </div>`;
}

function bindHomeEvents() {
  // API Key save
  document.getElementById("save-key-btn")?.addEventListener("click", async () => {
    const val = document.getElementById("api-key-input")?.value.trim();
    if (val) {
      state.apiKey = val;
      await API.saveSettings({ groq_key: val });
      showToast("✓ API Key נשמר");
      render();
    }
  });

  // API Key change
  document.getElementById("change-key-btn")?.addEventListener("click", () => {
    state.apiKey = ""; render();
  });

  // Dashboard
  document.getElementById("dash-btn")?.addEventListener("click", async () => {
    state.view = "dashboard";
    state.dashboard = null;
    render();
    state.dashboard = await API.getDashboard();
    render();
  });

  // Drop zone
  const dz = document.getElementById("drop-zone");
  if (dz) {
    dz.addEventListener("click", () => document.getElementById("file-input").click());
    dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", async e => {
      e.preventDefault(); dz.classList.remove("drag");
      const files = [...e.dataTransfer.files].filter(f => f.name.match(/\.(zip|txt)$/i));
      for (const f of files) await processFile(f);
      render();
    });
  }

  // File input
  document.getElementById("file-input")?.addEventListener("change", async e => {
    for (const f of e.target.files) await processFile(f);
    e.target.value = ""; render();
  });

  // Group fields
  document.querySelectorAll("[data-field]").forEach(el => {
    el.addEventListener("input", () => {
      const { field, id } = el.dataset;
      const g = state.groups.find(g => g.id === id);
      if (g) g[field] = el.value;
    });
  });

  // Remove group
  document.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remove;
      state.groups = state.groups.filter(g => g.id !== id);
      delete state.summaries[id]; delete state.progress[id];
      render();
    });
  });

  // Clear all local groups
  document.getElementById("clear-all")?.addEventListener("click", () => {
    state.groups = []; state.summaries = {}; state.progress = {}; render();
  });

  // Run: upload + summarize
  document.getElementById("run-btn")?.addEventListener("click", async () => {
    state.processing = true; render();
    for (const g of state.groups) {
      try {
        // Upload
        state.progress[g.id] = "מעלה..."; render();
        await uploadGroup(g);

        // Summarize
        state.progress[g.id] = "מסכם..."; render();
        const res = await API.summarize(g.id, g.dateFrom, g.dateTo);
        state.summaries[g.id] = res.result;
        state.progress[g.id] = "✓ מוכן";
      } catch (e) {
        state.progress[g.id] = `❌ ${e.message || "שגיאה"}`;
        console.error(e);
      }
      render();
    }
    state.processing = false;
    // Refresh DB groups and notify other tabs/devices
    await loadDbGroups();
    notifyOtherTabs();
    render();
  });

  // DB group click -> go to dashboard summary
  document.querySelectorAll("[data-db-group]").forEach(el => {
    el.addEventListener("click", async () => {
      const groupId = el.dataset.dbGroup;
      state.view = "dashboard";
      state.dashboard = null;
      render();
      state.dashboard = await API.getDashboard();
      state.activeGroupId = groupId;
      render();
    });
  });
}

// ── Summary View ─────────────────────────────────────────────────────────────
function renderSummary(app) {
  const result = state.activeSummary;
  if (!result) { state.view = "home"; render(); return; }

  const group = state.dbGroups.find(g => g.id === state.activeGroupId) ||
                state.groups.find(g => g.id === state.activeGroupId) ||
                { name: "קבוצה", messageCount: 0 };

  const moodColor = { חיובי: "green", ניטרלי: "blue", מתוח: "red" }[result.mood] || "blue";

  const sectionCard = (title, icon, items, dotColor, cls = "") => {
    if (!items?.length) return "";
    return `<div class="section-card ${cls}">
      <div class="section-header"><span class="section-icon">${icon}</span><span class="section-title">${title}</span><span class="section-count">${items.length}</span></div>
      <ul class="section-list">${items.map(i => `<li class="section-item"><span class="section-dot" style="background:${dotColor}"></span>${i}</li>`).join("")}</ul>
    </div>`;
  };

  app.innerHTML = `
    <div class="header">
      <div class="header-icon">💬</div>
      <div><div class="header-title">סיכום קבוצה</div></div>
    </div>
    <div class="main">
      <div class="nav-back">
        <button class="back-btn" id="back-btn">← חזור</button>
        <div style="display:flex;gap:8px">
          <button class="export-btn" id="copy-btn">📋 העתק</button>
          <button class="export-btn" id="export-btn">📄 PDF</button>
        </div>
      </div>

      <div class="summary-header">
        <div class="summary-name">${group.name || group.filename || ""}</div>
        <div class="summary-badges">
          ${result.mood ? `<span class="badge badge-${moodColor}">מצב: ${result.mood}</span>` : ""}
          <span class="badge badge-blue">${result.messageCount || group.message_count || "?"} הודעות</span>
        </div>
        <div class="summary-text">${result.summary}</div>
      </div>

      ${result.urgentItems?.length ? `<div class="section-card urgent">
        <div class="section-header"><span class="section-icon">🔴</span><span class="section-title">דחוף לטיפול</span><span class="section-count">${result.urgentItems.length}</span></div>
        <ul class="section-list">${result.urgentItems.map(i => `<li class="section-item"><span class="section-dot" style="background:#ef4444"></span>${i}</li>`).join("")}</ul>
      </div>` : ""}

      ${sectionCard("מגמות שיח", "📈", result.trends, "#2dd4bf")}
      ${sectionCard("הבטחות שלא קוימו", "⚠️", result.brokenPromises, "#f59e0b")}
      ${sectionCard("בעיות חוזרות", "🔁", result.recurringProblems, "#f97316")}
      ${sectionCard("משימות ו-Action Items", "✅", result.actionItems, "#10b981")}
      ${sectionCard("תובנות עסקיות", "💡", result.businessInsights, "#fbbf24")}
      ${sectionCard("החלטות מרכזיות", "🎯", result.keyDecisions, "#60a5fa")}
      ${sectionCard("שאלות פתוחות", "❓", result.openQuestions, "#a78bfa")}
    </div>`;

  document.getElementById("back-btn").addEventListener("click", () => {
    if (state.dashboard) { state.view = "dashboard"; } else { state.view = "home"; }
    render();
  });
  document.getElementById("copy-btn").addEventListener("click", () => {
    const text = summaryToText(group, result);
    navigator.clipboard.writeText(text).then(() => showToast("✓ הועתק ללוח"));
  });
  document.getElementById("export-btn").addEventListener("click", () => printSummary(group, result));
}

function summaryToText(group, result) {
  const sec = (title, items) => items?.length ? `\n${title}:\n${items.map(i => `• ${i}`).join("\n")}` : "";
  return `סיכום: ${group.name}\n${result.messageCount || group.message_count || "?"} הודעות | מצב: ${result.mood || "—"}\n\n${result.summary || ""}` +
    sec("דחוף", result.urgentItems) + sec("משימות", result.actionItems) +
    sec("הבטחות שלא קוימו", result.brokenPromises) + sec("מגמות", result.trends) +
    sec("בעיות חוזרות", result.recurringProblems) + sec("שאלות פתוחות", result.openQuestions) +
    sec("תובנות עסקיות", result.businessInsights) + sec("החלטות", result.keyDecisions);
}

function printSummary(group, result) {
  const w = window.open("", "_blank");
  w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>סיכום - ${group.name}</title>
  <style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;color:#111;line-height:1.7}
  h1{color:#059669;border-bottom:2px solid #059669;padding-bottom:8px}
  h2{color:#374151;font-size:16px;margin-top:28px}ul{padding-right:20px}li{margin-bottom:6px}
  .box{background:#f0fdf4;border-right:4px solid #059669;padding:16px;border-radius:4px;margin:16px 0}
  .meta{color:#6b7280;font-size:13px;margin-bottom:20px}</style></head><body>
  <h1>📋 סיכום: ${group.name}</h1>
  <div class="meta">${new Date().toLocaleDateString("he-IL")} | ${result.messageCount || group.message_count || "?"} הודעות | מצב: ${result.mood || "—"}</div>
  <div class="box">${result.summary}</div>
  ${result.urgentItems?.length ? `<h2>🔴 דחוף</h2><ul>${result.urgentItems.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}
  ${result.actionItems?.length ? `<h2>✅ משימות</h2><ul>${result.actionItems.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}
  ${result.brokenPromises?.length ? `<h2>⚠️ הבטחות שלא קוימו</h2><ul>${result.brokenPromises.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}
  ${result.trends?.length ? `<h2>📈 מגמות</h2><ul>${result.trends.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}
  ${result.openQuestions?.length ? `<h2>❓ שאלות פתוחות</h2><ul>${result.openQuestions.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}
  ${result.businessInsights?.length ? `<h2>💡 תובנות עסקיות</h2><ul>${result.businessInsights.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}
  </body></html>`);
  w.document.close(); w.print();
}

// ── Cross View ───────────────────────────────────────────────────────────────
function renderCross(app) {
  const c = state.crossResult || state.activeSummary;
  if (!c) { state.view = "home"; render(); return; }

  const sectionCard = (title, icon, items, dotColor) => {
    if (!items?.length) return "";
    return `<div class="section-card">
      <div class="section-header"><span class="section-icon">${icon}</span><span class="section-title">${title}</span><span class="section-count">${items.length}</span></div>
      <ul class="section-list">${items.map(i => `<li class="section-item"><span class="section-dot" style="background:${dotColor}"></span>${i}</li>`).join("")}</ul>
    </div>`;
  };

  app.innerHTML = `
    <div class="header">
      <div class="header-icon">🔗</div>
      <div><div class="header-title">ניתוח Cross-קבוצות</div></div>
    </div>
    <div class="main">
      <div class="nav-back">
        <button class="back-btn" id="back-btn">← חזור</button>
      </div>

      ${c.executiveSummary ? `<div class="summary-header">
        <div class="summary-badges"><span class="badge badge-purple">סיכום מנהלים</span></div>
        <div class="summary-text">${c.executiveSummary}</div>
      </div>` : ""}

      ${sectionCard("בעיות מערכתיות", "🚨", c.systemicProblems, "#ef4444")}
      ${sectionCard("הזדמנויות", "🚀", c.opportunities, "#10b981")}

      ${c.crossTopics?.length ? `<div class="section-card">
        <div class="section-header"><span class="section-icon">🔗</span><span class="section-title">נושאים משותפים</span><span class="section-count">${c.crossTopics.length}</span></div>
        ${c.crossTopics.map(t => `<div class="cross-topic">
          <div class="cross-topic-title">${t.topic}</div>
          <div class="cross-topic-badges">${(t.groups || []).map(g => `<span class="badge badge-purple">${g}</span>`).join("")}</div>
          <div class="cross-topic-insight">${t.insight}</div>
        </div>`).join("")}
      </div>` : ""}

      ${c.peopleInMultipleGroups?.length ? `<div class="section-card">
        <div class="section-header"><span class="section-icon">👥</span><span class="section-title">אנשים בכמה קבוצות</span></div>
        ${c.peopleInMultipleGroups.map(p => `<div style="margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:14px;font-weight:600">${p.name}</span>
            ${(p.groups || []).map(g => `<span class="badge badge-blue">${g}</span>`).join("")}
          </div>
          <div style="font-size:12px;color:var(--muted)">${p.context}</div>
        </div>`).join("")}
      </div>` : ""}
    </div>`;

  document.getElementById("back-btn").addEventListener("click", () => {
    if (state.dashboard) { state.view = "dashboard"; } else { state.view = "home"; }
    render();
  });
}

// ── Dashboard View ───────────────────────────────────────────────────────────
function renderDashboard(app) {
  const d = state.dashboard;

  app.innerHTML = `
    <div class="header">
      <div class="header-icon">📊</div>
      <div><div class="header-title">דשבורד</div></div>
    </div>
    <div class="main">
      <div class="nav-back">
        <button class="back-btn" id="back-btn">← חזור</button>
      </div>
      ${!d ? `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>` : renderDashboardContent(d)}
    </div>`;

  document.getElementById("back-btn")?.addEventListener("click", () => {
    state.view = "home"; state.dashboard = null; render();
  });

  if (d) bindDashboardEvents(d);
}

function renderDashboardContent(d) {
  const formatDate = ts => new Date(ts).toLocaleDateString("he-IL");

  return `
    <div class="dash-stats">
      <div class="dash-stat">
        <div class="dash-stat-num">${d.groups.length}</div>
        <div class="dash-stat-label">קבוצות</div>
      </div>
      <div class="dash-stat">
        <div class="dash-stat-num">${d.totalSummaries}</div>
        <div class="dash-stat-label">סיכומים</div>
      </div>
      <div class="dash-stat">
        <div class="dash-stat-num">${d.groups.reduce((s, g) => s + g.message_count, 0).toLocaleString()}</div>
        <div class="dash-stat-label">הודעות</div>
      </div>
    </div>

    ${d.groups.map(g => `<div class="dash-card">
      <div class="dash-card-header">
        <div class="group-avatar">${g.name.charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="dash-card-name">${g.name}</div>
          <div class="dash-card-meta">${g.message_count} הודעות · ${g.first_message_date || "?"} עד ${g.last_message_date || "?"}</div>
        </div>
        <button class="group-remove" data-delete-group="${g.id}">✕</button>
      </div>
      ${g.summaries.length ? g.summaries.slice(0, 5).map(s => `<div class="dash-summary-row" data-view-summary='${JSON.stringify({ groupId: g.id, result: s.result })}'>
        <span class="dash-summary-date">${formatDate(s.created_at)}</span>
        <span class="dash-summary-range">${s.date_from && s.date_to ? `${s.date_from} → ${s.date_to}` : "טווח מלא"}</span>
        <span class="dash-summary-mood">${s.result.mood ? `<span class="badge badge-${{ חיובי: "green", ניטרלי: "blue", מתוח: "red" }[s.result.mood] || "blue"}">${s.result.mood}</span>` : ""}</span>
        <span style="color:var(--green);font-size:12px">←</span>
      </div>`).join("") : `<div style="font-size:12px;color:var(--dim);padding:8px">לא סוכם עדיין</div>`}
      <button class="btn btn-primary btn-sm" style="margin-top:8px" data-resummarize="${g.id}">✨ סכם מחדש</button>
    </div>`).join("")}

    ${d.crossAnalyses?.length ? `
      <div class="section-sep">ניתוחי Cross-קבוצות</div>
      ${d.crossAnalyses.map(c => `<div class="cross-ready-card" data-view-cross='${JSON.stringify(c.result)}'>
        <div class="ready-card-row">
          <span class="ready-card-name" style="color:#a78bfa">🔗 ${formatDate(c.created_at)}</span>
          <span style="color:#a78bfa;font-size:13px">פתח ←</span>
        </div>
        <div class="ready-card-preview">${c.result.executiveSummary || ""}</div>
      </div>`).join("")}
    ` : ""}

    ${d.groups.length >= 2 ? `<button class="btn btn-purple" id="cross-btn" style="margin-top:12px" ${state.crossLoading ? "disabled" : ""}>
      ${state.crossLoading ? `<span class="spinner"></span> מנתח...` : "🔗 ניתוח cross-קבוצות"}
    </button>` : ""}
  `;
}

function bindDashboardEvents(d) {
  // View summary
  document.querySelectorAll("[data-view-summary]").forEach(el => {
    el.addEventListener("click", () => {
      const data = JSON.parse(el.dataset.viewSummary);
      state.activeGroupId = data.groupId;
      state.activeSummary = data.result;
      state.view = "summary";
      render();
    });
  });

  // View cross
  document.querySelectorAll("[data-view-cross]").forEach(el => {
    el.addEventListener("click", () => {
      state.activeSummary = JSON.parse(el.dataset.viewCross);
      state.view = "cross";
      render();
    });
  });

  // Delete group
  document.querySelectorAll("[data-delete-group]").forEach(el => {
    el.addEventListener("click", async () => {
      if (!confirm("למחוק קבוצה וכל הסיכומים שלה?")) return;
      await API.deleteGroup(el.dataset.deleteGroup);
      state.dashboard = await API.getDashboard();
      await loadDbGroups();
      render();
    });
  });

  // Re-summarize
  document.querySelectorAll("[data-resummarize]").forEach(el => {
    el.addEventListener("click", async () => {
      const groupId = el.dataset.resummarize;
      el.disabled = true;
      el.innerHTML = `<span class="spinner"></span> מסכם...`;
      try {
        await API.summarize(groupId);
        state.dashboard = await API.getDashboard();
        showToast("✓ סיכום חדש נוצר");
      } catch (e) { showToast(`❌ ${e.message}`); }
      render();
    });
  });

  // Cross analysis
  document.getElementById("cross-btn")?.addEventListener("click", async () => {
    state.crossLoading = true; render();
    try {
      const groupIds = d.groups.map(g => g.id);
      const res = await API.crossAnalyze(groupIds);
      state.activeSummary = res.result;
      state.view = "cross";
    } catch (e) { showToast(`❌ ${e.message}`); }
    state.crossLoading = false;
    render();
  });
}

// ── Load DB groups ───────────────────────────────────────────────────────────
async function loadDbGroups() {
  try {
    const groups = await API.getGroups();
    state.dbGroups = groups.map(g => ({
      ...g,
      lastSummary: null, // will be populated from dashboard
    }));
    // Load latest summary previews
    if (groups.length) {
      const dash = await API.getDashboard();
      for (const g of state.dbGroups) {
        const dg = dash.groups.find(dg => dg.id === g.id);
        if (dg?.summaries?.length) {
          g.lastSummary = dg.summaries[0].result.summary;
        }
      }
    }
  } catch { state.dbGroups = []; }
}

// ── Service Worker + Share Target ────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then(() => {
    navigator.serviceWorker.addEventListener("message", async e => {
      if (e.data?.type === "SHARED_FILE") {
        await processBase64(e.data.base64, e.data.fileName);
      }
    });
  });

  async function checkPendingShare() {
    try {
      const cache = await caches.open("wa-summarizer-v6");
      const pending = await cache.match("/__pending_share__");
      if (pending) {
        const data = await pending.json();
        await cache.delete("/__pending_share__");
        if (data.base64 && data.fileName) await processBase64(data.base64, data.fileName);
      }
    } catch (e) { console.error("Share check error:", e); }
    if (location.search.includes("from=share")) history.replaceState(null, "", "/");
  }
  window.addEventListener("load", () => setTimeout(checkPendingShare, 500));
  checkPendingShare();
}

// ── Auto-import API Key from URL hash ────────────────────────────────────────
if (location.hash.startsWith("#key=")) {
  const key = decodeURIComponent(location.hash.slice(5));
  if (key) {
    state.apiKey = key;
    API.saveSettings({ groq_key: key });
    history.replaceState(null, "", "/");
    showToast("✓ API Key נשמר בהצלחה");
  }
}

// ── Cross-tab sync via BroadcastChannel ──────────────────────────────────────
const channel = new BroadcastChannel("wa-summarizer");
channel.onmessage = async (e) => {
  if (e.data === "refresh") {
    await loadDbGroups();
    if (state.view === "dashboard" && state.dashboard) {
      state.dashboard = await API.getDashboard();
    }
    render();
  }
};

function notifyOtherTabs() {
  channel.postMessage("refresh");
}

// ── Cross-device polling ─────────────────────────────────────────────────────
let lastPollHash = "";
async function pollForUpdates() {
  if (document.hidden) return;
  try {
    const groups = await API.getGroups();
    const hash = JSON.stringify(groups.map(g => g.updated_at));
    if (lastPollHash && hash !== lastPollHash) {
      await loadDbGroups();
      if (state.view === "dashboard" && state.dashboard) {
        state.dashboard = await API.getDashboard();
      }
      render();
      showToast("✓ נתונים עודכנו");
    }
    lastPollHash = hash;
  } catch { /* ignore */ }
}
setInterval(pollForUpdates, 15000);

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const settings = await API.getSettings();
    state.apiKey = settings.groq_key || "";
  } catch { /* no settings yet */ }
  await loadDbGroups();
  lastPollHash = JSON.stringify(state.dbGroups.map(g => g.updated_at));
  render();
})();
