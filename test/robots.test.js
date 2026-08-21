// Was darf in eine Suchmaschine — und was auf keinen Fall.
//
// ⚠️ Der teuerste denkbare Fehler dieser Anwendung wäre nicht ein Absturz,
// sondern eine Mandanten-Subdomain im Google-Index: Namen von Reinigungskräften,
// Termine, Verdienste. Bis 27.07.2026 sperrte nginx pauschal ALLES; seither
// entscheidet der Code — und zwar über eine POSITIVLISTE.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-robots-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

// Die Logik aus server.js, hier nachgebildet: Sie hängt nur an BASE_URL und am
// Host-Header, nicht an der Datenbank.
function oeffentlichFuer(baseUrl) {
  const h = baseUrl.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().split(':')[0];
  const erlaubt = new Set([h, h.startsWith('www.') ? h.slice(4) : `www.${h}`]);
  return host => erlaubt.has(String(host || '').split(':')[0].toLowerCase());
}

test('nur Apex und www dürfen in den Index', () => {
  const oeff = oeffentlichFuer('https://putzflow.de');
  assert.equal(oeff('putzflow.de'), true);
  assert.equal(oeff('www.putzflow.de'), true);
  assert.equal(oeff('PUTZFLOW.DE'), true, 'Groß/Kleinschreibung egal');
  assert.equal(oeff('putzflow.de:443'), true, 'Port stört nicht');
});

test('⚠️ BASE_URL mit Port — der Fall der selbst betriebenen Instanz', () => {
  // Stand der Port noch im Satz, verglich sich `putzflow.de:3990` gegen
  // `putzflow.de` und die eigene Startseite galt als nicht öffentlich: `noindex`
  // auf der Verkaufsseite, und Seiten, die es nur dort gibt, antworteten mit 404.
  const oeff = oeffentlichFuer('http://putzflow.example:3990');
  assert.equal(oeff('putzflow.example'), true);
  assert.equal(oeff('putzflow.example:3990'), true);
  assert.equal(oeff('kunde.putzflow.example'), false);
});

test('⚠️ Mandanten, Demo und Betreiberbereich NIEMALS', () => {
  const oeff = oeffentlichFuer('https://putzflow.de');
  for (const host of [
    'rheinblick.putzflow.de',      // ein echter Kunde
    'demo.putzflow.de',
    'intern.putzflow.de',          // trägt keinen Mandanten — der gefährliche Fall
    'hof.putzflow.de',
    'irgendwas-neues.putzflow.de', // der Host, den es morgen gibt
  ]) {
    assert.equal(oeff(host), false, `${host} darf nicht indexierbar sein`);
  }
});

test('ein fremder Host, der nur so aussieht, zählt nicht', () => {
  const oeff = oeffentlichFuer('https://putzflow.de');
  assert.equal(oeff('putzflow.de.example.org'), false);
  assert.equal(oeff('boeseputzflow.de'), false);
  assert.equal(oeff(''), false);
  assert.equal(oeff(undefined), false);
});
