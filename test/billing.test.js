// Tests der Rechen-Kerne: Feiertage, Vergütung, Abrechnungsperiode.
// Ausführen: npm test

const test = require('node:test');
const assert = require('node:assert');

const { isHoliday, holidayName, isWeekend } = require('../src/holidays');
const { payCents, periodOf, nextPeriod, minutesWorked, minijobStatus, isPremiumDay,
        minijobLimitCents, limitFromMindestlohnCents, trialEnd,
        MINDESTLOHN_BY_YEAR, MINIJOB_LIMIT_BY_YEAR } = require('../src/billing');

test('Feiertage: bundesweite und regionale', () => {
  assert.equal(isHoliday('2026-01-01', 'NW'), true, 'Neujahr');
  assert.equal(isHoliday('2026-04-03', 'NW'), true, 'Karfreitag 2026');
  assert.equal(isHoliday('2026-06-04', 'NW'), true, 'Fronleichnam 2026 in NRW');
  assert.equal(isHoliday('2026-06-04', 'HH'), false, 'Fronleichnam nicht in Hamburg');
  assert.equal(isHoliday('2026-10-31', 'NI'), true, 'Reformationstag in Niedersachsen');
  assert.equal(isHoliday('2026-10-31', 'NW'), false, 'Reformationstag nicht in NRW');
  assert.equal(holidayName('2026-11-01', 'NW'), 'Allerheiligen');
});

test('Buß- und Bettag nur in Sachsen, Mittwoch vor dem 23.11.', () => {
  assert.equal(isHoliday('2026-11-18', 'SN'), true);
  assert.equal(isHoliday('2026-11-18', 'NW'), false);
});

test('Wochenende', () => {
  assert.equal(isWeekend('2026-07-25'), true, 'Samstag');
  assert.equal(isWeekend('2026-07-26'), true, 'Sonntag');
  assert.equal(isWeekend('2026-07-27'), false, 'Montag');
});

test('Pauschale: Werktag vs. Zuschlagstag (G&G-Muster 22,50 / 30)', () => {
  const rule = { mode: 'flat', base_cents: 2250, premium_on: 'weekend_holiday', premium_mode: 'rate', premium_cents: 3000 };
  assert.equal(payCents({ rule, dateStr: '2026-07-27', region: 'NW' }), 2250, 'Montag');
  assert.equal(payCents({ rule, dateStr: '2026-07-26', region: 'NW' }), 3000, 'Sonntag');
  assert.equal(payCents({ rule, dateStr: '2026-06-04', region: 'NW' }), 3000, 'Fronleichnam NRW');
  assert.equal(payCents({ rule, dateStr: '2026-06-04', region: 'HH' }), 2250, 'kein Feiertag in HH');
});

test('Pauschale ignoriert die erfasste Zeit', () => {
  const rule = { mode: 'flat', base_cents: 2250, premium_on: 'never' };
  assert.equal(payCents({ rule, dateStr: '2026-07-27', minutes: 300 }), 2250);
});

test('Stundenlohn mit Prozent-Zuschlag', () => {
  const rule = { mode: 'hourly', base_cents: 1500, premium_on: 'weekend_holiday', premium_mode: 'percent', premium_percent: 20 };
  assert.equal(payCents({ rule, dateStr: '2026-07-27', minutes: 90 }), 2250, '1,5 h × 15 €');
  assert.equal(payCents({ rule, dateStr: '2026-07-26', minutes: 90 }), 2700, '1,5 h × 18 €');
});

test('Stundenlohn mit Ersatz-Satz', () => {
  const rule = { mode: 'hourly', base_cents: 1500, premium_on: 'weekend', premium_mode: 'rate', premium_cents: 2000 };
  assert.equal(payCents({ rule, dateStr: '2026-07-26', minutes: 120 }), 4000);
});

