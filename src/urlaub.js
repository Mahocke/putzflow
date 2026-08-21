// urlaub.js — Urlaubsanspruch, -zählung und -entgelt.
//
// Fachlich aus Glanz & Gloria übernommen (dort `vacation.js`), aber an drei Stellen
// verallgemeinert, weil Putzflow viele Betriebe bedient und G&G genau einen:
//
//   1. **Feiertage hängen am Bundesland des Mandanten**, nicht fest an NRW.
//   2. **Die Zähleinheit ist einstellbar** (`tenants.urlaub_werktage`, 5 oder 6).
//   3. **Der Verdienst kommt aus `jobs.jobPay()`**, also aus der Vergütungsregel des
//      Mandanten — G&G konnte mit festen Pauschalen rechnen.
//
// ZÄHLWEISE. Urlaubstag = Werktag ohne Feiertag. Werktage sind nach § 3 Abs. 2 BUrlG
// **Montag bis Samstag** — das ist die gesetzliche Einheit und deshalb der Standard.
// Ein Betrieb, dessen Verträge in Arbeitstagen (Mo–Fr) rechnen, stellt auf 5 um.
// Eine ganze freie Woche kostet dann 5 statt 6 Tage; entsprechend sind 30 Werktage
// dasselbe wie 25 Arbeitstage. Sonntage gehen nie ab, Feiertage ebenso wenig
// (§ 3 Abs. 2 BUrlG: nie auf den Urlaub anrechenbar).
// Beantragt wird trotzdem der volle Zeitraum inklusive Wochenende — nur so blockiert
// die Planung richtig; gezählt werden aber nur die Werktage darin.
//
// ⚠️ **Anspruch, Verbrauch UND Entgelt müssen dieselbe Einheit benutzen.** Sonst zahlt
// eine freie Woche nicht den Wochenverdienst — siehe `entgeltProTag()`. Deshalb geht
// `werktage` durch alle drei Funktionen, statt an einer Stelle festzustehen.
//
// ⚠️ **Die Einheit wird bei der Genehmigung EINGEFROREN** (`vacation_requests.werktage`).
// Stellt ein Betrieb später von 6 auf 5 um, würden sonst rückwirkend alle genehmigten
// Urlaube neu gezählt: Ein Zettel, der längst abgezeichnet und an die Lohnbuchhaltung
// gegangen ist, änderte sich Monate später von selbst.

const { get, all } = require('./db');
const auslagenLogik = require('./auslagen');
const { isHoliday } = require('./holidays');

// ⚠️ `jobs.js` wird ERST BEIM AUFRUF geladen, nicht hier oben. Die beiden Module
// brauchen einander: Der Stundenzettel in `jobs.js` fragt nach dem Urlaub der
// Periode, und das Urlaubsentgelt hier fragt nach dem Verdienst der letzten
// dreizehn Wochen. Stünde die Zeile oben, bekäme das zuerst geladene Modul vom
// anderen ein leeres Objekt — `jobsLogik.jobPay is not a function`, und zwar je
// nach Ladereihenfolge mal hier und mal dort. Ein `require` im Rumpf kostet nichts
// (Node hält den Modul-Cache), löst den Ring aber sauber auf.
function jobs() { return require('./jobs'); }

// § 3 Abs. 2 BUrlG. Kein frei wählbarer Wert: 5 und 6 sind die beiden Einheiten, in
// denen Arbeitsverträge tatsächlich geschrieben werden. Alles andere wäre eine
// Zahl, die niemand belegen kann — und aus der sich Geld ableitet.
const WERKTAGE_STANDARD = 6;

function werktageProWoche(quelle) {
  const n = parseInt(quelle && (quelle.urlaub_werktage ?? quelle.werktage), 10);
  return n === 5 ? 5 : WERKTAGE_STANDARD;
}

