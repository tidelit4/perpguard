// Frontend tests: the glasses state machine (src/flow.ts), driven by the REAL backend view.
// flow.ts is TypeScript with no imports; we transpile it with the esbuild that Vite already installs
// and import it from a data: URL. If node_modules is missing, these tests are skipped (backend tests
// in hl.test.js need no dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ledger } from '../ledger.js'
import { createApp } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = name => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))

let flow = null
try {
  const { transformSync } = await import('esbuild')
  const { code } = transformSync(readFileSync(join(here, '..', '..', 'src', 'flow.ts'), 'utf8'), { loader: 'ts', format: 'esm' })
  flow = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
} catch (e) {
  console.log(`# flow tests skipped: ${e.message}`)
}
const t = flow ? test : test.skip

const CROSS_ADDR = '0x71565a55237a3f069801b414ae825e33090576c3'
const ISO_ADDR = '0x69c3b71b1f78473a00c5cd41105dc96aa65d30b2'
function backend(fixture) {
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
  const app = createApp({ ledger: new Ledger(null), hl })
  return (method, path, body) => new Promise(resolve => {
    const req = { method, url: path, on(ev, cb) { if (ev === 'data' && body) cb(JSON.stringify(body)); if (ev === 'end') cb() } }
    const res = { writeHead(code) { this.code = code }, end(s) { resolve({ code: this.code, body: JSON.parse(s) }) } }
    app.handle(req, res)
  })
}
const CROSS = { state: fx('state_cross.json'), rawMarkets: fx('markets_cross.json') }
const ISO_1124 = {
  state: fx('state_unified_1124.json'), rawMarkets: fx('markets_1124.json'),
  spot: fx('spot_unified_1124.json'), abstraction: fx('abstraction_unified_1124.json'),
}

// Every string the glasses would show must fit the G2 limits and be plain ASCII.
function assertFits(r) {
  const bytes = s => Buffer.byteLength(s, 'utf8')
  const ascii = s => /^[\x0a\x20-\x7e]*$/.test(s)
  if (r.kind === 'text') {
    assert.ok(bytes(r.text) <= 999, `text ${bytes(r.text)} B`)
    assert.ok(ascii(r.text), `non-ASCII: ${JSON.stringify(r.text)}`)
  } else {
    assert.ok(r.items.length >= 1 && r.items.length <= 20, `${r.items.length} rows`)
    for (const it of r.items) {
      assert.ok(bytes(it) <= 63, `row ${bytes(it)} B: ${it}`)
      assert.ok(ascii(it), `non-ASCII row: ${it}`)
    }
    assert.ok(ascii(r.header))
  }
}

t('flow: clampBytes keeps text within the byte limit and marks the cut', () => {
  assert.equal(flow.clampBytes('abc', 10), 'abc')
  const s = flow.clampBytes('x'.repeat(2000), flow.TEXT_LIMIT)
  assert.ok(Buffer.byteLength(s) <= flow.TEXT_LIMIT)
  assert.ok(s.endsWith('...'))
})

