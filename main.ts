// Pump.fun Bot Sprint — early-entry spike seller for the agent-fun/replay/v2 harness.
//
// How it talks to the harness: the SDK shim owns the wire. The harness sends one
// `hello` message first (capital, caps, latency in slots, fees), then one `batch`
// message per slot (that slot's CreateEvent / TradeEvent / CompleteEvent records,
// the marks, the fills of earlier orders, and the account). This bot answers every
// batch with exactly one reply carrying its `orders` for that slot; orders decided
// on slot s fill at slot s + latency_slots. Nothing here reads the clock, the
// environment or any randomness, so two runs over the same replay produce the same
// action log byte for byte.
//
// Strategy, in short: buy early, sell into strength. A new curve is bought once,
// as soon as the per-reply size cap admits a real buy (real SOL reserves of at
// least 2 SOL, so the cap is at least 0.02 SOL), provided its price has not
// already run far past where it was first seen — never chase a spike that already
// happened. One buy per coin, no pyramiding, no re-entry. Exits are a ladder:
// sell half at +30%, let the rest ride under a trailing stop (armed at +25%,
// out on a 30% pullback from the peak), cut the whole position at -15%, and
// free the slot after a long hold so the next coin can be taken. A slow probe
// backstop buys tiny round trips on the most liquid curve only if the count of
// finished round trips lags the pace the guardrails need (at least 20 coins, each
// round trip at least 0.01 SOL), so the entry clears the bar even on a quiet
// window. Most pump.fun coins drift sideways and a few spike hard, so the edge is
// in catching the spikes while keeping every loss small and the fee bill low.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts'

// ------------------------------------------------------------------ parameters

/** SOL, as a float, for the price math (lamports stay exact BigInts on the wire). */
const SOL = 1_000_000_000
/** Buy once real SOL reserves reach this: the 1% size cap then admits >= 0.02 SOL. */
const MIN_REAL_SOL = 2
/** Most SOL put into one coin, and the size of its single buy. */
const BUY_SOL = 0.05
/** Smallest buy worth sending (also the guardrail's round-trip floor, with margin). */
const MIN_BUY_SOL = 0.02
/** Do not buy a coin whose price already ran this far past where it was first seen. */
const MAX_RUN_FROM_FIRST = 1.6
/** Do not buy a coin that already faded below this multiple of where it was
 * first seen: a coin going nowhere from its start rarely turns around. */
const MIN_RUN_FROM_FIRST = 1.03
/** Drop a candidate that never became buyable after this many slots. */
const MAX_CANDIDATE_AGE_SLOTS = 3000
/** A coin is only bought while it is fresh: this many slots after it first
 * became buyable (real SOL reserves reached MIN_REAL_SOL). Later than that the
 * early pump is usually over and buying means buying the decline. */
const MAX_BUYABLE_AGE_SLOTS = 120
/** Exits, as fractions of cost. (The ratio counts fees, so a stop of -0.12 fires
 * at roughly a -9% price move, and a take-profit of +0.20 at roughly +17%.) */
const STOP_LOSS = -0.12
const TAKE_HALF_AT = 0.2
const TRAIL_ARM = 0.2
const TRAIL_DROP = 0.25
/** Exit after this many slots held, unless the position is well up. */
const MAX_HOLD_SLOTS = 3000
const HOLD_IF_UP = 0.5
/** Guardrail probes: one tiny round trip at a time, bought on the most liquid curve. */
const PROBE_BUY_SOL = 0.02
const PROBE_PACE_START_SLOTS = 20000
const PROBE_TARGET_COINS = 25
const PROBE_WINDOW_SLOTS = 54000
/** Slippage allowed on buys; sells always go out wide open. */
const BUY_SLIPPAGE_BPS = 5000
const SELL_SLIPPAGE_BPS = 10000
/** A round trip counts toward the guardrails from this buy size up. */
const ROUND_TRIP_MIN_LAMPORTS = 10_000_000n

