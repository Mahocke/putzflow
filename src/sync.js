// sync.js — Aus Smoobu-Buchungen werden Reinigungsaufträge.
//
// Grundregel: Jede Abreise erzeugt eine Reinigung am Abreisetag. Der Abreisetag
// ist `departure`, die Uhrzeit steht als `check-out` an der Buchung selbst.
//
// Die drei Fälle, an denen so etwas erfahrungsgemäß scheitert — alle aus G&G gelernt:
//
//   1. STORNO. Smoobu liefert stornierte Buchungen weiter mit, erkennbar an
//      `type: 'cancellation'`. Die zugehörige Reinigung entfällt; war sie schon
//      zugesagt, wird die Kraft verständigt und der Kalendereintrag abgesagt.
//   2. VERSCHOBEN. Ändert sich das Abreisedatum, darf ein bereits ZUGESAGTER
//      Termin nicht still wandern. Er wird auf „angefragt" zurückgesetzt und neu
//      gefragt — sonst steht die Kraft am falschen Tag vor der Tür.
//   3. EIGENBELEGUNG. `is-blocked-booking` sind Sperren des Vermieters, keine
//      Gäste. Daraus entsteht keine Reinigung.

const { get, all, run } = require('./db');

const SCHLUESSEL = b => `smoobu:${b.id}`;

// Echtes Prädikat: liefert true/false, nicht das Abreisedatum. Klingt nach
// Kleinigkeit, aber ein Prädikat, das Daten zurückgibt, lädt zu Fehlern ein.
function istGast(b) {
  return !!(b && b.type !== 'cancellation' && !b['is-blocked-booking'] && b.departure);
}

// Unterkünfte abgleichen: neue anlegen, Namen nachziehen. Nichts löschen —
// eine in Smoobu entfernte Wohnung kann noch Aufträge und Stundenzettel tragen.
function syncUnits(tenant, apartments) {
  let neu = 0, umbenannt = 0;
  for (const a of apartments) {
    const ref = String(a.id);
    const vorhanden = get(`SELECT * FROM units WHERE tenant_id = ? AND external_ref = ?`, tenant.id, ref);
    if (!vorhanden) {
      run(`INSERT INTO units(tenant_id, name, kind, external_ref) VALUES(?,?,?,?)`,
          tenant.id, a.name, 'apartment', ref);
      neu++;
    } else if (vorhanden.name !== a.name) {
      run(`UPDATE units SET name = ? WHERE id = ?`, a.name, vorhanden.id);
      umbenannt++;
    }
  }
  return { neu, umbenannt };
}

/**
 * Buchungen in Aufträge überführen.
 * @returns {{angelegt:number, verschoben:object[], entfallen:object[], uebersprungen:number}}
 */
function syncJobs(tenant, buchungen) {
  const angelegt = [];
  const verschoben = [];
  const entfallen = [];
  let uebersprungen = 0;

  for (const b of buchungen) {
    const key = SCHLUESSEL(b);
    const vorhanden = get(`SELECT * FROM jobs WHERE tenant_id = ? AND dedup_key = ?`, tenant.id, key);

    // --- Storno oder Eigenbelegung: Reinigung entfällt ---
    if (!istGast(b)) {
      if (vorhanden && vorhanden.status !== 'skipped') {
        run(`UPDATE jobs SET status = 'skipped', skipped_by = 'smoobu' WHERE id = ?`, vorhanden.id);
        entfallen.push({ job: vorhanden, grund: b.type === 'cancellation' ? 'storniert' : 'Eigenbelegung' });
      } else if (!vorhanden) {
        uebersprungen++;
      }
      continue;
    }

    const unit = get(`SELECT * FROM units WHERE tenant_id = ? AND external_ref = ?`,
                     tenant.id, String(b.apartment && b.apartment.id));
    if (!unit) { uebersprungen++; continue; }        // Unterkunft (noch) nicht bekannt

    const abreise = b.departure;
    const zeit = /^\d{1,2}:\d{2}$/.test(b['check-out'] || '') ? b['check-out'] : null;

    if (!vorhanden) {
      run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, status, dedup_key, note)
           VALUES(?,?,?,?,'open',?,?)`,
          tenant.id, unit.id, abreise, 'apartment', key,
          zeit ? `Abreise ${zeit}` : null);
      angelegt.push(get(`SELECT * FROM jobs WHERE tenant_id = ? AND dedup_key = ?`, tenant.id, key));
      continue;
    }

    // --- Datum geändert? ---
    if (vorhanden.due_date !== abreise) {
      if (vorhanden.status === 'done') continue;      // erledigt bleibt erledigt
      const warZugesagt = !!vorhanden.confirmed;
      const alteKraft = vorhanden.assigned_user_id;

      if (warZugesagt) {
        // NICHT still verschieben: die Kraft hat für den alten Tag zugesagt.
        run(`UPDATE jobs SET due_date = ?, confirmed = 0, start_time = NULL, requested_at = ? WHERE id = ?`,
            abreise, new Date().toISOString().slice(0, 19).replace('T', ' '), vorhanden.id);
      } else {
        run(`UPDATE jobs SET due_date = ?, start_time = NULL WHERE id = ?`, abreise, vorhanden.id);
      }
      verschoben.push({ job: get(`SELECT * FROM jobs WHERE id = ?`, vorhanden.id),
                        von: vorhanden.due_date, nach: abreise, warZugesagt, alteKraft });
      continue;
    }

    // Wieder aufgelebt (Storno zurückgenommen)
    //
    // ⚠️ NUR, was Smoobu selbst abgesagt hat. Sagt die Verwaltung eine Reinigung von
    // Hand ab — der Gast kam nicht, die Wohnung wird doch nicht gebraucht —, dann
    // bleibt die Buchung in Smoobu eine ganz normale Gastbuchung. Ohne diese
    // Bedingung stünde die abgesagte Reinigung nach dem nächsten stündlichen Lauf
    // wieder als „offen" in der Liste, und niemand käme darauf, warum: Es hat ja
    // keiner etwas angefasst. Die Absage von Hand wiegt schwerer als das, was in
    // Smoobu steht — sie kennt den Grund, den Smoobu nicht kennt.
    if (vorhanden.status === 'skipped' && vorhanden.skipped_by !== 'admin') {
      run(`UPDATE jobs SET status = 'open', skipped_by = NULL WHERE id = ?`, vorhanden.id);
      angelegt.push(get(`SELECT * FROM jobs WHERE id = ?`, vorhanden.id));
    }
  }

  return { angelegt, verschoben, entfallen, uebersprungen };
}

module.exports = { syncUnits, syncJobs, istGast, SCHLUESSEL };
