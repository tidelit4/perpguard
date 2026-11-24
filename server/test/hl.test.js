import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  indexMarkets, analyse, reduceEstimate, liqPrice, liqDistance, impliedMarginAvailable, marginToReach, guardActions,
  freeCollateral, MIN_MARGIN_GAIN,
} from '../hl.js'
import { Ledger } from '../ledger.js'
import { createApp, actionId } from '../index.js'
import * as fmt from '../format.js'

const fx = name => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8'))
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))

// Live mainnet accounts recorded 2026-11-23 from the public /info API (no keys involved):
//  - ISO: unified account, BTC long 7x + SOL short 10x, both ISOLATED margin
//  - CROSS: BTC/DOGE/STRK/TRUMP/XMR longs, all CROSS margin (some with no liquidation price)
const ISO = { state: fx('state_unified.json'), markets: indexMarkets(fx('markets.json')) }
const CROSS = { state: fx('state_cross.json'), markets: indexMarkets(fx('markets_cross.json')) }
// The same isolated account recorded 2026-11-24 together with its spot balance and account mode:
// accountValue $140k, but withdrawable 0 and spot USDC total - hold = $0.06635 => nothing to add.
const LIVE = {
  state: fx('state_unified_1124.json'),
  markets: indexMarkets(fx('markets_1124.json')),
  rawMarkets: fx('markets_1124.json'),
  spot: fx('spot_unified_1124.json'),
  abstraction: fx('abstraction_unified_1124.json'),
}
// A synthetic "standard account with $1M spot USDC" for tests of the uncapped add-margin math.
const RICH = { spot: { balances: [{ coin: 'USDC', token: 0, total: '1000000.0', hold: '0.0' }] }, abstraction: 'default' }
const iso = analyse(ISO.state, ISO.markets, { alertPct: 0.1 })
const isoRich = analyse(ISO.state, ISO.markets, { alertPct: 0.1, ...RICH })
const live = analyse(LIVE.state, LIVE.markets, { alertPct: 0.15, spot: LIVE.spot, abstraction: LIVE.abstraction })
const liveBtc = live.positions.find(p => p.coin === 'BTC')
const cross = analyse(CROSS.state, CROSS.markets, { alertPct: 0.4 })
const btc = iso.positions.find(p => p.coin === 'BTC')
const sol = iso.positions.find(p => p.coin === 'SOL')
const crossWithLiq = cross.positions.filter(p => p.liq)
const withFree = (a, free) => ({ ...a, free })

test('liqDistance is positive while there is room, for both sides', () => {
  assert.equal(liqDistance(1, 100, 90), 0.1)
  assert.equal(liqDistance(-1, 100, 110), 0.1)
  assert.equal(liqDistance(1, 100, null), null)
})

test('liqPrice matches the documented formula for an isolated long', () => {
  // 1 unit at 100, 10 of margin available, 50x max => l = 1/100
  const p = liqPrice({ price: 100, side: 1, size: 1, marginAvailable: 10, maxLeverage: 50 })
  assert.ok(Math.abs(p - (100 - 10 / 0.99)) < 1e-9)
})

test('analyse reads positions, sides, margin type and reported liquidation prices', () => {
  assert.equal(iso.positions.length, 2)
  assert.equal(btc.side, 1)
  assert.equal(sol.side, -1)
  assert.equal(btc.marginType, 'isolated')
  assert.equal(sol.marginType, 'isolated')
  assert.ok(btc.liq > 0 && btc.liq < btc.mark, 'long liquidates below mark')
  assert.ok(sol.liq > sol.mark, 'short liquidates above mark')
  assert.equal(sol.risk, 'danger', 'SOL is ~8% from liquidation, under the 10% alert')
  assert.equal(btc.risk, 'warn')
  assert.ok((iso.positions[0].liqDist ?? 9) <= (iso.positions[1].liqDist ?? 9), 'closest liquidation first')
  assert.equal(cross.positions.length, 5)
  assert.ok(cross.positions.every(p => p.marginType === 'cross'))
  assert.ok(crossWithLiq.length >= 1, 'fixture has a cross position with a liquidation price')
})

