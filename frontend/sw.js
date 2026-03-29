const CACHE = "wa-summarizer-v6";
const ASSETS = ["/", "/index.html", "/manifest.json", "/css/style.css", "/js/parser.js", "/js/api.js", "/js/groq.js", "/js/app.js"];

// Install
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// Fetch
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Never cache API calls
  if (url.pathname.startsWith("/api/")) return;

  // Handle share target POST
  if (url.pathname.includes("share-target") && e.request.method === "POST") {
    e.respondWith(
      (async () => {
        const formData = await e.request.formData();

        let file = formData.get("file");
        if (!file || !(file instanceof File) || file.size === 0) {
          for (const [key, val] of formData.entries()) {
            if (val instanceof File && val.size > 0) { file = val; break; }
          }
        }

        const shareData = {};

        if (file && file.size > 0) {
          const arrayBuffer = await file.arrayBuffer();
          shareData.base64 = bufferToBase64(arrayBuffer);
          shareData.fileName = file.name || "shared-file.zip";
        } else {
          const text = formData.get("text") || formData.get("title") || formData.get("url") || "";
          if (text) {
            shareData.base64 = btoa(unescape(encodeURIComponent(text)));
            shareData.fileName = "shared-text.txt";
          }
        }

        if (shareData.base64) {
          const cache = await caches.open(CACHE);
          await cache.put(
            "/__pending_share__",
            new Response(JSON.stringify(shareData), { headers: { "Content-Type": "application/json" } })
          );

          const allClients = await clients.matchAll({ type: "window" });
          for (const client of allClients) {
            client.postMessage({ type: "SHARED_FILE", ...shareData });
          }
        }

        return Response.redirect("/?from=share", 303);
      })()
    );
    return;
  }

  // HTML + JS: network first, cache fallback.
  if (e.request.mode === "navigate" || e.request.destination === "document" || e.request.destination === "script") {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
