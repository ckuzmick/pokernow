// No-limit Texas Hold'em engine. One Game per room.
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const SEATS = 9;

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---- hand evaluation: returns comparable array [category, ...tiebreakers]
const CAT_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

function eval5(cards) {
  const vals = cards.map(c => RANKS.indexOf(c[0])).sort((a, b) => b - a);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const uniq = [...new Set(vals)];
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals.join() === '12,3,2,1,0') straightHigh = 3; // wheel
  }
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts).map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const byGroup = groups.map(g => g[1]);
  if (straightHigh >= 0 && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...byGroup];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
  if (flush) return [5, ...vals];
  if (straightHigh >= 0) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...byGroup];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
  if (groups[0][0] === 2) return [1, ...byGroup];
  return [0, ...vals];
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1);
  }
  return 0;
}

export function bestHand(cards) {
  let best = null;
  const n = cards.length;
  // try every way to drop (n - 5) cards; n is 5..7
  const combos = n === 5 ? [[]] : n === 6 ? [...Array(6).keys()].map(a => [a]) : [];
  if (n === 7) for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) combos.push([a, b]);
  for (const drop of combos) {
    const five = cards.filter((_, i) => !drop.includes(i));
    const score = eval5(five);
    if (!best || cmp(score, best.score) > 0) best = { score, cards: five };
  }
  best.name = CAT_NAMES[best.score[0]];
  return best;
}

// ---- game
export class Game {
  constructor({ startingStack = 1000, sb = 10, bb = 20, runoutDelay = 2200, chickenTime = 15000 } = {}) {
    this.seats = Array(SEATS).fill(null);
    this.startingStack = startingStack;
    this.sb = sb;
    this.bb = bb;
    this.dealer = -1;
    this.inHand = false;
    this.board = [];
    this.log = [];
    this.handNo = 0;
    this.showdown = null; // {seat: {cards, handName}} revealed at end
    this.onChange = () => {};
    this.nextHandTimer = null;
    this.started = false;
    this.runoutDelay = runoutDelay; // ms between streets when everyone is all-in
    this.runoutTimer = null;
    this.ledger = new Map(); // id -> { name, buyIn, buyOut }
    // 'holdem' or 'chicken'; switching takes effect at the next hand
    this.mode = 'holdem';
    this.nextMode = 'holdem';
    this.ante = 100;
    this.chickenTime = chickenTime;
    this.chickenTimer = null;
  }

  setMode(mode) {
    if (!['holdem', 'chicken'].includes(mode) || mode === this.nextMode) return;
    this.nextMode = mode;
    const label = mode === 'chicken' ? 'Chicken Poker' : "Hold'em";
    this.say(this.inHand ? `Switching to ${label} next hand` : `Game switched to ${label}`);
    if (!this.inHand) this.mode = mode;
  }

  setAnte(amount) {
    const a = Math.floor(Number(amount));
    if (!(a > 0 && a <= 1e9)) return 'Enter a valid ante';
    this.ante = a;
    this.say(`Chicken ante set to ${a}`);
  }

  addBuyIn(id, name, amt) {
    const e = this.ledger.get(id) || { name, buyIn: 0, buyOut: 0 };
    e.name = name;
    e.buyIn += amt;
    this.ledger.set(id, e);
  }

  say(msg) {
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }

  sit(seat, id, name, amount) {
    if (seat < 0 || seat >= SEATS || this.seats[seat]) return 'Seat taken';
    if (this.seats.some(p => p && p.id === id && !p.leaving)) return 'Already seated';
    if (this.seats.some(p => p && p.id === id)) return 'You are leaving this hand, sit again after it ends';
    const amt = Math.floor(Number(amount));
    if (!(amt > 0 && amt <= 1e9)) return 'Enter a valid buy-in';
    this.seats[seat] = {
      id, name, stack: amt, cards: [], bet: 0, total: 0,
      folded: true, allIn: false, acted: false, connected: true, leaving: false,
    };
    this.addBuyIn(id, name, amt);
    this.say(`${name} sits in seat ${seat + 1} with ${amt}`);
    this.maybeStart();
  }

  stand(id) {
    const i = this.seatOf(id);
    if (i < 0) return;
    const p = this.seats[i];
    if (p.leaving) return;
    this.say(`${p.name} stands up`);
    if (this.inHand && !p.folded) {
      p.folded = true;
      p.foldedAt = ++this.foldCount;
      this.say(`${p.name} folds`);
      if (this.toAct === i) this.advance();
      else if (!this.checkEnd() && this.street === 'chicken' && !this.seats.some(q => q && !q.folded && !q.redealt)) this.flipChicken();
    }
    // a mid-hand leaver can still win an orphaned side pot, so cash out when the hand ends
    if (this.inHand) p.leaving = true;
    else this.cashOut(i);
  }

