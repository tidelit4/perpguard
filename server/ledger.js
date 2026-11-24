// Paper ledger: every "write" PerpGuard makes is a simulated order at the live mark price.
// No keys, no exchange calls, no user funds. Persisted as JSON so the history survives restarts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export class Ledger {
  constructor(file) {
    this.file = file
    this.orders = []
    if (file) {
      try {
        this.orders = JSON.parse(readFileSync(file, 'utf8')).orders || []
      } catch {
        this.orders = []
      }
    }
  }

  save() {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ orders: this.orders }, null, 1))
  }

  // Paper actions per coin, oldest first: { BTC: [{ fraction, amount }, ...] }. Order matters: on
  // Hyperliquid, cutting an isolated position releases margin pro rata, including margin added
  // earlier, so hl.analyse replays them in sequence. `fraction` is of the size at that moment.
  overlay(addr) {
    const out = {}
    for (const o of this.orders) {
      if (o.addr !== addr.toLowerCase()) continue
      ;(out[o.coin] ??= []).push({ fraction: o.fraction || 0, amount: o.amount || 0 })
    }
    return out
  }

  // pos is an analysed position (see hl.analyse); act is one of hl.guardActions(...).
  // free: USDC free to add as margin right now (hl.analyse(...).free, paper actions included). A
  // paper margin add can't spend more than that; it is recorded so replays can be checked.
  record({ addr, pos, act, source, free }) {
    const margin = act.kind === 'margin'
    if (margin ? !(act.amount > 0) : !(act.fraction > 0 && act.fraction <= 1)) throw new Error('invalid action')
    if (margin && free != null && act.amount > free + 1e-9) {
      throw new Error(`insufficient free USDC: adding ${act.amount} with ${Math.max(0, free).toFixed(2)} free`)
    }
    const fraction = margin ? 0 : act.fraction
    const order = {
      id: randomUUID().slice(0, 8),
      ts: new Date().toISOString(),
      addr: addr.toLowerCase(),
      coin: pos.coin,
      action: margin ? 'margin' : fraction === 1 ? 'close' : 'reduce',
      fraction,
      amount: margin ? act.amount : 0,
      // Reducing a long is a sell, reducing a short is a buy.
      side: margin ? null : pos.side > 0 ? 'sell' : 'buy',
      size: +(pos.size * fraction).toPrecision(6),
      px: pos.mark,
      notional: +(pos.size * fraction * pos.mark).toFixed(2),
      before: { liq: pos.liq, liqDist: pos.liqDist },
      after: { liq: act.est.liq, liqDist: act.est.liqDist },
      ...(margin && free != null ? { free: { before: +free.toFixed(6), after: +(free - act.amount).toFixed(6) } } : {}),
      source,
      paper: true,
    }
    this.orders.push(order)
    this.save()
    return order
  }

  history(addr, limit = 20) {
    const a = addr?.toLowerCase()
    return this.orders.filter(o => !a || o.addr === a).slice(-limit).reverse()
  }

  reset(addr) {
    this.orders = this.orders.filter(o => o.addr !== addr.toLowerCase())
    this.save()
  }
}
