'use strict';
/* =====================  SIGL – Saisie MEG (CSPS)  =====================
   Saisie hors-ligne du « Rapport de gestion et de commande des produits de santé ».
   Mêmes formules que le classeur Excel (onglet SIGL). Données : IndexedDB (sur l'appareil). */

const $ = (s, r = document) => r.querySelector(s);
const MONTHS = ['JANVIER','FÉVRIER','MARS','AVRIL','MAI','JUIN','JUILLET','AOÛT','SEPTEMBRE','OCTOBRE','NOVEMBRE','DÉCEMBRE'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const N = v => v == null ? 0 : v;
const fmt = (n, d = 0) => (n == null || !isFinite(n)) ? '—' : n.toLocaleString('fr-FR', { maximumFractionDigits: d });
const pad2 = n => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const PAGE = 60;

// champs de saisie : [clé, libellé, lettre du formulaire]
const FIELDS = [
  ['deb', 'Début de mois', 'A'], ['rec', 'Reçu', 'B'], ['per', 'Périmé', 'D'], ['aut', 'Autres pertes', 'E'],
  ['ajm', 'Ajust. (−)', 'F-'], ['ajp', 'Ajust. (+)', 'F+'], ['fin', 'Stock fin de mois', 'G'], ['rup', 'Jours de rupture', 'H']
];

/* ---------- stockage IndexedDB ---------- */
const DB = {
  db: null,
  open() { return new Promise((res, rej) => { const q = indexedDB.open('sigl-meg', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => { this.db = q.result; res(); }; q.onerror = () => rej(q.error); }); },
  tx(mode, fn) { return new Promise((res, rej) => { const t = this.db.transaction('kv', mode); const r = fn(t.objectStore('kv')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); },
  get: k => DB.tx('readonly', s => s.get(k)),
  set: (k, v) => DB.tx('readwrite', s => s.put(v, k)),
  del: k => DB.tx('readwrite', s => s.delete(k)),
  reports: () => DB.tx('readonly', s => s.getAll(IDBKeyRange.bound('report:', 'report:￿')))
};

/* ---------- état ---------- */
const S = { settings: null, catalog: null, reports: [], rep: null, tab: 'prod', q: '', filter: 'all', shown: PAGE };
const DEFAULTS = { district: 'GOURCY', region: 'YAADGA', csps: '', rate: 12 };
let saveTimer = null;

async function loadAll() {
  S.settings = Object.assign({}, DEFAULTS, await DB.get('settings'));
  S.catalog = (await DB.get('catalog')) || JSON.parse(JSON.stringify(window.CATALOG));
  if (!(await DB.get('catalog'))) await DB.set('catalog', S.catalog);
  S.reports = (await DB.reports()) || [];
}
const saveSettings = () => DB.set('settings', S.settings);
const saveCatalog = () => DB.set('catalog', S.catalog);
const repKey = r => 'report:' + r.id;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 350); }
async function saveNow() { clearTimeout(saveTimer); if (!S.rep) return; S.rep.updated = Date.now(); await DB.set(repKey(S.rep), S.rep); const i = S.reports.findIndex(r => r.id === S.rep.id); if (i >= 0) S.reports[i] = S.rep; else S.reports.push(S.rep); }
const makeId = (csps, y, m) => `${csps.trim().toUpperCase()}|${y}-${pad2(m)}`;

/* ---------- calculs (identiques au classeur) ---------- */
function calc(it, v, days) {
  v = v || {};
  const deb = N(v.deb), rec = N(v.rec), per = N(v.per), aut = N(v.aut), ajm = N(v.ajm), ajp = N(v.ajp), fin = N(v.fin), rup = N(v.rup);
  const cons = deb + rec + ajp - per - aut - ajm - fin;            // E = C+D+I-F-G-H-J
  const base = days - rup;
  const adj = base > 0 ? cons / base * days : cons;                  // L = E/(jours-K)*jours
  const cmd = Math.max(adj * 2 - fin, 0);                            // M = max(2L - J, 0)
  const pu = N(it.pu), drd = N(it.drd);
  return { cons, adj, cmd, P: cons * drd, Q: cons * pu, R: deb * pu, S: rec * pu, T: fin * pu, U: (per + aut) * pu, rup };
}
function problems(it, v, days) {
  const out = [];
  if (!v) return out;
  const c = calc(it, v, days);
  if (v.fin != null && c.cons < 0) out.push('Consommation négative : vérifiez début, reçu, pertes et stock fin.');
  if (v.rup != null && v.rup > days) out.push(`Jours de rupture > ${days} jours du mois.`);
  ['deb', 'rec', 'per', 'aut', 'ajm', 'ajp', 'fin', 'rup'].forEach(k => { if (v[k] != null && v[k] < 0) out.push('Valeur négative.'); });
  return [...new Set(out)];
}
function totals(rep) {
  const t = { P: 0, Q: 0, R: 0, S: 0, T: 0, U: 0, rec: 0, done: 0, nTr: 0, trRup: 0, trDays: 0, bad: 0 };
  for (const it of rep.items) {
    const v = rep.v[it.id];
    if (v && v.fin != null) t.done++;
    if (it.tr) { t.nTr++; if (N(v && v.rup) > 0) t.trRup++; t.trDays += N(v && v.rup); }
    if (!v) continue;
    const c = calc(it, v, rep.days);
    t.P += c.P; t.Q += c.Q; t.R += c.R; t.S += c.S; t.T += c.T; t.U += c.U; t.rec += N(v.rec);
    if (problems(it, v, rep.days).length) t.bad++;
  }
  const f = rep.fin, g = x => N(f[x]);
  t.marge = (t.Q - t.P) - t.U;
  t.retro = (g('caisse') + g('verse')) * (N(f.rate) / 100);
  t.car = g('grat') + g('ramu') + g('fonct') + g('caisse') + g('verse');
  t.cat = t.Q;
  t.ecart = t.car - t.cat;
  t.ratio = t.cat ? t.car / t.cat : null;
  t.tauxRup = t.nTr ? 100 * t.trRup / t.nTr : null;
  t.durRup = t.nTr ? t.trDays / t.nTr : null;
  return t;
}

/* ---------- sécurité : mot de passe administrateur (prix public / DRD) ---------- */
const SHA_K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256(msg) {
  const bytes = new TextEncoder().encode(msg), l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
  m.set(bytes); m[l] = 0x80; const dv = new DataView(m.buffer); dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor(l * 8 / 4294967296));
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]; const w = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const x = w[i - 15], y = w[i - 2]; w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0; }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map(x => x | 0);
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
function hashPw(pw, salt) { let h = sha256(salt + ':' + pw); for (let i = 0; i < 3000; i++) h = sha256(h + salt + pw); return h; }
const pwRec = () => S.settings.pw || (window.ADMIN_PW && window.ADMIN_PW.hash ? window.ADMIN_PW : null);
const hasPw = () => !!pwRec();
const isLocked = () => hasPw() && Date.now() > (S.unlockedUntil || 0);
function checkPw(pw) { const r = pwRec(); return !!r && hashPw(pw, r.salt) === r.hash; }
function makePw(pw) { const salt = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join(''); return { salt, hash: hashPw(pw, salt) }; }
function askPw(msg = 'Saisissez le mot de passe administrateur') {
  return new Promise(res => {
    const d = $('#dlg2'); let done = false; const fin = v => { if (done) return; done = true; if (d.open) d.close(); res(v); };
    d.innerHTML = `<div class="dh">🔒 Mot de passe administrateur</div><div class="db"><div class="fm"><label>${esc(msg)}<input type="password" id="pw-in" autocomplete="off"></label><p id="pw-err" style="color:var(--bad);margin:0" hidden></p></div></div><div class="df"><button class="btn sec" data-x>Annuler</button><button class="btn" data-ok>Valider</button></div>`;
    const err = m => { const e = $('#pw-err'); e.textContent = m; e.hidden = false; };
    const ok = () => {
      if (Date.now() < (S.pwBlock || 0)) return err(`Trop d'essais. Réessayez dans ${Math.ceil((S.pwBlock - Date.now()) / 1000)} s.`);
      if (checkPw($('#pw-in').value)) { S.fails = 0; S.unlockedUntil = Date.now() + 10 * 60 * 1000; fin(true); }
      else { S.fails = (S.fails || 0) + 1; if (S.fails >= 5) { S.pwBlock = Date.now() + 30000; S.fails = 0; err('Trop d\'essais. Attendez 30 secondes.'); } else err('Mot de passe incorrect.'); $('#pw-in').select(); }
    };
    d.querySelector('[data-x]').onclick = () => fin(false); d.querySelector('[data-ok]').onclick = ok;
    d.addEventListener('close', () => fin(false), { once: true }); d.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    d.showModal(); setTimeout(() => $('#pw-in') && $('#pw-in').focus(), 60);
  });
}
const needUnlock = msg => isLocked() ? askPw(msg) : Promise.resolve(true);
function dlgSetPw() {
  dlg(`<div class="dh">${S.settings.pw || window.ADMIN_PW ? 'Nouveau mot de passe' : 'Définir un mot de passe'}</div><div class="db"><div class="fm">
    <p class="mut" style="margin:0">Ce mot de passe protège la modification des prix (prix unitaire CSPS / prix public et prix DRD). Notez-le et conservez-le : il ne peut pas être récupéré.</p>
    <label>Mot de passe (4 caractères minimum)<input type="password" id="pw1" autocomplete="new-password"></label>
    <label>Confirmer<input type="password" id="pw2" autocomplete="new-password"></label></div></div>`,
    async () => {
      const a = $('#pw1').value, b = $('#pw2').value;
      if (a.length < 4) { toast('4 caractères minimum'); return false; }
      if (a !== b) { toast('Les deux mots de passe sont différents'); return false; }
      S.settings.pw = makePw(a); await saveSettings(); S.unlockedUntil = Date.now() + 10 * 60 * 1000; toast('Mot de passe enregistré'); viewSettings();
    }, 'Enregistrer');
}

/* ---------- création de rapport ---------- */
function newReport(csps, y, m) {
  const prev = S.reports.filter(r => r.csps.toUpperCase() === csps.toUpperCase()).sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month));
  const last = prev[0];
  const pm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const before = prev.find(r => r.year === pm.y && r.month === pm.m);
  const rep = {
    id: makeId(csps, y, m), csps: csps.trim(), year: y, month: m, days: daysIn(y, m),
    date: new Date().toISOString().slice(0, 10),
    items: S.catalog.map(c => ({ ...c })), v: {},
    fin: { grat: null, ramu: null, fonct: null, caisse: null, verse: null, rate: S.settings.rate },
    sign: last ? Object.fromEntries(Object.entries(last.sign).map(([k, o]) => [k, { nom: '', fonc: o.fonc || '', tel: '' }])) : { prep: { nom: '', fonc: 'GERANT', tel: '' }, appr: { nom: '', fonc: 'ICP', tel: '' }, recu: { nom: '', fonc: 'Pharmacien/PEP', tel: '' } },
    updated: Date.now()
  };
  if (before) carryOver(rep, before);
  return rep;
}
function carryOver(rep, before) {
  let n = 0;
  for (const it of rep.items) {
    const pv = before.v[it.id];
    if (pv && pv.fin != null) { const v = (rep.v[it.id] ||= {}); if (v.deb == null) { v.deb = pv.fin; n++; } }
  }
  return n;
}

