import { db } from './db.js';
import {
  HOUR, MIN, breakMs, paidMs, wage, travel, isOnBreak, totals,
  startOfWeek, startOfMonth, addDays, addMonths, inRange, weekNumber,
  rangeFromInputs, toStamp, dateKey, timeKey
} from './calc.js';

const APP_VERSION = '1.2.0';

// ---------- state ----------
const state = {
  shifts: [],
  planned: [],
  settings: { key: 'settings', rate: null, travel: null, installHintDismissed: false },
  view: 'today',
  hours: { mode: 'week', anchor: new Date() },
  schedule: { month: startOfMonth(new Date()), selected: dateKey(new Date()) },
  installEvent: null,
  anim: null // eenmalige animatie op het startscherm: 'arrive' of 'leave'
};

// ---------- opmaak (nl-NL, 24 uur, euro) ----------
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
function fTimerHtml(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}<span class="sec">:${String(s % 60).padStart(2, '0')}</span>`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const parseEuro = (v) => { const n = parseFloat(String(v).trim().replace(/\s|€/g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const fEuroInput = (n) => (typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '');
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hasRate = () => typeof state.settings.rate === 'number' && state.settings.rate > 0;
const hasTravel = () => typeof state.settings.travel === 'number' && state.settings.travel > 0;
const activeShift = () => state.shifts.find((s) => s.end == null) || null;
const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;

// ---------- gegevens ----------
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

// ---------- inchecken / pauze / uitchecken ----------
async function checkIn() {
  await loadAll();
  if (activeShift()) { toast('Je bent al ingecheckt.'); return render(); }
  // Al eerder vandaag gewerkt? Dan gaat de laatste dienst van vandaag gewoon door.
  // De tijd tussen uitchecken en opnieuw inchecken telt als onbetaalde pauze.
  const now = Date.now();
  const todayK = dateKey(now);
  const prev = state.shifts
    .filter((s) => s.end != null && s.end <= now && dateKey(s.start) === todayK)
    .sort((a, b) => b.end - a.end)[0];
  if (prev) {
    const resumed = { ...prev, end: null, updatedAt: now };
    resumed.breaks = [...(prev.breaks || []), { start: prev.end, end: now }];
    await db.put('shifts', resumed);
    await loadAll();
    state.anim = 'arrive';
    toast(`Je dienst van ${fTime(prev.start)} gaat verder. De tijd ertussen telt als pauze.`);
    return render();
  }
  // Rijkosten staan bij elke nieuwe dienst standaard uit.
  const shift = { id: uid(), start: Date.now(), end: null, breaks: [], rate: hasRate() ? state.settings.rate : null, travel: null, createdAt: Date.now() };
  const ok = await db.startShiftIfNone(shift);
  await loadAll();
  askPersist();
  if (ok) state.anim = 'arrive';
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
  state.anim = 'leave';
  stamp(fDur(paidMs(s)) + ' uur');
  toast(`Uitgecheckt. ${fDur(paidMs(s))} uur${w != null ? ' · ' + fEuro(w + travel(s)) : ''}`, {
    label: 'Ongedaan maken',
    run: async () => { await db.put('shifts', before); await loadAll(); render(); }
  });
  render();
}
async function toggleTravel(on) {
  await loadAll();
  const s = activeShift();
  if (!s) return render();
  if (on && !hasTravel()) {
    toast('Stel eerst je standaard rijkosten in bij Instellingen.');
    return render();
  }
  await saveShift({ ...s, travel: on ? state.settings.travel : null });
  renderTodayMonth();
}

function stamp(text) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'stamp';
  el.innerHTML = `<div><span class="ck">✓</span>Klaar!<div style="font-size:15px;font-family:var(--body);font-weight:700;margin-top:4px">${esc(text)}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

// ---------- weergave ----------
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
  stagger($('#view-' + state.view));
}
function stagger(root) {
  [...root.children].forEach((c, i) => c.style.setProperty('--i', i));
  $$('.list', root).forEach((l) => [...l.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 10))));
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

const EMPTY_BOX = `
<svg viewBox="0 0 96 80" aria-hidden="true">
  <ellipse cx="48" cy="74" rx="34" ry="4" fill="#12305a" opacity=".08"/>
  <path d="M18 34h60v34a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" fill="#c8904f"/>
  <rect x="43" y="34" width="10" height="38" fill="#e9c690"/>
  <path d="M18 34l10-12h40l10 12z" fill="#a8743b"/>
  <path class="lid" d="M18 34L6 22l12-10 10 10z" fill="#d9a465"/>
  <path d="M78 34l12-12-12-10-10 10z" fill="#d9a465"/>
</svg>`;

