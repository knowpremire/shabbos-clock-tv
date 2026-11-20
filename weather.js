// Weather helpers for the display. Data comes from Open-Meteo (open-meteo.com), stored in
// Celsius with unix-second timestamps, so a saved forecast keeps working offline.
(function (root) {
  'use strict';

  const HOUR = 3600;

  // WMO weather codes, as Open-Meteo reports them.
  const LABELS = [
    [[0], 'Clear'],
    [[1], 'Mostly clear'],
    [[2], 'Partly cloudy'],
    [[3], 'Cloudy'],
    [[45, 48], 'Fog'],
    [[51, 53, 55], 'Drizzle'],
    [[56, 57], 'Freezing drizzle'],
    [[61], 'Light rain'],
    [[63], 'Rain'],
    [[65], 'Heavy rain'],
    [[66, 67], 'Freezing rain'],
    [[71], 'Light snow'],
    [[73], 'Snow'],
    [[75], 'Heavy snow'],
    [[77], 'Snow grains'],
    [[80, 81], 'Showers'],
    [[82], 'Heavy showers'],
    [[85, 86], 'Snow showers'],
    [[95], 'Thunderstorms'],
    [[96, 99], 'Thunderstorms, hail'],
  ];

  function describe(code, isDay) {
    if (code === 0 && isDay) return 'Sunny';
    const hit = LABELS.find(([codes]) => codes.includes(code));
    return hit ? hit[1] : 'Weather';
  }

  const toUnit = (celsius, useCelsius) => Math.round(useCelsius ? celsius : (celsius * 9) / 5 + 32);

  function isNumbers(list, length) {
    return Array.isArray(list) && list.length === length && list.every((v) => v === null || Number.isFinite(v));
  }

  /** True if a saved forecast has the hourly and daily series the display reads. */
  function valid(w) {
    const h = w?.hourly;
    const d = w?.daily;
    return (
      Number.isFinite(w?.lat) &&
      Number.isFinite(w?.lon) &&
      Array.isArray(h?.time) &&
      h.time.length > 0 &&
      isNumbers(h.time, h.time.length) &&
      isNumbers(h.temperature_2m, h.time.length) &&
      isNumbers(h.weather_code, h.time.length) &&
      (h.precipitation_probability === undefined || isNumbers(h.precipitation_probability, h.time.length)) &&
      Array.isArray(d?.time) &&
      isNumbers(d.time, d.time.length) &&
      isNumbers(d.temperature_2m_max, d.time.length) &&
      isNumbers(d.temperature_2m_min, d.time.length) &&
      isNumbers(d.weather_code, d.time.length)
    );
  }

  function lastAtOrBefore(times, t) {
    let index = -1;
    for (let i = 0; i < times.length && times[i] <= t; i++) index = i;
    return index;
  }

  /**
   * Weather for the moment `nowMs`: the live reading if it is under an hour old, otherwise the
   * saved hourly forecast. Returns null once the saved forecast has run out.
   */
  function at(w, nowMs) {
    if (!valid(w)) return null;
    const t = nowMs / 1000;
    let temp;
    let code;
    let isDay = null;
    const c = w.current;
    if (c && Number.isFinite(c.temperature_2m) && Number.isFinite(c.time) && t >= c.time - HOUR && t - c.time < HOUR) {
      temp = c.temperature_2m;
      code = c.weather_code;
      isDay = c.is_day === 1;
    } else {
      const i = lastAtOrBefore(w.hourly.time, t);
      if (i < 0 || t - w.hourly.time[i] >= HOUR) return null;
      temp = w.hourly.temperature_2m[i];
      code = w.hourly.weather_code[i];
    }
    if (!Number.isFinite(temp)) return null;
    const d = w.daily;
    const j = lastAtOrBefore(d.time, t);
    // A local day is 23 to 25 hours long around daylight-saving changes.
    const today =
      j >= 0 && t - d.time[j] < 25 * HOUR && Number.isFinite(d.temperature_2m_max[j]) && Number.isFinite(d.temperature_2m_min[j])
        ? { high: d.temperature_2m_max[j], low: d.temperature_2m_min[j], code: d.weather_code[j] }
        : null;
    return { temp, code, label: describe(code, isDay), today };
  }

  const HOUR_MS = HOUR * 1000;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Shabbos'];

  /**
   * The next `count` parts of the day from the saved forecast, starting with the part under way:
   * morning from 6 AM, afternoon from noon, night from 6 PM, phone time. Shabbos and Yom Tov
   * move the night: it starts at candle lighting, and Motzei Shabbos starts when Shabbos ends.
   * The part under way only counts its remaining hours. Parts the forecast doesn't reach are
   * left out.
   *
   * @param periods [{candles: [ms], end: ms}] Shabbos (and joined Yom Tov) periods near now
   * @returns [{label, kind, start, end, low, high, code, condition, rain}] (temperatures in Celsius)
   */
  function outlook(w, nowMs, periods = [], count = 3) {
    if (!valid(w)) return [];
    const dayKey = (ms) => new Date(ms).toDateString();
    const marks = [];
    const moved = new Set(); // days whose night starts at candle lighting or Shabbos end
    for (const p of periods) {
      for (const c of p.candles) {
        marks.push({ at: c, kind: 'night' });
        moved.add(dayKey(c));
      }
      marks.push({ at: p.end, kind: 'night', after: true });
      moved.add(dayKey(p.end));
    }
    const today = new Date(nowMs);
    for (let d = -1; d <= 6; d++) {
      const hour = (h) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + d, h).getTime();
      marks.push({ at: hour(6), kind: 'morning' }, { at: hour(12), kind: 'afternoon' });
      if (!moved.has(dayKey(hour(18)))) marks.push({ at: hour(18), kind: 'night' });
    }
    marks.sort((a, b) => a.at - b.at);

    const h = w.hourly;
    const parts = [];
    let i = marks.findIndex((m, k) => k + 1 === marks.length || marks[k + 1].at > nowMs);
    for (; i >= 0 && i + 1 < marks.length && parts.length < count; i++) {
      const mark = marks[i];
      const from = Math.max(mark.at, nowMs);
      const end = marks[i + 1].at;
      if (end <= from) continue;
      const hours = [];
      // Each hourly value covers the hour that follows it.
      for (let k = 0; k < h.time.length; k++) {
        const t = h.time[k] * 1000;
        if (t + HOUR_MS > from && t < end && Number.isFinite(h.temperature_2m[k])) hours.push(k);
      }
      // Leave out parts the forecast only reaches the edge of.
      if (!hours.length || h.time[hours[hours.length - 1]] * 1000 + HOUR_MS < Math.min(end, from + 2 * HOUR_MS)) continue;
      const temps = hours.map((k) => h.temperature_2m[k]);
      const codes = hours.map((k) => h.weather_code[k]).filter(Number.isFinite);
      // WMO codes rise with severity, so the highest code is the weather worth knowing about.
      const code = codes.length ? Math.max(...codes) : null;
      const chances = (h.precipitation_probability ? hours.map((k) => h.precipitation_probability[k]) : []).filter(Number.isFinite);
      const weekday = new Date(mark.at).getDay();
      const label =
        mark.kind === 'night'
          ? mark.after && weekday === 6
            ? 'Motzei Shabbos'
            : WEEKDAYS[weekday].replace('Shabbos', 'Sat') + ' night'
          : WEEKDAYS[weekday] + (mark.kind === 'morning' ? ' AM' : ' PM');
      parts.push({
        label,
        kind: mark.kind,
        start: from,
        end,
        low: Math.min(...temps),
        high: Math.max(...temps),
        code,
        condition: code === null ? '' : describe(code, mark.kind !== 'night'),
        rain: chances.length ? Math.max(...chances) : null,
      });
    }
    return parts;
  }

  /** Great-circle distance in kilometres between two {lat, lon} points. */
  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  const api = { describe, toUnit, valid, at, outlook, distanceKm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShabbosWeather = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
