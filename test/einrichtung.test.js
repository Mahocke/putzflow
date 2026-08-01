// Die Ersteinrichtung — der Weg hinein auf einer frischen Instanz.
//
// ⚠️ Zwei Dinge müssen hier stimmen, sonst ist die Instanz entweder
// unbenutzbar oder offen: Der Weg muss offen sein, SOLANGE es keinen echten
// Betrieb gibt, und danach zu. Und der Code muss zählen.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

process.env.DB_FILE = '/tmp/putzflow-einrichtung-test.sqlite';
fs.rmSync(process.env.DB_FILE, { force: true });
fs.rmSync('/tmp/EINRICHTUNG.txt', { force: true });

const { init, run, get } = require('../src/db');
const einrichtung = require('../src/einrichtung');
init();

test('offen, solange es keinen Betrieb gibt', () => {
  assert.equal(einrichtung.offen(), true);
});

test('der Demo-Mandant versperrt die Einrichtung NICHT', () => {
  // Er entsteht beim ersten Start von selbst (BOOTSTRAP_DEMO). Zählte er mit,
  // wäre die Einrichtung zu, bevor sie jemand gesehen hat.
  run(`INSERT INTO tenants(slug, name, is_demo) VALUES('demo', 'Demo', 1)`);
  assert.equal(einrichtung.offen(), true);
});

test('Code: Schreibweise egal, Bindestrich egal — aber falsch bleibt falsch', () => {
  const c = einrichtung.code();
  assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(einrichtung.codeStimmt(c), true);
  assert.equal(einrichtung.codeStimmt(c.toLowerCase()), true);
  assert.equal(einrichtung.codeStimmt(c.replace('-', '')), true);
  assert.equal(einrichtung.codeStimmt(` ${c} `), true);
  assert.equal(einrichtung.codeStimmt('FALS-CHE1'), false);
  assert.equal(einrichtung.codeStimmt(''), false);
  assert.equal(einrichtung.codeStimmt(null), false);
});

test('der Code überlebt einen Neustart', () => {
  // Sonst wäre der Zettel, den jemand gerade abgeschrieben hat, nach einem
  // `systemctl restart` wertlos — und der Fehler sähe wie ein Tippfehler aus.
  const c = einrichtung.code();
  delete require.cache[require.resolve('../src/einrichtung')];
  const frisch = require('../src/einrichtung');
  assert.equal(frisch.code(), c);
});

test('anlegen erzeugt Betrieb, Inhaber und Vergütungsregel', () => {
  const t = einrichtung.anlegen({
    slug: 'musterhof', firma: 'Ferienwohnungen Musterhof',
    name: 'Anna Muster', email: '  Anna@Example.ORG ', passwort: 'geheim1234',
  });
  assert.equal(t.slug, 'musterhof');
  // ⚠️ Sofort bestätigt: Wer den Einrichtungscode hat, sitzt an der Maschine.
  // Eine Bestätigungsmail wäre der wahrscheinlichste Punkt zum Scheitern.
  assert.ok(t.email_verified_at, 'E-Mail gilt als bestätigt');
  assert.equal(t.trial_ends_at, null, 'kein Testzeitraum beim Selbstbetrieb');
  // ⚠️ Ohne dieses Kennzeichen wäre der frisch eingerichtete Betrieb sofort nur
  // lesbar: kein Testzeitraum = abgelaufen. Und niemand auf einer eigenen
  // Instanz könnte die Sperre aufheben.
  assert.equal(t.selbstbetrieb, 1, 'selbst betrieben — es gibt nichts abzurechnen');

  const u = get(`SELECT * FROM users WHERE tenant_id = ?`, t.id);
  assert.equal(u.email, 'anna@example.org', 'Adresse normalisiert');
  assert.equal(u.role, 'owner');
  assert.ok(u.password_hash && !u.password_hash.includes('geheim1234'),
            'nur der Hash wird gespeichert');
  assert.ok(get(`SELECT * FROM comp_rules WHERE tenant_id = ?`, t.id),
            'ohne Vergütungsregel stünde die erste Zuteilung ohne Betrag da');
});

test('danach ist der Weg zu — und der Code von der Platte', () => {
  assert.equal(einrichtung.offen(), false);
  assert.equal(fs.existsSync(einrichtung.codeDatei()), false,
               'die Code-Datei bleibt nicht liegen');
});
