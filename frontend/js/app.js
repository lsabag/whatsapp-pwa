// ── State ────────────────────────────────────────────────────────────────────
const VERSION = "v2.4.0";
const state = {
  view: "home",       // home | summary | cross | dashboard | topics | messages
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
  scannedTopics: null,
  topicMessages: null,
  activeTopic: null,
  scanDates: {},      // groupId -> { from, to }
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

// ── Summarize Orchestrator (chunk by chunk with progress) ────────────────────
async function runSummarize(groupId, dateFrom, dateTo, focus, onProgress) {
  // Step 1: Prepare
  onProgress("מכין...", 0);
  const prep = await API.summarizePrepare(groupId, dateFrom, dateTo, focus);
  const { totalChunks, totalMessages, topSenders, groupName, context, chunkSize } = prep;
  onProgress(`${totalMessages} הודעות, ${totalChunks} חלקים`, 0);

  // Step 2: Chunk by chunk
  const partials = [];
  for (let i = 0; i < totalChunks; i++) {
    onProgress(`מנתח חלק ${i + 1} מתוך ${totalChunks}...`, (i / totalChunks) * 80);
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await API.summarizeChunk({
          groupId, dateFrom, dateTo, chunkIndex: i, totalChunks, chunkSize,
          focus: focus || prep.focus, groupName, context,
        });
        partials.push(res.result);
        break;
      } catch (e) {
        if (e.message.includes("חריגה") && retries > 1) {
          onProgress(`ממתין (rate limit)... ניסיון ${4 - retries}/3`, (i / totalChunks) * 80);
          await new Promise(r => setTimeout(r, 20000));
          retries--;
        } else throw e;
      }
    }
    // Wait between chunks to avoid rate limit
    if (i < totalChunks - 1) {
      onProgress(`מנתח חלק ${i + 1} מתוך ${totalChunks}... ⏳`, ((i + 1) / totalChunks) * 80);
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // Step 3: Merge
  onProgress(totalChunks > 1 ? "ממזג סיכומים..." : "שומר...", 85);
  if (totalChunks > 1) {
    await new Promise(r => setTimeout(r, 3000)); // delay before merge
  }
  const final = await API.summarizeMerge({
    groupId, dateFrom, dateTo, partials, totalMessages, topSenders,
    focus: focus || prep.focus, groupName, context,
  });

  onProgress("✓ סיכום מוכן!", 100);
  return final;
}

// ── Render Router ────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById("app");
  if (state.view === "summary") { renderSummary(app); return; }
  if (state.view === "cross") { renderCross(app); return; }
  if (state.view === "dashboard") { renderDashboard(app); return; }
  if (state.view === "topics") { renderTopics(app); return; }
  if (state.view === "messages") { renderMessages(app); return; }
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

function dateRangeSelect(gId, preset) {
  return `<select class="input input-sm date-select" data-dateselect="${gId}" style="margin-top:8px">
    <option value="all" ${preset !== "custom" && preset !== "week" && preset !== "month" && preset !== "3months" && preset !== "6months" ? "selected" : ""}>כל ההודעות</option>
    <option value="week" ${preset === "week" ? "selected" : ""}>השבוע האחרון</option>
    <option value="month" ${preset === "month" ? "selected" : ""}>החודש האחרון</option>
    <option value="3months" ${preset === "3months" ? "selected" : ""}>3 חודשים אחרונים</option>
    <option value="6months" ${preset === "6months" ? "selected" : ""}>חצי שנה אחרונה</option>
    <option value="custom" ${preset === "custom" ? "selected" : ""}>בחירת תאריכים...</option>
  </select>`;
}

function getPresetDates(preset, maxDate) {
  const to = maxDate || new Date().toISOString().slice(0, 10);
  const d = new Date(to);
  switch (preset) {
    case "week": d.setDate(d.getDate() - 7); break;
    case "month": d.setMonth(d.getMonth() - 1); break;
    case "3months": d.setMonth(d.getMonth() - 3); break;
    case "6months": d.setMonth(d.getMonth() - 6); break;
    default: return { from: null, to: null };
  }
  return { from: d.toISOString().slice(0, 10), to };
}

function countMessagesInRange(messages, from, to) {
  if (!from && !to) return messages.length;
  return messages.filter(m => {
    const d = parseDateStr(m.date);
    if (!d) return false;
    const iso = toISODate(d);
    if (from && iso < from) return false;
    if (to && iso > to) return false;
    return true;
  }).length;
}

function renderGroups() {
  const groupsHtml = state.groups.map(g => {
    const st = state.progress[g.id];
    const badge = st ? (st.includes("✓") ? `<span class="badge badge-green">${st}</span>` : st.includes("❌") ? `<span class="badge badge-red">${st}</span>` : `<span class="badge badge-amber">${st}</span>`) : "";
    const showCustom = g.datePreset === "custom";
    const filteredCount = countMessagesInRange(g.messages, g.dateFrom, g.dateTo);
    const isFiltered = g.dateFrom || g.dateTo;
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
        ${state.processing ? `<span class="spinner"></span> מעלה...` : `📤 העלה ${state.groups.length} קבוצה${state.groups.length !== 1 ? "ות" : ""}`}
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

  // Date range dropdown
  document.querySelectorAll("[data-dateselect]").forEach(sel => {
    sel.addEventListener("change", () => {
      const gId = sel.dataset.dateselect;
      const g = state.groups.find(g => g.id === gId);
      if (!g) return;
      g.datePreset = sel.value;
      if (sel.value === "all") {
        g.dateFrom = null; g.dateTo = null;
      } else if (sel.value === "custom") {
        g.dateFrom = g.dateFrom || g.dateMin;
        g.dateTo = g.dateTo || g.dateMax;
      } else {
        const { from, to } = getPresetDates(sel.value, g.dateMax);
        g.dateFrom = from < g.dateMin ? g.dateMin : from;
        g.dateTo = to;
      }
      render();
    });
  });

  // Today buttons (new groups)
  document.querySelectorAll("[data-today-target]").forEach(btn => {
    btn.addEventListener("click", () => {
      const g = state.groups.find(g => g.id === btn.dataset.todayId);
      if (g) { g[btn.dataset.todayTarget] = new Date().toISOString().slice(0, 10); render(); }
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
        state.progress[g.id] = "מעלה..."; render();
        await uploadGroup(g);
        state.progress[g.id] = "✓ הועלה";
      } catch (e) {
        state.progress[g.id] = `❌ ${e.message || "שגיאה"}`;
        console.error(e);
      }
      render();
    }
    state.processing = false;
    state.groups = [];
    state.progress = {};
    await loadDbGroups();
    notifyOtherTabs();
    showToast("✓ הקבוצות הועלו — עבור לדשבורד לסכם");
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

      ${sectionCard("נושאים שעלו", "💬", result.topics, "#14b8a6")}

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

    ${d.groups.map(g => {
      const fm = g.firstMessage;
      const lm = g.lastMessage;
      return `<div class="dash-card">
      <div class="dash-card-header">
        <div class="group-avatar">${g.name.charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="dash-card-name">${g.name}</div>
          <div class="dash-card-meta">${g.message_count} הודעות · ${g.first_message_date || "?"} עד ${g.last_message_date || "?"}</div>
        </div>
        <button class="group-remove" data-delete-group="${g.id}">✕</button>
      </div>
      <div style="font-size:11px;color:var(--dim);padding:4px 0 8px;border-bottom:1px solid var(--border);margin-bottom:8px">
        ${fm ? `<div>📥 ראשונה: <span style="color:var(--muted)">${fm.date} ${fm.time}</span> — <span style="color:var(--green)">${fm.sender}</span>: ${fm.text.slice(0,60)}${fm.text.length>60?"...":""}</div>` : ""}
        ${lm ? `<div>📤 אחרונה: <span style="color:var(--muted)">${lm.date} ${lm.time}</span> — <span style="color:var(--green)">${lm.sender}</span>: ${lm.text.slice(0,60)}${lm.text.length>60?"...":""}</div>` : ""}
      </div>
      ${g.summaries.length ? g.summaries.slice(0, 5).map(s => {
        const time = new Date(s.created_at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
        const range = s.date_from && s.date_to ? `${s.date_from} → ${s.date_to}` : "טווח מלא";
        const msgs = s.message_count ? `${s.message_count} הודעות` : "";
        return `<div class="dash-summary-row">
          <div style="flex:1;min-width:0;cursor:pointer" data-view-summary='${JSON.stringify({ groupId: g.id, result: s.result })}'>
            <div style="font-size:12px;color:var(--text)">${range}</div>
            <div style="font-size:10px;color:var(--dim)">${formatDate(s.created_at)} ${time}${msgs ? ` · ${msgs}` : ""}</div>
          </div>
          ${s.result.mood ? `<span class="badge badge-${{ חיובי: "green", ניטרלי: "blue", מתוח: "red" }[s.result.mood] || "blue"}">${s.result.mood}</span>` : ""}
          <button class="group-remove" data-delete-summary="${encodeURIComponent(s.id)}" data-summary-date="${formatDate(s.created_at)} ${time}" data-summary-range="${range}" style="font-size:13px;padding:2px 6px">✕</button>
        </div>`;
      }).join("") : `<div style="font-size:12px;color:var(--dim);padding:8px">לא סוכם עדיין</div>`}
      <input class="input input-sm" id="dash-focus-${g.id}" style="margin-top:8px" placeholder="מה לשים דגש? (וואצאפ, קלוד קוד, לקוחות...)" value="" />
      <select class="input input-sm" data-dash-dateselect="${g.id}" style="margin-top:8px">
        <option value="all" selected>כל ההודעות</option>
        <option value="week">השבוע האחרון</option>
        <option value="month">החודש האחרון</option>
        <option value="3months">3 חודשים אחרונים</option>
        <option value="6months">חצי שנה אחרונה</option>
        <option value="custom">בחירת תאריכים...</option>
      </select>
      <div class="date-range" id="custom-dates-${g.id}" style="display:none">
        <div style="flex:1;display:flex;gap:4px;align-items:center">
          <input type="date" class="input" id="dash-from-${g.id}" value="${g.first_message_date || ""}" min="${g.first_message_date || ""}" max="${g.last_message_date || ""}" style="flex:1" />
          <button class="today-btn" data-today-dash="dash-from-${g.id}">היום</button>
        </div>
        <div style="flex:1;display:flex;gap:4px;align-items:center">
          <input type="date" class="input" id="dash-to-${g.id}" value="${g.last_message_date || ""}" min="${g.first_message_date || ""}" max="${g.last_message_date || ""}" style="flex:1" />
          <button class="today-btn" data-today-dash="dash-to-${g.id}">היום</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-primary btn-sm" style="flex:1" data-resummarize="${g.id}" data-max-date="${g.last_message_date || ""}">✨ סכם</button>
        <button class="btn btn-sm btn-outline" style="flex:1;margin:0" data-scan-topics="${g.id}" data-max-date="${g.last_message_date || ""}">🔍 סרוק נושאים</button>
      </div>
    </div>`;
    }).join("")}

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

  // Delete summary
  document.querySelectorAll("[data-delete-summary]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const date = el.dataset.summaryDate;
      const range = el.dataset.summaryRange;
      if (!confirm(`למחוק את הסיכום של ${date}?\nטווח: ${range}`)) return;
      const id = decodeURIComponent(el.dataset.deleteSummary);
      try {
        await API.deleteSummary(id);
        state.dashboard = await API.getDashboard();
        notifyOtherTabs();
        showToast("✓ סיכום נמחק");
      } catch (err) { showToast(`❌ ${err.message}`); }
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

  // Today buttons (dashboard)
  document.querySelectorAll("[data-today-dash]").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.todayDash);
      if (input) input.value = new Date().toISOString().slice(0, 10);
    });
  });

  // Dashboard date selects
  const dashDates = {};
  document.querySelectorAll("[data-dash-dateselect]").forEach(sel => {
    const gId = sel.dataset.dashDateselect;
    dashDates[gId] = { from: null, to: null };
    sel.addEventListener("change", () => {
      const g = d.groups.find(g => g.id === gId);
      const customEl = document.getElementById(`custom-dates-${gId}`);
      if (sel.value === "custom") {
        if (customEl) customEl.style.display = "flex";
      } else {
        if (customEl) customEl.style.display = "none";
        if (sel.value === "all") {
          dashDates[gId] = { from: null, to: null };
        } else {
          const { from, to } = getPresetDates(sel.value, g?.last_message_date);
          dashDates[gId] = { from, to };
        }
      }
    });
  });

  // Re-summarize with date range
  document.querySelectorAll("[data-resummarize]").forEach(el => {
    el.addEventListener("click", async () => {
      const groupId = el.dataset.resummarize;
      let dateFrom = dashDates[groupId]?.from || null;
      let dateTo = dashDates[groupId]?.to || null;
      // Check custom date inputs
      const fromInput = document.getElementById(`dash-from-${groupId}`);
      const toInput = document.getElementById(`dash-to-${groupId}`);
      const customEl = document.getElementById(`custom-dates-${groupId}`);
      if (customEl && customEl.style.display !== "none") {
        dateFrom = fromInput?.value || null;
        dateTo = toInput?.value || null;
      }
      // Get focus
      const focusInput = document.getElementById(`dash-focus-${groupId}`);
      const focus = focusInput?.value?.trim() || null;
      // Save focus to group if provided
      if (focus) API.updateGroup(groupId, { name: d.groups.find(g=>g.id===groupId)?.name || "", context: "", focus });
      // Show progress area
      const card = el.closest(".dash-card");
      let progressEl = card.querySelector(".summary-progress");
      if (!progressEl) {
        progressEl = document.createElement("div");
        progressEl.className = "summary-progress";
        progressEl.style.marginTop = "8px";
        card.appendChild(progressEl);
      }
      el.disabled = true;
      el.innerHTML = `<span class="spinner"></span> מסכם...`;

      try {
        await runSummarize(groupId, dateFrom, dateTo, focus, (text, pct) => {
          progressEl.innerHTML = `
            <div class="progress-text">${text}</div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
        });
        state.dashboard = await API.getDashboard();
        notifyOtherTabs();
        showToast("✓ סיכום חדש נוצר");
      } catch (e) { showToast(`❌ ${e.message}`); }
      render();
    });
  });

  // Scan topics
  document.querySelectorAll("[data-scan-topics]").forEach(el => {
    el.addEventListener("click", async () => {
      const groupId = el.dataset.scanTopics;
      let dateFrom = dashDates[groupId]?.from || null;
      let dateTo = dashDates[groupId]?.to || null;
      const customEl = document.getElementById(`custom-dates-${groupId}`);
      if (customEl && customEl.style.display !== "none") {
        dateFrom = document.getElementById(`dash-from-${groupId}`)?.value || null;
        dateTo = document.getElementById(`dash-to-${groupId}`)?.value || null;
      }
      el.disabled = true;
      el.innerHTML = `<span class="spinner"></span> סורק...`;
      try {
        const res = await API.scanTopics(groupId, dateFrom, dateTo);
        state.scannedTopics = res.topics;
        state.activeGroupId = groupId;
        state.scanDates = { from: dateFrom, to: dateTo };
        state.view = "topics";
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

// ── Topics View ──────────────────────────────────────────────────────────────
function renderTopics(app) {
  const topics = state.scannedTopics || [];
  const group = state.dbGroups.find(g => g.id === state.activeGroupId) || { name: "קבוצה" };
  const heatOrder = { hot: 0, warm: 1, cold: 2 };
  const sorted = [...topics].sort((a, b) => (heatOrder[a.heat] || 2) - (heatOrder[b.heat] || 2));

  app.innerHTML = `
    <div class="header">
      <div class="header-icon">🔍</div>
      <div><div class="header-title">נושאים — ${group.name}</div></div>
    </div>
    <div class="main">
      <div class="nav-back">
        <button class="back-btn" id="back-btn">← חזור לדשבורד</button>
      </div>
      ${!sorted.length ? `<div style="text-align:center;padding:32px;color:var(--dim)">לא נמצאו נושאים</div>` : ""}
      ${sorted.map((t, i) => `<div class="topic-card" data-topic-idx="${i}">
        <div class="topic-name">${t.name}</div>
        <div class="topic-preview">${t.preview || ""}</div>
        <div class="topic-meta">
          <span class="badge heat-${t.heat || "cold"}">${t.heat === "hot" ? "🔥 לוהט" : t.heat === "warm" ? "🟡 חם" : "🔵 קר"}</span>
          ${t.messages ? `<span style="font-size:11px;color:var(--dim)">~${t.messages} הודעות</span>` : ""}
        </div>
        <div class="topic-actions">
          <button class="btn btn-sm btn-outline" style="margin:0;flex:1" data-view-topic-msgs="${i}">💬 הצג הודעות</button>
          <button class="btn btn-sm btn-primary" style="flex:1" data-summarize-topic="${i}">✨ סכם נושא</button>
        </div>
      </div>`).join("")}
    </div>`;

  document.getElementById("back-btn").addEventListener("click", () => {
    state.view = "dashboard"; render();
  });

  // View messages for topic
  document.querySelectorAll("[data-view-topic-msgs]").forEach(el => {
    el.addEventListener("click", async () => {
      const t = sorted[+el.dataset.viewTopicMsgs];
      const keywords = (t.keywords || [t.name]).join(",");
      el.disabled = true;
      el.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = await API.searchMessages(state.activeGroupId, keywords, state.scanDates.from, state.scanDates.to);
        state.topicMessages = res.messages;
        state.activeTopic = t;
        state.view = "messages";
      } catch (e) { showToast(`❌ ${e.message}`); }
      render();
    });
  });

  // Summarize specific topic
  document.querySelectorAll("[data-summarize-topic]").forEach(el => {
    el.addEventListener("click", async () => {
      const t = sorted[+el.dataset.summarizeTopic];
      el.disabled = true;
      const card = el.closest(".topic-card");
      let progressEl = card.querySelector(".summary-progress");
      if (!progressEl) {
        progressEl = document.createElement("div");
        progressEl.className = "summary-progress";
        progressEl.style.marginTop = "6px";
        card.appendChild(progressEl);
      }
      try {
        const res = await runSummarize(state.activeGroupId, state.scanDates.from, state.scanDates.to, t.name, (text, pct) => {
          progressEl.innerHTML = `<div class="progress-text">${text}</div><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
        });
        state.activeSummary = res.result;
        state.view = "summary";
      } catch (e) { showToast(`❌ ${e.message}`); }
      render();
    });
  });
}

// ── Messages View ────────────────────────────────────────────────────────────
function renderMessages(app) {
  const msgs = state.topicMessages || [];
  const topic = state.activeTopic || { name: "נושא" };

  app.innerHTML = `
    <div class="header">
      <div class="header-icon">💬</div>
      <div><div class="header-title">${topic.name}</div><div class="header-sub">${msgs.length} הודעות</div></div>
    </div>
    <div class="main">
      <div class="nav-back">
        <button class="back-btn" id="back-btn">← חזור לנושאים</button>
        <button class="export-btn" id="copy-msgs">📋 העתק הכל</button>
      </div>
      ${!msgs.length ? `<div style="text-align:center;padding:32px;color:var(--dim)">לא נמצאו הודעות</div>` :
      `<div class="msg-viewer">
        ${msgs.map(m => `<div class="msg-bubble">
          <div class="msg-sender">${m.sender}</div>
          <div class="msg-text">${m.text}</div>
          <div class="msg-time">${m.date} ${m.time}</div>
        </div>`).join("")}
      </div>`}
    </div>`;

  document.getElementById("back-btn").addEventListener("click", () => {
    state.view = "topics"; render();
  });

  document.getElementById("copy-msgs").addEventListener("click", () => {
    const text = msgs.map(m => `[${m.date} ${m.time}] ${m.sender}: ${m.text}`).join("\n");
    navigator.clipboard.writeText(text).then(() => showToast("✓ הועתק ללוח"));
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