// Datums-Helfer mit Mittag-Anker — sommerzeitsicher, dasselbe Muster wie in zeit.js.
function plusTage(dateStr, n) {
  return new Date(new Date(dateStr + 'T12:00:00Z').getTime() + n * 86400000)
    .toISOString().slice(0, 10);
}
function wochentag(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();          // 0=So … 6=Sa
}

// Ein Urlaubstag ist ein Werktag ohne Feiertag.
// ⚠️ `region` darf leer sein — dann gelten nur die bundesweiten Feiertage. Das ist
// dieselbe bewusste Entscheidung wie beim Zuschlag: ein plausibel aussehender
// falscher Wert (stiller Rückfall auf NRW) ist schlimmer als ein fehlender.
function istUrlaubstag(dateStr, region, werktage = WERKTAGE_STANDARD) {
  const w = wochentag(dateStr);
  return w >= 1 && w <= werktage && !isHoliday(dateStr, region);
}

// Urlaubstage im Zeitraum, beide Grenzen inklusive.
function zaehleTage(von, bis, region, werktage = WERKTAGE_STANDARD) {
  let n = 0;
  for (let d = von; d <= bis; d = plusTage(d, 1)) if (istUrlaubstag(d, region, werktage)) n++;
  return n;
}

// Wie zaehleTage, aber je Kalenderjahr aufgeteilt: { 2026: 5, 2027: 3 }. Urlaub über
// den Jahreswechsel belastet so jedes Jahr sein eigenes Kontingent.
function zaehleTageJeJahr(von, bis, region, werktage = WERKTAGE_STANDARD) {
  const out = {};
  for (let d = von; d <= bis; d = plusTage(d, 1)) {
    if (!istUrlaubstag(d, region, werktage)) continue;
    const y = +d.slice(0, 4);
    out[y] = (out[y] || 0) + 1;
  }
  return out;
}

// --- Anspruch ---------------------------------------------------------------
// Jahresanspruch der Person. Beginnt er unterjährig — Eintritt oder Vertrags-
// umstellung —, gilt § 5 Abs. 1 BUrlG: ein Zwölftel je VOLLEM Beschäftigungsmonat
// ab `vacation_start` (ein Start am Monatsersten zählt den Monat mit).
// Bruchteile ab einem halben Tag werden aufgerundet (§ 5 Abs. 2 BUrlG); darunter
// bleiben sie stehen — abrunden wäre eine Kürzung ohne Grundlage.
//
// null = für diese Person ist kein Urlaubskonto geführt (z. B. eine Reinigungsfirma
// als Auftragnehmerin — die hat keinen Urlaubsanspruch gegen den Betrieb).
function anspruchFuerJahr(user, jahr) {
  if (!user || !user.vacation_days) return null;
  const voll = user.vacation_days;
  const start = user.vacation_start;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return voll;

  const startJahr = +start.slice(0, 4);
  if (startJahr < jahr) return voll;
  if (startJahr > jahr) return 0;

  const ersterVollerMonat = +start.slice(8, 10) === 1 ? +start.slice(5, 7) : +start.slice(5, 7) + 1;
  const monate = Math.max(0, 12 - ersterVollerMonat + 1);
  const roh = voll * monate / 12;
  const bruch = roh - Math.floor(roh);
  return bruch >= 0.5 ? Math.ceil(roh) : Math.round(roh * 10) / 10;
}

// Genehmigte Urlaubstage einer Person, je Jahr und „davon bis 31.3.".
// Der Q1-Anteil ist wichtig, weil er zuerst den Übertrag aus dem Vorjahr aufbraucht.
//
// ⚠️ Gezählt wird mit der bei der Genehmigung eingefrorenen Einheit (`r.werktage`),
// nicht mit der heutigen Einstellung des Mandanten. Siehe Kopf der Datei.
function genommenJeJahr(userId, region) {
  const jeJahr = {};
  const reqs = all(`SELECT start_date, end_date, werktage FROM vacation_requests
                     WHERE user_id = ? AND status = 'approved'`, userId);
  for (const r of reqs) {
    const w = werktageProWoche(r);
    for (let d = r.start_date; d <= r.end_date; d = plusTage(d, 1)) {
      if (!istUrlaubstag(d, region, w)) continue;
      const y = +d.slice(0, 4);
      if (!jeJahr[y]) jeJahr[y] = { genommen: 0, genommenQ1: 0 };
      jeJahr[y].genommen++;
      if (d <= `${y}-03-31`) jeJahr[y].genommenQ1++;
    }
  }
  return jeJahr;
}

