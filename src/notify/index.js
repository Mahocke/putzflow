// notify/index.js — Zustellung ist pluggable (NotificationChannel).
//
// Der Magic-Link-Kern ist kanal-agnostisch: eine Nachricht ist immer
// { to, subject, text, link }. Ob das per Mail oder (in Entwicklung) nur auf der
// Konsole landet, entscheidet der Kanal — nicht die Fachlogik.

const { run, get } = require('../db');

// Die Abstraktion bleibt bewusst bestehen, auch wenn es derzeit nur zwei Kanäle gibt:
// Der Magic-Link-Kern soll nichts über den Zustellweg wissen. WhatsApp wurde am
// 26.07.2026 gestrichen (Vorlaufzeit bei Meta, laufende Kosten je Nachricht) —
// ein neuer Kanal wäre eine Datei mit canReach() und send().
const CHANNELS = {
  console: require('./console'),
  mail: require('./brevo-mail'),
  smtp: require('./smtp'),
};

function configured() {
  return String(process.env.NOTIFY_CHANNELS || 'console')
    .split(',').map(s => s.trim()).filter(s => CHANNELS[s]);
}

// `mail` und `smtp` gleichzeitig ist der EMPFOHLENE Betrieb: der erste
// verschickt, der zweite fängt auf. Trotzdem beim Start einmal sagen, welcher
// gerade vorn steht — sonst trägt jemand SMTP ein, verschickt weiter über Brevo
// und sucht lange nach dem Grund.
function pruefeKanaele() {
  const aktiv = configured();
  const hinweise = [];
  const mailkanaele = aktiv.filter(c => c === 'mail' || c === 'smtp');
  if (mailkanaele.length > 1) {
    hinweise.push(`Mailkanäle: verschickt wird über „${mailkanaele[0]}", `
                + `„${mailkanaele[1]}" fängt auf, wenn das fehlschlägt. `
                + `Zum Tauschen die Reihenfolge in NOTIFY_CHANNELS ändern.`);
  }
  if (!aktiv.length) {
    hinweise.push('NOTIFY_CHANNELS ist leer oder nennt nur unbekannte Kanäle — '
                + 'es wird gar nichts zugestellt.');
  }
  return hinweise;
}

// ⚠️ `mail` und `smtp` sind ZWEI WEGE FÜR DASSELBE MEDIUM, nicht zwei Medien.
// Der Wunsch „schick das per Mail" darf deshalb nicht zugleich den Anbieter
// festlegen. Am 27.07.2026 beim Umstellen auf SMTP aufgefallen: An sieben
// Stellen steht `channel: 'mail'` — gemeint war immer „per Mail, nicht auf die
// Konsole". Weil der Wunsch die Reihenfolge schlug, wäre bei
// NOTIFY_CHANNELS=smtp,mail weiterhin JEDE Mail über Brevos API gegangen,
// während das Startprotokoll „verschickt wird über smtp" meldete. Ein
// Konfigurationswechsel ohne Wirkung, mit einer Anzeige, die das Gegenteil sagt.
const MAILWEGE = new Set(['mail', 'smtp']);

// Alle Kanäle, die diesen Empfänger erreichen können — in der Reihenfolge, in
// der sie versucht werden. Der Wunsch des Empfängers zuerst, sofern er ein
// anderes MEDIUM meint; innerhalb der Mailwege entscheidet NOTIFY_CHANNELS.
function channelsFor(recipient) {
  const avail = configured();
  const want = recipient.channel;
  const ordered = want && avail.includes(want) && !MAILWEGE.has(want)
    ? [want, ...avail.filter(c => c !== want)]
    : avail;
  return ordered.filter(name => CHANNELS[name].canReach(recipient));
}

// Der Kanal, über den verschickt WÜRDE. Für Anzeige und Tests.
function pickChannel(recipient) {
  return channelsFor(recipient)[0] || null;
}

