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

// পেমেন্ট ও প্ল্যান (ম্যানেজারের জন্য): পাবলিক কনফিগ + পেমেন্ট জমা + নিজের স্ট্যাটাস। অনুমোদন শুধু অ্যাডমিন প্যানেল থেকে।
const okId = (x) => typeof x === "string" && /^[A-Za-z0-9+/=_-]{4,32}$/.test(x);

export const GET = guard(async (req) => {
  const u = new URL(req.url), q = u.searchParams.get("qr");
  if (q) {
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(q)) return J({ error: "bad" }, 400);
    const d = await cmd("GET", "qr_" + q);
    const m = d && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(d);
    if (!m) return J({ error: "none" }, 404);
    return new Response(Buffer.from(m[2], "base64"), { headers: { "content-type": m[1], "cache-control": "public, max-age=300" } });
  }
  const c = await getCfg();
  return J({ free: c.free, plans: c.plans, support: c.support, notice: c.notice, methods: c.methods.filter((m) => m.on).map((m) => ({ id: m.id, name: m.name, num: m.num, note: m.note, q: m.q || 0 })) });
});

export const POST = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > 4000) return J({ error: "big" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  if (!okId(b.id) || typeof b.token !== "string" || b.token.length < 32 || b.token.length > 128) return J({ error: "bad" }, 400);
  const v = await getJSON("v_" + b.id);
  if (!v || v.wh !== sha(b.token)) return J({ error: "forbidden" }, 403);
  const cfg = await getCfg(), e = await entOf(b.id);
  const mine = async () => {
    const ids = (await cmd("ZRANGE", "pm_" + b.id, -15, -1)) || [];
    const rows = await cmds(ids.map((i) => ["GET", "pay_" + i]));
    return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean).reverse().map((p) => ({ id: p.id, plan: p.plan.name, limit: p.plan.limit, amount: p.amount, method: p.method.name, trx: p.trx, st: p.st, at: p.at, note: p.note || "" }));
  };
  if (b.a === "ent") return J({ limit: limFrom(e, cfg), until: (e && e.until) || 0, free: cfg.free, mc: v.mc || 0, pays: await mine() });
  if (b.a === "submit") {
    const plan = cfg.plans.find((p) => p.id === b.plan), method = cfg.methods.find((m) => m.id === b.method && m.on);
    const sender = String(b.sender || "").trim(), trx = String(b.trx || "").trim().toUpperCase();
    if (!plan || !method) return J({ error: "bad_plan" }, 400);
    if (!/^[0-9+ -]{6,20}$/.test(sender)) return J({ error: "bad_sender" }, 400);
    if (!/^[A-Z0-9]{6,24}$/.test(trx)) return J({ error: "bad_trx" }, 400);
    const cur = await mine();
    if (cur.filter((p) => p.st === "pending").length >= 3) return J({ error: "too_many_pending" }, 429);
    const pid = newPid();
    if (!(await cmd("SET", "trx_" + method.id + "_" + trx, pid, "NX"))) return J({ error: "trx_used" }, 409);
    const rec = { id: pid, mid: b.id, mname: v.name || "", plan: { id: plan.id, name: plan.name, limit: plan.limit, price: plan.price, days: plan.days || 0 }, method: { id: method.id, name: method.name }, sender, trx, amount: plan.price, st: "pending", at: Date.now() };
    await cmds([["SET", "pay_" + pid, JSON.stringify(rec)], ["ZADD", "pays", 0, pid], ["ZADD", "pm_" + b.id, 0, pid]]);
    return J({ ok: 1, id: pid });
  }
  return J({ error: "bad" }, 400);
});
