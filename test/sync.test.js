// Tests der Smoobu-Übernahme: Storno, Verschiebung, Eigenbelegung.
// Ausführen: npm test

// ⚠️ Eigene Testdatenbank. Diese Datei zieht ueber src/signatur bzw. src/sync
// das Modul src/db herein, und das oeffnet die Datei beim Laden. Ohne eigenen
// Pfad greifen mehrere Testdateien gleichzeitig auf dieselbe SQLite-Datei zu --
// node --test faehrt sie parallel -- und unter Last faellt eine ganze Datei aus.
process.env.DB_FILE = '/tmp/putzflow-sync-test.sqlite';

const test = require('node:test');
const assert = require('node:assert');
const { istGast, SCHLUESSEL } = require('../src/sync');
const { signieren } = require('../src/smoobu');

const gast = { id: 1, type: 'reservation', departure: '2026-08-01', 'is-blocked-booking': false };

test('Nur echte Gastbuchungen erzeugen eine Reinigung', () => {
  assert.equal(istGast(gast), true);
  assert.equal(istGast({ ...gast, type: 'cancellation' }), false, 'Storno');
  assert.equal(istGast({ ...gast, 'is-blocked-booking': true }), false, 'Eigenbelegung des Vermieters');
  assert.equal(istGast({ ...gast, departure: null }), false, 'ohne Abreisedatum keine Reinigung');
  assert.equal(istGast(null), false);
});

test('Der Schlüssel bindet den Auftrag an die Buchung', () => {
  assert.equal(SCHLUESSEL({ id: 4711 }), 'smoobu:4711');
  assert.notEqual(SCHLUESSEL({ id: 1 }), SCHLUESSEL({ id: 2 }));
});

test('Signatur: Query-Paare bleiben codiert und werden als Ganzes sortiert', () => {
  // Genau hier lag die Falle: Wer dekodiert oder nur nach Schlüsseln sortiert,
  // bekommt von Smoobu 401.
  const a = signieren('k', 's', '/api/reservations', '?b=2&a=1');
  const b = signieren('k', 's', '/api/reservations', '?a=1&b=2');
  // Zeitstempel und Nonce unterscheiden sich, die Struktur muss aber stimmen.
  for (const kopf of [a, b]) {
    assert.ok(kopf['X-Signature'], 'Signatur fehlt');
    assert.ok(kopf['X-Nonce'], 'Nonce fehlt');
    assert.match(kopf['X-Timestamp'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'ohne Millisekunden');
    assert.equal(kopf['X-API-Key'], 'k');
  }
});

test('Signatur ist bei gleichem Zeitstempel reproduzierbar', () => {
  const echt = Date.prototype.toISOString;
  const uuid = require('crypto').randomUUID;
  Date.prototype.toISOString = () => '2026-07-26T12:00:00.000Z';
  require('crypto').randomUUID = () => 'feste-nonce';
  try {
    const a = signieren('k', 's', '/api/me', '');
    const b = signieren('k', 's', '/api/me', '');
    assert.equal(a['X-Signature'], b['X-Signature']);
    const c = signieren('k', 'anderes-secret', '/api/me', '');
    assert.notEqual(a['X-Signature'], c['X-Signature'], 'anderes Secret, andere Signatur');
  } finally {
    Date.prototype.toISOString = echt;
    require('crypto').randomUUID = uuid;
  }
});

test('Der Smoobu-Zugriff bleibt lesend', () => {
  const fs = require('fs');
  const quelle = fs.readFileSync(require.resolve('../src/smoobu.js'), 'utf8');

  // Kein Schreibzugriff im Client — weder als fetch-Option noch als Methode.
  assert.ok(!/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(quelle),
    'Der Client darf keine schreibende HTTP-Methode setzen');

  // Die Signatur verdrahtet GET fest. Selbst ein versehentliches POST würde damit
  // von Smoobu abgewiesen — eine Sicherung unterhalb der Absicht des Aufrufers.
  assert.match(quelle, /\['GET', pfad/, 'Kanonischer String muss GET festschreiben');

  const c = require('../src/smoobu').client({ key: 'k', secret: 's' });
  assert.deepEqual(Object.keys(c).sort(), ['buchungen', 'get', 'konto', 'unterkuenfte'],
    'Der Client bietet ausschließlich lesende Funktionen');
});
