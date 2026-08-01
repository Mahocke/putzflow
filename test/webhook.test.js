// Smoobu-Webhook: wer darf einen Sofort-Abgleich auslösen — und wer auf keinen Fall.
//
// Der Webhook ist die einzige Route der Anwendung, die OHNE Anmeldung etwas
// anstößt, das Smoobu-Aufrufe kostet. Alles, was hier schiefgeht, ist entweder
// ein fremder Mandant oder ein offener Verstärker. Ausführen: npm test

// ⚠️ Eigene Testdatenbank, vor dem ersten require gesetzt (siehe CLAUDE.md).
process.env.DB_FILE = '/tmp/putzflow-webhook-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { get, run, init } = require('../src/db');

init();

// Vier Mandanten, die sich genau in dem unterscheiden, worauf die Route prüft.
run(`INSERT INTO tenants(slug, name, smoobu_key, smoobu_webhook_token)
     VALUES('hof', 'Musterhof', 'verschluesselt', 'token-hof-xxxxxxxxxxxxxxxxxxxx')`);
run(`INSERT INTO tenants(slug, name, is_demo, smoobu_key, smoobu_webhook_token)
     VALUES('demo', 'Demo', 1, 'verschluesselt', 'token-demo-xxxxxxxxxxxxxxxxxxx')`);
run(`INSERT INTO tenants(slug, name, active, smoobu_key, smoobu_webhook_token)
     VALUES('weg', 'Gekündigt', 0, 'verschluesselt', 'token-weg-xxxxxxxxxxxxxxxxxxxx')`);
run(`INSERT INTO tenants(slug, name, smoobu_webhook_token)
     VALUES('ohne', 'Ohne Smoobu', 'token-ohne-xxxxxxxxxxxxxxxxxxx')`);

// Wörtlich die Route aus server.js — sie ist der ganze Zugangsschutz.
// ⚠️ `String(...)` und die Längenprüfung stehen VOR der Abfrage und sind nicht
// bloß Kosmetik: `get()` wirft bei null/undefined („cannot be bound to SQLite
// parameter"), und eine Route, die bei einem fehlenden Pfadteil mit 500 statt 404
// antwortet, verrät, dass es sie gibt. Beim Bau dieses Tests genau so gestolpert.
function nachschlagen(rohToken) {
  const token = String(rohToken || '');
  if (token.length < 20) return undefined;
  return get(`SELECT id, slug FROM tenants WHERE smoobu_webhook_token = ? AND active = 1
                AND is_demo = 0 AND smoobu_key IS NOT NULL`, token);
}

test('Der richtige Token findet seinen Mandanten', () => {
  assert.equal(nachschlagen('token-hof-xxxxxxxxxxxxxxxxxxxx')?.slug, 'hof');
});

test('⚠️ Die Demo löst NIE einen Abgleich aus', () => {
  // Die Zugangsdaten der Demo sind öffentlich bekannt. Käme man dort an die
  // Webhook-Adresse, hätte jeder Besucher einen Knopf, der Smoobu-Aufrufe kostet.
  assert.equal(nachschlagen('token-demo-xxxxxxxxxxxxxxxxxxx'), undefined);
});

test('⚠️ Ein stillgelegter Mandant auch nicht', () => {
  // Sonst liefe der Abgleich für einen gekündigten Kunden weiter — mit seinem
  // Schlüssel, auf seine Kosten, ohne dass er die Anwendung noch benutzen kann.
  assert.equal(nachschlagen('token-weg-xxxxxxxxxxxxxxxxxxxx'), undefined);
});

test('Ohne hinterlegten Zugang gibt es nichts abzugleichen', () => {
  assert.equal(nachschlagen('token-ohne-xxxxxxxxxxxxxxxxxxx'), undefined);
});

test('⚠️ Fremde und leere Token laufen ins Leere', () => {
  for (const t of ['', null, undefined, 'token-hof-xxxxxxxxxxxxxxxxxxx', 'x']) {
    assert.equal(nachschlagen(t), undefined, `Token ${JSON.stringify(t)}`);
  }
});

test('⚠️ Trennen löscht den Token mit', () => {
  // Sonst bliebe eine Adresse gültig, die der Kunde für erledigt hält — und beim
  // erneuten Verbinden wäre die alte, womöglich abgeflossene, wieder scharf.
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const del = quelle.slice(quelle.indexOf(`app.delete('/api/smoobu'`));
  assert.match(del.slice(0, 400), /smoobu_webhook_token\s*=\s*NULL/,
    'DELETE /api/smoobu muss smoobu_webhook_token mit zurücksetzen');
});

test('⚠️ Dem Payload wird nicht vertraut — die Route liest req.body NICHT', () => {
  // Das ist die tragende Annahme des ganzen Entwurfs: Der Aufruf ist nur ein
  // Klopfen, die Daten holt Putzflow selbst und signiert über die API. Läse die
  // Route den Body aus, könnte jeder mit dem Token Termine erfinden.
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = quelle.indexOf(`app.post('/webhook/smoobu/:token'`);
  assert.ok(start > 0, 'Webhook-Route fehlt');
  const route = quelle.slice(start, quelle.indexOf('\n});', start));
  assert.ok(!/req\.body/.test(route), 'Die Webhook-Route darf req.body nicht anfassen');
});

test('Das Sicherheitsnetz bleibt bestehen', () => {
  // Der Webhook ersetzt den Tick NICHT. Ein verpasstes Ereignis — Smoobu-Ausfall,
  // vergessener Eintrag, getauschter Token — dürfte sonst eine Reinigung kosten.
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(quelle, /setInterval\(\(\) => \{ smoobuTick\(\)/, 'periodischer Abgleich fehlt');
});
