// billing.js — Vergütung, Abrechnungsperiode, Minijob-Grenze.
//
// Verallgemeinerung gegenüber Glanz & Gloria: dort waren Tarife Konstanten
// (22,50 € / 30 € / 25 €). Putzflow rechnet nach einer *Regel*, die pro Mandant,
// pro Objekt und pro Putzkraft hinterlegt werden kann:
//
//   mode          'flat'   = Pauschale je Reinigung
//                 'hourly' = Stundenlohn × erfasster Zeit
//   base_cents    Pauschale je Job bzw. Stundensatz
//   premium_on    'weekend_holiday' | 'weekend' | 'holiday' | 'never'
//   premium_mode  'rate'    = premium_cents ersetzt base_cents (G&G-Muster: 22,50 -> 30)
//                 'percent' = base_cents + premium_percent %
//                 'none'    = kein Zuschlag
//
// Ehrliche Erfassung wie im Original: echte Zeiten, echte Beträge, KEINE Deckelung.
// Die Minijobgrenze wird angezeigt und gewarnt, aber nie stillschweigend gekappt.

const { isHoliday, isWeekend } = require('./holidays');

const PERIOD_START_DAY = 16;                    // Periode läuft 16. -> 15.

// --- Geringfügigkeitsgrenze („Minijob-Grenze") ------------------------------
// ⚠️ KEINE feste Zahl. Seit Oktober 2022 ist sie dynamisch an den Mindestlohn
// gekoppelt: Mindestlohn × 130 ÷ 3, aufgerundet auf volle Euro (130 = 10 Wochen-
// stunden über 13 Wochen). Sie steigt also mit jeder Mindestlohnerhöhung.
//
// ⚠️ PFLEGEHINWEIS: Diese Tabelle muss jährlich ergänzt werden. Fehlt ein Jahr,
// wird der jüngste bekannte Wert genommen — die Grenze wäre dann zu niedrig
// angesetzt, es würde also zu früh gewarnt (die harmlose Richtung).
const MINIJOB_LIMIT_BY_YEAR = {
  2024: 53800,   // Mindestlohn 12,41 €
  2025: 55600,   // Mindestlohn 12,82 €
  2026: 60300,   // Mindestlohn 13,90 €
  2027: 63300,   // Mindestlohn 14,60 € (beschlossen)
};
const DEFAULT_MINIJOB_LIMIT_CENTS = MINIJOB_LIMIT_BY_YEAR[2026];

// Aus einem Mindestlohn die Grenze rechnen — für künftige Jahre, sobald bekannt.
function limitFromMindestlohnCents(mindestlohnCents) {
  return Math.ceil(mindestlohnCents * 130 / 3 / 100) * 100;
}

// Grenze für das Jahr, in dem die Periode BEGINNT. Die gesetzliche Grenze gilt je
// Kalendermonat; unsere Periode läuft über den Monatswechsel, deshalb ist eine
// Wahl nötig. Der Periodenbeginn ist die vorsichtigere: über den Jahreswechsel
// hinweg wird eher zu früh gewarnt als zu spät.
// overrideCents > 0 schlägt alles — für Mandanten mit abweichender Vereinbarung.
function minijobLimitCents(dateStr, overrideCents = 0) {
  if (overrideCents > 0) return overrideCents;
  const year = parseInt(String(dateStr).slice(0, 4), 10);
  if (MINIJOB_LIMIT_BY_YEAR[year]) return MINIJOB_LIMIT_BY_YEAR[year];
  const known = Object.keys(MINIJOB_LIMIT_BY_YEAR).map(Number).sort((a, b) => a - b);
  return MINIJOB_LIMIT_BY_YEAR[year < known[0] ? known[0] : known[known.length - 1]];
}

// --- Mindestlohn ------------------------------------------------------------
// ⚠️ § 1 MiLoG: Der Mindestlohn gilt JE ARBEITSSTUNDE und ist unabdingbar. Eine
// Pauschale je Reinigung darf ihn nicht unterschreiten. Maßgeblich ist nach der
// Rechtsprechung das Verhältnis von Gesamtvergütung zu Gesamtstunden im
// Abrechnungszeitraum — nicht der einzelne Auftrag. Liegt es darunter, muss der
// Arbeitgeber aufstocken; ein Verzicht der Beschäftigten ist unwirksam.
//
// ⚠️ Tabelle jährlich pflegen — dieselbe Quelle wie die Minijob-Grenze.
const MINDESTLOHN_BY_YEAR = {
  2024: 1241,
  2025: 1282,
  2026: 1390,
  2027: 1460,   // beschlossen
};