test('reduceEstimate at 0% reproduces the reported liquidation price exactly (iso + cross)', () => {
  for (const [a, p] of [...iso.positions.map(p => [iso, p]), ...crossWithLiq.map(p => [cross, p])]) {
    const est = reduceEstimate(p, a, 0)
    assert.ok(close(est.liq, p.liq), `${p.coin}: ${est.liq} vs ${p.liq}`)
  }
})

test('CROSS: cutting moves liquidation further away, monotonically; closing removes it', () => {
  // null = the estimated liquidation price fell to/below zero, i.e. no liquidation: infinite room.
  const room = d => d ?? Infinity
  for (const p of crossWithLiq) {
    const d25 = room(reduceEstimate(p, cross, 0.25).liqDist)
    const d50 = room(reduceEstimate(p, cross, 0.5).liqDist)
    assert.ok(d25 > p.liqDist, `${p.coin} 25% should add room (${d25} vs ${p.liqDist})`)
    assert.ok(d50 >= d25 && (d50 > d25 || d25 === Infinity), `${p.coin} 50% should add more room than 25%`)
    assert.equal(reduceEstimate(p, cross, 1).liq, null)
  }
})

test('ISOLATED: cutting does NOT move liquidation; adding margin does', () => {
  for (const p of iso.positions) {
    for (const f of [0.25, 0.5]) {
      assert.ok(close(reduceEstimate(p, iso, f).liq, p.liq), `${p.coin} -${f * 100}% keeps liq`)
    }
    const more = reduceEstimate(p, iso, 0, 1000)
    assert.ok(more.liqDist > p.liqDist, `${p.coin} +$1000 margin adds room`)
    assert.ok(impliedMarginAvailable(p) > 0)
  }
})

test('marginToReach: adding the computed USDC lands exactly on the target distance', () => {
  for (const target of [0.2, 0.3]) {
    const amt = marginToReach(sol, target)
    assert.ok(amt > 0)
    assert.ok(close(reduceEstimate(sol, iso, 0, amt).liqDist, target, 1e-9))
  }
  assert.equal(marginToReach(sol, 0.01), 0, 'already further than target => nothing to add')
  assert.equal(marginToReach(crossWithLiq[0], 0.5), null, 'cross positions have no isolated margin')
})

test('guardActions: isolated => add margin (above threshold) + close; cross => reduce 25/50 + close', () => {
  const sa = guardActions(sol, isoRich, 0.1)
  assert.deepEqual(sa.map(actionId), ['margin:0.2', 'margin:0.3', 'reduce:1'])
  assert.equal(sa[0].kind, 'margin')
  assert.ok(Number.isInteger(sa[0].amount) && sa[0].amount > 0)
  assert.ok(sa[0].est.liqDist >= 0.2 && sa[0].est.liqDist > 0.1, 'brings liq distance back above the threshold')
  assert.ok(!sa.some(x => x.kind === 'reduce' && x.fraction < 1), 'no pointless partial cut offered for isolated')

  const cp = crossWithLiq[0]
  const ca = guardActions(cp, cross, 0.4)
  assert.deepEqual(ca.map(actionId), ['reduce:0.25', 'reduce:0.5', 'reduce:1'])
  assert.ok(ca[0].est.liqDist > cp.liqDist)
})

