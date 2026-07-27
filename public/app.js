// app.js — Verwaltungsoberfläche (Chefin/Inhaber): Termine verteilen, Stundenzettel sehen.
// Reiter: Termine · Team · Stundenzettel.

const $ = s => document.querySelector(s);
let me = null, tenant = null, users = [], tab = 'jobs';
// Die zuletzt geladenen Termine — der Klick-Handler braucht den Lohn eines
// Termins, um vor dem Zuteilen über die Grenze warnen zu können.
let letzteJobs = [];

const fmtDate = iso => new Date(iso + 'T12:00:00Z')
  .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const euro = c => (c / 100).toFixed(2).replace('.', ',') + ' €';
const hhmm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;

const LAND = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen',
  HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen',
  ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
};

// ⚠️ Bei einem ZUGESAGTEN Termin hieß der Knopf früher „Erneut anfragen" — und war
// obendrein die auffälligste Aktion auf einer Karte, auf der längst alles geklärt
// ist. Was er tut, hängt jetzt an der Auswahl daneben:
//   andere Person → Umteilen (die alte bekommt eine Kalender-Absage)
//   dieselbe      → nur nochmal senden, ohne den Zustand anzufassen
function sendeKnopf(j, gewaehlt) {
  const g = gewaehlt ? Number(gewaehlt) : null;
  // Nichts zugeteilt und nichts gewählt: Es gibt schlicht nichts zu senden.
  if (!g && !j.assigned_user_id) return { text: 'Anfragen', klasse: 'primary', aus: true };
  if (!g) return { text: 'Zuteilung entfernen', klasse: 'ghost', aus: false };
  if (j.assigned_user_id === g) return { text: 'Nochmal senden', klasse: 'ghost', aus: false };
  return { text: j.assigned_user_id ? 'Umteilen' : 'Anfragen', klasse: 'primary', aus: false };
}

// Beim Stundenlohn steht der Betrag erst fest, wenn Zeit erfasst ist —
// „0,00 €" wäre dort schlicht falsch verstanden.
const payLabel = pay => (pay.mode === 'hourly' && !pay.minutes) ? 'nach Zeit' : euro(pay.cents);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2400);
}

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Fehler ${res.status}`);
  return json;
}

// --- Login ---
function renderLogin(err, demo) {
  $('#logout').hidden = true;
  $('#content').innerHTML = `
    ${demo ? `<div class="card">
      <h2>Schaufenster</h2>
      <p class="small muted">Das hier ist die Demo — ein erfundener Betrieb mit zehn
      Unterkünften und vier Reinigungskräften. Sie können alles anfassen: zuteilen,
      Rundruf auslösen, Stundenzettel ansehen. Nachrichten gehen von hier nie hinaus,
      und über Nacht wird der Stand zurückgesetzt.</p>
      <button class="primary" id="demorein">Ohne Anmeldung ansehen</button>
    </div>` : ''}
    <form class="card" id="loginform">
      <h2>Anmelden</h2>
      ${err ? `<p class="small" style="color:var(--bad)">${err}</p>` : ''}
      <p><input name="email" type="email" placeholder="E-Mail" required style="width:100%"></p>
      <p><input name="password" type="password" placeholder="Passwort" required style="width:100%"></p>
      <button class="${demo ? 'ghost' : 'primary'}" type="submit">Anmelden</button>
      <p class="small muted" style="margin-top:.8rem">
        <a href="#" id="vergessen">Passwort vergessen?</a>
      </p>
    </form>
    <div class="card" id="vergessenkarte" hidden>
      <h2>Neues Passwort anfordern</h2>
      <p class="small muted">Wir schicken einen Link an Ihre Adresse. Er gilt eine
      Stunde und lässt sich einmal verwenden.</p>
      <form id="vergessenform" class="row">
        <input name="email" type="email" placeholder="E-Mail" required style="flex:1;min-width:12rem">
        <button type="submit">Senden</button>
      </form>
    </div>`;
  const rein = $('#demorein');
  if (rein) rein.addEventListener('click', async () => {
    rein.disabled = true;
    try { await api('/api/demo-login', {}); start(); }
    catch (e) { toast(e.message); rein.disabled = false; }
  });
  $('#vergessen').addEventListener('click', ev => {
    ev.preventDefault();
    const karte = $('#vergessenkarte');
    karte.hidden = false;
    // Die Adresse aus dem Anmeldefeld übernehmen — wer sich gerade vertippt hat,
    // soll sie nicht zweimal eintippen.
    const oben = $('#loginform input[name=email]').value;
    if (oben) karte.querySelector('input[name=email]').value = oben;
    karte.querySelector('input[name=email]').focus();
  });
  $('#vergessenform').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      // ⚠️ Die Antwort ist immer dieselbe, auch wenn es das Konto nicht gibt.
      // Alles andere machte aus dem Formular ein Kundenverzeichnis.
      const r = await api('/api/passwort/vergessen', { email: f.get('email') });
      $('#vergessenkarte').innerHTML = `<h2>Mail unterwegs</h2>
        <p class="small muted">${r.hinweis}</p>`;
    } catch (e) { toast(e.message); }
  });
  $('#loginform').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      await api('/api/login', { email: f.get('email'), password: f.get('password') });
      start();
    } catch (e) { renderLogin(e.message); }
  });
}

// --- Reiter ---
function tabsHtml() {
  const t = [['jobs', 'Termine'], ['month', 'Monat'], ['team', 'Team'], ['units', 'Unterkünfte'],
             ['sheet', 'Stundenzettel'], ['konto', 'Konto']];
  return `<div class="row" style="margin-bottom:.8rem">` +
    t.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'primary' : 'ghost'}">${l}</button>`).join('') +
    `</div>`;
}

