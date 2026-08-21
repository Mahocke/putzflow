// krypto.js — Fremdzugangsdaten verschlüsselt ablegen.
//
// Der Smoobu-Schlüssel gehört dem KUNDEN, nicht uns. Er liegt deshalb nicht in der
// .env, sondern je Mandant in der Datenbank — und dort verschlüsselt, damit ein
// kopiertes Datenbankabbild nicht gleich alle Kundenkonten offenlegt.
//
// AES-256-GCM: verschlüsselt UND authentifiziert. Der Schlüssel kommt aus
// APP_SECRET; ohne den ist nichts zu entschlüsseln.
//
// ⚠️ APP_SECRET nie ändern, ohne die gespeicherten Werte neu zu setzen — sonst
// sind alle hinterlegten Kundenzugänge unbrauchbar.

const crypto = require('crypto');

function schluessel() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) {
    throw new Error('APP_SECRET fehlt oder ist zu kurz (mindestens 32 Zeichen)');
  }
  return crypto.createHash('sha256').update(s).digest();       // 32 Byte
}

// Ergebnis: "v1.<iv>.<tag>.<ciphertext>", alles base64url
function verschluesseln(klartext) {
  if (klartext == null || klartext === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel(), iv);
  const daten = Buffer.concat([c.update(String(klartext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), daten.toString('base64url')].join('.');
}

function entschluesseln(gespeichert) {
  if (!gespeichert) return null;
  const teile = String(gespeichert).split('.');
  if (teile.length !== 4 || teile[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', schluessel(), Buffer.from(teile[1], 'base64url'));
    d.setAuthTag(Buffer.from(teile[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(teile[3], 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;                       // falscher APP_SECRET oder manipulierter Wert
  }
}

// Für Anzeigen: nur die letzten Zeichen, nie der ganze Schlüssel.
function maskieren(wert, sichtbar = 4) {
  if (!wert) return null;
  const s = String(wert);
  return s.length <= sichtbar ? '…' : '…' + s.slice(-sichtbar);
}

module.exports = { verschluesseln, entschluesseln, maskieren };