test('screens: ASCII only, under 999 bytes, list items under 63 bytes, incl. paper states', () => {
  const ledger = new Ledger(null)
  const addr = '0x0000000000000000000000000000000000000001'
  const [m] = guardActions(sol, isoRich, 0.1)
  ledger.record({ addr, pos: sol, act: m, free: isoRich.free, source: 'test' })
  ledger.record({ addr, pos: btc, act: { kind: 'reduce', fraction: 1, est: { liq: null, liqDist: null } }, source: 'test' })
  const paper = analyse(ISO.state, ISO.markets, { alertPct: 0.1, overlay: ledger.overlay(addr), ...RICH })
  const texts = []
  const items = []
  // live = no free USDC (fallback screens); withFree(live, 20000) = capped "all free USDC" screens.
  for (const [a, pct] of [[iso, 0.1], [isoRich, 0.1], [live, 0.15], [withFree(live, 20000), 0.15], [cross, 0.4], [paper, 0.1]]) {
    texts.push(fmt.glance(a), fmt.glanceLine(a))
    a.positions.forEach((p, i) => {
      texts.push(fmt.detail(p, i, a.positions.length), fmt.alertLine(p))
      items.push(fmt.listItem(p))
      guardActions(p, a, pct).forEach((act, j, all) => texts.push(fmt.proposal(p, act, j, all.length)))
    })
  }
  for (const o of ledger.history(addr)) texts.push(fmt.filled(o))
  for (const t of texts) {
    assert.ok(Buffer.byteLength(t) < fmt.TEXT_LIMIT, t)
    assert.ok(/^[\x20-\x7e\n]*$/.test(t), `non-ASCII in: ${t}`)
    assert.ok(!/2x: /.test(t), 'no screen relies on double-tap')
  }
  for (const s of items) assert.ok(Buffer.byteLength(s) <= fmt.LIST_ITEM_LIMIT && /^[\x20-\x7e]*$/.test(s), s)
  assert.match(fmt.proposal(sol, m), /Add \$[\d.,k]+ margin\? \(paper\)/)
  assert.match(fmt.proposal(crossWithLiq[0], guardActions(crossWithLiq[0], cross, 0.4)[0]), /Reduce 25%\? \(paper\)[\s\S]*becomes LIQ/)
})

test('ledger: margin then cut replays in order; paper state drives risk; persists', () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'pg-')), 'l.json'))
  const addr = '0xABC0000000000000000000000000000000000001'
  const [m] = guardActions(sol, isoRich, 0.1)
  const o1 = ledger.record({ addr, pos: sol, act: m, free: isoRich.free, source: 'test' })
  assert.equal(o1.action, 'margin')
  assert.equal(o1.amount, m.amount)
  assert.equal(o1.side, null)
  assert.equal(o1.paper, true)

  let a = analyse(ISO.state, ISO.markets, { alertPct: 0.1, overlay: ledger.overlay(addr), ...RICH })
  assert.ok(close(a.free, 1e6 - m.amount), 'paper margin add spends the paper free balance')
  let s = a.positions.find(p => p.coin === 'SOL')
  assert.ok(close(s.liqDist, m.est.liqDist, 1e-9), 'paper position shows the estimated liq distance')
  assert.notEqual(s.risk, 'danger', 'alert stops after the paper margin add')
  assert.equal(s.paper.added, m.amount)
  assert.ok(close(s.live.liqDist, sol.liqDist), 'live numbers kept')

  // Cutting the (now better-margined) isolated position releases margin pro rata: liq stays put.
  ledger.record({ addr, pos: s, act: { kind: 'reduce', fraction: 0.5, est: reduceEstimate(s, a, 0.5) }, source: 'test' })
  assert.deepEqual(ledger.overlay(addr).SOL, [{ fraction: 0, amount: m.amount }, { fraction: 0.5, amount: 0 }])
  a = analyse(ISO.state, ISO.markets, { alertPct: 0.1, overlay: ledger.overlay(addr), ...RICH })
  assert.ok(close(a.free, 1e6 - m.amount + s._isolatedMargin * 0.5), 'cutting isolated half gives half its margin back')
  const s2 = a.positions.find(p => p.coin === 'SOL')
  assert.ok(close(s2.size, sol.size / 2))
  assert.ok(close(s2.liq, s.liq))
  assert.ok(close(s2.paper.cut, 0.5))

  const [last] = ledger.history(addr)
  assert.equal(last.side, 'buy', 'reducing a short is a buy')
  assert.equal(new Ledger(ledger.file).orders.length, 2, 'persisted')
  ledger.reset(addr)
  assert.equal(ledger.history(addr).length, 0)
})

