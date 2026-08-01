// tenant.js — Mandant kommt aus dem Host: <slug>.putzflow.de
// Apex + www zeigen die Landing-Page (kein Mandant). Für lokale Entwicklung ohne
// Subdomain hilft DEFAULT_TENANT.

const { get } = require('./db');

const APEX_HOSTS = new Set(['putzflow.de', 'www.putzflow.de', 'putzflow.com', 'www.putzflow.com']);

// Unter WELCHEN Domains liegen Mandanten? Alles andere ist keine Subdomain von
// uns, sondern irgendein Hostname, unter dem die Instanz zufällig erreichbar ist.
//
// ⚠️ Ohne diese Grenze war jeder mehrteilige Hostname ein Mandantenname. Bei
// einer Testinstanz im Tailnet las `side.tailf271ca.ts.net` als Mandant „side",
// DEFAULT_TENANT griff nicht mehr — und die Instanz antwortete mit „Unbekannter
// Mandant", ohne dass irgendwo etwas falsch konfiguriert war.
// Dieselbe Falle träfe jeden, der Putzflow hinter einem fremden Hostnamen testet
// (`putzflow.fritz.box`, ein Vorschau-Deploy, eine ngrok-Adresse).
function basisDomains() {
  const roh = process.env.TENANT_DOMAINS
    || (process.env.BASE_URL || '').replace(/^https?:\/\//, '').split('/')[0];
  const eigene = String(roh).split(',')
    .map(d => d.trim().toLowerCase().split(':')[0].replace(/^www\./, ''))
    .filter(Boolean);
  // Die eigenen Adressen bleiben gesetzt, auch wenn BASE_URL fehlt.
  return new Set([...eigene, 'putzflow.de', 'putzflow.com']);
}

function slugFromHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  if (!h || APEX_HOSTS.has(h)) return null;
  if (h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  const parts = h.split('.');
  if (parts.length < 3) return null;                 // z. B. "putzflow.de" ohne Subdomain
  const sub = parts[0];
  if (['www', 'app'].includes(sub)) return null;
  // Nur eine echte Subdomain EINER unserer Domains benennt einen Mandanten.
  const rest = parts.slice(1).join('.');
  const domains = basisDomains();
  if (domains.has(h)) return null;                   // die eigene Adresse selbst, nur mehrteilig
  if (!domains.has(rest)) return null;
  return sub;
}

function bySlug(slug) {
  if (!slug) return null;
  return get(`SELECT * FROM tenants WHERE slug = ? AND active = 1`, slug) || null;
}

// Eine Instanz, ein Betrieb: Gibt es GENAU EINEN selbst eingerichteten Mandanten,
// ist er gemeint, wenn der Host keinen nennt (IP-Adresse, Tailnet-Name, localhost).
//
// ⚠️ Das ersetzt seit dem 27.07.2026 das automatische Eintragen von
// DEFAULT_TENANT in die `.env`. Der Grund ist bitter und lehrreich: Unsere
// eigene systemd-Vorlage härtet mit `ProtectSystem=strict`, also ist das
// Anwendungsverzeichnis schreibgeschützt — nur `data/` nicht. Das Schreiben
// scheiterte still, die Einrichtung funktionierte trotzdem, und **erst der
// nächste Neustart** warf den Betreiber mit „Unbekannter Mandant" hinaus.
// Ein Fehler mit Zündschnur, gefunden beim Nachbau auf einer fremden Maschine.
// Was in der Datenbank steht, überlebt jeden Neustart und jede Härtung.
//
// ⚠️ `selbstbetrieb = 1` ist die Bedingung, nicht „genau ein Mandant". Auf
// putzflow.de gibt es solche Mandanten nicht — dort muss die Apex-Adresse die
// Startseite zeigen und nicht den einzigen Kunden, den wir gerade haben.
function einzelbetrieb() {
  try {
    const treffer = get(`SELECT slug, COUNT(*) OVER () AS n FROM tenants
                          WHERE selbstbetrieb = 1 AND active = 1 LIMIT 2`);
    return treffer && treffer.n === 1 ? treffer.slug : null;
  } catch { return null; }
}

// Middleware: setzt req.tenant (oder null bei Apex/Landing).
function attachTenant(req, res, next) {
  const slug = slugFromHost(req.headers.host)
    || process.env.DEFAULT_TENANT               // ausdrücklich gesetzt gewinnt
    || einzelbetrieb()
    || null;
  req.tenant = bySlug(slug);
  next();
}

function requireTenant(req, res, next) {
  if (!req.tenant) return res.status(404).json({ error: 'Unbekannter Mandant' });
  next();
}

module.exports = { slugFromHost, bySlug, attachTenant, requireTenant, einzelbetrieb, APEX_HOSTS };
