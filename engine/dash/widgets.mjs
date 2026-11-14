// META-TEND (REPORT s.5.3): the shared chart widgets, built once - `meter` (one value against a max), `bars` (a ranked list, one horizontal bar each), `columns` (one
// value over time, a column per point) and `stack` (one bar split into its parts + a legend). Pure: data -> HTML on the palette's
// CSS variables (index.html .wbars / .wcols / .wstack); every chart carries its numbers as text and an aria-label.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = v => typeof v === 'number' && Number.isFinite(v);
const w = (v, max) => (fin(v) && max > 0 ? Math.max(0, Math.min(100, 100 * v / max)).toFixed(1) : '0');

/** rows [{ label, value, note?, cls? }] -> a ranked list; fmt(value) the number shown; max (default the largest value) */
export function bars(rows, { fmt = String, max, id = '' } = {}) {
  const m = max ?? Math.max(0, ...rows.map(r => (fin(r.value) ? r.value : 0)));
  return `<ol class="wbars"${id ? ` id="${esc(id)}"` : ''}>${rows.map(r => `<li><div class="wbl"><span class="wbn">${esc(r.label)}</span><b class="mono">${esc(fmt(r.value))}</b></div>
    <div class="bar ${esc(r.cls ?? '')}"><i style="width:${w(r.value, m)}%"></i></div>${r.note ? `<div class="small mute wbnote">${r.note}</div>` : ''}</li>`).join('')}</ol>`;
}

/** one value against a max -> a single bar, an optional tick at `mark` (a p90, a hand-off line); no data = a dash */
export function meter(v, max, mark, cls = '') {
  if (!fin(v) || !fin(max) || max <= 0) return '<span class="mute">-</span>';
  return `<div class="bar ${esc(cls)}" title="${esc(v)} of ${esc(max)}"><i style="width:${Math.min(100, 100 * v / max).toFixed(1)}%"></i>${fin(mark) ? `<u style="left:${Math.min(100, 100 * mark / max).toFixed(1)}%"></u>` : ''}</div>`;
}

/** points [{ label, value, cls? }] in time order -> one column each, the first / last labels under the axis */
export function columns(points, { fmt = String, title = '', id = '', unit = '' } = {}) {
  const m = Math.max(0, ...points.map(p => (fin(p.value) ? p.value : 0)));
  const aria = `${title}: ${points.map(p => `${p.label} ${fmt(p.value)}`).join(', ')}`;
  return `<div class="wcols"${id ? ` id="${esc(id)}"` : ''} role="img" aria-label="${esc(aria)}"><div class="wcolrow">${points.map(p => `<span class="wcol ${esc(p.cls ?? '')}" style="height:${w(p.value, m)}%" title="${esc(`${p.label}: ${fmt(p.value)}${unit}`)}"></span>`).join('')}</div>
    <div class="wcolax small mute"><span>${esc(points[0]?.label ?? '')}</span><span>max ${esc(fmt(m))}${esc(unit)}</span><span>${esc(points.at(-1)?.label ?? '')}</span></div></div>`;
}

/** parts [{ key, label, value }] -> one bar split by value + a legend; colour class seg-<key> */
export function stack(parts, { fmt = String, id = '' } = {}) {
  const ps = parts.filter(p => fin(p.value) && p.value > 0), tot = ps.reduce((n, p) => n + p.value, 0) || 1;
  return `<div class="wstack"${id ? ` id="${esc(id)}"` : ''}><div class="insbar" role="img" aria-label="${esc(ps.map(p => `${p.label} ${fmt(p.value)}`).join(', '))}">${ps.map(p => `<span class="insseg seg-${esc(p.key)}" style="width:${(100 * p.value / tot).toFixed(2)}%" title="${esc(`${p.label} ${fmt(p.value)}`)}"></span>`).join('')}</div>
    <div class="small inslegend">${ps.map(p => `<span><i class="insdot seg-${esc(p.key)}"></i>${esc(p.label)} ${esc(fmt(p.value))}</span>`).join(' ')}</div></div>`;
}

/** cols [{ key, label, cards: [html], note?, more? }] -> a board: one column per state, its count in the header, the cards stacked (META-TEND P3: the ladder) */
export function board(cols, { id = '', aria = '' } = {}) {
  return `<div class="wboard"${id ? ` id="${esc(id)}"` : ''} role="list" aria-label="${esc(aria || cols.map(c => `${c.label} ${c.cards.length + (c.more || 0)}`).join(', '))}">${cols.map(c => `<section class="wbcol wb-${esc(c.key)}" role="listitem">
    <h4>${esc(c.label)} <b>${c.cards.length + (c.more || 0)}</b></h4>${c.cards.length ? c.cards.map(x => `<div class="wbcard">${x}</div>`).join('') : `<p class="small mute">${esc(c.note ?? 'none')}</p>`}${c.more ? `<p class="small mute">+${c.more} more</p>` : ''}</section>`).join('')}</div>`;
}

/** series [{ key, label, points: [{ x (a day, YYYY-MM-DD), y }] }] over `days` (the x axis, in order) -> one SVG line per series + a
 * legend with each series' last value (META-TEND P5: "is it growing forever?"); colour class ln-<n> (the --k series) */
export function lines(series, { days = [], fmt = String, id = '', title = '' } = {}) {
  const W = 600, H = 150, P = 4, max = Math.max(1, ...series.flatMap(s => s.points.map(p => p.y)).filter(fin));
  const X = d => (days.length > 1 ? P + (W - 2 * P) * days.indexOf(d) / (days.length - 1) : W / 2), Y = v => H - P - (H - 2 * P) * v / max;
  const pts = s => s.points.filter(p => fin(p.y) && days.includes(p.x)).sort((a, b) => days.indexOf(a.x) - days.indexOf(b.x));
  const last = s => pts(s).at(-1);
  const aria = `${title}: ${series.map(s => `${s.label} ${last(s) ? fmt(last(s).y) : 'none'}`).join(', ')}`;
  const svg = series.map((s, i) => { const ps = pts(s); return `<g class="ln ln-${(i % 9) + 1}">${ps.length > 1 ? `<polyline points="${ps.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}"/>` : ''}${ps.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3"><title>${esc(`${s.label} ${p.x}: ${fmt(p.y)}`)}</title></circle>`).join('')}</g>`; }).join('');
  return `<div class="wlines"${id ? ` id="${esc(id)}"` : ''}><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(aria)}"><line class="lnax" x1="0" y1="${H - P}" x2="${W}" y2="${H - P}"/>${svg}</svg>
    <div class="wcolax small mute"><span>${esc(days[0] ?? '')}</span><span>max ${esc(fmt(max))}</span><span>${esc(days.at(-1) ?? '')}</span></div>
    <div class="small inslegend">${series.map((s, i) => `<span><i class="insdot ln-${(i % 9) + 1}"></i>${esc(s.label)} ${last(s) ? `<b>${esc(fmt(last(s).y))}</b>` : '-'}</span>`).join(' ')}</div></div>`;
}
