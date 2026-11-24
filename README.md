# pump-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/barubinan123-boop/pump-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/barubinan123-boop/pump-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves: it buys each new coin once, early, while it is still rising from where it started, and sells into strength with a take-profit ladder, a trailing stop and a stop-loss. Built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty — the house replays it on 6 hours of pump.fun market data collected after entries close, ranked by net PnL.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout: the harness sends one `hello` message (capital, caps, latency in slots, fees), then one `batch` message per slot with that slot's market events, and the bot answers each batch with one reply carrying its `orders` for that slot. Node 22 runs the TypeScript directly, no build and no dependencies. The SDK shim it uses is vendored at `vendor/makefun-bot.ts`.

## Strategy

- **Buy early, once per coin.** A new curve is bought as soon as the per-reply size cap admits a real buy (real SOL reserves of at least 2 SOL, so the cap is at least 0.02 SOL), provided its price is still above where it started — never chase a spike that already happened, and never buy a coin already fading at the entry moment. One buy per coin, no pyramiding, no re-entry, and a coin is only bought while it is fresh (within 120 slots of first becoming buyable).
- **Sell into strength.** Half the position goes at +20%, the rest rides under a trailing stop (armed at +20%, out on a 25% pullback from the peak). The whole position is cut at -12%, and a long hold is freed after 3000 slots so the next coin can be taken.
- **Guardrails.** Every round trip is at least 0.01 SOL, the bot works through hundreds of coins so the 20-coin bar is cleared with margin, and at most 5 small positions are open at once, which keeps the drawdown far under the 50% limit. A rejected sell is backed off and retried small instead of spammed, so a curve whose real reserves collapsed can never lock a slot.
- **Deterministic.** No clock, no environment reads, no randomness — two runs over the same replay produce the same action log byte for byte.

## Grade it locally

With the bounty kit unpacked (it ships the dev dataset and the grader):

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=s0awek38&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