// Urlaubskonto für ein Jahr: Anspruch, Übertrag aus dem Vorjahr, Verbrauch, Rest.
//
// Übertrag: Was am Jahresende übrig ist, wandert ins Folgejahr und verfällt dort am
// 31.3. (§ 7 Abs. 3 BUrlG). Urlaub, der bis dahin genommen wird, geht ZUERST auf den
// Übertrag — sonst verfiele er, obwohl die Person gerade freinimmt.
//
// `rest` kann negativ werden (überzogen). Das ist Absicht: Die Genehmigung WARNT
// dann, blockt aber nicht — ein Betrieb darf Urlaub im Voraus gewähren, und ein
// Werkzeug, das ihm das verbietet, wird umgangen statt benutzt.
// ⚠️ **Ein Übertrag wird NUR aus Jahren gerechnet, die Putzflow selbst kennt.**
// Das war der erste Entwurf falsch: Ohne Startdatum lief die Schleife drei Jahre
// zurück, unterstellte in jedem Jahr den vollen Anspruch und keinen genommenen Tag —
// ein frisch angelegtes Konto zeigte damit im Januar 60 statt 30 freien Tagen. Die
// Zahl sah völlig plausibel aus, und genau das ist das Problem: Sie stammte nicht aus
// Daten, sondern aus einer Annahme über die Zeit VOR der Einführung.
// `vacation_tracked_since` hält fest, ab wann das Konto hier geführt wird. Davor sagt
// Putzflow nichts, statt etwas zu erfinden (`uebertrag_unbekannt`).
function konto(user, region, heuteStr, zieljahr = null) {
  if (!user || !user.vacation_days) return null;
  const jahr = zieljahr || +heuteStr.slice(0, 4);
  const jahrVon = s => (s && /^\d{4}/.test(String(s))) ? +String(s).slice(0, 4) : null;
  const gefuehrtSeit = jahrVon(user.vacation_tracked_since);
  const anspruchSeit = jahrVon(user.vacation_start);

  // Frühestens ab dem Jahr, in dem das Konto hier eröffnet wurde — und nie vor dem
  // Beginn des Anspruchs. Höchstens drei Jahre zurück: Weiter zurück kann kein
  // Übertrag mehr leben, und jedes Jahr kostet eine Runde über alle Anträge.
  const basis = Math.max(gefuehrtSeit ?? jahr, anspruchSeit ?? -Infinity);
  const startJahr = Math.max(Math.min(basis, jahr), jahr - 3);
  const jeJahr = genommenJeJahr(user.id, region);

  let uebertrag = 0, ergebnis = null;
  for (let y = startJahr; y <= jahr; y++) {
    const anspruch = anspruchFuerJahr(user, y) || 0;
    const g = jeJahr[y] || { genommen: 0, genommenQ1: 0 };
    const ausUebertrag = Math.min(uebertrag, g.genommenQ1);
    const restAnspruch = anspruch - (g.genommen - ausUebertrag);
    const uebertragRest = uebertrag - ausUebertrag;

    if (y === jahr) {
      const verfall = `${y}-03-31`;
      // Der Übertrag zählt nur, solange sein Verfallstag nicht vorbei ist. Bei einer
      // Vorschau aufs Folgejahr ist er das noch nicht — deshalb der Vergleich mit
      // `heute` und nicht mit dem Jahr.
      const nochGueltig = heuteStr <= verfall;
      const lebenderUebertrag = nochGueltig ? Math.max(0, uebertragRest) : 0;
      ergebnis = {
        jahr: y,
        anspruch,
        uebertrag_ein: runde(uebertrag),
        uebertrag_rest: runde(lebenderUebertrag),
        uebertrag_verfaellt: verfall,
        genommen: runde(g.genommen),
        rest: runde(restAnspruch + lebenderUebertrag),
        // Wahr, wenn die Person schon vor der Einführung Anspruch hatte: Dann gibt es
        // womöglich einen Übertrag, den Putzflow nicht kennen kann. Die Oberfläche
        // sagt das hin, statt „0 Tage Übertrag" zu behaupten.
        uebertrag_unbekannt: startJahr === y && anspruchSeit !== null && anspruchSeit < y,
      };
    }
    uebertrag = Math.max(0, restAnspruch);      // nur ein positiver Rest wandert weiter
  }
  return ergebnis;
}

