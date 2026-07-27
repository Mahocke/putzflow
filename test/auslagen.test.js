const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-auslagen-test.sqlite';
process.env.RECEIPT_DIR = '/tmp/putzflow-auslagen-belege';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const auslagen = require('../src/auslagen');
const billing = require('../src/billing');

const roh = (o = {}) => ({
  id: 1, date: '2026-07-20', description: 'Kaffeekapseln', amount_cents: 1990,
  minutes: 0, pay_cents: null, receipt_file: null, approved_at: '2026-07-21T08:00:00Z',
  rejected_at: null, job_id: null, note: null, ...o,
});

test('Stundensatz: hinterlegter Stundenlohn schlägt alles Weitere', () => {
  const satz = auslagen.stundensatzCents({ mode: 'hourly', base_cents: 1800 }, [], '2026-07-16');
  assert.equal(satz, 1800);
});

// Bei Pauschalen gibt es keinen Stundensatz. Die Kraft für den Botengang auf den
// Mindestlohn zurückzustufen, obwohl sie sonst deutlich mehr verdient, wäre unfair.
test('Stundensatz: sonst der eigene effektive Satz aus den Reinigungen', () => {
  const positionen = [{ minutes: 120, cents: 4000 }, { minutes: 60, cents: 2000 }];
  // 6000 Cent auf 180 Minuten = 20,00 €/Std.
  assert.equal(auslagen.stundensatzCents({ mode: 'flat', base_cents: 2000 }, positionen, '2026-07-16'), 2000);
});

test('Stundensatz: nie unter dem Mindestlohn', () => {
  const mager = [{ minutes: 600, cents: 1000 }];        // 1,00 €/Std.
  assert.equal(auslagen.stundensatzCents({ mode: 'flat' }, mager, '2026-07-16'),
               billing.mindestlohnCents('2026-07-16'));
  assert.equal(auslagen.stundensatzCents({ mode: 'hourly', base_cents: 500 }, [], '2026-07-16'),
               billing.mindestlohnCents('2026-07-16'));
  assert.equal(auslagen.stundensatzCents(null, [], '2026-07-16'), 1390);
});

test('nur Freigegebenes zählt, Offenes bleibt sichtbar', () => {
  const a = auslagen.aufbereiten([
    roh({ id: 1, amount_cents: 1990 }),
    roh({ id: 2, amount_cents: 500, approved_at: null }),
    roh({ id: 3, amount_cents: 900, approved_at: null, rejected_at: '2026-07-21T09:00:00Z' }),
  ], 1500);
  assert.equal(a.posten.length, 3);
  assert.equal(a.auslagen_cents, 1990);
  assert.equal(a.offen, 1);
  assert.deepEqual(a.posten.map(p => p.zustand), ['genehmigt', 'offen', 'abgelehnt']);
});

test('Wegezeit wird nach Stundensatz vergütet, ein eingetragener Betrag schlägt ihn', () => {
  const a = auslagen.aufbereiten([
    roh({ id: 1, minutes: 30 }),                 // 30 min zu 15,00 € = 7,50 €
    roh({ id: 2, minutes: 30, pay_cents: 1200 }),
  ], 1500);
  assert.equal(a.posten[0].entgelt_cents, 750);
  assert.equal(a.posten[1].entgelt_cents, 1200);
  assert.equal(a.entgelt_cents, 1950);
  assert.equal(a.minuten, 60);
});

// Der Kern: 30 € Kaffeekapseln dürfen niemanden über die Minijob-Grenze schieben
// und dürfen den effektiven Stundenlohn nicht schönrechnen (§ 3 Nr. 50 EStG).
test('Auslagenersatz ist kein Arbeitsentgelt', () => {
  const a = auslagen.aufbereiten([roh({ amount_cents: 3000, minutes: 0 })], 1500);
  assert.equal(a.entgelt_cents, 0, 'reine Auslage erzeugt keinen Lohn');
  assert.equal(a.auslagen_cents, 3000);

  // So, wie timesheet() es zusammensetzt: nur das Entgelt geht in die Prüfung.
  const jobPositionen = [{ minutes: 60, cents: 1400 }];
  const pruefung = billing.mindestlohnPruefung(
    [...jobPositionen, ...a.genehmigt.map(p => ({ minutes: p.minutes, cents: p.entgelt_cents }))],
    '2026-07-16');
  assert.equal(pruefung.effektiv_cents, 1400, 'die 30 € heben den Schnitt nicht');
  assert.equal(pruefung.unterschritten, false);
});

test('Besorgungszeit ohne Vergütung reißt den Mindestlohn', () => {
  const a = auslagen.aufbereiten([roh({ minutes: 60, pay_cents: 0 })], 1500);
  const pruefung = billing.mindestlohnPruefung(
    [{ minutes: 60, cents: 1400 }, ...a.genehmigt.map(p => ({ minutes: p.minutes, cents: p.entgelt_cents }))],
    '2026-07-16');
  assert.equal(pruefung.minuten, 120);
  assert.equal(pruefung.effektiv_cents, 700);
  assert.equal(pruefung.unterschritten, true);
});

// --- Arbeitszeitaufzeichnung (§ 17 MiLoG) ---------------------------------
const jobsLogik = require('../src/jobs');

test('Beginn und Ende werden je Einsatz durchgereicht, nicht nur die Dauer', () => {
  const z = jobsLogik.zeitraeume([
    { started_at: '2026-07-20 08:00:00', ended_at: '2026-07-20 10:30:00' },
    { started_at: '2026-07-20 13:00:00', ended_at: null },      // läuft noch
  ]);
  assert.deepEqual(z, [{ von: '08:00', bis: '10:30' }]);
});

test('die Sieben-Tage-Frist wird korrekt bestimmt', () => {
  assert.equal(jobsLogik.fristAbgelaufen('2026-07-20', '2026-07-27'), false, 'am siebten Tag noch offen');
  assert.equal(jobsLogik.fristAbgelaufen('2026-07-20', '2026-07-28'), true);
  assert.equal(jobsLogik.AUFZEICHNUNGSFRIST_TAGE, 7);
});
