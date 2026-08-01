// zeit.js — Terminzeiten und die Umrechnung nach UTC.
//
// Warum überhaupt Uhrzeiten: Ein Kalender mit drei ganztägigen Einträgen am selben
// Tag sagt der Reinigungskraft nichts. Deshalb bekommt jeder zugesagte Termin eine
// Startzeit — die erste Reinigung des Tages zur Check-out-Zeit, jede weitere im
// Takt danach. Dasselbe Muster wie in Glanz & Gloria (dort 11/12/13 Uhr).
//
// Die Zeiten sind lokale Zeit (Europe/Berlin). Für den Kalender müssen sie nach UTC,
// und zwar mit dem Versatz, der AN DIESEM TAG gilt — im Sommer +2, im Winter +1.
// Ein fester Versatz wäre ein halbes Jahr lang falsch.

function pad(n) { return String(n).padStart(2, '0'); }

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function formatHHMM(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Versatz der Zone gegenüber UTC in Minuten, für genau diesen Zeitpunkt.
function zoneOffsetMinutes(utcDate, timeZone = 'Europe/Berlin') {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map(x => [x.type, x.value]));
  const alsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (alsUtc - utcDate.getTime()) / 60000;
}

// Lokale Wandzeit -> echter UTC-Zeitpunkt. Zwei Runden, weil der erste Versatz
// an den Umstellungstagen danebenliegen kann.
function localToUtc(dateStr, hhmm, timeZone = 'Europe/Berlin') {
  const naiv = new Date(`${dateStr}T${hhmm}:00Z`);
  const o1 = zoneOffsetMinutes(naiv, timeZone);
  let utc = new Date(naiv.getTime() - o1 * 60000);
  const o2 = zoneOffsetMinutes(utc, timeZone);
  if (o2 !== o1) utc = new Date(naiv.getTime() - o2 * 60000);
  return utc;
}

// Format für iCalendar: 20260726T090000Z
function icsStamp(utcDate) {
  return utcDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const SPAETESTENS = 22 * 60;   // danach wird nicht mehr geplant

/**
 * Plant den Zeitschlitz einer Reinigung in den Tag einer Kraft.
 *
 * Berücksichtigt die FAHRZEIT: Liegt die nächste Unterkunft an einem anderen Ort,
 * kommt ein Puffer dazu. Mehrere Wohnungen unter einer Anschrift (der Normalfall
 * bei kleinen Vermietern) laufen dagegen direkt hintereinander weg.
 *
 * Lücken werden gefüllt, aber nur wenn die Fahrzeit zu BEIDEN Nachbarn passt —
 * sonst entstünde ein Plan, den niemand einhalten kann.
 *
 * @param {{time:string, ort:string}[]} belegt  bestehende Termine der Kraft an dem Tag
 * @param {object} o
 * @param {string} o.basis     frühester Start (Check-out-Zeit)
 * @param {number} o.takt      Minuten je Reinigung
 * @param {number} o.fahrzeit  Puffer bei Ortswechsel
 * @param {string} o.ort       Ort der neuen Reinigung
 */
function planeSlot(belegt, { basis = '11:00', takt = 60, fahrzeit = 0, ort = null } = {}) {
  const frueheste = parseHHMM(basis);
  if (frueheste == null) return '11:00';

  const liste = (belegt || [])
    .map(b => ({ t: parseHHMM(b.time), ort: b.ort == null ? null : String(b.ort) }))
    .filter(b => b.t != null)
    .sort((a, b) => a.t - b.t);

  const wechsel = (a, b) => (a !== b ? fahrzeit : 0);

  for (let i = 0; i <= liste.length; i++) {
    const davor = liste[i - 1];
    const danach = liste[i];

    let start = davor ? davor.t + takt + wechsel(davor.ort, ort) : frueheste;
    if (start < frueheste) start = frueheste;
    if (start > SPAETESTENS) return formatHHMM(SPAETESTENS);

    if (!danach) return formatHHMM(start);

    // Passt es zwischen davor und danach — inklusive Rückfahrt zum nächsten Ort?
    const spaetestesEnde = danach.t - wechsel(ort, danach.ort);
    if (start + takt <= spaetestesEnde) return formatHHMM(start);
  }
  return formatHHMM(frueheste);
}

// Alte Signatur (nur Uhrzeiten, keine Orte) — bleibt für einfache Fälle.
function naechsterSlot(belegt, basis = '11:00', takt = 60) {
  return planeSlot((belegt || []).map(t => ({ time: t, ort: null })), { basis, takt, fahrzeit: 0, ort: null });
}

module.exports = { parseHHMM, formatHHMM, zoneOffsetMinutes, localToUtc, icsStamp, naechsterSlot, planeSlot };
