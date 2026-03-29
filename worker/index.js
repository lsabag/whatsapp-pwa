export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      // CORS
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }
      try {
        const res = await handleAPI(url, request, env);
        return addCors(res);
      } catch (e) {
        return addCors(json({ error: e.message }, 500));
      }
    }

    // Serve static files from site bucket (handled by [site] in wrangler.toml)
    return env.ASSETS.fetch(request);
  }
};

// ── API Router ─────────────────────────────────────────────────────────────

async function handleAPI(url, request, env) {
  const path = url.pathname;
  const method = request.method;

  // Settings (API key)
  if (path === "/api/settings" && method === "GET") return getSettings(env);
  if (path === "/api/settings" && method === "POST") return saveSettings(request, env);

  // Groups
  if (path === "/api/groups" && method === "GET") return getGroups(env);
  if (path === "/api/groups" && method === "POST") return createGroup(request, env);
  if (path.match(/^\/api\/groups\/[^/]+$/) && method === "GET") return getGroup(path.split("/")[3], env);
  if (path.match(/^\/api\/groups\/[^/]+$/) && method === "PUT") return updateGroup(path.split("/")[3], request, env);
  if (path.match(/^\/api\/groups\/[^/]+$/) && method === "DELETE") return deleteGroup(path.split("/")[3], env);
  if (path.match(/^\/api\/groups\/[^/]+\/messages$/) && method === "GET") return getMessages(path.split("/")[3], url, env);

  // Summaries — step-by-step
  if (path === "/api/summarize/prepare" && method === "POST") return summarizePrepare(request, env);
  if (path === "/api/summarize/chunk" && method === "POST") return summarizeChunk(request, env);
  if (path === "/api/summarize/merge" && method === "POST") return summarizeMerge(request, env);
  if (path.match(/^\/api\/summaries\/[^/]+$/) && method === "GET") return getSummaries(path.split("/")[3], env);
  if (path.match(/^\/api\/summaries\/[^/]+$/) && method === "DELETE") return deleteSummary(path.split("/")[3], env);

  // Cross analysis
  if (path === "/api/cross-analyze" && method === "POST") return crossAnalyze(request, env);
  if (path === "/api/cross-analyses" && method === "GET") return getCrossAnalyses(env);

  // Topic scan
  if (path === "/api/scan-topics" && method === "POST") return scanTopics(request, env);

  // Message search by topic
  if (path.match(/^\/api\/groups\/[^/]+\/search$/) && method === "GET") return searchMessages(path.split("/")[3], url, env);

  // Dashboard
  if (path === "/api/dashboard" && method === "GET") return getDashboard(env);

  // Fix dates migration
  if (path === "/api/fix-dates" && method === "POST") return fixDates(env);

  return json({ error: "Not found" }, 404);
}

// ── Settings ───────────────────────────────────────────────────────────────

async function getSettings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM settings").all();
  const settings = {};
  for (const r of rows.results) settings[r.key] = r.value;
  return json(settings);
}

async function saveSettings(request, env) {
  const body = await request.json();
  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  }
  return json({ ok: true });
}

// ── Groups ─────────────────────────────────────────────────────────────────

async function getGroups(env) {
  const groups = await env.DB.prepare(
    "SELECT id, name, filename, context, focus, message_count, first_message_date, last_message_date, created_at, updated_at FROM groups ORDER BY updated_at DESC"
  ).all();
  return json(groups.results);
}

async function getGroup(id, env) {
  id = decodeURIComponent(id);
  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
  if (!group) return json({ error: "Not found" }, 404);
  return json(group);
}

