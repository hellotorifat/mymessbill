import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
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


// সুপার অ্যাডমিন (শুধু মালিকের জন্য): ADMIN_KEY env-এর সাথে মিললে তবেই উত্তর দেয়।
// দেখা যায়: মেসের নাম, তৈরি/সর্বশেষ আপডেটের সময়, সংস্করণ, লগইন কোডের সংখ্যা, মেসেজ সংখ্যা। সদস্য/হিসাব/চ্যাট এনক্রিপ্টেড, তাই পড়া যায় না।
const okId = (x) => typeof x === "string" && /^[A-Za-z0-9+/=_-]{4,32}$/.test(x);
async function authed(req) {
  const K = process.env.ADMIN_KEY || "";
  if (K.length < 8) throw new StoreError("admin_not_configured");
  const a = Buffer.from(sha(req.headers.get("x-admin-key") || ""), "hex"), b = Buffer.from(sha(K), "hex");
  if (timingSafeEqual(a, b)) return true;
  await new Promise((r) => setTimeout(r, 800));
  return false;
}
const zk = (k, id) => (k === "e" ? "e_" : "m_") + sha(id).slice(0, 24);

export const GET = guard(async (req) => {
  if (!(await authed(req))) return J({ error: "forbidden" }, 403);
  const cfg0 = await getCfg();
  let cur = "0", ids = [];
  do {
    const [nx, ks] = await cmd("SCAN", cur, "MATCH", "v_*", "COUNT", 500);
    cur = String(nx); ids.push(...ks.map((k) => k.slice(2)));
  } while (cur !== "0" && ids.length < 5000);
  const rows = [];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const res = await cmds(part.flatMap((id) => [["GET", "v_" + id], ["ZCARD", zk("c", id)], ["ZCARD", zk("e", id)], ["GET", "ent_" + id]]));
    part.forEach((id, j) => {
      let v = null, en = null; try { v = JSON.parse(res[j * 4]); } catch {} try { en = JSON.parse(res[j * 4 + 3]); } catch {}
      if (!v) return;
      rows.push({ id, name: v.name || "", ver: v.ver || 0, cat: v.cat || 0, uat: v.uat || 0, codes: (v.lks || []).length, chat: res[j * 4 + 1] || 0, ev: res[j * 4 + 2] || 0, mc: v.mc === undefined ? null : v.mc, lim: limFrom(en, cfg0), until: (en && en.until) || 0, size: (v.ct || "").length });
    });
  }
  rows.sort((a, b) => (b.uat || 0) - (a.uat || 0));
  return J({ total: rows.length, list: rows });
});

export const DELETE = guard(async (req) => {
  if (!(await authed(req))) return J({ error: "forbidden" }, 403);
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!okId(id)) return J({ error: "bad_id" }, 400);
  const v = await getJSON("v_" + id);
  if (!v) return J({ error: "none" }, 404);
  const dels = ["v_" + id, zk("c", id), zk("e", id), "ent_" + id];
  for (const lk of v.lks || []) { if ((await cmd("GET", "lk_" + lk)) === id) dels.push("lk_" + lk); }
  await cmds(dels.map((k) => ["DEL", k]));
  return J({ ok: 1, deleted: v.name || id });
});

const cleanStr = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const rid = () => Math.random().toString(36).slice(2, 8);
async function saveCfg(c) { await setJSON("cfg", c); }
async function loadPays(n) {
  const ids = (await cmd("ZRANGE", "pays", -n, -1)) || [];
  const rows = ids.length ? await cmds(ids.map((i) => ["GET", "pay_" + i])) : [];
  return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean).reverse();
}

