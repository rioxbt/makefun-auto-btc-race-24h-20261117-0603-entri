# makefun-auto-btc-race-24h-20261117-0603-entri

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/rioxbt/makefun-auto-btc-race-24h-20261117-0603-entri/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/rioxbt/makefun-auto-btc-race-24h-20261117-0603-entri/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A long-only cbBTC (Coinbase Wrapped BTC) bot that holds a core position from the first bar, scales in
when the price is cheap against the last 8 hours, and leaves on a take profit, a wide stop or a long
hold. It speaks `agent-fun/bars-replay/v1` through the kit's own shim, vendored verbatim, and trades
1-minute Coinbase Wrapped BTC / USDC bars replayed from an Orca Whirlpool.

## Run it

```sh
# the grader's own shape: node reads the harness's JSON lines on stdin and answers one reply per bar
node main.ts

# what the kit's CLI does to it, on the published dev window (docker, or process for a local run)
node <unpacked kit>/cli/makefun.mjs grade-local --kit <unpacked kit> --bot . --driver process
```

## How it decides

The bot starts with 1,000 USDC of paper money and may hold one position. Everything in `main.ts`
follows from the market model's own numbers, which the kit's dev window and pools let anyone check:

* **A round trip costs about 35-40 bps.** 4 bps of fee each way plus 2 bps of modelled slippage is
  12 bps, whatever the size; the constant-product price impact against a bar's own open depth (about
  700k to 1.06M USDC in this universe) adds roughly 12 bps more at full size, each way.
* **A minute moves about 6 bps.** On the dev window the per-minute close-to-close return has a
  standard deviation of 6.4 bps, its largest move is 45 bps and 141 of its 1,440 bars are flat, so
  crossing the spread often is a losing game: the bot trades three times in a day, not thirty.
* **Cash earns nothing and there are no shorts**, so a bot that waits for the perfect entry pays for
  it with the day's drift. Hence the core.

So the rules are:

1. **Core.** Buy 70% of equity on the first bar that has a close (bar 1's open). This is also the
   one own fill the guardrails ask for, so it can never be missed.
2. **Add.** Buy the remaining 30% when the close is 60 bps or more below the highest close of the
   last 480 bars (8 hours, expanding early in the window). Buy weakness once per dip: a *new* dip
   needs the drop to come back inside 60 bps first, so a fall is not bought bar after bar.
3. **Leave.** Sell everything at +250 bps over the position's average fill price, at -450 bps
   against it, or after 720 bars (12 hours). Then the bot stops: one core, one add, one exit. A
   second round trip has to be paid for out of the same 24 hours of noise, and on the evidence below
   it was not worth it.

Every order names a `max_slippage_bps` measured from the close it was decided on (40-60 bps), so a
bar that gaps away from the signal is dropped instead of filled at a price the signal never saw, and
a dropped entry is simply retried on the next bar.

## What it measured

Graded locally with the kit's own CLI on the published dev window (the exactly reproducible command
above; `result_sha256` depends on the whole snapshot and so changes with every commit, which is why
only the action log's hash is quoted below):

| | |
|---|---|
| Net PnL | **+5.129533 USDC** (return +0.5129533%) |
| Fills / rejections | 3 / 0 |
| Fees paid | 0.802095 USDC; net PnL at 2x fees 4.325504 USDC |
| Maximum drawdown | 2.1186% (the guardrail allows 25%) |
| Win rate | 1.000000 (one round trip) |
| Sharpe (per bar marks) | 0.006712569 |
| Exposure | 56.6% of the window |
| Determinism | two executions reproduce the action log byte for byte (`action_log_sha256` `3c044cf7add465d60c91510e59b543d028dc315778cef35b0f0b1f42ea245853`) |

The rules were also walked over 300 synthetic 24-hour windows rebuilt by resampling blocks of the dev
window's own minute returns (5 to 240 minutes), at zero drift and at +20/-20 bps per day, and
compared bar for bar with plain buy-and-hold on the same windows: the bot's mean net PnL was higher
in every drift scenario (about -1.1 vs -1.3 USDC at zero drift, +0.8 vs +0.7 at +20 bps/day, -3.1 vs
-3.3 at -20 bps/day) and it beat buy-and-hold in 82-90 of every 150 windows, mostly by buying 30% of
its size 60 bps cheaper in the middle of the day and by standing in cash after its exit instead of
riding a fall. One window is a small sample and no backtest forecasts the next 24 hours; the
reasoning above is why the thresholds sit where they do, not the fit.

## Files

* `main.ts` — the bot: the entrypoint the grader runs (`node /bot/main.ts`).
* `vendor/makefun-bars.ts` — the kit's SDK shim, byte for byte (sha256 `9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).
* `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