test('premium_on steuert, wann der Zuschlag greift', () => {
  assert.equal(isPremiumDay('2026-06-04', 'NW', 'holiday'), true);
  assert.equal(isPremiumDay('2026-06-04', 'NW', 'weekend'), false);
  assert.equal(isPremiumDay('2026-07-26', 'NW', 'holiday'), false);
  assert.equal(isPremiumDay('2026-07-26', 'NW', 'never'), false);
});

test('Abrechnungsperiode: Standard läuft vom 16. bis zum 15.', () => {
  assert.deepEqual(periodOf('2026-07-20'),
    { start: '2026-07-16', end: '2026-08-15', key: '2026-07-16', label: '07/2026 → 08/2026', start_day: 16 });
  assert.equal(periodOf('2026-07-15').start, '2026-06-16', 'der 15. gehört zur Vorperiode');
  assert.equal(periodOf('2026-07-16').start, '2026-07-16', 'der 16. beginnt die neue');
  assert.equal(periodOf('2026-01-05').start, '2025-12-16', 'Jahreswechsel rückwärts');
  assert.equal(periodOf('2026-12-20').end, '2027-01-15', 'Jahreswechsel vorwärts');
});

test('Abrechnungsperiode ist frei wählbar', () => {
  // Kalendermonat (Stichtag 1) — hier hätte (start_day - 1) den „0." erzeugt
  assert.equal(periodOf('2026-07-20', 1).start, '2026-07-01');
  assert.equal(periodOf('2026-07-20', 1).end, '2026-07-31', '31-Tage-Monat');
  assert.equal(periodOf('2026-07-20', 1).label, '07/2026', 'Kalendermonat braucht keinen Pfeil');
  assert.equal(periodOf('2026-07-20', 16).label, '07/2026 → 08/2026');
  assert.equal(periodOf('2026-02-10', 1).end, '2026-02-28', 'Februar');
  assert.equal(periodOf('2028-02-10', 1).end, '2028-02-29', 'Schaltjahr');

  // Stichtag 20
  assert.equal(periodOf('2026-07-19', 20).start, '2026-06-20', 'der 19. gehört noch zur Vorperiode');
  assert.equal(periodOf('2026-07-20', 20).start, '2026-07-20');
  assert.equal(periodOf('2026-07-20', 20).end, '2026-08-19');

  // Stichtag 28 = obere Grenze, in jedem Monat vorhanden
  assert.equal(periodOf('2026-01-30', 28).end, '2026-02-27');
});

test('Stichtag wird auf 1–28 begrenzt', () => {
  assert.equal(periodOf('2026-07-20', 31).start_day, 28, 'ab dem 29. wäre die Grenze im Februar uneindeutig');
  assert.equal(periodOf('2026-07-20', 0).start_day, 1);
  assert.equal(periodOf('2026-07-20', -5).start_day, 1);
  assert.equal(periodOf('2026-07-20', undefined).start_day, 16, 'Default bleibt der 16.');
});

test('nextPeriod springt genau eine Periode weiter und behält den Stichtag', () => {
  assert.equal(nextPeriod(periodOf('2026-07-20')).start, '2026-08-16');
  const p1 = periodOf('2026-07-20', 1);
  assert.equal(nextPeriod(p1).start, '2026-08-01');
  assert.equal(nextPeriod(p1).start_day, 1);
});

test('minutesWorked zählt nur beendete Sessions', () => {
  assert.equal(minutesWorked([
    { started_at: '2026-07-20 09:00:00', ended_at: '2026-07-20 10:30:00' },
    { started_at: '2026-07-20 12:00:00', ended_at: null },
  ]), 90);
  assert.equal(minutesWorked([]), 0);
});

test('Minijob-Ampel', () => {
  const L = 60300;                                   // gesetzliche Grenze 2026
  assert.equal(minijobStatus(10000, L).level, 'ok');
  assert.equal(minijobStatus(52000, L).level, 'warn', '86 % der Grenze');
  assert.equal(minijobStatus(60300, L).level, 'over');
  assert.equal(minijobStatus(45000, L).remaining_cents, 15300);
});

