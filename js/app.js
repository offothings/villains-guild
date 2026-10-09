(function () {
  "use strict";

  const state = {
    // sOrTablet/aOrMonster/bCaptures/kills/assists/deaths are Guild-League
    // only and null for other events — see combatStats().
    attendance: [], // { date, event, field, ingame_name, points, sOrTablet, aOrMonster, bCaptures, kills, assists, deaths }
    rosterEvents: [], // { date, name, class, log } sorted ascending by date, joined/left log
    rosterEventDatesSorted: [], // unique ascending dates
    signups: [], // { date, event, field, ingame_name }
    absences: [], // { dateBegin, dateEnd, ingame_name, class, comments } (ISO dates)
    absencesError: "",
    auctionAudits: [], // { date, event, ingame_name, status } (ISO date)
    pendingAudits: [], // { date, event, ingame_name, status } (ISO date)
    auditsError: "",
  };

  // Guild data lives in a Google Sheet (one spreadsheet, one tab per file).
  // Each tab is fetched as CSV via Sheets' export endpoint. The sheet must
  // be shared as "Anyone with the link" → Viewer for this to work.
  const SPREADSHEET_ID = "1VkAB0RWFQBzVkEJUyBoHu_mPxW5Mnqz373GcDpKlMw0";
  const ATTENDANCE_GID = "0";
  const ROSTER_GID = "108271403";
  const SIGNUP_GID = "311091534";
  // Looked up by sheet name (gviz endpoint) rather than gid.
  const ABSENCE_SHEET_NAME = "absence_reports";
  const AUCTION_AUDITS_SHEET_NAME = "auction_audits";
  const PENDING_AUDITS_SHEET_NAME = "audits_pending";

  // Event names must match the sheet's "event" column exactly.
  const EVENT_STELLAR_CLASH = "Guild League Stellar Clash";
  const EVENT_VALE_OF_CLASH = "Guild League Vale of Clash";
  const GUILD_LEAGUE_EVENTS = [EVENT_STELLAR_CLASH, EVENT_VALE_OF_CLASH];
  const EMPERIUM_OVERRUN_EVENT = "Emperium Overrun";

  function sheetCSVUrl(gid) {
    return "https://docs.google.com/spreadsheets/d/" + SPREADSHEET_ID + "/export?format=csv&gid=" + gid;
  }

  const fmtPct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "—");
  const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString() : "—");

  // Swaps in a non-breaking hyphen so "YYYY-MM-DD" never line-breaks
  // mid-string when a table's columns get narrow.
  const fmtDate = (d) => (typeof d === "string" ? d.replace(/-/g, "‑") : d);

  // Blank cells parse to "" (not undefined) from the CSV, and must be kept
  // as null (not 0) so callers can tell "not tracked for this row" apart
  // from "tracked, and zero".
  function parseOptionalNum(v) {
    if (v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function loadCSV(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load " + url + " (" + res.status + ")");
    const text = await res.text();
    return parseCSV(text);
  }

  // Replays the join/leave log up to (and including) dateStr and returns the
  // resulting roster as a Map of name -> { class, joinedDate }, where
  // joinedDate is the date of the join that led to current membership (so a
  // rejoin after leaving shows the most recent join, not the original one).
  // Returns null if there's no roster data loaded at all.
  function getRosterAsOf(dateStr) {
    if (!dateStr || state.rosterEvents.length === 0) return null;
    const roster = new Map();
    for (const ev of state.rosterEvents) {
      if (ev.date > dateStr) break;
      if (ev.log === "left") {
        roster.delete(ev.name);
      } else {
        roster.set(ev.name, { class: ev.class, joinedDate: ev.date });
      }
    }
    return roster;
  }

  // Most recent "joined" date for a player, even if they've since left —
  // informational, unlike getRosterAsOf which is gated on current membership.
  function getLatestJoinDate(name) {
    let latest = null;
    for (const ev of state.rosterEvents) {
      if (ev.name === name && ev.log === "joined" && (!latest || ev.date > latest)) {
        latest = ev.date;
      }
    }
    return latest;
  }

  // Sessions are identified by date + event only — the "field" column does
  // not distinguish a separate event/session.
  function sessionKey(row) {
    return row.date + "|||" + row.event;
  }

  // Combat stats share sheet columns whose meaning depends on which Guild
  // League event a row belongs to: Vale of Clash tracks S/A/B tablets
  // separately; Stellar Clash tracks one combined "tablets captured" total
  // (shown under the S Tablets column, reusing the same sheet column) plus
  // monsters killed (B is unused for Stellar Clash). Other events don't
  // populate any of these columns at all — returned as null, not 0, so
  // callers can tell "not tracked" apart from "tracked, zero".
  function combatStats(row) {
    if (row.event === EVENT_VALE_OF_CLASH) {
      return { sTablets: row.sOrTablet, aTablets: row.aOrMonster, bTablets: row.bCaptures, monstersKilled: null };
    }
    if (row.event === EVENT_STELLAR_CLASH) {
      return { sTablets: row.sOrTablet, aTablets: null, bTablets: null, monstersKilled: row.aOrMonster };
    }
    return { sTablets: null, aTablets: null, bTablets: null, monstersKilled: null };
  }

  function fmtStat(n) {
    return n === null || n === undefined ? "—" : fmtNum(n);
  }

  // Kills/assists/deaths are Guild-League-only, blank elsewhere.
  function formatKAD(row) {
    if (!GUILD_LEAGUE_EVENTS.includes(row.event)) return "—";
    return fmtNum(row.kills || 0) + "/" + fmtNum(row.assists || 0) + "/" + fmtNum(row.deaths || 0);
  }

  function newCombatTotals() {
    return {
      sTablets: 0,
      aTablets: 0,
      bTablets: 0,
      monstersKilled: 0,
      kills: 0,
      assists: 0,
      deaths: 0,
      hasVale: false,
      hasStellar: false,
    };
  }

  function accumulateCombatStats(totals, row) {
    if (row.event === EVENT_VALE_OF_CLASH) totals.hasVale = true;
    if (row.event === EVENT_STELLAR_CLASH) totals.hasStellar = true;
    const stats = combatStats(row);
    if (stats.sTablets !== null) totals.sTablets += stats.sTablets;
    if (stats.aTablets !== null) totals.aTablets += stats.aTablets;
    if (stats.bTablets !== null) totals.bTablets += stats.bTablets;
    if (stats.monstersKilled !== null) totals.monstersKilled += stats.monstersKilled;
    if (GUILD_LEAGUE_EVENTS.includes(row.event)) {
      totals.kills += row.kills || 0;
      totals.assists += row.assists || 0;
      totals.deaths += row.deaths || 0;
    }
  }

  // Formats accumulated totals for display, showing "—" for stats that were
  // never tracked at all (as opposed to tracked-and-zero).
  function formatCombatTotals(totals) {
    const trackedTablets = totals.hasVale || totals.hasStellar;
    return {
      sTablets: trackedTablets ? fmtNum(totals.sTablets) : "—",
      aTablets: totals.hasVale ? fmtNum(totals.aTablets) : "—",
      bTablets: totals.hasVale ? fmtNum(totals.bTablets) : "—",
      monstersKilled: totals.hasStellar ? fmtNum(totals.monstersKilled) : "—",
      kad: trackedTablets ? fmtNum(totals.kills) + "/" + fmtNum(totals.assists) + "/" + fmtNum(totals.deaths) : "—",
    };
  }

  function buildSessions(rows) {
    const sessions = new Map();
    for (const row of rows) {
      const key = sessionKey(row);
      if (!sessions.has(key)) {
        sessions.set(key, {
          date: row.date,
          event: row.event,
          attendees: new Set(),
          totalPoints: 0,
          combat: newCombatTotals(),
        });
      }
      const s = sessions.get(key);
      s.attendees.add(row.ingame_name);
      s.totalPoints += row.points;
      accumulateCombatStats(s.combat, row);
    }
    return Array.from(sessions.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  function inRange(dateStr, start, end) {
    if (start && dateStr < start) return false;
    if (end && dateStr > end) return false;
    return true;
  }

  // ---------- Tabs ----------

  function initTabs() {
    const buttons = document.querySelectorAll(".tab-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
      });
    });
  }

  // ---------- Overview tab ----------

  function initOverviewTab() {
    const startInput = document.getElementById("overview-start");
    const endInput = document.getElementById("overview-end");
    const clearBtn = document.getElementById("overview-clear");

    const dates = state.attendance.map((r) => r.date);
    if (dates.length) {
      startInput.min = endInput.min = dates.reduce((a, b) => (b < a ? b : a));
      startInput.max = endInput.max = dates.reduce((a, b) => (b > a ? b : a));
    }

    startInput.addEventListener("change", renderOverview);
    endInput.addEventListener("change", renderOverview);
    clearBtn.addEventListener("click", () => {
      startInput.value = "";
      endInput.value = "";
      renderOverview();
    });

    renderOverview();
  }

  function renderOverview() {
    const start = document.getElementById("overview-start").value;
    const end = document.getElementById("overview-end").value;

    const filtered = state.attendance.filter((r) => inRange(r.date, start, end));
    const sessions = buildSessions(filtered);

    const uniquePlayers = new Set(filtered.map((r) => r.ingame_name));
    const totalAttendanceInstances = filtered.length;
    const avgAttendeesPerSession = sessions.length ? totalAttendanceInstances / sessions.length : NaN;

    let pctNumerator = 0;
    let pctDenominator = 0;
    const sessionRows = sessions.map((s) => {
      const roster = getRosterAsOf(s.date);
      let pct = NaN;
      if (roster && roster.size > 0) {
        pct = s.attendees.size / roster.size;
        pctNumerator += s.attendees.size;
        pctDenominator += roster.size;
      }
      return { ...s, rosterSize: roster ? roster.size : null, pct };
    });
    const overallPct = pctDenominator > 0 ? pctNumerator / pctDenominator : NaN;

    // Leaderboard
    const leaderboard = new Map(); // name -> { sessions: Set(key), points, combat }
    for (const row of filtered) {
      const key = sessionKey(row);
      if (!leaderboard.has(row.ingame_name)) {
        leaderboard.set(row.ingame_name, { sessions: new Set(), points: 0, combat: newCombatTotals() });
      }
      const l = leaderboard.get(row.ingame_name);
      l.sessions.add(key);
      l.points += row.points;
      accumulateCombatStats(l.combat, row);
    }
    const leaderboardRows = Array.from(leaderboard.entries())
      .map(([name, v]) => ({ name, sessions: v.sessions.size, points: v.points, combat: formatCombatTotals(v.combat) }))
      .sort((a, b) => b.sessions - a.sessions || b.points - a.points);

    // Stat cards
    const stats = document.getElementById("overview-stats");
    stats.innerHTML = "";
    addStatCard(stats, "Sessions", fmtNum(sessions.length));
    addStatCard(stats, "Unique Players", fmtNum(uniquePlayers.size));
    addStatCard(stats, "Avg Attendees / Session", Number.isFinite(avgAttendeesPerSession) ? avgAttendeesPerSession.toFixed(1) : "—");
    addStatCard(stats, "Overall Attendance %", fmtPct(overallPct));

    // Session table
    const tbody = document.querySelector("#overview-table tbody");
    tbody.innerHTML = "";
    if (sessionRows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty">No sessions in this range.</td></tr>';
    } else {
      for (const s of sessionRows) {
        const combat = formatCombatTotals(s.combat);
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeHTML(fmtDate(s.date)) + "</td>" +
          "<td>" + escapeHTML(s.event) + "</td>" +
          "<td>" + fmtNum(s.attendees.size) + (s.rosterSize ? " / " + fmtNum(s.rosterSize) : "") + "</td>" +
          "<td>" + fmtPct(s.pct) + "</td>" +
          "<td>" + combat.sTablets + "</td>" +
          "<td>" + combat.aTablets + "</td>" +
          "<td>" + combat.bTablets + "</td>" +
          "<td>" + combat.monstersKilled + "</td>" +
          "<td>" + combat.kad + "</td>" +
          "<td>" + fmtNum(s.totalPoints) + "</td>";
        tbody.appendChild(tr);
      }
    }

    // Leaderboard table
    const lbBody = document.querySelector("#overview-leaderboard tbody");
    lbBody.innerHTML = "";
    if (leaderboardRows.length === 0) {
      lbBody.innerHTML = '<tr><td colspan="9" class="empty">No data in this range.</td></tr>';
    } else {
      leaderboardRows.slice(0, 20).forEach((row, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + (idx + 1) + "</td>" +
          "<td>" + escapeHTML(row.name) + "</td>" +
          "<td>" + fmtNum(row.sessions) + "</td>" +
          "<td>" + row.combat.sTablets + "</td>" +
          "<td>" + row.combat.aTablets + "</td>" +
          "<td>" + row.combat.bTablets + "</td>" +
          "<td>" + row.combat.monstersKilled + "</td>" +
          "<td>" + row.combat.kad + "</td>" +
          "<td>" + fmtNum(row.points) + "</td>";
        lbBody.appendChild(tr);
      });
    }
  }

  function addStatCard(container, label, value) {
    const div = document.createElement("div");
    div.className = "stat-card";
    div.innerHTML = '<div class="stat-value">' + value + '</div><div class="stat-label">' + escapeHTML(label) + "</div>";
    container.appendChild(div);
  }

  // ---------- Player tab ----------

  // Single-click searchable name picker. `onChange` runs whenever the
  // input's value changes (typing or picking from the list).
  function attachNameCombo(input, dropdown, combo, names, onChange) {
    function renderDropdown() {
      const q = input.value.trim().toLowerCase();
      const matches = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
      dropdown.innerHTML = matches.length
        ? matches
            .slice(0, 50)
            .map((n) => '<li data-name="' + escapeHTML(n) + '">' + escapeHTML(n) + "</li>")
            .join("")
        : '<li class="empty">No matches</li>';
    }

    function openDropdown() {
      renderDropdown();
      dropdown.classList.add("open");
    }

    function closeDropdown() {
      dropdown.classList.remove("open");
    }

    input.addEventListener("click", openDropdown);
    input.addEventListener("input", () => {
      openDropdown();
      onChange();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdown();
    });

    dropdown.addEventListener("click", (e) => {
      // Stop the click from bubbling to the <label>, which would otherwise
      // forward a synthetic click to the input and reopen the dropdown.
      e.stopPropagation();
      const li = e.target.closest("li[data-name]");
      if (!li) return;
      input.value = li.dataset.name;
      closeDropdown();
      onChange();
    });

    document.addEventListener("click", (e) => {
      if (!combo.contains(e.target)) closeDropdown();
    });

    return { close: closeDropdown };
  }

  function sortedUniqueNames(names) {
    return Array.from(new Set(names.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  function initPlayerTab() {
    const nameInput = document.getElementById("player-name");
    const startInput = document.getElementById("player-start");
    const endInput = document.getElementById("player-end");
    const clearBtn = document.getElementById("player-clear");

    const combo = attachNameCombo(
      nameInput,
      document.getElementById("player-name-dropdown"),
      document.getElementById("player-name-combo"),
      sortedUniqueNames(state.attendance.map((r) => r.ingame_name)),
      renderPlayer
    );

    const dates = state.attendance.map((r) => r.date);
    if (dates.length) {
      startInput.min = endInput.min = dates.reduce((a, b) => (b < a ? b : a));
      startInput.max = endInput.max = dates.reduce((a, b) => (b > a ? b : a));
    }

    startInput.addEventListener("change", renderPlayer);
    endInput.addEventListener("change", renderPlayer);
    clearBtn.addEventListener("click", () => {
      nameInput.value = "";
      startInput.value = "";
      endInput.value = "";
      combo.close();
      renderPlayer();
    });

    renderPlayer();
  }

  function renderPlayer() {
    const name = document.getElementById("player-name").value.trim();
    const start = document.getElementById("player-start").value;
    const end = document.getElementById("player-end").value;

    const stats = document.getElementById("player-stats");
    const tbody = document.querySelector("#player-table tbody");
    stats.innerHTML = "";
    tbody.innerHTML = "";

    if (!name) {
      stats.innerHTML = '<p class="hint">Type or pick a player name to see their stats.</p>';
      tbody.innerHTML = '<tr><td colspan="9" class="empty">No player selected.</td></tr>';
      return;
    }

    const joinedDate = getLatestJoinDate(name);

    const matchLower = name.toLowerCase();
    const rows = state.attendance
      .filter((r) => r.ingame_name.toLowerCase() === matchLower && inRange(r.date, start, end))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    if (rows.length === 0) {
      addStatCard(stats, "Date Joined", joinedDate || "—");
      stats.insertAdjacentHTML(
        "beforeend",
        '<p class="hint">No attendance found for "' + escapeHTML(name) + '" in this range.</p>'
      );
      tbody.innerHTML = '<tr><td colspan="9" class="empty">No records.</td></tr>';
      return;
    }

    const totalPoints = rows.reduce((sum, r) => sum + r.points, 0);
    const avgPoints = totalPoints / rows.length;
    const best = rows.reduce((a, b) => (b.points > a.points ? b : a));
    const firstDate = rows[rows.length - 1].date;
    const lastDate = rows[0].date;

    addStatCard(stats, "Date Joined", joinedDate || "—");
    addStatCard(stats, "Sessions Attended", fmtNum(rows.length));
    addStatCard(stats, "Total Points", fmtNum(totalPoints));
    addStatCard(stats, "Avg Points / Session", avgPoints.toFixed(1));
    addStatCard(stats, "Best Session", fmtNum(best.points) + " (" + best.event + ")");
    addStatCard(stats, "First → Last", firstDate + " → " + lastDate);

    for (const r of rows) {
      const combat = combatStats(r);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHTML(fmtDate(r.date)) + "</td>" +
        "<td>" + escapeHTML(r.event) + "</td>" +
        "<td>" + escapeHTML(r.field) + "</td>" +
        "<td>" + fmtStat(combat.sTablets) + "</td>" +
        "<td>" + fmtStat(combat.aTablets) + "</td>" +
        "<td>" + fmtStat(combat.bTablets) + "</td>" +
        "<td>" + fmtStat(combat.monstersKilled) + "</td>" +
        "<td>" + formatKAD(r) + "</td>" +
        "<td>" + fmtNum(r.points) + "</td>";
      tbody.appendChild(tr);
    }
  }

  // ---------- Members tab ----------

  function initMembersTab() {
    const startInput = document.getElementById("members-start");
    const endInput = document.getElementById("members-end");
    const maxAttendanceInput = document.getElementById("members-max-attendance");
    const joinedStartInput = document.getElementById("members-joined-start");
    const joinedEndInput = document.getElementById("members-joined-end");
    const clearBtn = document.getElementById("members-clear");

    const allDates = state.rosterEventDatesSorted.concat(state.attendance.map((r) => r.date)).sort();
    if (allDates.length) {
      startInput.min = endInput.min = allDates[0];
      startInput.max = endInput.max = allDates[allDates.length - 1];
    }
    if (state.rosterEventDatesSorted.length) {
      joinedStartInput.min = joinedEndInput.min = state.rosterEventDatesSorted[0];
      joinedStartInput.max = joinedEndInput.max =
        state.rosterEventDatesSorted[state.rosterEventDatesSorted.length - 1];
    }

    startInput.addEventListener("change", renderMembers);
    endInput.addEventListener("change", renderMembers);
    maxAttendanceInput.addEventListener("input", renderMembers);
    joinedStartInput.addEventListener("change", renderMembers);
    joinedEndInput.addEventListener("change", renderMembers);
    clearBtn.addEventListener("click", () => {
      startInput.value = "";
      endInput.value = "";
      maxAttendanceInput.value = "";
      joinedStartInput.value = "";
      joinedEndInput.value = "";
      renderMembers();
    });

    renderMembers();
  }

  function renderMembers() {
    const start = document.getElementById("members-start").value;
    const end = document.getElementById("members-end").value;
    const maxAttendanceRaw = document.getElementById("members-max-attendance").value;
    const maxAttendance = maxAttendanceRaw === "" ? null : Math.max(0, Math.floor(Number(maxAttendanceRaw)));
    const joinedStart = document.getElementById("members-joined-start").value;
    const joinedEnd = document.getElementById("members-joined-end").value;
    const joinedFilterActive = !!joinedStart || !!joinedEnd;

    // The date range only activates once both ends are set. Max Attendance
    // is scoped to that range and does nothing without it — it never
    // filters against all-time attendance.
    const rangeActive = !!start && !!end;
    const applyMaxFilter = rangeActive && maxAttendance !== null && !Number.isNaN(maxAttendance);

    const snapshotDate =
      end || (state.rosterEventDatesSorted.length
        ? state.rosterEventDatesSorted[state.rosterEventDatesSorted.length - 1]
        : "");

    const roster = getRosterAsOf(snapshotDate);
    const tbody = document.querySelector("#members-table tbody");
    const countEl = document.getElementById("members-count");
    const sessionsHeader = document.getElementById("members-sessions-header");
    tbody.innerHTML = "";
    sessionsHeader.textContent = rangeActive ? "Sessions Attended (in range)" : "Sessions Attended (all-time)";

    if (!roster) {
      countEl.textContent = "No roster data available.";
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No data.</td></tr>';
      return;
    }

    const rows = Array.from(roster.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const info = roster.get(name);
        const history = state.attendance.filter((r) => r.ingame_name === name);
        const scopedHistory = rangeActive ? history.filter((r) => inRange(r.date, start, end)) : history;
        const sessions = new Set(scopedHistory.map(sessionKey)).size;
        const lastAttended = history.length
          ? history.reduce((a, b) => (b.date > a.date ? b : a)).date
          : "—";
        return { name, class: info.class, joinedDate: info.joinedDate, sessions, lastAttended };
      })
      .filter((r) => !joinedFilterActive || inRange(r.joinedDate, joinedStart, joinedEnd));

    const visibleRows = applyMaxFilter ? rows.filter((r) => r.sessions <= maxAttendance) : rows;

    const summary = [roster.size + " member" + (roster.size === 1 ? "" : "s") + " as of " + (snapshotDate || "—")];
    if (rangeActive) summary.push("attendance counted " + start + " → " + end);
    if (joinedFilterActive) {
      summary.push(
        "joined " + (joinedStart || "…") + " → " + (joinedEnd || "…") + " (" + rows.length + " match)"
      );
    }
    if (applyMaxFilter) {
      summary.push("showing " + visibleRows.length + " with " + fmtNum(maxAttendance) + " or fewer sessions");
    }
    countEl.textContent = summary.join(" — ");

    if (visibleRows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty">' +
        (applyMaxFilter || joinedFilterActive ? "No members match these filters." : "No data.") +
        "</td></tr>";
      return;
    }

    for (const r of visibleRows) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHTML(r.name) + "</td>" +
        "<td>" + escapeHTML(r.class || "—") + "</td>" +
        "<td>" + escapeHTML(fmtDate(r.joinedDate || "—")) + "</td>" +
        "<td>" + fmtNum(r.sessions) + "</td>" +
        "<td>" + escapeHTML(fmtDate(r.lastAttended)) + "</td>";
      tbody.appendChild(tr);
    }
  }

  // ---------- Signup Audit tab ----------

  function initSignupTab() {
    const startInput = document.getElementById("signup-start");
    const endInput = document.getElementById("signup-end");
    const clearBtn = document.getElementById("signup-clear");

    const dates = state.attendance.map((r) => r.date).concat(state.signups.map((r) => r.date));
    if (dates.length) {
      startInput.min = endInput.min = dates.reduce((a, b) => (b < a ? b : a));
      startInput.max = endInput.max = dates.reduce((a, b) => (b > a ? b : a));
    }

    startInput.addEventListener("change", renderSignupAudit);
    endInput.addEventListener("change", renderSignupAudit);
    clearBtn.addEventListener("click", () => {
      startInput.value = "";
      endInput.value = "";
      renderSignupAudit();
    });

    renderSignupAudit();
  }

  // Joins attendance and sign-up rows on date + event + ingame_name (per
  // the guild's own definition of a "session") and buckets them into three
  // kinds of mismatch: signed up but never showed, showed on a different
  // field than signed up for, and showed without ever signing up.
  function buildSignupAudit(attendanceRows, signupRows) {
    const keyOf = (r) => r.date + "|||" + r.event + "|||" + r.ingame_name;

    const attendanceByKey = new Map();
    for (const r of attendanceRows) attendanceByKey.set(keyOf(r), r);

    const signupByKey = new Map();
    for (const r of signupRows) signupByKey.set(keyOf(r), r);

    const noAttendance = [];
    const fieldMismatch = [];
    for (const [key, s] of signupByKey) {
      const a = attendanceByKey.get(key);
      if (!a) {
        noAttendance.push(s);
      } else if (a.field !== s.field) {
        fieldMismatch.push({
          date: s.date,
          event: s.event,
          ingame_name: s.ingame_name,
          signupField: s.field,
          attendedField: a.field,
        });
      }
    }

    const noSignup = [];
    for (const [key, a] of attendanceByKey) {
      if (!signupByKey.has(key)) noSignup.push(a);
    }

    const byDateEventName = (a, b) =>
      b.date.localeCompare(a.date) || a.event.localeCompare(b.event) || a.ingame_name.localeCompare(b.ingame_name);
    noAttendance.sort(byDateEventName);
    fieldMismatch.sort(byDateEventName);
    noSignup.sort(byDateEventName);

    return { noAttendance, fieldMismatch, noSignup };
  }

  function renderSignupAudit() {
    const start = document.getElementById("signup-start").value;
    const end = document.getElementById("signup-end").value;

    const attendance = state.attendance.filter((r) => inRange(r.date, start, end));
    const signups = state.signups.filter((r) => inRange(r.date, start, end));

    const { noAttendance, fieldMismatch, noSignup } = buildSignupAudit(attendance, signups);

    const stats = document.getElementById("signup-stats");
    stats.innerHTML = "";
    addStatCard(stats, "Signed Up, No Attendance", fmtNum(noAttendance.length));
    addStatCard(stats, "Field Mismatches", fmtNum(fieldMismatch.length));
    addStatCard(stats, "Attended, No Sign-up", fmtNum(noSignup.length));

    fillSignupTable("#signup-no-attendance-table tbody", noAttendance, (r) => [
      fmtDate(r.date),
      r.event,
      r.ingame_name,
      r.field,
    ]);
    fillSignupTable("#signup-field-mismatch-table tbody", fieldMismatch, (r) => [
      fmtDate(r.date),
      r.event,
      r.ingame_name,
      r.signupField,
      r.attendedField,
    ]);
    fillSignupTable("#signup-no-signup-table tbody", noSignup, (r) => [
      fmtDate(r.date),
      r.event,
      r.ingame_name,
      r.field,
    ]);
  }

  function fillSignupTable(bodySelector, rows, toCells) {
    const tbody = document.querySelector(bodySelector);
    const colCount = tbody.closest("table").querySelectorAll("thead th").length;
    tbody.innerHTML = "";
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="empty">None in this range.</td></tr>';
      return;
    }
    for (const row of rows) {
      const tr = document.createElement("tr");
      // A cell is plain text (escaped) unless given as { html } for markup
      // the caller has already built safely.
      tr.innerHTML = toCells(row)
        .map((c) => "<td>" + (c && typeof c === "object" ? c.html : escapeHTML(c)) + "</td>")
        .join("");
      tbody.appendChild(tr);
    }
  }

  // ---------- Absence Report tab ----------

  function sheetByNameUrl(sheetName) {
    return (
      "https://docs.google.com/spreadsheets/d/" + SPREADSHEET_ID +
      "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(sheetName)
    );
  }

  // Loads the first of `sheetNames` that exists and has every column in
  // `requiredCols`. Checking columns matters because the by-name endpoint
  // can fall back to a different tab when a name doesn't match.
  async function loadNamedSheet(sheetNames, requiredCols) {
    let lastErr = null;
    for (const name of sheetNames) {
      try {
        const rows = await loadCSV(sheetByNameUrl(name));
        const missing = rows.length ? requiredCols.filter((c) => !(c in rows[0])) : [];
        if (missing.length) throw new Error('"' + name + '" is missing column(s): ' + missing.join(", "));
        return rows;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // Accepts YYYY-MM-DD or M/D/YYYY (how Sheets may render a date cell);
  // returns ISO YYYY-MM-DD, or "" if unparseable.
  function toISODate(v) {
    const s = String(v || "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
    return "";
  }

  function isoFromLocal(d) {
    return (
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
    );
  }

  // Weeks run Monday through Sunday.
  function weekBounds(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const sinceMonday = (date.getDay() + 6) % 7;
    const monday = new Date(y, m - 1, d - sinceMonday);
    const sunday = new Date(y, m - 1, d - sinceMonday + 6);
    return { monday: isoFromLocal(monday), sunday: isoFromLocal(sunday) };
  }

  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function withWeekday(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return WEEKDAYS[new Date(y, m - 1, d).getDay()] + " - " + fmtDate(iso);
  }

  function initAbsenceTab() {
    const dateInput = document.getElementById("absence-date");
    dateInput.value = isoFromLocal(new Date());
    dateInput.addEventListener("change", renderAbsence);
    renderAbsence();
  }

  function renderAbsence() {
    const dateInput = document.getElementById("absence-date");
    if (!dateInput.value) dateInput.value = isoFromLocal(new Date());
    const { monday, sunday } = weekBounds(dateInput.value);

    document.getElementById("absence-summary").textContent =
      "Showing members absent on week starting on Monday " + monday + " and ending on Sunday " + sunday + ".";

    const tbody = document.querySelector("#absence-table tbody");
    if (state.absencesError) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty">' + escapeHTML(state.absencesError) + "</td></tr>";
      return;
    }

    // Any overlap with the week: began by Sunday and ends on/after Monday.
    const rows = state.absences
      .filter((a) => a.dateBegin && a.dateEnd && a.dateBegin <= sunday && a.dateEnd >= monday)
      .sort((a, b) => a.ingame_name.localeCompare(b.ingame_name));

    fillSignupTable("#absence-table tbody", rows, (a) => [
      a.ingame_name,
      a.class || "—",
      withWeekday(a.dateBegin),
      withWeekday(a.dateEnd),
      a.comments || "—",
    ]);
  }

  // ---------- Auction Audit Tracker tab ----------

  // Lenient so "Screenshots pending", "screenshots_pending" and " OK " all match.
  function normStatus(s) {
    return String(s || "").trim().toLowerCase().replace(/_/g, " ");
  }

  function copyIdCell(id) {
    // 17+ digit IDs only survive in the sheet as plain text; a number cell
    // rounds them (e.g. 1.23E+17 or trailing zeros), so don't offer those.
    if (!/^\d{15,25}$/.test(id)) {
      return { html: '<button class="btn-secondary copy-btn" disabled>No Discord ID</button>' };
    }
    return { html: '<button class="btn-secondary copy-btn" data-copy="' + escapeHTML(id) + '">Copy Discord ID</button>' };
  }

  // Copies `text`; when `html` is given and the browser supports it, also
  // offers an HTML version (preferred by Google Sheets when pasting).
  async function copyText(text, html) {
    try {
      if (html && window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      return true;
    } catch {
      // Fallback for browsers/contexts without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  // Rows behind each audit table as last rendered, keyed by table id. A cell
  // is a plain value, or { text } to force Sheets to keep it as text.
  const auditCopyRows = {};

  // Tab-separated text plus an HTML table, so a paste into Google Sheets
  // fills one cell per value. In the HTML, { text } cells carry Sheets' own
  // "this is a string" marker so long Discord IDs aren't rounded.
  function tableClipboard(headers, rows) {
    const plain = (c) => String(c && typeof c === "object" ? c.text : c).replace(/[\t\r\n]+/g, " ");
    const tsv = [headers].concat(rows).map((r) => r.map(plain).join("\t")).join("\n");
    const td = (c) => {
      if (c && typeof c === "object") {
        const marker = escapeHTML(JSON.stringify({ 1: 2, 2: c.text }));
        return '<td data-sheets-value="' + marker + '">' + escapeHTML(c.text) + "</td>";
      }
      return "<td>" + escapeHTML(c) + "</td>";
    };
    const html =
      "<table><thead><tr>" +
      headers.map((h) => "<th>" + escapeHTML(h) + "</th>").join("") +
      "</tr></thead><tbody>" +
      rows.map((r) => "<tr>" + r.map(td).join("") + "</tr>").join("") +
      "</tbody></table>";
    return { tsv, html };
  }

  function flashButton(btn, message, label) {
    btn.textContent = message;
    clearTimeout(btn._reset);
    btn._reset = setTimeout(() => (btn.textContent = label), 1500);
  }

  function isAcceptedStatus(status) {
    const st = normStatus(status);
    return st.startsWith("ok") || st.startsWith("accepted");
  }

  function initAuditTab() {
    document.getElementById("tab-audit").addEventListener("click", async (e) => {
      const idBtn = e.target.closest(".copy-btn[data-copy]");
      if (idBtn) {
        const ok = await copyText(idBtn.dataset.copy);
        flashButton(idBtn, ok ? "Copied!" : "Copy failed", "Copy Discord ID");
        return;
      }
      const tableBtn = e.target.closest(".copy-table-btn");
      if (tableBtn) {
        const id = tableBtn.dataset.table;
        const headers = Array.from(document.querySelectorAll("#" + id + " thead th")).map((th) => th.textContent.trim());
        const { tsv, html } = tableClipboard(headers, auditCopyRows[id] || []);
        const ok = await copyText(tsv, html);
        flashButton(tableBtn, ok ? "Copied!" : "Copy failed", "Copy table data");
      }
    });

    const dateInput = document.getElementById("audit-date");
    const nameInput = document.getElementById("audit-name");
    const clearBtn = document.getElementById("audit-clear");

    const combo = attachNameCombo(
      nameInput,
      document.getElementById("audit-name-dropdown"),
      document.getElementById("audit-name-combo"),
      sortedUniqueNames(state.auctionAudits.concat(state.pendingAudits).map((r) => r.ingame_name)),
      renderAudits
    );

    dateInput.addEventListener("change", renderAudits);
    clearBtn.addEventListener("click", () => {
      dateInput.value = "";
      nameInput.value = "";
      combo.close();
      renderAudits();
    });

    renderAudits();
  }

  function renderAudits() {
    const date = document.getElementById("audit-date").value;
    const query = document.getElementById("audit-name").value.trim().toLowerCase();

    const tables = ["#audit-pending-table tbody", "#audit-resend-table tbody", "#audit-accepted-table tbody"];
    const stats = document.getElementById("audit-stats");
    stats.innerHTML = "";
    if (state.auditsError) {
      for (const k in auditCopyRows) delete auditCopyRows[k];
      document.getElementById("audit-summary").textContent = state.auditsError;
      tables.forEach((sel) => fillSignupTable(sel, [], () => []));
      return;
    }

    // A name picked from the list (or typed in full) matches only that
    // player; a partial name matches anyone containing it.
    const allNames = state.auctionAudits.concat(state.pendingAudits).map((r) => r.ingame_name.toLowerCase());
    const exact = allNames.includes(query);
    const matches = (r) =>
      (!date || r.date === date) &&
      (!query || (exact ? r.ingame_name.toLowerCase() === query : r.ingame_name.toLowerCase().includes(query)));
    const byDateThenName = (a, b) => b.date.localeCompare(a.date) || a.ingame_name.localeCompare(b.ingame_name);

    const pending = state.pendingAudits.filter(matches).sort(byDateThenName);
    const awaitingScreens = pending.filter((r) => normStatus(r.status) === "screenshots pending");
    const resend = pending.filter((r) => {
      const st = normStatus(r.status);
      return st && st !== "screenshots pending" && !isAcceptedStatus(st);
    });
    const accepted = state.auctionAudits
      .filter((r) => isAcceptedStatus(r.status))
      .filter(matches)
      .sort(byDateThenName);

    const parts = [];
    if (date) parts.push("event date " + date);
    if (query) parts.push('player "' + document.getElementById("audit-name").value.trim() + '"');
    document.getElementById("audit-summary").textContent = parts.length
      ? "Filtered by " + parts.join(" and ") + "."
      : "Showing all dates and players.";

    addStatCard(stats, "Total Members", fmtNum(awaitingScreens.length + resend.length + accepted.length));
    addStatCard(stats, "Screenshots Received", fmtNum(resend.length + accepted.length));
    addStatCard(stats, "Screenshots Refused", fmtNum(resend.length));
    addStatCard(stats, "Screenshots Pending", fmtNum(awaitingScreens.length));

    // Same ID check as the copy buttons: a rounded or blank ID is left empty
    // rather than pasted as a wrong number.
    const idForCopy = (id) => ({ text: /^\d{15,25}$/.test(id) ? id : "" });
    auditCopyRows["audit-pending-table"] = awaitingScreens.map((r) => [r.date, r.ingame_name, r.status, idForCopy(r.discord_id)]);
    auditCopyRows["audit-resend-table"] = resend.map((r) => [r.date, r.ingame_name, r.status, idForCopy(r.discord_id)]);
    auditCopyRows["audit-accepted-table"] = accepted.map((r) => [r.date, r.event, r.ingame_name, r.status]);

    fillSignupTable(tables[0], awaitingScreens, (r) => [fmtDate(r.date || "—"), r.ingame_name, r.status, copyIdCell(r.discord_id)]);
    fillSignupTable(tables[1], resend, (r) => [fmtDate(r.date || "—"), r.ingame_name, r.status, copyIdCell(r.discord_id)]);
    fillSignupTable(tables[2], accepted, (r) => [fmtDate(r.date || "—"), r.event || "—", r.ingame_name, r.status]);
  }

  // ---------- The Snitch tab ----------

  function initSnitchTab() {
    const startInput = document.getElementById("snitch-start");
    const endInput = document.getElementById("snitch-end");
    const joinedCutoffInput = document.getElementById("snitch-joined-cutoff");
    const clearBtn = document.getElementById("snitch-clear");

    const allDates = state.rosterEventDatesSorted.concat(state.attendance.map((r) => r.date)).sort();
    if (allDates.length) {
      startInput.min = endInput.min = allDates[0];
      startInput.max = endInput.max = allDates[allDates.length - 1];
    }
    if (state.rosterEventDatesSorted.length) {
      joinedCutoffInput.min = state.rosterEventDatesSorted[0];
      joinedCutoffInput.max = state.rosterEventDatesSorted[state.rosterEventDatesSorted.length - 1];
    }

    startInput.addEventListener("change", renderSnitch);
    endInput.addEventListener("change", renderSnitch);
    joinedCutoffInput.addEventListener("change", renderSnitch);
    clearBtn.addEventListener("click", () => {
      startInput.value = "";
      endInput.value = "";
      joinedCutoffInput.value = "";
      renderSnitch();
    });

    renderSnitch();
  }

  // Base member list for The Snitch's tables: roster snapshotted as of the
  // event range's end date (or the current roster if no range is set,
  // matching Member List's convention), limited to members who joined on
  // or before the cutoff when one is set.
  function getSnitchMembers(end, joinedCutoff) {
    const snapshotDate =
      end || (state.rosterEventDatesSorted.length
        ? state.rosterEventDatesSorted[state.rosterEventDatesSorted.length - 1]
        : "");
    const roster = getRosterAsOf(snapshotDate);
    if (!roster) return null;
    return Array.from(roster.entries())
      .filter(([, info]) => !joinedCutoff || info.joinedDate <= joinedCutoff)
      .map(([name, info]) => ({ name, class: info.class, joinedDate: info.joinedDate }));
  }

  // Distinct sessions (date + event) a player attended among eventNames,
  // within the date range.
  function countAttendedSessions(name, eventNames, start, end) {
    const keys = new Set();
    for (const r of state.attendance) {
      if (r.ingame_name === name && eventNames.includes(r.event) && inRange(r.date, start, end)) {
        keys.add(sessionKey(r));
      }
    }
    return keys.size;
  }

  // Distinct sessions (date + event) a player signed up for among
  // eventNames on the given field, within the date range.
  function countSignupSessions(name, eventNames, field, start, end) {
    const keys = new Set();
    for (const r of state.signups) {
      if (
        r.ingame_name === name &&
        eventNames.includes(r.event) &&
        r.field === field &&
        inRange(r.date, start, end)
      ) {
        keys.add(sessionKey(r));
      }
    }
    return keys.size;
  }

  function bottomN(rows, n, valueFn) {
    return rows
      .slice()
      .sort((a, b) => valueFn(a) - valueFn(b) || a.name.localeCompare(b.name))
      .slice(0, n);
  }

  function topN(rows, n, valueFn) {
    return rows
      .slice()
      .sort((a, b) => valueFn(b) - valueFn(a) || a.name.localeCompare(b.name))
      .slice(0, n);
  }

  function countByName(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(r.ingame_name, (counts.get(r.ingame_name) || 0) + 1);
    return counts;
  }

  function renderSnitch() {
    const start = document.getElementById("snitch-start").value;
    const end = document.getElementById("snitch-end").value;
    const joinedCutoff = document.getElementById("snitch-joined-cutoff").value;

    const members = getSnitchMembers(end, joinedCutoff);
    const summaryEl = document.getElementById("snitch-summary");

    if (!members) {
      summaryEl.textContent = "No roster data available.";
      [
        "#snitch-guild-league-table tbody",
        "#snitch-emperium-table tbody",
        "#snitch-signup-table tbody",
        "#snitch-repeat-offenders-table tbody",
        "#snitch-mismatch-table tbody",
      ].forEach((sel) => fillSignupTable(sel, [], () => []));
      return;
    }

    const summary = [members.length + " eligible member" + (members.length === 1 ? "" : "s")];
    if (start && end) summary.push("events counted " + start + " → " + end);
    if (joinedCutoff) summary.push("joined on/before " + joinedCutoff);
    summaryEl.textContent = summary.join(" — ");

    const guildLeagueRows = members.map((m) => ({
      ...m,
      attendances: countAttendedSessions(m.name, GUILD_LEAGUE_EVENTS, start, end),
    }));
    const guildLeagueBottom = bottomN(guildLeagueRows, 10, (r) => r.attendances);
    fillSignupTable("#snitch-guild-league-table tbody", guildLeagueBottom, (r) => [
      r.name,
      r.class || "—",
      fmtDate(r.joinedDate || "—"),
      fmtNum(r.attendances),
    ]);

    const emperiumRows = members.map((m) => ({
      ...m,
      attendances: countAttendedSessions(m.name, [EMPERIUM_OVERRUN_EVENT], start, end),
    }));
    const emperiumBottom = bottomN(emperiumRows, 10, (r) => r.attendances);
    fillSignupTable("#snitch-emperium-table tbody", emperiumBottom, (r) => [
      r.name,
      r.class || "—",
      fmtDate(r.joinedDate || "—"),
      fmtNum(r.attendances),
    ]);

    const signupRows = members.map((m) => ({
      ...m,
      mainSignups: countSignupSessions(m.name, GUILD_LEAGUE_EVENTS, "Main Field", start, end),
      subSignups: countSignupSessions(m.name, GUILD_LEAGUE_EVENTS, "Sub Field", start, end),
    }));
    const signupBottom = bottomN(signupRows, 10, (r) => r.mainSignups);
    fillSignupTable("#snitch-signup-table tbody", signupBottom, (r) => [
      r.name,
      r.class || "—",
      fmtDate(r.joinedDate || "—"),
      fmtNum(r.mainSignups),
      fmtNum(r.subSignups),
    ]);

    // Players who show up in all three bottom-10 lists above.
    const emperiumByName = new Map(emperiumBottom.map((r) => [r.name, r]));
    const signupByName = new Map(signupBottom.map((r) => [r.name, r]));
    const repeatOffenders = guildLeagueBottom
      .filter((r) => emperiumByName.has(r.name) && signupByName.has(r.name))
      .map((r) => ({
        ...r,
        empAttendances: emperiumByName.get(r.name).attendances,
        mainSignups: signupByName.get(r.name).mainSignups,
        subSignups: signupByName.get(r.name).subSignups,
      }));
    fillSignupTable("#snitch-repeat-offenders-table tbody", repeatOffenders, (r) => [
      r.name,
      r.class || "—",
      fmtDate(r.joinedDate || "—"),
      fmtNum(r.attendances),
      fmtNum(r.empAttendances),
      fmtNum(r.mainSignups),
      fmtNum(r.subSignups),
    ]);

    // Sign-up mismatches, across all events (not just Guild League): signed
    // up but never attended, plus "Late to the Event" — signed up for Main
    // Field but attended Sub Field. Reuses the same join logic as Signup
    // Audit, scoped to this tab's own date range.
    const rangedAttendance = state.attendance.filter((r) => inRange(r.date, start, end));
    const rangedSignups = state.signups.filter((r) => inRange(r.date, start, end));
    const { noAttendance, fieldMismatch } = buildSignupAudit(rangedAttendance, rangedSignups);
    const noAttendanceCounts = countByName(noAttendance);
    const lateToEventCounts = countByName(
      fieldMismatch.filter((r) => r.signupField === "Main Field" && r.attendedField === "Sub Field")
    );
    const mismatchRows = members.map((m) => {
      const didntAttend = noAttendanceCounts.get(m.name) || 0;
      const lateToEvent = lateToEventCounts.get(m.name) || 0;
      return { ...m, didntAttend, lateToEvent, totalMismatches: didntAttend + lateToEvent };
    });
    fillSignupTable("#snitch-mismatch-table tbody", topN(mismatchRows, 10, (r) => r.totalMismatches), (r) => [
      r.name,
      r.class || "—",
      fmtDate(r.joinedDate || "—"),
      fmtNum(r.didntAttend),
      fmtNum(r.lateToEvent),
    ]);
  }

  // ---------- Utilities ----------

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function showError(message) {
    const main = document.querySelector("main");
    main.innerHTML = '<div class="error-box">' + escapeHTML(message) + "</div>";
  }

  // ---------- Init ----------

  async function init() {
    try {
      const [attendanceRaw, rosterRaw, signupRaw] = await Promise.all([
        loadCSV(sheetCSVUrl(ATTENDANCE_GID)),
        loadCSV(sheetCSVUrl(ROSTER_GID)),
        loadCSV(sheetCSVUrl(SIGNUP_GID)),
      ]);

      state.attendance = attendanceRaw.map((r) => ({
        date: r.date,
        event: r.event,
        field: r.field,
        ingame_name: r.ingame_name,
        points: Number(r.points) || 0,
        sOrTablet: parseOptionalNum(r.S_or_Tablet_captures),
        aOrMonster: parseOptionalNum(r.A_captures_Monster_kills),
        bCaptures: parseOptionalNum(r.B_captures),
        kills: parseOptionalNum(r.kills),
        assists: parseOptionalNum(r.assists),
        deaths: parseOptionalNum(r.deaths),
      }));

      state.rosterEvents = rosterRaw
        .map((r) => ({ date: r.date, name: r.name, class: r.class, log: r.log }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      state.rosterEventDatesSorted = Array.from(new Set(state.rosterEvents.map((r) => r.date))).sort();

      state.signups = signupRaw.map((r) => ({
        date: r.date,
        event: r.event,
        field: r.field,
        ingame_name: r.ingame_name,
      }));

      initTabs();
      initOverviewTab();
      initPlayerTab();
      initMembersTab();
      initSignupTab();
      initSnitchTab();

      // Loaded separately so a problem with this sheet can't break the
      // other tabs.
      try {
        const absenceRaw = await loadNamedSheet([ABSENCE_SHEET_NAME], ["date_begin", "date_end", "ingame_name"]);
        state.absences = absenceRaw.map((r) => ({
          dateBegin: toISODate(r.date_begin),
          dateEnd: toISODate(r.date_end),
          ingame_name: r.ingame_name || "",
          class: r.class || "",
          comments: r.comments || "",
        }));
      } catch (err) {
        console.error(err);
        state.absencesError = "Couldn't load the absence_reports sheet (" + err.message + ").";
      }
      initAbsenceTab();

      try {
        const toAudit = (r) => ({
          date: toISODate(r.event_date),
          event: r.event || "",
          ingame_name: r.ingame_name || "",
          status: (r.status || "").trim(),
          discord_id: (r.discord_id || "").trim(),
        });
        const cols = ["event_date", "event", "ingame_name", "status"];
        const [auctionRaw, pendingRaw] = await Promise.all([
          loadNamedSheet([AUCTION_AUDITS_SHEET_NAME], cols),
          loadNamedSheet([PENDING_AUDITS_SHEET_NAME], cols),
        ]);
        state.auctionAudits = auctionRaw.map(toAudit).filter((r) => r.ingame_name);
        state.pendingAudits = pendingRaw.map(toAudit).filter((r) => r.ingame_name);
      } catch (err) {
        console.error(err);
        state.auditsError = "Couldn't load the auction audit sheets (" + err.message + ").";
      }
      initAuditTab();
    } catch (err) {
      console.error(err);
      showError(
        "Couldn't load guild data from the Google Sheet. Make sure it's shared as \"Anyone with the link\" → Viewer, and that the sheet/tab structure hasn't changed. Details: " +
          err.message
      );
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
