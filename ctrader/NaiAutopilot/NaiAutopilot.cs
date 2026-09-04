using System;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiRunnerV1Instrumented : Robot
{
    private const string Label = "NAI-RUNNER-V1-INSTRUMENTED";
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

    // Instrumentation only. These fields do not participate in entry, exit, sizing or management decisions.
    private EntryMeta? _activeMeta;
    private int _longTrades;
    private int _shortTrades;
    private int _longWins;
    private int _longLosses;
    private int _longScratches;
    private int _shortWins;
    private int _shortLosses;
    private int _shortScratches;
    private int _pullbackTrades;
    private int _momentumTrades;
    private int _pullbackWins;
    private int _pullbackLosses;
    private int _pullbackScratches;
    private int _momentumWins;
    private int _momentumLosses;
    private int _momentumScratches;
    private int _fullRiskLosses;
    private double _longNet;
    private double _shortNet;
    private double _pullbackNet;
    private double _momentumNet;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI RUNNER V1 INSTRUMENTED BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI RUNNER V1 INSTRUMENTED BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _bars = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;
        Positions.Closed += OnPositionClosed;

        Print("NAI RUNNER V1 INSTRUMENTED STARTED | {0} | TICK-DRIVEN M1 | risk={1:F2}% target={2:F2}R | BE={3:F2}R trail={4:F2}R", SymbolName, RiskPercent, TargetR, BreakEvenAtR, TrailAtR);
        Print("CONTROL LOGIC | exact original Runner V1 trading rules | instrumentation only, no filters added");
        Print("RUNNER SYMBOL | tick={0} pip={1} minVol={2} maxVol={3} step={4}", Symbol.TickSize, Symbol.PipSize, Symbol.VolumeInUnitsMin, Symbol.VolumeInUnitsMax, Symbol.VolumeInUnitsStep);
    }

    protected override void OnStop()
    {
        Positions.Closed -= OnPositionClosed;
        PrintStats("BOT STOP");
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
            Print("NAI RUNNER | WAIT | scan={0} cooldown={1}/{2}", _scanCount, barsSinceEntry, CooldownBars);
            return;
        }

        var atr = Atr(i);
        if (atr <= Symbol.TickSize * 5)
        {
            Print("NAI RUNNER | WAIT | scan={0} ATR={1:F2} too small", _scanCount, atr);
            return;
        }

        TrendVotes(i, out var bull, out var bear);
        var trend = bull >= 3 && bull > bear ? 1 : bear >= 3 && bear > bull ? -1 : 0;
        var trendText = trend > 0 ? "LONG" : trend < 0 ? "SHORT" : "MIXED";

        var setup = trend == 0 ? null : FindPullbackEntry(i, trend, atr) ?? FindMomentumEntry(i, trend, atr);

        if (setup == null)
        {
            var fast = AverageClose(i - 5, i);
            var slow = AverageClose(i - 17, i);
            var distance = Math.Abs(_bars.ClosePrices[i] - fast) / atr;
            Print("NAI RUNNER | WAIT | scan={0} trend={1} votes={2}/{3} fastSlow={4:F2}ATR priceFast={5:F2}ATR", _scanCount, trendText, bull, bear, Math.Abs(fast - slow) / atr, distance);
            return;
        }

        ExecuteSetup(setup, i);
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
        var stopPips = Math.Abs(setup.Entry - setup.Stop) / Symbol.PipSize;
        var tpPips = Math.Abs(setup.Target - setup.Entry) / Symbol.PipSize;
        if (stopPips <= 0 || tpPips <= 0)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);

        if (volume < Symbol.VolumeInUnitsMin)
        {
            Print("NAI RUNNER | SKIP | risk-size {0} below broker min {1} | stop={2:F0} pips", volume, Symbol.VolumeInUnitsMin, stopPips);
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var tradeType = setup.Direction > 0 ? TradeType.Buy : TradeType.Sell;
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, setup.Name);

        if (!result.IsSuccessful)
        {
            Print("NAI RUNNER | ENTRY REJECTED | {0} | {1}", setup.Name, result.Error);
            return;
        }

        _lastEntryIndex = i;
        _entryIndex = i;

        // Instrumentation snapshot only. It is captured after the original trade has already been accepted.
        TrendVotes(i, out var bull, out var bear);
        var atr = Atr(i);
        var fast = AverageClose(i - 5, i);
        var slow = AverageClose(i - 17, i);
        var priceFast = atr > Symbol.TickSize ? Math.Abs(_bars.ClosePrices[i] - fast) / atr : 0;
        var fastSlow = atr > Symbol.TickSize ? Math.Abs(fast - slow) / atr : 0;
        var structure = StructureDirection(i);
        var intendedRiskUsd = Account.Equity * RiskPercent / 100.0;
        _activeMeta = new EntryMeta(setup.Name, tradeType, Server.Time, intendedRiskUsd, bull, bear, atr, fastSlow, priceFast, structure, setup.Reason);

        if (tradeType == TradeType.Buy) _longTrades++; else _shortTrades++;
        if (setup.Name == "PULLBACK RUNNER") _pullbackTrades++; else if (setup.Name == "MOMENTUM RUNNER") _momentumTrades++;

        Print("NAI RUNNER | ENTER {0} | {1} | entry={2} SL={3} TP={4} volume={5} target={6:F2}R | {7}", tradeType, setup.Name, result.Position.EntryPrice, setup.Stop, setup.Target, volume, TargetR, setup.Reason);
        Print("NAI META | {0} {1} | votes={2}/{3} fastSlow={4:F2}ATR priceFast={5:F2}ATR structure={6} intendedRisk=${7:F2}",
            tradeType, setup.Name, bull, bear, fastSlow, priceFast, structure, intendedRiskUsd);
    }

    private void ManageOpenPosition()
    {
        var p = FindRunnerPosition();
        if (p == null || !p.TakeProfit.HasValue || !p.StopLoss.HasValue)
            return;

        var originalRisk = Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR;
        if (originalRisk <= Symbol.TickSize)
            return;

        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = favorable / originalRisk;

        if (r >= BreakEvenAtR)
        {
            var be = p.EntryPrice;
            var improve = p.TradeType == TradeType.Buy ? p.StopLoss.Value < be : p.StopLoss.Value > be;
            if (improve)
            {
                ModifyPosition(p, be, p.TakeProfit, false);
                Print("NAI RUNNER | PROTECT | break-even locked at {0}", be);
            }
        }

        if (r >= TrailAtR && _bars.Count > 5)
        {
            var i = _bars.Count - 2;
            var atr = Atr(i);
            var candidate = p.TradeType == TradeType.Buy
                ? LowestLow(i - 2, i) - atr * 0.08
                : HighestHigh(i - 2, i) + atr * 0.08;

            var improve = p.TradeType == TradeType.Buy
                ? candidate > p.StopLoss.Value && candidate < Symbol.Bid
                : candidate < p.StopLoss.Value && candidate > Symbol.Ask;

            if (improve)
            {
                ModifyPosition(p, candidate, p.TakeProfit, false);
                Print("NAI RUNNER | TRAIL | SL -> {0:F2} | liveR={1:F2}", candidate, r);
            }
        }
    }

    private void EvaluateEarlyExit(Position p, int i)
    {
        TrendVotes(i, out var bull, out var bear);
        var strongOpposite = p.TradeType == TradeType.Buy ? bear >= 4 : bull >= 4;
        if (!strongOpposite)
            return;

        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        var ageBars = _entryIndex >= 0 ? i - _entryIndex : 99;

        if (ageBars >= 2 && r < 0.40)
        {
            ClosePosition(p);
            Print("NAI RUNNER | EARLY EXIT | strong opposite trend votes bull={0} bear={1} | R={2:F2}", bull, bear, r);
        }
    }

    private void PrintPositionStatus(Position p, int i)
    {
        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        TrendVotes(i, out var bull, out var bear);
        Print("NAI RUNNER | HOLD | {0} P/L={1:F2} R={2:F2} votes={3}/{4} SL={5} TP={6}", p.TradeType, p.NetProfit, r, bull, bear,
            p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "--",
            p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "--");
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.SymbolName != SymbolName || p.Label != Label)
            return;

        var meta = _activeMeta;
        var setup = meta?.SetupName ?? p.Comment ?? "UNKNOWN";
        var intendedRisk = Math.Max(0.01, meta?.IntendedRiskUsd ?? (Account.Balance * RiskPercent / 100.0));
        var scratchThreshold = intendedRisk * 0.15;
        var fullRiskThreshold = intendedRisk * 0.65;
        var isScratch = Math.Abs(p.NetProfit) <= scratchThreshold;
        var isWin = !isScratch && p.NetProfit > 0;
        var isLoss = !isScratch && p.NetProfit < 0;
        var isFullRiskLoss = p.NetProfit <= -fullRiskThreshold;

        if (p.TradeType == TradeType.Buy)
        {
            _longNet += p.NetProfit;
            if (isWin) _longWins++; else if (isLoss) _longLosses++; else _longScratches++;
        }
        else
        {
            _shortNet += p.NetProfit;
            if (isWin) _shortWins++; else if (isLoss) _shortLosses++; else _shortScratches++;
        }

        if (setup == "PULLBACK RUNNER")
        {
            _pullbackNet += p.NetProfit;
            if (isWin) _pullbackWins++; else if (isLoss) _pullbackLosses++; else _pullbackScratches++;
        }
        else if (setup == "MOMENTUM RUNNER")
        {
            _momentumNet += p.NetProfit;
            if (isWin) _momentumWins++; else if (isLoss) _momentumLosses++; else _momentumScratches++;
        }

        if (isFullRiskLoss)
            _fullRiskLosses++;

        var duration = meta != null ? Server.Time - meta.EntryTime : TimeSpan.Zero;
        Print("NAI RESULT | {0} {1} | net={2:F2} closeReason={3} class={4} fullRisk={5} duration={6:F0}s",
            p.TradeType, setup, p.NetProfit, args.Reason,
            isScratch ? "SCRATCH" : isWin ? "WIN" : "LOSS",
            isFullRiskLoss ? "YES" : "NO",
            duration.TotalSeconds);

        if (meta != null)
        {
            Print("NAI RESULT META | votesAtEntry={0}/{1} fastSlow={2:F2}ATR priceFast={3:F2}ATR structure={4} intendedRisk=${5:F2} | {6}",
                meta.BullVotes, meta.BearVotes, meta.FastSlowAtr, meta.PriceFastAtr, meta.Structure, meta.IntendedRiskUsd, meta.Reason);
        }

        PrintStats("TRADE CLOSED");
        _activeMeta = null;
    }

    private void PrintStats(string trigger)
    {
        Print("=== NAI RUNNER V1 CONTROL STATS | {0} ===", trigger);
        Print("LONG | trades={0} W={1} L={2} scratch={3} net={4:F2}", _longTrades, _longWins, _longLosses, _longScratches, _longNet);
        Print("SHORT | trades={0} W={1} L={2} scratch={3} net={4:F2}", _shortTrades, _shortWins, _shortLosses, _shortScratches, _shortNet);
        Print("PULLBACK | trades={0} W={1} L={2} scratch={3} net={4:F2}", _pullbackTrades, _pullbackWins, _pullbackLosses, _pullbackScratches, _pullbackNet);
        Print("MOMENTUM | trades={0} W={1} L={2} scratch={3} net={4:F2}", _momentumTrades, _momentumWins, _momentumLosses, _momentumScratches, _momentumNet);
        Print("FULL-RISK LOSSES | {0}", _fullRiskLosses);
        Print("TOTAL NET | {0:F2}", _longNet + _shortNet);
        Print("=== END NAI RUNNER V1 CONTROL STATS ===");
    }

    private Position? FindRunnerPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

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
        Print("NAI RUNNER | NEW DAY | equity anchor={0:F2}", _dayStartEquity);
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
        Print("NAI RUNNER HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
        PrintStats("DAILY STOP");
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

    private sealed record EntryMeta(
        string SetupName,
        TradeType TradeType,
        DateTime EntryTime,
        double IntendedRiskUsd,
        int BullVotes,
        int BearVotes,
        double Atr,
        double FastSlowAtr,
        double PriceFastAtr,
        int Structure,
        string Reason);
}
