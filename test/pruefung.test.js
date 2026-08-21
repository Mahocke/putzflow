// Tests der Eingabeprüfung bei der Registrierung. Ausführen: npm test

const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/pruefung');

test('Platzhalter werden erkannt', () => {
  for (const w of ['test', 'asdf', 'xxx', 'aaaa', '----', 'n/a', 'keine', '']) {
    assert.equal(p.istPlatzhalter(w), true, `„${w}" sollte auffallen`);
  }
  for (const w of ['Gästehaus Rheinblick', 'Anna Meier', 'Köln']) {
    assert.equal(p.istPlatzhalter(w), false, `„${w}" ist echt`);
  }
});

test('E-Mail: Form, Wegwerfdienste, Platzhalter', () => {
  assert.equal(p.pruefeEmail('anna@rheinblick.de'), null);
  assert.ok(p.pruefeEmail('anna(at)web.de'), 'kaputte Form');
  assert.ok(p.pruefeEmail('x@mailinator.com'), 'Wegwerfdienst');
  assert.ok(p.pruefeEmail('test@web.de'), 'Platzhalter vor dem @');
});

test('Anschrift braucht eine Hausnummer', () => {
  const gut = { street: 'Rheinstraße 12', zip: '40210', city: 'Düsseldorf', country: 'DE' };
  assert.equal(p.pruefeAnschrift(gut), null);
  assert.ok(p.pruefeAnschrift({ ...gut, street: 'Rheinstraße' }), 'ohne Hausnummer');
  assert.ok(p.pruefeAnschrift({ ...gut, street: 'abc' }), 'zu kurz');
});

test('Postleitzahl passt zum Land', () => {
  const b = { street: 'Hauptstr. 1', city: 'Wien' };
  assert.equal(p.pruefeAnschrift({ ...b, zip: '1010', country: 'AT' }), null, '4-stellig in Österreich');
  assert.ok(p.pruefeAnschrift({ ...b, zip: '1010', country: 'DE' }), '4-stellig ist in Deutschland falsch');
  assert.equal(p.pruefeAnschrift({ ...b, zip: '40210', country: 'DE' }), null);
  assert.ok(p.pruefeAnschrift({ ...b, zip: '40210', country: 'FR' }), 'Land nicht unterstützt');
});

test('Telefon ist freiwillig, aber wenn, dann plausibel', () => {
  assert.equal(p.pruefeTelefon(''), null, 'leer ist erlaubt');
  assert.equal(p.pruefeTelefon(null), null);
  assert.equal(p.pruefeTelefon('0211 1234567'), null);
  assert.equal(p.pruefeTelefon('+49 (0)211 13 72 73 87'), null);
  assert.ok(p.pruefeTelefon('123'), 'zu kurz');
  assert.ok(p.pruefeTelefon('0211-abc'), 'Buchstaben');
});

test('Name und Betrieb müssen echt aussehen', () => {
  assert.equal(p.pruefeName('Katrin Berger'), null);
  assert.ok(p.pruefeName('ab'), 'zu kurz');
  assert.ok(p.pruefeName('12345'), 'ohne Buchstaben');
  assert.equal(p.pruefeBetrieb('Gästehaus Rheinblick'), null);
  assert.ok(p.pruefeBetrieb('test'));
});