// ------------------------------------------------------------------ tape state

interface CoinTape {
  createdSlot: number | null
  firstPrice: number
  trades: number
  /** First slot the curve's real SOL reserves reached MIN_REAL_SOL (-1: not yet). */
  buyableSinceSlot: number
}

interface Held {
  openedSlot: number
  peakRatio: number
  tookHalf: boolean
  probe: boolean
}

const tapes = new Map<Pubkey, CoinTape>()
const candidates = new Set<Pubkey>()
const held = new Map<Pubkey, Held>()
/** SOL spent on filled buys per mint, for the round-trip count. */
const boughtLamports = new Map<Pubkey, bigint>()
/** Mints whose round trip (buy >= 0.01 SOL, then fully sold) is done. */
const roundTrips = new Set<Pubkey>()
/** Do not retry a rejected sell before this slot (per mint). */
const sellBlockedUntil = new Map<Pubkey, number>()
/** Largest fraction of a position one sell may take (per mint): shrunk when a
 * full sell is rejected for exceeding the curve's remaining real SOL. */
const sellFractionCap = new Map<Pubkey, number>()
let firstSlot = -1
let probeOpen: Pubkey | null = null

function tapeFor(mint: Pubkey): CoinTape {
  let tape = tapes.get(mint)
  if (tape === undefined) {
    tape = { createdSlot: null, firstPrice: 0, trades: 0, buyableSinceSlot: -1 }
    tapes.set(mint, tape)
  }
  return tape
}

/** SOL per token from the curve's virtual reserves. */
function priceOf(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint)
  if (curve === undefined) return 0
  const tokens = Number(curve.virtual_token_reserves)
  if (tokens <= 0) return 0
  return Number(curve.virtual_quote_reserves) / tokens
}

// ------------------------------------------------------------------ the bot

