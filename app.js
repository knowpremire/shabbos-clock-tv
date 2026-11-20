(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const native = location.hostname === 'appassets.androidplatform.net';
  // The Chromecast receiver (receiver/build.sh): shows what the phone sends, never fetches Chabad.
  const tv = window.SHABBOS_TV === true;
  const castBridge = native && !tv ? window.ShabbosCast : null;

  const SETTINGS_KEY = 'shabbos-settings-v1';
  // v2: weeks can include Yom Tov candle lightings; v1 caches were parsed without holiday weeks.
  const cacheKey = (zip) => 'shabbos-calendar-v2-' + zip;
  const CHABAD_ICS = 'https://www.chabad.org/calendar/candlelighting/candlelighting.ics.asp?locationType=2&weeks=52&locationId=';
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const REFRESH_AFTER_SUCCESS_MS = 6 * 60 * MINUTE;
  const MAX_ALARM_SECONDS = 600;
  const DEFAULT_SOUND_NAME = 'Phone default alarm';
  const DAYS = { sat: 'Shabbos', fri: 'Friday', both: 'Friday & Shabbos' };
  const END_LABELS = { shabbat: 'Shabbos ends', holiday: 'Yom Tov ends', both: 'Shabbos & Yom Tov end' };
  // The line under "Shabbos ends": where the times come from and whether they're saved.
  const STATUS = {
    loading: 'Chabad.org · updating…',
    offline: 'Chabad.org · offline, using saved',
    saved: 'Chabad.org · saved times',
    live: 'Chabad.org · saved for offline',
    tv: 'Chabad.org · from your phone',
  };
  const WEATHER_KEY = 'shabbos-weather-v1';
  const OPEN_METEO =
    'https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,precipitation_probability' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&timeformat=unixtime&forecast_days=5';
  const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search?count=5&countryCode=US&name=';
  const WEATHER_EVERY_MS = 30 * MINUTE;
  const WEATHER_RETRY_MS = 5 * MINUTE;
  const LOCATE_EVERY_MS = 30 * MINUTE;
  // A new ZIP from location is followed only after moving this far from where the current ZIP
  // was found, so a spot near a ZIP border doesn't flip back and forth.
  const FOLLOW_ZIP_KM = 10;

  const settings = {
    zip: '11213',
    scale: 1,
    awake: true,
    hour24: false,
    seconds: true,
    brightness: -1,
    standby: true,
    nightDim: false,
    dimFrom: '22:00',
    dimTo: '07:00',
    dimLevel: 0.05,
    autoLocation: true,
    locationAsked: false,
    coords: null, // last phone location {lat, lon, at}
    zipOrigin: null, // where the current ZIP was found by location {lat, lon}
    zipCoords: null, // the ZIP's own position, for weather without location {zip, lat, lon}
    weather: true,
    celsius: false,
  };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (e) {}
  const isTime = (value) => /^\d{2}:\d{2}$/.test(value);
  if (!/^\d{5}$/.test(settings.zip)) settings.zip = '11213';
  if (!isTime(settings.dimFrom)) settings.dimFrom = '22:00';
  if (!isTime(settings.dimTo)) settings.dimTo = '07:00';
  settings.scale = Math.max(0.3, Number(settings.scale) || 1);
  settings.dimLevel = Math.min(1, Math.max(0.02, Number(settings.dimLevel) || 0.05));
  const isPoint = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);
  for (const key of ['coords', 'zipOrigin', 'zipCoords']) if (!isPoint(settings[key])) settings[key] = null;

  let cache = null;
  let networkState = tv ? 'tv' : 'saved';
  let inflight = null;
  let failures = 0;
  let lastRefresh = 0;
  let requestSequence = 0;
  let lastSyncError = '';
  let controlsTimer;
  let toastTimer;
  let lastClock = '';
  let lastMinute = -1;
  let nightActive = null;
  let soundRequest = '';
  let alarmData = { alarms: [], allowed: false, enabled: false };
  let editDays = { fri: false, sat: true };
  let weather = null;
  let weatherInflight = false;
  let lastWeather = 0;
  let weatherError = '';
  let lastLocate = 0;
  let locating = false;
  let locationNote = '';
  try {
    const saved = JSON.parse(localStorage.getItem(WEATHER_KEY));
    if (ShabbosWeather.valid(saved)) weather = saved;
  } catch (e) {}

  const civilFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  let hebrewFormat = null;
  try {
    hebrewFormat = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) {}
  let clockFormat = null;

  // ---- General UI -------------------------------------------------------------------------

  function save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      toast('Storage is full; settings could not be saved.');
    }
    pushToTv();
  }

  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
  }

  function showControls() {
    if (tv) return;
    document.body.classList.add('active');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => document.body.classList.remove('active'), 5000);
  }
  ['pointerdown', 'pointermove', 'keydown'].forEach((type) => document.addEventListener(type, showControls, { passive: true }));

  // ---- Display preferences and night dimming ----------------------------------------------

  function minutesOf(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function isNight(now = new Date()) {
    if (!settings.nightDim) return false;
    const from = minutesOf(settings.dimFrom);
    const to = minutesOf(settings.dimTo);
    const minute = now.getHours() * 60 + now.getMinutes();
    if (from === to) return false;
    return from < to ? minute >= from && minute < to : minute >= from || minute < to;
  }

  const percent = (value) => Math.round(value * 100) + '%';

  function displayPreferences() {
    nightActive = isNight();
    const brightness = nightActive ? settings.dimLevel : settings.brightness;
    // The TV's backlight can't be set from here, so night dimming darkens the picture instead.
    if (tv) document.body.style.filter = nightActive ? 'brightness(' + Math.max(0.25, settings.dimLevel) + ')' : '';
    if (native) fetch('/display?awake=' + (settings.awake ? '1' : '0') + '&brightness=' + brightness).catch(() => {});
    clockFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: !settings.hour24 });

    $('awakeInput').checked = settings.awake;
    $('hourInput').checked = settings.hour24;
    $('secondsInput').checked = settings.seconds;
    $('standbyInput').checked = settings.standby;
    $('brightnessInput').value = settings.brightness < 0 ? 50 : Math.round(settings.brightness * 100);
    $('brightnessText').textContent = settings.brightness < 0 ? 'System brightness' : percent(settings.brightness);
    $('nightDimInput').checked = settings.nightDim;
    $('dimOptions').hidden = !settings.nightDim;
    $('dimFrom').value = settings.dimFrom;
    $('dimTo').value = settings.dimTo;
    $('dimLevel').value = Math.round(settings.dimLevel * 100);
    $('nightDimText').textContent = settings.nightDim
      ? (nightActive ? 'Dimmed now · ' : '') + percent(settings.dimLevel) + ' from ' + settings.dimFrom + ' until ' + settings.dimTo
      : 'Lowers brightness on a schedule, no touch needed';

    $('seconds').hidden = !settings.seconds;
    $('period').hidden = settings.hour24;
    document.body.classList.toggle('standby', settings.standby);
  }

  function fitClock() {
    const landscape = innerWidth > innerHeight;
    // Landscape standby puts the date in the top bar, leaving the bottom row to times and weather.
    const line = $('dateLine');
    const home = landscape && settings.standby ? $('header') : $('center');
    if (line.parentNode && line.parentNode !== home) {
      if (home === $('header')) home.insertBefore(line, home.lastElementChild);
      else home.append(line);
    }
    const el = $('clock');
    // Measure the bundled font against the actual screen.
    el.style.setProperty('--clock-stretch', '1');
    el.style.fontSize = '100px';
    const bounds = el.getBoundingClientRect();
    const width = innerWidth - (settings.standby ? 60 : 70);
    // In portrait, the Shabbos forecast row takes space below the clock: shrink the clock by
    // that much and move it up by half, so its bottom clears the row.
    const outlookRoom = !landscape && !$('outlook').hidden ? $('outlook').getBoundingClientRect().height + 24 : 0;
    $('center').style.marginTop = outlookRoom ? -outlookRoom / 2 + 'px' : '';
    // On the TV the bottom row is larger; leave it its measured height.
    const bottom = tv ? $('times').getBoundingClientRect().height + 150 : landscape ? 130 : 210;
    const height = (settings.standby ? innerHeight - bottom : innerHeight * 0.38) - outlookRoom;
    const maximum = Math.max(20, 100 * Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height)));
    const desired = maximum * (settings.standby ? 1 : 0.68) * settings.scale;
    const size = Math.floor(Math.min(maximum, desired));
    el.style.fontSize = size + 'px';
    if (settings.standby) el.style.setProperty('--clock-stretch', String(Math.min(1.8, width / ((bounds.width * size) / 100))));
    el.dataset.atMaximum = desired >= maximum ? '1' : '0';
  }

  // Slow movement to spread wear on OLED screens over a 25-hour Shabbos.
  function drift() {
    document.documentElement.style.setProperty('--dx', Math.round(Math.random() * 24 - 12) + 'px');
    document.documentElement.style.setProperty('--dy', Math.round(Math.random() * 16 - 8) + 'px');
  }

  // ---- Clock and Shabbos times -------------------------------------------------------------

  function tick() {
    const now = new Date();
    const parts = clockFormat.formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    $('hours').textContent = get('hour');
    $('minutes').textContent = get('minute');
    $('seconds').textContent = get('second');
    $('period').textContent = get('dayPeriod');
    const digits = get('hour') + ':' + get('minute');
    if (digits !== lastClock) {
      lastClock = digits;
      fitClock();
    }
    const minute = Math.floor(now.getTime() / MINUTE);
    if (minute !== lastMinute) {
      lastMinute = minute;
      renderCache();
      renderWeather();
      if (isNight(now) !== nightActive) displayPreferences();
    }
  }

  function dateLabel(iso) {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z'));
  }

  function renderDates() {
    const now = new Date();
    $('civilDate').textContent = civilFormat.format(now);
    if (!hebrewFormat) {
      $('hebrewDate').textContent = '';
      return;
    }
    const advanced = ShabbosCalendar.hebrewDayAdvanced(cache, now.getTime());
    const day = advanced ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12) : now;
    $('hebrewDate').textContent = hebrewFormat.format(day);
  }

  function validWeek(w) {
    return (
      Number.isFinite(w?.end?.instant) &&
      Number.isFinite(w?.candle?.instant) &&
      /^\d{4}-\d{2}-\d{2}$/.test(w.candle.date) &&
      (!w.candles || w.candles.every((c) => Number.isFinite(c.instant)))
    );
  }

  function storedCalendar(zip) {
    try {
      const candidate = JSON.parse(localStorage.getItem(cacheKey(zip)));
      if (candidate?.zip === zip && Array.isArray(candidate.weeks) && candidate.weeks.every(validWeek)) return candidate;
    } catch (e) {}
    return null;
  }

  function readCache() {
    cache = storedCalendar(settings.zip);
  }

  function storeCache(value) {
    pushToTv();
    try {
      localStorage.setItem(cacheKey(value.zip), JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function renderCache() {
    renderDates();
    $('location').textContent = cache?.location || 'Shabbos times · ZIP ' + settings.zip;
    $('chabadLink').href = 'https://www.chabad.org/calendar/candlelighting_cdo/locationId/' + settings.zip + '/locationType/2/jewish/Candle-Lighting.htm';
    $('syncDetails').textContent = lastSyncError;
    const status = $('status');
    const now = Date.now();
    const picked = ShabbosCalendar.selectWeek(cache, now);
    if (picked) {
      const { candle } = picked;
      const { end } = picked.week;
      $('candleTime').textContent = candle.time;
      $('candlePeriod').textContent = candle.period;
      $('candleLabel').textContent = 'Candle lighting' + (candle.qualifier === 'after' || candle.qualifier === 'before' ? ' · ' + candle.qualifier : '');
      $('candleDate').textContent = dateLabel(candle.date);
      $('endTime').textContent = end.time;
      $('endPeriod').textContent = end.period;
      $('endLabel').textContent = END_LABELS[end.kind] || END_LABELS.shabbat;
      $('endDate').textContent = dateLabel(end.date);
      const remaining = cache.weeks.filter((w) => w.end.instant + ShabbosCalendar.AFTER_SHABBOS_MS >= now).length;
      $('cacheInfo').textContent = remaining
        ? remaining + ' saved Shabbos weeks · through ' + dateLabel(cache.weeks[cache.weeks.length - 1].end.date)
        : 'Saved weeks have expired. Connect to refresh.';
      $('lastSaved').textContent = 'Saved ' + new Date(cache.savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      status.classList.toggle('warning', picked.expired || networkState === 'offline');
      status.textContent = picked.expired ? 'Expired · connect to refresh' : STATUS[networkState] || STATUS.saved;
    } else {
      ['candleTime', 'endTime'].forEach((id) => ($(id).textContent = '—'));
      ['candlePeriod', 'endPeriod'].forEach((id) => ($(id).textContent = ''));
      $('candleLabel').textContent = 'Candle lighting';
      $('endLabel').textContent = END_LABELS.shabbat;
      $('candleDate').textContent = tv ? 'Waiting for your phone' : 'No saved times for ' + settings.zip;
      $('endDate').textContent = tv ? 'Choose this TV in Shabbos Clock' : 'Connect to download';
      status.textContent = tv ? 'Not connected yet' : networkState === 'loading' ? 'Getting Chabad times…' : 'Connect once to save times';
      status.classList.add('warning');
      $('cacheInfo').textContent = 'No saved calendar for this ZIP.';
      $('lastSaved').textContent = '';
    }
  }

  // ---- Refreshing from Chabad -------------------------------------------------------------

  // After a good download, check again every 6 hours; after failures, retry every 5 to 30 minutes.
  function refreshDue() {
    const wait = networkState === 'live' ? REFRESH_AFTER_SUCCESS_MS : Math.max(5, Math.min(30, 2 ** failures)) * MINUTE;
    return Date.now() - lastRefresh >= wait;
  }

  /** Downloads and checks one ZIP's calendar. Throws if it is missing, malformed or for another place. */
  async function download(zip, signal) {
    const response = await fetch((native ? '/times?zip=' : CHABAD_ICS) + zip, { signal, cache: 'no-store' });
    if (!response.ok) throw Error((await response.text()).slice(0, 180) || 'Chabad refresh unavailable');
    const calendar = ShabbosCalendar.parseICS(await response.text());
    if (!new RegExp('\\b' + zip + '\\b').test(calendar.location)) throw Error('Location did not match ZIP');
    const header = (name) => response.headers?.get(name) || '';
    const isCached = header('X-Shabbos-Cached') === '1';
    const savedAt = Number(header('X-Shabbos-Saved-At')) || (isCached && calendar.generatedAt) || Date.now();
    return { calendar: { zip, savedAt, ...calendar }, isCached, error: header('X-Shabbos-Refresh-Error') };
  }

  async function refresh(force = false) {
    if (tv || inflight === settings.zip) return;
    if (!force && Date.now() - lastRefresh < MINUTE) return;
    const zip = settings.zip;
    const sequence = ++requestSequence;
    inflight = zip;
    lastRefresh = Date.now();
    networkState = 'loading';
    renderCache();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const current = () => zip === settings.zip && sequence === requestSequence;
    try {
      const { calendar: updated, isCached, error } = await download(zip, controller.signal);
      if (!current()) return;
      if (ShabbosCalendar.selectWeek(updated).expired && cache && !ShabbosCalendar.selectWeek(cache).expired) throw Error('Older calendar');
      // Commit only a complete parsed calendar; never clear stored data on refresh errors.
      cache = updated;
      if (!storeCache(updated)) toast('Times loaded; browser storage could not save them.');
      networkState = isCached ? 'saved' : 'live';
      lastSyncError = error;
      failures = isCached ? failures + 1 : 0;
    } catch (e) {
      if (current()) {
        networkState = 'offline';
        lastSyncError = e.name === 'AbortError' ? 'Refresh timed out. Saved times remain available.' : e.message;
        failures++;
        if (force) toast(cache ? 'Could not refresh. Saved times are still here.' : 'Could not reach Chabad. Try again when connected.');
      }
    } finally {
      clearTimeout(timeout);
      if (sequence === requestSequence) inflight = null;
      if (current()) renderCache();
    }
  }

  // Calendar to show before the first download: the native app's saved copy, or the bundled one.
  async function loadSavedCalendar() {
    if (tv) return;
    const zip = settings.zip;
    try {
      const response = await fetch(native ? '/saved?zip=' + zip : 'seed.ics');
      if (!response.ok || (!native && zip !== '11213')) return;
      const seed = ShabbosCalendar.parseICS(await response.text());
      if (settings.zip !== zip || cache || !new RegExp('\\b' + zip + '\\b').test(seed.location)) return;
      const savedAt = Number(response.headers?.get('X-Shabbos-Saved-At')) || seed.generatedAt || Date.now();
      cache = { zip, savedAt, ...seed };
      storeCache(cache);
      renderCache();
    } catch (e) {}
  }

  // ---- Location ----------------------------------------------------------------------------

  function renderLocation() {
    $('autoLocationInput').checked = settings.autoLocation;
    $('locationText').textContent = settings.autoLocation
      ? locationNote || 'Sets the ZIP and weather from where the phone is'
      : 'Off · times use the ZIP below';
  }

  /** Asks the phone where it is; follows a new ZIP once that ZIP's times are saved. */
  async function locate(ask = false) {
    if (!native || !settings.autoLocation || locating) return;
    locating = true;
    lastLocate = Date.now();
    try {
      const response = await fetch('/location' + (ask ? '?ask=1' : ''));
      if (response.status === 403) {
        locationNote = ask ? 'Waiting for location permission…' : 'Location permission is off · using the ZIP below';
        return;
      }
      if (!response.ok) {
        locationNote = (await response.text()).slice(0, 120) || 'Location unavailable';
        return;
      }
      const fix = await response.json();
      if (!isPoint(fix)) return;
      const moved = !settings.coords || ShabbosWeather.distanceKm(settings.coords, fix) > 2;
      settings.coords = { lat: fix.lat, lon: fix.lon, at: Date.now() };
      locationNote = 'On' + (fix.place ? ' · near ' + fix.place : '');
      if (fix.country && fix.country !== 'US') {
        locationNote = 'Outside the US · Chabad times use the ZIP below';
      } else if (/^\d{5}$/.test(fix.zip || '')) {
        if (fix.zip === settings.zip) {
          settings.zipOrigin = { lat: fix.lat, lon: fix.lon };
        } else if (!settings.zipOrigin || ShabbosWeather.distanceKm(settings.zipOrigin, fix) >= FOLLOW_ZIP_KM) {
          await followZip(fix.zip, fix);
        }
      }
      save();
      if (moved) refreshWeather(true);
    } catch (e) {
      locationNote = 'Location unavailable';
    } finally {
      locating = false;
      renderLocation();
    }
  }

  async function followZip(zip, fix) {
    let calendar = storedCalendar(zip);
    if (!calendar) {
      try {
        calendar = (await download(zip)).calendar;
      } catch (e) {
        // Keep showing the current ZIP's times rather than an empty screen.
        locationNote = 'Found ZIP ' + zip + ' · switches once its times download';
        return;
      }
      storeCache(calendar);
    }
    settings.zip = zip;
    settings.zipOrigin = { lat: fix.lat, lon: fix.lon };
    save();
    cache = calendar;
    networkState = 'saved';
    renderCache();
    toast('Shabbos times for ' + (calendar.location || 'ZIP ' + zip));
    lastRefresh = 0;
    refresh();
  }

  window.locationPermission = (granted) => {
    if (granted) {
      locate();
    } else {
      settings.autoLocation = false;
      save();
      renderLocation();
      refreshWeather(true);
    }
  };

  // ---- Weather -----------------------------------------------------------------------------

  /** Where the weather is for: the phone's location, or else the ZIP's own position. */
  function weatherPlace() {
    if (settings.autoLocation && settings.coords) return settings.coords;
    if (settings.zipCoords?.zip === settings.zip) return settings.zipCoords;
    return null;
  }

  async function lookUpZip(zip) {
    const response = await fetch(native ? '/geocode?zip=' + zip : GEOCODE + zip);
    if (!response.ok) throw Error('Could not look up ZIP ' + zip + ' for weather');
    const results = (await response.json()).results || [];
    const hit = results.find((r) => r.postcodes?.includes(zip)) || results[0];
    if (!isPoint({ lat: hit?.latitude, lon: hit?.longitude })) throw Error('No weather location for ZIP ' + zip);
    settings.zipCoords = { zip, lat: hit.latitude, lon: hit.longitude };
    save();
    return settings.zipCoords;
  }

  function weatherDue() {
    return Date.now() - lastWeather >= (weatherError ? WEATHER_RETRY_MS : WEATHER_EVERY_MS);
  }

  async function refreshWeather(force = false) {
    if (!settings.weather || weatherInflight || (!force && !weatherDue())) return;
    weatherInflight = true;
    lastWeather = Date.now();
    try {
      const place = weatherPlace() || (await lookUpZip(settings.zip));
      const query = '&latitude=' + place.lat.toFixed(2) + '&longitude=' + place.lon.toFixed(2);
      const response = await fetch(native ? '/weather?lat=' + place.lat + '&lon=' + place.lon : OPEN_METEO + query, { cache: 'no-store' });
      if (!response.ok) throw Error('Weather unavailable');
      const data = await response.json();
      const updated = { lat: place.lat, lon: place.lon, fetchedAt: Date.now(), current: data.current, hourly: data.hourly, daily: data.daily };
      if (!ShabbosWeather.valid(updated)) throw Error('Weather data was incomplete');
      weather = updated;
      weatherError = '';
      pushToTv();
      try {
        localStorage.setItem(WEATHER_KEY, JSON.stringify(updated));
      } catch (e) {}
    } catch (e) {
      weatherError = e.message || 'Weather unavailable';
    } finally {
      weatherInflight = false;
      renderWeather();
    }
  }

  function renderWeather() {
    $('weatherInput').checked = settings.weather;
    $('celsiusInput').checked = settings.celsius;
    const place = weatherPlace();
    // Don't show a saved forecast for somewhere else.
    const here = weather && (!place || ShabbosWeather.distanceKm(place, weather) < 30);
    const now = settings.weather && here ? ShabbosWeather.at(weather, Date.now()) : null;
    const updated = weather ? new Date(weather.fetchedAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    $('weatherText').textContent = !settings.weather
      ? 'Off'
      : weatherError
        ? weatherError + (updated && now ? ' · showing forecast from ' + updated : '')
        : updated
          ? 'Updated ' + updated + ' · saved forecast works offline'
          : 'Updates every 30 minutes; the saved forecast works offline';
    $('weatherCard').hidden = !now;
    const parts = settings.weather && here ? shabbosOutlook() : [];
    const resize = $('outlook').hidden !== !parts.length;
    $('outlook').hidden = !parts.length;
    const deg = (c) => ShabbosWeather.toUnit(c, settings.celsius) + '°';
    $('outlook').replaceChildren(
      ...parts.map((part) => {
        const cell = document.createElement('div');
        cell.className = 'outlook-part';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = part.label;
        const temps = document.createElement('div');
        temps.className = 'outlook-temp';
        const low = deg(part.low);
        const high = deg(part.high);
        temps.textContent = low === high ? high : low.slice(0, -1) + '–' + high;
        const sky = document.createElement('div');
        sky.className = 'date';
        // Chance of rain or snow from 20%: after the word when it is the weather, otherwise spelled out.
        const chance = part.rain >= 20 ? (part.code >= 51 ? ' ' + part.rain + '%' : ' · ' + part.rain + '% rain') : '';
        sky.textContent = part.condition + chance;
        cell.append(label, temps, sky);
        return cell;
      })
    );
    if (resize) fitClock();
    if (!now) return;
    $('weatherLabel').textContent = now.label;
    $('weatherTemp').textContent = deg(now.temp);
    $('weatherUnit').textContent = settings.celsius ? 'C' : 'F';
    $('weatherRange').textContent = now.today ? 'H ' + deg(now.today.high) + ' · L ' + deg(now.today.low) : '';
  }

  /** The next three parts of the day, split around candle lighting and Shabbos ending. */
  function shabbosOutlook() {
    if (!weather) return [];
    const now = Date.now();
    const periods = (cache?.weeks || [])
      .filter((w) => w.end.instant > now - 2 * DAY && w.candle.instant < now + 7 * DAY)
      .map((w) => ({ candles: (w.candles || [w.candle]).map((c) => c.instant), end: w.end.instant }));
    return ShabbosWeather.outlook(weather, now, periods, 3);
  }

  // ---- Hooks called by MainActivity --------------------------------------------------------

  window.connectionReturned = () => {
    if (weatherError || !weather) refreshWeather(true);
    if (networkState === 'live' && !refreshDue()) return;
    lastRefresh = 0;
    refresh();
  };
  window.appResumed = () => {
    displayPreferences();
    tick();
    fitClock();
    loadAlarm();
    if (refreshDue()) refresh();
    if (Date.now() - lastLocate >= LOCATE_EVERY_MS) locate();
    refreshWeather();
  };
  window.closeSettings = () => {
    if ($('settings').open) $('settings').close();
    else showControls();
  };
  window.dismissSettings = () => {
    if ($('alarms').open && !$('alarmForm').hidden) {
      showAlarmList();
      return true;
    }
    for (const id of ['alarms', 'settings', 'tv']) {
      if ($(id).open) {
        $(id).close();
        return true;
      }
    }
    return false;
  };

  // ---- Settings dialog ---------------------------------------------------------------------

  $('settingsButton').onclick = () => {
    $('zipInput').value = settings.zip;
    renderCache();
    renderLocation();
    renderWeather();
    $('settings').showModal();
  };
  $('closeButton').onclick = window.closeSettings;
  $('settings').addEventListener('click', (e) => {
    if (e.target !== $('settings')) return;
    const rect = $('settings').getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) $('settings').close();
  });
  $('refreshButton').onclick = () => refresh(true);

  $('settingsForm').onsubmit = (e) => {
    e.preventDefault();
    const zip = $('zipInput').value.trim();
    if (!/^\d{5}$/.test(zip)) {
      $('formError').textContent = 'Enter a five-digit US ZIP.';
      return;
    }
    $('formError').textContent = '';
    const turnedOff = settings.autoLocation;
    settings.zip = zip;
    settings.autoLocation = false;
    save();
    readCache();
    networkState = 'saved';
    renderCache();
    renderLocation();
    lastRefresh = 0;
    refresh(true);
    refreshWeather(true);
    toast('ZIP ' + zip + ' saved' + (turnedOff ? ' · location off' : ''));
  };

  $('autoLocationInput').onchange = () => {
    settings.autoLocation = $('autoLocationInput').checked;
    settings.zipOrigin = null;
    locationNote = '';
    settings.locationAsked = true;
    save();
    renderLocation();
    if (settings.autoLocation) locate(true);
    else refreshWeather(true);
  };
  $('weatherInput').onchange = () => {
    settings.weather = $('weatherInput').checked;
    save();
    renderWeather();
    refreshWeather(true);
  };
  $('celsiusInput').onchange = () => {
    settings.celsius = $('celsiusInput').checked;
    save();
    renderWeather();
  };

  for (const [id, name] of [
    ['awakeInput', 'awake'],
    ['hourInput', 'hour24'],
    ['secondsInput', 'seconds'],
    ['standbyInput', 'standby'],
  ]) {
    $(id).onchange = () => {
      settings[name] = $(id).checked;
      save();
      displayPreferences();
      lastClock = '';
      tick();
      fitClock();
    };
  }

  $('brightnessInput').oninput = () => {
    settings.brightness = Math.max(0.02, Number($('brightnessInput').value) / 100);
    save();
    displayPreferences();
  };
  $('systemBrightness').onclick = () => {
    settings.brightness = -1;
    save();
    displayPreferences();
  };

  $('nightDimInput').onchange = () => {
    settings.nightDim = $('nightDimInput').checked;
    save();
    displayPreferences();
  };
  for (const [id, name] of [
    ['dimFrom', 'dimFrom'],
    ['dimTo', 'dimTo'],
  ]) {
    $(id).onchange = () => {
      if (!isTime($(id).value)) return;
      settings[name] = $(id).value;
      save();
      displayPreferences();
    };
  }
  $('dimLevel').oninput = () => {
    settings.dimLevel = Math.max(0.02, Number($('dimLevel').value) / 100);
    save();
    displayPreferences();
  };

  function resize(delta) {
    settings.scale = Math.round(Math.max(0.3, settings.scale + delta) * 100) / 100;
    save();
    fitClock();
    toast($('clock').dataset.atMaximum === '1' ? 'Clock fills the available screen' : 'Clock size ' + Math.round(settings.scale * 100) + '%');
  }
  $('plus').onclick = () => resize(0.1);
  $('minus').onclick = () => resize(-0.1);

  // ---- Alarms ------------------------------------------------------------------------------

  const DURATIONS = [10, 30, 60, 120, 300, 600];
  const DAY_ORDER = { fri: 0, both: 1, sat: 2 };
  let editing = null; // the alarm open in the editor, or null for a new one

  function validDuration(value) {
    const seconds = Number(value);
    return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_ALARM_SECONDS ? seconds : 0;
  }

  function durationLabel(seconds) {
    if (seconds < 60) return seconds + ' sec';
    const minutes = seconds / 60;
    return Number.isInteger(minutes) ? minutes + ' min' : Math.floor(minutes) + ' min ' + (seconds % 60) + ' sec';
  }

  const timeParts = (a) => {
    const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: !settings.hour24 }).formatToParts(new Date(2026, 0, 1, a.hour, a.minute));
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return { time: get('hour') + ':' + get('minute'), period: get('dayPeriod') };
  };

  /** Alarms in the order they happen in the day; Friday before Shabbos at the same time. */
  function byTime(a, b) {
    return a.hour * 60 + a.minute - (b.hour * 60 + b.minute) || DAY_ORDER[a.days] - DAY_ORDER[b.days] || a.id - b.id;
  }

  function renderDays() {
    $('dayFri').classList.toggle('on', editDays.fri);
    $('daySat').classList.toggle('on', editDays.sat);
    $('dayFri').setAttribute('aria-pressed', String(editDays.fri));
    $('daySat').setAttribute('aria-pressed', String(editDays.sat));
  }

  function setDurationChoices(current) {
    // Presets, plus an older alarm's own value if it isn't one of them.
    const values = DURATIONS.includes(current) ? DURATIONS : DURATIONS.concat(current).sort((x, y) => x - y);
    $('alarmDuration').replaceChildren(
      ...values.map((v) => {
        const option = document.createElement('option');
        option.value = String(v);
        option.textContent = durationLabel(v);
        return option;
      })
    );
    $('alarmDuration').value = String(current);
  }

  function showAlarmList() {
    $('alarmForm').hidden = true;
    $('alarmListView').hidden = false;
    soundRequest = '';
  }

  function editAlarm(a) {
    soundRequest = '';
    $('alarmId').value = a?.id || 0;
    $('alarmFormTitle').textContent = a ? 'Edit alarm' : 'New alarm';
    $('alarmName').value = a?.name || '';
    $('alarmTime').value = String(a?.hour ?? 7).padStart(2, '0') + ':' + String(a?.minute ?? 0).padStart(2, '0');
    const days = a?.days || 'sat';
    editDays = { fri: days !== 'sat', sat: days !== 'fri' };
    renderDays();
    setDurationChoices(Math.min(a?.duration ?? 30, MAX_ALARM_SECONDS));
    $('alarmSound').value = a?.sound || '';
    $('alarmSoundName').textContent = a?.soundName || DEFAULT_SOUND_NAME;
    $('deleteAlarm').hidden = !a;
    $('alarmListView').hidden = true;
    $('alarmForm').hidden = false;
    editing = a;
  }

  $('dayFri').onclick = () => {
    editDays.fri = !editDays.fri;
    if (!editDays.fri && !editDays.sat) editDays.sat = true;
    renderDays();
  };
  $('daySat').onclick = () => {
    editDays.sat = !editDays.sat;
    if (!editDays.fri && !editDays.sat) editDays.fri = true;
    renderDays();
  };

  function alarmQuery(a) {
    return (
      '&id=' + a.id +
      '&enabled=' + (a.enabled ? '1' : '0') +
      '&hour=' + a.hour +
      '&minute=' + a.minute +
      '&days=' + a.days +
      '&name=' + encodeURIComponent(a.name || '') +
      '&duration=' + (a.duration ?? 30) +
      '&sound=' + encodeURIComponent(a.sound || '') +
      '&soundName=' + encodeURIComponent(a.soundName || DEFAULT_SOUND_NAME)
    );
  }

  async function changeAlarm(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw Error();
      await loadAlarm();
      return true;
    } catch (e) {
      toast('Could not save alarm changes.');
      return false;
    }
  }

  function alarmRow(a) {
    const row = document.createElement('div');
    row.className = 'alarm-item' + (a.enabled ? '' : ' off');

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'alarm-edit';
    const { time, period } = timeParts(a);
    const big = document.createElement('strong');
    big.textContent = time;
    const ampm = document.createElement('span');
    ampm.className = 'alarm-period';
    ampm.textContent = period;
    const detail = document.createElement('small');
    detail.textContent = [a.name, DAYS[a.days], durationLabel(a.duration ?? 30)].filter(Boolean).join(' · ');
    edit.append(big, ampm, detail);
    edit.setAttribute('aria-label', 'Edit ' + time + ' ' + period + ' alarm');
    edit.onclick = () => editAlarm(a);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = a.enabled;
    toggle.setAttribute('aria-label', (a.enabled ? 'Turn off ' : 'Turn on ') + time + ' ' + period + ' alarm');
    toggle.onchange = () => changeAlarm('/alarm?action=save' + alarmQuery({ ...a, enabled: toggle.checked }));

    row.append(edit, toggle);
    return row;
  }

  function relativeDay(ms) {
    const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((start(new Date(ms)) - start(new Date())) / (24 * 60 * MINUTE));
    return days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days';
  }

  async function loadAlarm() {
    if (!native) return;
    try {
      const response = await fetch('/alarm');
      if (!response.ok) return;
      alarmData = await response.json();
      const alarms = alarmData.alarms.slice().sort(byTime);
      const enabled = alarms.filter((a) => a.enabled).length;
      const dot = $('alarmDot');
      dot.hidden = !enabled;
      dot.classList.toggle('pending', !alarmData.allowed);
      dot.setAttribute('aria-label', enabled + ' alarms enabled' + (alarmData.allowed ? '' : ' · permission needed'));
      dot.title = enabled + ' alarms enabled';
      $('alarmPermission').hidden = alarmData.allowed || !enabled;
      $('alarmStatus').textContent =
        alarmData.error ||
        (!alarms.length
          ? 'No alarms yet'
          : !enabled
            ? 'All alarms are off'
            : alarmData.allowed && alarmData.next
              ? 'Next alarm ' + new Date(alarmData.next).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' }) + ' · ' + relativeDay(alarmData.next)
              : 'Allow Alarms & reminders so these can ring');
      $('alarmList').replaceChildren(...alarms.map(alarmRow));
    } catch (e) {}
  }

  $('alarmsButton').onclick = () => {
    showAlarmList();
    loadAlarm();
    $('alarms').showModal();
  };
  $('closeAlarms').onclick = () => $('alarms').close();
  $('newAlarm').onclick = () => editAlarm(null);
  $('cancelAlarm').onclick = showAlarmList;

  $('alarmForm').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('alarmTime').value.match(/^(\d{2}):(\d{2})$/);
    if (!t) return toast('Choose an alarm time.');
    const duration = validDuration($('alarmDuration').value);
    if (!duration) return toast('Choose an auto-stop time from 1 to ' + MAX_ALARM_SECONDS + ' seconds.');
    const a = {
      id: Number($('alarmId').value),
      // Editing keeps an alarm's on/off state; a new alarm starts on.
      enabled: editing ? editing.enabled : true,
      hour: Number(t[1]),
      minute: Number(t[2]),
      days: editDays.fri && editDays.sat ? 'both' : editDays.fri ? 'fri' : 'sat',
      name: $('alarmName').value.trim(),
      duration,
      sound: $('alarmSound').value,
      soundName: $('alarmSoundName').textContent,
    };
    if (await changeAlarm('/alarm?action=save' + alarmQuery(a))) {
      showAlarmList();
      const { time, period } = timeParts(a);
      toast(time + ' ' + period + ' alarm saved' + (a.enabled ? '' : ' (off)'));
    }
  };

  $('deleteAlarm').onclick = async () => {
    if (!editing) return;
    const { time, period } = timeParts(editing);
    if (await changeAlarm('/alarm?action=delete&id=' + editing.id)) {
      showAlarmList();
      toast(time + ' ' + period + ' alarm deleted');
    }
  };

  $('alarmPermission').onclick = () => fetch('/alarm?action=permission').catch(() => toast('Could not open Android alarm settings.'));

  $('chooseSound').onclick = () => {
    soundRequest = Date.now() + '-' + Math.random();
    fetch('/alarm?action=sound&uri=' + encodeURIComponent($('alarmSound').value) + '&token=' + encodeURIComponent(soundRequest)).catch(() =>
      toast('Could not open the sound picker.')
    );
  };
  $('defaultSound').onclick = () => {
    $('alarmSound').value = '';
    $('alarmSoundName').textContent = DEFAULT_SOUND_NAME;
    soundRequest = '';
  };
  window.soundSelected = (uri, title, token) => {
    if (token !== soundRequest || $('alarmForm').hidden) return;
    $('alarmSound').value = uri;
    $('alarmSoundName').textContent = title;
  };
  window.soundPickerFailed = () => toast('This phone does not provide an alarm sound picker.');

  $('testAlarm').onclick = () => {
    const duration = validDuration($('alarmDuration').value);
    if (!duration) return toast('Choose an auto-stop time from 1 to ' + MAX_ALARM_SECONDS + ' seconds.');
    fetch('/alarm?action=test&duration=' + duration + '&sound=' + encodeURIComponent($('alarmSound').value)).catch(() => {});
    toast('Testing · stops after ' + durationLabel(duration));
  };
  $('stopAlarm').onclick = () => fetch('/alarm?action=stop').catch(() => {});

  // ---- Show on TV (phone) ------------------------------------------------------------------

  // Settings the TV uses. Brightness and keep-awake belong to the phone.
  const TV_SETTINGS = ['zip', 'hour24', 'seconds', 'weather', 'celsius', 'nightDim', 'dimFrom', 'dimTo', 'dimLevel'];
  let castInfo = { state: 'off', device: '', message: '' };
  let castList = [];
  let castScanning = false;
  let castTimer;

  function castStatus() {
    try {
      return castBridge ? JSON.parse(castBridge.status()) : null;
    } catch (e) {
      return null;
    }
  }

  /** Everything the TV needs to run the clock on its own. Kept under Cast's 64 KB message limit. */
  function tvPayload() {
    const now = Date.now();
    const calendar = cache && { ...cache, weeks: cache.weeks.filter((w) => w.end.instant + DAY >= now) };
    const data = {
      v: 1,
      sentAt: now,
      settings: Object.fromEntries(TV_SETTINGS.map((key) => [key, settings[key]])),
      place: weatherPlace(),
      calendar,
      weather,
    };
    let json = JSON.stringify(data);
    // The TV fetches its own weather, so the forecast is the first thing to leave out if needed.
    if (json.length > 60000) json = JSON.stringify({ ...data, weather: null });
    while (json.length > 60000 && calendar?.weeks.length > 8) {
      calendar.weeks = calendar.weeks.slice(0, Math.ceil(calendar.weeks.length * 0.75));
      json = JSON.stringify({ ...data, weather: null });
    }
    return json;
  }

  function pushToTv(now = false) {
    if (!castBridge || (castInfo.state !== 'casting' && castInfo.state !== 'connecting')) return;
    clearTimeout(castTimer);
    castTimer = setTimeout(() => castBridge.update(tvPayload()), now ? 0 : 1500);
  }

  function renderTv() {
    const name = castInfo.device || 'the TV';
    const casting = castInfo.state === 'casting';
    $('tvButton').classList.toggle('on', casting);
    $('tvStatus').textContent =
      castInfo.state === 'connecting'
        ? 'Starting the clock on ' + name + '…'
        : casting
          ? 'Showing on ' + name + '. It keeps running when this phone is off.'
          : castInfo.state === 'lost'
            ? 'Lost the connection to ' + name + '. It may still be showing the clock.'
            : castInfo.message && castInfo.state === 'error'
              ? castInfo.message
              : castScanning
                ? 'Looking for TVs on this Wi-Fi…'
                : castList.length
                  ? 'Choose a TV'
                  : 'No TVs found. Make sure the TV is on and on the same Wi-Fi as this phone.';
    $('tvList').replaceChildren(
      ...castList.map((device) => {
        const button = document.createElement('button');
        button.className = 'tv-device' + (casting && device.name === castInfo.device ? ' on' : '');
        const strong = document.createElement('strong');
        strong.textContent = device.name;
        const small = document.createElement('small');
        small.textContent = casting && device.name === castInfo.device ? 'Showing the clock' : device.model || 'Chromecast';
        button.append(strong, small);
        button.onclick = () => {
          castInfo = { state: 'connecting', device: device.name, message: '' };
          castBridge.start(device.id);
          renderTv();
        };
        return button;
      })
    );
    $('tvStop').hidden = !(casting || castInfo.state === 'connecting' || castInfo.state === 'lost' || castStatus()?.remembered);
  }

  function scanForTvs() {
    castList = [];
    castScanning = true;
    castBridge.scan();
    renderTv();
  }

  window.castDevices = (list) => {
    castList = Array.isArray(list) ? list : [];
    renderTv();
  };
  window.castScanning = (on) => {
    castScanning = !!on;
    renderTv();
  };
  window.castState = (info) => {
    const was = castInfo.state;
    castInfo = { state: info?.state || 'off', device: info?.device || '', message: info?.message || '' };
    if (castInfo.state === 'casting' && was !== 'casting') {
      pushToTv(true);
      toast('Showing on ' + (castInfo.device || 'the TV'));
    }
    if (castInfo.state === 'connecting') pushToTv(true);
    renderTv();
  };

  $('tvButton').hidden = !castStatus()?.configured;
  $('tvButton').onclick = () => {
    $('tv').showModal();
    if (castInfo.state !== 'connecting') scanForTvs();
    renderTv();
  };
  $('tvScan').onclick = scanForTvs;
  $('tvStop').onclick = () => {
    castBridge.stop();
    toast('Stopped showing on ' + (castInfo.device || 'the TV'));
  };
  $('closeTv').onclick = () => {
    if (castBridge) castBridge.stopScan();
    $('tv').close();
  };

  // ---- TV receiver ---------------------------------------------------------------------------

  /** Data from the phone (see tvPayload). Checked like anything else read from storage. */
  window.tvData = (data) => {
    if (!tv || !data || typeof data !== 'object') return;
    const incoming = data.settings || {};
    for (const key of TV_SETTINGS) if (typeof incoming[key] === typeof settings[key]) settings[key] = incoming[key];
    if (!/^\d{5}$/.test(settings.zip)) settings.zip = '11213';
    if (!isTime(settings.dimFrom)) settings.dimFrom = '22:00';
    if (!isTime(settings.dimTo)) settings.dimTo = '07:00';
    settings.dimLevel = Math.min(1, Math.max(0.02, Number(settings.dimLevel) || 0.05));
    Object.assign(settings, { standby: true, scale: 1, autoLocation: false, coords: null });
    if (isPoint(data.place)) settings.zipCoords = { zip: settings.zip, lat: data.place.lat, lon: data.place.lon };
    save();
    const calendar = data.calendar;
    if (calendar?.zip === settings.zip && Array.isArray(calendar.weeks) && calendar.weeks.length && calendar.weeks.every(validWeek)) {
      cache = calendar;
      storeCache(calendar);
    } else {
      readCache();
    }
    if (ShabbosWeather.valid(data.weather) && (!weather || data.weather.fetchedAt > weather.fetchedAt)) {
      weather = data.weather;
      try {
        localStorage.setItem(WEATHER_KEY, JSON.stringify(weather));
      } catch (e) {}
    }
    displayPreferences();
    lastClock = '';
    tick();
    renderCache();
    renderDates();
    renderWeather();
    fitClock();
    if (!weather || Date.now() - (weather.fetchedAt || 0) > WEATHER_EVERY_MS) refreshWeather(true);
  };

  // ---- Start -------------------------------------------------------------------------------

  window.addEventListener('resize', fitClock);
  window.addEventListener('online', window.connectionReturned);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.appResumed();
  });
  if (document.fonts) document.fonts.ready.then(fitClock);

  async function start() {
    if (tv) {
      document.body.classList.add('tv');
      settings.standby = true;
      settings.scale = 1;
    }
    readCache();
    displayPreferences();
    renderCache();
    tick();
    fitClock();
    showControls();
    drift();
    loadAlarm();
    renderWeather();
    if (!cache) await loadSavedCalendar();
    refresh();
    if (settings.autoLocation && native) {
      const ask = !settings.locationAsked;
      settings.locationAsked = true;
      save();
      await locate(ask);
    }
    refreshWeather();
  }

  start();
  setInterval(tick, 1000);
  setInterval(drift, 60000);
  setInterval(() => {
    if (refreshDue()) refresh();
    refreshWeather();
    if (Date.now() - lastLocate >= LOCATE_EVERY_MS) locate();
  }, 30000);
})();
