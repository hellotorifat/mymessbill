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

// এনক্রিপ্টেড মেস চ্যাট ও লাইভ ইভেন্ট (kind=e): সার্ভার শুধু ciphertext রাখে।
const okLk = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(x);
const okAfter = (x) => x === "" || /^\d{13}-[a-z0-9]{6}$/.test(x);
const b64ok = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max && /^[A-Za-z0-9+/=]+$/.test(x);
const KEEP = { c: 300, e: 1000 };
const PAGE = 200;
const key = (kind, id) => (kind === "e" ? "e_" : "m_") + sha(id).slice(0, 24);

export const GET = guard(async (req) => {
  const u = new URL(req.url);
  const lk = u.searchParams.get("lk") || "", after = u.searchParams.get("after") || "";
  const kind = u.searchParams.get("kind") === "e" ? "e" : "c";
  if (!okLk(lk) || !okAfter(after)) return J({ error: "bad" }, 400);
  const id = await cmd("GET", "lk_" + lk);
  if (!id) return J({ error: "none" }, 404);
  const zk = key(kind, id);
  let rows;
  if (kind === "e") rows = await cmd("ZRANGEBYLEX", zk, after ? "(" + after + "}" : "-", "+", "LIMIT", 0, PAGE);
  else {
    rows = await cmd("ZRANGE", zk, -80, -1);
    if (after) rows = rows.filter((r) => r.split("|")[0] > after);
  }
  const msgs = (rows || []).map((r) => { const [k, iv, ct] = r.split("|"); return { k, iv, ct }; });
  return J({ msgs });
});

export const POST = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > 8000) return J({ error: "big" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  const { lk, iv, ct } = b || {};
  const kind = b && b.kind === "e" ? "e" : "c";
  if (!okLk(lk) || !b64ok(iv, 24) || !b64ok(ct, 6000)) return J({ error: "bad" }, 400);
  const id = await cmd("GET", "lk_" + lk);
  if (!id) return J({ error: "none" }, 404);
  const zk = key(kind, id);
  const k = String(Date.now()).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  const [, n] = await cmds([["ZADD", zk, 0, `${k}|${iv}|${ct}`], ["ZCARD", zk]]);
  if (n > KEEP[kind]) await cmd("ZREMRANGEBYRANK", zk, 0, n - KEEP[kind] - 1);
  return J({ k });
});
