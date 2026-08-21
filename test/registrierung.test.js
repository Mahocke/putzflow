// Die Anmeldung auf putzflow.de — der Weg von der Verkaufsseite ins eigene Konto.
//
// ⚠️ Dieser Test startet den ECHTEN Server als Kindprozess und spricht ihn über
// HTTP an. Das ist der einzige Test im Repo, der das tut, und er hat einen Anlass:
// Vom 26.07. bis zum 21.08.2026 war die Anmeldung auf putzflow.de tot. Kein Test
// hat es gemerkt, weil alle Tests unterhalb der Routen ansetzen — und die Fehler
// saßen IN den Routen und im gelebten Datenbankschema. Drei Wochen lang konnte
// niemand Kunde werden. Gemeldet hat es am Ende ein Interessent per Mail.
//
// ⚠️ Und er baut die Datenbank absichtlich so, wie sie auf hauptbox WIRKLICH war
// (`region TEXT NOT NULL DEFAULT 'NW'`), nicht so, wie ein frisches `init()` sie
// anlegt. Genau dieser Unterschied hat den Fehler in der Entwicklung unsichtbar
// gemacht: Auf dev ging die Anmeldung, auf prod nie.
//
// Ausführen: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const WURZEL = path.join(__dirname, '..');

// --- Eine Datenbank im Zustand von damals -----------------------------------
function bestandsdatenbankBauen(datei) {
  fs.rmSync(datei, { force: true });
  fs.rmSync(`${datei}-wal`, { force: true });
  fs.rmSync(`${datei}-shm`, { force: true });

  // Erst das heutige Schema anlegen lassen …
  const bauen = require('node:child_process').spawnSync(
    process.execPath,
    ['-e', "process.env.DB_FILE=process.argv[1];require('./src/db').init()", datei],
    { cwd: WURZEL, env: { ...process.env, DB_FILE: datei }, encoding: 'utf8' },
  );
  assert.equal(bauen.status, 0, `Schema-Aufbau fehlgeschlagen: ${bauen.stderr}`);

  // … und `tenants` dann auf den alten Stand ZURÜCKdrehen.
  const db = new DatabaseSync(datei);
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tenants'`).get().sql;
  const alt = sql
    .replace(/region\s+TEXT(?!\s+NOT)/i, "region TEXT NOT NULL DEFAULT 'NW'")
    .replace(/^CREATE TABLE\s+"?tenants"?/i, 'CREATE TABLE tenants__alt');
  assert.match(alt, /region TEXT NOT NULL DEFAULT 'NW'/, 'Rückbau griff nicht');
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`UPDATE tenants SET region = 'NW' WHERE region IS NULL`);
  db.exec(alt);
  db.exec(`INSERT INTO tenants__alt SELECT * FROM tenants`);
  db.exec(`DROP TABLE tenants`);
  db.exec(`ALTER TABLE tenants__alt RENAME TO tenants`);
  db.close();
  return datei;
}

function spalte(datei, tabelle, name) {
  const db = new DatabaseSync(datei, { readOnly: true });
  const s = db.prepare(`PRAGMA table_info(${tabelle})`).all().find(c => c.name === name);
  db.close();
  return s;
}

// --- Server als Kindprozess --------------------------------------------------
let kind = null;
let BASIS = null;

function serverStarten(datei, port, extra = {}) {
  return new Promise((fertig, fehler) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: WURZEL,
      env: {
        ...process.env,
        DB_FILE: datei,
        PORT: String(port),
        BASE_URL: `http://127.0.0.1:${port}`,
        NOTIFY_CHANNELS: 'console',
        // ⚠️ APP_SECRET MUSS hier stehen. Der Server liest sonst die `.env` des
        // Arbeitsverzeichnisses — die gibt es in der Entwicklung, im Baubaum des
        // OSS-Exports aber nicht, und dort startete er gar nicht erst. Ein Test
        // darf nicht davon abhängen, was zufällig in der `.env` des Entwicklers
        // steht (am 21.08.2026 blockierte genau das die Veröffentlichung).
        APP_SECRET: 'test-geheimnis-mindestens-32-zeichen-lang',
        BOOTSTRAP_DEMO: '1',
        NODE_ENV: 'test',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ausgabe = '';
    const zeitgeber = setTimeout(() => fehler(new Error(`Server kam nicht hoch:\n${ausgabe}`)), 15000);
    p.stdout.on('data', (d) => {
      ausgabe += d;
      if (ausgabe.includes('läuft auf')) { clearTimeout(zeitgeber); fertig(p); }
    });
    p.stderr.on('data', (d) => { ausgabe += d; });
    p.on('exit', (c) => { clearTimeout(zeitgeber); fehler(new Error(`Server beendet (${c}):\n${ausgabe}`)); });
  });
}