/* ---------- routage ---------- */
window.addEventListener('hashchange', route);
function go(h) { location.hash = h; }
async function route() {
  await saveNow();
  const h = location.hash.replace(/^#/, '') || '/';
  if (h.startsWith('/r/')) {
    const id = decodeURIComponent(h.slice(3));
    S.rep = S.reports.find(r => r.id === id) || null;
    if (!S.rep) return go('/');
    viewReport();
  } else if (h === '/catalogue') { S.rep = null; viewCatalog(); }
  else if (h === '/reglages') { S.rep = null; viewSettings(); }
  else { S.rep = null; viewHome(); }
  window.scrollTo(0, 0);
}

/* ---------- vues : accueil ---------- */
function topbar(title, sub, back, actions = '') {
  return `<div class="top">${back ? `<button class="ib" data-act="back" aria-label="Retour">←</button>` : ''}<h1>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</h1>${actions}</div>`;
}
function viewHome() {
  const list = [...S.reports].sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month) || a.csps.localeCompare(b.csps));
  $('#app').innerHTML = topbar('SIGL · Saisie MEG', `District sanitaire de ${S.settings.district}`, false,
    `<button class="ib" data-act="catalog" title="Catalogue produits">💊</button><button class="ib" data-act="settings" title="Réglages">⚙</button>`) +
    `<div class="wrap">
      <div class="row-btns"><button class="btn" data-act="new">＋ Nouveau rapport mensuel</button>
      <button class="btn sec" data-act="import">Importer des données</button></div>
      ${list.length ? list.map(r => { const t = totals(r); const p = Math.round(100 * t.done / r.items.length); return `<div class="card rep" data-open="${esc(r.id)}"><div class="t"><b>${esc(r.csps)} — ${MONTHS[r.month - 1]} ${r.year}</b><small>${t.done}/${r.items.length} produits saisis${t.cat ? ' · CAR/CAT ' + fmt(t.ratio * 100, 1) + ' %' : ''}</small><div class="bar"><i style="width:${p}%"></i></div></div><span class="mut">›</span></div>`; }).join('')
        : `<div class="empty"><p style="font-size:2.4rem;margin:0">📋</p><p><b>Aucun rapport pour l'instant.</b><br>Appuyez sur « Nouveau rapport mensuel » pour commencer la saisie.</p></div>`}
    </div>`;
}
function dlg(html, onOk, okLabel = 'Enregistrer') {
  const d = $('#dlg');
  d.innerHTML = html + `<div class="df"><button class="btn sec" value="cancel" data-x>Annuler</button><button class="btn" data-ok>${okLabel}</button></div>`;
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('[data-ok]').onclick = async () => { if ((await onOk(d)) !== false) d.close(); };
  d.showModal();
}
function dlgInfo(html) { const d = $('#dlg'); d.innerHTML = html + `<div class="df"><button class="btn" data-x>OK</button></div>`; d.querySelector('[data-x]').onclick = () => d.close(); d.showModal(); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }

function dlgNew() {
  const now = new Date(); let y = now.getFullYear(), m = now.getMonth(); if (m === 0) { m = 12; y--; }   // mois précédent par défaut
  const known = [...new Set(S.reports.map(r => r.csps))];
  dlg(`<div class="dh">Nouveau rapport mensuel</div><div class="db"><div class="fm">
    <label>CSPS de :<input id="n-csps" list="n-list" value="${esc(known[0] || S.settings.csps)}" placeholder="Nom du CSPS" autocomplete="off"></label><datalist id="n-list">${known.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
    <div class="fm g2"><label>Mois<select id="n-m">${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label>Année<input id="n-y" type="number" value="${y}" min="2020" max="2100"></label></div>
    <p class="mut" style="margin:0">Si le rapport du mois précédent existe pour ce CSPS, le stock de début de mois est repris automatiquement.</p></div></div>`,
    async d => {
      const csps = $('#n-csps').value.trim(), mm = +$('#n-m').value, yy = +$('#n-y').value;
      if (!csps) { toast('Indiquez le nom du CSPS'); return false; }
      const id = makeId(csps, yy, mm);
      if (S.reports.some(r => r.id === id)) { toast('Ce rapport existe déjà'); go('/r/' + encodeURIComponent(id)); return; }
      const rep = newReport(csps, yy, mm); S.rep = rep; S.settings.csps = csps; saveSettings(); await saveNow(); S.tab = 'prod'; S.q = ''; S.filter = 'all'; go('/r/' + encodeURIComponent(rep.id));
    }, 'Créer');
}

/* ---------- vue : rapport ---------- */
function viewReport() {
  const r = S.rep;
  $('#app').innerHTML = topbar(`${r.csps}`, `${MONTHS[r.month - 1]} ${r.year} · ${r.days} jours`, true,
    `<button class="ib" data-act="recs" title="Réceptions (commandes reçues)">📦 <span class="lbl">Réceptions</span><b id="rcn"></b></button><button class="ib" data-act="export" title="Exporter en Excel ou PDF">⬇ Exporter</button>`) +
    `<div id="pane"></div>
    <nav class="tabs"><button data-tab="prod"><span>💊</span>Produits</button><button data-tab="bilan"><span>📊</span>Bilan</button><button data-tab="infos"><span>📝</span>Infos</button></nav>`;
  renderTab(); rcBadge();
}
function renderTab() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  if (S.tab === 'prod') paneProducts(); else if (S.tab === 'bilan') paneBilan(); else paneInfos();
}

function visibleItems() {
  const r = S.rep, q = S.q.trim().toLowerCase();
  return r.items.filter(it => {
    const v = r.v[it.id];
    if (q && !it.name.toLowerCase().includes(q)) return false;
    switch (S.filter) {
      case 'free': return it.free;
      case 'paid': return !it.free;
      case 'todo': return !(v && v.fin != null);
      case 'done': return v && v.fin != null;
      case 'alert': return problems(it, v, r.days).length > 0;
      case 'tr': return it.tr;
    }
    return true;
  });
}
const FILTERS = [['all', 'Tous'], ['todo', 'À saisir'], ['done', 'Saisis'], ['alert', '⚠ Alertes'], ['free', 'Gratuits'], ['paid', 'Payants'], ['tr', 'Traceurs']];

function paneProducts() {
  $('#pane').innerHTML = `<div class="stick"><div class="tools"><input type="search" id="q" placeholder="Rechercher un produit…" value="${esc(S.q)}" autocomplete="off">
    <div class="chips">${FILTERS.map(([k, l]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div></div>
    <div class="hdr"><div>Désignation</div>${FIELDS.map(f => `<div class="${f[0] === 'fin' ? 'hfin' : ''}">${f[1]}<br>(${f[2]})</div>`).join('')}<div>Consommé<br>(C)</div><div>Conso. ajustée<br>(I)</div><div>À commander<br>(J)</div></div></div>
    <div class="body"><div id="list"></div><div id="foot"></div></div>`;
  setTopH(); renderList(true);
}
function setTopH() { const t = $('.top'); if (t) document.documentElement.style.setProperty('--topH', t.offsetHeight + 'px'); }
window.addEventListener('resize', setTopH);
function rowHTML(it) {
  const r = S.rep, v = r.v[it.id] || {};
  return `<div class="row ${it.free ? 'free' : ''}" data-id="${it.id}">
    <div class="nm"><div class="n"><b>${esc(it.name)}</b><small>${esc(it.unit)}${it.pu ? ' · ' + fmt(it.pu, 2) + ' F' : ''}${it.tr ? ' · traceur' : ''}</small></div><button class="ed" data-edit="${it.id}" aria-label="Modifier le produit">✎</button></div>
    <div class="fields">${FIELDS.map(([k, l]) => { const n = k === 'rec' ? rcCount(r, it.id) : 0; return `<label class="${k === 'fin' ? 'fin' : ''}${n ? ' rcv' : ''}"><span>${l}</span><input data-k="${k}" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${v[k] == null ? '' : String(v[k]).replace('.', ',')}">${n ? `<button type="button" class="rcb" data-rcp="${it.id}" title="${n} réception(s) : voir le détail">📦${n}</button>` : ''}</label>`; }).join('')}</div>
    <div class="calc"><div><small>Consommé</small><b data-o="cons"></b></div><div><small>Conso. ajustée</small><b data-o="adj"></b></div><div><small>À commander</small><b data-o="cmd"></b></div></div>
    <div class="flag" hidden></div></div>`;
}
function renderList(reset) {
  const items = visibleItems(); if (reset) S.shown = PAGE;
  const slice = items.slice(0, S.shown);
  $('#list').innerHTML = slice.length ? slice.map(rowHTML).join('') + (items.length > slice.length ? `<button class="btn sec more" data-act="more">Afficher la suite (${items.length - slice.length} restants)</button>` : '')
    : `<div class="empty">Aucun produit ne correspond.</div>`;
  $('#list').querySelectorAll('.row').forEach(updateRow);
  updateFoot();
}
function updateRow(row) {
  const r = S.rep, it = r.items.find(x => x.id === row.dataset.id), v = r.v[it.id];
  const c = calc(it, v, r.days), has = v && Object.keys(v).length > 0;
  const set = (o, val, neg) => { const e = row.querySelector(`[data-o=${o}]`); e.textContent = has ? fmt(val, 1) : '—'; e.classList.toggle('neg', !!neg); };
  set('cons', c.cons, has && c.cons < 0); set('adj', c.adj); set('cmd', c.cmd);
  const pr = problems(it, v, r.days), fl = row.querySelector('.flag');
  fl.hidden = !pr.length; fl.textContent = pr.join(' ');
  row.classList.toggle('done', !!(v && v.fin != null) && !pr.length); row.classList.toggle('warn', pr.length > 0);
}
let footTimer;
function updateFoot() {
  clearTimeout(footTimer);
  footTimer = setTimeout(() => {
    const el = $('#foot'); if (!el || !S.rep) return; const t = totals(S.rep);
    el.innerHTML = `<p class="mut" style="text-align:center;margin:14px">${t.done}/${S.rep.items.length} produits saisis${t.bad ? ` · <b style="color:var(--bad)">${t.bad} alerte(s)</b>` : ''}</p>`;
  }, 150);
}

/* saisie : un seul écouteur pour toute la liste */
document.addEventListener('input', e => {
  const inp = e.target.closest('input[data-k]'); if (!inp || !S.rep) return;
  const row = inp.closest('.row'), id = row.dataset.id, k = inp.dataset.k, n = num(inp.value);
  inp.classList.toggle('bad', inp.value.trim() !== '' && n == null);
  const v = (S.rep.v[id] ||= {});
  if (n == null) delete v[k]; else v[k] = n;
  if (!Object.keys(v).length) delete S.rep.v[id];
  updateRow(row); updateFoot(); scheduleSave();
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.q = e.target.value; clearTimeout(renderList.t); renderList.t = setTimeout(() => renderList(true), 200); }
});
document.addEventListener('focusin', e => { if (e.target.matches('input[data-k]')) setTimeout(() => e.target.select(), 0); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.rep && S.tab === 'prod' && $('#q')) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  const inp = e.target.closest && e.target.closest('input[data-k]'); if (!inp) return;
  const all = [...document.querySelectorAll('#list input[data-k]')], i = all.indexOf(inp);
  let t = null;
  if (e.key === 'Enter') t = all[i + 1];
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const d = e.key === 'ArrowDown' ? 1 : -1; t = all[i + d * FIELDS.length]; }
  if (t) { e.preventDefault(); t.focus(); t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
});

/* ---------- réceptions : une ou plusieurs commandes reçues dans le mois ---------- */
const fd = iso => iso ? iso.split('-').reverse().join('/') : '—';
const todayISO = () => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`; };
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const rcCount = (r, pid) => (r.recs || []).reduce((n, x) => n + (x.lines.some(l => l.pid === pid) ? 1 : 0), 0);
const recSums = r => { const s = {}; for (const x of r.recs || []) for (const l of x.lines) s[l.pid] = (s[l.pid] || 0) + N(l.qty); return s; };
/* applique un changement de réceptions et répercute la différence dans la colonne « Reçu » (B) */
function applyRecs(r, mutate) {
  const before = recSums(r); r.recs ||= []; mutate(r.recs); const after = recSums(r);
  for (const pid of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = N(after[pid]) - N(before[pid]); if (!d) continue;
    const v = (r.v[pid] ||= {}), nv = Math.round((N(v.rec) + d) * 1e4) / 1e4;
    if (nv === 0 && !after[pid]) delete v.rec; else v.rec = nv;
    if (!Object.keys(v).length) delete r.v[pid];
  }
}
const money = n => fmt(Math.round(n), 0) + ' F';
function recVal(r, lines) { const m = new Map(r.items.map(i => [i.id, i])); let a = 0, v = 0; for (const l of lines) { const it = m.get(l.pid); if (!it) continue; a += N(l.qty) * N(it.drd); v += N(l.qty) * N(it.pu); } return { a, v }; }
function rcBadge() { const e = $('#rcn'); if (e && S.rep) { const n = (S.rep.recs || []).length; e.textContent = n ? ' ' + n : ''; } }
function rcRefresh() { rcBadge(); if (S.tab === 'prod' && $('#list')) renderList(false); }

function dlgRecs() {
  const d = $('#dlg3'), r = S.rep, recs = (r.recs || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const grand = recs.reduce((n, x) => n + x.lines.length, 0);
  d.className = 'big';
  d.innerHTML = `<div class="dh">📦 Réceptions · ${MONTHS[r.month - 1]} ${r.year}</div><div class="db">
    <p class="mut" style="margin:0 0 10px">Enregistrez chaque commande reçue (bon de livraison). La colonne <b>Reçu (B)</b> de chaque produit est mise à jour automatiquement : plusieurs réceptions s'additionnent.</p>
    ${recs.length ? recs.map(x => `<div class="cat-item" data-rc="${x.id}"><div class="n"><b>${fd(x.date)} · ${esc(x.ref || 'sans n° de bon')}</b><small>${x.lines.length} produit(s) · achat ${money(recVal(r, x.lines).a)} · vente publique ${money(recVal(r, x.lines).v)}</small></div><span class="mut">✎</span></div>`).join('') + (() => { const all = recVal(r, recs.flatMap(x => x.lines)); return `<div class="rc-tot"><div><small>${recs.length} réception(s) · ${grand} ligne(s)</small></div><div><small>Total achat</small><b>${money(all.a)}</b></div><div><small>Total vente au public</small><b>${money(all.v)}</b></div></div>`; })() : `<div class="empty">Aucune réception enregistrée ce mois-ci.</div>`}
  </div><div class="df"><button class="btn sec" data-x>Fermer</button><button class="btn" data-new>＋ Nouvelle réception</button></div>`;
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('[data-new]').onclick = () => dlgRecEdit();
  d.querySelectorAll('[data-rc]').forEach(e => e.onclick = () => dlgRecEdit(e.dataset.rc));
  d.onclose = () => rcRefresh();
  if (!d.open) d.showModal();
}

function dlgRecEdit(id) {
  const d = $('#dlg3'), r = S.rep, old = id ? (r.recs || []).find(x => x.id === id) : null;
  const ed = old ? JSON.parse(JSON.stringify(old)) : { id: 'rc' + Date.now().toString(36), date: todayISO(), ref: '', note: '', lines: [] };
  const first = JSON.stringify(ed), byId = new Map(r.items.map(i => [i.id, i]));
  d.className = 'big';
  d.innerHTML = `<div class="dh">${old ? 'Modifier la réception' : 'Nouvelle réception'}</div><div class="db rcedit">
    <div class="fm g2"><label>Date de réception<input id="rc-d" type="date" value="${ed.date}"></label><label>N° du bon / de la commande<input id="rc-r" value="${esc(ed.ref)}" placeholder="ex. BL 0123" autocomplete="off"></label></div>
    <p id="rc-w" class="flag" hidden></p>
    <label class="srch">Ajouter un produit reçu<input id="rc-q" type="search" placeholder="Tapez le nom du produit…" autocomplete="off" enterkeyhint="done"></label>
    <div id="rc-s" class="sug"></div>
    <div id="rc-l"></div>
  </div><div id="rc-sum" class="rc-sum" hidden></div><div class="df">${old ? '<button class="btn bad" data-del style="margin-right:auto">Supprimer</button>' : ''}<button class="btn sec" data-x>Retour</button><button class="btn" data-ok>Enregistrer</button></div>`;
  const q = d.querySelector('#rc-q'), L = d.querySelector('#rc-l'), SG = d.querySelector('#rc-s');
  const total = () => ed.lines.reduce((n, l) => n + N(l.qty), 0);
  function drawLines() {
    L.innerHTML = ed.lines.length ? `<div class="rc-h"><b>${ed.lines.length} produit(s) dans cette réception</b><span id="rc-t" class="mut"></span></div>` + ed.lines.map(l => { const it = byId.get(l.pid); return `<div class="rc-line" data-p="${l.pid}"><div class="n"><b>${esc(it ? it.name : l.pid)}</b><small>${esc(it ? it.unit : '')}</small><small class="pr">Achat : <span>${it ? fmt(N(it.drd), 2) : 0} F</span> × qté = <b data-la="${l.pid}"></b></small><small class="pr">Public : <span>${it ? fmt(N(it.pu), 2) : 0} F</span> × qté = <b data-lv="${l.pid}"></b></small></div><input data-q="${l.pid}" inputmode="decimal" autocomplete="off" enterkeyhint="next" placeholder="Qté" value="${l.qty == null ? '' : String(l.qty).replace('.', ',')}"><button type="button" class="ed" data-rm="${l.pid}" aria-label="Retirer">✕</button></div>`; }).join('') : `<div class="empty" style="padding:18px">Aucun produit pour l'instant.<br>Recherchez-en un ci-dessus.</div>`;
    sum();
  }
  function sum() {
    const t = d.querySelector('#rc-t'); if (t) t.textContent = 'Total : ' + fmt(total(), 2) + ' unités';
    for (const l of ed.lines) { const it = byId.get(l.pid); if (!it) continue; const a = d.querySelector(`[data-la="${l.pid}"]`), v = d.querySelector(`[data-lv="${l.pid}"]`); if (a) a.textContent = money(N(l.qty) * N(it.drd)); if (v) v.textContent = money(N(l.qty) * N(it.pu)); }
    const T = recVal(r, ed.lines), box = d.querySelector('#rc-sum');
    box.hidden = !ed.lines.length; box.innerHTML = `<div><small>Total achat de la liste</small><b>${money(T.a)}</b></div><div><small>Total vente au public</small><b>${money(T.v)}</b></div><div><small>Marge théorique</small><b>${money(T.v - T.a)}</b></div>`;
  }
  function sug() {
    const toks = norm(q.value).split(/\s+/).filter(Boolean);
    if (!toks.length) { SG.innerHTML = ''; return []; }
    const m = r.items.filter(i => { const n = norm(i.name); return toks.every(t => n.includes(t)); }).slice(0, 8);
    SG.innerHTML = m.length ? m.map(i => `<button type="button" data-add="${i.id}"><b>${esc(i.name)}</b><small>${esc(i.unit)} · achat ${fmt(N(i.drd), 2)} F · public ${fmt(N(i.pu), 2)} F${ed.lines.some(l => l.pid === i.id) ? ' · déjà ajouté' : ''}</small></button>`).join('') : `<div class="mut" style="padding:8px">Aucun produit trouvé.</div>`;
    return m;
  }
  function add(pid) {
    if (!ed.lines.some(l => l.pid === pid)) ed.lines.unshift({ pid, qty: null });
    q.value = ''; SG.innerHTML = ''; drawLines();
    const inp = L.querySelector(`[data-q="${pid}"]`); if (inp) { inp.focus(); inp.select(); }
  }
  q.oninput = sug;
  q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const m = sug(); if (m[0]) add(m[0].id); } };
  SG.onclick = e => { const b = e.target.closest('[data-add]'); if (b) add(b.dataset.add); };
  L.oninput = e => { const i = e.target.closest('[data-q]'); if (!i) return; const l = ed.lines.find(x => x.pid === i.dataset.q); l.qty = num(i.value); i.classList.toggle('bad', i.value.trim() !== '' && l.qty == null); sum(); };
  L.onfocusin = e => { if (e.target.matches('[data-q]')) setTimeout(() => e.target.select(), 0); };
  L.onkeydown = e => { if (e.key === 'Enter' && e.target.matches('[data-q]')) { e.preventDefault(); q.focus(); } };
  L.onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { ed.lines = ed.lines.filter(l => l.pid !== b.dataset.rm); drawLines(); } };
  const chkDate = () => { const v = d.querySelector('#rc-d').value, w = d.querySelector('#rc-w'), ok = !v || v.slice(0, 7) === `${r.year}-${pad2(r.month)}`; w.hidden = ok; w.textContent = ok ? '' : `⚠ Cette date n'est pas dans ${MONTHS[r.month - 1].toLowerCase()} ${r.year}.`; };
  d.querySelector('#rc-d').oninput = chkDate; chkDate();
  const back = () => { if (JSON.stringify({ ...ed, date: d.querySelector('#rc-d').value, ref: d.querySelector('#rc-r').value.trim() }) !== first && ed.lines.length && !confirm('Abandonner les modifications de cette réception ?')) return; dlgRecs(); };
  d.querySelector('[data-x]').onclick = back;
  const del = d.querySelector('[data-del]');
  if (del) del.onclick = async () => { if (!confirm('Supprimer cette réception ? Les quantités seront retirées de la colonne « Reçu ».')) return; applyRecs(r, a => { const i = a.findIndex(x => x.id === ed.id); if (i >= 0) a.splice(i, 1); }); await saveNow(); toast('Réception supprimée'); dlgRecs(); };
  d.querySelector('[data-ok]').onclick = async () => {
    ed.date = d.querySelector('#rc-d').value; ed.ref = d.querySelector('#rc-r').value.trim();
    if (!ed.date) return toast('Indiquez la date de réception');
    if (!ed.lines.length) return toast('Ajoutez au moins un produit');
    const miss = ed.lines.find(l => !(l.qty > 0));
    if (miss) { const i = L.querySelector(`[data-q="${miss.pid}"]`); i.classList.add('bad'); i.focus(); return toast('Quantité à renseigner (supérieure à 0)'); }
    if (ed.ref && (r.recs || []).some(x => x.id !== ed.id && norm(x.ref) === norm(ed.ref)) && !confirm(`Une réception « ${ed.ref} » existe déjà. Enregistrer quand même (risque de doublon) ?`)) return;
    applyRecs(r, a => { const i = a.findIndex(x => x.id === ed.id); if (i >= 0) a[i] = ed; else a.push(ed); });
    await saveNow(); toast(old ? 'Réception modifiée' : 'Réception enregistrée'); dlgRecs();
  };
  drawLines(); if (!d.open) d.showModal(); if (!old) setTimeout(() => q.focus(), 60);
}
function dlgRecProd(pid) {
  const r = S.rep, it = r.items.find(x => x.id === pid), v = r.v[pid] || {};
  const rows = (r.recs || []).map(x => ({ x, l: x.lines.find(l => l.pid === pid) })).filter(o => o.l).sort((a, b) => (a.x.date || '').localeCompare(b.x.date || ''));
  const s = rows.reduce((n, o) => n + N(o.l.qty), 0), hand = Math.round((N(v.rec) - s) * 1e4) / 1e4;
  dlgInfo(`<div class="dh">${esc(it.name)}</div><div class="db"><table class="t">${rows.map(o => `<tr><td>${fd(o.x.date)} · ${esc(o.x.ref || 'sans n°')}</td><td>${fmt(o.l.qty, 2)}</td></tr>`).join('')}${hand ? `<tr><td>Saisi directement dans « Reçu »</td><td>${fmt(hand, 2)}</td></tr>` : ''}<tr><td><b>Total reçu (B)</b></td><td><b>${fmt(N(v.rec), 2)}</b></td></tr></table><p class="mut">Pour modifier : ouvrez « 📦 Réceptions » en haut de l'écran.</p></div>`);
}

/* ---------- onglet Bilan ---------- */
function paneBilan() {
  const f = S.rep.fin;
  const fi = (k, l) => `<label>${l}<input data-f="${k}" inputmode="decimal" value="${f[k] == null ? '' : String(f[k]).replace('.', ',')}" placeholder="0"></label>`;
  $('#pane').innerHTML = `<div class="wrap body"><div id="bres1"></div>
    <div class="card"><h2>Caisse et sorties (F CFA)</h2><div class="fm g2">
      ${fi('grat', 'MEG sorties pour la gratuité des soins et la PF')}${fi('ramu', 'MEG sorties pour le RAMU')}${fi('fonct', 'MEG sorties pour le fonctionnement du CSPS')}
      ${fi('caisse', 'Caisse du gérant non encore versé au trésorier')}${fi('verse', 'Versements effectués au trésorier par le gérant')}
      <label>Taux de rétrocession (%)<input data-f="rate" inputmode="decimal" value="${String(N(f.rate)).replace('.', ',')}"></label></div></div>
    <div id="bres2"></div>
    <div class="row-btns"><button class="btn sec bad-o" data-act="bilanreset">↺ Remettre le bilan à vide</button></div></div>`;
  bilanResults();
}
function bilanResults() {
  const r = S.rep, t = totals(r);
  const ok = t.ratio != null && t.ratio >= 0.98 && t.ratio <= 1.02;
  $('#bres1').innerHTML = `<div class="card"><h2>Valeurs du mois (prix public DMEG)</h2><table class="t">
      <tr><td>Valeur du stock au début du mois</td><td>${fmt(t.R)} F</td></tr>
      <tr><td>Valeur des MEG reçues</td><td>${fmt(t.S)} F</td></tr>
      <tr><td>Total vente du mois (prix public)</td><td><b>${fmt(t.Q)} F</b></td></tr>
      <tr><td>Total vente du mois (prix DRD)</td><td>${fmt(t.P)} F</td></tr>
      <tr><td>Valeur du stock en fin de mois</td><td>${fmt(t.T)} F</td></tr>
      <tr><td>Valeur du stock périmé / cassé</td><td>${fmt(t.U)} F</td></tr></table></div>
    <div class="card"><h2>Indicateurs de rupture (produits traceurs)</h2><table class="t">
      <tr><td>Taux de rupture des traceurs</td><td>${t.tauxRup == null ? '—' : fmt(t.tauxRup, 1) + ' %'}</td></tr>
      <tr><td>Durée moyenne de rupture (jours)</td><td>${t.durRup == null ? '—' : fmt(t.durRup, 1)}</td></tr></table>
      <p class="mut" style="margin:8px 0 0">${t.nTr ? `${t.nTr} produit(s) traceur(s) marqué(s).` : 'Aucun traceur défini : marquez les 25 médicaments traceurs DMEG dans le catalogue (💊) pour calculer ces indicateurs.'}</p></div>`;
  $('#bres2').innerHTML = `<div class="card"><h2>Résultats</h2><table class="t">
      <tr><td>Marge théorique du mois</td><td>${fmt(t.marge)} F</td></tr>
      <tr><td>Rétrocession maximum sur recettes en liquidité</td><td>${fmt(t.retro)} F</td></tr>
      <tr><td>Chiffre d'affaires réel (CAR)</td><td>${fmt(t.car)} F</td></tr>
      <tr><td>Chiffre d'affaires théorique (CAT)</td><td>${fmt(t.cat)} F</td></tr>
      <tr><td>CAR − CAT</td><td>${fmt(t.ecart)} F</td></tr>
      <tr><td>CAR / CAT <span class="mut">(norme 0,98 – 1,02)</span></td><td>${t.ratio == null ? '<span class="pill na">—</span>' : `<span class="pill ${ok ? 'ok' : 'bad'}">${fmt(t.ratio, 3)} ${ok ? '✔' : '⚠'}</span>`}</td></tr></table></div>`;
}
document.addEventListener('input', e => {
  const i = e.target.closest && e.target.closest('input[data-f]'); if (!i || !S.rep) return;
  S.rep.fin[i.dataset.f] = num(i.value); scheduleSave(); bilanResults();
});

/* ---------- onglet Infos ---------- */
function paneInfos() {
  const r = S.rep, s = r.sign;
  const sg = (k, l) => `<div class="card"><h2>${l}</h2><div class="fm g2"><label>Nom et prénom<input data-s="${k}.nom" value="${esc(s[k].nom)}"></label><label>Fonction<input data-s="${k}.fonc" value="${esc(s[k].fonc)}"></label><label>N° de téléphone<input data-s="${k}.tel" inputmode="tel" value="${esc(s[k].tel)}"></label></div></div>`;
  $('#pane').innerHTML = `<div class="wrap body">
    <div class="card"><h2>Identification du rapport</h2><div class="fm g2">
      <label>CSPS de :<input id="i-csps" value="${esc(r.csps)}"></label>
      <label>Mois<select id="i-m">${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === r.month ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Année<input id="i-y" type="number" value="${r.year}"></label>
      <label>Date du rapport<input id="i-d" type="date" value="${esc(r.date)}"></label></div>
      <p class="mut" style="margin-bottom:0">Nombre de jours du mois : <b>${r.days}</b> · District : ${esc(S.settings.district)}</p></div>
    ${sg('prep', 'Préparé par (gérant)')}${sg('appr', 'Approuvé par (ICP)')}${sg('recu', 'Reçu au District par')}
    <div class="card"><h2>Actions</h2><div class="row-btns" style="margin:0">
      <button class="btn" data-act="export">⬇ Exporter (Excel / PDF)</button>
      <button class="btn sec" data-act="json">Sauvegarde (JSON)</button>
      <button class="btn sec" data-act="carry">Reprendre les stocks du mois précédent</button>
      <button class="btn sec" data-act="prices">Mettre à jour les prix depuis le catalogue</button>
      <button class="btn bad" data-act="delrep">Supprimer ce rapport</button></div></div></div>`;
}
document.addEventListener('change', async e => {
  const t = e.target; if (!S.rep) return;
  if (t.dataset && t.dataset.s) { const [k, f] = t.dataset.s.split('.'); S.rep.sign[k][f] = t.value; scheduleSave(); return; }
  if (['i-csps', 'i-m', 'i-y', 'i-d'].includes(t.id)) {
    const r = S.rep, old = r.id;
    const csps = $('#i-csps').value.trim() || r.csps, m = +$('#i-m').value, y = +$('#i-y').value || r.year;
    const id = makeId(csps, y, m);
    if (id !== old && S.reports.some(x => x.id === id)) { toast('Un rapport existe déjà pour ce CSPS et ce mois'); return paneInfos(); }
    r.csps = csps; r.month = m; r.year = y; r.days = daysIn(y, m); r.date = $('#i-d').value || r.date; r.id = id;
    if (id !== old) { await DB.del('report:' + old); S.reports = S.reports.filter(x => x.id !== old); S.reports.push(r); history.replaceState(null, '', '#/r/' + encodeURIComponent(id)); }
    await saveNow(); viewReport(); S.tab = 'infos'; renderTab(); toast('Enregistré');
  }
});

/* ---------- catalogue ---------- */
let cq = '';
function viewCatalog() {
  $('#app').innerHTML = topbar('Catalogue des produits', `${S.catalog.length} produits · prix et unités`, true, `<button class="ib" data-act="addprod">＋</button>`) +
    `<div class="tools"><input type="search" id="cq" placeholder="Rechercher…" value="${esc(cq)}"></div><div class="wrap" id="clist"></div>`;
  drawCatalog();
}
function drawCatalog() {
  const q = cq.trim().toLowerCase(), items = S.catalog.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 200);
  $('#clist').innerHTML = `<div class="card" style="padding:4px 14px">${items.map(c => `<div class="cat-item ${c.free ? 'free' : ''}" data-cedit="${c.id}"><div class="n"><b>${esc(c.name)}</b><small>${esc(c.unit)} · CSPS ${fmt(c.pu, 2)} F · DRD ${fmt(c.drd, 2)} F${c.free ? ' · gratuit' : ''}${c.tr ? ' · traceur' : ''}</small></div><span class="mut">✎</span></div>`).join('') || '<div class="empty">Aucun résultat</div>'}</div>${S.catalog.length > 200 && !q ? '<p class="mut" style="text-align:center">Utilisez la recherche pour voir les autres produits.</p>' : ''}`;
}
document.addEventListener('input', e => { if (e.target.id === 'cq') { cq = e.target.value; drawCatalog(); } });

function dlgProduct(id) {
  const c = id ? S.catalog.find(x => x.id === id) : { id: uid(), name: '', unit: '', pu: 0, drd: 0, free: false, tr: false };
  dlg(`<div class="dh">${id ? 'Modifier le produit' : 'Nouveau produit'}</div><div class="db"><div class="fm">
    <label>Désignation<input id="p-n" value="${esc(c.name)}"></label>
    <div class="fm g2"><label>Unité de comptage<input id="p-u" value="${esc(c.unit)}"></label><span></span>
    <label>Prix unitaire en CSPS / prix public (F)${isLocked() ? ' 🔒' : ''}<input id="p-pu" inputmode="decimal" ${isLocked() ? 'readonly' : ''} value="${String(c.pu).replace('.', ',')}"></label>
    <label>Prix DRD (F)${isLocked() ? ' 🔒' : ''}<input id="p-drd" inputmode="decimal" ${isLocked() ? 'readonly' : ''} value="${String(c.drd).replace('.', ',')}"></label></div>
    ${isLocked() ? '<button class="btn sec sm" id="p-unlock" style="justify-self:start">🔒 Déverrouiller les prix (mot de passe)</button>' : (hasPw() ? '' : '<p class="mut" style="margin:0">Les prix ne sont protégés par aucun mot de passe : voir Réglages › Sécurité.</p>')}
    <label class="chk"><input type="checkbox" id="p-free" ${c.free ? 'checked' : ''}> Produit gratuit / de programme (prix = 0)</label>
    <label class="chk"><input type="checkbox" id="p-tr" ${c.tr ? 'checked' : ''}> Médicament traceur DMEG</label>
    ${id ? '<button class="btn bad sm" id="p-del" style="justify-self:start">Retirer du catalogue</button>' : ''}</div></div>`,
    async () => {
      const name = $('#p-n').value.trim(); if (!name) { toast('Désignation obligatoire'); return false; }
      const prices = isLocked() ? { pu: c.pu, drd: c.drd } : { pu: N(num($('#p-pu').value)), drd: N(num($('#p-drd').value)) };
      Object.assign(c, { name, unit: $('#p-u').value.trim(), ...prices, free: $('#p-free').checked, tr: $('#p-tr').checked });
      if (!id) S.catalog.push(c);
      await saveCatalog();
      if (S.rep) { const i = S.rep.items.findIndex(x => x.id === c.id); if (i >= 0) S.rep.items[i] = { ...c }; else S.rep.items.push({ ...c }); scheduleSave(); }
      toast('Produit enregistré'); if (S.rep) { S.tab === 'prod' ? renderList() : renderTab(); } else drawCatalog();
    });
  const ul = $('#p-unlock');
  if (ul) ul.onclick = async () => { if (await askPw('Saisissez le mot de passe pour modifier les prix')) { $('#p-pu').readOnly = false; $('#p-drd').readOnly = false; ul.remove(); toast('Prix déverrouillés (10 min)'); $('#p-pu').focus(); } };
  const del = $('#p-del');
  if (del) del.onclick = async () => { if (!confirm('Retirer ce produit du catalogue ? (les rapports déjà créés le conservent)')) return; S.catalog = S.catalog.filter(x => x.id !== id); await saveCatalog(); $('#dlg').close(); drawCatalog(); };
}

/* ---------- réglages / sauvegarde ---------- */
function viewSettings() {
  const s = S.settings;
  $('#app').innerHTML = topbar('Réglages', '', true) + `<div class="wrap">
    <div class="card"><h2>En-tête des rapports</h2><div class="fm g2">
      <label>District sanitaire<input id="s-d" value="${esc(s.district)}"></label><label>Région<input id="s-r" value="${esc(s.region)}"></label>
      <label>Taux de rétrocession par défaut (%)<input id="s-rate" inputmode="decimal" value="${s.rate}"></label></div></div>
    <div class="card"><h2>Sécurité des prix</h2><p class="mut" style="margin-top:0">${hasPw() ? (isLocked() ? '🔒 Les prix (CSPS / public et DRD) sont protégés par un mot de passe.' : '🔓 Prix déverrouillés pour quelques minutes.') : 'Aucun mot de passe : les prix peuvent être modifiés par tout utilisateur.'}</p>
      <div class="row-btns" style="margin:0">${hasPw() ? `<button class="btn sec" data-act="pwchange">Changer le mot de passe</button>${s.pw ? '<button class="btn sec" data-act="pwremove">Retirer le mot de passe</button>' : ''}${!isLocked() ? '<button class="btn sec" data-act="pwlock">Verrouiller maintenant</button>' : ''}` : '<button class="btn" data-act="pwset">Définir un mot de passe</button>'}</div></div>
    <div class="card"><h2>Données</h2><p class="mut" style="margin-top:0">Les données restent sur cet appareil. Faites régulièrement une sauvegarde et transmettez-la au district (WhatsApp, e-mail, clé USB).</p>
      <div class="row-btns" style="margin:0"><button class="btn" data-act="backup">Sauvegarder tout (JSON)</button><button class="btn sec" data-act="import">Restaurer / importer</button><button class="btn sec" data-act="catalog">Catalogue des produits</button></div></div>
    <p class="mut" style="text-align:center">SIGL Saisie MEG · version 1.5.1 · fonctionne sans connexion</p></div>`;
  ['s-d', 's-r', 's-rate'].forEach(i => $('#' + i).addEventListener('change', () => { s.district = $('#s-d').value.trim(); s.region = $('#s-r').value.trim(); s.rate = N(num($('#s-rate').value)); saveSettings(); toast('Enregistré'); }));
}

/* ---------- fichiers (téléchargement / partage Android) ---------- */
async function saveFile(name, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    try {
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
      const w = await cap.Plugins.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
      await cap.Plugins.Share.share({ title: name, url: w.uri, dialogTitle: 'Enregistrer ou envoyer le fichier' });
      return;
    } catch (err) { if (String(err && err.message || err).toLowerCase().includes('cancel')) return; console.error(err); }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); toast('Fichier téléchargé : ' + name);
}
const safe = s => s.replace(/[^\w\-]+/g, '_');

