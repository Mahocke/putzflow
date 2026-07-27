// signatur.js — Stundenzettel abzeichnen (einfache elektronische Signatur).
//
// Zweck: Die Reinigungskraft bestätigt am Ende der Abrechnungsperiode, dass die
// erfassten Zeiten stimmen. Damit muss die Chefin nicht vor Ort sein, und die
// Lohnbuchhaltung bekommt einen abgezeichneten Zettel.
//
// Kernidee (aus Glanz & Gloria): Es wird ein HASH der abgezeichneten Positionen
// gespeichert, nicht nur ein Häkchen. Ändert jemand hinterher eine Zeit, weicht der
// neu berechnete Hash ab — die Unterschrift wird als „veraltet" ausgewiesen und muss
// erneuert werden. Es wird nichts aktiv ungültig gemacht; der Vergleich passiert bei
// jeder Anzeige. So kann keine Änderung unbemerkt unter einer Unterschrift passieren.
//
// Das ist eine EINFACHE elektronische Signatur (eIDAS Art. 3 Nr. 10) — keine
// qualifizierte. Für die Bestätigung von Arbeitszeiten im Beschäftigungsverhältnis
// ist das der übliche und ausreichende Weg.

const crypto = require('crypto');
const { get, all, run } = require('./db');

// Der Hash bindet genau die Positionen, die angezeigt wurden: Datum, Unterkunft,
// Minuten, Betrag. Reihenfolge festgelegt, damit derselbe Zettel denselben Hash gibt.
function hashPositionen(items) {
  const kanonisch = (items || [])
    .map(i => [i.job_id, i.date, i.unit || '', i.minutes, i.cents].join('|'))
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(kanonisch).digest('hex');
}

// Status der Unterschrift für einen Zettel.
//   'offen'    — noch nicht abgezeichnet
//   'gueltig'  — abgezeichnet, Positionen unverändert
//   'veraltet' — abgezeichnet, aber danach wurde etwas geändert
function status(tenantId, userId, periodStart, items) {
  const s = get(`SELECT * FROM timesheet_signatures
                  WHERE tenant_id = ? AND user_id = ? AND period_start = ?`,
                tenantId, userId, periodStart);
  if (!s) return { zustand: 'offen' };
  const jetzt = hashPositionen(items);
  return {
    zustand: s.hash === jetzt ? 'gueltig' : 'veraltet',
    signiert_am: s.signed_at,
    name: s.signed_name,
    summe_cents: s.total_cents,
  };
}

function signieren(tenantId, userId, periodStart, items, { name, totalCents, ip, userAgent }) {
  const hash = hashPositionen(items);
  const snapshot = JSON.stringify({ items, erstellt: new Date().toISOString() });
  const vorhanden = get(`SELECT id FROM timesheet_signatures
                          WHERE tenant_id = ? AND user_id = ? AND period_start = ?`,
                        tenantId, userId, periodStart);
  if (vorhanden) {
    run(`UPDATE timesheet_signatures
            SET hash = ?, snapshot = ?, signed_at = ?, signed_name = ?, total_cents = ?, ip = ?, user_agent = ?
          WHERE id = ?`,
        hash, snapshot, new Date().toISOString(), name, totalCents, ip || null, userAgent || null, vorhanden.id);
  } else {
    run(`INSERT INTO timesheet_signatures
           (tenant_id, user_id, period_start, hash, snapshot, signed_at, signed_name, total_cents, ip, user_agent)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        tenantId, userId, periodStart, hash, snapshot, new Date().toISOString(),
        name, totalCents, ip || null, userAgent || null);
  }
  return hash;
}

// Wann darf abgezeichnet werden? Eine abgelaufene Periode immer. Die laufende erst
// in den letzten drei Tagen — vorher ist der Zettel unvollständig und der Knopf
// stiftet nur Verwirrung.
function darfSignieren(periode, heute = new Date().toISOString().slice(0, 10)) {
  if (heute > periode.end) return true;
  const restTage = Math.round((new Date(periode.end + 'T12:00:00Z') - new Date(heute + 'T12:00:00Z')) / 86400000);
  return restTage <= 2;
}

module.exports = { hashPositionen, status, signieren, darfSignieren };