// Tekening op het startscherm: een loods met stellingen, een bestelbus bij de deur
// en een mannetje met een steekkar. Loopt als Sven aan het werk is.
function sceneHtml(mode) {
  if (/\bresting\b/.test(mode)) return breakSceneHtml();
  const box = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#c8904f" stroke="#1d2b53" stroke-width="1.5"/><rect x="${x + w / 2 - 2}" y="${y}" width="4" height="${h}" fill="#e9c690"/>`;
  const rack = (x) => `
    <g stroke="#1d2b53" stroke-width="2.5" fill="none"><path d="M${x} 112V22M${x + 96} 112V22M${x} 46h96M${x} 78h96M${x} 108h96"/></g>
    ${box(x + 8, 30, 22, 16)}${box(x + 34, 34, 16, 12)}${box(x + 62, 26, 26, 20)}
    ${box(x + 6, 60, 18, 18)}${box(x + 28, 64, 26, 14)}${box(x + 70, 62, 18, 16)}
    ${box(x + 14, 92, 28, 16)}${box(x + 58, 96, 20, 12)}`;
  return `
  <div class="card scene ${mode}" aria-hidden="true">
    <svg viewBox="0 0 360 124" preserveAspectRatio="xMidYMax meet">
      <rect x="0" y="112" width="360" height="12" fill="#dcc59d"/>
      <path class="floor" d="M-20 118h400" stroke="#1d2b53" stroke-width="2" stroke-dasharray="14 10"/>
      ${rack(8)}${rack(116)}
      <g><rect x="226" y="14" width="140" height="98" fill="#f6ecd8"/>
        <rect x="226" y="14" width="140" height="22" fill="#dcc59d"/>
        <path d="M226 22h140M226 29h140" stroke="#1d2b53" stroke-width="1.5"/>
        <path d="M226 112V14H366" fill="none" stroke="#1d2b53" stroke-width="3"/></g>
      <g class="van"><g transform="translate(236 44) scale(.95)">
        <rect x="10" y="12" width="66" height="42" rx="6" fill="#fbf4e6" stroke="#1d2b53" stroke-width="2.5"/>
        <rect x="10" y="40" width="66" height="5" fill="#1fae72"/>
        <g class="vanload">${box(16, -2, 18, 14)}${box(36, 0, 16, 12)}${box(54, -4, 18, 16)}</g>
        <path d="M78 24h17c3 0 5 1.5 6.5 4l6 10c1 1.6 1.5 3.4 1.5 5.2V50a4 4 0 0 1-4 4H78z" fill="#1fae72" stroke="#1d2b53" stroke-width="2.5"/>
        <path d="M84 28h10c1.6 0 2.8.7 3.6 2l4.2 7H84z" fill="#fbf4e6" stroke="#1d2b53" stroke-width="1.5"/>
        <g class="wheel"><circle cx="30" cy="56" r="9" fill="#1d2b53"/><circle cx="30" cy="56" r="3.5" fill="#fbf4e6"/></g>
        <g class="wheel"><circle cx="92" cy="56" r="9" fill="#1d2b53"/><circle cx="92" cy="56" r="3.5" fill="#fbf4e6"/></g>
      </g></g>
      <g class="walker"><g class="man">
        <g class="leg leg-b"><path d="M20 80v28" stroke="#2b3550" stroke-width="5" stroke-linecap="round"/><path d="M19 109.5h7" stroke="#1d2b53" stroke-width="4" stroke-linecap="round"/></g>
        <g class="cart">
          <path d="M37 66l13 40h12" stroke="#5b6270" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <g class="load">${box(45, 92, 18, 13)}${box(43, 79, 16, 13)}${box(44, 68, 13, 11)}</g>
          <g class="wheel"><circle cx="51" cy="107" r="5" fill="#1d2b53"/><circle cx="51" cy="107" r="1.8" fill="#fbf4e6"/></g>
        </g>
        <rect x="14" y="57" width="13" height="24" rx="4" fill="#c8382e" stroke="#1d2b53" stroke-width="2"/>
        <path d="M24 63l13 4" stroke="#c8382e" stroke-width="4.5" stroke-linecap="round"/>
        <circle cx="20" cy="50" r="7" fill="#f1c9a0" stroke="#1d2b53" stroke-width="2"/>
        <path d="M13 49a7 7 0 0 1 14 0z" fill="#c8382e" stroke="#1d2b53" stroke-width="1.5"/><rect x="25" y="46.5" width="7" height="2.5" rx="1" fill="#c8382e"/>
        <g class="leg leg-a"><path d="M20 80v28" stroke="#1d2b53" stroke-width="5" stroke-linecap="round"/><path d="M19 109.5h7" stroke="#1d2b53" stroke-width="4" stroke-linecap="round"/></g>
      </g></g>
    </svg>
  </div>`;
}

// Pauze: hetzelfde mannetje staat buiten tegen de loods te roken.
function breakSceneHtml() {
  return `
  <div class="card scene resting" aria-hidden="true">
    <svg viewBox="0 0 360 124" preserveAspectRatio="xMidYMax meet">
      <rect x="0" y="0" width="360" height="124" fill="#f3e6cc"/>
      <g class="cloud"><ellipse cx="250" cy="26" rx="22" ry="8" fill="#fbf4e6"/><ellipse cx="266" cy="22" rx="14" ry="8" fill="#fbf4e6"/></g>
      <g class="cloud c2"><ellipse cx="320" cy="44" rx="16" ry="6" fill="#fbf4e6"/></g>
      <circle cx="320" cy="20" r="10" fill="#f0b34a" opacity=".85"/>
      <rect x="0" y="10" width="170" height="102" fill="#dcc59d" stroke="#1d2b53" stroke-width="2.5"/>
      <path d="M0 34h170M0 58h170M0 82h170M40 10v24M100 10v24M70 34v24M130 34v24M40 58v24M100 58v24M70 82v30M130 82v30" stroke="#c4a979" stroke-width="1.5"/>
      <rect x="30" y="46" width="92" height="66" fill="#1d2b53"/>
      <rect x="30" y="46" width="92" height="30" fill="#efe2c8" stroke="#1d2b53" stroke-width="2"/>
      <path d="M30 56h92M30 66h92" stroke="#1d2b53" stroke-width="1.5"/>
      <rect x="138" y="20" width="24" height="16" fill="#1fae72" stroke="#1d2b53" stroke-width="2"/>
      <rect x="0" y="112" width="360" height="12" fill="#c9b48c"/>
      <path d="M0 112h360" stroke="#1d2b53" stroke-width="2"/>
      <g transform="translate(176 7)"><g class="smoker">
        <path d="M17 80v22M24 80v22" stroke="#1d2b53" stroke-width="5" stroke-linecap="round"/>
        <path d="M15 103h7M22 103h7" stroke="#1d2b53" stroke-width="4" stroke-linecap="round"/>
        <rect x="14" y="57" width="13" height="24" rx="4" fill="#c8382e" stroke="#1d2b53" stroke-width="2"/>
        <path d="M16 62l-3 14" stroke="#c8382e" stroke-width="4.5" stroke-linecap="round"/>
        <circle cx="20" cy="50" r="7" fill="#f1c9a0" stroke="#1d2b53" stroke-width="2"/>
        <path d="M13 49a7 7 0 0 1 14 0z" fill="#c8382e" stroke="#1d2b53" stroke-width="1.5"/><rect x="25" y="46.5" width="7" height="2.5" rx="1" fill="#c8382e"/>
        <g transform="translate(24 62)"><g class="ua">
          <path d="M0 0L4 9" stroke="#c8382e" stroke-width="4.5" stroke-linecap="round"/>
          <g transform="translate(4 9)"><g class="fa">
            <path d="M0 0L7 0" stroke="#c8382e" stroke-width="4.5" stroke-linecap="round"/>
            <path d="M7 0l5 -1" stroke="#fbf4e6" stroke-width="2.2" stroke-linecap="round"/><circle cx="12.5" cy="-1.1" r="1.4" fill="#e8742c"/>
          </g></g>
        </g></g>
        <g class="smoke"><circle cx="30" cy="50" r="3" fill="#c9c3b8"/><circle cx="33" cy="45" r="4" fill="#d6d1c7"/><circle cx="31" cy="38" r="5" fill="#e3dfd7"/></g>
        <g class="wisp"><circle cx="38" cy="64" r="1.6" fill="#d6d1c7"/></g>
      </g></g>
    </svg>
  </div>`;
}

