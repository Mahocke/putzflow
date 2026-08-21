// Urlaub: Zählweise, Anspruch, Konto, Entgelt — und die drei Stellen, an denen ein
// Fehler Geld kostet:
//   1. Der Divisor beim Urlaubsentgelt (Wochenverdienst, NICHT Verdienst je Arbeitstag).
//   2. Urlaubsentgelt in der Minijob-Grenze, aber NICHT in der Mindestlohn-Rechnung.
//   3. Die Blockade der Planung an genehmigten Urlaubstagen.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-urlaub-test.sqlite';
process.env.RECEIPT_DIR = '/tmp/putzflow-urlaub-belege';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const db = require('../src/db');
db.init();
const { run, get } = db;
const urlaub = require('../src/urlaub');
const jobsLogic = require('../src/jobs');
const rundruf = require('../src/rundruf');
const billing = require('../src/billing');

// --- Kulisse ---------------------------------------------------------------
run(`INSERT INTO tenants(id, slug, name, region, urlaub_werktage, period_start_day)
     VALUES(1,'t','Testbetrieb','NW',6,16)`);
run(`INSERT INTO users(id, tenant_id, name, role, employment, vacation_days, vacation_paid, email)
     VALUES(1,1,'Marina','cleaner','minijob',30,1,'marina@example.org')`);
run(`INSERT INTO users(id, tenant_id, name, role, employment, vacation_days, email)
     VALUES(2,1,'Jana','cleaner','minijob',NULL,'jana@example.org')`);
// ⚠️ Eigene Person für die Kontoführung. Mit derselben wie unten überlappten sich die
// Urlaube der Konto-Tests und die des Stundenzettels — dann misst jeder Test den
// Urlaub des anderen mit, und beide sehen trotzdem plausibel aus.
// `vacation_tracked_since` ist der Anker für den Übertrag: Ohne ihn rechnet Putzflow
// bewusst KEINEN Übertrag aus Jahren, die es nicht kennt.
run(`INSERT INTO users(id, tenant_id, name, role, employment, vacation_days, email, vacation_tracked_since)
     VALUES(3,1,'Ela','cleaner','minijob',30,'ela@example.org','2026-01-01')`);
run(`INSERT INTO units(id, tenant_id, name) VALUES(1,1,'Wohnung A')`);
run(`INSERT INTO comp_rules(tenant_id, unit_id, user_id, mode, base_cents, premium_on)
     VALUES(1,NULL,NULL,'flat',3000,'never')`);

const tenant = get(`SELECT * FROM tenants WHERE id = 1`);
const marina = get(`SELECT * FROM users WHERE id = 1`);
const jana = get(`SELECT * FROM users WHERE id = 2`);
const ela = get(`SELECT * FROM users WHERE id = 3`);

// ===========================================================================
// Zählweise
// ===========================================================================
test('Werktage sind Mo–Sa, Sonntage zählen nie', () => {
  // 06.07.2026 (Mo) bis 12.07.2026 (So)
  assert.equal(urlaub.zaehleTage('2026-07-06', '2026-07-12', 'NW', 6), 6);
  assert.equal(urlaub.zaehleTage('2026-07-06', '2026-07-12', 'NW', 5), 5);
  // Ein einzelner Sonntag ist kein Urlaubstag.
  assert.equal(urlaub.zaehleTage('2026-07-12', '2026-07-12', 'NW', 6), 0);
});

// § 3 Abs. 2 BUrlG: Feiertage sind nie auf den Urlaub anrechenbar. Welche das sind,
// hängt am Bundesland — genau der Punkt, an dem Putzflow sich von G&G löst.
test('Feiertage gehen nicht ab — und welche das sind, entscheidet das Bundesland', () => {
  // Fronleichnam 2026 = 04.06., Feiertag in NRW, nicht in Berlin.
  assert.equal(urlaub.zaehleTage('2026-06-01', '2026-06-07', 'NW', 6), 5);
  assert.equal(urlaub.zaehleTage('2026-06-01', '2026-06-07', 'BE', 6), 6);
});

// ⚠️ Ohne Bundesland gelten NUR die bundesweiten Feiertage. Ein stiller Rückfall auf
// NRW würde einem Berliner Betrieb einen Urlaubstag schenken, den es dort nicht gibt.
test('ohne Bundesland gelten nur die bundesweiten Feiertage', () => {
  assert.equal(urlaub.zaehleTage('2026-06-01', '2026-06-07', null, 6), 6);
  assert.equal(urlaub.zaehleTage('2026-06-01', '2026-06-07', '', 6), 6);
});

