// Das Einführungsangebot: die ersten fünf zahlen ein halbes Jahr nichts.
//
// ⚠️ Der Punkt dieses Tests ist NICHT die Rechnung, sondern die Wahrhaftigkeit.
// Am 21.08.2026 stand die Formulierung „noch 2 von 5 verfügbar" im Raum, bei
// einem einzigen Kunden. Eine erfundene Verknappung ist nach Anhang zu § 3 Abs. 3
// UWG Nr. 7 eine per se verbotene Praxis — und bei einem Produkt, das mit
// Nachprüfbarkeit wirbt (offener Quellcode, „Sie können nachlesen, wie gerechnet
// wird"), die denkbar falsche erste Unwahrheit. Deshalb wird gezählt.
//
// ⚠️ Und es wird eng gezählt: Der Demo-Mandant ist ein Schaufenster, der
// Schattenbetrieb ist der EIGENE Betrieb im Vergleichslauf. Beide mitzuzählen
// wäre genau die Verknappung, die nicht behauptet werden soll.
//
// Ausführen: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const WURZEL = path.join(__dirname, '..');
const DATEI = '/tmp/putzflow-aktion-test.sqlite';
const PORT = 39418;
const BASIS = `http://127.0.0.1:${PORT}`;
let kind = null;

const KONTO = {
  name: 'Katrin Berger', street: 'Rheinstraße 12', zip: '40210',
  city: 'Düsseldorf', country: 'DE', password: 'einlangespasswort',
};
const anmelden = (daten) => fetch(`${BASIS}/api/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...KONTO, ...daten }), signal: AbortSignal.timeout(10000),
});
const aktion = () => fetch(`${BASIS}/api/aktion`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());

before(async () => {
  for (const e of ['', '-wal', '-shm']) fs.rmSync(DATEI + e, { force: true });
  const bauen = spawnSync(process.execPath,
    ['-e', "process.env.DB_FILE=process.argv[1];require('./src/db').init()", DATEI],
    { cwd: WURZEL, env: { ...process.env, DB_FILE: DATEI }, encoding: 'utf8' });
  assert.equal(bauen.status, 0, bauen.stderr);

  // ⚠️ Genau die Lage vom 21.08.2026 nachstellen: ein Demo-Mandant, ein
  // Schattenbetrieb (der eigene Betrieb) — und noch KEIN einziger Fremdkunde.
  const db = new DatabaseSync(DATEI);
  db.exec(`INSERT INTO tenants(slug, name, is_demo) VALUES('demo', 'Demo', 1)`);
  db.exec(`INSERT INTO tenants(slug, name, schattenbetrieb) VALUES('duelkener-hof', 'Dülkener Hof (Schattenbetrieb)', 1)`);
  db.exec(`INSERT INTO tenants(slug, name, selbstbetrieb) VALUES('fremde-instanz', 'Selbst betrieben', 1)`);
  db.close();

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
             APP_SECRET: 'test-geheimnis-mindestens-32-zeichen-lang', BOOTSTRAP_DEMO: '0', NODE_ENV: 'test',
             ALARM_EMAIL: '', AKTION_PLAETZE: '5', AKTION_TAGE: '183' },
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

test('⚠️ Demo, Schattenbetrieb und Selbstbetrieb belegen KEINEN Platz', async () => {
  // Drei Mandanten stehen in der Datenbank, keiner davon ist ein Kunde.
  const a = await aktion();
  assert.equal(a.plaetze, 5);
  assert.equal(a.frei, 5, 'ein Nicht-Kunde wurde mitgezählt');
});

test('ein echter Kunde belegt einen Platz', async () => {
  const r = await anmelden({ firma: 'Gästehaus Rheinblick', email: 'eins@example.net' });
  assert.equal(r.status, 200, await r.text());
  assert.equal((await aktion()).frei, 4);
});

test('⚠️ der Gebührenurlaub ist ein längerer Testzeitraum, kein zweiter Mechanismus', async () => {
  // Es gibt kein eigenes Feld: `trial_ends_at` wird von der Schreibsperre und vom
  // Rechnungslauf schon respektiert. Ein halbes Jahr statt sechs Wochen.
  const db = new DatabaseSync(DATEI, { readOnly: true });
  const t = db.prepare(`SELECT trial_ends_at FROM tenants WHERE slug = 'gaestehaus-rheinblick'`).get();
  db.close();
  assert.ok(t, 'Mandant nicht gefunden');
  const tage = Math.round((new Date(t.trial_ends_at) - new Date()) / 86400000);
  assert.ok(tage > 150, `nur ${tage} Tage — das ist der normale Testzeitraum, nicht die Aktion`);
});

test('⚠️ ist die Aktion voll, wird sie nicht mehr behauptet — und nicht mehr gewährt', async () => {
  // Bis zur Grenze auffüllen. Die Anlage-Sperre zählt drei je Stunde und IP,
  // deshalb die restlichen vier direkt in die Datenbank.
  const db = new DatabaseSync(DATEI);
  for (let i = 2; i <= 5; i++) {
    db.prepare(`INSERT INTO tenants(slug, name) VALUES(?, ?)`).run(`kunde-${i}`, `Kunde ${i}`);
  }
  db.close();

  const a = await aktion();
  assert.equal(a.frei, 0);

  // Der sechste bekommt den normalen Testzeitraum.
  const r = await anmelden({ firma: 'Sechster Betrieb', email: 'sechs@example.net' });
  assert.equal(r.status, 200, await r.text());
  const d2 = new DatabaseSync(DATEI, { readOnly: true });
  const t = d2.prepare(`SELECT trial_ends_at FROM tenants WHERE slug = 'sechster-betrieb'`).get();
  d2.close();
  const tage = Math.round((new Date(t.trial_ends_at) - new Date()) / 86400000);
  assert.ok(tage < 90, `${tage} Tage — der sechste hat die Aktion trotzdem bekommen`);
});

test('die Zahl fällt nie unter null', async () => {
  const db = new DatabaseSync(DATEI);
  db.prepare(`INSERT INTO tenants(slug, name) VALUES('einer-zuviel', 'Einer zu viel')`).run();
  db.close();
  const a = await aktion();
  assert.equal(a.frei, 0, 'negative Plätze wären eine sinnlose Aussage');
});

test('die Verkaufsseite behauptet keine Zahl aus sich heraus', (t) => {
  const html = fs.readFileSync(path.join(WURZEL, 'public', 'landing.html'), 'utf8');
  // ⚠️ Im OSS-Export ist `landing.html` eine Platzhalterseite ohne Anmeldung — dort
  // gibt es kein Angebot und nichts zu prüfen. Erkennungsmerkmal: das Formular.
  if (!/id="regform"/.test(html)) return t.skip('Platzhalter-Startseite (OSS-Export)');
  assert.match(html, /api\/aktion/, 'die Seite fragt die Zahl nicht ab');
  // ⚠️ Kein hingeschriebenes „noch N von 5". Fände sich so etwas, wäre es genau
  // die Behauptung, die dieser Test verhindern soll.
  assert.doesNotMatch(html, /noch\s+\d+\s+von\s+\d+/i, 'da steht eine feste Zahl im Quelltext');
});