async function createGroup(request, env) {
  const body = await request.json();
  let { id, name, filename, context, focus, messages } = body;
  const now = Date.now();

  // Detect date format from messages
  _dateFormat = null;
  detectDateFormat(messages.map(m => m.date));

  // Check if a group with the same name already exists — reuse its ID to keep summaries
  const existing = await env.DB.prepare("SELECT id, created_at FROM groups WHERE name = ?").bind(name).first();
  if (existing) {
    id = existing.id;
  }

  // Parse dates to find range
  const dates = messages.map(m => parseDate(m.date)).filter(Boolean).sort((a, b) => a - b);
  const firstDate = dates.length ? toISO(dates[0]) : null;
  const lastDate = dates.length ? toISO(dates[dates.length - 1]) : null;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO groups (id, name, filename, context, focus, message_count, first_message_date, last_message_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, name, filename, context || "", focus || "", messages.length, firstDate, lastDate, existing ? existing.created_at : now, now).run();

  // Replace messages (summaries are kept)
  const batchSize = 50;
  await env.DB.prepare("DELETE FROM messages WHERE group_id = ?").bind(id).run();

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const stmts = batch.map(m => {
      const pd = parseDate(m.date);
      return env.DB.prepare(
        "INSERT INTO messages (group_id, date, time, sender, text, parsed_date) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, m.date, m.time, m.sender, m.text, pd ? toISO(pd) : null);
    });
    await env.DB.batch(stmts);
  }

  return json({ id, message_count: messages.length, first_message_date: firstDate, last_message_date: lastDate });
}

async function updateGroup(id, request, env) {
  id = decodeURIComponent(id);
  const body = await request.json();
  const { name, context, focus } = body;
  await env.DB.prepare(
    "UPDATE groups SET name = ?, context = ?, focus = ?, updated_at = ? WHERE id = ?"
  ).bind(name, context || "", focus || "", Date.now(), id).run();
  return json({ ok: true });
}

async function deleteGroup(id, env) {
  const decoded = decodeURIComponent(id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE group_id = ?").bind(decoded),
    env.DB.prepare("DELETE FROM summaries WHERE group_id = ?").bind(decoded),
    env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(decoded),
  ]);
  return json({ ok: true });
}

async function getMessages(groupId, url, env) {
  groupId = decodeURIComponent(groupId);
  const dateFrom = url.searchParams.get("from");
  const dateTo = url.searchParams.get("to");

  let query = "SELECT date, time, sender, text FROM messages WHERE group_id = ?";
  const params = [groupId];

  if (dateFrom) { query += " AND parsed_date >= ?"; params.push(dateFrom); }
  if (dateTo) { query += " AND parsed_date <= ?"; params.push(dateTo); }
  query += " ORDER BY id ASC";

  const rows = await env.DB.prepare(query).bind(...params).all();
  return json(rows.results);
}

// ── Get Summaries ──────────────────────────────────────────────────────────

async function getSummaries(groupId, env) {
  const rows = await env.DB.prepare(
    "SELECT id, group_id, date_from, date_to, message_count, result, created_at FROM summaries WHERE group_id = ? ORDER BY created_at DESC"
  ).bind(groupId).all();
  return json(rows.results.map(r => ({ ...r, result: JSON.parse(r.result) })));
}

async function deleteSummary(id, env) {
  const decoded = decodeURIComponent(id);
  await env.DB.prepare("DELETE FROM summaries WHERE id = ?").bind(decoded).run();
  return json({ ok: true });
}

// ── Summarize (step-by-step) ───────────────────────────────────────────────

const SYS_CHUNK = `אתה מנתח שיחות WhatsApp לאנשי עסקים. ענה בעברית בלבד. החזר JSON בלבד ללא backticks ולא כלום אחר.
חשוב מאוד: ציין כל נושא שעלה בשיחה, גם אם הוא קטן או שדיברו עליו רק כמה הודעות. אל תדלג על שום נושא.
כל שם מוצר, כלי, טכנולוגיה, אפליקציה, או שירות שהוזכר — חייב להופיע ברשימת הנושאים.
רשום כמה שיותר פריטים בכל שדה — עדיף יותר מדי מאשר פחות מדי.`;

const SYS_MERGE = `אתה ממזג סיכומי חלקים של שיחת WhatsApp לסיכום אחד מקיף. ענה בעברית בלבד. החזר JSON בלבד ללא backticks ולא כלום אחר.
חשוב מאוד: שמור על כל הנושאים מכל החלקים. אל תשמיט שום נושא, גם אם הוא מוזכר רק בחלק אחד.
מזג את כל הפריטים מכל החלקים — עדיף רשימה ארוכה ומלאה מאשר קצרה וחסרה.`;

