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


const okLk = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(x);
const okId = (x) => typeof x === "string" && /^[A-Za-z0-9+/=_-]{4,32}$/.test(x);
const okWrapN = (w, max) => w && typeof w.s === "string" && typeof w.i === "string" && typeof w.w === "string" && w.w.length < max;
const okWrap = (w) => okWrapN(w, 400);
const MAX = 900_000; // Upstash রিকোয়েস্ট সীমার ভেতরে থাকতে

export const GET = guard(async (req) => {
  const u = new URL(req.url);
  // ফাংশনের সংস্করণ (সহ-ম্যানেজার চালু আছে কি না) + স্টোরেজ ঠিক আছে কি না
  if (u.searchParams.get("v") === "1") { await cmd("GET", "bp_ping"); return J({ fv: 3 }); }
  const lk = u.searchParams.get("lk") || "";
  if (!okLk(lk)) return J({ error: "bad_lk" }, 400);
  const id = await cmd("GET", "lk_" + lk);
  if (!id) return J({ error: "none" }, 404);
  const v = await getJSON("v_" + id);
  if (!v) return J({ error: "none" }, 404);
  const { wh, W, MC, lks, alk, C, cwh, ...pub } = v;
  if (alk) {
    if (lk === alk) { pub.W = W || {}; if (MC) pub.MC = MC; pub.alk = alk; }
    else { delete pub.A; if (W && W[lk]) pub.M = W[lk]; if (Array.isArray(C) && C.includes(lk)) pub.co = true; }
  }
  return J(pub);
});

export const PUT = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > MAX) return J({ error: "big" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch { return J({ error: "bad_json" }, 400); }
  const { id, name, M, A, di, ct, base, token, lks, W, MC, alk, drop, co, C, cws } = b || {};
  if (!okId(id)) return J({ error: "bad_id" }, 400);
  if (typeof token !== "string" || token.length < 32 || token.length > 128) return J({ error: "bad_token" }, 400);
  if (typeof di !== "string" || typeof ct !== "string") return J({ error: "bad_data" }, 400);

  // কনকারেন্ট প্রকাশ আটকাতে ছোট লক
  const lock = "lock_" + id;
  if (!(await cmd("SET", lock, "1", "NX", "PX", "8000"))) return J({ error: "conflict" }, 409);
  try {
    // সহ-ম্যানেজার: শুধু ডেটা বদলায়
    if (co === true) {
      const o = await getJSON("v_" + id);
      if (!o || !Array.isArray(o.cwh) || !o.cwh.includes(sha(token))) return J({ error: "forbidden" }, 403);
      if (o.ver !== base) return J({ error: "conflict" }, 409);
      const ver = o.ver + 1;
      await setJSON("v_" + id, { ...o, di, ct, ver, uat: Date.now() });
      return J({ ver });
    }
    if (!okWrap(A)) return J({ error: "bad_A" }, 400);
    if (M != null && !okWrap(M)) return J({ error: "bad_M" }, 400);
    if (!Array.isArray(lks) || lks.length < 1 || lks.length > 62 || !lks.every(okLk)) return J({ error: "bad_lks" }, 400);
    if (W != null) {
      if (typeof W !== "object" || Array.isArray(W)) return J({ error: "bad_W" }, 400);
      const ks = Object.keys(W);
      if (ks.length > 60 || !ks.every((k) => okLk(k) && okWrap(W[k]))) return J({ error: "bad_W" }, 400);
    }
    if (MC != null && !okWrapN(MC, 12000)) return J({ error: "bad_MC" }, 400);
    if (alk != null && (!okLk(alk) || !lks.includes(alk))) return J({ error: "bad_alk" }, 400);
    if (C != null) {
      if (!Array.isArray(C) || C.length > 2 || !C.every((x) => okLk(x) && lks.includes(x))) return J({ error: "bad_C" }, 400);
      if (!Array.isArray(cws) || cws.length !== C.length || !cws.every((x) => typeof x === "string" && x.length >= 32 && x.length <= 128)) return J({ error: "bad_C" }, 400);
    }
    if (drop != null && (!Array.isArray(drop) || drop.length > 5 || !drop.every(okLk))) return J({ error: "bad_drop" }, 400);

    const old = await getJSON("v_" + id);
    if (old) {
      if (old.wh !== sha(token)) return J({ error: "forbidden" }, 403);
      if (old.ver !== base) return J({ error: "conflict" }, 409);
    } else if (base !== 0) {
      return J({ error: "conflict" }, 409);
    }
    // অন্য মেসের কোড দখল আটকানো — তবে একই ম্যানেজার কোডের পুরোনো (অসম্পূর্ণ/মাইগ্রেট করা) রেকর্ড থাকলে নতুন রেকর্ড তা প্রতিস্থাপন করতে পারে
    for (const lk of lks) {
      const ex = await cmd("GET", "lk_" + lk);
      if (ex && ex !== id) {
        const o = await getJSON("v_" + ex);
        if (o && o.wh !== sha(token)) return J({ error: "taken" }, 409);
      }
    }
    const ver = (old ? old.ver : 0) + 1;
    const rec = { id, name: String(name || "").slice(0, 50), A, di, ct, ver, wh: sha(token), lks, cat: (old && old.cat) || Date.now(), uat: Date.now() };
    if (M != null) rec.M = M;
    if (W != null) rec.W = W;
    if (MC != null) rec.MC = MC;
    if (alk != null) rec.alk = alk;
    if (C != null && C.length) { rec.C = C; rec.cwh = cws.map(sha); }
    await setJSON("v_" + id, rec);
    for (const lk of lks) await cmd("SET", "lk_" + lk, id);
    const gone = new Set([...((old && old.lks) || []), ...(drop || [])].filter((x) => !lks.includes(x)));
    for (const lk of gone) { if ((await cmd("GET", "lk_" + lk)) === id) await cmd("DEL", "lk_" + lk); }
    return J({ ver });
  } finally { await cmd("DEL", lock).catch(() => {}); }
});
