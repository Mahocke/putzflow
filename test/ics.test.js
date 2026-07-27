// Tests der Kalendereinladung. Ausführen: npm test

const test = require('node:test');
const assert = require('node:assert');
const { buildEvent, asAttachment, uidFor, esc, fold } = require('../src/ics');

const BASIS = {
  jobId: 42, userId: 7, date: '2026-07-26',
  summary: 'Reinigung Ferienwohnung Altstadt',
  organizerEmail: 'no-reply@mail.putzflow.de',
  attendeeEmail: 'marina@example.org', attendeeName: 'Marina Kessler',
  now: new Date('2026-07-20T08:00:00Z'), sequence: 1,
};

test('REQUEST enthält die Pflichtfelder', () => {
  const s = buildEvent({ ...BASIS, method: 'REQUEST' });
  assert.match(s, /BEGIN:VCALENDAR/);
  assert.match(s, /METHOD:REQUEST/);
  assert.match(s, /STATUS:CONFIRMED/);
  assert.match(s, /UID:pf-job-42-user-7@putzflow\.de/);
  assert.match(s, /SUMMARY:Reinigung Ferienwohnung Altstadt/);
  assert.match(s, /END:VCALENDAR/);
});

test('Ganztägig: DTSTART als Datum, DTEND am Folgetag', () => {
  const s = buildEvent({ ...BASIS, method: 'REQUEST' });
  assert.match(s, /DTSTART;VALUE=DATE:20260726/);
  assert.match(s, /DTEND;VALUE=DATE:20260727/, 'ganztägig endet am Folgetag');
});

test('Monatswechsel beim Folgetag', () => {
  const s = buildEvent({ ...BASIS, method: 'REQUEST', date: '2026-07-31' });
  assert.match(s, /DTEND;VALUE=DATE:20260801/);
});

test('CANCEL kehrt Status und Teilnahme um', () => {
  const s = buildEvent({ ...BASIS, method: 'CANCEL' });
  assert.match(s, /METHOD:CANCEL/);
  assert.match(s, /STATUS:CANCELLED/);
  assert.match(s, /PARTSTAT=DECLINED/);
});

test('UID ist deterministisch — Absage trifft denselben Termin', () => {
  const a = buildEvent({ ...BASIS, method: 'REQUEST' });
  const b = buildEvent({ ...BASIS, method: 'CANCEL', sequence: 2 });
  const uid = s => s.match(/UID:(\S+)/)[1];
  assert.equal(uid(a), uid(b));
});

test('SEQUENCE wächst, sonst ignorieren Kalender die Änderung', () => {
  const a = buildEvent({ ...BASIS, method: 'REQUEST', sequence: 5 });
  const b = buildEvent({ ...BASIS, method: 'CANCEL', sequence: 6 });
  assert.ok(Number(b.match(/SEQUENCE:(\d+)/)[1]) > Number(a.match(/SEQUENCE:(\d+)/)[1]));
});

test('Sonderzeichen werden maskiert (RFC 5545)', () => {
  assert.equal(esc('Lange Str. 54, 3. OG; hinten'), 'Lange Str. 54\\, 3. OG\\; hinten');
  assert.equal(esc('Zeile1\nZeile2'), 'Zeile1\\nZeile2');
  assert.equal(esc('a\\b'), 'a\\\\b');
  const s = buildEvent({ ...BASIS, method: 'REQUEST', location: 'Lange Str. 54, hinten' });
  assert.match(s, /LOCATION:Lange Str\. 54\\, hinten/);
});

test('Lange Zeilen werden gefaltet', () => {
  const lang = 'x'.repeat(200);
  const gefaltet = fold('SUMMARY:' + lang);
  for (const zeile of gefaltet.split('\r\n')) {
    assert.ok(zeile.length <= 71, `Zeile zu lang: ${zeile.length}`);
  }
  assert.ok(gefaltet.includes('\r\n '), 'Fortsetzungszeilen beginnen mit Leerzeichen');
});

test('Zeilen enden mit CRLF', () => {
  const s = buildEvent({ ...BASIS, method: 'REQUEST' });
  assert.ok(s.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(s), 'kein nacktes LF');
});

test('Anhang trägt die Methode im MIME-Typ', () => {
  const a = asAttachment(buildEvent({ ...BASIS, method: 'CANCEL' }), 'CANCEL');
  assert.equal(a.name, 'termin.ics');
  assert.match(a.contentType, /method=CANCEL/);
  assert.match(Buffer.from(a.content, 'base64').toString('utf8'), /METHOD:CANCEL/);
});

test('uidFor bindet Job UND Person', () => {
  assert.notEqual(uidFor(1, 2), uidFor(1, 3), 'zwei Kräfte am selben Job = zwei Termine');
  assert.notEqual(uidFor(1, 2), uidFor(2, 2));
});