const JSON_CHUNK = `{"topics":["נושא 1","נושא 2","...כל הנושאים"],"summary":"תקציר 3-5 משפטים","actionItems":["..."],"openQuestions":["..."],"businessInsights":["..."],"keyDecisions":["..."],"mood":"חיובי/ניטרלי/מתוח","urgentItems":["..."],"trends":["..."],"brokenPromises":["..."],"recurringProblems":["..."]}`;

const JSON_MERGE = `{"topics":["כל הנושאים מכל החלקים"],"summary":"תקציר מקיף 5-8 משפטים","actionItems":["כל המשימות"],"openQuestions":["כל השאלות"],"businessInsights":["כל התובנות"],"keyDecisions":["כל ההחלטות"],"mood":"חיובי/ניטרלי/מתוח","urgentItems":["כל הדחופים"],"trends":["כל המגמות"],"brokenPromises":["כל ההבטחות"],"recurringProblems":["כל הבעיות"]}`;

// Step 1: Prepare — returns chunk count and metadata
async function summarizePrepare(request, env) {
  const { groupId, dateFrom, dateTo, focus } = await request.json();

  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json({ error: "קבוצה לא נמצאה" }, 404);

  let query = "SELECT date, time, sender, text FROM messages WHERE group_id = ?";
  const params = [groupId];
  if (dateFrom) { query += " AND parsed_date >= ?"; params.push(dateFrom); }
  if (dateTo) { query += " AND parsed_date <= ?"; params.push(dateTo); }
  query += " ORDER BY id ASC";
  const msgs = (await env.DB.prepare(query).bind(...params).all()).results;

  if (!msgs.length) return json({ error: "אין הודעות בטווח שנבחר" }, 400);

  const msgsPerChunk = 80;
  const totalChunks = Math.ceil(msgs.length / msgsPerChunk);
  const senderCount = {};
  for (const m of msgs) senderCount[m.sender] = (senderCount[m.sender] || 0) + 1;
  const topSenders = Object.entries(senderCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return json({
    totalMessages: msgs.length,
    totalChunks,
    chunkSize: msgsPerChunk,
    topSenders,
    groupName: group.name,
    context: group.context,
    focus: focus || group.focus || "",
  });
}

// Step 2: Summarize one chunk — uses LIMIT/OFFSET to avoid fetching all messages
async function summarizeChunk(request, env) {
  const { groupId, dateFrom, dateTo, chunkIndex, totalChunks, chunkSize, focus, groupName, context } = await request.json();

  const keyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq_key'").first();
  if (!keyRow) return json({ error: "API Key לא מוגדר" }, 400);

  const msgsPerChunk = chunkSize || 80;
  let query = "SELECT date, time, sender, text FROM messages WHERE group_id = ?";
  const params = [groupId];
  if (dateFrom) { query += " AND parsed_date >= ?"; params.push(dateFrom); }
  if (dateTo) { query += " AND parsed_date <= ?"; params.push(dateTo); }
  query += ` ORDER BY id ASC LIMIT ${msgsPerChunk} OFFSET ${chunkIndex * msgsPerChunk}`;
  const msgs = (await env.DB.prepare(query).bind(...params).all()).results;

  if (!msgs.length) return json({ chunkIndex, result: { summary: "", topics: [] } });

  const focusPrompt = focus ? `\nהמשתמש ביקש דגש מיוחד על: "${focus}" — וודא שכל אזכור של נושא זה מופיע בסיכום.` : "";
  const focusLine = focus ? `\nשים דגש מיוחד על: ${focus}` : "";
  const contextLine = context ? ` | נושא: ${context}` : "";

  const chatText = msgs.map(m => `[${m.date} ${m.time}] ${m.sender}: ${m.text}`).join("\n");
  // Trim if still too long
  const trimmed = chatText.length > 6000 ? chatText.slice(0, 6000) : chatText;
  const userMsg = `קבוצה: "${groupName}"${contextLine} | חלק ${chunkIndex + 1}/${totalChunks}${focusLine}\n${trimmed}`;

  const result = parseGroqResult(await callGroq(SYS_CHUNK + focusPrompt + "\n" + JSON_CHUNK, userMsg, keyRow.value));
  return json({ chunkIndex, result });
}

// Step 3: Merge all chunks and save
async function summarizeMerge(request, env) {
  const { groupId, dateFrom, dateTo, partials, totalMessages, topSenders, focus, groupName, context } = await request.json();

  const keyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq_key'").first();
  if (!keyRow) return json({ error: "API Key לא מוגדר" }, 400);

  let result;
  if (partials.length === 1) {
    result = partials[0];
  } else {
    const focusPrompt = focus ? `\nהמשתמש ביקש דגש מיוחד על: "${focus}".` : "";
    const mergeInput = `קבוצה: "${groupName}" | נושא: ${context || "כללי"} | דגש: ${focus || "הכל"}
סה"כ: ${totalMessages} הודעות | טופ: ${topSenders.map(([n, c]) => `${n}(${c})`).join(", ")}
סיכומי חלקים:\n${partials.map((p, i) => `חלק ${i + 1}: ${JSON.stringify(p)}`).join("\n")}`;
    result = parseGroqResult(await callGroq(SYS_MERGE + focusPrompt + "\n" + JSON_MERGE, mergeInput, keyRow.value));
  }

  // Save
  const summaryId = `${groupId}-${Date.now()}`;
  await env.DB.prepare(
    "INSERT INTO summaries (id, group_id, date_from, date_to, message_count, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(summaryId, groupId, dateFrom || null, dateTo || null, totalMessages, JSON.stringify(result), Date.now()).run();
  await env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(Date.now(), groupId).run();

  return json({ id: summaryId, result, messageCount: totalMessages });
}

// ── Cross Analysis ─────────────────────────────────────────────────────────

async function crossAnalyze(request, env) {
  const body = await request.json();
  const { groupIds } = body;

  const keyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq_key'").first();
  if (!keyRow) return json({ error: "API Key לא מוגדר" }, 400);

  // Get latest summary for each group
  const input = [];
  for (const gId of groupIds) {
    const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(gId).first();
    const summary = await env.DB.prepare(
      "SELECT result FROM summaries WHERE group_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(gId).first();
    if (group && summary) {
      const r = JSON.parse(summary.result);
      input.push({ name: group.name, summary: r.summary, actionItems: r.actionItems, businessInsights: r.businessInsights, trends: r.trends, brokenPromises: r.brokenPromises });
    }
  }

  const sys = `אתה מנתח תבניות חוצות-קבוצות. ענה בעברית בלבד. החזר JSON בלבד ללא backticks.
{"crossTopics":[{"topic":"נושא","groups":["..."],"insight":"..."}],"systemicProblems":["..."],"opportunities":["..."],"peopleInMultipleGroups":[{"name":"...","groups":["..."],"context":"..."}],"executiveSummary":"3 משפטים"}`;

  const result = parseGroqResult(await callGroq(sys, `נתח: ${JSON.stringify(input, null, 2)}`, keyRow.value));

  const id = `cross-${Date.now()}`;
  await env.DB.prepare(
    "INSERT INTO cross_analyses (id, group_ids, result, created_at) VALUES (?, ?, ?, ?)"
  ).bind(id, JSON.stringify(groupIds), JSON.stringify(result), Date.now()).run();

  return json({ id, result });
}

async function getCrossAnalyses(env) {
  const rows = await env.DB.prepare("SELECT * FROM cross_analyses ORDER BY created_at DESC").all();
  return json(rows.results.map(r => ({ ...r, result: JSON.parse(r.result), group_ids: JSON.parse(r.group_ids) })));
}

// ── Topic Scan ─────────────────────────────────────────────────────────────

async function scanTopics(request, env) {
  const body = await request.json();
  const { groupId, dateFrom, dateTo } = body;

  const keyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq_key'").first();
  if (!keyRow) return json({ error: "API Key לא מוגדר" }, 400);

  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json({ error: "קבוצה לא נמצאה" }, 404);

  let query = "SELECT date, time, sender, text FROM messages WHERE group_id = ?";
  const params = [groupId];
  if (dateFrom) { query += " AND parsed_date >= ?"; params.push(dateFrom); }
  if (dateTo) { query += " AND parsed_date <= ?"; params.push(dateTo); }
  query += " ORDER BY id ASC";
  const msgs = (await env.DB.prepare(query).bind(...params).all()).results;

  if (!msgs.length) return json({ error: "אין הודעות בטווח שנבחר" }, 400);

  // Sample messages for topic detection — take spread across the range
  const sampleSize = Math.min(msgs.length, 300);
  const step = Math.max(1, Math.floor(msgs.length / sampleSize));
  const sample = [];
  for (let i = 0; i < msgs.length; i += step) sample.push(msgs[i]);
  const chatText = sample.map(m => `[${m.date}] ${m.sender}: ${m.text}`).join("\n");

  const sys = `אתה סורק שיחות WhatsApp ומזהה את כל הנושאים שעלו. ענה בעברית בלבד. החזר JSON בלבד ללא backticks.
זהה כל נושא, גם קטן. לכל נושא תן דירוג חום (hot/warm/cold) לפי כמות הדיון וה"להט".
כלול: שמות מוצרים, כלים, אנשים, אירועים, בעיות, החלטות — כל דבר שדוברו עליו.
{"topics":[{"name":"שם הנושא","heat":"hot/warm/cold","messages":"~מספר הודעות משוער","keywords":["מילת מפתח 1","מילת מפתח 2"],"preview":"משפט אחד שמתאר על מה דיברו"}]}`;

  const result = parseGroqResult(await callGroq(sys, `קבוצה: "${group.name}" | ${msgs.length} הודעות\n${chatText}`, keyRow.value));

  return json({ topics: result.topics || [], messageCount: msgs.length });
}

// ── Search Messages ────────────────────────────────────────────────────────

async function searchMessages(groupId, url, env) {
  groupId = decodeURIComponent(groupId);
  const topic = url.searchParams.get("topic") || "";
  const dateFrom = url.searchParams.get("from");
  const dateTo = url.searchParams.get("to");
  const keywords = topic.split(",").map(k => k.trim()).filter(Boolean);

  if (!keywords.length) return json({ error: "חסרה מילת חיפוש" }, 400);

  let query = "SELECT date, time, sender, text FROM messages WHERE group_id = ?";
  const params = [groupId];
  if (dateFrom) { query += " AND parsed_date >= ?"; params.push(dateFrom); }
  if (dateTo) { query += " AND parsed_date <= ?"; params.push(dateTo); }
  query += " ORDER BY id ASC";
  const allMsgs = (await env.DB.prepare(query).bind(...params).all()).results;

  // Filter messages containing any keyword
  const filtered = allMsgs.filter(m => {
    const text = m.text.toLowerCase();
    return keywords.some(k => text.includes(k.toLowerCase()));
  });

  return json({ messages: filtered, total: allMsgs.length, matched: filtered.length });
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function getDashboard(env) {
  const groups = (await env.DB.prepare(
    "SELECT id, name, filename, message_count, first_message_date, last_message_date, created_at, updated_at FROM groups ORDER BY updated_at DESC"
  ).all()).results;

  const summaries = (await env.DB.prepare(
    "SELECT id, group_id, date_from, date_to, message_count, result, created_at FROM summaries ORDER BY created_at DESC"
  ).all()).results;

  const crossAnalyses = (await env.DB.prepare(
    "SELECT id, group_ids, result, created_at FROM cross_analyses ORDER BY created_at DESC LIMIT 10"
  ).all()).results;

  // Group summaries by group_id
  const summaryMap = {};
  for (const s of summaries) {
    if (!summaryMap[s.group_id]) summaryMap[s.group_id] = [];
    summaryMap[s.group_id].push({ ...s, result: JSON.parse(s.result) });
  }

  // Get first and last message per group
  const edgeMsgs = {};
  for (const g of groups) {
    const first = await env.DB.prepare("SELECT date, time, sender, text FROM messages WHERE group_id = ? ORDER BY id ASC LIMIT 1").bind(g.id).first();
    const last = await env.DB.prepare("SELECT date, time, sender, text FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT 1").bind(g.id).first();
    edgeMsgs[g.id] = { first, last };
  }

  return json({
    groups: groups.map(g => ({
      ...g,
      summaries: summaryMap[g.id] || [],
      firstMessage: edgeMsgs[g.id]?.first || null,
      lastMessage: edgeMsgs[g.id]?.last || null,
    })),
    crossAnalyses: crossAnalyses.map(c => ({ ...c, result: JSON.parse(c.result), group_ids: JSON.parse(c.group_ids) })),
    totalSummaries: summaries.length
  });
}

// ── Groq API ───────────────────────────────────────────────────────────────

async function callGroq(system, user, key) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      max_tokens: 3000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!res.ok) {
    const msgs = { 401: "API Key לא תקין", 413: "הצ׳אט ארוך מדי", 429: "rate_limit", 500: "שגיאה בשרת Groq" };
    throw new Error(msgs[res.status] || `שגיאת Groq: ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "{}";
}

function parseGroqResult(txt) {
  try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
  catch { return { summary: txt, actionItems: [], openQuestions: [], businessInsights: [], trends: [], brokenPromises: [], recurringProblems: [] }; }
}

function chunkMessages(messages, maxChars = 5500) {
  const chunks = []; let chunk = [], len = 0;
  for (const m of messages) {
    const line = `[${m.date} ${m.time}] ${m.sender}: ${m.text}`;
    if (len + line.length > maxChars && chunk.length) {
      chunks.push(chunk); chunk = []; len = 0;
    }
    chunk.push(m); len += line.length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// ── Fix dates migration ──────────────────────────────────────────────────────
async function fixDates(env) {
  const groups = (await env.DB.prepare("SELECT id FROM groups").all()).results;
  let fixed = 0;
  for (const g of groups) {
    const msgs = (await env.DB.prepare("SELECT id, date FROM messages WHERE group_id = ?").bind(g.id).all()).results;
    if (!msgs.length) continue;
    // Detect format
    _dateFormat = null;
    detectDateFormat(msgs.map(m => m.date));
    // Update in batches
    const batchSize = 50;
    for (let i = 0; i < msgs.length; i += batchSize) {
      const batch = msgs.slice(i, i + batchSize);
      const stmts = batch.map(m => {
        const pd = parseDate(m.date);
        return env.DB.prepare("UPDATE messages SET parsed_date = ? WHERE id = ?").bind(pd ? toISO(pd) : null, m.id);
      });
      await env.DB.batch(stmts);
    }
    // Update group dates
    const first = (await env.DB.prepare("SELECT parsed_date FROM messages WHERE group_id = ? AND parsed_date IS NOT NULL ORDER BY parsed_date ASC LIMIT 1").bind(g.id).first());
    const last = (await env.DB.prepare("SELECT parsed_date FROM messages WHERE group_id = ? AND parsed_date IS NOT NULL ORDER BY parsed_date DESC LIMIT 1").bind(g.id).first());
    await env.DB.prepare("UPDATE groups SET first_message_date = ?, last_message_date = ? WHERE id = ?")
      .bind(first?.parsed_date, last?.parsed_date, g.id).run();
    fixed += msgs.length;
  }
  return json({ ok: true, fixed });
}

// Detect date format from a batch of date strings
let _dateFormat = null;
function detectDateFormat(dates) {
  if (_dateFormat) return _dateFormat;
  for (const s of dates) {
    const p = s.split(/[\/\.]/);
    if (p.length < 3) continue;
    if (+p[1] > 12) { _dateFormat = "MM/DD/YY"; return _dateFormat; }
    if (+p[0] > 12) { _dateFormat = "DD/MM/YY"; return _dateFormat; }
  }
  _dateFormat = "DD/MM/YY"; // default
  return _dateFormat;
}

function parseDate(s) {
  const p = s.split(/[\/\.]/);
  if (p.length < 3) return null;
  let y = p[2]; if (y.length === 2) y = "20" + y;
  if (_dateFormat === "MM/DD/YY") {
    return new Date(+y, +p[0] - 1, +p[1]);
  }
  return new Date(+y, +p[1] - 1, +p[0]);
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function addCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, headers });
}