async function renderJobs() {
  const data = await api('/api/jobs');
  letzteJobs = data.jobs;
  // Für das Anlege-Formular darunter. Eigener Aufruf statt eines Zwischenspeichers:
  // Wer gerade eine Unterkunft angelegt hat, soll sie hier sofort finden.
  const aktiveUnits = (await api('/api/units')).units.filter(u => u.active);
  const crew = users.filter(x => ['cleaner', 'lead'].includes(x.role) && x.active);

  // Restbudget direkt in die Auswahl schreiben: Bei mehreren Kräften ist die Frage
  // beim Zuteilen nicht „wer kann?", sondern „wer darf noch, ohne die Grenze zu reißen?".
  const opts = u => crew.map(x => {
    const rest = x.minijob ? ` — noch ${euro(x.minijob.remaining_cents)}` : '';
    const warn = x.minijob && x.minijob.level === 'over' ? ' ⚠' : '';
    return `<option value="${x.id}"${x.id === u ? ' selected' : ''}>${x.name}${rest}${warn}</option>`;
  }).join('');

  // Warnung, wenn dieser Termin die zugeteilte Kraft über die Grenze trüge.
  const budgetHint = j => {
    const who = crew.find(x => x.id === j.assigned_user_id);
    if (!who || !who.minijob) return '';
    if (who.minijob.level === 'over') {
      return `<div class="small" style="color:var(--bad)">⚠ ${who.name} liegt über der ${euro(who.minijob.limit_cents)}-Grenze</div>`;
    }
    if (j.status !== 'done' && j.pay.cents > who.minijob.remaining_cents) {
      return `<div class="small" style="color:var(--warn)">⚠ Dieser Termin bringt ${who.name} über die Grenze — nur noch ${euro(who.minijob.remaining_cents)} frei</div>`;
    }
    return '';
  };

  // Offene Termine zuerst: darauf muss die Chefin reagieren. Erledigte sind
  // Beleg, kein Arbeitsvorrat — die stehen darunter, jeweils chronologisch.
  const sorted = [...data.jobs].sort((a, b) =>
    (a.status === 'done') - (b.status === 'done') || a.due_date.localeCompare(b.due_date));

  const cards = sorted.map(j => {
    const badge = j.status === 'done' ? '<span class="pill ok">erledigt</span>'
      : j.declined_at ? '<span class="pill bad">abgesagt</span>'
      : j.confirmed ? '<span class="pill ok">zugesagt</span>'
      : j.requested_at ? '<span class="pill warn">angefragt</span>'
      : '<span class="pill">offen</span>';
    // Erledigte Termine sind abgeschlossen — dort weder Zuteilung noch Anfrage-Knopf
    // anbieten, sonst sieht die Liste nach Arbeit aus, die längst getan ist.
    const controls = j.status === 'done'
      ? `<div class="small muted">von ${j.user_name || '—'}</div>`
      : `<div class="row" style="margin-top:.6rem">
           <select data-assign="${j.id}">
             <option value="">— niemand —</option>${opts(j.assigned_user_id)}
           </select>
           ${(k => `<button data-send="${j.id}" class="${k.klasse}"${k.aus ? ' disabled' : ''}>${k.text}</button>`)(sendeKnopf(j, j.assigned_user_id))}
           ${j.confirmed ? '' : `<button data-rundruf="${j.id}" class="ghost" title="Allen anbieten — wer zuerst zusagt, bekommt den Termin">Rundruf</button>`}
         </div>
         ${budgetHint(j)}
         ${j.rundruf_offen ? `<div class="small" style="color:var(--warn)">Rundruf läuft — angefragt: ${j.rundruf_offen}</div>` : ''}`;

    return `<div class="card">
      <div class="row spread">
        <span class="date">${fmtDate(j.due_date)}${j.start_time ? ' · ' + j.start_time : ''} ${j.premium ? '<span class="pill premium">Zuschlag</span>' : ''}</span>
        ${badge}
      </div>
      <div class="small muted">${j.kind === 'aufgabe'
        ? `<strong>${j.titel}</strong>${j.unit_name ? ' · ' + j.unit_name : ''} <span class="pill">Aufgabe</span>`
        : (j.unit_name || '—')} · ${payLabel(j.pay)}${j.pay.minutes ? ' · ' + hhmm(j.pay.minutes) : ''}</div>
      ${controls}
    </div>`;
  }).join('');

  // Termin von Hand: telefonisch gebucht, Mitarbeiter übernachtet, Familienbesuch —
  // oder eine Sonderaufgabe, die mit keiner Buchung zu tun hat.
  const unitOpts = (aktiveUnits || []).map(u => `<option value="${u.id}">${u.name}</option>`).join('');
  const anlegen = `<details class="card" id="neu">
    <summary><strong>Termin von Hand anlegen</strong></summary>
    <p class="small muted">Für Buchungen, die nicht in Smoobu stehen — und für
    Sonderaufgaben wie „Kaffeekapseln kaufen".</p>
    <form id="neuform">
      <div class="row" style="margin-bottom:.5rem">
        <label class="small"><input type="radio" name="art" value="apartment" checked> Reinigung</label>
        <label class="small"><input type="radio" name="art" value="aufgabe"> Sonderaufgabe</label>
      </div>
      <p class="nurAufgabe" hidden><input name="titel" placeholder="Worum geht es? z. B. Kaffeekapseln kaufen" style="width:100%"></p>
      <div class="row">
        <select name="unit_id" style="flex:1;min-width:10rem">
          <option value="">— Unterkunft —</option>${unitOpts}
        </select>
        <input name="due_date" type="date" required style="min-width:9rem">
        <input name="start_time" type="time" style="width:7rem" title="Uhrzeit (freiwillig)">
      </div>
      <div class="row nurAufgabe" style="margin-top:.5rem" hidden>
        <input name="pay" type="text" inputmode="decimal" placeholder="Betrag € (leer = nach Zeit)" style="flex:1;min-width:11rem">
      </div>
      <p class="small muted nurAufgabe" hidden>Ohne Betrag wird nach erfasster Zeit
      bezahlt — mindestens zum gesetzlichen Mindestlohn. Die Unterkunft ist hier freiwillig.</p>
      <button class="primary" type="submit" style="margin-top:.6rem">Anlegen</button>
    </form>
  </details>`;

  $('#content').innerHTML = tabsHtml() +
    `<div class="small muted" style="margin-bottom:.5rem">Periode ${data.from} – ${data.to}</div>` +
    anlegen +
    (cards || '<div class="card muted">Keine Termine in dieser Periode.</div>');

  const nf = $('#neuform');
  const artUmschalten = () => {
    const aufgabe = nf.querySelector('input[name=art]:checked').value === 'aufgabe';
    nf.querySelectorAll('.nurAufgabe').forEach(el => { el.hidden = !aufgabe; });
    // Bei einer Reinigung ist die Unterkunft Pflicht — ohne sie gibt es nichts
    // zu reinigen und keine Checkliste, an der sich die Kraft entlanghangelt.
    nf.querySelector('select[name=unit_id]').required = !aufgabe;
  };
  nf.querySelectorAll('input[name=art]').forEach(r => r.addEventListener('change', artUmschalten));
  artUmschalten();

  nf.addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(nf).entries());
    const body = {
      kind: f.art, due_date: f.due_date,
      unit_id: f.unit_id || null, start_time: f.start_time || '',
    };
    if (f.art === 'aufgabe') {
      body.titel = f.titel;
      // Leeres Feld heißt „nach Zeit" — nicht 0 €. Deshalb nur senden, wenn
      // wirklich etwas dasteht.
      const roh = String(f.pay || '').trim().replace(',', '.');
      if (roh !== '') body.pay_cents = Math.round(Number(roh) * 100);
    }
    try {
      await api('/api/jobs', body);
      toast('Angelegt.');
      await renderJobs();
    } catch (e) { toast(e.message); }
  });
}

// --- Monatsansicht -------------------------------------------------------
// Ein Kalender sagt auf einen Blick, was eine Liste erst nach Scrollen verrät:
// wo Lücken sind und wo noch keiner zugesagt hat.
let monthCursor = null;                       // {y, m} — null = laufender Monat

const DAY_STATUS = {
  open:      { farbe: 'var(--bad)',   text: 'offen' },
  requested: { farbe: 'var(--warn)',  text: 'angefragt' },
  confirmed: { farbe: 'var(--ok)',    text: 'zugesagt' },
  done:      { farbe: 'var(--muted)', text: 'erledigt' },
};

function jobStatusKey(j) {
  if (j.status === 'done') return 'done';
  if (j.confirmed) return 'confirmed';
  if (j.requested_at && !j.declined_at) return 'requested';
  return 'open';
}

