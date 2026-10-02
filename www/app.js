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
    sign: last ? JSON.parse(JSON.stringify(last.sign)) : { prep: { nom: '', fonc: 'GERANT', tel: '' }, appr: { nom: '', fonc: 'ICP', tel: '' }, recu: { nom: '', fonc: 'Pharmacien/PEP', tel: '' } },
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
    `<button class="ib" data-act="xlsx" title="Exporter en Excel">⬇ Excel</button>`) +
    `<div id="pane"></div>
    <nav class="tabs"><button data-tab="prod"><span>💊</span>Produits</button><button data-tab="bilan"><span>📊</span>Bilan</button><button data-tab="infos"><span>📝</span>Infos</button></nav>`;
  renderTab();
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
  const r = S.rep;
  $('#pane').innerHTML = `<div class="tools"><input type="search" id="q" placeholder="Rechercher un produit…" value="${esc(S.q)}" autocomplete="off">
    <div class="chips">${FILTERS.map(([k, l]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div></div>
    <div class="body"><div class="hdr"><div>Désignation</div>${FIELDS.map(f => `<div>${f[1]}<br>(${f[2]})</div>`).join('')}<div>Consommé<br>(C)</div><div>Conso. ajustée<br>(I)</div><div>À commander<br>(J)</div></div>
    <div id="list"></div><div id="foot"></div></div>`;
  renderList(true);
}
function rowHTML(it) {
  const r = S.rep, v = r.v[it.id] || {};
  return `<div class="row ${it.free ? 'free' : ''}" data-id="${it.id}">
    <div class="nm"><div class="n"><b>${esc(it.name)}</b><small>${esc(it.unit)}${it.pu ? ' · ' + fmt(it.pu, 2) + ' F' : ''}${it.tr ? ' · traceur' : ''}</small></div><button class="ed" data-edit="${it.id}" aria-label="Modifier le produit">✎</button></div>
    <div class="fields">${FIELDS.map(([k, l]) => `<label><span>${l}</span><input data-k="${k}" inputmode="decimal" autocomplete="off" value="${v[k] == null ? '' : String(v[k]).replace('.', ',')}"></label>`).join('')}</div>
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
  const inp = e.target.closest && e.target.closest('input[data-k]'); if (!inp) return;
  const all = [...document.querySelectorAll('#list input[data-k]')], i = all.indexOf(inp);
  let t = null;
  if (e.key === 'Enter') t = all[i + 1];
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const d = e.key === 'ArrowDown' ? 1 : -1; t = all[i + d * FIELDS.length]; }
  if (t) { e.preventDefault(); t.focus(); t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
});

/* ---------- onglet Bilan ---------- */
function paneBilan() {
  const f = S.rep.fin;
  const fi = (k, l) => `<label>${l}<input data-f="${k}" inputmode="decimal" value="${f[k] == null ? '' : String(f[k]).replace('.', ',')}" placeholder="0"></label>`;
  $('#pane').innerHTML = `<div class="wrap body"><div id="bres1"></div>
    <div class="card"><h2>Caisse et sorties (F CFA)</h2><div class="fm g2">
      ${fi('grat', 'MEG sorties pour la gratuité des soins et la PF')}${fi('ramu', 'MEG sorties pour le RAMU')}${fi('fonct', 'MEG sorties pour le fonctionnement du CSPS')}
      ${fi('caisse', 'Caisse du gérant non encore versé au trésorier')}${fi('verse', 'Versements effectués au trésorier par le gérant')}
      <label>Taux de rétrocession (%)<input data-f="rate" inputmode="decimal" value="${String(N(f.rate)).replace('.', ',')}"></label></div></div>
    <div id="bres2"></div></div>`;
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
      <button class="btn" data-act="xlsx">⬇ Exporter en Excel</button>
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
    <label>Prix unitaire en CSPS (F)<input id="p-pu" inputmode="decimal" value="${String(c.pu).replace('.', ',')}"></label>
    <label>Prix DRD (F)<input id="p-drd" inputmode="decimal" value="${String(c.drd).replace('.', ',')}"></label></div>
    <label class="chk"><input type="checkbox" id="p-free" ${c.free ? 'checked' : ''}> Produit gratuit / de programme (prix = 0)</label>
    <label class="chk"><input type="checkbox" id="p-tr" ${c.tr ? 'checked' : ''}> Médicament traceur DMEG</label>
    ${id ? '<button class="btn bad sm" id="p-del" style="justify-self:start">Retirer du catalogue</button>' : ''}</div></div>`,
    async () => {
      const name = $('#p-n').value.trim(); if (!name) { toast('Désignation obligatoire'); return false; }
      Object.assign(c, { name, unit: $('#p-u').value.trim(), pu: N(num($('#p-pu').value)), drd: N(num($('#p-drd').value)), free: $('#p-free').checked, tr: $('#p-tr').checked });
      if (!id) S.catalog.push(c);
      await saveCatalog();
      if (S.rep) { const i = S.rep.items.findIndex(x => x.id === c.id); if (i >= 0) S.rep.items[i] = { ...c }; else S.rep.items.push({ ...c }); scheduleSave(); }
      toast('Produit enregistré'); if (S.rep) { S.tab === 'prod' ? renderList() : renderTab(); } else drawCatalog();
    });
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
    <div class="card"><h2>Données</h2><p class="mut" style="margin-top:0">Les données restent sur cet appareil. Faites régulièrement une sauvegarde et transmettez-la au district (WhatsApp, e-mail, clé USB).</p>
      <div class="row-btns" style="margin:0"><button class="btn" data-act="backup">Sauvegarder tout (JSON)</button><button class="btn sec" data-act="import">Restaurer / importer</button><button class="btn sec" data-act="catalog">Catalogue des produits</button></div></div>
    <p class="mut" style="text-align:center">SIGL Saisie MEG · version 1.0 · fonctionne sans connexion</p></div>`;
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

function exportXlsx(r) {
  const X = XLSX, ws = {}, merges = [], t = totals(r), first = 10, n = r.items.length, last = first + n - 1, tot = last + 1;
  const A = (c, row) => X.utils.encode_cell({ c, r: row - 1 });
  const thin = { style: 'thin', color: { rgb: '999999' } }, bd = { top: thin, bottom: thin, left: thin, right: thin };
  const put = (c, row, v, o = {}) => { if (v == null || v === '') { if (!o.s && !o.f) return; v = ''; } ws[A(c, row)] = Object.assign({ v, t: typeof v === 'number' ? 'n' : 's' }, o); };
  const hs = { font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: 'D9EAD3' } }, alignment: { wrapText: true, vertical: 'center', horizontal: 'center' }, border: bd };
  const bold = { font: { bold: true } };
  put(0, 1, 'MINISTERE DE LA SANTE', { s: bold }); put(10, 1, 'BURKINA FASO', { s: bold });
  put(0, 2, 'REGION DE ' + S.settings.region); put(10, 2, 'La Patrie ou la Mort, Nous Vaincrons!');
  put(0, 3, 'DIRECTION REGIONALE DE LA SANTE');
  put(0, 4, 'DISTRICT SANITAIRE DE:'); put(1, 4, S.settings.district, { s: bold }); put(10, 4, 'Nombre de jours du mois :'); put(13, 4, r.days, { s: bold });
  put(0, 5, 'CSPS DE :'); put(1, 5, r.csps, { s: bold });
  put(1, 6, 'ANNEE'); put(2, 6, r.year, { s: bold }); put(4, 6, 'MOIS DE'); put(5, 6, MONTHS[r.month - 1], { s: bold });
  const dd = r.date ? r.date.split('-').reverse().join(' / ') : ''; put(10, 6, 'Date:'); put(11, 6, dd);
  put(0, 7, 'RAPPORT DE GESTION ET DE COMMANDE DES PRODUITS DE SANTE', { s: { font: { bold: true, sz: 13 } } });
  const H = ['Désignation', 'Unité de comptage', 'Quantité disponible et utilisable en début de mois', 'Quantité reçue au cours du mois', 'Quantité consommée au cours du mois', 'Quantité périmée au cours du mois', 'Autres pertes au cours du mois', 'Ajustements (−) au cours du mois', 'Ajustements (+) au cours du mois', 'Quantité disponible et utilisable en fin de mois', 'Nbre de jours de rupture au cours du mois', 'Quantité consommée ajustée du mois', 'Quantité à commander', 'Prix unitaire en CSPS', 'Prix DRD', 'Total vente du mois au prix DRD', 'Total vente du mois aux prix public (DMEG)', 'Valeur stock au début du mois aux prix public (DMEG)', 'Valeur des MEG commandée aux prix public (DMEG)', 'Valeur stock à la fin du mois aux prix public (DMEG)', 'Valeur stock périmé / cassé aux prix public (DMEG)', 'Traceur (1 = oui)'];
  H.forEach((h, c) => put(c, 8, h, { s: hs }));
  ['', '', 'A', 'B', 'C', 'D', 'E', 'F-', 'F+', 'G', 'H', 'I', 'J'].forEach((l, c) => put(c, 9, l, { s: hs }));
  const nf = { numFmt: '#,##0.##' }, fr = { fill: { fgColor: { rgb: 'FABF8F' } } };
  r.items.forEach((it, i) => {
    const row = first + i, v = r.v[it.id] || {}, c = calc(it, v, r.days);
    put(0, row, it.name, { s: Object.assign({ border: bd }, it.free ? { fill: fr.fill } : {}) }); put(1, row, it.unit, { s: { border: bd } });
    const inp = { s: { border: bd, numFmt: '#,##0.##' } };
    [['deb', 2], ['rec', 3], ['per', 5], ['aut', 6], ['ajm', 7], ['ajp', 8], ['fin', 9], ['rup', 10]].forEach(([k, col]) => { if (v[k] != null) put(col, row, v[k], inp); else put(col, row, '', { s: { border: bd } }); });
    const F = (col, f, val) => put(col, row, val, { f, s: { border: bd, numFmt: '#,##0.##' } });
    F(4, `C${row}+D${row}+I${row}-F${row}-G${row}-H${row}-J${row}`, c.cons);
    F(11, `IF($N$4-K${row}>0,E${row}/($N$4-K${row})*$N$4,E${row})`, c.adj);
    F(12, `IF(L${row}*2-J${row}>=0,L${row}*2-J${row},0)`, c.cmd);
    put(13, row, N(it.pu), { s: { border: bd, numFmt: '#,##0.##' } }); put(14, row, N(it.drd), { s: { border: bd, numFmt: '#,##0.##' } });
    F(15, `E${row}*O${row}`, c.P); F(16, `E${row}*N${row}`, c.Q); F(17, `C${row}*N${row}`, c.R); F(18, `D${row}*N${row}`, c.S); F(19, `J${row}*N${row}`, c.T); F(20, `(F${row}+G${row})*N${row}`, c.U);
    if (it.tr) put(21, row, 1, { s: { border: bd } });
  });
  put(0, tot, 'TOTAL', { s: bold });
  [['D', 3, t.rec], ['P', 15, t.P], ['Q', 16, t.Q], ['R', 17, t.R], ['S', 18, t.S], ['T', 19, t.T], ['U', 20, t.U]].forEach(([L, c, val]) => put(c, tot, val, { f: `SUM(${L}${first}:${L}${last})`, s: { font: { bold: true }, numFmt: '#,##0' } }));
  let row = tot + 1;
  const line = (label, val, f, extra) => { put(0, row, label, extra && extra.bold ? { s: bold } : {}); if (val !== undefined) put(2, row, val, { f, s: { numFmt: '#,##0.###' } }); return row++; };
  const hasTr = t.nTr > 0, V = `V${first}:V${last}`, K = `K${first}:K${last}`;
  line("Taux de rupture des médicaments traceurs DMEG (100 x nbre de traceurs en rupture / nbre de traceurs)", hasTr ? t.tauxRup : '', `IF(SUM(${V})=0,"",100*COUNTIFS(${V},1,${K},">0")/SUM(${V}))`);
  line("Durée moyenne de rupture des médicaments traceurs DMEG (somme des jours de rupture / nbre de traceurs)", hasTr ? t.durRup : '', `IF(SUM(${V})=0,"",SUMIF(${V},1,${K})/SUM(${V}))`);
  const f = r.fin; const R = {};
  [['grat', 'MEG sorties pour la gratuité des soins et la PF'], ['ramu', 'MEG sorties pour le RAMU'], ['fonct', 'MEG sortie pour le fonctionnement du CSPS'], ['caisse', 'Caisse du gérant non encore versé au trésorier'], ['verse', 'Versement effectués au trésorier par le gérant']].forEach(([k, l]) => { R[k] = line(l, N(f[k])); });
  R.marge = line('Marge théorique du mois', t.marge, `(Q${tot}-P${tot})-U${tot}`);
  R.retro = row; line('Rétrocession maximum sur les recettes en liquidité du mois', t.retro, `(C${R.caisse}+C${R.verse})*G${R.retro}/100`); put(6, R.retro, N(f.rate), { s: { numFmt: '0.##' } }); put(7, R.retro, '← taux de rétrocession (%)');
  R.car = line("Chiffre d'affaire réel (CAR)", t.car, `C${R.grat}+C${R.ramu}+C${R.fonct}+C${R.caisse}+C${R.verse}`);
  R.cat = line("Chiffre d'affaire théorique (CAT)", t.cat, `Q${tot}`);
  line('CAR-CAT', t.ecart, `C${R.car}-C${R.cat}`);
  const rr = line('CAR / CAT', t.ratio == null ? '' : t.ratio, `IFERROR(C${R.car}/C${R.cat},"")`); put(6, rr, '0,98 < N < 1,02');
  row++;
  put(1, row, 'Nom et Prénom', { s: bold }); put(3, row, 'Fonction', { s: bold }); put(4, row, 'N° Téléphone', { s: bold }); row++;
  [['Préparé par', 'prep'], ['Approuvé par', 'appr'], ['Reçu au District par', 'recu']].forEach(([l, k]) => { put(0, row, l, { s: bold }); put(1, row, r.sign[k].nom); put(3, row, r.sign[k].fonc); put(4, row, r.sign[k].tel); row++; });
  ws['!ref'] = X.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: 21, r: row } });
  ws['!cols'] = [{ wch: 52 }, { wch: 14 }, ...Array(19).fill({ wch: 14 }), { wch: 9 }];
  ws['!rows'] = []; ws['!rows'][7] = { hpt: 78 };
  ws['!merges'] = merges; ws['!freeze'] = { xSplit: 1, ySplit: 9 };
  ws['!views'] = [{ state: 'frozen', xSplit: 1, ySplit: 9 }];
  const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'SIGL');
  const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
  saveFile(`SIGL_${safe(r.csps)}_${r.year}-${pad2(r.month)}.xlsx`, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

async function importFile(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'sigl-meg') throw new Error('format');
    let n = 0;
    for (const r of d.reports || []) {
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
  const el = e.target.closest('[data-act],[data-open],[data-tab],[data-filter],[data-edit],[data-cedit]'); if (!el) return;
  const d = el.dataset;
  if (d.open) return go('/r/' + encodeURIComponent(d.open));
  if (d.tab) { S.tab = d.tab; return renderTab(); }
  if (d.filter) { S.filter = d.filter; return paneProducts(); }
  if (d.edit) return dlgProduct(d.edit, true);
  if (d.cedit) return dlgProduct(d.cedit);
  switch (d.act) {
    case 'back': return history.length > 1 ? history.back() : go('/');
    case 'new': return dlgNew();
    case 'import': return pickFile();
    case 'catalog': return go('/catalogue');
    case 'settings': return go('/reglages');
    case 'addprod': return dlgProduct();
    case 'more': S.shown += PAGE; { const y = scrollY; renderList(false); scrollTo(0, y); } return;
    case 'xlsx': await saveNow(); return exportXlsx(S.rep);
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
