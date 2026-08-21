// stundenzettel-pdf.js — Stundenzettel als PDF für die Lohnbuchhaltung.
//
// Ein Steuerbüro will ein Dokument, keine Tabelle in einer Mail. Das PDF trägt
// alle Positionen, die Summe und — wenn abgezeichnet — einen Vermerk zur
// elektronischen Unterschrift samt Zeitpunkt. Fehlt die Unterschrift, bleibt eine
// Zeile zum Unterschreiben von Hand.
//
// ⚠️ Es stehen NUR geleistete Einsätze drauf. Geplante Termine gehören auf den
// Bildschirm (für die Verteilung entlang der Minijob-Grenze), aber nicht in ein
// Dokument für die Lohnbuchhaltung — dort wäre noch nicht geleistete Arbeit als
// Vergütung ausgewiesen. Der Aufrufer filtert, hier wird nur noch gezeichnet.
//
// ⚠️ § 17 Abs. 1 MiLoG verlangt BEGINN, ENDE und DAUER der täglichen Arbeitszeit.
// Eine Spalte „2:00 h" allein erfüllt das nicht. Fehlt die Aufzeichnung ganz, wird
// das ausdrücklich als Mangel vermerkt statt mit einem Strich verschwiegen — ein
// Zettel, der Lücken verschweigt, ist bei einer Prüfung wertlos.
//
// ⚠️ Keine Emojis und keine Häkchen im Text: Die Standard-Schrift (Helvetica) kann
// nur WinAnsi. Ein Häkchen erscheint sonst als Kästchen oder wirft einen Fehler.
// (Dieselbe Falle gab es schon in Glanz & Gloria.)

const PDFDocument = require('pdfkit');

const euro = c => (c / 100).toFixed(2).replace('.', ',') + ' EUR';
const datum = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const stunden = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

/**
 * @param {object} o
 * @param {string} o.tenantName
 * @param {string} o.personName
 * @param {{start:string,end:string}} o.periode
 * @param {{date:string,unit:string,minutes:number,cents:number,mode:string}[]} o.items
 * @param {number} o.summeCents
 * @param {number} o.summeMinuten
 * @param {{zustand:string, signiert_am?:string, name?:string}} o.signatur
 * @param {{genehmigt:object[], auslagen_cents:number, entgelt_cents:number}} [o.auslagen]
 * @param {{posten:object[], entgelt_cents:number, tage:number}} [o.urlaub]
 * @param {number} [o.zuZahlenCents]
 * @returns {Promise<Buffer>}
 */
