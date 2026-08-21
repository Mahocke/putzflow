// server.js — Putzflow, Express-Server.
//
// Aufbau bewusst wie Glanz & Gloria (Vanilla, kein Build-Step), aber von Anfang an
// mandantenfähig und kanal-agnostisch. Siehe CLAUDE.md.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const dbmod = require('./src/db');
const slugs = require('./src/slug');
const { get, all, run, init } = dbmod;
const billing = require('./src/billing');
const jobsLogic = require('./src/jobs');
const rundruf = require('./src/rundruf');
// ⚠️ KEIN require auf ./src/betreiber, ./src/rechnung oder ./src/rechnungslauf.
// Der Betreiberbereich ist ein optionales Modul und wird weiter unten in einem
// try-Block geladen (Suchwort „Betreiberbereich"). Wer hier eine feste Zeile
// ergänzt, koppelt ihn wieder fest an den Kern — dann startet der quelloffene
// Export nicht mehr, und das fällt erst Wochen später auf. Ein Test in
// test/betreiber.test.js wacht darüber.
const auth = require('./src/auth');
const { attachTenant, requireTenant } = require('./src/tenant');
const { REGIONS } = require('./src/holidays');
const notify = require('./src/notify');
const ics = require('./src/ics');
const zeit = require('./src/zeit');
const checkliste = require('./src/checklist');
const krypto = require('./src/krypto');
const smoobu = require('./src/smoobu');
const sync = require('./src/sync');
const pruefung = require('./src/pruefung');
const auslagen = require('./src/auslagen');
const urlaub = require('./src/urlaub');
const angebot = require('./src/angebot');
const preis = require('./src/preis');
const fmt = require('./src/format');
const signatur = require('./src/signatur');
const pdf = require('./src/stundenzettel-pdf');
const einrichtung = require('./src/einrichtung');

const PORT = Number(process.env.PORT || 3990);
// ⚠️ Standard bleibt 127.0.0.1 — eine Instanz, die beim ersten Start am offenen
// Netz hängt, ist die gefährlichere Voreinstellung. Wer ohne Webserver davor
// arbeitet (Testinstanz im eigenen Netz, Tailnet), setzt HOST bewusst.
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC = path.join(__dirname, 'public');
const TESTTAGE = Number(process.env.TRIAL_DAYS || 42);        // sechs Wochen

// --- Einführungsangebot: die ersten fünf zahlen ein halbes Jahr nichts ------
// ⚠️ Die Zahl auf der Verkaufsseite wird GEZÄHLT, nicht hingeschrieben. Eine
// erfundene Verknappung („noch 2 von 5") wäre nach Anhang zu § 3 Abs. 3 UWG Nr. 7
// eine per se verbotene Praxis — und bei einem Produkt, das mit Nachprüfbarkeit
// wirbt (offener Quellcode, „Sie können nachlesen, wie gerechnet wird"), die
// denkbar falsche erste Unwahrheit.
const AKTION_PLAETZE = Number(process.env.AKTION_PLAETZE || 5);
const AKTION_TAGE = Number(process.env.AKTION_TAGE || 183);   // ein halbes Jahr

// ⚠️ NUR echte Fremdkunden. Der Demo-Mandant ist ein Schaufenster, der
// Schattenbetrieb ist unser eigener Betrieb im Vergleichslauf, und `selbstbetrieb`
// ist eine fremde Installation. Keiner davon ist ein Kunde, der einen Platz
// belegt — sie mitzuzählen wäre genau die Verknappung, die wir nicht behaupten
// wollen. Die Bedingung ist dieselbe wie beim Gewähren weiter unten: Zähler und
// Vergabe dürfen nie auseinanderlaufen.
function belegtePlaetze() {
  return get(`SELECT COUNT(*) AS n FROM tenants
                WHERE is_demo = 0 AND schattenbetrieb = 0 AND selbstbetrieb = 0`).n;
}
function freiePlaetze() {
  return Math.max(0, AKTION_PLAETZE - belegtePlaetze());
}

// ⚠️ Ohne APP_SECRET NICHT starten. Der Schlüssel verschlüsselt die
// Smoobu-Zugänge der Mandanten (src/krypto.js) — fehlt er, fällt das erst auf,
// wenn der erste Kunde seinen Zugang hinterlegt, also lange nach der
// Installation. Schlimmer: Wer ihn später nachträgt und wieder ändert, macht
// alles Verschlüsselte unbrauchbar, ohne Fehlermeldung. Ein lauter Abbruch beim
// ersten Start ist der einzige Zeitpunkt, an dem das nichts kostet.
// Absichtlich NICHT selbst erzeugt und weggeschrieben: Wäre die .env einmal
// nicht beschreibbar, entstünde bei jedem Start ein neuer Schlüssel — und damit
// genau der stille Datenverlust, der hier verhindert werden soll.
if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
  console.error('\n  APP_SECRET fehlt in der .env (oder ist kürzer als 32 Zeichen).');
  console.error('  Einmal erzeugen, danach NIE wieder ändern:\n');
  console.error('      echo "APP_SECRET=$(openssl rand -hex 32)" >> .env\n');
  console.error('  Er verschlüsselt die hinterlegten Smoobu-Zugänge und gehört in die Sicherung.\n');
  process.exit(1);
}

init();

const app = express();
app.set('trust proxy', 1);

// ⚠️ Express 4 kennt keine async-Routen. Wirft ein `async`-Handler, entsteht eine
// unbehandelte Promise-Ablehnung — und es geht ÜBERHAUPT KEINE Antwort raus. Der
// Browser hängt, bis nginx nach 60 Sekunden mit einem 504 abbricht. Genau so hat
// sich der `region`-Fehler am 20.08.2026 einem Interessenten gezeigt: dreimal eine
// Minute warten und dann eine nginx-Fehlerseite, die aussieht, als sei der ganze
// Dienst tot. Der Fehler war eine einzige Datenbankspalte.
//
// Deshalb wird JEDER Handler an dieser einen Stelle eingepackt statt an
// zweihundert. Muss VOR der ersten Route stehen — auch die Module, die sich
// später ihre Routen holen (`betreiber.js`, `einrichtung.js`), laufen dann mit.
for (const methode of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
  const original = app[methode].bind(app);
  app[methode] = (...args) => original(...args.map((a) => (
    // Vier Parameter = Fehlerbehandlung. Die darf nicht eingepackt werden, sonst
    // hält Express sie für gewöhnliche Middleware und ruft sie nie auf.
    typeof a === 'function' && a.length < 4
      ? function (req, res, next) {
        let r;
        try { r = a.call(this, req, res, next); } catch (e) { return next(e); }
        if (r && typeof r.catch === 'function') r.catch(next);
        return r;
      }
      : a
  )));
}
app.use(express.json({ limit: '256kb' }));
app.use(attachTenant);
app.use(auth.attachUser);
app.use(schreibsperre);

function today() { return new Date().toISOString().slice(0, 10); }

// Der Demo-Mandant ist öffentlich: Zugangsdaten stehen auf der Seite. Deshalb dort
// alles sperren, was fremde Zugangsdaten aufnimmt oder nach außen wirkt — sonst
// wäre die Demo ein offenes Mailrelais und ein Sammelbecken für echte API-Schlüssel.
// Stand des Testzeitraums. Solange es keinen Bezahlweg gibt, wird NICHT gesperrt —
// jemanden auszusperren, der gar nicht bezahlen kann, wäre absurd. Erst mit Stripe
// wird daraus eine echte Grenze.
function teststand(tenant) {
  if (!tenant || !tenant.trial_ends_at) return null;
  const heute = new Date().toISOString().slice(0, 10);
  const tage = Math.round((new Date(tenant.trial_ends_at + 'T12:00:00Z') - new Date(heute + 'T12:00:00Z')) / 86400000);
  return {
    endet_am: tenant.trial_ends_at,
    tage_rest: tage,
    abgelaufen: tage < 0,
    angebot_token: tenant.angebot_token,
    bestellt_am: tenant.bestellt_am,
  };
}

const mandantenUrl = slug => BASE_URL.replace('://', `://${slug}.`);

// Abgerechnet wird je Unterkunft, die tatsächlich betreut wird.
function zaehleUnterkuenfte(tenantId) {
  return get(`SELECT COUNT(*) AS n FROM units WHERE tenant_id = ? AND active = 1`, tenantId).n;
}

// Was ein Mandant nach dem Test kostet — an einer Stelle gerechnet (src/preis.js),
// damit Startseite, Angebotsseite und Rechnung nicht auseinanderlaufen.
function preisFuer(tenant) {
  return { ...preis.fuer(zaehleUnterkuenfte(tenant.id)), modus: tenant.billing_mode || 'yearly' };
}

// Zustand eines Mandanten: voll nutzbar oder nur noch lesbar.
// Wer nicht zahlt, verliert NICHT seine Daten und auch nicht den Zugang — er kann
// weiter alles ansehen und herunterladen, nur nicht mehr weiterarbeiten. Das ist
// fair, vermeidet Datenverlust und erfüllt nebenbei die Datenübertragbarkeit.
function nurLesbar(tenant) {
  // ⚠️ Die Schreibsperre ist unser Kassenmechanismus, keine Fachlogik. Auf einer
  // selbst betriebenen Instanz gibt es niemanden, der eine Rechnung stellt —
  // und niemanden, der die Sperre wieder aufheben könnte.
  if (!tenant || tenant.is_demo || tenant.selbstbetrieb) return false;
  const heute = today();
  if (tenant.paid_until && tenant.paid_until >= heute) return false;
  if (tenant.trial_ends_at && tenant.trial_ends_at >= heute) return false;
  return true;
}

// Schreibzugriffe sperren, sobald der Mandant nur noch lesen darf. Als Middleware
// über ALLE Schreibmethoden statt an jeder Route einzeln — sonst wird beim nächsten
// neuen Endpunkt garantiert einer vergessen.
const SCHREIBEN_ERLAUBT = new Set([
  '/api/login', '/api/logout', '/api/register', '/api/verify/resend',
  // Wer seine Adresse sucht, hat noch gar keinen Mandanten aufgelöst — die Sperre
  // eines fremden könnte ihn sonst treffen.
  '/api/adresse-vergessen',
  // ⚠️ Das eigene Konto bleibt änderbar, auch wenn der Testzeitraum abgelaufen
  // ist. Die Sperre soll das Weiterarbeiten unterbinden, nicht verhindern, dass
  // jemand sein Passwort wechselt — der Anlass dafür ist oft, dass es jemand
  // mitgelesen hat, und der wartet nicht auf eine Rechnung.
  '/api/me',
  // Auch die Ersteinrichtung: Auf einer frischen Instanz gibt es noch keinen
  // Mandanten, der irgendetwas bezahlt haben könnte.
  '/api/einrichtung',
  // ⚠️ Und das Zurücksetzen. Wer ausgesperrt ist, muss zurück ins Konto können,
  // auch wenn der Testzeitraum abgelaufen ist — schon um seine Daten zu
  // exportieren, was ausdrücklich offen bleiben soll (Art. 20 DSGVO).
  '/api/passwort/vergessen',
]);
function schreibsperre(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.path.startsWith('/api/')) return next();
  // ⚠️ Der Betreiberbereich gehört NICHT hinter die Mandanten-Sperre. Auf
  // intern.putzflow.de löst DEFAULT_TENANT bzw. der Host keinen sinnvollen
  // Mandanten auf, aber req.tenant kann trotzdem gesetzt sein (lokal etwa der
  // Demo-Mandant) — und dann blockierte die abgelaufene Testphase EINES
  // Mandanten das Rechnungsstellen des Betreibers. Im Durchstich passiert.
  if (req.path.startsWith('/api/intern/')) return next();
  if (SCHREIBEN_ERLAUBT.has(req.path)) return next();
  // Bestellen und Verlängern müssen GERADE DANN gehen, wenn schon gesperrt ist —
  // sonst wäre der Weg zurück in den Betrieb genau der, der blockiert wird.
  if (req.path.startsWith('/api/angebot/')) return next();
  // Das Setzen des neuen Passworts trägt den Token im Pfad, steht also nicht in
  // der Liste oben.
  if (req.path.startsWith('/api/passwort/')) return next();
  if (!nurLesbar(req.tenant)) return next();
  res.status(402).json({
    error: 'Der Testzeitraum ist abgelaufen. Sie können weiterhin alles ansehen und '
         + 'herunterladen — zum Weiterarbeiten schreiben Sie an hallo@putzflow.de.',
    nur_lesbar: true,
  });
}

