import { cmd, getJSON, setJSON, sha, J, guard, okId, limit } from "./_lib.js";

// অটো রিমাইন্ডার (ম্যানেজার/সহ-ম্যানেজারের জন্য)। বার্তার লেখা ক্লায়েন্টে এনক্রিপ্টেড — সার্ভার শুধু ciphertext ও সময়ের নিয়ম রাখে।
// নিয়ম: k="m" প্রতি মাসের d তারিখ (১–২৮), k="w" প্রতি সপ্তাহের d বার (০=রবি … ৬=শনি), k="o" একবার, d="YYYY-MM-DD"।
// পাঠায় /api/cron (Vercel Cron, প্রতিদিন সকাল ~৭টা বাংলাদেশ সময়)।
const b64ok = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max && /^[A-Za-z0-9+/=]+$/.test(x);
const MAX_REM = 10;

function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const x of list.slice(0, MAX_REM)) {
    if (!x || typeof x.id !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(x.id)) return null;
    if (!b64ok(x.iv, 24) || !b64ok(x.ct, 1500)) return null;
    let d;
    if (x.k === "m") { d = parseInt(x.d); if (!(d >= 1 && d <= 28)) return null; }
    else if (x.k === "w") { d = parseInt(x.d); if (!(d >= 0 && d <= 6)) return null; }
    else if (x.k === "o") { d = String(x.d || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null; }
    else return null;
    out.push({ id: x.id, k: x.k, d, iv: x.iv, ct: x.ct });
  }
  return out;
}

export const GET = guard(async (req) => {
  // অ্যাপ জানতে চায় সার্ভারে CRON_SECRET বসানো আছে কিনা (না থাকলে রিমাইন্ডার পাঠানো হবে না)
  if (new URL(req.url).searchParams.get("s") === "1") return J({ cron: (process.env.CRON_SECRET || "").length >= 16 });
  return J({ error: "bad" }, 400);
});

export const POST = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > 30_000) return J({ error: "big" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  if (!okId(b.id) || typeof b.token !== "string" || b.token.length < 32 || b.token.length > 128) return J({ error: "bad" }, 400);
  { const rl = await limit(req, "rem", 40, 600, b.id); if (rl) return rl; }
  const v = await getJSON("v_" + b.id);
  if (!v) return J({ error: "not_published" }, 404);
  const h = sha(b.token);
  if (v.wh !== h && !(Array.isArray(v.cwh) && v.cwh.includes(h))) return J({ error: "forbidden" }, 403);
  if (b.a === "set") {
    const list = cleanList(b.list);
    if (!list) return J({ error: "bad_list" }, 400);
    if (!list.length) { await cmd("DEL", "rm_" + b.id); await cmd("ZREM", "rmidx", b.id); }
    else { await setJSON("rm_" + b.id, list); await cmd("ZADD", "rmidx", 0, b.id); }
    return J({ ok: 1, n: list.length });
  }
  return J({ error: "bad" }, 400);
});
