// einrichtung.js — der erste Betrieb auf einer frischen Instanz.
//
// Ein Mandant entsteht sonst ausschließlich über das Anmeldeformular der
// Verkaufsseite (`POST /api/register`). Wer Putzflow selbst betreibt, hat diese
// Seite nicht: Im quelloffenen Stand wird sie gegen einen schlichten Wegweiser
// getauscht. Damit war der einzige Einstieg weg — die Instanz lief, war aber
// leer und ohne Weg hinein. Genau diese Lücke schließt dieses Modul.
//
// ⚠️ Der Weg ist offen, SOLANGE ES KEINEN echten Mandanten gibt, und keine
// Sekunde länger. Der Demo-Mandant zählt dabei nicht (`is_demo = 1`): Er wird
// beim ersten Start automatisch erzeugt und dürfte die Einrichtung sonst
// versperren, bevor jemand sie überhaupt gesehen hat.
//
// ⚠️ Ein Einrichtungscode gehört dazu. Ohne ihn gilt „wer zuerst kommt, mahlt
// zuerst" — und zwischen `systemctl start` und der Einrichtung liegen bei einer
// öffentlich erreichbaren Instanz Minuten, in denen ein Fremder den Betrieb
// anlegen könnte. Der Code beweist Zugriff auf die Maschine.
// Er steht im Serverprotokoll und in `data/EINRICHTUNG.txt`; ein PASSWORT würde
// dort nichts zu suchen haben, ein Einmalcode für genau diesen Vorgang schon.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { get, run } = require('./db');

// Ohne I, O, 0, 1 — der Code wird abgetippt, oft vom Telefon abgelesen.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function wuerfeln(n = 8) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function datenOrdner() {
  const db = process.env.DB_FILE || 'data/putzflow.sqlite';
  return path.dirname(path.resolve(db));
}

function codeDatei() {
  return path.join(datenOrdner(), 'EINRICHTUNG.txt');
}

// Offen heißt: es gibt noch keinen echten Betrieb.
function offen() {
  try {
    return get(`SELECT COUNT(*) AS n FROM tenants WHERE COALESCE(is_demo, 0) = 0`).n === 0;
  } catch {
    return false;                    // keine Tabelle = kein init() = nichts zu tun
  }
}

// ⚠️ Der Code überlebt einen Neustart. Würde er bei jedem Start neu gewürfelt,
// wäre der Zettel, den jemand gerade abgeschrieben hat, nach einem `restart`
// wertlos — und die Ursache sähe wie ein Tippfehler aus.
function code() {
  const datei = codeDatei();
  try {
    const vorhanden = fs.readFileSync(datei, 'utf8').trim();
    if (vorhanden) return vorhanden;
  } catch { /* gibt es noch nicht */ }

  const neu = wuerfeln();
  try {
    fs.mkdirSync(path.dirname(datei), { recursive: true });
    fs.writeFileSync(datei, `${neu}\n`, { mode: 0o600 });
  } catch (e) {
    // Nicht schreibbar ist kein Grund aufzugeben — dann gilt eben der Wert aus
    // dem Protokoll für diesen Prozess.
    console.error('[einrichtung] Code nicht speicherbar:', e.message);
  }
  return neu;
}

// Zeitkonstanter Vergleich: Der Code ist kurz, ein Zeitunterschied wäre messbar.
function codeStimmt(eingabe) {
  const soll = Buffer.from(code().replace(/[\s-]/g, '').toUpperCase());
  const ist = Buffer.from(String(eingabe || '').replace(/[\s-]/g, '').toUpperCase());
  if (soll.length !== ist.length) return false;
  return crypto.timingSafeEqual(soll, ist);
}

function aufraeumen() {
  try { fs.unlinkSync(codeDatei()); } catch { /* war nie da */ }
}