  cashOut(i) {
    const p = this.seats[i];
    this.ledger.get(p.id).buyOut += p.stack;
    this.seats[i] = null;
  }

  setConnected(id, connected) {
    const i = this.seatOf(id);
    if (i < 0) return;
    this.seats[i].connected = connected;
    if (!connected && this.inHand && this.toAct === i) this.skipDisconnected();
  }

  start() {
    this.started = true;
    this.maybeStart();
  }

  addChips(id, amount) {
    const p = this.seats[this.seatOf(id)];
    if (!p || p.leaving) return 'Not seated';
    if (this.inHand && !p.folded) return 'Wait until you are out of the hand';
    const amt = Math.floor(Number(amount));
    if (!(amt > 0 && amt <= 1e9)) return 'Enter a valid amount';
    p.stack += amt;
    this.addBuyIn(id, p.name, amt);
    this.say(`${p.name} adds ${amt} chips`);
    this.maybeStart();
  }

  seatOf(id) { return this.seats.findIndex(p => p && p.id === id); }

  nextSeat(from, pred) {
    for (let k = 1; k <= SEATS; k++) {
      const i = (from + k) % SEATS;
      if (this.seats[i] && pred(this.seats[i], i)) return i;
    }
    return -1;
  }

  ready() { return this.seats.filter(p => p && p.stack > 0 && !p.leaving).length >= 2; }

  maybeStart() {
    if (this.started && !this.inHand && !this.nextHandTimer && this.ready()) {
      this.nextHandTimer = setTimeout(() => { this.nextHandTimer = null; this.startHand(); this.onChange(); }, 1500);
    }
  }

  startHand() {
    if (this.inHand || !this.ready()) return;
    this.handNo++;
    this.inHand = true;
    this.showdown = null;
    this.winners = [];
    this.board = [];
    this.foldCount = 0;
    this.deck = newDeck();
    this.mode = this.nextMode;
    this.faceUp = false;
    for (const p of this.seats) if (p) {
      Object.assign(p, { cards: [], bet: 0, total: 0, acted: false, allIn: false, folded: p.stack <= 0, foldedAt: 0, redealt: false });
    }
    const live = (p) => !p.folded;
    this.dealer = this.nextSeat(this.dealer, live);
    if (this.mode === 'chicken') return this.startChicken();
    const n = this.seats.filter(p => p && live(p)).length;
    let sbSeat, bbSeat;
    if (n === 2) { sbSeat = this.dealer; bbSeat = this.nextSeat(sbSeat, live); }
    else { sbSeat = this.nextSeat(this.dealer, live); bbSeat = this.nextSeat(sbSeat, live); }
    this.sbSeat = sbSeat; this.bbSeat = bbSeat;
    this.say(`— Hand #${this.handNo} — dealer: ${this.seats[this.dealer].name}`);
    this.post(sbSeat, this.sb);
    this.post(bbSeat, this.bb);
    for (let r = 0; r < 2; r++) for (const p of this.seats) if (p && live(p)) p.cards.push(this.deck.pop());
    this.street = 'preflop';
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.toAct = this.nextSeat(bbSeat, p => !p.folded && !p.allIn);
    if (this.canActCount() === 0 || (this.canActCount() === 1 && this.seats[this.toAct].bet >= this.currentBet)) this.runOut();
    else this.skipDisconnected();
  }

  // ---- chicken poker: everyone antes, then a shot clock. Any player may
  // force a full redeal once. When the clock runs out (or nobody has a
  // redeal left), all hands flip face up and the board runs out.
  startChicken() {
    this.say(`— Hand #${this.handNo} · Chicken Poker — ante ${this.ante}`);
    this.seats.forEach((p, i) => p && !p.folded && this.post(i, this.ante));
    for (const p of this.seats) if (p) p.bet = 0; // antes go straight to the pot
    this.street = 'chicken';
    this.toAct = -1;
    this.currentBet = 0;
    this.redeals = 0;
    this.lastRedealBy = null;
    this.dealHoles();
  }

  dealHoles() {
    this.deck = newDeck();
    for (const p of this.seats) if (p && !p.folded) p.cards = [this.deck.pop(), this.deck.pop()];
    clearTimeout(this.chickenTimer);
    if (!this.seats.some(p => p && !p.folded && !p.redealt)) return this.flipChicken();
    this.chickenDeadline = Date.now() + this.chickenTime;
    this.chickenTimer = setTimeout(() => { this.flipChicken(); this.onChange(); }, this.chickenTime);
  }

  redeal(id) {
    if (!this.inHand || this.street !== 'chicken') return 'Nothing to redeal';
    const p = this.seats[this.seatOf(id)];
    if (!p || p.folded) return 'You are not in this hand';
    if (p.redealt) return 'You already used your redeal';
    p.redealt = true;
    this.redeals++;
    this.lastRedealBy = p.name;
    this.say(`${p.name} redeals!`);
    this.dealHoles();
  }

