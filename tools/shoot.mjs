// Drive the PerpGuard G2 browser preview in headless Edge and save glasses screenshots.
// usage: node shoot.mjs <outDir> [addr] [alertPct]
// Walks: glance -> list -> detail -> proposal (swipe = next option) -> tap = paper fill -> glance,
// then reloads with a tight alert threshold to capture the interrupting alert.
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const [out, addr = '0x71565a55237a3f069801b414ae825e33090576c3', alertArg = '0.1'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const state = () => page.evaluate(() => ({
  containers: window.__g2.page.containers.map(c => ({ kind: c.kind, name: c.name, content: c.content, items: c.items, sel: c.sel })),
  status: document.getElementById('pg-status')?.textContent ?? '',
}))
async function waitScreen(kind, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await state()
    if (s.status.includes(`glasses screen: ${kind} `)) return s
    await sleep(150)
  }
  throw new Error(`timeout waiting for screen ${kind}; last: ${JSON.stringify(await state())}`)
}
const results = []
async function shot(name) {
  await sleep(250)
  const s = await state()
  const png = await page.evaluate(() => window.__g2.snapshot())
  writeFileSync(join(out, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'))
  await page.screenshot({ path: join(out, `${name}_page.png`) })
  results.push({ name, status: s.status, containers: s.containers })
  console.log(`== ${name}: ${s.status}`)
  for (const c of s.containers) console.log(c.kind === 'text' ? c.content : `${(c.items || []).join('\n')}  [sel ${c.sel}]`)
}
const input = a => page.evaluate(x => window.__g2.input(x), a)

async function open(alert) {
  await page.goto(`http://localhost:5173/preview.html?addr=${addr}&alert=${alert}&api=http://localhost:8787`)
}

// Pass 1: comfortable threshold (no alert) to show the normal flow.
await open(0.02)
await waitScreen('glance')
await shot('01_glance')
await input('click')
await waitScreen('list')
await shot('02_list')
await input('click') // first row = closest to liquidation
await waitScreen('detail')
await shot('03_detail')

// Pass 2: alert threshold above the closest position -> the alert interrupts with a guard proposal.
await open(alertArg)
await waitScreen('proposal')
await shot('04_alert_proposal')
await input('down') // swipe = no -> next option
await sleep(300)
await shot('05_proposal_next')
await input('click') // tap = yes -> paper fill
await waitScreen('filled')
await shot('06_paper_filled')
await input('click')
await waitScreen('glance')
await shot('07_glance_after')

writeFileSync(join(out, 'walk.json'), JSON.stringify({ addr, alert: alertArg, results, logs }, null, 1))
console.log('console:', logs.filter(l => !l.includes('[vite]')).slice(0, 30).join('\n'))
await browser.close()
