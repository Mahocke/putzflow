// Der SMTP-Kanal — und vor allem die Falle daneben.
//
// ⚠️ Hier wird NICHT wirklich verschickt. Getestet wird, was ohne Server
// entscheidbar ist: Wann meldet sich der Kanal als erreichbar, wie wird eine
// Kalendereinladung zerlegt, und was passiert, wenn zwei Mailkanäle gleichzeitig
// aktiv sind.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-smtp-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const smtp = require('../src/notify/smtp');
const notify = require('../src/notify');
const ics = require('../src/ics');

function mit(env, fn) {
  const vorher = { ...process.env };
  Object.assign(process.env, env);
  try { fn(); } finally { process.env = vorher; }
}

test('⚠️ ohne SMTP_HOST meldet der Kanal sich NICHT als erreichbar', () => {
  // Sonst gewänne er in pickChannel gegen einen funktionierenden Brevo-Kanal,
  // nur weil er in NOTIFY_CHANNELS weiter vorn steht — und jede Mail schlüge fehl.
  mit({ SMTP_HOST: '' }, () => {
    assert.equal(smtp.canReach({ email: 'a@b.de' }), false);
  });
  mit({ SMTP_HOST: 'mail.example.net' }, () => {
    assert.equal(smtp.canReach({ email: 'a@b.de' }), true);
    assert.equal(smtp.canReach({ phone: '+49...' }), false, 'ohne Adresse geht nichts');
  });
});

test('465 spricht sofort TLS, 587 beginnt im Klartext', () => {
  mit({ SMTP_HOST: 'mail.example.net', SMTP_PORT: '465', SMTP_SECURE: '' }, () => {
    assert.equal(smtp.konfiguration().secure, true);
  });
  mit({ SMTP_HOST: 'mail.example.net', SMTP_PORT: '587', SMTP_SECURE: '' }, () => {
    assert.equal(smtp.konfiguration().secure, false);
  });
  mit({ SMTP_HOST: 'mail.example.net', SMTP_PORT: '587', SMTP_SECURE: 'ja' }, () => {
    assert.equal(smtp.konfiguration().secure, true, 'von Hand übersteuerbar');
  });
});

test('ohne Benutzernamen wird nicht angemeldet', () => {
  // Ein lokaler Relay im selben Netz verlangt oft keine Anmeldung. Ein leeres
  // auth-Objekt ließe nodemailer trotzdem AUTH versuchen — und der Server
  // antwortete mit einem Fehler, der nach falschem Passwort aussieht.
  mit({ SMTP_HOST: 'localhost', SMTP_USER: '', SMTP_PASS: '' }, () => {
    assert.equal(smtp.konfiguration().auth, undefined);
  });
});

test('die .ics wird zur echten Einladung, nicht zum Anhang', () => {
  // ⚠️ Das ist der fachliche Gewinn gegenüber Brevo: Dessen API kann den
  // MIME-Typ eines Anhangs nicht setzen, die Einladung kommt als Datei an.
  const text = ics.buildEvent({
    jobId: 1, userId: 2, summary: 'Reinigung Wohnung 1',
    date: '2026-08-01', method: 'REQUEST',
    organizerEmail: 'no-reply@example.de',
    attendeeName: 'Anna Muster', attendeeEmail: 'anna@example.de',
  });
  const { dateien, einladung } = smtp.zerlegeAnhaenge([
    ics.asAttachment(text, 'REQUEST'),
    { name: 'stundenzettel.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4').toString('base64') },
  ]);
  assert.equal(einladung.method, 'request');
  assert.match(einladung.content, /^BEGIN:VCALENDAR/);
  assert.equal(einladung.filename, 'termin.ics');
  assert.equal(dateien.length, 1, 'das PDF bleibt ein gewöhnlicher Anhang');
  assert.equal(dateien[0].filename, 'stundenzettel.pdf');
  assert.equal(dateien[0].encoding, 'base64');
});

test('CANCEL bleibt CANCEL', () => {
  // Eine Absage mit method=REQUEST würde den Termin im Kalender neu anlegen
  // statt ihn zu entfernen.
  const { einladung } = smtp.zerlegeAnhaenge([{
    name: 'termin.ics',
    contentType: 'text/calendar; charset=utf-8; method=CANCEL',
    content: Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n').toString('base64'),
  }]);
  assert.equal(einladung.method, 'cancel');
});

test('bei zwei Mailkanälen wird gesagt, welcher vorn steht', () => {
  // Beide erreichen dieselbe Adresse; der vordere verschickt, der hintere fängt
  // auf. Wer SMTP einträgt und weiter über Brevo verschickt, sucht sonst lange.
  mit({ NOTIFY_CHANNELS: 'mail,smtp' }, () => {
    const h = notify.pruefeKanaele();
    assert.equal(h.length, 1);
    assert.match(h[0], /über „mail"/);
  });
  mit({ NOTIFY_CHANNELS: 'smtp' }, () => {
    assert.deepEqual(notify.pruefeKanaele(), []);
  });
  mit({ NOTIFY_CHANNELS: 'unfug' }, () => {
    assert.match(notify.pruefeKanaele()[0], /gar nichts zugestellt/);
  });
});

test('die Reihenfolge in NOTIFY_CHANNELS entscheidet', () => {
  mit({ NOTIFY_CHANNELS: 'smtp,mail', SMTP_HOST: 'mail.example.net' }, () => {
    assert.equal(notify.pickChannel({ email: 'a@b.de' }), 'smtp');
  });
  mit({ NOTIFY_CHANNELS: 'mail,smtp', SMTP_HOST: 'mail.example.net' }, () => {
    assert.equal(notify.pickChannel({ email: 'a@b.de' }), 'mail');
  });
  // Und ohne SMTP-Konfiguration fällt es auf Brevo zurück, statt zu scheitern.
  mit({ NOTIFY_CHANNELS: 'smtp,mail', SMTP_HOST: '' }, () => {
    assert.equal(notify.pickChannel({ email: 'a@b.de' }), 'mail');
  });
});
