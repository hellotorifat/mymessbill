// লোকাল ডেভ সার্ভার: npm run dev  →  http://localhost:3000
// Vercel ছাড়াই পুরো অ্যাপ চলে (মেমরি ডেটাবেস, রিস্টার্টে ডেটা হারায়)। vercel.json-এর সিকিউরিটি হেডারও বসে, তাই CSP এখানেই পরীক্ষা করা যায়।
process.env.BP_MEMORY = "1";
process.env.ADMIN_KEY ||= "dev-admin-key-1234";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +process.env.PORT || 3000;
const cfg = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
const secHeaders = Object.fromEntries(((cfg.headers || []).find((h) => h.source === "/(.*)") || { headers: [] }).headers.map((h) => [h.key, h.value]));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css" };
const API = new Set(["vault", "chat", "admin", "pay", "push", "auth", "cron", "remind"]);

http.createServer(async (rq, rs) => {
  try {
    const u = new URL(rq.url, "http://localhost:" + PORT);
    const m = /^\/api\/([a-z]+)$/.exec(u.pathname);
    if (m && API.has(m[1])) {
      const mod = await import("../api/" + m[1] + ".js");
      const h = mod[rq.method];
      if (!h) { rs.writeHead(405); return rs.end(); }
      const chunks = []; for await (const c of rq) chunks.push(c);
      const body = chunks.length && !["GET", "HEAD"].includes(rq.method) ? Buffer.concat(chunks) : undefined;
      const res = await h(new Request(u, { method: rq.method, headers: rq.headers, body }));
      rs.writeHead(res.status, { ...Object.fromEntries(res.headers), ...secHeaders });
      return rs.end(Buffer.from(await res.arrayBuffer()));
    }
    let p = decodeURIComponent(u.pathname);
    if (p === "/") p = "/index.html";
    if (!path.extname(p)) p += ".html";
    const f = path.join(root, p);
    if (!f.startsWith(root + path.sep)) { rs.writeHead(403); return rs.end(); }
    const buf = await readFile(f);
    rs.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache", ...secHeaders });
    rs.end(buf);
  } catch (e) {
    if (e && e.code === "ENOENT") { rs.writeHead(404); return rs.end("not found"); }
    console.error(e); rs.writeHead(500); rs.end("server error");
  }
}).listen(PORT, () => console.log("mymessbill dev: http://localhost:" + PORT + "   (admin: /admin.html, key: " + process.env.ADMIN_KEY + ")"));
