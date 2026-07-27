// jobs.js — Fachlogik rund um Reinigungsaufträge: Vergütungsregel auflösen,
// Lohn je Job berechnen, Stundenzettel/Periodensumme bilden.

const { get, all } = require('./db');
const billing = require('./billing');
const auslagenLogik = require('./auslagen');

// Regel-Auflösung von fein nach grob: Putzkraft > Objekt > Mandanten-Default.
function resolveRule(tenantId, unitId, userId) {
  const candidates = [
    userId ? get(`SELECT * FROM comp_rules WHERE tenant_id = ? AND user_id = ? AND unit_id IS NULL`, tenantId, userId) : null,
    userId && unitId ? get(`SELECT * FROM comp_rules WHERE tenant_id = ? AND user_id = ? AND unit_id = ?`, tenantId, userId, unitId) : null,
    unitId ? get(`SELECT * FROM comp_rules WHERE tenant_id = ? AND unit_id = ? AND user_id IS NULL`, tenantId, unitId) : null,
    get(`SELECT * FROM comp_rules WHERE tenant_id = ? AND unit_id IS NULL AND user_id IS NULL`, tenantId),
  ];
  // Reihenfolge: (user+unit) am spezifischsten, dann user, dann unit, dann Default
  return candidates[1] || candidates[0] || candidates[2] || candidates[3] || billing.DEFAULT_RULE;
}

function sessionsFor(jobId) {
  return all(`SELECT started_at, ended_at FROM work_sessions WHERE job_id = ? ORDER BY started_at`, jobId);
}

// § 17 Abs. 1 MiLoG verlangt Beginn, ENDE und Dauer — die Dauer allein genügt nicht.
// Deshalb wandern die Zeitpunkte bis auf den Stundenzettel durch.
const hhmm = ts => (ts ? String(ts).slice(11, 16) : null);
const zeitraeume = sessions => (sessions || [])
  .filter(s => s.ended_at)
  .map(s => ({ von: hhmm(s.started_at), bis: hhmm(s.ended_at) }));

// Die Aufzeichnung ist spätestens am siebten auf den Arbeitstag folgenden Kalendertag
// fällig (§ 17 Abs. 1 S. 1 MiLoG). Danach lässt sie sich nicht mehr fristgerecht
// nachholen — dann hilft nur noch, es überhaupt nachzutragen.
const AUFZEICHNUNGSFRIST_TAGE = 7;
function fristAbgelaufen(dateStr, heute = new Date().toISOString().slice(0, 10)) {
  const tage = Math.round((new Date(heute + 'T12:00:00Z') - new Date(dateStr + 'T12:00:00Z')) / 86400000);
  return tage > AUFZEICHNUNGSFRIST_TAGE;
}

// Ein Job -> { minutes, cents, rule }
// Sonderaufgabe: was die Verwaltung von Hand vergibt und was keine Reinigung ist —
// Kaffeekapseln kaufen, Wäsche holen, den Schlüsseldienst treffen.
const AUFGABE = 'aufgabe';

