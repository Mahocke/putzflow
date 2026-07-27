const { test } = require('node:test');
const assert = require('node:assert');
const preis = require('../src/preis');

test('4,00 € je Unterkunft und Monat', () => {
  assert.equal(preis.monatCent(10), 4000);
  assert.equal(preis.monatCent(12), 4800);
  assert.equal(preis.monatCent(25), 10000);
});

// Der Mindestbetrag greift erst unter fünf Unterkünften — also genau dort, wo
// Rechnung und Support mehr kosten, als der Kunde zahlt.
test('Mindestbetrag 20 € greift unter fünf Unterkünften', () => {
  assert.equal(preis.monatCent(0), 2000);
  assert.equal(preis.monatCent(1), 2000);
  assert.equal(preis.monatCent(4), 2000);
  assert.equal(preis.monatCent(5), 2000, 'bei fünf trifft sich beides genau');
  assert.equal(preis.monatCent(6), 2400);
  assert.equal(preis.MINDEST_AB_EINHEITEN, 5);
  assert.equal(preis.fuer(4).mindest_greift, true);
  assert.equal(preis.fuer(5).mindest_greift, false);
});

test('der Preis steigt nie, wenn Unterkünfte wegfallen', () => {
  for (let n = 0; n < 60; n++) {
    assert.ok(preis.monatCent(n) <= preis.monatCent(n + 1),
              `${n} Unterkünfte kosten mehr als ${n + 1}`);
  }
});

test('jährlich im Voraus sind nur zehn Monate zu zahlen', () => {
  const p = preis.fuer(12);
  assert.equal(p.monat_cent, 4800);
  assert.equal(p.jahr_cent, 48000, 'zehn Monatsbeträge');
  assert.equal(p.ersparnis_jahr_cent, 9600, 'zwei Monatsbeträge geschenkt');
  assert.equal(preis.jahrCent(2), 20000, 'auch der Mindestbetrag zählt zehnfach');
});

test('Beispielrechnungen, wie sie auf der Startseite stehen', () => {
  assert.equal(preis.fuer(10).monat_cent, 4000);
  assert.equal(preis.fuer(10).jahr_cent, 40000);
  assert.equal(preis.fuer(20).monat_cent, 8000);
  assert.equal(preis.fuer(20).jahr_cent, 80000);
});

// ⚠️ Der Mindestbetrag darf NICHT als Paket wirken: Ab der fünften Unterkunft muss
// jede weitere genau 4 € kosten, ohne Sprünge und ohne Blockgrößen. Genau dieser
// Eindruck war entstanden, weil die Startseite eine Stufentabelle zeigte.
test('keine Blockgrößen — jede Unterkunft über dem Mindestbetrag kostet genau 4 €', () => {
  for (let n = preis.MINDEST_AB_EINHEITEN; n < 60; n++) {
    assert.equal(preis.monatCent(n + 1) - preis.monatCent(n), preis.SATZ_MONAT_CENT,
                 `Sprung zwischen ${n} und ${n + 1} Unterkünften`);
  }
});

test('unterhalb des Mindestbetrags ist der Preis konstant, nicht gestaffelt', () => {
  const werte = [0, 1, 2, 3, 4, 5].map(preis.monatCent);
  assert.deepEqual(werte, [2000, 2000, 2000, 2000, 2000, 2000]);
});
