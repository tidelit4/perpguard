// Browser preview host for PerpGuard (dev only, not part of the packed .ehpk).
//
// The Even Hub SDK talks to its host through `window.flutter_inappwebview.callHandler('evenAppMessage', msg)`
// and receives pushes through `window._listenEvenAppMessage(msg)`. This file stands in for that host in a
// normal browser: it keeps the container page the app builds, draws it on a 576x288 canvas
// (4-bit green look, like the G2), and turns keyboard / button input into the same EvenHub events the
// glasses send. The app code (src/main.ts) and the real SDK run unmodified on top of it.
//
// It is an approximation for demos and screenshots: fonts and list scrolling differ from the hardware.
// The official reference is the Even Hub simulator (`npm run simulate`).

type Any = Record<string, any>
type Box = { x: number; y: number; w: number; h: number; pad: number; border: number; radius: number; id: number; name: string; capture: boolean }
type TextC = Box & { kind: 'text'; content: string }
type ListC = Box & { kind: 'list'; items: string[]; sel: number; selBorder: boolean }
type Container = TextC | ListC

const W = 576
const H = 288
const FG = ['#000000', '#1f6b1f', '#2f9e2f', '#44c944', '#5cff5c'] // textColor 0..4 (0 is invisible)
const FONT = '19px "Segoe UI", system-ui, sans-serif'
const LINE = 25
const ROW = 30

// Normalise keys so camelCase, proto_names and Pascal_Case all read the same: "X_Position" -> "xposition".
function norm(v: any): any {
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    const o: Any = {}
    for (const [k, x] of Object.entries(v)) o[k.replace(/_/g, '').toLowerCase()] = norm(x)
    return o
  }
  return v
}
const num = (v: any, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v))

const page: { containers: Container[]; exited: boolean } = { containers: [], exited: false }
const calls: Any[] = []
;(window as Any).__g2 = { page, calls, input, draw, snapshot: () => canvas.toDataURL('image/png') }

function box(c: Any): Box {
  return {
    x: num(c.xposition), y: num(c.yposition), w: num(c.width, W), h: num(c.height, H),
    pad: num(c.paddinglength), border: num(c.borderwidth), radius: num(c.borderradius ?? c.borderrdaius),
    id: num(c.containerid), name: String(c.containername ?? ''), capture: num(c.iseventcapture) === 1,
  }
}

function setPage(raw: Any) {
  const d = norm(raw)
  const cs: Container[] = []
  for (const t of d.textobject ?? []) cs.push({ ...box(t), kind: 'text', content: String(t.content ?? '') })
  for (const l of d.listobject ?? []) {
    const it = l.itemcontainer ?? {}
    cs.push({ ...box(l), kind: 'list', items: (it.itemname ?? []).map(String), sel: 0, selBorder: num(it.isitemselectborderen) === 1 })
  }
  page.containers = cs
  page.exited = false
  draw()
}

function upgrade(raw: Any) {
  const d = norm(raw)
  const c = page.containers.find(x => x.kind === 'text' && (x.id === num(d.containerid) || x.name === d.containername)) as TextC | undefined
  if (!c) return false
  c.content = String(d.content ?? '')
  draw()
  return true
}

// ---- host side of the bridge
async function callHandler(name: string, ...args: any[]) {
  let msg = args[0]
  if (typeof msg === 'string') { try { msg = JSON.parse(msg) } catch { /* keep string */ } }
  const method = msg?.method ?? msg?.name
  const data = msg?.data ?? msg?.params ?? msg?.arguments ?? {}
  calls.push({ name, method, data })
  switch (method) {
    case 'createStartUpPageContainer': setPage(data); return 0 // StartUpPageCreateResult.success
    case 'rebuildPageContainer': setPage(data); return true
    case 'textContainerUpgrade': return upgrade(data)
    case 'shutDownPageContainer': page.exited = true; draw(); return true
    case 'getLocalStorage': return localStorage.getItem(`g2host.${data?.key}`) ?? ''
    case 'setLocalStorage': localStorage.setItem(`g2host.${data?.key}`, String(data?.value ?? '')); return true
    case 'getUserInfo': return { uid: 0, name: 'preview', avatar: '', country: '' }
    default: return null
  }
}
;(window as Any).flutter_inappwebview = { callHandler }

