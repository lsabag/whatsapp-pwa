const CACHE = "wa-summarizer-v3";
const ASSETS = ["/", "/index.html", "/manifest.json"];

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

  // Handle share target POST
  if (url.pathname.includes("share-target") && e.request.method === "POST") {
    e.respondWith(
      (async () => {
        const formData = await e.request.formData();

        // Try to get file from form data — check multiple possible field names
        let file = formData.get("file");
        if (!file || !(file instanceof File)) {
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
          // Fallback: capture text/title/url params (WhatsApp sometimes shares as text)
          const text = formData.get("text") || formData.get("title") || formData.get("url") || "";
          if (text) {
            shareData.base64 = btoa(unescape(encodeURIComponent(text)));
            shareData.fileName = "shared-text.txt";
          }
        }

        if (shareData.base64) {
          const allClients = await clients.matchAll({ type: "window" });
          for (const client of allClients) {
            client.postMessage({ type: "SHARED_FILE", ...shareData });
          }

          if (allClients.length === 0) {
            const cache = await caches.open(CACHE);
            await cache.put(
              "/__pending_share__",
              new Response(JSON.stringify(shareData), {
                headers: { "Content-Type": "application/json" }
              })
            );
          }
        }

        return Response.redirect("/", 303);
      })()
    );
    return;
  }

  // Normal fetch with cache fallback
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