t('flow: cross account, browse glance -> list -> detail -> proposal -> next option -> back', async () => {
  const call = backend(CROSS)
  const view = (await call('GET', `/api/state?addr=${CROSS_ADDR}&alert=0.02`)).body
  assert.equal(view.alert, null, 'threshold 2%: nothing to alert')
  let s = { kind: 'glance' }
  assertFits(flow.render(s, view))
  assert.equal(flow.maybeAlert(s, view, {}, 0), null)

  // swipe on glance = refresh, stays on glance
  let r = flow.step(s, view, { kind: 'swipe' })
  assert.equal(r.screen, s)
  assert.deepEqual(r.effect, { kind: 'refresh' })

  // tap = positions list (native list, closest liquidation first, "< back" last)
  s = flow.step(s, view, { kind: 'tap' }).screen
  assert.equal(s.kind, 'list')
  const list = flow.render(s, view)
  assert.equal(list.kind, 'list')
  assertFits(list)
  assert.equal(list.items.length, view.positions.length + 1)
  assert.equal(list.items.at(-1), flow.BACK_ITEM)
  // tap/swipe on a list screen do nothing; only the list selection event moves on
  assert.equal(flow.step(s, view, { kind: 'tap' }).screen, s)

  // the "< back" row returns to the glance
  assert.equal(flow.step(s, view, { kind: 'listSelect', index: list.items.length - 1 }).screen.kind, 'glance')

  // first row = detail of the closest-to-liquidation position
  s = flow.step(s, view, { kind: 'listSelect', index: 0 }).screen
  assert.deepEqual(s, { kind: 'detail', coin: view.positions[0].coin })
  assertFits(flow.render(s, view))
  assert.equal(flow.step(s, view, { kind: 'swipe' }).screen.kind, 'list', 'swipe on detail = back')

  // tap on detail = guard proposal, first option
  s = flow.step(s, view, { kind: 'tap' }).screen
  assert.deepEqual(s, { kind: 'proposal', coin: view.positions[0].coin, idx: 0, from: 'detail' })
  const p = view.positions[0]
  const texts = []
  for (let i = 0; i < p.actions.length; i++) {
    const out = flow.render(s, view)
    assertFits(out)
    assert.match(out.text, /\(paper\)/)
    assert.match(out.text, /tap: YES/)
    assert.doesNotMatch(out.text, /double/i, 'no screen asks for a double-tap')
    texts.push(out.text)
    r = flow.step(s, view, { kind: 'swipe' })
    if (i + 1 < p.actions.length) {
      assert.equal(r.screen.idx, i + 1, 'swipe = no -> next option')
      assert.equal(r.effect, null)
    } else {
      assert.deepEqual(r.screen, { kind: 'detail', coin: p.coin }, 'after the last option: back to detail, no snooze')
      assert.equal(r.effect, null)
    }
    s = r.screen
  }
  assert.match(texts[0], /Reduce 25%\? \(paper\)/)
})

t('flow: cross alert interrupts, swipe = no, tap = YES posts the offered action, alert clears', async () => {
  const call = backend(CROSS)
  const q = `addr=${CROSS_ADDR}&alert=0.4`
  let view = (await call('GET', `/api/state?${q}`)).body
  assert.ok(view.alert, 'threshold 40%: BTC alerts')

  // the alert interrupts browsing screens, but never an open proposal / fill / loading screen
  for (const kind of ['glance', 'list']) assert.equal(flow.maybeAlert({ kind }, view, {}, 0)?.kind, 'proposal')
  assert.equal(flow.maybeAlert({ kind: 'detail', coin: 'DOGE' }, view, {}, 0)?.coin, view.alert.coin)
  assert.equal(flow.maybeAlert({ kind: 'filled', text: '' }, view, {}, 0), null)
  assert.equal(flow.maybeAlert({ kind: 'loading', msg: '' }, view, {}, 0), null)
  assert.equal(flow.maybeAlert({ kind: 'proposal', coin: 'X', idx: 0, from: 'detail' }, view, {}, 0), null)
  // snoozed coins do not interrupt until the snooze runs out
  assert.equal(flow.maybeAlert({ kind: 'glance' }, view, { [view.alert.coin]: 1000 }, 999), null)
  assert.ok(flow.maybeAlert({ kind: 'glance' }, view, { [view.alert.coin]: 1000 }, 1001))

  let s = flow.maybeAlert({ kind: 'glance' }, view, {}, 0)
  assert.deepEqual(s, { kind: 'proposal', coin: view.alert.coin, idx: 0, from: 'alert' })
  const first = flow.render(s, view)
  assertFits(first)
  assert.match(first.text, /LIQ .*AWAY/)
  assert.match(first.text, /Reduce 25%\? \(paper\)/)

  // swipe = no -> Reduce 50%
  s = flow.step(s, view, { kind: 'swipe' }).screen
  assert.equal(s.idx, 1)
  assert.match(flow.render(s, view).text, /Reduce 50%\? \(paper\)/)

  // tap = YES -> confirm effect carrying exactly the offered action id
  const r = flow.step(s, view, { kind: 'tap' })
  assert.equal(r.screen.kind, 'loading')
  const act = view.positions.find(p => p.coin === s.coin).actions[1]
  assert.deepEqual(r.effect, { kind: 'confirm', coin: s.coin, action: act.id })

  // main.ts sends that effect to the backend; the paper fill is accepted
  const filled = await call('POST', `/api/paper?${q}`, { coin: r.effect.coin, action: r.effect.action, source: 'glasses' })
  assert.equal(filled.code, 200)
  const fs = { kind: 'filled', text: filled.body.text }
  assertFits(flow.render(fs, view))
  assert.match(filled.body.text, /PAPER FILLED/)
  assert.match(filled.body.text, /no funds moved/)

  // tap on the fill -> glance + refresh; the refreshed view no longer alerts on this coin
  const back = flow.step(fs, view, { kind: 'tap' })
  assert.deepEqual(back, { screen: { kind: 'glance' }, effect: { kind: 'refresh' } })
  view = (await call('GET', `/api/state?${q}`)).body
  assert.notEqual(view.alert?.coin, s.coin)
  assert.equal(flow.maybeAlert({ kind: 'glance' }, view, {}, 0)?.coin ?? null, view.alert?.coin ?? null)
  assert.match(flow.render({ kind: 'glance' }, view).text, /\(paper\)/)
})