function baue(o) {
  return new Promise((fertig, fehler) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const teile = [];
    doc.on('data', t => teile.push(t));
    doc.on('end', () => fertig(Buffer.concat(teile)));
    doc.on('error', fehler);

    doc.fontSize(16).text('Stundenzettel', { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#444')
       .text(`${o.tenantName}`)
       .text(`Abrechnungszeitraum ${datum(o.periode.start)} bis ${datum(o.periode.end)}`);
    doc.moveDown(0.6);
    doc.fontSize(12).fillColor('#000').text(o.personName);
    doc.moveDown(0.8);

    // Tabellenkopf
    const x = { tag: 50, objekt: 120, vonbis: 300, zeit: 390, betrag: 460 };
    const kopf = y => {
      doc.fontSize(9).fillColor('#666');
      doc.text('Tag', x.tag, y).text('Unterkunft', x.objekt, y)
         .text('Beginn - Ende', x.vonbis, y, { width: 85, align: 'right' })
         .text('Dauer', x.zeit, y, { width: 60, align: 'right' })
         .text('Betrag', x.betrag, y, { width: 90, align: 'right' });
      doc.moveTo(50, y + 13).lineTo(545, y + 13).strokeColor('#bbb').stroke();
      doc.fillColor('#000');
      return y + 20;
    };

    let y = kopf(doc.y);
    doc.fontSize(10);
    let ohneAufzeichnung = 0;
    for (const i of o.items) {
      if (y > 720) { doc.addPage(); y = kopf(50); doc.fontSize(10); }
      const zeiten = i.zeiten || [];
      const fehlt = !zeiten.length;
      if (fehlt) ohneAufzeichnung++;
      doc.fillColor(fehlt ? '#a00' : '#000');
      doc.text(datum(i.date), x.tag, y)
         .text(String(i.unit || '-').slice(0, 32), x.objekt, y)
         // ⚠️ lineBreak:false — ohne das bricht ein langer Vermerk um und schiebt sich
         // über die naechste Zeile.
         .text(fehlt ? 'nicht erfasst' : zeiten.map(z => `${z.von} - ${z.bis}`).join(', '),
               x.vonbis, y, { width: 85, align: 'right', lineBreak: false })
         .text(i.minutes ? stunden(i.minutes) : '-', x.zeit, y, { width: 60, align: 'right' })
         .text(i.mode === 'hourly' && !i.minutes ? 'nach Zeit' : euro(i.cents),
               x.betrag, y, { width: 90, align: 'right' });
      y += 16;
    }
    doc.fillColor('#000');

    // Urlaub gehört ueber die Summenlinie, nicht darunter zu den Auslagen:
    // Urlaubsentgelt IST Arbeitsentgelt (§ 11 BUrlG, § 14 SGB IV) und geht in die
    // Lohnsumme ein. Stuende es unten bei den Auslagen, buchte die Lohnbuchhaltung
    // es beitragsfrei — falsch, und in der teuren Richtung.
    // ⚠️ Diese Zeilen zaehlen NICHT als fehlende Aufzeichnung. An einem Urlaubstag
    // ist voellig zu Recht keine Arbeitszeit erfasst; sie rot als Mangel zu zeigen
    // wuerde den echten Mangel entwerten, den die Farbe daneben meint.
    for (const u of (o.urlaub && o.urlaub.posten) || []) {
      if (!u.tage) continue;
      if (y > 720) { doc.addPage(); y = kopf(50); doc.fontSize(10); }
      doc.fontSize(10).fillColor('#000');
      doc.text(datum(u.date), x.tag, y)
         .text(String(u.unit || 'Urlaub').slice(0, 32), x.objekt, y)
         .text(u.bezahlt ? `${u.tage} Tag${u.tage === 1 ? '' : 'e'}` : 'unbezahlt',
               x.vonbis, y, { width: 85, align: 'right', lineBreak: false })
         .text('-', x.zeit, y, { width: 60, align: 'right' })
         .text(euro(u.cents), x.betrag, y, { width: 90, align: 'right' });
      y += 16;
    }

    doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor('#666').stroke();
    y += 12;
    doc.fontSize(11)
       .text('Summe', x.objekt, y)
       .text(stunden(o.summeMinuten), x.zeit, y, { width: 60, align: 'right' })
       .text(euro(o.summeCents), x.betrag, y, { width: 90, align: 'right' });
    y += 20;

    // Fehlende Aufzeichnungen benennen statt verschweigen. § 17 Abs. 1 MiLoG:
    // Beginn, Ende und Dauer, spaetestens am siebten Folgetag.
    if (ohneAufzeichnung) {
      doc.fontSize(9).fillColor('#a00').text(
        `${ohneAufzeichnung} Einsatz/Einsaetze ohne Arbeitszeitaufzeichnung. `
        + `Nach § 17 Abs. 1 MiLoG sind Beginn, Ende und Dauer der taeglichen Arbeitszeit `
        + `spaetestens am siebten auf den Arbeitstag folgenden Kalendertag aufzuzeichnen `
        + `und zwei Jahre aufzubewahren. Bitte nachtragen.`, 50, y, { width: 495 });
      y += 34;
      doc.fillColor('#000');
    }

    // Mindestlohn: gilt je Arbeitsstunde und ist unabdingbar (§ 1 MiLoG).
    const ml = o.mindestlohn;
    if (ml && ml.minuten) {
      doc.fontSize(9).fillColor(ml.unterschritten ? '#a00' : '#444');
      doc.text(`Effektiv ${euro(ml.effektiv_cents)} je Stunde bei einem Mindestlohn von ` +
               `${euro(ml.grenze_cents)} je Stunde.`, 50, y);
      y += 12;
      if (ml.unterschritten) {
        doc.text(`Aufstockung auf den Mindestlohn: ${euro(ml.fehlbetrag_cents)}`, 50, y);
        y += 12;
        doc.fontSize(11).fillColor('#000')
           .text('Auszuzahlen', x.objekt, y)
           .text(euro(o.summeCents + ml.fehlbetrag_cents), x.betrag, y, { width: 90, align: 'right' });
        y += 18;
        doc.fontSize(9);
      }
      // Nur zeigen, wenn nicht schon der schaerfere Aufzeichnungs-Vermerk dasteht —
      // sonst steht zweimal dasselbe in unterschiedlichen Worten.
      if (ml.ohne_zeit && !ohneAufzeichnung) {
        doc.fillColor('#444').text(
          `${ml.ohne_zeit} Position(en) ohne erfasste Zeit - dort nicht pruefbar.`, 50, y);
        y += 12;
      }
      doc.fillColor('#000');
      y += 12;
    }

    // Auslagen getrennt ausweisen. ⚠️ Sie sind KEIN Arbeitsentgelt (§ 3 Nr. 50 EStG):
    // Sie in die Lohnsumme zu ziehen wäre nicht nur falsch gebucht, es würde die
    // Kraft auch scheinbar über die Minijob-Grenze schieben. Die ZEIT für die
    // Besorgung steckt dagegen oben in den Positionen.
    const au = o.auslagen;
    if (au && au.genehmigt && au.genehmigt.length) {
      y += 6;
      doc.fontSize(10).fillColor('#000').text('Auslagen (Erstattung, kein Arbeitsentgelt)', 50, y);
      y += 16;
      doc.fontSize(9);
      for (const p of au.genehmigt) {
        if (y > 720) { doc.addPage(); y = 50; }
        doc.text(datum(p.date), x.tag, y)
           .text(String(p.beschreibung || '-').slice(0, 40), x.objekt, y)
           .text(p.minutes ? stunden(p.minutes) : '-', x.zeit, y, { width: 60, align: 'right' })
           .text(euro(p.auslage_cents), x.betrag, y, { width: 90, align: 'right' });
        y += 14;
      }
      doc.fontSize(10)
         .text('Summe Auslagen', x.objekt, y)
         .text(euro(au.auslagen_cents), x.betrag, y, { width: 90, align: 'right' });
      y += 18;
      if (au.entgelt_cents) {
        doc.fontSize(9).fillColor('#444').text(
          `Die Zeit fuer diese Besorgungen ist als Arbeitszeit oben enthalten `
          + `(${euro(au.entgelt_cents)}).`, 50, y);
        y += 14;
      }
      doc.fontSize(11).fillColor('#000')
         .text('Zu ueberweisen', x.objekt, y)
         .text(euro(o.zuZahlenCents), x.betrag, y, { width: 90, align: 'right' });
      y += 20;
    }

    doc.fontSize(9).fillColor('#444');
    if (o.signatur && o.signatur.zustand === 'gueltig') {
      doc.text('Elektronisch abgezeichnet', 50, y);
      doc.text(`von ${o.signatur.name || o.personName} am ` +
               `${new Date(o.signatur.signiert_am).toLocaleString('de-DE')}`, 50, y + 12);
      doc.text('Einfache elektronische Signatur, bestaetigt ueber den persoenlichen Zugangslink.',
               50, y + 24);
    } else {
      if (o.signatur && o.signatur.zustand === 'veraltet') {
        doc.fillColor('#a00').text(
          'Hinweis: Nach dem Abzeichnen wurden Positionen geaendert. Bitte erneut bestaetigen.',
          50, y);
        y += 16;
        doc.fillColor('#444');
      }
      doc.moveTo(50, y + 34).lineTo(260, y + 34).strokeColor('#666').stroke();
      doc.text('Datum, Unterschrift', 50, y + 38);
    }

    doc.end();
  });
}

module.exports = { baue };