test('Urlaub über den Jahreswechsel belastet jedes Jahr einzeln', () => {
  const je = urlaub.zaehleTageJeJahr('2026-12-28', '2027-01-05', 'NW', 6);
  // 28.–31.12. (Mo–Do) = 4, 01.01. Neujahr fällt weg, 02.01. (Sa) + 04./05.01. = 3
  assert.equal(je[2026], 4);
  assert.equal(je[2027], 3);
});

// ===========================================================================
// Anspruch (§ 5 BUrlG)
// ===========================================================================
test('voller Anspruch ohne Startdatum', () => {
  assert.equal(urlaub.anspruchFuerJahr({ vacation_days: 30 }, 2026), 30);
});

test('§ 5 BUrlG: ein Zwölftel je vollem Monat, ab einem halben Tag aufgerundet', () => {
  // Start am 1.9. → September zählt mit → 4 Monate → 4/12 × 30 = 10
  assert.equal(urlaub.anspruchFuerJahr({ vacation_days: 30, vacation_start: '2026-09-01' }, 2026), 10);
  // Start am 15.9. → erster VOLLER Monat ist Oktober → 3/12 × 30 = 7,5 → 8
  assert.equal(urlaub.anspruchFuerJahr({ vacation_days: 30, vacation_start: '2026-09-15' }, 2026), 8);
  // Im Folgejahr wieder voll
  assert.equal(urlaub.anspruchFuerJahr({ vacation_days: 30, vacation_start: '2026-09-15' }, 2027), 30);
  // Vor dem Start: nichts
  assert.equal(urlaub.anspruchFuerJahr({ vacation_days: 30, vacation_start: '2026-09-15' }, 2025), 0);
});

// ⚠️ Kein Anspruch ist etwas anderes als null Tage. Eine beauftragte Reinigungsfirma
// hat gegen den Betrieb keinen Urlaubsanspruch — die Oberfläche darf dann gar nichts
// anzeigen, statt „0 von 0 frei" zu behaupten.
test('ohne hinterlegte Tage gibt es kein Konto (null, nicht 0)', () => {
  assert.equal(urlaub.anspruchFuerJahr({ vacation_days: null }, 2026), null);
  assert.equal(urlaub.konto({ id: 2, vacation_days: null }, 'NW', '2026-08-01'), null);
  assert.equal(urlaub.aktiv(jana, '2026-08-01'), false);
});

test('das Startdatum schaltet das Konto erst frei', () => {
  const spaet = { id: 9, vacation_days: 30, vacation_start: '2026-09-01' };
  assert.equal(urlaub.aktiv(spaet, '2026-08-31'), false);
  assert.equal(urlaub.aktiv(spaet, '2026-09-01'), true);
});

// ===========================================================================
// Konto: Übertrag und Verfall zum 31.3. (§ 7 Abs. 3 BUrlG)
// ===========================================================================
test('Rest wandert ins Folgejahr und verfällt dort am 31.3.', () => {
  // 2026: 30 Tage Anspruch, 24 genommen → 6 Tage Übertrag nach 2027.
  run(`INSERT INTO vacation_requests(tenant_id,user_id,start_date,end_date,status,werktage)
       VALUES(1,3,'2026-08-03','2026-08-29','approved',6)`);   // 4 volle Wochen Mo–Sa = 24 Tage

  const k26 = urlaub.konto(ela, 'NW', '2026-09-01', 2026);
  assert.equal(k26.anspruch, 30);
  assert.equal(k26.genommen, 24);
  assert.equal(k26.rest, 6);

  // Am 1.3.2027 lebt der Übertrag noch: 30 + 6 = 36.
  const vorVerfall = urlaub.konto(ela, 'NW', '2027-03-01', 2027);
  assert.equal(vorVerfall.uebertrag_ein, 6);
  assert.equal(vorVerfall.uebertrag_rest, 6);
  assert.equal(vorVerfall.rest, 36);

  // Am 1.4.2027 ist er weg: nur noch der Jahresanspruch.
  const nachVerfall = urlaub.konto(ela, 'NW', '2027-04-01', 2027);
  assert.equal(nachVerfall.uebertrag_rest, 0);
  assert.equal(nachVerfall.rest, 30);
});

