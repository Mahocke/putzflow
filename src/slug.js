// slug.js — aus einem Firmennamen wird eine Web-Adresse: <slug>.putzflow.de
//
// ⚠️ Der Slug ist UNUMKEHRBAR. Er steckt im Magic-Link, den die Putzkraft im
// Postfach hat (`server.js`: `${host}/m/${token}`), im Lesezeichen des Betreibers
// und in der Webhook-Adresse bei Smoobu. Wer ihn nachträglich ändert, macht all
// das ungültig — deshalb gibt es kein Umbenennen, und deshalb darf der Kunde ihn
// bei der Anmeldung SELBST bestimmen. Der Vorschlag hier ist nur ein Vorschlag.
//
// ⚠️ Und er wird der Putzkraft gezeigt. Eine Adresse wie `feel01.putzflow.de` in
// einer Mail an jemanden, der ausdrücklich KEINE App installieren soll, ist genau
// die Form, vor der man Leute warnt. Der wiedererkennbare Betriebsname ist das
// einzige Vertrauenssignal, das diese Mail hat. Darum sprechend statt kurz.

// Rechtsformen und ihre Bruchstücke. Sie tragen nichts zur Wiedererkennung bei —
// „Müller GmbH & Co. KG" heißt für jeden Menschen einfach „Müller".
const RECHTSFORM = new Set([
  'gmbh', 'ug', 'ag', 'kg', 'kgaa', 'ohg', 'gbr', 'mbh', 'co', 'ev', 'eg', 'se',
  'ltd', 'bv', 'inc', 'gesellschaft', 'haftungsbeschraenkt', 'haftungsbeschrankt',
  'kfr', 'kfm', 'kg-aa', 'partg', 'mbb',
]);

// Füllwörter — aber NUR an den Rändern, nie mitten im Namen. „Haus am Deich"
// ist der Markenname; wer daraus „haus-deich" macht, hat ihn zerstört. Am Rand
// dagegen tragen sie nichts: „Die kleine Ferienwohnung an der Ostsee" auf drei
// Wörter gekürzt endete sonst auf „…-an".
const FUELLER = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'und', 'fuer', 'am',
  'an', 'im', 'in', 'zum', 'zur', 'von', 'vom', 'zu', 'bei', 'the', 'at', 'of',
]);

const MAX_ZEICHEN = 24;
const MAX_WORTE = 3;

// Adressen, die niemandem gehören dürfen: technische Namen, unsere eigenen Hosts,
// und alles, was in einer Mail nach uns statt nach dem Kunden aussieht.
const GESPERRT = new Set([
  'www', 'app', 'mail', 'smtp', 'imap', 'pop', 'mx', 'ns', 'ns1', 'ns2', 'autodiscover',
  'api', 'admin', 'demo', 'hof', 'test', 'dev', 'staging', 'static', 'cdn', 'assets',
  'blog', 'help', 'support', 'status', 'docs', 'shop', 'login', 'account', 'billing',
  'putzflow', 'root', 'system', 'null', 'undefined', 'intern',
]);

function worte(name) {
  // ⚠️ `String(null)` ist „null" und `String(undefined)` ist „undefined" — beides
  // steht in GESPERRT, der Vorschlag wäre also eine Adresse, die niemand haben darf.
  // Im Test aufgefallen, bevor es jemand gesehen hat.
  if (name === null || name === undefined) return [];
  return String(name).toLowerCase()
    // ⚠️ Klammerinhalt fliegt ganz raus. „(haftungsbeschränkt)" ist der längste
    // Bestandteil im Namen und der einzige, den niemand mitspricht.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

// Der Vorschlag, den das Anmeldeformular vorbelegt.
function raenderPutzen(w) {
  while (w.length > 1 && FUELLER.has(w[0])) w = w.slice(1);
  while (w.length > 1 && FUELLER.has(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

// Der Vorschlag, den das Anmeldeformular vorbelegt.
function vorschlag(name) {
  const alle = worte(name);
  let w = raenderPutzen(alle.filter(t => !RECHTSFORM.has(t)));
  // War der Name NUR Rechtsform, ist das immer noch besser als nichts.
  if (!w.length || (w.length === 1 && !w[0])) w = raenderPutzen(alle);
  if (!w.length) return 'betrieb';

  const raus = [];
  for (const t of w) {
    if (raus.length >= MAX_WORTE) break;
    const laenge = raus.join('-').length + (raus.length ? 1 : 0) + t.length;
    // ⚠️ Am WORTENDE trennen, nie mittendrin. Vorher schnitt ein hartes
    // `slice(0, 40)` „…-haftungsbeschraenkt" zu „…-haftungsbe" — die Adresse sah
    // aus wie ein Tippfehler.
    if (raus.length && laenge > MAX_ZEICHEN) break;
    raus.push(t);
  }
  // ⚠️ Nach dem Kürzen NOCH EINMAL die Ränder putzen: Erst das Abschneiden macht
  // aus einem Füllwort mitten im Namen eines am Ende.
  const fertig = raenderPutzen(raus).join('-');
  // Ein einzelnes überlanges Wort darf hart gekürzt werden — da gibt es keine Fuge.
  return fertig.slice(0, MAX_ZEICHEN) || 'betrieb';
}

// Prüft, was der Kunde selbst eingetippt hat. Gibt die Beanstandung zurück oder null.
function pruefe(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (s.length < 3) return 'Die Adresse braucht mindestens 3 Zeichen';
  if (s.length > 40) return 'Die Adresse darf höchstens 40 Zeichen haben';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
    return 'Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche — nicht am Anfang oder Ende';
  }
  // ⚠️ `xn--` leitet Punycode ein. Ein Slug, der so beginnt, wird von Browsern und
  // Mailprogrammen als kodierter Umlaut-Name gedeutet und kann als etwas ganz
  // anderes erscheinen, als hier in der Datenbank steht.
  if (s.startsWith('xn--')) return 'Diese Adresse ist nicht möglich';
  if (GESPERRT.has(s)) return 'Diese Adresse ist vergeben';
  return null;
}

module.exports = { vorschlag, pruefe, GESPERRT, MAX_ZEICHEN, MAX_WORTE };
