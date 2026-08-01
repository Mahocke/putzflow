// m.js — Magic-Link-Seite der Putzkräfte. Passwortlos, eine Seite, große Knöpfe.
// Der Token steckt im Pfad (/m/<token>) und geht nie in einen Query-String
// (der landet sonst in Referrern und Logs).

const TOKEN = location.pathname.split('/').filter(Boolean)[1] || '';
const API = `/api/m/${TOKEN}`;
const $ = s => document.querySelector(s);

let state = null;

const fmtDate = iso => new Date(iso + 'T12:00:00Z')
  .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const euro = c => (c / 100).toFixed(2).replace('.', ',') + ' €';
const hhmm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

// Stundenlohn ohne erfasste Zeit ergibt noch keinen Betrag — nicht als 0,00 € zeigen.
const payLabel = j => (j.mode === 'hourly' && !j.minutes) ? 'nach Zeit' : euro(j.cents);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2200);
}

async function api(path, body, method) {
  const res = await fetch(API + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Fehler ${res.status}`);
  return json;
}

async function load() {
  try {
    state = await api('');
    render();
  } catch (e) {
    $('#content').innerHTML = `<div class="card"><p>${e.message}</p></div>`;
  }
}

function jobCard(j) {
  const past = j.date < state.today;
  const badge = j.status === 'done' ? '<span class="pill ok">erledigt</span>'
    : j.declined ? '<span class="pill bad">abgesagt</span>'
    : j.confirmed ? '<span class="pill ok">zugesagt</span>'
    : j.rundruf ? '<span class="pill warn">Rundruf</span>'
    : j.requested ? '<span class="pill warn">angefragt</span>'
    : '<span class="pill">offen</span>';

  let actions = '';
  if (j.status !== 'done') {
    if (!j.confirmed && !j.declined) {
      // Beim Rundruf muss dranstehen, dass es ein Wettlauf ist — sonst wirkt ein
      // "schon vergeben" beim Tippen wie ein Fehler der Anwendung.
      const hinweis = j.rundruf
        ? '<p class="small muted" style="margin:.2rem 0 .4rem">Diese Anfrage ging an mehrere. Wer zuerst zusagt, bekommt den Termin.</p>'
        : '';
      actions = `${hinweis}
                 <button class="primary" data-act="yes" data-id="${j.id}">Ja, ich übernehme</button>
                 <button class="ghost" data-act="no" data-id="${j.id}">${j.rundruf ? 'Passt mir nicht' : 'Kann ich nicht'}</button>`;
    } else if (j.confirmed) {
      actions = j.running
        ? `<button class="primary" data-act="done" data-id="${j.id}">Fertig</button>`
        : `<button class="primary" data-act="start" data-id="${j.id}">Start</button>
           <button class="ghost" data-act="time" data-id="${j.id}">Zeiten nachtragen</button>`;
    }
  }

  const liste = j.checkliste || [];
  const offen = liste.filter(i => !i.done).length;
  const checkHtml = (j.confirmed && j.status !== 'done' && liste.length) ? `
    <div class="check">
      <div class="row spread small muted" style="margin:.5rem 0 .3rem">
        <span>Checkliste</span><span>${liste.length - offen}/${liste.length}</span>
      </div>
      ${liste.map(i => `
        <label class="check-zeile${i.done ? ' ist-fertig' : ''}">
          <input type="checkbox" data-check="${i.item_id}" data-job="${j.id}"${i.done ? ' checked' : ''}>
          <span>${i.text}</span>
          ${i.wants_photo ? (i.has_photo
            ? '<span class="pill ok">Foto ✓</span>'
            : `<button class="ghost small" data-foto="${i.item_id}" data-job="${j.id}">Foto</button>`) : ''}
        </label>`).join('')}
      ${liste.some(i => i.wants_photo && !i.has_photo)
        ? '<p class="small muted" style="margin:.4rem 0 0">Bitte erst nach der Reinigung fotografieren, wenn die Wohnung leer ist.</p>'
        : ''}
    </div>` : '';

  return `<div class="card">
    <div class="row spread">
      <span class="date">${fmtDate(j.date)}${j.time ? ' · ' + j.time : ''}${past && j.status !== 'done' ? ' <span class="pill bad">überfällig</span>' : ''}</span>
      ${badge}
    </div>
    <div class="small muted">${j.unit || '—'}${j.note ? ' · ' + j.note : ''}</div>
    <div class="small muted">${j.minutes ? hhmm(j.minutes) + ' · ' : ''}${payLabel(j)}</div>
    ${j.running ? '<div class="small" style="color:var(--brand)">⏱ läuft …</div>' : ''}
    ${checkHtml}
    <div class="row" style="margin-top:.6rem">${actions}</div>
  </div>`;
}

function render() {
  $('#hello').textContent = `Hallo ${state.me.name}`;
  $('#tenant').textContent = state.tenant.name;

  const ts = state.timesheet;
  const mj = ts.minijob;                     // null, wenn keine Verdienstgrenze gilt
  const pct = mj ? Math.min(100, Math.round(mj.cents / mj.limit_cents * 100)) : 0;
  const upcoming = state.jobs.filter(j => j.status !== 'done' || j.date >= state.today);

  const sigKarte = (t, titel) => {
    if (!t) return '';
    const z = t.signatur ? t.signatur.zustand : 'offen';
    const knopf = t.darf_signieren && z !== 'gueltig'
      ? `<button class="primary" data-sign="${t.period.start}" style="margin-top:.5rem">
           ${z === 'veraltet' ? 'Erneut abzeichnen' : 'Stundenzettel abzeichnen'}</button>`
      : '';
    const hinweis = z === 'gueltig'
      ? `<div class="small" style="color:var(--ok)">Abgezeichnet am ${new Date(t.signatur.signiert_am).toLocaleDateString('de-DE')}</div>`
      : z === 'veraltet'
        ? '<div class="small" style="color:var(--warn)">Seit Ihrer Bestätigung wurde etwas geändert — bitte erneut abzeichnen.</div>'
        : (t.darf_signieren ? '<div class="small muted">Bitte bestätigen Sie, dass die Zeiten stimmen.</div>' : '');
    return `<div class="card">
      <h2>${titel}</h2>
      <div class="row spread"><strong>${euro(t.total_cents)}</strong>
        <span class="small muted">${hhmm(t.total_minutes)} · ${t.items.length} Einsätze</span></div>
      ${hinweis}${knopf}
    </div>`;
  };

  $('#content').innerHTML = `
    ${sigKarte(state.vorperiode, `Vorige Abrechnung (${state.vorperiode ? state.vorperiode.period.start + ' – ' + state.vorperiode.period.end : ''})`)}
    <div class="card">
      <h2>Diese Abrechnung (${ts.period.start} – ${ts.period.end})</h2>
      <div class="row spread">
        <strong>${euro(ts.zu_zahlen_cents ?? ts.total_cents)}</strong>
        <span class="small muted">${hhmm(ts.total_minutes)} · ${ts.items.length} Einsätze</span>
      </div>
      ${ts.auslagen && ts.auslagen.auslagen_cents
        ? `<div class="small muted">${euro(ts.total_cents)} Lohn und
           ${euro(ts.auslagen.auslagen_cents)} Erstattung für Ausgelegtes</div>` : ''}
      ${ts.mindestlohn && ts.mindestlohn.minuten ? `<div class="small ${ts.mindestlohn.unterschritten ? '' : 'muted'}"
        style="${ts.mindestlohn.unterschritten ? 'color:var(--warn)' : ''}">
        ${euro(ts.mindestlohn.effektiv_cents)} je Stunde${ts.mindestlohn.unterschritten
          ? (ts.period && ts.period.end >= state.today
            ? ` · Stand heute kämen ${euro(ts.mindestlohn.fehlbetrag_cents)} Aufstockung
                auf den Mindestlohn dazu (Periode läuft noch)`
            : ` · Aufstockung auf den Mindestlohn: ${euro(ts.mindestlohn.fehlbetrag_cents)}`)
          : ''}</div>` : ''}
      ${mj ? `<div class="bar ${mj.level === 'over' ? 'over' : mj.level === 'warn' ? 'warn' : ''}"><i style="width:${pct}%"></i></div>
      <div class="small muted">${mj.level === 'over'
        ? `Grenze von ${euro(mj.limit_cents)} überschritten`
        : `noch ${euro(mj.remaining_cents)} bis zur ${euro(mj.limit_cents)}-Grenze`}</div>` : ''}
      ${ts.signatur && ts.signatur.zustand === 'gueltig'
        ? `<div class="small" style="color:var(--ok);margin-top:.4rem">Abgezeichnet am ${new Date(ts.signatur.signiert_am).toLocaleDateString('de-DE')}</div>`
        : ts.darf_signieren
          ? `<button class="primary" data-sign="${ts.period.start}" style="margin-top:.6rem">
               ${ts.signatur && ts.signatur.zustand === 'veraltet' ? 'Erneut abzeichnen' : 'Stundenzettel abzeichnen'}</button>`
          : ''}
    </div>
    ${auslagenKarte(ts.auslagen)}
    ${upcoming.length ? upcoming.map(jobCard).join('') : '<div class="card muted">Zurzeit keine Termine.</div>'}
  `;
}

// Sonderausgaben: was die Kraft für den Betrieb ausgelegt hat. Bewusst zwei Felder —
// das Geld wird erstattet, die Zeit für den Weg wird bezahlt. Beides getrennt zu
// erfassen ist kein Formalismus: Auslagenersatz ist kein Arbeitsentgelt und zählt
// nicht in die Verdienstgrenze, die Zeit dagegen schon.
function auslagenKarte(a) {
  if (!a) return '';
  const zeile = p => `<div class="row spread" style="padding:.35rem 0;border-top:1px solid var(--line)">
      <div>
        <div>${p.beschreibung}</div>
        <div class="small muted">${fmtTag(p.date)}${p.minutes ? ' · ' + hhmm(p.minutes) : ''}
          ${p.zustand === 'offen' ? '· wartet auf Freigabe'
            : p.zustand === 'abgelehnt' ? '· nicht anerkannt' : '· freigegeben'}</div>
      </div>
      <div style="text-align:right">
        <div><strong>${euro(p.auslage_cents)}</strong></div>
        ${p.zustand === 'offen'
          ? `<button class="ghost small" data-ausl-weg="${p.id}">zurückziehen</button>`
          : ''}
        ${p.beleg ? '' : `<button class="ghost small" data-ausl-beleg="${p.id}">Beleg</button>`}
      </div>
    </div>`;

  return `<div class="card">
    <h2>Ausgelegt</h2>
    ${a.posten.length
      ? a.posten.map(zeile).join('') +
        `<div class="row spread" style="padding-top:.5rem;border-top:2px solid var(--line)">
           <span class="small muted">freigegeben und erstattet</span>
           <strong>${euro(a.auslagen_cents)}</strong></div>`
      : '<p class="small muted">Nichts ausgelegt in diesem Zeitraum.</p>'}
    <form id="neueauslage" style="margin-top:.6rem">
      <input name="description" placeholder="Wofür? z. B. Kaffeekapseln" required style="width:100%">
      <div class="row" style="margin-top:.4rem">
        <input name="amount" type="text" inputmode="decimal" placeholder="Betrag €" style="flex:1;min-width:6rem">
        <input name="minutes" type="number" min="0" step="5" placeholder="Minuten Weg" style="flex:1;min-width:6rem">
      </div>
      <button class="primary" type="submit" style="margin-top:.4rem">Melden</button>
      <p class="small muted" style="margin:.3rem 0 0">Den Kassenbon können Sie danach
      fotografieren. Erstattet wird, was Ihre Chefin freigibt.</p>
    </form>
  </div>`;
}

const fmtTag = iso => iso.split('-').reverse().join('.');

document.addEventListener('submit', async ev => {
  const f = ev.target.closest('#neueauslage');
  if (!f) return;
  ev.preventDefault();
  const d = new FormData(f);
  const betrag = String(d.get('amount') || '').replace(',', '.').trim();
  try {
    await api('/auslagen', {
      description: d.get('description'),
      amount_cents: betrag ? Math.round(parseFloat(betrag) * 100) : 0,
      minutes: Number(d.get('minutes') || 0),
    });
    toast('Gemeldet — Ihre Chefin sieht es.');
    await load();
  } catch (e) { toast(e.message); }
});

document.addEventListener('click', async ev => {
  const weg = ev.target.closest('button[data-ausl-weg]');
  if (weg) {
    if (!confirm('Diese Meldung zurückziehen?')) return;
    try { await api(`/auslagen/${weg.dataset.auslWeg}`, null, 'DELETE'); await load(); }
    catch (e) { toast(e.message); }
    return;
  }
  const beleg = ev.target.closest('button[data-ausl-beleg]');
  if (!beleg) return;
  const feld = document.createElement('input');
  feld.type = 'file'; feld.accept = 'image/*'; feld.capture = 'environment';
  feld.onchange = async () => {
    const datei = feld.files && feld.files[0];
    if (!datei) return;
    beleg.disabled = true; beleg.textContent = '…';
    try {
      const klein = await verkleinern(datei);
      const res = await fetch(`${API}/auslagen/${beleg.dataset.auslBeleg}/beleg`, {
        method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: klein,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Fehler ${res.status}`);
      toast('Beleg gespeichert');
      await load();
    } catch (e) { toast(e.message); beleg.disabled = false; beleg.textContent = 'Beleg'; }
  };
  feld.click();
});