function keineDemo(req, res, next) {
  if (req.tenant && req.tenant.is_demo) {
    return res.status(403).json({ error: 'In der Demo nicht möglich — melden Sie sich für ein eigenes Konto an.' });
  }
  // Ohne bestätigte Adresse keine Aktionen, die nach außen wirken oder fremde
  // Zugangsdaten aufnehmen. Sonst wäre ein Konto mit erfundener Adresse
  // genauso mächtig wie ein echtes.
  if (req.tenant && !req.tenant.email_verified_at && !req.tenant.is_demo) {
    return res.status(403).json({ error: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse — den Link finden Sie in Ihrem Postfach.' });
  }
  next();
}
// Wie heißt dieser Termin in einer Nachricht? Eine Reinigung heißt nach ihrer
// Unterkunft, eine Sonderaufgabe nach dem, was zu tun ist.
// ⚠️ Ohne das stand in der Anfrage für „Kaffeekapseln kaufen": „können Sie die
// Reinigung übernehmen?" — die Kraft fährt dann zur Wohnung statt in den Laden.
function jobBezeichnung(job, unitName) {
  if (job.kind === jobsLogic.AUFGABE) return job.titel || 'Sonderaufgabe';
  return unitName ? `Reinigung ${unitName}` : 'Reinigung';
}
function nowSql() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function magicUrl(tenantSlug, token) {
  const host = BASE_URL.replace('://', `://${tenantSlug}.`);
  return `${host}/m/${token}`;
}

// --- HTML nie cachen (PWA-Falle aus G&G: iOS friert sonst die Startseite ein) ---
function noCacheHtml(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

// ===========================================================================
// Suchmaschinen: NUR die Startseite darf in den Index
// ===========================================================================
// Bis zum 27.07.2026 setzte nginx `X-Robots-Tag: noindex` pauschal für alle
// Hosts — richtig gedacht (Magic-Links stehen in Mails und dürfen nie in einen
// Index), aber zu grob: Auch die Verkaufsseite blieb unsichtbar.
//
// ⚠️ POSITIVLISTE, keine Ausschlussliste. Erlaubt sind ausschließlich der Apex
// und www. Alles andere — jede Mandanten-Subdomain, die Demo, der
// Betreiberbereich und jeder Host, den es morgen gibt — bleibt gesperrt. Bei
// einer Ausschlussliste wäre der nächste neue Host versehentlich offen, und
// das fiele erst auf, wenn Kundennamen in einer Suchmaschine stehen.
//
// ⚠️ Die Prüfung hängt am HOST, nicht an `req.tenant`. `intern.putzflow.de`
// trägt keinen Mandanten und wäre über den Mandanten-Weg fälschlich „öffentlich".
const OEFFENTLICH = (() => {
  // ⚠️ Der Port muss AUCH hier weg, nicht nur beim Vergleich unten. Steht in
  // BASE_URL ein Port (jede selbst betriebene Instanz hinter einem eigenen
  // Reverse Proxy, siehe README), stand im Satz `putzflow.de:3990` und der
  // Vergleich gegen `putzflow.de` ging nie auf: Die öffentliche Seite galt dann
  // als nicht öffentlich — inklusive `noindex` auf der eigenen Startseite.
  const h = BASE_URL.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().split(':')[0];
  return new Set([h, h.startsWith('www.') ? h.slice(4) : `www.${h}`]);
})();

function istOeffentlicheSeite(req) {
  return OEFFENTLICH.has(String(req.headers.host || '').split(':')[0].toLowerCase());
}

app.use((req, res, next) => {
  if (!istOeffentlicheSeite(req)) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// ⚠️ Die öffentlichen Inhaltsseiten stehen GENAU HIER und nirgends sonst.
// Sitemap, Route und Test lesen alle aus dieser einen Liste — sonst entsteht
// früher oder später eine Seite ohne Sitemap-Eintrag oder ein Sitemap-Eintrag
// ohne Seite (ein 404 in der Sitemap kostet Vertrauen bei jedem Crawler).
// `test/inhaltsseiten.test.js` wacht darüber, dass zu jedem Eintrag eine Datei
// in public/ liegt.
//
// Es sind KEINE Suchmaschinenseiten im Sinne von „Doorway Pages": Jede
// beantwortet eine Frage, die auf der Startseite nur als Nebensatz vorkommt und
// dort auch keinen Platz bekommen darf — die Startseite ist bewusst auf
// 44 Wörter bis zum ersten Bild getrimmt. Sie sind zugleich das, was man einem
// Interessenten auf eine konkrete Rückfrage schickt.
const INHALTSSEITEN = [
  'smoobu',
  'endreinigung-ferienwohnung',
  'arbeitszeiterfassung-reinigungskraefte',
  'preise',
];

// robots.txt — zweiter Riegel neben dem Header, aus demselben Grund.
// ⚠️ Kein `Allow: /$` mehr (05.08.2026). Die Zeile stammt aus der Zeit, als es
// genau eine öffentliche Seite gab, und las sich wie „nur die Wurzel ist
// erlaubt" — gewirkt hat sie nie, weil ohne `Disallow: /` ohnehin alles erlaubt
// ist, was nicht ausdrücklich gesperrt wurde. Sie stehenzulassen hätte beim
// nächsten Blick in die Datei die falsche Vermutung genährt, die Inhaltsseiten
// seien gesperrt.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  if (!istOeffentlicheSeite(req)) return res.send('User-agent: *\nDisallow: /\n');
  res.send(`User-agent: *
Disallow: /m/
Disallow: /angebot/
Disallow: /anmelden/
Disallow: /api/

Sitemap: ${BASE_URL}/sitemap.xml
`);
});

// Startseite + Inhaltsseiten. Impressum und Datenschutz stehen bewusst nicht
// drin: Sie sollen erreichbar sein, nicht ranken.
app.get('/sitemap.xml', (req, res) => {
  if (!istOeffentlicheSeite(req)) return res.status(404).send('Nicht gefunden');
  const eintrag = (pfad, prio) =>
    `  <url><loc>${BASE_URL}/${pfad}</loc><changefreq>weekly</changefreq><priority>${prio}</priority></url>`;
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[eintrag('', '1.0'), ...INHALTSSEITEN.map(s => eintrag(s, '0.8'))].join('\n')}
</urlset>
`);
});

// ===========================================================================
// Health — schlankes JSON für ein externes Status-Board.
// ===========================================================================
app.get('/health', (req, res) => {
  try {
    const t = get(`SELECT COUNT(*) AS n FROM tenants WHERE active = 1`);
    const j = get(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'open'`);
    res.json({
      ok: true, service: 'putzflow', version: require('./package.json').version,
      tenants: t.n, open_jobs: j.n, channels: notify.configured(), time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ===========================================================================
// Magic-Link — passwortloser Zugang der Putzkräfte
// ===========================================================================
app.get('/m/:token', (req, res) => {
  const u = auth.userByMagicToken(req.params.token);
  noCacheHtml(res);
  if (!u) return res.status(404).send(page('Link ungültig', '<p>Dieser Link gilt nicht mehr. Bitte melden Sie sich bei Ihrer Ansprechpartnerin.</p>'));
  res.sendFile(path.join(PUBLIC, 'm.html'));
});

function magicUser(req, res, next) {
  const u = auth.userByMagicToken(req.params.token);
  if (!u) return res.status(404).json({ error: 'Link ungültig' });
  req.cleaner = u;
  req.tenant = get(`SELECT * FROM tenants WHERE id = ?`, u.tenant_id);
  next();
}

app.get('/api/m/:token', magicUser, (req, res) => {
  const u = req.cleaner, t = req.tenant;
  // Sie sieht ihre eigenen Termine — UND die, die ihr per Rundruf angeboten
  // wurden und noch niemandem gehören. Fremde Zuteilungen bleiben unsichtbar:
  // Ein offenes Angebot ist keine Auskunft darüber, wer sonst noch gefragt wurde.
  const rows = all(
    `SELECT j.*, un.name AS unit_name,
            EXISTS(SELECT 1 FROM job_offers o
                    WHERE o.job_id = j.id AND o.user_id = ? AND o.answer IS NULL) AS ist_rundruf
       FROM jobs j LEFT JOIN units un ON un.id = j.unit_id
      WHERE j.tenant_id = ? AND j.due_date >= date('now','-14 day')
        AND ( j.assigned_user_id = ?
              OR ( j.assigned_user_id IS NULL AND j.status = 'open'
                   AND EXISTS(SELECT 1 FROM job_offers o
                               WHERE o.job_id = j.id AND o.user_id = ? AND o.answer IS NULL) ) )
      ORDER BY j.due_date, j.id`, u.id, t.id, u.id, u.id);

  const jobs = rows.map(j => {
    const p = jobsLogic.jobPay(t, j);
    const open = all(`SELECT id FROM work_sessions WHERE job_id = ? AND ended_at IS NULL`, j.id);
    return {
      // ⚠️ Bei einer Sonderaufgabe steht der Titel, wo sonst die Unterkunft
      // steht — sonst sieht die Kraft in ihrer Liste eine leere Zeile mit einem
      // Datum und soll darauf zusagen.
      id: j.id, date: j.due_date, kind: j.kind, unit: j.unit_name || j.titel, status: j.status,
      confirmed: !!j.confirmed, requested: !!j.requested_at, declined: !!j.declined_at,
      rundruf: !!j.ist_rundruf,
      note: j.note, time: j.start_time, minutes: p.minutes, cents: p.cents, mode: p.rule.mode,
      running: open.length > 0, checkliste: checkliste.forJob(t.id, j),
    };
  });

  res.json({
    me: { name: u.name, role: u.role },
    tenant: { name: t.name, region: t.region },
    today: today(),
    jobs,
    timesheet: (() => {
      const ts = jobsLogic.timesheet(t, u.id, today());
      return { ...ts,
        signatur: signatur.status(t.id, u.id, ts.period.start, ts.signatur_positionen),
        darf_signieren: signatur.darfSignieren(ts.period) };
    })(),
    // Urlaub. `null`, solange für sie kein Konto geführt wird — dann zeigt die
    // Seite den ganzen Abschnitt nicht, statt „0 von 0 Tagen frei" zu behaupten.
    urlaub: (() => {
      if (!urlaub.aktiv(u, today())) return null;
      return {
        konto: urlaub.konto(u, t.region, today()),
        werktage: urlaub.werktageProWoche(t),
        bezahlt: !!u.vacation_paid,
        // Ein Jahr zurück: Was älter ist, steht im Stundenzettel und im Konto —
        // eine endlose Liste alter Anträge auf einer Handy-Seite hilft niemandem.
        antraege: all(
          `SELECT id, start_date, end_date, note, status, days, paid, pay_cents,
                  pay_per_day_cents, decline_reason, requested_at
             FROM vacation_requests
            WHERE user_id = ? AND end_date >= date('now','-365 day')
            ORDER BY start_date DESC`, u.id),
      };
    })(),
    // Die vorige Periode bleibt sichtbar, bis sie abgezeichnet ist — sonst
    // verpasst die Kraft die Bestätigung, sobald der Monat umschlägt.
    vorperiode: (() => {
      const vorher = new Date(new Date(billing.periodOf(today(), t.period_start_day).start + 'T12:00:00Z') - 86400000)
        .toISOString().slice(0, 10);
      const ts = jobsLogic.timesheet(t, u.id, vorher);
      const st = signatur.status(t.id, u.id, ts.period.start, ts.signatur_positionen);
      return ts.signatur_positionen.length && st.zustand !== 'gueltig'
        ? { ...ts, signatur: st, darf_signieren: true } : null;
    })(),
  });
});

// Zu-/Absage
app.post('/api/m/:token/respond', magicUser, (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`,
                  Number(req.body.job_id), req.tenant.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });

  // ⚠️ Auch die ZUSAGE wird verriegelt, nicht nur die Anfrage. Ein Angebot, das
  // vor der Genehmigung des Urlaubs hinausging, liegt weiter in ihrem Postfach —
  // und ein Rundruf-Angebot bleibt offen, bis jemand zusagt. Ohne diesen Riegel
  // wäre der ganze Urlaubsplan mit einem Klick auf eine alte Mail umgangen, und
  // zwar von der Person, die den Urlaub selbst beantragt hat.
  if (req.body.answer === 'yes' && urlaub.imUrlaub(req.cleaner.id, job.due_date)) {
    return res.status(409).json({
      error: `An dem Tag haben Sie genehmigten Urlaub. Wenn Sie doch arbeiten möchten, `
           + `sagen Sie bitte kurz in der Verwaltung Bescheid — der Urlaub muss dafür zurückgenommen werden.`,
    });
  }

  // Zwei Wege führen hierher: eine persönliche Anfrage (der Termin gehört ihr
  // bereits) oder ein Rundruf (er gehört noch niemandem, sie hat ein offenes
  // Angebot). Alles andere geht sie nichts an.
  if (job.assigned_user_id !== req.cleaner.id) {
    // Bewusst OHNE `answer IS NULL`: Wer auf einer veralteten Liste tippt, hat
    // ein bereits geschlossenes Angebot — sie soll „jemand war schneller" lesen
    // und nicht „Termin nicht gefunden". Was daraus wird, entscheidet annehmen().
    const angebot = get(`SELECT id FROM job_offers WHERE job_id = ? AND user_id = ?`,
                        job.id, req.cleaner.id);
    if (!angebot) return res.status(404).json({ error: 'Termin nicht gefunden' });

    if (req.body.answer === 'yes') {
      const zuschlag = rundruf.annehmen(req.tenant, job, req.cleaner);
      if (!zuschlag.ok) {
        return res.status(409).json({
          error: zuschlag.grund === 'vergeben'
            ? 'Jemand war schneller — der Termin ist schon vergeben.'
            : 'Termin nicht gefunden',
        });
      }
      const frisch = get(`SELECT * FROM jobs WHERE id = ?`, job.id);
      vergibZeit(req.tenant, frisch);
      sendCalendar(req.tenant, frisch, req.cleaner, 'REQUEST').catch(() => {});
      // Den anderen Bescheid geben — sonst tippen sie ins Leere und ärgern sich.
      for (const a of zuschlag.zuSpaet) {
        notify.send({ name: a.name, email: a.email, phone: a.phone, channel: a.channel }, {
          subject: `${jobBezeichnung(job, null)} am ${job.due_date} ist vergeben`,
          text: `Hallo ${a.name},\n\nder Termin am ${job.due_date} wurde inzwischen von jemand anderem übernommen. Danke fürs Schauen!`,
        }, req.tenant.id).catch(() => {});
      }
      notifyAdmins(req.tenant, `Zusage: ${job.due_date}`,
        `${req.cleaner.name} hat den Rundruf für den ${job.due_date} angenommen.`);
      return res.json({ ok: true });
    }

    rundruf.ablehnen(req.tenant, job, req.cleaner);
    return res.json({ ok: true });
  }

  if (req.body.answer === 'yes') {
    run(`UPDATE jobs SET confirmed = 1, declined_at = NULL WHERE id = ?`, job.id);
    vergibZeit(req.tenant, job);
    sendCalendar(req.tenant, job, req.cleaner, 'REQUEST').catch(() => {});
  } else {
    const warZugesagt = !!job.confirmed;
    run(`UPDATE jobs SET confirmed = 0, declined_at = ?, assigned_user_id = NULL, start_time = NULL WHERE id = ?`,
        nowSql(), job.id);
    // Nur absagen, was vorher im Kalender stand.
    if (warZugesagt) sendCalendar(req.tenant, job, req.cleaner, 'CANCEL').catch(() => {});
    // ⚠️ Absage heißt SOFORT Rundruf. Vorher fiel der Termin nur auf „offen"
    // zurück und wartete darauf, dass jemand die Mail liest — genau die Lücke,
    // durch die eine Reinigung untergeht. Die Mail an die Verwaltung schreibt
    // jetzt rundrufStarten(), samt Vorgeschichte und Übersprungenen.
    rundrufStarten(req.tenant, job, {
      ausser: [req.cleaner.id],
      anlass: `${req.cleaner.name} hat den Termin am ${job.due_date} abgesagt. Der Rundruf ist sofort rausgegangen.`,
    }).catch(() => {});
  }
  res.json({ ok: true });
});

// Zeiterfassung: Start / Fertig
app.post('/api/m/:token/start', magicUser, (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
                  Number(req.body.job_id), req.tenant.id, req.cleaner.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  const open = get(`SELECT id FROM work_sessions WHERE job_id = ? AND ended_at IS NULL`, job.id);
  if (open) return res.json({ ok: true, already: true });
  run(`INSERT INTO work_sessions(tenant_id, job_id, user_id, started_at) VALUES(?, ?, ?, ?)`,
      req.tenant.id, job.id, req.cleaner.id, nowSql());
  res.json({ ok: true });
});

app.post('/api/m/:token/done', magicUser, (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
                  Number(req.body.job_id), req.tenant.id, req.cleaner.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  run(`UPDATE work_sessions SET ended_at = ? WHERE job_id = ? AND ended_at IS NULL`, nowSql(), job.id);
  run(`UPDATE jobs SET status = 'done' WHERE id = ?`, job.id);
  res.json({ ok: true, pay: jobsLogic.jobPay(req.tenant, get(`SELECT * FROM jobs WHERE id = ?`, job.id)) });
});

// Stundenzettel abzeichnen
app.post('/api/m/:token/sign', magicUser, (req, res) => {
  const t = req.tenant, u = req.cleaner;
  const stichtag = String(req.body.period_start || today());
  const ts = jobsLogic.timesheet(t, u.id, stichtag);
  if (!ts.signatur_positionen.length) return res.status(400).json({ error: 'Für diesen Zeitraum gibt es nichts abzuzeichnen' });
  if (!signatur.darfSignieren(ts.period)) {
    return res.status(400).json({ error: 'Der Zeitraum läuft noch — Abzeichnen ab den letzten drei Tagen' });
  }
  signatur.signieren(t.id, u.id, ts.period.start, ts.signatur_positionen, {
    name: u.name, totalCents: ts.total_cents,
    ip: req.ip, userAgent: req.headers['user-agent'],
  });
  res.json({ ok: true, signatur: signatur.status(t.id, u.id, ts.period.start, ts.signatur_positionen) });
});

// Checklistenpunkt abhaken
app.post('/api/m/:token/check', magicUser, (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
                  Number(req.body.job_id), req.tenant.id, req.cleaner.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  const ok = checkliste.toggle(req.tenant.id, job, Number(req.body.item_id), req.cleaner.id, !!req.body.done);
  if (!ok) return res.status(404).json({ error: 'Punkt nicht gefunden' });
  res.json({ ok: true, checkliste: checkliste.forJob(req.tenant.id, job) });
});

// Foto zu einem Punkt. Roher Bild-Body statt Multipart — spart eine Abhängigkeit,
// und die Oberfläche verkleinert das Bild ohnehin vor dem Hochladen.
app.post('/api/m/:token/foto/:itemId',
  express.raw({ type: ['image/jpeg', 'image/png'], limit: '8mb' }),
  (req, res, next) => magicUser(req, res, next),
  (req, res) => {
    const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
                    Number(req.query.job_id), req.tenant.id, req.cleaner.id);
    if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Kein Bild empfangen' });
    checkliste.savePhoto(req.tenant.id, job, Number(req.params.itemId), req.cleaner.id,
                         req.body, req.headers['content-type'] || 'image/jpeg');
    res.json({ ok: true, checkliste: checkliste.forJob(req.tenant.id, job) });
  });

// Foto ausliefern. NIE öffentlich: nur die zugeteilte Kraft über ihren Link oder
// die Verwaltung des Mandanten. Der Dateiname allein reicht nicht.
function sendFoto(req, res, tenantId, jobId, itemId) {
  const c = get(`SELECT * FROM job_checks WHERE tenant_id = ? AND job_id = ? AND item_id = ?`,
                tenantId, jobId, itemId);
  if (!c || !c.photo_file) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(checkliste.photoPath(c.photo_file));
}

app.get('/api/m/:token/foto/:jobId/:itemId', magicUser, (req, res) => {
  const job = get(`SELECT id FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
                  Number(req.params.jobId), req.tenant.id, req.cleaner.id);
  if (!job) return res.status(404).end();
  sendFoto(req, res, req.tenant.id, job.id, Number(req.params.itemId));
});

app.get('/api/foto/:jobId/:itemId', requireTenant, auth.requireAdmin, (req, res) => {
  sendFoto(req, res, req.tenant.id, Number(req.params.jobId), Number(req.params.itemId));
});

// Zeiten nachtragen/korrigieren (von/bis am Job-Datum)
app.post('/api/m/:token/time', magicUser, (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
                  Number(req.body.job_id), req.tenant.id, req.cleaner.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  const { from, to } = req.body;
  if (!/^\d{2}:\d{2}$/.test(from || '') || !/^\d{2}:\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'Zeiten im Format HH:MM angeben' });
  }
  const started = `${job.due_date} ${from}:00`;
  const ended = `${job.due_date} ${to}:00`;
  if (ended <= started) return res.status(400).json({ error: '„bis" muss nach „von" liegen' });
  run(`DELETE FROM work_sessions WHERE job_id = ?`, job.id);
  run(`INSERT INTO work_sessions(tenant_id, job_id, user_id, started_at, ended_at) VALUES(?, ?, ?, ?, ?)`,
      req.tenant.id, job.id, req.cleaner.id, started, ended);
  run(`UPDATE jobs SET status = 'done' WHERE id = ?`, job.id);
  res.json({ ok: true });
});

// ===========================================================================
// Registrierung — der einzige Weg, wie ein Mandant entsteht
// ===========================================================================

// Vorschlag, Prüfung und gesperrte Namen stehen in `src/slug.js` — dort steht auch,
// warum die Adresse sprechend sein muss und warum sie unumkehrbar ist.
function vergeben(kandidat) {
  return slugs.GESPERRT.has(kandidat) || !!get(`SELECT id FROM tenants WHERE slug = ?`, kandidat);
}

function freierSlug(name) {
  const basis = slugs.vorschlag(name);
  let kandidat = basis, n = 1;
  while (vergeben(kandidat)) {
    kandidat = `${basis}-${++n}`;
    if (n > 50) return null;
  }
  return kandidat;
}

// Verfügbarkeit für das Anmeldeformular. ⚠️ Gedrosselt und ohne Nebenwirkung: Die
// Antwort sagt nur „frei" oder „belegt", nie WEM eine Adresse gehört — sonst wäre
// der Endpunkt ein Verzeichnis unserer Kunden.
const slugGefragt = new Map();
app.get('/api/slug-frei', (req, res) => {
  if (!zaehle(slugGefragt, req.ip, 120)) return res.status(429).json({ error: 'Zu viele Anfragen' });
  const s = String(req.query.slug || '').trim().toLowerCase();
  const fehler = slugs.pruefe(s);
  if (fehler) return res.json({ frei: false, grund: fehler });
  if (vergeben(s)) return res.json({ frei: false, grund: 'Diese Adresse ist schon vergeben' });
  res.json({ frei: true });
});

// Stiller Ausfall an der Kasse: Zwischen dem 26.07. und dem 21.08.2026 konnte sich
// niemand anmelden, und NICHTS hat es gemeldet — kein Log, das jemand liest, kein
// Ausschlag im Störungs-Board. Aufgefallen ist es, weil ein Interessent nach sieben
// Fehlversuchen von Hand eine Mail geschrieben hat. Der eigentliche Schaden war
// nicht die Datenbankspalte, sondern dass sie drei Wochen unbemerkt bleiben konnte.
//
// ⚠️ Der Alarm darf den Aufrufer NIE mitreißen: Er läuft im Hintergrund und
// verschluckt seine eigenen Fehler. Ein Mailserver, der gerade nicht antwortet,
// darf nicht der Grund sein, warum aus einem Fehler zwei werden.
// ⚠️ OHNE `ALARM_EMAIL` geht NICHTS raus — nur ins Log. Hier stand bis zum
// 21.08.2026 ein Rückfall auf `hallo@putzflow.de`, und das war ein Leck: `server.js`
// geht in den öffentlichen Export (`_ops/oss-export.sh`). Jede fremde Instanz hätte
// UNS ungefragt Mails über IHRE Kunden geschickt — Firmenname, Adresse, Fehlertext —,
// ohne dass jemand das eingerichtet hätte. Ein Standardwert, der Post an den
// Hersteller schickt, ist keine Bequemlichkeit, sondern eine Wanze.
function benachrichtige(betreff, text) {
  const an = process.env.ALARM_EMAIL;
  if (!an) return console.log(`[melden] ${betreff} (ALARM_EMAIL nicht gesetzt — nur im Log)`);
  notify.send({ name: 'Putzflow', email: an, channel: 'mail' }, {
    subject: `Putzflow: ${betreff}`,
    text: `${text}\n\n— automatisch gemeldet von ${BASE_URL}`,
  }).catch(e => console.error('[melden] konnte nicht zugestellt werden:', e.message));
}

function alarm(betreff, text) {
  console.error(`[alarm] ${betreff}`);
  benachrichtige(`⚠️ ${betreff}`, text);
}

// Bremse gegen Massenanlage. Zwei getrennte Zähler, und das ist der Punkt:
// ABGEWIESENE Versuche dürfen nicht dasselbe Gewicht haben wie erfolgreiche.
// Sonst sperrt sich aus, wer sich dreimal vertippt.
const versuche = new Map();      // alle Anläufe, großzügig
const angelegt = new Map();      // tatsächlich entstandene Konten, streng
function zaehle(karte, ip, grenze, { nurPruefen = false } = {}) {
  const jetzt = Date.now();
  const liste = (karte.get(ip) || []).filter(t => jetzt - t < 3600_000);
  if (liste.length >= grenze) { karte.set(ip, liste); return false; }
  // `nurPruefen` trennt „darf noch" von „hat gerade". Wer erst nach getaner Arbeit
  // zählt, bestraft niemanden für einen Fehlschlag, den er nicht zu verantworten hat.
  if (!nurPruefen) { liste.push(jetzt); karte.set(ip, liste); }
  return true;
}

// Was die Verkaufsseite anzeigen darf. Öffentlich und ohne Geheimnis: die blosse
// Zahl freier Plätze verrät nichts über einzelne Kunden.
app.get('/api/aktion', (req, res) => {
  const frei = freiePlaetze();
  res.json({ plaetze: AKTION_PLAETZE, frei, monate: Math.round(AKTION_TAGE / 30.5) });
});

app.post('/api/register', async (req, res) => {
  if (!zaehle(versuche, req.ip, 30)) {
    return res.status(429).json({ error: 'Zu viele Anläufe von hier. Bitte in einer Stunde erneut.' });
  }

  const firma = String(req.body.firma || '').trim();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const passwort = String(req.body.password || '');
  // ⚠️ KEIN Bundesland bei der Anmeldung. Es wird NUR gebraucht, wenn der Betrieb
  // Feiertagszuschläge zahlt — das ist freiwillig und weiß beim Anmelden noch
  // niemand. Also später in den Einstellungen, mit Begründung an Ort und Stelle.
  // Bis dahin gelten die bundesweiten Feiertage (siehe holidays.js); dass die
  // Angabe fehlt, macht die Oberfläche sichtbar, statt still NRW anzunehmen.
  const anschrift = {
    street: String(req.body.street || '').trim(),
    zip: String(req.body.zip || '').trim(),
    city: String(req.body.city || '').trim(),
    country: String(req.body.country || 'DE').toUpperCase(),
  };
  const telefon = String(req.body.phone || '').trim();

  // Der Reihe nach prüfen und den ERSTEN Fehler melden — eine Liste von fünf
  // Beanstandungen liest niemand.
  const fehler = pruefung.pruefeBetrieb(firma)
    || pruefung.pruefeName(name)
    || pruefung.pruefeEmail(email)
    || pruefung.pruefeAnschrift(anschrift)
    || pruefung.pruefeTelefon(telefon)

    || (passwort.length < 8 ? 'Passwort mit mindestens 8 Zeichen wählen' : null);
  if (fehler) return res.status(400).json({ error: fehler });
  // ⚠️ NUR eigene Konten sperren die Anmeldung, nicht jede Erwähnung der Adresse.
  // Vorher stand hier `WHERE email = ?` ohne `tenant_id` — global über alle
  // Mandanten. Das war strenger als die Bedingung, die es schützen sollte
  // (`idx_users_email` ist auf `(tenant_id, email)` eindeutig), und es hat am
  // 20.08.2026 einen Interessenten zwölfmal abgewiesen: Er hatte sich in der
  // öffentlichen DEMO als Reinigungskraft eingetragen — genau das, wozu die
  // Verkaufsseite einlädt — und war damit für die Anmeldung gesperrt. Die
  // Meldung behauptete, er habe schon ein Konto; er suchte daraufhin eine
  // Anmeldeseite, die es nicht gab.
  //
  // Wer bei einem fremden Betrieb putzt, darf seinen eigenen aufmachen. Nur wer
  // schon selbst einen führt, wird zu seiner Adresse geschickt — mit der Adresse,
  // nicht mit einer Sackgasse.
  const eigenes = get(
    `SELECT t.slug FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = ? AND u.role IN ('owner', 'admin')
         AND t.is_demo = 0 AND t.active = 1`, email);
  if (eigenes) {
    // ⚠️ Adresse aus BASE_URL, nicht `putzflow.de` hingeschrieben. Auf einer selbst
    // betriebenen Instanz schickte ein fester Name den Kunden zu uns statt zu sich.
    return res.status(400).json({
      error: `Zu dieser Adresse gibt es schon ein Konto — Sie melden sich unter `
           + `${BASE_URL.replace('://', `://${eigenes.slug}.`)} an. `
           + `Passwort vergessen? Dort steht der Link dafür.`,
    });
  }

  // ⚠️ Die Adresse ist UNUMKEHRBAR — sie steckt im Magic-Link jeder Putzkraft, im
  // Lesezeichen des Betreibers und in der Webhook-Adresse bei Smoobu. Deshalb darf
  // der Kunde sie SELBST bestimmen; das Formular schlägt nur vor. Wer nichts angibt
  // (etwa ein Aufruf ohne Browser), bekommt den Vorschlag.
  let slug;
  const gewuenscht = String(req.body.slug || '').trim().toLowerCase();
  if (gewuenscht) {
    const slugFehler = slugs.pruefe(gewuenscht);
    if (slugFehler) return res.status(400).json({ error: slugFehler });
    // ⚠️ Hier NICHT hochzählen wie beim Vorschlag. Wer eine Adresse ausdrücklich
    // eintippt, will genau die — `feeling-at-home-2` wäre keine Antwort auf seinen
    // Wunsch, sondern eine stille Ersetzung.
    if (vergeben(gewuenscht)) {
      return res.status(400).json({ error: 'Diese Adresse ist schon vergeben — bitte eine andere wählen' });
    }
    slug = gewuenscht;
  } else {
    slug = freierSlug(firma);
    if (!slug) return res.status(400).json({ error: 'Für diesen Namen finden wir keine freie Adresse' });
  }

  // ⚠️ Nur PRÜFEN, noch nicht zählen. Gezählt wird erst, wenn wirklich ein Konto
  // entstanden ist (unten). Vorher zählte schon der Versuch — und weil das Anlegen
  // durch den `region`-Fehler jedes Mal abstürzte, hat unser eigener Absturz den
  // Besucher nach drei Anläufen für eine Stunde ausgesperrt, mit der Meldung, er
  // habe „gerade mehrere Konten angelegt". Er hatte kein einziges.
  if (!zaehle(angelegt, req.ip, 3, { nurPruefen: true })) {
    return res.status(429).json({ error: 'Von hier wurden gerade mehrere Konten angelegt. Bitte später erneut.' });
  }

  // Sechs Wochen, aufgerundet auf das Ende der Abrechnungsperiode (siehe billing.js).
  // ⚠️ Für die ersten `AKTION_PLAETZE` Kunden stattdessen ein halbes Jahr. Es gibt
  // dafür KEIN eigenes Feld: Ein Gebührenurlaub IST ein längerer Testzeitraum, und
  // `trial_ends_at` wird von der Schreibsperre und vom Rechnungslauf schon
  // respektiert. Ein zweiter Mechanismus daneben wäre eine zweite Wahrheit.
  // ⚠️ Endgültig entschieden wird erst IN der Transaktion unten — sonst könnten
  // zwei gleichzeitige Anmeldungen denselben letzten Platz bekommen.
  const aktionMoeglich = freiePlaetze() > 0;
  const testEnde = billing.trialEnd(today(), billing.PERIOD_START_DAY,
                                    aktionMoeglich ? AKTION_TAGE : TESTTAGE);
  const bestaetigung = auth.randToken(24);
  // region ausdrücklich NULL — kein stiller Rückfall auf NRW. Damit das auf einer
  // Bestandsdatenbank nicht an `NOT NULL` scheitert, nimmt `db.js` die Bedingung
  // beim Start von der Spalte (`notNullLoesen`). Vom 26.07. bis zum 21.08.2026
  // fehlte dieser Schritt, und die Anmeldung war die ganze Zeit tot.
  //
  // Herkunft: was in der Anzeigen-URL stand, sonst die verweisende Seite.
  // ⚠️ Gedeckelt und von Steuerzeichen befreit — der Wert kommt vom Browser und
  // landet später in der Betreiberliste.
  const herkunft = String(req.body.herkunft || req.get('referer') || '')
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || null;

  // ⚠️ Die drei Einfügungen gehören zusammen. Ohne Transaktion hinterließe ein
  // Fehler in der Mitte einen Mandanten ohne Eigentümer — der Slug wäre vergeben,
  // aber niemand käme hinein, und der zweite Anlauf mit derselben Adresse liefe
  // in einen anderen Slug. Genau diesen Zustand hätte der 20.08. erzeugt, wäre er
  // eine Zeile später gescheitert.
  let t;
  try {
    dbmod.db.exec('BEGIN');
    run(`INSERT INTO tenants(slug, name, region, trial_ends_at, street, zip, city, country, phone, verify_token, herkunft)
         VALUES(?,?,NULL,?,?,?,?,?,?,?,?)`,
        slug, firma, testEnde, anschrift.street, anschrift.zip, anschrift.city,
        anschrift.country, telefon || null, bestaetigung, herkunft);
    t = get(`SELECT * FROM tenants WHERE slug = ?`, slug);
    // Mandanten-Default für die Vergütung, sonst steht die erste Zuteilung ohne Betrag da.
    run(`INSERT INTO comp_rules(tenant_id, mode, base_cents, premium_on, premium_mode, premium_cents)
         VALUES(?, 'flat', 2250, 'weekend_holiday', 'rate', 3000)`, t.id);
    run(`INSERT INTO users(tenant_id, email, name, role, password_hash) VALUES(?,?,?,'owner',?)`,
        t.id, email, name, auth.hashPassword(passwort));
    dbmod.db.exec('COMMIT');
  } catch (e) {
    dbmod.db.exec('ROLLBACK');
    // ⚠️ Eine gescheiterte Anmeldung MUSS wehtun, sofort und bei uns. Drei Wochen
    // lang konnte sich niemand anmelden, ohne dass es aufgefallen wäre — gemerkt
    // hat es ein Interessent, der sieben Anläufe gebraucht und dann geschrieben
    // hat. Das darf sich nicht wiederholen: Jeder Fehlschlag geht als Mail raus.
    // Ohne die Eingaben des Besuchers, nur mit dem, was zur Reparatur nötig ist.
    console.error(`[registrierung] gescheitert für ${slug}:`, e.stack || e.message);
    alarm('Registrierung gescheitert',
          `Auf ${BASE_URL} konnte sich gerade jemand NICHT anmelden.\n\n`
          + `Betrieb: ${firma}\nAdresse (Slug): ${slug}\nHerkunft: ${herkunft || 'unbekannt'}\n\n`
          + `Fehler: ${e.message}\n\n`
          + `Der Besucher hat eine Entschuldigung mit der Bitte bekommen, sich zu melden.`);
    throw e;   // die Fehlerbehandlung ganz unten schickt die saubere 500 raus
  }

  // Jetzt erst zählt es als Anlage — ein Fehlschlag darf niemanden aussperren.
  zaehle(angelegt, req.ip, 3);


  const adresse = BASE_URL.replace('://', `://${slug}.`);
  const bestaetigungsLink = `${BASE_URL}/bestaetigen/${bestaetigung}`;
  notify.send({ name, email, channel: 'mail' }, {
    subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse — Putzflow',
    text: `Hallo ${name},\n\nbitte bestätigen Sie zuerst diese Adresse — ein Klick genügt:\n\n` +
          `${bestaetigungsLink}\n\nDanach steht Ihr Zugang bereit:\n\n${adresse}\n\n` +
          `Anmelden mit ${email} und Ihrem Passwort.\n\n` +
          `Als Erstes lohnt sich der Reiter „Unterkünfte": dort legen Sie Ihre Wohnungen an ` +
          `oder verbinden Smoobu, und Sie hinterlegen Ihre Checklisten. Danach im Reiter ` +
          `„Team" die Reinigungskräfte — die bekommen ihren persönlichen Link und brauchen ` +
          `weder App noch Passwort.\n\n` +
          `Ihr Testzeitraum läuft bis zum ${fmt.tag(testEnde)} — sechs Wochen, ` +
          `aufgerundet auf das Ende Ihrer ersten vollständigen Abrechnungsperiode. ` +
          `Zahlungsdaten brauchen Sie dafür nicht anzugeben.`,
    link: bestaetigungsLink,
  }, t.id).catch(() => {});

  // ⚠️ Eine neue Anmeldung ist das seltenste und wichtigste Ereignis, das dieses
  // System kennt — und bis zum 21.08.2026 hätte sie niemand bemerkt. Gemeldet wurde
  // nur der Fehlschlag; ein Erfolg blieb genauso still wie vorher der Ausfall.
  // Wer wissen will, ob sein Produkt lebt, darf nicht in eine Datenbank schauen
  // müssen.
  const anschriftZeile = [anschrift.street, `${anschrift.zip} ${anschrift.city}`.trim(), anschrift.country]
    .filter(Boolean).join(', ');
  benachrichtige(`neue Anmeldung — ${firma}`,
    `${firma} hat sich gerade angemeldet.\n\n`
    + `Adresse:   ${adresse}\n`
    + `Name:      ${name}\n`
    + `E-Mail:    ${email}\n`
    + `Anschrift: ${anschriftZeile}\n`
    + (telefon ? `Telefon:   ${telefon}\n` : '')
    + `Herkunft:  ${herkunft || 'unbekannt'}\n`
    + `Testphase: bis ${fmt.tag(testEnde)}\n\n`
    + `Die Willkommensmail zum Bestätigen der Adresse ist unterwegs. Solange sie nicht `
    + `bestätigt ist, kann der Betrieb seinen Smoobu-Zugang noch nicht hinterlegen.`);

  res.json({ ok: true, slug, url: adresse, trial_ends_at: testEnde });
});

// Bestätigung der E-Mail-Adresse. Der Link kommt aus der Willkommensmail.
app.get('/bestaetigen/:token', (req, res) => {
  noCacheHtml(res);
  const t = get(`SELECT * FROM tenants WHERE verify_token = ?`, String(req.params.token));
  if (!t) {
    return res.status(404).send(page('Link ungültig',
      '<p>Dieser Bestätigungslink gilt nicht mehr. Melden Sie sich in Ihrem Konto an — dort können Sie eine neue Bestätigung anfordern.</p>'));
  }
  if (!t.email_verified_at) {
    run(`UPDATE tenants SET email_verified_at = ?, verify_token = NULL WHERE id = ?`,
        new Date().toISOString(), t.id);
  }
  const ziel = BASE_URL.replace('://', `://${t.slug}.`);
  res.send(page('Adresse bestätigt',
    `<p>Danke — Ihre E-Mail-Adresse ist bestätigt.</p>
     <p><a href="${ziel}">Weiter zu ${t.slug}.putzflow.de</a></p>`));
});

// ===========================================================================
// „Wie heißt noch mal meine Adresse?"
// ===========================================================================
// ⚠️ Es gibt bewusst KEINE zentrale Anmeldung: Jeder Betrieb meldet sich unter
// seiner eigenen Adresse an, damit ein Formular nie zwischen gleichnamigen
// Konten raten muss. Der Preis dafür ist, dass `putzflow.de/login` naheliegt —
// und dort stand bis zum 21.08.2026 ein nacktes „Diese Seite gibt es nicht".
// Ein Interessent ist genau da gelandet, nachdem ihn die Anmeldung fälschlich
// weggeschickt hatte. Zwei Sackgassen hintereinander, und beide waren unsere.
for (const pfad of ['/login', '/anmelden']) {
  app.get(pfad, (req, res, next) => {
    // ⚠️ Nur auf der Hauptdomain. Auf `ihrbetrieb.putzflow.de` wäre der Hinweis
    // „Ihr Betrieb hat eine eigene Adresse" an genau der Stelle, wo man schon ist.
    if (req.tenant || !istOeffentlicheSeite(req)) return next();
    noCacheHtml(res);
    res.send(page('Anmelden', `
      <p>Jeder Betrieb hat bei Putzflow seine eigene Adresse — etwa
      <code>ihrbetrieb.putzflow.de</code>. Dort melden Sie sich an.</p>
      <p>Nicht mehr im Kopf? Tragen Sie Ihre E-Mail-Adresse ein, wir schicken sie Ihnen.</p>
      <form method="post" action="/api/adresse-vergessen" id="f"
            style="display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0">
        <input name="email" type="email" required placeholder="ihre@adresse.de"
               style="flex:1;min-width:14rem;padding:.6rem;border:1px solid #ccc;border-radius:.5rem">
        <button style="padding:.6rem 1rem;border:0;border-radius:.5rem;background:#1c2024;color:#fff">
          Adresse schicken</button>
      </form>
      <p id="m" hidden></p>
      <p style="font-size:.9rem;color:#666">Noch kein Konto?
      <a href="/#anmelden">Sechs Wochen kostenlos testen</a>.</p>
      <script>
        document.getElementById('f').addEventListener('submit', async ev => {
          ev.preventDefault();
          const m = document.getElementById('m');
          await fetch('/api/adresse-vergessen', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: ev.target.email.value }),
          }).catch(() => {});
          m.hidden = false;
          m.textContent = 'Wenn es zu dieser Adresse ein Konto gibt, ist die Mail unterwegs.';
          ev.target.hidden = true;
        });
      </script>`));
  });
}

// ⚠️ Antwortet IMMER gleich, egal ob es die Adresse gibt. Sonst wäre das Formular
// ein Auskunftsschalter darüber, wer Kunde ist. Aus demselben Grund gedrosselt.
const adresseGefragt = new Map();
app.post('/api/adresse-vergessen', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const immer = { ok: true };
  if (!email || !zaehle(adresseGefragt, req.ip, 5)) return res.json(immer);

  const konten = all(
    `SELECT t.slug, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = ? AND u.role IN ('owner', 'admin')
         AND t.is_demo = 0 AND t.active = 1 ORDER BY t.name`, email);
  if (!konten.length) return res.json(immer);

  const liste = konten
    .map(k => `${k.name}\n${BASE_URL.replace('://', `://${k.slug}.`)}`)
    .join('\n\n');
  notify.send({ name: '', email, channel: 'mail' }, {
    subject: 'Ihre Putzflow-Adresse',
    text: `Hallo,\n\nSie melden sich hier an:\n\n${liste}\n\n`
        + `Passwort vergessen? Auf der Anmeldeseite steht der Link dafür.\n\n`
        + `Wenn Sie danach nicht gefragt haben, können Sie diese Mail übergehen — `
        + `es ist nichts geschehen.`,
  }).catch(e => console.error('[adresse-vergessen]', e.message));
  res.json(immer);
});

// Neue Bestätigung anfordern
app.post('/api/verify/resend', requireTenant, auth.requireAdmin, (req, res) => {
  if (req.tenant.email_verified_at) return res.json({ ok: true, schon: true });
  const token = req.tenant.verify_token || auth.randToken(24);
  run(`UPDATE tenants SET verify_token = ? WHERE id = ?`, token, req.tenant.id);
  notify.send({ name: req.user.name, email: req.user.email, channel: 'mail' }, {
    subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse — Putzflow',
    text: `Hallo ${req.user.name},\n\nbitte bestätigen Sie Ihre Adresse mit einem Klick:`,
    link: `${BASE_URL}/bestaetigen/${token}`,
  }, req.tenant.id).catch(() => {});
  res.json({ ok: true });
});

// ===========================================================================
// Ersteinrichtung — der Weg hinein auf einer selbst betriebenen Instanz
// ===========================================================================
// Sichtbar nur, solange es keinen echten Betrieb gibt (src/einrichtung.js).
// Auf putzflow.de ist das seit dem ersten Kunden dauerhaft zu; wer Putzflow
// selbst betreibt, kommt hier hinein, ohne dass Mailversand schon steht.

app.get('/einrichtung', (req, res) => {
  noCacheHtml(res);
  if (!einrichtung.offen()) {
    return res.status(404).send(page('Schon eingerichtet',
      '<p>Auf dieser Instanz gibt es bereits einen Betrieb. Die Ersteinrichtung ist damit ' +
      'geschlossen — weitere Konten legt die Verwaltung im Reiter „Team" an.</p>'));
  }
  res.sendFile(path.join(PUBLIC, 'einrichtung.html'));
});

app.get('/api/einrichtung', (req, res) => {
  res.json({
    offen: einrichtung.offen(),
    // Läuft die Instanz unter einer Adresse ohne Subdomain (IP, Tailnet,
    // localhost), gibt es später nur EINEN Betrieb — die Seite fragt dann gar
    // nicht erst nach Mandanten und Subdomains.
    einzelbetrieb: !require('./src/tenant').slugFromHost(req.headers.host),
    host: String(req.headers.host || ''),
  });
});

app.post('/api/einrichtung', (req, res) => {
  if (!einrichtung.offen()) {
    return res.status(409).json({ error: 'Auf dieser Instanz gibt es bereits einen Betrieb.' });
  }
  // ⚠️ Erst bremsen, dann prüfen: Der Code ist kurz genug, dass er sich sonst
  // durchprobieren ließe. Zehn Anläufe in der Stunde reichen für Tippfehler.
  if (!zaehle(versuche, req.ip, 10)) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte in einer Stunde erneut.' });
  }
  if (!einrichtung.codeStimmt(req.body.code)) {
    return res.status(403).json({ error: 'Der Einrichtungscode stimmt nicht.' });
  }

  const firma = String(req.body.firma || '').trim();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const passwort = String(req.body.password || '');
  // Anschrift und Telefon bleiben hier außen vor: Sie stehen im Anmeldeformular,
  // weil wir daraus eine Rechnung stellen. Wer selbst betreibt, bekommt von uns
  // keine — und eine Pflichtangabe ohne Zweck ist eine Hürde ohne Gegenwert.
  //
  // ⚠️ Die E-Mail-Adresse wird hier NUR auf ihre Form geprüft — keine
  // Wegwerf-Domains, keine Platzhalter-Namen. Diese Regeln aus `pruefung.js`
  // schützen unsere Kundenliste vor Unsinns-Anmeldungen; auf einer eigenen
  // Instanz gibt es niemanden, den sie schützen könnten. Angemeldet wird mit
  // Adresse UND Passwort, beides eben selbst getippt: Ein Vertipper sperrt
  // niemanden aus. Wer seine Testinstanz mit `admin@example.com` einrichtet,
  // soll das dürfen.
  const fehler = pruefung.pruefeBetrieb(firma)
    || pruefung.pruefeName(name)
    || (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) ? null : 'Die E-Mail-Adresse sieht nicht richtig aus')
    || (passwort.length < 8 ? 'Passwort mit mindestens 8 Zeichen wählen' : null);
  if (fehler) return res.status(400).json({ error: fehler });

  const slug = freierSlug(firma);
  if (!slug) return res.status(400).json({ error: 'Für diesen Namen finden wir keine freie Adresse' });

  const t = einrichtung.anlegen({ slug, firma, name, email, passwort });

  // Kein Testzeitraum und keine Schreibsperre beim Selbstbetrieb: `trial_ends_at`
  // bleibt NULL. Die Sperre ist unser Kassenmechanismus, nicht Fachlogik —
  // auf einer eigenen Instanz hätte sie niemanden, der sie aufheben könnte.
  // ⚠️ Hier wird NICHTS in die .env geschrieben. Der Mandant wird gefunden,
  // weil er als einziger `selbstbetrieb = 1` trägt (`tenant.einzelbetrieb()`) —
  // das überlebt jeden Neustart und funktioniert auch unter einer gehärteten
  // systemd-Unit, in der das Anwendungsverzeichnis schreibgeschützt ist.
  const einzeln = !require('./src/tenant').slugFromHost(req.headers.host);
  const url = einzeln
    ? `${req.protocol}://${req.headers.host}/`
    : BASE_URL.replace('://', `://${slug}.`);

  console.log(`[einrichtung] Betrieb „${firma}" angelegt (slug ${slug}, Inhaber ${email}).`);
  res.json({ ok: true, slug, url, einzelbetrieb: einzeln });
});

