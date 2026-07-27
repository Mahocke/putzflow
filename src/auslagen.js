// auslagen.js — Sonderausgaben: was eine Reinigungskraft für den Betrieb auslegt.
//
// Der Anlass ist banal — Kaffeekapseln nachkaufen, Ersatzschlüssel, eine Packung
// Müllbeutel — die Buchhaltung dahinter ist es nicht. Eine Auslage besteht aus zwei
// völlig verschiedenen Dingen, die NICHT vermischt werden dürfen:
//
//   1. Das verauslagte GELD. Das ist Auslagenersatz (§ 3 Nr. 50 EStG,
//      § 1 Abs. 1 Nr. 1 SvEV): steuer- und beitragsfrei, KEIN Arbeitsentgelt.
//      ⚠️ Es zählt deshalb WEDER in die Minijob-Grenze NOCH in die
//      Mindestlohn-Rechnung. Wer es einfach als Position dazuaddiert, schiebt
//      eine Kraft mit 30 € Kaffeekapseln scheinbar über die 603-€-Grenze — und
//      rechnet sich gleichzeitig den effektiven Stundenlohn schön.
//   2. Die ZEIT für den Weg. Das ist Arbeitszeit wie jede andere: vergütungs-
//      pflichtig, zählt in Mindestlohn und Minijob-Grenze.
//
// Deshalb trägt ein Eintrag beide Felder getrennt, und der Stundenzettel weist sie
// getrennt aus.
//
// ⚠️ Belege sind NICHT wie Kontrollfotos zu behandeln. Ein Kassenbon ist ein
// Buchungsbeleg (§ 147 AO, § 17 MiLoG) und unterliegt der Aufbewahrungspflicht —
// er darf nicht nach 90 Tagen verfallen. Deshalb ein eigener Ordner, den
// `cleanupPhotos()` nicht anfasst.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { get, all, run } = require('./db');
const billing = require('./billing');

const BELEG_DIR = process.env.RECEIPT_DIR ||
  path.join(path.dirname(path.resolve(process.env.DB_FILE || 'data/putzflow.sqlite')), 'belege');

fs.mkdirSync(BELEG_DIR, { recursive: true });

function fuerPeriode(tenantId, userId, von, bis) {
  return all(`SELECT * FROM expenses
               WHERE tenant_id = ? AND user_id = ? AND date BETWEEN ? AND ?
               ORDER BY date, id`, tenantId, userId, von, bis);
}

/**
 * Stundensatz für die Zeit einer Besorgung, in Cent. Von fein nach grob:
 *   1. Was die Verwaltung ausdrücklich einträgt (pay_cents) — schlägt alles.
 *   2. Der hinterlegte Stundenlohn der Person, falls nach Zeit abgerechnet wird.
 *   3. Ihr eigener effektiver Satz aus den Reinigungen dieser Periode. Bei
 *      Pauschalen gibt es keinen Stundensatz; ihren eigenen Schnitt zu nehmen ist
 *      fairer, als sie für den Botengang auf den Mindestlohn zurückzustufen.
 *   4. Der gesetzliche Mindestlohn — die Untergrenze, nie weniger.
 * ⚠️ Punkt 3 rechnet NUR mit den Reinigungspositionen, nicht mit den Auslagen
 * selbst: Sonst hinge der Satz von sich selbst ab.
 */
function stundensatzCents(regel, jobPositionen, dateStr) {
  const untergrenze = billing.mindestlohnCents(dateStr);
  if (regel && regel.mode === 'hourly' && regel.base_cents > 0) {
    return Math.max(regel.base_cents, untergrenze);
  }
  const mitZeit = (jobPositionen || []).filter(i => i.minutes > 0);
  const minuten = mitZeit.reduce((a, i) => a + i.minutes, 0);
  if (minuten > 0) {
    const betrag = mitZeit.reduce((a, i) => a + i.cents, 0);
    return Math.max(Math.round(betrag * 60 / minuten), untergrenze);
  }
  return untergrenze;
}

/** Vergütung für die Zeit einer einzelnen Auslage. */
function entgeltCents(auslage, satzCents) {
  if (auslage.pay_cents !== null && auslage.pay_cents !== undefined) return auslage.pay_cents;
  return Math.round((auslage.minutes || 0) * satzCents / 60);
}

/**
 * Auslagen einer Periode aufbereitet.
 * Nur GENEHMIGTE fließen in die Summen — ein Kassenbon, den niemand gesehen hat,
 * gehört nicht in einen Zettel, der an die Lohnbuchhaltung geht. Offene werden
 * trotzdem mitgeliefert, sonst verschwänden sie lautlos.
 */
function aufbereiten(rows, satzCents) {
  const posten = (rows || []).map(a => ({
    id: a.id,
    date: a.date,
    beschreibung: a.description,
    auslage_cents: a.amount_cents || 0,
    minutes: a.minutes || 0,
    entgelt_cents: entgeltCents(a, satzCents),
    beleg: !!a.receipt_file,
    genehmigt_am: a.approved_at,
    abgelehnt_am: a.rejected_at,
    zustand: a.approved_at ? 'genehmigt' : a.rejected_at ? 'abgelehnt' : 'offen',
    job_id: a.job_id,
    note: a.note,
  }));
  const genehmigt = posten.filter(p => p.zustand === 'genehmigt');
  return {
    posten,
    genehmigt,
    satz_cents: satzCents,
    auslagen_cents: genehmigt.reduce((s, p) => s + p.auslage_cents, 0),
    entgelt_cents: genehmigt.reduce((s, p) => s + p.entgelt_cents, 0),
    minuten: genehmigt.reduce((s, p) => s + p.minutes, 0),
    offen: posten.filter(p => p.zustand === 'offen').length,
  };
}

function speichereBeleg(tenantId, auslageId, buffer, mime) {
  const endung = /png/i.test(mime) ? 'png' : 'jpg';
  const name = `${tenantId}-${auslageId}-${crypto.randomBytes(8).toString('hex')}.${endung}`;
  fs.writeFileSync(path.join(BELEG_DIR, name), buffer);
  const alt = get(`SELECT receipt_file FROM expenses WHERE id = ?`, auslageId);
  if (alt && alt.receipt_file) {
    try { fs.unlinkSync(belegPfad(alt.receipt_file)); } catch { /* schon weg */ }
  }
  run(`UPDATE expenses SET receipt_file = ? WHERE id = ?`, name, auslageId);
  return name;
}

function belegPfad(datei) { return path.join(BELEG_DIR, path.basename(datei)); }

module.exports = {
  BELEG_DIR, fuerPeriode, stundensatzCents, entgeltCents, aufbereiten,
  speichereBeleg, belegPfad,
};