test('Urlaub im ersten Quartal verbraucht zuerst den Übertrag', () => {
  // 6 Tage Übertrag aus 2026, 6 Tage Urlaub im Februar 2027.
  run(`INSERT INTO vacation_requests(tenant_id,user_id,start_date,end_date,status,werktage)
       VALUES(1,3,'2027-02-01','2027-02-06','approved',6)`);    // Mo–Sa = 6 Tage

  // Der Übertrag ist aufgebraucht, der Jahresanspruch unangetastet.
  const k = urlaub.konto(ela, 'NW', '2027-03-01', 2027);
  assert.equal(k.genommen, 6);
  assert.equal(k.uebertrag_rest, 0);
  assert.equal(k.rest, 30, 'die 6 Tage kamen aus dem Übertrag, nicht aus dem neuen Jahr');

  // Nach dem 31.3. bleibt es dabei: verbraucht ist verbraucht.
  assert.equal(urlaub.konto(ela, 'NW', '2027-04-01', 2027).rest, 30);
  run(`DELETE FROM vacation_requests WHERE start_date = '2027-02-01'`);
});

// ===========================================================================
// Urlaubsentgelt (§ 11 BUrlG) — hier sitzt der teuerste denkbare Fehler
// ===========================================================================
test('Urlaubsentgelt kommt vom WOCHENverdienst, nicht vom Verdienst je Arbeitstag', () => {
  // Marina arbeitet zwei Tage die Woche zu 30,00 € — also 60,00 € je Woche.
  // Vier Wochen vor dem 03.08.2026:
  for (const d of ['2026-07-06', '2026-07-10', '2026-07-13', '2026-07-17',
                   '2026-07-20', '2026-07-24', '2026-07-27', '2026-07-31']) {
    run(`INSERT INTO jobs(tenant_id, unit_id, due_date, status, assigned_user_id)
         VALUES(1,1,?, 'done', 1)`, d);
  }
  const e = urlaub.entgeltProTag(tenant, marina, '2026-08-03', 6);

  assert.equal(e.referenz_wochen, 4);
  assert.equal(e.referenz_tage, 8);
  assert.equal(e.referenz_summe_cents, 8 * 3000);
  assert.equal(e.pro_woche_cents, 6000, 'vier Wochen à 60,00 €');
  // ⚠️ Der springende Punkt: 60,00 € ÷ 6 Werktage = 10,00 € je Urlaubstag.
  // Mit dem Divisor „tatsächliche Arbeitstage" (2) kämen 30,00 € heraus — eine
  // freie Woche würde dann 180,00 € kosten statt der 60,00 €, die sie verdient hätte.
  assert.equal(e.pro_tag_cents, 1000);
  assert.equal(e.pro_tag_cents * 6, e.pro_woche_cents, 'eine freie Woche kostet genau einen Wochenverdienst');
});

test('bei 5-Tage-Zählung wird der Wochenverdienst durch 5 geteilt', () => {
  const e = urlaub.entgeltProTag(tenant, marina, '2026-08-03', 5);
  assert.equal(e.pro_woche_cents, 6000);
  assert.equal(e.pro_tag_cents, 1200);
  assert.equal(e.pro_tag_cents * 5, e.pro_woche_cents);
});

// § 11 Abs. 1 Satz 3 BUrlG: Verdienstausfälle drücken den Schnitt nicht.
test('Wochen ohne Einsatz drücken den Schnitt nicht', () => {
  // Referenzfenster für den 03.08. ist der 04.05.–02.08. — 13 Wochen. Gearbeitet
  // wurde nur in vieren. Ein starrer Divisor 13 ergäbe 240,00 € ÷ 13 ÷ 6 = 3,08 €.
  const e = urlaub.entgeltProTag(tenant, marina, '2026-08-03', 6);
  assert.equal(e.referenz_wochen, 4, 'nur Wochen MIT Arbeit zählen');
  assert.ok(e.pro_tag_cents > 300);
});

test('ohne Historie: 0 mit Warnung, kein stiller Betrag', () => {
  const e = urlaub.entgeltProTag(tenant, jana, '2026-08-03', 6);
  assert.equal(e.referenz_wochen, 0);
  assert.equal(e.pro_tag_cents, 0);
  assert.equal(e.keine_historie, true);
});