function jobPay(tenant, job) {
  const rule = resolveRule(tenant.id, job.unit_id, job.assigned_user_id);
  const minutes = billing.minutesWorked(sessionsFor(job.id));

  // ⚠️ Eine Sonderaufgabe darf NICHT die Reinigungspauschale bekommen. 22,50 €
  // für „eben Kapseln holen" wäre so falsch wie 22,50 € für einen halben Tag
  // Wäscherei — in beide Richtungen. Deshalb entweder ein ausdrücklicher Betrag
  // oder Bezahlung nach erfasster Zeit.
  if (job.kind === AUFGABE) {
    // ⚠️ NULL heißt „nach Zeit" und ist nicht dasselbe wie 0. Ein Betrag von
    // 0 ist eine bewusste Angabe (unentgeltlich) und muss erhalten bleiben.
    if (job.pay_cents !== null && job.pay_cents !== undefined) {
      return { minutes, cents: job.pay_cents, mode: 'fixed', rule };
    }
    // Ohne hinterlegten Stundenlohn gilt der Mindestlohn — die einzige Zahl, die
    // ohne weitere Angaben rechtlich nicht falsch sein kann.
    const satz = rule.mode === 'hourly' && rule.base_cents > 0
      ? Math.max(rule.base_cents, billing.mindestlohnCents(job.due_date))
      : billing.mindestlohnCents(job.due_date);
    return { minutes, cents: Math.round(minutes * satz / 60), mode: 'hourly', rule };
  }

  const cents = billing.payCents({ rule, dateStr: job.due_date, minutes, region: tenant.region });
  // mode gehört mit nach draußen: beim Stundenlohn ohne erfasste Zeit muss die
  // Oberfläche „nach Zeit" statt „0,00 €" zeigen können.
  return { minutes, cents, mode: rule.mode, rule };
}