// Testzeitraum einmalig verlängern. Bewusst als Selbstbedienung MIT Benachrichtigung
// an uns: Der Kunde wird nicht ausgebremst, wir erfahren aber, dass er noch überlegt —
// und haben einen Anlass, ihn anzusprechen. Genau diese Rückmeldung fehlt sonst.
// --- Sonderausgaben --------------------------------------------------------
// Eine Kraft legt etwas aus (Kaffeekapseln, Müllbeutel, Ersatzschlüssel). Sie meldet
// es über ihren Link, die Verwaltung genehmigt, dann steht es auf dem Stundenzettel.
// ⚠️ Getrennt gehalten: das Geld ist Auslagenersatz, die Zeit ist Arbeitszeit.
function auslageAus(req, body) {
  const betrag = Math.round(Number(String(body.amount_cents ?? '').toString().replace(',', '.')) || 0);
  const minuten = Math.max(0, Math.round(Number(body.minutes) || 0));
  const text = String(body.description || '').trim();
  if (!text) return { fehler: 'Wofür war die Ausgabe?' };
  if (betrag < 0) return { fehler: 'Der Betrag darf nicht negativ sein' };
  if (!betrag && !minuten) return { fehler: 'Bitte einen Betrag oder eine Zeit angeben' };
  // Ein Datum in der Zukunft wäre entweder ein Tippfehler oder eine Vorausbuchung —
  // beides gehört nicht in eine Abrechnung.
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : today();
  if (datum > today()) return { fehler: 'Das Datum liegt in der Zukunft' };
  return { datum, text, betrag, minuten };
}

app.get('/api/m/:token/auslagen', magicUser, (req, res) => {
  const periode = billing.periodOf(today(), req.tenant.period_start_day);
  const satz = auslagen.stundensatzCents(
    jobsLogic.resolveRule(req.tenant.id, null, req.cleaner.id), [], periode.start);
  const rows = auslagen.fuerPeriode(req.tenant.id, req.cleaner.id, periode.start, periode.end);
  res.json({ periode, ...auslagen.aufbereiten(rows, satz) });
});

app.post('/api/m/:token/auslagen', magicUser, (req, res) => {
  const a = auslageAus(req, req.body || {});
  if (a.fehler) return res.status(400).json({ error: a.fehler });
  const job = req.body.job_id
    ? get(`SELECT id FROM jobs WHERE id = ? AND tenant_id = ? AND assigned_user_id = ?`,
          Number(req.body.job_id), req.tenant.id, req.cleaner.id)
    : null;
  run(`INSERT INTO expenses(tenant_id, user_id, job_id, date, description, amount_cents, minutes)
       VALUES(?,?,?,?,?,?,?)`,
      req.tenant.id, req.cleaner.id, job ? job.id : null, a.datum, a.text, a.betrag, a.minuten);
  const id = get(`SELECT last_insert_rowid() AS id`).id;
  notifyAdmins(req.tenant, `Auslage: ${req.cleaner.name}`,
    `${req.cleaner.name} hat eine Auslage gemeldet:\n\n${a.text}\n` +
    `${fmt.euro(a.betrag)}${a.minuten ? ` und ${a.minuten} Minuten` : ''} am ${fmt.tag(a.datum)}.\n\n` +
    `Sie erscheint erst auf dem Stundenzettel, wenn Sie sie freigeben.`);
  res.json({ ok: true, id });
});

// Solange nichts entschieden ist, darf die Kraft ihre eigene Meldung zurückziehen —
// danach nicht mehr, sonst verschwände Genehmigtes aus einem abgezeichneten Zettel.
app.delete('/api/m/:token/auslagen/:id', magicUser, (req, res) => {
  const a = get(`SELECT * FROM expenses WHERE id = ? AND tenant_id = ? AND user_id = ?`,
                Number(req.params.id), req.tenant.id, req.cleaner.id);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  if (a.approved_at) return res.status(400).json({ error: 'Bereits freigegeben — bitte in der Verwaltung melden' });
  run(`DELETE FROM expenses WHERE id = ?`, a.id);
  res.json({ ok: true });
});

app.post('/api/m/:token/auslagen/:id/beleg',
  express.raw({ type: ['image/jpeg', 'image/png'], limit: '8mb' }),
  (req, res, next) => magicUser(req, res, next),
  (req, res) => {
    const a = get(`SELECT * FROM expenses WHERE id = ? AND tenant_id = ? AND user_id = ?`,
                  Number(req.params.id), req.tenant.id, req.cleaner.id);
    if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Kein Bild empfangen' });
    auslagen.speichereBeleg(req.tenant.id, a.id, req.body, req.headers['content-type'] || 'image/jpeg');
    res.json({ ok: true });
  });

function sendBeleg(res, tenantId, id) {
  const a = get(`SELECT receipt_file FROM expenses WHERE id = ? AND tenant_id = ?`, id, tenantId);
  if (!a || !a.receipt_file) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(auslagen.belegPfad(a.receipt_file));
}

app.get('/api/m/:token/auslagen/:id/beleg', magicUser, (req, res) => {
  const a = get(`SELECT id FROM expenses WHERE id = ? AND tenant_id = ? AND user_id = ?`,
                Number(req.params.id), req.tenant.id, req.cleaner.id);
  if (!a) return res.status(404).end();
  sendBeleg(res, req.tenant.id, a.id);
});

// Verwaltung: freigeben, ablehnen, korrigieren, selbst eintragen.
app.get('/api/expenses/:id/beleg', requireTenant, auth.requireAdmin, (req, res) => {
  sendBeleg(res, req.tenant.id, Number(req.params.id));
});

app.post('/api/expenses', requireTenant, auth.requireAdmin, (req, res) => {
  const a = auslageAus(req, req.body || {});
  if (a.fehler) return res.status(400).json({ error: a.fehler });
  const user = get(`SELECT id FROM users WHERE id = ? AND tenant_id = ?`,
                   Number(req.body.user_id), req.tenant.id);
  if (!user) return res.status(400).json({ error: 'Person nicht gefunden' });
  // Was die Verwaltung selbst einträgt, ist damit auch freigegeben — sonst müsste
  // sie ihre eigene Eingabe noch einmal bestätigen.
  run(`INSERT INTO expenses(tenant_id, user_id, date, description, amount_cents, minutes,
                            approved_at, approved_by)
       VALUES(?,?,?,?,?,?,?,?)`,
      req.tenant.id, user.id, a.datum, a.text, a.betrag, a.minuten,
      new Date().toISOString(), req.user.id);
  res.json({ ok: true });
});

app.patch('/api/expenses/:id', requireTenant, auth.requireAdmin, (req, res) => {
  const a = get(`SELECT * FROM expenses WHERE id = ? AND tenant_id = ?`,
                Number(req.params.id), req.tenant.id);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  const b = req.body || {};
  if (b.zustand === 'genehmigt') {
    run(`UPDATE expenses SET approved_at = ?, approved_by = ?, rejected_at = NULL WHERE id = ?`,
        new Date().toISOString(), req.user.id, a.id);
  } else if (b.zustand === 'abgelehnt') {
    run(`UPDATE expenses SET rejected_at = ?, approved_at = NULL WHERE id = ?`,
        new Date().toISOString(), a.id);
  }
  if (b.amount_cents !== undefined) {
    run(`UPDATE expenses SET amount_cents = ? WHERE id = ?`, Math.max(0, Math.round(Number(b.amount_cents) || 0)), a.id);
  }
  if (b.minutes !== undefined) {
    run(`UPDATE expenses SET minutes = ? WHERE id = ?`, Math.max(0, Math.round(Number(b.minutes) || 0)), a.id);
  }
  // pay_cents: null bedeutet ausdrücklich „wieder automatisch rechnen".
  if (b.pay_cents !== undefined) {
    run(`UPDATE expenses SET pay_cents = ? WHERE id = ?`,
        b.pay_cents === null || b.pay_cents === '' ? null : Math.round(Number(b.pay_cents) || 0), a.id);
  }
  if (b.note !== undefined) run(`UPDATE expenses SET note = ? WHERE id = ?`, String(b.note).trim() || null, a.id);
  res.json({ ok: true });
});

app.delete('/api/expenses/:id', requireTenant, auth.requireAdmin, (req, res) => {
  const a = get(`SELECT id FROM expenses WHERE id = ? AND tenant_id = ?`,
                Number(req.params.id), req.tenant.id);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  run(`DELETE FROM expenses WHERE id = ?`, a.id);
  res.json({ ok: true });
});

