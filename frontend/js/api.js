// ── API Client (DB operations only — Groq is called from browser) ────────────
const API = {
  async fetch(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `שגיאה: ${res.status}`);
    return data;
  },

  // Settings
  getSettings() { return this.fetch("/settings"); },
  saveSettings(settings) { return this.fetch("/settings", { method: "POST", body: settings }); },

  // Groups
  getGroups() { return this.fetch("/groups"); },
  createGroup(group) { return this.fetch("/groups", { method: "POST", body: group }); },
  updateGroup(id, data) { return this.fetch(`/groups/${encodeURIComponent(id)}`, { method: "PUT", body: data }); },
  deleteGroup(id) { return this.fetch(`/groups/${encodeURIComponent(id)}`, { method: "DELETE" }); },

  // Summarize steps
  summarizePrepare(groupId, dateFrom, dateTo, focus) {
    return this.fetch("/summarize/prepare", { method: "POST", body: { groupId, dateFrom, dateTo, focus } });
  },
  getChunkMessages(groupId, dateFrom, dateTo, chunkIndex, chunkSize) {
    return this.fetch("/summarize/get-chunk", { method: "POST", body: { groupId, dateFrom, dateTo, chunkIndex, chunkSize } });
  },
  saveSummary(groupId, dateFrom, dateTo, result, totalMessages) {
    return this.fetch("/summarize/save", { method: "POST", body: { groupId, dateFrom, dateTo, result, totalMessages } });
  },

  // Summaries
  getSummaries(groupId) { return this.fetch(`/summaries/${encodeURIComponent(groupId)}`); },
  deleteSummary(id) { return this.fetch(`/summaries/${encodeURIComponent(id)}`, { method: "DELETE" }); },

  // Topic scan (returns messages, frontend calls Groq)
  scanTopicsData(groupId, dateFrom, dateTo) {
    return this.fetch("/scan-topics", { method: "POST", body: { groupId, dateFrom, dateTo } });
  },
  searchMessages(groupId, topic, dateFrom, dateTo) {
    const params = new URLSearchParams({ topic });
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return this.fetch(`/groups/${encodeURIComponent(groupId)}/search?${params}`);
  },

  // Cross analysis
  crossAnalyze(groupIds) { return this.fetch("/cross-analyze", { method: "POST", body: { groupIds } }); },
  getCrossAnalyses() { return this.fetch("/cross-analyses"); },

  // Dashboard
  getDashboard() { return this.fetch("/dashboard"); },
};
