#!/usr/bin/env python3
"""
MI LIVE TV SYSTEM — /scripts/playout.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Heavy-duty playout engine:
  • Reads 30-day schedule from Firebase RTDB
  • Calculates exact current show based on wall-clock time
  • Detects gaps and auto-injects commercials/fillers
  • Pushes updated "now_playing" state back to Firebase
  • Runs via GitHub Actions every 10 minutes
"""

import os
import sys
import json
import time
import math
import logging
import datetime
import hashlib
import urllib.request
import urllib.error
from typing import Optional

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("MI-Playout")

# ── Firebase REST API (no SDK needed in CI) ───────────────────────────────────
FIREBASE_BASE = "https://ramadan-2385b-default-rtdb.firebaseio.com"
FIREBASE_KEY  = os.environ.get("FIREBASE_API_KEY", "AIzaSyBbnU8DkthpYQMHOLLyj6M0cc05qXfjMcw")

# ── Emergency / Filler Assets ─────────────────────────────────────────────────
FILLER_LOOP     = "https://firebasestorage.googleapis.com/v0/b/ramadan-2385b.firebasestorage.app/o/filler_loop.m3u8?alt=media"
COMMERCIAL_POOL = [
    {"title": "MI TV Commercial Break 1", "duration": 120, "stream_url": FILLER_LOOP},
    {"title": "MI TV Channel ID",          "duration": 30,  "stream_url": FILLER_LOOP},
    {"title": "MI TV Animated Bumper",     "duration": 15,  "stream_url": FILLER_LOOP},
]
CHANNELS = [1, 2, 3]
MAX_GAP_SECONDS = 30  # gaps under 30s get silent padding; over this get a commercial

# ─────────────────────────────────────────────────────────────────────────────
# Firebase REST helpers
# ─────────────────────────────────────────────────────────────────────────────

def fb_get(path: str) -> Optional[dict]:
    """GET data from Firebase RTDB via REST."""
    url = f"{FIREBASE_BASE}/{path}.json?auth={FIREBASE_KEY}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            return data
    except urllib.error.HTTPError as e:
        log.error(f"Firebase GET error {e.code} for {path}: {e.reason}")
        return None
    except Exception as e:
        log.error(f"Firebase GET exception for {path}: {e}")
        return None


def fb_put(path: str, payload: dict) -> bool:
    """PUT (overwrite) data at a Firebase RTDB path."""
    url = f"{FIREBASE_BASE}/{path}.json?auth={FIREBASE_KEY}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="PUT",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception as e:
        log.error(f"Firebase PUT error for {path}: {e}")
        return False


