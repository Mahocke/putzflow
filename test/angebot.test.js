const { test } = require('node:test');
const assert = require('node:assert');
const angebot = require('../src/angebot');
const fmt = require('../src/format');

const mandant = extra => ({
  is_demo: 0, email_verified_at: '2026-06-01T10:00:00Z', trial_ends_at: '2026-08-01',
  ...extra,
});

test('eine Woche vor Ablauf wird gefragt, davor nicht', () => {
  assert.equal(angebot.faellig(mandant(), '2026-07-20'), null);
  assert.equal(angebot.faellig(mandant(), '2026-07-25'), 'entscheidung');
  assert.equal(angebot.faellig(mandant(), '2026-08-01'), 'entscheidung');
});

test('nach Ablauf kommt die zweite Mail, aber nur einmal', () => {
  assert.equal(angebot.faellig(mandant(), '2026-08-02'), 'ablauf');
  const schon = mandant({ ablauf_mail_fuer: '2026-08-01' });
  assert.equal(angebot.faellig(schon, '2026-08-02'), null);
});

// Verschiebt sich das Testende — etwa weil wir jemandem von Hand mehr Zeit geben —,
// muss die Frage vor dem neuen Ende erneut gestellt werden. Genau dafür trägt der
// Merker ein Datum und kein Ja/Nein.
test('nach einem verschobenen Testende wird erneut gefragt', () => {
  const t = mandant({ entscheidung_mail_fuer: '2026-08-01' });
  assert.equal(angebot.faellig(t, '2026-07-28'), null);

  t.trial_ends_at = '2026-09-15';
  assert.equal(angebot.faellig(t, '2026-07-28'), null, 'zu früh');
  assert.equal(angebot.faellig(t, '2026-09-10'), 'entscheidung');
});

test('Demo, unbestätigte Adresse, Bestellung und bezahlte Zeit werden nicht angeschrieben', () => {
  assert.equal(angebot.faellig(mandant({ is_demo: 1 }), '2026-07-28'), null);
  assert.equal(angebot.faellig(mandant({ email_verified_at: null }), '2026-07-28'), null);
  assert.equal(angebot.faellig(mandant({ bestellt_am: '2026-07-20T09:00:00Z' }), '2026-07-28'), null);
  assert.equal(angebot.faellig(mandant({ paid_until: '2027-07-01' }), '2026-07-28'), null);
});

// Anlass: „hat den Testzeitraum um 42 Tage verlängert, neu bis 2026-09-06".
test('Zeiträume und Daten werden menschlich geschrieben', () => {
  assert.equal(fmt.dauer(42), 'sechs Wochen');
  assert.equal(fmt.dauer(7), 'eine Woche');
  assert.equal(fmt.dauer(10), '10 Tage');
  assert.equal(fmt.dauer(1), 'einen Tag');
  assert.equal(fmt.tag('2026-09-06'), '06.09.2026');
  assert.equal(fmt.euro(40000), '400,00 €');
});
