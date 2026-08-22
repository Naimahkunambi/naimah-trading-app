export class ShadowTimingLab {
  constructor(horizons = [1, 2, 3]) { this.setHorizons(horizons); }

  setHorizons(horizons) {
    this.horizons = [...new Set(horizons.map(Number).filter(h => Number.isInteger(h) && h >= 1))].sort((a, b) => a - b);
    this.tickIndex = -1;
    this.pending = [];
    this.scores = new Map(this.horizons.map(h => [h, { horizon: h, wins: 0, losses: 0, ties: 0, pending: 0 }]));
  }

  addSignal(signal, signalQuote) {
    this.pending.push({ signal: { ...signal }, signalQuote: Number(signalQuote), index: this.tickIndex });
    this.refresh();
  }

  onTick(tick) {
    this.tickIndex += 1;
    const maxH = Math.max(...this.horizons, 1);
    for (const item of this.pending) {
      const delta = this.tickIndex - item.index;
      if (!this.horizons.includes(delta)) continue;
      const score = this.scores.get(delta);
      const q = Number(tick.quote);
      const win = item.signal.direction === 'CALL' ? q > item.signalQuote : q < item.signalQuote;
      const tie = q === item.signalQuote;
      if (tie) score.ties += 1;
      // Conservative convention from the DBot research: ties count as losses.
      if (win) score.wins += 1;
      else score.losses += 1;
    }
    this.pending = this.pending.filter(item => this.tickIndex - item.index < maxH);
    this.refresh();
  }

  snapshot() { return [...this.scores.values()].map(x => ({ ...x })); }

  refresh() {
    for (const s of this.scores.values()) {
      s.pending = this.pending.filter(item => this.tickIndex - item.index < s.horizon).length;
    }
  }
}
