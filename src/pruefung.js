// pruefung.js — Eingaben bei der Registrierung prüfen.
//
// Ziel ist nicht, Betrug auszuschließen — das kann kein Formular. Ziel ist, den
// Aufwand für Unsinn über den Nutzen zu heben: offensichtliche Platzhalter
// abweisen, Anschrift plausibel prüfen, und vor allem die E-Mail-Adresse
// bestätigen lassen. Erst die Bestätigung macht ein Konto echt.

const PLZ = {
  DE: /^\d{5}$/,
  AT: /^\d{4}$/,
  CH: /^\d{4}$/,
};

const PLATZHALTER = /^(test|tester|testen|asdf|asd|qwer|qwertz|abc|xxx+|aaa+|foo|bar|xyz|keine?|none|null|undefined|na|n\/a|-+|\.+)$/i;

function istPlatzhalter(wert) {
  const w = String(wert || '').trim();
  if (!w) return true;
  if (PLATZHALTER.test(w)) return true;
  // „aaaa", „111", „....": ein einziges Zeichen wiederholt
  if (w.length >= 3 && new Set(w.replace(/\s/g, '')).size === 1) return true;
  return false;
}

// Wegwerf-Adressen. Bewusst kurz gehalten: Eine vollständige Liste ist ein
// Wettrüsten, das man nicht gewinnt. Die Bestätigungsmail ist die eigentliche Hürde.
const WEGWERF = new Set([
  'mailinator.com', 'yopmail.com', 'trashmail.com', 'wegwerfmail.de', 'guerrillamail.com',
  'temp-mail.org', '10minutemail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com',
  'example.com', 'example.org', 'test.de',
]);

function pruefeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return 'Die E-Mail-Adresse sieht nicht richtig aus';
  const domain = e.split('@')[1];
  if (WEGWERF.has(domain)) return 'Bitte eine dauerhaft erreichbare E-Mail-Adresse angeben';
  if (istPlatzhalter(e.split('@')[0])) return 'Bitte eine echte E-Mail-Adresse angeben';
  return null;
}

function pruefeName(name) {
  const n = String(name || '').trim();
  if (n.length < 3) return 'Bitte den vollständigen Namen angeben';
  if (istPlatzhalter(n)) return 'Bitte den echten Namen angeben';
  if (!/[a-zäöüß]/i.test(n)) return 'Der Name sieht nicht richtig aus';
  return null;
}

function pruefeAnschrift({ street, zip, city, country = 'DE' }) {
  const land = String(country || 'DE').toUpperCase();
  const s = String(street || '').trim();
  const p = String(zip || '').trim();
  const o = String(city || '').trim();

  if (s.length < 5 || istPlatzhalter(s)) return 'Bitte Straße und Hausnummer angeben';
  // Eine Anschrift ohne Ziffer ist fast immer eine ohne Hausnummer.
  if (!/\d/.test(s)) return 'In der Straße fehlt die Hausnummer';
  if (!PLZ[land]) return 'Dieses Land unterstützen wir noch nicht';
  if (!PLZ[land].test(p)) return `Die Postleitzahl passt nicht zu ${land}`;
  if (o.length < 2 || istPlatzhalter(o)) return 'Bitte den Ort angeben';
  if (!/[a-zäöüß]/i.test(o)) return 'Der Ort sieht nicht richtig aus';
  return null;
}

// Optional — wird nur geprüft, wenn etwas dasteht.
function pruefeTelefon(phone) {
  const t = String(phone || '').trim();
  if (!t) return null;
  const ziffern = t.replace(/[^\d]/g, '');
  if (ziffern.length < 7 || ziffern.length > 15) return 'Die Telefonnummer sieht nicht richtig aus';
  if (!/^[+\d][\d\s/()-]*$/.test(t)) return 'Die Telefonnummer enthält unerlaubte Zeichen';
  return null;
}

function pruefeBetrieb(firma) {
  const f = String(firma || '').trim();
  if (f.length < 3) return 'Bitte den Namen des Betriebs angeben';
  if (istPlatzhalter(f)) return 'Bitte den echten Namen des Betriebs angeben';
  return null;
}

module.exports = { istPlatzhalter, pruefeEmail, pruefeName, pruefeAnschrift, pruefeTelefon, pruefeBetrieb, PLZ };
