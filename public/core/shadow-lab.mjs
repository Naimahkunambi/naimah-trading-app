export class ShadowTimingLab {
  constructor(horizons = [1, 2, 3, 4]) { this.setHorizons(horizons); }

  setHorizons(horizons) {
    const clean = [...new Set(horizons.map(Number).filter(h => Number.isInteger(h) && h >= 1))].sort((a, b) => a - b);
    // Timing Lab v2 always measures the four true one-tick execution windows.
    this.maxHorizon = Math.max(...clean, 4);
    this.tickIndex = -1;
    this.pending = [];
    this.windows = Array.from({ length: 4 }, (_, i) => this.makeWindow(i, i + 1));
  }

  makeSide() { return { wins: 0, losses: 0, ties: 0 }; }

  makeWindow(from, to) {
    return {
      from,
      to,
      label: `${from}→${to}`,
      wins: 0,
      losses: 0,
      ties: 0,
      pending: 0,
      byDirection: { CALL: this.makeSide(), PUT: this.makeSide() }
    };
  }

  addSignal(signal, signalQuote) {
    this.pending.push({
      signal: { ...signal },
      signalQuote: Number(signalQuote),
      index: this.tickIndex,
      prices: { 0: Number(signalQuote) }
    });
    this.refresh();
  }

  onTick(tick) {
    this.tickIndex += 1;
    const q = Number(tick.quote);

    for (const item of this.pending) {
      const delta = this.tickIndex - item.index;
      if (delta < 1 || delta > 4) continue;

      item.prices[delta] = q;
      const start = item.prices[delta - 1];
      if (start === undefined) continue;

      const window = this.windows[delta - 1];
      const direction = item.signal.direction === 'PUT' ? 'PUT' : 'CALL';
      const side = window.byDirection[direction];
      const tie = q === start;
      const win = direction === 'CALL' ? q > start : q < start;

      if (tie) {
        window.ties += 1;
        side.ties += 1;
      }
      // Conservative convention from the DBot research: ties count as losses.
      if (win) {
        window.wins += 1;
        side.wins += 1;
      } else {
        window.losses += 1;
        side.losses += 1;
      }
    }

    this.pending = this.pending.filter(item => this.tickIndex - item.index < 4);
    this.refresh();
  }

  // Keep the existing dashboard renderer untouched. It already knows how to render
  // horizon/wins/losses/pending cards, so v2 exposes overall + CALL + PUT cards using
  // that stable shape. Example labels render as T+0→1, T+1→2 CALL, etc.
  snapshot() {
    const rows = [];
    for (const w of this.windows) {
      rows.push({
        horizon: w.label,
        wins: w.wins,
        losses: w.losses,
        ties: w.ties,
        pending: w.pending,
        scope: 'ALL',
        from: w.from,
        to: w.to
      });
      for (const direction of ['CALL', 'PUT']) {
        const s = w.byDirection[direction];
        rows.push({
          horizon: `${w.label} ${direction}`,
          wins: s.wins,
          losses: s.losses,
          ties: s.ties,
          pending: w.pending,
          scope: direction,
          from: w.from,
          to: w.to
        });
      }
    }
    return rows;
  }

  refresh() {
    for (const w of this.windows) {
      w.pending = this.pending.filter(item => this.tickIndex - item.index < w.to).length;
    }
  }
}
