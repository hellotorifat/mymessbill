// সব API ফাইলের শেয়ার্ড অংশ (আগে ৬টা ফাইলে কপি করা ছিল)। নামের শুরুতে _ থাকায় Vercel এটাকে আলাদা endpoint বানায় না।
import { createHash } from "node:crypto";
import * as NC from "node:crypto";

// Redis (Upstash REST) স্টোরেজ। Vercel-এ Storage → Upstash Redis যুক্ত করলে এই env ভেরিয়েবলগুলো নিজে থেকেই বসে যায়।
// BP_MEMORY=1 শুধু লোকাল টেস্টের জন্য (মেমরিতে রাখে, রিস্টার্টে হারায়) — প্রোডাকশনে ব্যবহার করবেন না।
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const MEM = process.env.BP_MEMORY === "1";
const memCmd = MEM ? (await import("./_mem.js")).memCmd : null;

export class StoreError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

export async function cmds(list) {
  if (!list.length) return [];
  if (MEM) return list.map(memCmd);
  if (!URL_ || !TOKEN) throw new StoreError("storage_not_configured");
  let r;
  try {
    r = await fetch(URL_.replace(/\/$/, "") + "/pipeline", {
      method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(list.map((c) => c.map((x) => String(x)))),
    });
  } catch { throw new StoreError("storage_unreachable"); }
  if (!r.ok) { let t = ""; try { t = (await r.text()).slice(0, 120); } catch {} console.error("upstash", r.status, t); const e = new StoreError("storage_error_" + r.status); e.detail = t; throw e; }
  const j = await r.json();
  return j.map((x) => { if (x && x.error) { console.error("upstash cmd", x.error); const e = new StoreError("storage_cmd"); e.detail = String(x.error).slice(0, 120); throw e; } return x.result; });
}
export const cmd = async (...c) => (await cmds([c]))[0];
export const getJSON = async (k) => { const v = await cmd("GET", k); if (v == null) return null; try { return JSON.parse(v); } catch { return null; } };
export const setJSON = (k, o) => cmd("SET", k, JSON.stringify(o));

