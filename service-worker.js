"use strict";

const CACHE_NAME = "invomint-shell-v6";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon.png",
  "./workspace-embed.js",
  "./invoice-generator/index.html",
  "./invoice-generator/style.css",
  "./invoice-generator/app.js",
  "./receipt-generator/index.html",
  "./receipt-generator/styles.css",
  "./receipt-generator/script.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("invomint-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const update = fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  });
  event.waitUntil(update.then(() => undefined).catch(() => undefined));
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => {
    if (cached) return cached;
    return update.catch(async () => {
      if (request.mode === "navigate" &&
          (url.pathname.endsWith("/") || url.pathname.endsWith("/index.html"))) {
        return (await caches.match("./index.html")) || Response.error();
      }
      return Response.error();
    });
  }));
});
