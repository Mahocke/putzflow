// preis.js — was ein Mandant kostet.
//
// Ein Satz, ein Mindestbetrag, fertig (Stand 26.07.2026):
//
//   4,00 € je Unterkunft und Monat, netto
//   mindestens 20,00 € im Monat
//   jährlich im Voraus = ZEHN Monatsbeträge (zwei Monate geschenkt)
//
// Vorher gab es eine Mengenstaffel (5,00 / 4,50 / 4,00 €). Die ist gestrichen, weil
// sie sich nicht erklären ließ: „ab 20 Unterkünften · 4,00 €" wurde prompt als
// „20 € Mindestbetrag" gelesen. Ein Preis, den man beim Überfliegen falsch versteht,
// ist ein schlechter Preis — auch wenn er rechnerisch stimmt.
//
// Der Mindestbetrag ist kein Ertragsbringer, sondern eine Grenze: Er greift erst
// unter fünf Unterkünften, also genau dort, wo wir ohnehin nicht hinwollen. Eine
// Rechnung schreiben und Support leisten kostet mehr, als ein Zwei-Wohnungen-Kunde
// im Jahr zahlen würde.
//
// ⚠️ Kein zweiter Nachlass daneben. Der frühere 20-%-Abschlussrabatt wurde am
// 26.07.2026 gestrichen; zwei Preisnachlässe übereinander sind der kürzeste Weg
// zum Preisverfall.

const SATZ_MONAT_CENT = 400;          // je Unterkunft und Monat
const MINDEST_MONAT_CENT = 2000;      // Mindestbetrag im Monat
const MONATE_IM_JAHRESPREIS = 10;     // jährlich = zehn Monatsbeträge

/**
 * Gesamtpreis je Monat in Cent — nie unter dem Mindestbetrag.
 * Der Mindestbetrag gilt auch bei null Unterkünften: Wer bestellt hat, ist Kunde,
 * und eine Rechnung über 0,00 € wäre Unfug.
 */
function monatCent(einheiten) {
  const n = Math.max(0, einheiten | 0);
  return Math.max(MINDEST_MONAT_CENT, n * SATZ_MONAT_CENT);
}

const jahrCent = einheiten => monatCent(einheiten) * MONATE_IM_JAHRESPREIS;

/** Ab wie vielen Unterkünften der Satz den Mindestbetrag übersteigt. */
const MINDEST_AB_EINHEITEN = Math.ceil(MINDEST_MONAT_CENT / SATZ_MONAT_CENT);

/** Alles, was Oberfläche, Angebot und Rechnung über den Preis wissen müssen. */
function fuer(einheiten) {
  const n = Math.max(0, einheiten | 0);
  const monat = monatCent(n);
  return {
    einheiten: n,
    satz_monat_cent: SATZ_MONAT_CENT,
    mindest_monat_cent: MINDEST_MONAT_CENT,
    // Zahlt dieser Kunde den Mindestbetrag statt nach Unterkünften?
    mindest_greift: n * SATZ_MONAT_CENT < MINDEST_MONAT_CENT,
    mindest_ab_einheiten: MINDEST_AB_EINHEITEN,
    monat_cent: monat,
    jahr_cent: monat * MONATE_IM_JAHRESPREIS,
    // Was die jährliche Zahlung gegenüber zwölf Monatsraten spart.
    ersparnis_jahr_cent: monat * (12 - MONATE_IM_JAHRESPREIS),
    monate_im_jahrespreis: MONATE_IM_JAHRESPREIS,
  };
}

module.exports = {
  SATZ_MONAT_CENT, MINDEST_MONAT_CENT, MONATE_IM_JAHRESPREIS, MINDEST_AB_EINHEITEN,
  monatCent, jahrCent, fuer,
};