function mindestlohnCents(dateStr) {
  const jahr = parseInt(String(dateStr).slice(0, 4), 10);
  if (MINDESTLOHN_BY_YEAR[jahr]) return MINDESTLOHN_BY_YEAR[jahr];
  const bekannt = Object.keys(MINDESTLOHN_BY_YEAR).map(Number).sort((a, b) => a - b);
  return MINDESTLOHN_BY_YEAR[jahr < bekannt[0] ? bekannt[0] : bekannt[bekannt.length - 1]];
}

// Effektiver Stundenlohn. Wird für den ZEITRAUM ausgewertet, nicht je Auftrag:
// Eine Reinigung, die lange dauert, gleicht sich mit kurzen aus. Ein Wert je
// Position stand zwischenzeitlich im Stundenzettel — das war irreführend, weil
// dort einzelne Zeilen unter dem Mindestlohn stehen können, ohne dass ein Verstoß
// vorliegt. Ohne erfasste Zeit nicht berechenbar: null, nicht 0.
function stundenlohnCents(cents, minutes) {
  return minutes > 0 ? Math.round(cents * 60 / minutes) : null;
}

/**
 * Mindestlohn-Prüfung für einen Abrechnungszeitraum.
 * Nur Positionen MIT erfasster Zeit gehen ein: Ohne Zeit lässt sich der
 * Stundenlohn nicht bestimmen, und sie mitzuzählen würde das Ergebnis
 * schönrechnen (Geld ohne Stunden hebt den Schnitt).
 */
function mindestlohnPruefung(items, dateStr) {
  const grenze = mindestlohnCents(dateStr);
  const mitZeit = (items || []).filter(i => i.minutes > 0);
  const minuten = mitZeit.reduce((a, i) => a + i.minutes, 0);
  const betrag = mitZeit.reduce((a, i) => a + i.cents, 0);
  const ohneZeit = (items || []).length - mitZeit.length;

  if (!minuten) {
    return { grenze_cents: grenze, minuten: 0, betrag_cents: 0, effektiv_cents: null,
             soll_cents: 0, fehlbetrag_cents: 0, ohne_zeit: ohneZeit, unterschritten: false };
  }
  const effektiv = Math.round(betrag * 60 / minuten);
  const soll = Math.ceil(grenze * minuten / 60);
  const fehlbetrag = Math.max(0, soll - betrag);
  return {
    grenze_cents: grenze, minuten, betrag_cents: betrag, effektiv_cents: effektiv,
    soll_cents: soll, fehlbetrag_cents: fehlbetrag, ohne_zeit: ohneZeit,
    unterschritten: fehlbetrag > 0,
  };
}

// --- Testzeitraum -----------------------------------------------------------
// Sechs Wochen, aufgerundet auf das Ende der dann laufenden Abrechnungsperiode.
//
// Warum aufrunden: Der Nutzen zeigt sich erst in einer VOLLSTÄNDIGEN Periode —
// Zeiten erfassen, abzeichnen lassen, an die Lohnbuchhaltung schicken. Harte
// 42 Tage können mitten drin enden; dann entscheidet der Kunde über etwas, das er
// nie zu Ende erlebt hat. Nebenbei fällt das Ende so immer auf einen
// Periodenwechsel — den Tag, an dem er ohnehin auf den Zettel schaut.
//
// Dass mindestens eine volle Periode drinliegt, ist keine Hoffnung, sondern folgt
// aus der Rechnung: Die Periode, die den 42. Tag enthält, beginnt frühestens
// 30 Tage davor — also nach der Anmeldung. Ergibt 42 bis 72 Tage.
function trialEnd(startDate, startDay, tage = 42) {
  const ziel = new Date(new Date(startDate + 'T12:00:00Z').getTime() + tage * 86400000)
    .toISOString().slice(0, 10);
  return periodOf(ziel, startDay).end;
}

const DEFAULT_RULE = Object.freeze({
  mode: 'flat',
  base_cents: 2250,
  premium_on: 'weekend_holiday',
  premium_mode: 'rate',
  premium_cents: 3000,
  premium_percent: 0,
});

// --- Zuschlagsfrage --------------------------------------------------------
function isPremiumDay(dateStr, region, premiumOn = 'weekend_holiday') {
  switch (premiumOn) {
    case 'never':   return false;
    case 'weekend': return isWeekend(dateStr);
    case 'holiday': return isHoliday(dateStr, region);
    default:        return isWeekend(dateStr) || isHoliday(dateStr, region);
  }
}