function monthTotals() {
  const now = new Date();
  return totals(state.shifts.filter((x) => inRange(x, startOfMonth(now), addMonths(startOfMonth(now), 1))));
}

function renderToday() {
  const el = $('#view-today');
  const now = new Date();
  const s = activeShift();
  const onBreak = isOnBreak(s);
  const np = nextPlanned();

  const statusChip = !s ? '<span class="status idle">Niet aan<br>het werk</span>'
    : onBreak ? '<span class="status break">Pauze</span>' : '<span class="status working">Aan het<br>werk</span>';
  state.lastAnim = state.anim; state.anim = null;
  const nr = String(state.shifts.length + (s ? 0 : 1)).padStart(3, '0');

  let action;
  if (!s) {
    action = `
      <div class="card">
        <div class="card-head"><span>Dienst nr. ${nr}</span><span class="barcode"></span></div>
        ${statusChip}
        <p style="margin:0 120px 16px 0">Begin je met werken? Druk op inchecken.</p>
        <button class="big-btn in" data-act="checkin">
          <span><span class="lbl">Inchecken</span><small>Start je dienst nu</small></span>
          <span class="arrow" aria-hidden="true">→</span>
        </button>
      </div>`;
  } else {
    const startD = new Date(s.start);
    const startLabel = dateKey(startD) === dateKey(now) ? fTime(startD) : `${fShortDay(startD)} ${fTime(startD)}`;
    const w = wage(s);
    action = `
      <div class="card">
        <div class="card-head"><span>Dienst nr. ${nr}</span><span class="barcode"></span></div>
        ${statusChip}
        <div class="eyebrow">${onBreak ? 'Gewerkt · staat stil tijdens pauze' : 'Gewerkte tijd'}</div>
        <div class="timer num" data-live="paid">${fTimerHtml(paidMs(s))}</div>
        <button class="big-btn out" data-act="checkout" style="margin-top:16px">
          <span><span class="lbl">Uitchecken</span><small>Rond je dienst af</small></span>
          <span class="arrow" aria-hidden="true">✓</span>
        </button>
        <div class="btn-row" style="margin:12px 0 4px">
          ${onBreak
            ? '<button class="btn primary block" data-act="stopbreak">Pauze stoppen</button>'
            : '<button class="btn amber block" data-act="startbreak">Pauze starten</button>'}
        </div>
        <label class="travel-btn">
          <span class="switch"><input type="checkbox" id="travel-toggle" ${travel(s) ? 'checked' : ''} aria-label="Rijkosten voor deze dienst"><span class="track"></span></span>
          <span class="tb-text"><span class="tb-off">Rijkosten aanzetten</span><span class="tb-on">Rijkosten staan aan</span><span class="s">${hasTravel() ? fEuro(state.settings.travel) + ' voor deze dienst' : 'Stel eerst een bedrag in bij Instellingen'}</span></span>
        </label>
        <div class="facts">
          <div class="fact"><span>Begin</span><span class="v num">${startLabel}</span></div>
          <div class="fact"><span>Pauze</span><span class="v num" data-live="break">${fDur(breakMs(s))}</span></div>
          <div class="fact"><span>Tot nu</span><span class="v num" data-live="wage">${w != null ? fEuro(w) : '–'}</span></div>
        </div>
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
        <div class="card-head"><span>Volgende dienst</span><span>${isNow ? 'Nu' : 'Gepland'}</span></div>
        <div class="next">
          <span class="pin" aria-hidden="true"><span>${fShortDay(st)}</span><b>${st.getDate()}</b></span>
          <div>
            <div class="when">${dayLabel}</div>
            <div class="muted num small">${fTime(np.start)} – ${fTime(np.end)}${np.overnight ? ' (volgende dag)' : ''} · ${fDur(np.end - np.start)} uur</div>
          </div>
          <span></span>
        </div>
      </div>`;
  } else {
    npHtml = `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div><div class="eyebrow">Volgende dienst</div><div class="muted small" style="margin-top:4px">Nog niets ingepland.</div></div>
        <button class="btn small" data-go="schedule">Plannen</button>
      </div>`;
  }

  const showInstall = !isStandalone() && !state.settings.installHintDismissed;
  el.innerHTML = `
    <div class="greet">
      <div class="greet-top"><h1>Hoi Sven</h1><span class="barcode light"></span></div>
      <div class="date">${capital(fLongDate(now))}</div>
    </div>
    ${sceneHtml([!s ? 'idle' : onBreak ? 'resting' : 'walking', state.lastAnim || ''].join(' '))}
    ${!hasRate() ? `
      <div class="notice">
        <div class="grow"><b>Vul je uurloon in</b><br><span class="small">Dan rekent de app je verwachte bruto loon uit.</span></div>
        <button class="btn small navy" data-go="settings">Instellen</button>
      </div>` : ''}
    ${showInstall ? `
      <div class="notice info">
        <div class="grow"><b>Zet de app op je beginscherm</b><br><span class="small">Dan open je hem met één tik.</span></div>
        <button class="btn small navy" data-act="install-help">Hoe?</button>
      </div>` : ''}
    ${action}
    ${npHtml}
    <div class="card tape" id="month-card">${monthCardInner()}</div>
  `;
}