export const POST = guard(async (req) => {
  if (!(await authed(req))) return J({ error: "forbidden" }, 403);
  const raw = await req.text();
  if (raw.length > 400_000) return J({ error: "big" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  const cfg = await getCfg();

  if (b.a === "cfgget") {
    const pays = await loadPays(300);
    const ok = pays.filter((p) => p.st === "approved");
    return J({ cfg, stats: { pending: pays.filter((p) => p.st === "pending").length, approved: ok.length, revenue: ok.reduce((s, p) => s + (+p.amount || 0), 0) } });
  }
  if (b.a === "cfg") {
    const free = Math.max(1, Math.min(500, parseInt(b.free) || 15));
    const plans = (Array.isArray(b.plans) ? b.plans : []).slice(0, 10).map((p) => ({ id: /^[A-Za-z0-9_-]{2,16}$/.test(p.id || "") ? p.id : "p" + rid(), name: cleanStr(p.name, 40), limit: Math.max(1, Math.min(1000, parseInt(p.limit) || 0)), price: Math.max(0, Math.min(1_000_000, +p.price || 0)), days: Math.max(0, Math.min(3650, parseInt(p.days) || 0)) })).filter((p) => p.name && p.limit > free);
    await saveCfg({ ...cfg, free, plans: plans.length ? plans : DEF_PLANS, support: cleanStr(b.support, 200), notice: cleanStr(b.notice, 300) });
    return J({ ok: 1 });
  }
  if (b.a === "method") {
    const m = b.method || {};
    const id = /^[A-Za-z0-9_-]{2,24}$/.test(m.id || "") ? m.id : "m" + rid();
    const old = cfg.methods.find((x) => x.id === id);
    if (cfg.methods.length >= 12 && !old) return J({ error: "too_many" }, 400);
    let q = old ? old.q || 0 : 0;
    if (b.qr === null) { await cmd("DEL", "qr_" + id); q = 0; }
    else if (typeof b.qr === "string" && b.qr) {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.qr) || b.qr.length > 300_000) return J({ error: "bad_qr" }, 400);
      await cmd("SET", "qr_" + id, b.qr); q = Date.now();
    }
    const rec = { id, name: cleanStr(m.name, 30), num: cleanStr(m.num, 60), note: cleanStr(m.note, 200), on: m.on !== false, q };
    if (!rec.name) return J({ error: "bad_name" }, 400);
    await saveCfg({ ...cfg, methods: old ? cfg.methods.map((x) => (x.id === id ? rec : x)) : cfg.methods.concat([rec]) });
    return J({ ok: 1, id });
  }
  if (b.a === "mdel") {
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(b.id || "")) return J({ error: "bad" }, 400);
    await cmd("DEL", "qr_" + b.id);
    await saveCfg({ ...cfg, methods: cfg.methods.filter((x) => x.id !== b.id) });
    return J({ ok: 1 });
  }
  if (b.a === "pays") return J({ list: await loadPays(300) });
  if (b.a === "payact") {
    const key = "pay_" + String(b.id || "");
    if (!/^pay_\d{13}-[a-z0-9]{6}$/.test(key)) return J({ error: "bad" }, 400);
    const p = await getJSON(key);
    if (!p) return J({ error: "none" }, 404);
    if (p.st !== "pending") return J({ error: "done" }, 409);
    if (b.act === "approve") {
      const e = (await entOf(p.mid)) || { limit: 0, until: 0 };
      const days = p.plan.days || 0, now = Date.now();
      const until = days ? Math.max(now, e.until || 0) + days * 86400000 : 0;
      await setJSON("ent_" + p.mid, { limit: Math.max(e.limit || 0, p.plan.limit), until: days ? until : 0, by: p.id, at: now });
      p.st = "approved";
    } else if (b.act === "reject") p.st = "rejected";
    else return J({ error: "bad" }, 400);
    p.note = cleanStr(b.note, 200); p.at2 = Date.now();
    await setJSON(key, p);
    return J({ ok: 1 });
  }
  if (b.a === "ent") {
    if (!okId(b.id)) return J({ error: "bad" }, 400);
    const limit = parseInt(b.limit) || 0, days = Math.max(0, parseInt(b.days) || 0);
    if (limit <= 0) await cmd("DEL", "ent_" + b.id);
    else await setJSON("ent_" + b.id, { limit: Math.min(limit, 1000), until: days ? Date.now() + days * 86400000 : 0, by: "manual", at: Date.now() });
    return J({ ok: 1 });
  }
  return J({ error: "bad" }, 400);
});
