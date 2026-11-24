// Hyperliquid read client + risk math. Read-only: only the public /info endpoint is used.

export const HL_INFO = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info'

export async function info(body, { fetchImpl = fetch, url = HL_INFO } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`hyperliquid /info ${body.type}: HTTP ${res.status}`)
  return res.json()
}

export function isAddress(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)
}

// Market data keyed by coin: mark price, hourly funding, max leverage.
export function indexMarkets([meta, ctxs]) {
  const out = {}
  meta.universe.forEach((u, i) => {
    const c = ctxs[i]
    if (!c || u.isDelisted) return
    out[u.name] = {
      mark: Number(c.markPx),
      funding: Number(c.funding),
      maxLeverage: u.maxLeverage,
      prevDayPx: Number(c.prevDayPx),
    }
  })
  return out
}

// Hyperliquid's documented liquidation price for one position, holding every other price fixed:
//   liq = price - side * marginAvailable / size / (1 - l * side),  l = 1 / maintenanceLeverage
// where maintenanceLeverage = 2 * maxLeverage (maintenance margin is half the initial margin at
// max leverage) and marginAvailable = accountValue - maintenanceMarginRequired (cross) or
// isolatedMargin - maintenanceMarginRequired (isolated).
// https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations
// Large positions use tiered margin tables, so this is an estimate; validate() measures the error
// against the liquidationPx Hyperliquid itself reports.
export function liqPrice({ price, side, size, marginAvailable, maxLeverage }) {
  const l = 1 / (2 * maxLeverage)
  if (size <= 0) return null
  const px = price - (side * marginAvailable) / size / (1 - l * side)
  return px > 0 ? px : null
}

export function maintenanceFor(notional, maxLeverage) {
  return notional / (2 * maxLeverage)
}

// Signed distance from mark to liquidation as a fraction of mark: positive = room left.
export function liqDistance(side, mark, liq) {
  if (liq == null || !(liq > 0)) return null
  return side > 0 ? (mark - liq) / mark : (liq - mark) / mark
}

export function riskLevel(dist, alertPct) {
  if (dist == null) return 'safe'
  if (dist <= alertPct) return 'danger'
  if (dist <= alertPct * 2) return 'warn'
  return 'safe'
}

// Abstraction modes in which spot USDC and perps margin are ONE balance (userAbstraction /info type).
// For these, clearinghouseState.withdrawable is not extra money on top of the spot balance.
const SHARED_BALANCE = new Set(['unifiedAccount', 'portfolioMargin'])

// USDC the account could move into isolated margin right now, from the public /info API:
//  - perps: clearinghouseState.withdrawable (free cross collateral)
//  - spot:  spotClearinghouseState USDC total - hold (hold = what open orders / margin already use);
//           negative totals (portfolio-margin borrowing) count as 0, and for unified accounts it is
//           also capped by tokenToAvailableAfterMaintenance.
// Standard accounts can add both (spot USDC is one class transfer away). Unified / portfolio-margin
// accounts hold everything in the spot balance, so only the spot figure counts (no double count).
// If spot state is unavailable, only perps withdrawable counts: when unsure, offer less, not more.
// Verified 2026-11-24 on 0x69c3... (unifiedAccount): withdrawable 0, USDC total 140,064.997975,
// hold 140,064.931625 -> free $0.07 while accountValue is $140k (fixtures/*_1124.json).
export function freeCollateral(state, spot, abstraction) {
  const perps = Math.max(0, Number(state?.withdrawable) || 0)
  if (!spot || !Array.isArray(spot.balances)) return { free: perps, perps, spot: null, mode: abstraction || 'unknown' }
  const usdc = spot.balances.find(b => b.token === 0 || b.coin === 'USDC')
  const total = Number(usdc?.total || 0)
  const hold = Number(usdc?.hold || 0)
  let spotFree = Math.max(0, Math.min(total, total - hold))
  const afterMaint = (spot.tokenToAvailableAfterMaintenance || []).find(([t]) => t === 0)
  if (afterMaint) spotFree = Math.min(spotFree, Math.max(0, Number(afterMaint[1]) || 0))
  const mode = typeof abstraction === 'string' ? abstraction
    : spot.portfolioMarginEnabled ? 'portfolioMargin'
      : spot.tokenToAvailableAfterMaintenance ? 'unifiedAccount' : 'default'
  return { free: SHARED_BALANCE.has(mode) ? spotFree : perps + spotFree, perps, spot: spotFree, mode }
}