// Stundenzettel einer Putzkraft für die Periode, in die dateStr fällt.
// Basis ist assigned_user_id (wer den Termin hat, dessen Lohn) — wie in G&G.
function timesheet(tenant, userId, dateStr) {
  const period = billing.periodOf(dateStr, tenant.period_start_day);
  const person = get(`SELECT employment FROM users WHERE id = ?`, userId);
  const employment = person ? person.employment : 'minijob';
  const rows = all(
    `SELECT j.*, u.name AS unit_name
       FROM jobs j LEFT JOIN units u ON u.id = j.unit_id
      WHERE j.tenant_id = ? AND j.assigned_user_id = ?
        AND j.due_date BETWEEN ? AND ?
        AND j.status IN ('open','done')
      ORDER BY j.due_date, j.id`,
    tenant.id, userId, period.start, period.end);

  // ⚠️ Geplante Termine gehören auf den BILDSCHIRM (ohne sie ließe sich die
  // Minijob-Grenze nicht vorausschauend verteilen), aber NICHT auf den Zettel für die
  // Lohnbuchhaltung: Dort wäre noch nicht geleistete Arbeit als Vergütung ausgewiesen.
  // Deshalb trägt jede Position, ob sie geleistet oder geplant ist, und die Summen
  // sind getrennt.
  let cents = 0, minutes = 0, geplantCents = 0;
  const items = rows.map(j => {
    const p = jobPay(tenant, j);
    const geplant = j.status !== 'done';
    if (geplant) geplantCents += p.cents;
    else { cents += p.cents; minutes += p.minutes; }
    const zeiten = zeitraeume(sessionsFor(j.id));
    return {
      // ⚠️ Bei einer Sonderaufgabe steht der Titel, wo sonst die Unterkunft
      // steht — sonst erschiene sie im Stundenzettel und im PDF für die
      // Lohnbuchhaltung als leere Zeile mit einem Betrag daneben. Eine Position
      // ohne Bezeichnung ist in einem Lohndokument wertlos.
      job_id: j.id, date: j.due_date, kind: j.kind, unit: j.unit_name || j.titel,
      status: j.status, minutes: p.minutes, cents: p.cents, mode: p.rule.mode,
      geplant, zeiten,
      // Erledigt, aber ohne Zeitaufzeichnung — das ist der dokumentierte Mangel,
      // nicht bloß eine fehlende Zahl.
      zeit_fehlt: !geplant && !zeiten.length,
      frist_abgelaufen: !geplant && !zeiten.length && fristAbgelaufen(j.due_date),
    };
  });
  const geleistet = items.filter(i => !i.geplant);

  // Sonderausgaben. Die ZEIT für eine Besorgung ist Arbeitszeit wie jede andere und
  // geht in Mindestlohn und Minijob-Grenze ein; das verauslagte GELD ist
  // Auslagenersatz und darf in keine der beiden Rechnungen — siehe auslagen.js.
  const satz = auslagenLogik.stundensatzCents(resolveRule(tenant.id, null, userId), items, period.start);
  const auslagen = auslagenLogik.aufbereiten(
    auslagenLogik.fuerPeriode(tenant.id, userId, period.start, period.end), satz);

  // cents/minutes enthalten nur Geleistetes — Geplantes steht getrennt in geplant_cents.
  const entgeltCents = cents + auslagen.entgelt_cents;
  const entgeltMinuten = minutes + auslagen.minuten;

  // Nur Auslagen MIT Zeit gehen in die Prüfung. Eine reine Erstattung ohne Weg ist
  // keine „Position ohne erfasste Zeit" — sie als solche zu zählen würde den Hinweis
  // „nicht prüfbar" auf dem Zettel grundlos aufblähen.
  const mindestlohn = billing.mindestlohnPruefung(
    [...geleistet, ...auslagen.genehmigt.filter(p => p.minutes > 0)
                                        .map(p => ({ minutes: p.minutes, cents: p.entgelt_cents }))],
    period.start);

  // Die Unterschrift bindet auch die Auslagen: Wird eine nachträglich geändert oder
  // genehmigt, ändert sich der Betrag auf dem Zettel — dann muss neu abgezeichnet
  // werden. Ohne Auslagen ist die Liste identisch zu früher, alte Unterschriften
  // bleiben also gültig.
  // Abgezeichnet wird nur, was tatsächlich geleistet wurde — was nächste Woche
  // ansteht, kann niemand bestätigen. Nebenwirkung: Der Hash bleibt stabil, während
  // die Planung sich noch ändert.
  const signaturPositionen = [...geleistet, ...auslagen.genehmigt.map(p => ({
    job_id: `auslage-${p.id}`, date: p.date, unit: p.beschreibung,
    minutes: p.minutes, cents: p.entgelt_cents + p.auslage_cents,
  }))];

  return {
    period, items, geleistet,
    total_cents: entgeltCents, total_minutes: entgeltMinuten,
    geplant_cents: geplantCents,
    // Ampel für die Verwaltung: Was ist erledigt, aber nicht aufgezeichnet?
    aufzeichnung: {
      fehlend: geleistet.filter(i => i.zeit_fehlt).length,
      frist_abgelaufen: geleistet.filter(i => i.frist_abgelaufen).length,
      frist_tage: AUFZEICHNUNGSFRIST_TAGE,
    },
    mindestlohn,
    auslagen,
    signatur_positionen: signaturPositionen,
    // Was tatsächlich zu überweisen ist: Vergütung, etwaige Aufstockung und die
    // Erstattung der Auslagen. Nur die ersten beiden sind Arbeitsentgelt.
    zu_zahlen_cents: entgeltCents + mindestlohn.fehlbetrag_cents + auslagen.auslagen_cents,
    employment,
    // Grenze nur bei Minijob. Midijob kennt keine solche Obergrenze; Festangestellte
    // und Reinigungsfirmen ohnehin nicht — dort wäre ein Balken schlicht Unsinn.
    // ⚠️ Die Aufstockung zählt mit — sie ist Arbeitsentgelt. Die Auslagenerstattung
    // nicht.
    // ⚠️ UND das Geplante zählt mit, anders als beim Stundenzettel. Die Frage bei der
    // Zuteilung ist „wer darf diesen Termin noch übernehmen?" — wer schon zugesagte
    // Termine ausblendet, verteilt fröhlich über die Grenze hinaus und merkt es erst
    // am Monatsende.
    minijob: employment === 'minijob'
      ? billing.minijobStatus(entgeltCents + mindestlohn.fehlbetrag_cents + geplantCents,
                              billing.minijobLimitCents(period.start, tenant.minijob_limit_cents))
      : null,
  };
}

module.exports = { resolveRule, sessionsFor, jobPay, timesheet, AUFGABE,
                   zeitraeume, fristAbgelaufen, AUFZEICHNUNGSFRIST_TAGE };
