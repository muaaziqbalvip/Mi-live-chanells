#!/usr/bin/env python3
"""
MI LIVE TV — playout.py
30-Day Smart Scheduler + Auto-Filler Logic
Runs via GitHub Actions on a cron schedule.

Usage:
  python playout.py --channels 1 2 3 --days 30
  python playout.py --channel 1 --days 7 --dry-run
"""

import argparse
import json
import os
import sys
import time
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, db

# ─── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("milive-scheduler")

# ─── Constants ────────────────────────────────────────────────────────────────
DEFAULT_TIMEZONE    = "Asia/Karachi"   # PKT — adjust as needed
DEFAULT_FILLER_URL  = os.getenv("DEFAULT_FILLER_URL", "https://example.com/filler.mp4")
DEFAULT_PROMO_URL   = os.getenv("DEFAULT_PROMO_URL",  "https://example.com/promo.mp4")
SEGMENT_DURATION    = 6               # HLS segment seconds
MIN_GAP_FILL_SEC    = 5               # fill any gap >= 5 seconds

# ─── Firebase Init ────────────────────────────────────────────────────────────
def init_firebase():
    """Initialize Firebase Admin SDK from environment variable (JSON string)."""
    if firebase_admin._apps:
        return firebase_admin.get_app()

    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if service_account_json:
        sa_dict = json.loads(service_account_json)
        cred = credentials.Certificate(sa_dict)
    else:
        # Fallback: load from file (for local dev)
        cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "serviceAccountKey.json")
        if not os.path.exists(cred_path):
            log.error("No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_JSON env var.")
            sys.exit(1)
        cred = credentials.Certificate(cred_path)

    firebase_admin.initialize_app(cred, {
        "databaseURL": os.getenv(
            "FIREBASE_DATABASE_URL",
            "https://ramadan-2385b-default-rtdb.firebaseio.com"
        )
    })
    log.info("Firebase Admin SDK initialized.")
    return firebase_admin.get_app()


# ─── Helpers ──────────────────────────────────────────────────────────────────
def parse_duration(duration_str: str) -> int:
    """Parse 'HH:MM:SS' → total seconds."""
    parts = [int(p) for p in (duration_str or "00:30:00").split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0]


def format_duration(seconds: int) -> str:
    """Total seconds → 'HH:MM:SS'."""
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def dt_to_iso(dt: datetime) -> str:
    return dt.isoformat()


def make_entry(title: str, start_dt: datetime, duration_sec: int,
               video_url: str, entry_type: str, channel_id: int) -> dict:
    return {
        "title":     title,
        "start":     dt_to_iso(start_dt),
        "duration":  format_duration(duration_sec),
        "videoUrl":  video_url,
        "type":      entry_type,
        "channelId": channel_id,
        "createdAt": int(time.time() * 1000),
        "autoFilled": entry_type in ("filler", "promo"),
    }


# ─── Media Library Reader ─────────────────────────────────────────────────────
def fetch_media_library(channel_id: int) -> list[dict]:
    """Fetch all uploaded media for a channel from Firebase."""
    try:
        snap = db.reference(f"channels/ch{channel_id}/media").get()
        if not snap:
            return []
        items = list(snap.values())
        log.info(f"  Channel {channel_id}: {len(items)} media items found.")
        return items
    except Exception as e:
        log.warning(f"  Could not fetch media library: {e}")
        return []


def fetch_filler_config(channel_id: int) -> dict:
    """Fetch filler config from Firebase."""
    try:
        snap = db.reference(f"channels/ch{channel_id}/filler").get()
        return snap or {}
    except Exception:
        return {}


def fetch_program_template(channel_id: int) -> list[dict]:
    """
    Fetch the weekly program template (repeating schedule blueprint).
    Each item: { dayOfWeek: 0-6, startHour, startMin, durationSec, videoUrl, title, type }
    """
    try:
        snap = db.reference(f"channels/ch{channel_id}/programTemplate").get()
        if not snap:
            return []
        return list(snap.values())
    except Exception:
        return []


# ─── Auto-Filler Logic ────────────────────────────────────────────────────────
class AutoFiller:
    """Fills gaps in the schedule with fillers, promos, and animations."""

    def __init__(self, filler_url: str, promo_url: str):
        self.filler_url = filler_url
        self.promo_url  = promo_url
        self._promo_counter = 0

    def pick_filler(self, gap_seconds: int) -> tuple[str, str]:
        """Choose the best filler type for a given gap duration."""
        if gap_seconds <= 30:
            return self.filler_url, "filler"
        if gap_seconds <= 120:
            self._promo_counter += 1
            return self.promo_url, "promo"
        # Longer gaps: alternate between promo and animation
        if self._promo_counter % 2 == 0:
            self._promo_counter += 1
            return self.promo_url, "promo"
        self._promo_counter += 1
        return self.filler_url, "filler"

    def fill_gap(self, start_dt: datetime, gap_seconds: int,
                 channel_id: int, slot_index: int) -> list[dict]:
        """
        Fill a gap with one or more filler entries.
        Splits long gaps into multiple filler segments.
        """
        entries = []
        remaining = gap_seconds
        cursor = start_dt
        seg_idx = 0

        while remaining >= MIN_GAP_FILL_SEC:
            url, ftype = self.pick_filler(remaining)
            # Cap single filler at 5 minutes
            seg_dur = min(remaining, 300)

            entries.append(make_entry(
                title       = f"Auto-Filler {slot_index}-{seg_idx}",
                start_dt    = cursor,
                duration_sec= seg_dur,
                video_url   = url,
                entry_type  = ftype,
                channel_id  = channel_id,
            ))
            cursor   += timedelta(seconds=seg_dur)
            remaining -= seg_dur
            seg_idx  += 1

        return entries


