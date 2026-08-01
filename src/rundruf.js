// rundruf.js — einen Termin mehreren Kräften gleichzeitig anbieten; die erste
// Zusage bekommt ihn.
//
// Warum das kein Komfort-Merkmal ist: Eine WhatsApp-Gruppe kann rufen, aber
// nicht binden — dort sieht Schweigen aus wie Zustimmung. Hier hat jedes
// Angebot einen Zustand, und wer zuerst zusagt, hat den Termin verbindlich.
//
// ⚠️ Der Zuschlag MUSS atomar sein. Zwei Kräfte, die im selben Moment tippen,
// dürfen nicht beide den Termin bekommen. Deshalb wird nicht erst gelesen und
// dann geschrieben, sondern in EINER Anweisung geschrieben und geprüft:
//     UPDATE jobs SET assigned_user_id = ? WHERE id = ? AND assigned_user_id IS NULL
// Ist `changes` danach 0, war jemand schneller. Ein vorheriges SELECT wäre ein
// Wettlauf mit sich selbst.
//
// ⚠️ Wer über der Verdienstgrenze läge, wird GAR NICHT erst gefragt. Ein
// Rundruf, der jemanden über die Grenze einlädt, schafft genau das Problem, das
// die Ampel verhindern soll — und die Absage danach wäre eine Zumutung. Die
// Übersprungenen werden aber gemeldet, nicht verschwiegen.

const { get, all, run } = require('./db');
const jobsLogic = require('./jobs');

function jetzt() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

// Wer kommt für diesen Termin in Frage?
// ausserIds: Personen, die für diesen Termin gerade ausscheiden — die fragt man
// nicht sofort erneut.
// ⚠️ `ausserGrund` ist KEIN Feinschliff. Der Grund steht wörtlich in der Mail an die
// Verwaltung, und es gibt zwei ganz verschiedene Anlässe: Die Kraft hat selbst
// abgesagt — oder die Verwaltung hat sie abgemeldet, weil sie krank ist. Ein festes
// „hat gerade abgesagt" behauptet im zweiten Fall etwas über eine Person, das sie nie
// gesagt hat, und zwar schriftlich gegenüber ihrer Chefin.
function kandidaten(tenant, job, ausserIds = [], ausserGrund = 'hat gerade abgesagt') {
  const crew = all(
    `SELECT * FROM users
      WHERE tenant_id = ? AND active = 1 AND silent = 0 AND role IN ('cleaner','lead')
      ORDER BY name`, tenant.id);

  const gefragt = [];
  const uebersprungen = [];

  for (const u of crew) {
    if (ausserIds.includes(u.id)) { uebersprungen.push({ user: u, grund: ausserGrund }); continue; }
    if (!u.email && !u.phone) { uebersprungen.push({ user: u, grund: 'keine Adresse hinterlegt' }); continue; }

    // ⚠️ Der Lohn hängt an der PERSON, nicht am Termin: comp_rules kann je Kraft
    // abweichen. Bei einem unbesetzten Termin liefert jobPay() die Standardregel
    // — für die Grenzprüfung muss deshalb so gerechnet werden, als hätte SIE ihn.
    const lohn = jobsLogic.jobPay(tenant, { ...job, assigned_user_id: u.id }).cents;

    // Die Grenze zählt Geleistetes, Geplantes UND die nötige Aufstockung mit
    // (src/jobs.js). Ein Angebot, das jemanden darüber trüge, unterbleibt.
    const ts = jobsLogic.timesheet(tenant, u.id, job.due_date);
    if (ts.minijob && lohn > ts.minijob.remaining_cents) {
      uebersprungen.push({ user: u, grund: `über der Verdienstgrenze — nur noch ${(ts.minijob.remaining_cents / 100).toFixed(2)} € frei` });
      continue;
    }
    gefragt.push(u);
  }
  return { gefragt, uebersprungen };
}

// Angebote schreiben. Idempotent: Ein zweiter Rundruf legt keine Dubletten an
// und weckt keine bereits beantworteten Angebote wieder auf.
function anbieten(tenant, job, users) {
  const t = jetzt();
  const neu = [];
  for (const u of users) {
    const vorhanden = get(`SELECT id, answer FROM job_offers WHERE job_id = ? AND user_id = ?`, job.id, u.id);
    if (vorhanden) {
      if (vorhanden.answer === null) continue;          // läuft schon
      run(`UPDATE job_offers SET answer = NULL, answered_at = NULL, offered_at = ? WHERE id = ?`, t, vorhanden.id);
    } else {
      run(`INSERT INTO job_offers(tenant_id, job_id, user_id, offered_at) VALUES(?,?,?,?)`,
          tenant.id, job.id, u.id, t);
    }
    neu.push(u);
  }
  return neu;
}

// Zuschlag. Liefert { ok: true } oder { ok: false, grund: 'vergeben' | 'kein_angebot' }.
function annehmen(tenant, job, user) {
  const angebot = get(`SELECT * FROM job_offers WHERE job_id = ? AND user_id = ?`, job.id, user.id);
  if (!angebot) return { ok: false, grund: 'kein_angebot' };
  // 'closed' heißt: eine andere war schneller. Das muss von „kenne ich nicht"
  // unterscheidbar bleiben, sonst bekommt sie beim Tippen auf einer veralteten
  // Liste ein „Termin nicht gefunden" und hält es für einen Fehler.
  if (angebot.answer === 'closed' || angebot.answer === 'yes') return { ok: false, grund: 'vergeben' };
  // Ein früheres „passt mir nicht" hindert sie nicht: Solange der Termin frei
  // ist, darf sie es sich anders überlegen.

  const t = jetzt();
  const r = run(
    `UPDATE jobs SET assigned_user_id = ?, confirmed = 1, declined_at = NULL,
            requested_at = COALESCE(requested_at, ?)
      WHERE id = ? AND assigned_user_id IS NULL`, user.id, t, job.id);
  if (!r.changes) {
    run(`UPDATE job_offers SET answer = 'closed', answered_at = ? WHERE id = ?`, t, angebot.id);
    return { ok: false, grund: 'vergeben' };
  }

  run(`UPDATE job_offers SET answer = 'yes', answered_at = ? WHERE id = ?`, t, angebot.id);
  const andere = all(`SELECT o.*, u.name, u.email, u.phone, u.channel FROM job_offers o
                       JOIN users u ON u.id = o.user_id
                      WHERE o.job_id = ? AND o.answer IS NULL`, job.id);
  run(`UPDATE job_offers SET answer = 'closed', answered_at = ? WHERE job_id = ? AND answer IS NULL`, t, job.id);
  return { ok: true, zuSpaet: andere };
}

// Absage auf ein Rundruf-Angebot. Der Termin bleibt für die übrigen offen.
function ablehnen(tenant, job, user) {
  const r = run(`UPDATE job_offers SET answer = 'no', answered_at = ?
                  WHERE job_id = ? AND user_id = ? AND answer IS NULL`, jetzt(), job.id, user.id);
  return { ok: !!r.changes };
}

// Läuft für diesen Termin noch ein Rundruf?
function offeneAngebote(job) {
  return all(`SELECT o.*, u.name FROM job_offers o JOIN users u ON u.id = o.user_id
               WHERE o.job_id = ? AND o.answer IS NULL ORDER BY u.name`, job.id);
}

module.exports = { kandidaten, anbieten, annehmen, ablehnen, offeneAngebote };
