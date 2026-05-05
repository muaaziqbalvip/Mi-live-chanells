# MI LIVE TV SYSTEM — Complete Setup Guide

## Folder Structure

```
mi-live-tv/
├── .github/
│   └── workflows/
│       └── scheduler.yml          # GitHub Actions cron job
├── api/
│   ├── stream.js                  # HLS M3U8 serverless endpoint
│   └── trigger-scheduler.js       # Manual scheduler trigger
├── public/
│   ├── index.html                 # Control Room dashboard
│   ├── style.css                  # UI styles
│   └── app.js                     # Client-side logic
├── playout.py                     # 30-day scheduler (Python)
├── requirements.txt               # Python deps
├── firebase-schema.json           # Firebase DB structure reference
├── firebase-rules.json            # Firebase security rules
├── vercel.json                    # Vercel deployment config
├── package.json                   # Node.js dependencies
└── SETUP.md                       # This file
```

---

## STEP 1 — Firebase Setup

### 1.1 Create Firebase Project
1. Go to https://console.firebase.google.com
2. Your project **ramadan-2385b** is already created (credentials provided)
3. Enable **Realtime Database**: Build → Realtime Database → Create Database → Start in test mode

### 1.2 Upload Database Schema
1. In Firebase Console → Realtime Database → Import JSON
2. Upload `firebase-schema.json` to pre-populate structure
3. OR manually create the `/channels/ch1` node

### 1.3 Apply Security Rules
1. Firebase Console → Realtime Database → Rules
2. Paste the contents of `firebase-rules.json`
3. Publish

### 1.4 Enable Firebase Storage
1. Firebase Console → Storage → Get Started
2. Choose region closest to your users
3. Start in test mode initially

### 1.5 Generate Service Account Key (for Python scheduler)
1. Firebase Console → Project Settings → Service Accounts
2. Click **Generate new private key**
3. Download the JSON file — keep it secret!
4. You'll need this for GitHub Actions secrets

---

## STEP 2 — GitHub Repository Setup

### 2.1 Create Repository
```bash
git init mi-live-tv
cd mi-live-tv
git remote add origin https://github.com/YOUR_USERNAME/mi-live-tv.git
```

### 2.2 Push all files
```bash
git add .
git commit -m "Initial MI LIVE TV System"
git push -u origin main
```

### 2.3 Add GitHub Secrets
Go to: GitHub Repo → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:

| Secret Name                    | Value                                      |
|--------------------------------|--------------------------------------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON`| Paste entire JSON from serviceAccountKey   |
| `FIREBASE_DATABASE_URL`        | `https://ramadan-2385b-default-rtdb.firebaseio.com` |
| `DEFAULT_FILLER_URL`           | Your filler video URL                      |
| `DEFAULT_PROMO_URL`            | Your promo video URL                       |

---

## STEP 3 — Vercel Deployment

### 3.1 Install Vercel CLI
```bash
npm install -g vercel
```

### 3.2 Connect to Vercel
```bash
cd mi-live-tv
vercel login
vercel
```
Follow the prompts:
- Set up and deploy? **Y**
- Which scope? (your account)
- Link to existing project? **N**
- Project name: `mi-live-tv`
- Directory: `./`
- Override settings? **N**

### 3.3 Add Environment Variables in Vercel
Go to: Vercel Dashboard → Your Project → Settings → Environment Variables

Add these variables:

| Variable                  | Value                                        |
|---------------------------|----------------------------------------------|
| `FIREBASE_PROJECT_ID`     | `ramadan-2385b`                              |
| `FIREBASE_CLIENT_EMAIL`   | From your service account JSON               |
| `FIREBASE_PRIVATE_KEY`    | From your service account JSON (full key)    |
| `FIREBASE_DATABASE_URL`   | `https://ramadan-2385b-default-rtdb.firebaseio.com` |
| `DEFAULT_FILLER_URL`      | Your filler video MP4 URL                   |
| `GITHUB_PAT`              | Your GitHub Personal Access Token           |
| `GITHUB_OWNER`            | Your GitHub username                        |
| `GITHUB_REPO`             | `mi-live-tv`                                |

### 3.4 Deploy to Production
```bash
vercel --prod
```

Your Control Room will be at: `https://mi-live-tv.vercel.app`
Your stream URL will be at:   `https://mi-live-tv.vercel.app/api/stream?channelId=1`

