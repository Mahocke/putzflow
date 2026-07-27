// Tests der Terminzeiten. Ausführen: npm test

const test = require('node:test');
const assert = require('node:assert');
const { parseHHMM, formatHHMM, localToUtc, icsStamp, naechsterSlot } = require('../src/zeit');
const { buildEvent } = require('../src/ics');

test('HH:MM lesen und schreiben', () => {
  assert.equal(parseHHMM('11:00'), 660);
  assert.equal(parseHHMM('9:30'), 570);
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('23:59'), 1439);
  assert.equal(parseHHMM('24:00'), null, 'ungültige Stunde');
  assert.equal(parseHHMM('11:60'), null, 'ungültige Minute');
  assert.equal(parseHHMM('elf'), null);
  assert.equal(parseHHMM(null), null);
  assert.equal(formatHHMM(660), '11:00');
  assert.equal(formatHHMM(570), '09:30');
});

test('Zeitschlitze stapeln sich im Takt', () => {
  assert.equal(naechsterSlot([], '11:00', 60), '11:00', 'erste Reinigung zur Check-out-Zeit');
  assert.equal(naechsterSlot(['11:00'], '11:00', 60), '12:00');
  assert.equal(naechsterSlot(['11:00', '12:00'], '11:00', 60), '13:00');
  assert.equal(naechsterSlot(['11:00', '13:00'], '11:00', 60), '12:00', 'Lücke wird gefüllt');
});

test('Zeitschlitze folgen der Check-out-Zeit der Unterkunft', () => {
  assert.equal(naechsterSlot([], '10:00', 60), '10:00');
  assert.equal(naechsterSlot(['10:00'], '10:00', 90), '11:30', 'anderer Takt');
});

test('Schlitze laufen nicht in die Nacht', () => {
  const voll = [];
  for (let h = 11; h <= 23; h++) voll.push(`${String(h).padStart(2, '0')}:00`);
  const s = naechsterSlot(voll, '11:00', 60);
  assert.ok(parseHHMM(s) <= 22 * 60, `würde ${s} eintragen — zu spät`);
});

test('Berliner Zeit nach UTC: Sommer und Winter unterscheiden sich', () => {
  assert.equal(icsStamp(localToUtc('2026-07-26', '11:00')), '20260726T090000Z', 'Sommerzeit: -2 h');
  assert.equal(icsStamp(localToUtc('2026-01-15', '11:00')), '20260115T100000Z', 'Winterzeit: -1 h');
});

test('Umstellungstage werden richtig getroffen', () => {
  // 2026: Sommerzeit ab 29.03., zurück am 25.10.
  assert.equal(icsStamp(localToUtc('2026-03-28', '11:00')), '20260328T100000Z', 'Tag davor: noch Winter');
  assert.equal(icsStamp(localToUtc('2026-03-30', '11:00')), '20260330T090000Z', 'Tag danach: Sommer');
  assert.equal(icsStamp(localToUtc('2026-10-24', '11:00')), '20261024T090000Z', 'noch Sommer');
  assert.equal(icsStamp(localToUtc('2026-10-26', '11:00')), '20261026T100000Z', 'wieder Winter');
});

test('Einladung mit Zeit ergibt einen Zeitblock, ohne Zeit ganztägig', () => {
  const basis = {
    jobId: 1, userId: 2, date: '2026-07-26', summary: 'Reinigung',
    organizerEmail: 'a@b.de', attendeeEmail: 'c@d.de',
    now: new Date('2026-07-20T08:00:00Z'), sequence: 1, method: 'REQUEST',
  };
  const mitZeit = buildEvent({ ...basis, startTime: '11:00', durationMinutes: 60 });
  assert.match(mitZeit, /DTSTART:20260726T090000Z/);
  assert.match(mitZeit, /DTEND:20260726T100000Z/);
  assert.ok(!/VALUE=DATE/.test(mitZeit), 'kein Ganztages-Format');

  const ohneZeit = buildEvent(basis);
  assert.match(ohneZeit, /DTSTART;VALUE=DATE:20260726/);
});

test('Terminlänge folgt dem Takt des Mandanten', () => {
  const s = buildEvent({
    jobId: 1, userId: 2, date: '2026-07-26', summary: 'R', method: 'REQUEST',
    organizerEmail: 'a@b.de', attendeeEmail: 'c@d.de', now: new Date('2026-07-20T08:00:00Z'),
    sequence: 1, startTime: '11:00', durationMinutes: 90,
  });
  assert.match(s, /DTEND:20260726T103000Z/, '90 Minuten');
});

const { planeSlot } = require('../src/zeit');

test('Fahrzeit: gleicher Ort läuft direkt durch', () => {
  const o = { basis: '11:00', takt: 60, fahrzeit: 30, ort: 'A' };
  assert.equal(planeSlot([], o), '11:00');
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }], o), '12:00', 'kein Puffer bei gleicher Anschrift');
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }, { time: '12:00', ort: 'A' }], o), '13:00');
});

test('Fahrzeit: Ortswechsel schiebt den Termin', () => {
  const o = { basis: '11:00', takt: 60, fahrzeit: 30 };
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }], { ...o, ort: 'B' }), '12:30',
    '60 Min Reinigung + 30 Min Fahrt');
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }, { time: '12:30', ort: 'B' }], { ...o, ort: 'A' }), '14:00',
    'zurück zum ersten Ort kostet wieder Fahrzeit');
});

test('Fahrzeit: Lücke nur füllen, wenn sie zu BEIDEN Nachbarn passt', () => {
  const o = { basis: '11:00', takt: 60, fahrzeit: 30 };
  // Lücke 11–14 Uhr, alles am selben Ort: 12:00 passt.
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }, { time: '14:00', ort: 'A' }], { ...o, ort: 'A' }), '12:00');
  // Anderer Ort, aber die Lücke reicht punktgenau: 11:00 + 60 + 30 Fahrt = 12:30,
  // Reinigung bis 13:30, 30 Min zurück -> exakt 14:00. Passt.
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }, { time: '14:00', ort: 'A' }], { ...o, ort: 'B' }), '12:30');
  // Eine halbe Stunde weniger Luft, und es geht nicht mehr auf -> ans Ende.
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }, { time: '13:30', ort: 'A' }], { ...o, ort: 'B' }), '15:00');
});

test('Ohne Fahrzeit verhält es sich wie vorher', () => {
  const o = { basis: '11:00', takt: 60, fahrzeit: 0, ort: 'B' };
  assert.equal(planeSlot([{ time: '11:00', ort: 'A' }], o), '12:00');
});

test('Planung läuft nicht in die Nacht', () => {
  const voll = [];
  for (let h = 11; h <= 23; h++) voll.push({ time: `${String(h).padStart(2, '0')}:00`, ort: 'A' });
  const s = planeSlot(voll, { basis: '11:00', takt: 60, fahrzeit: 30, ort: 'B' });
  assert.ok(parseHHMM(s) <= 22 * 60, `würde ${s} planen — zu spät`);
});