document.addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id), act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === 'yes' || act === 'no') {
      const job = (state.jobs || []).find(x => x.id === id);
      // Bei einem Rundruf sagt sie nicht ab, sie winkt nur ab — die Rückfrage
      // „wirklich absagen?" wäre dort schlicht falsch.
      if (act === 'no' && !job?.rundruf && !confirm('Termin wirklich absagen?')) return;
      await api('/respond', { job_id: id, answer: act === 'yes' ? 'yes' : 'no' });
    } else if (act === 'start') {
      await api('/start', { job_id: id });
    } else if (act === 'done') {
      const job = (state.jobs || []).find(x => x.id === id);
      const rest = (job && job.checkliste || []).filter(i => !i.done).length;
      if (rest && !confirm(`Noch ${rest} Punkt${rest === 1 ? '' : 'e'} der Checkliste offen. Trotzdem fertig melden?`)) return;
      // Ohne laufende Zeiterfassung nach den Zeiten fragen, statt still einen Einsatz
      // ohne Arbeitszeit zu buchen. Beginn und Ende sind Pflicht (§ 17 MiLoG) — wer
      // vergessen hat zu starten, soll sie hier eintragen können und nicht erst,
      // wenn die Chefin die Lücke bemerkt.
      if (job && !job.running && !job.minutes) {
        const von = prompt('Wann haben Sie angefangen? (HH:MM)');
        if (!von) return;
        const bis = prompt('Wann waren Sie fertig? (HH:MM)');
        if (!bis) return;
        await api('/time', { job_id: id, from: von, to: bis });
        toast('Erledigt — danke!');
        await load();
        return;
      }
      await api('/done', { job_id: id });
      toast('Erledigt — danke!');
    } else if (act === 'time') {
      const from = prompt('Angefangen um (HH:MM)?');
      if (!from) return;
      const to = prompt('Fertig um (HH:MM)?');
      if (!to) return;
      await api('/time', { job_id: id, from, to });
    }
    await load();
  } catch (e) {
    toast(e.message);
    // War jemand schneller, ist ihre Liste veraltet. Ohne Neuladen stünde der
    // Termin weiter da und lüde zum nächsten vergeblichen Tippen ein.
    if (/vergeben/i.test(e.message)) await load();
  } finally {
    btn.disabled = false;
  }
});

