# PerpGuard: DoraHacks "Heads Up" submission draft

**Track:** 02 Crypto & DeFi (Hyperliquid)
**Repo:** https://github.com/tidelit4/perpguard
**Video:** https://github.com/tidelit4/perpguard/releases/download/v0.1-demo/demo_draft.mp4
(release page: https://github.com/tidelit4/perpguard/releases/tag/v0.1-demo). It is a 2:27 silent,
captioned walk-through (1280x720 H.264, a title card plus 12 scenes) made from the glasses framebuffer
of the official Even Hub simulator 0.9.5 on live mainnet data (2026-11-24): glance, positions, detail,
guard proposal, cross-margin alert, swipe = next option, tap = paper fill, alert cleared, isolated
alert with capped add-margin, the phone-side settings form, and the glance after a paper close.

## Short description (one paragraph)

PerpGuard is a liquidation guard for Hyperliquid perps on Even Realities G2. A glance line shows
every position for a public address, closest to liquidation first: leverage, liquidation distance,
PnL and funding. It uses live data from Hyperliquid's public `info` API. When a position falls under
your alert threshold, the glasses interrupt with one concrete fix and the liquidation distance it
would give: "Reduce 25%? (paper)" for cross margin, or "Add $X margin? (paper)" for isolated margin.
The margin amount is capped by the USDC that is actually free. You answer with one gesture: tap =
yes, swipe = no / next option. A "yes" records a **paper** trade at the live mark. The glasses then
guard the paper position, so you see the distance move and the alert clear. There are no keys, no
signing and no real orders anywhere.

## Read + write

- **Read (real data):** `clearinghouseState`, `metaAndAssetCtxs`, `spotClearinghouseState` and
  `userAbstraction` from `POST api.hyperliquid.xyz/info`, which is public and needs no auth. The
  liquidation estimates are calibrated on the liquidation price Hyperliquid reports.
- **Write (paper):** `POST /api/paper` on the PerpGuard backend. It re-reads live state, prices the
  fill at the current mark and appends it to a paper ledger. The ledger is replayed in order on top
  of the live position.

## Safety

- The app and backend contain no wallet, private key, API key or signing code. The only upstream
  call is Hyperliquid's unauthenticated read endpoint.
- Every write is labelled `(paper)` on the glasses. The fill screen says "paper trade only: no funds
  moved".
- Proposals are mechanical what-ifs ("if you cut 25%, liq moves from X to Y"). They are not
  financial advice. Fees and slippage are ignored.
- Double-tap is never used as an answer, because the system may own it (exit dialog). A misread
  gesture can't confirm anything.
- Why not testnet: Hyperliquid's testnet faucet requires a prior mainnet deposit from the same
  address, and agent wallets trade the master account. A testnet demo would still need real money.

## What existed before 2026-11-23 08:00 UTC

- **No PerpGuard code.** Everything in `server/` (code, tests and recorded fixtures), `src/`,
  `preview/` and `tools/`, plus `app.json`, `preview.html`, `README.md` and this file, was written
  from 2026-11-23 08:00 UTC onward.
- **Before the window:** a written plan and research notes only (2026-11-22). They cover the app
  idea, reading the Even Hub SDK typings and docs, and checking Hyperliquid's public API shapes and
  its testnet-faucet rule by hand. None of that is in the repo.
- **Third-party code we started from:** the Even Realities `evenhub-templates/minimal` scaffold
  (`index.html`, `tsconfig.json`, `vite.config.ts`, the initial `package.json`), copied on 11-23
  and since edited. We also use the npm packages `@evenrealities/even_hub_sdk` 0.0.16,
  `@evenrealities/evenhub-cli` 0.2.0, `@evenrealities/evenhub-simulator` 0.9.5, Vite, TypeScript,
  and Hyperliquid's public API.

## Even Hub API feature requests (5)

1. **Headless simulator mode** (`evenhub-simulator --headless --automation-port N`). Today the
   simulator always opens a desktop window, even when it is driven entirely through the automation
   API. A no-window mode would let CI run UI tests and capture `/api/screenshot/glasses` on a server.
2. **Background notifications.** An API for an app to post a short alert (one text line plus
   tap/dismiss) to the glasses while it is not in the foreground. A guard app is only useful if it
   can interrupt you; today it can only alert while it is open.
3. **A documented reserved-gesture table and a "gesture consumed" flag.** State which inputs the
   system owns (double-tap → exit dialog? long-press?) per firmware version, so apps don't bind
   confirm or cancel to a gesture the OS may intercept.
4. **Ring input in the simulator.** `eventSource` is hard-coded to the right temple
   (`TOUCH_EVENT_FROM_GLASSES_R`). Add `{"action":..., "source":"ring"}` to `/api/input` so
   ring-driven flows can be tested.
5. **An official browser host mock for the SDK bridge.** A small npm package that implements
   `flutter_inappwebview.callHandler('evenAppMessage')` and `_listenEvenAppMessage` against a
   576x288 canvas (like our `preview/g2-host.ts`). It would allow UI iteration in any browser and
   Playwright tests without the simulator.

## How to run

See `README.md` → "Run it". In short: `npm install`, `npm test`, `npm run server`, `npm run dev`, then
`npx evenhub-simulator "http://localhost:5173/?addr=0x71565a55237a3f069801b414ae825e33090576c3&alert=0.4"`.

## Limitations

- Liquidation estimates ignore fees, slippage and funding accrual between polls (15 s).
- No background alerts yet (see feature request 2). A Telegram bot leg is the planned workaround.
- Paper cuts of cross positions do not credit the released margin back to "free" (conservative).
- Voice commands are planned, not built.