test('Minijob-Grenze ist jahresabhängig, nicht fix 600 €', () => {
  assert.equal(minijobLimitCents('2025-06-01'), 55600);
  assert.equal(minijobLimitCents('2026-07-16'), 60300, '2026: 603 €');
  assert.equal(minijobLimitCents('2027-01-01'), 63300, '2027: 633 €');
});

test('Grenze: Mandanten-Override schlägt die gesetzliche', () => {
  assert.equal(minijobLimitCents('2026-07-16', 50000), 50000);
  assert.equal(minijobLimitCents('2026-07-16', 0), 60300, '0 = automatisch');
});

test('Grenze: unbekannte Jahre fallen auf den nächstgelegenen bekannten Wert', () => {
  assert.equal(minijobLimitCents('2099-01-01'), 63300, 'nach der Tabelle: jüngster Wert');
  assert.equal(minijobLimitCents('2001-01-01'), 53800, 'vor der Tabelle: ältester Wert');
});

test('Formel Mindestlohn × 130 ÷ 3, aufgerundet', () => {
  assert.equal(limitFromMindestlohnCents(1390), 60300, '13,90 € → 603 €');
  assert.equal(limitFromMindestlohnCents(1460), 63300, '14,60 € → 633 €');
  assert.equal(limitFromMindestlohnCents(1282), 55600, '12,82 € → 556 €');
});

const { mindestlohnCents, stundenlohnCents, mindestlohnPruefung } = require('../src/billing');

test('Mindestlohn ist jahresabhängig', () => {
  assert.equal(mindestlohnCents('2025-06-01'), 1282);
  assert.equal(mindestlohnCents('2026-07-16'), 1390);
  assert.equal(mindestlohnCents('2027-01-01'), 1460);
});

test('Effektiver Stundenlohn aus Pauschale und Zeit', () => {
  assert.equal(stundenlohnCents(2250, 120), 1125, '22,50 € für 2 h = 11,25 €/h');
  assert.equal(stundenlohnCents(3000, 90), 2000, '30 € für 1,5 h = 20 €/h');
  assert.equal(stundenlohnCents(2250, 0), null, 'ohne Zeit nicht berechenbar — null, nicht 0');
});

test('Pauschale unter Mindestlohn wird erkannt und beziffert', () => {
  // 2 h für 22,50 € = 11,25 €/h, Mindestlohn 2026 = 13,90 €/h
  const p = mindestlohnPruefung([{ minutes: 120, cents: 2250 }], '2026-07-16');
  assert.equal(p.unterschritten, true);
  assert.equal(p.effektiv_cents, 1125);
  assert.equal(p.soll_cents, 2780, '2 h × 13,90 €');
  assert.equal(p.fehlbetrag_cents, 530, 'aufzustocken sind 5,30 €');
});

test('Auskömmliche Pauschale löst keine Aufstockung aus', () => {
  // 1 h für 22,50 € = 22,50 €/h
  const p = mindestlohnPruefung([{ minutes: 60, cents: 2250 }], '2026-07-16');
  assert.equal(p.unterschritten, false);
  assert.equal(p.fehlbetrag_cents, 0);
});

test('Maßgeblich ist der Zeitraum, nicht der einzelne Auftrag', () => {
  // Eine schlecht bezahlte und eine gut bezahlte Position gleichen sich aus.
  const p = mindestlohnPruefung([
    { minutes: 120, cents: 2250 },   // 11,25 €/h — für sich zu wenig
    { minutes: 60, cents: 3000 },    // 30,00 €/h
  ], '2026-07-16');
  assert.equal(p.effektiv_cents, 1750, '52,50 € auf 3 h');
  assert.equal(p.unterschritten, false, 'im Zeitraum eingehalten');
});