// ===========================================================================
// Urlaub
// ===========================================================================
// Die Kraft beantragt über ihren Magic-Link, die Verwaltung entscheidet — in der
// Oberfläche oder direkt aus der Mail. Rechnung und Zählweise stehen in
// src/urlaub.js; hier steht nur, wer was darf.
//
// ⚠️ Ein OFFENER Antrag blockiert nichts. Erst die Genehmigung wirkt auf die
// Planung. Sonst nähme sich jede Kraft durch bloßes Beantragen aus dem Dienstplan,
// und die Verwaltung merkte es an dem Tag, an dem niemand mehr verfügbar ist.

const URLAUB_MAX_TAGE = 400;        // Sicherheitsnetz gegen vertippte Jahreszahlen

function urlaubAntragPruefen(tenant, user, von, bis) {
  const datum = /^\d{4}-\d{2}-\d{2}$/;
  if (!datum.test(von) || !datum.test(bis)) return 'Bitte Anfang und Ende als Datum angeben.';
  if (bis < von) return 'Das Ende liegt vor dem Anfang.';
  const spanne = Math.round((new Date(bis + 'T12:00:00Z') - new Date(von + 'T12:00:00Z')) / 86400000);
  if (spanne > URLAUB_MAX_TAGE) return 'Dieser Zeitraum ist länger als ein Jahr — bitte prüfen.';

  const w = urlaub.werktageProWoche(tenant);
  if (!urlaub.zaehleTage(von, bis, tenant.region, w)) {
    // Ein Zeitraum, der nur aus Sonntagen und Feiertagen besteht, ergibt null
    // Urlaubstage. Ihn stillschweigend anzunehmen hieße, einen Antrag zu führen,
    // der nichts bewirkt und nichts kostet — und niemand wüsste, warum.
    return 'In diesem Zeitraum liegt kein Urlaubstag (nur Sonn- und Feiertage).';
  }
  const kollision = get(
    `SELECT start_date, end_date FROM vacation_requests
      WHERE user_id = ? AND status IN ('pending','approved')
        AND start_date <= ? AND end_date >= ?`, user.id, bis, von);
  if (kollision) {
    return `Für ${fmt.tag(kollision.start_date)}–${fmt.tag(kollision.end_date)} gibt es schon einen Antrag.`;
  }
  return null;
}

function urlaubAntrag(tenantId, userId, von, bis, note) {
  run(`INSERT INTO vacation_requests(tenant_id, user_id, start_date, end_date, note)
       VALUES(?,?,?,?,?)`, tenantId, userId, von, bis, String(note || '').trim().slice(0, 500) || null);
  return get(`SELECT * FROM vacation_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1`, userId);
}

// Genehmigen. Hier — und NUR hier — werden Tage, Zähleinheit, Tagessatz und Betrag
// eingefroren. Ab jetzt darf sich der Betrag nicht mehr bewegen, sonst änderte sich
// ein abgezeichneter Stundenzettel rückwirkend (siehe src/urlaub.js).
function urlaubGenehmigen(tenant, antrag, user, { via, durch = null }) {
  const w = urlaub.werktageProWoche(tenant);
  const tage = urlaub.zaehleTage(antrag.start_date, antrag.end_date, tenant.region, w);
  const bezahlt = user.vacation_paid ? 1 : 0;
  const entgelt = bezahlt ? urlaub.entgeltProTag(tenant, user, antrag.start_date, w) : null;
  const proTag = entgelt ? entgelt.pro_tag_cents : 0;
  run(`UPDATE vacation_requests
          SET status = 'approved', days = ?, werktage = ?, paid = ?,
              pay_per_day_cents = ?, pay_cents = ?, decided_at = ?, decided_via = ?, decided_by = ?
        WHERE id = ?`,
      tage, w, bezahlt, proTag, Math.round(tage * proTag), nowSql(), via, durch, antrag.id);
  return { tage, werktage: w, pro_tag_cents: proTag, entgelt };
}

function urlaubZeitraum(a) {
  return a.start_date === a.end_date ? fmt.tag(a.start_date)
                                     : `${fmt.tag(a.start_date)} bis ${fmt.tag(a.end_date)}`;
}

// --- Die Kraft: beantragen und zurückziehen --------------------------------
app.post('/api/m/:token/urlaub', magicUser, (req, res) => {
  const u = req.cleaner, t = req.tenant;
  if (!urlaub.aktiv(u, today())) {
    return res.status(400).json({ error: 'Für Sie ist kein Urlaubskonto hinterlegt. Bitte in der Verwaltung nachfragen.' });
  }
  const von = String(req.body.von || '').trim(), bis = String(req.body.bis || von).trim();
  const fehler = urlaubAntragPruefen(t, u, von, bis);
  if (fehler) return res.status(400).json({ error: fehler });
  // ⚠️ Kein Antrag in die Vergangenheit. Nachträglich eingetragener Urlaub ist eine
  // Korrektur an einem womöglich schon abgezeichneten Zettel — das darf nur die
  // Verwaltung, und zwar sehenden Auges.
  if (von < today()) return res.status(400).json({ error: 'Urlaub lässt sich nur für die Zukunft beantragen.' });

  const antrag = urlaubAntrag(t.id, u.id, von, bis, req.body.note);
  const tage = urlaub.zaehleTage(von, bis, t.region, urlaub.werktageProWoche(t));
  const konto = urlaub.konto(u, t.region, today());

  // Die Verwaltung entscheidet direkt aus der Mail — zwei Links, jeder mit eigenem
  // Token. Der Kontostand steht dabei, sonst muss sie ihn woanders nachschlagen.
  const links = urlaubTokens(t, antrag);
  notifyAdmins(t, `Urlaubsantrag: ${u.name}, ${urlaubZeitraum(antrag)}`,
    [`${u.name} beantragt Urlaub vom ${urlaubZeitraum(antrag)}.`,
     `Das sind ${tage} Urlaubstag${tage === 1 ? '' : 'e'}.`,
     konto ? `Konto ${konto.jahr}: ${konto.rest} von ${konto.anspruch} Tagen noch frei.` : null,
     antrag.note ? `\nNotiz: ${antrag.note}` : null,
     '', 'Entscheiden:', `  Genehmigen: ${links.approve}`, `  Ablehnen:   ${links.decline}`,
    ].filter(v => v !== null).join('\n'));

  res.json({ ok: true, tage });
});

// Zurückziehen. Ein offener Antrag verschwindet; ein genehmigter, der noch nicht
// begonnen hat, wird storniert — dann muss die Verwaltung es erfahren, denn sie hat
// in der Zwischenzeit ohne diese Person geplant.
app.delete('/api/m/:token/urlaub/:id', magicUser, (req, res) => {
  const a = get(`SELECT * FROM vacation_requests WHERE id = ? AND user_id = ?`,
                Number(req.params.id), req.cleaner.id);
  if (!a) return res.status(404).json({ error: 'Antrag nicht gefunden' });
  if (a.status === 'approved' && a.start_date <= today()) {
    return res.status(400).json({ error: 'Ein laufender oder vergangener Urlaub lässt sich nur in der Verwaltung ändern.' });
  }
  if (!['pending', 'approved'].includes(a.status)) return res.json({ ok: true });

  const warGenehmigt = a.status === 'approved';
  run(`UPDATE vacation_requests SET status = 'cancelled' WHERE id = ?`, a.id);
  notifyAdmins(req.tenant, `Urlaub zurückgezogen: ${req.cleaner.name}`,
    `${req.cleaner.name} hat den ${warGenehmigt ? 'genehmigten ' : ''}Urlaub vom ${urlaubZeitraum(a)} zurückgezogen.`
    + (warGenehmigt ? '\n\nDie Tage sind wieder frei — bitte prüfen, ob dadurch Termine anders verteilt werden können.' : ''));
  res.json({ ok: true });
});

// --- Die Verwaltung ---------------------------------------------------------
app.get('/api/urlaub', requireTenant, auth.requireAdmin, (req, res) => {
  const heute = today();
  const antraege = all(
    `SELECT v.*, u.name AS user_name FROM vacation_requests v
       JOIN users u ON u.id = v.user_id
      WHERE v.tenant_id = ? AND (v.status = 'pending' OR v.end_date >= date('now','-90 day'))
      ORDER BY v.status = 'pending' DESC, v.start_date`, req.tenant.id);

  const crew = all(`SELECT * FROM users WHERE tenant_id = ? AND active = 1
                      AND role IN ('cleaner','lead') ORDER BY name`, req.tenant.id);
  res.json({
    werktage: urlaub.werktageProWoche(req.tenant),
    antraege,
    personen: crew.map(u => ({
      id: u.id, name: u.name,
      vacation_days: u.vacation_days, vacation_start: u.vacation_start,
      vacation_paid: !!u.vacation_paid,
      konto: urlaub.konto(u, req.tenant.region, heute),
    })),
  });
});

// Urlaub direkt eintragen — die Verwaltung plant oft selbst, und nicht jede Kraft
// beantragt über die Seite. Ein so angelegter Antrag ist sofort genehmigt: Es gäbe
// niemanden, der ihn noch entscheiden müsste.
app.post('/api/urlaub', requireTenant, auth.requireAdmin, (req, res) => {
  const u = get(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`,
                Number(req.body.user_id), req.tenant.id);
  if (!u) return res.status(404).json({ error: 'Person nicht gefunden' });
  if (!u.vacation_days) return res.status(400).json({ error: `Für ${u.name} sind keine Urlaubstage hinterlegt.` });

  const von = String(req.body.von || '').trim(), bis = String(req.body.bis || von).trim();
  const fehler = urlaubAntragPruefen(req.tenant, u, von, bis);
  if (fehler) return res.status(400).json({ error: fehler });

  const antrag = urlaubAntrag(req.tenant.id, u.id, von, bis, req.body.note);
  const eingefroren = urlaubGenehmigen(req.tenant, antrag, u, { via: 'app', durch: req.user.id });
  urlaubBescheid(req.tenant, u, get(`SELECT * FROM vacation_requests WHERE id = ?`, antrag.id), 'approved');
  res.json({ ok: true, ...eingefroren });
});

app.post('/api/urlaub/:id/entscheiden', requireTenant, auth.requireAdmin, (req, res) => {
  const a = get(`SELECT * FROM vacation_requests WHERE id = ? AND tenant_id = ?`,
                Number(req.params.id), req.tenant.id);
  if (!a) return res.status(404).json({ error: 'Antrag nicht gefunden' });
  const u = get(`SELECT * FROM users WHERE id = ?`, a.user_id);
  const ergebnis = urlaubEntscheiden(req.tenant, a, u, req.body.entscheidung, {
    via: 'app', durch: req.user.id, grund: req.body.grund,
  });
  if (ergebnis.error) return res.status(400).json(ergebnis);
  res.json(ergebnis);
});

// Einen genehmigten Urlaub zurücknehmen — die Tage werden wieder frei, die Planung
// ist wieder offen. Getrennt vom Ablehnen: Das ist eine Entscheidung über einen
// offenen Antrag, dies die Korrektur einer schon getroffenen.
app.delete('/api/urlaub/:id', requireTenant, auth.requireAdmin, (req, res) => {
  const a = get(`SELECT * FROM vacation_requests WHERE id = ? AND tenant_id = ?`,
                Number(req.params.id), req.tenant.id);
  if (!a) return res.status(404).json({ error: 'Antrag nicht gefunden' });
  const u = get(`SELECT * FROM users WHERE id = ?`, a.user_id);
  run(`UPDATE vacation_requests SET status = 'cancelled', decided_at = ?, decided_by = ? WHERE id = ?`,
      nowSql(), req.user.id, a.id);
  if (u && !u.silent) {
    notify.send({ name: u.name, email: u.email, phone: u.phone, channel: u.channel }, {
      subject: `Urlaub zurückgenommen: ${urlaubZeitraum(a)}`,
      text: `Hallo ${u.name},\n\nder Urlaub vom ${urlaubZeitraum(a)} wurde zurückgenommen. `
          + `Bitte sprechen Sie kurz mit der Verwaltung, falls das unerwartet kommt.`,
    }, req.tenant.id).catch(() => {});
  }
  res.json({ ok: true });
});

// Gemeinsamer Kern für „aus der App" und „aus der Mail" — damit beide Wege
// dieselben Regeln anwenden. Ein zweiter Pfad mit eigener Logik wäre die Stelle,
// an der die Zählweise auseinanderläuft.
function urlaubEntscheiden(tenant, antrag, user, entscheidung, { via, durch = null, grund = '' }) {
  if (antrag.status !== 'pending') {
    return { error: `Dieser Antrag ist bereits ${({ approved: 'genehmigt', declined: 'abgelehnt', cancelled: 'zurückgezogen' })[antrag.status] || 'entschieden'}.`,
             bereits: antrag.status };
  }
  if (!user) return { error: 'Person nicht gefunden' };

  if (entscheidung === 'approve') {
    const eingefroren = urlaubGenehmigen(tenant, antrag, user, { via, durch });
    const frisch = get(`SELECT * FROM vacation_requests WHERE id = ?`, antrag.id);
    urlaubBescheid(tenant, user, frisch, 'approved');
    return { ok: true, entscheidung: 'approved', ...eingefroren };
  }

  run(`UPDATE vacation_requests SET status = 'declined', decided_at = ?, decided_via = ?,
          decided_by = ?, decline_reason = ? WHERE id = ?`,
      nowSql(), via, durch, String(grund || '').trim().slice(0, 500) || null, antrag.id);
  urlaubBescheid(tenant, user, get(`SELECT * FROM vacation_requests WHERE id = ?`, antrag.id), 'declined');
  return { ok: true, entscheidung: 'declined' };
}

// Der Bescheid an die Kraft. ⚠️ Der Betrag steht NUR bei bezahltem Urlaub darin,
// und wenn er 0 wäre, steht der Grund dabei: „0,00 €" ohne Erklärung liest sich wie
// ein Fehler und erzeugt genau den Anruf, den eine Zeile Text verhindert.
function urlaubBescheid(tenant, user, antrag, art) {
  if (!user || user.silent || !user.email) return;
  const zeilen = [`Hallo ${user.name},`, ''];
  if (art === 'approved') {
    zeilen.push(`Ihr Urlaub vom ${urlaubZeitraum(antrag)} ist genehmigt.`);
    zeilen.push(`Das sind ${antrag.days} Urlaubstag${antrag.days === 1 ? '' : 'e'}.`);
    if (antrag.paid && antrag.pay_cents > 0) {
      zeilen.push(`Urlaubsentgelt: ${fmt.euro(antrag.pay_cents)} (${fmt.euro(antrag.pay_per_day_cents)} je Tag).`);
    } else if (antrag.paid) {
      zeilen.push('Ein Urlaubsentgelt konnte noch nicht berechnet werden, weil aus den letzten '
                + 'dreizehn Wochen kein Verdienst vorliegt. Die Verwaltung setzt den Betrag von Hand.');
    }
    const konto = urlaub.konto(user, tenant.region, today());
    if (konto) zeilen.push('', `Danach sind in ${konto.jahr} noch ${konto.rest} von ${konto.anspruch} Tagen frei.`);
  } else {
    zeilen.push(`Ihr Urlaubsantrag vom ${urlaubZeitraum(antrag)} wurde leider abgelehnt.`);
    if (antrag.decline_reason) zeilen.push('', `Begründung: ${antrag.decline_reason}`);
  }
  notify.send({ name: user.name, email: user.email, phone: user.phone, channel: user.channel },
    { subject: art === 'approved' ? `Urlaub genehmigt: ${urlaubZeitraum(antrag)}`
                                  : `Urlaubsantrag abgelehnt: ${urlaubZeitraum(antrag)}`,
      text: zeilen.join('\n') }, tenant.id).catch(() => {});
}

// --- Entscheiden aus der Mail ----------------------------------------------
// ⚠️ Der Link FÜHRT NICHTS AUS. Er zeigt eine Seite mit einem Knopf, und erst der
// Knopf entscheidet. Grund: Mail-Sicherheitsdienste rufen jeden Link in einer
// eingehenden Nachricht vorsorglich ab (Microsoft Safe Links, Barracuda, Proofpoint).
// Ein GET, das genehmigt, wäre also schon genehmigt, bevor die Chefin die Mail
// überhaupt geöffnet hat — und niemand könnte den Vorgang von einer echten
// Entscheidung unterscheiden.
//
// ⚠️ Gespeichert wird der HASH des Tokens, wie bei sessions und password_resets.
// Wer eine Sicherungskopie liest, soll damit keinen Urlaub genehmigen können.
function urlaubTokens(tenant, antrag) {
  const machen = (action) => {
    const roh = crypto.randomBytes(18).toString('base64url');
    run(`INSERT INTO vacation_action_tokens(token, tenant_id, request_id, action) VALUES(?,?,?,?)`,
        crypto.createHash('sha256').update(roh).digest('hex'), tenant.id, antrag.id, action);
    return `${mandantenUrl(tenant.slug)}/urlaub/${roh}`;
  };
  return { approve: machen('approve'), decline: machen('decline') };
}

function urlaubTokenLesen(roh) {
  const t = get(`SELECT * FROM vacation_action_tokens WHERE token = ?`,
                crypto.createHash('sha256').update(String(roh || '')).digest('hex'));
  if (!t) return null;
  const antrag = get(`SELECT * FROM vacation_requests WHERE id = ?`, t.request_id);
  if (!antrag) return null;
  return { token: t, antrag,
           tenant: get(`SELECT * FROM tenants WHERE id = ?`, t.tenant_id),
           user: get(`SELECT * FROM users WHERE id = ?`, antrag.user_id) };
}

app.get('/urlaub/:token', (req, res) => {
  noCacheHtml(res);
  const d = urlaubTokenLesen(req.params.token);
  if (!d) return res.status(404).send(page('Link ungültig', '<p>Dieser Link gilt nicht mehr.</p>'));
  if (d.antrag.status !== 'pending') {
    const wie = { approved: 'genehmigt', declined: 'abgelehnt', cancelled: 'zurückgezogen' }[d.antrag.status];
    return res.send(page('Schon entschieden',
      `<p>Der Urlaubsantrag von ${escapeHtml(d.user.name)} (${urlaubZeitraum(d.antrag)}) ist bereits <strong>${wie}</strong>.</p>`));
  }
  const genehmigen = d.token.action === 'approve';
  const tage = urlaub.zaehleTage(d.antrag.start_date, d.antrag.end_date, d.tenant.region,
                                 urlaub.werktageProWoche(d.tenant));
  const konto = urlaub.konto(d.user, d.tenant.region, today());
  res.send(page(genehmigen ? 'Urlaub genehmigen' : 'Urlaubsantrag ablehnen',
    `<p><strong>${escapeHtml(d.user.name)}</strong><br>${urlaubZeitraum(d.antrag)} — ${tage} Urlaubstag${tage === 1 ? '' : 'e'}</p>`
    + (konto ? `<p>Konto ${konto.jahr}: ${konto.rest} von ${konto.anspruch} Tagen frei.</p>` : '')
    + (d.antrag.note ? `<p>Notiz: ${escapeHtml(d.antrag.note)}</p>` : '')
    + `<form method="post" action="/urlaub/${encodeURIComponent(req.params.token)}">`
    + `<button type="submit">${genehmigen ? 'Jetzt genehmigen' : 'Jetzt ablehnen'}</button></form>`
    + `<p style="margin-top:2rem;font-size:.9em;color:#666">Erst dieser Knopf entscheidet — der Link allein tut nichts.</p>`));
});

app.post('/urlaub/:token', (req, res) => {
  noCacheHtml(res);
  const d = urlaubTokenLesen(req.params.token);
  if (!d) return res.status(404).send(page('Link ungültig', '<p>Dieser Link gilt nicht mehr.</p>'));
  if (d.token.used_at) return res.send(page('Schon benutzt', '<p>Über diesen Link wurde bereits entschieden.</p>'));

  const ergebnis = urlaubEntscheiden(d.tenant, d.antrag, d.user, d.token.action, { via: 'mail' });
  if (ergebnis.error) return res.send(page('Schon entschieden', `<p>${escapeHtml(ergebnis.error)}</p>`));

  run(`UPDATE vacation_action_tokens SET used_at = ? WHERE token = ?`, nowSql(), d.token.token);
  // Das Geschwister-Token verfällt mit: Sonst könnte derselbe Antrag über den
  // zweiten Link ein zweites Mal entschieden werden.
  run(`UPDATE vacation_action_tokens SET used_at = ? WHERE request_id = ? AND used_at IS NULL`,
      nowSql(), d.antrag.id);

  res.send(page(ergebnis.entscheidung === 'approved' ? 'Genehmigt' : 'Abgelehnt',
    `<p>Der Urlaub von ${escapeHtml(d.user.name)} (${urlaubZeitraum(d.antrag)}) ist `
    + `<strong>${ergebnis.entscheidung === 'approved' ? 'genehmigt' : 'abgelehnt'}</strong>. `
    + `${escapeHtml(d.user.name)} hat Bescheid bekommen.</p>`));
});

// --- Entscheidungsangebot --------------------------------------------------
// Eine Woche vor Ablauf geht eine Mail mit genau zwei Wegen raus: jetzt entscheiden
// mit 20 % auf das erste Jahr, oder einmalig sechs Wochen weiter testen. Beides
// führt über EINEN Link ohne Anmeldung — wer sich vom Handy aus entscheiden will,
// soll nicht erst ein Passwort suchen müssen. Der Link ist 144 Bit lang und steht
// im Pfad, nie in der Abfrage (sonst stünde er in fremden Server-Protokollen).
function angebotLink(t) {
  let token = t.angebot_token;
  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    run(`UPDATE tenants SET angebot_token = ? WHERE id = ?`, token, t.id);
    t.angebot_token = token;
  }
  return `${mandantenUrl(t.slug)}/angebot/${token}`;
}

function empfaenger(tenantId) {
  return get(`SELECT name, email FROM users
               WHERE tenant_id = ? AND role IN ('owner','admin') AND active = 1 AND email IS NOT NULL
               ORDER BY (role = 'owner') DESC, id ASC`, tenantId);
}

async function entscheidungsmail(t, art) {
  const zu = empfaenger(t.id);
  if (!zu) return false;
  const heute = today();
  const p = preis.fuer(zaehleUnterkuenfte(t.id));
  const link = angebotLink(t);

  const preiszeile = p.einheiten
    ? `Bei ${p.einheiten} Unterkünften sind das ${fmt.euro(p.monat_cent)} im Monat`
      + `${p.mindest_greift ? ` (Mindestbetrag)` : ''} — jährlich im Voraus `
      + `${fmt.euro(p.jahr_cent)}, also nur zehn statt zwölf Monate.`
    : `${fmt.euro(p.satz_monat_cent)} je Unterkunft und Monat, mindestens `
      + `${fmt.euro(p.mindest_monat_cent)} im Monat.`;

  const kopf = art === 'entscheidung'
    ? `Ihr Testzeitraum läuft am ${fmt.tag(t.trial_ends_at)} ab — mit dem Ende Ihrer `
      + `Abrechnungsperiode. Sie haben also einen vollen Durchlauf hinter sich.`
    : `Ihr Testzeitraum ist am ${fmt.tag(t.trial_ends_at)} abgelaufen. Ihre Daten sind `
      + `vollständig da: Sie können weiterhin alles ansehen und herunterladen, nur das `
      + `Weiterarbeiten ruht.`;

  await notify.send({ name: zu.name, email: zu.email, channel: 'mail' }, {
    subject: art === 'entscheidung'
      ? `Noch ${fmt.dauer(angebot.tageBis(t.trial_ends_at, heute))} Testzeitraum — machen Sie weiter?`
      : `Ihr Testzeitraum ist abgelaufen — so geht es weiter`,
    text: `Hallo ${zu.name},\n\n${kopf}\n\n${preiszeile}\n\n`
        + `Weitermachen mit einem Klick:\n\n${link}\n\n`
        + `Abgerechnet wird auf Rechnung, netto zzgl. MwSt. — keine Kreditkarte, keine `
        + `Kündigungsfrist. Wenn Sie sich dagegen entscheiden, ist auch das in Ordnung: `
        + `Ihre Daten bleiben sichtbar und Sie können sie jederzeit herunterladen.`,
  }, t.id);

  const feld = art === 'entscheidung' ? 'entscheidung_mail_fuer' : 'ablauf_mail_fuer';
  run(`UPDATE tenants SET ${feld} = ? WHERE id = ?`, t.trial_ends_at, t.id);
  return true;
}

// Läuft beim Start und alle 12 Stunden. Kein eigener Zeitplan-Dienst: Der Merker
// je Mandant macht den Lauf beliebig oft wiederholbar, deshalb ist die Häufigkeit
// egal — nur die Zustellung darf sich nicht doppeln, und dafür sorgt der Merker.
async function angebotslauf() {
  const heute = today();
  for (const t of all(`SELECT * FROM tenants WHERE is_demo = 0`)) {
    const art = angebot.faellig(t, heute);
    if (!art) continue;
    try {
      if (await entscheidungsmail(t, art)) console.log(`[angebot] ${art} an ${t.slug}`);
    } catch (e) {
      console.error(`[angebot] ${t.slug}:`, e.message);
    }
  }
}

function angebotAus(req, res, next) {
  const t = get(`SELECT * FROM tenants WHERE angebot_token = ?`, req.params.token);
  // Der Link gehört zu genau einem Mandanten. Über eine fremde Subdomain darf er
  // nicht greifen, sonst wäre er ein Mandantensprung.
  if (!t || (req.tenant && req.tenant.id !== t.id)) {
    return res.status(404).json({ error: 'Dieser Link gilt nicht mehr.' });
  }
  req.angebotTenant = t;
  next();
}

app.get('/api/angebot/:token', angebotAus, (req, res) => {
  const t = req.angebotTenant;
  const heute = today();
  res.json({
    betrieb: t.name,
    endet_am: t.trial_ends_at,
    abgelaufen: !!t.trial_ends_at && t.trial_ends_at < heute,
    bestellt_am: t.bestellt_am,
    modus: t.billing_mode,
    preis: preis.fuer(zaehleUnterkuenfte(t.id)),
  });
});

// Bestellung. Kein Zahlungsdienstleister: Es folgt eine Rechnung. Damit niemand
// zwischen Bestellung und Zahlungseingang ausgesperrt wird, läuft der Zugang bis
// zum Zahlungsziel weiter — wer bestellt hat, ist Kunde, nicht Bittsteller.
app.post('/api/angebot/:token/bestellen', angebotAus, (req, res) => {
  const t = req.angebotTenant;
  if (t.bestellt_am) return res.status(400).json({ error: 'Ihre Bestellung liegt uns bereits vor.' });
  const modus = req.body && req.body.modus === 'monthly' ? 'monthly' : 'yearly';
  const heute = today();
  const bis = angebot.plusTage(heute, angebot.ZAHLZIEL_TAGE);

  run(`UPDATE tenants SET bestellt_am = ?, billing_mode = ?, paid_until = ? WHERE id = ?`,
      new Date().toISOString(), modus, bis, t.id);

  const p = preis.fuer(zaehleUnterkuenfte(t.id));
  notify.send({ name: 'Putzflow', email: process.env.OPS_EMAIL || 'hallo@putzflow.de', channel: 'mail' }, {
    subject: `Bestellung: ${t.name}`,
    text: `${t.name} (${t.slug}.putzflow.de) hat bestellt.\n\n`
        + `Zahlweise: ${modus === 'yearly' ? 'jährlich' : 'monatlich'}\n`
        + `Unterkünfte: ${p.einheiten}\n`
        + `Betrag: ${fmt.euro(modus === 'yearly' ? p.jahr_cent : p.monat_cent)} netto `
        + `(${fmt.euro(p.satz_monat_cent)} je Unterkunft und Monat)\n`
        + `Anschrift: ${t.name}, ${t.street || '—'}, ${t.zip || ''} ${t.city || ''}\n\n`
        + `Zugang läuft ohne Zutun bis ${fmt.tag(bis)} — bis dahin Rechnung stellen und `
        + `nach Zahlungseingang paid_until setzen.`,
  }, t.id).catch(() => {});

  const zu = empfaenger(t.id);
  if (zu) {
    notify.send({ name: zu.name, email: zu.email, channel: 'mail' }, {
      subject: 'Danke — wir haben Ihre Bestellung',
      text: `Hallo ${zu.name},\n\nvielen Dank. Sie zahlen `
          + `${modus === 'yearly' ? 'jährlich' : 'monatlich'} `
          + `${fmt.euro(modus === 'yearly' ? p.jahr_cent : p.monat_cent)} netto.\n\n`
          + `Die Rechnung kommt per Mail. Ihr Zugang läuft ohne Unterbrechung weiter; `
          + `Sie müssen nichts weiter tun.`,
    }, t.id).catch(() => {});
  }

  res.json({ ok: true, modus });
});


// --- Export ---------------------------------------------------------------
// Alles, was der Kunde eingegeben hat, in einem Rutsch. Bewusst auch im
// Nur-Lesen-Zustand erreichbar: Wer aufhört, soll seine Daten mitnehmen können.
function csvFeld(w) {
  const s = w == null ? '' : String(w);
  return /[";\n\r]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
}
const csvZeile = werte => werte.map(csvFeld).join(';');

app.get('/api/export/stundenzettel.csv', requireTenant, auth.requireAdmin, (req, res) => {
  const zeilen = [csvZeile(['Person', 'Art', 'Datum', 'Unterkunft/Zweck', 'Minuten',
                            'Betrag EUR', 'Status', 'Periode'])];
  const kraefte = all(`SELECT id, name FROM users WHERE tenant_id = ? AND role IN ('cleaner','lead')`, req.tenant.id);
  const daten = all(`SELECT DISTINCT due_date FROM jobs WHERE tenant_id = ? ORDER BY due_date`, req.tenant.id);
  const perioden = [...new Set(daten.map(d => billing.periodOf(d.due_date, req.tenant.period_start_day).start))];
  for (const k of kraefte) {
    for (const p of perioden) {
      const ts = jobsLogic.timesheet(req.tenant, k.id, p);
      for (const i of ts.items) {
        zeilen.push(csvZeile([k.name, 'Reinigung', i.date, i.unit, i.minutes,
                              (i.cents / 100).toFixed(2).replace('.', ','), i.status, ts.period.start]));
      }
      // Auslagen als eigene Art — wer die Spalte übersieht, addiert sonst
      // Auslagenersatz zum Arbeitsentgelt.
      for (const a of ts.auslagen.posten) {
        zeilen.push(csvZeile([k.name, 'Auslage', a.date, a.beschreibung, a.minutes,
                              (a.auslage_cents / 100).toFixed(2).replace('.', ','),
                              a.zustand, ts.period.start]));
      }
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="putzflow-stundenzettel-${req.tenant.slug}.csv"`);
  // BOM voran, sonst zeigt Excel die Umlaute falsch an.
  res.send('﻿' + zeilen.join('\r\n'));
});

