// Jedes eingebettete <script> in public/ muss überhaupt erst einmal parsen.
//
// ⚠️ Der Anlass: In `landing.html` steckt das Anmeldeformular samt seiner Logik als
// Inline-Skript. Ein einziger Syntaxfehler darin — eine falsch entwertete Regex
// genügt — legt NICHT nur die neue Zeile lahm, sondern das ganze Skriptelement:
// Der Knopf „Konto anlegen" tut dann gar nichts mehr, ohne jede sichtbare Meldung.
// Genau die Sorte Fehler, die auf dem Server grün ist und beim Besucher tot.
//
// Geprüft wird nur die SYNTAX, nicht das Verhalten: Der Code gehört in den Browser
// und würde hier über `document` stolpern. Das reicht auch — ausgeführt wird er
// beim Besucher, geparst muss er vorher werden.
//
// Ausführen: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const SEITEN = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html'));

test('es gibt überhaupt Seiten zu prüfen', () => {
  // Ohne diese Zusicherung wäre der Test still grün, wenn der Ordner umzieht.
  assert.ok(SEITEN.length >= 5, `nur ${SEITEN.length} HTML-Dateien gefunden`);
});

for (const datei of SEITEN) {
  test(`${datei}: eingebettete Skripte parsen`, () => {
    const html = fs.readFileSync(path.join(PUBLIC, datei), 'utf8');
    const bloecke = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    let geprueft = 0;
    for (const [, attribute, code] of bloecke) {
      if (/\ssrc\s*=/i.test(attribute)) continue;                       // externe Datei
      if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attribute)) continue;  // JSON-LD u. ä.
      if (!code.trim()) continue;
      const modul = /type\s*=\s*["']module["']/i.test(attribute);
      assert.doesNotThrow(
        () => new vm.Script(code, { filename: `${datei}#${geprueft + 1}`, ...(modul ? {} : {}) }),
        `${datei}: eingebettetes Skript Nr. ${geprueft + 1} hat einen Syntaxfehler`,
      );
      geprueft++;
    }
    // ⚠️ Bei der Verkaufsseite MUSS etwas dabei sein. Fände das Ausschneiden nichts,
    // wäre der Test still grün und die eigentliche Gefahr ungeprüft.
    //
    // ⚠️ Aber NUR bei unserer eigenen Verkaufsseite. Im OSS-Export wird
    // `landing.html` durch eine Platzhalterseite ohne Anmeldeformular ersetzt
    // (`_ops/oss-vorlagen/`), und dort wäre die Forderung nach `regform` schlicht
    // falsch — am 21.08.2026 hat genau das die Veröffentlichung blockiert. Woran
    // man die eigene erkennt: Sie hat das Formular. Die Syntaxprüfung oben gilt
    // unabhängig davon für jede Seite, und die ist der eigentliche Zweck.
    if (datei === 'landing.html' && /id="regform"/.test(html)) {
      assert.ok(geprueft >= 2, `in landing.html nur ${geprueft} Skripte gefunden`);
      assert.match(html, /name="slug"/, 'das Adressfeld fehlt');
      assert.match(html, /api\/slug-frei/, 'die Verfügbarkeitsprüfung fehlt');
      assert.match(html, /api\/aktion/, 'das Einführungsangebot fehlt');
    }
  });
}
