// অ্যাপ শেল ক্যাশ: নেটওয়ার্ক আগে, না পেলে ক্যাশ। /api/* কখনো ক্যাশ হয় না।
const C="bp-v21",SHELL=["/","/index.html","/manifest.webmanifest","/icon-192.png","/rifat.webp","/logo.webp"],LATER=["/vendor/html2canvas.min.js","/vendor/jspdf.umd.min.js"];
// অ্যাপ শেল ইনস্টলের সময়; PDF লাইব্রেরি (থাকলে) পিছনে ক্যাশ হয় — না থাকলে ইনস্টল আটকায় না। তাই অফলাইনেও PDF চলে।
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL).then(()=>Promise.allSettled(LATER.map(u=>c.add(u))))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api/"))return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match("/index.html"))));
});

/* ---------- পুশ নোটিফিকেশন ---------- */
const GEN={rem:"⏰ রিমাইন্ডার",chat:"💬 চ্যাটে নতুন মেসেজ",meal:"🍽 মিলে আপডেট",bazar:"🛒 বাজারে আপডেট",duty:"📅 রুটিনে আপডেট",pub:"📋 ম্যানেজার আপডেট করেছেন"};
const idbGet=id=>new Promise(res=>{try{const q=indexedDB.open("bpnf",1);q.onupgradeneeded=()=>q.result.createObjectStore("k");q.onsuccess=()=>{try{const g=q.result.transaction("k").objectStore("k").get(id);g.onsuccess=()=>res(g.result||null);g.onerror=()=>res(null)}catch(e){res(null)}};q.onerror=()=>res(null)}catch(e){res(null)}});
const u8=t=>Uint8Array.from(atob(t),c=>c.charCodeAt(0));
self.addEventListener("push",e=>{e.waitUntil((async()=>{
  let d={};try{d=e.data.json()}catch(x){}
  let t=d.n||"mymessbill",b=GEN[d.k]||"মেসে নতুন আপডেট";
  if(d.iv&&d.ct&&d.id){try{const k=await idbGet(d.id);if(k){const key=await crypto.subtle.importKey("raw",u8(k),"AES-GCM",false,["decrypt"]);const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:u8(d.iv)},key,u8(d.ct));const o=JSON.parse(new TextDecoder().decode(pt));if(o.t)t=o.t;if(o.b)b=o.b}}catch(x){}}
  const cl=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  if(cl.some(c=>c.visibilityState==="visible"))return;
  await self.registration.showNotification(t,{body:b,icon:"/icon-192.png",badge:"/icon-192.png",tag:(d.id||"")+(d.k||""),renotify:true,data:{u:"/"}})})())});
self.addEventListener("notificationclick",e=>{e.notification.close();e.waitUntil((async()=>{
  const cl=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  for(const c of cl){if("focus" in c){await c.focus();return}}
  if(self.clients.openWindow)await self.clients.openWindow("/")})())});
