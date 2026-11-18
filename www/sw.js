const V='sigl-meg-v4';
const FILES=['./','index.html','style.css','app.js','data.js','maps.js','config.js','vendor/xlsx.js','vendor/jspdf.js','vendor/autotable.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
// Hors connexion d'abord ; en ligne, le cache est rafraîchi en arrière-plan (la mise à jour s'applique à l'ouverture suivante)
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(caches.open(V).then(c=>c.match(e.request,{ignoreSearch:true}).then(hit=>{
    const net=fetch(e.request).then(r=>{if(r&&r.ok&&new URL(e.request.url).origin===location.origin)c.put(e.request,r.clone());return r}).catch(()=>hit);
    return hit||net;
  })));
});