# ─── Core Scheduler ───────────────────────────────────────────────────────────
class ThirtyDayScheduler:

    def __init__(self, channel_id: int, timezone_str: str = DEFAULT_TIMEZONE,
                 days: int = 30, dry_run: bool = False):
        self.channel_id   = channel_id
        self.tz           = ZoneInfo(timezone_str)
        self.days         = days
        self.dry_run      = dry_run
        self.filler_cfg   = {}
        self.media_lib    = []
        self.template     = []
        self.generated    = []  # Final schedule entries

    def load_from_firebase(self):
        log.info(f"Loading data for channel {self.channel_id} from Firebase…")
        self.filler_cfg = fetch_filler_config(self.channel_id)
        self.media_lib  = fetch_media_library(self.channel_id)
        self.template   = fetch_program_template(self.channel_id)
        log.info(f"  Template entries: {len(self.template)}")
        log.info(f"  Filler URL: {self.filler_cfg.get('url', DEFAULT_FILLER_URL)}")

    def calculate(self):
        """
        Core 30-day schedule calculation.

        Algorithm:
        1. Iterate over each day in the window.
        2. For each day, apply the weekly template (if set).
        3. Detect gaps between scheduled programs.
        4. Auto-fill every gap >= MIN_GAP_FILL_SEC.
        5. If no template: fill entire day with fillers.
        """
        filler_url = self.filler_cfg.get("url", DEFAULT_FILLER_URL)
        promo_url  = self.filler_cfg.get("promoUrl", DEFAULT_PROMO_URL)
        autofiller = AutoFiller(filler_url=filler_url, promo_url=promo_url)

        now_local   = datetime.now(self.tz).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        window_end  = now_local + timedelta(days=self.days)

        log.info(f"Calculating {self.days}-day schedule for channel {self.channel_id}…")
        log.info(f"  Window: {now_local.date()} → {window_end.date()}")

        total_entries   = 0
        total_filler_s  = 0
        total_program_s = 0

        cursor = now_local

        while cursor < window_end:
            day_start = cursor
            day_end   = cursor + timedelta(hours=24)
            dow       = cursor.weekday()  # 0=Mon, 6=Sun

            # Get programs for this day of week from template
            day_programs = [
                t for t in self.template
                if t.get("dayOfWeek") == dow
            ]
            day_programs.sort(key=lambda x: x.get("startHour", 0) * 60 + x.get("startMin", 0))

            # Build timeline for this day
            timeline: list[dict] = []
            for prog in day_programs:
                prog_start = cursor.replace(
                    hour=int(prog.get("startHour", 0)),
                    minute=int(prog.get("startMin", 0)),
                    second=0
                )
                prog_dur = parse_duration(prog.get("duration", "00:30:00"))

                # If duration from template > actual media duration, clip or pad
                actual_dur = int(prog.get("durationSec") or prog_dur)
                if actual_dur < prog_dur:
                    # Real content is shorter: note gap to fill after
                    log.debug(f"  Program '{prog.get('title')}' is {prog_dur - actual_dur}s short — will auto-fill.")

                timeline.append(make_entry(
                    title        = prog.get("title", "Scheduled Program"),
                    start_dt     = prog_start,
                    duration_sec = actual_dur,
                    video_url    = prog.get("videoUrl", filler_url),
                    entry_type   = prog.get("type", "program"),
                    channel_id   = self.channel_id,
                ))
                total_program_s += actual_dur

            # ── Gap Detection + Auto-Fill ──────────────────────────────────
            filled_timeline = []
            slot_idx = 0

            if not timeline:
                # No template for this day → fill entire day with filler
                filler_entries = autofiller.fill_gap(day_start, 86400, self.channel_id, slot_idx)
                filled_timeline.extend(filler_entries)
                total_filler_s += 86400
            else:
                # Fill gap from day start → first program
                first_start = datetime.fromisoformat(timeline[0]["start"])
                gap_to_first = int((first_start - day_start).total_seconds())
                if gap_to_first >= MIN_GAP_FILL_SEC:
                    fills = autofiller.fill_gap(day_start, gap_to_first, self.channel_id, slot_idx)
                    filled_timeline.extend(fills)
                    total_filler_s += gap_to_first
                    slot_idx += 1

                # Walk through programs
                for i, entry in enumerate(timeline):
                    filled_timeline.append(entry)
                    entry_start = datetime.fromisoformat(entry["start"])
                    entry_dur   = parse_duration(entry["duration"])
                    entry_end   = entry_start + timedelta(seconds=entry_dur)

                    # Gap after this entry
                    if i < len(timeline) - 1:
                        next_start = datetime.fromisoformat(timeline[i+1]["start"])
                        gap = int((next_start - entry_end).total_seconds())
                    else:
                        gap = int((day_end - entry_end).total_seconds())

                    if gap >= MIN_GAP_FILL_SEC:
                        fills = autofiller.fill_gap(entry_end, gap, self.channel_id, slot_idx)
                        filled_timeline.extend(fills)
                        total_filler_s += gap
                        slot_idx += 1

            self.generated.extend(filled_timeline)
            total_entries += len(filled_timeline)
            cursor = day_end

        log.info(f"  ✅ Generated {total_entries} entries over {self.days} days.")
        log.info(f"  📺 Program time  : {format_duration(total_program_s)}")
        log.info(f"  🔄 Filler time   : {format_duration(total_filler_s)}")
        log.info(f"  ⏱  Total         : {format_duration(total_program_s + total_filler_s)}")

    def save_to_firebase(self):
        """Write the generated schedule to Firebase in batched chunks."""
        if self.dry_run:
            log.info("[DRY RUN] Would write to Firebase. Showing first 5 entries:")
            for e in self.generated[:5]:
                log.info(f"  {e['start']} | {e['title']} | {e['duration']} | {e['type']}")
            return

        ch_ref  = db.reference(f"channels/ch{self.channel_id}/schedule")
        meta_ref = db.reference(f"channels/ch{self.channel_id}/schedulerMeta")

        log.info(f"Clearing old schedule for channel {self.channel_id}…")
        ch_ref.delete()

        log.info(f"Writing {len(self.generated)} entries to Firebase…")

        BATCH_SIZE = 100
        for i in range(0, len(self.generated), BATCH_SIZE):
            batch = self.generated[i:i + BATCH_SIZE]
            batch_data = {}
            for entry in batch:
                # Use timestamp as key for ordering
                key = str(int(datetime.fromisoformat(entry["start"]).timestamp() * 1000))
                batch_data[key] = entry
            ch_ref.update(batch_data)
            log.info(f"  Wrote batch {i // BATCH_SIZE + 1}/{-(-len(self.generated) // BATCH_SIZE)}")
            time.sleep(0.1)  # Avoid rate limiting

        # Write scheduler metadata
        meta_ref.set({
            "lastRun":      int(time.time() * 1000),
            "daysScheduled": self.days,
            "totalEntries":  len(self.generated),
            "channelId":     self.channel_id,
            "generatedAt":   datetime.now(timezone.utc).isoformat(),
        })

        log.info(f"✅ Schedule saved to Firebase for channel {self.channel_id}.")

    def export_json(self, path: str):
        """Export schedule to a local JSON file (for debugging)."""
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.generated, f, indent=2, ensure_ascii=False)
        log.info(f"Schedule exported to {path}")

    def run(self):
        self.load_from_firebase()
        self.calculate()
        self.save_to_firebase()


