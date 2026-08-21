// Wer wissen will, ob sein Produkt lebt, darf nicht in eine Datenbank schauen müssen.
//
// ⚠️ Zwei Zusagen, die gegeneinander stehen und beide gelten müssen:
//   1. Auf DIESER Instanz geht bei jeder Anmeldung eine Mail an den Betreiber.
//   2. Auf einer FREMDEN Instanz geht ohne Konfiguration GAR NICHTS raus.
// Punkt 2 ist der wichtigere: `server.js` geht in den öffentlichen Export. Bis zum
// 21.08.2026 stand in `alarm()` ein Rückfall auf `hallo@putzflow.de` — jede fremde
// Installation hätte uns ungefragt Firmennamen und Anschriften ihrer Kunden
// geschickt. Ein Standardwert, der Post an den Hersteller schickt, ist eine Wanze.
//
// Geprüft wird über den Konsolenkanal (`NOTIFY_CHANNELS=console`): Der schreibt die
// Nachricht in die Ausgabe des Serverprozesses, statt sie zu verschicken.
//
// Ausführen: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const WURZEL = path.join(__dirname, '..');

const KONTO = {
  firma: 'Gästehaus Rheinblick', name: 'Katrin Berger', street: 'Rheinstraße 12',
  zip: '40210', city: 'Düsseldorf', country: 'DE', phone: '0211 1234567',
  password: 'einlangespasswort',
};

// Ein Server, dessen Ausgabe wir mitlesen.
async function serverMitOhr(datei, port, extra) {
  for (const e of ['', '-wal', '-shm']) fs.rmSync(datei + e, { force: true });
  const bauen = spawnSync(process.execPath,
    ['-e', "process.env.DB_FILE=process.argv[1];require('./src/db').init()", datei],
    { cwd: WURZEL, env: { ...process.env, DB_FILE: datei }, encoding: 'utf8' });
  assert.equal(bauen.status, 0, bauen.stderr);

  const zustand = { ausgabe: '' };
  zustand.kind = await new Promise((fertig, fehler) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: WURZEL,
      env: { ...process.env, DB_FILE: datei, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`,
             NOTIFY_CHANNELS: 'console',
             // ⚠️ APP_SECRET MUSS hier stehen. Der Server liest sonst die `.env` des
             // Arbeitsverzeichnisses — die gibt es in der Entwicklung, im Baubaum des
             // OSS-Exports aber nicht, und dort startete er gar nicht erst. Ein Test
             // darf nicht davon abhängen, was zufällig in der `.env` des Entwicklers
             // steht (am 21.08.2026 blockierte genau das die Veröffentlichung).
             APP_SECRET: 'test-geheimnis-mindestens-32-zeichen-lang', BOOTSTRAP_DEMO: '0', NODE_ENV: 'test',
             // ⚠️ Ausdrücklich leeren: Sonst erbt der Kindprozess ein ALARM_EMAIL
             // aus der Umgebung des Entwicklers und der zweite Fall wäre still grün.
             ALARM_EMAIL: '', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bereit = false;
    const t = setTimeout(() => fehler(new Error(`Server kam nicht hoch:\n${zustand.ausgabe}`)), 15000);
    p.stdout.on('data', (d) => {
      zustand.ausgabe += d;
      if (!bereit && zustand.ausgabe.includes('läuft auf')) { bereit = true; clearTimeout(t); fertig(p); }
    });
    p.stderr.on('data', (d) => { zustand.ausgabe += d; });
    p.on('exit', c => { if (!bereit) { clearTimeout(t); fehler(new Error(`Server beendet (${c}):\n${zustand.ausgabe}`)); } });
  });
  return zustand;
}

const anmelden = (port, daten) => fetch(`http://127.0.0.1:${port}/api/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...KONTO, ...daten }), signal: AbortSignal.timeout(10000),
});

// Der Konsolenkanal schreibt asynchron — kurz nachfassen statt blind zu warten.
async function warteAuf(zustand, muster, ms = 4000) {
  const bis = Date.now() + ms;
  while (Date.now() < bis) {
    if (muster.test(zustand.ausgabe)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

let mit = null, ohne = null;

before(async () => {
  mit  = await serverMitOhr('/tmp/putzflow-meldung-mit-test.sqlite',  39414,
                            { ALARM_EMAIL: 'betreiber@example.org' });
  ohne = await serverMitOhr('/tmp/putzflow-meldung-ohne-test.sqlite', 39415, {});
});

after(() => { for (const z of [mit, ohne]) if (z && z.kind) z.kind.kill(); });

test('bei jeder Anmeldung geht eine Meldung an den Betreiber', async () => {
  const r = await anmelden(39414, { email: 'neu@example.net', slug: 'rheinblick' });
  assert.equal(r.status, 200, await r.text());

  assert.ok(await warteAuf(mit, /betreiber@example\.org/),
            `keine Meldung an den Betreiber:\n${mit.ausgabe.slice(-800)}`);
  // Was drinstehen muss, damit die Mail etwas nützt.
  for (const teil of ['neue Anmeldung', 'Gästehaus Rheinblick', 'rheinblick', 'Katrin Berger',
                      'neu@example.net', 'Düsseldorf']) {
    assert.ok(mit.ausgabe.includes(teil), `„${teil}" fehlt in der Meldung`);
  }
  // ⚠️ Das Passwort NIE. Es steht im Klartext im Anfragekörper und wäre mit einer
  // unachtsamen Zeile schnell in einer Mail, die durch fremde Server läuft.
  assert.ok(!mit.ausgabe.includes(KONTO.password), '⚠️ das Passwort steht in der Meldung');
});

test('⚠️ ohne ALARM_EMAIL geht NICHTS raus — nur ins Log', async () => {
  const r = await anmelden(39415, { email: 'fremd@example.net', slug: 'fremder-betrieb' });
  assert.equal(r.status, 200, await r.text());

  assert.ok(await warteAuf(ohne, /ALARM_EMAIL nicht gesetzt/),
            `der Hinweis im Log fehlt:\n${ohne.ausgabe.slice(-800)}`);
  // Der eigentliche Punkt: kein Empfänger, und vor allem NICHT unsere Adresse.
  assert.ok(!/hallo@putzflow\.de/.test(ohne.ausgabe),
            '⚠️ eine fremde Instanz würde uns Post schicken');
  assert.ok(!/notify:console.*an .*@/.test(ohne.ausgabe.split('neue Anmeldung')[1] || ''),
            'es wurde doch eine Nachricht adressiert');
});

test('auch der Fehlschlag meldet sich — aber nur mit Empfänger', async () => {
  // Der Alarm von heute Morgen läuft über denselben Weg; wäre er noch fest auf
  // hallo@putzflow.de verdrahtet, träfe ihn dieselbe Lücke.
  const quelle = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  assert.match(quelle, /function alarm\([\s\S]{0,200}benachrichtige\(/,
               'alarm() geht nicht über benachrichtige() — dann gilt die Sperre für ihn nicht');
  assert.ok(!/ALARM_EMAIL\s*\|\|\s*'/.test(quelle),
            '⚠️ es gibt wieder einen Rückfall-Empfänger in server.js');
});
