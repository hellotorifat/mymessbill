import { createHash } from "node:crypto";
// Redis (Upstash REST) স্টোরেজ। Vercel-এ Storage → Upstash Redis যুক্ত করলে এই env ভেরিয়েবলগুলো নিজে থেকেই বসে যায়।
// BP_MEMORY=1 শুধু লোকাল টেস্টের জন্য (মেমরিতে রাখে, রিস্টার্টে হারায়) — প্রোডাকশনে ব্যবহার করবেন না।
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

class StoreError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

/* ---------- মেমরি ব্যাকএন্ড (শুধু টেস্ট) ---------- */
const G = (globalThis.__bpmem ??= { mem: new Map(), zs: new Map(), exp: new Map() }); const { mem, zs, exp } = G;
function alive(k) { const e = exp.get(k); if (e && e < Date.now()) { mem.delete(k); exp.delete(k); return false; } return true; }
function memCmd(c) {
  const [op, k, ...a] = c; const O = String(op).toUpperCase();
  const Z = () => { if (!zs.has(k)) zs.set(k, []); return zs.get(k); };
  switch (O) {
    case "GET": return alive(k) && mem.has(k) ? mem.get(k) : null;
    case "SET": {
      const nx = a.includes("NX"); if (nx && alive(k) && mem.has(k)) return null;
      mem.set(k, a[0]); const i = a.indexOf("PX"); if (i >= 0) exp.set(k, Date.now() + +a[i + 1]); else exp.delete(k); return "OK";
    }
    case "DEL": { const d = mem.delete(k) | zs.delete(k); return d ? 1 : 0; }
    case "SCAN": { const m = String(a[1] === "MATCH" ? a[2] : "*").replace(/\*$/, ""); return ["0", [...mem.keys()].filter((x) => x.startsWith(m) && alive(x))]; }
    case "ZADD": { const z = Z(); if (!z.includes(a[1])) z.push(a[1]); z.sort(); return 1; }
    case "ZCARD": return (zs.get(k) || []).length;
    case "ZRANGE": { const z = zs.get(k) || []; let s = +a[0], e = +a[1]; if (s < 0) s = Math.max(0, z.length + s); if (e < 0) e = z.length + e; return z.slice(s, e + 1); }
    case "ZRANGEBYLEX": {
      const z = zs.get(k) || []; const mn = a[0], mx = a[1]; let r = z.filter((m) => (mn === "-" ? true : mn[0] === "(" ? m > mn.slice(1) : m >= mn.slice(1)) && (mx === "+" ? true : mx[0] === "(" ? m < mx.slice(1) : m <= mx.slice(1)));
      const li = a.indexOf("LIMIT"); if (li >= 0) r = r.slice(+a[li + 1], +a[li + 1] + +a[li + 2]); return r;
    }
    case "ZREMRANGEBYRANK": { const z = zs.get(k) || []; let s = +a[0], e = +a[1]; if (s < 0) s = Math.max(0, z.length + s); if (e < 0) e = z.length + e; z.splice(s, Math.max(0, e - s + 1)); return 1; }
    default: throw new StoreError("store_cmd");
  }
}