function runde(n) { return Math.round(n * 10) / 10; }

// --- Urlaubsentgelt (§ 11 BUrlG) --------------------------------------------
// Der durchschnittliche Verdienst der letzten dreizehn Wochen vor Urlaubsbeginn,
// umgerechnet auf einen Urlaubstag.
//
// ⚠️ **Der Divisor MUSS die Zähleinheit sein.** Das Entgelt kommt vom WOCHEN­verdienst
// geteilt durch die Werktage der Woche — NICHT vom Verdienst je tatsächlichem
// Arbeitstag. Sonst bekäme eine Kraft, die an zwei von sechs Werktagen arbeitet, für
// eine freie Woche das Dreifache dessen, was sie sonst verdient hätte. So kostet eine
// ganze freie Woche exakt einen Wochenverdienst — unabhängig davon, auf wie viele
// Tage sie ihn sonst verteilt.
//
// Divisor „Wochen MIT Arbeit" statt starr 13: Wochen ohne Einsatz — Einarbeitung,
// Urlaub, Krankheit — drücken den Schnitt nicht. Das entspricht § 11 Abs. 1 Satz 3
// BUrlG, wonach Verdienstkürzungen wegen unverschuldeter Ausfälle außer Betracht
// bleiben.
//
// ⚠️ **Auslagenersatz geht NICHT ein, die vergütete Zeit dafür schon.** Das
// verauslagte Geld ist kein Arbeitsentgelt (§ 3 Nr. 50 EStG) und hätte im Schnitt
// nichts zu suchen; der Botengang selbst ist Arbeit wie jede andere. Wer beides
// zusammen nimmt, rechnet das Urlaubsentgelt an den Kaffeekapseln hoch.
//
// Ohne Historie (`referenz_wochen = 0`) kommt 0 heraus, zusammen mit `keine_historie`.
// Das ist eine Warnung, kein Riegel: Wer in der ersten Woche Urlaub beantragt, hat
// keinen Schnitt — den Betrag muss dann ein Mensch setzen.
function montagDerWoche(dateStr) {
  return plusTage(dateStr, -((wochentag(dateStr) + 6) % 7));
}

function entgeltProTag(tenant, user, startDatum, werktage = werktageProWoche(tenant)) {
  const von = plusTage(startDatum, -91);        // 13 volle Wochen
  const bis = plusTage(startDatum, -1);

  const rows = all(
    `SELECT * FROM jobs
      WHERE tenant_id = ? AND assigned_user_id = ? AND status = 'done'
        AND due_date BETWEEN ? AND ?`, tenant.id, user.id, von, bis);

  const jobsLogik = jobs();
  let summe = 0;
  const wochen = new Set(), tage = new Set();
  const positionen = [];
  for (const j of rows) {
    const p = jobsLogik.jobPay(tenant, j);
    summe += p.cents;
    positionen.push({ minutes: p.minutes, cents: p.cents });
    wochen.add(montagDerWoche(j.due_date));
    tage.add(j.due_date);
  }

  // Die vergütete ZEIT genehmigter Auslagen zählt mit — sie ist Arbeitsentgelt.
  const satz = auslagenLogik.stundensatzCents(
    jobsLogik.resolveRule(tenant.id, null, user.id), positionen, von);
  const auslagen = auslagenLogik.aufbereiten(
    auslagenLogik.fuerPeriode(tenant.id, user.id, von, bis), satz);
  for (const p of auslagen.genehmigt) {
    if (!p.entgelt_cents) continue;
    summe += p.entgelt_cents;
    wochen.add(montagDerWoche(p.date));
  }

  const refWochen = wochen.size;
  return {
    pro_tag_cents: refWochen ? Math.round(summe / (refWochen * werktage)) : 0,
    pro_woche_cents: refWochen ? Math.round(summe / refWochen) : 0,
    referenz_summe_cents: summe,
    referenz_wochen: refWochen,
    referenz_tage: tage.size,
    referenz_von: von,
    referenz_bis: bis,
    werktage,
    keine_historie: refWochen === 0,
  };
}

