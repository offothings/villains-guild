# Guild Attendance Tracker

A static site (no build step) that shows guild event attendance from three
tabs of a Google Sheet. Built to run on GitHub Pages.

## Tabs

1. **Guild Overview** — date-range filter over all sessions: stats (session
   count, unique players, avg attendees/session, overall attendance %), a
   per-session table, and a leaderboard.
2. **Player Lookup** — filter by player name (with a single-click searchable
   dropdown) and a date range: that player's stats and their full
   attendance history.
3. **Member List** — pick a date and see who was on the guild roster as of
   that date, plus each member's all-time session count and last-attended
   date.
4. **Signup Audit** — date-range filter cross-referencing sign-ups against
   attendance for the same date + event + player, split into three lists:
   players who signed up but never showed, players who showed on a
   different field than they signed up for, and players who showed without
   signing up.

## Data source

All three tables live as tabs in one
[Google Sheet](https://docs.google.com/spreadsheets/d/1VkAB0RWFQBzVkEJUyBoHu_mPxW5Mnqz373GcDpKlMw0/edit).
The site fetches each tab's CSV export directly at page load — there is no
local copy of the data in this repo.

- **Attendance** tab (gid `0`) — one row per player per event:
  ```
  date, event, field, ingame_name, points
  ```
- **Roster** tab (gid `108271403`) — a **join/leave log**: one row per
  membership change.
  ```
  date, name, class, log
  ```
  `log` is either `joined` or `left`. The site replays this log in date
  order to reconstruct who was on the roster (and their class) as of any
  given date — add a new `joined` row when someone joins, and a `left` row
  when someone leaves, in chronological order. No need to re-list unchanged
  members; the site carries forward everyone who last `joined` and hasn't
  since `left`.
- **Signup** tab (gid `311091534`) — one row per player per event sign-up:
  ```
  date, event, discord_name, field, ingame_name
  ```
  `discord_name` is ignored by the site. `field` is the field the player
  signed up for, compared against their actual attended `field` on the
  Attendance tab.

All three tabs must keep their header row and column order. Values are
matched case-sensitively on `ingame_name`, so keep spelling/casing
consistent across tabs — this matters especially for the Signup Audit tab,
since a casing mismatch on `ingame_name` will show up as a false "didn't
attend" / "didn't sign up" pair.

The URLs the site fetches are built from the spreadsheet ID and each tab's
`gid` in `js/app.js` (`SPREADSHEET_ID`, `ATTENDANCE_GID`, `ROSTER_GID`,
`SIGNUP_GID`). If a tab is ever added, removed, or reordered, its `gid` can
change — find the current one from the tab's URL in Google Sheets
(`...#gid=123456`) and update it there.

## Updating data

Edit the Google Sheet directly — no commit or push needed. The site
re-fetches all three tabs on every page load.

The sheet must stay shared as **Anyone with the link → Viewer** (or more
open) for the CSV export endpoint to be reachable without login; if
sharing is tightened, the site will fail to load data.

## Local preview

Serve the folder over HTTP (this also avoids unrelated `file://` quirks in
some browsers):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Publishing on GitHub Pages

This repo is named `<username>.github.io`, so GitHub Pages serves it
automatically from the default branch's root — no extra config needed once
this branch is merged into the default branch (or set as the Pages source
under **Settings → Pages**).