test('ledger: a full close removes the position from the paper view', () => {
  const ledger = new Ledger(null)
  const addr = '0x0000000000000000000000000000000000000002'
  const act = guardActions(btc, iso, 0.1).find(x => x.fraction === 1)
  const o = ledger.record({ addr, pos: btc, act, source: 'test' })
  assert.equal(o.action, 'close')
  assert.equal(o.side, 'sell')
  const a = analyse(ISO.state, ISO.markets, { alertPct: 0.1, overlay: ledger.overlay(addr) })
  assert.deepEqual(a.closed, ['BTC'])
  assert.deepEqual(a.positions.map(p => p.coin), ['SOL'])
  assert.throws(() => ledger.record({ addr, pos: btc, act: { kind: 'reduce', fraction: 1.5, est: {} } }), /invalid/)
  assert.throws(() => ledger.record({ addr, pos: btc, act: { kind: 'margin', amount: -5, est: {} } }), /invalid/)
})

// Fake /info: answers each request type from the fixture (missing spot/abstraction => upstream error,
// which the backend must treat as "no extra free USDC").
function harness(fixture, ledger = new Ledger(null)) {
  const hl = async body => {
    const r = {
      metaAndAssetCtxs: fixture.rawMarkets,
      clearinghouseState: fixture.state,
      spotClearinghouseState: fixture.spot,
      userAbstraction: fixture.abstraction,
    }[body.type]
    if (r === undefined) throw new Error(`no fixture for ${body.type}`)
    return r
  }
  const app = createApp({ ledger, hl })
  return (method, path, body) => new Promise(resolve => {
    const req = { method, url: path, on(ev, cb) { if (ev === 'data' && body) cb(JSON.stringify(body)); if (ev === 'end') cb() } }
    const res = { writeHead(code) { this.code = code }, end(s) { resolve({ code: this.code, body: JSON.parse(s) }) } }
    app.handle(req, res)
  })
}

test('API (isolated account with free USDC): alert -> add margin on paper -> alert clears', async () => {
  const call = harness({ state: ISO.state, rawMarkets: fx('markets.json'), ...RICH })
  const addr = '0x69c3b71b1f78473a00c5cd41105dc96aa65d30b2'
  const st = await call('GET', `/api/state?addr=${addr}`)
  assert.equal(st.code, 200)
  assert.match(st.body.glance, /PERPGUARD/)
  assert.match(st.body.glanceLine, /SOL 10x SHORT LIQ 8\.\d%/)
  assert.equal(st.body.alert.coin, 'SOL')
  const s = st.body.positions.find(p => p.coin === 'SOL')
  assert.equal(s.actions[0].id, 'margin:0.2')
  assert.match(s.actions[0].text, /Add \$.* margin\?/)

  assert.equal((await call('POST', `/api/paper?addr=${addr}`, { coin: 'SOL', action: 'reduce:0.25' })).code, 409, 'partial cut not offered for isolated')
  assert.equal((await call('POST', `/api/paper?addr=${addr}`, { coin: 'ETH', action: 'reduce:1' })).code, 404)
  const ok = await call('POST', `/api/paper?addr=${addr}`, { coin: 'SOL', action: 'margin:0.2' })
  assert.equal(ok.code, 200)
  assert.match(ok.body.text, /PAPER FILLED/)
  assert.equal(ok.body.order.amount, s.actions[0].amount)

  const after = await call('GET', `/api/state?addr=${addr}`)
  assert.equal(after.body.alert, null, 'no more alert once the paper margin is in')
  assert.match(after.body.positions.find(p => p.coin === 'SOL').detail, /paper: \+\$.* margin \(live LIQ 8\.\d%\)/)
  assert.equal((await call('GET', `/api/paper?addr=${addr}`)).body.orders.length, 1)
  assert.equal((await call('DELETE', `/api/paper?addr=${addr}`)).code, 200)
  assert.equal((await call('GET', `/api/state?addr=nope`)).code, 400)
})