// Stundenzettel abzeichnen
document.addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-sign]');
  if (!btn) return;
  if (!confirm('Sie bestätigen, dass die erfassten Zeiten und Beträge stimmen.')) return;
  btn.disabled = true;
  try {
    await api('/sign', { period_start: btn.dataset.sign });
    toast('Abgezeichnet — danke!');
    await load();
  } catch (e) { toast(e.message); btn.disabled = false; }
});

// Checklistenpunkt abhaken
document.addEventListener('change', async ev => {
  const box = ev.target.closest('input[data-check]');
  if (!box) return;
  try {
    await api('/check', { job_id: Number(box.dataset.job), item_id: Number(box.dataset.check), done: box.checked });
    await load();
  } catch (e) { toast(e.message); box.checked = !box.checked; }
});

// Bild vor dem Hochladen verkleinern: Ein Handyfoto hat gern 4 MB. Das kostet die
// Reinigungskraft Datenvolumen und uns Plattenplatz — 1600 px genügen als Beleg.
function verkleinern(file, maxKante = 1600, guete = 0.8) {
  return new Promise((fertig, fehler) => {
    const bild = new Image();
    bild.onload = () => {
      const faktor = Math.min(1, maxKante / Math.max(bild.width, bild.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bild.width * faktor);
      c.height = Math.round(bild.height * faktor);
      c.getContext('2d').drawImage(bild, 0, 0, c.width, c.height);
      c.toBlob(b => b ? fertig(b) : fehler(new Error('Bild ließ sich nicht umwandeln')), 'image/jpeg', guete);
      URL.revokeObjectURL(bild.src);
    };
    bild.onerror = () => fehler(new Error('Bild ließ sich nicht lesen'));
    bild.src = URL.createObjectURL(file);
  });
}

document.addEventListener('click', ev => {
  const btn = ev.target.closest('button[data-foto]');
  if (!btn) return;
  const feld = document.createElement('input');
  feld.type = 'file';
  feld.accept = 'image/*';
  feld.capture = 'environment';            // öffnet direkt die Kamera
  feld.onchange = async () => {
    const datei = feld.files && feld.files[0];
    if (!datei) return;
    btn.disabled = true; btn.textContent = '…';
    try {
      const klein = await verkleinern(datei);
      const res = await fetch(`${API}/foto/${btn.dataset.foto}?job_id=${btn.dataset.job}`, {
        method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: klein,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Fehler ${res.status}`);
      toast('Foto gespeichert');
      await load();
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Foto'; }
  };
  feld.click();
});

// PWA: „zum Home-Bildschirm" macht daraus eine App — ohne Store, ohne Installation.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Kommt die PWA aus dem Hintergrund, frische Daten holen (G&G-Muster).
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

load();
