import { db } from './db.js';
import {
  HOUR, MIN, breakMs, paidMs, wage, isOnBreak, totals,
  startOfDay, startOfWeek, startOfMonth, addDays, addMonths, inRange, weekNumber,
  rangeFromInputs, toStamp, dateKey, timeKey
} from './calc.js';

const APP_VERSION = '1.0.0';

// ---------- state ----------
const state = {
  shifts: [],
  planned: [],
  settings: { key: 'settings', rate: null, installHintDismissed: false },
  view: 'today',
  hours: { mode: 'week', anchor: new Date() },
  schedule: { month: startOfMonth(new Date()), selected: dateKey(new Date()) },
  installEvent: null
};

// ---------- formatting (nl-NL, 24 uur, euro) ----------
const nf = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fEuro = (n) => nf.format(n);
const fLongDate = (d) => new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
const fDateYear = (d) => new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
const fShortDay = (d) => new Intl.DateTimeFormat('nl-NL', { weekday: 'short' }).format(d).replace('.', '');
const fMonthYear = (d) => new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric' }).format(d);
const fMonth = (d) => new Intl.DateTimeFormat('nl-NL', { month: 'long' }).format(d);
const fDayMonth = (d) => new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(d).replace('.', '');
const fTime = (t) => timeKey(t);
function fDur(ms) { // weergave afgerond op hele minuten
  const m = Math.round(ms / MIN);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function fTimer(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const parseEuro = (v) => { const n = parseFloat(String(v).trim().replace(/\s|€/g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const fRateInput = (n) => (typeof n === 'number' ? String(n.toFixed(2)).replace('.', ',') : '');
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hasRate = () => typeof state.settings.rate === 'number' && state.settings.rate > 0;
const activeShift = () => state.shifts.find((s) => s.end == null) || null;

// ---------- data ----------
async function loadAll() {
  const [shifts, planned, settings] = await Promise.all([db.all('shifts'), db.all('planned'), db.get('settings', 'settings')]);
  state.shifts = shifts;
  state.planned = planned;
  if (settings) state.settings = { ...state.settings, ...settings };
}
async function saveShift(s) { await db.put('shifts', s); await loadAll(); askPersist(); }
async function saveSettings() { await db.put('settings', state.settings); }
let persistAsked = false;
function askPersist() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  navigator.storage.persist().catch(() => {});
}

// ---------- check-in / pauze / check-out ----------
async function checkIn() {
  await loadAll();
  if (activeShift()) { toast('Je bent al ingecheckt.'); return render(); }
  const shift = { id: uid(), start: Date.now(), end: null, breaks: [], rate: hasRate() ? state.settings.rate : null, createdAt: Date.now() };
  const ok = await db.startShiftIfNone(shift);
  await loadAll();
  askPersist();
  toast(ok ? 'Ingecheckt om ' + fTime(shift.start) + '. Succes!' : 'Je bent al ingecheckt.');
  render();
}
async function startBreak() {
  await loadAll();
  const s = activeShift();
  if (!s || isOnBreak(s)) return render();
  s.breaks = [...(s.breaks || []), { start: Date.now(), end: null }];
  await saveShift(s);
  render();
}
async function stopBreak() {
  await loadAll();
  const s = activeShift();
  if (!s) return render();
  const now = Date.now();
  s.breaks = (s.breaks || []).map((b) => (b.end == null ? { ...b, end: now } : b));
  await saveShift(s);
  render();
}
async function checkOut() {
  await loadAll();
  const s = activeShift();
  if (!s) return render();
  const before = structuredClone(s);
  const now = Date.now();
  s.breaks = (s.breaks || []).map((b) => (b.end == null ? { ...b, end: now } : b));
  s.end = now;
  await saveShift(s);
  const w = wage(s);
  toast(`Uitgecheckt. ${fDur(paidMs(s))} uur${w != null ? ' · ' + fEuro(w) : ''}`, {
    label: 'Ongedaan maken',
    run: async () => { await db.put('shifts', before); await loadAll(); render(); }
  });
  render();
}

// ---------- rendering ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function render() {
  for (const v of ['today', 'hours', 'schedule', 'settings']) $('#view-' + v).hidden = v !== state.view;
  $$('.tab').forEach((t) => {
    const on = t.dataset.view === state.view;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  ({ today: renderToday, hours: renderHours, schedule: renderSchedule, settings: renderSettings })[state.view]();
}

function go(view) { state.view = view; render(); window.scrollTo(0, 0); }

function plannedRange(p) { return rangeFromInputs(p.date, p.startTime, p.endTime); }
function nextPlanned() {
  const now = Date.now();
  return state.planned
    .map((p) => ({ p, ...plannedRange(p) }))
    .filter((x) => x.end > now)
    .sort((a, b) => a.start - b.start)[0] || null;
}

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }

function renderToday() {
  const el = $('#view-today');
  const now = new Date();
  const s = activeShift();
  const onBreak = isOnBreak(s);
  const monthShifts = state.shifts.filter((x) => inRange(x, startOfMonth(now), addMonths(startOfMonth(now), 1)));
  const t = totals(monthShifts);
  const np = nextPlanned();

  let statusCard;
  if (!s) {
    statusCard = `
      <div class="card">
        <span class="status idle">Niet aan het werk</span>
        <p class="muted" style="margin:12px 0 16px">Begin je met werken? Tik op inchecken.</p>
        <button class="big-btn in" data-act="checkin">Inchecken<small>Start je dienst nu</small></button>
      </div>`;
  } else {
    const startD = new Date(s.start);
    const startLabel = dateKey(startD) === dateKey(now) ? fTime(startD) : `${fShortDay(startD)} ${fDayMonth(startD)}, ${fTime(startD)}`;
    const openBreak = onBreak ? s.breaks.find((b) => b.end == null) : null;
    statusCard = `
      <div class="card">
        <span class="status ${onBreak ? 'break' : 'working'}">${onBreak ? 'Pauze' : 'Aan het werk'}</span>
        <div class="muted small" style="margin-top:14px">${onBreak ? 'Gewerkte tijd (staat stil tijdens pauze)' : 'Gewerkte tijd'}</div>
        <div class="timer num" data-live="paid">${fTimer(paidMs(s))}</div>
        <div style="margin:12px 0 14px">
          <div class="kv"><span>Ingecheckt om</span><span class="num">${startLabel}</span></div>
          <div class="kv"><span>Pauze totaal</span><span class="num" data-live="break">${fDur(breakMs(s))}</span></div>
          ${onBreak ? `<div class="kv"><span>Pauze sinds</span><span class="num">${fTime(openBreak.start)}</span></div>` : ''}
          ${s.rate != null ? `<div class="kv"><span>Verwacht bruto tot nu</span><span class="num" data-live="wage">${fEuro(wage(s))}</span></div>` : ''}
        </div>
        <div class="btn-row" style="margin-bottom:10px">
          ${onBreak
            ? `<button class="btn primary block" data-act="stopbreak">▶︎ Pauze stoppen</button>`
            : `<button class="btn amber block" data-act="startbreak">⏸ Pauze starten</button>`}
        </div>
        <button class="big-btn out" data-act="checkout">Uitchecken<small>Rond je dienst af</small></button>
        <button class="btn ghost block small" data-act="edit-active" style="margin-top:6px">Begintijd aanpassen</button>
      </div>`;
  }

  let npHtml;
  if (np) {
    const st = new Date(np.start);
    const isNow = np.start <= Date.now();
    const dayLabel = dateKey(st) === dateKey(now) ? 'Vandaag' : dateKey(st) === dateKey(addDays(now, 1)) ? 'Morgen' : capital(fLongDate(st));
    npHtml = `
      <div class="card flat">
        <div class="card-title">Volgende geplande dienst</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div>
            <div style="font-weight:700;font-size:18px">${dayLabel}${isNow ? ' <span class="tag">nu volgens rooster</span>' : ''}</div>
            <div class="muted num">${fTime(np.start)} – ${fTime(np.end)}${np.overnight ? ' (volgende dag)' : ''} · ${fDur(np.end - np.start)} uur</div>
          </div>
          <span class="tag">Gepland</span>
        </div>
      </div>`;
  } else {
    npHtml = `
      <div class="card flat">
        <div class="card-title">Volgende geplande dienst</div>
        <p class="muted" style="margin:0 0 10px">Nog niets ingepland.</p>
        <button class="btn small" data-go="schedule">Dienst plannen</button>
      </div>`;
  }

  const showInstall = !isStandalone() && !state.settings.installHintDismissed;
  el.innerHTML = `
    <div class="hello">Hoi Sven 👋</div>
    <p class="muted" style="margin-bottom:16px">${capital(fLongDate(now))}</p>
    ${!hasRate() ? `
      <div class="notice">
        <div class="grow"><b>Vul je uurloon in</b><br><span class="small">Dan kan de app je verwachte bruto loon uitrekenen.</span></div>
        <button class="btn small navy" data-go="settings">Instellen</button>
      </div>` : ''}
    ${showInstall ? `
      <div class="notice info">
        <div class="grow"><b>Zet de app op je beginscherm</b><br><span class="small">Dan open je hem met één tik, net als een gewone app.</span></div>
        <button class="btn small" data-act="install-help">Hoe?</button>
      </div>` : ''}
    ${statusCard}
    ${npHtml}
    <div class="card">
      <div class="card-title">Deze maand · ${fMonth(now)}</div>
      <div class="stats">
        <div class="stat"><div class="label">Gewerkte uren</div><div class="value num" data-live="month-hours">${fDur(t.ms)}</div></div>
        <div class="stat"><div class="label">Verwacht bruto loon</div><div class="value green num" data-live="month-wage">${hasRate() || t.money > 0 ? fEuro(t.money) : '–'}</div></div>
      </div>
      ${t.missingRate ? `<p class="hint warn" style="margin:10px 0 0">${t.missingRate} ${t.missingRate === 1 ? 'dienst heeft' : 'diensten hebben'} nog geen uurloon en ${t.missingRate === 1 ? 'telt' : 'tellen'} niet mee in het loon.</p>` : ''}
      <p class="disclaimer">Indicatie, exclusief toeslagen, vakantiegeld en inhoudingen.</p>
    </div>
    ${state.shifts.length === 0 && !s ? `<p class="muted small" style="text-align:center">Nog geen diensten geregistreerd. Je eerste dienst verschijnt hier zodra je incheckt.</p>` : ''}
  `;
}

function updateLive() {
  if (state.view !== 'today') return;
  const s = activeShift();
  if (!s) return;
  const set = (k, v) => { const e = document.querySelector(`[data-live="${k}"]`); if (e) e.textContent = v; };
  set('paid', fTimer(paidMs(s)));
  set('break', fDur(breakMs(s)));
  const w = wage(s); if (w != null) set('wage', fEuro(w));
  const now = new Date();
  const t = totals(state.shifts.filter((x) => inRange(x, startOfMonth(now), addMonths(startOfMonth(now), 1))));
  set('month-hours', fDur(t.ms));
  if (hasRate() || t.money > 0) set('month-wage', fEuro(t.money));
}

function shiftRow(s) {
  const st = new Date(s.start);
  const live = s.end == null;
  const endD = live ? null : new Date(s.end);
  const overnight = endD && dateKey(endD) !== dateKey(st);
  const w = wage(s);
  return `
    <button class="shift${live ? ' live' : ''}" data-shift="${esc(s.id)}">
      <div class="date-badge"><b>${st.getDate()}</b><span>${fShortDay(st)}</span></div>
      <div class="main">
        <div class="t num">${fTime(st)} – ${live ? '<span class="tag green">bezig</span>' : fTime(endD) + (overnight ? ' <span class="tag">+1 dag</span>' : '')}</div>
        <div class="s num">Pauze ${fDur(breakMs(s))} · ${s.rate != null ? fEuro(s.rate) + '/u' : '<span style="color:#8a5500">geen uurloon</span>'}</div>
      </div>
      <div class="right">
        <div class="h num">${fDur(paidMs(s))} u</div>
        <div class="w num">${w != null ? fEuro(w) : '–'}</div>
      </div>
    </button>`;
}

function renderHours() {
  const el = $('#view-hours');
  const { mode, anchor } = state.hours;
  let from, to, label, sub;
  if (mode === 'week') {
    from = startOfWeek(anchor); to = addDays(from, 7);
    label = `Week ${weekNumber(from)}`;
    sub = `${fDayMonth(from)} – ${fDayMonth(addDays(to, -1))} ${addDays(to, -1).getFullYear()}`;
  } else {
    from = startOfMonth(anchor); to = addMonths(from, 1);
    label = capital(fMonthYear(from));
    sub = '';
  }
  const list = state.shifts.filter((s) => inRange(s, from, to)).sort((a, b) => b.start - a.start);
  const t = totals(list);

  let listHtml = '';
  if (!list.length) {
    listHtml = `<div class="empty"><span class="emoji">🗓️</span>Geen gewerkte diensten in deze ${mode === 'week' ? 'week' : 'maand'}.<br><span class="small">Vergeten in te checken? Voeg de dienst hierboven toe met <b>+ Dienst</b>.</span></div>`;
  } else if (mode === 'month') {
    const groups = new Map();
    for (const s of list) {
      const k = +startOfWeek(new Date(s.start));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [k, items] of groups) {
      const gt = totals(items);
      listHtml += `<div class="muted small" style="display:flex;justify-content:space-between;margin:8px 4px 2px"><b>Week ${weekNumber(new Date(k))}</b><span class="num">${fDur(gt.ms)} u · ${fEuro(gt.money)}</span></div>`;
      listHtml += `<div class="list">${items.map(shiftRow).join('')}</div>`;
    }
  } else {
    listHtml = `<div class="list">${list.map(shiftRow).join('')}</div>`;
  }

  el.innerHTML = `
    <div class="page-head"><h1>Uren</h1><button class="btn small navy" data-act="add-shift">+ Dienst</button></div>
    <div class="seg" role="tablist">
      <button class="${mode === 'week' ? 'on' : ''}" data-mode="week">Week</button>
      <button class="${mode === 'month' ? 'on' : ''}" data-mode="month">Maand</button>
    </div>
    <div class="period">
      <button class="icon-btn" data-period="-1" aria-label="Vorige">‹</button>
      <div class="label">${label}${sub ? `<small>${sub}</small>` : ''}</div>
      <button class="icon-btn" data-period="1" aria-label="Volgende">›</button>
    </div>
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">Betaalde uren</div><div class="value num">${fDur(t.ms)}</div></div>
        <div class="stat"><div class="label">Verwacht bruto loon</div><div class="value green num">${fEuro(t.money)}</div></div>
      </div>
      <p class="muted small" style="margin:8px 0 0">${t.count} ${t.count === 1 ? 'dienst' : 'diensten'}, pauzes zijn eraf gehaald.</p>
      ${t.missingRate ? `<p class="hint warn" style="margin:6px 0 0">${t.missingRate} ${t.missingRate === 1 ? 'dienst zonder' : 'diensten zonder'} uurloon ${t.missingRate === 1 ? 'telt' : 'tellen'} niet mee in het loon. Tik erop om een uurloon in te vullen.</p>` : ''}
      <p class="disclaimer">Indicatie, exclusief toeslagen, vakantiegeld en inhoudingen.</p>
    </div>
    ${listHtml}
    ${list.length ? '<p class="muted tiny" style="text-align:center;margin-top:14px">Tik op een dienst om hem aan te passen of te verwijderen.</p>' : ''}
  `;
}

function renderSchedule() {
  const el = $('#view-schedule');
  const { month, selected } = state.schedule;
  const todayK = dateKey(new Date());
  const gridStart = startOfWeek(month);
  const plannedByDay = new Map();
  for (const p of state.planned) plannedByDay.set(p.date, (plannedByDay.get(p.date) || 0) + 1);
  const workedByDay = new Map();
  for (const s of state.shifts) { const k = dateKey(s.start); workedByDay.set(k, (workedByDay.get(k) || 0) + 1); }

  let cells = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    if (i === 35 && d.getMonth() !== month.getMonth()) break;
    const k = dateKey(d);
    const cls = [d.getMonth() !== month.getMonth() ? 'other' : '', k === todayK ? 'today' : '', k === selected ? 'sel' : ''].join(' ');
    cells += `<button class="${cls}" data-day="${k}" aria-label="${fLongDate(d)}">${d.getDate()}<span class="dots">${workedByDay.has(k) ? '<i class="dot w"></i>' : ''}${plannedByDay.has(k) ? '<i class="dot p"></i>' : ''}</span></button>`;
  }

  const selDate = new Date(toStamp(selected, '00:00'));
  const dayPlanned = state.planned.filter((p) => p.date === selected).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const dayWorked = state.shifts.filter((s) => dateKey(s.start) === selected).sort((a, b) => a.start - b.start);
  const upcoming = state.planned.map((p) => ({ p, ...plannedRange(p) })).filter((x) => x.end > Date.now()).sort((a, b) => a.start - b.start).slice(0, 8);

  el.innerHTML = `
    <div class="page-head"><h1>Rooster</h1><button class="btn small navy" data-act="add-plan">+ Plannen</button></div>
    <div class="card">
      <div class="period" style="margin-top:0">
        <button class="icon-btn" data-month="-1" aria-label="Vorige maand">‹</button>
        <div class="label">${capital(fMonthYear(month))}</div>
        <button class="icon-btn" data-month="1" aria-label="Volgende maand">›</button>
      </div>
      <div class="cal">${cells}</div>
      <div class="legend"><span><i class="w"></i>Gewerkt</span><span><i class="p"></i>Gepland</span></div>
    </div>

    <h2>${capital(fLongDate(selDate))}</h2>
    <div class="list" style="margin-bottom:12px">
      ${dayWorked.map(shiftRow).join('')}
      ${dayPlanned.map(plannedRow).join('')}
      ${!dayWorked.length && !dayPlanned.length ? '<p class="muted" style="margin:0 4px">Niets gepland of gewerkt op deze dag.</p>' : ''}
    </div>
    <button class="btn block" data-act="add-plan-day" style="margin-bottom:22px">+ Dienst plannen op deze dag</button>

    <h2>Komende diensten</h2>
    <div class="list">
      ${upcoming.length ? upcoming.map((x) => plannedRow(x.p, true)).join('') : '<div class="empty"><span class="emoji">📅</span>Nog geen diensten gepland.<br><span class="small">Zet je rooster erin, dan zie je op het startscherm wanneer je weer moet werken.</span></div>'}
    </div>
    <p class="muted tiny" style="margin-top:14px">Geplande diensten tellen niet mee als gewerkte uren. Check in als je echt begint.</p>
  `;
}

function plannedRow(p, showDate = false) {
  const r = plannedRange(p);
  const st = new Date(r.start);
  return `
    <button class="shift planned" data-plan="${esc(p.id)}">
      <div class="date-badge"><b>${st.getDate()}</b><span>${fShortDay(st)}</span></div>
      <div class="main">
        <div class="t num">${fTime(r.start)} – ${fTime(r.end)}${r.overnight ? ' <span class="tag">+1 dag</span>' : ''}</div>
        <div class="s">${showDate ? capital(fLongDate(st)) : 'Gepland'}</div>
      </div>
      <div class="right"><span class="tag">Gepland</span><div class="h num small" style="margin-top:4px">${fDur(r.end - r.start)} u</div></div>
    </button>`;
}

async function renderSettings() {
  const el = $('#view-settings');
  const ios = isIOS();
  el.innerHTML = `
    <div class="page-head"><h1>Instellingen</h1></div>

    <div class="card">
      <h2>Uurloon</h2>
      <label class="field"><span>Bruto uurloon</span>
        <div class="euro-input"><input id="rate" class="input num" inputmode="decimal" autocomplete="off" placeholder="bijv. 12,50" value="${fRateInput(state.settings.rate)}"></div>
      </label>
      <p class="hint">Staat op je contract of loonstrook. Een nieuw uurloon geldt alleen voor nieuwe diensten; eerdere diensten houden hun eigen uurloon.</p>
      <div id="rate-error" class="error" hidden></div>
      <button class="btn primary block" data-act="save-rate">Uurloon opslaan</button>
    </div>

    <div class="card">
      <h2>Zo wordt je loon berekend</h2>
      <p class="small">Gewerkte tijd min onbetaalde pauzes, keer het uurloon dat bij die dienst hoort. De app rekent met de echte minuten en rondt alleen af bij het tonen.</p>
      <p class="small" style="margin:0"><b>Verwacht bruto loon</b> is een indicatie, exclusief toeslagen, vakantiegeld en inhoudingen. Wat je netto krijgt staat op je loonstrook.</p>
    </div>

    <div class="card">
      <h2>App op je beginscherm</h2>
      ${isStandalone() ? '<p class="notice green" style="margin:0 0 10px">✓ De app staat op je beginscherm.</p>' : ''}
      ${installStepsHtml(ios)}
      ${state.installEvent ? '<button class="btn primary block" data-act="install" style="margin-top:10px">Installeren</button>' : ''}
    </div>

    <div class="card">
      <h2>Reservekopie</h2>
      <p class="small">Je gegevens staan alleen op deze telefoon. Ze kunnen verloren gaan als je de browsergegevens of websitegegevens van Safari wist, of de app van je beginscherm verwijdert. Maak daarom af en toe een reservekopie en bewaar die bijvoorbeeld in Bestanden of iCloud Drive.</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn navy" data-act="export">Exporteren</button>
        <button class="btn" data-act="import">Importeren</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <p class="muted tiny" id="persist-status" style="margin:10px 0 0"></p>
    </div>

    <p class="muted tiny" style="text-align:center">Sven z'n uren · versie ${APP_VERSION}<br>${state.shifts.length} diensten · ${state.planned.length} geplande diensten</p>
  `;
  if (navigator.storage && navigator.storage.persisted) {
    try {
      const p = await navigator.storage.persisted();
      const e = $('#persist-status');
      if (e) e.textContent = p ? 'Opslag staat op blijvend bewaren.' : '';
    } catch (_) { /* niet belangrijk */ }
  }
}

function installStepsHtml(ios) {
  const share = '<svg class="share-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  if (ios || !state.installEvent) {
    return `
      <p class="small" style="margin-bottom:4px"><b>iPhone (Safari)</b></p>
      <ol class="steps small">
        <li>Open deze pagina in <b>Safari</b>.</li>
        <li>Tik op de deelknop ${share} (onderin of naast de adresbalk).</li>
        <li>Kies <b>Zet op beginscherm</b>. Zie je het niet? Scroll in het menu naar beneden.</li>
        <li>Zet <b>Open als webapp</b> aan als je die optie ziet, en tik op <b>Voeg toe</b>.</li>
        <li>Open de app voortaan via het nieuwe icoontje. Hij opent dan als losse app.</li>
      </ol>
      <p class="small" style="margin:10px 0 4px"><b>Android (Chrome)</b></p>
      <ol class="steps small">
        <li>Tik op het menu ⋮ rechtsboven.</li>
        <li>Kies <b>App installeren</b> of <b>Toevoegen aan startscherm</b>.</li>
      </ol>`;
  }
  return '<p class="small">Tik op <b>Installeren</b> om de app op je startscherm te zetten.</p>';
}

// ---------- bottom sheet & dialogs ----------
let sheetCleanup = null;
function openSheet(html, mount) {
  const sheet = $('#sheet');
  sheet.innerHTML = html;
  sheet.hidden = false;
  $('#sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  sheetCleanup = mount ? mount(sheet) : null;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
  if (typeof sheetCleanup === 'function') sheetCleanup();
  sheetCleanup = null;
}
function confirmDialog({ title, text, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const box = $('#confirm'), bd = $('#confirm-backdrop');
    const done = (v) => { box.hidden = true; bd.hidden = true; box.innerHTML = ''; resolve(v); };
    box.innerHTML = `
      <h2>${esc(title)}</h2>
      <p>${text}</p>
      <div class="btn-row" style="margin-top:18px">
        <button class="btn" data-c="no">Annuleren</button>
        <button class="btn ${danger ? 'danger' : 'navy'}" data-c="yes">${esc(ok)}</button>
      </div>`;
    box.hidden = false; bd.hidden = false;
    $('[data-c="no"]', box).onclick = () => done(false);
    $('[data-c="yes"]', box).onclick = () => done(true);
    bd.onclick = () => done(false);
  });
}

let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button class="btn small" style="margin-left:10px;min-height:34px;padding:6px 10px;background:#fff;color:var(--navy)">${esc(action.label)}</button>` : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
}

// ---------- shift form (handmatig toevoegen / aanpassen) ----------
function overlapping(start, end, ignoreId) {
  const now = Date.now();
  return state.shifts.find((s) => s.id !== ignoreId && start < (s.end ?? now) && end > s.start) || null;
}

function openShiftForm(existing) {
  const isNew = !existing;
  const now = new Date();
  const s = existing || null;
  const date = s ? dateKey(s.start) : dateKey(now);
  const startT = s ? fTime(s.start) : '';
  const endT = s ? fTime(s.end) : '';
  const breakMin = s ? Math.round(breakMs(s) / MIN) : 0;
  const rate = s ? s.rate : (hasRate() ? state.settings.rate : null);

  openSheet(`
    <h2>${isNew ? 'Dienst toevoegen' : 'Dienst aanpassen'}</h2>
    <form id="shift-form" novalidate>
      <label class="field"><span>Datum (begin van de dienst)</span><input class="input" type="date" name="date" value="${date}" required></label>
      <div class="row2">
        <label class="field"><span>Begintijd</span><input class="input num" type="time" name="start" value="${startT}" required></label>
        <label class="field"><span>Eindtijd</span><input class="input num" type="time" name="end" value="${endT}" required></label>
      </div>
      <p class="hint" id="overnight-hint" hidden>🌙 Eindtijd ligt vóór de begintijd, dus de dienst eindigt de volgende dag.</p>
      <div class="row2">
        <label class="field"><span>Onbetaalde pauze</span><input class="input num" type="number" name="pause" min="0" step="1" inputmode="numeric" value="${breakMin}"></label>
        <label class="field"><span>Uurloon</span><div class="euro-input"><input class="input num" name="rate" inputmode="decimal" placeholder="12,50" value="${fRateInput(rate)}"></div></label>
      </div>
      <p class="hint">Pauze in minuten. Het uurloon wordt bij deze dienst bewaard.</p>
      <div class="card flat" style="padding:12px 14px;margin-bottom:14px">
        <div class="kv"><span>Betaalde tijd</span><span class="num" id="pv-hours">–</span></div>
        <div class="kv"><span>Verwacht bruto loon</span><span class="num" id="pv-wage">–</span></div>
      </div>
      <div class="error" id="form-error" hidden></div>
      <button class="btn primary block" type="submit">Opslaan</button>
      ${!isNew ? '<button class="btn danger block" type="button" data-act="delete-shift" style="margin-top:10px">Dienst verwijderen</button>' : ''}
      <button class="btn ghost block" type="button" data-act="close-sheet" style="margin-top:6px">Annuleren</button>
    </form>`, (sheet) => {
    const form = $('#shift-form', sheet);
    const read = () => {
      const f = new FormData(form);
      const d = f.get('date'), st = f.get('start'), en = f.get('end');
      const pauseRaw = String(f.get('pause') || '0').trim();
      const pause = pauseRaw === '' ? 0 : Number(pauseRaw);
      const rateRaw = String(f.get('rate') || '').trim();
      const r = rateRaw === '' ? null : parseEuro(rateRaw);
      if (!d || !st || !en) return { incomplete: true, rate: r, pause };
      // Ongewijzigde velden: houd de exacte geregistreerde tijdstempels (tot op de seconde).
      if (s && d === date && st === startT && en === endT) return { start: s.start, end: s.end, overnight: dateKey(s.end) !== dateKey(s.start), pause, rate: r };
      return { ...rangeFromInputs(d, st, en), pause, rate: r };
    };
    const preview = () => {
      const v = read();
      $('#overnight-hint', sheet).hidden = !v.overnight;
      if (v.incomplete || !(v.pause >= 0)) { $('#pv-hours', sheet).textContent = '–'; $('#pv-wage', sheet).textContent = '–'; return; }
      const ms = Math.max(0, v.end - v.start - v.pause * MIN);
      $('#pv-hours', sheet).textContent = fDur(ms) + ' uur';
      $('#pv-wage', sheet).textContent = v.rate != null && v.rate > 0 ? fEuro((ms / HOUR) * v.rate) : 'geen uurloon';
    };
    form.addEventListener('input', preview);
    preview();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = read();
      const err = (m) => { const x = $('#form-error', sheet); x.textContent = m; x.hidden = false; };
      if (v.incomplete) return err('Vul een datum, begintijd en eindtijd in.');
      if (!Number.isFinite(v.pause) || v.pause < 0 || !Number.isInteger(v.pause)) return err('Vul de pauze in als een heel aantal minuten (0 of meer).');
      if (v.rate !== null && !(v.rate > 0 && v.rate < 1000)) return err('Vul een geldig uurloon in, bijvoorbeeld 12,50. Of laat het leeg.');
      if (v.end - v.start > 24 * HOUR) return err('Een dienst kan niet langer dan 24 uur duren.');
      if (v.pause * MIN >= v.end - v.start) return err('De pauze is langer dan de dienst zelf.');
      if (v.end > Date.now()) return err('Deze dienst eindigt in de toekomst. Zet toekomstige diensten in het Rooster.');
      const ov = overlapping(v.start, v.end, s && s.id);
      if (ov) return err(`Deze tijden overlappen met je dienst van ${fLongDate(new Date(ov.start))} (${fTime(ov.start)}${ov.end ? ' – ' + fTime(ov.end) : ''}).`);

      const next = s ? { ...s } : { id: uid(), breaks: [], createdAt: Date.now(), manual: true };
      next.start = v.start;
      next.end = v.end;
      next.rate = v.rate;
      // Pauze: alleen vervangen als Sven het aantal minuten echt heeft veranderd.
      // Zijn alleen uurloon of niets veranderd, dan blijven de precies geregistreerde pauzes staan.
      const timesSame = s && v.start === s.start && v.end === s.end;
      if (!s || v.pause !== breakMin || !timesSame) next.breakMs = v.pause * MIN;
      next.updatedAt = Date.now();
      await saveShift(next);
      closeSheet();
      toast(isNew ? 'Dienst toegevoegd.' : 'Dienst aangepast.');
      state.hours.anchor = new Date(next.start);
      render();
    });
    $('[data-act="delete-shift"]', sheet)?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Dienst verwijderen?',
        text: `Weet je zeker dat je de dienst van <b>${fLongDate(new Date(s.start))}</b> (${fTime(s.start)} – ${fTime(s.end)}) wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`,
        ok: 'Verwijderen', danger: true
      });
      if (!ok) return;
      await db.del('shifts', s.id);
      await loadAll();
      closeSheet();
      toast('Dienst verwijderd.');
      render();
    });
  });
}

function openActiveForm() {
  const s = activeShift();
  if (!s) return;
  openSheet(`
    <h2>Begintijd aanpassen</h2>
    <p class="muted small">Later ingecheckt dan je begon? Pas hier de begintijd van je huidige dienst aan.</p>
    <form id="active-form" novalidate>
      <div class="row2">
        <label class="field"><span>Datum</span><input class="input" type="date" name="date" value="${dateKey(s.start)}"></label>
        <label class="field"><span>Begintijd</span><input class="input num" type="time" name="start" value="${fTime(s.start)}"></label>
      </div>
      <div class="error" id="form-error" hidden></div>
      <button class="btn primary block" type="submit">Opslaan</button>
      <button class="btn danger block" type="button" data-act="cancel-active" style="margin-top:10px">Dienst annuleren (per ongeluk ingecheckt)</button>
      <button class="btn ghost block" type="button" data-act="close-sheet" style="margin-top:6px">Terug</button>
    </form>`, (sheet) => {
    $('#active-form', sheet).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const err = (m) => { const x = $('#form-error', sheet); x.textContent = m; x.hidden = false; };
      if (!f.get('date') || !f.get('start')) return err('Vul een datum en begintijd in.');
      const start = toStamp(f.get('date'), f.get('start'));
      if (start > Date.now()) return err('De begintijd kan niet in de toekomst liggen.');
      if (Date.now() - start > 24 * HOUR) return err('De begintijd ligt meer dan 24 uur geleden.');
      const ov = overlapping(start, Date.now(), s.id);
      if (ov) return err('Deze begintijd overlapt met een eerdere dienst.');
      if ((s.breaks || []).some((b) => b.start < start)) return err('Er is al een pauze vóór deze begintijd geregistreerd.');
      await saveShift({ ...s, start, updatedAt: Date.now() });
      closeSheet(); toast('Begintijd aangepast.'); render();
    });
    $('[data-act="cancel-active"]', sheet).addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Dienst annuleren?', text: 'De huidige dienst wordt verwijderd en telt niet mee. Weet je het zeker?', ok: 'Annuleren', danger: true });
      if (!ok) return;
      await db.del('shifts', s.id); await loadAll(); closeSheet(); toast('Dienst geannuleerd.'); render();
    });
  });
}

// ---------- geplande diensten ----------
function openPlanForm(existing, presetDate) {
  const p = existing || null;
  openSheet(`
    <h2>${p ? 'Geplande dienst' : 'Dienst plannen'}</h2>
    <form id="plan-form" novalidate>
      <label class="field"><span>Datum</span><input class="input" type="date" name="date" value="${p ? p.date : (presetDate || dateKey(new Date()))}"></label>
      <div class="row2">
        <label class="field"><span>Begintijd</span><input class="input num" type="time" name="start" value="${p ? p.startTime : ''}"></label>
        <label class="field"><span>Eindtijd</span><input class="input num" type="time" name="end" value="${p ? p.endTime : ''}"></label>
      </div>
      <p class="hint" id="overnight-hint" hidden>🌙 Deze dienst eindigt de volgende dag.</p>
      <p class="hint">Een geplande dienst telt niet mee als gewerkte tijd. Check in als je echt begint.</p>
      <div class="error" id="form-error" hidden></div>
      <button class="btn primary block" type="submit">${p ? 'Opslaan' : 'Inplannen'}</button>
      ${p ? '<button class="btn danger block" type="button" data-act="delete-plan" style="margin-top:10px">Verwijderen</button>' : ''}
      <button class="btn ghost block" type="button" data-act="close-sheet" style="margin-top:6px">Annuleren</button>
    </form>`, (sheet) => {
    const form = $('#plan-form', sheet);
    const upd = () => {
      const f = new FormData(form);
      const ok = f.get('date') && f.get('start') && f.get('end');
      $('#overnight-hint', sheet).hidden = !(ok && rangeFromInputs(f.get('date'), f.get('start'), f.get('end')).overnight);
    };
    form.addEventListener('input', upd); upd();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const err = (m) => { const x = $('#form-error', sheet); x.textContent = m; x.hidden = false; };
      if (!f.get('date') || !f.get('start') || !f.get('end')) return err('Vul een datum, begintijd en eindtijd in.');
      if (f.get('start') === f.get('end')) return err('Begin- en eindtijd zijn hetzelfde.');
      const item = { id: p ? p.id : uid(), date: f.get('date'), startTime: f.get('start'), endTime: f.get('end') };
      await db.put('planned', item); await loadAll();
      state.schedule.selected = item.date;
      state.schedule.month = startOfMonth(new Date(toStamp(item.date, '00:00')));
      closeSheet(); toast(p ? 'Geplande dienst aangepast.' : 'Dienst ingepland.'); render();
    });
    $('[data-act="delete-plan"]', sheet)?.addEventListener('click', async () => {
      const r = plannedRange(p);
      const ok = await confirmDialog({ title: 'Geplande dienst verwijderen?', text: `De geplande dienst van <b>${fLongDate(new Date(r.start))}</b> (${fTime(r.start)} – ${fTime(r.end)}) wordt uit je rooster gehaald.`, ok: 'Verwijderen', danger: true });
      if (!ok) return;
      await db.del('planned', p.id); await loadAll(); closeSheet(); toast('Geplande dienst verwijderd.'); render();
    });
  });
}

// ---------- instellingen: uurloon, export, import ----------
async function saveRate() {
  const v = $('#rate').value;
  const n = parseEuro(v);
  const errEl = $('#rate-error');
  if (!(n > 0 && n < 1000)) { errEl.textContent = 'Vul een geldig bruto uurloon in, bijvoorbeeld 12,50.'; errEl.hidden = false; return; }
  const rounded = Math.round(n * 100) / 100;
  const changed = state.settings.rate !== rounded;
  state.settings.rate = rounded;
  await saveSettings();
  askPersist();
  // Lopende dienst zonder uurloon krijgt het nieuwe uurloon.
  const a = activeShift();
  if (a && a.rate == null) await db.put('shifts', { ...a, rate: rounded });
  await loadAll();
  const missing = state.shifts.filter((s) => s.rate == null);
  if (missing.length) {
    const ok = await confirmDialog({
      title: 'Ook voor eerdere diensten?',
      text: `${missing.length} ${missing.length === 1 ? 'dienst heeft' : 'diensten hebben'} nog geen uurloon. Wil je daar ${fEuro(rounded)} voor gebruiken? Diensten met een eigen uurloon blijven zoals ze zijn.`,
      ok: 'Ja, toepassen'
    });
    if (ok) { for (const s of missing) await db.put('shifts', { ...s, rate: rounded }); await loadAll(); }
  }
  toast(changed ? `Uurloon ${fEuro(rounded)} opgeslagen. Geldt voor nieuwe diensten.` : 'Uurloon opgeslagen.');
  render();
}

async function exportData() {
  await loadAll();
  const data = { app: 'sven-uren', schema: 1, exportedAt: new Date().toISOString(), shifts: state.shifts, planned: state.planned, settings: [state.settings] };
  const json = JSON.stringify(data, null, 2);
  const name = `sven-uren-reservekopie-${dateKey(new Date())}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Reservekopie Sven z\'n uren' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Reservekopie gedownload.');
}

function validBackup(d) {
  if (!d || d.app !== 'sven-uren' || !Array.isArray(d.shifts) || !Array.isArray(d.planned)) return false;
  const okShift = (s) => s && typeof s.id === 'string' && typeof s.start === 'number' && (s.end === null || typeof s.end === 'number') && Array.isArray(s.breaks || []);
  const okPlan = (p) => p && typeof p.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && /^\d{2}:\d{2}$/.test(p.startTime) && /^\d{2}:\d{2}$/.test(p.endTime);
  return d.shifts.every(okShift) && d.planned.every(okPlan) && d.shifts.filter((s) => s.end == null).length <= 1;
}

async function importFile(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (_) { d = null; }
  if (!validBackup(d)) { toast('Dit bestand is geen geldige reservekopie.'); return; }
  const ok = await confirmDialog({
    title: 'Reservekopie terugzetten?',
    text: `In deze reservekopie staan ${d.shifts.length} diensten en ${d.planned.length} geplande diensten (gemaakt op ${fDateYear(new Date(d.exportedAt))}). <b>Alles wat nu in de app staat wordt vervangen.</b>`,
    ok: 'Terugzetten', danger: true
  });
  if (!ok) return;
  const settings = (Array.isArray(d.settings) ? d.settings : []).filter((x) => x && x.key === 'settings');
  await db.replaceAll({ shifts: d.shifts, planned: d.planned, settings: settings.length ? settings : [{ key: 'settings', rate: null }] });
  state.settings = { key: 'settings', rate: null, installHintDismissed: false };
  await loadAll();
  toast('Reservekopie teruggezet.');
  render();
}

function showInstallHelp() {
  openSheet(`
    <h2>Op je beginscherm zetten</h2>
    ${installStepsHtml(isIOS())}
    <p class="small muted" style="margin-top:12px">Na de eerste keer openen werkt de app ook zonder internet.</p>
    ${state.installEvent ? '<button class="btn primary block" data-act="install" style="margin-top:10px">Installeren</button>' : ''}
    <button class="btn block" data-act="dismiss-install" style="margin-top:12px">Begrepen, niet meer tonen</button>
    <button class="btn ghost block" data-act="close-sheet" style="margin-top:6px">Sluiten</button>
  `);
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('.tab');
  if (tab) return go(tab.dataset.view);
  const g = e.target.closest('[data-go]');
  if (g) return go(g.dataset.go);

  const m = e.target.closest('[data-mode]');
  if (m) { state.hours.mode = m.dataset.mode; return render(); }
  const per = e.target.closest('[data-period]');
  if (per) {
    const n = Number(per.dataset.period);
    state.hours.anchor = state.hours.mode === 'week' ? addDays(state.hours.anchor, 7 * n) : addMonths(state.hours.anchor, n);
    return render();
  }
  const mon = e.target.closest('[data-month]');
  if (mon) { state.schedule.month = addMonths(state.schedule.month, Number(mon.dataset.month)); return render(); }
  const day = e.target.closest('[data-day]');
  if (day) {
    state.schedule.selected = day.dataset.day;
    const d = new Date(toStamp(day.dataset.day, '00:00'));
    if (d.getMonth() !== state.schedule.month.getMonth()) state.schedule.month = startOfMonth(d);
    return render();
  }
  const sh = e.target.closest('[data-shift]');
  if (sh) {
    const s = state.shifts.find((x) => x.id === sh.dataset.shift);
    if (!s) return;
    return s.end == null ? openActiveForm() : openShiftForm(s);
  }
  const pl = e.target.closest('[data-plan]');
  if (pl) { const p = state.planned.find((x) => x.id === pl.dataset.plan); if (p) openPlanForm(p); return; }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  const btnLock = (fn) => async () => { act.disabled = true; try { await fn(); } finally { act.disabled = false; } };
  switch (act.dataset.act) {
    case 'checkin': return btnLock(checkIn)();
    case 'checkout': return btnLock(checkOut)();
    case 'startbreak': return btnLock(startBreak)();
    case 'stopbreak': return btnLock(stopBreak)();
    case 'edit-active': return openActiveForm();
    case 'add-shift': return openShiftForm(null);
    case 'add-plan': return openPlanForm(null, state.schedule.selected);
    case 'add-plan-day': return openPlanForm(null, state.schedule.selected);
    case 'close-sheet': return closeSheet();
    case 'save-rate': return saveRate();
    case 'export': return exportData();
    case 'import': return $('#import-file').click();
    case 'install-help': return showInstallHelp();
    case 'dismiss-install':
      state.settings.installHintDismissed = true; await saveSettings(); closeSheet(); return render();
    case 'install':
      if (state.installEvent) { state.installEvent.prompt(); state.installEvent = null; closeSheet(); render(); }
      return;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'import-file' && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; }
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvent = e; if (state.view === 'settings') render(); });

// Na terugkomen (telefoon ontgrendeld, app weer geopend): opnieuw inlezen en
// tijden opnieuw berekenen vanuit de opgeslagen tijdstempels.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') { await loadAll(); if ($('#sheet').hidden) render(); }
});
window.addEventListener('pageshow', async (e) => { if (e.persisted) { await loadAll(); render(); } });

setInterval(updateLive, 1000);

// ---------- start ----------
(async function init() {
  try {
    await loadAll();
  } catch (err) {
    document.querySelector('#app').innerHTML = '<div class="card"><h2>Opslaan lukt niet</h2><p>Je browser blokkeert lokale opslag (bijvoorbeeld in privémodus). Open de app in een normaal Safari-venster.</p></div>';
    return;
  }
  render();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast('De app is bijgewerkt. Je gegevens zijn bewaard.'); });
  }
})();

// Voor tests
window.__sven = { state, loadAll, render };
