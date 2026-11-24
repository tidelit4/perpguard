// PerpGuard on Even Realities G2: glance, position list, liquidation alert with tap = yes / swipe = no.
// The glasses app talks ONLY to the PerpGuard backend (server/), which reads Hyperliquid's public
// API and keeps a paper ledger. No keys, no wallet, no real orders anywhere in this app.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk'
import { step, render, maybeAlert, SNOOZE_MS, type Screen, type View, type Input, type Effect, type Render } from './flow'

// ---- config: ?addr=0x..&alert=0.1&api=http://host:8787 > saved in the phone page > demo account
const qs = new URLSearchParams(location.search)
const API = (qs.get('api') || import.meta.env.VITE_PERPGUARD_API || 'http://localhost:8787').replace(/\/$/, '')
const POLL_MS = 15_000
let addr = (qs.get('addr') || localStorage.getItem('pg.addr') || '').toLowerCase()
let alertPct = Number(qs.get('alert') || localStorage.getItem('pg.alert') || 0.1)

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${API}${path}${sep}addr=${addr}&alert=${alertPct}`, init)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body as T
}

// ---- glasses page: one full-screen text container, or a header + native list
const MAIN = { id: 1, name: 'main' }
const HDR = { id: 2, name: 'hdr' }
const LIST = { id: 3, name: 'pos' }
const W = 576
const H = 288

const textPage = (content: string) => ({
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: H,
    borderWidth: 0, borderColor: 5, paddingLength: 6,
    containerID: MAIN.id, containerName: MAIN.name,
    content, isEventCapture: 1,
  })],
})

const listPage = (header: string, items: string[]) => ({
  containerTotalNum: 2,
  textObject: [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: 40,
    borderWidth: 0, paddingLength: 6,
    containerID: HDR.id, containerName: HDR.name,
    content: header, isEventCapture: 0,
  })],
  listObject: [new ListContainerProperty({
    xPosition: 0, yPosition: 40, width: W, height: H - 40,
    borderWidth: 0, paddingLength: 4,
    containerID: LIST.id, containerName: LIST.name,
    itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: W - 8, isItemSelectBorderEn: 1, itemName: items }),
    isEventCapture: 1,
  })],
})

const bridge = await waitForEvenAppBridge()
const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(textPage('PERPGUARD\n\nconnecting...')))
console.log('[perpguard] page created:', created === StartUpPageCreateResult.success ? 'success' : `failed (${created})`)

let layout: 'text' | 'list' = 'text'
let shownText = ''
let listRows: string[] = []
let screen: Screen = { kind: 'loading', msg: 'connecting...' }
let view: View | null = null
const snoozedUntil: Record<string, number> = {}

async function paint(r: Render) {
  if (r.kind === 'text') {
    if (layout === 'text') {
      if (r.text === shownText) return
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: MAIN.id, containerName: MAIN.name, content: r.text }))
    } else {
      await bridge.rebuildPageContainer(new RebuildPageContainer(textPage(r.text)))
      layout = 'text'
    }
    shownText = r.text
  } else {
    listRows = r.items
    await bridge.rebuildPageContainer(new RebuildPageContainer(listPage(r.header, r.items)))
    layout = 'list'
    shownText = ''
  }
}

async function go(next: Screen) {
  if (next === screen) return // step() returns the same object when the input does nothing here
  screen = next
  await paint(render(screen, view))
  console.log(`[perpguard] screen ${screen.kind}`) // lets the simulator automation (tools/sim_shoot.mjs) sync on screens
  updatePhone()
}

async function refresh() {
  if (!addr) {
    const demo = await fetch(`${API}/api/demo`).then(r => r.json()).catch(() => null)
    addr = demo?.accounts?.[0] ?? ''
  }
  try {
    view = await api<View>('/api/state')
  } catch (e) {
    if (screen.kind !== 'proposal') await go({ kind: 'error', msg: `backend: ${String((e as Error).message || e).slice(0, 120)}` })
    return
  }
  const alert = maybeAlert(screen, view, snoozedUntil, Date.now())
  if (alert) return go(alert)
  if (screen.kind === 'loading' || screen.kind === 'error') return go({ kind: 'glance' })
  if (screen.kind === 'glance' || screen.kind === 'detail') return paint(render(screen, view)) // in-place, flicker-free
  updatePhone()
}

async function run(effect: Effect) {
  if (!effect) return
  if (effect.kind === 'refresh') return refresh()
  if (effect.kind === 'snooze') {
    snoozedUntil[effect.coin] = Date.now() + SNOOZE_MS
    return
  }
  // confirm: the backend re-reads live state and records a PAPER fill; nothing is sent to an exchange.
  try {
    const r = await api<{ text: string }>('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coin: effect.coin, action: effect.action, source: 'glasses' }),
    })
    view = await api<View>('/api/state').catch(() => view)
    await go({ kind: 'filled', text: r.text })
  } catch (e) {
    await go({ kind: 'error', msg: `not filled: ${String((e as Error).message || e).slice(0, 120)}` })
  }
}

// ---- input. CLICK is 0 and protobuf drops zero fields, so a present envelope without eventType
// is a tap (same rule as the official template). Taps arrive on sysEvent, scrolls on textEvent,
// list selections on listEvent.
const typeOf = (env?: { eventType?: OsEventTypeList }) => (env ? env.eventType ?? OsEventTypeList.CLICK_EVENT : null)
let busy = false
let lastInput = { key: '', at: 0 }

bridge.onEvenHubEvent(async event => {
  const sys = typeOf(event.sysEvent)
  const txt = typeOf(event.textEvent)
  const lst = typeOf(event.listEvent)
  if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || txt === OsEventTypeList.DOUBLE_CLICK_EVENT || lst === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Left to the system convention: exit (with the OS confirm dialog). Never used as "no".
    await bridge.shutDownPageContainer(1)
    return
  }
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return refresh()
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return

  let input: Input | null = null
  if (lst === OsEventTypeList.CLICK_EVENT && layout === 'list') {
    const name = event.listEvent?.currentSelectItemName
    const byName = name ? listRows.indexOf(name) : -1
    input = { kind: 'listSelect', index: byName >= 0 ? byName : event.listEvent?.currentSelectItemIndex ?? 0 }
  } else if (layout === 'text' && (sys === OsEventTypeList.CLICK_EVENT || txt === OsEventTypeList.CLICK_EVENT)) {
    input = { kind: 'tap' }
  } else if (layout === 'text' && (txt === OsEventTypeList.SCROLL_TOP_EVENT || txt === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    sys === OsEventTypeList.SCROLL_TOP_EVENT || sys === OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    input = { kind: 'swipe' }
  }
  if (!input || busy) return
  // One physical gesture can surface on more than one envelope; drop repeats within 250 ms.
  const key = JSON.stringify(input)
  if (key === lastInput.key && Date.now() - lastInput.at < 250) return
  lastInput = { key, at: Date.now() }

  busy = true
  try {
    const { screen: next, effect } = step(screen, view, input)
    await go(next)
    await run(effect)
  } finally {
    busy = false
  }
})

// ---- phone side (the WebView page): status + account settings. The glasses never need it.
function updatePhone() {
  const el = document.getElementById('app')
  if (!el) return
  if (!document.getElementById('pg-glance')) buildPhone(el)
  document.getElementById('pg-glance')!.textContent = view?.glance ?? 'loading...'
  document.getElementById('pg-status')!.textContent = `glasses screen: ${screen.kind} | backend: ${API}`
}

function buildPhone(el: HTMLElement) {
  el.innerHTML = `
    <div style="max-width:420px;text-align:left">
      <h3 style="margin:0 0 8px">PerpGuard</h3>
      <div style="opacity:.8;font-size:12px;margin-bottom:8px">Read-only Hyperliquid data. Every "write" is a PAPER trade. Not financial advice.</div>
      <pre id="pg-glance" style="white-space:pre-wrap;font-size:12px;background:#111;padding:8px"></pre>
      <label>Public address (0x..)<br><input id="pg-addr" style="width:100%"></label><br>
      <label>Alert when liquidation is within (%)<br><input id="pg-alert" type="number" min="1" max="50"></label>
      <button id="pg-save">Save</button>
      <div id="pg-status" style="opacity:.6;font-size:11px;margin-top:8px"></div>
    </div>`
  ;(document.getElementById('pg-addr') as HTMLInputElement).value = addr
  ;(document.getElementById('pg-alert') as HTMLInputElement).value = String(Math.round(alertPct * 100))
  document.getElementById('pg-save')!.addEventListener('click', () => {
    const a = (document.getElementById('pg-addr') as HTMLInputElement).value.trim().toLowerCase()
    const p = Number((document.getElementById('pg-alert') as HTMLInputElement).value) / 100
    if (/^0x[0-9a-f]{40}$/.test(a)) { addr = a; localStorage.setItem('pg.addr', a) }
    if (p >= 0.01 && p <= 0.5) { alertPct = p; localStorage.setItem('pg.alert', String(p)) }
    refresh()
  })
}

await refresh()
setInterval(() => { if (!busy) refresh() }, POLL_MS)
