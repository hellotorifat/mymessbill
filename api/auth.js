import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { cmd, getJSON, setJSON, sha, J, guard, StoreError, limit } from "./_lib.js";

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
  { const rl = await limit(req, "auth", 60, 600); if (rl) return rl; }
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