app.get('/api/export/daten.json', requireTenant, auth.requireAdmin, (req, res) => {
  const t = req.tenant;
  const ohneGeheimnis = u => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
    employment: u.employment, silent: !!u.silent, active: !!u.active,
  });
  res.setHeader('Content-Disposition', `attachment; filename="putzflow-${t.slug}.json"`);
  res.json({
    erzeugt: new Date().toISOString(),
    betrieb: {
      name: t.name, slug: t.slug, region: t.region, strasse: t.street,
      plz: t.zip, ort: t.city, land: t.country, telefon: t.phone,
      abrechnung_ab_tag: t.period_start_day,
    },
    unterkuenfte: all(`SELECT id, name, kind, location, checkout_time, external_ref, active
                         FROM units WHERE tenant_id = ?`, t.id),
    personen: all(`SELECT * FROM users WHERE tenant_id = ?`, t.id).map(ohneGeheimnis),
    verguetung: all(`SELECT * FROM comp_rules WHERE tenant_id = ?`, t.id),
    checklisten: all(`SELECT * FROM checklist_items WHERE tenant_id = ?`, t.id),
    auftraege: all(`SELECT id, unit_id, due_date, start_time, kind, status, assigned_user_id,
                           confirmed, requested_at, declined_at, note FROM jobs WHERE tenant_id = ?`, t.id),
    arbeitszeiten: all(`SELECT job_id, user_id, started_at, ended_at FROM work_sessions WHERE tenant_id = ?`, t.id),
    abgehakt: all(`SELECT job_id, item_id, user_id, done_at, note FROM job_checks WHERE tenant_id = ?`, t.id),
    unterschriften: all(`SELECT user_id, period_start, signed_at, signed_name, total_cents
                           FROM timesheet_signatures WHERE tenant_id = ?`, t.id),
    auslagen: all(`SELECT id, user_id, job_id, date, description, amount_cents, minutes,
                          pay_cents, approved_at, rejected_at, note FROM expenses WHERE tenant_id = ?`, t.id),
  });
});

// ===========================================================================
// Verwaltung (owner/admin)
// ===========================================================================
app.post('/api/login', requireTenant, (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const u = get(`SELECT * FROM users WHERE tenant_id = ? AND email = ? AND active = 1`, req.tenant.id, email);
  if (!u || !auth.verifyPassword(req.body.password || '', u.password_hash)) {
    return res.status(401).json({ error: 'E-Mail oder Passwort stimmt nicht' });
  }
  const { raw, expires } = auth.createSession(req.tenant.id, u.id);
  auth.setCookie(res, raw, expires);
  res.json({ ok: true, me: { name: u.name, role: u.role } });
});

// Schaufenster ohne Anmeldung: Wer demo.putzflow.de aufruft, kommt mit einem Tippen
// hinein. Bis zum 26.07.2026 stand dort eine Anmeldemaske — der „öffentliche"
// Demo-Mandant war also für Fremde verschlossen, und auf der Startseite wurde
// stattdessen um eine Mail gebeten.
//
// ⚠️ Das ist nur vertretbar, weil die Zustellung für Demo-Mandanten gesperrt ist
// (`src/notify`). Sonst könnte hier jeder eine beliebige Adresse eintragen und sich
// von Putzflow eine Mail dorthin schicken lassen. Wer diese Route anfasst, prüft
// zuerst, dass jener Riegel noch steht.
//
// ⚠️ Besucher dürfen die Demo verändern — das gehört zum Anfassen dazu. Geradezogen
// wird nächtlich per `_ops/demo-daten.js` (rührt ausschließlich slug 'demo' an).
app.post('/api/demo-login', requireTenant, (req, res) => {
  if (!req.tenant.is_demo) return res.status(404).json({ error: 'Nicht verfügbar' });
  const u = get(`SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1
                 ORDER BY id LIMIT 1`, req.tenant.id);
  if (!u) return res.status(500).json({ error: 'Demo ist nicht eingerichtet' });
  const { raw, expires } = auth.createSession(req.tenant.id, u.id);
  auth.setCookie(res, raw, expires);
  res.json({ ok: true, me: { name: u.name, role: u.role } });
});

// Das eigene Konto ändern — Name, Anmeldeadresse, Passwort.
//
// ⚠️ Es gab das bis zum 27.07.2026 NICHT, in keiner Form: kein Knopf, keine
// Route, kein „Passwort vergessen". Wer sein Passwort wechseln wollte, brauchte
// einen SQL-Befehl. Aufgefallen ist es an einer Testinstanz, deren Konto ein
// Agent angelegt hatte — Adresse und Passwort waren damit auf immer die, die
// er sich ausgedacht hatte. Derselbe Mangel traf aber jede Kundin: Ein Passwort,
// das man nicht wechseln kann, ist nach dem ersten Mitlesen für immer verbrannt.
//
// ⚠️ In der Demo gesperrt, und das ist kein Formalismus: `/api/demo-login` macht
// JEDEN Besucher zur Inhaberin. Ohne diese Sperre könnte ein Fremder dort Adresse
// und Passwort ändern und das Schaufenster dauerhaft übernehmen.
// Absichtlich NICHT `keineDemo` — das verlangt zusätzlich eine bestätigte
// E-Mail-Adresse. Wer sich bei der Anmeldung vertippt hat, muss die Adresse aber
// gerade dann noch ändern können.
app.patch('/api/me', requireTenant, auth.requireAuth, (req, res) => {
  if (req.tenant.is_demo) {
    return res.status(403).json({ error: 'In der Demo nicht möglich.' });
  }
  const u = get(`SELECT * FROM users WHERE id = ?`, req.user.id);
  if (!u) return res.status(404).json({ error: 'Konto nicht gefunden' });

  const name = req.body.name === undefined ? null : String(req.body.name).trim();
  const email = req.body.email === undefined ? null : String(req.body.email).trim().toLowerCase();
  const neu = req.body.password_neu === undefined ? null : String(req.body.password_neu);
  const alt = String(req.body.password_alt || '');

  // ⚠️ Adresse UND Passwort sind Anmeldedaten — beide nur gegen das alte
  // Passwort. Sonst genügte ein fremder Rechner mit offener Sitzung, um die
  // Anmeldeadresse auf die eigene umzubiegen und die Inhaberin auszusperren.
  // Der Name ist harmlos und darf ohne.
  const anmeldedaten = email !== null || neu !== null;
  if (anmeldedaten && !auth.verifyPassword(alt, u.password_hash)) {
    return res.status(403).json({ error: 'Das bisherige Passwort stimmt nicht' });
  }

  if (name !== null) {
    const f = pruefung.pruefeName(name);
    if (f) return res.status(400).json({ error: f });
  }
  if (email !== null) {
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
      return res.status(400).json({ error: 'Die E-Mail-Adresse sieht nicht richtig aus' });
    }
    if (get(`SELECT id FROM users WHERE tenant_id = ? AND email = ? AND id <> ?`,
            req.tenant.id, email, u.id)) {
      return res.status(400).json({ error: 'Diese E-Mail ist im Betrieb schon vergeben' });
    }
  }
  if (neu !== null) {
    if (neu.length < 8) return res.status(400).json({ error: 'Passwort mit mindestens 8 Zeichen wählen' });
    if (neu === alt) return res.status(400).json({ error: 'Das ist das bisherige Passwort' });
  }

  if (name !== null) run(`UPDATE users SET name = ? WHERE id = ?`, name, u.id);
  if (email !== null) run(`UPDATE users SET email = ? WHERE id = ?`, email, u.id);
  if (neu !== null) {
    run(`UPDATE users SET password_hash = ? WHERE id = ?`, auth.hashPassword(neu), u.id);
    // ⚠️ Nach einem Passwortwechsel ALLE anderen Sitzungen beenden. Der häufigste
    // Grund zu wechseln ist der Verdacht, dass jemand mitliest — bliebe dessen
    // Sitzung offen, hätte der Wechsel genau nichts bewirkt. Die eigene bleibt,
    // sonst fliegt man beim Speichern aus der eigenen Anwendung.
    const meine = auth.readCookie(req);
    auth.beendeAndereSitzungen(u.id, meine);
  }

  const frisch = get(`SELECT name, email FROM users WHERE id = ?`, u.id);
  res.json({ ok: true, me: frisch, passwort_geaendert: neu !== null });
});

// ===========================================================================
// Passwort vergessen
// ===========================================================================
// ⚠️ Der einzige Weg zurück ins Konto ohne Anmeldung — und damit die Route mit
// dem größten Schadenspotenzial im ganzen System. Vier Regeln, jede aus einem
// bekannten Fehler anderer:
//
//  1. **Nie verraten, ob es ein Konto gibt.** Die Antwort ist immer dieselbe.
//     Sonst ist das Formular ein Verzeichnis: Wer wissen will, ob eine Adresse
//     Kundin ist, tippt sie ein und liest die Fehlermeldung.
//  2. **Gebremst, und zwar zweifach** — nach IP (wer probiert Adressen durch)
//     und nach Konto (wer jemanden mit Mails zuschütten will). Ohne die zweite
//     Bremse ist das Formular ein Mailwerfer auf fremde Postfächer.
//  3. **Nur Konten mit Passwort.** Reinigungskräfte melden sich nie an; ein
//     Zurücksetzen für sie wäre ein Weg, sich ihren Magic-Link schicken zu
//     lassen.
//  4. **In der Demo gesperrt.** Dort ist jeder Besucher die Inhaberin.
const vergessenIp = new Map();
const vergessenKonto = new Map();

app.post('/api/passwort/vergessen', requireTenant, async (req, res) => {
  // Immer dieselbe Antwort — auch bei Sperre, auch in der Demo, auch bei
  // Unsinn. Ein Unterschied wäre wieder eine Auskunft.
  const immer = { ok: true, hinweis: 'Wenn es zu dieser Adresse ein Konto gibt, ist die Mail unterwegs.' };
  const email = String(req.body.email || '').trim().toLowerCase();

  if (req.tenant.is_demo) return res.json(immer);
  if (!zaehle(vergessenIp, req.ip, 10)) return res.json(immer);
  if (!zaehle(vergessenKonto, `${req.tenant.id}:${email}`, 3)) return res.json(immer);

  const u = get(`SELECT * FROM users WHERE tenant_id = ? AND email = ? AND active = 1
                   AND password_hash IS NOT NULL`, req.tenant.id, email);
  if (!u) return res.json(immer);

  const { raw, expires } = auth.createReset(req.tenant.id, u.id);
  const link = `${BASE_URL.replace('://', `://${req.tenant.slug}.`)}/passwort/${raw}`;
  await notify.send({ name: u.name, email: u.email, channel: 'mail' }, {
    subject: 'Neues Passwort für Putzflow',
    text: `Hallo ${u.name},\n\nSie können sich hier ein neues Passwort setzen. `
        + `Der Link gilt ${auth.RESET_TTL_MINUTEN} Minuten und lässt sich genau einmal verwenden.\n\n`
        + `Wenn Sie das nicht angefordert haben, ignorieren Sie diese Mail — ohne den Link `
        + `passiert nichts, und Ihr bisheriges Passwort gilt weiter.`,
    link,
  }, req.tenant.id).catch(() => {});
  console.log(`[passwort] Zurücksetzen angefordert für ${u.email} (gültig bis ${expires.toISOString()}).`);
  res.json(immer);
});

app.get('/passwort/:token', (req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(PUBLIC, 'passwort.html'));
});

