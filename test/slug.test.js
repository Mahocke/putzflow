// Aus einem Firmennamen wird eine Web-Adresse.
//
// ⚠️ Die Adresse ist UNUMKEHRBAR: Sie steckt im Magic-Link jeder Putzkraft, im
// Lesezeichen des Betreibers und in der Smoobu-Webhook-Adresse. Ein Fehler hier
// lässt sich nicht später geradeziehen — deshalb prüft dieser Test nicht nur, dass
// etwas herauskommt, sondern dass es das RICHTIGE ist.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const slug = require('../src/slug');

test('Rechtsformzusätze tragen nichts zur Wiedererkennung bei', () => {
  assert.equal(slug.vorschlag('Ferienwohnungen Müller GmbH & Co. KG'), 'ferienwohnungen-mueller');
  assert.equal(slug.vorschlag('Schmitz Immobilien und Vermietung GbR'), 'schmitz-immobilien');
  assert.equal(slug.vorschlag('BER-Apartments UG'), 'ber-apartments');
});

test('⚠️ Klammerinhalt fliegt ganz raus — der Fall vom 20.08.2026', () => {
  // Vorher blieb der Klammerzusatz stehen und wurde dann hart nach 40 Zeichen
  // mitten im Wort abgeschnitten — die Adresse sah aus wie ein Tippfehler.
  assert.equal(slug.vorschlag('Haus am Deich Ferienwohnungen GmbH (haftungsbeschränkt)'), 'haus-am-deich');
});

test('⚠️ Füllwörter NUR an den Rändern — sonst zerstört man den Markennamen', () => {
  // „Haus am Deich" ohne „at" wäre nicht mehr der Name des Betriebs.
  assert.match(slug.vorschlag('Haus am Deich Ferienwohnungen'), /^haus-am-deich/);
  assert.equal(slug.vorschlag('Haus am See'), 'haus-am-see');
  // Am Rand dagegen tragen sie nichts — und erst das Kürzen macht aus einem
  // Füllwort in der Mitte eines am Ende.
  assert.equal(slug.vorschlag('Die kleine Ferienwohnung an der Ostsee'), 'kleine-ferienwohnung');
});

test('am Wortende trennen, nie mittendrin', () => {
  for (const name of [
    'Ferienwohnungen Müller GmbH & Co. KG',
    'Die kleine Ferienwohnung an der Ostsee',
    'Ferienhof Zur Alten Mühle GmbH',
    'Gästehaus Rheinblick am Rhein',
  ]) {
    const s = slug.vorschlag(name);
    assert.doesNotMatch(s, /-$/, `${s} endet auf einem Bindestrich`);
    // Jedes Wort im Ergebnis muss VOLLSTÄNDIG im Namen vorkommen.
    const quelle = name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ');
    for (const w of s.split('-')) {
      assert.match(quelle, new RegExp(`(^| )${w}( |$)`), `„${w}" ist ein Wortfragment aus ${name}`);
    }
  }
});

test('immer eine brauchbare Adresse, auch bei Unsinn', () => {
  // ⚠️ `String(null)` ist „null", `String(undefined)` ist „undefined" — beides steht
  // in GESPERRT. Ohne Abfangen schlüge das Formular eine Adresse vor, die niemand
  // haben darf.
  for (const name of ['', '   ', '...', '###', null, undefined]) {
    assert.equal(slug.vorschlag(name), 'betrieb', `aus ${JSON.stringify(name)} kam etwas anderes`);
  }
  // Ein Name, der NUR aus einer Rechtsform besteht, ist immer noch besser als nichts.
  assert.equal(slug.vorschlag('GmbH'), 'gmbh');
});

test('der Vorschlag darf syntaktisch nie danebenliegen', () => {
  // ⚠️ Ob die vorgeschlagene Adresse auch FREI ist, sagt der Vorschlag nicht — das
  // beantwortet `/api/slug-frei` bzw. `freierSlug()`. Heißt ein Betrieb wirklich
  // „Shop", ist `shop` gesperrt und der Kunde sieht das im Formular sofort.
  for (const n of ['', 'GmbH', 'Ferienhaus "Zum Anker"', '###', 'Öl & Wasser GbR', null]) {
    const s = slug.vorschlag(n);
    assert.match(s, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, `„${s}" ist keine gültige Hostkomponente`);
    assert.ok(s.length >= 3 && s.length <= slug.MAX_ZEICHEN, `„${s}" hat ${s.length} Zeichen`);
  }
});

test('ein einzelnes überlanges Wort wird gekürzt — da gibt es keine Fuge', () => {
  const s = slug.vorschlag('Donaudampfschifffahrtsgesellschaftskapitaenswohnung');
  assert.ok(s.length <= slug.MAX_ZEICHEN, `${s.length} Zeichen`);
  assert.equal(slug.pruefe(s), null);
});

test('⚠️ was der Kunde selbst eintippt, wird geprüft', () => {
  assert.equal(slug.pruefe('rheinblick'), null);
  assert.equal(slug.pruefe('haus-am-see'), null);
  assert.equal(slug.pruefe('a1'), 'Die Adresse braucht mindestens 3 Zeichen');
  assert.match(slug.pruefe('-anfang'), /nicht am Anfang oder Ende/);
  assert.match(slug.pruefe('ende-'), /nicht am Anfang oder Ende/);
  assert.match(slug.pruefe('Groß'), /Kleinbuchstaben/);
  assert.match(slug.pruefe('mit punkt.de'), /Kleinbuchstaben/);
  assert.equal(slug.pruefe('x'.repeat(41)), 'Die Adresse darf höchstens 40 Zeichen haben');
});

test('⚠️ technische Namen und Punycode sind gesperrt', () => {
  for (const s of ['www', 'mail', 'api', 'demo', 'intern', 'putzflow', 'admin']) {
    assert.ok(slug.pruefe(s), `${s} müsste gesperrt sein`);
  }
  // `xn--` leitet Punycode ein: Browser und Mailprogramme zeigen so etwas als
  // Umlaut-Namen an — die Adresse sähe dann anders aus, als sie in der Datenbank steht.
  assert.equal(slug.pruefe('xn--mller-kva'), 'Diese Adresse ist nicht möglich');
});

test('der Vorschlag ist selbst immer eine gültige Adresse', () => {
  const namen = [
    'Haus am Deich Ferienwohnungen GmbH (haftungsbeschränkt)', 'Gästehaus Rheinblick',
    'Ferienwohnungen Müller GmbH & Co. KG', 'Dülkener Hof', 'Appartements am Meer e.K.',
    'A. Meier', '123 Apartments', 'Öl & Wasser GbR', 'Ferienhaus "Zum Anker"',
  ];
  for (const n of namen) {
    const s = slug.vorschlag(n);
    assert.equal(slug.pruefe(s), null, `„${s}" (aus „${n}") wäre nicht eingebbar`);
  }
});
