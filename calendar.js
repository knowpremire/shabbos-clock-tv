/* Chabad calendar decoding and date selection. No astronomical calculations. */
(function (root) {
  'use strict';

  // Keep showing a Shabbos's times this long after it ends before moving on to the next one.
  const AFTER_SHABBOS_MS = 2 * 60 * 60 * 1000;
  const FRIDAY = 5;

  function decode(s) {
    return s
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/gi, '\n')
      .replace(/\\([,;\\])/g, '$1');
  }

  // Chabad words these several ways, e.g. "Light Candles at", "Light Shabbat Candles at",
  // "Light Shabbat / Holiday Candles at", "Shabbat Ends", "Shabbat / Holiday Ends", "Holiday Ends".
  function eventType(summary) {
    if (/Chanukah|Hanukkah|Menorah/i.test(summary)) return null;
    if (/\bEnds\b/i.test(summary)) return 'end';
    if (/\bLight\b[^:]*\bCandles\b|Candle[ -]Lighting/i.test(summary)) return 'candle';
    return null;
  }

  function endKind(summary) {
    const shabbat = /Shabbat/i.test(summary);
    const holiday = /Holiday|Yom Kippur/i.test(summary);
    return shabbat && holiday ? 'both' : holiday ? 'holiday' : 'shabbat';
  }

  function dayOfWeek(isoDate) {
    return new Date(isoDate + 'T12:00:00Z').getUTCDay();
  }

  function parseEvent(fields) {
    const summary = fields.SUMMARY || '';
    const type = eventType(summary);
    const dt = (fields.DTSTART || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const uid = (fields.UID || '').match(/-(\d{4})(\d{2})(\d{2})T000000@/);
    const time = summary.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!type || !dt || !uid || !time) return null;
    const hh = Number(time[1]);
    const mm = Number(time[2]);
    if (hh < 1 || hh > 12 || mm > 59) return null;
    const event = {
      type,
      date: `${uid[1]}-${uid[2]}-${uid[3]}`,
      instant: Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]),
      time: hh + ':' + time[2],
      period: time[3].toUpperCase(),
      qualifier: /after/i.test(summary) ? 'after' : /before/i.test(summary) ? 'before' : 'at',
      summary,
    };
    if (type === 'end') event.kind = endKind(summary);
    return event;
  }

  function parseICS(text) {
    if (!text.includes('BEGIN:VCALENDAR')) throw Error('Not a calendar');
    const normalized = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').replace(/=\n/g, '');
    const events = [];
    const seen = new Set();
    let location = '';
    let generatedAt = 0;
    for (const block of normalized.split('BEGIN:VEVENT').slice(1)) {
      const fields = {};
      for (const line of block.split('\n')) {
        const sep = line.indexOf(':');
        if (sep > 0) fields[line.slice(0, sep).split(';')[0]] = decode(line.slice(sep + 1).trim());
      }
      const stamp = (fields.DTSTAMP || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      if (stamp && !generatedAt) generatedAt = Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]);
      const event = parseEvent(fields);
      if (!event || seen.has(event.type + event.instant)) continue;
      seen.add(event.type + event.instant);
      events.push(event);
      location = fields.LOCATION || location;
    }
    events.sort((a, b) => a.instant - b.instant);

    // A period is every candle lighting up to the next "Ends". Shabbos that runs into Yom Tov
    // (or Yom Tov into Shabbos) is one period, possibly ending on Sunday or later.
    const weeks = [];
    let candles = [];
    for (const event of events) {
      if (event.type === 'candle') {
        candles.push(event);
      } else if (candles.length) {
        // Only periods that include Shabbos; Friday always has a candle lighting.
        if (candles.some((c) => dayOfWeek(c.date) === FRIDAY)) weeks.push({ candle: candles[0], candles, end: event });
        candles = [];
      }
    }
    if (!weeks.length) throw Error('No complete dated Shabbat times');
    return { location, generatedAt, weeks };
  }

  // The candle lighting to show: the next one in this period, or the last one once all have passed.
  function currentCandle(week, now) {
    const candles = week.candles || [week.candle];
    return candles.find((c) => c.instant >= now) || candles[candles.length - 1];
  }

  function selectWeek(cache, now = Date.now(), grace = AFTER_SHABBOS_MS) {
    if (!cache || !Array.isArray(cache.weeks) || !cache.weeks.length) return null;
    const active = cache.weeks.find((w) => w.end.instant + grace >= now);
    const week = active || cache.weeks[cache.weeks.length - 1];
    return { week, candle: currentCandle(week, now), expired: !active };
  }

  // True once today's candle lighting or Shabbos/Yom Tov end has passed, when the Jewish day has
  // already moved to the next date. Uses the phone's local date.
  function hebrewDayAdvanced(cache, now = Date.now()) {
    if (!cache || !Array.isArray(cache.weeks)) return false;
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return cache.weeks.some((w) =>
      (w.candles || [w.candle]).concat(w.end).some((e) => e.date === today && e.instant <= now)
    );
  }

  const api = { parseICS, selectWeek, hebrewDayAdvanced, AFTER_SHABBOS_MS };
  root.ShabbosCalendar = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