// Gilt dieser Link noch? Die Seite fragt das, bevor sie ein Formular zeigt —
// sonst tippt jemand ein Passwort und erfährt erst danach, dass der Link tot ist.
app.get('/api/passwort/:token', requireTenant, (req, res) => {
  const r = auth.resetByToken(String(req.params.token));
  // ⚠️ Auch der Mandant muss passen. Ein Token aus einem anderen Betrieb darf
  // hier nicht gelten — sonst wäre der Link über Subdomains hinweg ein Sprung.
  if (!r || r.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Dieser Link gilt nicht mehr.' });
  res.json({ ok: true, name: r.name, email: r.email });
});

app.post('/api/passwort/:token', requireTenant, (req, res) => {
  const neu = String(req.body.password || '');
  const r = auth.resetByToken(String(req.params.token));
  if (!r || r.tenant_id !== req.tenant.id) {
    return res.status(404).json({ error: 'Dieser Link gilt nicht mehr. Bitte fordern Sie einen neuen an.' });
  }
  if (neu.length < 8) return res.status(400).json({ error: 'Passwort mit mindestens 8 Zeichen wählen' });

  auth.useReset(String(req.params.token), neu);
  console.log(`[passwort] Neu gesetzt für ${r.email}, alle Sitzungen beendet.`);
  // ⚠️ KEINE Anmeldung im selben Zug. Wer den Link aus einer fremden Mailbox
  // hat, säße sonst sofort im Konto; so muss er das neue Passwort auch noch
  // eintippen — und die echte Inhaberin sieht beim Anmelden, dass etwas nicht
  // stimmt, statt es nie zu erfahren.
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(auth.readCookie(req));
  auth.clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireTenant, (req, res) => {
  if (!req.user) {
    // Der Mandant darf auch ohne Anmeldung dabeistehen: Die Anmeldemaske muss
    // wissen, ob sie den Demo-Zugang anbieten soll. Nichts davon ist geheim —
    // Name und Demo-Marke stehen ohnehin auf der Startseite.
    return res.status(401).json({
      error: 'Nicht angemeldet',
      tenant: { name: req.tenant.name, slug: req.tenant.slug, demo: !!req.tenant.is_demo },
    });
  }
  res.json({
    me: req.user,
    tenant: {
      name: req.tenant.name, slug: req.tenant.slug, region: req.tenant.region,
      demo: !!req.tenant.is_demo,
      test: teststand(req.tenant),
      bestaetigt: !!req.tenant.email_verified_at,
      preis: preisFuer(req.tenant),
      nur_lesbar: nurLesbar(req.tenant),
      period_start_day: req.tenant.period_start_day,
      minijob_limit_cents: req.tenant.minijob_limit_cents,
    },
  });
});

// Mandanten-Einstellungen: Abrechnungsperiode, Bundesland, Minijob-Grenze
app.patch('/api/tenant', requireTenant, auth.requireAdmin, (req, res) => {
  const { period_start_day, region, minijob_limit_cents } = req.body;

  if (period_start_day !== undefined) {
    const day = billing.normalizeStartDay(period_start_day);
    if (String(day) !== String(parseInt(period_start_day, 10))) {
      return res.status(400).json({ error: 'Stichtag muss zwischen 1 und 28 liegen' });
    }
    run(`UPDATE tenants SET period_start_day = ? WHERE id = ?`, day, req.tenant.id);
  }
  if (region !== undefined) {
    // Leer ist zulässig: Wer keine Feiertagszuschläge zahlt, braucht kein Bundesland.
    if (region !== '' && !REGIONS.includes(region)) {
      return res.status(400).json({ error: 'Unbekanntes Bundesland' });
    }
    run(`UPDATE tenants SET region = ? WHERE id = ?`, region || null, req.tenant.id);
  }
  // Zähleinheit für den Urlaub: 6 = Werktage Mo–Sa (§ 3 Abs. 2 BUrlG), 5 = Arbeitstage.
  // ⚠️ Nur diese beiden. Ein freies Feld lüde dazu ein, „3" einzutragen, weil jemand
  // an drei Tagen die Woche arbeitet — dann wäre der Anspruch richtig gezählt und das
  // Urlaubsentgelt doppelt so hoch. Anspruch, Verbrauch und Entgelt hängen an
  // derselben Zahl (src/urlaub.js).
  if (req.body.urlaub_werktage !== undefined) {
    const w = parseInt(req.body.urlaub_werktage, 10);
    if (w !== 5 && w !== 6) return res.status(400).json({ error: 'Zähleinheit: 5 (Arbeitstage) oder 6 (Werktage).' });
    run(`UPDATE tenants SET urlaub_werktage = ? WHERE id = ?`, w, req.tenant.id);
  }
  for (const [feld, wert] of [['checkout_time', req.body.checkout_time],
                              ['slot_minutes', req.body.slot_minutes],
                              ['travel_minutes', req.body.travel_minutes]]) {
    if (wert === undefined) continue;
    if (feld === 'checkout_time') {
      if (!zeit.parseHHMM(wert)) return res.status(400).json({ error: 'Check-out-Zeit im Format HH:MM' });
      run(`UPDATE tenants SET checkout_time = ? WHERE id = ?`, String(wert).trim(), req.tenant.id);
    } else {
      const n = parseInt(wert, 10);
      if (!Number.isFinite(n) || n < 0 || n > 480) return res.status(400).json({ error: 'Minuten zwischen 0 und 480' });
      run(`UPDATE tenants SET ${feld} = ? WHERE id = ?`, n, req.tenant.id);
    }
  }
  if (minijob_limit_cents !== undefined) {
    const cents = parseInt(minijob_limit_cents, 10);
    if (!Number.isFinite(cents) || cents < 0) return res.status(400).json({ error: 'Ungültige Grenze' });
    run(`UPDATE tenants SET minijob_limit_cents = ? WHERE id = ?`, cents, req.tenant.id);
  }

  const t = get(`SELECT * FROM tenants WHERE id = ?`, req.tenant.id);
  res.json({
    ok: true,
    tenant: {
      name: t.name, region: t.region,
      period_start_day: t.period_start_day, minijob_limit_cents: t.minijob_limit_cents,
      period: billing.periodOf(today(), t.period_start_day),
    },
  });
});

app.get('/api/jobs', requireTenant, auth.requireAdmin, (req, res) => {
  const period = billing.periodOf(today(), req.tenant.period_start_day);
  const from = req.query.from || period.start;
  const to = req.query.to || period.end;
  const rows = all(
    `SELECT j.*, un.name AS unit_name, u.name AS user_name
       FROM jobs j LEFT JOIN units un ON un.id = j.unit_id
                   LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.tenant_id = ? AND j.due_date BETWEEN ? AND ?
      ORDER BY j.due_date, j.id`, req.tenant.id, from, to);
  res.json({
    from, to,
    jobs: rows.map(j => ({
      ...j,
      premium: billing.isPremiumDay(j.due_date, req.tenant.region, 'weekend_holiday'),
      pay: jobsLogic.jobPay(req.tenant, j),
      // Namen der noch offenen Rundruf-Angebote — sonst sieht ein laufender
      // Rundruf genauso aus wie ein Termin, um den sich niemand kümmert.
      rundruf_offen: rundruf.offeneAngebote(j).map(o => o.name).join(', ') || null,
    })),
  });
});

app.get('/api/users', requireTenant, auth.requireAdmin, (req, res) => {
  const rows = all(`SELECT id, name, email, phone, role, channel, silent, active, team_lead_id, magic_token, employment
                      FROM users WHERE tenant_id = ? ORDER BY role, name`, req.tenant.id);
  // Datenschutz-Prinzip aus G&G: ein Lead sieht nur sein eigenes Team.
  const visible = req.user.role === 'lead'
    ? rows.filter(u => u.id === req.user.id || u.team_lead_id === req.user.id)
    : rows;
  // Jede Reinigungskraft bekommt ihren Periodenstand mit. Ab mehreren Kräften ist die
  // 600-€-Grenze keine Anzeige mehr, sondern eine Verteilungsbedingung: Die Verwaltung
  // muss BEIM Zuteilen sehen, wer noch Luft hat — nicht erst im Stundenzettel.
  res.json({
    users: visible.map(u => {
      const out = {
        ...u,
        magic_url: u.magic_token ? magicUrl(req.tenant.slug, u.magic_token) : null,
        // ⚠️ Gehört in die LISTE und nicht erst in den Fehlschlag — sonst merkt man
        // es erst, wenn eine Reinigung schon vergeben ist.
        unerreichbar: unerreichbarePerson(u) && !['owner', 'admin'].includes(u.role),
      };
      if (['cleaner', 'lead'].includes(u.role) && u.active) {
        // timesheet() liefert die Grenze nur bei employment = 'minijob' — sonst null.
        out.minijob = jobsLogic.timesheet(req.tenant, u.id, today()).minijob;
      }
      return out;
    }),
  });
});

// ⚠️ `notify_log` gab es seit dem ersten Tag — GELESEN hat es niemand, an keiner
// Stelle der Oberfläche. Eine Tabelle, in die nur hineingeschrieben wird, ist kein
// Protokoll, sondern ein Grab. Am 21.08.2026 lagen dort vier fehlgeschlagene
// Terminanfragen des ersten Kunden, von denen er nichts wusste.
app.get('/api/zustellprobleme', requireTenant, auth.requireAdmin, (req, res) => {
  // Vierzehn Tage: lang genug, dass ein Fehlschlag vom letzten Wochenende noch
  // auffällt, kurz genug, dass ein behobenes Problem von selbst verschwindet und
  // niemand eine Meldung wegklicken muss, die längst nicht mehr stimmt.
  const probleme = all(
    `SELECT subject, recipient, error, created_at FROM notify_log
       WHERE tenant_id = ? AND status = 'failed' AND created_at >= datetime('now', '-14 day')
       ORDER BY created_at DESC LIMIT 20`, req.tenant.id);
  res.json({ anzahl: probleme.length, probleme });
});

const EMPLOYMENT = ['minijob', 'midijob', 'angestellt', 'firma'];

// Person anlegen. Reinigungskräfte bekommen sofort ihren Magic-Link — außer
// stillen, die per Definition keinen Zugang haben.
app.post('/api/users', requireTenant, auth.requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const rolle = ['cleaner', 'lead', 'admin'].includes(req.body.role) ? req.body.role : 'cleaner';
  if (email && get(`SELECT id FROM users WHERE tenant_id = ? AND email = ?`, req.tenant.id, email)) {
    return res.status(400).json({ error: 'Diese E-Mail ist schon vergeben' });
  }
  const employment = EMPLOYMENT.includes(req.body.employment) ? req.body.employment : 'minijob';
  run(`INSERT INTO users(tenant_id, name, email, phone, role, employment, silent)
       VALUES(?,?,?,?,?,?,?)`,
      req.tenant.id, name, email, String(req.body.phone || '').trim() || null,
      rolle, employment, req.body.silent ? 1 : 0);
  const u = get(`SELECT * FROM users WHERE tenant_id = ? AND name = ? ORDER BY id DESC LIMIT 1`, req.tenant.id, name);
  auth.ensureMagicToken(u);
  res.json({ ok: true });
});

// Beschäftigungsart einer Person ändern. Steuert allein, ob die Minijob-Grenze
// überhaupt verfolgt wird — die Planung selbst funktioniert in jedem Fall.
app.patch('/api/users/:id', requireTenant, auth.requireAdmin, (req, res) => {
  const u = get(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!u) return res.status(404).json({ error: 'Person nicht gefunden' });
  const { employment, name, email, phone, silent, active, team_lead_id } = req.body;
  if (employment !== undefined) {
    if (!EMPLOYMENT.includes(employment)) return res.status(400).json({ error: 'Unbekannte Beschäftigungsart' });
    run(`UPDATE users SET employment = ? WHERE id = ?`, employment, u.id);
  }
  if (name !== undefined && String(name).trim()) run(`UPDATE users SET name = ? WHERE id = ?`, String(name).trim(), u.id);
  if (email !== undefined) {
    const e = String(email).trim().toLowerCase() || null;
    if (e && get(`SELECT id FROM users WHERE tenant_id = ? AND email = ? AND id <> ?`, req.tenant.id, e, u.id)) {
      return res.status(400).json({ error: 'Diese E-Mail ist schon vergeben' });
    }
    run(`UPDATE users SET email = ? WHERE id = ?`, e, u.id);
  }
  if (phone !== undefined) run(`UPDATE users SET phone = ? WHERE id = ?`, String(phone).trim() || null, u.id);
  if (team_lead_id !== undefined) {
    const lead = team_lead_id ? Number(team_lead_id) : null;
    run(`UPDATE users SET team_lead_id = ? WHERE id = ?`, lead && lead !== u.id ? lead : null, u.id);
  }
  if (silent !== undefined) {
    // Invariante: still ⇒ kein Zugang. Beim Wiederaufleben neuen Token prägen.
    run(`UPDATE users SET silent = ? WHERE id = ?`, silent ? 1 : 0, u.id);
    if (silent) run(`UPDATE users SET magic_token = NULL WHERE id = ?`, u.id);
    else auth.ensureMagicToken(get(`SELECT * FROM users WHERE id = ?`, u.id));
  }
  if (active !== undefined) {
    if (!active && u.role === 'owner') return res.status(400).json({ error: 'Die Inhaberin lässt sich nicht stilllegen' });
    run(`UPDATE users SET active = ? WHERE id = ?`, active ? 1 : 0, u.id);
  }

  // --- Urlaub ---
  // ⚠️ Leer heißt „kein Urlaubskonto", nicht „null Tage". Der Unterschied ist
  // sichtbar: Ohne Konto zeigt die Magic-Seite den Abschnitt gar nicht; mit
  // 0 Tagen stünde dort „0 von 0 frei" und die Kraft fragte nach, warum sie
  // keinen Urlaub hat. Deshalb NULL und nicht 0.
  if (req.body.vacation_days !== undefined) {
    const roh = String(req.body.vacation_days).trim().replace(',', '.');
    if (roh === '') {
      run(`UPDATE users SET vacation_days = NULL WHERE id = ?`, u.id);
    } else {
      const tage = Number(roh);
      if (!Number.isFinite(tage) || tage < 0 || tage > 60) {
        return res.status(400).json({ error: 'Urlaubstage bitte als Zahl zwischen 0 und 60.' });
      }
      run(`UPDATE users SET vacation_days = ? WHERE id = ?`, tage, u.id);
      // Beim ERSTEN Eintragen festhalten, ab wann Putzflow dieses Konto führt.
      // Ohne diesen Merker unterstellte die Kontorechnung für jedes frühere Jahr
      // vollen, nicht genommenen Anspruch — und wies einen Übertrag aus, den es
      // nie gab. Nur setzen, wenn er fehlt: Eine spätere Änderung der Tagezahl
      // darf die Historie nicht zurückdatieren.
      if (!u.vacation_tracked_since) {
        run(`UPDATE users SET vacation_tracked_since = ? WHERE id = ?`, today(), u.id);
      }
    }
  }
  if (req.body.vacation_start !== undefined) {
    const d = String(req.body.vacation_start).trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Startdatum als JJJJ-MM-TT.' });
    run(`UPDATE users SET vacation_start = ? WHERE id = ?`, d || null, u.id);
  }
  if (req.body.vacation_paid !== undefined) {
    run(`UPDATE users SET vacation_paid = ? WHERE id = ?`, req.body.vacation_paid ? 1 : 0, u.id);
  }
  res.json({ ok: true });
});

// ⚠️ Eine Kraft ohne Adresse und ohne „still"-Marke ist ein WIDERSPRUCH: Die
// Software SOLL sie fragen, KANN es aber nicht. Bis zum 21.08.2026 fiel das
// lautlos ins `notify_log`, und die Oberfläche meldete schlicht „Zugeteilt" —
// beim ersten echten Kunden viermal an einem Vormittag, ohne dass er davon
// erfahren hätte.
function unerreichbarePerson(p) {
  return !!p && !p.silent && !p.email && !p.phone;
}

// Was die Oberfläche dem Menschen sagen soll, wenn eine Nachricht nicht rausging.
// ⚠️ Nicht „failed", sondern was zu TUN ist — der Magic-Link liegt ja bereit, er
// muss nur von Hand hinüber. Und ⚠️ von BEIDEN Routen benutzt, die an eine Kraft
// schreiben (Zuteilung und Absage): Repariert man nur eine, schweigt die andere
// weiter, und genau das fällt beim nächsten Mal niemandem auf.
function zustellHinweis(person, sent) {
  if (!sent || sent.ok) return null;
  const stumm = unerreichbarePerson(person);
  return {
    ok: false,
    grund: stumm
      ? `${person.name} hat weder E-Mail noch Telefon hinterlegt`
      : (sent.error || 'Die Nachricht ging nicht raus'),
    rat: stumm
      ? 'Tragen Sie eine Adresse ein — oder schicken Sie ihr den persönlichen Link selbst.'
      : 'Bitte später noch einmal anfragen.',
  };
}

// --- Smoobu ---------------------------------------------------------------
function smoobuClient(tenant) {
  const key = krypto.entschluesseln(tenant.smoobu_key);
  const secret = krypto.entschluesseln(tenant.smoobu_secret);
  if (!key || !secret) return null;
  return smoobu.client({ key, secret });
}

app.get('/api/smoobu', requireTenant, auth.requireAdmin, (req, res) => {
  const key = krypto.entschluesseln(req.tenant.smoobu_key);
  res.json({
    verbunden: !!key,
    key_maskiert: krypto.maskieren(key),
    zuletzt: req.tenant.smoobu_synced_at,
    demo: !!req.tenant.is_demo,
    // Erst zeigen, wenn eine Verbindung besteht — vorher hat der Kunde nichts
    // einzutragen, und ein Token auf Vorrat wäre nur ein Geheimnis mehr.
    // In der Demo nie: Die URL wäre öffentlich und jeder Besucher könnte
    // Abgleiche auslösen.
    webhook_url: (key && !req.tenant.is_demo) ? webhookUrl(req.tenant) : null,
  });
});

// Zugangsdaten hinterlegen. Wird sofort gegen Smoobu geprüft — lieber hier ein
// Fehler als später ein stiller Abgleich, der nichts tut.
app.put('/api/smoobu', requireTenant, auth.requireAdmin, keineDemo, async (req, res) => {
  const key = String(req.body.key || '').trim();
  const secret = String(req.body.secret || '').trim();
  if (!key || !secret) return res.status(400).json({ error: 'Schlüssel und Secret angeben' });
  try {
    const konto = await smoobu.client({ key, secret }).konto();
    run(`UPDATE tenants SET smoobu_key = ?, smoobu_secret = ? WHERE id = ?`,
        krypto.verschluesseln(key), krypto.verschluesseln(secret), req.tenant.id);
    res.json({ ok: true, konto: { name: [konto.firstName, konto.lastName].filter(Boolean).join(' '), email: konto.email } });
  } catch (e) {
    res.status(400).json({ error: `Zugang abgelehnt: ${e.message}` });
  }
});

app.delete('/api/smoobu', requireTenant, auth.requireAdmin, (req, res) => {
  // Der Webhook-Token geht mit. Wer die Verbindung trennt, erwartet, dass nichts
  // zurückbleibt — und beim erneuten Verbinden entsteht ohnehin ein frischer.
  run(`UPDATE tenants SET smoobu_key = NULL, smoobu_secret = NULL, smoobu_webhook_token = NULL
         WHERE id = ?`, req.tenant.id);
  res.json({ ok: true });
});

// Abgleich anstoßen
app.post('/api/smoobu/sync', requireTenant, auth.requireAdmin, async (req, res) => {
  try {
    const ergebnis = await smoobuSync(req.tenant);
    res.json({ ok: true, ...ergebnis });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ====================================================================
// Smoobu-Webhook — Sofort-Abgleich statt Warten auf den nächsten Tick
// ====================================================================
// Smoobu ruft bei jedem Buchungsereignis (neu, geändert, storniert) eine URL auf,
// die der Kunde im Smoobu-Dashboard hinterlegt. Vorher lag zwischen einer
// kurzfristigen Abreise und dem Reinigungsauftrag bis zu eine Stunde — bei einer
// Spontanbuchung für morgen ist das der Unterschied zwischen „die Kraft weiß
// Bescheid" und „niemand war da". Übernommen von Glanz & Gloria (dort seit
// 02.07.2026 im Betrieb), angepasst auf mehrere Mandanten.
//
// ⚠️ **Dem Payload wird NICHT vertraut.** Er wird nicht einmal gelesen. Der Aufruf
// ist nur ein Klopfen an der Tür; die Daten holt Putzflow anschließend selbst und
// signiert über die API. Wer den Token kennt, kann damit einen Abgleich auslösen —
// mehr nicht. Ohne diese Regel wäre der Webhook ein Weg, fremde Termine zu erfinden.
//
// ⚠️ **Das Geheimnis steht im PFAD, nicht in einem Header** — Smoobu kann bei einem
// Webhook keine eigenen Header setzen. Deshalb je Mandant ein eigener 256-Bit-Token
// (`tenants.smoobu_webhook_token`), der sich einzeln tauschen lässt.

function webhookToken(tenant) {
  if (tenant.smoobu_webhook_token) return tenant.smoobu_webhook_token;
  const token = crypto.randomBytes(32).toString('base64url');
  run(`UPDATE tenants SET smoobu_webhook_token = ? WHERE id = ?`, token, tenant.id);
  tenant.smoobu_webhook_token = token;
  return token;
}

// ⚠️ Die URL wird aus BASE_URL gebaut, nicht aus dem Host-Header des Aufrufs.
// Sonst stünde in der Anleitung, was ein Angreifer hineinschreibt — und der Kunde
// trüge es arglos bei Smoobu ein.
const webhookUrl = tenant => `${mandantenUrl(tenant.slug)}/webhook/smoobu/${webhookToken(tenant)}`;

// Zustand je Mandant: Smoobu schickt pro Änderung gern mehrere Ereignisse kurz
// hintereinander. Ohne Sammelfrist liefe für eine einzige Buchung dreimal derselbe
// Abgleich. Und läuft schon einer, wird der nächste vorgemerkt statt parallel
// gestartet — zwei gleichzeitige Läufe auf demselben Mandanten würden dieselben
// Aufträge doppelt anlegen wollen.
const webhookLauf = new Map();   // tenant.id -> { timer, laeuft, nochmal }

function webhookAnstossen(tenantId) {
  let z = webhookLauf.get(tenantId);
  if (!z) { z = { timer: null, laeuft: false, nochmal: false }; webhookLauf.set(tenantId, z); }
  clearTimeout(z.timer);
  z.timer = setTimeout(() => webhookAbgleich(tenantId), 2000);   // 2 s Sammelfrist
  if (z.timer.unref) z.timer.unref();
}

async function webhookAbgleich(tenantId) {
  const z = webhookLauf.get(tenantId);
  if (!z) return;
  if (z.laeuft) { z.nochmal = true; return; }
  z.laeuft = true;
  try {
    // Frisch aus der Datenbank: zwischen Klopfen und Abgleich kann der Kunde die
    // Verbindung getrennt haben.
    const t = get(`SELECT * FROM tenants WHERE id = ? AND active = 1 AND smoobu_key IS NOT NULL`, tenantId);
    if (!t) return;
    const r = await smoobuSync(t);
    if (r.angelegt || r.verschoben || r.entfallen) {
      console.log(`[webhook] ${t.slug}: +${r.angelegt} neu, ${r.verschoben} verschoben, ${r.entfallen} entfallen`);
    }
  } catch (e) {
    console.error(`[webhook] Abgleich fehlgeschlagen: ${e.message}`);
  } finally {
    z.laeuft = false;
    if (z.nochmal) { z.nochmal = false; setTimeout(() => webhookAbgleich(tenantId), 1000).unref?.(); }
  }
}

app.post('/webhook/smoobu/:token', (req, res) => {
  const token = String(req.params.token || '');
  // ⚠️ 404 und nicht 401: Ein unbekannter Token darf nicht verraten, dass es die
  // Route überhaupt gibt. Und kein Abgleich, bevor der Token stimmt — sonst wäre
  // die Route ein Weg, fremde Smoobu-Konten im Sekundentakt abfragen zu lassen.
  if (token.length < 20) return res.status(404).end();
  const t = get(`SELECT id FROM tenants WHERE smoobu_webhook_token = ? AND active = 1
                   AND is_demo = 0 AND smoobu_key IS NOT NULL`, token);
  if (!t) return res.status(404).end();
  res.json({ ok: true });          // Smoobu sofort bestätigen, der Abgleich läuft danach
  webhookAnstossen(t.id);
});

// Token neu erzeugen — für den Fall, dass die URL irgendwo gelandet ist, wo sie
// nicht hingehört. Der alte gilt ab sofort nicht mehr; die neue URL muss dann in
// Smoobu eingetragen werden, sonst kommt kein Sofort-Abgleich mehr (der Tick
// unten fängt es auf).
app.post('/api/smoobu/webhook-neu', requireTenant, auth.requireAdmin, keineDemo, (req, res) => {
  run(`UPDATE tenants SET smoobu_webhook_token = NULL WHERE id = ?`, req.tenant.id);
  req.tenant.smoobu_webhook_token = null;
  res.json({ ok: true, webhook_url: webhookUrl(req.tenant) });
});

// Der eigentliche Abgleich. Fenster: 14 Tage zurück (nachträgliche Änderungen)
// bis 120 Tage voraus.
async function smoobuSync(tenant) {
  const c = smoobuClient(tenant);
  if (!c) throw new Error('Kein Smoobu-Zugang hinterlegt');

  const von = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const bis = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);

  const unterkuenfte = sync.syncUnits(tenant, await c.unterkuenfte());
  const ergebnis = sync.syncJobs(tenant, await c.buchungen({ from: von, to: bis }));

  // Wegfall und Verschiebung sind die Fälle, bei denen jemand Bescheid wissen muss.
  for (const e of ergebnis.entfallen) {
    if (!e.job.assigned_user_id) continue;
    const kraft = get(`SELECT * FROM users WHERE id = ?`, e.job.assigned_user_id);
    if (e.job.confirmed) sendCalendar(tenant, e.job, kraft, 'CANCEL').catch(() => {});
    if (kraft && !kraft.silent && kraft.email) {
      notify.send({ name: kraft.name, email: kraft.email, channel: kraft.channel },
        // „Reinigung" ist hier richtig und bleibt: Diese Mails entstehen nur im
        // Smoobu-Lauf, und was aus einer Buchung kommt, ist immer eine Reinigung.
        // Sonderaufgaben kennt Smoobu nicht.
        { subject: `Entfällt: Reinigung am ${e.job.due_date}`,
          text: `Hallo ${kraft.name},\n\ndie Reinigung am ${e.job.due_date} entfällt — die Buchung wurde ${e.grund}.` },
        tenant.id).catch(() => {});
    }
    notifyAdmins(tenant, `Reinigung entfällt: ${e.job.due_date}`,
      `Die Buchung wurde ${e.grund}. Die Reinigung am ${e.job.due_date} wurde abgesagt.`);
  }

  for (const v of ergebnis.verschoben) {
    if (!v.warZugesagt || !v.alteKraft) continue;
    const kraft = get(`SELECT * FROM users WHERE id = ?`, v.alteKraft);
    sendCalendar(tenant, { ...v.job, due_date: v.von }, kraft, 'CANCEL').catch(() => {});
    if (kraft && !kraft.silent && kraft.email) {
      const token = auth.ensureMagicToken(kraft);
      notify.send({ name: kraft.name, email: kraft.email, channel: kraft.channel },
        { subject: `Verschoben: Reinigung vom ${v.von} auf den ${v.nach}`,
          text: `Hallo ${kraft.name},\n\ndie Buchung wurde verschoben. Die Reinigung ist jetzt am ${v.nach} statt am ${v.von}.\nKönnen Sie den neuen Termin auch übernehmen?`,
          link: token ? magicUrl(tenant.slug, token) : null }, tenant.id).catch(() => {});
    }
    notifyAdmins(tenant, `Termin verschoben: ${v.von} → ${v.nach}`,
      `Eine bereits zugesagte Reinigung wurde verschoben. ${kraft ? kraft.name : 'Die Kraft'} wurde neu gefragt.`);
  }

  run(`UPDATE tenants SET smoobu_synced_at = ? WHERE id = ?`, new Date().toISOString(), tenant.id);
  return {
    unterkuenfte,
    angelegt: ergebnis.angelegt.length,
    verschoben: ergebnis.verschoben.length,
    entfallen: ergebnis.entfallen.length,
    uebersprungen: ergebnis.uebersprungen,
  };
}

// Abgleich für alle Mandanten mit hinterlegtem Zugang — seit dem Webhook (s. o.)
// nur noch das SICHERHEITSNETZ für verpasste Ereignisse, nicht mehr der Hauptweg.
// Deshalb von stündlich auf 15 Minuten heruntergesetzt: Wer den Webhook nicht
// einträgt, soll nicht bis zu eine Stunde auf eine Spontanbuchung warten. Smoobus
// Limit (1000 Aufrufe/Minute) ist davon um Größenordnungen entfernt.
// ⚠️ Schattenmandanten werden SELTENER abgefragt (30.07.2026, siehe
// `tenants.schattenbetrieb` in db.js). Zwei Gründe, beide praktisch:
//
// 1. Ein Schattenmandant muss nicht aktuell sein. Führend ist das alte System des
//    Betriebs; hier wird nur verglichen, und verglichen wird nachts.
// 2. Beide Systeme hängen am SELBEN Smoobu-Konto. Das alte fragt alle 5 Minuten
//    ab, wir alle 15 — je Lauf zwei Aufrufe (`/api/apartments`, `/api/reservations`).
//    Zusammen wären das gut 30 Aufrufe die Stunde auf einem fremden Konto, dessen
//    Ratenbegrenzung wir nicht in der Hand haben. Stündlich statt viertelstündlich
//    drückt unseren Anteil auf ein Drittel.
//
// Bewusst über `smoobu_synced_at` statt über einen eigenen Merker: Der Wert wird
// bei jedem Abgleich ohnehin geschrieben, und ein zweiter Zeitstempel, der
// dasselbe bedeutet, driftet irgendwann vom ersten ab.
const SCHATTEN_ABSTAND_MS = 55 * 60 * 1000;   // knapp unter einer Stunde, damit ein
                                              // Lauf nicht wegen Sekunden ausfällt

function schattenPause(t) {
  if (!t.schattenbetrieb || !t.smoobu_synced_at) return false;
  const alter = Date.now() - Date.parse(t.smoobu_synced_at);
  return Number.isFinite(alter) && alter < SCHATTEN_ABSTAND_MS;
}

async function smoobuTick() {
  for (const t of all(`SELECT * FROM tenants WHERE active = 1 AND smoobu_key IS NOT NULL`)) {
    if (schattenPause(t)) continue;
    try {
      const r = await smoobuSync(t);
      if (r.angelegt || r.verschoben || r.entfallen) {
        console.log(`[smoobu] ${t.slug}: +${r.angelegt} neu, ${r.verschoben} verschoben, ${r.entfallen} entfallen`);
      }
    } catch (e) {
      console.error(`[smoobu] ${t.slug}: ${e.message}`);
    }
  }
}

// Unterkünfte pflegen (Verwaltung)
app.get('/api/units', requireTenant, auth.requireAdmin, (req, res) => {
  res.json({
    units: all(`SELECT * FROM units WHERE tenant_id = ? AND active = 1 ORDER BY name`, req.tenant.id),
    tenant: {
      checkout_time: req.tenant.checkout_time,
      slot_minutes: req.tenant.slot_minutes,
      travel_minutes: req.tenant.travel_minutes,
      period_start_day: req.tenant.period_start_day,
      region: req.tenant.region || '',
      regionen: REGIONS,
      // Ohne Bundesland gelten nur die bundesweiten Feiertage. Ob das überhaupt
      // eine Rolle spielt, hängt an der Vergütungsregel — deshalb wird hier
      // ausgerechnet, statt die Frage jedem zu stellen.
      feiertage_relevant: ['weekend_holiday', 'holiday']
        .includes(jobsLogic.resolveRule(req.tenant.id, null, null).premium_on),
    },
  });
});

app.post('/api/units', requireTenant, auth.requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  run(`INSERT INTO units(tenant_id, name, location, checkout_time) VALUES(?,?,?,?)`,
      req.tenant.id, name,
      (req.body.location || '').trim() || null, (req.body.checkout_time || '').trim() || null);
  res.json({ ok: true });
});

app.patch('/api/units/:id', requireTenant, auth.requireAdmin, (req, res) => {
  const u = get(`SELECT * FROM units WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!u) return res.status(404).json({ error: 'Unterkunft nicht gefunden' });
  const { name, location, checkout_time, active } = req.body;
  if (name !== undefined && String(name).trim()) run(`UPDATE units SET name = ? WHERE id = ?`, String(name).trim(), u.id);
  if (location !== undefined) run(`UPDATE units SET location = ? WHERE id = ?`, String(location).trim() || null, u.id);
  if (checkout_time !== undefined) {
    const t = String(checkout_time).trim();
    if (t && !zeit.parseHHMM(t)) return res.status(400).json({ error: 'Zeit im Format HH:MM angeben' });
    run(`UPDATE units SET checkout_time = ? WHERE id = ?`, t || null, u.id);
  }
  if (active !== undefined) run(`UPDATE units SET active = ? WHERE id = ?`, active ? 1 : 0, u.id);
  res.json({ ok: true });
});

// Checkliste pflegen (Verwaltung)
app.get('/api/checklist', requireTenant, auth.requireAdmin, (req, res) => {
  res.json({
    units: all(`SELECT id, name FROM units WHERE tenant_id = ? AND active = 1 ORDER BY name`, req.tenant.id),
    items: all(`SELECT * FROM checklist_items WHERE tenant_id = ? AND active = 1
                 ORDER BY unit_id IS NULL DESC, unit_id, position, id`, req.tenant.id),
  });
});

app.post('/api/checklist', requireTenant, auth.requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text fehlt' });
  const unitId = req.body.unit_id ? Number(req.body.unit_id) : null;
  if (unitId && !get(`SELECT id FROM units WHERE id = ? AND tenant_id = ?`, unitId, req.tenant.id)) {
    return res.status(404).json({ error: 'Unterkunft nicht gefunden' });
  }
  const max = get(`SELECT COALESCE(MAX(position), 0) AS p FROM checklist_items
                    WHERE tenant_id = ? AND unit_id IS ?`, req.tenant.id, unitId);
  run(`INSERT INTO checklist_items(tenant_id, unit_id, position, text, wants_photo) VALUES(?,?,?,?,?)`,
      req.tenant.id, unitId, max.p + 1, text, req.body.wants_photo ? 1 : 0);
  res.json({ ok: true });
});

app.patch('/api/checklist/:id', requireTenant, auth.requireAdmin, (req, res) => {
  const i = get(`SELECT * FROM checklist_items WHERE id = ? AND tenant_id = ?`,
                Number(req.params.id), req.tenant.id);
  if (!i) return res.status(404).json({ error: 'Punkt nicht gefunden' });
  const { text, wants_photo } = req.body;
  if (text !== undefined) {
    const t = String(text).trim();
    if (!t) return res.status(400).json({ error: 'Text darf nicht leer sein' });
    run(`UPDATE checklist_items SET text = ? WHERE id = ?`, t, i.id);
  }
  if (wants_photo !== undefined) {
    run(`UPDATE checklist_items SET wants_photo = ? WHERE id = ?`, wants_photo ? 1 : 0, i.id);
  }
  res.json({ ok: true });
});

app.delete('/api/checklist/:id', requireTenant, auth.requireAdmin, (req, res) => {
  // Nicht löschen, nur stilllegen — sonst verschwinden bereits abgehakte Punkte
  // rückwirkend aus erledigten Aufträgen.
  run(`UPDATE checklist_items SET active = 0 WHERE id = ? AND tenant_id = ?`,
      Number(req.params.id), req.tenant.id);
  res.json({ ok: true });
});

// Rundruf: denselben Termin allen infrage kommenden Kräften anbieten.
// Bewusst eine EIGENE Route neben /assign: Zuteilen heißt „du machst das",
// Rundruf heißt „wer kann?". Das sind zwei verschiedene Absichten, und die
// Betreiberin soll sie auch getrennt auslösen können.
// Kein `keineDemo`: Der Rundruf darf in der Demo vorgeführt werden. Dass daraus
// keine echte Mail wird, entscheidet src/notify — dort ist der Riegel richtig
// aufgehoben, weil er dann für jede Route gilt, auch für die nächste.
// Termin von Hand anlegen — Reinigung oder Sonderaufgabe.
//
// ⚠️ Bis zum 27.07.2026 konnte ein Termin NUR aus Smoobu entstehen. Wer Smoobu
// nicht nutzt, hatte eine Anwendung, die leer blieb — und für den quelloffenen
// Stand war das ein Loch im Versprechen: Wir laden zum Selbstbetrieb ein, und
// nach der Einrichtung ging nichts. Im Alltag fehlte es genauso: telefonisch
// gebucht, Mitarbeiter übernachtet, Familienbesuch — Fälle, die bewusst nicht
// in Smoobu landen, für die aber trotzdem gereinigt werden muss.
//
// Danach ist es ein Termin wie jeder andere: zuteilen oder Rundruf, Anfrage,
// Zusage, Kalendereinladung, Stundenzettel.
app.post('/api/jobs', requireTenant, auth.requireAdmin, (req, res) => {
  const istAufgabe = String(req.body.kind || '') === jobsLogic.AUFGABE;
  const datum = String(req.body.due_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return res.status(400).json({ error: 'Bitte ein Datum angeben' });

  const titel = String(req.body.titel || '').trim();
  let unitId = null;
  if (istAufgabe) {
    if (!titel) return res.status(400).json({ error: 'Worum geht es? Bitte die Aufgabe benennen' });
    // Eine Sonderaufgabe DARF zu einer Unterkunft gehören („Waschmaschine in
    // Wohnung 2 warten"), muss aber nicht.
    if (req.body.unit_id) {
      const u = get(`SELECT id FROM units WHERE id = ? AND tenant_id = ?`, Number(req.body.unit_id), req.tenant.id);
      if (!u) return res.status(400).json({ error: 'Unbekannte Unterkunft' });
      unitId = u.id;
    }
  } else {
    const u = get(`SELECT id FROM units WHERE id = ? AND tenant_id = ? AND active = 1`,
                  Number(req.body.unit_id), req.tenant.id);
    if (!u) return res.status(400).json({ error: 'Bitte eine Unterkunft wählen' });
    unitId = u.id;
  }

  const zeit = String(req.body.start_time || '').trim();
  if (zeit && !/^\d{2}:\d{2}$/.test(zeit)) return res.status(400).json({ error: 'Uhrzeit bitte als HH:MM' });

  // ⚠️ Leeres Feld heißt „nach Zeit", nicht 0 €. Ein ausdrückliches 0 bleibt 0
  // (unentgeltlich) — deshalb wird auf leeren String geprüft, nicht auf falsy.
  let payCents = null;
  if (istAufgabe && String(req.body.pay_cents ?? '').trim() !== '') {
    payCents = Math.round(Number(req.body.pay_cents));
    if (!Number.isFinite(payCents) || payCents < 0) {
      return res.status(400).json({ error: 'Der Betrag ist keine gültige Zahl' });
    }
  }

  // ⚠️ Eigener dedup_key mit Zufall. Smoobu-Termine tragen `smoobu:<id>`;
  // `sync.js` fasst ausschließlich an, was es über SEINEN Schlüssel findet.
  // Ein Termin von Hand muss außerhalb dieses Raums liegen — sonst räumt die
  // nächste Synchronisation weg, was jemand eingetragen hat, und es merkt
  // niemand, bis die Reinigung ausfällt. Test in test/manuelle-jobs.test.js.
  const key = `manuell:${auth.randToken(9)}`;
  run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, titel, pay_cents, start_time, dedup_key, note)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      req.tenant.id, unitId, datum,
      istAufgabe ? jobsLogic.AUFGABE : 'apartment',
      istAufgabe ? titel : null, payCents, zeit || null, key,
      String(req.body.note || '').trim() || null);

  const job = get(`SELECT * FROM jobs WHERE tenant_id = ? AND dedup_key = ?`, req.tenant.id, key);
  console.log(`[jobs] ${istAufgabe ? 'Aufgabe' : 'Reinigung'} von Hand angelegt (${datum}, id ${job.id}).`);
  res.json({ ok: true, job });
});

app.post('/api/jobs/:id/rundruf', requireTenant, auth.requireAdmin, async (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (job.status === 'done') return res.status(400).json({ error: 'Termin ist schon erledigt' });
  if (job.assigned_user_id && job.confirmed) {
    return res.status(400).json({ error: 'Termin ist bereits zugesagt' });
  }
  // Eine laufende Einzelanfrage wird durch den Rundruf ersetzt.
  if (job.assigned_user_id) {
    run(`UPDATE jobs SET assigned_user_id = NULL, requested_at = NULL, start_time = NULL WHERE id = ?`, job.id);
    job.assigned_user_id = null;
  }
  const r = await rundrufStarten(req.tenant, job, { anlass: 'Von Hand ausgelöst.' });
  res.json({
    ok: true,
    gefragt: r.gefragt.map(u => u.name),
    uebersprungen: r.uebersprungen.map(s => ({ name: s.user.name, grund: s.grund })),
  });
});

// Termin zuteilen + anfragen (eine Aktion, wie im Original)
app.post('/api/jobs/:id/assign', requireTenant, auth.requireAdmin, async (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  const userId = req.body.user_id ? Number(req.body.user_id) : null;

  // Wechselt ein ZUGESAGTER Termin die Person (oder wird frei), muss der alte
  // Kalendereintrag weg — sonst steht er dort für immer.
  if (job.confirmed && job.assigned_user_id && job.assigned_user_id !== userId) {
    const alt = get(`SELECT * FROM users WHERE id = ?`, job.assigned_user_id);
    sendCalendar(req.tenant, job, alt, 'CANCEL').catch(() => {});
  }

  if (!userId) {
    run(`UPDATE jobs SET assigned_user_id = NULL, confirmed = 0, requested_at = NULL, start_time = NULL WHERE id = ?`, job.id);
    return res.json({ ok: true });
  }

  const u = get(`SELECT * FROM users WHERE id = ? AND tenant_id = ? AND active = 1`, userId, req.tenant.id);
  if (!u) return res.status(404).json({ error: 'Person nicht gefunden' });

  // ⚠️ Kein stiller Riegel, sondern eine Rückmeldung mit Namen und Datum. Die
  // Verwaltung soll den Termin ja vergeben — sie hat nur gerade vergessen, dass
  // diese Kraft im Urlaub ist. Ein wortloses „geht nicht" ließe sie raten.
  // Der Riegel gilt auch beim erneuten Senden: Steht eine Zuteilung aus der Zeit
  // vor dem Urlaubsantrag noch da, wäre gerade das die Anfrage, die niemand
  // gebrauchen kann.
  if (urlaub.imUrlaub(u.id, job.due_date)) {
    return res.status(409).json({
      error: `${u.name} hat am ${fmt.tag(job.due_date)} genehmigten Urlaub. `
           + `Bitte jemand anderen einteilen — oder den Urlaub zuerst zurücknehmen.`,
    });
  }

  // ⚠️ Dieselbe Person erneut anschreiben heißt NOCHMAL SENDEN, nicht neu
  // zuteilen. Vorher setzte jeder Klick `confirmed = 0` und löschte `start_time`
  // — auch bei einem längst zugesagten Termin. Die Kalender-Absage ging dabei
  // nicht raus (die hängt am Personenwechsel), also stand der Termin in ihrem
  // Kalender weiter um 11:00, während Putzflow ihn als „angefragt" ohne Uhrzeit
  // führte. Dazu musste sie ohne Anlass erneut zusagen.
  const nurNochmalSenden = job.assigned_user_id === u.id;
  if (!nurNochmalSenden) {
    // Zeitschlitz gehört zur Person, nicht zum Termin — bei Wechsel neu vergeben.
    run(`UPDATE jobs SET assigned_user_id = ?, confirmed = 0, declined_at = NULL, requested_at = ?, start_time = NULL WHERE id = ?`,
        u.id, nowSql(), job.id);
  }

  let sent = null;
  if (!u.silent && req.body.notify !== false) {
    const token = auth.ensureMagicToken(u);
    const unit = job.unit_id ? get(`SELECT name FROM units WHERE id = ?`, job.unit_id) : null;
    sent = await notify.send(
      { name: u.name, email: u.email, phone: u.phone, channel: u.channel },
      {
        subject: `${jobBezeichnung(job, unit && unit.name)} am ${job.due_date}`,
        // ⚠️ EINE Vorlage für beide Arten, und sie benennt die Sache trotzdem.
        // Zwei Textvarianten waren die erste Fassung — dann vergisst man beim
        // nächsten Mal eine. „Können Sie den Job übernehmen?" wäre die andere
        // Versuchung: eine Vorlage, aber ein Anglizismus, der hier sonst nirgends
        // steht (nach außen heißt es „Termin"), und die Kraft müsste in die
        // Betreffzeile zurückspringen, um zu erfahren, worum es geht.
        text: `Hallo ${u.name},\n\nam ${fmt.tag(job.due_date)} steht an: `
            + `${jobBezeichnung(job, unit && unit.name)}.\nKönnen Sie das übernehmen? `
            + `Bitte kurz zu- oder absagen:`,
        link: token ? magicUrl(req.tenant.slug, token) : null,
      }, req.tenant.id);
  }
  res.json({ ok: true, notified: sent, zustellung: zustellHinweis(u, sent) });
});

// Die Reinigung fällt weg — der Gast kam nicht, die Wohnung wird doch nicht
// gebraucht. Bis zum 28.07.2026 konnte das NUR Smoobu (Storno, Eigenbelegung);
// von Hand ging es gar nicht, und ein selbst angelegter Termin ließ sich nie
// wieder loswerden.
//
// ⚠️ Nicht zu verwechseln mit „diese Kraft kann nicht" — dafür gibt es Umteilen
// und „Zuteilung entfernen", und dort BLEIBT der Termin und will neu vergeben
// werden. Hier verschwindet die Arbeit selbst.
app.post('/api/jobs/:id/absagen', requireTenant, auth.requireAdmin, async (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  // ⚠️ Erledigtes bleibt erledigt: Daran hängen erfasste Arbeitszeit und Lohn.
  // Eine geleistete Reinigung nachträglich verschwinden zu lassen, wäre keine
  // Absage, sondern eine Lücke im Nachweis nach § 17 MiLoG.
  if (job.status === 'done') return res.status(400).json({ error: 'Erledigte Termine lassen sich nicht absagen' });
  if (job.status === 'skipped') return res.status(400).json({ error: 'Termin ist schon abgesagt' });

  const kraft = job.assigned_user_id ? get(`SELECT * FROM users WHERE id = ?`, job.assigned_user_id) : null;
  const unit = job.unit_id ? get(`SELECT name FROM units WHERE id = ?`, job.unit_id) : null;

  // ⚠️ CANCEL nur für einen Termin, der vorher ZUGESAGT war — sonst geht eine
  // Absage für einen Kalendereintrag hinaus, den es nie gab (dieselbe Regel wie
  // beim Umteilen und im Smoobu-Lauf). Wer nur angefragt war, wartet trotzdem auf
  // eine Antwort und muss erfahren, dass sich die Frage erledigt hat — deshalb
  // dort eine schlichte Mail statt der Einladung.
  let sent = null;
  if (kraft && job.confirmed) {
    sent = await sendCalendar(req.tenant, job, kraft, 'CANCEL').catch(() => null);
  } else if (kraft && !kraft.silent) {
    sent = await notify.send(
      { name: kraft.name, email: kraft.email, phone: kraft.phone, channel: kraft.channel },
      { subject: `Entfällt: ${jobBezeichnung(job, unit && unit.name)} am ${job.due_date}`,
        text: `Hallo ${kraft.name},\n\nder Termin am ${fmt.tag(job.due_date)} entfällt — `
            + `${jobBezeichnung(job, unit && unit.name)}.\nSie brauchen nichts weiter zu tun.` },
      req.tenant.id).catch(() => null);
  }

  jobsLogic.absagen(job);
  res.json({ ok: true, notified: sent, zustellung: zustellHinweis(kraft, sent) });
});

// Die Kraft fällt aus — die Reinigung bleibt und wird sofort neu ausgeschrieben.
//
// ⚠️ Der Rundruf-Knopf konnte das nicht: Er verweigert bei einem ZUGESAGTEN Termin
// („Termin ist bereits zugesagt"), und genau das ist der Alltagsfall — sie hat
// zugesagt und wird dann krank. Übrig blieb nur der Umweg über die Auswahl auf
// „— niemand —", den niemand findet, und danach von Hand ein Rundruf.
//
// ⚠️ Der Rundruf geht SOFORT raus, nicht auf Nachfrage. Ein Termin, der nur auf
// „offen" zurückfällt, wartet darauf, dass jemand ihn bemerkt — genau die Lücke,
// durch die eine Reinigung untergeht. Dieselbe Entscheidung wie bei der Absage
// durch die Kraft selbst. Wer eine BESTIMMTE Kraft einsetzen will, nimmt ohnehin
// nicht diesen Weg, sondern die Auswahl daneben („Umteilen").
app.post('/api/jobs/:id/neu-verteilen', requireTenant, auth.requireAdmin, async (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (job.status === 'done') return res.status(400).json({ error: 'Termin ist schon erledigt' });
  if (job.status === 'skipped') return res.status(400).json({ error: 'Termin ist abgesagt' });
  if (!job.assigned_user_id) return res.status(400).json({ error: 'Niemand zugeteilt — nimm den Rundruf' });

  const kraft = get(`SELECT * FROM users WHERE id = ?`, job.assigned_user_id);
  const unit = job.unit_id ? get(`SELECT name FROM units WHERE id = ?`, job.unit_id) : null;

  // Zugesagt: Kalender-Absage, wie beim Umteilen. Nur angefragt: eine kurze
  // Nachricht, sonst wartet sie weiter auf eine Frage, die sich erledigt hat —
  // der Rundruf geht bewusst an alle AUSSER ihr.
  if (kraft && job.confirmed) {
    sendCalendar(req.tenant, job, kraft, 'CANCEL').catch(() => {});
  } else if (kraft && !kraft.silent) {
    notify.send(
      { name: kraft.name, email: kraft.email, phone: kraft.phone, channel: kraft.channel },
      { subject: `Nicht mehr für Sie: ${jobBezeichnung(job, unit && unit.name)} am ${job.due_date}`,
        text: `Hallo ${kraft.name},\n\nder Termin am ${fmt.tag(job.due_date)} wird neu vergeben — `
            + `Sie brauchen nichts weiter zu tun.` },
      req.tenant.id).catch(() => {});
  }

  jobsLogic.zuteilungFreigeben(job);
  job.assigned_user_id = null;
  job.confirmed = 0;

  const r = await rundrufStarten(req.tenant, job, {
    ausser: kraft ? [kraft.id] : [],
    // ⚠️ NICHT der Standardgrund „hat gerade abgesagt" — sie hat nichts gesagt.
    ausserGrund: 'fällt aus',
    anlass: `${kraft ? kraft.name : 'Die zugeteilte Kraft'} fällt aus und wurde von der `
          + `Verwaltung abgemeldet. Der Rundruf ist sofort rausgegangen.`,
  });

  res.json({
    ok: true,
    gefragt: r.gefragt.map(u => u.name),
    uebersprungen: r.uebersprungen.map(s => ({ name: s.user.name, grund: s.grund })),
  });
});

// Zurücknehmen. Ein Fehlklick darf keinen Termin endgültig vernichten — und
// manchmal kommt der Gast eben doch.
//
// ⚠️ Der Termin kommt als OFFEN zurück, nicht als zugesagt: Die Zuteilung ist
// beim Absagen weggefallen, weil die Kraft eine Absage bekommen hat (siehe
// `jobsLogic.absagen`). Sie muss neu gefragt werden — eine Zusage von vorher
// galt einer Reinigung, die abgesagt wurde.
app.post('/api/jobs/:id/einplanen', requireTenant, auth.requireAdmin, (req, res) => {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`, Number(req.params.id), req.tenant.id);
  if (!job) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (job.status !== 'skipped') return res.status(400).json({ error: 'Termin ist nicht abgesagt' });
  jobsLogic.wiederEinplanen(job);
  res.json({ ok: true });
});

app.get('/api/timesheet', requireTenant, auth.requireAdmin, (req, res) => {
  const date = req.query.date || today();
  const userId = Number(req.query.user_id || 0);
  if (userId) return res.json(jobsLogic.timesheet(req.tenant, userId, date));

  const cleaners = all(`SELECT id, name FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('cleaner','lead')`,
                       req.tenant.id);
  res.json({
    period: billing.periodOf(date, req.tenant.period_start_day),
    payroll_email: req.tenant.payroll_email,
    demo: !!req.tenant.is_demo,
    sheets: cleaners.map(c => {
      const ts = jobsLogic.timesheet(req.tenant, c.id, date);
      return { user_id: c.id, name: c.name, ...ts,
               signatur: signatur.status(req.tenant.id, c.id, ts.period.start, ts.signatur_positionen) };
    }),
  });
});

// Vergibt der zugesagten Reinigung einen Zeitschlitz: die erste des Tages zur
// Check-out-Zeit, jede weitere im Takt danach. Ohne das stünden bei drei
// Reinigungen am selben Tag drei ganztägige Einträge im Kalender — wertlos.
function vergibZeit(tenant, job) {
  if (job.start_time) return job.start_time;
  const unit = job.unit_id ? get(`SELECT checkout_time, location FROM units WHERE id = ?`, job.unit_id) : null;
  const basis = (unit && unit.checkout_time) || tenant.checkout_time || '11:00';
  // Die schon verplanten Termine MIT ihrem Ort — sonst plant Putzflow zwei
  // Reinigungen an verschiedenen Anschriften direkt hintereinander.
  const belegt = all(
    `SELECT j.start_time AS time, un.location AS ort
       FROM jobs j LEFT JOIN units un ON un.id = j.unit_id
      WHERE j.tenant_id = ? AND j.assigned_user_id = ? AND j.due_date = ?
        AND j.start_time IS NOT NULL AND j.id <> ?`,
    tenant.id, job.assigned_user_id, job.due_date, job.id);
  const slot = zeit.planeSlot(belegt, {
    basis,
    takt: tenant.slot_minutes || 60,
    fahrzeit: tenant.travel_minutes || 0,
    ort: unit ? unit.location : null,
  });
  run(`UPDATE jobs SET start_time = ? WHERE id = ?`, slot, job.id);
  job.start_time = slot;
  return slot;
}

// --- Kalender ------------------------------------------------------------
// Die ANFRAGE bekommt bewusst keine Einladung — erst die ZUSAGE. Sonst stehen
// im Kalender der Reinigungskraft Termine, die sie nie übernommen hat (G&G-Lehre).
// Abgesagt wird nur, was vorher zugesagt WAR.
async function sendCalendar(tenant, job, user, method) {
  if (!user || !user.email || user.silent) return null;
  const unit = job.unit_id ? get(`SELECT name FROM units WHERE id = ?`, job.unit_id) : null;
  // ⚠️ Auch hier: Eine Sonderaufgabe heißt nach dem, was zu tun ist. Sonst steht
  // im Kalender der Kraft „Reinigung" und sie fährt zur Wohnung, statt in den
  // Laden zu gehen — der Kalendereintrag ist das, wonach sie sich am Tag richtet.
  const titel = jobBezeichnung(job, unit && unit.name);
  const text = method === 'CANCEL'
    ? `Hallo ${user.name},\n\nder Termin am ${job.due_date}${unit ? ' (' + unit.name + ')' : ''} entfällt.\nDer Kalendereintrag wird mit dieser Mail abgesagt.`
    : `Hallo ${user.name},\n\ndanke für die Zusage. Der Termin am ${job.due_date}${unit ? ' (' + unit.name + ')' : ''} ist notiert.\nDie angehängte Datei trägt ihn in Ihren Kalender ein.`;

  const einladung = ics.buildEvent({
    method, jobId: job.id, userId: user.id, date: job.due_date,
    startTime: job.start_time, durationMinutes: tenant.slot_minutes || 60,
    timeZone: tenant.timezone || 'Europe/Berlin',
    summary: titel, location: unit ? unit.name : undefined,
    description: `${tenant.name} — über Putzflow`,
    organizerEmail: process.env.NOTIFY_FROM_EMAIL || 'no-reply@mail.putzflow.de',
    attendeeEmail: user.email, attendeeName: user.name,
  });

  return notify.send(
    { name: user.name, email: user.email, phone: user.phone, channel: user.channel },
    { subject: `${method === 'CANCEL' ? 'Abgesagt' : 'Bestätigt'}: ${titel} am ${job.due_date}`,
      text, attachments: [ics.asAttachment(einladung, method)] },
    tenant.id);
}

// Stundenzettel als PDF an die Lohnbuchhaltung. Ein Steuerbüro will Dokumente,
// keine Tabelle in einer Mail.
app.post('/api/payroll/send', requireTenant, auth.requireAdmin, keineDemo, async (req, res) => {
  const ziel = String(req.body.email || req.tenant.payroll_email || '').trim();
  if (!ziel) return res.status(400).json({ error: 'Adresse der Lohnbuchhaltung fehlt' });
  const datum = req.body.date || today();
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number) : null;

  const kraefte = all(`SELECT id, name FROM users
                        WHERE tenant_id = ? AND active = 1 AND role IN ('cleaner','lead')`, req.tenant.id)
    .filter(c => !ids || ids.includes(c.id));

  const anhaenge = [];
  let ohneUnterschrift = 0, ohneZeit = 0;
  for (const c of kraefte) {
    const ts = jobsLogic.timesheet(req.tenant, c.id, datum);
    if (!ts.signatur_positionen.length) continue;
    const st = signatur.status(req.tenant.id, c.id, ts.period.start, ts.signatur_positionen);
    if (st.zustand !== 'gueltig') ohneUnterschrift++;
    ohneZeit += ts.aufzeichnung.fehlend;
    const buf = await pdf.baue({
      tenantName: req.tenant.name, personName: c.name, periode: ts.period,
      // Nur Geleistetes — geplante Termine sind keine Vergütung.
      items: ts.geleistet, summeCents: ts.total_cents, summeMinuten: ts.total_minutes,
      mindestlohn: ts.mindestlohn, signatur: st,
      auslagen: ts.auslagen, urlaub: ts.urlaub, zuZahlenCents: ts.zu_zahlen_cents,
    });
    anhaenge.push({ name: `Stundenzettel ${c.name} ${ts.period.start}.pdf`,
                    content: buf.toString('base64') });
  }
  if (!anhaenge.length) return res.status(400).json({ error: 'Keine Positionen im Zeitraum' });

  const periode = billing.periodOf(datum, req.tenant.period_start_day);
  const r = await notify.send({ name: 'Lohnbuchhaltung', email: ziel, channel: 'mail' }, {
    subject: `Stundenzettel ${req.tenant.name} — ${periode.start} bis ${periode.end}`,
    text: `Guten Tag,\n\nanbei die Stundenzettel für den Zeitraum ${periode.start} bis ${periode.end}.\n` +
          `${anhaenge.length} Person${anhaenge.length === 1 ? '' : 'en'}.` +
          (ohneUnterschrift ? `\n\nHinweis: ${ohneUnterschrift} Zettel ohne gültige elektronische Bestätigung — dort ist eine Unterschriftszeile vorgesehen.` : '') +
          (ohneZeit ? `\n\nAchtung: ${ohneZeit} erledigte Einsätze ohne Arbeitszeitaufzeichnung. ` +
                      `§ 17 Abs. 1 MiLoG verlangt Beginn, Ende und Dauer je Arbeitstag. Sie sind im PDF rot vermerkt.` : '') +
          `\n\nVersendet über Putzflow.`,
    attachments: anhaenge,
  }, req.tenant.id);

  if (req.body.email) run(`UPDATE tenants SET payroll_email = ? WHERE id = ?`, ziel, req.tenant.id);
  if (!r.ok) return res.status(502).json({ error: r.error || 'Versand fehlgeschlagen' });
  res.json({ ok: true, gesendet: anhaenge.length, ohne_unterschrift: ohneUnterschrift, an: ziel });
});

// Rundruf auslösen: fragen, verschicken, Betreiberin unterrichten.
// `anlass` steht in der Mail an die Verwaltung — bei einer Absage ist die
// Vorgeschichte die halbe Information.
async function rundrufStarten(tenant, job, { ausser = [], ausserGrund, anlass = '' } = {}) {
  const { gefragt, uebersprungen } = rundruf.kandidaten(tenant, job, ausser, ausserGrund);
  const neu = rundruf.anbieten(tenant, job, gefragt);
  const unit = job.unit_id ? get(`SELECT name FROM units WHERE id = ?`, job.unit_id) : null;

  for (const u of neu) {
    const token = auth.ensureMagicToken(u);
    notify.send(
      { name: u.name, email: u.email, phone: u.phone, channel: u.channel },
      {
        subject: `${jobBezeichnung(job, unit && unit.name)} am ${job.due_date} — wer kann?`,
        text: `Hallo ${u.name},\n\nam ${fmt.tag(job.due_date)} steht an: `
            + `${jobBezeichnung(job, unit && unit.name)}.\n`
            + `Diese Anfrage geht an mehrere — wer zuerst zusagt, bekommt den Termin:`,
        link: token ? magicUrl(tenant.slug, token) : null,
      }, tenant.id).catch(() => {});
  }

  // ⚠️ Die Übersprungenen gehören in die Mail. Ein Rundruf, der still an drei
  // von sieben geht, sieht aus wie ein Rundruf an alle — und wenn niemand
  // zusagt, sucht die Betreiberin den Fehler an der falschen Stelle.
  const zeilen = [
    anlass,
    neu.length
      ? `Angefragt (${neu.length}): ${neu.map(u => u.name).join(', ')}`
      : 'Es konnte NIEMAND angefragt werden.',
  ];
  if (uebersprungen.length) {
    zeilen.push('', 'Nicht angefragt:');
    for (const s of uebersprungen) zeilen.push(`  ${s.user.name} — ${s.grund}`);
  }
  notifyAdmins(tenant, `Rundruf: Reinigung am ${job.due_date}`, zeilen.filter(Boolean).join('\n'));
  return { gefragt: neu, uebersprungen };
}

function notifyAdmins(tenant, subject, text) {
  const admins = all(`SELECT name, email, phone, channel FROM users
                       WHERE tenant_id = ? AND role IN ('owner','admin') AND active = 1`, tenant.id);
  for (const a of admins) notify.send(a, { subject, text }, tenant.id).catch(() => {});
}

// ===========================================================================

// ===========================================================================
// Betreiberbereich — OPTIONALES Modul, nicht Teil des Produkts
// ===========================================================================
// `src/betreiber.js` ist unser Abrechnungswerkzeug: der einzige Ort im System,
// an dem jemand mehr als einen Mandanten sieht. Fachlich gehört er nicht zur
// Anwendung — wer Putzflow selbst betreibt, braucht ihn nicht. Deshalb hängt er
// sich seit dem 27.07.2026 selbst ein und wird hier nur versuchsweise geladen.
// Fehlt der Ordner, läuft der Kern ohne ihn weiter; genau das macht den
// quelloffenen Spiegel möglich, ohne unsere Rechnungsstellung mitzuliefern.
//
// ⚠️ Muss VOR express.static und der `/`-Route stehen: Das Modul registriert
// eine eigene `/`-Route für den Betreiber-Host und reicht sonst weiter. Steht
// der Aufruf zu spät, bekommt intern.* die Landing-Page.
//
// ⚠️ Gefragt wird, ob die DATEI da ist — kein try/catch um das require.
// Erster Entwurf fing `MODULE_NOT_FOUND` ab; das verschluckte auch den Fall
// „betreiber.js ist da, aber rechnungslauf.js fehlt": Node nennt im
// Require-Stack ebenfalls betreiber.js, jede Textprüfung darauf greift daneben.
// Der Betreiberbereich wäre dann lautlos weg, obwohl er installiert ist —
// genau die Sorte stiller Ausfall, die hier nie vorkommen soll.
// Jetzt gilt: Datei weg = erwarteter Zustand, Hinweis. Datei da = geladen, und
// JEDER Fehler darin bricht den Start laut ab.
if (require('fs').existsSync(path.join(__dirname, 'src', 'betreiber.js'))) {
  require('./src/betreiber').routen(app, { noCacheHtml, PUBLIC });
} else {
  console.log('[start] Betreiberbereich nicht installiert — Kern läuft ohne.');
}

// Statische Auslieferung + Landing
// ===========================================================================
// index: false — sonst liefert express.static für "/" die index.html aus und die
// Landing-Route unten kommt nie zum Zug (Apex bekäme die Verwaltungs-Oberfläche).
app.use(express.static(PUBLIC, {
  index: false, etag: true, maxAge: '0',
  setHeaders(res, file) { if (file.endsWith('.html')) noCacheHtml(res); },
}));

app.get('/', (req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(PUBLIC, req.tenant ? 'index.html' : 'landing.html'));
});