  flipChicken() {
    clearTimeout(this.chickenTimer);
    this.chickenTimer = null;
    if (!this.inHand || this.street !== 'chicken') return;
    this.faceUp = true;
    this.say('Cards up');
    for (const p of this.seats) if (p && !p.folded) this.say(`${p.name}: ${p.cards.join(' ')}`);
    this.street = 'preflop';
    this.runOut();
  }

  post(i, amt) {
    const p = this.seats[i];
    const a = Math.min(amt, p.stack);
    p.stack -= a; p.bet += a; p.total += a;
    if (p.stack === 0) p.allIn = true;
    this.say(`${p.name} posts ${a}`);
  }

  canActCount() { return this.seats.filter(p => p && !p.folded && !p.allIn).length; }
  pot() { return this.seats.reduce((s, p) => s + (p ? p.total : 0), 0); }

  act(id, action, amount = 0) {
    if (!this.inHand) return 'No hand in progress';
    const i = this.seatOf(id);
    if (i !== this.toAct) return 'Not your turn';
    const p = this.seats[i];
    const toCall = this.currentBet - p.bet;
    amount = Math.floor(Number(amount) || 0);

    if (action === 'fold' && toCall <= 0) action = 'check'; // never fold for free
    if (action === 'fold') {
      p.folded = true;
      p.foldedAt = ++this.foldCount;
      this.say(`${p.name} folds`);
    } else if (action === 'check') {
      if (toCall > 0) return 'Cannot check';
      this.say(`${p.name} checks`);
    } else if (action === 'call') {
      if (toCall <= 0) return 'Nothing to call';
      const a = Math.min(toCall, p.stack);
      p.stack -= a; p.bet += a; p.total += a;
      if (p.stack === 0) p.allIn = true;
      this.say(`${p.name} calls ${a}${p.allIn ? ' (all-in)' : ''}`);
    } else if (action === 'raise') {
      const max = p.bet + p.stack;
      const min = Math.min(this.currentBet + this.minRaise, max);
      if (amount > max) amount = max;
      if (amount < min) return `Minimum raise is to ${min}`;
      if (amount <= this.currentBet) return 'Raise must exceed current bet';
      const add = amount - p.bet;
      const raiseBy = amount - this.currentBet;
      p.stack -= add; p.bet = amount; p.total += add;
      if (p.stack === 0) p.allIn = true;
      if (raiseBy >= this.minRaise) this.minRaise = raiseBy;
      const verb = this.currentBet === 0 ? 'bets' : 'raises to';
      this.currentBet = amount;
      for (const q of this.seats) if (q && q !== p) q.acted = false;
      this.say(`${p.name} ${verb} ${amount}${p.allIn ? ' (all-in)' : ''}`);
    } else return 'Unknown action';

    p.acted = true;
    this.advance();
    return null;
  }

  checkEnd() {
    const live = this.seats.filter(p => p && !p.folded);
    if (live.length === 1) { this.finish(); return true; }
    return false;
  }