async function renderMonth() {
  const heute = new Date();
  const y = monthCursor ? monthCursor.y : heute.getFullYear();
  const m = monthCursor ? monthCursor.m : heute.getMonth() + 1;
  const pad = n => String(n).padStart(2, '0');
  const tageImMonat = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${y}-${pad(m)}-01`;
  const to = `${y}-${pad(m)}-${tageImMonat}`;

  const data = await api(`/api/jobs?from=${from}&to=${to}`);
  const proTag = {};
  for (const j of data.jobs) (proTag[j.due_date] ||= []).push(j);

  // Montag als erster Wochentag — deutscher Kalender.
  const ersterWochentag = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const heuteIso = new Date().toISOString().slice(0, 10);

  const zellen = [];
  for (let i = 0; i < ersterWochentag; i++) zellen.push('<div class="cal-leer"></div>');
  for (let d = 1; d <= tageImMonat; d++) {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    const jobs = proTag[iso] || [];
    const zaehler = {};
    for (const j of jobs) { const k = jobStatusKey(j); zaehler[k] = (zaehler[k] || 0) + 1; }
    const punkte = Object.entries(zaehler)
      .map(([k, n]) => `<span class="cal-punkt" style="background:${DAY_STATUS[k].farbe}" title="${n}× ${DAY_STATUS[k].text}"></span>`)
      .join('');
    const titel = jobs.length
      ? jobs.map(j => `${j.unit_name || '?'} — ${DAY_STATUS[jobStatusKey(j)].text}${j.user_name ? ' (' + j.user_name + ')' : ''}`).join('\n')
      : '';
    zellen.push(`<div class="cal-tag${iso === heuteIso ? ' cal-heute' : ''}"${titel ? ` title="${titel.replace(/"/g, '&quot;')}"` : ''}>
      <span class="cal-nr">${d}</span>
      <span class="cal-punkte">${punkte}</span>
    </div>`);
  }

  const monatsname = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const legende = Object.values(DAY_STATUS)
    .map(s => `<span class="cal-leg"><span class="cal-punkt" style="background:${s.farbe}"></span>${s.text}</span>`).join('');

  $('#content').innerHTML = tabsHtml() + `<div class="card">
    <div class="row spread" style="margin-bottom:.6rem">
      <button class="ghost" data-month="-1">←</button>
      <strong>${monatsname}</strong>
      <button class="ghost" data-month="1">→</button>
    </div>
    <div class="cal-kopf">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => `<div>${d}</div>`).join('')}</div>
    <div class="cal">${zellen.join('')}</div>
    <div class="row small muted" style="margin-top:.7rem;gap:.9rem">${legende}</div>
  </div>`;
}

async function renderTeam() {
  const ARTEN = { minijob: 'Minijob', midijob: 'Midijob', angestellt: 'angestellt', firma: 'Firma' };
  const kraefte = users.filter(u => ['cleaner', 'lead'].includes(u.role));

  const budget = u => {
    if (!u.minijob) return '<span class="muted small">Verdienstgrenze wird nicht verfolgt</span>';
    const cls = u.minijob.level === 'over' ? 'bad' : u.minijob.level === 'warn' ? 'warn' : 'ok';
    return `<span class="pill ${cls}">${u.minijob.level === 'over'
      ? 'über Grenze' : `noch ${euro(u.minijob.remaining_cents)}`}</span>`;
  };

  const karte = u => `<div class="card">
    <div class="row spread">
      <h2>${u.name}${u.silent ? ' <span class="pill">still</span>' : ''}${u.active ? '' : ' <span class="pill bad">stillgelegt</span>'}</h2>
      ${budget(u)}
    </div>
    <form class="row" data-person="${u.id}" style="margin-top:.5rem;flex-wrap:wrap">
      <label class="small muted">Name <input name="name" value="${u.name}" style="min-width:9rem"></label>
      <label class="small muted">E-Mail <input name="email" type="email" value="${u.email || ''}" style="min-width:12rem"></label>
      <label class="small muted">Beschäftigung
        <select name="employment">${Object.entries(ARTEN).map(([k, l]) =>
          `<option value="${k}"${(u.employment || 'minijob') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="small muted row" style="gap:.3rem"><input type="checkbox" name="silent"${u.silent ? ' checked' : ''}> still</label>
      <button class="ghost" type="submit">Speichern</button>
    </form>
    <div class="row small muted" style="margin-top:.4rem">
      ${u.magic_url
        ? `<button class="ghost small" data-copy="${u.magic_url}">Link kopieren</button>
           <span>Diesen Link bekommt sie — kein Konto, kein Passwort.</span>`
        : '<span>Still: kein Zugang, keine Nachrichten.</span>'}
    </div>
  </div>`;

  $('#content').innerHTML = tabsHtml() +
    (kraefte.length ? kraefte.map(karte).join('') : '<div class="card muted">Noch niemand angelegt.</div>') +
    `<form class="card" id="neueperson">
      <h2>Person hinzufügen</h2>
      <div class="row" style="flex-wrap:wrap;margin-top:.4rem">
        <input name="name" placeholder="Name" required style="min-width:10rem">
        <input name="email" type="email" placeholder="E-Mail" style="min-width:12rem">
        <select name="employment">
          <option value="minijob">Minijob</option>
          <option value="midijob">Midijob</option>
          <option value="angestellt">angestellt</option>
          <option value="firma">Firma</option>
        </select>
        <button class="primary" type="submit">Anlegen</button>
      </div>
      <p class="small muted" style="margin:.5rem 0 0">Die Person bekommt sofort ihren
      persönlichen Link. Bei <strong>Minijob</strong> verfolgt Putzflow die Verdienstgrenze,
      sonst nicht.</p>
    </form>`;
}

async function renderUnits() {
  const [u, c] = await Promise.all([api('/api/units'), api('/api/checklist')]);
  const proUnit = new Map([[null, []]]);
  for (const x of u.units) proUnit.set(x.id, []);
  for (const i of c.items) (proUnit.get(i.unit_id) || proUnit.get(null)).push(i);

  const punkte = (unitId, items, hinweis) => `
    <div class="small muted" style="margin:.6rem 0 .2rem">Checkliste — ${hinweis}</div>
    ${items.length ? items.map(i => `
      <form class="row check-edit" data-edititem="${i.id}">
        <input name="text" value="${i.text.replace(/"/g, '&quot;')}" style="flex:1;min-width:11rem">
        <label class="small muted row" style="gap:.3rem"><input type="checkbox" name="foto"${i.wants_photo ? ' checked' : ''}> Foto</label>
        <button class="ghost small" type="submit">Speichern</button>
        <button class="ghost small" type="button" data-delitem="${i.id}">entfernen</button>
      </form>`).join('') : '<p class="small muted">Noch nichts eingetragen.</p>'}
    <form class="row" data-additem="${unitId === null ? '' : unitId}" style="margin-top:.5rem">
      <input name="text" placeholder="Neuer Punkt" required style="flex:1;min-width:11rem">
      <label class="small muted row" style="gap:.3rem"><input type="checkbox" name="foto"> Foto</label>
      <button class="primary" type="submit">Hinzufügen</button>
    </form>`;

  const sm = await api('/api/smoobu').catch(() => ({ verbunden: false }));

  $('#content').innerHTML = tabsHtml() + `
    <div class="card">
      <div class="row spread"><h2>Smoobu</h2>
        ${sm.verbunden ? '<span class="pill ok">verbunden</span>' : '<span class="pill">nicht verbunden</span>'}</div>
      ${sm.verbunden ? `
        <p class="small muted">Schlüssel ${sm.key_maskiert} · letzter Abgleich:
          ${sm.zuletzt ? new Date(sm.zuletzt).toLocaleString('de-DE') : 'noch keiner'}</p>
        <div class="row">
          <button class="primary" id="sync">Jetzt abgleichen</button>
          <button class="ghost" id="smoobu-weg">Verbindung trennen</button>
        </div>
        <p class="small muted" style="margin:.5rem 0 0">Putzflow liest nur — es schreibt
        nichts in Ihr Smoobu-Konto zurück. Abgeglichen wird stündlich automatisch.</p>`
      : `<p class="small muted">Ihre Abreisen werden dann automatisch zu Reinigungsaufträgen.
         Putzflow braucht dafür <strong>zwei</strong> Angaben aus Ihrem Smoobu-Konto.</p>
        <ol class="small muted" style="margin:.4rem 0 .2rem;padding-left:1.2rem">
          <li>In Smoobu: <strong>Einstellungen → Erweitert → API&nbsp;Keys</strong></li>
          <li>Schlüssel anlegen — Smoobu zeigt <strong>API-Schlüssel</strong> und
              <strong>API-Secret</strong>.</li>
          <li>Beides hier eintragen.</li>
        </ol>
        <p class="small" style="color:var(--warn);margin:.2rem 0 .4rem">⚠️ Das Secret zeigt
        Smoobu <strong>nur ein einziges Mal</strong> — es lässt sich später nicht mehr
        nachsehen. Kopieren Sie es sofort hierher. Haben Sie schon einen Schlüssel, aber
        kein Secret mehr? Dann in Smoobu „Secret neu erzeugen": Der Schlüssel bleibt
        derselbe, nur das alte Secret gilt sofort nicht mehr.</p>
        ${sm.demo ? `
        <form class="row" style="flex-wrap:wrap;margin-top:.5rem" onsubmit="return false">
          <input placeholder="API-Schlüssel" disabled style="min-width:14rem">
          <input placeholder="API-Secret" disabled style="min-width:14rem">
          <button class="primary" disabled>Verbinden</button>
        </form>
        <p class="small" style="color:var(--warn);margin:.4rem 0 0">In der Demo gesperrt.
        Die Zugangsdaten dieser Demo sind öffentlich — ein hier hinterlegter Smoobu-Schlüssel
        wäre für jeden anderen Besucher nutzbar. Im eigenen Konto ist das Feld frei.</p>`
        : `<form class="row" id="smoobu-form" style="flex-wrap:wrap;margin-top:.5rem">
          <input name="key" placeholder="API-Schlüssel" required style="min-width:14rem">
          <input name="secret" placeholder="API-Secret" required style="min-width:14rem">
          <button class="primary" type="submit">Verbinden</button>
        </form>`}`}
    </div>

    <div class="card">
      <h2>Planung</h2>
      <p class="small muted">Wann darf frühestens gereinigt werden, wie lang ist ein Termin,
      und wie viel Zeit braucht die Kraft zwischen zwei Anschriften?</p>
      <form class="row" id="planung" style="margin-top:.5rem">
        <label class="small muted">Check-out <input name="checkout_time" value="${u.tenant.checkout_time || '11:00'}" style="width:6rem"></label>
        <label class="small muted">Termin (Min) <input name="slot_minutes" type="number" min="15" max="480" value="${u.tenant.slot_minutes || 60}" style="width:5.5rem"></label>
        <label class="small muted">Fahrzeit (Min) <input name="travel_minutes" type="number" min="0" max="480" value="${u.tenant.travel_minutes ?? 30}" style="width:5.5rem"></label>
        <label class="small muted">Abrechnung ab dem <input name="period_start_day" type="number" min="1" max="28" value="${u.tenant.period_start_day || 16}" style="width:4.5rem"></label>
        <label class="small muted">Bundesland
          <select name="region">
            <option value=""${u.tenant.region ? '' : ' selected'}>— keins —</option>
            ${(u.tenant.regionen || []).map(r => `<option value="${r}"${u.tenant.region === r ? ' selected' : ''}>${LAND[r] || r}</option>`).join('')}
          </select></label>
        <button class="primary" type="submit">Speichern</button>
      </form>
      ${u.tenant.feiertage_relevant && !u.tenant.region ? `<p class="small"
        style="color:var(--warn);margin:.5rem 0 0">⚠️ Sie zahlen Feiertagszuschlag, haben
        aber kein Bundesland hinterlegt — es gelten derzeit nur die neun bundesweiten
        Feiertage. Fronleichnam, Allerheiligen und Reformationstag zählen je nach Land
        dazu.</p>` : ''}
      <p class="small muted" style="margin:.5rem 0 0">Das <strong>Bundesland</strong>
      brauchen Sie nur, wenn Sie Feiertagszuschlag zahlen — die Feiertage hängen davon ab.
      Sonst kann es leer bleiben.</p>
      <p class="small muted" style="margin:.5rem 0 0">Die Abrechnungsperiode läuft vom
      gewählten Tag bis zum Vortag des Folgemonats — voreingestellt der 16., damit sie
      fertig ist, bevor die Lohnbuchhaltung um den 20. meldet. Der 1. ergibt den
      Kalendermonat.</p>
    </div>

    <div class="card">
      <h2>Gilt für alle Unterkünfte</h2>
      ${punkte(null, proUnit.get(null), 'überall abzuhaken')}
    </div>

    ${u.units.map(x => `<div class="card">
      <div class="row spread"><h2>${x.name}</h2></div>
      <form class="row" data-unit="${x.id}" style="margin:.3rem 0 .2rem">
        <label class="small muted">Ort <input name="location" value="${x.location || ''}" placeholder="z. B. Lange Str. 54" style="min-width:11rem"></label>
        <label class="small muted">Check-out <input name="checkout_time" value="${x.checkout_time || ''}" placeholder="${u.tenant.checkout_time || '11:00'}" style="width:6rem"></label>
        <button class="ghost" type="submit">Speichern</button>
      </form>
      <p class="small muted" style="margin:0">Gleicher Ort = kein Fahrtpuffer zwischen zwei Reinigungen.</p>
      ${punkte(x.id, proUnit.get(x.id) || [], 'nur hier')}
    </div>`).join('')}

    <form class="card row" id="neueunit">
      <input name="name" placeholder="Neue Unterkunft" required style="flex:1;min-width:11rem">
      <input name="location" placeholder="Ort (optional)" style="min-width:9rem">
      <button class="primary" type="submit">Anlegen</button>
    </form>`;
}

