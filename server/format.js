// Text for the G2 display (576x288, one proportional font, keep each screen well under 999 bytes,
// list items under 63 bytes) and for chat. Plain ASCII only: glyphs missing from the glasses font
// are silently dropped. Input scheme: tap = yes/select, swipe = no/next. Double-tap is left to the
// system (it may open the exit dialog), so no screen depends on it.

export const TEXT_LIMIT = 999
export const LIST_ITEM_LIMIT = 63

export function usd(n, { sign = false } = {}) {
  if (n == null || !Number.isFinite(n)) return '-'
  const s = sign ? (n >= 0 ? '+' : '-') : n < 0 ? '-' : ''
  const a = Math.abs(n)
  const body = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(a >= 100 ? 0 : 2)
  return `${s}$${body}`
}

export function px(n) {
  if (n == null || !Number.isFinite(n)) return '-'
  const d = n >= 1000 ? 0 : n >= 10 ? 2 : n >= 1 ? 3 : 5
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function pct(f, digits = 1) {
  if (f == null || !Number.isFinite(f)) return '-'
  return (100 * f).toFixed(digits) + '%'
}

export function qty(n) {
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3)
}

// Distance to liquidation, clamped: null or >100% away reads as "far".
export function liqText(dist) {
  if (dist == null || dist > 1) return 'LIQ far'
  if (dist <= 0) return 'LIQ NOW'
  return `LIQ ${pct(dist)}`
}

const sideWord = side => (side > 0 ? 'LONG' : 'SHORT')
const flag = risk => (risk === 'danger' ? '!' : risk === 'warn' ? '~' : ' ')
const paperTag = p => (p.paper ? ' (paper)' : '')

// The one line you see at a glance: the position closest to liquidation, plus the account.
export function glanceLine(a) {
  const p = a.positions[0]
  if (!p) return `PerpGuard: no open perps  acct ${usd(a.accountValue)}`
  return `${flag(p.risk).trim() || '-'} ${p.coin} ${p.leverage}x ${sideWord(p.side)} ${liqText(p.liqDist)} ${usd(p.pnl, { sign: true })}` +
    (a.positions.length > 1 ? `  +${a.positions.length - 1} more` : '')
}

export function glance(a, { now = new Date(), max = 5 } = {}) {
  const fund = a.positions.reduce((s, p) => s + p.fundingPerHour, 0)
  const hhmm = now.toISOString().slice(11, 16)
  const free = a.free == null ? '' : `  free ${usd(Math.max(0, a.free))}`
  const lines = [`PERPGUARD  acct ${usd(a.accountValue)}${free}  ${hhmm}Z`, '']
  for (const p of a.positions.slice(0, max)) {
    lines.push(`${flag(p.risk)} ${p.coin} ${p.leverage}x ${sideWord(p.side)}  ${liqText(p.liqDist)}  ${usd(p.pnl, { sign: true })}${paperTag(p)}`)
  }
  if (a.positions.length > max) lines.push(`  +${a.positions.length - max} more`)
  if (a.closed?.length) lines.push(`  closed on paper: ${a.closed.join(', ')}`)
  lines.push(`funding ${usd(fund, { sign: true })}/h`)
  lines.push(a.positions.length ? 'tap: positions   swipe: refresh' : 'swipe: refresh')
  return lines.join('\n')
}

// One row of the native list container (<= 63 bytes).
export function listItem(p) {
  const s = `${flag(p.risk)}${p.coin} ${p.leverage}x ${p.side > 0 ? 'L' : 'S'} ${p.marginType === 'isolated' ? 'iso' : 'cross'} ${liqText(p.liqDist)} ${usd(p.pnl, { sign: true })}${p.paper ? ' P' : ''}`
  return s.length > LIST_ITEM_LIMIT ? s.slice(0, LIST_ITEM_LIMIT) : s
}

