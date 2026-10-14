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
  constructor({ startingStack = 1000, sb = 10, bb = 20 } = {}) {
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
  }

  say(msg) {
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }

  sit(seat, id, name) {
    if (seat < 0 || seat >= SEATS || this.seats[seat]) return 'Seat taken';
    if (this.seats.some(p => p && p.id === id)) return 'Already seated';
    this.seats[seat] = {
      id, name, stack: this.startingStack, cards: [], bet: 0, total: 0,
      folded: true, allIn: false, acted: false, connected: true, leaving: false,
    };
    this.say(`${name} sits in seat ${seat + 1} with ${this.startingStack}`);
    this.maybeStart();
  }

  stand(id) {
    const i = this.seatOf(id);
    if (i < 0) return;
    const p = this.seats[i];
    this.say(`${p.name} stands up`);
    if (this.inHand && !p.folded) {
      if (this.toAct === i) this.act(id, 'fold');
      else { p.folded = true; this.say(`${p.name} folds`); this.checkEnd(); }
    }
    if (this.inHand) p.leaving = true;
    else this.seats[i] = null;
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

  rebuy(id) {
    const p = this.seats[this.seatOf(id)];
    if (!p || p.stack > 0 || (this.inHand && !p.folded)) return;
    p.stack = this.startingStack;
    this.say(`${p.name} rebuys for ${this.startingStack}`);
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
    // clear leavers
    this.seats = this.seats.map(p => (p && p.leaving ? null : p));
    this.handNo++;
    this.inHand = true;
    this.showdown = null;
    this.winners = [];
    this.board = [];
    this.deck = newDeck();
    for (const p of this.seats) if (p) {
      Object.assign(p, { cards: [], bet: 0, total: 0, acted: false, allIn: false, folded: p.stack <= 0 });
    }
    const live = (p) => !p.folded;
    this.dealer = this.nextSeat(this.dealer, live);
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

    if (action === 'fold') {
      p.folded = true;
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

  runOut() {
    while (this.street !== 'river') this.nextStreet();
    this.finish();
  }

  // auto-act for disconnected players so the table doesn't stall
  skipDisconnected() {
    const p = this.seats[this.toAct];
    if (p && !p.connected) this.act(p.id, this.currentBet > p.bet ? 'fold' : 'check');
  }

  finish() {
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
        const elig = live.filter(x => x.p.total >= lvl);
        prev = lvl;
        if (!amt || !elig.length) continue;
        let best = [];
        for (const x of elig) {
          const c = best.length ? cmp(x.hand.score, best[0].hand.score) : 1;
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
        cards: p.id === viewerId || (this.showdown && this.showdown[i]) ? p.cards : null,
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
      log: this.log.slice(-40),
      you: this.seatOf(viewerId),
    };
  }
}