/* ---------- moteur de valeurs : SIGL -> SYNTHESE -> RMA (mêmes liens que le classeur) ---------- */
const SYN = {}, RMAM = {};
(window.MAPS ? window.MAPS.syn : []).forEach(e => SYN[e.r] = e);
(window.MAPS ? window.MAPS.rma : []).forEach(e => RMAM[e.r] = e);
function placeItems(r) {
  const rowOf = {}, used = new Set(), extras = [];
  for (const it of r.items) {
    const m = /^p(\d{1,3})$/.exec(it.id), n = m ? +m[1] : 0;
    if (n >= 13 && n <= 454 && !used.has(n)) { rowOf[it.id] = n; used.add(n); } else extras.push(it);
  }
  let nx = 436; for (const it of extras) { while (used.has(nx)) nx++; rowOf[it.id] = nx; used.add(nx); nx++; }
  const byRow = {}; r.items.forEach(it => byRow[rowOf[it.id]] = it);
  const last = Math.max(454, ...used);
  return { rowOf, byRow, last, tot: last + 1 };
}
function engine(r) {
  const P = placeItems(r), memo = {};
  const key = { C: 'deb', D: 'rec', F: 'per', G: 'aut', H: 'ajm', I: 'ajp', J: 'fin', K: 'rup' };
  const sigl = (row, col) => {
    const it = P.byRow[row]; if (!it) return 0;
    const v = r.v[it.id] || {}, c = calc(it, v, r.days);
    if (col === 'E') return c.cons; if (col === 'L') return c.adj; if (col === 'M') return c.cmd;
    return N(v[key[col]]);
  };
  const src = (t, g, col) => g === 'G' ? sigl(t, col) : (t <= 163 ? syn(t, col) : sigl(t - 152, col));
  const syn = (n, col) => { const k = 's' + n + col; if (k in memo) return memo[k]; const e = SYN[n]; let s = 0; if (e && e.t) e.t.forEach((t, i) => s += src(t, e.g[i], col)); return memo[k] = s; };
  const rma = (n, col) => { const e = RMAM[n]; let s = 0; if (e && e.t) e.t.forEach(t => s += src(t, 'S', col === 'L' ? 'M' : col)); return s; };
  const refText = (t, g, col, local) => g === 'G' ? `SIGL!${col}${t}` : (t <= 163 ? (local ? `${col}${t}` : `SYNTHESE!${col}${t}`) : `SIGL!${col}${t - 152}`);
  return { P, sigl, syn, rma, refText };
}