// --- Zustand ----------------------------------------------------------------
// Führt diese Person heute schon ein Urlaubskonto? Urlaubstage müssen hinterlegt und
// das Startdatum erreicht sein — wer zum 1.9. auf Midijob wechselt, sieht vorher
// nichts, statt einen Anspruch angezeigt zu bekommen, den sie noch nicht hat.
function aktiv(user, heuteStr) {
  if (!user || !user.vacation_days) return false;
  return !user.vacation_start || user.vacation_start <= heuteStr;
}

// Hat die Person an diesem Tag GENEHMIGTEN Urlaub? Das ist die Frage, an der die
// Planung hängt: keine Zuteilung, kein Angebot, keine Erinnerung.
//
// ⚠️ Bewusst nur `approved`. Ein offener Antrag darf die Planung NICHT blockieren —
// sonst könnte sich jede Kraft durch bloßes Beantragen aus dem Dienstplan nehmen,
// und die Verwaltung merkte es erst, wenn niemand mehr verfügbar ist.
function imUrlaub(userId, dateStr) {
  return !!get(`SELECT 1 AS x FROM vacation_requests
                 WHERE user_id = ? AND status = 'approved'
                   AND start_date <= ? AND end_date >= ?`, userId, dateStr, dateStr);
}

// Alle Tage eines Zeitraums, an denen die Person genehmigten Urlaub hat — für die
// Anzeige im Kalender der Verwaltung.
function urlaubstageImZeitraum(tenantId, userId, von, bis) {
  const reqs = all(
    `SELECT id, start_date, end_date, werktage FROM vacation_requests
      WHERE tenant_id = ? AND user_id = ? AND status = 'approved'
        AND start_date <= ? AND end_date >= ?`, tenantId, userId, bis, von);
  const tage = [];
  for (const r of reqs) {
    const a = r.start_date > von ? r.start_date : von;
    const b = r.end_date < bis ? r.end_date : bis;
    for (let d = a; d <= b; d = plusTage(d, 1)) tage.push({ datum: d, antrag_id: r.id });
  }
  return tage;
}