// Pflichtangaben: „leicht erkennbar, unmittelbar erreichbar" — deshalb ohne .html
// und auf JEDER Subdomain, nicht nur auf der Startseite.
// Die Entscheidungsseite aus der Mail — ohne Anmeldung erreichbar, der Token im
// Pfad ist der Ausweis.
app.get('/angebot/:token', (req, res) => {
  noCacheHtml(res);
  res.sendFile(path.join(PUBLIC, 'angebot.html'));
});

for (const seite of ['impressum', 'datenschutz']) {
  app.get(`/${seite}`, (req, res) => {
    noCacheHtml(res);
    res.sendFile(path.join(PUBLIC, `${seite}.html`));
  });
}

// Die öffentlichen Inhaltsseiten unter sprechender Adresse, ohne `.html`.
// ⚠️ Zwei Bedingungen, und beide sind nötig:
//   1. NUR auf dem öffentlichen Host. Auf einer Mandanten-Subdomain hat eine
//      Verkaufsseite nichts zu suchen — dieselbe Positivliste wie bei robots.
//   2. `existsSync`, weil der quelloffene Spiegel diese Dateien NICHT mitbekommt
//      (Positivliste in `_ops/oss-export.sh`). Ohne die Prüfung liefe eine
//      Selbstinstallation bei jedem Aufruf in einen sendFile-Fehler statt in ein
//      sauberes 404 — für eine Seite, die dort schlicht nicht existiert.
for (const seite of INHALTSSEITEN) {
  const datei = path.join(PUBLIC, `${seite}.html`);
  if (!require('fs').existsSync(datei)) continue;
  app.get(`/${seite}`, (req, res, next) => {
    if (!istOeffentlicheSeite(req)) return next();
    noCacheHtml(res);
    res.sendFile(datei);
  });
}

