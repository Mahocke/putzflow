// Das eigene Konto — und was ein Passwortwechsel mit offenen Sitzungen macht.
//
// ⚠️ Der häufigste Grund, ein Passwort zu wechseln, ist der Verdacht, dass
// jemand mitliest. Bliebe dessen Sitzung offen, hätte der Wechsel genau nichts
// bewirkt — das Cookie gilt ein Jahr.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-konto-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const { init, run, get, all } = require('../src/db');
const auth = require('../src/auth');
init();

run(`INSERT INTO tenants(slug, name) VALUES('hof', 'Musterhof')`);
const t = get(`SELECT * FROM tenants WHERE slug = 'hof'`);
run(`INSERT INTO users(tenant_id, email, name, role, password_hash) VALUES(?,?,?,'owner',?)`,
    t.id, 'anna@musterhof.de', 'Anna Muster', auth.hashPassword('geheim1234'));
run(`INSERT INTO users(tenant_id, email, name, role, password_hash) VALUES(?,?,?,'admin',?)`,
    t.id, 'bea@musterhof.de', 'Bea Beispiel', auth.hashPassword('geheim1234'));
const anna = get(`SELECT * FROM users WHERE email = 'anna@musterhof.de'`);
const bea = get(`SELECT * FROM users WHERE email = 'bea@musterhof.de'`);

test('ein Passwortwechsel beendet die ANDEREN Sitzungen, nicht die eigene', () => {
  const hier = auth.createSession(t.id, anna.id);        // der Rechner, an dem sie sitzt
  const telefon = auth.createSession(t.id, anna.id);     // ihr Telefon
  const fremd = auth.createSession(t.id, anna.id);       // der mitlesende Dritte
  const beas = auth.createSession(t.id, bea.id);         // eine ANDERE Person

  auth.beendeAndereSitzungen(anna.id, hier.raw);

  assert.ok(auth.sessionUser(hier.raw), '⚠️ die eigene bleibt — sonst fliegt man beim Speichern raus');
  assert.equal(auth.sessionUser(telefon.raw), null);
  assert.equal(auth.sessionUser(fremd.raw), null, 'das war der ganze Zweck');
  assert.ok(auth.sessionUser(beas.raw), '⚠️ fremde Konten bleiben unberührt');
});

test('ohne eigene Sitzung fliegen alle raus', () => {
  // Der Weg von der Kommandozeile: Dort gibt es kein Cookie, und dann ist
  // „alle" richtig — sonst bliebe ausgerechnet beim Notfall etwas offen.
  const a = auth.createSession(t.id, anna.id);
  const b = auth.createSession(t.id, anna.id);
  auth.beendeAndereSitzungen(anna.id, null);
  assert.equal(auth.sessionUser(a.raw), null);
  assert.equal(auth.sessionUser(b.raw), null);
});

test('das neue Passwort gilt, das alte nicht mehr', () => {
  run(`UPDATE users SET password_hash = ? WHERE id = ?`, auth.hashPassword('neues-passwort'), anna.id);
  const u = get(`SELECT * FROM users WHERE id = ?`, anna.id);
  assert.equal(auth.verifyPassword('neues-passwort', u.password_hash), true);
  assert.equal(auth.verifyPassword('geheim1234', u.password_hash), false);
  assert.ok(!u.password_hash.includes('neues-passwort'), 'gespeichert wird nur der Hash');
});

test('Sitzungen hängen an der Person, nicht am Mandanten', () => {
  // Sonst beendete ein Passwortwechsel bei einem Kunden die Sitzungen eines
  // anderen — oder, schlimmer, eben nicht.
  const offen = all(`SELECT user_id FROM sessions`);
  assert.ok(offen.every(s => typeof s.user_id === 'number'));
});
