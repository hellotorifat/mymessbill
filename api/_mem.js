// মেমরি ব্যাকএন্ড — শুধু লোকাল টেস্টের জন্য (BP_MEMORY=1)। প্রোডাকশনে এই ফাইল লোডই হয় না।
// Redis-এর যতটুকু কমান্ড অ্যাপ ব্যবহার করে, ততটুকুই নকল করা হয়েছে।
export class MemError extends Error {}

const G = (globalThis.__bpmem ??= { mem: new Map(), zs: new Map(), exp: new Map() });
const { mem, zs, exp } = G;

function alive(k) {
  const e = exp.get(k);
  if (e && e < Date.now()) { mem.delete(k); exp.delete(k); return false; }
  return true;
}
const cmpZ = (a, b) => a.s - b.s || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0);
const norm = (z, s, e) => { s = +s; e = +e; if (s < 0) s = Math.max(0, z.length + s); if (e < 0) e = z.length + e; return [s, e]; };

export function memCmd(c) {
  const [op, k, ...a] = c;
  const O = String(op).toUpperCase();
  const Z = () => { if (!zs.has(k)) zs.set(k, []); return zs.get(k); };
  switch (O) {
    case "GET": return alive(k) && mem.has(k) ? mem.get(k) : null;
    case "SET": {
      const nx = a.includes("NX");
      if (nx && alive(k) && mem.has(k)) return null;
      mem.set(k, a[0]);
      const i = a.indexOf("PX");
      if (i >= 0) exp.set(k, Date.now() + +a[i + 1]); else exp.delete(k);
      return "OK";
    }
    case "DEL": { const d = mem.delete(k) | zs.delete(k); exp.delete(k); return d ? 1 : 0; }
    case "INCR": case "INCRBY": case "DECR": {
      const by = O === "INCR" ? 1 : O === "DECR" ? -1 : +a[0];
      const cur = alive(k) && mem.has(k) ? +mem.get(k) || 0 : 0;
      mem.set(k, String(cur + by));
      return cur + by;
    }
    case "PEXPIRE": { if (!mem.has(k)) return 0; exp.set(k, Date.now() + +a[0]); return 1; }
    case "SCAN": {
      const m = String(a[1] === "MATCH" ? a[2] : "*").replace(/\*$/, "");
      return ["0", [...mem.keys()].filter((x) => x.startsWith(m) && alive(x))];
    }
    case "ZADD": {
      const z = Z();
      for (let i = 0; i + 1 < a.length; i += 2) {
        const s = +a[i], m = String(a[i + 1]);
        const ex = z.find((x) => x.m === m);
        if (ex) ex.s = s; else z.push({ s, m });
      }
      z.sort(cmpZ);
      return 1;
    }
    case "ZREM": { const z = zs.get(k) || []; const n = z.length; zs.set(k, z.filter((x) => !a.includes(x.m))); return n - zs.get(k).length; }
    case "ZCARD": return (zs.get(k) || []).length;
    case "ZRANGE": { const z = zs.get(k) || []; const [s, e] = norm(z, a[0], a[1]); return z.slice(s, e + 1).map((x) => x.m); }
    case "ZREVRANGE": { const z = [...(zs.get(k) || [])].reverse(); const [s, e] = norm(z, a[0], a[1]); return z.slice(s, e + 1).map((x) => x.m); }
    case "ZRANGEBYLEX": {
      const z = (zs.get(k) || []).map((x) => x.m);
      const mn = a[0], mx = a[1];
      let r = z.filter((m) => (mn === "-" ? true : mn[0] === "(" ? m > mn.slice(1) : m >= mn.slice(1)) && (mx === "+" ? true : mx[0] === "(" ? m < mx.slice(1) : m <= mx.slice(1)));
      const li = a.indexOf("LIMIT");
      if (li >= 0) r = r.slice(+a[li + 1], +a[li + 1] + +a[li + 2]);
      return r;
    }
    case "ZREMRANGEBYRANK": { const z = zs.get(k) || []; const [s, e] = norm(z, a[0], a[1]); z.splice(s, Math.max(0, e - s + 1)); return 1; }
    default: throw new MemError("store_cmd");
  }
}