export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const J = (o, s = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
// ডেটাবেসের ভেতরের এরর-টেক্সট (detail) আর ক্লায়েন্টকে পাঠানো হয় না — শুধু সার্ভার লগে থাকে।
export const guard = (fn) => async (req) => {
  try { return await fn(req); }
  catch (e) {
    if (e instanceof StoreError) return J({ error: e.code }, e.status);
    // Vercel → Logs-এ খুঁজে পাওয়ার জন্য এক লাইনের JSON (ব্যবহারকারীর ডেটা বা টোকেন নয়)
    let path = ""; try { path = new URL(req.url).pathname; } catch {}
    console.error(JSON.stringify({ lvl: "error", app: "mymessbill", path, method: req.method, msg: String((e && e.message) || e).slice(0, 300), at: new Date().toISOString() }));
    return J({ error: "server" }, 500);
  }
};

export const okLk = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(x);
export const okId = (x) => typeof x === "string" && /^[A-Za-z0-9+/=_-]{4,32}$/.test(x);

/* ---------- রেট লিমিট ---------- */
// শুধু লেখা/ভারী endpoint-এ ব্যবহার হয় (পোলিং GET-এ নয়), যাতে Upstash-এর কমান্ড কোটা না বাড়ে।
// মেসের সবাই একই হোস্টেল ওয়াইফাই (একই IP) ব্যবহার করতে পারে, তাই সীমা উদার রাখা হয়েছে — উদ্দেশ্য শুধু ফ্লাড ঠেকানো।
// স্টোরেজ সমস্যা হলে রিকোয়েস্ট আটকানো হয় না (fail-open)।
export const ipOf = (req) => ((req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "?").slice(0, 64);
export async function limit(req, name, max, windowSec, extra = "") {
  try {
    const win = windowSec * 1000, b = Math.floor(Date.now() / win);
    const k = "rl_" + name + "_" + sha(ipOf(req) + "|" + extra).slice(0, 16) + "_" + b;
    const n = await cmd("INCR", k);
    if (n === 1) await cmd("PEXPIRE", k, win * 2);
    if (n > max) return J({ error: "rate_limited" }, 429, { "retry-after": String(windowSec) });
  } catch { /* fail-open */ }
  return null;
}

/* ---------- সেটিং, প্ল্যান ও মেম্বার সীমা ---------- */
export const DEF_PLANS = [
  { id: "p25", name: "২৫ জন পর্যন্ত", limit: 25, price: 100, days: 0 },
  { id: "p50", name: "৫০ জন পর্যন্ত", limit: 50, price: 200, days: 0 },
];
export async function getCfg() {
  const c = (await getJSON("cfg")) || {};
  return { free: c.free || 15, plans: Array.isArray(c.plans) && c.plans.length ? c.plans : DEF_PLANS, methods: Array.isArray(c.methods) ? c.methods : [], support: c.support || "", notice: c.notice || "" };
}
export async function entOf(id) { return (await getJSON("ent_" + id)) || null; }
export function limFrom(e, cfg) { return e && (!e.until || e.until > Date.now()) ? Math.max(e.limit || 0, cfg.free) : cfg.free; }
export const newPid = () => String(Date.now()).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/* ---------- অ্যাডমিনের জন্য মেসের সূচি (SCAN-এর বদলে) ---------- */
// vidx = সব মেসের id (স্কোর = শেষ আপডেটের সময়), vm_<id> = ছোট মেটা রেকর্ড। তাই অ্যাডমিন লিস্টে বড় ciphertext পড়তে হয় না।
export const metaOf = (rec) => ({ name: rec.name || "", ver: rec.ver || 0, cat: rec.cat || 0, uat: rec.uat || 0, codes: (rec.lks || []).length, mc: rec.mc === undefined ? null : rec.mc, size: (rec.ct || "").length });
export async function idxPut(rec) {
  await cmds([["SET", "vm_" + rec.id, JSON.stringify(metaOf(rec))], ["ZADD", "vidx", rec.uat || Date.now(), rec.id]]);
}
export async function idxDel(id) { await cmds([["DEL", "vm_" + id], ["ZREM", "vidx", id]]); }
export async function idxEnsure() {
  if (await cmd("GET", "vidx_ok")) return;
  let cur = "0", ids = [];
  do {
    const [nx, ks] = await cmd("SCAN", cur, "MATCH", "v_*", "COUNT", 500);
    cur = String(nx); ids.push(...ks.map((k) => k.slice(2)));
  } while (cur !== "0" && ids.length < 20000);
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    const rows = await cmds(part.map((id) => ["GET", "v_" + id]));
    const out = [];
    rows.forEach((r, j) => {
      let v = null; try { v = JSON.parse(r); } catch {}
      if (!v) return;
      out.push(["SET", "vm_" + part[j], JSON.stringify(metaOf({ ...v, id: part[j] }))], ["ZADD", "vidx", v.uat || v.cat || 1, part[j]]);
    });
    if (out.length) await cmds(out);
  }
  await cmd("SET", "vidx_ok", "1");
}

/* ---------- পেমেন্ট পরিসংখ্যান (কাউন্টার) ---------- */
// আগে শুধু শেষ ৩০০ পেমেন্ট দেখে revenue গোনা হতো। এখন কাউন্টার রাখা হয়; প্রথমবার সব পেমেন্ট গুনে চালু করা হয়।
export async function payStats() {
  if (!(await cmd("GET", "pstat_ok"))) {
    let p = 0, a = 0, r = 0;
    const ids = (await cmd("ZRANGE", "pays", 0, -1)) || [];
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await cmds(ids.slice(i, i + 200).map((x) => ["GET", "pay_" + x]));
      for (const x of rows) { try { const o = JSON.parse(x); if (o.st === "pending") p++; else if (o.st === "approved") { a++; r += +o.amount || 0; } } catch {} }
    }
    await cmds([["SET", "pstat_p", p], ["SET", "pstat_a", a], ["SET", "pstat_r", r], ["SET", "pstat_ok", "1"]]);
    return { pending: p, approved: a, revenue: r };
  }
  const [p, a, r] = await cmds([["GET", "pstat_p"], ["GET", "pstat_a"], ["GET", "pstat_r"]]);
  return { pending: Math.max(0, +p || 0), approved: Math.max(0, +a || 0), revenue: Math.max(0, +r || 0) };
}
export async function payBump(dp, da, dr) {
  if (!(await cmd("GET", "pstat_ok"))) return; // চালু না থাকলে প্রথম payStats() সব গুনে নেবে
  await cmds([["INCRBY", "pstat_p", dp], ["INCRBY", "pstat_a", da], ["INCRBY", "pstat_r", dr]]);
}

