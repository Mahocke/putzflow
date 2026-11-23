// anmeldebremse.js — begrenzt FEHLGESCHLAGENE Passwort-Anmeldungen.
//
// Bis zum 23.11.2026 zählte /api/login als einziger öffentlicher Endpunkt keine
// Versuche: 40 falsche Passwörter in gut einer Sekunde liefen ohne jede Sperre
// durch. Gezählt werden nur Fehlschläge — wer sich einmal vertippt und dann
// richtig anmeldet, merkt von der Bremse nichts, und ein Erfolg setzt den Zähler
// für diese Adresse zurück.
//
// Zwei Schlüssel, weil sie Verschiedenes abwehren:
//   je IP-Adresse  — einer probiert viele Passwörter (streng)
//   je Konto       — viele Adressen probieren dasselbe Konto (großzügiger, damit
//                    ein Fremder die Chefin nicht mit wenigen Versuchen aussperrt)
// Der Zustand liegt im Speicher. Nach einem Neustart beginnt er von vorn — für
// eine Bremse reicht das; sie soll Durchprobieren unwirtschaftlich machen, nicht
// ein Protokoll führen.

const FENSTER_MS = 15 * 60_000;

function anmeldeBremse({ jeIp = 10, jeKonto = 30, fensterMs = FENSTER_MS } = {}) {
  const fehl = new Map();

  const frisch = schluessel => {
    const jetzt = Date.now();
    const liste = (fehl.get(schluessel) || []).filter(t => jetzt - t < fensterMs);
    if (liste.length) fehl.set(schluessel, liste); else fehl.delete(schluessel);
    return liste;
  };

  // Gelegentlich alles Abgelaufene wegräumen, damit die Karte bei vielen
  // verschiedenen Adressen nicht unbegrenzt wächst.
  const aufraeumen = () => { if (fehl.size > 5000) for (const k of [...fehl.keys()]) frisch(k); };

  const schluessel = (ip, konto) => [`ip:${ip}`, `konto:${String(konto || '').toLowerCase()}`];

  return {
    // true = gesperrt; dann gar nicht erst das Passwort prüfen.
    gesperrt(ip, konto) {
      const [a, b] = schluessel(ip, konto);
      return frisch(a).length >= jeIp || (konto ? frisch(b).length >= jeKonto : false);
    },
    fehlschlag(ip, konto) {
      aufraeumen();
      const jetzt = Date.now();
      const [a, b] = schluessel(ip, konto);
      for (const k of konto ? [a, b] : [a]) {
        const l = frisch(k); l.push(jetzt); fehl.set(k, l);
      }
    },
    erfolg(ip) { fehl.delete(`ip:${ip}`); },
  };
}

const MELDUNG = 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.';

module.exports = { anmeldeBremse, MELDUNG };
