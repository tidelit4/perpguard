// PerpGuard glasses flow: a pure state machine (no SDK, no network) so it can be unit-tested.
// Input scheme: tap = yes / select, swipe (up or down) = no / next / back. Double-tap is NOT used:
// the system may own it (exit dialog), so main.ts only passes it on as "exit".

export type Action = {
  id: string
  kind: 'margin' | 'reduce'
  label: string
  text: string
  estLiqDist: number | null
  amount?: number
  fraction?: number
}
export type Position = {
  coin: string
  side: number
  marginType: 'cross' | 'isolated'
  risk: 'safe' | 'warn' | 'danger'
  liqDist: number | null
  listItem: string
  detail: string
  alert: string | null
  actions: Action[]
}
export type View = {
  addr: string
  accountValue: number
  free?: number // USDC free to add as isolated margin (after paper actions); caps add-margin offers
  alertPct: number
  glanceLine: string
  glance: string
  closed: string[]
  alert: { coin: string; line: string } | null
  positions: Position[]
}

export type Screen =
  | { kind: 'loading'; msg: string }
  | { kind: 'error'; msg: string }
  | { kind: 'glance' }
  | { kind: 'list' }
  | { kind: 'detail'; coin: string }
  | { kind: 'proposal'; coin: string; idx: number; from: 'alert' | 'detail' }
  | { kind: 'filled'; text: string }

export type Input = { kind: 'tap' } | { kind: 'swipe' } | { kind: 'listSelect'; index: number }

export type Effect =
  | { kind: 'refresh' }
  | { kind: 'confirm'; coin: string; action: string }
  | { kind: 'snooze'; coin: string }
  | null

export type Render =
  | { kind: 'text'; text: string }
  | { kind: 'list'; header: string; items: string[] }

export const TEXT_LIMIT = 999
export const LIST_ITEM_LIMIT = 63
export const LIST_MAX_ITEMS = 20
export const SNOOZE_MS = 5 * 60 * 1000
export const BACK_ITEM = '< back'

const enc = new TextEncoder()
export function clampBytes(s: string, max: number): string {
  if (enc.encode(s).length <= max) return s
  let out = s
  while (enc.encode(out).length > max - 3) out = out.slice(0, -1)
  return out + '...'
}

const find = (v: View | null, coin: string) => v?.positions.find(p => p.coin === coin) ?? null

// List rows: positions (closest liquidation first) then a back row; at most 20 rows in total.
export function listItems(v: View): string[] {
  const rows = v.positions.slice(0, LIST_MAX_ITEMS - 1).map(p => clampBytes(p.listItem, LIST_ITEM_LIMIT))
  return [...rows, BACK_ITEM]
}

export function step(screen: Screen, view: View | null, input: Input): { screen: Screen; effect: Effect } {
  const stay = { screen, effect: null }
  switch (screen.kind) {
    case 'loading':
      return stay
    case 'error':
      return { screen: { kind: 'loading', msg: 'retrying...' }, effect: { kind: 'refresh' } }
    case 'glance':
      if (input.kind === 'tap' && view?.positions.length) return { screen: { kind: 'list' }, effect: null }
      if (input.kind === 'swipe') return { screen, effect: { kind: 'refresh' } }
      return stay
    case 'list': {
      if (input.kind !== 'listSelect' || !view) return stay
      const p = view.positions[input.index]
      if (!p || input.index >= LIST_MAX_ITEMS - 1) return { screen: { kind: 'glance' }, effect: null }
      return { screen: { kind: 'detail', coin: p.coin }, effect: null }
    }
    case 'detail': {
      if (!find(view, screen.coin)) return { screen: { kind: 'glance' }, effect: null }
      if (input.kind === 'tap') return { screen: { kind: 'proposal', coin: screen.coin, idx: 0, from: 'detail' }, effect: null }
      if (input.kind === 'swipe') return { screen: { kind: 'list' }, effect: null }
      return stay
    }
    case 'proposal': {
      const p = find(view, screen.coin)
      const act = p?.actions[screen.idx]
      if (!p || !act) return { screen: { kind: 'glance' }, effect: null }
      if (input.kind === 'tap') {
        return { screen: { kind: 'loading', msg: `${act.label} on paper...` }, effect: { kind: 'confirm', coin: p.coin, action: act.id } }
      }
      if (input.kind === 'swipe') {
        // "No": offer the next option; after the last one, step back out.
        if (screen.idx + 1 < p.actions.length) return { screen: { ...screen, idx: screen.idx + 1 }, effect: null }
        if (screen.from === 'alert') return { screen: { kind: 'glance' }, effect: { kind: 'snooze', coin: p.coin } }
        return { screen: { kind: 'detail', coin: p.coin }, effect: null }
      }
      return stay
    }
    case 'filled':
      if (input.kind === 'tap' || input.kind === 'swipe') return { screen: { kind: 'glance' }, effect: { kind: 'refresh' } }
      return stay
  }
}

// Interrupt with the alert screen when a position is under the threshold, unless the user is
// already deciding something, or said no to this coin in the last SNOOZE_MS.
export function maybeAlert(screen: Screen, view: View | null, snoozedUntil: Record<string, number>, now: number): Screen | null {
  const coin = view?.alert?.coin
  if (!coin) return null
  if (!['glance', 'list', 'detail'].includes(screen.kind)) return null
  if ((snoozedUntil[coin] ?? 0) > now) return null
  if (!find(view, coin)?.actions.length) return null
  return { kind: 'proposal', coin, idx: 0, from: 'alert' }
}

export function render(screen: Screen, view: View | null): Render {
  const text = (s: string): Render => ({ kind: 'text', text: clampBytes(s, TEXT_LIMIT) })
  switch (screen.kind) {
    case 'loading':
      return text(`PERPGUARD\n\n${screen.msg}`)
    case 'error':
      return text(`PERPGUARD\n\n${screen.msg}\n\ntap or swipe: retry`)
    case 'filled':
      return text(screen.text)
    case 'glance':
      return text(view ? view.glance : 'PERPGUARD\n\nno data yet')
    case 'list':
      if (!view) return text('PERPGUARD\n\nno data yet')
      return {
        kind: 'list',
        header: clampBytes(`POSITIONS ${view.positions.length}  ${view.glanceLine}`, 120),
        items: listItems(view),
      }
    case 'detail': {
      const p = find(view, screen.coin)
      return text(p ? p.detail : 'position closed')
    }
    case 'proposal': {
      const act = find(view, screen.coin)?.actions[screen.idx]
      return text(act ? act.text : 'no guard action')
    }
  }
}