/* ---------- Web Push (লাইব্রেরি ছাড়া: VAPID ES256 + RFC 8291 aes128gcm) ---------- */
const Bf = (x) => Buffer.from(x);
export const ub64 = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
export const pb64 = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
export async function vapid() {
  let v = await getJSON("vapid");
  if (v && v.pub && v.prv) return v;
  const e = NC.createECDH("prime256v1"); e.generateKeys();
  v = { pub: pb64(e.getPublicKey()), prv: pb64(e.getPrivateKey()) };
  if (!(await cmd("SET", "vapid", JSON.stringify(v), "NX"))) v = await getJSON("vapid");
  return v;
}
function vapidJwt(aud, v) {
  const h = pb64(Bf(JSON.stringify({ typ: "JWT", alg: "ES256" }))), p = pb64(Bf(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://mymessbill.vercel.app" })));
  const pub = ub64(v.pub), d = ub64(v.prv);
  const key = NC.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: pb64(d), x: pb64(pub.subarray(1, 33)), y: pb64(pub.subarray(33, 65)) }, format: "jwk" });
  const sig = NC.createSign("SHA256").update(h + "." + p).sign({ key, dsaEncoding: "ieee-p1363" });
  return h + "." + p + "." + pb64(sig);
}
const hkdf = (salt, ikm, info, len) => { const prk = NC.createHmac("sha256", salt).update(ikm).digest(); let t = Buffer.alloc(0), out = Buffer.alloc(0), i = 1; while (out.length < len) { t = NC.createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i++])])).digest(); out = Buffer.concat([out, t]); } return out.subarray(0, len); };
function encryptPush(payload, p256dh, auth) {
  const ua = ub64(p256dh), as = ub64(auth), salt = NC.randomBytes(16), e = NC.createECDH("prime256v1"); e.generateKeys();
  const secret = e.computeSecret(ua), asPub = e.getPublicKey();
  const ikm = hkdf(as, secret, Buffer.concat([Bf("WebPush: info\0"), ua, asPub]), 32);
  const cek = hkdf(salt, ikm, Bf("Content-Encoding: aes128gcm\0"), 16), nonce = hkdf(salt, ikm, Bf("Content-Encoding: nonce\0"), 12);
  const c = NC.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Bf(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

// সার্ভার শুধু পরিচিত ব্রাউজার-পুশ সার্ভিসেই রিকোয়েস্ট পাঠায় (SSRF ঠেকাতে)।
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];
export function okPushEndpoint(s) {
  if (typeof s !== "string" || s.length > 600) return false;
  if (MEM && /^http:\/\/localhost(:\d+)?\//.test(s)) return true; // শুধু টেস্ট
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
    const h = u.hostname.toLowerCase();
    return PUSH_HOSTS.some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}
async function pushOne(sub, payload, v) {
  if (!okPushEndpoint(sub.e)) return 410; // অনুমোদিত নয় — তালিকা থেকে বাদ
  const u = new URL(sub.e);
  const body = encryptPush(payload, sub.p, sub.a);
  const r = await fetch(sub.e, { method: "POST", redirect: "manual", headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", authorization: "vapid t=" + vapidJwt(u.origin, v) + ", k=" + v.pub }, body, signal: AbortSignal.timeout(6000) });
  return r.status;
}
/* মেসের সব সাবস্ক্রাইবকে (প্রেরক বাদে) পুশ পাঠায়। টেক্সট ক্লায়েন্টে এনক্রিপ্টেড; সার্ভার শুধু ct পাঠিয়ে দেয়। */
export async function notifyMess(id, name, nf, exEndpoint, opts = {}) {
  try {
    const kind = nf && /^[a-z]{1,8}$/.test(nf.k || "") ? nf.k : "u";
    if (!opts.noThrottle && !(await cmd("SET", "pt_" + id + "_" + kind, "1", "NX", "PX", "4000"))) return 0;
    const subs = (await getJSON("ps_" + id)) || [];
    if (!subs.length) return 0;
    const v = await vapid();
    const pl = JSON.stringify({ id, n: String(name || "").slice(0, 40), k: kind, iv: nf && typeof nf.iv === "string" && nf.iv.length <= 24 ? nf.iv : "", ct: nf && typeof nf.ct === "string" && nf.ct.length <= 1500 ? nf.ct : "" });
    const live = [], seen = {};
    let sent = 0;
    for (const s of subs) {
      if (s.e === exEndpoint) { live.push(s); continue; }
      if (seen[s.l] === undefined) seen[s.l] = (await cmd("GET", "lk_" + s.l)) === id;
      if (!seen[s.l]) continue;
      let st = 0; try { st = await pushOne(s, pl, v); } catch { st = 0; }
      if (st === 404 || st === 410) continue;
      if (st >= 200 && st < 300) sent++;
      live.push(s);
    }
    if (live.length !== subs.length) await setJSON("ps_" + id, live);
    return sent;
  } catch (e) { console.error("push", e && e.message); return 0; }
}