// --- Für den Stundenzettel --------------------------------------------------
// Eine Zeile je genehmigtem Antrag, der in die Periode hineinragt — mit den Tagen,
// die IN der Periode liegen, und dem bei der Genehmigung eingefrorenen Tagessatz.
//
// ⚠️ **Gezählt wird je Periode neu, bezahlt wird mit dem eingefrorenen Satz.** Ein
// Urlaub über den Periodenwechsel gehört anteilig in beide Zettel — die Tage lassen
// sich also nicht aus dem Antrag übernehmen. Der SATZ dagegen darf sich nicht mehr
// bewegen, sonst änderte sich ein abgezeichneter Zettel rückwirkend, weil in der
// Zwischenzeit neue Aufträge in den 13-Wochen-Schnitt gelaufen sind.
//
// ⚠️ **Urlaubsentgelt ist Arbeitsentgelt, aber KEINE Arbeitszeit.** Es zählt in die
// Minijob-Grenze (§ 8 SGB IV) und darf auf keinen Fall in die Mindestlohn-Rechnung:
// Geld ohne Stunden hebt dort den Schnitt und verdeckt einen Verstoß. Deshalb
// liefert diese Funktion eine eigene Liste und keine Positionen für `items`.
//
// Vergangene und künftige Urlaubstage werden getrennt — dieselbe Regel wie bei
// „geplant ≠ geleistet": Was nächste Woche ansteht, gehört nicht als Vergütung in
// ein Lohndokument und kann auch niemand abzeichnen.
function fuerPeriode(tenant, userId, periode, heuteStr = new Date().toISOString().slice(0, 10)) {
  const reqs = all(
    `SELECT * FROM vacation_requests
      WHERE tenant_id = ? AND user_id = ? AND status = 'approved'
        AND start_date <= ? AND end_date >= ?
      ORDER BY start_date`, tenant.id, userId, periode.end, periode.start);

  const posten = [];
  let entgelt = 0, geplant = 0, tage = 0, tageGeplant = 0;

  for (const r of reqs) {
    const w = werktageProWoche(r);
    const von = r.start_date > periode.start ? r.start_date : periode.start;
    const bis = r.end_date < periode.end ? r.end_date : periode.end;

    // Vergangen und künftig getrennt zählen: `heute` schneidet den Antrag ein
    // zweites Mal. Ein Urlaub, der heute läuft, ist zur Hälfte schon genommen.
    let tageVergangen = 0, tageKuenftig = 0;
    for (let d = von; d <= bis; d = plusTage(d, 1)) {
      if (!istUrlaubstag(d, tenant.region, w)) continue;
      if (d <= heuteStr) tageVergangen++; else tageKuenftig++;
    }
    if (!tageVergangen && !tageKuenftig) continue;

    const satz = r.paid ? (r.pay_per_day_cents || 0) : 0;
    const cents = Math.round(tageVergangen * satz);
    const centsGeplant = Math.round(tageKuenftig * satz);

    entgelt += cents;
    geplant += centsGeplant;
    tage += tageVergangen;
    tageGeplant += tageKuenftig;

    posten.push({
      antrag_id: r.id,
      // ⚠️ `job_id` mit Präfix: Der Signatur-Hash mischt Aufträge, Auslagen und
      // Urlaub in EINER Liste. Ohne eigenen Namensraum kollidierte Antrag 7 mit
      // Auftrag 7, und zwei verschiedene Zettel bekämen denselben Hash.
      job_id: `urlaub-${r.id}`,
      von, bis,
      date: von,
      unit: bis > von ? `Urlaub ${fmt(von)}–${fmt(bis)}` : `Urlaub ${fmt(von)}`,
      tage: tageVergangen,
      tage_geplant: tageKuenftig,
      minutes: 0,
      cents,
      cents_geplant: centsGeplant,
      pro_tag_cents: satz,
      bezahlt: !!r.paid,
      werktage: w,
    });
  }

  return {
    posten,
    entgelt_cents: entgelt,
    geplant_cents: geplant,
    tage,
    tage_geplant: tageGeplant,
    // Nur Vergangenes wandert in den Signatur-Hash — was nächste Woche ansteht,
    // kann niemand bestätigen. Gleiche Regel wie bei den Aufträgen.
    signatur_positionen: posten
      .filter(p => p.tage > 0)
      .map(p => ({ job_id: p.job_id, date: p.date, unit: p.unit, minutes: 0, cents: p.cents })),
  };
}

function fmt(d) { return `${d.slice(8, 10)}.${d.slice(5, 7)}.`; }

module.exports = {
  WERKTAGE_STANDARD, werktageProWoche,
  plusTage, istUrlaubstag, zaehleTage, zaehleTageJeJahr,
  anspruchFuerJahr, genommenJeJahr, konto,
  entgeltProTag, aktiv, imUrlaub, urlaubstageImZeitraum, fuerPeriode,
};
