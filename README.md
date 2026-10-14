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