test('Positionen ohne Zeit fließen NICHT in die Prüfung ein', () => {
  // Geld ohne Stunden würde den Schnitt künstlich heben und einen Verstoß verdecken.
  const p = mindestlohnPruefung([
    { minutes: 120, cents: 2250 },
    { minutes: 0, cents: 5000 },
  ], '2026-07-16');
  assert.equal(p.effektiv_cents, 1125, 'nur die Position mit Zeit zählt');
  assert.equal(p.unterschritten, true);
  assert.equal(p.ohne_zeit, 1);
});

test('Ohne jede erfasste Zeit ist nichts prüfbar', () => {
  const p = mindestlohnPruefung([{ minutes: 0, cents: 2250 }], '2026-07-16');
  assert.equal(p.effektiv_cents, null);
  assert.equal(p.unterschritten, false);
  assert.equal(p.ohne_zeit, 1);
});

test('Matthias-Fall: eine lange Reinigung kippt den Zeitraum nicht', () => {
  // 1× 5 Stunden für 22,50 € (allein 4,50 €/h) plus 10× 50 Minuten für je 22,50 €.
  const items = [{ minutes: 300, cents: 2250 }];
  for (let i = 0; i < 10; i++) items.push({ minutes: 50, cents: 2250 });

  assert.equal(mindestlohnPruefung([items[0]], '2026-07-16').unterschritten, true,
    'die lange Reinigung allein läge unter dem Mindestlohn');
  const p = mindestlohnPruefung(items, '2026-07-16');
  assert.equal(p.unterschritten, false, 'im Zeitraum ist der Mindestlohn eingehalten');
  assert.equal(p.fehlbetrag_cents, 0, 'also keine Aufstockung');
});

// --- Testzeitraum ---------------------------------------------------------
test('Testende fällt immer auf ein Periodenende', () => {
  assert.equal(trialEnd('2026-07-26', 16), '2026-09-15');
  assert.equal(trialEnd('2026-08-14', 16), '2026-10-15');
  assert.equal(trialEnd('2026-09-01', 16), '2026-10-15');
});

// Der eigentliche Zweck: Der Kunde soll einen VOLLEN Durchlauf erlebt haben,
// bevor er entscheidet. Die Periode, in der der Test endet, muss also nach der
// Anmeldung begonnen haben.
test('im Testzeitraum liegt immer eine vollständig miterlebte Periode', () => {
  for (const startDay of [1, 16, 20]) {
    for (let i = 0; i < 370; i++) {
      const tag = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      const ende = trialEnd(tag, startDay);
      const letzte = periodOf(ende, startDay);
      assert.ok(letzte.start > tag,
                `${tag} (Start ${startDay}.): Periode ${letzte.start} begann nicht nach der Anmeldung`);
      const dauer = Math.round((new Date(ende) - new Date(tag)) / 86400000);
      assert.ok(dauer >= 42 && dauer <= 72, `${tag}: ${dauer} Tage`);
    }
  }
});

// --- Feiertage ohne Bundesland ---------------------------------------------
// ⚠️ Früher fiel der Code still auf NRW zurück: Ein Betrieb ohne Angabe bekam
// Fronleichnam als Zuschlagstag, obwohl das in zehn Ländern kein Feiertag ist.
// Ohne Angabe gelten jetzt NUR die bundesweiten Tage.
test('ohne Bundesland zählen nur die bundesweiten Feiertage', () => {
  assert.equal(isHoliday('2026-10-03'), true, 'Tag der Deutschen Einheit gilt überall');
  assert.equal(isHoliday('2026-01-01'), true, 'Neujahr gilt überall');
  assert.equal(isHoliday('2026-06-04'), false, 'Fronleichnam nur in manchen Ländern');
  assert.equal(isHoliday('2026-10-31'), false, 'Reformationstag nur in manchen Ländern');
  assert.equal(isHoliday('2026-11-01'), false, 'Allerheiligen nur in manchen Ländern');
});

test('mit Bundesland kommen die regionalen Tage dazu', () => {
  assert.equal(isHoliday('2026-06-04', 'NW'), true, 'Fronleichnam in NRW');
  assert.equal(isHoliday('2026-06-04', 'BE'), false, 'nicht in Berlin');
  assert.equal(isHoliday('2026-10-31', 'SN'), true, 'Reformationstag in Sachsen');
});

