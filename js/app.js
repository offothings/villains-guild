(function () {
  "use strict";

  const state = {
    attendance: [], // { date, event, field, ingame_name, points }
    rosterEvents: [], // { date, name, class, log } sorted ascending by date, joined/left log
    rosterEventDatesSorted: [], // unique ascending dates
    signups: [], // { date, event, field, ingame_name }
  };

  // Guild data lives in a Google Sheet (one spreadsheet, one tab per file).
  // Each tab is fetched as CSV via Sheets' export endpoint. The sheet must
  // be shared as "Anyone with the link" → Viewer for this to work.
  const SPREADSHEET_ID = "1VkAB0RWFQBzVkEJUyBoHu_mPxW5Mnqz373GcDpKlMw0";
  const ATTENDANCE_GID = "0";
  const ROSTER_GID = "108271403";
  const SIGNUP_GID = "311091534";

  function sheetCSVUrl(gid) {
    return "https://docs.google.com/spreadsheets/d/" + SPREADSHEET_ID + "/export?format=csv&gid=" + gid;
  }

  const fmtPct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "—");
  const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString() : "—");

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

  // Sessions are identified by date + event only — the "field" column does
  // not distinguish a separate event/session.
  function sessionKey(row) {
    return row.date + "|||" + row.event;
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
        });
      }
      const s = sessions.get(key);
      s.attendees.add(row.ingame_name);
      s.totalPoints += row.points;
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
    const leaderboard = new Map(); // name -> { sessions: Set(key), points }
    for (const row of filtered) {
      const key = sessionKey(row);
      if (!leaderboard.has(row.ingame_name)) {
        leaderboard.set(row.ingame_name, { sessions: new Set(), points: 0 });
      }
      const l = leaderboard.get(row.ingame_name);
      l.sessions.add(key);
      l.points += row.points;
    }
    const leaderboardRows = Array.from(leaderboard.entries())
      .map(([name, v]) => ({ name, sessions: v.sessions.size, points: v.points }))
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
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No sessions in this range.</td></tr>';
    } else {
      for (const s of sessionRows) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeHTML(s.date) + "</td>" +
          "<td>" + escapeHTML(s.event) + "</td>" +
          "<td>" + fmtNum(s.attendees.size) + (s.rosterSize ? " / " + fmtNum(s.rosterSize) : "") + "</td>" +
          "<td>" + fmtPct(s.pct) + "</td>" +
          "<td>" + fmtNum(s.totalPoints) + "</td>";
        tbody.appendChild(tr);
      }
    }

    // Leaderboard table
    const lbBody = document.querySelector("#overview-leaderboard tbody");
    lbBody.innerHTML = "";
    if (leaderboardRows.length === 0) {
      lbBody.innerHTML = '<tr><td colspan="3" class="empty">No data in this range.</td></tr>';
    } else {
      leaderboardRows.slice(0, 20).forEach((row, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + (idx + 1) + "</td>" +
          "<td>" + escapeHTML(row.name) + "</td>" +
          "<td>" + fmtNum(row.sessions) + "</td>" +
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

  function initPlayerTab() {
    const nameInput = document.getElementById("player-name");
    const dropdown = document.getElementById("player-name-dropdown");
    const startInput = document.getElementById("player-start");
    const endInput = document.getElementById("player-end");
    const clearBtn = document.getElementById("player-clear");

    const names = Array.from(new Set(state.attendance.map((r) => r.ingame_name))).sort((a, b) =>
      a.localeCompare(b)
    );

    function renderDropdown() {
      const q = nameInput.value.trim().toLowerCase();
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

    nameInput.addEventListener("click", openDropdown);
    nameInput.addEventListener("input", () => {
      openDropdown();
      renderPlayer();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdown();
    });

    dropdown.addEventListener("click", (e) => {
      // Stop the click from bubbling to the <label>, which would otherwise
      // forward a synthetic click to the input and reopen the dropdown.
      e.stopPropagation();
      const li = e.target.closest("li[data-name]");
      if (!li) return;
      nameInput.value = li.dataset.name;
      closeDropdown();
      renderPlayer();
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#player-name-combo")) closeDropdown();
    });

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
      closeDropdown();
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
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No player selected.</td></tr>';
      return;
    }

    const matchLower = name.toLowerCase();
    const rows = state.attendance
      .filter((r) => r.ingame_name.toLowerCase() === matchLower && inRange(r.date, start, end))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    if (rows.length === 0) {
      stats.innerHTML = '<p class="hint">No attendance found for "' + escapeHTML(name) + '" in this range.</p>';
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No records.</td></tr>';
      return;
    }

    const totalPoints = rows.reduce((sum, r) => sum + r.points, 0);
    const avgPoints = totalPoints / rows.length;
    const best = rows.reduce((a, b) => (b.points > a.points ? b : a));
    const firstDate = rows[rows.length - 1].date;
    const lastDate = rows[0].date;

    addStatCard(stats, "Sessions Attended", fmtNum(rows.length));
    addStatCard(stats, "Total Points", fmtNum(totalPoints));
    addStatCard(stats, "Avg Points / Session", avgPoints.toFixed(1));
    addStatCard(stats, "Best Session", fmtNum(best.points) + " (" + best.event + ")");
    addStatCard(stats, "First → Last", firstDate + " → " + lastDate);

    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHTML(r.date) + "</td>" +
        "<td>" + escapeHTML(r.event) + "</td>" +
        "<td>" + escapeHTML(r.field) + "</td>" +
        "<td>" + fmtNum(r.points) + "</td>";
      tbody.appendChild(tr);
    }
  }

  // ---------- Members tab ----------

  function initMembersTab() {
    const startInput = document.getElementById("members-start");
    const endInput = document.getElementById("members-end");
    const maxAttendanceInput = document.getElementById("members-max-attendance");
    const clearBtn = document.getElementById("members-clear");

    const allDates = state.rosterEventDatesSorted.concat(state.attendance.map((r) => r.date)).sort();
    if (allDates.length) {
      startInput.min = endInput.min = allDates[0];
      startInput.max = endInput.max = allDates[allDates.length - 1];
    }

    startInput.addEventListener("change", renderMembers);
    endInput.addEventListener("change", renderMembers);
    maxAttendanceInput.addEventListener("input", renderMembers);
    clearBtn.addEventListener("click", () => {
      startInput.value = "";
      endInput.value = "";
      maxAttendanceInput.value = "";
      renderMembers();
    });

    renderMembers();
  }

  function renderMembers() {
    const start = document.getElementById("members-start").value;
    const end = document.getElementById("members-end").value;
    const maxAttendanceRaw = document.getElementById("members-max-attendance").value;
    const maxAttendance = maxAttendanceRaw === "" ? null : Math.max(0, Math.floor(Number(maxAttendanceRaw)));

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
      });

    const visibleRows = applyMaxFilter ? rows.filter((r) => r.sessions <= maxAttendance) : rows;

    const summary = [roster.size + " member" + (roster.size === 1 ? "" : "s") + " as of " + (snapshotDate || "—")];
    if (rangeActive) summary.push("attendance counted " + start + " → " + end);
    if (applyMaxFilter) {
      summary.push("showing " + visibleRows.length + " with " + fmtNum(maxAttendance) + " or fewer sessions");
    }
    countEl.textContent = summary.join(" — ");

    if (visibleRows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty">' +
        (applyMaxFilter ? "No members at or below that attendance." : "No data.") +
        "</td></tr>";
      return;
    }

    for (const r of visibleRows) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHTML(r.name) + "</td>" +
        "<td>" + escapeHTML(r.class || "—") + "</td>" +
        "<td>" + escapeHTML(r.joinedDate || "—") + "</td>" +
        "<td>" + fmtNum(r.sessions) + "</td>" +
        "<td>" + escapeHTML(r.lastAttended) + "</td>";
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
      r.date,
      r.event,
      r.ingame_name,
      r.field,
    ]);
    fillSignupTable("#signup-field-mismatch-table tbody", fieldMismatch, (r) => [
      r.date,
      r.event,
      r.ingame_name,
      r.signupField,
      r.attendedField,
    ]);
    fillSignupTable("#signup-no-signup-table tbody", noSignup, (r) => [
      r.date,
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
      tr.innerHTML = toCells(row)
        .map((c) => "<td>" + escapeHTML(c) + "</td>")
        .join("");
      tbody.appendChild(tr);
    }
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
