import { cmd, getJSON, setJSON, sha, J, guard, okLk, okId, getCfg, entOf, limFrom, notifyMess, idxPut, limit } from "./_lib.js";

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
  if (raw.length > MAX) return J({ error: "big", max: MAX }, 413);
  let b;
  try { b = JSON.parse(raw); } catch { return J({ error: "bad_json" }, 400); }
  const { id, name, M, A, di, ct, base, token, lks, W, MC, alk, drop, co, C, cws, nf, ex } = b || {};
  if (!okId(id)) return J({ error: "bad_id" }, 400);
  { const rl = await limit(req, "vput", 90, 60, id); if (rl) return rl; }
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
      const nrec = { ...o, di, ct, ver, uat: Date.now() };
      await setJSON("v_" + id, nrec);
      await idxPut(nrec);
      if (nf && typeof nf === "object") await notifyMess(id, o.name, nf, typeof ex === "string" ? ex : "");
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
    // মেম্বার সীমা: ফ্রি সীমার বেশি সদস্য দিতে হলে অ্যাডমিনের অনুমোদিত প্ল্যান লাগে। আগে থেকে থাকা সংখ্যা বাড়ানো ছাড়া আটকায় না।
    const mcn = Number.isInteger(b.mc) && b.mc >= 0 && b.mc <= 1000 ? b.mc : 0;
    const cfg = await getCfg(), lim = limFrom(await entOf(id), cfg);
    if (mcn > lim) {
      const prev = old ? (old.mc === undefined ? mcn : old.mc) : null;
      const grow = old ? mcn > prev : b.rs !== 1;
      if (grow) return J({ error: "member_limit", limit: lim, free: cfg.free }, 402);
    }
    const ver = (old ? old.ver : 0) + 1;
    const rec = { id, name: String(name || "").slice(0, 50), A, di, ct, ver, wh: sha(token), lks, mc: mcn, cat: (old && old.cat) || Date.now(), uat: Date.now() };
    if (M != null) rec.M = M;
    if (W != null) rec.W = W;
    if (MC != null) rec.MC = MC;
    if (alk != null) rec.alk = alk;
    if (C != null && C.length) { rec.C = C; rec.cwh = cws.map(sha); }
    await setJSON("v_" + id, rec);
    await idxPut(rec);
    for (const lk of lks) await cmd("SET", "lk_" + lk, id);
    const gone = new Set([...((old && old.lks) || []), ...(drop || [])].filter((x) => !lks.includes(x)));
    for (const lk of gone) { if ((await cmd("GET", "lk_" + lk)) === id) await cmd("DEL", "lk_" + lk); }
    if (nf && typeof nf === "object") await notifyMess(id, rec.name, nf, typeof ex === "string" ? ex : "");
    return J({ ver });
  } finally { await cmd("DEL", lock).catch(() => {}); }
});