// --- Kernrechnung ----------------------------------------------------------
// minutes wird nur im Stundenlohn-Modus gebraucht.
function payCents({ rule, dateStr, minutes = 0, region = 'NW' }) {
  const r = { ...DEFAULT_RULE, ...(rule || {}) };
  const premium = isPremiumDay(dateStr, region, r.premium_on);

  if (r.mode === 'hourly') {
    let rate = r.base_cents;
    if (premium) {
      if (r.premium_mode === 'rate' && r.premium_cents) rate = r.premium_cents;
      else if (r.premium_mode === 'percent' && r.premium_percent) rate = rate * (1 + r.premium_percent / 100);
    }
    return Math.round(rate * (Math.max(0, minutes) / 60));
  }

  // 'flat' — Pauschale je Reinigung, unabhängig von der erfassten Zeit
  let cents = r.base_cents;
  if (premium) {
    if (r.premium_mode === 'rate' && r.premium_cents) cents = r.premium_cents;
    else if (r.premium_mode === 'percent' && r.premium_percent) cents = cents * (1 + r.premium_percent / 100);
  }
  return Math.round(cents);
}

// --- Abrechnungsperiode ----------------------------------------------------
// Frei wählbar je Mandant (tenants.period_start_day). Default bleibt der 16.:
// Der Zeitraum 16.–15. hat sich bewährt, weil die Lohnbuchhaltung um den 20.
// melden muss — die Periode ist dann schon abgeschlossen und abgezeichnet.
// Wer lieber den Kalendermonat abrechnet, setzt 1.
function pad(n) { return String(n).padStart(2, '0'); }

// Auf 1–28 begrenzt: ab dem 29. gäbe es Monate ohne diesen Tag (Februar), die
// Periodengrenze wäre dann nicht mehr eindeutig.
function normalizeStartDay(day) {
  const d = parseInt(day, 10);
  if (!Number.isFinite(d)) return PERIOD_START_DAY;
  return Math.min(28, Math.max(1, d));
}

// Liefert {start, end, key, label, start_day} der Periode, in die dateStr fällt.
function periodOf(dateStr, startDay = PERIOD_START_DAY) {
  const sd = normalizeStartDay(startDay);
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);

  // Ab dem Stichtag beginnt die Periode in DIESEM Monat, davor im Vormonat.
  let sy = y, sm = m;
  if (d < sd) { sm = m - 1; if (sm === 0) { sm = 12; sy = y - 1; } }

  // Ende = ein Tag vor dem nächsten Stichtag. Über Datumsarithmetik statt
  // (sd - 1), sonst käme bei sd = 1 der „0. des Monats" heraus.
  let ey = sy, em = sm + 1;
  if (em === 13) { em = 1; ey = sy + 1; }
  const start = `${sy}-${pad(sm)}-${pad(sd)}`;
  const end = new Date(Date.UTC(ey, em - 1, sd) - 86400000).toISOString().slice(0, 10);

  // Label aus dem echten Ende ableiten: bei Stichtag 1 liegt es im Startmonat
  // ("07/2026"), sonst im Folgemonat ("07/2026 → 08/2026").
  const endLabel = `${end.slice(5, 7)}/${end.slice(0, 4)}`;
  const startLabel = `${pad(sm)}/${sy}`;
  const label = startLabel === endLabel ? startLabel : `${startLabel} → ${endLabel}`;

  return { start, end, key: start, label, start_day: sd };
}

function nextPeriod(period, startDay = period && period.start_day) {
  const end = new Date(period.end + 'T12:00:00Z');
  return periodOf(new Date(end.getTime() + 86400000).toISOString().slice(0, 10), startDay);
}

// --- Zeiterfassung ---------------------------------------------------------
// Minuten aus work_sessions (nur abgeschlossene Sessions zählen).
function minutesWorked(sessions) {
  let ms = 0;
  for (const s of sessions || []) {
    if (!s.ended_at) continue;
    ms += new Date(s.ended_at + 'Z').getTime() - new Date(s.started_at + 'Z').getTime();
  }
  return Math.max(0, Math.round(ms / 60000));
}

// --- Minijob-Ampel ---------------------------------------------------------
function minijobStatus(cents, limitCents = DEFAULT_MINIJOB_LIMIT_CENTS) {
  const pct = limitCents > 0 ? cents / limitCents : 0;
  return {
    cents,
    limit_cents: limitCents,
    remaining_cents: Math.max(0, limitCents - cents),
    level: pct >= 1 ? 'over' : pct >= 0.85 ? 'warn' : 'ok',
  };
}

function euro(cents) { return (cents / 100).toFixed(2).replace('.', ',') + ' €'; }

module.exports = {
  DEFAULT_RULE, DEFAULT_MINIJOB_LIMIT_CENTS, PERIOD_START_DAY, MINIJOB_LIMIT_BY_YEAR,
  isPremiumDay, payCents, periodOf, nextPeriod, normalizeStartDay, trialEnd,
  MINDESTLOHN_BY_YEAR, mindestlohnCents, stundenlohnCents, mindestlohnPruefung,
  minijobLimitCents, limitFromMindestlohnCents,
  minutesWorked, minijobStatus, euro,
};
