// PerpGuard backend: reads Hyperliquid, renders G2 screens, keeps the paper ledger.
// Holds no keys and moves no funds. Run: npm run server   (PORT, LEDGER_FILE, HL_INFO_URL optional)
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { info, indexMarkets, analyse, guardActions, isAddress } from './hl.js'
import { Ledger } from './ledger.js'
import * as fmt from './format.js'

const here = dirname(fileURLToPath(import.meta.url))

// Public accounts with live positions, so the demo shows real data without anyone's wallet.
export const DEMO_ACCOUNTS = (process.env.DEMO_ACCOUNTS ||
  '0x69c3b71b1f78473a00c5cd41105dc96aa65d30b2,0x71565a55237a3f069801b414ae825e33090576c3,0x9fb470376f12af151c9ce88bf7b4acaa13bad02b'
).split(',')

// Stable id for an offered action, e.g. "reduce:0.25", "reduce:1", "margin:0.2". A margin action is
// keyed by its target distance; the amount is recomputed from live state when it is confirmed.
// "margin:max" = all free USDC (offered when no target amount is affordable).
export const actionId = act => (act.kind === 'margin'
  ? (act.max ? 'margin:max' : `margin:${+act.target.toFixed(4)}`)
  : `reduce:${act.fraction}`)

export function createApp({ ledger = new Ledger(process.env.LEDGER_FILE || join(here, 'data', 'ledger.json')), hl = info, marketTtlMs = 5000 } = {}) {
  let marketCache = { at: 0, data: null }
  async function markets() {
    if (Date.now() - marketCache.at > marketTtlMs) {
      marketCache = { at: Date.now(), data: indexMarkets(await hl({ type: 'metaAndAssetCtxs' })) }
    }
    return marketCache.data
  }

  async function snapshot(addr, alertPct) {
    // Spot balance + account mode only cap "add margin" proposals; if they fail, free = perps
    // withdrawable alone (under-states, never over-states, what can be added).
    const optional = p => p.then(r => r ?? null, () => null)
    const [m, state, spot, abstraction] = await Promise.all([
      markets(),
      hl({ type: 'clearinghouseState', user: addr }),
      optional(hl({ type: 'spotClearinghouseState', user: addr })),
      optional(hl({ type: 'userAbstraction', user: addr })),
    ])
    return analyse(state, m, { alertPct, overlay: ledger.overlay(addr), spot, abstraction })
  }

  // Everything the glasses need, pre-rendered: the client only picks screens and sends the user's
  // yes/no back, so all money math stays server-side and testable.
  function view(a, addr, alertPct) {
    const n = a.positions.length
    const positions = a.positions.map((p, i) => {
      const acts = guardActions(p, a, alertPct)
      return {
        coin: p.coin,
        side: p.side,
        marginType: p.marginType,
        risk: p.risk,
        liqDist: p.liqDist,
        paper: p.paper,
        listItem: fmt.listItem(p),
        detail: fmt.detail(p, i, n),
        alert: p.risk === 'danger' ? fmt.alertLine(p) : null,
        actions: acts.map((act, j) => ({
          id: actionId(act),
          kind: act.kind,
          label: fmt.actionLabel(act),
          text: fmt.proposal(p, act, j, acts.length),
          estLiqDist: act.est.liqDist,
          ...(act.kind === 'margin' ? { amount: act.amount } : { fraction: act.fraction }),
        })),
      }
    })
    const danger = positions.find(p => p.risk === 'danger')
    return {
      addr,
      accountValue: a.accountValue,
      free: a.free,
      time: a.time,
      alertPct,
      glanceLine: fmt.glanceLine(a),
      glance: fmt.glance(a),
      closed: a.closed,
      // The position the glasses should interrupt for (closest to liquidation under the threshold).
      alert: danger ? { coin: danger.coin, line: danger.alert } : null,
      positions,
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const send = (code, body) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') return send(204, {})
    const addr = (url.searchParams.get('addr') || '').toLowerCase()
    const alertPct = Math.min(Math.max(Number(url.searchParams.get('alert') || 0.1), 0.01), 0.5)
    try {
      if (url.pathname === '/api/health') return send(200, { ok: true })
      if (url.pathname === '/api/demo') return send(200, { accounts: DEMO_ACCOUNTS })
      if (url.pathname !== '/api/state' && url.pathname !== '/api/paper') return send(404, { error: 'not found' })
      if (!isAddress(addr)) return send(400, { error: 'addr must be a 0x address' })

      if (url.pathname === '/api/state') return send(200, view(await snapshot(addr, alertPct), addr, alertPct))

      if (req.method === 'GET') return send(200, { orders: ledger.history(addr) })
      if (req.method === 'DELETE') {
        ledger.reset(addr)
        return send(200, { ok: true })
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        // Re-read live state so the paper fill uses the current mark, not what the screen showed.
        const a = await snapshot(addr, alertPct)
        const pos = a.positions.find(p => p.coin === body.coin)
        if (!pos) return send(404, { error: `no open ${body.coin} position` })
        const act = guardActions(pos, a, alertPct).find(x => actionId(x) === body.action)
        if (!act) return send(409, { error: `action ${body.action} is not offered for ${pos.coin} right now` })
        const order = ledger.record({ addr, pos, act, free: a.free, source: String(body.source || 'glasses').slice(0, 16) })
        return send(200, { order, text: fmt.filled(order) })
      }
      return send(405, { error: 'method not allowed' })
    } catch (e) {
      return send(502, { error: String(e.message || e) })
    }
  }

  return { handle, snapshot, view }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > 10_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8787)
  const app = createApp()
  createServer(app.handle).listen(port, () => console.log(`PerpGuard backend on http://localhost:${port}`))
}
