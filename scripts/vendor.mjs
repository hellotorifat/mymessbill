// PDF লাইব্রেরি নিজের সার্ভার থেকে দেওয়ার জন্য (CDN-এর ওপর নির্ভরতা শেষ):  npm run vendor
// তারপর vendor/ ফোল্ডারটা commit করুন। অ্যাপ আগে /vendor/… থেকে লোড করে, না পেলে CDN-এ যায়।
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const FILES = [
  ["vendor/html2canvas.min.js", "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"],
  ["vendor/jspdf.umd.min.js", "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"],
];
await mkdir("vendor", { recursive: true });
for (const [dest, url] of FILES) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " → " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 50_000) throw new Error(dest + " অস্বাভাবিক ছোট (" + buf.length + " বাইট)");
  await writeFile(dest, buf);
  console.log(dest, (buf.length / 1024).toFixed(0) + " KB", "sha384-" + createHash("sha384").update(buf).digest("base64"));
}