test('API (cross account): Reduce 25% on paper is a sell for a long and moves liq away', async () => {
  const call = harness({ state: CROSS.state, rawMarkets: fx('markets_cross.json') })
  const addr = '0x71565a55237a3f069801b414ae825e33090576c3'
  const st = await call('GET', `/api/state?addr=${addr}&alert=0.4`)
  const p = st.body.positions.find(x => x.liqDist != null && x.liqDist < 1)
  assert.equal(p.marginType, 'cross')
  assert.deepEqual(p.actions.map(x => x.id), ['reduce:0.25', 'reduce:0.5', 'reduce:1'])
  assert.ok(p.actions[0].estLiqDist > p.liqDist)
  const ok = await call('POST', `/api/paper?addr=${addr}&alert=0.4`, { coin: p.coin, action: 'reduce:0.25' })
  assert.equal(ok.code, 200)
  assert.equal(ok.body.order.side, 'sell')
  assert.equal(ok.body.order.fraction, 0.25)
  assert.ok(ok.body.order.after.liqDist > ok.body.order.before.liqDist)
})

test('freeCollateral: real unified account, plus unified-cross / portfolio-margin / standard / no-spot cases', () => {
  // Recorded 0x69c3 (unifiedAccount): $140k account value, $0 withdrawable, spot USDC total-hold = $0.06635.
  const f = freeCollateral(LIVE.state, LIVE.spot, LIVE.abstraction)
  assert.equal(f.mode, 'unifiedAccount')
  assert.ok(close(f.free, 0.06635, 1e-6), `free ${f.free}`)
  assert.ok(Number(LIVE.state.marginSummary.accountValue) > 100000, 'account value is NOT what can be added')
  // Numbers seen live 11-24 on 0x7156 (unified, cross): perps withdrawable 37.19 is the same money as
  // the spot balance, so free = total - hold (capped by available-after-maintenance), no double count.
  const uni = freeCollateral({ withdrawable: '37.192075' }, {
    balances: [{ coin: 'USDC', token: 0, total: '60214.503898', hold: '33300.670426' }],
    tokenToAvailableAfterMaintenance: [[0, '48960.943685']],
  }, 'unifiedAccount')
  assert.ok(close(uni.free, 60214.503898 - 33300.670426, 1e-9))
  // Mode inferred from the spot payload when userAbstraction is unavailable.
  assert.equal(freeCollateral({ withdrawable: '0' }, LIVE.spot, null).mode, 'unifiedAccount')
  // Portfolio margin with USDC borrowed (negative total): nothing free.
  const pm = freeCollateral({ withdrawable: '0.0' }, {
    portfolioMarginEnabled: true,
    balances: [{ coin: 'USDC', token: 0, total: '-327153.91', hold: '-496632.70' }],
  }, 'portfolioMargin')
  assert.equal(pm.free, 0)
  // Standard account: perps withdrawable + spot USDC (one class transfer away).
  const std = freeCollateral({ withdrawable: '100.5' }, { balances: [{ coin: 'USDC', token: 0, total: '50', hold: '10' }] }, 'default')
  assert.equal(std.free, 140.5)
  // No spot data: perps withdrawable only.
  assert.equal(freeCollateral({ withdrawable: '12' }, null, null).free, 12)
})