// ---- input: the same gesture set the simulator's automation API accepts
const evType = { click: 0, up: 1, down: 2, double_click: 3 } as const
function push(type: 'sysEvent' | 'textEvent' | 'listEvent', jsonData: Any) {
  const listen = (window as Any)._listenEvenAppMessage
  if (typeof listen !== 'function') throw new Error('SDK bridge not initialised yet')
  listen({ type: 'listen_even_app_data', method: 'evenHubEvent', data: { type, jsonData } })
}

function input(action: keyof typeof evType) {
  const cap = page.containers.find(c => c.capture)
  if (!cap || page.exited) return 'ignored (no event container)'
  if (action === 'double_click') { push('sysEvent', { eventType: 3, eventSource: 1 }); return 'double_click' }
  if (cap.kind === 'list') {
    // The firmware moves the list focus itself and reports the selection on click.
    if (action === 'up' || action === 'down') {
      cap.sel = Math.max(0, Math.min(cap.items.length - 1, cap.sel + (action === 'down' ? 1 : -1)))
      draw()
      return `list sel ${cap.sel}`
    }
    push('listEvent', { containerID: cap.id, containerName: cap.name, currentSelectItemIndex: cap.sel, currentSelectItemName: cap.items[cap.sel], eventType: 0 })
    return `list click ${cap.sel}`
  }
  if (action === 'click') push('sysEvent', { eventType: 0, eventSource: 1 })
  else push('textEvent', { containerID: cap.id, containerName: cap.name, eventType: evType[action] })
  return action
}

// ---- drawing
const canvas = document.getElementById('g2') as HTMLCanvasElement
canvas.width = W
canvas.height = H
const g = canvas.getContext('2d')!

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const next = line + word
      if (g.measureText(next).width <= width || !line) line = next
      else { out.push(line.trimEnd()); line = word.trimStart() }
    }
    out.push(line)
  }
  return out
}

function frame(c: Box) {
  if (!c.border) return
  g.strokeStyle = FG[4]
  g.lineWidth = c.border
  g.beginPath()
  g.roundRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, c.radius)
  g.stroke()
}

function draw() {
  g.fillStyle = '#000'
  g.fillRect(0, 0, W, H)
  g.font = FONT
  g.textBaseline = 'top'
  if (page.exited) {
    g.fillStyle = FG[3]
    g.fillText('(app closed: system exit dialog)', 20, H / 2 - 10)
    return
  }
  for (const c of page.containers) {
    g.save()
    g.beginPath()
    g.rect(c.x, c.y, c.w, c.h)
    g.clip()
    frame(c)
    if (c.kind === 'text') {
      g.fillStyle = FG[4]
      wrap(c.content, c.w - 2 * c.pad).forEach((ln, i) => g.fillText(ln, c.x + c.pad, c.y + c.pad + i * LINE))
    } else {
      const visible = Math.max(1, Math.floor((c.h - 2 * c.pad) / ROW))
      const first = Math.max(0, Math.min(c.sel - visible + 1, c.items.length - visible))
      c.items.slice(first, first + visible).forEach((it, k) => {
        const i = first + k
        const y = c.y + c.pad + k * ROW
        if (i === c.sel && c.selBorder) {
          g.strokeStyle = FG[4]
          g.lineWidth = 2
          g.beginPath()
          g.roundRect(c.x + c.pad, y + 1, c.w - 2 * c.pad, ROW - 3, 6)
          g.stroke()
        }
        g.fillStyle = i === c.sel ? FG[4] : FG[3]
        g.fillText(it, c.x + c.pad + 8, y + 5)
      })
    }
    g.restore()
  }
}
draw()

// ---- controls: buttons + keyboard (arrows = swipe, Enter/Space = tap, D = double-tap)
const keymap: Record<string, keyof typeof evType> = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'click', ' ': 'click', d: 'double_click' }
window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return
  const a = keymap[e.key]
  if (a) { e.preventDefault(); input(a) }
})
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-g2]')) {
  b.addEventListener('click', () => input(b.dataset.g2 as keyof typeof evType))
}
