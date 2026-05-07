# 📺 MI LIVE TV SYSTEM v2.0

**Muslim Islam Network — 24/7 Cloud TV Playout & Control Room**

---

## 🚀 Deploy in 3 Steps

### 1. GitHub
```bash
git init
git add .
git commit -m "MI Live TV v2.0"
git remote add origin https://github.com/YOUR_USERNAME/mi-live-tv.git
git push -u origin main
```

### 2. Vercel
```bash
npm install
vercel --prod
```

### 3. GitHub Actions Secret
Go to: Settings → Secrets → Actions → New secret
- Name:  `FIREBASE_API_KEY`
- Value: `AIzaSyBbnU8DkthpYQMHOLLyj6M0cc05qXfjMcw`

---

## 📁 File Structure

```
mi-live-tv/
├── api/
│   └── stream.js          ← Vercel serverless: serves M3U8
├── public/
│   └── admin.html         ← Full Control Room dashboard
├── scripts/
│   └── playout.py         ← 30-day playout engine
├── styles/
│   └── nastaliq.css       ← Urdu/Emoji CSS
├── .github/
│   └── workflows/
│       └── broadcast.yml  ← GitHub Actions (every 10 min)
├── vercel.json
├── package.json
└── requirements.txt
```

---

## 📡 Stream URLs

| Channel | M3U8 Link |
|---------|-----------|
| CH 1 | `https://YOUR-VERCEL.vercel.app/api/stream?ch=1` |
| CH 2 | `https://YOUR-VERCEL.vercel.app/api/stream?ch=2` |
| CH 3 | `https://YOUR-VERCEL.vercel.app/api/stream?ch=3` |

Admin Panel: `https://YOUR-VERCEL.vercel.app/admin`

---

## 🔥 Firebase Structure

```
mitv/
├── schedules/
│   ├── ch1/   ← 30-day schedule array
│   ├── ch2/
│   └── ch3/
├── now_playing/
│   ├── ch1/   ← Current show + upcoming
│   ├── ch2/
│   └── ch3/
├── overrides/
│   ├── ch1/   ← Emergency override
│   ├── ch2/
│   └── ch3/
├── ticker/    ← Live Urdu news ticker
├── stream_urls/   ← URLs by category
├── frame_layout/  ← Saved frame settings
├── shield_settings/ ← Copyright shield
└── system/
    ├── heartbeat/
    └── status/
```

---

## ⚙️ GitHub Actions

Runs every 10 minutes automatically:
- Calculates current show via time-based playout
- Fills gaps with commercials/fillers
- Health checks all stream URLs
- Warms Vercel cache
- Regenerates 30-day schedule at midnight PKT

---

Made with ❤️ by Admin Maaz — Muslim Islam Network