function monthCardInner() {
  const now = new Date();
  const t = monthTotals();
  const monthShifts = state.shifts.filter((x) => inRange(x, startOfMonth(now), addMonths(startOfMonth(now), 1))).sort((a, b) => a.start - b.start);
  const boxes = monthShifts.slice(-18).map((s) => `<i class="box${s.end == null ? ' live' : ''}"></i>`).join('');
  return `
    <div class="card-head">
      <span>Deze maand · ${fMonth(now)}</span>
      <div class="stack" aria-label="${plural(t.count, 'dienst', 'diensten')}">${boxes}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="label">Gewerkte uren</div><div class="value num" data-live="month-hours">${fDur(t.ms)}</div></div>
      <div class="stat"><div class="label">Verwacht bruto loon</div><div class="value green num" data-live="month-wage">${hasRate() || t.money > 0 ? fEuro(t.money) : '–'}</div></div>
    </div>
    ${t.travel > 0 ? `
      <div class="sum-lines">
        <div class="sum-line"><span>Rijkosten (${plural(t.travelCount, 'dienst', 'diensten')})</span><b>${fEuro(t.travel)}</b></div>
        <div class="sum-line total"><span>Samen</span><b data-live="month-total">${fEuro(t.money + t.travel)}</b></div>
      </div>` : ''}
    ${t.missingRate ? `<p class="hint warn" style="margin:10px 0 0">${plural(t.missingRate, 'dienst heeft', 'diensten hebben')} nog geen uurloon en ${t.missingRate === 1 ? 'telt' : 'tellen'} niet mee.</p>` : ''}
    ${t.count === 0 ? '<p class="muted small" style="margin:10px 0 0">Nog geen diensten deze maand. Ze verschijnen hier zodra je incheckt.</p>' : ''}
    <p class="disclaimer">Indicatie, exclusief toeslagen, vakantiegeld en inhoudingen.</p>`;
}
function renderTodayMonth() { const c = $('#month-card'); if (c) c.innerHTML = monthCardInner(); }

function updateLive() {
  if (state.view !== 'today' || document.hidden) return;
  const s = activeShift();
  if (!s) return;
  const set = (k, v, html) => { const e = document.querySelector(`[data-live="${k}"]`); if (e) e[html ? 'innerHTML' : 'textContent'] = v; };
  set('paid', fTimerHtml(paidMs(s)), true);
  set('break', fDur(breakMs(s)));
  const w = wage(s); if (w != null) set('wage', fEuro(w));
  const t = monthTotals();
  set('month-hours', fDur(t.ms));
  if (hasRate() || t.money > 0) set('month-wage', fEuro(t.money));
  set('month-total', fEuro(t.money + t.travel));
}

function shiftRow(s) {
  const st = new Date(s.start);
  const live = s.end == null;
  const endD = live ? null : new Date(s.end);
  const overnight = endD && dateKey(endD) !== dateKey(st);
  const w = wage(s);
  const tr = travel(s);
  return `
    <button class="shift${live ? ' live' : ''}" data-shift="${esc(s.id)}">
      <div class="date-badge"><b>${st.getDate()}</b><span>${fShortDay(st)}</span></div>
      <div class="main">
        <div class="t num">${fTime(st)} – ${live ? '<span class="tag green">bezig</span>' : fTime(endD) + (overnight ? ' <span class="tag">+1</span>' : '')}</div>
        <div class="s num">Pauze ${fDur(breakMs(s))} · ${s.rate != null ? fEuro(s.rate) + '/u' : '<span style="color:#8a5500">geen uurloon</span>'}${tr ? ' · rijk. ' + fEuro(tr) : ''}</div>
      </div>
      <div class="right">
        <div class="h num">${fDur(paidMs(s))}</div>
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
    sub = plural(state.shifts.filter((s) => inRange(s, from, to)).length, 'dienst', 'diensten');
  }
  const list = state.shifts.filter((s) => inRange(s, from, to)).sort((a, b) => b.start - a.start);
  const t = totals(list);

  let listHtml = '';
  if (!list.length) {
    listHtml = `<div class="empty">${EMPTY_BOX}<b style="color:var(--navy)">Nog niets deze ${mode === 'week' ? 'week' : 'maand'}</b><br><span class="small">Vergeten in te checken? Tik op <b>+ Dienst</b>.</span></div>`;
  } else if (mode === 'month') {
    const groups = new Map();
    for (const s of list) {
      const k = +startOfWeek(new Date(s.start));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [k, items] of groups) {
      const gt = totals(items);
      listHtml += `<div class="group-head"><b>Week ${weekNumber(new Date(k))}</b><span class="num">${fDur(gt.ms)} uur · ${fEuro(gt.money)}</span></div>`;
      listHtml += `<div class="list">${items.map(shiftRow).join('')}</div>`;
    }
  } else {
    listHtml = `<div class="list">${list.map(shiftRow).join('')}</div>`;
  }

  el.innerHTML = `
    <div class="page-head"><h1>Uren</h1><button class="btn small navy" data-act="add-shift">+ Dienst</button></div>
    <div class="seg ${mode === 'month' ? 'month' : ''}" role="tablist">
      <button data-mode="week" aria-selected="${mode === 'week'}">Week</button>
      <button data-mode="month" aria-selected="${mode === 'month'}">Maand</button>
    </div>
    <div class="period">
      <button class="icon-btn" data-period="-1" aria-label="Vorige">‹</button>
      <div class="label">${label}<small>${sub}</small></div>
      <button class="icon-btn" data-period="1" aria-label="Volgende">›</button>
    </div>
    <div class="card tape">
      <div class="stats">
        <div class="stat"><div class="label">Betaalde uren</div><div class="value num">${fDur(t.ms)}</div></div>
        <div class="stat"><div class="label">Verwacht bruto loon</div><div class="value green num">${fEuro(t.money)}</div></div>
      </div>
      <div class="sum-lines">
        <div class="sum-line"><span>Diensten</span><b>${t.count}</b></div>
        ${t.travel > 0 ? `<div class="sum-line"><span>Rijkosten</span><b>${fEuro(t.travel)}</b></div>
        <div class="sum-line total"><span>Samen</span><b>${fEuro(t.money + t.travel)}</b></div>` : ''}
      </div>
      ${t.missingRate ? `<p class="hint warn" style="margin:8px 0 0">${plural(t.missingRate, 'dienst', 'diensten')} zonder uurloon ${t.missingRate === 1 ? 'telt' : 'tellen'} niet mee in het loon. Tik erop om er een in te vullen.</p>` : ''}
      <p class="disclaimer">Pauzes zijn eraf gehaald. Indicatie, exclusief toeslagen, vakantiegeld en inhoudingen.</p>
    </div>
    <button class="btn navy block" data-act="report" style="margin-bottom:18px">⤓ Overzicht downloaden voor je baas</button>
    ${listHtml}
    ${list.length ? '<p class="muted tiny" style="text-align:center;margin-top:14px">Tik op een dienst om hem aan te passen of te verwijderen.</p>' : ''}
  `;
}

function renderSchedule() {
  const el = $('#view-schedule');
  const { month, selected } = state.schedule;
  const todayK = dateKey(new Date());
  const gridStart = startOfWeek(month);
  const plannedByDay = new Set(state.planned.map((p) => p.date));
  const workedByDay = new Set(state.shifts.map((s) => dateKey(s.start)));

  let cells = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 40; i++) {
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

    <div class="card flat">
      <div class="card-head" style="margin-bottom:10px"><h2 style="margin:0">${capital(fLongDate(selDate))}</h2></div>
      <div class="list" style="margin-bottom:12px">
        ${dayWorked.map(shiftRow).join('')}
        ${dayPlanned.map((p) => plannedRow(p)).join('')}
        ${!dayWorked.length && !dayPlanned.length ? '<p class="muted small" style="margin:0">Niets gepland of gewerkt op deze dag.</p>' : ''}
      </div>
      <button class="btn block" data-act="add-plan-day">+ Dienst plannen op deze dag</button>
    </div>

    <h2 style="margin:22px 4px 12px">Komende diensten</h2>
    <div class="list">
      ${upcoming.length ? upcoming.map((x) => plannedRow(x.p, true)).join('') : `<div class="empty">${EMPTY_BOX}<b style="color:var(--navy)">Nog niets gepland</b><br><span class="small">Zet je rooster erin, dan zie je op het startscherm wanneer je weer moet werken.</span></div>`}
    </div>
    <p class="muted tiny" style="margin:14px 4px 0">Geplande diensten tellen niet mee als gewerkte uren. Check in als je echt begint.</p>
  `;
}