---

## STEP 4 — GitHub Actions (Auto Scheduler)

### 4.1 The workflow runs automatically every day at 00:00 UTC
- File: `.github/workflows/scheduler.yml`
- Calculates 30 days of schedule
- Saves to Firebase Realtime Database
- Uploads schedule export as artifact

### 4.2 Trigger Manually
- GitHub → Actions → "MI LIVE TV — 30-Day Scheduler" → Run workflow
- Enter channel IDs and days

### 4.3 Test the Scheduler Locally
```bash
# Install Python deps
pip install firebase-admin

# Set env var (paste your entire service account JSON as one line)
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
export FIREBASE_DATABASE_URL='https://ramadan-2385b-default-rtdb.firebaseio.com'

# Run dry-run to verify
python playout.py --channels 1 2 --days 7 --dry-run

# Run for real
python playout.py --channels 1 --days 30 --export schedule_output.json
```

---

## STEP 5 — Adding a Program Template

The scheduler uses a **weekly template** stored in Firebase to know what programs to air each day. Add your recurring shows here:

```
channels/ch1/programTemplate/my-morning-show
  ├── dayOfWeek: 0        (0=Mon, 1=Tue, ... 6=Sun)
  ├── startHour: 8
  ├── startMin: 0
  ├── duration: "00:45:00"
  ├── title: "Good Morning Pakistan"
  ├── videoUrl: "https://your-storage/morning-show.mp4"
  └── type: "program"
```

---

## STEP 6 — Multi-Channel Setup

Each channel has its own independent node in Firebase and its own M3U8 URL.

| Channel   | Stream URL                              | Firebase Node    |
|-----------|-----------------------------------------|------------------|
| MI LIVE 1 | `/api/stream?channelId=1`               | `/channels/ch1`  |
| MI LIVE 2 | `/api/stream?channelId=2`               | `/channels/ch2`  |
| MI LIVE 3 | `/api/stream?channelId=3`               | `/channels/ch3`  |

To add Channel 3:
1. In Firebase, duplicate the `ch2` node → rename to `ch3`
2. In Control Room → Settings → Add Channel → "MI LIVE 3"
3. Run: `python playout.py --channels 3 --days 30`

---

## STEP 7 — Playing the Stream

### VLC
```
File → Open Network Stream → paste your M3U8 URL
```

### ffplay
```bash
ffplay "https://mi-live-tv.vercel.app/api/stream?channelId=1"
```

### IPTV App (Android/iOS)
Add the M3U8 URL as a custom channel in any IPTV player (TiviMate, IPTV Smarters, etc.)

### Embed in website (HLS.js)
```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="video" controls></video>
<script>
  const video = document.getElementById('video');
  const src = 'https://mi-live-tv.vercel.app/api/stream?channelId=1';
  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;  // Safari native HLS
  }
</script>
```

---

## STEP 8 — Mobile Dashboard (Android/Oppo A16)

The Control Room is fully mobile-responsive:

1. Open Chrome on your phone
2. Go to `https://mi-live-tv.vercel.app`
3. Tap the ⚙ button (bottom-right) to open the control panel
4. All features: Ticker editor, Overlays, Schedule, Media — work from mobile
5. For Urdu typing: enable Urdu keyboard → switch ticker to "اردو" mode

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Stream returns 500 | Check Vercel env vars — especially `FIREBASE_PRIVATE_KEY` (must have `\n` in key) |
| Schedule not updating | Run the GitHub Action manually, check Firebase rules allow writes |
| Ticker Urdu font not loading | Font loads from CDN — check internet connection |
| Firebase auth error | Regenerate service account key, update GitHub/Vercel secrets |
| Stream shows filler only | Add entries to `programTemplate` and re-run scheduler |
| CORS error | Already handled in `stream.js` — check Vercel deployment |

---

## Architecture Summary

```
[Control Room Dashboard]  ←→  [Firebase Realtime DB]
         ↕                            ↕
   [Vercel /api/stream]    [GitHub Actions + playout.py]
         ↕
   [HLS M3U8 → IPTV Players / Web / VLC]
```

- **Zero Downtime**: If current program ends early → filler auto-inserted
- **30-Day Window**: Pre-calculated so stream never has empty slots
- **Real-time Control**: Ticker, overlays, logo updated instantly via Firebase
- **Multi-Channel**: Independent Firebase nodes per channel
