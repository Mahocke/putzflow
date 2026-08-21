// Absagen: die Reinigung fällt weg — und was das von „die Kraft kann nicht"
// unterscheidet.
//
// ⚠️ Zwei Dinge müssen hier stimmen, sonst kostet es Geld oder eine Reinigung:
// Eine abgesagte Reinigung darf NICHT mehr in Lohn und Verdienstgrenze zählen,
// und sie darf beim Wiedereinplanen nicht als „zugesagt" zurückkommen — die
// Zusage galt einer Reinigung, die abgesagt wurde.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-absagen-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const { init, run, get } = require('../src/db');
const jobs = require('../src/jobs');
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

let lfd = 0;
function anlege(felder = {}) {
  run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, status, assigned_user_id, confirmed,
                        requested_at, start_time, dedup_key)
       VALUES(?,?,?,'apartment',?,?,?,?,?,?)`,
      t.id, unit.id, felder.due_date ?? TAG, felder.status ?? 'open',
      felder.assigned_user_id ?? null, felder.confirmed ?? 0,
      felder.requested_at ?? null, felder.start_time ?? null, `absage:${++lfd}`);
  return get(`SELECT * FROM jobs WHERE tenant_id = ? ORDER BY id DESC LIMIT 1`, t.id);
}
const frisch = j => get(`SELECT * FROM jobs WHERE id = ?`, j.id);

test('Absagen räumt Zuteilung, Zusage und Zeitschlitz weg', () => {
  const j = anlege({ assigned_user_id: anna.id, confirmed: 1,
                     requested_at: '2026-08-01 09:00:00', start_time: '11:00' });
  jobs.absagen(j);
  const nach = frisch(j);
  assert.equal(nach.status, 'skipped');
  assert.equal(nach.skipped_by, 'admin');
  assert.equal(nach.assigned_user_id, null);
  assert.equal(nach.confirmed, 0);
  assert.equal(nach.requested_at, null);
  // ⚠️ Der Zeitschlitz gehört zur Person, nicht zum Termin — bliebe er stehen,
  // bekäme die nächste Kraft eine Uhrzeit, die für jemand anderen geplant wurde.
  assert.equal(nach.start_time, null);
});

test('⚠️ eine abgesagte Reinigung zählt nicht mehr in Lohn und Verdienstgrenze', () => {
  const vorher = jobs.timesheet(t, anna.id, TAG);
  const j = anlege({ assigned_user_id: anna.id, confirmed: 1 });
  const mit = jobs.timesheet(t, anna.id, TAG);
  assert.ok(mit.geplant_cents > vorher.geplant_cents, 'Vorbedingung: der Termin zählt erst mit');

  jobs.absagen(j);
  const ohne = jobs.timesheet(t, anna.id, TAG);
  assert.equal(ohne.geplant_cents, vorher.geplant_cents,
    'nach der Absage darf der Termin weder im Lohn noch in der Minijob-Ampel stehen');
});

test('Wiedereinplanen bringt den Termin als OFFEN zurück, nicht als zugesagt', () => {
  const j = anlege({ assigned_user_id: anna.id, confirmed: 1 });
  jobs.absagen(j);
  jobs.wiederEinplanen(frisch(j));
  const nach = frisch(j);
  assert.equal(nach.status, 'open');
  assert.equal(nach.skipped_by, null);
  // ⚠️ Der Kern: Anna hat eine Absage bekommen. Käme der Termin mit ihrer alten
  // Zusage zurück, stünde er als „zugesagt" da, ohne dass sie je wieder gefragt
  // wurde — und sie erschiene am Tag der Reinigung nicht.
  assert.equal(nach.assigned_user_id, null);
  assert.equal(nach.confirmed, 0);
});

// --- Der andere Ausgang: die Kraft fällt aus, die Reinigung bleibt ---

test('Freigeben lässt den Termin stehen und macht ihn wieder vergebbar', () => {
  const j = anlege({ assigned_user_id: anna.id, confirmed: 1, start_time: '11:00' });
  jobs.zuteilungFreigeben(frisch(j));
  const nach = frisch(j);
  // ⚠️ Der Unterschied zum Absagen in einer Zeile: Der Termin bleibt OFFEN.
  // Die Reinigung muss ja trotzdem gemacht werden.
  assert.equal(nach.status, 'open');
  assert.equal(nach.skipped_by, null);
  assert.equal(nach.assigned_user_id, null);
  assert.equal(nach.confirmed, 0);
  assert.equal(nach.start_time, null);
});

test('⚠️ Freigeben behauptet NICHT, die Kraft hätte abgesagt', () => {
  const j = anlege({ assigned_user_id: anna.id, confirmed: 1 });
  jobs.zuteilungFreigeben(frisch(j));
  // `declined_at` ist der Merker für „die Kraft hat selbst abgesagt". Stünde er
  // hier, zeigte die Karte „abgesagt" und der nächste Rundruf überspränge Anna
  // mit der Begründung „hat gerade abgesagt" — beides über sie behauptet, ohne
  // dass sie etwas gesagt hat.
  assert.equal(frisch(j).declined_at, null);
});

test('eine freigegebene Reinigung zählt nicht mehr auf Annas Konto', () => {
  const vorher = jobs.timesheet(t, anna.id, TAG);
  const j = anlege({ assigned_user_id: anna.id, confirmed: 1 });
  assert.ok(jobs.timesheet(t, anna.id, TAG).geplant_cents > vorher.geplant_cents);
  jobs.zuteilungFreigeben(frisch(j));
  assert.equal(jobs.timesheet(t, anna.id, TAG).geplant_cents, vorher.geplant_cents,
    'sie macht die Reinigung nicht — also darf sie auch nicht auf ihre Grenze gehen');
});

test('ein nur angefragter Termin lässt sich genauso absagen', () => {
  const j = anlege({ assigned_user_id: anna.id, confirmed: 0, requested_at: '2026-08-01 09:00:00' });
  jobs.absagen(j);
  assert.equal(frisch(j).status, 'skipped');
});