// Der Hinweis beim Start. Steht bewusst am Ende der Startmeldungen, damit er
// das Letzte ist, was im Fenster steht.
function hinweisBeimStart(basisUrl) {
  if (!offen()) return;
  const c = code();
  console.log('');
  console.log('  ┌─ Putzflow ist noch nicht eingerichtet.');
  console.log(`  │  Öffne  ${basisUrl}/einrichtung`);
  console.log(`  │  Einrichtungscode:  ${c}`);
  console.log('  └─ Der Code gilt nur, bis der erste Betrieb angelegt ist.');
  console.log('');
}

// Betrieb + Inhaberkonto in einem Zug.
//
// ⚠️ Die E-Mail-Adresse gilt hier sofort als bestätigt — anders als bei der
// Anmeldung über die Verkaufsseite. Dort ist die Bestätigung der Beweis, dass
// hinter einem Konto ein erreichbarer Mensch steht. Hier ist dieser Beweis
// bereits erbracht: Wer den Einrichtungscode hat, sitzt an der Maschine. Eine
// Bestätigungsmail wäre zudem der wahrscheinlichste Punkt zum Scheitern —
// Mailversand ist beim ersten Start selten schon eingerichtet.
// ⚠️ `selbstbetrieb = 1` ist die wichtigste Zeile hier. Ohne sie gilt der
// Mandant als Kunde ohne laufenden Testzeitraum — also sofort NUR LESBAR, und
// niemand auf dieser Instanz könnte das aufheben. Der frisch eingerichtete
// Betrieb wäre unbenutzbar, mit einer Fehlermeldung, die zum Schreiben an
// hallo@putzflow.de auffordert. Beim Durchspielen am 27.07.2026 aufgefallen.
function anlegen({ slug, firma, name, email, passwort, testEnde = null }) {
  const auth = require('./auth');
  const jetzt = new Date().toISOString();
  run(`INSERT INTO tenants(slug, name, region, trial_ends_at, email_verified_at, selbstbetrieb)
       VALUES(?,?,NULL,?,?,1)`, slug, firma, testEnde, jetzt);
  const t = get(`SELECT * FROM tenants WHERE slug = ?`, slug);
  // Ohne Vergütungsregel stünde die erste Zuteilung ohne Betrag da.
  run(`INSERT INTO comp_rules(tenant_id, mode, base_cents, premium_on, premium_mode, premium_cents)
       VALUES(?, 'flat', 2250, 'weekend_holiday', 'rate', 3000)`, t.id);
  run(`INSERT INTO users(tenant_id, email, name, role, password_hash) VALUES(?,?,?,'owner',?)`,
      t.id, String(email).toLowerCase().trim(), name, auth.hashPassword(passwort));
  aufraeumen();
  return t;
}

// ⚠️ Hier stand bis zum 27.07.2026 ein `alsEinzelbetriebMerken()`, das
// `DEFAULT_TENANT=<slug>` in die `.env` schrieb. Es ist ersatzlos gestrichen,
// und die Begründung ist die lehrreichste dieses Tages:
//
// Unsere eigene systemd-Vorlage härtet mit `ProtectSystem=strict` — das
// Anwendungsverzeichnis ist dann schreibgeschützt, nur `data/` nicht. Das
// Schreiben scheiterte also still. Die Einrichtung lief trotzdem durch, die
// Anwendung war erreichbar, alles sah richtig aus — und **erst der nächste
// Neustart** warf den Betreiber mit „Unbekannter Mandant" hinaus. Gefunden
// wurde das nicht von uns, sondern beim Nachbau auf einer fremden Maschine.
//
// Zwei Lehren: Ein Programm, das sich auf das Schreiben seiner eigenen
// Konfiguration verlässt, hat eine Abhängigkeit, die es nicht kontrolliert.
// Und ein Fehler, der erst beim übernächsten Schritt auftritt, ist teurer als
// einer, der sofort knallt. Die Antwort steht jetzt in der Datenbank
// (`tenants.selbstbetrieb`), wo ohnehin geschrieben wird —
// `tenant.einzelbetrieb()` liest sie bei jeder Anfrage.

module.exports = {
  offen, code, codeStimmt, hinweisBeimStart, anlegen, aufraeumen, codeDatei,
};
