// Die Adresse des Betriebs: <slug>.putzflow.de.
//
// ⚠️ Eigene Datei mit EIGENEM Serverprozess, und das ist kein Schönheitsfehler: Die
// Sperre gegen Massenanlage zählt drei Konten je Stunde und Absender-IP, und sie
// lebt im Arbeitsspeicher des Prozesses. In `registrierung.test.js` sind die drei
// schon verbraucht — dort liefen diese Fälle in ein 429 statt in die Prüfung.
//
// ⚠️ Die Adresse ist UNUMKEHRBAR (Magic-Links, Lesezeichen, Smoobu-Webhook). Deshalb
// prüft dieser Test vor allem eines: dass NICHTS still ersetzt wird.
//
// Ausführen: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const WURZEL = path.join(__dirname, '..');
const DATEI = '/tmp/putzflow-adresse-test.sqlite';
const PORT = 39413;
const BASIS = `http://127.0.0.1:${PORT}`;
let kind = null;

const KONTO = {
  name: 'Katrin Berger', street: 'Rheinstraße 12', zip: '40210',
  city: 'Düsseldorf', country: 'DE', password: 'einlangespasswort',
};

function anmelden(daten) {
  return fetch(`${BASIS}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...KONTO, ...daten }), signal: AbortSignal.timeout(10000),
  });
}

before(async () => {
  for (const e of ['', '-wal', '-shm']) fs.rmSync(DATEI + e, { force: true });
  const bauen = spawnSync(process.execPath,
    ['-e', "process.env.DB_FILE=process.argv[1];require('./src/db').init()", DATEI],
    { cwd: WURZEL, env: { ...process.env, DB_FILE: DATEI }, encoding: 'utf8' });
  assert.equal(bauen.status, 0, bauen.stderr);

  kind = await new Promise((fertig, fehler) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: WURZEL,
      env: { ...process.env, DB_FILE: DATEI, PORT: String(PORT), BASE_URL: BASIS,
             NOTIFY_CHANNELS: 'console',
             // ⚠️ APP_SECRET MUSS hier stehen. Der Server liest sonst die `.env` des
             // Arbeitsverzeichnisses — die gibt es in der Entwicklung, im Baubaum des
             // OSS-Exports aber nicht, und dort startete er gar nicht erst. Ein Test
             // darf nicht davon abhängen, was zufällig in der `.env` des Entwicklers
             // steht (am 21.08.2026 blockierte genau das die Veröffentlichung).
             APP_SECRET: 'test-geheimnis-mindestens-32-zeichen-lang', BOOTSTRAP_DEMO: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let aus = '';
    const t = setTimeout(() => fehler(new Error(`Server kam nicht hoch:\n${aus}`)), 15000);
    p.stdout.on('data', d => { aus += d; if (aus.includes('läuft auf')) { clearTimeout(t); fertig(p); } });
    p.stderr.on('data', d => { aus += d; });
    p.on('exit', c => { clearTimeout(t); fehler(new Error(`Server beendet (${c}):\n${aus}`)); });
  });
});

after(() => { if (kind) kind.kill(); });

test('die Adresse darf selbst gewählt werden', async () => {
  const r = await anmelden({ ...KONTO, firma: 'Gästehaus Rheinblick', email: 'wunsch@example.net',
                             slug: 'rheinblick' });
  // ⚠️ Den Körper NUR EINMAL lesen. `assert.equal(r.status, 200, await r.text())`
  // verbraucht ihn, und das anschließende `r.json()` scheitert dann mit einer
  // Meldung, die nach Serverfehler aussieht statt nach Testfehler.
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.equal(JSON.parse(text).slug, 'rheinblick');
});

test('⚠️ eine belegte Wunschadresse wird NICHT still ersetzt', async () => {
  // Wer eine Adresse ausdrücklich eintippt, will genau die. `rheinblick-2`
  // wäre keine Antwort auf seinen Wunsch, sondern eine stille Ersetzung —
  // und die Adresse lässt sich später nicht mehr wechseln.
  const r = await anmelden({ ...KONTO, firma: 'Anderer Betrieb', email: 'zweiter@example.net',
                             slug: 'rheinblick' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /schon vergeben/);
});

test('gesperrte und krumme Adressen weist der Server ab', async () => {
  for (const [s, muster] of [['www', /vergeben/], ['-krumm', /Anfang oder Ende/],
                             ['ab', /mindestens 3/], ['Groß', /Kleinbuchstaben/]]) {
    const r = await anmelden({ ...KONTO, firma: 'Prüffall', email: `p-${s.length}@example.net`, slug: s });
    assert.equal(r.status, 400, `„${s}" ist durchgekommen`);
    assert.match((await r.json()).error, muster);
  }
});

test('/api/slug-frei sagt frei oder belegt — und nie, wem etwas gehört', async () => {
  const frag = async (s) => (await fetch(`${BASIS}/api/slug-frei?slug=${encodeURIComponent(s)}`,
    { signal: AbortSignal.timeout(10000) })).json();

  assert.equal((await frag('noch-ganz-frei')).frei, true);
  const belegt = await frag('rheinblick');
  assert.equal(belegt.frei, false);
  // ⚠️ Kein Name, keine Firma, keine ID — sonst wäre der Endpunkt ein
  // Verzeichnis unserer Kunden.
  assert.doesNotMatch(JSON.stringify(belegt), /Rheinblick|Gästehaus|tenant|id/i);
  assert.equal((await frag('www')).frei, false);
});

test('ohne eigene Angabe kommt der Vorschlag — am Wortende getrennt', async () => {
  const r = await anmelden({ ...KONTO, firma: 'Ferienwohnungen Müller GmbH & Co. KG',
                             email: 'mueller@example.net' });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.equal(JSON.parse(text).slug, 'ferienwohnungen-mueller');
});
