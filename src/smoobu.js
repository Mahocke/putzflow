// smoobu.js — Zugriff auf Smoobu, je Mandant mit dessen eigenen Zugangsdaten.
//
// Anders als bei Glanz & Gloria gibt es hier KEIN zentrales Gateway: Putzflow ist
// mandantenfähig und muss viele Kundenschlüssel halten, nicht einen eigenen.
// Die Signierung ist aber wörtlich die dort erprobte — sie war mühsam genug.
//
// ⚠️ Kanonisierungs-Falle (im gg-Gateway empirisch gefunden): Query-Paare bleiben
// URL-CODIERT und werden als ganze "key=value"-Strings sortiert. Wer vorher
// dekodiert oder nur nach dem Schlüssel sortiert, bekommt 401 — und sucht lange.
//
// Nur GET. Putzflow liest aus Smoobu, schreibt nie zurück.
//
// ZWEI ANMELDEARTEN, absichtlich austauschbar:
//
//   mode 'hmac'   Schlüssel + Secret des KUNDEN. Funktioniert sofort, ohne
//                 Partnerstatus — der Weg für die ersten Kunden und für Entwicklung.
//   mode 'oauth'  Zugriffstoken des Kunden, ausgestellt nach dessen Zustimmung.
//                 Braucht Client-ID/Secret von Smoobu, also Partnerstatus.
//
// ⚠️ Häufiges Missverständnis: OAuth ersetzt NICHT die Zugangsdaten je Mandant.
// Einen Generalschlüssel über fremde Konten gibt es nicht. OAuth ändert nur, WIE
// der mandantenspezifische Zugang entsteht (Zustimmungsdialog statt Copy-and-paste)
// und wie er widerrufen wird. Die Ablage bleibt: verschlüsselt je Mandant.

const crypto = require('crypto');

const BASIS = 'https://login.smoobu.com';
const LEERER_BODY = crypto.createHash('sha256').update('').digest('hex');

function signieren(key, secret, pfad, suchstring) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');   // ohne Millisekunden
  const nonce = crypto.randomUUID();
  const query = suchstring ? suchstring.replace(/^\?/, '').split('&').sort().join('&') : '';
  const kanonisch = ['GET', pfad, query, ts, nonce, LEERER_BODY, key].join('\n');
  return {
    'X-API-Key': key,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Signature': crypto.createHmac('sha256', secret).update(kanonisch).digest('base64'),
  };
}

function client({ mode = 'hmac', key, secret, token, userAgent = 'putzflow/0.1' }) {
  if (mode === 'oauth') {
    if (!token) throw new Error('Smoobu-Zugriffstoken fehlt');
  } else if (!key || !secret) {
    throw new Error('Smoobu-Zugangsdaten fehlen');
  }

  // Die einzige Stelle, an der sich die Anmeldearten unterscheiden.
  function authKopf(pfad, such) {
    return mode === 'oauth'
      ? { Authorization: `Bearer ${token}` }
      : signieren(key, secret, pfad, such);
  }

  async function get(pfad, params = {}) {
    const such = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    const url = BASIS + pfad + (such ? '?' + such : '');

    let letzte;
    // Smoobu wirft sporadisch 502/503 — auch schon vor der HMAC-Umstellung.
    // Je Versuch frisch signieren, sonst läuft der Zeitstempel ab.
    for (let versuch = 1; versuch <= 3; versuch++) {
      const kopf = { ...authKopf(pfad, such ? '?' + such : ''),
                     'User-Agent': userAgent, 'Cache-Control': 'no-cache' };
      const r = await fetch(url, { headers: kopf });
      if (r.status !== 502 && r.status !== 503) {
        if (!r.ok) throw new Error(`Smoobu ${r.status}: ${(await r.text()).slice(0, 180)}`);
        return r.json();
      }
      letzte = r.status;
      if (versuch < 3) await new Promise(r2 => setTimeout(r2, versuch * 2000));
    }
    throw new Error(`Smoobu antwortet dauerhaft mit ${letzte}`);
  }

  return {
    get,
    // Prüft die Zugangsdaten und liefert das Konto zurück.
    async konto() { return get('/api/me'); },
    async unterkuenfte() { return (await get('/api/apartments')).apartments || []; },

    // Buchungen im Zeitraum. Smoobu blättert — wir holen alle Seiten.
    async buchungen({ from, to, seitengroesse = 100 }) {
      const alle = [];
      let seite = 1, seiten = 1;
      do {
        const d = await get('/api/reservations', { from, to, pageSize: seitengroesse, page: seite });
        alle.push(...(d.bookings || []));
        seiten = d.page_count || 1;
        seite += 1;
      } while (seite <= seiten && seite <= 50);       // harte Grenze gegen Endlosschleifen
      return alle;
    },
  };
}

module.exports = { client, signieren };