// Auslagen im Stundenzettel. Getrennt von den Reinigungen, mit eigener Summe:
// Auslagenersatz ist kein Arbeitsentgelt und darf weder in die Lohnsumme noch in
// die Verdienstgrenze — steht er in derselben Tabelle, wandert er dort früher oder
// später hinein.
function auslagenBlock(s) {
  const a = s.auslagen;
  if (!a || !a.posten.length) return '';
  const zeile = p => `<tr>
      <td>${fmtDate(p.date)}</td>
      <td class="small muted">${p.beschreibung}
        ${p.beleg ? `<a class="small" href="/api/expenses/${p.id}/beleg" target="_blank">Beleg</a>`
                  : '<span class="small muted">(ohne Beleg)</span>'}</td>
      <td class="num">${p.minutes ? hhmm(p.minutes) : '—'}</td>
      <td class="num">${euro(p.auslage_cents)}</td>
      <td class="num">${p.zustand === 'offen'
        ? `<button class="ghost small" data-ausl-ok="${p.id}">freigeben</button>
           <button class="ghost small" data-ausl-nein="${p.id}">ablehnen</button>`
        : p.zustand === 'abgelehnt'
          ? '<span class="pill">abgelehnt</span>'
          : '<span class="pill ok">frei</span>'}</td></tr>`;

  return `<div style="margin-top:.8rem">
    <div class="row spread"><strong class="small">Auslagen</strong>
      <span class="small muted">Erstattung, kein Arbeitsentgelt</span></div>
    <table><thead><tr><th>Tag</th><th>Wofür</th><th class="num">Zeit</th>
      <th class="num">Auslage</th><th class="num"></th></tr></thead>
      <tbody>${a.posten.map(zeile).join('')}</tbody></table>
    <div class="small muted" style="margin-top:.3rem">
      Freigegeben: <strong>${euro(a.auslagen_cents)}</strong> Erstattung
      ${a.entgelt_cents ? ` · ${euro(a.entgelt_cents)} Lohn für ${hhmm(a.minuten)} Wegezeit
        (${euro(a.satz_cents)}/Std.)` : ''}
      · zu überweisen <strong>${euro(s.zu_zahlen_cents)}</strong>
    </div>
  </div>`;
}

