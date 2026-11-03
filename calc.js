// Rekenregels. Alles werkt met echte tijdstempels in milliseconden;
// afronden gebeurt alleen bij het tonen.
export const MIN = 60000;
export const HOUR = 3600000;

// Totale pauze van een dienst (ms).
export function breakMs(shift, now = Date.now()) {
  // breakMs = handmatig ingevulde pauze; breaks = geregistreerde pauzes (komen erbij).
  const shiftEnd = shift.end ?? now;
  let total = typeof shift.breakMs === 'number' ? Math.max(0, shift.breakMs) : 0;
  for (const b of shift.breaks || []) {
    const s = Math.max(b.start, shift.start);
    const e = Math.min(b.end ?? now, shiftEnd);
    if (e > s) total += e - s;
  }
  return total;
}

// Betaalde tijd (ms) = eindtijd - begintijd - onbetaalde pauze.
export function paidMs(shift, now = Date.now()) {
  const end = shift.end ?? now;
  return Math.max(0, end - shift.start - breakMs(shift, now));
}

// Verwacht bruto loon met het uurloon dat bij deze dienst is opgeslagen.
export function wage(shift, now = Date.now()) {
  if (typeof shift.rate !== 'number' || !(shift.rate > 0)) return null;
  return (paidMs(shift, now) / HOUR) * shift.rate;
}

export function isOnBreak(shift) {
  return !!(shift && shift.end == null && (shift.breaks || []).some((b) => b.end == null));
}

// Rijkosten van een dienst: alleen als ze voor die dienst zijn aangezet.
export function travel(shift) {
  return typeof shift.travel === 'number' && shift.travel > 0 ? shift.travel : 0;
}

export function totals(shifts, now = Date.now()) {
  let ms = 0, money = 0, missingRate = 0, travelSum = 0, travelCount = 0;
  for (const s of shifts) {
    ms += paidMs(s, now);
    const t = travel(s);
    if (t) { travelSum += t; travelCount++; }
    const w = wage(s, now);
    if (w == null) missingRate++; else money += w;
  }
  return { ms, money, missingRate, count: shifts.length, travel: travelSum, travelCount };
}

// ---- periodes (lokale tijd, week begint op maandag) ----
export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function startOfWeek(d) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // maandag = 0
  x.setDate(x.getDate() - day);
  return x;
}
export function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function addMonths(d, n) { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; }

export function inRange(shift, from, to) { return shift.start >= +from && shift.start < +to; }

// ISO-weeknummer
export function weekNumber(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - yearStart) / 86400000 + 1) / 7);
}

// Datum (YYYY-MM-DD) + tijd (HH:MM) -> tijdstempel in lokale tijd
export function toStamp(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi, 0, 0).getTime();
}

// Begin + eind op een datum; als eind <= begin, eindigt de dienst de volgende dag.
export function rangeFromInputs(dateStr, startStr, endStr) {
  const start = toStamp(dateStr, startStr);
  let end = toStamp(dateStr, endStr);
  let overnight = false;
  if (end <= start) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [h, mi] = endStr.split(':').map(Number);
    end = new Date(y, m - 1, d + 1, h, mi, 0, 0).getTime();
    overnight = true;
  }
  return { start, end, overnight };
}

export function dateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function timeKey(d) {
  const x = new Date(d);
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}