function plannedRow(p, showDate = false) {
  const r = plannedRange(p);
  const st = new Date(r.start);
  return `
    <button class="shift planned" data-plan="${esc(p.id)}">
      <div class="date-badge"><b>${st.getDate()}</b><span>${fShortDay(st)}</span></div>
      <div class="main">
        <div class="t num">${fTime(r.start)} – ${fTime(r.end)}${r.overnight ? ' <span class="tag">+1</span>' : ''}</div>
        <div class="s">${showDate ? capital(fLongDate(st)) : 'Gepland'}</div>
      </div>
      <div class="right"><span class="tag">Gepland</span><div class="h num small" style="margin-top:4px;font-size:15px">${fDur(r.end - r.start)}</div></div>
    </button>`;
}

async function renderSettings() {
  const el = $('#view-settings');
  const ios = isIOS();
  el.innerHTML = `
    <div class="page-head"><h1>Instellingen</h1></div>

    <div class="card tape">
      <h2>Loon en rijkosten</h2>
      <label class="field"><span>Bruto uurloon</span>
        <div class="euro-input"><input id="rate" class="input num" inputmode="decimal" autocomplete="off" placeholder="bijv. 12,50" value="${fEuroInput(state.settings.rate)}"></div>
      </label>
      <p class="hint">Staat op je contract of loonstrook. Een nieuw uurloon geldt alleen voor nieuwe diensten.</p>
      <label class="field"><span>Standaard rijkosten per dienst</span>
        <div class="euro-input"><input id="travel" class="input num" inputmode="decimal" autocomplete="off" placeholder="bijv. 5,00" value="${fEuroInput(state.settings.travel)}"></div>
      </label>
      <p class="hint">Staat bij elke dienst standaard uit. Zet het per dienst aan met de schakelaar als je rijkosten hebt gemaakt.</p>
      <div id="rate-error" class="error" hidden></div>
      <button class="btn primary block" data-act="save-rate">Opslaan</button>
    </div>

    <div class="card">
      <h2>Zo wordt het berekend</h2>
      <p class="small">Gewerkte tijd min onbetaalde pauzes, keer het uurloon dat bij die dienst hoort. De app rekent met de echte minuten en rondt alleen af bij het tonen. Rijkosten worden apart opgeteld.</p>
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

    <p class="muted tiny" style="text-align:center">Sven z'n uren · versie ${APP_VERSION}<br>${plural(state.shifts.length, 'dienst', 'diensten')} · ${plural(state.planned.length, 'geplande dienst', 'geplande diensten')}</p>
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

// ---------- sheet & dialogen ----------
function openSheet(html, mount) {
  const sheet = $('#sheet');
  sheet.innerHTML = html;
  sheet.hidden = false;
  $('#sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  if (mount) mount(sheet);
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
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
  t.hidden = true; void t.offsetWidth; // animatie opnieuw starten
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="toast-btn">↺ ${esc(action.label)}</button>` : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
}

// ---------- dienst toevoegen / aanpassen ----------
function overlapping(start, end, ignoreId) {
  const now = Date.now();
  return state.shifts.find((s) => s.id !== ignoreId && start < (s.end ?? now) && end > s.start) || null;
}

