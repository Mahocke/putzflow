// notify/brevo-mail.js — transaktionale Mail über Brevo.
//
// Entscheidung (25.07.2026): KEIN eigener Mailserver, KEINE fremde Mailbox anbinden.
// Versand von der eigenen Subdomain mail.putzflow.de mit SPF/DKIM/DMARC über Brevo.
// Transaktionale Templates umgehen Brevos Marketing-Preisstufe — beim Signup als
// transaktional/Utility verifizieren.

const API = 'https://api.brevo.com/v3/smtp/email';

function canReach(recipient) { return !!recipient.email; }

async function send(recipient, message) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY fehlt');

  const body = {
    sender: {
      name: process.env.NOTIFY_FROM_NAME || 'Putzflow',
      email: process.env.NOTIFY_FROM_EMAIL || 'no-reply@mail.putzflow.de',
    },
    to: [{ email: recipient.email, name: recipient.name || undefined }],
    subject: message.subject,
    textContent: message.link ? `${message.text}\n\n${message.link}\n` : message.text,
  };
  if (message.html) body.htmlContent = message.html;

  // Anhänge, z. B. die Kalendereinladung.
  // ⚠️ Brevos API nimmt nur {name, content} — der MIME-Typ lässt sich nicht setzen.
  // Die .ics kommt daher als Dateianhang an, nicht als eingebettete Einladung mit
  // Zusagen-Knopf. Für uns unerheblich: Die Zusage ist in Putzflow schon erfolgt,
  // der Anhang soll den Termin nur in den Kalender bringen. Ein Tippen darauf genügt.
  if (message.attachments && message.attachments.length) {
    body.attachment = message.attachments.map(a => ({ name: a.name, content: a.content }));
  }

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json().catch(() => ({}));
  return { id: json.messageId || null };
}

module.exports = { canReach, send };
