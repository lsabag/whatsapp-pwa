// ── API Client ───────────────────────────────────────────────────────────────
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
  getGroup(id) { return this.fetch(`/groups/${id}`); },
  createGroup(group) { return this.fetch("/groups", { method: "POST", body: group }); },
  updateGroup(id, data) { return this.fetch(`/groups/${id}`, { method: "PUT", body: data }); },
  deleteGroup(id) { return this.fetch(`/groups/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  getMessages(groupId, from, to) {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return this.fetch(`/groups/${groupId}/messages?${params}`);
  },

  // Summarize (step-by-step)
  summarizePrepare(groupId, dateFrom, dateTo, focus) {
    return this.fetch("/summarize/prepare", { method: "POST", body: { groupId, dateFrom, dateTo, focus } });
  },
  summarizeChunk(params) {
    return this.fetch("/summarize/chunk", { method: "POST", body: params });
  },
  summarizeMerge(params) {
    return this.fetch("/summarize/merge", { method: "POST", body: params });
  },

  // Summaries
  getSummaries(groupId) { return this.fetch(`/summaries/${groupId}`); },
  deleteSummary(id) { return this.fetch(`/summaries/${encodeURIComponent(id)}`, { method: "DELETE" }); },

  // Topic scan
  scanTopics(groupId, dateFrom, dateTo) {
    return this.fetch("/scan-topics", { method: "POST", body: { groupId, dateFrom, dateTo } });
  },
  searchMessages(groupId, topic, dateFrom, dateTo) {
    const params = new URLSearchParams({ topic });
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    return this.fetch(`/groups/${groupId}/search?${params}`);
  },

  // Cross analysis
  crossAnalyze(groupIds) { return this.fetch("/cross-analyze", { method: "POST", body: { groupIds } }); },
  getCrossAnalyses() { return this.fetch("/cross-analyses"); },

  // Dashboard
  getDashboard() { return this.fetch("/dashboard"); },
};
