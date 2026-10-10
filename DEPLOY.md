# Vercel-এ চালু করার ধাপ (Bachelors Paradise)

1. এই ফোল্ডারটি (api, index.html, vercel.json সহ — সবকিছু) Vercel-এ deploy করুন
   (GitHub repo বা `vercel --prod`)। Framework Preset: **Other**, Build Command ফাঁকা।
2. ডেটা রাখার জন্য ডেটাবেস দরকার (Netlify Blobs-এর বদলে):
   Vercel Dashboard → আপনার Project → **Storage** → **Create Database** → **Upstash Redis** (Free) → Connect to Project।
   এতে `KV_REST_API_URL` ও `KV_REST_API_TOKEN` নিজে থেকে যুক্ত হয়ে যায়।
3. **Redeploy** দিন (Deployments → ⋯ → Redeploy), না দিলে নতুন env কাজ করবে না।
4. সাইট খুলে `/api/vault?v=1` দেখুন — `{"fv":3}` এলে সার্ভার ঠিক আছে। `storage_not_configured` এলে ধাপ ২–৩ বাকি।
5. পুরোনো ডেটা ফেরাতে: লগইন পেজের **♻️ ব্যাকআপ থেকে ফেরান** → ব্যাকআপ .json + আগের ম্যানেজার কোড।
   ম্যানেজার ও মেম্বার কোড আগের মতোই থাকবে, ডেটা নিজে প্রকাশ হবে।
   (ব্যাকআপে সদস্যদের ব্যক্তিগত কোড ও চ্যাট থাকে না; ব্যক্তিগত কোড লাগলে সেটিং → লগইন কোড থেকে আবার চালু করুন।)
