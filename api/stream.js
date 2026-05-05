/**
 * MI LIVE TV — /api/stream.js
 * Vercel Serverless Function — Dynamic M3U8 HLS Generator
 * Serves a valid HLS manifest based on the current Firebase schedule.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getDatabase }            = require('firebase-admin/database');
const { credential }             = require('firebase-admin');

// ─── Firebase Admin Init (singleton) ───────────────────────────────────────
function getFirebaseApp() {
  if (getApps().length > 0) return getApps()[0];
  return initializeApp({
    credential: credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function parseDuration(durationStr) {
  // "HH:MM:SS" → seconds
  const parts = (durationStr || '00:30:00').split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

function getNowPlayingEntry(scheduleMap) {
  const now     = Date.now();
  const entries = Object.values(scheduleMap || {});

  for (const entry of entries) {
    const start    = new Date(entry.start).getTime();
    const durSec   = parseDuration(entry.duration);
    const end      = start + durSec * 1000;
    if (now >= start && now < end) {
      return { ...entry, elapsedSec: Math.floor((now - start) / 1000), totalSec: durSec };
    }
  }
  return null;
}

function getNextEntry(scheduleMap) {
  const now     = Date.now();
  const entries = Object.values(scheduleMap || {})
    .filter(e => new Date(e.start).getTime() > now)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  return entries[0] || null;
}

/**
 * Build a valid HLS M3U8 manifest.
 * For a proxy-based live stream we generate a sliding window manifest.
 * For direct MP4 URLs we use an EXT-X-DISCONTINUITY approach.
 */
function buildM3U8(entry, fillerUrl, channelId) {
  const segDuration = 6; // seconds per HLS segment

  if (!entry || !entry.videoUrl) {
    // No live content → serve filler
    return buildFillerM3U8(fillerUrl || 'https://example.com/filler.mp4', segDuration, channelId);
  }

  const videoUrl    = entry.videoUrl;
  const elapsed     = entry.elapsedSec || 0;
  const remaining   = (entry.totalSec || 1800) - elapsed;
  const mediaSeq    = Math.floor(elapsed / segDuration);
  const windowSize  = 5; // segments in live window

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${segDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
    `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}`,
    `## Channel: ${channelId} | Program: ${entry.title || 'Unknown'} | Type: ${entry.type || 'program'}`,
    '',
  ];

  // Add live sliding window segments
  for (let i = 0; i < windowSize; i++) {
    const segStart = (mediaSeq + i) * segDuration;
    lines.push(`#EXTINF:${segDuration}.000,`);
    // Segment URL with byte-range offset encoded as query params
    lines.push(`${videoUrl}?t=${segStart}&dur=${segDuration}&ch=${channelId}`);
  }

  // If program is ending soon, queue filler
  if (remaining <= segDuration * windowSize && fillerUrl) {
    lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${segDuration}.000,`);
    lines.push(`${fillerUrl}?filler=1&ch=${channelId}`);
  }

  return lines.join('\n');
}

function buildFillerM3U8(fillerUrl, segDuration, channelId) {
  const mediaSeq = Math.floor(Date.now() / 1000 / segDuration);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${segDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
    `## Channel: ${channelId} | Mode: FILLER`,
    '',
    `#EXTINF:${segDuration}.000,`,
    `${fillerUrl}?filler=1&ch=${channelId}&t=${mediaSeq * segDuration}`,
    `#EXTINF:${segDuration}.000,`,
    `${fillerUrl}?filler=1&ch=${channelId}&t=${(mediaSeq+1) * segDuration}`,
    `#EXTINF:${segDuration}.000,`,
    `${fillerUrl}?filler=1&ch=${channelId}&t=${(mediaSeq+2) * segDuration}`,
    `#EXTINF:${segDuration}.000,`,
    `${fillerUrl}?filler=1&ch=${channelId}&t=${(mediaSeq+3) * segDuration}`,
    `#EXTINF:${segDuration}.000,`,
    `${fillerUrl}?filler=1&ch=${channelId}&t=${(mediaSeq+4) * segDuration}`,
  ].join('\n');
}

function buildMasterM3U8(channelId) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `## MI LIVE TV — Master Playlist — Channel ${channelId}`,
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,NAME="1080p"',
    `${base}/api/stream?channelId=${channelId}&quality=1080p`,
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,NAME="720p"',
    `${base}/api/stream?channelId=${channelId}&quality=720p`,
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,NAME="480p"',
    `${base}/api/stream?channelId=${channelId}&quality=480p`,
  ].join('\n');
}

// ─── Main Handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { channelId = '1', master = 'false', quality } = req.query;
  const chId = parseInt(channelId) || 1;

  // Serve master playlist
  if (master === 'true') {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(buildMasterM3U8(chId));
  }

  try {
    const app = getFirebaseApp();
    const db  = getDatabase(app);

    // Fetch schedule and filler config in parallel
    const [scheduleSnap, fillerSnap, overlaySnap] = await Promise.all([
      db.ref(`channels/ch${chId}/schedule`).once('value'),
      db.ref(`channels/ch${chId}/filler`).once('value'),
      db.ref(`channels/ch${chId}/overlays`).once('value'),
    ]);

    const scheduleMap = scheduleSnap.val() || {};
    const fillerCfg   = fillerSnap.val()   || {};
    const fillerUrl   = fillerCfg.url || process.env.DEFAULT_FILLER_URL || 'https://example.com/filler.mp4';

    // Find what's on right now
    const nowPlaying = getNowPlayingEntry(scheduleMap);
    const nextUp     = getNextEntry(scheduleMap);

    // Log to Firebase for analytics
    const logRef = db.ref(`channels/ch${chId}/analytics/requests`);
    logRef.push({
      timestamp: Date.now(),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
      quality: quality || 'default',
      hasContent: !!nowPlaying,
    }).catch(() => {}); // Non-blocking

    // Build M3U8 response
    const m3u8 = buildM3U8(nowPlaying, fillerUrl, chId);

    // Response headers — HLS standard
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-MI-Channel', chId.toString());
    res.setHeader('X-MI-Now-Playing', nowPlaying?.title || 'FILLER');
    res.setHeader('X-MI-Next-Up', nextUp?.title || 'UNKNOWN');

    return res.status(200).send(m3u8);

  } catch (err) {
    console.error('[stream.js] Firebase error:', err.message);

    // Fallback: serve filler manifest so stream never fully breaks
    const fallbackFiller = process.env.DEFAULT_FILLER_URL || 'https://example.com/filler.mp4';
    const fallback = buildFillerM3U8(fallbackFiller, 6, chId);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-MI-Fallback', 'true');
    return res.status(200).send(fallback);
  }
};
