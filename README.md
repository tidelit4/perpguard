# PerpGuard: a Hyperliquid liquidation guard for Even Realities G2

**Heads Up hackathon, Track 02: Crypto & DeFi (Hyperliquid).**

PerpGuard puts your Hyperliquid perp positions in the corner of your eye. When a position drifts
toward liquidation, the glasses interrupt with a concrete fix, and you answer with one gesture:
**tap = yes, swipe = no / next option**.

- **Read:** live positions, mark, liquidation price, PnL and funding for any public Hyperliquid
  address, from Hyperliquid's public `info` API. These are real accounts and real numbers, not mocks.
- **Write:** your "yes" records a **paper trade** (reduce 25% / 50% / close, or add isolated margin),
  priced at the live mark. The glasses then guard the *paper* position, so you see the liquidation
  distance move and the alert clear.

![Liquidation alert with a guard proposal (Even Hub simulator)](docs/shots/05_alert.png)

**Demo video (2:27, captioned, no audio):**
[demo_draft.mp4](https://github.com/tidelit4/perpguard/releases/download/v0.1-demo/demo_draft.mp4)
on the [v0.1-demo release](https://github.com/tidelit4/perpguard/releases/tag/v0.1-demo). It walks the
same official-simulator screens as below: glance, positions, detail, alert, paper fix and the glance after.

## Why read-only + paper

- **No keys anywhere.** The glasses app talks only to the PerpGuard backend, and the backend only
  calls Hyperliquid's public, unauthenticated `POST /info` endpoint. There is no wallet, no API key
  and no signing code in this repo.
- **The hackathon rules** ask for testnet, paper or read-only data, and for no user funds held.
  Hyperliquid's testnet faucet requires a prior mainnet deposit from the same address, and testnet
  agent wallets trade the master account's margin. A "testnet order" demo would therefore still need
  real money. Paper fills on live prices show the same decision loop with zero risk.
- **Not financial advice.** The proposals are mechanical what-ifs: "if you cut 25%, the liquidation
  price moves from X to Y". Fees and slippage are ignored, and every proposal is labelled `(paper)`.

## Screens (576x288, official Even Hub simulator, live data)

Every image below is the glasses framebuffer from the **official Even Hub simulator 0.9.5**
(`GET /api/screenshot/glasses` on its `--automation-port`). The app was driven with the simulator's
own tap/swipe inputs against the live backend on 2026-11-24 ~05:55Z. The accounts are public
Hyperliquid addresses with open positions; numbers change with the market.

| | |
|---|---|
| ![glance](docs/shots/01_glance.png) **Glance**: account value, free USDC, every position closest-to-liquidation first, funding per hour. Tap = positions, swipe = refresh. | ![list](docs/shots/02_list.png) **Positions**: native G2 list (at most 20 rows, 63 bytes each). Tap a row for details. |
| ![detail](docs/shots/03_detail.png) **Detail**: size, mark, entry, PnL, liq price and distance, funding. Tap = guard options, swipe = back. | ![confirm](docs/shots/04_confirm.png) **Confirm (on demand)**: a guard proposal with the new liq distance. Tap = YES (paper), swipe = next option. |
| ![alert](docs/shots/05_alert.png) **Alert (cross margin)**: interrupts any browsing screen when liq distance falls under your threshold (here 40%). | ![next](docs/shots/06_alert_swipe_next.png) **Swipe = no**: next option (Reduce 50%, then Close). After the last option the coin is snoozed for 5 min. |
| ![filled](docs/shots/07_paper_filled.png) **Tap = yes**: the backend re-reads live state and records a paper fill at the current mark. No funds move. | ![after](docs/shots/08_glance_after.png) **After**: the glance shows the paper position (`(paper)`) at 70.5% from liquidation; the alert is gone. |
| ![isolated](docs/shots/09_alert_isolated_add_margin.png) **Alert (isolated margin)**: cutting an isolated position does not move its liq price, so PerpGuard proposes adding margin, **capped by the USDC actually free** in the account (here: all $12.2k free, short of the $113k a 30% buffer would need, and it says so). | ![closed](docs/shots/10_isolated_closed_glance.png) **After a paper Close**: the position is gone, its margin is back in the free balance, and the glance lists it as closed on paper. |

Double-tap is deliberately unused. The system may own it (exit dialog), so the app passes it on as "exit".

## How it works

```
 G2 glasses  <-- Even Hub SDK -->  WebView app (src/)  --HTTP-->  PerpGuard backend (server/)  --HTTPS-->  api.hyperliquid.xyz/info
  text/list containers               screen state machine          analysis, screen text,                    (public, read-only)
  tap / swipe events                 (src/flow.ts)                 paper ledger (JSON file)
```

- **`server/hl.js`**: turns `clearinghouseState` + `metaAndAssetCtxs` into positions with liquidation
  distance and risk. It estimates the new liquidation price for each guard action: cross reduce,
  isolated add-margin, close. The estimate is calibrated on the liq price Hyperliquid reports, so it
  is exact at 0% change and also correct for unified accounts. Add-margin offers are capped by free
  USDC (perps `withdrawable` + spot USDC from `spotClearinghouseState`, per the account mode from
  `userAbstraction`).
- **`server/format.js`**: renders every glasses screen server-side as ASCII text within the display
  limits (≤ 999 bytes per text container, ≤ 63 bytes per list row).
- **`server/ledger.js`**: an append-only paper ledger, replayed in order on top of the live position.
- **`server/index.js`**: a tiny HTTP API.
  - `GET /api/state?addr=&alert=` returns the pre-rendered view.
  - `POST /api/paper` confirms an offered action. It re-reads live state first.
  - `GET` / `DELETE /api/paper` returns or clears the history.
  - `GET /api/demo` returns public demo accounts.
- **`src/flow.ts`**: a pure state machine (glance → list → detail → proposal → filled) plus the
  alert-interrupt rule. `server/test/flow.test.js` drives it with views from the real backend
  handler (recorded fixtures), from alert through paper fill to the cleared alert.
- **`src/main.ts`**: the SDK glue. It builds the page (one full-screen text container, or a header + a
  native list), applies flicker-free `textContainerUpgrade` updates, maps events (tap / swipe / list
  select) and polls every 15 s. The phone side of the WebView has a small settings form: public
  address and alert threshold.

## Run it

Requirements: Node 20+ (the Even Hub CLI's `pack` needs Node ≥ 20.17).

```bash
npm install
npm test                 # backend unit + API tests, plus glasses-flow tests (node --test server/test/)
npm run server           # backend on http://localhost:8787
npm run dev              # glasses app (Vite) on http://localhost:5173
```

Then pick one of these:

- **Even Hub simulator** (the official reference, installed as a dev dependency):
  `npx evenhub-simulator "http://localhost:5173/?addr=0x71565a55237a3f069801b414ae825e33090576c3&alert=0.4"`.
  With no `addr` the app uses the first demo account; you can also set the address and threshold in
  the phone-side form.
- **Browser preview (no simulator needed)**: open
  `http://localhost:5173/preview.html?addr=0x71565a55237a3f069801b414ae825e33090576c3&alert=0.4`.
  `preview/g2-host.ts` stands in for the Even App host bridge in a normal browser. It draws the
  containers the app creates on a 576x288 canvas and sends the same tap/swipe events. The app code and
  the real SDK run unmodified on top of it. Keys: Enter = tap, arrows = swipe, D = double-tap.
  Fonts and list scrolling are approximate; the simulator is the reference.
- **Real glasses**:
  1. Run the backend on a LAN address.
  2. Add that origin to `app.json` → `permissions[network].whitelist`.
  3. Start the app with `?api=http://<lan-ip>:8787`.
  4. Run `npx evenhub qr --url http://<lan-ip>:5173` and scan it with the Even App.

URL parameters: `addr` (public 0x address), `alert` (fraction, e.g. `0.1` = alert within 10% of
liquidation), `api` (backend origin). Backend env: `PORT`, `LEDGER_FILE`, `HL_INFO_URL`, `DEMO_ACCOUNTS`.

`npm run pack` builds `perpguard.ehpk` (optional).

### How the screenshots were made

With the backend and dev server running, start the simulator with an automation port, then let
`tools/sim_shoot.mjs` walk the flow with the simulator's own inputs (`POST /api/input`) and save
`GET /api/screenshot/glasses` after each step. The app logs `[perpguard] screen <kind>` on every
screen change, and the script syncs on that through `GET /api/console`.

```bash
npx evenhub-simulator "http://localhost:5173/?addr=0x7156...76c3&alert=0.02" --automation-port 9898
node tools/sim_shoot.mjs 9898 shots browse   # glance -> list -> detail -> confirm -> next option
# restart the simulator with &alert=0.4 (cross) or addr=0x69c3...30b2&alert=0.15 (isolated), then:
node tools/sim_shoot.mjs 9898 shots alert    # alert -> swipe -> tap (paper fill) -> glance
```

The simulator is a desktop window app (no headless mode), so this needs a desktop session.
`tools/shoot.mjs` does the same walk against `preview.html` in headless Edge (`npm i -D playwright-core`).

## What existed before the build window (2026-11-23 08:00 UTC)

The hackathon asks entrants to say what existed before Nov 23.

- **Who built it:** built by an AI coding agent (Anthropic's Claude) run by the entrant.
- **No PerpGuard app code existed before the window.** Every file in `server/` (including tests and
  recorded fixtures), `src/`, `preview/`, `tools/`, plus `app.json`, `preview.html` and this README
  was written from 2026-11-23 08:00 UTC onward.
- **Our only pre-window work was a written plan and research notes** (2026-11-22): the app idea,
  a day plan, reading the Even Hub SDK typings and docs, and checking Hyperliquid's public API
  response shapes and its testnet-faucet rule by hand with throwaway probe scripts. None of that is in
  this repo.
- **Third-party code we started from or depend on (not ours):**
  - the Even Realities `evenhub-templates/minimal` scaffold (`index.html`, `tsconfig.json`,
    `vite.config.ts`, the initial `package.json`), copied on 11-23 and since edited;
  - the npm packages `@evenrealities/even_hub_sdk` 0.0.16, `evenhub-cli` 0.2.0 and
    `evenhub-simulator` 0.9.5, plus Vite and TypeScript;
  - Hyperliquid's public `info` API.

## Limitations / next

- Liquidation estimates ignore fees, slippage and funding accrual between polls.
- Free USDC is conservative: paper cuts and closes of *cross* positions do not credit released
  margin back to the free figure (cuts and closes of isolated positions do, pro rata).
- The app can't push alerts while it's in the background. A Telegram bot leg for background alerts
  is the natural next step.
- Voice commands ("reduce half", "close", "next") are planned. The SDK provides raw 16 kHz PCM.

## Even Hub API feature requests (from building this)

1. A headless simulator mode (no window) for CI screenshots and tests.
2. A background notification API, so a guard app can alert when it isn't in the foreground.
3. A ring `eventSource` in the simulator, which is currently hard-coded to the right temple.
4. Documentation of which gestures the system reserves (double-tap → exit dialog?).
5. An official browser host mock for the SDK bridge, like `preview/g2-host.ts`, for quick UI work.

## License

MIT