async function cmds(list) {
  if (!list.length) return [];
  if (process.env.BP_MEMORY === "1") return list.map(memCmd);
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
const cmd = async (...c) => (await cmds([c]))[0];
const getJSON = async (k) => { const v = await cmd("GET", k); if (v == null) return null; try { return JSON.parse(v); } catch { return null; } };
const setJSON = (k, o) => cmd("SET", k, JSON.stringify(o));

const sha = (s) => createHash("sha256").update(s).digest("hex");
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const guard = (fn) => async (req) => {
  try { return await fn(req); }
  catch (e) {
    if (e instanceof StoreError) return J({ error: e.code, detail: e.detail }, e.status);
    console.error(e); return J({ error: "server" }, 500);
  }
};


/* ---------- সেটিং, প্ল্যান ও মেম্বার সীমা ---------- */
const DEF_PLANS = [
  { id: "p25", name: "২৫ জন পর্যন্ত", limit: 25, price: 100, days: 0 },
  { id: "p50", name: "৫০ জন পর্যন্ত", limit: 50, price: 200, days: 0 },
];
async function getCfg() {
  const c = (await getJSON("cfg")) || {};
  return { free: c.free || 15, plans: Array.isArray(c.plans) && c.plans.length ? c.plans : DEF_PLANS, methods: Array.isArray(c.methods) ? c.methods : [], support: c.support || "", notice: c.notice || "" };
}
async function entOf(id) { return (await getJSON("ent_" + id)) || null; }
function limFrom(e, cfg) { return e && (!e.until || e.until > Date.now()) ? Math.max(e.limit || 0, cfg.free) : cfg.free; }
const newPid = () => String(Date.now()).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/* ---------- Web Push (লাইব্রেরি ছাড়া: VAPID ES256 + RFC 8291 aes128gcm) ---------- */
import * as NC from "node:crypto";
const Bf = (x) => Buffer.from(x);
const ub64 = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const pb64 = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
async function vapid() {
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
async function pushOne(sub, payload, v) {
  const u = new URL(sub.e);
  if (u.protocol !== "https:" && !(process.env.BP_MEMORY === "1" && u.hostname === "localhost")) return 0;
  const body = encryptPush(payload, sub.p, sub.a);
  const r = await fetch(sub.e, { method: "POST", headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", authorization: "vapid t=" + vapidJwt(u.origin, v) + ", k=" + v.pub }, body, signal: AbortSignal.timeout(6000) });
  return r.status;
}
/* মেসের সব সাবস্ক্রাইবকে (প্রেরক বাদে) পুশ পাঠায়। টেক্সট ক্লায়েন্টে এনক্রিপ্টেড; সার্ভার শুধু ct পাঠিয়ে দেয়। */
async function notifyMess(id, name, nf, exEndpoint) {
  try {
    const kind = nf && /^[a-z]{1,8}$/.test(nf.k || "") ? nf.k : "u";
    if (!(await cmd("SET", "pt_" + id + "_" + kind, "1", "NX", "PX", "4000"))) return;
    const subs = (await getJSON("ps_" + id)) || [];
    if (!subs.length) return;
    const v = await vapid();
    const pl = JSON.stringify({ id, n: String(name || "").slice(0, 40), k: kind, iv: nf && typeof nf.iv === "string" && nf.iv.length <= 24 ? nf.iv : "", ct: nf && typeof nf.ct === "string" && nf.ct.length <= 1500 ? nf.ct : "" });
    const live = [], seen = {};
    for (const s of subs) {
      if (s.e === exEndpoint) { live.push(s); continue; }
      if (seen[s.l] === undefined) seen[s.l] = (await cmd("GET", "lk_" + s.l)) === id;
      if (!seen[s.l]) continue;
      let st = 0; try { st = await pushOne(s, pl, v); } catch { st = 0; }
      if (st === 404 || st === 410) continue;
      live.push(s);
    }
    if (live.length !== subs.length) await setJSON("ps_" + id, live);
  } catch (e) { console.error("push", e && e.message); }
}

const okLk = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(x);

export const GET = guard(async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("k") === "1") { const v = await vapid(); return J({ pub: v.pub }); }
  return J({ error: "bad" }, 400);
});

export const POST = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > 4000) return J({ error: "big" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  if (!okLk(b.lk)) return J({ error: "bad" }, 400);
  const id = await cmd("GET", "lk_" + b.lk);
  if (!id) return J({ error: "none" }, 404);
  const subs = (await getJSON("ps_" + id)) || [];
  if (b.a === "sub") {
    const s = b.sub || {};
    if (typeof s.endpoint !== "string" || s.endpoint.length > 600 || !(/^https:\/\//.test(s.endpoint) || (process.env.BP_MEMORY === "1" && /^http:\/\/localhost/.test(s.endpoint)))) return J({ error: "bad_sub" }, 400);
    const k = s.keys || {};
    if (typeof k.p256dh !== "string" || typeof k.auth !== "string" || k.p256dh.length > 120 || k.auth.length > 40) return J({ error: "bad_sub" }, 400);
    const rest = subs.filter((x) => x.e !== s.endpoint);
    rest.push({ e: s.endpoint, p: k.p256dh, a: k.auth, l: b.lk, t: Date.now() });
    await setJSON("ps_" + id, rest.slice(-300));
    return J({ ok: 1 });
  }
  if (b.a === "unsub") {
    await setJSON("ps_" + id, subs.filter((x) => x.e !== b.endpoint));
    return J({ ok: 1 });
  }
  return J({ error: "bad" }, 400);
});
