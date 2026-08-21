// Auf jede Anfrage kommt eine Antwort — auch auf die, bei der wir Mist bauen.
//
// ⚠️ Der Anlass: Am 20.08.2026 warf `/api/register` in einer `async`-Route. Express 4
// fängt das nicht, die Ablehnung blieb unbehandelt, und es ging ÜBERHAUPT KEINE
// Antwort raus. Der Besucher sah eine Minute lang „Wird angelegt …", danach eine
// nginx-Fehlerseite (504) — und die Verkaufsseite, die JSON erwartete, machte daraus
// einen Parser-Fehler. Aus einer falschen Datenbankspalte wurde so ein Produkt, das
// aussah, als sei es gar nicht da.
//
// Dieser Test erzwingt genau diesen Fehler und besteht darauf, dass er WEHTUT statt
// zu HÄNGEN: schnelle Antwort, sauberes JSON, verständlicher Satz.
//
// Ausführen: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const WURZEL = path.join(__dirname, '..');
const DATEI = '/tmp/putzflow-fehlerantwort-test.sqlite';
const PORT = 39412;
const BASIS = `http://127.0.0.1:${PORT}`;
let kind = null;

// Eine Datenbank, in die `/api/register` nicht schreiben KANN: eine Pflichtspalte,
// von der der Server nichts weiß. Stellvertreter für jeden Schemastand, der von dem
// abweicht, den die Entwicklung vor sich hat — also für den Fehler vom 20.08. selbst.
function stolperdatenbankBauen() {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DATEI + s, { force: true });
  const bauen = spawnSync(process.execPath,
    ['-e', "process.env.DB_FILE=process.argv[1];require('./src/db').init()", DATEI],
    { cwd: WURZEL, env: { ...process.env, DB_FILE: DATEI }, encoding: 'utf8' });
  assert.equal(bauen.status, 0, bauen.stderr);

  const db = new DatabaseSync(DATEI);
  db.exec(`ALTER TABLE tenants ADD COLUMN pflichtfeld TEXT NOT NULL DEFAULT 'x'`);
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tenants'`).get().sql;
  // Der Standardwert muss weg, sonst füllt SQLite die Lücke selbst und alles geht gut.
  const ohne = sql.replace(/pflichtfeld TEXT NOT NULL DEFAULT 'x'/, 'pflichtfeld TEXT NOT NULL')
                  .replace(/^CREATE TABLE\s+"?tenants"?/i, 'CREATE TABLE tenants__stolper');
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(ohne);
  db.exec(`INSERT INTO tenants__stolper SELECT * FROM tenants`);
  db.exec(`DROP TABLE tenants`);
  db.exec(`ALTER TABLE tenants__stolper RENAME TO tenants`);
  // Ein Mandant muss drin sein, sonst legt der Bootstrap beim Start einen an und
  // scheitert schon dort — geprüft werden soll die ROUTE, nicht der Start.
  db.exec(`INSERT INTO tenants(slug, name, is_demo, pflichtfeld) VALUES('demo', 'Demo', 1, 'x')`);
  db.close();
}

before(async () => {
  stolperdatenbankBauen();
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

test('⚠️ ein Fehler in der Route hängt nicht — er antwortet, und zwar sofort', async () => {
  const start = Date.now();
  const r = await fetch(`${BASIS}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firma: 'Gästehaus Rheinblick', name: 'Katrin Berger', email: 'katrin@rheinblick.de',
      street: 'Rheinstraße 12', zip: '40210', city: 'Düsseldorf', country: 'DE',
      password: 'einlangespasswort',
    }),
    // ⚠️ Kurz. Vor der Reparatur wäre hier NICHTS gekommen, bis nginx nach 60
    // Sekunden abbricht — ein Test, der lange wartet, würde den Fehler verdecken.
    signal: AbortSignal.timeout(5000),
  });
  const gedauert = Date.now() - start;

  assert.equal(r.status, 500);
  assert.ok(gedauert < 3000, `hat ${gedauert} ms gebraucht — das riecht nach Hänger`);
  assert.match(r.headers.get('content-type') || '', /application\/json/,
               'die Verkaufsseite erwartet JSON; HTML wird dort zum Parser-Fehler');

  const d = await r.json();
  // Der Satz muss dem Besucher sagen, dass er nichts falsch gemacht hat, und wohin
  // er sich wenden kann. „Internal Server Error" tut beides nicht.
  assert.match(d.error, /nicht bei Ihnen/);
  assert.match(d.error, /hallo@putzflow\.de/);
  // Und er darf keine Innereien verraten.
  assert.doesNotMatch(d.error, /SQLITE|constraint|tenants|at .*\.js:/i);
});

test('der Server lebt danach weiter', async () => {
  // Ein abgestürzter Prozess wäre die andere Art, diesen Test zu bestehen.
  const r = await fetch(`${BASIS}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200);
});

test('halb angelegte Konten bleiben nicht zurück', async () => {
  // ⚠️ Die drei Einfügungen laufen in einer Transaktion. Ohne sie stünde jetzt ein
  // Mandant ohne Eigentümer in der Datenbank: Der Slug wäre vergeben, niemand käme
  // hinein, und der zweite Anlauf liefe in einen anderen Slug.
  const db = new DatabaseSync(DATEI, { readOnly: true });
  const t = db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE slug <> 'demo'`).get();
  const waisen = db.prepare(
    `SELECT COUNT(*) AS n FROM tenants t
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner')
         AND t.slug <> 'demo'`).get();
  db.close();
  assert.equal(t.n, 0, 'ein Mandant ist trotz Fehlschlag entstanden');
  assert.equal(waisen.n, 0, 'Mandant ohne Eigentümer zurückgeblieben');
});
