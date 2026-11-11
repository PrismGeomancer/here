/* Streak logic. No DOM and no clock in here: every function that cares about
   the date is handed `today`, so all of it can be tested with any day. Days are
   "YYYY-MM-DD" strings for the visitor's local calendar, which also means they
   sort correctly as plain strings. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HereStreak = factory();
})(this, function () {
  "use strict";

  var KEY = "here.v1";
  var MAX_DAYS = 3650;
  var MILESTONES = [7, 30, 100];

  function pad(n, length) { return String(n).padStart(length || 2, "0"); }

  function dayKey(date) {
    return pad(date.getFullYear(), 4) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function isValidDay(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parts = value.split("-").map(Number);
    var utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return utc.getUTCMonth() === parts[1] - 1 && utc.getUTCDate() === parts[2];
  }

  /* Calendar arithmetic in UTC, where no day is ever 23 or 25 hours long.
     A local Date would have to dodge DST, including zones that skip midnight. */
  function prevDay(day) {
    var parts = day.split("-").map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] - 1)).toISOString().slice(0, 10);
  }

  function empty() { return { days: [], longest: 0, version: 1 }; }

  function normalize(days) {
    var unique = Array.from(new Set(days)).sort();
    return unique.slice(Math.max(0, unique.length - MAX_DAYS));
  }

  function streakAt(days, day) {
    var seen = new Set(days), count = 0;
    while (seen.has(day)) { count++; day = prevDay(day); }
    return count;
  }

  function longestRun(days) {
    var best = 0, run = 0, previous = null;
    days.forEach(function (day) {
      run = previous !== null && prevDay(day) === previous ? run + 1 : 1;
      if (run > best) best = run;
      previous = day;
    });
    return best;
  }

  function press(state, today) {
    if (state.days.indexOf(today) !== -1) {
      return { state: state, wrote: false, streak: streakAt(state.days, today) };
    }
    var days = normalize(state.days.concat(today));
    return {
      state: { days: days, longest: Math.max(state.longest, longestRun(days)), version: 1 },
      wrote: true,
      streak: streakAt(days, today)
    };
  }

  function summary(state, today) {
    /* Entries after today only exist if the clock moved back or the visitor
       crossed the date line. They stay stored and count again once it's that day. */
    var past = state.days.filter(function (day) { return day <= today; });
    var last = past.length ? past[past.length - 1] : null;
    var live = last !== null && (last === today || last === prevDay(today));
    return {
      current: live ? streakAt(past, last) : 0,
      longest: Math.max(state.longest, longestRun(state.days)),
      total: state.days.length,
      last: last
    };
  }

  function gradeFor(streak) {
    if (streak >= 30) return "A+";
    if (streak >= 7) return "A";
    if (streak >= 3) return "B";
    if (streak >= 1) return "C";
    return "?";
  }

  function nextMilestone(streak) {
    var next = MILESTONES.filter(function (m) { return m > streak; })[0];
    return next === undefined ? null : next;
  }

  function meterPercent(streak) {
    var next = nextMilestone(streak);
    return next === null ? 100 : Math.round((streak / next) * 100);
  }

  /* Returns the imported days, not a new record: nothing the file claims about
     itself (longest, version) is trusted. merge() recomputes all of that. */
  function parseImport(text, today) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false }; }
    if (!data || typeof data !== "object" || !Array.isArray(data.days)) return { ok: false };
    if (!data.days.length || data.days.length > MAX_DAYS) return { ok: false };
    var fine = data.days.every(function (day) { return isValidDay(day) && day <= today; });
    return fine ? { ok: true, days: normalize(data.days) } : { ok: false };
  }

  function merge(state, importedDays) {
    var days = normalize(state.days.concat(importedDays));
    var merged = { days: days, longest: Math.max(state.longest, longestRun(days)), version: 1 };
    if (state.slot) merged.slot = state.slot;
    return merged;
  }

  function clean(raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return empty(); }
    if (!data || !Array.isArray(data.days)) return empty();
    var state = {
      days: normalize(data.days.filter(isValidDay)),
      longest: Number.isSafeInteger(data.longest) && data.longest > 0 ? data.longest : 0,
      version: 1
    };
    var slot = data.slot;
    if (slot && isValidDay(slot.day) && Number.isSafeInteger(slot.value) && slot.value >= 0) {
      state.slot = { day: slot.day, value: slot.value };
    }
    return state;
  }

  /* Pass whatever window.localStorage gave you, or null. Anything that throws
     flips the store to memory for the rest of the session. Once a write has
     failed, memory wins even if reads still work, or the page would go on
     showing the stale record. */
  function createStore(storage) {
    var memory = null, blocked = false;
    return {
      read: function () {
        if (blocked && memory) return memory;
        try {
          var raw = storage.getItem(KEY);
          return raw === null ? empty() : clean(raw);
        } catch (e) {
          blocked = true;
          return memory || empty();
        }
      },
      write: function (state) {
        memory = state;
        try { storage.setItem(KEY, JSON.stringify(state)); } catch (e) { blocked = true; }
      },
      blocked: function () { return blocked; }
    };
  }

  function stampInput(day, streak, slot) {
    return day + streak + (slot === undefined || slot === null ? "" : slot);
  }

  /* Plain http has no crypto.subtle. Null means "no fingerprint here". */
  function fingerprint(text, subtle) {
    if (subtle === undefined) subtle = typeof crypto !== "undefined" ? crypto.subtle : null;
    if (!subtle) return Promise.resolve(null);
    var digest;
    try { digest = subtle.digest("SHA-256", new TextEncoder().encode(text)); } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(digest).then(function (buffer) {
      return Array.from(new Uint8Array(buffer)).map(function (b) { return pad(b.toString(16)); }).join("");
    }).catch(function () { return null; });
  }

  /* ── Ritual ticks ──────────────────────────────────────────
     Stored as { day, done: [ids] } under its own key. Only today's ticks count,
     so a new day starts with none and nothing has to clear them. */
  var RITUALS_KEY = "here.rituals";

  function ritualsToday(raw, today, ids) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return []; }
    if (!data || data.day !== today || !Array.isArray(data.done)) return [];
    return ids.filter(function (id) { return data.done.indexOf(id) !== -1; }).sort(function (a, b) { return a - b; });
  }

  function toggleRitual(done, today, id) {
    var next = done.indexOf(id) === -1 ? done.concat(id) : done.filter(function (d) { return d !== id; });
    return { day: today, done: next.sort(function (a, b) { return a - b; }) };
  }

  /* ── Reminder ───────────────────────────────────────────────
     An iCalendar file (RFC 5545) with one event that repeats daily. The start has
     no time zone on purpose: a floating time rings at that hour wherever the
     visitor's calendar is. Null when the time or day isn't usable. */
  function icsText(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }

  /* Lines over 75 octets continue on the next line after a space. Cut on whole
     characters so nothing multi-byte is split. */
  function icsFold(line) {
    var out = [], current = "", size = 0;
    Array.from(line).forEach(function (char) {
      var bytes = new TextEncoder().encode(char).length;
      if (size + bytes > (out.length ? 74 : 75)) { out.push(current); current = ""; size = 0; }
      current += char;
      size += bytes;
    });
    out.push(current);
    return out.join("\r\n ");
  }

  function reminderCalendar(options) {
    var time = typeof options.time === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(options.time) : null;
    if (!time || !isValidDay(options.day)) return null;
    var now = new Date(options.now);
    var utc = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + "T" +
      pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + "Z";
    var title = icsText(options.name) + ": press the red key";
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//" + icsText(options.name) + "//Daily reminder//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + options.uid + "@stillhere",
      "DTSTAMP:" + utc,
      "DTSTART:" + options.day.replace(/-/g, "") + "T" + time[1] + time[2] + "00",
      "DURATION:PT5M",
      "RRULE:FREQ=DAILY",
      "SUMMARY:" + title,
      "DESCRIPTION:" + icsText("Still here? Press it once today. " + options.url),
      "URL:" + options.url,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:" + title,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR"
    ].map(icsFold).join("\r\n") + "\r\n";
  }

  return {
    KEY: KEY,
    RITUALS_KEY: RITUALS_KEY,
    ritualsToday: ritualsToday,
    toggleRitual: toggleRitual,
    reminderCalendar: reminderCalendar,
    dayKey: dayKey,
    isValidDay: isValidDay,
    prevDay: prevDay,
    empty: empty,
    streakAt: streakAt,
    press: press,
    summary: summary,
    gradeFor: gradeFor,
    nextMilestone: nextMilestone,
    meterPercent: meterPercent,
    parseImport: parseImport,
    merge: merge,
    createStore: createStore,
    stampInput: stampInput,
    fingerprint: fingerprint
  };
});