/* ---------- export Excel : 3 feuilles SIGL + SYNTHESE + RMA ---------- */
function exportXlsx(r) {
  const X = XLSX, E = engine(r), t = totals(r), P = E.P, first = 13, tot = P.tot, last = tot - 1, n = r.items.length;
  const thin = { style: 'thin', color: { rgb: '999999' } }, bd = { top: thin, bottom: thin, left: thin, right: thin };
  const hs = { font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: 'D9EAD3' } }, alignment: { wrapText: true, vertical: 'center', horizontal: 'center' }, border: bd };
  const bold = { font: { bold: true } }, catS = { font: { bold: true }, fill: { fgColor: { rgb: 'FABF8F' } }, border: bd };
  const NUM = { border: bd, numFmt: '#,##0.##' };
  const sheet = () => { const ws = {}; return { ws, put(c, row, v, o = {}) { const addr = X.utils.encode_cell({ c, r: row - 1 }); if ((v == null || v === '') && !o.f) { if (o.s) ws[addr] = { t: 'z', s: o.s }; return; } ws[addr] = Object.assign({ v, t: typeof v === 'number' ? 'n' : 's' }, o); } }; };
  const finish = (ws, maxc, maxr, cols, extra) => { ws['!ref'] = X.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: maxc, r: maxr } }); ws['!cols'] = cols; Object.assign(ws, extra || {}); return ws; };
  const dd = r.date ? r.date.split('-').reverse().join(' / ') : '';
  const head = (S, mid) => {
    S.put(0, 1, 'MINISTERE DE LA SANTE', { s: bold }); S.put(10, 1, 'BURKINA FASO', { s: bold });
    S.put(0, 2, 'REGION DE ' + S0.region); S.put(10, 2, 'La Patrie ou la Mort, Nous Vaincrons!');
    S.put(0, 3, 'DIRECTION REGIONALE DE LA SANTE');
    S.put(0, 4, 'DISTRICT SANITAIRE DE:'); S.put(1, 4, S0.district, { s: bold }); S.put(10, 4, 'Nombre de jours du mois :'); S.put(13, 4, r.days, { s: bold });
    S.put(0, 5, 'CSPS DE :'); S.put(1, 5, r.csps, { s: bold });
    S.put(1, 6, 'ANNEE'); S.put(2, 6, r.year, { s: bold }); S.put(4, 6, 'MOIS DE'); S.put(5, 6, MONTHS[r.month - 1], { s: bold }); S.put(10, 6, 'Date:'); S.put(11, 6, dd);
    S.put(0, 7, 'RAPPORT DE GESTION ET DE COMMANDE DES PRODUITS DE SANTE', { s: { font: { bold: true, sz: 13 } } });
  };
  const S0 = S.settings;
  const H = ['Désignation', 'Unité de comptage', 'Quantité disponible et utilisable en début de mois', 'Quantité reçue au cours du mois', 'Quantité consommée au cours du mois', 'Quantité périmée au cours du mois', 'Autres pertes au cours du mois', 'Ajustements (−) au cours du mois', 'Ajustements (+) au cours du mois', 'Quantité disponible et utilisable en fin de mois', 'Nbre de jours de rupture au cours du mois', 'Quantité consommée ajustée du mois', 'Quantité à commander', 'Prix unitaire en CSPS', 'Prix DRD', 'Total vente du mois au prix DRD', 'Total vente du mois aux prix public (DMEG)', 'Valeur stock au début du mois aux prix public (DMEG)', 'Valeur des MEG commandée aux prix public (DMEG)', 'Valeur stock à la fin du mois aux prix public (DMEG)', 'Valeur stock périmé / cassé aux prix public (DMEG)', 'Traceur (1 = oui)'];
  const LET = ['', '', 'A', 'B', 'C', 'D', 'E', 'F-', 'F+', 'G', 'H', 'I', 'J'];
  const COLS = 'ABCDEFGHIJKLMNOPQRSTUV';

  /* ===== feuille SIGL ===== */
  const G = sheet(), g = G.ws; head(G, true);
  H.forEach((h, c) => { G.put(c, 8, h, { s: hs }); G.put(c, 12, h, { s: hs }); });
  LET.forEach((l, c) => G.put(c, 10, l, { s: hs }));
  G.put(0, 11, 'INVENTAIRE DES MEDICAMENTS ET CONSOMMABLES', { s: bold });
  const frFill = { fgColor: { rgb: 'FABF8F' } };
  r.items.forEach(it => {
    const row = P.rowOf[it.id], v = r.v[it.id] || {}, c = calc(it, v, r.days);
    G.put(0, row, it.name, { s: Object.assign({ border: bd }, it.free ? { fill: frFill } : {}) }); G.put(1, row, it.unit, { s: { border: bd } });
    [['deb', 2], ['rec', 3], ['per', 5], ['aut', 6], ['ajm', 7], ['ajp', 8], ['fin', 9], ['rup', 10]].forEach(([k, col]) => G.put(col, row, v[k] != null ? v[k] : '', { s: NUM }));
    const F = (col, f, val) => G.put(col, row, val, { f, s: NUM });
    F(4, `C${row}+D${row}+I${row}-F${row}-G${row}-H${row}-J${row}`, c.cons);
    F(11, `IF($N$4-K${row}>0,E${row}/($N$4-K${row})*$N$4,E${row})`, c.adj);
    F(12, `IF(L${row}*2-J${row}>=0,L${row}*2-J${row},0)`, c.cmd);
    G.put(13, row, N(it.pu), { s: NUM }); G.put(14, row, N(it.drd), { s: NUM });
    F(15, `E${row}*O${row}`, c.P); F(16, `E${row}*N${row}`, c.Q); F(17, `C${row}*N${row}`, c.R); F(18, `D${row}*N${row}`, c.S); F(19, `J${row}*N${row}`, c.T); F(20, `(F${row}+G${row})*N${row}`, c.U);
    if (it.tr) G.put(21, row, 1, { s: { border: bd } });
  });
  G.put(0, tot, 'TOTAL', { s: bold });
  [['D', 3, t.rec], ['P', 15, t.P], ['Q', 16, t.Q], ['R', 17, t.R], ['S', 18, t.S], ['T', 19, t.T], ['U', 20, t.U]].forEach(([L, c, val]) => G.put(c, tot, val, { f: `SUM(${L}${first}:${L}${last})`, s: { font: { bold: true }, numFmt: '#,##0' } }));
  let row = tot + 1;
  const line = (label, val, f) => { G.put(0, row, label); if (val !== undefined) G.put(2, row, val, { f, s: { numFmt: '#,##0.###' } }); return row++; };
  const hasTr = t.nTr > 0, V = `V${first}:V${last}`, K = `K${first}:K${last}`, Rf = {}, fn = r.fin;
  line('Taux de rupture des médicaments traceurs DMEG (100 x nbre de traceurs en rupture / nbre de traceurs)', hasTr ? t.tauxRup : '', `IF(SUM(${V})=0,"",100*COUNTIFS(${V},1,${K},">0")/SUM(${V}))`);
  line('Durée moyenne de rupture des médicaments traceurs DMEG (somme des jours de rupture / nbre de traceurs)', hasTr ? t.durRup : '', `IF(SUM(${V})=0,"",SUMIF(${V},1,${K})/SUM(${V}))`);
  [['grat', 'MEG sorties pour la gratuité des soins et la PF'], ['ramu', 'MEG sorties pour le RAMU'], ['fonct', 'MEG sortie pour le fonctionnement du CSPS'], ['caisse', 'Caisse du gérant non encore versé au trésorier'], ['verse', 'Versement effectués au trésorier par le gérant']].forEach(([k, l]) => { Rf[k] = line(l, N(fn[k])); });
  Rf.marge = line('Marge théorique du mois', t.marge, `(Q${tot}-P${tot})-U${tot}`);
  Rf.retro = row; line('Rétrocession maximum sur les recettes en liquidité du mois', t.retro, `(C${Rf.caisse}+C${Rf.verse})*G${Rf.retro}/100`); G.put(6, Rf.retro, N(fn.rate), { s: { numFmt: '0.##' } }); G.put(7, Rf.retro, '← taux de rétrocession (%)');
  Rf.car = line("Chiffre d'affaire réel (CAR)", t.car, `C${Rf.grat}+C${Rf.ramu}+C${Rf.fonct}+C${Rf.caisse}+C${Rf.verse}`);
  Rf.cat = line("Chiffre d'affaire théorique (CAT)", t.cat, `Q${tot}`);
  line('CAR-CAT', t.ecart, `C${Rf.car}-C${Rf.cat}`);
  const rr = line('CAR / CAT', t.ratio == null ? '' : t.ratio, `IFERROR(C${Rf.car}/C${Rf.cat},"")`); G.put(6, rr, '0,98 < N < 1,02');
  row++; G.put(1, row, 'Nom et Prénom', { s: bold }); G.put(3, row, 'Fonction', { s: bold }); G.put(4, row, 'N° Téléphone', { s: bold }); row++;
  [['Préparé par', 'prep'], ['Approuvé par', 'appr'], ['Reçu au District par', 'recu']].forEach(([l, k]) => { G.put(0, row, l, { s: bold }); G.put(1, row, r.sign[k].nom); G.put(3, row, r.sign[k].fonc); G.put(4, row, r.sign[k].tel); row++; });
  finish(g, 21, row, [{ wch: 52 }, { wch: 14 }, ...Array(19).fill({ wch: 14 }), { wch: 9 }], { '!rows': (() => { const a = []; a[7] = { hpt: 78 }; a[11] = { hpt: 78 }; return a; })() });

  /* ===== feuille SYNTHESE (regroupement par programme) ===== */
  const Y = sheet(), y = Y.ws; head(Y, true);
  H.slice(0, 13).forEach((h, c) => Y.put(c, 8, h, { s: hs })); LET.forEach((l, c) => Y.put(c, 10, l, { s: hs }));
  const merges = []; let maxY = 11;
  (window.MAPS ? window.MAPS.syn : []).forEach(e => {
    maxY = Math.max(maxY, e.r);
    if (e.label) { for (let c = 0; c < 13; c++) Y.put(c, e.r, c ? '' : e.label, { s: catS }); return; }
    Y.put(0, e.r, e.a, { s: { border: bd } }); Y.put(1, e.r, e.u || '', { s: { border: bd } });
    'CDEFGHIJKLM'.split('').forEach((col, i) => Y.put(2 + i, e.r, E.syn(e.r, col), { f: e.t.map((tt, j) => E.refText(tt, e.g[j], col, true)).join('+') || '0', s: NUM }));
  });
  finish(y, 12, maxY + 1, [{ wch: 52 }, { wch: 14 }, ...Array(11).fill({ wch: 14 })], { '!rows': (() => { const a = []; a[7] = { hpt: 78 }; return a; })() });

  /* ===== feuille RMA ===== */
  const R = sheet(), rs = R.ws, rm = []; let maxR = 6;
  R.put(0, 1, 'MINISTERE DE LA SANTE', { s: bold }); R.put(6, 1, 'BURKINA FASO', { s: bold });
  R.put(0, 2, 'REGION DE ' + S0.region); R.put(6, 2, 'La Patrie ou la Mort, Nous Vaincrons!');
  R.put(0, 3, 'DISTRICT SANITAIRE DE ' + S0.district); R.put(0, 4, 'FORMATION SANITAIRE DE ' + r.csps); R.put(5, 4, `MOIS DE ${MONTHS[r.month - 1]} ${r.year}`, { s: bold });
  ['Désignation', 'Unité', 'Qtité dispo en début', 'Quantité reçue', 'Quantité consommée', 'Quantité périmée', 'Autres pertes', 'Ajustement (F-)', 'Ajustement (F+)', 'Qtité disponible et utilisable', 'Jours de rupture', 'Quantité à commander'].forEach((h, c) => R.put(c, 5, h, { s: hs }));
  ['', '', 'A', 'B', 'C', 'D', 'E', 'F-', 'F+', 'G', 'H', 'I'].forEach((l, c) => R.put(c, 6, l, { s: hs }));
  (window.MAPS ? window.MAPS.rma : []).forEach(e => {
    maxR = Math.max(maxR, e.r);
    if (e.label) { for (let c = 0; c < 12; c++) R.put(c, e.r, c ? '' : e.label, { s: catS }); rm.push({ s: { r: e.r - 1, c: 0 }, e: { r: e.r - 1, c: 11 } }); return; }
    R.put(0, e.r, e.a, { s: { border: bd } }); R.put(1, e.r, e.u || '', { s: { border: bd } });
    'CDEFGHIJKL'.split('').forEach((col, i) => { const sc = col === 'L' ? 'M' : col; if (e.t.length) R.put(2 + i, e.r, E.rma(e.r, col), { f: e.t.map(tt => E.refText(tt, 'S', sc, false)).join('+'), s: NUM }); else R.put(2 + i, e.r, '', { s: NUM }); });
  });
  let rr2 = maxR + 2; R.put(1, rr2, 'Nom et Prénom', { s: bold }); R.put(3, rr2, 'Fonction', { s: bold }); R.put(4, rr2, 'N° Téléphone', { s: bold }); rr2++;
  [['Préparé par', 'prep'], ['Approuvé par', 'appr'], ['Reçu au District par', 'recu']].forEach(([l, k]) => { R.put(0, rr2, l, { s: bold }); R.put(1, rr2, r.sign[k].nom); R.put(3, rr2, r.sign[k].fonc); R.put(4, rr2, r.sign[k].tel); rr2++; });
  finish(rs, 11, rr2, [{ wch: 58 }, { wch: 16 }, ...Array(10).fill({ wch: 13 })], { '!merges': rm, '!rows': (() => { const a = []; a[4] = { hpt: 48 }; return a; })() });

  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, g, 'SIGL'); X.utils.book_append_sheet(wb, y, 'SYNTHESE'); X.utils.book_append_sheet(wb, rs, 'RMA');
  const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
  saveFile(`SIGL_${safe(r.csps)}_${r.year}-${pad2(r.month)}.xlsx`, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

/* ---------- export PDF : SIGL + bilan + RMA ---------- */
const pt = s => String(s == null ? '' : s).replace(/μ/g, 'µ').replace(/−/g, '-').replace(/[  ]/g, ' ').replace(/←/g, '<-').replace(/[^\u0000-ÿ‘’“”–—…€Œœ]/g, '');
const pf = (n, d = 1) => (n == null || !isFinite(n)) ? '' : pt(fmt(n, d));
function exportPdf(r, onlyFilled, parts, tag) {
  const { jsPDF } = window.jspdf, doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const E = engine(r), t = totals(r), G = [15, 118, 110], title = `${r.csps} - ${MONTHS[r.month - 1]} ${r.year}`;
  const sg = S.settings, right = { halign: 'right' }, has = k => parts.includes(k);
  let firstPage = true;
  const newPage = label => {
    if (!firstPage) doc.addPage(); firstPage = false;
    doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('MINISTERE DE LA SANTE', 10, 10); doc.text('BURKINA FASO', 287, 10, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.text(pt('REGION DE ' + sg.region), 10, 14.5); doc.text('La Patrie ou la Mort, Nous Vaincrons!', 287, 14.5, { align: 'right' });
    doc.text('DIRECTION REGIONALE DE LA SANTE', 10, 19);
    doc.text(pt(`DISTRICT SANITAIRE DE : ${sg.district}      CSPS DE : ${r.csps}`), 10, 24);
    doc.text(pt(`MOIS DE ${MONTHS[r.month - 1]} ${r.year}      Nombre de jours : ${r.days}      Date : ${r.date ? r.date.split('-').reverse().join('/') : ''}`), 10, 28.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(pt(label), 148.5, 34, { align: 'center' });
  };
  const common = { theme: 'grid', styles: { font: 'helvetica', fontSize: 6.8, cellPadding: 1, lineColor: [150, 150, 150], lineWidth: 0.1, overflow: 'linebreak' }, headStyles: { fillColor: G, textColor: 255, halign: 'center', valign: 'middle', fontSize: 6.5 }, margin: { left: 10, right: 10, top: 14, bottom: 10 } };
  const sign = y => doc.autoTable({ ...common, startY: y, head: [['', 'Nom et prénom', 'Fonction', 'N° de téléphone', 'Date', 'Signature']], body: [['Préparé par', r.sign.prep.nom, r.sign.prep.fonc, r.sign.prep.tel, '', ''], ['Approuvé par', r.sign.appr.nom, r.sign.appr.fonc, r.sign.appr.tel, '', ''], ['Reçu au District par', r.sign.recu.nom, r.sign.recu.fonc, r.sign.recu.tel, '', '']].map(a => a.map(pt)), styles: { ...common.styles, fontSize: 8.5, minCellHeight: 11, valign: 'middle' }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 38 }, 5: { cellWidth: 50 } } });
  const catRow = (label, n) => [{ content: pt(label), colSpan: n, styles: { fontStyle: 'bold', fillColor: [255, 236, 214], halign: 'left' } }];
  // tableau de regroupement (SYNTHESE / RMA) : lignes de catégories + produits, avec filtre "renseignés"
  const grouped = (entries, valFn, cols, widths, head) => {
    const cl = 'CDEFGHIJKLM'.slice(0, cols), rows = []; let pend = null;
    entries.forEach(e => {
      if (e.label) { pend = catRow(e.label, cols + 2); if (!onlyFilled) { rows.push(pend); pend = null; } return; }
      const hasT = e.t && e.t.length, vals = cl.split('').map(c => hasT ? valFn(e.r, c) : null);
      if (onlyFilled && !vals.some(v => v)) return;
      if (pend) { rows.push(pend); pend = null; }
      rows.push([pt(e.a), pt(e.u || ''), ...vals.map(v => v == null ? '' : pf(v, 2))]);
    });
    doc.autoTable({ ...common, startY: 37, head: [head.map(pt)], body: rows, columnStyles: { 0: { cellWidth: widths[0] }, 1: { cellWidth: widths[1] }, ...Object.fromEntries(Array.from({ length: cols }, (_, i) => [i + 2, { ...right, cellWidth: widths[2] }])) } });
    if (!rows.length) { doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text('Aucun produit renseigné.', 10, 48); }
    sign((rows.length ? doc.lastAutoTable.finalY : 48) + 8);
  };

  // 1) SIGL
  if (has('sigl')) {
    newPage('RAPPORT DE GESTION ET DE COMMANDE DES PRODUITS DE SANTE (SIGL)');
    const items = r.items.filter(it => !onlyFilled || (r.v[it.id] && Object.keys(r.v[it.id]).length));
    const body = items.map(it => {
      const v = r.v[it.id], c = calc(it, v, r.days), hv = !!v && Object.keys(v).length > 0, g = k => v && v[k] != null ? pf(v[k], 2) : '';
      return [it.name, it.unit, g('deb'), g('rec'), hv ? pf(c.cons, 2) : '', g('per'), g('aut'), g('ajm'), g('ajp'), g('fin'), g('rup'), hv ? pf(c.adj, 1) : '', hv ? pf(c.cmd, 1) : '', it.pu ? pf(it.pu, 2) : '', hv && it.pu ? pf(c.Q, 0) : ''].map(pt).concat([it.free, hv && c.cons < 0]);
    });
    doc.autoTable({
      ...common, startY: 37,
      head: [['Désignation', 'Unité', 'Début (A)', 'Reçu (B)', 'Consommé (C)', 'Périmé (D)', 'Autres pertes (E)', 'Ajust. - (F-)', 'Ajust. + (F+)', 'Stock fin (G)', 'Jours rupture (H)', 'Conso. ajustée (I)', 'À commander (J)', 'Prix unit. CSPS', 'Vente prix public'].map(pt)],
      body: body.map(b => b.slice(0, 15)),
      columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 18 }, ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 2, { ...right, cellWidth: 14.1 }])) },
      didParseCell: d => { if (d.section === 'body') { const f = body[d.row.index]; if (f[15] && d.column.index === 0) d.cell.styles.fillColor = [255, 236, 214]; if (f[16] && d.column.index === 4) d.cell.styles.textColor = [185, 28, 28]; } }
    });
    if (!body.length) { doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text('Aucun produit renseigné.', 10, 48); }
  }

  // 2) Bilan
  if (has('bilan')) {
    newPage('BILAN DU MOIS'); const fin = r.fin, ok = t.ratio != null && t.ratio >= 0.98 && t.ratio <= 1.02;
    const two = (rows, y, x, w) => doc.autoTable({ ...common, startY: y, showHead: false, body: rows.map(a => a.map(pt)), tableWidth: w, margin: { left: x, right: 297 - x - w, top: 14, bottom: 10 }, columnStyles: { 0: { cellWidth: w - 34 }, 1: { halign: 'right', fontStyle: 'bold', cellWidth: 34 } }, styles: { ...common.styles, fontSize: 8.2, cellPadding: 1.5 } });
    two([['Valeur du stock au début du mois (prix public)', pf(t.R, 0) + ' F'], ['Valeur des MEG reçues (prix public)', pf(t.S, 0) + ' F'], ['Total vente du mois au prix public (DMEG)', pf(t.Q, 0) + ' F'], ['Total vente du mois au prix DRD', pf(t.P, 0) + ' F'], ['Valeur du stock en fin de mois (prix public)', pf(t.T, 0) + ' F'], ['Valeur du stock périmé / cassé (prix public)', pf(t.U, 0) + ' F']], 40, 10, 136);
    const yL = doc.lastAutoTable.finalY;
    two([['Taux de rupture des traceurs DMEG', t.tauxRup == null ? '-' : pf(t.tauxRup, 1) + ' %'], ['Durée moyenne de rupture des traceurs (jours)', t.durRup == null ? '-' : pf(t.durRup, 1)], ['Marge théorique du mois', pf(t.marge, 0) + ' F'], [`Rétrocession maximum sur recettes en liquidité (${pf(N(fin.rate), 2)} %)`, pf(t.retro, 0) + ' F']], yL + 5, 10, 136);
    const yL2 = doc.lastAutoTable.finalY;
    two([['MEG sorties pour la gratuité des soins et la PF', pf(N(fin.grat), 0) + ' F'], ['MEG sorties pour le RAMU', pf(N(fin.ramu), 0) + ' F'], ['MEG sorties pour le fonctionnement du CSPS', pf(N(fin.fonct), 0) + ' F'], ['Caisse du gérant non encore versé au trésorier', pf(N(fin.caisse), 0) + ' F'], ['Versements effectués au trésorier par le gérant', pf(N(fin.verse), 0) + ' F']], 40, 151, 136);
    two([["Chiffre d'affaires réel (CAR)", pf(t.car, 0) + ' F'], ["Chiffre d'affaires théorique (CAT)", pf(t.cat, 0) + ' F'], ['CAR - CAT', pf(t.ecart, 0) + ' F'], ['CAR / CAT (norme 0,98 - 1,02)', t.ratio == null ? '-' : pf(t.ratio, 3) + (ok ? '  (conforme)' : '  (hors norme)')]], doc.lastAutoTable.finalY + 5, 151, 136);
    sign(Math.max(yL2, doc.lastAutoTable.finalY) + 10);
  }

  // 3) SYNTHESE
  if (has('syn')) {
    newPage('SYNTHESE PAR PROGRAMME - RAPPORT DE GESTION ET DE COMMANDE DES PRODUITS DE SANTE');
    grouped(window.MAPS ? window.MAPS.syn : [], (n, c) => E.syn(n, c), 11, [70, 18, 17.1],
      ['Désignation', 'Unité', 'Début (A)', 'Reçu (B)', 'Consommé (C)', 'Périmé (D)', 'Autres pertes (E)', 'Ajust. - (F-)', 'Ajust. + (F+)', 'Stock fin (G)', 'Jours rupture (H)', 'Conso. ajustée (I)', 'À commander (J)']);
  }

  // 4) RMA
  if (has('rma')) {
    newPage(`RMA - RAPPORT MENSUEL D'ACTIVITES DES MEG - FORMATION SANITAIRE : ${r.csps}`);
    grouped(window.MAPS ? window.MAPS.rma : [], (n, c) => E.rma(n, c), 10, [82, 24, 17.1],
      ['Désignation', 'Unité', 'Qtité dispo en début (A)', 'Quantité reçue (B)', 'Quantité consommée (C)', 'Quantité périmée (D)', 'Autres pertes (E)', 'Ajust. - (F-)', 'Ajust. + (F+)', 'Qtité disponible (G)', 'Jours de rupture (H)', 'Quantité à commander (I)']);
  }

  const nP = doc.getNumberOfPages();
  for (let i = 1; i <= nP; i++) { doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(110); doc.text(pt(`SIGL Saisie MEG - ${title}`), 10, 205); doc.text(`Page ${i} / ${nP}`, 287, 205, { align: 'right' }); }
  saveFile(`${tag}_${safe(r.csps)}_${r.year}-${pad2(r.month)}.pdf`, doc.output('blob'));
}

