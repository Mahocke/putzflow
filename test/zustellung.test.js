// Eine Nachricht, die nicht ankommt, muss man sehen.
//
// ⚠️ Der Anlass steht in den Daten des ersten echten Kunden: Am 21.08.2026 hat er
// vier Reinigungen an eine Kraft zugeteilt, die keine E-Mail-Adresse hinterlegt hat.
// Alle vier Benachrichtigungen scheiterten mit „kein erreichbarer Kanal" — und er
// hat es mit hoher Wahrscheinlichkeit nicht gemerkt: Die Oberfläche meldete bei
// Erfolg „Angefragt (mail)" und bei Misserfolg schlicht „Zugeteilt". Der einzige
// Unterschied war ein fehlendes Wort. `notify_log` wurde geschrieben und nirgends
// gelesen.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WURZEL = path.join(__dirname, '..');
const quelle = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
const oberflaeche = fs.readFileSync(path.join(WURZEL, 'public', 'app.js'), 'utf8');

// Die Helfer aus server.js herausschneiden statt nachzubauen — sonst prüft man
// eine Kopie, die es in der Anwendung gar nicht gibt (Muster aus knopf.test.js).
function schneide(name) {
  const m = quelle.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} nicht in server.js gefunden`);
  return m[0];
}
const { unerreichbarePerson, zustellHinweis } = new Function(
  `${schneide('unerreichbarePerson')}; ${schneide('zustellHinweis')};
   return { unerreichbarePerson, zustellHinweis };`)();

const OHNE_ADRESSE = { name: 'Reinigung Nordlicht', silent: 0, email: null, phone: null };
const MIT_ADRESSE = { name: 'Berger, Katrin', silent: 0, email: 'katrin@example.net', phone: null };
const STILL = { name: 'Stille Kraft', silent: 1, email: null, phone: null };

test('⚠️ genau der Fall vom 21.08.: Kraft ohne Adresse, nicht als still markiert', () => {
  assert.equal(unerreichbarePerson(OHNE_ADRESSE), true);
});

test('wer erreichbar ist oder still, ist kein Widerspruch', () => {
  assert.equal(unerreichbarePerson(MIT_ADRESSE), false);
  // ⚠️ „still" ist die ABSICHT, keine Adresse zu haben — das ist kein Fehler,
  // sondern eine Entscheidung. Wer sie meldet, erzieht zum Wegklicken.
  assert.equal(unerreichbarePerson(STILL), false);
  assert.equal(unerreichbarePerson({ name: 'Nur Telefon', silent: 0, email: null, phone: '0170 1234567' }), false);
  assert.equal(unerreichbarePerson(null), false);
});

test('ein geglückter Versand meldet nichts', () => {
  assert.equal(zustellHinweis(MIT_ADRESSE, { ok: true, channel: 'mail' }), null);
  assert.equal(zustellHinweis(MIT_ADRESSE, null), null, 'ohne Versandversuch gibt es nichts zu melden');
});

test('⚠️ der Fehlschlag nennt die Person UND was zu tun ist', () => {
  const h = zustellHinweis(OHNE_ADRESSE, { ok: false, error: 'kein erreichbarer Kanal' });
  assert.equal(h.ok, false);
  assert.match(h.grund, /Reinigung Nordlicht/, 'ohne Namen weiß niemand, wen es betrifft');
  assert.match(h.grund, /weder E-Mail noch Telefon/);
  // ⚠️ Der Rat ist der Punkt. „kein erreichbarer Kanal" ist eine Diagnose;
  // der Betreiber braucht den nächsten Handgriff.
  assert.match(h.rat, /Adresse eintragen|Link selbst/);
  assert.doesNotMatch(JSON.stringify(h), /kein erreichbarer Kanal/,
                      'die technische Meldung gehört ins Log, nicht auf den Bildschirm');
});

test('ein anderer Fehler wird nicht als fehlende Adresse ausgegeben', () => {
  const h = zustellHinweis(MIT_ADRESSE, { ok: false, error: 'SMTP 421 zu viele Verbindungen' });
  assert.match(h.grund, /SMTP 421/);
  assert.match(h.rat, /später/);
});

test('⚠️ BEIDE Routen, die an eine Kraft schreiben, melden den Fehlschlag', () => {
  // Zuteilung und Absage. Repariert man nur eine, schweigt die andere weiter —
  // und das fällt beim nächsten Mal niemandem auf.
  assert.match(quelle, /zustellHinweis\(u, sent\)/, 'die Zuteilung meldet nicht');
  assert.match(quelle, /zustellHinweis\(kraft, sent\)/, 'die Absage meldet nicht');
  assert.equal((quelle.match(/notified: sent\b/g) || []).length,
               (quelle.match(/zustellung: zustellHinweis\(/g) || []).length,
               'es gibt eine Route, die `notified` zurueckgibt, aber keinen Hinweis');
});

test('⚠️ notify_log wird endlich gelesen', () => {
  // Eine Tabelle, in die nur hineingeschrieben wird, ist kein Protokoll.
  assert.match(quelle, /app\.get\('\/api\/zustellprobleme'/);
  assert.match(quelle, /status = 'failed'/);
  assert.match(quelle, /-14 day/, 'ohne Zeitfenster steht der Hinweis ewig');
  assert.match(oberflaeche, /api\/zustellprobleme/, 'die Oberfläche fragt gar nicht danach');
});

test('die Oberfläche unterscheidet Fehlschlag von Erfolg — sichtbar', () => {
  assert.match(oberflaeche, /NICHT benachrichtigt/,
               'der Fehlschlag muss sich wie einer anfuehlen, nicht wie „Zugeteilt"');
  assert.match(oberflaeche, /u\.unerreichbar/, 'die Personenkarte kennzeichnet es nicht');
  // Eine Warnung braucht laenger als eine Bestaetigung.
  assert.match(oberflaeche, /art === 'warn' \? 7000 : 2400/);
});
