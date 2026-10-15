# Poker Later

A bare-bones Poker Now clone: no-limit Texas Hold'em in the browser. Create a table, send the link, play.

```
npm install
npm start   # http://localhost:3000
```

- Up to 9 seats, buy in for any amount, add chips between hands, blinds 10/20
- Ledger: buy-ins, cash-outs, stacks, and net per player
- Board cards flip in one at a time; all-in runouts are dealt slowly
- Side pots, split pots, showdown reveals
- Refresh-safe (your seat sticks to your browser)
- Disconnected players auto-check/fold
- Folding with nothing to call counts as a check
- Keyboard: `f` fold, `c` check/call

## Chicken Poker

The host can switch the table to Chicken Poker from **Game** (takes effect next hand; same ledger as Hold'em).

- Everyone antes (host sets the amount, default 100) and gets 2 cards
- A 15-second clock starts. Press **Space** (or tap **Redeal**) to redeal every hand at the table; the clock restarts
- Each player can force one redeal per hand
- When the clock runs out, or nobody has a redeal left, all cards flip face up and the board runs out. Best hand takes the pot