  advance() {
    if (this.checkEnd()) return;
    const needs = (p) => !p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet);
    const next = this.nextSeat(this.toAct, needs);
    if (next >= 0) { this.toAct = next; this.skipDisconnected(); return; }
    // betting round over
    if (this.street === 'river') return this.finish();
    if (this.canActCount() <= 1) return this.runOut();
    this.nextStreet();
    this.toAct = this.nextSeat(this.dealer, p => !p.folded && !p.allIn);
    this.skipDisconnected();
  }

  nextStreet() {
    for (const p of this.seats) if (p) { p.bet = 0; p.acted = false; }
    this.currentBet = 0;
    this.minRaise = this.bb;
    if (this.street === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.street = 'flop'; }
    else if (this.street === 'flop') { this.board.push(this.deck.pop()); this.street = 'turn'; }
    else if (this.street === 'turn') { this.board.push(this.deck.pop()); this.street = 'river'; }
    this.say(`${this.street[0].toUpperCase() + this.street.slice(1)}: ${this.board.join(' ')}`);
  }

  // deal remaining streets; paced so the table can sweat each card
  runOut() {
    this.toAct = -1;
    if (!this.runoutDelay) {
      while (this.street !== 'river') this.nextStreet();
      return this.finish();
    }
    const step = () => {
      this.runoutTimer = null;
      if (!this.inHand) return;
      if (this.street === 'river') this.finish();
      else { this.nextStreet(); this.runoutTimer = setTimeout(step, this.runoutDelay); }
      this.onChange();
    };
    this.runoutTimer = setTimeout(step, this.runoutDelay);
  }

  // auto-act for disconnected players so the table doesn't stall
  skipDisconnected() {
    const p = this.seats[this.toAct];
    if (p && !p.connected) this.act(p.id, this.currentBet > p.bet ? 'fold' : 'check');
  }

  finish() {
    clearTimeout(this.runoutTimer);
    clearTimeout(this.chickenTimer);
    this.runoutTimer = this.chickenTimer = null;
    this.toAct = -1;
    const players = this.seats.map((p, i) => p && { p, i }).filter(Boolean);
    const live = players.filter(x => !x.p.folded);
    const won = {};
    if (live.length === 1) {
      const amt = this.pot();
      live[0].p.stack += amt;
      won[live[0].i] = amt;
      this.say(`${live[0].p.name} wins ${amt}`);
    } else {
      this.showdown = {};
      for (const x of live) {
        x.hand = bestHand([...x.p.cards, ...this.board]);
        this.showdown[x.i] = { cards: x.p.cards, handName: x.hand.name };
        this.say(`${x.p.name} shows ${x.p.cards.join(' ')} (${x.hand.name})`);
      }
      // side pots by contribution level
      const levels = [...new Set(players.map(x => x.p.total).filter(t => t > 0))].sort((a, b) => a - b);
      let prev = 0;
      for (const lvl of levels) {
        let amt = 0;
        for (const x of players) amt += Math.max(0, Math.min(x.p.total, lvl) - prev);
        let elig = live.filter(x => x.p.total >= lvl);
        // everyone in this side pot folded: it goes to whoever folded last
        if (!elig.length) elig = [players.filter(x => x.p.total >= lvl).sort((a, b) => b.p.foldedAt - a.p.foldedAt)[0]];
        prev = lvl;
        if (!amt) continue;
        let best = [];
        for (const x of elig) {
          const c = best.length ? cmp(x.hand?.score ?? [], best[0].hand?.score ?? []) : 1;
          if (c > 0) best = [x]; else if (c === 0) best.push(x);
        }
        // odd chips go to first winner left of the dealer
        best.sort((a, b) => ((a.i - this.dealer + SEATS) % SEATS) - ((b.i - this.dealer + SEATS) % SEATS));
        const share = Math.floor(amt / best.length);
        let rem = amt - share * best.length;
        for (const x of best) {
          const w = share + (rem-- > 0 ? 1 : 0);
          x.p.stack += w;
          won[x.i] = (won[x.i] || 0) + w;
        }
      }
      for (const [i, amt] of Object.entries(won)) {
        this.say(`${this.seats[i].name} wins ${amt}${this.showdown[i] ? ` with ${this.showdown[i].handName}` : ''}`);
      }
    }
    this.winners = Object.keys(won).map(Number);
    for (const p of this.seats) if (p) { p.bet = 0; }
    for (const p of this.seats) if (p) p.total = 0;
    this.inHand = false;
    this.seats.forEach((p, i) => p && p.leaving && this.cashOut(i));
    if (this.started && this.ready()) {
      this.nextHandTimer = setTimeout(() => { this.nextHandTimer = null; this.startHand(); this.onChange(); }, 5000);
    }
  }

  // state as seen by one viewer
  view(viewerId) {
    return {
      seats: this.seats.map((p, i) => p && {
        name: p.name, stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn,
        connected: p.connected, isYou: p.id === viewerId,
        hasCards: p.cards.length > 0 && !p.folded,
        cards: p.id === viewerId || (this.faceUp && !p.folded) || (this.showdown && this.showdown[i]) ? p.cards : null,
        redealt: !!p.redealt,
        handName: this.showdown?.[i]?.handName ?? null,
      }),
      board: this.board,
      pot: this.inHand ? this.pot() : 0,
      inHand: this.inHand,
      started: this.started,
      dealer: this.dealer,
      toAct: this.inHand ? this.toAct : -1,
      currentBet: this.currentBet || 0,
      minRaise: this.minRaise || this.bb,
      winners: this.inHand ? [] : this.winners || [],
      sb: this.sb, bb: this.bb,
      mode: this.mode, nextMode: this.nextMode, ante: this.ante,
      chicken: this.inHand && this.street === 'chicken'
        ? { msLeft: Math.max(0, this.chickenDeadline - Date.now()), total: this.chickenTime, redeals: this.redeals, lastRedealBy: this.lastRedealBy }
        : null,
      log: this.log.slice(-40),
      you: this.seats.findIndex(p => p && p.id === viewerId && !p.leaving),
      ledger: [...this.ledger.entries()].map(([id, e]) => {
        const p = this.seats.find(q => q && q.id === id && !q.leaving);
        return { name: e.name, buyIn: e.buyIn, buyOut: e.buyOut, stack: p ? p.stack + p.total : 0, seated: !!p, isYou: id === viewerId };
      }),
    };
  }
}
