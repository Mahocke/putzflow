// format.js — Zahlen und Zeiträume so schreiben, wie ein Mensch sie liest.
//
// Anlass: Die erste Verlängerungsmail lautete „hat den Testzeitraum um 42 Tage
// verlängert, neu bis 2026-09-06". Beides ist maschinennah — niemand denkt in
// 42 Tagen, und ein ISO-Datum liest sich wie eine Datenbankzeile (Outlook macht
// daraus obendrein einen Link). Deshalb an EINER Stelle formatiert, damit nicht
// jede neue Mail dieselbe Entscheidung neu trifft.

const tag = iso => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');

const euro = cent => (cent / 100).toFixed(2).replace('.', ',') + ' €';

const ZAHLWORT = ['null', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben',
                  'acht', 'neun', 'zehn', 'elf', 'zwölf'];

// 42 → „sechs Wochen", 7 → „eine Woche", 10 → „10 Tage".
function dauer(tage) {
  const t = Math.round(tage);
  if (t % 7 === 0 && t > 0) {
    const w = t / 7;
    const zahl = ZAHLWORT[w] || String(w);
    return w === 1 ? 'eine Woche' : `${zahl} Wochen`;
  }
  return t === 1 ? 'einen Tag' : `${t} Tage`;
}

module.exports = { tag, euro, dauer };
