import { cmd, getJSON, setJSON, J, guard, okLk, vapid, okPushEndpoint, limit } from "./_lib.js";

export const GET = guard(async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("k") === "1") { const v = await vapid(); return J({ pub: v.pub }); }
  return J({ error: "bad" }, 400);
});

export const POST = guard(async (req) => {
  const raw = await req.text();
  if (raw.length > 4000) return J({ error: "big" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return J({ error: "bad" }, 400); }
  if (!okLk(b.lk)) return J({ error: "bad" }, 400);
  { const rl = await limit(req, "push", 30, 600, b.lk); if (rl) return rl; }
  const id = await cmd("GET", "lk_" + b.lk);
  if (!id) return J({ error: "none" }, 404);
  const subs = (await getJSON("ps_" + id)) || [];
  if (b.a === "sub") {
    const s = b.sub || {};
    if (!okPushEndpoint(s.endpoint)) return J({ error: "bad_sub" }, 400);
    const k = s.keys || {};
    if (typeof k.p256dh !== "string" || typeof k.auth !== "string" || k.p256dh.length > 120 || k.auth.length > 40) return J({ error: "bad_sub" }, 400);
    const rest = subs.filter((x) => x.e !== s.endpoint);
    rest.push({ e: s.endpoint, p: k.p256dh, a: k.auth, l: b.lk, t: Date.now() });
    await setJSON("ps_" + id, rest.slice(-300));
    return J({ ok: 1 });
  }
  if (b.a === "unsub") {
    await setJSON("ps_" + id, subs.filter((x) => x.e !== b.endpoint));
    return J({ ok: 1 });
  }
  return J({ error: "bad" }, 400);
});