// ===========================================================================
// Stundenzettel: Arbeitsentgelt ja, Arbeitszeit nein
// ===========================================================================
test('Urlaubsentgelt zählt in die Minijob-Grenze, aber NICHT in die Mindestlohn-Rechnung', () => {
  // Eine erledigte Reinigung mit erfasster Zeit in der Periode 16.08.–15.09.2026 …
  run(`INSERT INTO jobs(id, tenant_id, unit_id, due_date, status, assigned_user_id)
       VALUES(500,1,1,'2026-08-20','done',1)`);
  run(`INSERT INTO work_sessions(tenant_id, job_id, user_id, started_at, ended_at)
       VALUES(1,500,1,'2026-08-20 09:00:00','2026-08-20 11:00:00')`);
  // … und genehmigter, bezahlter Urlaub darin: 24.–29.08. (Mo–Sa) = 6 Tage à 10,00 €.
  run(`INSERT INTO vacation_requests(tenant_id,user_id,start_date,end_date,status,werktage,
                                     paid,days,pay_per_day_cents,pay_cents)
       VALUES(1,1,'2026-08-24','2026-08-29','approved',6,1,6,1000,6000)`);

  // `heute` ausdrücklich nach dem Periodenende: Sonst hinge das Ergebnis daran,
  // wann der Test läuft — und der Urlaub stünde bis zum 24.08. unter „geplant".
  const ts = jobsLogic.timesheet(tenant, 1, '2026-09-01', '2026-09-16');

  assert.equal(ts.urlaub.tage, 6);
  assert.equal(ts.urlaub.entgelt_cents, 6000);

  // Die Reinigung: 30,00 € auf 120 Minuten.
  assert.equal(ts.total_cents, 3000 + 6000, 'Urlaubsentgelt ist Teil des Arbeitsentgelts');
  assert.equal(ts.total_minutes, 120, 'Urlaub bringt KEINE Arbeitsminuten mit');

  // ⚠️ Der Kern: Die Mindestlohn-Prüfung sieht nur die Reinigung. Zöge sie die
  // 60,00 € Urlaub mit hinein, stünde dort ein effektiver Stundenlohn von 45,00 €
  // statt 15,00 € — und ein echter Verstoß bliebe unentdeckt.
  assert.equal(ts.mindestlohn.betrag_cents, 3000);
  assert.equal(ts.mindestlohn.minuten, 120);
  assert.equal(ts.mindestlohn.effektiv_cents, 1500);
  // Und der Urlaub darf auch nicht als „Position ohne erfasste Zeit" gezählt werden:
  // an einem Urlaubstag ist zu Recht keine Zeit erfasst, das ist kein Mangel.
  assert.equal(ts.mindestlohn.ohne_zeit, 0);
  assert.equal(ts.aufzeichnung.fehlend, 0);

  // Die Minijob-Ampel zählt das Urlaubsentgelt mit — es ist Arbeitsentgelt.
  assert.equal(ts.minijob.cents, 9000);
});

test('der Urlaub hängt im Signatur-Hash — eine spätere Änderung veraltet die Unterschrift', () => {
  const ts = jobsLogic.timesheet(tenant, 1, '2026-09-01', '2026-09-16');
  const mitUrlaub = ts.signatur_positionen.find(p => String(p.job_id).startsWith('urlaub-'));
  assert.ok(mitUrlaub, 'der Urlaub steht als Position im Hash');
  assert.equal(mitUrlaub.minutes, 0);
  assert.equal(mitUrlaub.cents, 6000);

  const signatur = require('../src/signatur');
  const vorher = signatur.hashPositionen(ts.signatur_positionen);
  run(`UPDATE vacation_requests SET end_date = '2026-08-28'
        WHERE user_id = 1 AND start_date = '2026-08-24'`);
  const nachher = signatur.hashPositionen(
    jobsLogic.timesheet(tenant, 1, '2026-09-01', '2026-09-16').signatur_positionen);
  assert.notEqual(vorher, nachher, 'ein verkürzter Urlaub muss die Unterschrift veralten lassen');
  run(`UPDATE vacation_requests SET end_date = '2026-08-29'
        WHERE user_id = 1 AND start_date = '2026-08-24'`);
});

// ⚠️ Künftiger Urlaub gehört in die Ampel (die Verwaltung plant vorwärts), aber nicht
// als Vergütung auf den Zettel für die Lohnbuchhaltung — dieselbe Trennung wie bei
// geplanten Terminen.
test('künftiger Urlaub steht bei „geplant", nicht bei „geleistet"', () => {
  const heute = '2026-08-25';
  const u = urlaub.fuerPeriode(tenant, 1, billing.periodOf('2026-09-01', 16), heute);
  assert.equal(u.tage, 2, '24. und 25.08. sind vorbei');
  assert.equal(u.tage_geplant, 4, '26.–29.08. stehen noch aus');
  assert.equal(u.entgelt_cents, 2000);
  assert.equal(u.geplant_cents, 4000);
  assert.equal(u.signatur_positionen[0].cents, 2000, 'abgezeichnet wird nur Genommenes');
});

