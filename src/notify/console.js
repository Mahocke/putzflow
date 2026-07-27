// notify/console.js — Entwicklungs-Kanal: schreibt die Nachricht ins Log statt sie zu senden.
// Damit lässt sich der komplette Magic-Link-Ablauf ohne Brevo-Konto durchspielen.

function canReach() { return true; }

async function send(recipient, message) {
  const to = recipient.email || recipient.phone || recipient.name || '?';
  console.log(`[notify:console] an ${to} — ${message.subject}`);
  if (message.text) console.log(message.text.split('\n').map(l => '    ' + l).join('\n'));
  if (message.link) console.log(`    → ${message.link}`);
  for (const a of message.attachments || []) console.log(`    📎 ${a.name} (${a.contentType || 'Datei'})`);
  return { id: 'console' };
}

module.exports = { canReach, send };
