/* Steady & Strong — offline cache.
   Keeps the whole app on the device so it opens with no connection. Network
   first so a fresh upload is picked up straight away; the cached copy is the
   fallback when there is no signal.

   The version below is bumped with every release. The page listens for a
   newly installed worker and offers a "there is a new version" button,
   instead of quietly serving last month's app for days on end. */
var VERSION = "v16";
var CACHE = "steady-strong-" + VERSION;
var CORE = ["./", "./index.html"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(CORE).catch(function(){}); }));
});

self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){ return k === CACHE ? null : caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener("message", function(e){
  var d = e.data;
  if(!d) return;
  if(d === "version" || d.type === "version"){
    if(e.source) e.source.postMessage({ type: "version", version: VERSION });
  }
  if(d === "skipWaiting" || d.type === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  if(url.origin !== location.origin) return;   /* fonts and libraries: leave to the browser */
  e.respondWith(
    fetch(req).then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(req, copy); });
      return res;
    }).catch(function(){
      return caches.match(req).then(function(hit){ return hit || caches.match("./index.html"); });
    })
  );
});
