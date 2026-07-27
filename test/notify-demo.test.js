// Aus dem Demo-Mandanten darf NIE eine echte Mail hinausgehen.
//
// Warum das ein Test wert ist: Der Demo-Mandant ist öffentlich. Wer dort
// hineinkommt, kann bei einer Reinigungskraft eine beliebige Adresse eintragen
// und über eine Terminanfrage eine Mail dorthin auslösen — ein offenes
// Mailrelais mit der Absenderdomain von Putzflow. Der Lohnversand war über
// `keineDemo` gesperrt, Terminanfragen und Rundruf waren es nicht.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-notifydemo-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });
// ⚠️ Ausdrücklich den Mailkanal einschalten — sonst liefe der Test auf der
// Konsole und würde nichts beweisen.
process.env.NOTIFY_CHANNELS = 'mail';
process.env.BREVO_API_KEY = 'test-darf-nie-benutzt-werden';

const { get, run, init } = require('../src/db');
const notify = require('../src/notify');

init();
run(`INSERT INTO tenants(slug, name, region, is_demo) VALUES('demo', 'Schaufenster', 'NW', 1)`);
run(`INSERT INTO tenants(slug, name, region, is_demo) VALUES('echt', 'Echter Betrieb', 'NW', 0)`);
const demo = get(`SELECT * FROM tenants WHERE slug = 'demo'`);
const echt = get(`SELECT * FROM tenants WHERE slug = 'echt'`);

const empfaenger = { name: 'Fremde', email: 'beliebig@example.org', channel: 'mail' };
const nachricht = { subject: 'Reinigung am 2026-08-01', text: 'Können Sie?' };

test('Demo-Mandant: Mail wird auf die Konsole umgeleitet, nicht verschickt', async () => {
  const r = await notify.send(empfaenger, nachricht, demo.id);
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'console', 'darf NIE über den Mailkanal gehen');
  assert.equal(r.demo, true);
});

test('der Versuch steht im Protokoll — stillschweigend verschlucken wäre schlimmer', () => {
  const z = get(`SELECT * FROM notify_log WHERE tenant_id = ? ORDER BY id DESC`, demo.id);
  assert.ok(z, 'es gibt einen Eintrag');
  assert.equal(z.status, 'demo');
  assert.equal(z.recipient, 'beliebig@example.org');
});

test('echter Mandant geht weiterhin über den Mailkanal', async () => {
  // Der Schlüssel ist erfunden, also scheitert der Versand — entscheidend ist,
  // dass er ÜBERHAUPT versucht wurde und nicht auf der Konsole landete.
  const r = await notify.send(empfaenger, nachricht, echt.id);
  assert.notEqual(r.channel, 'console', 'ein echter Mandant darf nicht umgeleitet werden');
});

test('ohne Mandant wird nicht umgeleitet', async () => {
  const r = await notify.send(empfaenger, nachricht, null);
  assert.notEqual(r.channel, 'console');
});
