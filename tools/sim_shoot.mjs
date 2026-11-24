// Drive the OFFICIAL Even Hub simulator (0.9.5) through its automation port and save glasses-screen PNGs.
// usage: node tools/sim_shoot.mjs <port> <outDir> <plan: browse|alert>
// Start first: backend (npm run server), Vite (npm run dev), and
//   npx evenhub-simulator "http://localhost:5173/?addr=0x..&alert=0.02" --automation-port 9898
// The app logs "[perpguard] screen <kind>" on every screen change; we sync on that via /api/console.
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const [port = '9898', out, plan = 'browse'] = process.argv.slice(2)
if (!out) { console.error('usage: node sim_shoot.mjs <port> <outDir> <browse|alert>'); process.exit(2) }
mkdirSync(out, { recursive: true })
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = s => { console.log(s); appendFileSync(join(out, `sim_${plan}.log`), s + '\n') }

async function get(path) {
  const r = await fetch(base + path)
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`)
  return r
}
async function consoleText() {
  return await (await get('/api/console')).text()
}
// All "[perpguard] screen X" occurrences seen so far, in order.
async function screens() {
  return [...(await consoleText()).matchAll(/\[perpguard\] screen (\w+)/g)].map(m => m[1])
}
async function waitScreen(kind, since, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await screens()
    if (s.slice(since).includes(kind)) return s.length
    await sleep(250)
  }
  throw new Error(`timeout waiting for screen ${kind}; seen: ${(await screens()).join(',')}`)
}
async function shot(name) {
  await sleep(1200) // let the LVGL renderer finish the page swap
  const png = Buffer.from(await (await get('/api/screenshot/glasses')).arrayBuffer())
  writeFileSync(join(out, `${name}.png`), png)
  log(`shot ${name}.png (${png.length} B)`)
}
async function input(action) {
  const r = await fetch(base + '/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
  log(`input ${action} -> ${r.status} ${(await r.text()).slice(0, 80)}`)
}

// wait for the automation server
for (let i = 0; ; i++) {
  try { if ((await (await get('/api/ping')).text()).includes('pong')) break } catch { /* not up yet */ }
  if (i > 120) throw new Error('simulator automation port never answered')
  await sleep(500)
}
log(`ping ok (${plan})`)

let n = 0
if (plan === 'browse') {
  // low alert threshold: glance -> tap -> list -> tap -> detail -> tap -> guard proposal -> swipe -> next option
  n = await waitScreen('glance', 0)
  await shot('01_glance')
  await input('click'); n = await waitScreen('list', n); await shot('02_list')
  await input('click'); n = await waitScreen('detail', n); await shot('03_detail')
  await input('click'); n = await waitScreen('proposal', n); await shot('04_confirm_from_detail')
  await input('down'); await sleep(800); await shot('04b_confirm_next_option')
} else {
  // alert threshold above the closest position: the alert interrupts -> swipe = next -> tap = paper fill -> glance
  n = await waitScreen('proposal', 0)
  await shot('05_alert')
  await input('down'); await sleep(800); await shot('06_alert_swipe_next')
  await input('click'); n = await waitScreen('filled', n); await shot('07_paper_filled')
  await input('click'); n = await waitScreen('glance', n); await shot('08_glance_after')
}
try {
  writeFileSync(join(out, `webview_${plan}.png`), Buffer.from(await (await get('/api/screenshot/webview')).arrayBuffer()))
} catch (e) { log(`webview screenshot failed: ${e.message}`) }
writeFileSync(join(out, `console_${plan}.txt`), await consoleText())
log('done')