// recipient: { name, email, phone, channel }
async function send(recipient, message, tenantId = null) {
  // ⚠️ Aus dem Demo-Mandanten geht NIE eine echte Mail raus. Er ist öffentlich:
  // Wer dort hineinkommt, kann bei einer Kraft eine beliebige Adresse eintragen
  // und sich von Putzflow eine Mail dorthin schicken lassen — ein offenes
  // Mailrelais. Der Lohnversand war deshalb schon über `keineDemo` gesperrt,
  // Terminanfragen und Rundruf waren es nicht. Der Riegel gehört hierher und
  // nicht an einzelne Routen: Sonst muss man ihn bei jeder neuen Route erneut
  // bedenken, und genau das geht einmal schief.
  if (tenantId && istDemo(tenantId)) {
    log(tenantId, 'console', recipient.email || recipient.phone, message.subject, 'demo', null);
    await CHANNELS.console.send(recipient, message);
    return { ok: true, channel: 'console', demo: true };
  }

  const redirect = (process.env.NOTIFY_REDIRECT_TO || '').trim();
  const target = redirect ? { ...recipient, email: redirect, channel: 'mail' } : recipient;

  const kanaele = channelsFor(target);
  if (!kanaele.length) {
    log(tenantId, 'none', target.email || target.phone, message.subject, 'failed', 'kein erreichbarer Kanal');
    return { ok: false, error: 'kein erreichbarer Kanal' };
  }

  // ⚠️ Schlägt ein Kanal beim Senden fehl, wird der NÄCHSTE versucht. Vorher gab
  // es einen Versuch und danach nichts — bei `NOTIFY_CHANNELS=smtp,mail` sah das
  // aus wie ein Netz, war aber keins: Der zweite Kanal kam nur zum Zug, wenn der
  // erste den Empfänger gar nicht erreichen KONNTE, nicht wenn er ausfiel.
  //
  // ⚠️ Das nimmt eine doppelte Zustellung in Kauf: Bricht die Verbindung ab,
  // NACHDEM der Server die Mail angenommen hat, geht sie zweimal raus. Bewusst
  // so entschieden — Putzflows ganze Begründung ist, dass eine Reinigung
  // untergeht, wenn niemand die Nachricht liest. Eine Terminanfrage doppelt ist
  // ein Ärgernis, eine ausgefallene Reinigung ein Schaden.
  const fehler = [];
  for (const name of kanaele) {
    try {
      const res = await CHANNELS[name].send(target, message);
      log(tenantId, name, target.email || target.phone, message.subject,
          redirect ? 'redirected' : 'sent', fehler.length ? `nach Ausweichen: ${fehler.join('; ')}` : null);
      if (fehler.length) console.warn(`[notify] über „${name}" verschickt, nachdem ${fehler.join('; ')}`);
      return { ok: true, channel: name, ausgewichen: fehler.length > 0, ...res };
    } catch (e) {
      const grund = `${name}: ${String(e.message || e)}`;
      fehler.push(grund);
      log(tenantId, name, target.email || target.phone, message.subject, 'failed', String(e.message || e));
    }
  }
  return { ok: false, channel: kanaele[0], error: fehler.join('; ') };
}

// Klein gehalten und gekapselt: ein fehlender Mandant darf den Versand nicht
// kippen, aber im Zweifel wird NICHT verschickt.
function istDemo(tenantId) {
  try {
    const t = get(`SELECT is_demo FROM tenants WHERE id = ?`, tenantId);
    return t ? !!t.is_demo : false;
  } catch { return false; }
}

function log(tenantId, channel, recipient, subject, status, error) {
  try {
    run(`INSERT INTO notify_log(tenant_id, channel, recipient, subject, status, error)
         VALUES(?, ?, ?, ?, ?, ?)`, tenantId, channel, recipient || null, subject || null, status, error);
  } catch { /* Logging darf den Versand nie kippen */ }
}

module.exports = { send, configured, pickChannel, channelsFor, pruefeKanaele, CHANNELS };