async function renderSheet() {
  const data = await api('/api/timesheet');
  const sigPille = st => {
    if (!st) return '';
    if (st.zustand === 'gueltig') return '<span class="pill ok">abgezeichnet</span>';
    if (st.zustand === 'veraltet') return '<span class="pill warn">Unterschrift veraltet</span>';
    return '<span class="pill">nicht abgezeichnet</span>';
  };

  // Die Periode läuft noch? Dann ist alles über den Mindestlohn eine Vorschau,
  // keine Feststellung — die Aufstockung wird erst mit dem Lohn fällig.
  const heuteIso2 = new Date().toISOString().slice(0, 10);
  const periodeLaeuft = data.period && data.period.end >= heuteIso2;

  // ⚠️ Der Balken zählt etwas ANDERES als die Zahl in der Kopfzeile: dort steht
  // das geleistete Entgelt, im Balken stecken zusätzlich das Geplante und die
  // Aufstockung. Ohne diese Zeile liest sich „230,79 €" über
  // „über der 603,00 €-Grenze" wie ein Rechenfehler.
  const grenzeRechnung = (s, mj) => {
    const teile = [`${euro(s.total_cents)} geleistet`];
    if (s.geplant_cents) teile.push(`${euro(s.geplant_cents)} geplant`);
    if (s.mindestlohn && s.mindestlohn.fehlbetrag_cents) {
      teile.push(`${euro(s.mindestlohn.fehlbetrag_cents)} Aufstockung`);
    }
    return `gezählt: ${teile.join(' + ')} = ${euro(mj.cents)}. `
         + `Auslagenerstattung zählt nicht mit — sie ist kein Arbeitsentgelt.`;
  };

  const cards = data.sheets.map(s => {
    const mj = s.minijob;                       // null, wenn keine Grenze gilt
    const pct = mj ? Math.min(100, Math.round(mj.cents / mj.limit_cents * 100)) : 0;
    const ml = s.mindestlohn;
    // § 17 MiLoG will Beginn, Ende UND Dauer — deshalb steht hier der Zeitraum, nicht
    // nur die Summe. Fehlt er bei einem erledigten Einsatz, ist das ein Mangel und
    // kein Gedankenstrich.
    const zeitZelle = i => {
      if (i.geplant) return '<span class="small muted">geplant</span>';
      if (i.zeiten && i.zeiten.length) {
        return `<span class="small">${i.zeiten.map(z => `${z.von}–${z.bis}`).join(', ')}</span>
                <span class="small muted">${hhmm(i.minutes)}</span>`;
      }
      return `<button class="ghost small" data-zeit="${i.job_id}" data-tag="${i.date}"
                style="color:var(--bad)">Zeit fehlt — nachtragen</button>`;
    };
    const rows = s.items.map(i => `<tr${i.geplant ? ' class="geplant"' : ''}>
        <td>${fmtDate(i.date)}</td><td class="small muted">${i.unit || '—'}</td>
        <td class="num">${zeitZelle(i)}</td>
        <td class="num">${payLabel(i)}</td></tr>`).join('');
    const az = s.aufzeichnung;
    return `<div class="card">
      <div class="row spread"><h2>${s.name} ${sigPille(s.signatur)}</h2>
        <strong title="geleistet">${euro(s.total_cents)}</strong></div>
      ${mj ? `<div class="bar ${mj.level === 'over' ? 'over' : mj.level === 'warn' ? 'warn' : ''}"><i style="width:${pct}%"></i></div>
      <div class="small muted">${mj.level === 'over' ? `⚠️ über der ${euro(mj.limit_cents)}-Grenze`
        : `noch ${euro(mj.remaining_cents)} frei`}
        <br>${grenzeRechnung(s, mj)}</div>` : ''}
      ${rows ? `<table style="margin-top:.6rem"><thead><tr><th>Tag</th><th>Unterkunft</th><th class="num">Beginn – Ende</th><th class="num">Betrag</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      ${s.geplant_cents ? `<div class="small muted">Davon ${euro(s.geplant_cents)} noch geplant —
        auf dem Stundenzettel für die Lohnbuchhaltung steht nur Geleistetes.</div>` : ''}
      ${az && az.fehlend ? `<div class="small" style="color:var(--bad);margin-top:.4rem">
        ⚠️ ${az.fehlend} erledigte${az.fehlend === 1 ? 'r Einsatz hat' : ' Einsätze haben'} keine
        Arbeitszeitaufzeichnung${az.frist_abgelaufen ? `, davon ${az.frist_abgelaufen} älter als
        ${az.frist_tage} Tage` : ''}. § 17 Abs. 1 MiLoG verlangt Beginn, Ende und Dauer je
        Arbeitstag, aufzuzeichnen binnen ${az.frist_tage} Tagen und zwei Jahre aufzubewahren.</div>` : ''}
      ${ml && ml.minuten ? `<div class="small" style="margin-top:.5rem;${ml.unterschritten ? 'color:var(--bad)' : 'color:var(--muted)'}">
        Effektiv ${euro(ml.effektiv_cents)}/Std. bei Mindestlohn ${euro(ml.grenze_cents)}/Std.
        ${ml.unterschritten
          ? (periodeLaeuft
            ? `— <strong>Stand heute wären ${euro(ml.fehlbetrag_cents)} Aufstockung fällig</strong>,
               auszuzahlen ${euro(s.zu_zahlen_cents)}. Die Periode läuft noch bis
               ${fmtDate(data.period.end)}; gerechnet ist nur, was bisher an Zeit erfasst wurde.
               Der Mindestlohn gilt je Arbeitsstunde und lässt sich durch eine Pauschale nicht
               unterschreiten — bleibt es beim jetzigen Schnitt, wächst der Betrag mit jedem
               weiteren Einsatz.`
            : `— <strong>Aufstockung nötig: ${euro(ml.fehlbetrag_cents)}</strong>, auszuzahlen ${euro(s.zu_zahlen_cents)}.
               Der Mindestlohn gilt je Arbeitsstunde und lässt sich durch eine Pauschale nicht unterschreiten.`)
          : (periodeLaeuft ? '— Stand heute eingehalten.' : '— eingehalten.')}
        ${ml.ohne_zeit ? `<br>${ml.ohne_zeit} Position${ml.ohne_zeit === 1 ? '' : 'en'} ohne erfasste Zeit — dort nicht prüfbar.` : ''}
      </div>` : ''}
      ${auslagenBlock(s)}
      <form class="row auslageform" data-user="${s.user_id}" style="margin-top:.6rem">
        <input name="description" placeholder="Auslage nachtragen — wofür?" style="flex:1;min-width:11rem">
        <input name="amount" type="text" inputmode="decimal" placeholder="€" style="width:5.5rem">
        <input name="minutes" type="number" min="0" step="5" placeholder="Min." style="width:5rem">
        <button class="ghost" type="submit">Eintragen</button>
      </form>
    </div>`;
  }).join('');
  const offen = data.sheets.filter(s =>
    (s.geleistet.length || (s.auslagen && s.auslagen.genehmigt.length)) &&
    (!s.signatur || s.signatur.zustand !== 'gueltig')).length;
  const fehlendeZeiten = data.sheets.reduce((n, s) => n + (s.aufzeichnung ? s.aufzeichnung.fehlend : 0), 0);
  $('#content').innerHTML = tabsHtml() +
    `<div class="small muted" style="margin-bottom:.5rem">Periode ${data.period.start} – ${data.period.end}</div>` +
    (cards || '<div class="card muted">Noch keine Einsätze.</div>') +
    `<form class="card" id="payroll">
      <h2>An die Lohnbuchhaltung senden</h2>
      <p class="small muted">Jede Person bekommt ein eigenes PDF. Abgezeichnete Zettel tragen
      den Vermerk zur elektronischen Bestätigung, die übrigen eine Unterschriftszeile.
      ${offen ? `<strong>${offen} Zettel ${offen === 1 ? 'ist' : 'sind'} noch nicht abgezeichnet.</strong>` : ''}</p>
      ${fehlendeZeiten ? `<p class="small" style="color:var(--bad);margin:.3rem 0 0">
        ⚠️ ${fehlendeZeiten} erledigte Einsätze ohne Arbeitszeitaufzeichnung. Bitte erst nachtragen —
        im PDF sind sie rot vermerkt.</p>` : ''}
      <div class="row" style="margin-top:.5rem">
        <input name="email" type="email" placeholder="lohnbuchhaltung@kanzlei.de"
               value="${data.payroll_email || ''}"${data.demo ? ' disabled' : ' required'} style="flex:1;min-width:14rem">
        <button class="primary" type="submit"${data.demo ? ' disabled' : ''}>Senden</button>
      </div>
      ${data.demo ? `<p class="small" style="color:var(--warn);margin:.4rem 0 0">In der Demo
      gesperrt — sonst ließen sich von hier Mails an beliebige Adressen verschicken.</p>` : ''}
    </form>`;
}

// --- Das eigene Konto ------------------------------------------------------
// ⚠️ Bis zum 27.07.2026 gab es das nicht: Wer sein Passwort wechseln wollte,
// brauchte einen SQL-Befehl auf dem Server. Für eine Vermieterin heißt das:
// gar nicht. Ein Passwort, das man nicht wechseln kann, ist nach dem ersten
// Mitlesen für immer verbrannt.
async function renderKonto() {
  $('#content').innerHTML = tabsHtml() + `
    <div class="card">
      <h2>Mein Konto</h2>
      ${tenant.demo ? `<p class="small muted">In der Demo lässt sich das Konto nicht ändern —
        hier ist jeder Besucher angemeldet.</p>` : `
      <form id="kontoform">
        <p><label class="small muted">Name</label>
           <input name="name" value="${(me.name || '').replace(/"/g, '&quot;')}" required style="width:100%"></p>
        <p><label class="small muted">E-Mail — damit melden Sie sich an</label>
           <input name="email" type="email" value="${(me.email || '').replace(/"/g, '&quot;')}" required style="width:100%"></p>
        <p><label class="small muted">Neues Passwort <span class="muted">(leer lassen, wenn es bleiben soll)</span></label>
           <input name="password_neu" type="password" autocomplete="new-password" minlength="8" style="width:100%"></p>
        <p><label class="small muted">Bisheriges Passwort</label>
           <input name="password_alt" type="password" autocomplete="current-password" style="width:100%">
           <span class="small muted">Nur nötig, wenn Sie E-Mail oder Passwort ändern.</span></p>
        <button type="submit">Speichern</button>
      </form>
      <p class="small muted" style="margin-top:1rem">Nach einem Passwortwechsel werden alle
      anderen Anmeldungen beendet — auf dem Telefon, im Büro, überall. Diese hier bleibt.</p>`}
    </div>
    <div class="card">
      <h2>Betrieb</h2>
      <p class="small muted">${tenant.name} · <code>${tenant.slug}</code></p>
      <p class="small muted">Reinigungskräfte legen Sie im Reiter „Team" an — die melden sich
      nie an, sondern bekommen einen persönlichen Link.</p>
    </div>`;

  const f = $('#kontoform');
  if (!f) return;
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    const body = { password_alt: d.password_alt || '' };
    // Nur senden, was sich wirklich ändert — sonst verlangt der Server das alte
    // Passwort auch dann, wenn jemand bloß seinen Namen berichtigt.
    if (d.name !== me.name) body.name = d.name;
    if (d.email !== me.email) body.email = d.email;
    if (d.password_neu) body.password_neu = d.password_neu;
    if (Object.keys(body).length === 1) return toast('Nichts geändert.');
    try {
      const r = await api('/api/me', body, 'PATCH');
      me.name = r.me.name; me.email = r.me.email;
      $('#sub').textContent = `Putzflow · ${me.name}`;
      toast(r.passwort_geaendert ? 'Gespeichert — neues Passwort gilt ab sofort.' : 'Gespeichert.');
      await renderKonto();
    } catch (e) { toast(e.message); }
  });
}

async function renderTab() {
  try {
    if (tab === 'jobs') await renderJobs();
    else if (tab === 'month') await renderMonth();
    else if (tab === 'team') await renderTeam();
    else if (tab === 'units') await renderUnits();
    else if (tab === 'konto') await renderKonto();
    else await renderSheet();
  } catch (e) { toast(e.message); }
}

// --- Ereignisse ---
document.addEventListener('click', async ev => {
  const tabBtn = ev.target.closest('button[data-tab]');
  if (tabBtn) { tab = tabBtn.dataset.tab; return renderTab(); }

  const monat = ev.target.closest('button[data-month]');
  if (monat) {
    const heute = new Date();
    const y = monthCursor ? monthCursor.y : heute.getFullYear();
    const m = (monthCursor ? monthCursor.m : heute.getMonth() + 1) + Number(monat.dataset.month);
    monthCursor = m === 0 ? { y: y - 1, m: 12 } : m === 13 ? { y: y + 1, m: 1 } : { y, m };
    return renderMonth();
  }

  const send = ev.target.closest('button[data-send]');
  if (send) {
    const id = send.dataset.send;
    const sel = document.querySelector(`select[data-assign="${id}"]`);

    // ⚠️ Rückfrage, bevor jemand über die Verdienstgrenze gerät. Vorher stand die
    // Warnung nur als Zeile unter der Karte — man konnte sie zuteilen, ohne sie
    // gelesen zu haben. Gesperrt wird NICHT: Es gibt echte Gründe (Mandanten-
    // Override, Wechsel in den Midijob), und Kappen käme nie in Frage. Aber es
    // soll eine Entscheidung sein, kein Versehen.
    if (sel.value) {
      const job = letzteJobs.find(x => String(x.id) === String(id));
      const wer = users.find(x => String(x.id) === String(sel.value));
      if (job && wer && wer.minijob) {
        const danach = wer.minijob.cents + job.pay.cents;
        if (danach > wer.minijob.limit_cents) {
          const ueber = danach - wer.minijob.limit_cents;
          const frage = wer.minijob.level === 'over'
            ? `${wer.name} liegt bereits über der ${euro(wer.minijob.limit_cents)}-Grenze `
              + `(${euro(wer.minijob.cents)}). Dieser Termin kommt oben drauf.\n\n`
            : `Dieser Termin bringt ${wer.name} über die ${euro(wer.minijob.limit_cents)}-Grenze: `
              + `${euro(wer.minijob.cents)} + ${euro(job.pay.cents)} = ${euro(danach)}, `
              + `also ${euro(ueber)} darüber.\n\n`;
          if (!confirm(frage
            + 'Gezählt sind Geleistetes, Geplantes und eine nötige Aufstockung auf den '
            + 'Mindestlohn — nicht die Auslagenerstattung.\n\nTrotzdem zuteilen?')) return;
        }
      }
    }

    send.disabled = true;
    try {
      const r = await api(`/api/jobs/${id}/assign`, { user_id: sel.value || null });
      toast(sel.value ? (r.notified?.ok ? `Angefragt (${r.notified.channel})` : 'Zugeteilt') : 'Zuteilung entfernt');
      // Die Zuteilung verschiebt Budgets — Team neu laden, sonst zeigen die
      // Auswahlfelder veraltete Restbeträge.
      users = (await api('/api/users')).users;
      await renderTab();
    } catch (e) { toast(e.message); } finally { send.disabled = false; }
    return;
  }

  const ruf = ev.target.closest('button[data-rundruf]');
  if (ruf) {
    const id = ruf.dataset.rundruf;
    if (!confirm('Diesen Termin allen infrage kommenden Kräften anbieten? Wer zuerst zusagt, bekommt ihn.')) return;
    ruf.disabled = true;
    try {
      const r = await api(`/api/jobs/${id}/rundruf`, {});
      // ⚠️ Auch melden, wer NICHT gefragt wurde. Ein Rundruf an drei von sieben
      // sieht sonst aus wie einer an alle, und wenn keine zusagt, sucht man den
      // Fehler an der falschen Stelle.
      const teile = [r.gefragt.length ? `Angefragt: ${r.gefragt.join(', ')}` : 'Niemand konnte angefragt werden'];
      if (r.uebersprungen.length) {
        teile.push(`Übersprungen: ${r.uebersprungen.map(s => `${s.name} (${s.grund})`).join('; ')}`);
      }
      toast(teile.join(' — '));
      users = (await api('/api/users')).users;
      await renderTab();
    } catch (e) { toast(e.message); } finally { ruf.disabled = false; }
    return;
  }

  const art = ev.target.closest('select[data-employment]');
  if (art) return;                    // Auswahl selbst löst nichts aus, erst change

  const sync = ev.target.closest('#sync');
  if (sync) {
    sync.disabled = true; sync.textContent = 'Gleiche ab …';
    try {
      const r = await api('/api/smoobu/sync', {});
      toast(`${r.angelegt} neu, ${r.verschoben} verschoben, ${r.entfallen} entfallen`);
      await renderTab();
    } catch (e) { toast(e.message); sync.disabled = false; sync.textContent = 'Jetzt abgleichen'; }
    return;
  }

  const smWeg = ev.target.closest('#smoobu-weg');
  if (smWeg) {
    if (!confirm('Verbindung zu Smoobu trennen? Bestehende Aufträge bleiben.')) return;
    try { await api('/api/smoobu', {}, 'DELETE'); await renderTab(); } catch (e) { toast(e.message); }
    return;
  }

  const del = ev.target.closest('button[data-delitem]');
  if (del) {
    if (!confirm('Punkt entfernen? Bereits abgehakte Aufträge behalten ihn.')) return;
    try { await api(`/api/checklist/${del.dataset.delitem}`, {}, 'DELETE'); await renderTab(); }
    catch (e) { toast(e.message); }
    return;
  }

  const copy = ev.target.closest('button[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy)
      .then(() => toast('Link kopiert')).catch(() => toast(copy.dataset.copy));
  }
});

// Beschäftigungsart umstellen — steuert, ob die Verdienstgrenze verfolgt wird.
document.addEventListener('change', ev => {
  // Die Auswahl bestimmt, was der Knopf daneben tut — also muss seine Beschriftung
  // sofort mitziehen und nicht erst nach dem Klick.
  const zut = ev.target.closest('select[data-assign]');
  if (zut) {
    const j = letzteJobs.find(x => String(x.id) === String(zut.dataset.assign));
    const btn = document.querySelector(`button[data-send="${zut.dataset.assign}"]`);
    if (j && btn) {
      const k = sendeKnopf(j, zut.value);
      btn.textContent = k.text; btn.className = k.klasse; btn.disabled = k.aus;
    }
  }
});

document.addEventListener('change', async ev => {
  const sel = ev.target.closest('select[data-employment]');
  if (!sel) return;
  try {
    await api(`/api/users/${sel.dataset.employment}`, { employment: sel.value }, 'PATCH');
    users = (await api('/api/users')).users;
    await renderTab();
    toast('Beschäftigungsart geändert');
  } catch (e) { toast(e.message); }
});

document.addEventListener('submit', async ev => {
  const planung = ev.target.closest('#planung');
  if (planung) {
    ev.preventDefault();
    const fd = new FormData(planung);
    try {
      await api('/api/tenant', {
        checkout_time: fd.get('checkout_time'),
        slot_minutes: fd.get('slot_minutes'),
        travel_minutes: fd.get('travel_minutes'),
        period_start_day: fd.get('period_start_day'),
        region: fd.get('region'),
      }, 'PATCH');
      toast('Planung gespeichert'); await renderTab();
    } catch (e) { toast(e.message); }
    return;
  }

  const unitForm = ev.target.closest('form[data-unit]');
  if (unitForm) {
    ev.preventDefault();
    const fd = new FormData(unitForm);
    try {
      await api(`/api/units/${unitForm.dataset.unit}`,
                { location: fd.get('location'), checkout_time: fd.get('checkout_time') }, 'PATCH');
      toast('Gespeichert'); await renderTab();
    } catch (e) { toast(e.message); }
    return;
  }

  const lohn = ev.target.closest('#payroll');
  if (lohn) {
    ev.preventDefault();
    const fd = new FormData(lohn);
    const btn = lohn.querySelector('button');
    if (!confirm(`Stundenzettel an ${fd.get('email')} senden?`)) return;
    btn.disabled = true; btn.textContent = 'Sende …';
    try {
      const r = await api('/api/payroll/send', { email: fd.get('email') });
      toast(`${r.gesendet} Stundenzettel an ${r.an} gesendet`);
      await renderTab();
    } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = 'Senden'; }
    return;
  }

  const editItem = ev.target.closest('form[data-edititem]');
  if (editItem) {
    ev.preventDefault();
    const fd = new FormData(editItem);
    try {
      await api(`/api/checklist/${editItem.dataset.edititem}`,
                { text: fd.get('text'), wants_photo: !!fd.get('foto') }, 'PATCH');
      toast('Gespeichert'); await renderTab();
    } catch (e) { toast(e.message); }
    return;
  }

  const person = ev.target.closest('form[data-person]');
  if (person) {
    ev.preventDefault();
    const fd = new FormData(person);
    try {
      await api(`/api/users/${person.dataset.person}`, {
        name: fd.get('name'), email: fd.get('email'),
        employment: fd.get('employment'), silent: !!fd.get('silent'),
      }, 'PATCH');
      users = (await api('/api/users')).users;
      toast('Gespeichert'); await renderTab();
    } catch (e) { toast(e.message); }
    return;
  }

  const neuePerson = ev.target.closest('#neueperson');
  if (neuePerson) {
    ev.preventDefault();
    const fd = new FormData(neuePerson);
    try {
      await api('/api/users', { name: fd.get('name'), email: fd.get('email'), employment: fd.get('employment') });
      users = (await api('/api/users')).users;
      toast('Angelegt'); await renderTab();
    } catch (e) { toast(e.message); }
    return;
  }

  const smf = ev.target.closest('#smoobu-form');
  if (smf) {
    ev.preventDefault();
    const fd = new FormData(smf);
    const btn = smf.querySelector('button');
    btn.disabled = true; btn.textContent = 'Prüfe …';
    try {
      const r = await api('/api/smoobu', { key: fd.get('key'), secret: fd.get('secret') }, 'PUT');
      toast(`Verbunden mit ${r.konto.email}`);
      await renderTab();
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Verbinden'; }
    return;
  }

  const neu = ev.target.closest('#neueunit');
  if (neu) {
    ev.preventDefault();
    const fd = new FormData(neu);
    try {
      await api('/api/units', { name: fd.get('name'), location: fd.get('location') });
      toast('Unterkunft angelegt'); await renderTab();
    } catch (e) { toast(e.message); }
    return;
  }

  const f = ev.target.closest('form[data-additem]');
  if (!f) return;
  ev.preventDefault();
  const fd = new FormData(f);
  try {
    await api('/api/checklist', {
      unit_id: f.dataset.additem || null,
      text: fd.get('text'),
      wants_photo: !!fd.get('foto'),
    });
    await renderTab();
  } catch (e) { toast(e.message); }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  location.reload();
});

async function start() {
  try {
    const info = await api('/api/me');
    me = info.me; tenant = info.tenant;
    $('#title').textContent = tenant.name;
    $('#sub').textContent = `Putzflow · ${me.name}`;
    hinweisleiste();
    $('#logout').hidden = false;
    users = (await api('/api/users')).users;
    await renderTab();
  } catch (e) {
    // api() wirft nur die Meldung — den Mandanten holen wir uns direkt, damit die
    // Maske weiß, ob sie den Demo-Zugang anbieten soll.
    let demo = false;
    try {
      const r = await fetch('/api/me');
      demo = !!(await r.json()).tenant?.demo;
    } catch { /* dann eben ohne */ }
    renderLogin(null, demo);
  }
}

// Hinweis zum Testzeitraum. Nach Ablauf wird nicht ausgesperrt: Ansehen und
// Herunterladen bleiben möglich, nur das Weiterarbeiten ruht. Wer aufhört, soll
// seine Daten mitnehmen können.
function hinweisleiste() {
  document.getElementById('hinweis')?.remove();
  const t = tenant && tenant.test;
  if (!t || t.bestellt_am) return;              // bestellt = erledigt, keine Leiste
  const p = tenant.preis;
  const el = document.createElement('div');
  el.id = 'hinweis';
  el.className = 'hinweis' + (tenant.nur_lesbar ? ' hinweis-aus' : '');

  const kosten = p
    ? ` Bei ${p.einheiten} Unterkünften sind das ${euro(p.monat_cent)} im Monat${
        p.mindest_greift ? ' (Mindestbetrag)' : ` — ${euro(p.satz_monat_cent)} je Unterkunft`},
        jährlich ${euro(p.jahr_cent)} für zehn Monate, zzgl. MwSt.`
    : '';

  // Derselbe Weg wie in der Mail — wer erst in der Anwendung darauf stößt, soll
  // nicht in seinem Postfach nach dem Link suchen müssen.
  const weiter = t.angebot_token
    ? `<a class="btn primary small" href="/angebot/${t.angebot_token}">Weitermachen</a>`
    : '';

  if (tenant.nur_lesbar) {
    el.innerHTML = `<strong>Testzeitraum abgelaufen</strong> (${fmtTag(t.endet_am)}).
      Sie können weiterhin alles ansehen und herunterladen.${kosten}
      <div class="row" style="margin-top:.5rem;gap:.5rem">
        ${weiter}
        <a class="btn ghost small" href="/api/export/stundenzettel.csv">Stundenzettel als CSV</a>
        <a class="btn ghost small" href="/api/export/daten.json">Alle Daten als JSON</a>
      </div>`;
  } else {
    el.innerHTML = `Testzeitraum: noch <strong>${t.tage_rest} Tag${t.tage_rest === 1 ? '' : 'e'}</strong>
      (bis ${fmtTag(t.endet_am)}, dem Ende Ihrer Abrechnungsperiode).${kosten}
      ${weiter ? `<div class="row" style="margin-top:.5rem">${weiter}</div>` : ''}`;
  }
  document.querySelector('.wrap').insertBefore(el, document.getElementById('content'));
}

const fmtTag = iso => iso.split('-').reverse().join('.');



if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();

// Auslagen freigeben, ablehnen, nachtragen.
document.addEventListener('click', async ev => {
  const ok = ev.target.closest('button[data-ausl-ok]');
  const nein = ev.target.closest('button[data-ausl-nein]');
  if (!ok && !nein) return;
  const btn = ok || nein;
  btn.disabled = true;
  try {
    await api(`/api/expenses/${btn.dataset.auslOk || btn.dataset.auslNein}`,
              { zustand: ok ? 'genehmigt' : 'abgelehnt' }, 'PATCH');
    await renderSheet();
  } catch (e) { toast(e.message); btn.disabled = false; }
});

document.addEventListener('submit', async ev => {
  const f = ev.target.closest('.auslageform');
  if (!f) return;
  ev.preventDefault();
  const d = new FormData(f);
  const betrag = String(d.get('amount') || '').replace(',', '.').trim();
  try {
    await api('/api/expenses', {
      user_id: Number(f.dataset.user),
      description: d.get('description'),
      amount_cents: betrag ? Math.round(parseFloat(betrag) * 100) : 0,
      minutes: Number(d.get('minutes') || 0),
    });
    toast('Eingetragen');
    await renderSheet();
  } catch (e) { toast(e.message); }
});

// Fehlende Arbeitszeit nachtragen. § 17 MiLoG verpflichtet den Arbeitgeber, nicht
// die Beschäftigte — also muss es auch hier gehen und nicht nur über deren Link.
document.addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-zeit]');
  if (!btn) return;
  const from = prompt(`Angefangen um (HH:MM) am ${fmtDate(btn.dataset.tag)}?`);
  if (!from) return;
  const to = prompt('Fertig um (HH:MM)?');
  if (!to) return;
  btn.disabled = true;
  try {
    await api(`/api/jobs/${btn.dataset.zeit}/time`, { from, to });
    toast('Nachgetragen');
    await renderSheet();
  } catch (e) { toast(e.message); btn.disabled = false; }
});
