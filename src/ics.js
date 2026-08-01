// ics.js — Kalendereinladungen (RFC 5545).
//
// Muster aus Glanz & Gloria übernommen, weil es sich dort bewährt hat:
//   - Die ANFRAGE enthält KEINEN Kalendereintrag. Erst die ZUSAGE erzeugt eine
//     REQUEST-Einladung. Sonst stehen im Kalender der Reinigungskraft Termine,
//     die sie nie übernommen hat.
//   - CANCEL nur für einen Termin, der vorher zugesagt WAR. Eine Absage auf etwas,
//     das nie im Kalender stand, verwirrt nur.
//   - UID deterministisch aus Job und Person: So erkennt jeder Kalender eine
//     spätere Änderung oder Absage als denselben Termin wieder.
//
// Mit Uhrzeit, sobald der Termin eine hat (start_time): Drei ganztägige Einträge am
// selben Tag sagen einer Reinigungskraft nichts. Ohne Uhrzeit fällt der Eintrag auf
// ganztägig zurück — lieber das als eine erfundene Zeit.

const { localToUtc, icsStamp, parseHHMM, formatHHMM } = require('./zeit');

const CRLF = '\r\n';

// RFC 5545: Sonderzeichen in TEXT-Werten maskieren.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545: Zeilen auf 75 Oktett umbrechen, Fortsetzung mit einem Leerzeichen.
// Wir falten nach Zeichen statt Oktett — ausreichend, solange keine Emoji im
// Text stehen; deutsche Umlaute sind in UTF-8 zwei Byte, deshalb konservativ 70.
function fold(line) {
  if (line.length <= 70) return line;
  const out = [line.slice(0, 70)];
  let rest = line.slice(70);
  while (rest.length > 69) { out.push(' ' + rest.slice(0, 69)); rest = rest.slice(69); }
  if (rest) out.push(' ' + rest);
  return out.join(CRLF);
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function dateOnly(iso) { return iso.replace(/-/g, ''); }
function plusOneDay(iso) {
  return new Date(new Date(iso + 'T12:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
}

// Mit Startzeit ein echter Zeitblock in UTC, sonst ganztägig.
function zeitZeilen(o) {
  const start = parseHHMM(o.startTime);
  if (start == null) {
    return [
      `DTSTART;VALUE=DATE:${dateOnly(o.date)}`,
      `DTEND;VALUE=DATE:${dateOnly(plusOneDay(o.date))}`,
    ];
  }
  const dauer = Number(o.durationMinutes) > 0 ? Number(o.durationMinutes) : 60;
  const von = localToUtc(o.date, formatHHMM(start), o.timeZone || 'Europe/Berlin');
  const bis = new Date(von.getTime() + dauer * 60000);
  return [`DTSTART:${icsStamp(von)}`, `DTEND:${icsStamp(bis)}`];
}

function uidFor(jobId, userId, host = 'putzflow.de') {
  return `pf-job-${jobId}-user-${userId}@${host}`;
}

/**
 * Baut eine Kalendereinladung.
 *
 * @param {object}  o
 * @param {'REQUEST'|'CANCEL'} o.method
 * @param {number}  o.jobId
 * @param {number}  o.userId
 * @param {string}  o.date        YYYY-MM-DD
 * @param {string}  o.summary     Titel im Kalender
 * @param {string} [o.description]
 * @param {string} [o.location]
 * @param {string}  o.organizerEmail
 * @param {string}  o.attendeeEmail
 * @param {string} [o.attendeeName]
 * @param {number} [o.sequence]   höher = neuer; Default Unix-Sekunden
 * @param {Date}   [o.now]        für Tests
 */
function buildEvent(o) {
  const method = o.method === 'CANCEL' ? 'CANCEL' : 'REQUEST';
  const seq = o.sequence != null ? o.sequence : Math.floor((o.now || new Date()).getTime() / 1000);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Putzflow//Reinigungsplanung//DE',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uidFor(o.jobId, o.userId)}`,
    `DTSTAMP:${stamp(o.now)}`,
    ...zeitZeilen(o),
    `SUMMARY:${esc(o.summary)}`,
    o.description ? `DESCRIPTION:${esc(o.description)}` : null,
    o.location ? `LOCATION:${esc(o.location)}` : null,
    `ORGANIZER;CN=Putzflow:mailto:${o.organizerEmail}`,
    `ATTENDEE;CN=${esc(o.attendeeName || o.attendeeEmail)};ROLE=REQ-PARTICIPANT;PARTSTAT=${
      method === 'CANCEL' ? 'DECLINED' : 'ACCEPTED'};RSVP=FALSE:mailto:${o.attendeeEmail}`,
    `SEQUENCE:${seq}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return lines.map(fold).join(CRLF) + CRLF;
}

// Als Mailanhang. Der Methodenparameter im MIME-Typ ist entscheidend — ohne ihn
// zeigen Outlook und Apple Mail nur eine Datei statt einer Einladung.
function asAttachment(icsText, method = 'REQUEST') {
  return {
    name: 'termin.ics',
    contentType: `text/calendar; charset=utf-8; method=${method}`,
    content: Buffer.from(icsText, 'utf8').toString('base64'),
  };
}

module.exports = { buildEvent, asAttachment, uidFor, esc, fold };
