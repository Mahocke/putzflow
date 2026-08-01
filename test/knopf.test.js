// knopf.test.js — was auf dem Knopf neben der Zuteilung steht.
//
// ⚠️ Diese eine Beschriftung war schon zweimal falsch: erst „Erneut anfragen"
// (setzte einen zugesagten Termin still zurück), dann „Nochmal senden" (harmlos,
// aber ohne Anwendungsfall auf einer geklärten Karte). Beides fiel erst am
// fertigen Bildschirmfoto auf. Deshalb steht die Tabelle jetzt in einem Test.
//
// `public/app.js` läuft im Browser und hängt sich beim Laden an `document` —
// require geht also nicht. Geprüft wird die Funktion selbst, aus der Datei
// herausgeschnitten: Bricht das Ausschneiden, bricht der Test, und niemand
// prüft versehentlich eine Kopie, die es in der Oberfläche gar nicht gibt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const quelle = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const treffer = quelle.match(/function sendeKnopf\(j, gewaehlt\) \{[\s\S]*?\n\}/);
assert.ok(treffer, 'sendeKnopf nicht in public/app.js gefunden');
const sendeKnopf = new Function(`${treffer[0]}; return sendeKnopf;`)();

const ANNA = 7, BEA = 9;

test('nichts zugeteilt, nichts gewählt: nichts zu senden', () => {
  const k = sendeKnopf({ assigned_user_id: null, confirmed: 0 }, '');
  assert.strictEqual(k.text, 'Anfragen');
  assert.strictEqual(k.aus, true);
});

test('offener Termin, jemand gewählt: anfragen', () => {
  const k = sendeKnopf({ assigned_user_id: null, confirmed: 0 }, String(ANNA));
  assert.strictEqual(k.text, 'Anfragen');
  assert.strictEqual(k.aus, false);
});

test('zugeteilt, niemand gewählt: Zuteilung entfernen', () => {
  const k = sendeKnopf({ assigned_user_id: ANNA, confirmed: 1 }, '');
  assert.strictEqual(k.text, 'Zuteilung entfernen');
});

test('andere Person gewählt: umteilen — auch bei zugesagtem Termin', () => {
  const k = sendeKnopf({ assigned_user_id: ANNA, confirmed: 1 }, String(BEA));
  assert.strictEqual(k.text, 'Umteilen');
  assert.strictEqual(k.aus, false);
});

test('angefragt und noch keine Antwort: erinnern', () => {
  const k = sendeKnopf({ assigned_user_id: ANNA, confirmed: 0 }, String(ANNA));
  assert.strictEqual(k.text, 'Erinnern');
  assert.strictEqual(k.aus, false);
  assert.ok(!k.weg, 'beim Nachfassen muss der Knopf dastehen');
});

// ⚠️ Der Kern: Auf einer zugesagten Karte gibt es nichts zu tun, also auch keinen
// Knopf. Wer hier wieder eine Beschriftung einträgt, baut den alten Fehler nach.
test('zugesagt und dieselbe Person: gar kein Knopf', () => {
  const k = sendeKnopf({ assigned_user_id: ANNA, confirmed: 1 }, String(ANNA));
  assert.strictEqual(k.weg, true);
  assert.strictEqual(k.text, '');
});

test('kein Knopf trägt je wieder „Nochmal senden"', () => {
  const faelle = [
    [{ assigned_user_id: null, confirmed: 0 }, ''],
    [{ assigned_user_id: null, confirmed: 0 }, String(ANNA)],
    [{ assigned_user_id: ANNA, confirmed: 0 }, ''],
    [{ assigned_user_id: ANNA, confirmed: 0 }, String(ANNA)],
    [{ assigned_user_id: ANNA, confirmed: 0 }, String(BEA)],
    [{ assigned_user_id: ANNA, confirmed: 1 }, ''],
    [{ assigned_user_id: ANNA, confirmed: 1 }, String(ANNA)],
    [{ assigned_user_id: ANNA, confirmed: 1 }, String(BEA)],
  ];
  for (const [j, gewaehlt] of faelle) {
    assert.notStrictEqual(sendeKnopf(j, gewaehlt).text, 'Nochmal senden');
  }
});
