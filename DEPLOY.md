# Vercel-এ চালু করার ধাপ (Bachelors Paradise)

## ১. ফাইল আপলোড
সব ফাইল ও ফোল্ডার GitHub repo-তে দিন — বিশেষ করে `api` ফোল্ডার (ভেতরে vault.js, chat.js, auth.js, admin.js), `index.html`, `admin.html`, `vercel.json`, `package.json`।
`api` ফোল্ডার না গেলে সাইট চলবে না (404)।

## ২. ডেটাবেস
Vercel → Project → Storage → Create → **Upstash Redis** (Free) → Connect to Project → **Redeploy**।
সাইটে `/api/vault?v=1` খুলে `{"fv":3}` এলে ঠিক আছে।

## ৩. Environment Variables (Project → Settings → Environment Variables), তারপর Redeploy
| নাম | কী |
|---|---|
| `ADMIN_KEY` | আপনার সুপার-অ্যাডমিন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর, লম্বা ও এলোমেলো রাখুন) |
| `GOOGLE_CLIENT_ID` | Google লগইনের Client ID (নিচে দেখুন) — না দিলে Google বাটন আসবে না, বাকি সব চলবে |
| `SERVER_SECRET` | (ঐচ্ছিক) লম্বা এলোমেলো লেখা। না দিলে ডেটাবেস টোকেন ব্যবহার হয়। একবার দিলে আর বদলাবেন না, বদলালে আগের Google লিংক কাজ করবে না |

## ৪. Google Client ID বানানো (একবার, ফ্রি)
1. https://console.cloud.google.com → নতুন Project।
2. APIs & Services → **OAuth consent screen** → External → অ্যাপের নাম, আপনার ইমেইল দিয়ে Save (Publish app করে দিন, নইলে শুধু test user ঢুকতে পারে)।
3. **Credentials → Create Credentials → OAuth client ID** → Application type: **Web application**।
4. **Authorized JavaScript origins** এ দিন: `https://mymessbill.vercel.app` (আপনার ডোমেইন)। Redirect URI লাগবে না।
5. যে Client ID পাবেন (…apps.googleusercontent.com) সেটা `GOOGLE_CLIENT_ID`-এ বসান → Redeploy।

## ৫. ব্যবহার
- **Google লিংক:** কোড দিয়ে ঢুকে হোম পেজের নিচে "Google অ্যাকাউন্ট লিংক" বাটন। এরপর লগইন পেজের ওপরে "Google দিয়ে লগইন"।
  এক Google অ্যাকাউন্টে একাধিক মেস লিংক করা যায়। ম্যানেজার কোড বদলালে/বাতিল হলে আবার লিংক করতে হবে।
- **সুপার অ্যাডমিন:** `https://আপনার-সাইট/admin.html` → ADMIN_KEY দিন। কয়টা মেস, নাম, তৈরি/আপডেটের সময়, লগইন কোড ও মেসেজ সংখ্যা দেখা যায়, মেস মোছাও যায়।
- **ব্যাকআপ রিকভার:** লগইন পেজের "♻️ ব্যাকআপ থেকে ফেরান"।

## নিরাপত্তা নোট
- মেসের হিসাব/সদস্য/চ্যাট এনক্রিপ্টেড — অ্যাডমিনও পড়তে পারে না।
- Google-এ লিংক করা কোড ডেটাবেসে এনক্রিপ্ট করা থাকে, চাবি শুধু Vercel env-এ। Google দিয়ে লগইনের সময় সার্ভার ওই কোড ফেরত দেয়, অর্থাৎ সার্ভার মালিক (আপনি) টেকনিক্যালি এটা করতে পারেন — এটাই "কোড ছাড়া লগইন"-এর মূল্য।
