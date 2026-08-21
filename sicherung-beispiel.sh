#!/bin/bash
# sicherung-beispiel.sh — Vorlage für die nächtliche Sicherung.
#
# Das ist eine gekürzte Fassung des Skripts, mit dem putzflow.de gesichert wird.
# Pfade und Offsite-Ziel sind herausgenommen; trag deine eigenen ein und häng es
# in die Crontab.
#
# ⚠️ WARUM NICHT EINFACH `cp`:
# SQLite läuft im WAL-Modus. Frisch geschriebene Zeilen stehen in der
# `-wal`-Datei, nicht in der Hauptdatei. Ein `cp datei.sqlite` liefert deshalb
# einen unvollständigen Stand — bei uns fehlte einmal ein Drittel der Aufträge,
# ohne jede Fehlermeldung. Richtig ist `.backup`: nimmt das WAL mit und
# funktioniert bei laufendem Server.
#
# ⚠️ Die `.env` GEHÖRT MIT IN DIE SICHERUNG. Ohne `APP_SECRET` sind die
# verschlüsselten Smoobu-Zugänge deiner Mandanten nach einer Wiederherstellung
# unbrauchbar. Deshalb die Sicherung auch nach `chmod 700` legen.
#
# ⚠️ Wer die Sicherung ändert, spielt sie danach EINMAL zurück. Eine ungeprobte
# Sicherung ist eine Vermutung, kein Sicherheitsnetz.

set -uo pipefail

APP_DIR="${APP_DIR:-/pfad/zu/putzflow}"
BACKUP_DIR="${BACKUP_DIR:-/pfad/zu/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

DB="$APP_DIR/data/putzflow.sqlite"
STAMP=$(date +%Y%m%d-%H%M%S)
ZIEL="$BACKUP_DIR/putzflow-$STAMP.sqlite"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# --- 1. Datenbank ----------------------------------------------------------
sqlite3 "$DB" ".backup '$ZIEL'" || { echo "Sicherung fehlgeschlagen"; exit 1; }

# --- 2. Die Kopie prüfen, statt ihr zu vertrauen ---------------------------
# Beides bricht ab, statt still durchzugehen: Eine kaputte Sicherung, die
# niemand bemerkt, ist schlimmer als gar keine.
if [ "$(sqlite3 -readonly "$ZIEL" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "integrity_check auf der Kopie fehlgeschlagen"; exit 1
fi

LIVE=$(sqlite3 -readonly "$DB" 'SELECT count(*) FROM jobs;')
KOPIE=$(sqlite3 -readonly "$ZIEL" 'SELECT count(*) FROM jobs;')
if [ "$LIVE" != "$KOPIE" ]; then
  echo "Plausibilität: live $LIVE Aufträge, Kopie $KOPIE — Abbruch"; exit 1
fi

# ⚠️ Die Seitendateien der KOPIE wegräumen, bevor gezippt wird. `.backup`
# erzeugt ein Ziel im WAL-Modus, also liegen daneben `<ziel>-wal` und
# `<ziel>-shm`. `gzip` nimmt nur die Hauptdatei mit, die beiden bleiben
# ungepackt liegen — und das Aufräumen unten sucht nach `*.sqlite.gz`, findet
# sie also nie. Ergebnis: zwei Dateileichen pro Nacht, dauerhaft. Am
# 27.07.2026 beim Nachbau nach dieser Anleitung aufgefallen.
# Sie dürfen weg: Der integrity_check oben lief bereits durch, die Kopie ist
# vollständig.
rm -f "$ZIEL-wal" "$ZIEL-shm"

gzip -f "$ZIEL"

# --- 3. Dateien und Konfiguration ------------------------------------------
# ⚠️ Fehler hier MÜSSEN abbrechen. Der Schritt sah lange so aus:
#     tar -czf … 2>/dev/null
# Danach lief das Skript weiter und meldete „Sicherung ok" — obwohl Belege,
# Fotos oder die .env fehlen konnten. Genau die Sorte stiller Teilausfall, vor
# der die WAL-Falle oben warnt, nur eine Ebene später. Ohne die .env ist die
# Sicherung wertlos: Ohne APP_SECRET sind die Smoobu-Zugänge nicht mehr zu
# entschlüsseln.
#
# Aufbewahrungspflichtig sind vor allem data/belege (§ 147 AO) — Fotos dagegen
# verfallen ohnehin nach 90 Tagen.
QUELLEN=""
for q in data/belege data/fotos .env; do
  [ -e "$APP_DIR/$q" ] && QUELLEN="$QUELLEN $q"
done
if [ -n "$QUELLEN" ]; then
  # shellcheck disable=SC2086
  if ! tar -czf "$BACKUP_DIR/dateien-$STAMP.tar.gz" -C "$APP_DIR" $QUELLEN; then
    echo "Dateisicherung fehlgeschlagen — Abbruch"; exit 1
  fi
fi

# --- 4. Aufräumen ----------------------------------------------------------
find "$BACKUP_DIR" -name 'putzflow-*.sqlite.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'dateien-*.tar.gz'     -mtime +"$KEEP_DAYS" -delete
# Seitendateien aus früheren Läufen (siehe oben) — räumt einmalig auf, was eine
# ältere Fassung dieses Skripts hat liegen lassen.
find "$BACKUP_DIR" -name 'putzflow-*.sqlite-wal' -delete
find "$BACKUP_DIR" -name 'putzflow-*.sqlite-shm' -delete

echo "Sicherung ok — $KOPIE Aufträge, $STAMP"

# --- Zurückspielen (in ein TESTVERZEICHNIS, nie direkt über data/) ---------
#   gunzip -c backups/putzflow-<stamp>.sqlite.gz > /tmp/probe.sqlite
#   sqlite3 -readonly /tmp/probe.sqlite "PRAGMA integrity_check; SELECT count(*) FROM jobs;"
#   tar -xzf backups/dateien-<stamp>.tar.gz -C /tmp/probe/
#
# Sinnvolle Ergänzung, die hier fehlt: eine zweite Kopie auf einem ANDEREN
# Rechner. Eine Sicherung auf derselben Maschine hilft gegen Tippfehler, nicht
# gegen einen Ausfall der Maschine.
