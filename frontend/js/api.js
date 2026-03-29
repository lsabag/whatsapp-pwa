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
  deleteGroup(id) { return this.fetch(`/groups/${id}`, { method: "DELETE" }); },
  getMessages(groupId, from, to) {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return this.fetch(`/groups/${groupId}/messages?${params}`);
  },

  // Summarize
  summarize(groupId, dateFrom, dateTo) {
    return this.fetch("/summarize", { method: "POST", body: { groupId, dateFrom, dateTo } });
  },

  // Summaries
  getSummaries(groupId) { return this.fetch(`/summaries/${groupId}`); },
  deleteSummary(id) { return this.fetch(`/summaries/${encodeURIComponent(id)}`, { method: "DELETE" }); },

  // Cross analysis
  crossAnalyze(groupIds) { return this.fetch("/cross-analyze", { method: "POST", body: { groupIds } }); },
  getCrossAnalyses() { return this.fetch("/cross-analyses"); },

  // Dashboard
  getDashboard() { return this.fetch("/dashboard"); },
};
