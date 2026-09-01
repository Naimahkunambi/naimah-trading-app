using System;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiRunnerV2 : Robot
{
    private const string Label = "NAI-RUNNER-V2-LONG";
    private const string RequiredSymbolText = "Volatility 25 (1s)";

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 1.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Target R", DefaultValue = 1.50, MinValue = 1.20, MaxValue = 3.00, Step = 0.10)]
    public double TargetR { get; set; }

    [Parameter("Daily Equity Stop %", DefaultValue = 2.00, MinValue = 1.00, MaxValue = 5.00, Step = 0.50)]
    public double DailyEquityStopPercent { get; set; }

    [Parameter("Cooldown M1 Bars", DefaultValue = 2, MinValue = 1, MaxValue = 10)]
    public int CooldownBars { get; set; }

    [Parameter("ATR Period", DefaultValue = 14, MinValue = 8, MaxValue = 40)]
    public int AtrPeriod { get; set; }

    [Parameter("Break-even at R", DefaultValue = 0.80, MinValue = 0.50, MaxValue = 1.50, Step = 0.10)]
    public double BreakEvenAtR { get; set; }

    [Parameter("Trail at R", DefaultValue = 1.20, MinValue = 0.80, MaxValue = 2.50, Step = 0.10)]
    public double TrailAtR { get; set; }

    private Bars _bars = null!;
    private DateTime _lastLiveBarOpen = DateTime.MinValue;
    private double _dayStartEquity;
    private DateTime _equityDay;
    private int _lastEntryIndex = -10000;
    private int _entryIndex = -1;
    private bool _halted;
    private int _scanCount;

    private int _consecutiveFullLosses;
    private bool _lossPause;
    private bool _lossPauseSawReset;
    private bool _pauseResetLogged;
    private double? _lastStopRequestPrice;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI RUNNER V2 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI RUNNER V2 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _bars = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;
        Positions.Closed += OnPositionClosed;

        Print("NAI RUNNER V2 LONG-ONLY STARTED | {0} | TICK-DRIVEN M1 | risk={1:F2}% target={2:F2}R | BE={3:F2}R trail={4:F2}R", SymbolName, RiskPercent, TargetR, BreakEvenAtR, TrailAtR);
        Print("V2 PROTECTION | SHORTS OFF | pause after 2 consecutive full SL losses until LONG structure resets");
        Print("V2 SYMBOL | tick={0} pip={1} minVol={2} maxVol={3} minSL={4} minDistanceType={5}", Symbol.TickSize, Symbol.PipSize, Symbol.VolumeInUnitsMin, Symbol.VolumeInUnitsMax, Symbol.MinStopLossDistance, Symbol.MinDistanceType);
    }

    protected override void OnStop()
    {
        Positions.Closed -= OnPositionClosed;
    }

    protected override void OnTick()
    {
        if (_halted || Account.IsLive)
            return;

        ResetDailyAnchorIfNeeded();
        if (HitDailyStop())
            return;

        ManageOpenPosition();

        if (_bars == null || _bars.Count < 45)
            return;

        var liveOpen = _bars.OpenTimes[_bars.Count - 1];
        if (liveOpen == _lastLiveBarOpen)
            return;

        _lastLiveBarOpen = liveOpen;
        var closedIndex = _bars.Count - 2;
        ProcessClosedMinute(closedIndex);
    }

    private void ProcessClosedMinute(int i)
    {
        _scanCount++;
        if (i < 35)
            return;

        var open = FindRunnerPosition();
        if (open != null)
        {
            EvaluateEarlyExit(open, i);
            PrintPositionStatus(open, i);
            return;
        }

        var barsSinceEntry = i - _lastEntryIndex;
        if (barsSinceEntry < CooldownBars)
        {
            Print("NAI V2 | WAIT | scan={0} cooldown={1}/{2}", _scanCount, barsSinceEntry, CooldownBars);
            return;
        }

        var atr = Atr(i);
        if (atr <= Symbol.TickSize * 5)
        {
            Print("NAI V2 | WAIT | scan={0} ATR={1:F2} too small", _scanCount, atr);
            return;
        }

        TrendVotes(i, out var bull, out var bear);
        var longTrend = bull >= 3 && bull > bear;

        if (HandleLossPause(longTrend, bull, bear))
            return;

        // V2 deliberately preserves the V1 LONG entry logic exactly and simply refuses SHORT entries.
        if (!longTrend)
        {
            Print("NAI V2 | WAIT | LONG-ONLY | bull/bear votes={0}/{1}", bull, bear);
            return;
        }

        var setup = FindPullbackEntry(i, 1, atr) ?? FindMomentumEntry(i, 1, atr);

        if (setup == null)
        {
            var fast = AverageClose(i - 5, i);
            var slow = AverageClose(i - 17, i);
            var distance = Math.Abs(_bars.ClosePrices[i] - fast) / atr;
            Print("NAI V2 | WAIT | LONG votes={0}/{1} fastSlow={2:F2}ATR priceFast={3:F2}ATR", bull, bear, Math.Abs(fast - slow) / atr, distance);
            return;
        }

        ExecuteSetup(setup, i);
    }

    private bool HandleLossPause(bool longTrend, int bull, int bear)
    {
        if (!_lossPause)
            return false;

        if (!longTrend)
        {
            _lossPauseSawReset = true;
            if (!_pauseResetLogged)
            {
                _pauseResetLogged = true;
                Print("NAI V2 | LOSS PAUSE | LONG structure reset observed | votes={0}/{1} | waiting for fresh LONG", bull, bear);
            }
            return true;
        }

        if (_lossPauseSawReset)
        {
            _lossPause = false;
            _lossPauseSawReset = false;
            _pauseResetLogged = false;
            _consecutiveFullLosses = 0;
            Print("NAI V2 | RESUME | fresh LONG structure formed after loss pause | votes={0}/{1}", bull, bear);
            return false;
        }

        Print("NAI V2 | LOSS PAUSE | 2 full losses | current LONG is same regime | votes={0}/{1}", bull, bear);
        return true;
    }

    private Setup? FindPullbackEntry(int i, int trend, double atr)
    {
        var fast = AverageClose(i - 5, i);
        var slow = AverageClose(i - 17, i);
        var open = _bars.OpenPrices[i];
        var close = _bars.ClosePrices[i];
        var high = _bars.HighPrices[i];
        var low = _bars.LowPrices[i];
        var range = Math.Max(Symbol.TickSize, high - low);
        var body = Math.Abs(close - open);

        var trendSeparated = trend > 0 ? fast > slow + atr * 0.05 : fast < slow - atr * 0.05;
        if (!trendSeparated)
            return null;

        var touchedValue = trend > 0 ? low <= fast + atr * 0.18 : high >= fast - atr * 0.18;
        var closedBack = trend > 0 ? close > fast : close < fast;
        var candleAligned = trend > 0 ? close > open : close < open;
        var closeStrong = trend > 0 ? close >= low + range * 0.58 : close <= high - range * 0.58;

        if (!touchedValue || !closedBack || !candleAligned || !closeStrong || body < atr * 0.12)
            return null;

        var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = trend > 0 ? LowestLow(i - 4, i) : HighestHigh(i - 4, i);
        var stop = trend > 0 ? swing - atr * 0.10 : swing + atr * 0.10;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.45)
        {
            risk = atr * 0.55;
            stop = trend > 0 ? entry - risk : entry + risk;
        }
        if (risk > atr * 1.55)
            return null;

        var target = trend > 0 ? entry + risk * TargetR : entry - risk * TargetR;
        return new Setup(trend, "PULLBACK RUNNER", entry, stop, target, risk,
            $"valueTouch fast={fast:F2} body={body / atr:F2}ATR risk={risk / atr:F2}ATR");
    }

    private Setup? FindMomentumEntry(int i, int trend, double atr)
    {
        var open = _bars.OpenPrices[i];
        var close = _bars.ClosePrices[i];
        var high = _bars.HighPrices[i];
        var low = _bars.LowPrices[i];
        var range = Math.Max(Symbol.TickSize, high - low);
        var body = Math.Abs(close - open);
        var fast = AverageClose(i - 5, i);

        var priorHigh = HighestHigh(i - 4, i - 1);
        var priorLow = LowestLow(i - 4, i - 1);
        var broke = trend > 0 ? close > priorHigh : close < priorLow;
        var aligned = trend > 0 ? close > open : close < open;
        var closeStrong = trend > 0 ? close >= low + range * 0.70 : close <= high - range * 0.70;
        var distanceFromFast = Math.Abs(close - fast) / atr;
        var efficiency = Efficiency(i - 4, i);

        if (!broke || !aligned || !closeStrong || body < atr * 0.28 || efficiency < 0.48 || distanceFromFast > 1.25)
            return null;

        var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = trend > 0 ? LowestLow(i - 3, i) : HighestHigh(i - 3, i);
        var stop = trend > 0 ? swing - atr * 0.08 : swing + atr * 0.08;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.50)
        {
            risk = atr * 0.60;
            stop = trend > 0 ? entry - risk : entry + risk;
        }
        if (risk > atr * 1.40)
            return null;

        var target = trend > 0 ? entry + risk * TargetR : entry - risk * TargetR;
        return new Setup(trend, "MOMENTUM RUNNER", entry, stop, target, risk,
            $"break4 eff={efficiency:F2} body={body / atr:F2}ATR fastDist={distanceFromFast:F2}ATR");
    }

    private void ExecuteSetup(Setup setup, int i)
    {
        // Safety: even if a future edit accidentally creates a short setup, V2 refuses it here.
        if (setup.Direction <= 0)
        {
            Print("NAI V2 | SHORT BLOCKED | setup={0}", setup.Name);
            return;
        }

        var stopPips = Math.Abs(setup.Entry - setup.Stop) / Symbol.PipSize;
        var tpPips = Math.Abs(setup.Target - setup.Entry) / Symbol.PipSize;
        if (stopPips <= 0 || tpPips <= 0)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);

        if (volume < Symbol.VolumeInUnitsMin)
        {
            Print("NAI V2 | SKIP | risk-size {0} below broker min {1} | stop={2:F0} pips", volume, Symbol.VolumeInUnitsMin, stopPips);
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var result = ExecuteMarketOrder(TradeType.Buy, SymbolName, volume, Label, stopPips, tpPips, setup.Name);

        if (!result.IsSuccessful)
        {
            Print("NAI V2 | ENTRY REJECTED | {0} | {1}", setup.Name, result.Error);
            return;
        }

        _lastEntryIndex = i;
        _entryIndex = i;
        _lastStopRequestPrice = null;
        Print("NAI V2 | ENTER BUY | {0} | entry={1} SL={2} TP={3} volume={4} target={5:F2}R | {6}", setup.Name, result.Position.EntryPrice, setup.Stop, setup.Target, volume, TargetR, setup.Reason);
    }

    private void ManageOpenPosition()
    {
        var p = FindRunnerPosition();
        if (p == null || !p.TakeProfit.HasValue || !p.StopLoss.HasValue)
            return;

        var originalRisk = Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR;
        if (originalRisk <= Symbol.TickSize)
            return;

        var price = Symbol.Bid;
        var favorable = price - p.EntryPrice;
        var r = favorable / originalRisk;

        if (r >= BreakEvenAtR && p.StopLoss.Value < p.EntryPrice)
            TryMoveStop(p, p.EntryPrice, "BREAK-EVEN", r);

        if (r >= TrailAtR && _bars.Count > 5)
        {
            var i = _bars.Count - 2;
            var atr = Atr(i);
            var candidate = LowestLow(i - 2, i) - atr * 0.08;
            if (candidate > p.StopLoss.Value)
                TryMoveStop(p, candidate, "TRAIL", r);
        }
    }

    private void TryMoveStop(Position p, double rawCandidate, string reason, double liveR)
    {
        if (!p.StopLoss.HasValue)
            return;

        var candidate = NormalizePriceDown(rawCandidate);
        var minDistancePrice = MinimumStopDistancePrice(Symbol.Bid);
        var safetyDistance = Math.Max(minDistancePrice + Symbol.TickSize * 2.0, (Symbol.Ask - Symbol.Bid) + Symbol.TickSize * 2.0);
        var maxLegalStop = NormalizePriceDown(Symbol.Bid - safetyDistance);
        candidate = Math.Min(candidate, maxLegalStop);

        // Never move backwards and never spam the same modification every tick.
        if (candidate <= p.StopLoss.Value + Symbol.TickSize)
            return;
        if (_lastStopRequestPrice.HasValue && Math.Abs(candidate - _lastStopRequestPrice.Value) < Symbol.TickSize * 0.5)
            return;

        _lastStopRequestPrice = candidate;
        var result = ModifyPosition(p, candidate, p.TakeProfit, false);

        if (result.IsSuccessful)
        {
            Print("NAI V2 | {0} SUCCESS | SL -> {1:F2} | liveR={2:F2}", reason, candidate, liveR);
            return;
        }

        Print("NAI V2 | {0} REJECTED | requestedSL={1:F2} bid={2:F2} minSLDistance={3} type={4} | error={5}",
            reason, candidate, Symbol.Bid, Symbol.MinStopLossDistance, Symbol.MinDistanceType, result.Error);
    }

    private double MinimumStopDistancePrice(double referencePrice)
    {
        if (Symbol.MinStopLossDistance <= 0)
            return 0;

        if (Symbol.MinDistanceType == SymbolMinDistanceType.Percentage)
            return referencePrice * Symbol.MinStopLossDistance / 100.0;

        return Symbol.MinStopLossDistance * Symbol.PipSize;
    }

    private double NormalizePriceDown(double price)
    {
        if (Symbol.TickSize <= 0)
            return Math.Round(price, Symbol.Digits);

        var ticks = Math.Floor((price + Symbol.TickSize * 1e-6) / Symbol.TickSize);
        return Math.Round(ticks * Symbol.TickSize, Symbol.Digits);
    }

    private void EvaluateEarlyExit(Position p, int i)
    {
        TrendVotes(i, out var bull, out var bear);
        var strongOpposite = bear >= 4;
        if (!strongOpposite)
            return;

        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var favorable = Symbol.Bid - p.EntryPrice;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        var ageBars = _entryIndex >= 0 ? i - _entryIndex : 99;

        if (ageBars >= 2 && r < 0.40)
        {
            var result = ClosePosition(p);
            if (result.IsSuccessful)
                Print("NAI V2 | EARLY EXIT SUCCESS | strong opposite trend votes bull={0} bear={1} | R={2:F2}", bull, bear, r);
            else
                Print("NAI V2 | EARLY EXIT REJECTED | {0}", result.Error);
        }
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.Label != Label || p.SymbolName != SymbolName || p.TradeType != TradeType.Buy)
            return;

        _lastStopRequestPrice = null;
        _entryIndex = -1;

        var intendedRiskCash = Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        var fullLossThreshold = -intendedRiskCash * 0.65;
        var fullStopLoss = args.Reason == PositionCloseReason.StopLoss && p.NetProfit <= fullLossThreshold;

        if (fullStopLoss)
        {
            _consecutiveFullLosses++;
            Print("NAI V2 | FULL LOSS {0}/2 | net={1:F2} reason={2}", _consecutiveFullLosses, p.NetProfit, args.Reason);

            if (_consecutiveFullLosses >= 2)
            {
                _lossPause = true;
                _lossPauseSawReset = false;
                _pauseResetLogged = false;
                Print("NAI V2 | LOSS PAUSE ARMED | two consecutive full SL losses | waiting for LONG structure reset");
            }
            return;
        }

        // A win, break-even, scratch, or early exit breaks the consecutive FULL-loss chain.
        if (_consecutiveFullLosses > 0)
            Print("NAI V2 | FULL-LOSS STREAK RESET | close net={0:F2} reason={1}", p.NetProfit, args.Reason);
        _consecutiveFullLosses = 0;
    }

    private void PrintPositionStatus(Position p, int i)
    {
        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var favorable = Symbol.Bid - p.EntryPrice;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        TrendVotes(i, out var bull, out var bear);
        Print("NAI V2 | HOLD BUY | P/L={0:F2} R={1:F2} votes={2}/{3} SL={4} TP={5}", p.NetProfit, r, bull, bear,
            p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "--",
            p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "--");
    }

    private Position? FindRunnerPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label && p.TradeType == TradeType.Buy);

    private void TrendVotes(int i, out int bull, out int bear)
    {
        bull = 0;
        bear = 0;
        var atr = Atr(i);
        if (atr <= Symbol.TickSize)
            return;

        var fast = AverageClose(i - 5, i);
        var slow = AverageClose(i - 17, i);
        if (fast > slow + atr * 0.04) bull++; else if (fast < slow - atr * 0.04) bear++;

        var fastPast = AverageClose(i - 9, i - 4);
        if (fast > fastPast + atr * 0.05) bull++; else if (fast < fastPast - atr * 0.05) bear++;

        var move3 = _bars.ClosePrices[i] - _bars.ClosePrices[i - 3];
        if (move3 > atr * 0.12) bull++; else if (move3 < -atr * 0.12) bear++;

        var structure = StructureDirection(i);
        if (structure > 0) bull++; else if (structure < 0) bear++;

        var body = _bars.ClosePrices[i] - _bars.OpenPrices[i];
        if (body > atr * 0.10) bull++; else if (body < -atr * 0.10) bear++;
    }

    private int StructureDirection(int i)
    {
        if (i < 12)
            return 0;
        var recentHigh = HighestHigh(i - 5, i);
        var recentLow = LowestLow(i - 5, i);
        var priorHigh = HighestHigh(i - 11, i - 6);
        var priorLow = LowestLow(i - 11, i - 6);
        var atr = Atr(i);
        var tol = atr * 0.05;
        if (recentHigh > priorHigh + tol && recentLow >= priorLow - tol) return 1;
        if (recentLow < priorLow - tol && recentHigh <= priorHigh + tol) return -1;
        return 0;
    }

    private void ResetDailyAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay)
            return;
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        _consecutiveFullLosses = 0;
        _lossPause = false;
        _lossPauseSawReset = false;
        _pauseResetLogged = false;
        Print("NAI V2 | NEW DAY | equity anchor={0:F2}", _dayStartEquity);
    }

    private bool HitDailyStop()
    {
        if (_dayStartEquity <= 0)
            return false;
        var dd = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (dd < DailyEquityStopPercent)
            return false;
        _halted = true;
        var p = FindRunnerPosition();
        if (p != null)
            ClosePosition(p);
        Print("NAI V2 HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
        return true;
    }

    private double Atr(int i)
    {
        var from = Math.Max(1, i - AtrPeriod + 1);
        double total = 0;
        var count = 0;
        for (var k = from; k <= i; k++)
        {
            var tr = Math.Max(_bars.HighPrices[k] - _bars.LowPrices[k],
                Math.Max(Math.Abs(_bars.HighPrices[k] - _bars.ClosePrices[k - 1]), Math.Abs(_bars.LowPrices[k] - _bars.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private double Efficiency(int from, int to)
    {
        if (to <= from)
            return 0;
        var net = Math.Abs(_bars.ClosePrices[to] - _bars.ClosePrices[from]);
        double path = 0;
        for (var k = from + 1; k <= to; k++)
            path += Math.Abs(_bars.ClosePrices[k] - _bars.ClosePrices[k - 1]);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double AverageClose(int from, int to)
    {
        from = Math.Max(0, from);
        double sum = 0;
        var count = 0;
        for (var k = from; k <= to; k++)
        {
            sum += _bars.ClosePrices[k];
            count++;
        }
        return count == 0 ? _bars.ClosePrices[to] : sum / count;
    }

    private double HighestHigh(int from, int to)
    {
        from = Math.Max(0, from);
        var v = double.MinValue;
        for (var k = from; k <= to; k++) v = Math.Max(v, _bars.HighPrices[k]);
        return v;
    }

    private double LowestLow(int from, int to)
    {
        from = Math.Max(0, from);
        var v = double.MaxValue;
        for (var k = from; k <= to; k++) v = Math.Min(v, _bars.LowPrices[k]);
        return v;
    }

    private sealed record Setup(int Direction, string Name, double Entry, double Stop, double Target, double Risk, string Reason);
}