test('add-margin cap: no proposal ever asks for more USDC than is free', () => {
  let offered = 0
  for (const base of [iso, live]) {
    for (const alertPct of [0.05, 0.1, 0.15, 0.2, 0.3]) {
      for (const free of [0, 0.06635, 50, 5000, 20000, 40000, 108000, 250000, 1e6]) {
        const a = withFree(base, free)
        for (const p of a.positions) {
          const acts = guardActions(p, a, alertPct)
          for (const act of acts.filter(x => x.kind === 'margin')) {
            offered++
            assert.ok(act.amount <= free, `${p.coin} alert ${alertPct}: asks ${act.amount} with ${free} free`)
            assert.ok(act.est.liqDist > p.liqDist, 'adding margin must add room')
          }
          // A target amount that IS affordable is still offered as such.
          const need2 = (p.liqDist ?? 9) < 2 * alertPct ? Math.ceil(marginToReach(p, 2 * alertPct)) : null
          if (need2 != null && need2 <= free) assert.ok(acts.some(x => actionId(x) === `margin:${+(2 * alertPct).toFixed(4)}`))
          assert.equal(acts.at(-1).fraction, 1, 'Close is always offered last')
        }
      }
    }
  }
  assert.ok(offered > 20, 'the sweep did exercise margin proposals')
  // Partially affordable: only the cheaper target survives.
  const need = [0.3, 0.45].map(t => Math.ceil(marginToReach(liveBtc, t)))
  const mid = guardActions(liveBtc, withFree(live, (need[0] + need[1]) / 2), 0.15)
  assert.deepEqual(mid.map(actionId), ['margin:0.3', 'reduce:1'])
})

