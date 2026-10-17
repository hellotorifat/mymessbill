// চালানোর নিয়ম: npm test   (BP_MEMORY=1 দিয়ে মেমরি ডেটাবেসে, কোনো আসল সার্ভার লাগে না)
process.env.BP_MEMORY = "1";
process.env.ADMIN_KEY = "test-admin-key-123456";
import test from "node:test";
import assert from "node:assert/strict";

const vault = await import("../api/vault.js");
const chat = await import("../api/chat.js");
const pay = await import("../api/pay.js");
const admin = await import("../api/admin.js");
const push = await import("../api/push.js");
const lib = await import("../api/_lib.js");

const req = (method, url, body, headers = {}) =>
  new Request("http://localhost" + url, { method, headers: { "content-type": "application/json", "x-forwarded-for": headers.ip || "1.2.3.4", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const jr = async (p) => { const res = await p; return { status: res.status, ...(await res.json().catch(() => ({}))) }; };
const rnd = (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
const wrap = { s: "s", i: "i", w: "w" };

function newMess(over = {}) {
  const id = "m" + rnd(10), token = rnd(40), lk = "L" + rnd(30);
  const body = { id, name: "টেস্ট মেস", A: wrap, M: wrap, di: "di", ct: "ct", base: 0, token, lks: [lk], mc: 3, ...over };
  return { id, token, lk, body };
}

test("vault: তৈরি, পড়া, ভুল টোকেন, পুরোনো সংস্করণ", async () => {
  const m = newMess();
  const r1 = await jr(await vault.PUT(req("PUT", "/api/vault", m.body)));
  assert.equal(r1.status, 200); assert.equal(r1.ver, 1);
  const g = await jr(await vault.GET(req("GET", "/api/vault?lk=" + m.lk)));
  assert.equal(g.status, 200); assert.equal(g.ct, "ct"); assert.equal(g.wh, undefined, "টোকেন-হ্যাশ ফাঁস হওয়া চলবে না");
  const bad = await jr(await vault.PUT(req("PUT", "/api/vault", { ...m.body, token: rnd(40), base: 1 })));
  assert.equal(bad.status, 403);
  const stale = await jr(await vault.PUT(req("PUT", "/api/vault", { ...m.body, base: 0 })));
  assert.equal(stale.status, 409);
  const ok2 = await jr(await vault.PUT(req("PUT", "/api/vault", { ...m.body, base: 1 })));
  assert.equal(ok2.ver, 2);
});

test("vault: ৯০০KB-এর বেশি হলে 413 ও সীমা জানানো হয়", async () => {
  const m = newMess({ ct: "x".repeat(950_000) });
  const r = await jr(await vault.PUT(req("PUT", "/api/vault", m.body)));
  assert.equal(r.status, 413); assert.equal(r.error, "big"); assert.equal(r.max, 900000);
});

test("vault: ফ্রি সীমার বেশি সদস্য হলে 402", async () => {
  const m = newMess({ mc: 40 });
  const r = await jr(await vault.PUT(req("PUT", "/api/vault", m.body)));
  assert.equal(r.status, 402); assert.equal(r.error, "member_limit");
});

test("push: শুধু পরিচিত পুশ সার্ভিস, অন্য সব বাতিল (SSRF)", () => {
  const ok = ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/abc"];
  const bad = ["https://evil.example.com/x", "https://169.254.169.254/latest", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.com/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://notfcm.googleapis.com.attacker.io/", "ftp://fcm.googleapis.com/", "javascript:alert(1)", "", null];
  for (const u of ok) assert.equal(lib.okPushEndpoint(u), true, u);
  for (const u of bad) assert.equal(lib.okPushEndpoint(u), false, String(u));
});

test("push: অনুমোদিত নয় এমন endpoint-এ সাবস্ক্রাইব করা যায় না", async () => {
  const m = newMess();
  await vault.PUT(req("PUT", "/api/vault", m.body));
  const r = await jr(await push.POST(req("POST", "/api/push", { a: "sub", lk: m.lk, sub: { endpoint: "https://evil.example.com/x", keys: { p256dh: "a", auth: "b" } } })));
  assert.equal(r.status, 400); assert.equal(r.error, "bad_sub");
  const g = await jr(await push.POST(req("POST", "/api/push", { a: "sub", lk: m.lk, sub: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "a", auth: "b" } } })));
  assert.equal(g.status, 200);
});

test("রেট লিমিট: সীমা পেরোলে 429, অন্য IP-তে চলে", async () => {
  const name = "t" + rnd(6);
  const r = (ip) => lib.limit(req("POST", "/x", {}, { ip }), name, 3, 60);
  for (let i = 0; i < 3; i++) assert.equal(await r("9.9.9.9"), null);
  const blocked = await r("9.9.9.9");
  assert.equal(blocked.status, 429); assert.ok(blocked.headers.get("retry-after"));
  assert.equal(await r("8.8.8.8"), null);
});

test("chat: পাঠানো ও পড়া", async () => {
  const m = newMess();
  await vault.PUT(req("PUT", "/api/vault", m.body));
  const p = await jr(await chat.POST(req("POST", "/api/chat", { lk: m.lk, iv: "aGVsbG8=", ct: "d29ybGQ=" })));
  assert.equal(p.status, 200); assert.ok(p.k);
  const g = await jr(await chat.GET(req("GET", "/api/chat?lk=" + m.lk)));
  assert.equal(g.msgs.length, 1);
});

async function adminPost(body, key = process.env.ADMIN_KEY, ip = "5.5.5.5") {
  return jr(await admin.POST(req("POST", "/api/admin", body, { "x-admin-key": key, ip })));
}

test("পেমেন্ট: জমা, ডুপ্লিকেট TrxID, বাতিলে TrxID মুক্ত, অনুমোদনে সীমা বাড়ে, কাউন্টার ঠিক", async () => {
  // কাউন্টার চালু করা হোক (খালি অবস্থা থেকে)
  const s0 = (await adminPost({ a: "cfgget" })).stats;
  const mm = await adminPost({ a: "method", method: { name: "bKash", num: "01700000000" } });
  assert.equal(mm.status, 200);
  const m = newMess();
  await vault.PUT(req("PUT", "/api/vault", m.body));
  const sub = (trx) => jr(pay.POST(req("POST", "/api/pay", { id: m.id, token: m.token, a: "submit", plan: "p25", method: mm.id, sender: "01711111111", trx })));
  const a = await sub("ABC12345");
  assert.equal(a.status, 200);
  assert.equal((await sub("ABC12345")).status, 409, "একই TrxID দুইবার নয়");
  assert.equal((await adminPost({ a: "cfgget" })).stats.pending, s0.pending + 1);

  const rej = await adminPost({ a: "payact", id: a.id, act: "reject", note: "ভুল" });
  assert.equal(rej.status, 200);
  assert.equal((await adminPost({ a: "payact", id: a.id, act: "reject" })).status, 409, "ডাবল অ্যাকশন নয়");
  const b = await sub("ABC12345");
  assert.equal(b.status, 200, "বাতিল হওয়া TrxID আবার জমা দেওয়া যায়");
  const ok = await adminPost({ a: "payact", id: b.id, act: "approve" });
  assert.equal(ok.status, 200);
  const st = (await adminPost({ a: "cfgget" })).stats;
  assert.equal(st.pending, s0.pending);
  assert.equal(st.approved, s0.approved + 1);
  assert.equal(st.revenue, s0.revenue + 100);
  const ent = await jr(await pay.POST(req("POST", "/api/pay", { id: m.id, token: m.token, a: "ent" })));
  assert.equal(ent.limit, 25);
  // এবার ২৫ জন পর্যন্ত সদস্য সংরক্ষণ করা যায়
  const up = await jr(await vault.PUT(req("PUT", "/api/vault", { ...m.body, base: 1, mc: 22 })));
  assert.equal(up.status, 200);
});

test("পেমেন্ট: পেন্ডিং ৩টির বেশি হয় না — একসাথে পাঠালেও না, একটার পর একটা পাঠালেও না", async () => {
  const mm = await adminPost({ a: "method", method: { name: "Nagad", num: "01800000000" } });
  const m = newMess();
  await vault.PUT(req("PUT", "/api/vault", m.body));
  const sub = (t) => jr(pay.POST(req("POST", "/api/pay", { id: m.id, token: m.token, a: "submit", plan: "p25", method: mm.id, sender: "01711111111", trx: t })));
  const par = await Promise.all(["AAAAAA01", "AAAAAA02", "AAAAAA03", "AAAAAA04", "AAAAAA05"].map(sub));
  assert.ok(par.filter((s) => s.status === 200).length >= 1, "অন্তত একটা সফল");
  assert.ok(par.filter((s) => s.status === 429 && s.error === "busy").length >= 1, "বাকিগুলো busy হিসেবে আটকায়");
  for (const t of ["BBBBBB01", "BBBBBB02", "BBBBBB03", "BBBBBB04"]) await sub(t);
  const ent = await jr(pay.POST(req("POST", "/api/pay", { id: m.id, token: m.token, a: "ent" })));
  assert.equal(ent.pays.filter((p) => p.st === "pending").length, 3);
  const over = await sub("CCCCCC01");
  assert.equal(over.status, 429); assert.equal(over.error, "too_many_pending");
});

test("অ্যাডমিন: ভুল কী ৮ বার হলে লক, সঠিক কী-ও তখন আটকে", async () => {
  const ip = "7.7.7.7";
  for (let i = 0; i < 8; i++) assert.equal((await adminPost({ a: "cfgget" }, "wrong-key-" + i, ip)).status, 403);
  const locked = await adminPost({ a: "cfgget" }, process.env.ADMIN_KEY, ip);
  assert.equal(locked.status, 429); assert.equal(locked.error, "locked");
  assert.equal((await adminPost({ a: "cfgget" }, process.env.ADMIN_KEY, "6.6.6.6")).status, 200, "অন্য IP আটকায় না");
});

test("অ্যাডমিন: মেস তালিকা পেজিনেশন, সার্চ ও মোছা", async () => {
  const names = ["আলফা মেস", "বিটা মেস", "গামা বাসা"];
  const ms = [];
  for (const n of names) { const m = newMess({ name: n + rnd(4) }); await vault.PUT(req("PUT", "/api/vault", m.body)); ms.push(m); }
  const list = (q) => jr(admin.GET(req("GET", "/api/admin" + q, undefined, { "x-admin-key": process.env.ADMIN_KEY, ip: "4.4.4.4" })));
  const all = await list("?limit=2&offset=0");
  assert.equal(all.list.length, 2); assert.ok(all.total >= 3);
  const s = await list("?q=" + encodeURIComponent("গামা"));
  assert.equal(s.list.length, 1); assert.equal(s.list[0].id, ms[2].id);
  const del = await jr(admin.DELETE(req("DELETE", "/api/admin?id=" + ms[2].id, undefined, { "x-admin-key": process.env.ADMIN_KEY, ip: "4.4.4.4" })));
  assert.equal(del.status, 200);
  assert.equal((await list("?q=" + encodeURIComponent("গামা"))).list.length, 0);
});

test("অ্যাডমিন: cfgget-এ দুর্বল কী ও SERVER_SECRET-এর সতর্কতা আসে", async () => {
  const r = await adminPost({ a: "cfgget" });
  assert.equal(r.warn.weakKey, false); assert.equal(r.warn.noSecret, true);
});

test("guard: স্টোরেজ এররের ভেতরের টেক্সট ক্লায়েন্টে যায় না", async () => {
  const h = lib.guard(async () => { const e = new lib.StoreError("storage_error_401"); e.detail = "WRONGPASS secret-detail"; throw e; });
  const r = await jr(await h(req("GET", "/x")));
  assert.equal(r.status, 503); assert.equal(r.error, "storage_error_401"); assert.equal(r.detail, undefined);
});

/* ---------- অটো রিমাইন্ডার + cron ---------- */
import http from "node:http";
import { createECDH, randomBytes } from "node:crypto";
process.env.CRON_SECRET = "cron-secret-for-tests-1234";
const remind = await import("../api/remind.js");
const cron = await import("../api/cron.js");
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

test("রিমাইন্ডার: ম্যানেজার ছাড়া সেট করা যায় না, ভুল ফরম্যাট বাতিল", async () => {
  const m = newMess();
  await vault.PUT(req("PUT", "/api/vault", m.body));
  const ok = { id: "r1", k: "w", d: 2, iv: "aXY=", ct: "Y3Q=" };
  const post = (b) => jr(remind.POST(req("POST", "/api/remind", { id: m.id, token: m.token, a: "set", ...b })));
  assert.equal((await jr(remind.POST(req("POST", "/api/remind", { id: m.id, token: rnd(40), a: "set", list: [ok] })))).status, 403);
  assert.equal((await post({ list: [ok] })).status, 200);
  assert.equal((await post({ list: [{ ...ok, k: "m", d: 31 }] })).status, 400, "মাসের তারিখ ২৮-এর বেশি নয়");
  assert.equal((await post({ list: [{ ...ok, k: "x" }] })).status, 400);
  assert.equal((await post({ list: [{ ...ok, ct: "<script>" }] })).status, 400);
  assert.equal((await post({ list: Array.from({ length: 11 }, (_, i) => ({ ...ok, id: "r" + i })) })).status, 200, "১০টির বেশি হলে বাড়তিগুলো ছাঁটা হয়");
  assert.equal((await jr(remind.POST(req("POST", "/api/remind", { id: "nonexist1", token: rnd(40), a: "set", list: [] })))).status, 404);
  const s = await jr(remind.GET(req("GET", "/api/remind?s=1")));
  assert.equal(s.cron, true);
});

test("cron: Authorization ছাড়া 401; সঠিক হলে আজকের রিমাইন্ডার একবারই যায়", async () => {
  const hits = [];
  const srv = http.createServer((q, r) => { let n = 0; q.on("data", (c) => (n += c.length)); q.on("end", () => { hits.push({ url: q.url, bytes: n, enc: q.headers["content-encoding"] }); r.writeHead(201); r.end(); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const m = newMess();
    await vault.PUT(req("PUT", "/api/vault", m.body));
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const sub = { endpoint: `http://localhost:${port}/push/abc`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } };
    assert.equal((await jr(push.POST(req("POST", "/api/push", { a: "sub", lk: m.lk, sub })))).status, 200);
    const dhaka = new Date(Date.now() + 6 * 3600 * 1000), today = dhaka.toISOString().slice(0, 10), wd = dhaka.getUTCDay();
    const list = [
      { id: "w1", k: "w", d: wd, iv: "aXZpdml2aXZpdml2", ct: "Y3RjdGN0" },            // আজকের বার → যাবে
      { id: "w2", k: "w", d: (wd + 3) % 7, iv: "aXZpdmw=", ct: "Y3Q=" },              // অন্য বার → যাবে না
      { id: "o1", k: "o", d: today, iv: "aXZpdmw=", ct: "Y3Q=" },                     // আজকের এককালীন → যাবে
      { id: "o2", k: "o", d: "2020-01-01", iv: "aXZpdmw=", ct: "Y3Q=" },              // মেয়াদ পেরিয়েছে → বাদ
    ];
    assert.equal((await jr(remind.POST(req("POST", "/api/remind", { id: m.id, token: m.token, a: "set", list })))).status, 200);

    assert.equal((await jr(cron.GET(req("GET", "/api/cron")))).status, 401);
    assert.equal((await jr(cron.GET(req("GET", "/api/cron", undefined, { authorization: "Bearer wrong-wrong-wrong-wrong" })))).status, 401);
    const auth = { authorization: "Bearer " + process.env.CRON_SECRET };
    const r1 = await jr(cron.GET(req("GET", "/api/cron", undefined, auth)));
    assert.equal(r1.status, 200);
    const mine = hits.length;
    assert.equal(mine >= 2, true, "আজকের দুটো রিমাইন্ডারের পুশ গেছে (" + mine + ")");
    assert.equal(hits.every((h) => h.enc === "aes128gcm" && h.bytes > 100), true);
    const before = hits.length;
    const r2 = await jr(cron.GET(req("GET", "/api/cron", undefined, auth)));
    assert.equal(r2.status, 200);
    assert.equal(hits.length, before, "একই দিনে দ্বিতীয়বার cron চললে ডুপ্লিকেট যায় না");
    // মেয়াদ পেরোনো এককালীন রিমাইন্ডার মুছে গেছে
    const stored = await lib.getJSON("rm_" + m.id);
    assert.equal(stored.find((x) => x.id === "o2"), undefined);
    assert.equal(stored.length, 3);
  } finally { srv.close(); }
});

test("cron: CRON_SECRET না থাকলে 503 (চুপচাপ ব্যর্থ নয়)", async () => {
  const keep = process.env.CRON_SECRET; process.env.CRON_SECRET = "short";
  try { const r = await jr(cron.GET(req("GET", "/api/cron", undefined, { authorization: "Bearer short" }))); assert.equal(r.status, 503); assert.equal(r.error, "cron_not_configured"); }
  finally { process.env.CRON_SECRET = keep; }
});
