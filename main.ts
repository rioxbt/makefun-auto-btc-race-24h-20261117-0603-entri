// make.fun entry for "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261117-0603).
//
// The harness replays 1-minute Coinbase Wrapped BTC (cbBTC) bars quoted in USDC, read from an Orca
// Whirlpool, and ranks every entry by its net PnL over the 24 hours that start 15 minutes after the
// deadline. The bot starts with 1,000 USDC of paper money, is long only, and holds one position.
//
// Why the bot is shaped the way it is
// -----------------------------------
// Three measured numbers drive every decision:
//
//   * cost. Every fill pays 4 bps of fee each way and 2 bps of modelled slippage, and it also moves
//     the bar's own constant-product pool, which at the depths in this universe (about 700k to
//     1.06M USDC) adds about 12 bps for a 1,000 USDC trade, each way. A full-size round trip
//     therefore costs about 35-40 bps before it can earn a cent, and 12 bps of that is fixed
//     whatever the size, so a trade has to be paid for by a move bigger than that.
//   * noise. Minute to minute the price moves about 6 bps (standard deviation) on this data and
//     many bars are flat, so crossing the spread often is a losing game: the bot trades seldom and
//     lets the few large moves pay for it.
//   * cash earns nothing and there are no shorts, so every minute spent flat forgoes the day.
//
// So: hold a core position so the day is never missed, buy the rest of the capital only when the
// close is well below the highest close of the last 8 hours (weakness good enough that the round
// trip is paid for), and leave once the position has made a large gain, lost too much, or been held
// a long time — after which the bot stops rather than churning a second round trip out of noise.
//
// On the published dev window this graded +5.13 USDC (3 fills, 0 rejections, 2.1% max drawdown); the
// same rules over 300 resampled 24-hour windows beat plain buy-and-hold on average and lost less in
// falling ones. See README.md for the measurements.
//
// The wire protocol (agent-fun/bars-replay/v1) is handled by the kit's own shim, vendored verbatim
// at vendor/makefun-bars.ts; this file only decides orders.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC'; // the only symbol in the universe
const BPS = 10_000n; // basis points: 10,000 bps = 100%
const MIN_NOTIONAL = 1_000_000n; // the protocol's floor: 1 USDC, in micro-USDC

// Position sizing. The core buys most of the capital on the first bar the bot can trade; the add
// waits for a dip. Both are sizes of equity at the moment of the decision.
const CORE_BPS = 7_000n;
const ADD_BPS = 3_000n;

// The reference high is the highest close of the last 8 hours (the window is 24 hours long); the add
// waits for the close to fall DIP_BPS below it.
const PEAK_BARS = 480;
const DIP_BPS = 60n;

// Leaving. +2.5% over the position's average cost is more than a round trip needs; -4.5% is a wide
// stop, because a tight one only pays the fee twice; 12 hours is long enough that a flat day ends
// the position rather than the bot.
const TAKE_PROFIT_BPS = 250n;
const STOP_BPS = 450n;
const MAX_HOLD_BARS = 720;

// max_slippage_bps is measured from the latest close the bot was sent, so it bounds how far the next
// open may jump before the order is dropped instead of filled.
const CORE_SLIP_BPS = 50;
const ADD_SLIP_BPS = 40;
const EXIT_SLIP_BPS = 60;

/** What the bot holds, what it has seen, and what it is waiting for. */
class Bot {
  closes: bigint[] = []; // the window's closes: the series a dip is measured against
  seq = -1; // the seq of the batch being answered (bar time, in bars)
  coreFilled = false; // the core buy is done for good
  corePending = false; // a core buy is outstanding
  addDone = false; // this position already took its dip add
  addPending = false; // a dip add is outstanding
  armed = true; // the dip has reset since the last buy, so a dip is a new one (true at the start: the
  // window may open with the fall itself, and nothing has been bought yet)
  qty = 0n; // the quantity this bot believes it holds, folded from its fills
  avg: bigint | null = null; // the average price those fills were done at
  peakGain: bigint | null = null; // the best mark over that cost, in bps
  lastEntry: number | null = null; // the seq of the last fill that opened or added to the position
  done = false; // the position was closed: the bot takes no further entry

  /** Answer one batch: the orders decided on it, or [] for none. */
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    this.seq = batch.seq;
    this.foldFills(batch);
    const close = state.close(SYMBOL);
    if (close === null) return []; // no bar for the symbol yet: nothing is priced
    // A warm-up batch (hello.warmup_bars, absent in this competition) is history to build from: its
    // orders would be rejected (warmup), so build the series and wait for the scored window.
    if (state.warmingUp) {
      this.closes.push(close);
      return [];
    }
    let orders = this.enter(state, close);
    if (orders.length === 0) orders = this.leave(state, close);
    this.closes.push(close); // the reference series grows after the decision
    return orders;
  }

  /** Fold the fills the replay reports for the orders sent on the previous bar. */
  private foldFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        this.corePending = this.addPending = false;
        if (fill.status !== 'filled') continue; // a dropped entry is retried on the next bar
        const qty = BigInt(fill.qty);
        const price = BigInt(fill.price);
        this.avg = this.qty === 0n ? price : (this.avg! * this.qty + qty * price) / (this.qty + qty);
        this.qty += qty;
        this.lastEntry = this.seq;
        this.peakGain = null;
        if (this.coreFilled) this.addDone = true;
        else this.coreFilled = true;
      } else if (fill.status === 'filled') {
        this.qty -= BigInt(fill.qty);
        if (this.qty <= 0n) {
          this.qty = 0n;
          this.avg = null;
          this.peakGain = null;
          this.lastEntry = null;
          this.done = true; // one core, one add, one exit: then the bot is finished
        }
      }
    }
  }

  private enter(state: BarsState, close: bigint): OrderInput[] {
    if (this.done) return [];
    if (!this.coreFilled) {
      if (this.corePending || this.qty > 0n || state.positions.has(SYMBOL)) return [];
      const notional = (state.equity * CORE_BPS) / BPS;
      this.corePending = true;
      return this.buy(notional, state, CORE_SLIP_BPS);
    }
    if (this.addDone || this.addPending || this.closes.length === 0) return [];
    const reference = this.closes.slice(-PEAK_BARS).reduce((hi, c) => (c > hi ? c : hi));
    const drop = (BPS * (reference - close)) / reference;
    if (drop < DIP_BPS) {
      this.armed = true; // the dip is behind us: the next one is fresh
      return [];
    }
    if (!this.armed) return []; // the dip that was already bought
    const byWeight = (state.equity * ADD_BPS) / BPS;
    const notional = byWeight < state.cash ? byWeight : state.cash;
    this.addPending = true;
    return this.buy(notional, state, ADD_SLIP_BPS);
  }

  private buy(notional: bigint, state: BarsState, slipBps: number): OrderInput[] {
    if (notional < MIN_NOTIONAL || notional > state.cash) {
      this.corePending = this.addPending = false;
      return [];
    }
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: slipBps }];
  }

  private leave(state: BarsState, close: bigint): OrderInput[] {
    const held = state.positions.get(SYMBOL);
    if (held === undefined) return [];
    const cost = this.avg ?? close;
    const gain = (BPS * (close - cost)) / cost;
    this.peakGain = this.peakGain === null || gain > this.peakGain ? gain : this.peakGain;
    const age = this.seq - (this.lastEntry ?? this.seq);
    if (gain >= TAKE_PROFIT_BPS || gain <= -STOP_BPS || age >= MAX_HOLD_BARS) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: EXIT_SLIP_BPS }];
    }
    return [];
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
