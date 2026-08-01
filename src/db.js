// db.js — node:sqlite, Schema + idempotente Migrationen (ALTER-TABLE-IF-not-exists-Muster
// wie in Glanz & Gloria). Alles ist mandantenfähig: JEDE fachliche Tabelle trägt tenant_id.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'putzflow.sqlite');
fs.mkdirSync(path.dirname(path.resolve(DB_FILE)), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

// --- kleine Helfer (gleiche Signatur wie im gg-Repo) ---
function run(sql, ...params) { return db.prepare(sql).run(...params); }
function get(sql, ...params) { return db.prepare(sql).get(...params); }
function all(sql, ...params) { return db.prepare(sql).all(...params); }

// ⚠️ Ist das hier eine FRISCHE Datenbank? Muss VOR dem CREATE TABLE beantwortet
// werden. Grund ist kosmetisch, aber er zählt: Beim allerersten Start meldete
// `addColumn` zehnmal „Spalte ergänzt" — auf einer leeren Datenbank. Technisch
// harmlos (die Spalten stehen nicht im CREATE TABLE, sondern in den
// Migrationen), aber wer Putzflow gerade zum ersten Mal startet, liest zehn
// Zeilen über nachgerüstete Spalten und hält das für ein misslungenes Upgrade.
let frischeDatenbank = false;

function init() {
  frischeDatenbank = !get(`SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                TEXT NOT NULL UNIQUE,
      name                TEXT NOT NULL,
      -- ⚠️ KEIN Standardwert. 'NW' stand hier bis 26.07.2026 und hat den stillen
      -- Rückfall auf nordrhein-westfälische Feiertage eine Ebene tiefer wiederholt:
      -- Selbst nachdem Formular und Server das Feld nicht mehr belegten, schrieb die
      -- Datenbank NW hinein. Leer heißt „nicht angegeben" — dann gelten nur die
      -- bundesweiten Feiertage, und die Oberfläche weist darauf hin.
      region              TEXT,
      timezone            TEXT NOT NULL DEFAULT 'Europe/Berlin',
      minijob_limit_cents INTEGER NOT NULL DEFAULT 0,     -- 0 = gesetzliche Grenze des Jahres
      period_start_day    INTEGER NOT NULL DEFAULT 16,   -- Abrechnungsperiode ab dem …
      checkout_time       TEXT NOT NULL DEFAULT '11:00', -- ab wann gereinigt werden kann
      slot_minutes        INTEGER NOT NULL DEFAULT 60,   -- Länge + Takt der Termine
      travel_minutes      INTEGER NOT NULL DEFAULT 30,   -- Puffer bei Ortswechsel
      smoobu_key          TEXT,                          -- verschlüsselt, gehört dem Kunden
      smoobu_secret       TEXT,                          -- verschlüsselt
      smoobu_synced_at    TEXT,
      smoobu_webhook_token TEXT,                         -- Pfad-Geheimnis für den Sofort-Abgleich
      payroll_email       TEXT,

      is_demo             INTEGER NOT NULL DEFAULT 0,   -- öffentlich zugänglich, Zugangsdaten bekannt
      trial_ends_at       TEXT,                          -- Ende des Testzeitraums
      street              TEXT,
      zip                 TEXT,
      city                TEXT,
      country             TEXT NOT NULL DEFAULT 'DE',
      phone               TEXT,
      email_verified_at   TEXT,                          -- bestätigte Adresse
      verify_token        TEXT,
      trial_extended_at   TEXT,                          -- einmalige Verlängerung
      billing_mode        TEXT NOT NULL DEFAULT 'yearly',-- yearly | monthly
      paid_until          TEXT,
      active              INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS units (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'apartment',
      external_ref TEXT,                                -- z. B. Smoobu-Apartment-ID
      checkout_time TEXT,                               -- überschreibt die Mandanten-Zeit
      location      TEXT,                               -- Anschrift/Ort; gleicher Wert = keine Fahrzeit
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email         TEXT,
      phone         TEXT,                               -- Kontakt; derzeit kein Versandweg
      name          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'cleaner',    -- owner | admin | lead | cleaner
      password_hash TEXT,                               -- nur owner/admin
      magic_token   TEXT UNIQUE,                        -- passwortloser Zugang der Putzkräfte
      channel       TEXT NOT NULL DEFAULT 'mail',       -- derzeit nur 'mail'
      silent        INTEGER NOT NULL DEFAULT 0,         -- still = kein Zugang, keine Nachrichten
      employment    TEXT NOT NULL DEFAULT 'minijob',    -- minijob | midijob | angestellt | firma
      team_lead_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Vergütungsregel. Auflösung von fein nach grob:
    --   user_id gesetzt > unit_id gesetzt > beides NULL (Mandanten-Default)
    CREATE TABLE IF NOT EXISTS comp_rules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      unit_id         INTEGER REFERENCES units(id) ON DELETE CASCADE,
      user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
      mode            TEXT NOT NULL DEFAULT 'flat',     -- flat | hourly
      base_cents      INTEGER NOT NULL DEFAULT 2250,
      premium_on      TEXT NOT NULL DEFAULT 'weekend_holiday',
      premium_mode    TEXT NOT NULL DEFAULT 'rate',     -- rate | percent | none
      premium_cents   INTEGER NOT NULL DEFAULT 3000,
      premium_percent REAL NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      unit_id          INTEGER REFERENCES units(id) ON DELETE SET NULL,
      due_date         TEXT NOT NULL,                   -- YYYY-MM-DD
      kind             TEXT NOT NULL DEFAULT 'apartment',
      status           TEXT NOT NULL DEFAULT 'open',    -- open | done | skipped
      assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      confirmed        INTEGER NOT NULL DEFAULT 0,
      start_time       TEXT,                            -- HH:MM, beim Zusagen vergeben
      requested_at     TEXT,
      declined_at      TEXT,
      dedup_key        TEXT,
      note             TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Checkliste je Unterkunft. unit_id NULL = gilt für ALLE Unterkünfte des
    -- Mandanten (z. B. „Müll rausgebracht"), sonst nur für diese eine.
    CREATE TABLE IF NOT EXISTS checklist_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      unit_id       INTEGER REFERENCES units(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL DEFAULT 0,
      text          TEXT NOT NULL,
      wants_photo   INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Abarbeitung je Auftrag. Ein Eintrag entsteht erst beim Abhaken.
    CREATE TABLE IF NOT EXISTS job_checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      item_id    INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      done_at    TEXT,
      photo_file TEXT,                                 -- Dateiname unter data/fotos/
      note       TEXT
    );

    -- Sonderausgaben: was eine Kraft für den Betrieb auslegt (Kaffeekapseln,
    -- Ersatzschlüssel …). ⚠️ amount_cents ist AUSLAGENERSATZ und KEIN Arbeitsentgelt
    -- (§ 3 Nr. 50 EStG) — es zählt weder in die Minijob-Grenze noch in den
    -- Mindestlohn. minutes ist dagegen echte Arbeitszeit und wird vergütet.
    -- pay_cents NULL = Vergütung aus dem Stundensatz rechnen.
    CREATE TABLE IF NOT EXISTS expenses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      date         TEXT NOT NULL,
      description  TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      minutes      INTEGER NOT NULL DEFAULT 0,
      pay_cents    INTEGER,
      receipt_file TEXT,                               -- Dateiname unter data/belege/
      approved_at  TEXT,
      approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      rejected_at  TEXT,
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rundruf: ein Termin wird MEHREREN Kräften gleichzeitig angeboten, die erste
    -- Zusage bekommt ihn. Warum eine eigene Tabelle und nicht ein Feld an jobs:
    -- jobs.assigned_user_id ist EINE Person; ein Angebot an fünf Leute braucht
    -- fünf Zeilen, sonst weiß man hinterher nicht, wer gefragt wurde und wer
    -- abgesagt hat. Genau das ist der Unterschied zur WhatsApp-Gruppe.
    --
    -- answer: NULL = läuft noch | 'yes' = hat den Termin bekommen
    --         'no' = hat abgelehnt | 'closed' = eine andere war schneller
    CREATE TABLE IF NOT EXISTS job_offers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      offered_at  TEXT NOT NULL,
      answered_at TEXT,
      answer      TEXT
    );

    -- Betreiber der Plattform (wir), NICHT Nutzer eines Mandanten.
    --
    -- ⚠️ BEWUSST EIGENE TABELLEN, nicht users mit einer weiteren Rolle. Die
    -- Mandanten-Isolation ruht darauf, dass jede Sitzung genau EINEN tenant_id
    -- trägt und auth.attachUser sie verwirft, wenn er nicht zum Host passt.
    -- Ein Konto, das alle Mandanten sehen darf, würde diese Zusicherung
    -- aufweichen — hier steht es daneben, mit eigener Sitzungstabelle und
    -- eigenem Cookie. Eine Mandanten-Sitzung kann damit NIE zur Betreiber-
    -- Sitzung werden und umgekehrt.
    CREATE TABLE IF NOT EXISTS platform_admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS platform_sessions (
      id         TEXT PRIMARY KEY,               -- sha256 des Rohtokens
      admin_id   INTEGER NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Einmal-Anmeldelinks für den Betreiberbereich (27.07.2026).
    --
    -- ⚠️ NICHT wie der Magic-Link der Reinigungskräfte. Deren Token steht
    -- dauerhaft in users.magic_token und funktioniert Monate später noch —
    -- vertretbar, weil eine Kraft nur ihre eigenen Termine sieht. Hier hinge
    -- daran der Zugang zu ALLEN Mandanten. Deshalb: kurze Frist, genau eine
    -- Verwendung, danach used_at gesetzt. Wer die Mail später findet, hält
    -- einen toten Link in der Hand.
    -- (Keine Backticks in diesem Block: Das Schema steht in einem
    --  Template-String, ein Backtick im Kommentar beendet ihn mitten im SQL.)
    CREATE TABLE IF NOT EXISTS platform_login_tokens (
      id         TEXT PRIMARY KEY,               -- sha256 des Rohtokens
      admin_id   INTEGER NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Ausgangsrechnungen des Plattform-Betreibers an seine Mandanten.
    --
    -- ⚠️ Zeilen werden NIE gelöscht. Die laufende Nummer entsteht als MAX(lfd)+1
    -- je Jahr; verschwände eine stornierte Rechnung, bekäme die nächste dieselbe
    -- Nummer noch einmal. Storno ist ein Zustand, kein Löschen (§ 14 UStG:
    -- einmalig und fortlaufend).
    CREATE TABLE IF NOT EXISTS rechnungen (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      jahr          INTEGER NOT NULL,
      lfd           INTEGER NOT NULL,
      nummer        TEXT NOT NULL,
      datum         TEXT NOT NULL,
      leistung_von  TEXT NOT NULL,
      leistung_bis  TEXT NOT NULL,
      zahlweise     TEXT NOT NULL,               -- monat | jahr
      einheiten     INTEGER NOT NULL,
      netto_cent    INTEGER NOT NULL,
      ust_cent      INTEGER NOT NULL,
      brutto_cent   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'offen',  -- offen | bezahlt | storniert
      pdf_datei     TEXT,
      erstellt_von  INTEGER REFERENCES platform_admins(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at   TEXT
    );

    -- Abgezeichnete Stundenzettel. Der Hash bindet die Positionen: Ändert jemand
    -- danach eine Zeit, gilt die Unterschrift als veraltet (siehe src/signatur.js).
    CREATE TABLE IF NOT EXISTS timesheet_signatures (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period_start TEXT NOT NULL,
      hash         TEXT NOT NULL,
      snapshot     TEXT,
      signed_at    TEXT NOT NULL,
      signed_name  TEXT,
      total_cents  INTEGER,
      ip           TEXT,
      user_agent   TEXT
    );

    -- Passwort zuruecksetzen. Ein Token, eine Stunde, einmal verwendbar.
    -- ⚠️ Gespeichert wird der HASH des Tokens, nicht das Token selbst — genau wie
    -- bei sessions. Wer die Datenbank liest (Sicherungskopie, Fehlersuche,
    -- Support), koennte sonst jedes offene Zuruecksetzen zu Ende fuehren und
    -- damit jedes Konto uebernehmen.
    CREATE TABLE IF NOT EXISTS password_resets (
      id         TEXT PRIMARY KEY,                        -- sha256(raw)
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,                    -- sha256(raw)
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key       TEXT NOT NULL,
      value     TEXT,
      PRIMARY KEY (tenant_id, key)
    );

    CREATE TABLE IF NOT EXISTS notify_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      channel    TEXT NOT NULL,
      recipient  TEXT,
      subject    TEXT,
      status     TEXT NOT NULL,                         -- sent | failed | redirected
      error      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup   ON jobs(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;
    CREATE INDEX        IF NOT EXISTS idx_jobs_due     ON jobs(tenant_id, due_date);
    CREATE INDEX        IF NOT EXISTS idx_jobs_user    ON jobs(tenant_id, assigned_user_id, due_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email  ON users(tenant_id, email) WHERE email IS NOT NULL;
    CREATE INDEX        IF NOT EXISTS idx_units_tenant ON units(tenant_id);
    CREATE INDEX        IF NOT EXISTS idx_ws_job       ON work_sessions(job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sig_uniq     ON timesheet_signatures(tenant_id, user_id, period_start);
    CREATE INDEX        IF NOT EXISTS idx_items_unit   ON checklist_items(tenant_id, unit_id, position);
    CREATE INDEX        IF NOT EXISTS idx_exp_user     ON expenses(tenant_id, user_id, date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_uniq  ON job_checks(job_id, item_id);
    -- Eine Kraft wird je Termin nur einmal gefragt; ein zweiter Rundruf darf
    -- keine Dubletten erzeugen (INSERT OR IGNORE stützt sich darauf).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_uniq    ON job_offers(job_id, user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rg_nummer      ON rechnungen(nummer);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rg_lfd         ON rechnungen(jahr, lfd);
    CREATE INDEX        IF NOT EXISTS idx_offer_offen   ON job_offers(user_id, answer);
  `);

  // Nachträglich hinzugekommene Spalten für schon bestehende DBs.
  addColumn('tenants', 'period_start_day', `INTEGER NOT NULL DEFAULT 16`);
  // Beschäftigungsart: Die Minijob-Grenze ist ein MERKMAL, keine Voraussetzung.
  // Midijob kennt keine solche Obergrenze, Festangestellte und Reinigungsfirmen
  // erst recht nicht — dort wird nichts gedeckelt und nichts gewarnt.
  addColumn('users', 'employment', `TEXT NOT NULL DEFAULT 'minijob'`);
  // Uhrzeiten: Mehrere ganztägige Einträge an einem Tag sind im Kalender wertlos.
  addColumn('tenants', 'checkout_time', `TEXT NOT NULL DEFAULT '11:00'`);
  addColumn('tenants', 'slot_minutes', `INTEGER NOT NULL DEFAULT 60`);
  addColumn('units', 'checkout_time', `TEXT`);
  addColumn('jobs', 'start_time', `TEXT`);
  // Fahrzeit: Liegen die Unterkünfte an verschiedenen Anschriften, kann eine Kraft
  // nicht direkt von einer in die nächste wechseln.
  addColumn('units', 'location', `TEXT`);
  addColumn('tenants', 'travel_minutes', `INTEGER NOT NULL DEFAULT 30`);
  // Woher kam die Anmeldung? (27.07.2026)
  //
  // ⚠️ Bewusst KEIN Zählpixel und kein Cookie. Ein Meta- oder Google-Pixel
  // bräuchte eine Einwilligung samt Banner — für ein Produkt, dessen
  // Verkaufsargument Rechtskonformität ist, wäre rechtswidriges Tracking auf
  // der eigenen Seite eine unschöne Pointe.
  // Gespeichert wird nur, was der Betreiber selbst in seine Anzeigen-URL
  // geschrieben hat (utm_source/utm_campaign) oder von welcher Seite jemand
  // kam. Kein Personenbezug, keine Wiedererkennung, keine Speicherung im
  // Browser — und genau die eine Frage beantwortet: Welche Anzeige bringt
  // zahlende Kunden?
  addColumn('tenants', 'herkunft', `TEXT`);
  // Smoobu-Zugang des Kunden — verschlüsselt (src/krypto.js), nie im Klartext.
  addColumn('tenants', 'smoobu_key', `TEXT`);
  addColumn('tenants', 'smoobu_secret', `TEXT`);
  addColumn('tenants', 'smoobu_synced_at', `TEXT`);
  // Webhook: Smoobu kann keine Header setzen, das Geheimnis steht deshalb im Pfad.
  // Je Mandant eigener Wert — ein gemeinsamer wäre bei einem Leck bei ALLEN zu tauschen.
  addColumn('tenants', 'smoobu_webhook_token', `TEXT`);
  // Adresse der Lohnbuchhaltung, an die Stundenzettel gehen.
  addColumn('tenants', 'payroll_email', `TEXT`);
  // Schaufenster-Mandant: Zugangsdaten sind öffentlich bekannt. Alles, was nach
  // außen wirkt oder fremde Zugangsdaten aufnimmt, ist dort gesperrt.
  addColumn('tenants', 'is_demo', `INTEGER NOT NULL DEFAULT 0`);
  addColumn('tenants', 'trial_ends_at', `TEXT`);
  // ⚠️ Selbst betrieben heißt: Es gibt hier nichts abzurechnen. Der Mandant
  // entstand über die Ersteinrichtung auf einer eigenen Instanz, nicht über
  // unser Anmeldeformular — ihm einen Testzeitraum zu geben, an dessen Ende die
  // Schreibsperre zuschlägt, wäre sinnlos: Niemand könnte sie aufheben.
  // Ohne dieses Kennzeichen war eine frisch eingerichtete eigene Instanz vom
  // ersten Moment an nur lesbar (`trial_ends_at IS NULL` = abgelaufen). Beim
  // Durchspielen am 27.07.2026 aufgefallen, bevor es jemanden getroffen hat.
  addColumn('tenants', 'selbstbetrieb', `INTEGER NOT NULL DEFAULT 0`);

  // ⚠️ Schattenbetrieb (30.07.2026): Der Mandant läuft mit ECHTEN Daten eines
  // Betriebs mit, der noch auf seinem alten System arbeitet — zum Vergleich, ob
  // beide dasselbe rechnen. Aus ihm darf deshalb NIE eine Nachricht hinausgehen:
  // Die Reinigungskräfte bekämen sonst jeden Termin doppelt, einmal aus dem alten
  // System und einmal von hier, und der Vergleichsbetrieb würde zum Störfall.
  // Der Riegel sitzt in `src/notify/index.js` neben dem Demo-Riegel und aus
  // demselben Grund: an EINER Stelle, nicht an jeder Route — sonst wird er bei der
  // nächsten neuen Route vergessen, und dann ist es zu spät.
  // Zusätzlich fragt der Smoobu-Abgleich einen solchen Mandanten seltener ab
  // (siehe `smoobuTick` in server.js): Er muss nicht aktuell sein, denn führend
  // ist das alte System — und zwei Verbraucher an einem Smoobu-Konto sollen
  // dessen Ratenbegrenzung nicht ausreizen.
  addColumn('tenants', 'schattenbetrieb', `INTEGER NOT NULL DEFAULT 0`);

  // Termine von Hand: Sonderaufgaben ("Kaffeekapseln kaufen") und Reinigungen
  // fuer Buchungen, die bewusst nicht in Smoobu stehen (telefonisch gebucht,
  // Mitarbeiter uebernachtet, Familienbesuch).
  // ⚠️ `titel` traegt NUR die Sonderaufgabe. Eine Reinigung heisst nach ihrer
  // Unterkunft — stuende der Name auch dort, gaebe es zwei Wahrheiten darueber,
  // wie ein Termin heisst, und die erste Umbenennung einer Unterkunft liesse sie
  // auseinanderlaufen.
  addColumn('jobs', 'titel', `TEXT`);
  // ⚠️ Fester Betrag NUR fuer Sonderaufgaben und nur, wenn er ausdruecklich
  // gesetzt wurde. NULL heisst "nach Zeit" und ist nicht dasselbe wie 0.
  addColumn('jobs', 'pay_cents', `INTEGER`);
  // WER hat die Reinigung abgesagt: 'smoobu' (Storno oder Eigenbelegung, aus dem
  // stuendlichen Lauf) oder 'admin' (die Verwaltung von Hand, weil der Gast nicht
  // kam). NULL, solange nichts abgesagt ist.
  // ⚠️ Das ist keine Statistikspalte, sondern eine Weiche: `sync.js` belebt einen
  // `skipped`-Termin wieder, sobald Smoobu die Buchung erneut als Gastbuchung
  // liefert. Bei einem Storno, das der Gast zuruecknimmt, ist das richtig. Bei
  // einer von Hand abgesagten Reinigung waere es fatal — die Buchung steht ja
  // weiter drin, der Gast kam nur nicht. Die Absage waere nach spaetestens einer
  // Stunde wieder weg, ohne dass jemand etwas angefasst haette.
  addColumn('jobs', 'skipped_by', `TEXT`);
  // Anschrift und bestätigte Adresse — sonst legt jeder Beliebige Konten an.
  for (const [sp, def] of [['street', 'TEXT'], ['zip', 'TEXT'], ['city', 'TEXT'],
                           ['country', `TEXT NOT NULL DEFAULT 'DE'`], ['phone', 'TEXT'],
                           ['email_verified_at', 'TEXT'], ['verify_token', 'TEXT'],
                           ['trial_extended_at', 'TEXT'],
                           ['billing_mode', `TEXT NOT NULL DEFAULT 'yearly'`],
                           ['paid_until', 'TEXT'],
                           // Entscheidungsangebot am Ende des Tests. Die Merker tragen das
                           // Datum, FÜR das die Mail ging — nicht nur „gesendet": Nach einer
                           // Verlängerung passt der Merker nicht mehr und die Frage wird vor
                           // dem neuen Ende erneut gestellt.
                           ['entscheidung_mail_fuer', 'TEXT'],
                           ['ablauf_mail_fuer', 'TEXT'],
                           ['angebot_token', 'TEXT'],
                           ['rabatt_prozent', 'INTEGER NOT NULL DEFAULT 0'],
                           ['rabatt_gueltig_bis', 'TEXT'],
                           ['bestellt_am', 'TEXT']]) {
    addColumn('tenants', sp, def);
  }

  // Die Minijob-Grenze war als feste 600 € eingetragen — falsch: sie ist seit 2022
  // dynamisch an den Mindestlohn gekoppelt (2026: 603 €, 2027: 633 €). Der alte
  // Default wird auf 0 = „gesetzliche Grenze des Jahres" zurückgesetzt; ein bewusst
  // abweichend gesetzter Wert bliebe erhalten (60000 kam nur aus dem Default).
  run(`UPDATE tenants SET minijob_limit_cents = 0 WHERE minijob_limit_cents = 60000`);

  // ⚠️ Bestehende Datenbanken behalten den alten NOT-NULL-Default auf `region`.
  // SQLite kann das nicht per ALTER ändern, und ein Tabellen-Neubau wäre für einen
  // Standardwert unverhältnismäßig. Neue Mandanten bekommen deshalb im INSERT
  // ausdrücklich NULL mitgegeben (siehe server.js) — hier wird nur der Fall
  // aufgeräumt, dass ein Mandant nie ein Bundesland gewählt hat.
  // Bestandswerte bleiben unangetastet: Ob 'NW' gewählt oder gefallen ist, lässt
  // sich nachträglich nicht unterscheiden.

  // Treppenhäuser/Gemeinschaftsflächen waren die Eigenheit eines einzelnen Betriebs und
  // haben in einem Produkt für fremde Betriebe nichts zu suchen (26.07.2026): Sie
  // haben eine Sonderrolle im Preis gespielt, die niemand von außen erraten kann.
  // Bestehende Einträge werden zu normalen Unterkünften — Reinigungen daran bleiben
  // dadurch erhalten, statt beim Löschen mit unterzugehen.
  run(`UPDATE units SET kind = 'apartment' WHERE kind = 'stairwell'`);
  run(`UPDATE jobs  SET kind = 'apartment' WHERE kind = 'stairwell'`);

  // Invariante aus G&G: still ⇒ kein Magic-Token (sonst schleicht sich Zugang wieder ein).
  run(`UPDATE users SET magic_token = NULL WHERE silent = 1 AND magic_token IS NOT NULL`);
}

// Idempotentes ALTER TABLE — SQLite kann kein "ADD COLUMN IF NOT EXISTS".
function addColumn(table, column, definition) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (cols.some(c => c.name === column)) return;
  run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  // Auf einer frisch angelegten Datenbank ist das keine Nachricht wert.
  if (!frischeDatenbank) console.log(`[db] Spalte ${table}.${column} ergänzt`);
}

// --- Settings je Mandant ---
function getSetting(tenantId, key, fallback = null) {
  const row = get(`SELECT value FROM settings WHERE tenant_id = ? AND key = ?`, tenantId, key);
  return row ? row.value : fallback;
}
function setSetting(tenantId, key, value) {
  run(`INSERT INTO settings(tenant_id, key, value) VALUES(?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      tenantId, key, value == null ? null : String(value));
}

module.exports = { db, run, get, all, init, getSetting, setSetting, DB_FILE };