test('ein unbekanntes Kürzel wird nicht stillschweigend zu NRW', () => {
  assert.equal(isHoliday('2026-06-04', 'XX'), false);
  assert.equal(isHoliday('2026-06-04', ''), false);
});

// --- Pflege der Jahrestabellen ---------------------------------------------
// ⚠️ Diese Tests sind ABSICHTLICH datumsabhängig. Beide Tabellen in src/billing.js
// müssen jährlich ergänzt werden. Das stand bisher nur als Merksatz in der Doku,
// und Merksätze verfallen lautlos: Fehlt ein Jahr, rechnet der Code mit dem letzten
// bekannten Wert weiter — ohne Fehler, ohne Hinweis, mit falschen Zahlen.
//
// Die beiden Richtungen sind NICHT gleich harmlos:
//   Minijob-Grenze zu niedrig → es wird zu früh gewarnt. Lästig, aber ungefährlich.
//   Mindestlohn zu niedrig    → die Aufstockung wird zu klein gerechnet und ein
//                               echter Verstoß gegen § 1 MiLoG bleibt unentdeckt.
// Deshalb schlägt der Test fehl, sobald die Pflege fällig ist, statt nur zu mahnen.
const HEUTE = new Date();
const JAHR = HEUTE.getFullYear();

test('die Jahrestabellen kennen das laufende Jahr', () => {
  assert.ok(Object.hasOwn(MINDESTLOHN_BY_YEAR, JAHR),
    `MINDESTLOHN_BY_YEAR fehlt ${JAHR}. In src/billing.js ergänzen — Quelle ist der Beschluss der Mindestlohnkommission.`);
  assert.ok(Object.hasOwn(MINIJOB_LIMIT_BY_YEAR, JAHR),
    `MINIJOB_LIMIT_BY_YEAR fehlt ${JAHR}. Der Wert ist limitFromMindestlohnCents(Mindestlohn ${JAHR}), nicht frei wählbar.`);
});

// Die Mindestlohnkommission beschließt bis Ende Juni, die Minijob-Grenze folgt
// daraus rechnerisch. Ab November muss das Folgejahr also stehen — zwei Monate
// Vorlauf, damit der Jahreswechsel niemanden am 1. Januar überrascht.
test('ab November steht auch das Folgejahr fest', (t) => {
  if (HEUTE.getMonth() < 10) return t.skip(`vor November ${JAHR} noch nicht fällig`);
  assert.ok(Object.hasOwn(MINDESTLOHN_BY_YEAR, JAHR + 1),
    `MINDESTLOHN_BY_YEAR fehlt ${JAHR + 1}. Der Beschluss liegt seit Juni vor.`);
  assert.ok(Object.hasOwn(MINIJOB_LIMIT_BY_YEAR, JAHR + 1),
    `MINIJOB_LIMIT_BY_YEAR fehlt ${JAHR + 1}.`);
});

// Die Grenze ist seit 2022 an den Mindestlohn gekoppelt (× 130 ÷ 3, aufgerundet
// auf volle Euro) und damit kein frei einzutragender Wert. Der Test fängt den
// Zahlendreher ab, den man beim Pflegen von Hand macht.
test('Minijob-Grenze und Mindestlohn passen in jedem Jahr zusammen', () => {
  for (const jahr of Object.keys(MINDESTLOHN_BY_YEAR)) {
    if (!Object.hasOwn(MINIJOB_LIMIT_BY_YEAR, jahr)) continue;
    assert.equal(MINIJOB_LIMIT_BY_YEAR[jahr], limitFromMindestlohnCents(MINDESTLOHN_BY_YEAR[jahr]),
      `${jahr}: Grenze passt nicht zum Mindestlohn ${MINDESTLOHN_BY_YEAR[jahr]} ct`);
  }
});
