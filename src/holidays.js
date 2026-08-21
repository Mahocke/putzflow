// holidays.js — Gesetzliche Feiertage in Deutschland, je Bundesland.
// Verallgemeinert aus Glanz & Gloria (dort fest auf NRW verdrahtet): Putzflow ist
// Multi-Tenant, jeder Mandant hat sein eigenes Bundesland (tenants.region).
//
// ⚠️ OHNE Bundesland gelten NUR die bundesweiten Feiertage. Früher fiel der Code
// still auf NRW zurück — ein Betrieb ohne Angabe bekam dann Fronleichnam als
// Zuschlagstag, obwohl das in zehn Bundesländern kein Feiertag ist. Ein plausibel
// aussehender falscher Wert ist schlimmer als ein fehlender: Er fällt niemandem auf.
// Die Oberfläche muss stattdessen sichtbar machen, dass die Angabe fehlt.

const REGIONS = ['BW','BY','BE','BB','HB','HH','HE','MV','NI','NW','RP','SL','SN','ST','SH','TH'];

// Oster-Sonntag (Gauss/Meeus) -> Basis fuer die beweglichen Feiertage
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

// Buss- und Bettag (nur SN): der Mittwoch VOR dem 23. November.
function bussUndBettag(year) {
  let d = new Date(Date.UTC(year, 10, 22));           // 22.11.
  while (d.getUTCDay() !== 3) d = addDays(d, -1);     // zurueck bis Mittwoch
  return d;
}

// Feiertage eines Jahres fuer ein Bundesland -> Map datum -> name
function holidayMap(year, region) {
  // Unbekannt bleibt unbekannt: `r` passt dann zu keiner Regionsliste, also
  // überleben nur die bundesweiten Tage.
  const r = REGIONS.includes(region) ? region : null;
  const e = easterSunday(year);
  const out = new Map();
  const put = (date, name, regions) => {
    if (regions && !regions.includes(r)) return;
    out.set(typeof date === 'string' ? date : iso(date), name);
  };

  // Bundesweit
  put(`${year}-01-01`, 'Neujahr');
  put(addDays(e, -2), 'Karfreitag');
  put(addDays(e, 1), 'Ostermontag');
  put(`${year}-05-01`, 'Tag der Arbeit');
  put(addDays(e, 39), 'Christi Himmelfahrt');
  put(addDays(e, 50), 'Pfingstmontag');
  put(`${year}-10-03`, 'Tag der Deutschen Einheit');
  put(`${year}-12-25`, '1. Weihnachtstag');
  put(`${year}-12-26`, '2. Weihnachtstag');

  // Regional
  put(`${year}-01-06`, 'Heilige Drei Könige', ['BW','BY','ST']);
  put(`${year}-03-08`, 'Internationaler Frauentag', ['BE','MV']);
  put(e, 'Ostersonntag', ['BB']);
  put(addDays(e, 49), 'Pfingstsonntag', ['BB']);
  put(addDays(e, 60), 'Fronleichnam', ['BW','BY','HE','NW','RP','SL']);
  put(`${year}-08-15`, 'Mariä Himmelfahrt', ['SL']);
  put(`${year}-09-20`, 'Weltkindertag', ['TH']);
  put(`${year}-10-31`, 'Reformationstag', ['BB','HB','HH','MV','NI','SN','ST','SH','TH']);
  put(`${year}-11-01`, 'Allerheiligen', ['BW','BY','NW','RP','SL']);
  put(bussUndBettag(year), 'Buß- und Bettag', ['SN']);

  return out;
}

const _cache = new Map();                              // "2026|NW" -> Map
function mapFor(year, region) {
  const key = `${year}|${region}`;
  if (!_cache.has(key)) _cache.set(key, holidayMap(year, region));
  return _cache.get(key);
}

function isHoliday(dateStr, region) {
  return mapFor(parseInt(dateStr.slice(0, 4), 10), region).has(dateStr);
}
function holidayName(dateStr, region = 'NW') {
  return mapFor(parseInt(dateStr.slice(0, 4), 10), region).get(dateStr) || null;
}
function isWeekend(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();   // 0=So, 6=Sa
  return dow === 0 || dow === 6;
}

module.exports = { REGIONS, easterSunday, holidayMap, isHoliday, holidayName, isWeekend };
