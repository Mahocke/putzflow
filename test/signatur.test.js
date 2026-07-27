// Tests des Abzeichnens. Ausführen: npm test

// ⚠️ Eigene Testdatenbank. Diese Datei zieht ueber src/signatur bzw. src/sync
// das Modul src/db herein, und das oeffnet die Datei beim Laden. Ohne eigenen
// Pfad greifen mehrere Testdateien gleichzeitig auf dieselbe SQLite-Datei zu --
// node --test faehrt sie parallel -- und unter Last faellt eine ganze Datei aus.
process.env.DB_FILE = '/tmp/putzflow-signatur-test.sqlite';

const test = require('node:test');
const assert = require('node:assert');
const { hashPositionen, darfSignieren } = require('../src/signatur');

const positionen = [
  { job_id: 1, date: '2026-06-18', unit: 'Apartment A', minutes: 120, cents: 2250 },
  { job_id: 2, date: '2026-06-23', unit: 'Apartment B', minutes: 90, cents: 3000 },
];

test('Gleiche Positionen ergeben denselben Hash', () => {
  assert.equal(hashPositionen(positionen), hashPositionen([...positionen]));
});

test('Reihenfolge ändert den Hash nicht', () => {
  assert.equal(hashPositionen(positionen), hashPositionen([...positionen].reverse()));
});

test('Jede inhaltliche Änderung bricht die Unterschrift', () => {
  const basis = hashPositionen(positionen);
  const geaendert = [
    [{ ...positionen[0], minutes: 150 }, 'Zeit geändert'],
    [{ ...positionen[0], cents: 3000 }, 'Betrag geändert'],
    [{ ...positionen[0], date: '2026-06-19' }, 'Datum geändert'],
    [{ ...positionen[0], unit: 'Apartment C' }, 'Unterkunft geändert'],
  ];
  for (const [pos, was] of geaendert) {
    assert.notEqual(hashPositionen([pos, positionen[1]]), basis, was + ' muss auffallen');
  }
});

test('Eine zusätzliche oder fehlende Position bricht die Unterschrift', () => {
  const basis = hashPositionen(positionen);
  assert.notEqual(hashPositionen([positionen[0]]), basis, 'Position entfernt');
  assert.notEqual(hashPositionen([...positionen, { job_id: 3, date: '2026-07-01', unit: 'C', minutes: 60, cents: 2250 }]),
                  basis, 'Position ergänzt');
});

test('Leerer Zettel ist stabil', () => {
  assert.equal(hashPositionen([]), hashPositionen(null));
});

test('Abgezeichnet wird erst am Ende der Periode', () => {
  const p = { start: '2026-06-16', end: '2026-07-15' };
  assert.equal(darfSignieren(p, '2026-07-16'), true, 'Periode vorbei');
  assert.equal(darfSignieren(p, '2026-07-15'), true, 'letzter Tag');
  assert.equal(darfSignieren(p, '2026-07-13'), true, 'drittletzter Tag');
  assert.equal(darfSignieren(p, '2026-07-12'), false, 'vorher ist der Zettel unvollständig');
  assert.equal(darfSignieren(p, '2026-06-20'), false, 'mitten in der Periode');
});
