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
  let cur = "0", ids = [];
  do {
    const [nx, ks] = await cmd("SCAN", cur, "MATCH", "v_*", "COUNT", 500);
    cur = String(nx); ids.push(...ks.map((k) => k.slice(2)));
  } while (cur !== "0" && ids.length < 5000);
  const rows = [];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const res = await cmds(part.flatMap((id) => [["GET", "v_" + id], ["ZCARD", zk("c", id)], ["ZCARD", zk("e", id)]]));
    part.forEach((id, j) => {
      let v = null; try { v = JSON.parse(res[j * 3]); } catch {}
      if (!v) return;
      rows.push({ id, name: v.name || "", ver: v.ver || 0, cat: v.cat || 0, uat: v.uat || 0, codes: (v.lks || []).length, chat: res[j * 3 + 1] || 0, ev: res[j * 3 + 2] || 0, size: (v.ct || "").length });
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
  const dels = ["v_" + id, zk("c", id), zk("e", id)];
  for (const lk of v.lks || []) { if ((await cmd("GET", "lk_" + lk)) === id) dels.push("lk_" + lk); }
  await cmds(dels.map((k) => ["DEL", k]));
  return J({ ok: 1, deleted: v.name || id });
});
