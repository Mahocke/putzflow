// Welcher Betrieb ist gemeint? — die Antwort steht im Host-Header.
//
// ⚠️ Diese Datei entstand aus einem echten Fehlschlag: Auf einer Testinstanz im
// Tailnet (`side.tailf271ca.ts.net`) las Putzflow den Mandanten „side", fand
// ihn nicht und antwortete mit „Unbekannter Mandant". `DEFAULT_TENANT` griff
// nicht, weil ja scheinbar schon ein Betrieb im Namen stand — nichts war falsch
// konfiguriert, die Instanz war trotzdem unbenutzbar.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = '/tmp/putzflow-tenant-test.sqlite';
require('node:fs').rmSync(process.env.DB_FILE, { force: true });

const { slugFromHost } = require('../src/tenant');

function mit(env, fn) {
  const vorher = { ...process.env };
  Object.assign(process.env, env);
  try { fn(); } finally { process.env = vorher; }
}

test('Subdomain der eigenen Domain = Betrieb', () => {
  mit({ BASE_URL: 'https://putzflow.de' }, () => {
    assert.equal(slugFromHost('musterhof.putzflow.de'), 'musterhof');
    assert.equal(slugFromHost('MUSTERHOF.PUTZFLOW.DE'), 'musterhof');
    assert.equal(slugFromHost('musterhof.putzflow.de:443'), 'musterhof');
  });
});

test('Apex, www und app sind kein Betrieb', () => {
  mit({ BASE_URL: 'https://putzflow.de' }, () => {
    assert.equal(slugFromHost('putzflow.de'), null);
    assert.equal(slugFromHost('www.putzflow.de'), null);
    assert.equal(slugFromHost('app.putzflow.de'), null);
    assert.equal(slugFromHost('localhost'), null);
    assert.equal(slugFromHost('127.0.0.1'), null);
    assert.equal(slugFromHost(''), null);
    assert.equal(slugFromHost(undefined), null);
  });
});

test('⚠️ ein fremder Hostname ist KEIN Betrieb', () => {
  mit({ BASE_URL: 'http://100.65.37.122:3991', TENANT_DOMAINS: '' }, () => {
    assert.equal(slugFromHost('side.tailf271ca.ts.net'), null, 'Tailnet-Name');
    assert.equal(slugFromHost('putzflow.fritz.box'), null, 'Heimnetz');
    assert.equal(slugFromHost('100.65.37.122'), null, 'IP-Adresse');
  });
});

test('eigene Domain: die Apex-Adresse ist auch mehrteilig kein Betrieb', () => {
  mit({ BASE_URL: 'https://reinigung.example.de', TENANT_DOMAINS: '' }, () => {
    assert.equal(slugFromHost('reinigung.example.de'), null);
    assert.equal(slugFromHost('www.reinigung.example.de'), null);
    assert.equal(slugFromHost('musterhof.reinigung.example.de'), 'musterhof');
  });
});

test('⚠️ ein selbst betriebener Einzelmandant wird ohne DEFAULT_TENANT gefunden', () => {
  // Sonst hinge die Erreichbarkeit daran, dass sich die Anwendung ihre eigene
  // .env schreiben kann — und genau das verbietet die gehärtete systemd-Unit
  // (ProtectSystem=strict). Der Fehler trat erst beim NÄCHSTEN Neustart auf.
  const { init, run } = require('../src/db');
  const tenant = require('../src/tenant');
  init();
  assert.equal(tenant.einzelbetrieb(), null, 'ohne Mandanten: nichts zu raten');

  run(`INSERT INTO tenants(slug, name, is_demo) VALUES('demo', 'Demo', 1)`);
  assert.equal(tenant.einzelbetrieb(), null, 'der Demo-Mandant zählt nicht');

  run(`INSERT INTO tenants(slug, name, selbstbetrieb) VALUES('musterhof', 'Musterhof', 1)`);
  assert.equal(tenant.einzelbetrieb(), 'musterhof');

  // ⚠️ Ab dem zweiten wird nicht mehr geraten: Dann muss die Adresse sagen, wer
  // gemeint ist, sonst bekäme ein Betrieb die Daten eines anderen zu sehen.
  run(`INSERT INTO tenants(slug, name, selbstbetrieb) VALUES('seeblick', 'Seeblick', 1)`);
  assert.equal(tenant.einzelbetrieb(), null);
});

test('mehrere Domains über TENANT_DOMAINS', () => {
  mit({ BASE_URL: 'https://putzflow.de', TENANT_DOMAINS: 'putzflow.de,putzflow.com' }, () => {
    assert.equal(slugFromHost('musterhof.putzflow.com'), 'musterhof');
    assert.equal(slugFromHost('musterhof.beispiel.org'), null);
  });
});
