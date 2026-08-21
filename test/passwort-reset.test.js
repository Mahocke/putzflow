// Passwort vergessen — der einzige Weg zurück ins Konto ohne Anmeldung und
// damit die empfindlichste Stelle im System.
//
// ⚠️ Was hier schiefgehen kann, geht immer gleich aus: Ein Fremder übernimmt
// ein Konto. Die Tests halten deshalb weniger die Funktion fest als die
// Grenzen — abgelaufen, verbraucht, fremder Mandant, offene Sitzungen.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-reset-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const { init, run, get } = require('../src/db');
const auth = require('../src/auth');
init();

run(`INSERT INTO tenants(slug, name) VALUES('hof', 'Musterhof')`);
run(`INSERT INTO tenants(slug, name) VALUES('see', 'Seeblick')`);
const hof = get(`SELECT * FROM tenants WHERE slug = 'hof'`);
const see = get(`SELECT * FROM tenants WHERE slug = 'see'`);
run(`INSERT INTO users(tenant_id, email, name, role, password_hash) VALUES(?,?,?,'owner',?)`,
    hof.id, 'anna@musterhof.de', 'Anna', auth.hashPassword('altes-passwort'));
run(`INSERT INTO users(tenant_id, email, name, role, password_hash) VALUES(?,?,?,'owner',?)`,
    see.id, 'bea@seeblick.de', 'Bea', auth.hashPassword('altes-passwort'));
const anna = get(`SELECT * FROM users WHERE email = 'anna@musterhof.de'`);
const bea = get(`SELECT * FROM users WHERE email = 'bea@seeblick.de'`);

test('der Token steht nur als Hash in der Datenbank', () => {
  // ⚠️ Sonst könnte jeder, der eine Sicherungskopie liest, jedes offene
  // Zurücksetzen zu Ende führen.
  const { raw } = auth.createReset(hof.id, anna.id);
  const zeile = get(`SELECT id FROM password_resets WHERE user_id = ?`, anna.id);
  assert.ok(zeile);
  assert.notEqual(zeile.id, raw);
  assert.ok(auth.resetByToken(raw), 'der rohe Token passt trotzdem');
});

test('ein neuer Token entwertet den alten', () => {
  // Wer dreimal klickt, soll nicht drei gültige Schlüssel in drei Mails haben.
  const a = auth.createReset(hof.id, anna.id);
  const b = auth.createReset(hof.id, anna.id);
  assert.equal(auth.resetByToken(a.raw), null);
  assert.ok(auth.resetByToken(b.raw));
});

test('einmal verwendbar', () => {
  const { raw } = auth.createReset(hof.id, anna.id);
  assert.ok(auth.useReset(raw, 'neues-passwort-1'));
  assert.equal(auth.resetByToken(raw), null, 'danach tot');
  assert.equal(auth.useReset(raw, 'noch-eins'), null);
  const u = get(`SELECT * FROM users WHERE id = ?`, anna.id);
  assert.equal(auth.verifyPassword('neues-passwort-1', u.password_hash), true);
  assert.equal(auth.verifyPassword('altes-passwort', u.password_hash), false);
});

test('abgelaufene Token gelten nicht', () => {
  const { raw } = auth.createReset(hof.id, anna.id);
  run(`UPDATE password_resets SET expires_at = ? WHERE user_id = ? AND used_at IS NULL`,
      new Date(Date.now() - 60000).toISOString(), anna.id);
  assert.equal(auth.resetByToken(raw), null);
});

test('⚠️ ein Zurücksetzen beendet ALLE Sitzungen', () => {
  // Auch die des Angreifers. Wer sein Passwort zurücksetzt, hat im Zweifel
  // keinen Zugriff mehr auf sein Konto — bliebe die fremde Sitzung offen, wäre
  // das Zurücksetzen ein Placebo.
  const meine = auth.createSession(hof.id, anna.id);
  const fremde = auth.createSession(hof.id, anna.id);
  const beas = auth.createSession(see.id, bea.id);
  const { raw } = auth.createReset(hof.id, anna.id);
  auth.useReset(raw, 'wieder-neu-1234');
  assert.equal(auth.sessionUser(meine.raw), null);
  assert.equal(auth.sessionUser(fremde.raw), null);
  assert.ok(auth.sessionUser(beas.raw), '⚠️ fremde Konten bleiben unberührt');
});

test('der Token trägt seinen Mandanten mit', () => {
  // ⚠️ Die Route prüft, dass er zum Host passt. Ohne diese Angabe wäre ein Link
  // über Subdomains hinweg ein Mandantensprung.
  const { raw } = auth.createReset(see.id, bea.id);
  const r = auth.resetByToken(raw);
  assert.equal(r.tenant_id, see.id);
  assert.notEqual(r.tenant_id, hof.id);
});

test('stillgelegte Konten lassen sich nicht zurücksetzen', () => {
  const { raw } = auth.createReset(see.id, bea.id);
  run(`UPDATE users SET active = 0 WHERE id = ?`, bea.id);
  assert.equal(auth.resetByToken(raw), null);
  run(`UPDATE users SET active = 1 WHERE id = ?`, bea.id);
});

test('Aufräumen entfernt Abgelaufenes, nicht Gültiges', () => {
  run(`DELETE FROM password_resets`);
  const gueltig = auth.createReset(hof.id, anna.id);
  run(`INSERT INTO password_resets(id, tenant_id, user_id, expires_at)
       VALUES('alt', ?, ?, ?)`, hof.id, anna.id, new Date(Date.now() - 3600000).toISOString());
  auth.cleanupExpired();
  assert.ok(auth.resetByToken(gueltig.raw));
  assert.equal(get(`SELECT id FROM password_resets WHERE id = 'alt'`), undefined);
});