t('flow: saying no to every alert option snoozes the coin and returns to the glance', async () => {
  const view = (await backend(CROSS)('GET', `/api/state?addr=${CROSS_ADDR}&alert=0.4`)).body
  let s = flow.maybeAlert({ kind: 'glance' }, view, {}, 0)
  const n = view.positions.find(p => p.coin === s.coin).actions.length
  let r
  for (let i = 0; i < n; i++) { r = flow.step(s, view, { kind: 'swipe' }); s = r.screen }
  assert.deepEqual(r, { screen: { kind: 'glance' }, effect: { kind: 'snooze', coin: view.alert.coin } })
})

t('flow: isolated account (live 11-24 fixture): offers within free USDC, Close on paper removes it', async () => {
  const call = backend(ISO_1124)
  const q = `addr=${ISO_ADDR}&alert=0.15`
  const view = (await call('GET', `/api/state?${q}`)).body
  assert.ok(view.alert, 'isolated BTC alerts at 15%')
  let s = flow.maybeAlert({ kind: 'glance' }, view, {}, 0)
  const p = view.positions.find(x => x.coin === s.coin)
  assert.equal(p.marginType, 'isolated')
  // free USDC is ~$0.07 here, so no add-margin offer may exceed it (the backend falls back to cuts)
  assert.ok(p.actions.every(a => a.kind !== 'margin' || a.amount <= (view.free ?? 0) + 1e-9), 'add-margin capped by free USDC')
  for (let i = 0; i < p.actions.length; i++) {
    assertFits(flow.render({ ...s, idx: i }, view))
  }
  const closeIdx = p.actions.findIndex(a => a.kind === 'reduce' && a.fraction === 1)
  assert.ok(closeIdx >= 0)
  s = { ...s, idx: closeIdx }
  assert.match(flow.render(s, view).text, /Close\? \(paper\)/)
  const r = flow.step(s, view, { kind: 'tap' })
  const ok = await call('POST', `/api/paper?${q}`, { coin: r.effect.coin, action: r.effect.action })
  assert.equal(ok.code, 200)
  const after = (await call('GET', `/api/state?${q}`)).body
  assert.ok(!after.positions.some(x => x.coin === s.coin), 'closed on paper: gone from the positions')
  assertFits(flow.render({ kind: 'glance' }, after))
  // a detail/proposal screen for a coin that is gone falls back to the glance
  assert.equal(flow.step({ kind: 'detail', coin: s.coin }, after, { kind: 'tap' }).screen.kind, 'glance')
  assert.equal(flow.step({ ...s, idx: 0 }, after, { kind: 'tap' }).screen.kind, 'glance')
})

t('flow: error screen retries on any input; loading ignores input', () => {
  assert.deepEqual(flow.step({ kind: 'error', msg: 'x' }, null, { kind: 'tap' }).effect, { kind: 'refresh' })
  const l = { kind: 'loading', msg: 'x' }
  assert.equal(flow.step(l, null, { kind: 'tap' }).screen, l)
  assertFits(flow.render({ kind: 'error', msg: 'backend: down' }, null))
  assertFits(flow.render({ kind: 'glance' }, null))
  // tap on an empty glance (no positions) does not open an empty list
  assert.equal(flow.step({ kind: 'glance' }, { positions: [] }, { kind: 'tap' }).screen.kind, 'glance')
})
