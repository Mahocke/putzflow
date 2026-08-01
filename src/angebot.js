// angebot.js — Der Moment, in dem sich der Testzeitraum entscheidet.
//
// Ein ablaufender Test ohne Ansprache endet fast immer im Nichts: Der Kunde merkt
// es am Tag danach, ärgert sich und hört auf. Deshalb geht eine Woche vor Ablauf
// eine Mail raus — und nach Ablauf noch eine, danach nichts mehr.
//
// ⚠️ KEIN Abschlussrabatt (gestrichen 26.07.2026). Er sollte die Entscheidung
// vorziehen; seit der Test ohne Verlängerung endet, ist sie ohnehin terminiert.
// Der einzige Nachlass ist die Mengenstaffel in `preis.js` — zwei Rabattsysteme
// übereinander sind der kürzeste Weg zum Preisverfall.
//
// ⚠️ Der Merker heißt bewusst NICHT „mail_gesendet", sondern trägt das Datum, FÜR
// das die Mail geschickt wurde (`entscheidung_mail_fuer`). Verschiebt sich
// `trial_ends_at` — etwa weil wir jemandem von Hand mehr Zeit geben —, passt der
// Merker nicht mehr und die Frage wird vor dem neuen Ende erneut gestellt. Ein
// boolescher Merker hätte diesen zweiten Anlauf verschluckt.

const VORLAUF_TAGE = 7;        // so früh vor Ablauf wird gefragt
const ZAHLZIEL_TAGE = 30;      // Rechnung unterwegs → so lange weiterarbeiten

const TAG = 86400000;
const alsDatum = iso => new Date(iso + 'T12:00:00Z');
const plusTage = (iso, n) => new Date(alsDatum(iso).getTime() + n * TAG).toISOString().slice(0, 10);
const tageBis = (iso, heute) => Math.round((alsDatum(iso) - alsDatum(heute)) / TAG);

/**
 * Welche Mail schuldet ein Mandant heute?
 * @returns {'entscheidung'|'ablauf'|null}
 */
function faellig(t, heute) {
  if (!t || t.is_demo || t.bestellt_am) return null;
  // Ohne bestätigte Adresse wird nicht geworben — sonst würde jedes Fantasiekonto
  // aus dem Anmeldeformular zweimal angeschrieben.
  if (!t.email_verified_at || !t.trial_ends_at) return null;
  if (t.paid_until && t.paid_until >= heute) return null;

  const rest = tageBis(t.trial_ends_at, heute);
  if (rest >= 0 && rest <= VORLAUF_TAGE) {
    return t.entscheidung_mail_fuer === t.trial_ends_at ? null : 'entscheidung';
  }
  if (rest < 0) {
    return t.ablauf_mail_fuer === t.trial_ends_at ? null : 'ablauf';
  }
  return null;
}

module.exports = { VORLAUF_TAGE, ZAHLZIEL_TAGE, faellig, plusTage, tageBis };