const KONTO = {
  firma: 'Haus am Deich Ferienwohnungen GmbH (haftungsbeschränkt)',
  name: 'Katrin Berger',
  email: 'katrin@example.net',
  street: 'Deichstraße 15A',
  zip: '25813',
  city: 'Husum',
  country: 'DE',
  phone: '+49 (0) 176 1234567',
  password: 'einlangespasswort',
};

function anmelden(daten) {
  return fetch(`${BASIS}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(daten),
    signal: AbortSignal.timeout(10000),   // ⚠️ ein Hänger ist ein Fehlschlag, kein Warten
  });
}

const DATEI = '/tmp/putzflow-registrierung-test.sqlite';

before(async () => {
  bestandsdatenbankBauen(DATEI);
  // Vor dem Start: die Bedingung von damals steht wirklich noch da.
  assert.equal(spalte(DATEI, 'tenants', 'region').notnull, 1,
               'Vorbedingung: region müsste NOT NULL sein');
  kind = await serverStarten(DATEI, 39411);
  BASIS = 'http://127.0.0.1:39411';
});

after(() => { if (kind) kind.kill(); });

// ---------------------------------------------------------------------------

test('die Migration nimmt NOT NULL von tenants.region — und verliert dabei nichts', () => {
  const s = spalte(DATEI, 'tenants', 'region');
  assert.equal(s.notnull, 0, 'NOT NULL steht noch');
  assert.equal(s.dflt_value, null, "der stille Rückfall auf 'NW' steht noch");

  // Der Demo-Mandant aus dem Bootstrap hat den Umbau überlebt …
  const db = new DatabaseSync(DATEI, { readOnly: true });
  const demo = db.prepare(`SELECT * FROM tenants WHERE slug = 'demo'`).get();
  // … samt aller nachgerüsteten Spalten. `urlaub_werktage` kam als letzte dazu;
  // ginge beim Tabellen-Neubau etwas verloren, dann am ehesten am Ende.
  const spalten = db.prepare(`PRAGMA table_info(tenants)`).all().map(c => c.name);
  db.close();
  assert.ok(demo, 'Demo-Mandant ist beim Umbau verschwunden');
  for (const n of ['slug', 'name', 'region', 'herkunft', 'selbstbetrieb', 'urlaub_werktage']) {
    assert.ok(spalten.includes(n), `Spalte ${n} fehlt nach dem Umbau`);
  }
});

test('genau die Anmeldung vom 20.08.2026 geht durch', async () => {
  const r = await anmelden(KONTO);
  const text = await r.text();
  assert.equal(r.status, 200, `erwartet 200, bekommen ${r.status}: ${text.slice(0, 200)}`);
  const d = JSON.parse(text);
  assert.equal(d.ok, true);
  // ⚠️ Vorher wurde der Firmenname hart nach 40 Zeichen mitten im Wort
  // abgeschnitten. Klammerinhalt und Rechtsform sind jetzt draußen.
  assert.equal(d.slug, 'haus-am-deich');
  // Und der Mandant steht ohne Bundesland da, statt still nordrhein-westfälisch zu sein.
  const db = new DatabaseSync(DATEI, { readOnly: true });
  const t = db.prepare(`SELECT region FROM tenants WHERE slug = ?`).get(d.slug);
  db.close();
  assert.equal(t.region, null, 'region wurde still belegt');
});

test('wer in der Demo als Putzkraft steht, darf trotzdem ein eigenes Konto anlegen', async () => {
  // ⚠️ Der Fall, der ihn zwölfmal abgewiesen hat. Die Verkaufsseite lädt zur Demo
  // ein, die Demo ist öffentlich beschreibbar — wer dort seine eigene Adresse
  // einträgt, darf davon nicht ausgesperrt werden.
  const db = new DatabaseSync(DATEI);
  const demo = db.prepare(`SELECT id FROM tenants WHERE slug = 'demo'`).get();
  db.prepare(`INSERT INTO users(tenant_id, email, name, role) VALUES(?,?,?,'cleaner')`)
    .run(demo.id, 'katrin@rheinblick.de', 'Katrin Berger');
  db.close();

  const r = await anmelden({ ...KONTO, firma: 'Gästehaus Rheinblick', email: 'katrin@rheinblick.de' });
  assert.equal(r.status, 200, `Demo-Eintrag sperrt noch: ${(await r.text()).slice(0, 200)}`);
});

test('wer schon einen eigenen Betrieb führt, bekommt seine Adresse genannt statt einer Sackgasse', async () => {
  const r = await anmelden({ ...KONTO, firma: 'Noch ein Betrieb' });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.match(d.error, /haus-am-deich/, 'die Adresse fehlt in der Meldung');
  // ⚠️ Die Adresse muss aus BASE_URL kommen. Im ersten Anlauf stand hier
  // `putzflow.de` fest im Quelltext — auf einer fremden Instanz hätte die Meldung
  // den Kunden zu UNS geschickt.
  assert.match(d.error, /127\.0\.0\.1:39411/, 'die Adresse kommt nicht aus BASE_URL');
  assert.doesNotMatch(d.error, /putzflow\.de/, 'fester Domainname in der Meldung');
});

test('abgewiesene Versuche verbrauchen die Anlage-Sperre nicht', async () => {
  // ⚠️ Vorher zählte der Zähler schon den VERSUCH. Weil jede Anlage am
  // region-Fehler abstürzte, hat unser eigener Absturz den Besucher nach drei
  // Anläufen für eine Stunde ausgesperrt — mit der Meldung, er habe „gerade
  // mehrere Konten angelegt". Er hatte kein einziges.
  for (let i = 0; i < 6; i++) {
    const r = await anmelden({ ...KONTO, firma: `Zu kurzes Passwort ${i}`, email: `x${i}@example.net`, password: 'kurz' });
    assert.equal(r.status, 400, 'sollte an der Passwortlänge scheitern, nicht an der Sperre');
  }
  // Zwei Konten sind bisher entstanden, die dritte Anlage muss noch möglich sein.
  const r = await anmelden({ ...KONTO, firma: 'Dritter Betrieb', email: 'dritter@example.net' });
  assert.equal(r.status, 200, `Sperre hat trotz reiner Fehlversuche zugeschlagen: ${(await r.text()).slice(0, 200)}`);
});

test('/login ist keine Sackgasse mehr', async () => {
  const r = await fetch(`${BASIS}/login`, { signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /eigene Adresse/);
  assert.match(html, /adresse-vergessen/);

  // ⚠️ Das Skript dieser Seite wird im Server zusammengebaut, liegt also in KEINER
  // Datei — `test/inline-skript.test.js` sieht es nicht. Ein Syntaxfehler darin
  // wäre unsichtbar: Die Seite lädt, das Formular tut nichts.
  const skript = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(skript, 'kein eingebettetes Skript auf /login gefunden');
  assert.doesNotThrow(() => new (require('node:vm').Script)(skript[1]),
                      '/login: eingebettetes Skript hat einen Syntaxfehler');
});

test('die Adress-Erinnerung verrät nicht, wer Kunde ist', async () => {
  const antworten = await Promise.all(['katrin@example.net', 'niemand@example.net'].map(email =>
    fetch(`${BASIS}/api/adresse-vergessen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10000),
    }).then(r => r.text())));
  assert.equal(antworten[0], antworten[1], 'die Antworten unterscheiden sich — das ist ein Auskunftsschalter');
});
