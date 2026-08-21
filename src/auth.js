// auth.js — zwei Zugangswege:
//   1. Verwaltung (owner/admin/lead): E-Mail + Passwort (scrypt), langlebige Cookie-Session
//   2. Putzkräfte: passwortloser Magic-Link /m/<token> — kein Login, keine App-Pflicht
//
// Übernommen aus Glanz & Gloria, ergänzt um tenant_id in Session und Token-Auflösung.

const crypto = require('crypto');
const { get, run } = require('./db');

const COOKIE_NAME = 'pf_session';
const SESSION_TTL_DAYS = 365;
const MAGIC_TOKEN_BYTES = 18;                 // 144 Bit, wie im Original

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function randToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }

// --- Passwort ---
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const dk = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return dk.length === want.length && crypto.timingSafeEqual(dk, want);
}

// --- Sessions ---
function createSession(tenantId, userId) {
  const raw = randToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000);
  run(`INSERT INTO sessions(id, tenant_id, user_id, expires_at) VALUES(?, ?, ?, ?)`,
      sha256(raw), tenantId, userId, expires.toISOString());
  return { raw, expires };
}
function sessionUser(raw) {
  if (!raw) return null;
  const row = get(
    `SELECT s.id AS sid, s.expires_at, u.id, u.tenant_id, u.email, u.name, u.role, u.active, u.team_lead_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`, sha256(raw));
  if (!row || !row.active) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  run(`UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?`, row.sid);
  return { id: row.id, tenant_id: row.tenant_id, email: row.email, name: row.name, role: row.role, team_lead_id: row.team_lead_id };
}
function destroySession(raw) { if (raw) run(`DELETE FROM sessions WHERE id = ?`, sha256(raw)); }

// Alle Sitzungen einer Person beenden — bis auf die, aus der heraus gehandelt
// wird. Nach einem Passwortwechsel: Der häufigste Grund zu wechseln ist der
// Verdacht, dass jemand mitliest; bliebe dessen Sitzung offen, hätte der
// Wechsel nichts bewirkt.
// ⚠️ Die eigene MUSS bleiben, sonst fliegt man beim Speichern aus der eigenen
// Anwendung — und hält das für einen Fehler.
function beendeAndereSitzungen(userId, eigenesRaw) {
  if (eigenesRaw) {
    run(`DELETE FROM sessions WHERE user_id = ? AND id <> ?`, userId, sha256(eigenesRaw));
  } else {
    run(`DELETE FROM sessions WHERE user_id = ?`, userId);
  }
}

// --- Passwort zuruecksetzen ---
// ⚠️ Nur fuer Konten MIT Passwort (owner/admin). Reinigungskraefte melden sich
// nie an; ein Zuruecksetzen fuer sie waere ein Weg, sich einen Magic-Link
// schicken zu lassen, den man nicht haben soll.
const RESET_TTL_MINUTEN = 60;

function createReset(tenantId, userId) {
  const raw = randToken();
  const expires = new Date(Date.now() + RESET_TTL_MINUTEN * 60000);
  // ⚠️ Aeltere offene Anforderungen derselben Person verfallen sofort. Sonst
  // haelt jede weitere Anforderung die vorherige am Leben, und wer dreimal
  // klickt, hat drei gueltige Schluessel in drei Mails liegen.
  run(`DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL`, userId);
  run(`INSERT INTO password_resets(id, tenant_id, user_id, expires_at) VALUES(?,?,?,?)`,
      sha256(raw), tenantId, userId, expires.toISOString());
  return { raw, expires };
}