def fb_patch(path: str, payload: dict) -> bool:
    """PATCH (merge) data at a Firebase RTDB path."""
    url = f"{FIREBASE_BASE}/{path}.json?auth={FIREBASE_KEY}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="PATCH",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception as e:
        log.error(f"Firebase PATCH error for {path}: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Schedule utilities
# ─────────────────────────────────────────────────────────────────────────────

def normalize_schedule(raw) -> list:
    """Convert Firebase schedule (dict or list) into a sorted list."""
    if not raw:
        return []
    if isinstance(raw, list):
        return [s for s in raw if s]
    if isinstance(raw, dict):
        return list(raw.values())
    return []


def validate_show(show: dict) -> bool:
    required = ["title", "stream_url", "duration"]
    return all(k in show and show[k] for k in required)


def sort_schedule(schedule: list) -> list:
    """Sort by start_ts if present, else assume already ordered."""
    try:
        return sorted(schedule, key=lambda s: s.get("start_ts", 0))
    except Exception:
        return schedule


def fill_gaps(schedule: list) -> list:
    """
    Walk the schedule and inject commercials/fillers into gaps.
    A gap is a silent period between show_end and next_show_start.
    """
    if len(schedule) < 2:
        return schedule

    filled = [schedule[0]]

    for i in range(1, len(schedule)):
        prev = filled[-1]
        curr = schedule[i]

        prev_end = prev.get("start_ts", 0) + prev.get("duration", 0)
        curr_start = curr.get("start_ts", prev_end)

        gap = curr_start - prev_end

        if gap > MAX_GAP_SECONDS:
            log.info(f"Gap detected: {gap}s between '{prev['title']}' and '{curr['title']}'. Injecting filler.")
            # Fill with commercials until gap is consumed
            remaining_gap = gap
            ts = prev_end
            cycle = 0
            while remaining_gap > 0:
                filler = COMMERCIAL_POOL[cycle % len(COMMERCIAL_POOL)].copy()
                actual_dur = min(filler["duration"], remaining_gap)
                filler["duration"] = actual_dur
                filler["start_ts"] = ts
                filler["is_filler"] = True
                filler["title"] = f"{filler['title']} [{cycle+1}]"
                filled.append(filler)
                ts += actual_dur
                remaining_gap -= actual_dur
                cycle += 1

        filled.append(curr)

    return filled


def get_total_duration(schedule: list) -> int:
    return sum(s.get("duration", 0) for s in schedule)


def get_current_show(schedule: list, now_ts: int) -> Optional[dict]:
    """
    Time-based playout: calculate which show should be playing right now.
    Supports infinite looping over the schedule.
    """
    if not schedule:
        return None

    schedule_start = schedule[0].get("start_ts", 0)
    total_duration  = get_total_duration(schedule)

    if total_duration == 0:
        return None

    elapsed = now_ts - schedule_start
    if elapsed < 0:
        # Schedule hasn't started yet
        log.warning("Schedule hasn't started yet. Using first show.")
        return {**schedule[0], "offset": 0, "remaining": schedule[0].get("duration", 0)}

    looped_elapsed = elapsed % total_duration

    cursor = 0
    for show in schedule:
        dur = show.get("duration", 0)
        if looped_elapsed >= cursor and looped_elapsed < cursor + dur:
            offset    = looped_elapsed - cursor
            remaining = dur - offset
            return {**show, "offset": int(offset), "remaining": int(remaining)}
        cursor += dur

    # Fallback to last show
    last = schedule[-1]
    return {**last, "offset": 0, "remaining": last.get("duration", 0)}


def get_upcoming_shows(schedule: list, now_ts: int, count: int = 5) -> list:
    """Return next N shows after current."""
    if not schedule:
        return []

    total_duration  = get_total_duration(schedule)
    schedule_start  = schedule[0].get("start_ts", 0)
    elapsed         = (now_ts - schedule_start) % total_duration if total_duration else 0

    cursor = 0
    current_idx = 0
    for i, show in enumerate(schedule):
        dur = show.get("duration", 0)
        if elapsed >= cursor and elapsed < cursor + dur:
            current_idx = i
            break
        cursor += dur

    upcoming = []
    n = len(schedule)
    for i in range(1, count + 1):
        idx = (current_idx + i) % n
        upcoming.append({
            "title":      schedule[idx].get("title", "Unknown"),
            "duration":   schedule[idx].get("duration", 0),
            "stream_url": schedule[idx].get("stream_url", FILLER_LOOP),
            "is_filler":  schedule[idx].get("is_filler", False),
        })

    return upcoming


# ─────────────────────────────────────────────────────────────────────────────
# Stream health check
# ─────────────────────────────────────────────────────────────────────────────

def check_stream_health(url: str, timeout: int = 10) -> bool:
    """Attempt a HEAD request to verify the stream URL is reachable."""
    if not url or not url.startswith("http"):
        return False
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status in (200, 206)
    except Exception as e:
        log.warning(f"Stream health check failed for {url}: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# 30-Day default schedule generator
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_DAILY_BLOCKS = [
    {"title": "📺 MI Morning News",         "duration": 3600,  "category": "news"},
    {"title": "🕌 Quran Recitation",         "duration": 1800,  "category": "religious"},
    {"title": "📰 MI News Bulletin",         "duration": 900,   "category": "news"},
    {"title": "🎬 Islamic Documentary",      "duration": 5400,  "category": "documentary"},
    {"title": "📺 MI Afternoon Show",        "duration": 3600,  "category": "show"},
    {"title": "🕌 Dhuhr Azan",               "duration": 300,   "category": "azan"},
    {"title": "🎵 Nasheed Collection",        "duration": 2700,  "category": "nasheed"},
    {"title": "📰 MI News Bulletin PM",      "duration": 900,   "category": "news"},
    {"title": "🎬 Muslim World Report",      "duration": 3600,  "category": "documentary"},
    {"title": "🕌 Asr Azan",                 "duration": 300,   "category": "azan"},
    {"title": "📺 MI Evening Talk Show",     "duration": 3600,  "category": "show"},
    {"title": "🕌 Maghrib Azan",             "duration": 300,   "category": "azan"},
    {"title": "📰 MI Prime Time News",       "duration": 1800,  "category": "news"},
    {"title": "🎬 Featured Film",            "duration": 7200,  "category": "film"},
    {"title": "🕌 Isha Azan",                "duration": 300,   "category": "azan"},
    {"title": "🎵 Late Night Nasheeds",      "duration": 3600,  "category": "nasheed"},
    {"title": "📺 MI Night Digest",          "duration": 1800,  "category": "news"},
    {"title": "🌙 Overnight Loop",           "duration": 14400, "category": "loop"},
]

def generate_30day_schedule(channel_id: int, stream_url_map: dict = None) -> list:
    """
    Generate a 30-day schedule starting from today midnight (Pakistan time).
    Each day repeats DEFAULT_DAILY_BLOCKS with stream URLs mapped by category.
    """
    if stream_url_map is None:
        stream_url_map = {}

    # Pakistan Standard Time offset: UTC+5
    now_utc  = datetime.datetime.utcnow()
    pk_offset = datetime.timedelta(hours=5)
    now_pk   = now_utc + pk_offset

    # Start from today midnight PKT
    today_midnight = now_pk.replace(hour=0, minute=0, second=0, microsecond=0)
    start_utc = today_midnight - pk_offset  # Convert back to UTC
    start_ts  = int(start_utc.timestamp())

    schedule = []
    cursor_ts = start_ts

    for day in range(30):
        for block in DEFAULT_DAILY_BLOCKS:
            url = stream_url_map.get(block["category"], FILLER_LOOP)
            entry = {
                "title":      f"Day {day+1} — {block['title']}",
                "duration":   block["duration"],
                "stream_url": url,
                "start_ts":   cursor_ts,
                "category":   block["category"],
                "day":        day + 1,
                "is_filler":  False,
            }
            schedule.append(entry)
            cursor_ts += block["duration"]

    log.info(f"Generated 30-day schedule for Ch{channel_id}: {len(schedule)} blocks, "
             f"total {cursor_ts - start_ts}s ({(cursor_ts - start_ts)//86400} days)")
    return schedule


# ─────────────────────────────────────────────────────────────────────────────
# Main playout engine
# ─────────────────────────────────────────────────────────────────────────────

def process_channel(channel_id: int, now_ts: int):
    log.info(f"━━━ Processing Channel {channel_id} ━━━")

    # 1. Fetch schedule from Firebase
    raw_schedule = fb_get(f"mitv/schedules/ch{channel_id}")

    if not raw_schedule:
        log.warning(f"Ch{channel_id}: No schedule found in Firebase. Generating default 30-day schedule.")
        schedule = generate_30day_schedule(channel_id)
        # Push generated schedule to Firebase
        fb_put(f"mitv/schedules/ch{channel_id}", {str(i): s for i, s in enumerate(schedule)})
    else:
        schedule = normalize_schedule(raw_schedule)
        schedule = sort_schedule(schedule)

    if not schedule:
        log.error(f"Ch{channel_id}: Schedule is empty after normalization. Using emergency loop.")
        emergency_state = {
            "title":          "🚨 Emergency Loop",
            "stream_url":     FILLER_LOOP,
            "offset":         0,
            "remaining":      99999,
            "is_emergency":   True,
            "updated_at":     now_ts,
            "updated_at_iso": datetime.datetime.utcnow().isoformat() + "Z",
        }
        fb_patch(f"mitv/now_playing/ch{channel_id}", emergency_state)
        return

    # 2. Fill schedule gaps
    schedule = fill_gaps(schedule)

    # 3. Calculate current show
    current = get_current_show(schedule, now_ts)

    if not current:
        log.error(f"Ch{channel_id}: Could not determine current show. Using emergency loop.")
        current = {
            "title":      "🚨 Emergency Loop",
            "stream_url": FILLER_LOOP,
            "offset":     0,
            "remaining":  99999,
        }

    # 4. Stream health check
    stream_url = current.get("stream_url", FILLER_LOOP)
    healthy    = check_stream_health(stream_url)

    if not healthy:
        log.warning(f"Ch{channel_id}: Stream '{stream_url}' unreachable. Switching to filler loop.")
        stream_url = FILLER_LOOP
        current["stream_url"]     = FILLER_LOOP
        current["fallback_active"] = True

    # 5. Get upcoming shows
    upcoming = get_upcoming_shows(schedule, now_ts, count=5)

    # 6. Build "now playing" state object
    now_playing = {
        "channel":          channel_id,
        "title":            current.get("title", "Unknown"),
        "stream_url":       stream_url,
        "offset_seconds":   current.get("offset", 0),
        "remaining_seconds": current.get("remaining", 0),
        "category":         current.get("category", "unknown"),
        "is_filler":        current.get("is_filler", False),
        "fallback_active":  current.get("fallback_active", False),
        "stream_healthy":   healthy,
        "upcoming":         upcoming,
        "updated_at":       now_ts,
        "updated_at_iso":   datetime.datetime.utcnow().isoformat() + "Z",
        "schedule_total":   len(schedule),
    }

    # 7. Push to Firebase
    success = fb_patch(f"mitv/now_playing/ch{channel_id}", now_playing)

    if success:
        log.info(f"Ch{channel_id} ✅ Now playing: '{current['title']}' "
                 f"(offset {current.get('offset',0)}s, {current.get('remaining',0)}s remaining)")
    else:
        log.error(f"Ch{channel_id} ❌ Failed to update Firebase now_playing")

    # 8. Update last-run heartbeat
    fb_patch("mitv/system/heartbeat", {
        f"ch{channel_id}_last_run":    now_ts,
        f"ch{channel_id}_last_run_iso": datetime.datetime.utcnow().isoformat() + "Z",
    })


def update_system_status(now_ts: int, channels_processed: list):
    """Write overall system status to Firebase."""
    fb_patch("mitv/system/status", {
        "last_run":             now_ts,
        "last_run_iso":         datetime.datetime.utcnow().isoformat() + "Z",
        "channels_processed":   channels_processed,
        "scheduler_version":    "2.0.0",
        "engine":               "MI-Playout-Python",
        "next_expected_run":    now_ts + 600,
    })


def main():
    now_ts = int(time.time())
    log.info("=" * 60)
    log.info(f"MI LIVE TV SYSTEM — Playout Engine v2.0")
    log.info(f"Run time (UTC): {datetime.datetime.utcnow().isoformat()}")
    log.info(f"Unix timestamp: {now_ts}")
    log.info("=" * 60)

    channels_processed = []

    for ch in CHANNELS:
        try:
            process_channel(ch, now_ts)
            channels_processed.append(ch)
        except Exception as e:
            log.exception(f"Critical error processing Ch{ch}: {e}")

    update_system_status(now_ts, channels_processed)

    log.info("=" * 60)
    log.info(f"Playout run complete. Channels processed: {channels_processed}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
