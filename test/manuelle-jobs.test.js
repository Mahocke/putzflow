// Termine von Hand: Reinigungen ohne Smoobu und Sonderaufgaben.
//
// ⚠️ Zwei Dinge müssen hier stimmen, sonst kostet es Geld oder eine Reinigung:
// Eine Sonderaufgabe darf nicht die Reinigungspauschale bekommen, und die
// Smoobu-Synchronisation darf einen Termin von Hand nicht wegräumen.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-manuell-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const { init, run, get, all } = require('../src/db');
const jobs = require('../src/jobs');
const billing = require('../src/billing');
init();

run(`INSERT INTO tenants(slug, name) VALUES('hof', 'Musterhof')`);
const t = get(`SELECT * FROM tenants WHERE slug = 'hof'`);
run(`INSERT INTO comp_rules(tenant_id, mode, base_cents, premium_on, premium_mode, premium_cents)
     VALUES(?, 'flat', 2250, 'weekend_holiday', 'rate', 3000)`, t.id);
run(`INSERT INTO units(tenant_id, name) VALUES(?, 'Wohnung 1')`, t.id);
run(`INSERT INTO users(tenant_id, name, role) VALUES(?, 'Anna', 'cleaner')`, t.id);
const unit = get(`SELECT * FROM units WHERE tenant_id = ?`, t.id);
const anna = get(`SELECT * FROM users WHERE tenant_id = ?`, t.id);
const TAG = '2026-08-05';                          // ein Mittwoch, kein Zuschlagstag

function anlege(felder) {
  run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, titel, pay_cents, assigned_user_id, dedup_key)
       VALUES(?,?,?,?,?,?,?,?)`,
      t.id, felder.unit_id ?? null, felder.due_date ?? TAG, felder.kind ?? 'apartment',
      felder.titel ?? null, felder.pay_cents ?? null, anna.id, felder.dedup_key ?? `manuell:${Math.random()}`);
  return get(`SELECT * FROM jobs WHERE tenant_id = ? ORDER BY id DESC LIMIT 1`, t.id);
}

function zeitErfassen(job, minuten) {
  const von = `${job.due_date} 09:00:00`;
  const bis = `${job.due_date} ${String(9 + Math.floor(minuten / 60)).padStart(2, '0')}:${String(minuten % 60).padStart(2, '0')}:00`;
  run(`INSERT INTO work_sessions(tenant_id, job_id, user_id, started_at, ended_at) VALUES(?,?,?,?,?)`,
      t.id, job.id, anna.id, von, bis);
}

test('eine Reinigung von Hand bekommt die normale Pauschale', () => {
  const j = anlege({ unit_id: unit.id });
  assert.equal(jobs.jobPay(t, j).cents, 2250);
});

test('⚠️ eine Sonderaufgabe bekommt NICHT die Reinigungspauschale', () => {
  // 22,50 € für „eben Kapseln holen" wäre so falsch wie 22,50 € für einen
  // halben Tag Wäscherei — in beide Richtungen.
  const j = anlege({ kind: 'aufgabe', titel: 'Kaffeekapseln kaufen' });
  const p = jobs.jobPay(t, j);
  assert.notEqual(p.cents, 2250);
  assert.equal(p.cents, 0, 'ohne erfasste Zeit und ohne Betrag gibt es (noch) nichts');
  assert.equal(p.mode, 'hourly');
});

test('Sonderaufgabe nach Zeit: mindestens Mindestlohn', () => {
  const j = anlege({ kind: 'aufgabe', titel: 'Wäsche holen' });
  zeitErfassen(j, 30);
  const p = jobs.jobPay(t, get(`SELECT * FROM jobs WHERE id = ?`, j.id));
  assert.equal(p.minutes, 30);
  assert.equal(p.cents, Math.round(billing.mindestlohnCents(TAG) / 2));
});

test('⚠️ ein fester Betrag von 0 ist etwas anderes als kein Betrag', () => {
  // NULL heißt „nach Zeit". Wer ausdrücklich 0 einträgt, meint unentgeltlich —
  // würde beides gleich behandelt, entstünde aus einem Gefallen eine Forderung
  // oder umgekehrt.
  const unentgeltlich = anlege({ kind: 'aufgabe', titel: 'Blumen gießen', pay_cents: 0 });
  zeitErfassen(unentgeltlich, 60);
  const p = jobs.jobPay(t, get(`SELECT * FROM jobs WHERE id = ?`, unentgeltlich.id));
  assert.equal(p.cents, 0);
  assert.equal(p.mode, 'fixed');
  assert.equal(p.minutes, 60, 'die ZEIT bleibt trotzdem aufgezeichnet — § 17 MiLoG');
});

test('fester Betrag schlägt die Zeit', () => {
  const j = anlege({ kind: 'aufgabe', titel: 'Waschmaschine warten', pay_cents: 1500 });
  zeitErfassen(j, 200);
  assert.equal(jobs.jobPay(t, get(`SELECT * FROM jobs WHERE id = ?`, j.id)).cents, 1500);
});

test('Sonderaufgaben zählen in Stundenzettel und Verdienstgrenze', () => {
  // ⚠️ § 17 MiLoG kennt keine Ausnahme für „nur eben schnell einkaufen". Wer
  // Sonderaufgaben an `jobs` vorbei baut, hebelt die halbe Nachweisschicht aus.
  const ts = jobs.timesheet(t, anna.id, TAG);
  const aufgaben = ts.items.filter(i => i.kind === 'aufgabe');
  assert.ok(aufgaben.length >= 3);
  assert.ok(aufgaben.every(i => i.unit), '⚠️ der Titel steht, wo sonst die Unterkunft steht');
  assert.ok(ts.items.some(i => i.unit === 'Kaffeekapseln kaufen'));
});

test('⚠️ die Smoobu-Synchronisation fasst Termine von Hand NICHT an', () => {
  // sync.js sucht Termine über SEINEN dedup_key. Läge ein Termin von Hand in
  // demselben Namensraum, räumte ihn der nächste Lauf als „verschwundene
  // Buchung" weg — und niemand merkt es, bis die Reinigung ausfällt.
  const vonHand = all(`SELECT dedup_key FROM jobs WHERE tenant_id = ?`, t.id);
  assert.ok(vonHand.length > 0);
  assert.ok(vonHand.every(j => j.dedup_key.startsWith('manuell:')));
  assert.ok(vonHand.every(j => !j.dedup_key.startsWith('smoobu:')));
  // Und der Schlüssel ist je Termin verschieden — sonst überschriebe die zweite
  // Handeingabe die erste.
  assert.equal(new Set(vonHand.map(j => j.dedup_key)).size, vonHand.length);
});
