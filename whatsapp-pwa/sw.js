const CACHE = "wa-summarizer-v1";
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
  if (url.pathname === "/share-target" && e.request.method === "POST") {
    e.respondWith(
      (async () => {
        const formData = await e.request.formData();
        const file = formData.get("file");

        if (file) {
          const arrayBuffer = await file.arrayBuffer();
          const base64 = bufferToBase64(arrayBuffer);
          const fileName = file.name;

          // Send to all open clients
          const allClients = await clients.matchAll({ type: "window" });
          for (const client of allClients) {
            client.postMessage({ type: "SHARED_FILE", base64, fileName });
          }

          // If no clients open, store in cache and redirect
          if (allClients.length === 0) {
            const cache = await caches.open(CACHE);
            await cache.put(
              "/__pending_share__",
              new Response(JSON.stringify({ base64, fileName }), {
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
