// checklist.js — Checklisten je Unterkunft und ihre Abarbeitung samt Fotobeleg.
//
// Zweck: Ab einer Handvoll Unterkünfte kann der Betreiber nicht mehr jede Reinigung
// selbst abnehmen. Die Liste sagt der Reinigungskraft, worauf es in DIESER Wohnung
// ankommt; das Foto tritt an die Stelle des eigenen Blicks.
//
// ⚠️ Fotos sind Leistungskontrolle einer namentlich bekannten Beschäftigten
// (§ 26 BDSG). Deshalb bewusst zurückhaltend:
//   - Ein Foto wird nur dort verlangt, wo der Betreiber es ausdrücklich anhakt
//     (`wants_photo`), nicht pauschal für jeden Punkt.
//   - Fotos werden nach FOTO_TAGE Tagen gelöscht. Sie unterliegen keiner
//     Aufbewahrungspflicht — anders als die Arbeitszeiten — und verlieren ihren
//     Zweck, sobald die Reinigung abgenommen ist.
//   - Der Hinweis „erst nach der Reinigung fotografieren" steht in der Oberfläche,
//     damit keine Sachen von Gästen ins Bild geraten.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { get, all, run } = require('./db');

const FOTO_TAGE = Number(process.env.PHOTO_RETENTION_DAYS || 90);
const FOTO_DIR = process.env.PHOTO_DIR ||
  path.join(path.dirname(path.resolve(process.env.DB_FILE || 'data/putzflow.sqlite')), 'fotos');

fs.mkdirSync(FOTO_DIR, { recursive: true });

// Punkte für einen Auftrag: die der Unterkunft plus die mandantenweiten.
function itemsForJob(tenantId, job) {
  return all(
    `SELECT * FROM checklist_items
      WHERE tenant_id = ? AND active = 1 AND (unit_id IS NULL OR unit_id = ?)
      ORDER BY unit_id IS NULL DESC, position, id`,
    tenantId, job.unit_id || 0);
}

// Punkte + Stand der Abarbeitung für genau diesen Auftrag.
function forJob(tenantId, job) {
  const items = itemsForJob(tenantId, job);
  const stand = new Map(
    all(`SELECT * FROM job_checks WHERE job_id = ?`, job.id).map(c => [c.item_id, c]));
  return items.map(i => {
    const c = stand.get(i.id);
    return {
      item_id: i.id,
      text: i.text,
      wants_photo: !!i.wants_photo,
      allgemein: i.unit_id == null,
      done: !!(c && c.done_at),
      done_at: c ? c.done_at : null,
      has_photo: !!(c && c.photo_file),
      note: c ? c.note : null,
    };
  });
}

function fortschritt(liste) {
  const offen = liste.filter(i => !i.done).length;
  return { gesamt: liste.length, offen, fertig: liste.length - offen };
}

function toggle(tenantId, job, itemId, userId, done) {
  const item = get(`SELECT * FROM checklist_items WHERE id = ? AND tenant_id = ?`, itemId, tenantId);
  if (!item) return null;
  const vorhanden = get(`SELECT * FROM job_checks WHERE job_id = ? AND item_id = ?`, job.id, itemId);
  if (!vorhanden) {
    run(`INSERT INTO job_checks(tenant_id, job_id, item_id, user_id, done_at) VALUES(?,?,?,?,?)`,
        tenantId, job.id, itemId, userId, done ? new Date().toISOString() : null);
  } else {
    run(`UPDATE job_checks SET done_at = ?, user_id = ? WHERE id = ?`,
        done ? new Date().toISOString() : null, userId, vorhanden.id);
  }
  return true;
}

// Foto ablegen. Der Dateiname ist zufällig — der Pfad darf nicht erratbar sein,
// die Auslieferung läuft ohnehin nur über eine geprüfte Route.
function savePhoto(tenantId, job, itemId, userId, buffer, mime) {
  const endung = /png/i.test(mime) ? 'png' : 'jpg';
  const name = `${tenantId}-${job.id}-${itemId}-${crypto.randomBytes(8).toString('hex')}.${endung}`;
  fs.writeFileSync(path.join(FOTO_DIR, name), buffer);

  const vorhanden = get(`SELECT * FROM job_checks WHERE job_id = ? AND item_id = ?`, job.id, itemId);
  if (vorhanden) {
    if (vorhanden.photo_file) loeschDatei(vorhanden.photo_file);   // nur ein Bild je Punkt
    run(`UPDATE job_checks SET photo_file = ?, user_id = ?, done_at = COALESCE(done_at, ?) WHERE id = ?`,
        name, userId, new Date().toISOString(), vorhanden.id);
  } else {
    run(`INSERT INTO job_checks(tenant_id, job_id, item_id, user_id, done_at, photo_file) VALUES(?,?,?,?,?,?)`,
        tenantId, job.id, itemId, userId, new Date().toISOString(), name);
  }
  return name;
}

function photoPath(datei) { return path.join(FOTO_DIR, path.basename(datei)); }

function loeschDatei(datei) {
  try { fs.unlinkSync(photoPath(datei)); } catch { /* schon weg */ }
}

// Aufräumen: Fotos nach FOTO_TAGE entfernen, Datenbankeintrag behalten (der Haken
// bleibt gültig, nur der Bildbeleg verfällt).
function cleanupPhotos() {
  const grenze = new Date(Date.now() - FOTO_TAGE * 86400000).toISOString();
  const alt = all(`SELECT id, photo_file FROM job_checks
                    WHERE photo_file IS NOT NULL AND done_at IS NOT NULL AND done_at < ?`, grenze);
  for (const c of alt) {
    loeschDatei(c.photo_file);
    run(`UPDATE job_checks SET photo_file = NULL WHERE id = ?`, c.id);
  }
  if (alt.length) console.log(`[fotos] ${alt.length} Bilder nach ${FOTO_TAGE} Tagen gelöscht`);
  return alt.length;
}

module.exports = {
  FOTO_DIR, FOTO_TAGE,
  itemsForJob, forJob, fortschritt, toggle, savePhoto, photoPath, cleanupPhotos,
};
