import { createHash } from "node:crypto";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
  if (process.env.BP_MEMORY === "1") return list.map(memCmd);
  if (!URL_ || !TOKEN) throw new StoreError("storage_not_configured");
  let r;
  try {
    r = await fetch(URL_.replace(/\/$/, "") + "/pipeline", {
      method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(list),
    });
  } catch { throw new StoreError("storage_unreachable"); }
  if (!r.ok) throw new StoreError("storage_error_" + r.status);
  const j = await r.json();
  return j.map((x) => { if (x && x.error) throw new StoreError("storage_cmd"); return x.result; });
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
    if (e instanceof StoreError) return J({ error: e.code }, e.status);
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


// Google লগইন: Google অ্যাকাউন্টের সাথে মেসের কোড লিংক করা। কোড ডেটাবেসে এনক্রিপ্ট করে থাকে;
// এনক্রিপশনের চাবি শুধু Vercel env-এ (SERVER_SECRET, না থাকলে ডেটাবেস টোকেন থেকে) — ডেটাবেস একা ফাঁস হলে কোড পড়া যায় না।
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const normC = (c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const lkOf = (c) => b64u(createHash("sha256").update("bp-lk:" + normC(c)).digest());
const PEP = () => process.env.SERVER_SECRET || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || (process.env.BP_MEMORY === "1" ? "dev" : "");
const gkey = (sub) => { const p = PEP(); if (!p) throw new StoreError("secret_missing"); return createHash("sha256").update("bp-g:" + p + ":" + sub).digest(); };
function enc(code, sub) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", gkey(sub), iv);
  const ct = Buffer.concat([c.update(code, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function dec(s, sub) {
  try {
    const b = Buffer.from(s, "base64"), d = createDecipheriv("aes-256-gcm", gkey(sub), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}
async function verify(t) {
  if (typeof t !== "string" || t.length < 8 || t.length > 4000) return null;
  if (process.env.BP_MEMORY === "1" && process.env.BP_FAKE_GOOGLE === "1" && t.startsWith("fake:")) { const [, sub, email] = t.split(":"); return { sub, email }; }
  const cid = process.env.GOOGLE_CLIENT_ID;
  if (!cid) throw new StoreError("google_not_configured");
  let r;
  try { r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(t)); } catch { throw new StoreError("google_unreachable"); }
  if (!r.ok) return null;
  const j = await r.json();
  if (j.aud !== cid || !/^(https:\/\/)?accounts\.google\.com$/.test(j.iss || "") || String(j.email_verified) !== "true" || +j.exp * 1000 < Date.now() || !j.sub) return null;
  return { sub: j.sub, email: j.email };
}

export const GET = guard(async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("cfg") === "1") return J({ gid: process.env.GOOGLE_CLIENT_ID || "" });
  return J({ error: "bad" }, 400);
});

export const POST = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > 8000) return J({ error: "big" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  const g = await verify(b && b.t);
  if (!g) return J({ error: "bad_token" }, 401);
  const key = "g_" + sha(g.sub).slice(0, 40);
  const cur = (await getJSON(key)) || [];

  if (b.a === "link") {
    const code = String(b.code || "");
    if (!/^(MGR|MEM)[A-Z0-9]{12}$/.test(normC(code))) return J({ error: "bad_code" }, 400);
    const lk = lkOf(code), id = await cmd("GET", "lk_" + lk);
    if (!id) return J({ error: "none" }, 404);
    const v = await getJSON("v_" + id);
    if (!v) return J({ error: "none" }, 404);
    const list = cur.filter((e) => e.lk !== lk);
    list.push({ lk, n: String(v.name || "").slice(0, 50), r: b.r === "a" ? "a" : "m", c: enc(code, g.sub), t: Date.now() });
    await setJSON(key, list.slice(-10));
    return J({ ok: 1 });
  }
  if (b.a === "login") {
    const out = [], keep = [];
    for (const e of cur) {
      if (!(await cmd("GET", "lk_" + e.lk))) continue; // কোড বাতিল হয়ে গেছে
      const code = dec(e.c, g.sub);
      if (!code) continue;
      keep.push(e); out.push({ n: e.n, r: e.r, c: code });
    }
    if (keep.length !== cur.length) await setJSON(key, keep);
    return J({ list: out });
  }
  return J({ error: "bad" }, 400);
});
