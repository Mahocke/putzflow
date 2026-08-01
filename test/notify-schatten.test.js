// Aus einem SCHATTENMANDANTEN darf NIE eine Nachricht hinausgehen.
//
// Warum das ein eigener Test ist, obwohl es notify-demo.test.js schon fast gibt:
// Ein Schattenmandant ist etwas anderes als die Demo, und zwar in der
// gefährlicheren Richtung. Die Demo enthält erfundene Daten — geht dort etwas
// hinaus, ist es peinlich. Ein Schattenmandant enthält die ECHTEN Adressen
// echter Reinigungskräfte eines Betriebs, der noch auf seinem alten System
// arbeitet und von dem Vergleichsbetrieb gar nichts weiß. Ginge von hier eine
// Terminanfrage hinaus, bekäme jede Kraft jeden Termin doppelt — und der stille
// Vergleich, der niemanden stören soll, wäre genau die Störung.
//
// Der Riegel sitzt deshalb in `src/notify/index.js` und nicht an einzelnen
// Routen: Sonst muss er bei jeder neuen Route erneut bedacht werden, und genau
// das geht einmal schief.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-notifyschatten-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });
// ⚠️ Ausdrücklich den Mailkanal einschalten — sonst liefe der Test auf der
// Konsole und würde nichts beweisen.
process.env.NOTIFY_CHANNELS = 'mail';
process.env.BREVO_API_KEY = 'test-darf-nie-benutzt-werden';

const { get, run, init } = require('../src/db');
const notify = require('../src/notify');

init();
run(`INSERT INTO tenants(slug, name, region, schattenbetrieb) VALUES('schatten', 'Mitlaufender Betrieb', 'NW', 1)`);
run(`INSERT INTO tenants(slug, name, region, schattenbetrieb) VALUES('echt', 'Echter Betrieb', 'NW', 0)`);
const schatten = get(`SELECT * FROM tenants WHERE slug = 'schatten'`);
const echt = get(`SELECT * FROM tenants WHERE slug = 'echt'`);

// Bewusst eine Adresse, die nach einer echten Reinigungskraft aussieht: Das ist
// der Fall, um den es geht — nicht eine offensichtliche Testadresse.
const kraft = { name: 'Reinigungskraft', email: 'kraft@example.org', channel: 'mail' };
const nachricht = { subject: 'Reinigung am 2026-08-01', text: 'Können Sie?' };

test('Schattenmandant: Nachricht landet auf der Konsole, nicht beim Empfänger', async () => {
  const r = await notify.send(kraft, nachricht, schatten.id);
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'console', 'darf NIE über den Mailkanal gehen');
  assert.equal(r.gesperrt, 'schatten');
});

test('der Grund steht im Protokoll — sonst wäre „nichts gesendet" nicht von „vergessen" zu unterscheiden', () => {
  const z = get(`SELECT * FROM notify_log WHERE tenant_id = ? ORDER BY id DESC`, schatten.id);
  assert.ok(z, 'es gibt einen Eintrag');
  assert.equal(z.status, 'schatten');
  assert.equal(z.recipient, 'kraft@example.org');
});

test('der Riegel hängt am Mandanten, nicht am Empfänger — auch die Verwaltung bekommt nichts', async () => {
  // Sonst wäre der Schattenbetrieb nicht mehr still: Die Chefin bekäme Meldungen
  // über ein System, von dem sie nichts weiß.
  const chefin = { name: 'Verwaltung', email: 'chefin@example.org', channel: 'mail' };
  const r = await notify.send(chefin, { subject: 'Zusage', text: 'X hat zugesagt' }, schatten.id);
  assert.equal(r.channel, 'console');
  assert.equal(r.gesperrt, 'schatten');
});

test('ein echter Mandant im selben Prozess wird NICHT mitgesperrt', async () => {
  // Der Kern der Mandantentrennung: Der Riegel darf nicht global wirken, sonst
  // verstummt mit dem Schattenbetrieb die zahlende Kundschaft.
  // Der Schlüssel ist erfunden, also scheitert der Versand — entscheidend ist,
  // dass er ÜBERHAUPT versucht wurde und nicht auf der Konsole landete.
  const r = await notify.send(kraft, nachricht, echt.id);
  assert.notEqual(r.channel, 'console', 'ein echter Mandant darf nicht umgeleitet werden');
  assert.equal(r.gesperrt, undefined);
});

test('Schalter umgelegt: aus demselben Mandanten geht danach wieder etwas hinaus', async () => {
  // Der Umschalttag ist genau das — ein Feld von 1 auf 0. Bliebe der Mandant
  // gesperrt, wäre der Betrieb nach dem Umzug lautlos, und das fiele erst auf,
  // wenn eine Reinigung ausfällt.
  run(`UPDATE tenants SET schattenbetrieb = 0 WHERE id = ?`, schatten.id);
  const r = await notify.send(kraft, nachricht, schatten.id);
  assert.notEqual(r.channel, 'console');
  run(`UPDATE tenants SET schattenbetrieb = 1 WHERE id = ?`, schatten.id);
});