// Gibt die Zeile zurueck, wenn der Token gueltig, unbenutzt und nicht abgelaufen
// ist — sonst null. Kein Unterschied zwischen "gibt es nicht", "schon benutzt"
// und "abgelaufen": Der Unterschied waere fuer einen Angreifer eine Auskunft und
// fuer die Betroffene nutzlos, sie muss so oder so neu anfordern.
function resetByToken(raw) {
  if (!raw) return null;
  const row = get(
    `SELECT r.*, u.email, u.name, u.role, u.active
       FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.id = ?`, sha256(raw));
  if (!row || row.used_at || !row.active) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

// Setzt das Passwort und entwertet ALLES, was vorher galt.
function useReset(raw, neuesPasswort) {
  const row = resetByToken(raw);
  if (!row) return null;
  run(`UPDATE users SET password_hash = ? WHERE id = ?`, hashPassword(neuesPasswort), row.user_id);
  run(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`, sha256(raw));
  // Weitere offene Anforderungen mit verfallen lassen.
  run(`DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL`, row.user_id);
  // ⚠️ ALLE Sitzungen beenden, auch die des Angreifers. Wer sein Passwort
  // zuruecksetzt, hat im Zweifel keinen Zugriff mehr auf sein Konto — bliebe
  // eine fremde Sitzung offen, waere das Zuruecksetzen ein Placebo.
  beendeAndereSitzungen(row.user_id, null);
  return row;
}

// --- Cookie ---
function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}
function setCookie(res, raw, expires) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${raw}; Path=/; Expires=${expires.toUTCString()}; HttpOnly;${secure} SameSite=Lax`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`);
}

// --- Magic-Link ---
// Invariante: stille Mitarbeiterinnen bekommen NIE einen Token (G&G-Lehre).
function ensureMagicToken(user) {
  if (!user || user.silent) return null;
  if (user.magic_token) return user.magic_token;
  const tok = randToken(MAGIC_TOKEN_BYTES);
  run(`UPDATE users SET magic_token = ? WHERE id = ?`, tok, user.id);
  return tok;
}
function userByMagicToken(token) {
  if (!token) return null;
  return get(
    `SELECT u.*, t.slug AS tenant_slug, t.region AS tenant_region, t.name AS tenant_name,
            t.minijob_limit_cents
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.magic_token = ? AND u.active = 1 AND u.silent = 0 AND t.active = 1`, token);
}

// --- Middleware ---
function attachUser(req, res, next) {
  try { req.user = sessionUser(readCookie(req)); } catch { req.user = null; }
  // Eine Session gilt nur für ihren Mandanten — sonst wäre ein Cookie über
  // Subdomains hinweg ein Mandanten-Sprung.
  if (req.user && req.tenant && req.user.tenant_id !== req.tenant.id) req.user = null;
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Keine Berechtigung' });
  next();
}

function cleanupExpired() {
  // ⚠️ datetime(expires_at), NICHT der rohe Vergleich (27.07.2026). In dieser
  // Datenbank stehen ZWEI Zeitformate nebeneinander: created_at kommt aus
  // SQLites datetime('now') und sieht aus wie "2026-07-27 12:23:59", expires_at
  // wird aus JavaScript als toISOString() geschrieben — "2026-07-27T12:38:59.188Z".
  // Beim rohen Stringvergleich sortiert das Leerzeichen VOR dem T, also gilt am
  // selben Tag jede abgelaufene Zeile faelschlich als noch gueltig und wird nie
  // geloescht. datetime() bringt beides auf dieselbe Form.
  // (Gefunden, weil derselbe Fehler beim Aufraeumen von Hand alle Sitzungen
  //  auf einmal traf statt nur der alten.)
  try { run(`DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')`); } catch { /* egal */ }
  // Abgelaufene und verbrauchte Zuruecksetz-Token gehoeren ebenso weg — ein
  // benutzter Token ist wertlos, aber er verraet, DASS jemand ausgesperrt war.
  try {
    run(`DELETE FROM password_resets
          WHERE datetime(expires_at) < datetime('now')
             OR (used_at IS NOT NULL AND datetime(used_at) < datetime('now','-7 day'))`);
  } catch { /* egal */ }
}

module.exports = {
  COOKIE_NAME, hashPassword, verifyPassword,
  createSession, sessionUser, destroySession, beendeAndereSitzungen,
  createReset, resetByToken, useReset, RESET_TTL_MINUTEN,
  readCookie, setCookie, clearCookie,
  ensureMagicToken, userByMagicToken,
  attachUser, requireAuth, requireAdmin, cleanupExpired, randToken,
};