function openShiftForm(existing) {
  const isNew = !existing;
  const s = existing || null;
  const date = s ? dateKey(s.start) : dateKey(new Date());
  const startT = s ? fTime(s.start) : '';
  const endT = s ? fTime(s.end) : '';
  const breakMin = s ? Math.round(breakMs(s) / MIN) : 0;
  const rate = s ? s.rate : (hasRate() ? state.settings.rate : null);
  const trOn = s ? travel(s) > 0 : false; // nieuw: standaard uit
  const trAmount = s && travel(s) ? s.travel : state.settings.travel;

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
        <label class="field"><span>Pauze (min)</span><input class="input num" type="number" name="pause" min="0" step="1" inputmode="numeric" value="${breakMin}"></label>
        <label class="field"><span>Uurloon</span><div class="euro-input"><input class="input num" name="rate" inputmode="decimal" placeholder="12,50" value="${fEuroInput(rate)}"></div></label>
      </div>
      <label class="switch-row" style="margin-bottom:10px">
        <span><span class="t">Rijkosten</span><br><span class="s">Voor deze dienst</span></span>
        <span class="switch"><input type="checkbox" name="travelOn" ${trOn ? 'checked' : ''} aria-label="Rijkosten voor deze dienst"><span class="track"></span></span>
      </label>
      <label class="field" id="travel-field" ${trOn ? '' : 'hidden'}><span>Bedrag rijkosten</span><div class="euro-input"><input class="input num" name="travel" inputmode="decimal" placeholder="5,00" value="${fEuroInput(trAmount)}"></div></label>
      <div class="preview">
        <div class="sum-line"><span>Betaalde tijd</span><b id="pv-hours">–</b></div>
        <div class="sum-line"><span>Verwacht bruto loon</span><b id="pv-wage">–</b></div>
        <div class="sum-line" id="pv-travel-row" hidden><span>Rijkosten</span><b id="pv-travel">–</b></div>
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
      const travelOn = f.get('travelOn') === 'on';
      const travelAmt = travelOn ? parseEuro(f.get('travel') || '') : null;
      const base = { pause, rate: r, travelOn, travelAmt };
      if (!d || !st || !en) return { incomplete: true, ...base };
      // Ongewijzigde velden: houd de exacte geregistreerde tijdstempels (tot op de seconde).
      if (s && d === date && st === startT && en === endT) return { start: s.start, end: s.end, overnight: dateKey(s.end) !== dateKey(s.start), ...base };
      return { ...rangeFromInputs(d, st, en), ...base };
    };
    const preview = () => {
      const v = read();
      $('#travel-field', sheet).hidden = !v.travelOn;
      $('#pv-travel-row', sheet).hidden = !v.travelOn;
      $('#pv-travel', sheet).textContent = v.travelOn && v.travelAmt > 0 ? fEuro(v.travelAmt) : '–';
      $('#overnight-hint', sheet).hidden = !v.overnight;
      if (v.incomplete || !(v.pause >= 0)) { $('#pv-hours', sheet).textContent = '–'; $('#pv-wage', sheet).textContent = '–'; return; }
      const ms = Math.max(0, v.end - v.start - v.pause * MIN);
      $('#pv-hours', sheet).textContent = fDur(ms) + ' uur';
      $('#pv-wage', sheet).textContent = v.rate != null && v.rate > 0 ? fEuro((ms / HOUR) * v.rate) : 'geen uurloon';
    };
    form.addEventListener('input', preview);
    form.addEventListener('change', preview);
    preview();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = read();
      const err = (m) => { const x = $('#form-error', sheet); x.hidden = true; void x.offsetWidth; x.textContent = m; x.hidden = false; };
      if (v.incomplete) return err('Vul een datum, begintijd en eindtijd in.');
      if (!Number.isFinite(v.pause) || v.pause < 0 || !Number.isInteger(v.pause)) return err('Vul de pauze in als een heel aantal minuten (0 of meer).');
      if (v.rate !== null && !(v.rate > 0 && v.rate < 1000)) return err('Vul een geldig uurloon in, bijvoorbeeld 12,50. Of laat het leeg.');
      if (v.travelOn && !(v.travelAmt > 0 && v.travelAmt < 1000)) return err('Vul een geldig bedrag voor de rijkosten in, of zet ze uit.');
      if (v.end - v.start > 24 * HOUR) return err('Een dienst kan niet langer dan 24 uur duren.');
      if (v.pause * MIN >= v.end - v.start) return err('De pauze is langer dan de dienst zelf.');
      if (v.end > Date.now()) return err('Deze dienst eindigt in de toekomst. Zet toekomstige diensten in het Rooster.');
      const ov = overlapping(v.start, v.end, s && s.id);
      if (ov) return err(`Deze tijden overlappen met je dienst van ${fLongDate(new Date(ov.start))} (${fTime(ov.start)}${ov.end ? ' – ' + fTime(ov.end) : ''}).`);

      const next = s ? { ...s } : { id: uid(), breaks: [], createdAt: Date.now(), manual: true };
      next.start = v.start;
      next.end = v.end;
      next.rate = v.rate;
      next.travel = v.travelOn ? Math.round(v.travelAmt * 100) / 100 : null;
      // Zijn de tijden en de pauze niet veranderd, dan blijven de precies geregistreerde pauzes staan.
      const timesSame = s && v.start === s.start && v.end === s.end;
      if (!s || v.pause !== breakMin || !timesSame) { next.breakMs = v.pause * MIN; next.breaks = []; }
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
      // Ongewijzigd: exacte tijdstempel houden.
      const start = (f.get('date') === dateKey(s.start) && f.get('start') === fTime(s.start)) ? s.start : toStamp(f.get('date'), f.get('start'));
      if (start > Date.now()) return err('De begintijd kan niet in de toekomst liggen.');
      if (Date.now() - start > 24 * HOUR) return err('De begintijd ligt meer dan 24 uur geleden.');
      if (overlapping(start, Date.now(), s.id)) return err('Deze begintijd overlapt met een eerdere dienst.');
      if ((s.breaks || []).some((b) => b.start < start)) return err('Er is al een pauze vóór deze begintijd geregistreerd.');
      await saveShift({ ...s, start, updatedAt: Date.now() });
      closeSheet(); toast('Begintijd aangepast.'); render();
    });
    $('[data-act="cancel-active"]', sheet).addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Dienst annuleren?', text: 'De huidige dienst wordt verwijderd en telt niet mee. Weet je het zeker?', ok: 'Ja, annuleren', danger: true });
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

