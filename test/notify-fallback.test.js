// Fällt ein Mailweg aus, muss der nächste übernehmen.
//
// ⚠️ Das war bis zum 27.07.2026 NICHT so, sah aber so aus: Bei
// `NOTIFY_CHANNELS=smtp,mail` kam der zweite Kanal nur zum Zug, wenn der erste
// den Empfänger gar nicht erreichen KONNTE — nicht, wenn er beim Senden ausfiel.
// Ein schweigender Mailserver hätte also stillschweigend Terminanfragen
// verschluckt, obwohl ein funktionierender Weg danebenlag.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-fallback-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const notify = require('../src/notify');

// Die echten Kanäle beiseitelegen und durch Attrappen ersetzen: Hier wird der
// Ablauf getestet, nicht Brevo oder nodemailer.
const echte = { ...notify.CHANNELS };
function mitKanaelen(def, liste, fn) {
  const vorher = { ...process.env };
  const gesehen = [];
  for (const [name, verhalten] of Object.entries(def)) {
    notify.CHANNELS[name] = {
      canReach: r => verhalten.erreicht !== false && !!r.email,
      async send() {
        gesehen.push(name);
        if (verhalten.faellt) throw new Error(`${name} antwortet nicht`);
        return { id: `${name}-1` };
      },
    };
  }
  process.env.NOTIFY_CHANNELS = liste;
  process.env.NOTIFY_REDIRECT_TO = '';
  return Promise.resolve(fn(gesehen)).finally(() => {
    Object.assign(notify.CHANNELS, echte);
    for (const name of Object.keys(def)) if (!echte[name]) delete notify.CHANNELS[name];
    process.env = vorher;
  });
}

test('der erste Kanal genügt — der zweite wird nicht angefasst', async () => {
  await mitKanaelen({ smtp: {}, mail: {} }, 'smtp,mail', async gesehen => {
    const r = await notify.send({ name: 'Anna', email: 'a@b.de' }, { subject: 'Test', text: '.' });
    assert.equal(r.ok, true);
    assert.equal(r.channel, 'smtp');
    assert.equal(r.ausgewichen, false);
    assert.deepEqual(gesehen, ['smtp'], 'kein doppelter Versand im Normalfall');
  });
});

test('fällt der erste aus, übernimmt der zweite', async () => {
  await mitKanaelen({ smtp: { faellt: true }, mail: {} }, 'smtp,mail', async gesehen => {
    const r = await notify.send({ name: 'Anna', email: 'a@b.de' }, { subject: 'Test', text: '.' });
    assert.equal(r.ok, true, 'die Nachricht geht raus');
    assert.equal(r.channel, 'mail');
    assert.equal(r.ausgewichen, true, 'und es ist erkennbar, dass ausgewichen wurde');
    assert.deepEqual(gesehen, ['smtp', 'mail']);
  });
});

test('fallen alle aus, wird das gemeldet — mit allen Gründen', async () => {
  // Eine Fehlermeldung, die nur den letzten Versuch nennt, schickt bei der
  // Fehlersuche in die falsche Richtung.
  await mitKanaelen({ smtp: { faellt: true }, mail: { faellt: true } }, 'smtp,mail', async () => {
    const r = await notify.send({ name: 'Anna', email: 'a@b.de' }, { subject: 'Test', text: '.' });
    assert.equal(r.ok, false);
    assert.match(r.error, /smtp: smtp antwortet nicht/);
    assert.match(r.error, /mail: mail antwortet nicht/);
  });
});

test('ein Kanal, der den Empfänger nicht erreicht, zählt nicht als Versuch', async () => {
  // Ohne SMTP_HOST meldet der SMTP-Kanal canReach() = false. Er darf dann weder
  // den Versand aufhalten noch als Fehlschlag im Protokoll stehen.
  await mitKanaelen({ smtp: { erreicht: false }, mail: {} }, 'smtp,mail', async gesehen => {
    const r = await notify.send({ name: 'Anna', email: 'a@b.de' }, { subject: 'Test', text: '.' });
    assert.equal(r.ok, true);
    assert.equal(r.channel, 'mail');
    assert.equal(r.ausgewichen, false, 'kein Ausweichen — der Kanal stand nie zur Wahl');
    assert.deepEqual(gesehen, ['mail']);
  });
});

test('⚠️ „channel: mail" meint das Medium, nicht den Anbieter', async () => {
  // An sieben Stellen im Code steht `channel: 'mail'` — gemeint war immer „per
  // Mail statt auf die Konsole". Schlüge dieser Wunsch die Reihenfolge, ginge
  // bei NOTIFY_CHANNELS=smtp,mail weiterhin JEDE Mail über Brevos API, während
  // der Start „verschickt wird über smtp" meldet. Ein wirkungsloser Wechsel mit
  // einer Anzeige, die das Gegenteil behauptet.
  await mitKanaelen({ smtp: {}, mail: {} }, 'smtp,mail', async gesehen => {
    const r = await notify.send({ name: 'Anna', email: 'a@b.de', channel: 'mail' },
                                { subject: 'Test', text: '.' });
    assert.equal(r.channel, 'smtp', 'NOTIFY_CHANNELS entscheidet, nicht der Wunsch');
    assert.deepEqual(gesehen, ['smtp']);
  });
});

test('ein Wunsch nach einem anderen MEDIUM steht dagegen vorn', async () => {
  await mitKanaelen({ smtp: {}, console: {} }, 'smtp,console', async gesehen => {
    const r = await notify.send({ name: 'Anna', email: 'a@b.de', channel: 'console' },
                                { subject: 'Test', text: '.' });
    assert.equal(r.channel, 'console');
    assert.deepEqual(gesehen, ['console'], 'erst der Wunsch, der Rest bliebe als Netz');
  });
});

test('beim Start wird gesagt, welcher Mailweg vorn steht', async () => {
  await mitKanaelen({ smtp: {}, mail: {} }, 'smtp,mail', async () => {
    const h = notify.pruefeKanaele();
    assert.equal(h.length, 1);
    assert.match(h[0], /über „smtp"/);
    assert.match(h[0], /„mail" fängt auf/);
  });
});