test('unbezahlter Urlaub blockiert die Planung, löst aber kein Entgelt aus', () => {
  run(`INSERT INTO vacation_requests(tenant_id,user_id,start_date,end_date,status,werktage,
                                     paid,days,pay_per_day_cents,pay_cents)
       VALUES(1,2,'2026-08-24','2026-08-29','approved',6,0,6,0,0)`);
  const ts = jobsLogic.timesheet(tenant, 2, '2026-09-01', '2026-09-16');
  assert.equal(ts.urlaub.tage, 6);
  assert.equal(ts.urlaub.entgelt_cents, 0);
  assert.equal(urlaub.imUrlaub(2, '2026-08-26'), true);
});

// ===========================================================================
// Blockade der Planung
// ===========================================================================
test('nur GENEHMIGTER Urlaub blockiert — ein offener Antrag nicht', () => {
  run(`INSERT INTO vacation_requests(tenant_id,user_id,start_date,end_date,status)
       VALUES(1,1,'2026-10-05','2026-10-10','pending')`);
  assert.equal(urlaub.imUrlaub(1, '2026-10-07'), false,
    'sonst nähme sich jede Kraft durch bloßes Beantragen aus dem Dienstplan');
  assert.equal(urlaub.imUrlaub(1, '2026-08-26'), true);
});

test('der Rundruf fragt Urlauberinnen gar nicht erst — nennt sie aber der Verwaltung', () => {
  const job = { id: 900, tenant_id: 1, unit_id: 1, due_date: '2026-08-26', kind: 'apartment',
                assigned_user_id: null, status: 'open' };
  const { gefragt, uebersprungen } = rundruf.kandidaten(tenant, job);

  assert.equal(gefragt.find(u => u.id === 1), undefined, 'Marina hat an dem Tag Urlaub');
  const marinaUebersprungen = uebersprungen.find(s => s.user.id === 1);
  assert.ok(marinaUebersprungen, 'sie fehlt nicht stillschweigend');
  assert.equal(marinaUebersprungen.grund, 'hat an dem Tag Urlaub');

  // An einem Tag ohne Urlaub ist sie wieder dabei.
  const frei = rundruf.kandidaten(tenant, { ...job, due_date: '2026-09-10' });
  assert.ok(frei.gefragt.find(u => u.id === 1));
});

// ⚠️ Der Fehler, den diese Prüfung festhält, ist am 01.08.2026 beim Durchspielen
// aufgefallen: Ein frisch angelegtes Konto wies 30 Tage Übertrag aus. Die Rechnung
// war formal richtig — sie lief drei Jahre zurück, fand keine Anträge und schloss
// daraus auf „voller Anspruch, nichts genommen". Nur kannte Putzflow diese Jahre gar
// nicht. Eine Zahl, die aus einer Annahme über die Zeit vor der Einführung stammt,
// sieht genauso aus wie eine gerechnete — und niemand merkt den Unterschied.
test('kein erfundener Übertrag aus Jahren vor der Einführung', () => {
  run(`INSERT INTO users(id, tenant_id, name, role, vacation_days, vacation_tracked_since)
       VALUES(4,1,'Neu','cleaner',30,'2026-08-01')`);
  const neu = get(`SELECT * FROM users WHERE id = 4`);

  // Im Januar wäre der Übertrag noch gültig — er darf trotzdem nicht entstehen.
  const k = urlaub.konto(neu, 'NW', '2026-01-15');
  assert.equal(k.uebertrag_ein, 0);
  assert.equal(k.rest, 30, 'nicht 60');
  assert.equal(k.uebertrag_unbekannt, false, 'ohne Anspruchsbeginn gibt es nichts zu vermuten');

  // Wer laut Anspruchsbeginn schon länger dabei ist, bekommt den Hinweis — aber
  // keine erfundene Zahl.
  run(`UPDATE users SET vacation_start = '2019-04-01' WHERE id = 4`);
  const alt = urlaub.konto(get(`SELECT * FROM users WHERE id = 4`), 'NW', '2026-01-15');
  assert.equal(alt.uebertrag_ein, 0);
  assert.equal(alt.rest, 30);
  assert.equal(alt.uebertrag_unbekannt, true, 'da KANN ein Übertrag sein, den Putzflow nicht kennt');
});
