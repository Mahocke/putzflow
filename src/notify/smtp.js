// notify/smtp.js — Mailversand über einen beliebigen SMTP-Server.
//
// Zusätzlich zu Brevo, nicht statt Brevo (`NOTIFY_CHANNELS` entscheidet). Drei
// Gründe, und der dritte ist der eigentliche:
//
//  1. **Wer Putzflow selbst betreibt, braucht kein Brevo-Konto.** Bis zu diesem
//     Kanal war die Einladung zum Selbstbetrieb halbherzig: „Betreib es selbst —
//     aber Mail nur über meinen Anbieter." Eigener Server, Postmark, Mailgun,
//     Resend, die Mailbox des Hosters: alle sprechen SMTP.
//  2. **Die Kalendereinladung wird eine echte.** Brevos API kann den MIME-Typ
//     eines Anhangs nicht setzen, die .ics kommt als Datei an. Über SMTP geht
//     `text/calendar; method=REQUEST` korrekt — Outlook und Apple Mail zeigen
//     dann eine Einladung mit Zusagen-Knopf statt eines Anhangs.
//  3. **Kein Lock-in.** Gratistarife sterben nicht aus, sie rotieren: SendGrid
//     hat seinen 2025 abgeschafft, Mandrill ist praktisch raus, dafür kam Resend
//     dazu. Wer 2020 auf SendGrid setzte, musste 2025 wechseln. Mit SMTP ist so
//     ein Wechsel eine `.env`-Änderung statt einer Code-Änderung.
//
// ⚠️ NICHT über ein Freemail-Konto versenden (web.de, GMX, Gmail, Yahoo), auch
// wenn es technisch geht. Ein Rundruf an sieben Kräfte sind sieben fast gleiche
// Mails mit Links binnen Sekunden — genau das Muster, das ein Freemail-Anbieter
// als Missbrauch wertet. Dazu: Absender wäre eine Privatadresse, eigenes
// SPF/DKIM unmöglich, und vor allem **kein Bounce-Handling**. Landet eine
// Terminanfrage im Spam, merkt es niemand, und die Reinigung fällt aus.
//
// ⚠️ Microsoft 365 hat ein Verfallsdatum: Basic Auth für SMTP AUTH wird Ende
// Dezember 2026 bei bestehenden Tenants standardmäßig abgeschaltet (neue sofort),
// danach nur noch OAuth 2.0. Wer dort heute Benutzername und Passwort einträgt,
// baut etwas, das in Monaten stillsteht.

const nodemailer = require('nodemailer');

let transport = null;
let transportFuer = null;                 // Merkmal der Konfiguration, aus der er entstand

function konfiguration() {
  const host = (process.env.SMTP_HOST || '').trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';
  // ⚠️ Port 465 spricht von der ersten Sekunde an TLS, 587 beginnt im Klartext
  // und schaltet per STARTTLS um. Wer das verwechselt, bekommt keinen Fehler,
  // sondern eine Verbindung, die einfach hängt, bis der Timeout zuschlägt.
  const secure = process.env.SMTP_SECURE
    ? /^(1|true|ja|yes)$/i.test(String(process.env.SMTP_SECURE).trim())
    : port === 465;
  return { host, port, secure, auth: user ? { user, pass } : undefined };
}

function transporter() {
  const k = konfiguration();
  if (!k) throw new Error('SMTP_HOST fehlt');
  const merkmal = JSON.stringify(k);
  if (!transport || transportFuer !== merkmal) {
    // pool: eine Verbindung für mehrere Mails. Ein Rundruf sind sieben Mails in
    // Folge — ohne Pool wären das sieben Anmeldungen am Server, und manche
    // Anbieter werten genau das als Missbrauch.
    transport = nodemailer.createTransport({ ...k, pool: true, maxConnections: 2 });
    transportFuer = merkmal;
  }
  return transport;
}

// ⚠️ Ohne SMTP_HOST meldet der Kanal sich NICHT als erreichbar. Sonst gewänne er
// in `pickChannel` gegen einen funktionierenden Brevo-Kanal, nur weil er in
// NOTIFY_CHANNELS weiter vorn steht — und jede Mail schlüge fehl.
function canReach(recipient) {
  return !!recipient.email && !!konfiguration();
}

// Nodemailer verlangt bei einer Einladung eine eigene Struktur: `icalEvent`
// erzeugt ein multipart/alternative mit `method=REQUEST` im MIME-Typ. Als
// gewöhnlicher Anhang wäre die .ics wieder nur eine Datei — dann hätten wir
// Brevos Einschränkung nachgebaut, statt sie loszuwerden.
function zerlegeAnhaenge(attachments = []) {
  const dateien = [];
  let einladung = null;
  for (const a of attachments) {
    const typ = String(a.contentType || '');
    if (/^text\/calendar/i.test(typ) && !einladung) {
      const method = (typ.match(/method=([A-Za-z]+)/) || [, 'REQUEST'])[1].toLowerCase();
      einladung = {
        method,
        filename: a.name || 'termin.ics',
        content: Buffer.from(a.content, 'base64').toString('utf8'),
      };
      continue;
    }
    dateien.push({
      filename: a.name,
      content: a.content,
      encoding: 'base64',
      contentType: a.contentType || undefined,
    });
  }
  return { dateien, einladung };
}

async function send(recipient, message) {
  const von = {
    name: process.env.NOTIFY_FROM_NAME || 'Putzflow',
    address: process.env.SMTP_FROM || process.env.NOTIFY_FROM_EMAIL || process.env.SMTP_USER,
  };
  if (!von.address) throw new Error('NOTIFY_FROM_EMAIL fehlt');

  const { dateien, einladung } = zerlegeAnhaenge(message.attachments);
  const info = await transporter().sendMail({
    from: von,
    to: recipient.name ? { name: recipient.name, address: recipient.email } : recipient.email,
    subject: message.subject,
    text: message.link ? `${message.text}\n\n${message.link}\n` : message.text,
    html: message.html || undefined,
    attachments: dateien.length ? dateien : undefined,
    icalEvent: einladung || undefined,
  });
  return { id: info.messageId || null };
}

// Beim Start einmal anklopfen. Ein falsches Passwort oder ein blockierter Port
// fällt sonst erst auf, wenn die erste Terminanfrage nicht ankommt — und das
// merkt niemand, weil eine ausbleibende Mail nach nichts aussieht.
async function pruefen() {
  if (!konfiguration()) throw new Error('SMTP_HOST fehlt');
  await transporter().verify();
  return true;
}

module.exports = { canReach, send, pruefen, konfiguration, zerlegeAnhaenge };
