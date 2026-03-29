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

  // Summaries
  if (path === "/api/summarize" && method === "POST") return summarize(request, env);
  if (path.match(/^\/api\/summaries\/[^/]+$/) && method === "GET") return getSummaries(path.split("/")[3], env);

  // Cross analysis
  if (path === "/api/cross-analyze" && method === "POST") return crossAnalyze(request, env);
  if (path === "/api/cross-analyses" && method === "GET") return getCrossAnalyses(env);

  // Dashboard
  if (path === "/api/dashboard" && method === "GET") return getDashboard(env);

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
  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
  if (!group) return json({ error: "Not found" }, 404);
  return json(group);
}

async function createGroup(request, env) {
  const body = await request.json();
  let { id, name, filename, context, focus, messages } = body;
  const now = Date.now();

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
  const body = await request.json();
  const { name, context, focus } = body;
  await env.DB.prepare(
    "UPDATE groups SET name = ?, context = ?, focus = ?, updated_at = ? WHERE id = ?"
  ).bind(name, context || "", focus || "", Date.now(), id).run();
  return json({ ok: true });
}

async function deleteGroup(id, env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM summaries WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function getMessages(groupId, url, env) {
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

// ── Summarize ──────────────────────────────────────────────────────────────

async function summarize(request, env) {
  const body = await request.json();
  const { groupId, dateFrom, dateTo } = body;

  // Get API key
  const keyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'groq_key'").first();
  if (!keyRow) return json({ error: "API Key לא מוגדר" }, 400);
  const apiKey = keyRow.value;

  // Get group info
  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json({ error: "קבוצה לא נמצאה" }, 404);

  // Get filtered messages
  let query = "SELECT date, time, sender, text FROM messages WHERE group_id = ?";
  const params = [groupId];
  if (dateFrom) { query += " AND parsed_date >= ?"; params.push(dateFrom); }
  if (dateTo) { query += " AND parsed_date <= ?"; params.push(dateTo); }
  query += " ORDER BY id ASC";
  const msgs = (await env.DB.prepare(query).bind(...params).all()).results;

  if (!msgs.length) return json({ error: "אין הודעות בטווח שנבחר" }, 400);

  // Get top senders
  const senderCount = {};
  for (const m of msgs) senderCount[m.sender] = (senderCount[m.sender] || 0) + 1;
  const topSenders = Object.entries(senderCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Chunk and summarize
  const chunks = chunkMessages(msgs, 5500);
  const partials = [];

  const sysChunk = `אתה מנתח שיחות WhatsApp לאנשי עסקים. ענה בעברית בלבד. החזר JSON בלבד ללא backticks ולא כלום אחר.
חשוב מאוד: ציין כל נושא שעלה בשיחה, גם אם הוא קטן. אל תדלג על שום נושא.
רשום כמה שיותר פריטים בכל שדה — עדיף יותר מדי מאשר פחות מדי.
{"topics":["נושא 1","נושא 2","נושא 3","...כל הנושאים שעלו"],"summary":"תקציר 3-5 משפטים מפורט","actionItems":["..."],"openQuestions":["..."],"businessInsights":["..."],"keyDecisions":["..."],"mood":"חיובי/ניטרלי/מתוח","urgentItems":["..."],"trends":["..."],"brokenPromises":["..."],"recurringProblems":["..."]}`;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(3000);
    const chatText = chunks[i].map(m => `[${m.date} ${m.time}] ${m.sender}: ${m.text}`).join("\n");
    const userMsg = `קבוצה: "${group.name}" | חלק ${i + 1}/${chunks.length}\n${chatText}`;
    partials.push(parseGroqResult(await callGroq(sysChunk, userMsg, apiKey)));
  }

  let result;
  if (chunks.length === 1) {
    result = partials[0];
  } else {
    const sysMerge = `אתה ממזג סיכומי חלקים של שיחת WhatsApp לסיכום אחד מקיף. ענה בעברית בלבד. החזר JSON בלבד ללא backticks ולא כלום אחר.
חשוב מאוד: שמור על כל הנושאים מכל החלקים. אל תשמיט שום נושא, גם אם הוא מוזכר רק בחלק אחד.
מזג את כל הפריטים מכל החלקים — עדיף רשימה ארוכה ומלאה מאשר קצרה וחסרה.
{"topics":["כל הנושאים שעלו בכל החלקים"],"summary":"תקציר מקיף 5-8 משפטים שמכסה את כל הנושאים","actionItems":["כל המשימות"],"openQuestions":["כל השאלות"],"businessInsights":["כל התובנות"],"keyDecisions":["כל ההחלטות"],"mood":"חיובי/ניטרלי/מתוח","urgentItems":["כל הדחופים"],"trends":["כל המגמות"],"brokenPromises":["כל ההבטחות"],"recurringProblems":["כל הבעיות"]}`;
    const mergeInput = `קבוצה: "${group.name}" | נושא: ${group.context || "כללי"} | דגש: ${group.focus || "הכל"}
סה"כ: ${msgs.length} הודעות | טופ: ${topSenders.map(([n, c]) => `${n}(${c})`).join(", ")}
סיכומי חלקים:\n${partials.map((p, i) => `חלק ${i + 1}: ${JSON.stringify(p)}`).join("\n")}`;
    await sleep(3000);
    result = parseGroqResult(await callGroq(sysMerge, mergeInput, apiKey));
  }

  // Save summary to DB
  const summaryId = `${groupId}-${Date.now()}`;
  await env.DB.prepare(
    "INSERT INTO summaries (id, group_id, date_from, date_to, message_count, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(summaryId, groupId, dateFrom || null, dateTo || null, msgs.length, JSON.stringify(result), Date.now()).run();

  // Update group timestamp
  await env.DB.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").bind(Date.now(), groupId).run();

  return json({ id: summaryId, result, messageCount: msgs.length, topSenders });
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

  return json({
    groups: groups.map(g => ({
      ...g,
      summaries: summaryMap[g.id] || []
    })),
    crossAnalyses: crossAnalyses.map(c => ({ ...c, result: JSON.parse(c.result), group_ids: JSON.parse(c.group_ids) })),
    totalSummaries: summaries.length
  });
}

// ── Groq API ───────────────────────────────────────────────────────────────

async function callGroq(system, user, key, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
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
    if (res.status === 429 && attempt < retries - 1) {
      await sleep(15000); // Wait 15s on rate limit
      continue;
    }
    if (!res.ok) {
      const msgs = { 401: "API Key לא תקין", 413: "הצ׳אט ארוך מדי", 429: "חריגה ממגבלת בקשות — נסה שוב בעוד דקה", 500: "שגיאה בשרת Groq" };
      throw new Error(msgs[res.status] || `שגיאת Groq: ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "{}";
  }
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

function parseDate(s) {
  const p = s.split(/[\/\.]/);
  if (p.length < 3) return null;
  let [d, mo, y] = p; if (y.length === 2) y = "20" + y;
  return new Date(+y, +mo - 1, +d);
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
