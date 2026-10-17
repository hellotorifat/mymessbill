import { timingSafeEqual } from "node:crypto";
import { cmd, getJSON, setJSON, sha, J, guard, StoreError, notifyMess } from "./_lib.js";

// Vercel Cron প্রতিদিন একবার (vercel.json) এই endpoint ডাকে। Vercel নিজে "Authorization: Bearer <CRON_SECRET>" পাঠায়।
// তাই Vercel → Settings → Environment Variables-এ CRON_SECRET (কমপক্ষে ১৬ অক্ষর, এলোমেলো) দিতে হবে।
function okSecret(req) {
  const S = process.env.CRON_SECRET || "";
  if (S.length < 16) throw new StoreError("cron_not_configured");
  const a = Buffer.from(sha(req.headers.get("authorization") || ""), "hex"), b = Buffer.from(sha("Bearer " + S), "hex");
  return timingSafeEqual(a, b);
}

export const GET = guard(async (req) => {
  if (!okSecret(req)) return J({ error: "forbidden" }, 401);
  const now = new Date(Date.now() + 6 * 3600 * 1000); // বাংলাদেশ সময় (UTC+6)
  const ymd = now.toISOString().slice(0, 10), day = now.getUTCDate(), wd = now.getUTCDay();
  const ids = (await cmd("ZRANGE", "rmidx", 0, -1)) || [];
  let due = 0, sent = 0;
  for (const id of ids) {
    const list = (await getJSON("rm_" + id)) || [];
    const meta = await getJSON("vm_" + id);
    let changed = false;
    const keep = [];
    for (const x of list) {
      if (x.k === "o" && x.d < ymd) { changed = true; continue; } // মেয়াদ পেরোনো এককালীন রিমাইন্ডার বাদ
      keep.push(x);
      const hit = x.k === "m" ? x.d === day : x.k === "w" ? x.d === wd : x.d === ymd;
      if (!hit) continue;
      due++;
      // একই দিনে (cron আবার চললেও) দুইবার নয়
      if (!(await cmd("SET", "rmd_" + id + "_" + x.id + "_" + ymd, "1", "NX", "PX", 172800000))) continue;
      sent += await notifyMess(id, meta && meta.name, { k: "rem", iv: x.iv, ct: x.ct }, "", { noThrottle: true });
    }
    if (changed) { if (keep.length) await setJSON("rm_" + id, keep); else { await cmd("DEL", "rm_" + id); await cmd("ZREM", "rmidx", id); } }
  }
  return J({ ok: 1, date: ymd, mess: ids.length, due, sent });
});
