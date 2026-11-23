// Anmeldebremse (23.11.2026): /api/login zählte vorher keine Fehlversuche.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { anmeldeBremse } = require('../src/anmeldebremse');

test('sperrt nach zu vielen Fehlversuchen je IP', () => {
  const b = anmeldeBremse({ jeIp: 3, jeKonto: 100 });
  for (let i = 0; i < 3; i++) { assert.equal(b.gesperrt('1.2.3.4', 'a'), false); b.fehlschlag('1.2.3.4', 'a'); }
  assert.equal(b.gesperrt('1.2.3.4', 'a'), true);
  assert.equal(b.gesperrt('5.6.7.8', 'b'), false, 'andere Adresse bleibt frei');
});

test('sperrt ein Konto auch bei wechselnden IPs', () => {
  const b = anmeldeBremse({ jeIp: 100, jeKonto: 3 });
  for (let i = 0; i < 3; i++) b.fehlschlag(`10.0.0.${i}`, 'chefin');
  assert.equal(b.gesperrt('10.0.0.99', 'chefin'), true);
  assert.equal(b.gesperrt('10.0.0.99', 'andere'), false);
});

test('ein Erfolg setzt den IP-Zähler zurück, das Fenster läuft ab', () => {
  const b = anmeldeBremse({ jeIp: 2, jeKonto: 100, fensterMs: 30 });
  b.fehlschlag('1.1.1.1', 'x'); b.erfolg('1.1.1.1');
  b.fehlschlag('1.1.1.1', 'x');
  assert.equal(b.gesperrt('1.1.1.1', 'x'), false);
  b.fehlschlag('1.1.1.1', 'x');
  assert.equal(b.gesperrt('1.1.1.1', 'x'), true);
  const bis = Date.now() + 40; while (Date.now() < bis) { /* warten */ }
  assert.equal(b.gesperrt('1.1.1.1', 'x'), false);
});

test('⚠️ /api/login benutzt die Bremse', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.post('/api/login'"), src.indexOf("app.post('/api/login'") + 900);
  assert.match(route, /loginBremse\.gesperrt/);
  assert.match(route, /loginBremse\.fehlschlag/);
});

// Gespeichertes XSS (23.11.2026): Was die Kraft schreibt, erscheint in der Verwaltung.
test('⚠️ Freitext der Kräfte geht in app.js nur escaped in innerHTML', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Nur Zeilen mit HTML zählen — Toasts und confirm() setzen Text, kein Markup.
  const htmlZeilen = app.split('\n').filter(z => z.includes('<')).join('\n');
  for (const feld of ['p.beschreibung', 'a.note', 'a.user_name', 's.name', 'u.name', 'l.kraft', 'pr.error']) {
    const roh = new RegExp('\\$\\{' + feld.replace('.', '\\.') + '(\\}| \\|\\|)');
    assert.doesNotMatch(htmlZeilen, roh, `${feld} steht unescaped in einem Template`);
  }
});

test('⚠️ die Anwendungsseiten bekommen eine CSP ohne unsafe-inline für Skripte', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /"script-src 'self'"/);
  assert.match(src, /APP_SEITEN = new Set\(\['index\.html', 'm\.html', 'intern\.html'\]\)/);
});
