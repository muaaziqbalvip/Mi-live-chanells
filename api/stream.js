/**
 * MI LIVE TV SYSTEM — /api/stream.js
 * Vercel Serverless Function: Serves live M3U8 playlist link with fallback logic.
 * Always warm via stale-while-revalidate. Never returns null.
 */

const { initializeApp, getApps } = require("firebase/app");
const { getDatabase, ref, get, set } = require("firebase/database");

// ─── Firebase Config ────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBbnU8DkthpYQMHOLLyj6M0cc05qXfjMcw",
  authDomain: "ramadan-2385b.firebaseapp.com",
  databaseURL: "https://ramadan-2385b-default-rtdb.firebaseio.com",
  projectId: "ramadan-2385b",
  storageBucket: "ramadan-2385b.firebasestorage.app",
  messagingSenderId: "882828936310",
  appId: "1:882828936310:web:7f97b921031fe130fe4b57",
};

// ─── Emergency Fallback Links ────────────────────────────────────────────────
const EMERGENCY_LOOP =
  "https://firebasestorage.googleapis.com/v0/b/ramadan-2385b.firebasestorage.app/o/filler_loop.m3u8?alt=media";
const EMERGENCY_LINKS = {
  1: EMERGENCY_LOOP,
  2: EMERGENCY_LOOP,
  3: EMERGENCY_LOOP,
};

// ─── Initialize Firebase (singleton safe for serverless) ────────────────────
function getFirebaseApp() {
  if (getApps().length === 0) {
    return initializeApp(firebaseConfig);
  }
  return getApps()[0];
}

// ─── Time-based playout calculator ──────────────────────────────────────────
function getCurrentShow(schedule) {
  if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
    return null;
  }

  const now = Date.now();
  const scheduleStart = schedule[0].start_ts * 1000;

  // Calculate elapsed seconds from schedule start
  const elapsed = Math.floor((now - scheduleStart) / 1000);
  const totalDuration = schedule.reduce((sum, s) => sum + (s.duration || 0), 0);

  // Loop the schedule for infinite 30-day repeat
  const loopedElapsed = totalDuration > 0 ? elapsed % totalDuration : 0;

  let cursor = 0;
  for (const show of schedule) {
    const dur = show.duration || 0;
    if (loopedElapsed >= cursor && loopedElapsed < cursor + dur) {
      return {
        ...show,
        offset: loopedElapsed - cursor,
        remaining: dur - (loopedElapsed - cursor),
      };
    }
    cursor += dur;
  }

  // Fallback: return last show
  return { ...schedule[schedule.length - 1], offset: 0, remaining: 0 };
}

// ─── Build M3U8 Redirect Playlist ───────────────────────────────────────────
function buildM3U8(show, channelId) {
  const link = show?.stream_url || EMERGENCY_LINKS[channelId] || EMERGENCY_LOOP;
  const title = show?.title || "MI Live TV";

  return [
    "#EXTM3U",
    `#EXT-X-VERSION:3`,
    `#EXTINF:-1 tvg-id="mitv-ch${channelId}" tvg-name="${title}" group-title="MI Live TV",${title}`,
    link,
  ].join("\n");
}

// ─── Log stream access to Firebase ──────────────────────────────────────────
async function logAccess(db, channelId, show) {
  try {
    const logRef = ref(db, `mitv/stream_logs/ch${channelId}`);
    await set(logRef, {
      last_access: Date.now(),
      current_show: show?.title || "Unknown",
      stream_url: show?.stream_url || EMERGENCY_LOOP,
      ts: new Date().toISOString(),
    });
  } catch (_) {
    // Non-critical, don't fail stream on log error
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const channelId = parseInt(req.query.ch || "1", 10);

  if (![1, 2, 3].includes(channelId)) {
    return res.status(400).json({ error: "Invalid channel. Use ?ch=1, ?ch=2, or ?ch=3" });
  }

  // Cache headers: serve instantly, refresh in background
  res.setHeader(
    "Cache-Control",
    "public, max-age=30, stale-while-revalidate=60, stale-if-error=600"
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let show = null;

  try {
    const app = getFirebaseApp();
    const db = getDatabase(app);

    // Fetch schedule for this channel
    const scheduleRef = ref(db, `mitv/schedules/ch${channelId}`);
    const snapshot = await get(scheduleRef);

    if (snapshot.exists()) {
      const data = snapshot.val();
      const scheduleArray = Array.isArray(data) ? data : Object.values(data);
      show = getCurrentShow(scheduleArray);
    }

    // Fetch override if set by admin (emergency override)
    const overrideRef = ref(db, `mitv/overrides/ch${channelId}`);
    const overrideSnap = await get(overrideRef);
    if (overrideSnap.exists()) {
      const override = overrideSnap.val();
      if (override.active && override.stream_url) {
        show = {
          title: override.title || "Override",
          stream_url: override.stream_url,
          offset: 0,
          remaining: 99999,
        };
      }
    }

    // Log access (non-blocking)
    logAccess(db, channelId, show);
  } catch (err) {
    console.error(`[MI TV] Firebase error for ch${channelId}:`, err.message);
    // Fall through to emergency mode
  }

  // If we got no valid show, use emergency fallback
  if (!show || !show.stream_url) {
    show = {
      title: "MI Live TV — Emergency Loop",
      stream_url: EMERGENCY_LINKS[channelId] || EMERGENCY_LOOP,
      offset: 0,
      remaining: 99999,
    };
  }

  // Serve as M3U8 or JSON depending on accept header
  const wantsJSON =
    req.headers.accept?.includes("application/json") || req.query.format === "json";

  if (wantsJSON) {
    return res.status(200).json({
      channel: channelId,
      current_show: show.title,
      stream_url: show.stream_url,
      offset_seconds: show.offset || 0,
      remaining_seconds: show.remaining || 0,
      ts: new Date().toISOString(),
    });
  }

  res.setHeader("Content-Type", "application/x-mpegURL");
  return res.status(200).send(buildM3U8(show, channelId));
};
