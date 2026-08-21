// Rundruf: einen Termin mehreren anbieten, die erste Zusage gewinnt.
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-rundruf-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const { get, all, run, init } = require('../src/db');
const rundruf = require('../src/rundruf');

init();

// --- Aufbau ----------------------------------------------------------------
run(`INSERT INTO tenants(slug, name, region) VALUES('rt', 'Rundruf-Test', 'NW')`);
const tenant = get(`SELECT * FROM tenants WHERE slug = 'rt'`);

function kraft(name, extra = {}) {
  run(`INSERT INTO users(tenant_id, name, email, role, active, silent, employment)
       VALUES(?, ?, ?, 'cleaner', ?, ?, ?)`,
      tenant.id, name, `${name.toLowerCase()}@example.org`,
      extra.active ?? 1, extra.silent ?? 0, extra.employment ?? 'minijob');
  return get(`SELECT * FROM users WHERE tenant_id = ? AND name = ?`, tenant.id, name);
}
function termin(datum) {
  run(`INSERT INTO jobs(tenant_id, due_date, kind, status) VALUES(?, ?, 'apartment', 'open')`,
      tenant.id, datum);
  return get(`SELECT * FROM jobs WHERE tenant_id = ? AND due_date = ? ORDER BY id DESC`, tenant.id, datum);
}

const anna = kraft('Anna');
const bea = kraft('Bea');
const carla = kraft('Carla', { silent: 1 });        // still: kein Token, keine Nachricht
const dora = kraft('Dora', { active: 0 });          // stillgelegt

test('Rundruf fragt nur aktive, nicht stille Kräfte', () => {
  const job = termin('2026-08-03');
  const { gefragt, uebersprungen } = rundruf.kandidaten(tenant, job);
  const namen = gefragt.map(u => u.name).sort();
  assert.deepEqual(namen, ['Anna', 'Bea']);
  assert.ok(!uebersprungen.some(s => s.user.name === 'Carla'), 'Stille tauchen gar nicht erst auf');
  assert.ok(!uebersprungen.some(s => s.user.name === 'Dora'), 'Stillgelegte ebenso wenig');
});

test('wer gerade abgesagt hat, wird nicht sofort erneut gefragt', () => {
  const job = termin('2026-08-04');
  const { gefragt, uebersprungen } = rundruf.kandidaten(tenant, job, [anna.id]);
  assert.deepEqual(gefragt.map(u => u.name), ['Bea']);
  assert.equal(uebersprungen.find(s => s.user.name === 'Anna').grund, 'hat gerade abgesagt');
});

test('⚠️ der Ausschlussgrund ist frei — sonst steht eine Unwahrheit in der Mail', () => {
  // Meldet die Verwaltung eine kranke Kraft ab, ist sie zwar auch ausgeschlossen,
  // hat aber nichts gesagt. Der Grund steht wörtlich in der Mail an die Chefin.
  const job = termin('2026-08-11');
  const { uebersprungen } = rundruf.kandidaten(tenant, job, [anna.id], 'fällt aus');
  assert.equal(uebersprungen.find(s => s.user.name === 'Anna').grund, 'fällt aus');
});

test('Angebote sind idempotent — ein zweiter Rundruf legt keine Dubletten an', () => {
  const job = termin('2026-08-05');
  const { gefragt } = rundruf.kandidaten(tenant, job);
  rundruf.anbieten(tenant, job, gefragt);
  const nochmal = rundruf.anbieten(tenant, job, gefragt);
  assert.equal(nochmal.length, 0, 'laufende Angebote werden nicht erneut verschickt');
  assert.equal(all(`SELECT * FROM job_offers WHERE job_id = ?`, job.id).length, 2);
});

// ⚠️ Der Kern: Zwei Kräfte tippen im selben Moment. Ohne den bedingten UPDATE
// bekämen beide den Termin, und am Ende stünden zwei Frauen vor derselben Tür.
test('die erste Zusage gewinnt, die zweite läuft ins Leere', () => {
  const job = termin('2026-08-06');
  rundruf.anbieten(tenant, job, rundruf.kandidaten(tenant, job).gefragt);

  const erste = rundruf.annehmen(tenant, job, anna);
  assert.equal(erste.ok, true);
  assert.deepEqual(erste.zuSpaet.map(o => o.name), ['Bea']);

  const zweite = rundruf.annehmen(tenant, job, bea);
  assert.equal(zweite.ok, false);
  assert.equal(zweite.grund, 'vergeben');

  const frisch = get(`SELECT * FROM jobs WHERE id = ?`, job.id);
  assert.equal(frisch.assigned_user_id, anna.id, 'der Termin gehört Anna');
  assert.equal(frisch.confirmed, 1);
});

test('nach dem Zuschlag ist kein Angebot mehr offen', () => {
  const job = get(`SELECT * FROM jobs WHERE tenant_id = ? AND due_date = '2026-08-06'`, tenant.id);
  assert.equal(rundruf.offeneAngebote(job).length, 0);
  const antworten = all(`SELECT user_id, answer FROM job_offers WHERE job_id = ? ORDER BY user_id`, job.id);
  assert.deepEqual(antworten.map(a => a.answer).sort(), ['closed', 'yes']);
});

test('Absage auf einen Rundruf lässt den Termin für die anderen offen', () => {
  const job = termin('2026-08-07');
  rundruf.anbieten(tenant, job, rundruf.kandidaten(tenant, job).gefragt);

  assert.equal(rundruf.ablehnen(tenant, job, anna).ok, true);
  assert.deepEqual(rundruf.offeneAngebote(job).map(o => o.name), ['Bea']);
  assert.equal(get(`SELECT assigned_user_id FROM jobs WHERE id = ?`, job.id).assigned_user_id, null);

  // Bea kann ihn danach noch holen.
  assert.equal(rundruf.annehmen(tenant, job, bea).ok, true);
});

test('ohne Angebot kein Zuschlag', () => {
  const job = termin('2026-08-08');
  assert.deepEqual(rundruf.annehmen(tenant, job, anna), { ok: false, grund: 'kein_angebot' });
  assert.equal(get(`SELECT assigned_user_id FROM jobs WHERE id = ?`, job.id).assigned_user_id, null);
});

// ⚠️ Ein Rundruf, der jemanden über die Verdienstgrenze einlädt, schafft genau
// das Problem, das die Ampel verhindern soll.
test('wer über die Verdienstgrenze käme, wird gar nicht erst gefragt', () => {
  const voll = kraft('Elke');
  // Eigene Vergütungsregel für Elke: 300 € je Reinigung. Zwei zugesagte Termine
  // in derselben Periode bringen sie auf 600 € — es bleiben 3 € bis zur Grenze.
  run(`INSERT INTO comp_rules(tenant_id, user_id, mode, base_cents, premium_mode)
       VALUES(?, ?, 'flat', 30000, 'none')`, tenant.id, voll.id);
  for (const d of ['2026-08-01', '2026-08-02']) {
    run(`INSERT INTO jobs(tenant_id, due_date, kind, status, assigned_user_id, confirmed)
         VALUES(?, ?, 'apartment', 'open', ?, 1)`, tenant.id, d, voll.id);
  }
  const job = termin('2026-08-09');
  const { gefragt, uebersprungen } = rundruf.kandidaten(tenant, job);
  assert.ok(!gefragt.some(u => u.name === 'Elke'), 'Elke wird nicht gefragt');
  const grund = uebersprungen.find(s => s.user.name === 'Elke');
  assert.ok(grund && /Verdienstgrenze/.test(grund.grund), 'und es steht dabei, warum: ' + JSON.stringify(grund));
});
