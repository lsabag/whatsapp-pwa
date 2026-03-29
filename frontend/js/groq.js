// ── Groq Client (runs from browser, not Worker) ─────────────────────────────
const Groq = {
  async call(system, user, apiKey) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.3,
        max_tokens: 3000,
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      })
    });
    if (res.status === 429) throw new Error("rate_limit");
    if (!res.ok) {
      const msgs = { 401: "API Key לא תקין", 413: "הצ׳אט ארוך מדי", 500: "שגיאה בשרת Groq" };
      throw new Error(msgs[res.status] || `שגיאת Groq: ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "{}";
  },

  parse(txt) {
    try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
    catch { return { summary: txt, topics: [], actionItems: [], openQuestions: [], businessInsights: [], trends: [], brokenPromises: [], recurringProblems: [] }; }
  }
};