// ---------- instellingen: uurloon, rijkosten, export, import ----------
async function saveRate() {
  const errEl = $('#rate-error');
  const fail = (m) => { errEl.hidden = true; void errEl.offsetWidth; errEl.textContent = m; errEl.hidden = false; };
  const rateRaw = $('#rate').value.trim();
  const travelRaw = $('#travel').value.trim();
  const n = rateRaw === '' ? null : parseEuro(rateRaw);
  const tr = travelRaw === '' ? null : parseEuro(travelRaw);
  if (n !== null && !(n > 0 && n < 1000)) return fail('Vul een geldig bruto uurloon in, bijvoorbeeld 12,50.');
  if (tr !== null && !(tr > 0 && tr < 1000)) return fail('Vul geldige rijkosten in, bijvoorbeeld 5,00. Of laat het leeg.');
  const rounded = n === null ? null : Math.round(n * 100) / 100;
  const rateChanged = state.settings.rate !== rounded;
  state.settings.rate = rounded;
  state.settings.travel = tr === null ? null : Math.round(tr * 100) / 100;
  await saveSettings();
  askPersist();
  if (rounded !== null) {
    // Lopende dienst zonder uurloon krijgt het nieuwe uurloon.
    const a = activeShift();
    if (a && a.rate == null) await db.put('shifts', { ...a, rate: rounded });
    await loadAll();
    const missing = state.shifts.filter((s) => s.rate == null);
    if (missing.length) {
      const ok = await confirmDialog({
        title: 'Ook voor eerdere diensten?',
        text: `${plural(missing.length, 'dienst heeft', 'diensten hebben')} nog geen uurloon. Wil je daar ${fEuro(rounded)} voor gebruiken? Diensten met een eigen uurloon blijven zoals ze zijn.`,
        ok: 'Ja, toepassen'
      });
      if (ok) { for (const s of missing) await db.put('shifts', { ...s, rate: rounded }); await loadAll(); }
    }
  }
  toast(rateChanged && rounded !== null ? `Opgeslagen. ${fEuro(rounded)} geldt voor nieuwe diensten.` : 'Opgeslagen.');
  render();
}

// ---------- urenoverzicht als afbeelding (voor de werkgever) ----------
function currentPeriod() {
  const { mode, anchor } = state.hours;
  if (mode === 'week') {
    const from = startOfWeek(anchor), to = addDays(from, 7);
    return { from, to, title: `Week ${weekNumber(from)}`, sub: `${fDayMonth(from)} – ${fDayMonth(addDays(to, -1))} ${addDays(to, -1).getFullYear()}`, file: `week-${weekNumber(from)}-${from.getFullYear()}` };
  }
  const from = startOfMonth(anchor), to = addMonths(from, 1);
  return { from, to, title: capital(fMonthYear(from)), sub: '', file: `${fMonth(from)}-${from.getFullYear()}` };
}

// Zelf kiezen van welke tot welke datum het overzicht gaat.
function openReportForm() {
  const per = currentPeriod();
  openSheet(`
    <h2>Overzicht downloaden</h2>
    <form id="report-form" novalidate>
      <div class="row2">
        <label class="field"><span>Vanaf</span><input class="input" type="date" name="from" value="${dateKey(per.from)}"></label>
        <label class="field"><span>Tot en met</span><input class="input" type="date" name="to" value="${dateKey(addDays(per.to, -1))}"></label>
      </div>
      <p class="hint">Alle afgeronde diensten die in deze periode beginnen. Alleen tijden, geen bedragen.</p>
      <div class="error" id="form-error" hidden></div>
      <button class="btn primary block" type="submit">Downloaden</button>
      <button class="btn ghost block" type="button" data-act="close-sheet" style="margin-top:6px">Annuleren</button>
    </form>`, (sheet) => {
    $('#report-form', sheet).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const err = (m) => { const x = $('#form-error', sheet); x.textContent = m; x.hidden = false; };
      if (!f.get('from') || !f.get('to')) return err('Kies een begin- en einddatum.');
      const from = new Date(toStamp(f.get('from'), '00:00'));
      const last = new Date(toStamp(f.get('to'), '00:00'));
      if (last < from) return err('De einddatum ligt vóór de begindatum.');
      const to = addDays(last, 1);
      const same = +from === +per.from && +to === +per.to;
      const custom = same ? per : {
        from, to,
        title: from.getFullYear() === last.getFullYear() ? `${fDayMonth(from)} – ${fDayMonth(last)} ${last.getFullYear()}` : `${fDateYear(from)} – ${fDateYear(last)}`,
        sub: '', file: `${f.get('from')}-tot-${f.get('to')}`
      };
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try { await makeReport(custom); } finally { btn.disabled = false; }
      closeSheet();
    });
  });
}