// Turn a clearinghouseState into PerpGuard positions with risk fields.
// overlay: { [coin]: [{ fraction, amount }, ...] } paper actions from the ledger, oldest first. They
// are applied in order on top of the live position, so after a paper fill the glasses show (and
// guard) the paper position; the untouched live numbers stay under `live`.
// spot / abstraction: spotClearinghouseState and userAbstraction responses (optional), used for the
// free USDC that caps "add margin" proposals. Paper margin adds spend that free balance; paper cuts
// of ISOLATED positions give their margin back pro rata (what Hyperliquid does). Paper cuts of cross
// positions are not credited back (conservative: the free figure can only be under-stated).
export function analyse(state, markets, { alertPct = 0.1, overlay = {}, spot = null, abstraction = null } = {}) {
  const accountValue = Number(state.marginSummary.accountValue)
  const crossMaint = Number(state.crossMaintenanceMarginUsed || 0)
  const ctx = { accountValue, crossMaint }
  const freeLive = freeCollateral(state, spot, abstraction)
  let paperSpent = 0
  let paperReleased = 0
  const closed = []
  const live = state.assetPositions.map(({ position: p }) => {
    const m = markets[p.coin] || {}
    const szi = Number(p.szi)
    const side = szi > 0 ? 1 : -1
    const size = Math.abs(szi)
    const mark = m.mark || Number(p.positionValue) / size
    const maxLeverage = m.maxLeverage || p.maxLeverage
    const notional = size * mark
    const isolated = p.leverage?.type === 'isolated'
    const reportedLiq = p.liquidationPx ? Number(p.liquidationPx) : null
    const dist = liqDistance(side, mark, reportedLiq)
    const fundingPerHour = -side * (m.funding || 0) * notional // what this position earns (+) or pays (-)
    return {
      coin: p.coin,
      side,
      size,
      mark,
      entry: Number(p.entryPx),
      leverage: p.leverage?.value,
      marginType: isolated ? 'isolated' : 'cross',
      notional,
      pnl: Number(p.unrealizedPnl),
      roe: Number(p.returnOnEquity),
      liq: reportedLiq,
      liqDist: dist,
      fundingPerHour,
      risk: riskLevel(dist, alertPct),
      maxLeverage,
      _isolatedMargin: isolated ? Number(p.marginUsed) : null,
      fundingRate: m.funding || 0,
      paper: null,
      live: null,
    }
  })
  const positions = []
  for (const pos of live) {
    const ops = overlay[pos.coin] || []
    let cur = pos
    for (const op of ops) {
      paperSpent += op.amount || 0
      if (cur._isolatedMargin != null) paperReleased += cur._isolatedMargin * (op.fraction || 0)
      cur = applyPaper(cur, ctx, op, alertPct)
      if (!cur) break
    }
    if (!cur) {
      closed.push(pos.coin)
      continue
    }
    if (ops.length) {
      const left = cur.size / pos.size
      cur.paper = { cut: 1 - left, added: ops.reduce((s, o) => s + (o.amount || 0), 0), ops: ops.length }
      cur.live = { size: pos.size, liq: pos.liq, liqDist: pos.liqDist, risk: pos.risk }
    }
    positions.push(cur)
  }
  positions.sort((a, b) => (a.liqDist ?? 9) - (b.liqDist ?? 9))
  return {
    accountValue,
    withdrawable: Number(state.withdrawable),
    // USDC free to add as isolated margin, after paper actions (live figure under freeLive).
    free: freeLive.free - paperSpent + paperReleased,
    freeLive,
    marginUsed: Number(state.marginSummary.totalMarginUsed),
    crossMaint,
    time: state.time,
    positions,
    closed,
  }
}

// One paper action applied to an analysed position; returns the new position, or null if closed.
// PnL and funding scale with the size that is left (the cut part counts as realised, off-screen).
export function applyPaper(pos, ctx, { fraction = 0, amount = 0 }, alertPct) {
  const est = reduceEstimate(pos, ctx, fraction, amount)
  if (!(est.size > 0)) return null
  const k = est.size / pos.size
  return {
    ...pos,
    size: est.size,
    notional: pos.notional * k,
    pnl: pos.pnl * k,
    fundingPerHour: pos.fundingPerHour * k,
    liq: est.liq,
    liqDist: est.liqDist,
    risk: riskLevel(est.liqDist, alertPct),
    _isolatedMargin: pos._isolatedMargin == null ? null : pos._isolatedMargin * k + amount,
  }
}