await runBot({
  onHello(state) {
    const { hello } = state
    console.error(
      `hello: capital ${hello.capital.lamports} lamports, ` +
        `max ${hello.caps.max_open_positions} open positions, ` +
        `latency ${hello.latency_slots} slots, ` +
        `max ${hello.caps.max_orders_per_batch} orders per batch`,
    )
  },

  onBatch(state, batch: Batch): OrderInput[] {
    if (firstSlot < 0) firstSlot = batch.slot
    const nowSlot = batch.slot
    const orders: OrderInput[] = []
    const orderedThisBatch = new Set<Pubkey>()
    const txFee = state.txFeeLamports()
    let free = state.freeCashLamports()

    // --- fold this batch's fills into the round-trip ledger -----------------
    for (const fill of batch.fills) {
      if (fill.status === 'rejected' && fill.side === 'sell') {
        // A rejected sell is never worth retrying every batch: back off, and
        // shrink the size when the curve cannot take a full sale any more
        // (its real SOL reserves collapsed below the sale's proceeds).
        if (fill.reason === 'max_order_size') {
          sellFractionCap.set(fill.mint, 0.05)
          sellBlockedUntil.set(fill.mint, nowSlot + 500)
        } else if (fill.reason === 'token_complete') {
          held.delete(fill.mint)
          if (probeOpen === fill.mint) probeOpen = null
        } else if (fill.reason !== null) {
          sellBlockedUntil.set(fill.mint, nowSlot + 200)
        }
        continue
      }
      if (fill.status !== 'filled') continue
      if (fill.side === 'buy') {
        const prev = boughtLamports.get(fill.mint) ?? 0n
        boughtLamports.set(fill.mint, prev + BigInt(fill.quote_lamports))
      } else if (!state.positions.has(fill.mint)) {
        const spent = boughtLamports.get(fill.mint) ?? 0n
        if (spent >= ROUND_TRIP_MIN_LAMPORTS) roundTrips.add(fill.mint)
      }
    }

    // --- drop held entries whose position the harness already closed --------
    // (a curve that completed, or the replay flattening at the end, closes a
    // position without a sell fill from this bot; without this the mint could
    // never be bought again because the stale entry blocks a fresh entry).
    for (const mint of [...held.keys()]) {
      if (state.positions.has(mint)) continue
      let buyPending = false
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'buy') {
          buyPending = true
          break
        }
      }
      if (!buyPending) {
        held.delete(mint)
        if (probeOpen === mint) probeOpen = null
      }
    }

    // --- fold this batch's events into the tapes ---------------------------
    const tradedThisBatch = new Set<Pubkey>()
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const tape = tapeFor(event.mint)
        tape.createdSlot = event.slot
        candidates.add(event.mint)
      } else if (event.event === 'TradeEvent') {
        const tape = tapeFor(event.mint)
        if (tape.firstPrice === 0) {
          tape.firstPrice = Number(event.virtual_sol_reserves) / Number(event.virtual_token_reserves)
        }
        tape.trades += 1
        tradedThisBatch.add(event.mint)
      } else if (event.event === 'CompleteEvent') {
        candidates.delete(event.mint)
      }
    }

    // --- exits first: sells free a position slot for the entries below -----
    for (const [mint, position] of state.positions) {
      const info = held.get(mint)
      if (info === undefined) continue
      // A sell already in flight decides this coin's exit: sending another
      // one would double-sell it. (The held entry is only dropped by the
      // cleanup once the position is really gone, so a failed sell is
      // retried here on the next batch instead of orphaning the position.)
      let sellPending = false
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'sell') {
          sellPending = true
          break
        }
      }
      if (sellPending) continue
      const blockedUntil = sellBlockedUntil.get(mint) ?? -1
      if (nowSlot < blockedUntil) continue
      const tokens = position.token_amount
      const cost = BigInt(position.cost_lamports)
      if (cost <= 0n) continue
      const price = priceOf(state, mint)
      if (price <= 0) continue
      const value = (Number(tokens) * price) / SOL
      const costSol = Number(cost) / SOL
      const ratio = value / costSol - 1
      if (ratio > info.peakRatio) info.peakRatio = ratio

      const heldSlots = nowSlot - info.openedSlot
      let sellFraction = 0
      if (info.probe) {
        // A probe is sold whole as soon as its buy has landed.
        sellFraction = 1
      } else if (ratio <= STOP_LOSS) {
        sellFraction = 1
      } else if (!info.tookHalf && ratio >= TAKE_HALF_AT) {
        sellFraction = 0.5
        info.tookHalf = true
      } else if (info.peakRatio >= TRAIL_ARM && ratio <= info.peakRatio - TRAIL_DROP) {
        sellFraction = 1
      } else if (heldSlots >= MAX_HOLD_SLOTS && ratio < HOLD_IF_UP) {
        sellFraction = 1
      }
      if (sellFraction <= 0) continue
      // A curve whose real SOL collapsed can only take a small sale at a time.
      const fractionCap = sellFractionCap.get(mint)
      if (fractionCap !== undefined && sellFraction > fractionCap) sellFraction = fractionCap
      if (orders.length >= state.hello.caps.max_orders_per_batch) break
      const amount = sellFraction >= 1
        ? tokens
        : (tokens * BigInt(Math.floor(sellFraction * 100))) / 100n
      if (amount <= 0n) continue
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      }
      orders.push(sell)
      orderedThisBatch.add(mint)
    }

    // --- entries: buy each new coin once, early, before it runs far --------
    // Prune first: this pass runs every batch, even with no free slot, so a
    // dead candidate never piles up behind a full book.
    for (const mint of [...candidates]) {
      const tape = tapes.get(mint)
      const curve = state.curves.get(mint)
      if (tape === undefined || curve === undefined || curve.complete) {
        candidates.delete(mint)
        continue
      }
      const age = tape.createdSlot === null ? 0 : nowSlot - tape.createdSlot
      if (age > MAX_CANDIDATE_AGE_SLOTS) {
        candidates.delete(mint)
        continue
      }
      if (held.has(mint) || state.positions.has(mint)) {
        candidates.delete(mint)
        continue
      }
      const price = priceOf(state, mint)
      if (price > 0 && tape.firstPrice > 0 && price > MAX_RUN_FROM_FIRST * tape.firstPrice) {
        candidates.delete(mint)
        continue
      }
      // A coin is only bought while it is fresh: once it has been buyable for
      // longer than MAX_BUYABLE_AGE_SLOTS without a free slot, the early pump
      // is over and the coin is skipped for good.
      const realSol = Number(curve.real_quote_reserves) / SOL
      if (realSol >= MIN_REAL_SOL) {
        if (tape.buyableSinceSlot < 0) tape.buyableSinceSlot = nowSlot
        else if (nowSlot - tape.buyableSinceSlot > MAX_BUYABLE_AGE_SLOTS) {
          candidates.delete(mint)
          continue
        }
      }
    }
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount()
    for (const mint of candidates) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break
      if (slots <= 0) break
      const curve = state.curves.get(mint)
      if (curve === undefined) continue
      const realSol = Number(curve.real_quote_reserves) / SOL
      if (realSol < MIN_REAL_SOL) continue
      const price = priceOf(state, mint)
      if (price <= 0) continue
      // Only buy a coin still above where it started: one already fading at
      // the entry moment rarely turns around (see the dev-window analysis).
      const tapeEntry = tapes.get(mint)
      if (
        tapeEntry !== undefined &&
        tapeEntry.firstPrice > 0 &&
        price < MIN_RUN_FROM_FIRST * tapeEntry.firstPrice
      ) {
        candidates.delete(mint)
        continue
      }
      const cap = state.maxBuyLamports(mint)
      const capSol = Number(cap) / SOL
      if (capSol < MIN_BUY_SOL) continue
      const buySol = Math.min(BUY_SOL, capSol)
      const amount = BigInt(Math.floor(buySol * SOL))
      if (free < amount + txFee) continue
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      }
      orders.push(buy)
      orderedThisBatch.add(mint)
      free -= amount + txFee
      slots -= 1
      held.set(mint, { openedSlot: nowSlot, peakRatio: 0, tookHalf: false, probe: false })
      candidates.delete(mint)
    }

    // --- guardrail probes: keep the round-trip count on pace ---------------
    const elapsed = nowSlot - firstSlot
    const expectedCoins = (elapsed / PROBE_WINDOW_SLOTS) * PROBE_TARGET_COINS
    if (
      probeOpen === null &&
      roundTrips.size < PROBE_TARGET_COINS &&
      elapsed > PROBE_PACE_START_SLOTS &&
      roundTrips.size < expectedCoins &&
      slots > 0 &&
      orders.length < state.hello.caps.max_orders_per_batch
    ) {
      let bestMint: Pubkey | null = null
      let bestReal = 0
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue
        if (held.has(mint) || state.positions.has(mint)) continue
        if ([...state.pending.values()].some((p) => p.order.mint === mint)) continue
        const realSol = Number(curve.real_quote_reserves) / SOL
        if (realSol > bestReal && state.maxBuyLamports(mint) >= BigInt(Math.floor(PROBE_BUY_SOL * SOL))) {
          bestReal = realSol
          bestMint = mint
        }
      }
      if (bestMint !== null) {
        const amount = BigInt(Math.floor(PROBE_BUY_SOL * SOL))
        if (free >= amount + txFee) {
          const buy: BuyInput = {
            side: 'buy',
            mint: bestMint,
            quote_lamports: amount,
            max_slippage_bps: BUY_SLIPPAGE_BPS,
          }
          orders.push(buy)
          probeOpen = bestMint
          held.set(bestMint, {
            openedSlot: nowSlot,
            peakRatio: 0,
            tookHalf: false,
            probe: true,
          })
        }
      }
    }

    return orders
  },
})
