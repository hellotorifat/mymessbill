import { cmd, cmds, getJSON, sha, J, guard, okLk, notifyMess, limit } from "./_lib.js";

// এনক্রিপ্টেড মেস চ্যাট ও লাইভ ইভেন্ট (kind=e): সার্ভার শুধু ciphertext রাখে।
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
  const { lk, iv, ct, nf, ex } = b || {};
  const kind = b && b.kind === "e" ? "e" : "c";
  if (!okLk(lk) || !b64ok(iv, 24) || !b64ok(ct, 6000)) return J({ error: "bad" }, 400);
  { const rl = await limit(req, "chat", 240, 60, lk); if (rl) return rl; }
  const id = await cmd("GET", "lk_" + lk);
  if (!id) return J({ error: "none" }, 404);
  const zk = key(kind, id);
  const k = String(Date.now()).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  const [, n] = await cmds([["ZADD", zk, 0, `${k}|${iv}|${ct}`], ["ZCARD", zk]]);
  if (n > KEEP[kind]) await cmd("ZREMRANGEBYRANK", zk, 0, n - KEEP[kind] - 1);
  if (nf && typeof nf === "object") { const vv = await getJSON("v_" + id); await notifyMess(id, vv && vv.name, nf, typeof ex === "string" ? ex : ""); }
  return J({ k });
});