// Margin that stands between this position and liquidation, implied by the liquidationPx Hyperliquid
// reports (the liq formula solved for marginAvailable). Unified and portfolio-margin accounts back
// perps with spot collateral that clearinghouseState does not show, so rebuilding marginAvailable
// from accountValue alone is wrong for them; calibrating on the reported price is exact at fraction 0.
export function impliedMarginAvailable(pos) {
  const l = 1 / (2 * pos.maxLeverage)
  return (pos.mark - pos.liq) * pos.side * pos.size * (1 - l * pos.side)
}

// Estimated liquidation after cutting `fraction` of a position and/or adding `added` USDC of isolated
// margin (fees ignored, equity unchanged). On Hyperliquid, reducing an ISOLATED position releases its
// margin pro rata, so the liquidation price does not move; for those the useful guard is adding margin.
export function reduceEstimate(pos, { accountValue, crossMaint }, fraction, added = 0) {
  const newSize = pos.size * (1 - fraction)
  if (newSize <= 0) return { fraction, size: 0, liq: null, liqDist: null }
  const maintCut = maintenanceFor(pos.size * fraction * pos.mark, pos.maxLeverage)
  let marginAvailable
  if (pos.liq) {
    // Cutting a cross position frees its maintenance margin for the rest of the account.
    marginAvailable = pos.marginType === 'isolated'
      ? impliedMarginAvailable(pos) * (1 - fraction) + added
      : impliedMarginAvailable(pos) + maintCut
  } else if (pos.marginType === 'isolated') {
    marginAvailable = pos._isolatedMargin * (1 - fraction) + added - maintenanceFor(newSize * pos.mark, pos.maxLeverage)
  } else {
    marginAvailable = accountValue - (crossMaint - maintCut)
  }
  const liq = liqPrice({ price: pos.mark, side: pos.side, size: newSize, marginAvailable, maxLeverage: pos.maxLeverage })
  return { fraction, size: newSize, liq, liqDist: liqDistance(pos.side, pos.mark, liq) }
}

// USDC of isolated margin needed to put liquidation `target` (fraction of mark) away from mark.
export function marginToReach(pos, target) {
  if (pos.marginType !== 'isolated' || !pos.liq) return null
  const l = 1 / (2 * pos.maxLeverage)
  const needed = target * pos.mark * pos.size * (1 - l * pos.side)
  return Math.max(needed - impliedMarginAvailable(pos), 0)
}

// A capped "add all free USDC" proposal must move liquidation at least this much further away
// (fraction of mark, i.e. 1 percentage point of distance); otherwise it is noise and not offered.
export const MIN_MARGIN_GAIN = 0.01

// Guard actions offered for a position: cross -> reduce 25% / 50%; isolated -> add margin until
// liquidation is 2x / 3x the alert distance away; both -> close.
// Add-margin amounts are capped by analysis.free (USDC free to move, after paper actions; missing =
// 0). Options the account can't cover are dropped. If none is affordable: offer all free USDC
// ("margin:max") when that gains >= MIN_MARGIN_GAIN of distance, else fall back to Reduce 50%
// (liq stays put on isolated, but half the size is at risk) and Close.
export function guardActions(pos, analysis, alertPct) {
  const out = []
  if (pos.marginType === 'isolated' && pos.liq) {
    const free = Math.max(0, Number(analysis.free) || 0)
    const wanted = []
    for (const k of [2, 3]) {
      const target = alertPct * k
      if ((pos.liqDist ?? 9) >= target) continue
      const amount = Math.ceil(marginToReach(pos, target))
      wanted.push({ kind: 'margin', target, amount, free, est: reduceEstimate(pos, analysis, 0, amount) })
    }
    const affordable = wanted.filter(w => w.amount <= free)
    out.push(...affordable)
    if (wanted.length && !affordable.length) {
      const need = { amount: wanted[0].amount, target: wanted[0].target, free }
      const amount = Math.floor(free)
      const est = amount > 0 ? reduceEstimate(pos, analysis, 0, amount) : null
      if (est && est.liqDist != null && est.liqDist - (pos.liqDist ?? 0) >= MIN_MARGIN_GAIN) {
        out.push({ kind: 'margin', target: null, max: true, amount, free, need, est })
      } else {
        out.push({ kind: 'reduce', fraction: 0.5, noMargin: true, need, est: reduceEstimate(pos, analysis, 0.5) })
      }
    }
  } else {
    for (const f of [0.25, 0.5]) out.push({ kind: 'reduce', fraction: f, est: reduceEstimate(pos, analysis, f) })
  }
  out.push({ kind: 'reduce', fraction: 1, est: reduceEstimate(pos, analysis, 1) })
  return out
}