/* ---------- aperçu avant export ---------- */
function previewHTML(r, onlyFilled) {
  const E = engine(r), t = totals(r), fin = r.fin, ok = t.ratio != null && t.ratio >= 0.98 && t.ratio <= 1.02;
  const f = (n, d = 1) => (n == null || !isFinite(n)) ? '' : fmt(n, d), th = a => '<tr>' + a.map(x => `<th>${esc(x)}</th>`).join('') + '</tr>';
  const sign = `<table class="pv sg"><tr><th></th><th>Nom et prénom</th><th>Fonction</th><th>Téléphone</th></tr>${[['Préparé par', r.sign.prep], ['Approuvé par', r.sign.appr], ['Reçu au District par', r.sign.recu]].map(([l, o]) => `<tr><td><b>${l}</b></td><td>${esc(o.nom)}</td><td>${esc(o.fonc)}</td><td>${esc(o.tel)}</td></tr>`).join('')}</table>`;
  const none = '<p class="mut">Aucun produit renseigné.</p>';
  // SIGL
  const items = r.items.filter(it => !onlyFilled || (r.v[it.id] && Object.keys(r.v[it.id]).length));
  const sigl = items.length ? `<table class="pv"><thead>${th(['Désignation', 'Unité', 'Début (A)', 'Reçu (B)', 'Consommé (C)', 'Périmé (D)', 'Autres pertes (E)', 'Ajust. − (F-)', 'Ajust. + (F+)', 'Stock fin (G)', 'Jours rupture (H)', 'Conso. ajustée (I)', 'À commander (J)', 'Prix unit. CSPS', 'Vente prix public'])}</thead><tbody>${items.map(it => {
    const v = r.v[it.id], c = calc(it, v, r.days), hv = !!v && Object.keys(v).length > 0, g = k => v && v[k] != null ? f(v[k], 2) : '';
    return `<tr class="${it.free ? 'fr' : ''}"><td>${esc(it.name)}</td><td>${esc(it.unit)}</td><td>${g('deb')}</td><td>${g('rec')}</td><td class="${hv && c.cons < 0 ? 'neg' : ''}">${hv ? f(c.cons, 2) : ''}</td><td>${g('per')}</td><td>${g('aut')}</td><td>${g('ajm')}</td><td>${g('ajp')}</td><td class="fi">${g('fin')}</td><td>${g('rup')}</td><td>${hv ? f(c.adj, 1) : ''}</td><td>${hv ? f(c.cmd, 1) : ''}</td><td>${it.pu ? f(it.pu, 2) : ''}</td><td>${hv && it.pu ? f(c.Q, 0) : ''}</td></tr>`;
  }).join('')}</tbody></table>` : none;
  // Bilan
  const two = rows => `<table class="pv bil">${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td><b>${esc(b)}</b></td></tr>`).join('')}</table>`;
  const bilan = `<div class="pv2">${two([['Valeur du stock au début du mois (prix public)', money(t.R)], ['Valeur des MEG reçues (prix public)', money(t.S)], ['Total vente du mois au prix public (DMEG)', money(t.Q)], ['Total vente du mois au prix DRD', money(t.P)], ['Valeur du stock en fin de mois (prix public)', money(t.T)], ['Valeur du stock périmé / cassé (prix public)', money(t.U)]])}${two([['Taux de rupture des traceurs DMEG', t.tauxRup == null ? '-' : f(t.tauxRup, 1) + ' %'], ['Durée moyenne de rupture des traceurs (jours)', t.durRup == null ? '-' : f(t.durRup, 1)], ['Marge théorique du mois', money(t.marge)], [`Rétrocession maximum (${f(N(fin.rate), 2)} %)`, money(t.retro)]])}${two([['MEG sorties pour la gratuité et la PF', money(N(fin.grat))], ['MEG sorties pour le RAMU', money(N(fin.ramu))], ['MEG sorties pour le fonctionnement', money(N(fin.fonct))], ['Caisse du gérant non versée', money(N(fin.caisse))], ['Versements au trésorier', money(N(fin.verse))]])}${two([["Chiffre d'affaires réel (CAR)", money(t.car)], ["Chiffre d'affaires théorique (CAT)", money(t.cat)], ['CAR − CAT', money(t.ecart)], ['CAR / CAT (norme 0,98 – 1,02)', t.ratio == null ? '-' : f(t.ratio, 3) + (ok ? ' (conforme)' : ' (hors norme)')]])}</div>`;
  // SYNTHESE / RMA
  const group = (entries, fn, cols, head) => {
    const cl = 'CDEFGHIJKLM'.slice(0, cols), rows = []; let pend = null;
    entries.forEach(e => {
      if (e.label) { pend = `<tr class="cat"><td colspan="${cols + 2}">${esc(e.label)}</td></tr>`; if (!onlyFilled) { rows.push(pend); pend = null; } return; }
      const hasT = e.t && e.t.length, vals = cl.split('').map(c => hasT ? fn(e.r, c) : null);
      if (onlyFilled && !vals.some(v => v)) return;
      if (pend) { rows.push(pend); pend = null; }
      rows.push(`<tr><td>${esc(e.a)}</td><td>${esc(e.u || '')}</td>${vals.map(v => `<td>${v == null ? '' : f(v, 2)}</td>`).join('')}</tr>`);
    });
    return rows.length ? `<table class="pv"><thead>${th(head)}</thead><tbody>${rows.join('')}</tbody></table>` : none;
  };
  const syn = group(window.MAPS ? window.MAPS.syn : [], (n, c) => E.syn(n, c), 11, ['Désignation', 'Unité', 'Début (A)', 'Reçu (B)', 'Consommé (C)', 'Périmé (D)', 'Autres pertes (E)', 'Ajust. − (F-)', 'Ajust. + (F+)', 'Stock fin (G)', 'Jours rupture (H)', 'Conso. ajustée (I)', 'À commander (J)']);
  const rma = group(window.MAPS ? window.MAPS.rma : [], (n, c) => E.rma(n, c), 10, ['Désignation', 'Unité', 'Dispo début (A)', 'Reçue (B)', 'Consommée (C)', 'Périmée (D)', 'Autres pertes (E)', 'Ajust. − (F-)', 'Ajust. + (F+)', 'Disponible (G)', 'Jours rupture (H)', 'À commander (I)']);
  return { sigl: sigl + sign, bilan: bilan + sign, syn: syn + sign, rma: rma + sign };
}
function dlgPreview(part) {
  const d = $('#dlg3'), r = S.rep, only = S.pdfFilled !== false, H = previewHTML(r, only);
  const TABS = [['sigl', 'SIGL'], ['bilan', 'Bilan'], ['syn', 'SYNTHESE'], ['rma', 'RMA']]; part = part || 'sigl';
  d.className = 'huge';
  d.innerHTML = `<div class="dh">Aperçu avant export · ${esc(r.csps)} · ${MONTHS[r.month - 1]} ${r.year}</div>
    <div class="pvtabs">${TABS.map(([k, l]) => `<button class="chip ${k === part ? 'on' : ''}" data-pv="${k}">${l}</button>`).join('')}<label class="chk pvchk"><input type="checkbox" id="pv-f" ${only ? 'checked' : ''}> seulement les lignes renseignées</label></div>
    <div class="db pvbody">${H[part]}</div>
    <div class="df"><button class="btn sec" data-x>Retour</button><button class="btn sec" data-pdf>📕 PDF de cet onglet</button><button class="btn" data-xl>📗 Excel</button></div>`;
  d.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => dlgPreview(b.dataset.pv));
  d.querySelector('#pv-f').onchange = e => { S.pdfFilled = e.target.checked; dlgPreview(part); };
  d.querySelector('[data-x]').onclick = () => { d.close(); dlgExport(); };
  d.querySelector('[data-xl]').onclick = () => { d.close(); try { exportXlsx(r); } catch (e) { alert("Erreur pendant l'export : " + (e && e.message || e)); } };
  d.querySelector('[data-pdf]').onclick = () => { const tag = { sigl: 'SIGL', bilan: 'BILAN', syn: 'SYNTHESE', rma: 'RMA' }[part]; d.close(); try { exportPdf(r, S.pdfFilled !== false, [part], tag); } catch (e) { alert("Erreur pendant l'export : " + (e && e.message || e)); } };
  d.onclose = null; if (!d.open) d.showModal();
}

function dlgExport() {
  const d = $('#dlg');
  d.innerHTML = `<div class="dh">Exporter le rapport</div><div class="db"><div class="fm">
    <button class="btn sec" data-pre style="border-width:2px">👁 Aperçu avant export</button>
    <button class="btn" data-ex="xlsx">📗 Excel — 3 feuilles : SIGL, SYNTHESE, RMA</button>
    <div class="mut" style="font-weight:700;margin-top:4px">PDF (A4 paysage)</div>
    <button class="btn sec" data-ex="pdf:sigl,bilan:SIGL">📕 SIGL + bilan</button>
    <button class="btn sec" data-ex="pdf:syn:SYNTHESE">📕 SYNTHESE</button>
    <button class="btn sec" data-ex="pdf:rma:RMA">📕 RMA</button>
    <button class="btn sec" data-ex="pdf:sigl,bilan,syn,rma:COMPLET">📕 Tout en un seul PDF</button>
    <label class="chk"><input type="checkbox" id="ex-filled" ${S.pdfFilled === false ? '' : 'checked'}> PDF : seulement les lignes renseignées</label>
    <p class="mut" style="margin:0">Excel : les formules sont conservées, les trois feuilles sont liées comme dans votre classeur.</p></div></div>
    <div class="df"><button class="btn sec" data-x>Fermer</button></div>`;
  d.querySelector('[data-x]').onclick = () => d.close();
  d.querySelector('[data-pre]').onclick = () => { S.pdfFilled = $('#ex-filled').checked; d.close(); dlgPreview(); };
  d.querySelectorAll('[data-ex]').forEach(b => b.onclick = async () => {
    S.pdfFilled = $('#ex-filled').checked; const [k, parts, tag] = b.dataset.ex.split(':'); d.close(); await saveNow();
    try { k === 'xlsx' ? exportXlsx(S.rep) : exportPdf(S.rep, S.pdfFilled, parts.split(','), tag); } catch (e) { console.error(e); alert("Erreur pendant l'export : " + (e && e.message || e)); }
  });
  d.showModal();
}

async function importFile(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'sigl-meg') throw new Error('format');
    let n = 0, lock = isLocked();
    if (d.catalog && d.full && lock && !(await askPw('Mot de passe requis pour remplacer le catalogue et les prix'))) { d.full = false; }
    lock = isLocked();
    for (const r of d.reports || []) {
      if (lock) (r.items || []).forEach(it => { const l = S.catalog.find(x => x.id === it.id); if (l) { it.pu = l.pu; it.drd = l.drd; } });
      const cur = S.reports.find(x => x.id === r.id);
      if (!cur || (r.updated || 0) > (cur.updated || 0)) { await DB.set('report:' + r.id, r); n++; }
    }
    if (d.catalog && d.full && confirm('Remplacer aussi le catalogue des produits et les prix par ceux du fichier ?')) { S.catalog = d.catalog; await saveCatalog(); }
    S.reports = await DB.reports(); toast(`${n} rapport(s) importé(s)`); route();
  } catch (e) { alert("Fichier non reconnu. Choisissez un fichier de sauvegarde « .json » créé par cette application."); }
}
function pickFile() { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json'; i.onchange = () => i.files[0] && importFile(i.files[0]); i.click(); }

/* ---------- actions (clics) ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act],[data-open],[data-tab],[data-filter],[data-edit],[data-cedit],[data-rcp]'); if (!el) return;
  const d = el.dataset;
  if (d.open) return go('/r/' + encodeURIComponent(d.open));
  if (d.tab) { S.tab = d.tab; return renderTab(); }
  if (d.filter) { S.filter = d.filter; return paneProducts(); }
  if (d.rcp) { e.preventDefault(); return dlgRecProd(d.rcp); }
  if (d.edit) return dlgProduct(d.edit, true);
  if (d.cedit) return dlgProduct(d.cedit);
  switch (d.act) {
    case 'back': return history.length > 1 ? history.back() : go('/');
    case 'new': return dlgNew();
    case 'import': return pickFile();
    case 'pwset': return dlgSetPw();
    case 'pwchange': if (await needUnlock('Mot de passe actuel')) dlgSetPw(); return;
    case 'pwremove': if (await askPw('Mot de passe actuel') && confirm('Retirer le mot de passe ? Les prix pourront de nouveau être modifiés par tous.')) { delete S.settings.pw; await saveSettings(); viewSettings(); } return;
    case 'pwlock': S.unlockedUntil = 0; return viewSettings();
    case 'catalog': return go('/catalogue');
    case 'settings': return go('/reglages');
    case 'addprod': return dlgProduct();
    case 'more': S.shown += PAGE; { const y = scrollY; renderList(false); scrollTo(0, y); } return;
    case 'recs': return dlgRecs();
    case 'bilanreset': if (confirm('Vider tous les champs du bilan (caisse, sorties, versements) de ce rapport ?')) { Object.assign(S.rep.fin, { grat: null, ramu: null, fonct: null, caisse: null, verse: null, rate: S.settings.rate }); await saveNow(); paneBilan(); toast('Bilan remis à vide'); } return;
    case 'export': await saveNow(); return dlgExport();
    case 'json': await saveNow(); return saveFile(`SAUVEGARDE_${safe(S.rep.csps)}_${S.rep.year}-${pad2(S.rep.month)}.json`, JSON.stringify({ app: 'sigl-meg', version: 1, reports: [S.rep] }), 'application/json');
    case 'backup': { const reports = await DB.reports(); return saveFile(`SAUVEGARDE_SIGL_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'sigl-meg', version: 1, full: true, catalog: S.catalog, settings: S.settings, reports }), 'application/json'); }
    case 'carry': {
      const r = S.rep, pm = r.month === 1 ? { y: r.year - 1, m: 12 } : { y: r.year, m: r.month - 1 };
      const b = S.reports.find(x => x.csps.toUpperCase() === r.csps.toUpperCase() && x.year === pm.y && x.month === pm.m);
      if (!b) return dlgInfo(`<div class="dh">Rapport introuvable</div><div class="db">Aucun rapport de ${MONTHS[pm.m - 1]} ${pm.y} n'existe pour ${esc(r.csps)}.</div>`);
      const n = carryOver(r, b); await saveNow(); return toast(`${n} stock(s) de début de mois repris`);
    }
    case 'prices': {
      const r = S.rep; let n = 0;
      for (const c of S.catalog) { const i = r.items.find(x => x.id === c.id); if (!i) { r.items.push({ ...c }); n++; } else if (i.pu !== c.pu || i.drd !== c.drd) { i.pu = c.pu; i.drd = c.drd; n++; } }
      await saveNow(); return toast(`${n} produit(s) mis à jour`);
    }
    case 'delrep':
      if (confirm(`Supprimer définitivement le rapport ${S.rep.csps} – ${MONTHS[S.rep.month - 1]} ${S.rep.year} ?`)) { const id = S.rep.id; clearTimeout(saveTimer); S.rep = null; await DB.del('report:' + id); S.reports = S.reports.filter(x => x.id !== id); go('/'); }
  }
});

/* ---------- démarrage ---------- */
(async function init() {
  try { await DB.open(); await loadAll(); } catch (e) { $('#app').innerHTML = '<div class="wrap"><div class="card"><b>Stockage indisponible.</b><br>Impossible d\'ouvrir la base locale de l\'application.</div></div>'; return; }
  window.addEventListener('pagehide', saveNow); document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => { });
  await route();
})();
