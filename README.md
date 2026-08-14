# Guild Attendance Tracker

A static site (no build step) that shows guild event attendance from two CSV
files. Built to run on GitHub Pages.

## Tabs

1. **Guild Overview** — date-range filter over all sessions: stats (session
   count, unique players, avg attendees/session, overall attendance %), a
   per-session table, and a leaderboard.
2. **Player Lookup** — filter by player name (with autocomplete) and a date
   range: that player's stats and their full attendance history.
3. **Member List** — pick a date and see who was on the guild roster as of
   that date, plus each member's all-time session count and last-attended
   date.

## Data files

- `data/attendance.csv` — one row per player per event:
  ```
  "date","event","field","ingame_name","points"
  ```
- `data/roster.csv` — roster **snapshots**: each row says a member was on
  the roster as of `date`. Add a new snapshot (a batch of rows sharing a new
  date) whenever the roster changes; the site uses the most recent snapshot
  on or before whichever date you're viewing. You don't need to repeat a
  snapshot if the roster hasn't changed — the site should be seeded with realistic
  starter data now; replace both CSVs with your real data whenever you're
  ready.

Both files must keep their header row and column order. Values are matched
case-sensitively on `ingame_name`, so keep spelling/casing consistent
between the two files.

## Updating data

Edit `data/attendance.csv` and `data/roster.csv` directly (e.g. export from
a spreadsheet as CSV, keeping the quoted-header format), commit, and push.
The site re-reads these files on every page load — no build/deploy step
needed beyond a normal git push.

## Local preview

Browsers block `fetch()` on local files opened directly, so serve the
folder over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Publishing on GitHub Pages

This repo is named `<username>.github.io`, so GitHub Pages serves it
automatically from the default branch's root — no extra config needed once
this branch is merged into the default branch (or set as the Pages source
under **Settings → Pages**).
