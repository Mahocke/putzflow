// Tests der Smoobu-Übernahme: Storno, Verschiebung, Eigenbelegung.
// Ausführen: npm test

// ⚠️ Eigene Testdatenbank. Diese Datei zieht ueber src/signatur bzw. src/sync
// das Modul src/db herein, und das oeffnet die Datei beim Laden. Ohne eigenen
// Pfad greifen mehrere Testdateien gleichzeitig auf dieselbe SQLite-Datei zu --
// node --test faehrt sie parallel -- und unter Last faellt eine ganze Datei aus.
process.env.DB_FILE = '/tmp/putzflow-sync-test.sqlite';
// ⚠️ Und die Datei wegräumen. Solange diese Datei nur reine Hilfsfunktionen prüfte,
// fiel es nicht auf; seit hier Mandanten und Termine angelegt werden, liefe der
// zweite Lauf auf einen bereits vorhandenen Datenbestand und schlüge fehl, ohne
// dass am Code etwas falsch wäre. Ein Test, der nur beim ersten Mal grün ist, ist
// schlimmer als keiner.
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

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

// --- Wiederbelebung: was der stündliche Lauf zurückholen darf und was nicht ---
//
// ⚠️ Der gefährliche Fall. Sagt die Verwaltung eine Reinigung von Hand ab, weil der
// Gast nicht kam, dann bleibt die Buchung in Smoobu eine ganz normale Gastbuchung.
// Ohne Unterscheidung nach `skipped_by` stünde die Reinigung nach spätestens einer
// Stunde wieder als „offen" in der Liste — und niemand käme darauf, warum: Es hat ja
// keiner etwas angefasst.
{
  const { init, run, get } = require('../src/db');
  const { syncJobs } = require('../src/sync');
  init();

  run(`INSERT INTO tenants(slug, name) VALUES('wiederbelebt', 'Musterhof')`);
  const t = get(`SELECT * FROM tenants WHERE slug = 'wiederbelebt'`);
  run(`INSERT INTO units(tenant_id, name, external_ref) VALUES(?, 'Wohnung 1', '4711')`, t.id);
  const unit = get(`SELECT * FROM units WHERE tenant_id = ?`, t.id);

  const buchung = id => ({ id, type: 'reservation', departure: '2026-09-10',
                           'is-blocked-booking': false, apartment: { id: 4711 } });

  function abgesagterTermin(buchungsId, wer) {
    run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, status, skipped_by, dedup_key)
         VALUES(?,?, '2026-09-10', 'apartment', 'skipped', ?, ?)`,
        t.id, unit.id, wer, `smoobu:${buchungsId}`);
    return get(`SELECT * FROM jobs WHERE dedup_key = ?`, `smoobu:${buchungsId}`);
  }

  test('ein von Smoobu storniertes und wieder gebuchtes Zimmer lebt auf', () => {
    const j = abgesagterTermin(5001, 'smoobu');
    syncJobs(t, [buchung(5001)]);
    const nach = get(`SELECT * FROM jobs WHERE id = ?`, j.id);
    assert.equal(nach.status, 'open', 'der Gast hat sein Storno zurückgenommen');
    assert.equal(nach.skipped_by, null);
  });

  test('⚠️ eine von Hand abgesagte Reinigung wird NICHT wiederbelebt', () => {
    const j = abgesagterTermin(5002, 'admin');
    syncJobs(t, [buchung(5002)]);
    const nach = get(`SELECT * FROM jobs WHERE id = ?`, j.id);
    assert.equal(nach.status, 'skipped',
      'die Buchung steht weiter in Smoobu — der Gast kam nur nicht');
    assert.equal(nach.skipped_by, 'admin');
  });

  test('Storno aus Smoobu vermerkt sich als solches', () => {
    run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, status, dedup_key)
         VALUES(?,?, '2026-09-10', 'apartment', 'open', 'smoobu:5003')`, t.id, unit.id);
    syncJobs(t, [{ ...buchung(5003), type: 'cancellation' }]);
    const nach = get(`SELECT * FROM jobs WHERE dedup_key = 'smoobu:5003'`);
    assert.equal(nach.status, 'skipped');
    assert.equal(nach.skipped_by, 'smoobu', 'sonst wäre es später nicht wiederbelebbar');
  });
}