test('add-margin cap: free = $0.07 (recorded 0x69c3) falls back to Reduce 50% / Close, and says why', () => {
  assert.equal(liveBtc.risk, 'danger')
  const acts = guardActions(liveBtc, live, 0.15)
  assert.deepEqual(acts.map(actionId), ['reduce:0.5', 'reduce:1'])
  assert.ok(acts[0].noMargin)
  assert.ok(close(acts[0].est.liq, liveBtc.liq), 'isolated cut: liq honestly shown as unchanged')
  const text = fmt.proposal(liveBtc, acts[0], 0, acts.length)
  assert.match(text, /Reduce 50%\? \(paper\)\ncan't add margin: need \$108\.\dk, free \$0\.07\n/)
  assert.match(text, /liq stays 53,842 \(isolated\), half the size at risk/)
  assert.doesNotMatch(text, /Add \$/)
  // Old recorded fixture (no spot data, withdrawable 0) behaves the same.
  assert.deepEqual(guardActions(sol, iso, 0.1).map(actionId), ['reduce:0.5', 'reduce:1'])
  // Some free USDC, too little for any target: "all free USDC" if it gains >= MIN_MARGIN_GAIN of distance...
  const some = guardActions(liveBtc, withFree(live, 20000.4), 0.15)
  assert.deepEqual(some.map(actionId), ['margin:max', 'reduce:1'])
  assert.equal(some[0].amount, 20000)
  assert.ok(some[0].est.liqDist - liveBtc.liqDist >= MIN_MARGIN_GAIN)
  assert.match(fmt.proposal(liveBtc, some[0]), /Add \$20\.0k margin\? \(paper\)\nall free USDC \(\$108\.\dk needed for LIQ 30\.0%\)[\s\S]*free USDC \$20\.0k -> \$0\.40/)
  // ...but not when it is noise ($100 on a $612k position).
  assert.deepEqual(guardActions(liveBtc, withFree(live, 100), 0.15).map(actionId), ['reduce:0.5', 'reduce:1'])
})

test('API + ledger replay on recorded 0x69c3: paper close frees margin, paper add spends it, replay agrees', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pg-')), 'l.json')
  const ledger = new Ledger(file)
  const call = harness(LIVE, ledger)
  const addr = '0x69c3b71b1f78473a00c5cd41105dc96aa65d30b2'
  const q = `addr=${addr}&alert=0.15`
  let st = await call('GET', `/api/state?${q}`)
  assert.equal(st.code, 200)
  assert.ok(close(st.body.free, 0.06635, 1e-6))
  assert.match(st.body.glance, /acct \$140\.1k  free \$0\.07/)
  assert.equal(st.body.alert.coin, 'BTC')
  let b = st.body.positions.find(p => p.coin === 'BTC')
  assert.deepEqual(b.actions.map(x => x.id), ['reduce:0.5', 'reduce:1'])
  assert.equal((await call('POST', `/api/paper?${q}`, { coin: 'BTC', action: 'margin:0.3' })).code, 409, 'unaffordable margin is not confirmable')
  assert.equal((await call('POST', `/api/paper?${q}`, { coin: 'BTC', action: 'margin:max' })).code, 409)

  // Close SOL on paper: its isolated margin (marginUsed) comes back as free USDC.
  const solMargin = Number(LIVE.state.assetPositions.find(x => x.position.coin === 'SOL').position.marginUsed)
  assert.equal((await call('POST', `/api/paper?${q}`, { coin: 'SOL', action: 'reduce:1' })).code, 200)
  st = await call('GET', `/api/state?${q}`)
  const freeAfterClose = 0.06635 + solMargin
  assert.ok(close(st.body.free, freeAfterClose, 1e-9))

  // Now BTC can get all of it (not enough for the 30% target, but it moves liq a lot).
  b = st.body.positions.find(p => p.coin === 'BTC')
  assert.deepEqual(b.actions.map(x => x.id), ['margin:max', 'reduce:1'])
  assert.equal(b.actions[0].amount, Math.floor(freeAfterClose))
  const ok = await call('POST', `/api/paper?${q}`, { coin: 'BTC', action: 'margin:max' })
  assert.equal(ok.code, 200)
  const o = ok.body.order
  assert.equal(o.amount, Math.floor(freeAfterClose))
  assert.ok(close(o.free.before, freeAfterClose, 1e-6))
  assert.ok(close(o.free.after, freeAfterClose - o.amount, 1e-6) && o.free.after >= 0 && o.free.after < 1)
  assert.match(ok.body.text, /free USDC \$59\.7k -> \$0\.\d\d \(paper\)/)

  st = await call('GET', `/api/state?${q}`)
  assert.ok(close(st.body.free, o.free.after, 1e-6), 'paper free = live free - added + released')
  b = st.body.positions.find(p => p.coin === 'BTC')
  assert.ok(close(b.liqDist, o.after.liqDist, 1e-9), 'replayed position matches the estimate shown before the fill')
  assert.ok(!b.actions.some(x => x.kind === 'margin'), 'free is spent: no more add-margin offers')
  assert.equal((await call('POST', `/api/paper?${q}`, { coin: 'BTC', action: 'margin:max' })).code, 409)

  // A fresh process replaying the file gets the same numbers.
  const re = analyse(LIVE.state, LIVE.markets, { alertPct: 0.15, overlay: new Ledger(file).overlay(addr), spot: LIVE.spot, abstraction: LIVE.abstraction })
  assert.ok(close(re.free, st.body.free, 1e-12))
  assert.deepEqual(re.closed, ['SOL'])
  assert.ok(close(re.positions[0].liqDist, b.liqDist, 1e-12))
  // The ledger itself refuses to spend more than is free.
  assert.throws(() => ledger.record({ addr, pos: liveBtc, act: { kind: 'margin', amount: 1, est: {} }, free: 0.06635 }), /insufficient free USDC/)
})

test('API: upstream failure is a 502, not a crash', async () => {
  const app = createApp({ ledger: new Ledger(null), hl: async () => { throw new Error('boom') } })
  const r = await new Promise(resolve => app.handle(
    { method: 'GET', url: '/api/state?addr=0x69c3b71b1f78473a00c5cd41105dc96aa65d30b2', on() {} },
    { writeHead(c) { this.code = c }, end(s) { resolve({ code: this.code, body: JSON.parse(s) }) } },
  ))
  assert.equal(r.code, 502)
  assert.match(r.body.error, /boom/)
})
