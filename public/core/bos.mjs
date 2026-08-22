/**
 * Stateful HH/HL/LH/LL structure engine used by the SANI research.
 *
 * Pivot confirmation:
 *   low  at T-1 when T-2 > T-1 and T > T-1
 *   high at T-1 when T-2 < T-1 and T < T-1
 *
 * Bull: low -> high -> higher low -> break stored high => CALL
 * Bear: high -> low -> lower high -> break stored low => PUT
 *
 * Important: once a structure is ARMED (state 3), the BOS boundary stays
 * frozen. Only the confirming HL/LH may roll forward. This mirrors the
 * TickLock/statefix DBot logic that produced the clean virtual sample.
 */
export class StatefulBosStrategy {
  constructor(config = {}) {
    this.config = { bullEnabled: true, bearEnabled: true, ...config };
    this.reset();
  }

  setConfig(config = {}) {
    this.config = { ...this.config, ...config };
  }

  reset() {
    this.ticks = [];
    this.lastEpoch = -Infinity;
    this.resetStructure();
  }

  resetStructure() {
    this.bull = { state: 0, low: 0, high: 0, hl: 0 };
    this.bear = { state: 0, high: 0, low: 0, lh: 0 };
  }

  push(tick) {
    const epoch = Number(tick?.epoch);
    const quote = Number(tick?.quote);
    if (!Number.isFinite(epoch) || !Number.isFinite(quote) || epoch <= this.lastEpoch) return null;

    this.lastEpoch = epoch;
    const normalized = { epoch, quote };
    this.ticks.push(normalized);
    if (this.ticks.length > 64) this.ticks.shift();

    const signals = [];
    if (this.ticks.length < 3) return this.event(normalized, undefined, undefined, signals);

    const a = this.ticks.at(-3).quote;
    const p = this.ticks.at(-2).quote;
    const c = quote;
    const pivotLow = a > p && c > p ? p : undefined;
    const pivotHigh = a < p && c < p ? p : undefined;

    if (pivotLow !== undefined) this.onPivotLow(pivotLow);
    if (pivotHigh !== undefined) this.onPivotHigh(pivotHigh);

    // Evaluate BOS AFTER pivot state updates, matching the stateful DBot.
    if (this.bull.state === 3 && c > this.bull.high) {
      if (this.config.bullEnabled) signals.push(this.signal('CALL', normalized, this.bull.high, 'bullish-bos'));
      this.bull.state = 0;
    }
    if (this.bear.state === 3 && c < this.bear.low) {
      if (this.config.bearEnabled) signals.push(this.signal('PUT', normalized, this.bear.low, 'bearish-bos'));
      this.bear.state = 0;
    }

    return this.event(normalized, pivotLow, pivotHigh, signals);
  }

  onPivotLow(p) {
    // Bull sequence: low -> high -> higher low -> break the frozen high.
    if (this.bull.state === 0) {
      this.bull.low = p;
      this.bull.state = 1;
    } else if (this.bull.state === 1) {
      if (p < this.bull.low) this.bull.low = p; // roll lower low while waiting for high
    } else if (this.bull.state === 2) {
      if (p > this.bull.low && p < this.bull.high) {
        this.bull.hl = p;
        this.bull.state = 3;
      } else if (p <= this.bull.low) {
        this.bull.low = p;
        this.bull.state = 1; // invalidate and restart from new low
      }
    } else if (this.bull.state === 3) {
      if (p > this.bull.hl && p < this.bull.high) {
        this.bull.hl = p; // newer HL; BOS boundary unchanged
      } else if (p <= this.bull.low) {
        this.bull.low = p;
        this.bull.state = 1; // structure failed
      }
    }

    // Bear sequence: after first high, store/roll lower lows while waiting for LH.
    if (this.bear.state === 1) {
      this.bear.low = p;
      this.bear.state = 2;
    } else if (this.bear.state === 2 && p < this.bear.low) {
      this.bear.low = p;
    }
    // state 3 deliberately does NOT roll the BOS low.
  }

  onPivotHigh(p) {
    // Bear sequence: high -> low -> lower high -> break the frozen low.
    if (this.bear.state === 0) {
      this.bear.high = p;
      this.bear.state = 1;
    } else if (this.bear.state === 1) {
      if (p > this.bear.high) this.bear.high = p; // roll higher high while waiting for low
    } else if (this.bear.state === 2) {
      if (p < this.bear.high && p > this.bear.low) {
        this.bear.lh = p;
        this.bear.state = 3;
      } else if (p >= this.bear.high) {
        this.bear.high = p;
        this.bear.state = 1; // invalidate and restart from new high
      }
    } else if (this.bear.state === 3) {
      if (p < this.bear.lh && p > this.bear.low) {
        this.bear.lh = p; // newer LH; BOS boundary unchanged
      } else if (p >= this.bear.high) {
        this.bear.high = p;
        this.bear.state = 1; // structure failed
      }
    }

    // Bull sequence: after first low, store/roll higher highs while waiting for HL.
    if (this.bull.state === 1) {
      this.bull.high = p;
      this.bull.state = 2;
    } else if (this.bull.state === 2 && p > this.bull.high) {
      this.bull.high = p;
    }
    // state 3 deliberately does NOT roll the BOS high.
  }

  signal(direction, tick, level, structure) {
    return {
      id: `${direction}-${tick.epoch}-${tick.quote}`,
      direction,
      epoch: tick.epoch,
      quote: tick.quote,
      level,
      structure,
      bullState: { ...this.bull },
      bearState: { ...this.bear }
    };
  }

  event(tick, pivotLow, pivotHigh, signals) {
    return {
      tick,
      pivotLow,
      pivotHigh,
      signals,
      bullState: { ...this.bull },
      bearState: { ...this.bear }
    };
  }
}