export function detail(p, i, n) {
  const lines = [
    `${p.coin}-PERP  ${sideWord(p.side)} ${p.leverage}x ${p.marginType}   ${i + 1}/${n}`,
    `size ${qty(p.size)}  mark ${px(p.mark)}`,
    `entry ${px(p.entry)}  PnL ${usd(p.pnl, { sign: true })} (${pct(p.roe, 0)})`,
    `liq ${px(p.liq)}  ${liqText(p.liqDist)}${p.risk === 'danger' ? '  DANGER' : ''}`,
    `funding ${usd(p.fundingPerHour, { sign: true })}/h`,
  ]
  if (p.paper) {
    const parts = [p.paper.cut > 1e-9 && `-${pct(p.paper.cut, 0)} size`, p.paper.added > 0 && `+${usd(p.paper.added)} margin`]
    lines.push(`paper: ${parts.filter(Boolean).join(', ')} (live ${liqText(p.live.liqDist)})`)
  }
  lines.push('tap: guard   swipe: back')
  return lines.join('\n')
}

export function actionLabel(act) {
  if (act.kind === 'margin') return `Add ${usd(act.amount)} margin`
  return act.fraction === 1 ? 'Close' : `Reduce ${pct(act.fraction, 0)}`
}

// The alert / confirm screen. tap = YES (paper fill), swipe = NO (next option, then back).
export function proposal(p, act, i = 0, n = 1) {
  const head = p.risk === 'danger' ? `!! ${p.coin} ${liqText(p.liqDist)} AWAY !!` : `${p.coin} ${sideWord(p.side)} ${p.leverage}x guard`
  const trade = () => `${p.side > 0 ? 'sell' : 'buy'} ${qty(p.size * act.fraction)} ${p.coin} @ ${px(p.mark)} = ${usd(p.size * act.fraction * p.mark)}`
  const lines = [`${head}   ${i + 1}/${n}`, `${actionLabel(act)}? (paper)`]
  if (act.kind === 'margin') {
    // Add-margin amounts are capped by the USDC actually free in the account; say so on screen.
    lines.push(act.max
      ? `all free USDC (${usd(act.need.amount)} needed for ${liqText(act.need.target)})`
      : `isolated: cutting size won't move liq`)
    lines.push(`-> ${liqText(p.liqDist)} becomes ${liqText(act.est.liqDist)}`, `   liq ${px(p.liq)} -> ${px(act.est.liq)}`)
    lines.push(`free USDC ${usd(act.free)} -> ${usd(act.free - act.amount)}`)
  } else if (act.noMargin) {
    // Isolated, and not enough free USDC to add margin: cutting keeps liq where it is but halves
    // what is lost if it is hit.
    lines.push(`can't add margin: need ${usd(act.need.amount)}, free ${usd(act.need.free)}`)
    lines.push(trade(), `-> liq stays ${px(p.liq)} (isolated), half the size at risk`)
  } else if (act.fraction === 1) {
    lines.push(trade(), '-> position closed, no liquidation risk')
  } else {
    lines.push(trade(), `-> ${liqText(p.liqDist)} becomes ${liqText(act.est.liqDist)}`, `   liq ${px(p.liq)} -> ${px(act.est.liq)}`)
  }
  lines.push('', 'tap: YES      swipe: no')
  return lines.join('\n')
}

export function filled(o) {
  const what = o.action === 'margin'
    ? `added ${usd(o.amount)} margin to ${o.coin}`
    : `${o.side} ${qty(o.size)} ${o.coin} @ ${px(o.px)}  (${usd(o.notional)})`
  return [
    `PAPER FILLED  #${o.id}`,
    what,
    o.action === 'close' ? 'position closed on paper' : `${liqText(o.before.liqDist)} -> ${liqText(o.after.liqDist)}`,
    ...(o.free ? [`free USDC ${usd(o.free.before)} -> ${usd(o.free.after)} (paper)`] : []),
    '',
    'paper trade only: no funds moved',
    'tap: back',
  ].join('\n')
}

// One-line alert for chat / notifications.
export function alertLine(p) {
  return `${p.coin} ${p.leverage}x ${sideWord(p.side)} is ${liqText(p.liqDist)} away (mark ${px(p.mark)}, liq ${px(p.liq)}, PnL ${usd(p.pnl, { sign: true })})`
}
