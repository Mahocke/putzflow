# Putzflow

**Reinigungsplanung für Vermietende mit mehreren Ferienwohnungen (DACH).**
Termine verteilen, Zusagen einholen, Arbeitszeiten erfassen, Stundenzettel erzeugen —
mit der deutschen Lohn- und Nachweisschicht: Minijob-Grenze, Mindestlohn-Aufstockung,
Arbeitszeitaufzeichnung nach § 17 MiLoG.

> *English summary: Cleaning scheduling for German-speaking vacation rental hosts. The
> core value is German labour-law compliance (minimum wage top-ups, mini-job earnings
> caps, statutory working-time records), so the code, the interface and these docs are in
> German. Apache-2.0.*

Gehostet gibt es Putzflow unter [putzflow.de](https://putzflow.de). Dieses Repository ist
dieselbe Software zum Selbstbetreiben.

---

## Was es kann

- **Reinigungskräfte melden sich nie an.** Jede bekommt einen persönlichen Link
  (`<betrieb>/m/<token>`) — zusagen, Zeit starten, Checkliste abhaken, fertig melden.
  Keine App, kein Konto, kein Passwort.
- **Mehrere Mandanten** in einer Instanz, getrennt über Subdomains (`<slug>.example.de`).
- **Verdienstgrenze beim Verteilen**: Wer über die Minijob-Grenze käme, wird gar nicht
  erst gefragt. Die Grenze ist an den Mindestlohn gekoppelt und wandert jährlich.
- **Mindestlohnprüfung** über den Abrechnungszeitraum, mit ausgewiesener Aufstockung.
- **Arbeitszeitaufzeichnung** mit Beginn, Ende und Dauer je Einsatz — als PDF für die
  Lohnbuchhaltung.
- **Rundruf**: ein Termin, mehrere Angebote, die erste Zusage gewinnt (atomar).
- **Kalendereinladungen** (RFC 5545) bei Zusage, Absage bei Umverteilung.
- **Smoobu-Anbindung**: Abreisen werden stündlich zu Reinigungen, inklusive Storno,
  verschobener Buchung und Eigenbelegung.

## Voraussetzungen

- **Node.js ≥ 22.5** (die eingebaute SQLite-Schnittstelle wird genutzt, kein `better-sqlite3`)
- `sqlite3` auf der Kommandozeile — für die Sicherung
- `openssl` — einmal, für den `APP_SECRET`
- Für den öffentlichen Betrieb zusätzlich: ein Webserver davor (nginx o. ä.), ein
  Zertifikat und ein Dienst für den Mailversand. Zum Ausprobieren im eigenen Netz
  brauchst du beides **nicht** — siehe „Drei Betriebsarten".

Vier Laufzeit-Abhängigkeiten: `express`, `dotenv`, `pdfkit`, `nodemailer`.
**Kein Build-Step.**

## Loslegen

```bash
git clone <dieses-repo> putzflow && cd putzflow
npm ci                                     # reproduzierbar, nutzt package-lock.json
cp .env.example .env
echo "APP_SECRET=$(openssl rand -hex 32)" >> .env   # PFLICHT, sonst startet nichts
npm test                                   # sollte grün sein
node server.js
```

> Das `>>` hängt an: In der `.env` steht danach **zweimal** `APP_SECRET=`, oben
> die leere Zeile aus der Vorlage, unten deine. Das ist in Ordnung — sowohl
> dotenv als auch systemd nehmen die letzte. Wer aufräumen mag, löscht die
> **obere**, leere.

Beim ersten Start schreibt der Server einen **Einrichtungscode** ins Fenster:

```
  ┌─ Putzflow ist noch nicht eingerichtet.
  │  Öffne  http://localhost:3990/einrichtung
  │  Einrichtungscode:  QRTM-4K7B
  └─ Der Code gilt nur, bis der erste Betrieb angelegt ist.
```

Diese Seite aufrufen, Code eintippen, Betrieb und Inhaberkonto anlegen — fertig.
**Es wird dabei keine Mail verschickt**; der Mailversand darf später kommen.

> Den Code später nachschlagen: er steht in `data/EINRICHTUNG.txt`, bei einem
> systemd-Dienst auch in `journalctl -u putzflow | grep Einrichtungscode`.

> **⚠️ Wenn ein Coding-Agent die Einrichtung für dich macht** — was ausdrücklich ein
> guter Weg ist, siehe unten —, dann gilt: **Gib ihm deine echte E-Mail-Adresse und ein
> Einmal-Passwort, und ändere es danach selbst** unter „Konto" in der Anwendung.
>
> Der Grund ist banal und wird trotzdem übersehen: Was der Agent eintippt, kennt der
> Agent. Es steht in seinem Protokoll, oft auch im Verlauf eines Chatfensters, das
> irgendwo gespeichert wird. Ein Passwort, das jemand anders einmal gesehen hat, ist
> kein Passwort mehr — und dein Konto ist das, an dem Lohndaten und Arbeitszeitnachweise
> hängen.
>
> Bei der **Adresse** ist es umgekehrt: Die soll von Anfang an deine sein, nicht
> `agent@example.com`. Sonst gehen später die Terminanfragen und der „Passwort
> vergessen"-Link an ein Postfach, das es nicht gibt — und du kommst nicht mehr hinein.
> Ändern lässt sich beides jederzeit unter „Konto", die Adresse nur gegen das Passwort.

> **⚠️ Ohne Browser** — also wenn ein Agent die Einrichtung per `curl` macht —
> geht das Formular ins Leere: `POST /einrichtung` antwortet **404**. Die Seite
> schickt ihre Felder als JSON an `/api/einrichtung`:
>
> ```bash
> curl -X POST https://deine-domain.de/api/einrichtung \
>   -H 'content-type: application/json' \
>   -d '{"code":"QRTM-4K7B","firma":"…","name":"…","email":"…","password":"…"}'
> ```
>
> Antwort `{"ok":true,"slug":"…","einzelbetrieb":true}`. `einzelbetrieb` heißt:
> Es ist der einzige selbstbetriebene Mandant, also zeigt die Apex-Adresse ihn
> direkt — dafür ist **kein** `DEFAULT_TENANT` in der `.env` nötig, das steht in
> der Datenbank.

> **Warum überhaupt ein Code?** Eine frische Instanz ist leer. Ohne Nachweis könnte
> der Erste, der die Adresse errät, den Betrieb anlegen und wäre der Inhaber. Der
> Code beweist Zugriff auf die Maschine. Er ist einmalig und **erlischt, sobald ein
> Betrieb existiert** — danach antwortet `/einrichtung` mit „schon eingerichtet".
> Ein Passwort steht dabei nirgends im Protokoll: Das wählst du im Formular.

### Drei Betriebsarten

Es macht einen großen Unterschied, was du vorhast. Die Anleitung darunter ist für
den dritten Fall geschrieben — die ersten beiden brauchen viel weniger.

| | Was du brauchst |
|---|---|
| **1 · Lokal ausprobieren** | Nur die Schritte oben. `NOTIFY_CHANNELS=console` (Standard), dann landen alle Mails im Terminal statt im Postfach. `BOOTSTRAP_DEMO=1` legt zusätzlich einen Demo-Betrieb mit Beispieldaten an (Standard ist aus — der Demo-Betrieb lässt sich ohne Passwort betreten). |
| **2 · Private Testinstanz** (eigenes Netz, Tailscale, VPN) | Zusätzlich `HOST` auf die Adresse setzen, unter der die Instanz erreichbar sein soll, und `BASE_URL` dazu passend. Kein Zertifikat, kein DNS, kein Mailversand nötig. **Genau das ist der Fall, für den Wildcard-DNS und Subdomains unten Unfug wären** — siehe die Warnung darunter. |
| **3 · Öffentlicher Betrieb** | Alles Weitere: eigene Domain, nginx davor, Wildcard-Zertifikat, Transaktions-Mailer mit SPF/DKIM/DMARC, systemd-Dienst, nächtliche Sicherung. |

> **⚠️ `HOST=0.0.0.0` öffnet ALLE Netzwerkkarten** — auf einem gemieteten Server auch die
> zum offenen Internet. Wer damit „nur mal eben im Tailnet testen" will, hat seine
> Reinigungsplanung unbemerkt öffentlich gestellt. Besser ist, gar nicht erst überall zu
> lauschen: Trag die **eine** Adresse ein, unter der die Instanz erreichbar sein soll.
>
> ```bash
> HOST=100.65.37.122          # die Tailscale-Adresse dieser Maschine: tailscale ip -4
> BASE_URL=http://100.65.37.122:3990
> ```
>
> Das wirkt unabhängig von jeder Firewall — es gibt schlicht keinen offenen Port nach
> außen. Zwei Dinge dazu:
>
> - Die Adresse muss beim Start schon existieren. Unter systemd deshalb
>   `After=tailscaled.service` ergänzen, sonst scheitert der Start nach einem Reboot mit
>   `EADDRNOTAVAIL` — `Restart=on-failure` fängt es auf, aber unnötig hässlich.
> - Wenn du stattdessen `0.0.0.0` brauchst, **muss** eine Firewall davor. Mit UFW etwa
>   `ufw allow in on tailscale0 to any port 3990` und sonst nichts. Das ist
>   serverabhängig — prüf mit `ss -ltnp` und von außen mit `curl`, ob wirklich nur der
>   gewünschte Weg offen ist.

> **⚠️ Ein Betrieb oder mehrere?** Putzflow erkennt den Betrieb am Hostnamen
> (`<betrieb>.deine-domain.de`). Läuft die Instanz unter einer Adresse **ohne**
> Subdomain — IP-Adresse, Tailnet-Name, `localhost` — gibt es nichts zu erkennen.
> Dann gilt `DEFAULT_TENANT=<betrieb>` in der `.env`: eine Instanz, ein Betrieb.
> Die Ersteinrichtung trägt die Zeile in diesem Fall selbst ein.
>
> **⚠️ Und die häufigste Stolperfalle:** Als Betrieb gilt eine Subdomain nur unter
> der Domain aus `BASE_URL` (oder `TENANT_DOMAINS`). Ohne diese Grenze läse ein
> Tailnet-Name wie `side.tailf271ca.ts.net` als Betrieb „side" — die Instanz
> antwortete mit „Unbekannter Mandant", und `DEFAULT_TENANT` griffe nicht mehr,
> weil ja scheinbar schon ein Betrieb im Namen stand.

### Vorlagen für den Serverbetrieb

Im Ordner `deploy/`:

- `putzflow.service.example` — systemd-Dienst mit eigenem Benutzer, automatischem
  Neustart und Schreibrecht nur auf `data/`.
- `nginx.conf.example` — Reverse Proxy mit den Headern, auf die es ankommt.

### Wenn du dich ausgesperrt hast

**Mit eingerichtetem Mailversand:** „Passwort vergessen?" auf der Anmeldeseite. Der Link
gilt eine Stunde, lässt sich einmal verwenden, und danach sind alle offenen Anmeldungen
beendet — auf jedem Gerät.

**Ohne Mailversand** (oder wenn die Mail nicht ankommt) setzt du es direkt auf der
Maschine:

```bash
node -e '
  require("dotenv").config();
  const { init, run } = require("./src/db");
  const auth = require("./src/auth");
  init();
  const [email, pw] = process.argv.slice(1);
  const r = run("UPDATE users SET password_hash = ? WHERE email = ?", auth.hashPassword(pw), email);
  console.log(r.changes ? "gesetzt" : "diese Adresse gibt es nicht");
' chefin@example.org neues-passwort

# Danach alle offenen Sitzungen beenden:
sqlite3 data/putzflow.sqlite "DELETE FROM sessions;"
```

## Die `.env`

Alle Schlüssel stehen in `.env.example`. Die wichtigsten:

| Schlüssel | Wofür |
|---|---|
| `APP_SECRET` | **Pflicht.** Ohne ihn startet Putzflow nicht. Verschlüsselt die Smoobu-Zugänge der Mandanten |
| `BASE_URL` | Vollständige Adresse. Landet in den Links der Mails — und bestimmt, unter welcher Domain Subdomains als Betrieb gelten |
| `DB_FILE` | Pfad zur SQLite-Datei |
| `HOST` | Adresse, auf der gelauscht wird. Standard `127.0.0.1` (Webserver davor). Für eine Testinstanz im eigenen Netz die **eine** Adresse eintragen, unter der sie erreichbar sein soll — nicht `0.0.0.0` |
| `DEFAULT_TENANT` | Fester Betrieb, wenn die Instanz ohne Subdomain läuft |
| `TENANT_DOMAINS` | Nur nötig, wenn Betriebe unter mehreren Domains wohnen |
| `NOTIFY_CHANNELS` | `console` (Entwicklung), `smtp` (eigener Mailserver) oder `mail` (Brevo) |
| `SMTP_HOST` … | Zugang zum Mailserver, wenn `smtp` gewählt ist |
| `BREVO_API_KEY` | wenn per Brevo verschickt wird |
| `ALARM_EMAIL` | Wohin gemeldet wird, dass sich jemand angemeldet hat oder eine Anmeldung fehlschlug. **Leer = es geht nichts raus**, es steht nur im Log |

> **⚠️ `APP_SECRET` nie ändern.** Die Smoobu-Zugangsdaten der Mandanten sind damit
> verschlüsselt (AES-256-GCM). Ein neuer Schlüssel macht alle unbrauchbar, ohne
> Fehlermeldung beim Start. Er gehört in die Sicherung.

## Betrieb

### Subdomains

Mandanten laufen auf `<slug>.deine-domain.de`, die Apex-Domain zeigt die Startseite. Du
brauchst deshalb einen **Wildcard-Eintrag** im DNS und ein **Wildcard-Zertifikat**.

> **⚠️ Das geht nur über DNS-01**, nicht über HTTP-01. Let's Encrypt stellt Zertifikate
> für `*.deine-domain.de` ausschließlich gegen einen DNS-TXT-Eintrag aus. Wenn dein
> DNS-Anbieter keine API hat, wird das mühsam.
>
> Mit API läuft es unbeaufsichtigt, wenn du certbot zwei Haken mitgibst — einen,
> der den TXT-Eintrag setzt, und einen, der ihn wieder wegräumt:
>
> ```bash
> certbot certonly --manual --preferred-challenges dns \
>   --manual-auth-hook '/root/dns-hook.sh auth' \
>   --manual-cleanup-hook '/root/dns-hook.sh cleanup' \
>   -d deine-domain.de -d '*.deine-domain.de'
> ```
>
> certbot merkt sich beide in `/etc/letsencrypt/renewal/…conf`; die Verlängerung
> läuft danach von selbst. **Prüf sie einmal** mit
> `certbot renew --cert-name deine-domain.de --dry-run` — ein Haken, der nur beim
> ersten Mal funktioniert, fällt sonst erst in 90 Tagen auf, wenn das Zertifikat
> abgelaufen ist. Der Haken muss dem DNS Zeit zum Nachziehen lassen (ein `sleep`
> von etwa 45 Sekunden nach dem Setzen des Eintrags); ohne das fragt Let's
> Encrypt zu früh und die Prüfung scheitert.

> **⚠️ nginx lädt nach der Verlängerung nicht von selbst neu** und arbeitet dann
> bis zum nächsten Neustart mit dem abgelaufenen Zertifikat weiter — 90 Tage
> nach einer scheinbar geglückten Einrichtung. Ein zweizeiliges Skript in
> `/etc/letsencrypt/renewal-hooks/deploy/` (ausführbar, `systemctl reload nginx`)
> erledigt das für alle Zertifikate der Maschine.

### Mailversand

Putzflow verschickt Terminanfragen, Magic-Links und Stundenzettel. Es gibt **zwei Wege**,
und du brauchst genau einen:

```bash
# a) Ein beliebiger Mailserver — eigener, Postmark, Mailgun, Resend, der des Hosters
NOTIFY_CHANNELS=smtp
SMTP_HOST=smtp.example.net
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
NOTIFY_FROM_EMAIL=no-reply@deine-domain.de

# b) Brevo (das nutzt die gehostete Fassung)
NOTIFY_CHANNELS=mail
BREVO_API_KEY=...
```

Beim Start klopft Putzflow einmal am SMTP-Server an und sagt, ob er antwortet — ein
falsches Passwort fällt sonst erst auf, wenn eine Terminanfrage nicht ankommt, und eine
ausbleibende Mail sieht nach nichts aus.

> **Nebenbei besser über SMTP:** Die Kalendereinladung kommt als **echte Einladung** an
> (`method=REQUEST`), nicht als Dateianhang. Brevos API kann den MIME-Typ eines Anhangs
> nicht setzen.

**Zwei Kanäle zusammen sind ein Netz**, keine Doppelung: `NOTIFY_CHANNELS=smtp,mail`
verschickt über SMTP und fällt auf Brevo zurück, **wenn der Versand fehlschlägt** — nicht
erst, wenn der Kanal gar nicht konfiguriert ist. Das ist die empfohlene Einstellung,
sobald du zwei Wege hast.

> **⚠️ Der vordere gewinnt.** Wer SMTP einträgt und sich wundert, dass weiter über Brevo
> verschickt wird, hat die Reihenfolge falsch herum. Beim Start wird gesagt, welcher vorn
> steht.
>
> **⚠️ Beim Ausweichen kann eine Nachricht doppelt ankommen** — nämlich dann, wenn die
> Verbindung abbricht, *nachdem* der erste Server sie schon angenommen hat. Bewusst so:
> Eine doppelte Terminanfrage ist ein Ärgernis, eine ausgefallene Reinigung ein Schaden.

Richte für deine Absenderdomain **SPF, DKIM und DMARC** ein. Für zehn Unterkünfte reden
wir über rund 100–200 Mails im Monat — das liegt bei jedem Anbieter im Gratisbereich.

> **⚠️ Nicht über ein normales Mailkonto** (web.de, GMX, Gmail, Yahoo) versenden. Ein
> Rundruf sind sieben fast gleiche Mails mit Links binnen Sekunden — genau das Muster,
> das Freemail-Anbieter als Missbrauch werten. Dazu käme eine Privatadresse als Absender,
> kein eigenes DKIM und **kein Bounce-Handling**: Landet eine Terminanfrage im Spam,
> merkt es niemand, und die Reinigung fällt aus.

> **⚠️ Microsoft 365 als SMTP-Ziel hat ein Verfallsdatum.** Basic Auth für SMTP AUTH wird
> Ende 2026 standardmäßig abgeschaltet, danach geht nur noch OAuth 2.0. Wer heute
> Benutzername und Passwort einträgt, baut etwas, das in Monaten stillsteht.

### Smoobu verbinden

Im Reiter „Unterkünfte" unter *Smoobu*. Putzflow braucht **zwei** Angaben, nicht eine:

1. In Smoobu: **Einstellungen → Erweitert → API Keys**
2. Schlüssel anlegen — Smoobu zeigt **API-Schlüssel** und **API-Secret**
3. Beides in Putzflow eintragen

> **⚠️ Das Secret wird nur EINMAL angezeigt** und ist danach nicht mehr abrufbar. Wer es
> verliert, erzeugt in Smoobu ein neues („Regenerate Secret") — der Schlüssel bleibt
> derselbe, das alte Secret gilt aber sofort nicht mehr. Wenn du schon länger einen
> Schlüssel hast und gar kein Secret kennst, ist genau das der Weg.

Putzflow **liest nur** und schreibt nie in dein Smoobu-Konto zurück. Abgeglichen wird
stündlich. Die Zugangsdaten liegen verschlüsselt in der Datenbank (AES-256-GCM aus
`APP_SECRET`), nicht in der `.env`.

> **Warum HMAC?** Smoobu verlangt seit dem 25.09.2026 signierte Anfragen
> (`X-API-Key`, `X-Timestamp`, `X-Nonce`, `X-Signature`). Putzflow macht das von sich aus —
> ⚠️ die Signierung in `src/smoobu.js` ist deshalb kein Beiwerk und darf nicht vereinfacht
> werden. Die Kanonisierung ist heikel: Query-Paare bleiben URL-codiert und werden als
> ganze `key=value`-Strings sortiert; wer vorher dekodiert, bekommt 401.

### Sicherung

> **⚠️ `cp datei.sqlite` ist KEINE Sicherung.** SQLite läuft im WAL-Modus: frisch
> geschriebene Zeilen stehen in der `-wal`-Datei, nicht in der Hauptdatei. Bei uns fehlte
> so einmal ein Drittel der Aufträge — ohne jede Fehlermeldung.

Richtig ist `sqlite3 "$DB" ".backup '$ZIEL'"`; das nimmt das WAL mit und funktioniert bei
laufendem Server. Eine Vorlage liegt in `sicherung-beispiel.sh` — `APP_DIR` und
`BACKUP_DIR` anpassen, ausführbar machen und in die Crontab hängen:

```
# /etc/cron.d/putzflow-sicherung
20 3 * * * root /opt/putzflow/sicherung.sh >> /var/log/putzflow-sicherung.log 2>&1
```

**Spiel eine Sicherung einmal zurück** — eine ungeprobte Sicherung ist eine Vermutung.

Mit zu sichern: die Datenbank, `data/belege`, `data/fotos` **und die `.env`**.

### Was du dauerhaft selbst pflegen musst

Das ist der ehrliche Teil, und er ist wichtiger als die Installation:

**Mindestlohn und Minijob-Grenze ändern sich jedes Jahr.** Beide stehen in
`src/billing.js` (`MINDESTLOHN_BY_YEAR`, `MINIJOB_LIMIT_BY_YEAR`). Ein Test schlägt fehl,
sobald die Pflege fällig ist — ab November auch für das Folgejahr.

> **⚠️ Der Test sagt dir, DASS ein Wert fehlt, nicht WELCHER richtig ist.** Ein
> Sprachmodell danach zu fragen liefert vielleicht die richtige Zahl, vielleicht eine
> plausibel klingende. Ein zu niedriger Mindestlohnwert fällt niemandem auf: Die
> Aufstockung wird zu klein berechnet und ein echter Verstoß gegen § 1 MiLoG bleibt
> unentdeckt. Nimm die amtliche Quelle.

Dasselbe gilt für Rechtsänderungen an der Aufzeichnungspflicht. Wenn du Putzflow selbst
betreibst, trägst du diese Verantwortung — nicht die Software und nicht wir.

## Mitmachen

Fehlerberichte und Verbesserungen sind willkommen — als Issue oder Pull Request.

**Fragen zur Einrichtung auf deinem Server kann ich leider nicht beantworten.** Ich kann
Putzflow betreiben oder Einzelne bei der Einrichtung begleiten, nicht beides; das ist
keine Unfreundlichkeit, sondern eine Rechnung mit meiner Zeit. Wenn du nicht selbst
hosten möchtest, gibt es das gehostete Angebot auf [putzflow.de](https://putzflow.de).

Übrigens: Putzflow ist mit [Claude Code](https://claude.com/claude-code) gebaut. Damit ist
auch die Einrichtung auf einem eigenen Server zu schaffen — das ist ein Erfahrungsbericht,
kein Versprechen, und das Werkzeug kostet Geld.

## Lizenz

**Apache-2.0**, siehe `LICENSE`. Kurz: Du darfst die Software benutzen, ändern,
weitergeben und damit Geld verdienen — auch in einem geschlossenen Produkt. Was du tun
musst: den Lizenztext und die `NOTICE` mitgeben und **geänderte Dateien kennzeichnen**
(Abschnitt 4b, ein Kommentarkopf genügt).

Name und Logo sind ausgenommen — Abschnitt 6 der Lizenz gewährt ausdrücklich keine
Markenrechte, Einzelheiten in `TRADEMARK.md`.

> **Keine Gewährleistung, keine Haftung** (Abschnitte 7 und 8). Das ist bei Software, die
> Mindestlohn und Verdienstgrenzen rechnet, kein Kleingedrucktes: Wenn du Putzflow selbst
> betreibst, trägst **du** die Verantwortung dafür, dass die Werte stimmen und die
> Aufzeichnungen den gesetzlichen Anforderungen genügen. Prüfe das, bevor du dich darauf
> verlässt.
