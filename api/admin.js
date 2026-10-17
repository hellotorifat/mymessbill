import { timingSafeEqual } from "node:crypto";
import { cmd, cmds, getJSON, setJSON, sha, J, guard, StoreError, okId, getCfg, entOf, limFrom, DEF_PLANS, metaOf, idxEnsure, idxDel, payStats, payBump, ipOf } from "./_lib.js";

// সুপার অ্যাডমিন (শুধু মালিকের জন্য): ADMIN_KEY env-এর সাথে মিললে তবেই উত্তর দেয়।
// দেখা যায়: মেসের নাম, তৈরি/সর্বশেষ আপডেটের সময়, সংস্করণ, লগইন কোডের সংখ্যা, মেসেজ সংখ্যা। সদস্য/হিসাব/চ্যাট এনক্রিপ্টেড, তাই পড়া যায় না।
const FAIL_MAX = 8, FAIL_WINDOW_MS = 15 * 60 * 1000;
async function authed(req) {
  const K = process.env.ADMIN_KEY || "";
  if (K.length < 8) throw new StoreError("admin_not_configured");
  // ব্রুট-ফোর্স ঠেকাতে: একই IP থেকে ১৫ মিনিটে ৮ বার ভুল হলে ১৫ মিনিট আটকে দেওয়া হয়।
  const fk = "adm_fail_" + sha(ipOf(req)).slice(0, 16);
  const fails = +(await cmd("GET", fk)) || 0;
  if (fails >= FAIL_MAX) throw new StoreError("locked", 429);
  const a = Buffer.from(sha(req.headers.get("x-admin-key") || ""), "hex"), b = Buffer.from(sha(K), "hex");
  if (timingSafeEqual(a, b)) { if (fails) await cmd("DEL", fk); return true; }
  const n = await cmd("INCR", fk);
  if (n === 1) await cmd("PEXPIRE", fk, FAIL_WINDOW_MS);
  await new Promise((r) => setTimeout(r, 800));
  return false;
}
const zk = (k, id) => (k === "e" ? "e_" : "m_") + sha(id).slice(0, 24);

async function metasOf(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    const res = await cmds(part.map((id) => ["GET", "vm_" + id]));
    for (let j = 0; j < part.length; j++) {
      let m = null; try { m = JSON.parse(res[j]); } catch {}
      if (!m) { const v = await getJSON("v_" + part[j]); if (v) m = metaOf({ ...v, id: part[j] }); }
      if (m) out.push({ id: part[j], ...m });
    }
  }
  return out;
}

export const GET = guard(async (req) => {
  if (!(await authed(req))) return J({ error: "forbidden" }, 403);
  const u = new URL(req.url);
  const lim = Math.max(1, Math.min(100, parseInt(u.searchParams.get("limit")) || 30));
  const off = Math.max(0, parseInt(u.searchParams.get("offset")) || 0);
  const q = (u.searchParams.get("q") || "").trim().toLowerCase().slice(0, 50);
  await idxEnsure();
  const cfg0 = await getCfg();
  const ids = (await cmd("ZREVRANGE", "vidx", 0, -1)) || [];
  let page, total;
  if (q) {
    const all = (await metasOf(ids)).filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    total = all.length; page = all.slice(off, off + lim);
  } else {
    total = ids.length; page = await metasOf(ids.slice(off, off + lim));
  }
  const res = page.length ? await cmds(page.flatMap((m) => [["ZCARD", zk("c", m.id)], ["ZCARD", zk("e", m.id)], ["GET", "ent_" + m.id]])) : [];
  const rows = page.map((m, j) => {
    let en = null; try { en = JSON.parse(res[j * 3 + 2]); } catch {}
    return { id: m.id, name: m.name, ver: m.ver, cat: m.cat, uat: m.uat, codes: m.codes, chat: res[j * 3] || 0, ev: res[j * 3 + 1] || 0, mc: m.mc, lim: limFrom(en, cfg0), until: (en && en.until) || 0, size: m.size };
  });
  // sum=1: ওভারভিউয়ের মোট হিসাব (সব মেস মিলিয়ে) — শুধু প্রথম লোড/রিফ্রেশে চাওয়া হয়
  let sum;
  if (u.searchParams.get("sum") === "1") {
    const all = await metasOf(ids.slice(0, 1000));
    const ents = all.length ? await cmds(all.map((m) => ["GET", "ent_" + m.id])) : [];
    let members = 0, paid = 0; const exp = [];
    all.forEach((m, i) => {
      let en = null; try { en = JSON.parse(ents[i]); } catch {}
      members += m.mc || 0;
      const l = limFrom(en, cfg0);
      if (l > cfg0.free) paid++;
      if (en && en.until) exp.push({ id: m.id, name: m.name, lim: l, until: en.until });
    });
    sum = { members, paid, exp, capped: ids.length > 1000 };
  }
  return J({ total, offset: off, limit: lim, list: rows, sum });
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
  await idxDel(id);
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
    // warn: অ্যাডমিন প্যানেলে সতর্কতা দেখানোর জন্য (দুর্বল ADMIN_KEY / SERVER_SECRET না থাকা)
    const K = process.env.ADMIN_KEY || "";
    return J({ cfg, stats: await payStats(), warn: { weakKey: K.length < 12, noSecret: !process.env.SERVER_SECRET } });
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
    if (b.act !== "approve" && b.act !== "reject") return J({ error: "bad" }, 400);
    // একই পেমেন্টে দুইবার চাপ/দুই ট্যাব থেকে ডাবল অনুমোদন ঠেকাতে ছোট লক
    const lock = "paylk_" + b.id;
    if (!(await cmd("SET", lock, "1", "NX", "PX", 5000))) return J({ error: "busy" }, 429);
    try {
      const p = await getJSON(key);
      if (!p) return J({ error: "none" }, 404);
      if (p.st !== "pending") return J({ error: "done" }, 409);
      if (b.act === "approve") {
        const e = (await entOf(p.mid)) || { limit: 0, until: 0 };
        const days = p.plan.days || 0, now = Date.now();
        const until = days ? Math.max(now, e.until || 0) + days * 86400000 : 0;
        await setJSON("ent_" + p.mid, { limit: Math.max(e.limit || 0, p.plan.limit), until: days ? until : 0, by: p.id, at: now });
        p.st = "approved";
      } else {
        p.st = "rejected";
        // বাতিল হলে TrxID মুক্ত করা হয়, যাতে ভুলে বাতিল হওয়া পেমেন্ট ঠিক করে আবার জমা দেওয়া যায়
        if (p.method && p.method.id && p.trx) await cmd("DEL", "trx_" + p.method.id + "_" + p.trx);
      }
      p.note = cleanStr(b.note, 200); p.at2 = Date.now();
      await setJSON(key, p);
      await payBump(-1, p.st === "approved" ? 1 : 0, p.st === "approved" ? +p.amount || 0 : 0);
      return J({ ok: 1 });
    } finally { await cmd("DEL", lock).catch(() => {}); }
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