// ⚠️ Namen und Notizen kommen von Menschen und landen in `page()` — also maskieren.
// Der Urlaubsbescheid war die erste Stelle, an der freier Text eines Nutzers in
// serverseitig gebautes HTML geht; überall sonst rendert die Oberfläche im Browser
// aus JSON. Ohne diese Funktion wäre eine Notiz mit `<script>` eine gespeicherte
// XSS-Lücke, ausgelöst ausgerechnet von der Chefin beim Genehmigen.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, body) {
  return `<!doctype html><html lang="de"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Putzflow</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1c2024}
main{max-width:32rem;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 1px 3px #0002}</style>
<main><h1>${title}</h1>${body}</main></html>`;
}

app.use((req, res) => {
  noCacheHtml(res);
  res.status(404).send(page('Nicht gefunden', '<p>Diese Seite gibt es nicht.</p>'));
});

// ⚠️ MUSS die letzte Registrierung sein, und MUSS vier Parameter haben — daran und
// nur daran erkennt Express eine Fehlerbehandlung. Zusammen mit der Einpackung
// oben ist das die Zusage: Auf jede Anfrage kommt eine Antwort. Ein Fehler darf
// dem Besucher wehtun, aber er darf ihn nicht warten lassen.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[fehler] ${req.method} ${req.originalUrl} —`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  // Der Wortlaut des Fehlers bleibt im Log. Nach außen geht eine Meldung, die
  // sagt, was der Besucher tun kann — technische Innereien helfen ihm nicht und
  // verraten Fremden den Aufbau.
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      error: 'Da ist bei uns etwas schiefgegangen — nicht bei Ihnen. '
           + 'Bitte kurz an hallo@putzflow.de schreiben, dann kümmern wir uns sofort darum.',
    });
  }
  noCacheHtml(res);
  res.status(500).send(page('Da ist etwas schiefgegangen',
    '<p>Der Fehler liegt bei uns, nicht bei Ihnen. Wir sind benachrichtigt.</p>'
    + '<p>Wenn es eilt: <a href="mailto:hallo@putzflow.de">hallo@putzflow.de</a></p>'));
});

// ===========================================================================
// Bootstrap: Demo-Mandant beim ersten Start
// ===========================================================================
function bootstrap() {
  if (get(`SELECT COUNT(*) AS n FROM tenants`).n > 0) return;
  if (process.env.BOOTSTRAP_DEMO !== '1') return;

  // ⚠️ is_demo MUSS hier gesetzt sein. Ohne die Marke wäre der Schaufenster-Mandant
  // ein ganz normaler ohne Testzeitraum — also sofort nur noch lesbar, und die
  // Sperren für Smoobu-Zugang und Lohnversand (`keineDemo`) griffen nicht.
  // Auf hauptbox stand die 1 von Hand in der Datenbank; eine frische Installation
  // hätte sie nicht bekommen.
  run(`INSERT INTO tenants(slug, name, region, is_demo) VALUES('demo', 'Demo-Vermietung', 'NW', 1)`);
  const t = get(`SELECT * FROM tenants WHERE slug = 'demo'`);

  // Mandanten-Default: Pauschale 22,50 €, am Wochenende/Feiertag 30 € (G&G-Muster)
  run(`INSERT INTO comp_rules(tenant_id, mode, base_cents, premium_on, premium_mode, premium_cents)
       VALUES(?, 'flat', 2250, 'weekend_holiday', 'rate', 3000)`, t.id);

  const pw = auth.randToken(9);
  run(`INSERT INTO users(tenant_id, email, name, role, password_hash)
       VALUES(?, 'chefin@example.org', 'Demo-Chefin', 'owner', ?)`, t.id, auth.hashPassword(pw));
  run(`INSERT INTO users(tenant_id, email, name, role) VALUES(?, 'putzkraft@example.org', 'Demo-Putzkraft', 'cleaner')`, t.id);
  const cleaner = get(`SELECT * FROM users WHERE tenant_id = ? AND role = 'cleaner'`, t.id);
  const token = auth.ensureMagicToken(cleaner);

  for (const n of ['Wohnung 1', 'Wohnung 2', 'Wohnung 3']) {
    run(`INSERT INTO units(tenant_id, name) VALUES(?, ?)`, t.id, n);
  }
  const units = all(`SELECT * FROM units WHERE tenant_id = ?`, t.id);
  const base = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    const unit = units[i % units.length];
    run(`INSERT INTO jobs(tenant_id, unit_id, due_date, kind, assigned_user_id, dedup_key)
         VALUES(?, ?, ?, ?, ?, ?)`, t.id, unit.id, d, unit.kind, cleaner.id, `demo:${d}:${unit.id}`);
  }

  console.log(`[bootstrap] Demo-Mandant angelegt.`);
  // ⚠️ Die Adresse aus BASE_URL, nicht unsere. Hier stand „demo.putzflow.de" —
  // auf einer fremden Instanz ein Hinweis auf einen Server, der dem Betreiber
  // nicht gehört.
  console.log(`[bootstrap]   Verwaltung: chefin@example.org / ${pw}`);
  console.log(`[bootstrap]   Erreichbar unter ${BASE_URL.replace('://', '://demo.')} bzw. mit DEFAULT_TENANT=demo`);
  console.log(`[bootstrap]   Magic-Link: /m/${token}`);
}

bootstrap();
setInterval(() => { smoobuTick().catch(e => console.error('[smoobu]', e.message)); }, 15 * 60 * 1000).unref();
setInterval(auth.cleanupExpired, 6 * 3600 * 1000).unref();
// Fotos verfallen nach 90 Tagen — sie unterliegen keiner Aufbewahrungspflicht,
// anders als die Arbeitszeiten, und sind Leistungskontrolle (§ 26 BDSG).
setInterval(() => { try { checkliste.cleanupPhotos(); } catch (e) { console.error('[fotos]', e.message); } },
            12 * 3600 * 1000).unref();
try { checkliste.cleanupPhotos(); } catch { /* beim Start egal */ }
// Entscheidungsangebot: Der Merker je Mandant macht den Lauf wiederholbar, deshalb
// genügt ein grober Takt — es kommt nur darauf an, dass kein Ablauf durchrutscht.
setInterval(() => { angebotslauf().catch(e => console.error('[angebot]', e.message)); },
            12 * 3600 * 1000).unref();
angebotslauf().catch(e => console.error('[angebot]', e.message));

app.listen(PORT, HOST, () => {
  console.log(`[putzflow] läuft auf ${HOST}:${PORT} — Kanäle: ${notify.configured().join(', ') || 'keine'}`);
  for (const h of notify.pruefeKanaele()) console.log(`[notify] ${h}`);
  // ⚠️ Einmal am SMTP-Server anklopfen. Ein falsches Passwort oder ein vom
  // Hoster gesperrter Port fällt sonst erst auf, wenn eine Terminanfrage nicht
  // ankommt — und eine ausbleibende Mail sieht nach nichts aus. Der Start wird
  // dadurch NICHT verhindert: Ein Mailserver, der gerade nicht antwortet, darf
  // die Anwendung nicht am Hochfahren hindern.
  if (notify.configured().includes('smtp')) {
    notify.CHANNELS.smtp.pruefen()
      .then(() => console.log('[notify] SMTP-Verbindung ok'))
      .catch(e => console.warn(`[notify] ⚠️  SMTP nicht erreichbar: ${e.message}`));
  }
  // ⚠️ Als LETZTE Startmeldung. Wer gerade installiert hat, schaut auf das Ende
  // der Ausgabe — steht der Hinweis weiter oben, scrollt er vorbei.
  einrichtung.hinweisBeimStart(BASE_URL);
});
