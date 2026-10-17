import { cmd, cmds, getJSON, sha, J, guard, okId, getCfg, entOf, limFrom, newPid, payBump, limit } from "./_lib.js";

// পেমেন্ট ও প্ল্যান (ম্যানেজারের জন্য): পাবলিক কনফিগ + পেমেন্ট জমা + নিজের স্ট্যাটাস। অনুমোদন শুধু অ্যাডমিন প্যানেল থেকে।

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
    { const rl = await limit(req, "pay", 20, 600, b.id); if (rl) return rl; }
    // একই মেসের একসাথে একাধিক জমা এক লাইনে চালানো হয়, যাতে "৩টির বেশি পেন্ডিং নয়" সীমা ফাঁকি দেওয়া না যায়।
    const lock = "plock_" + b.id;
    if (!(await cmd("SET", lock, "1", "NX", "PX", 5000))) return J({ error: "busy" }, 429);
    try {
      const cur = await mine();
      if (cur.filter((p) => p.st === "pending").length >= 3) return J({ error: "too_many_pending" }, 429);
      const pid = newPid();
      if (!(await cmd("SET", "trx_" + method.id + "_" + trx, pid, "NX"))) return J({ error: "trx_used" }, 409);
      const rec = { id: pid, mid: b.id, mname: v.name || "", plan: { id: plan.id, name: plan.name, limit: plan.limit, price: plan.price, days: plan.days || 0 }, method: { id: method.id, name: method.name }, sender, trx, amount: plan.price, st: "pending", at: Date.now() };
      await cmds([["SET", "pay_" + pid, JSON.stringify(rec)], ["ZADD", "pays", 0, pid], ["ZADD", "pm_" + b.id, 0, pid]]);
      await payBump(1, 0, 0);
      return J({ ok: 1, id: pid });
    } finally { await cmd("DEL", lock).catch(() => {}); }
  }
  return J({ error: "bad" }, 400);
});