async function makeReport(per = currentPeriod()) {
  const list = state.shifts.filter((x) => x.end != null && inRange(x, per.from, per.to)).sort((a, b) => a.start - b.start);
  if (!list.length) { toast('Geen afgeronde diensten in deze periode.'); return; }
  try { await Promise.all(['900 40px Rubik', '700 20px "Courier Prime"', '400 20px "Courier Prime"'].map((f) => document.fonts.load(f))); } catch (_) {}
  const t = totals(list);
  const anyTravel = false; // alleen tijden op het overzicht, geen bedragen
  const W = 1240, P = 80, RH = 64;
  const H = 480 + list.length * RH + 300;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const INK = '#1d2b53', PAPER = '#fbf4e6', LINE = '#d9c6a3', MINT = '#1fae72', MUTED = '#7a6f5c';
  const D = (w, sz) => `${w} ${sz}px Rubik, sans-serif`;
  const M = (w, sz) => `${w} ${sz}px "Courier Prime", monospace`;
  const dashed = (y, col = LINE, w = 2) => { g.save(); g.setLineDash([12, 9]); g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(P, y); g.lineTo(W - P, y); g.stroke(); g.restore(); };
  const solid = (y, w = 4) => { g.fillStyle = INK; g.fillRect(P, y, W - 2 * P, w); };

  g.fillStyle = '#e9d6b4'; g.fillRect(0, 0, W, H);
  g.fillStyle = PAPER; g.fillRect(36, 36, W - 72, H - 72);
  // kop
  g.fillStyle = INK; g.fillRect(36, 36, W - 72, 210);
  g.fillStyle = PAPER; g.font = M(700, 22); g.fillText('URENOVERZICHT', P, 104);
  g.font = D(900, 72); g.fillText('Sven', P, 186);
  g.font = M(400, 26); g.fillText(`${per.title}${per.sub ? '  ·  ' + per.sub : ''}`, P, 226);
  // streepjescode
  let bx = W - P - 262;
  for (let i = 0; i < 40; i++) { const w = [2, 4, 2, 6, 3][i % 5]; g.fillRect(bx, 82, w, 52); bx += w + 3; }
  // stempel met totaal
  g.save(); g.translate(W - P - 110, 336); g.rotate(-0.2);
  g.strokeStyle = MINT; g.lineWidth = 6; g.beginPath(); g.arc(0, 0, 92, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 80, 0, Math.PI * 2); g.stroke();
  g.fillStyle = MINT; g.textAlign = 'center'; g.font = D(900, 48); g.fillText(fDur(t.ms), 0, 10);
  g.font = D(800, 18); g.fillText('UUR GEWERKT', 0, 42); g.restore(); g.textAlign = 'left';
  // samenvatting
  g.fillStyle = INK; g.font = M(700, 22); g.fillText(`${plural(t.count, 'DIENST', 'DIENSTEN')}`, P, 300);
  g.font = M(400, 22); g.fillStyle = MUTED; g.fillText('Tijden zoals door Sven zelf geregistreerd.', P, 334);
  g.fillText('Betaalde uren = eindtijd − begintijd − onbetaalde pauze.', P, 364);
  // tabel
  const cols = anyTravel
    ? [['DATUM', P], ['BEGIN', 430], ['EIND', 580], ['PAUZE', 730], ['UREN', 900], ['RIJKOSTEN', W - P]]
    : [['DATUM', P], ['BEGIN', 470], ['EIND', 640], ['PAUZE', 820], ['UREN', W - P]];
  let y = 480;
  g.font = M(700, 20); g.fillStyle = INK;
  cols.forEach(([n, x], i) => { g.textAlign = i === cols.length - 1 ? 'right' : 'left'; g.fillText(n, x, y); });
  g.textAlign = 'left'; solid(y + 16);
  y += 16;
  for (const s of list) {
    y += RH;
    const st = new Date(s.start), en = new Date(s.end);
    const over = dateKey(en) !== dateKey(st);
    const cells = [`${fShortDay(st)} ${fDayMonth(st)}`, fTime(st), fTime(en) + (over ? ' +1' : ''), fDur(breakMs(s)), fDur(paidMs(s))];
    if (anyTravel) cells.push(travel(s) ? fEuro(travel(s)) : '–');
    cells.forEach((v, i) => {
      const last = i === cells.length - 1;
      g.textAlign = last ? 'right' : 'left';
      g.font = i === 4 ? D(800, 28) : (i === 0 ? M(700, 26) : M(400, 26));
      g.fillStyle = INK;
      g.fillText(v, cols[i][1], y - 20);
    });
    g.textAlign = 'left';
    dashed(y);
  }
  // totaal
  y += 20; solid(y); solid(y + 8, 2);
  y += 70;
  g.font = D(900, 34); g.fillStyle = INK; g.fillText('Totaal', P, y);
  g.textAlign = 'right'; g.fillText(`${fDur(t.ms)} uur`, anyTravel ? 900 + 90 : W - P, y);
  if (anyTravel) { g.fillText(fEuro(t.travel), W - P, y); }
  g.textAlign = 'left';
  y += 44; g.font = M(400, 22); g.fillStyle = MUTED;
  g.fillText(`Totaal in decimalen: ${(Math.round(t.ms / MIN) / 60).toFixed(2).replace('.', ',')} uur`, P, y);
  if (anyTravel) { y += 32; g.fillText(`Rijkosten: ${plural(t.travelCount, 'dienst', 'diensten')}`, P, y); }
  // voet
  g.font = M(400, 20); g.fillStyle = MUTED;
  g.fillText(`Gemaakt op ${fLongDate(new Date())} ${new Date().getFullYear()} met Sven z'n uren`, P, H - 76);

  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const name = `uren-sven-${per.file}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: `Uren Sven · ${per.title}` }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('Overzicht gedownload.');
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
    text: `In deze reservekopie staan ${plural(d.shifts.length, 'dienst', 'diensten')} en ${plural(d.planned.length, 'geplande dienst', 'geplande diensten')} (gemaakt op ${fDateYear(new Date(d.exportedAt))}). <b>Alles wat nu in de app staat wordt vervangen.</b>`,
    ok: 'Terugzetten', danger: true
  });
  if (!ok) return;
  const settings = (Array.isArray(d.settings) ? d.settings : []).filter((x) => x && x.key === 'settings');
  await db.replaceAll({ shifts: d.shifts, planned: d.planned, settings: settings.length ? settings : [{ key: 'settings', rate: null }] });
  state.settings = { key: 'settings', rate: null, travel: null, installHintDismissed: false };
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
  if (m) {
    if (state.hours.mode === m.dataset.mode) return;
    state.hours.mode = m.dataset.mode;
    $('.seg')?.classList.toggle('month', state.hours.mode === 'month');
    setTimeout(render, 160); // eerst het schuifje laten bewegen
    return;
  }
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
    case 'report': return openReportForm();
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
  if (e.target.id === 'travel-toggle') toggleTravel(e.target.checked);
});
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// Niet inzoomen: knijpen en dubbeltikken blokkeren (naast de viewport-instelling).
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd < 320 && !e.target.closest('input, textarea, select')) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

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