# ─── CLI ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="MI LIVE TV — 30-Day Smart Scheduler"
    )
    parser.add_argument("--channels", nargs="+", type=int, default=[1],
                        help="Channel IDs to schedule (e.g. 1 2 3)")
    parser.add_argument("--days",     type=int,  default=30,
                        help="Number of days to schedule ahead")
    parser.add_argument("--timezone", type=str,  default=DEFAULT_TIMEZONE,
                        help="Timezone string (e.g. Asia/Karachi)")
    parser.add_argument("--dry-run",  action="store_true",
                        help="Calculate but do NOT write to Firebase")
    parser.add_argument("--export",   type=str, default=None,
                        help="Export schedule to JSON file path")
    args = parser.parse_args()

    # Init Firebase
    init_firebase()

    errors = []
    for ch_id in args.channels:
        log.info(f"════ Processing Channel {ch_id} ════")
        try:
            scheduler = ThirtyDayScheduler(
                channel_id   = ch_id,
                timezone_str = args.timezone,
                days         = args.days,
                dry_run      = args.dry_run,
            )
            scheduler.run()
            if args.export:
                export_path = args.export.replace(".json", f"_ch{ch_id}.json")
                scheduler.export_json(export_path)
        except Exception as e:
            log.error(f"Channel {ch_id} failed: {e}", exc_info=True)
            errors.append((ch_id, str(e)))

    if errors:
        log.error(f"Scheduler completed with {len(errors)} error(s):")
        for ch_id, msg in errors:
            log.error(f"  CH{ch_id}: {msg}")
        sys.exit(1)

    log.info("All channels scheduled successfully. 🎬")


if __name__ == "__main__":
    main()
