using System;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiRunnerV1RegimeLong : Robot
{
    private const string Label = "NAI-RUNNER-V1-REGIME-LONG";
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

    private Bars _m1 = null!;
    private Bars _m5 = null!;
    private Bars _m15 = null!;

    private DateTime _lastLiveM1Open = DateTime.MinValue;
    private DateTime _lastRegimePrint = DateTime.MinValue;
    private double _dayStartEquity;
    private DateTime _equityDay;
    private int _lastEntryIndex = -10000;
    private int _entryIndex = -1;
    private bool _halted;
    private int _scanCount;
    private double? _lastStopRequestPrice;
    private RegimeState _regime = RegimeState.Yellow;
    private int _m15Score;
    private int _m5Score;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI RUNNER V1 REGIME LONG BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI RUNNER V1 REGIME LONG BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _m5 = MarketData.GetBars(TimeFrame.Minute5, SymbolName);
        _m15 = MarketData.GetBars(TimeFrame.Minute15, SymbolName);
        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;

        RefreshRegime();

        Print("NAI RUNNER V1 REGIME LONG STARTED | {0} | DEMO", SymbolName);
        Print("ENTRY CORE | EXACT V1 LONG | Pullback Runner + Momentum Runner | SHORT DISABLED");
        Print("PERMISSION | GREEN=trade V1 LONG | YELLOW/RED=WAIT | regime never closes an open trade");
        Print("RISK | {0:F2}% | TP={1:F2}R | BE={2:F2}R | TRAIL={3:F2}R", RiskPercent, TargetR, BreakEvenAtR, TrailAtR);
        Print("SYMBOL | tick={0} pip={1} minVol={2} maxVol={3} step={4}", Symbol.TickSize, Symbol.PipSize, Symbol.VolumeInUnitsMin, Symbol.VolumeInUnitsMax, Symbol.VolumeInUnitsStep);
        PrintRegime("START");
    }

    protected override void OnTick()
    {
        if (_halted || Account.IsLive)
            return;

        ResetDailyAnchorIfNeeded();
        if (HitDailyStop())
            return;

        ManageOpenPosition();

        if (_m1 == null || _m1.Count < 45 || _m5.Count < 30 || _m15.Count < 30)
            return;

        var liveOpen = _m1.OpenTimes[_m1.Count - 1];
        if (liveOpen == _lastLiveM1Open)
            return;

        _lastLiveM1Open = liveOpen;
        var closedIndex = _m1.Count - 2;
        RefreshRegime();
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

        if (_regime != RegimeState.Green)
        {
            Print("NAI PERMISSION | {0} | NO LONG ENTRY | M15={1} M5={2}", _regime.ToString().ToUpperInvariant(), _m15Score, _m5Score);
            return;
        }

        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize * 5)
        {
            Print("NAI RUNNER | WAIT | scan={0} ATR={1:F2} too small", _scanCount, atr);
            return;
        }

        TrendVotes(i, out var bull, out var bear);
        var longTrend = bull >= 3 && bull > bear;

        if (!longTrend)
        {
            var fast = AverageClose(_m1, i - 5, i);
            var slow = AverageClose(_m1, i - 17, i);
            var distance = Math.Abs(_m1.ClosePrices[i] - fast) / atr;
            Print("NAI RUNNER | WAIT | GREEN regime but V1 LONG trend absent | votes={0}/{1} fastSlow={2:F2}ATR priceFast={3:F2}ATR", bull, bear, Math.Abs(fast - slow) / atr, distance);
            return;
        }

        // EXACT Runner V1 LONG entry order: Pullback first, then Momentum.
        var setup = FindPullbackEntry(i, 1, atr) ?? FindMomentumEntry(i, 1, atr);

        if (setup == null)
        {
            var fast = AverageClose(_m1, i - 5, i);
            var slow = AverageClose(_m1, i - 17, i);
            var distance = Math.Abs(_m1.ClosePrices[i] - fast) / atr;
            Print("NAI RUNNER | WAIT | GREEN + LONG votes={0}/{1} but no V1 setup | fastSlow={2:F2}ATR priceFast={3:F2}ATR", bull, bear, Math.Abs(fast - slow) / atr, distance);
            return;
        }

        ExecuteSetup(setup, i);
    }

    // EXACT Runner V1 Pullback LONG logic retained.
    private Setup? FindPullbackEntry(int i, int trend, double atr)
    {
        var fast = AverageClose(_m1, i - 5, i);
        var slow = AverageClose(_m1, i - 17, i);
        var open = _m1.OpenPrices[i];
        var close = _m1.ClosePrices[i];
        var high = _m1.HighPrices[i];
        var low = _m1.LowPrices[i];
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
        var swing = trend > 0 ? LowestLow(_m1, i - 4, i) : HighestHigh(_m1, i - 4, i);
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

    // EXACT Runner V1 Momentum LONG logic retained.
    private Setup? FindMomentumEntry(int i, int trend, double atr)
    {
        var open = _m1.OpenPrices[i];
        var close = _m1.ClosePrices[i];
        var high = _m1.HighPrices[i];
        var low = _m1.LowPrices[i];
        var range = Math.Max(Symbol.TickSize, high - low);
        var body = Math.Abs(close - open);
        var fast = AverageClose(_m1, i - 5, i);

        var priorHigh = HighestHigh(_m1, i - 4, i - 1);
        var priorLow = LowestLow(_m1, i - 4, i - 1);
        var broke = trend > 0 ? close > priorHigh : close < priorLow;
        var aligned = trend > 0 ? close > open : close < open;
        var closeStrong = trend > 0 ? close >= low + range * 0.70 : close <= high - range * 0.70;
        var distanceFromFast = Math.Abs(close - fast) / atr;
        var efficiency = Efficiency(_m1, i - 4, i);

        if (!broke || !aligned || !closeStrong || body < atr * 0.28 || efficiency < 0.48 || distanceFromFast > 1.25)
            return null;

        var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = trend > 0 ? LowestLow(_m1, i - 3, i) : HighestHigh(_m1, i - 3, i);
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
        var result = ExecuteMarketOrder(TradeType.Buy, SymbolName, volume, Label, stopPips, tpPips, setup.Name);

        if (!result.IsSuccessful)
        {
            Print("NAI RUNNER | ENTRY REJECTED | {0} | {1}", setup.Name, result.Error);
            return;
        }

        _lastEntryIndex = i;
        _entryIndex = i;
        _lastStopRequestPrice = null;
        Print("NAI RUNNER | ENTER BUY | {0} | entry={1} SL={2} TP={3} volume={4} target={5:F2}R | regime=GREEN M15={6} M5={7} | {8}", setup.Name, result.Position.EntryPrice, setup.Stop, setup.Target, volume, TargetR, _m15Score, _m5Score, setup.Reason);
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
                TryMoveStop(p, be, "BREAK-EVEN", r);
        }

        if (r >= TrailAtR && _m1.Count > 5)
        {
            var i = _m1.Count - 2;
            var atr = Atr(_m1, i);
            var candidate = p.TradeType == TradeType.Buy
                ? LowestLow(_m1, i - 2, i) - atr * 0.08
                : HighestHigh(_m1, i - 2, i) + atr * 0.08;
            TryMoveStop(p, candidate, "TRAIL", r);
        }
    }

    // V2-safe stop movement: same V1 management thresholds, but broker-safe and logs only accepted moves.
    private void TryMoveStop(Position p, double rawCandidate, string reason, double liveR)
    {
        if (!p.StopLoss.HasValue)
            return;

        var candidate = NormalizePrice(rawCandidate, p.TradeType == TradeType.Buy ? RoundingMode.Down : RoundingMode.Up);
        var reference = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var minDistancePrice = MinimumStopDistancePrice(reference);
        var safety = Math.Max(minDistancePrice + Symbol.TickSize * 2.0, (Symbol.Ask - Symbol.Bid) + Symbol.TickSize * 2.0);

        if (p.TradeType == TradeType.Buy)
        {
            candidate = Math.Min(candidate, NormalizePrice(Symbol.Bid - safety, RoundingMode.Down));
            if (candidate <= p.StopLoss.Value + Symbol.TickSize)
                return;
        }
        else
        {
            candidate = Math.Max(candidate, NormalizePrice(Symbol.Ask + safety, RoundingMode.Up));
            if (candidate >= p.StopLoss.Value - Symbol.TickSize)
                return;
        }

        if (_lastStopRequestPrice.HasValue && Math.Abs(candidate - _lastStopRequestPrice.Value) < Symbol.TickSize * 0.5)
            return;

        _lastStopRequestPrice = candidate;
        var result = ModifyPosition(p, candidate, p.TakeProfit, false);
        if (result.IsSuccessful)
            Print("NAI RUNNER | {0} SUCCESS | SL->{1:F2} | liveR={2:F2}", reason, candidate, liveR);
        else
            Print("NAI RUNNER | {0} REJECTED | requested={1:F2} error={2}", reason, candidate, result.Error);
    }

    // Original V1 early-exit logic retained. Regime permission does NOT close open trades.
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
            var result = ClosePosition(p);
            if (result.IsSuccessful)
                Print("NAI RUNNER | EARLY EXIT | original V1 opposite votes bull={0} bear={1} | R={2:F2}", bull, bear, r);
        }
    }

    private void PrintPositionStatus(Position p, int i)
    {
        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        TrendVotes(i, out var bull, out var bear);
        Print("NAI RUNNER | HOLD | {0} P/L={1:F2} R={2:F2} votes={3}/{4} SL={5} TP={6} | permissionNow={7}", p.TradeType, p.NetProfit, r, bull, bear,
            p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "--",
            p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "--",
            _regime.ToString().ToUpperInvariant());
    }

    private void RefreshRegime()
    {
        if (_m5.Count < 25 || _m15.Count < 25)
        {
            _regime = RegimeState.Yellow;
            return;
        }

        _m15Score = ContextScore(_m15, _m15.Count - 2);
        _m5Score = ContextScore(_m5, _m5.Count - 2);

        // Permission only. GREEN requires both higher timeframes to support LONG.
        if (_m15Score >= 2 && _m5Score >= 1)
            _regime = RegimeState.Green;
        else if (_m15Score <= -2 || _m5Score <= -2)
            _regime = RegimeState.Red;
        else
            _regime = RegimeState.Yellow;

        if (_lastRegimePrint == DateTime.MinValue || Server.Time - _lastRegimePrint >= TimeSpan.FromMinutes(5))
        {
            PrintRegime("UPDATE");
            _lastRegimePrint = Server.Time;
        }
    }

    private int ContextScore(Bars bars, int i)
    {
        if (i < 20)
            return 0;

        var atr = Atr(bars, i);
        if (atr <= Symbol.TickSize)
            return 0;

        var score = 0;
        var fast = AverageClose(bars, i - 5, i);
        var slow = AverageClose(bars, i - 17, i);
        if (fast > slow + atr * 0.05) score++;
        else if (fast < slow - atr * 0.05) score--;

        var fastPast = AverageClose(bars, i - 9, i - 4);
        if (fast > fastPast + atr * 0.05) score++;
        else if (fast < fastPast - atr * 0.05) score--;

        var move3 = bars.ClosePrices[i] - bars.ClosePrices[i - 3];
        if (move3 > atr * 0.18) score++;
        else if (move3 < -atr * 0.18) score--;

        var structure = StructureDirection(bars, i);
        if (structure > 0) score++;
        else if (structure < 0) score--;

        return score;
    }

    private void PrintRegime(string source)
    {
        Print("NAI REGIME | {0} | {1} | M15={2} M5={3} | GREEN trades, YELLOW/RED waits", source, _regime.ToString().ToUpperInvariant(), _m15Score, _m5Score);
    }

    private Position? FindRunnerPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    // EXACT Runner V1 M1 trend votes retained.
    private void TrendVotes(int i, out int bull, out int bear)
    {
        bull = 0;
        bear = 0;
        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize)
            return;

        var fast = AverageClose(_m1, i - 5, i);
        var slow = AverageClose(_m1, i - 17, i);
        if (fast > slow + atr * 0.04) bull++; else if (fast < slow - atr * 0.04) bear++;

        var fastPast = AverageClose(_m1, i - 9, i - 4);
        if (fast > fastPast + atr * 0.05) bull++; else if (fast < fastPast - atr * 0.05) bear++;

        var move3 = _m1.ClosePrices[i] - _m1.ClosePrices[i - 3];
        if (move3 > atr * 0.12) bull++; else if (move3 < -atr * 0.12) bear++;

        var structure = StructureDirection(_m1, i);
        if (structure > 0) bull++; else if (structure < 0) bear++;

        var body = _m1.ClosePrices[i] - _m1.OpenPrices[i];
        if (body > atr * 0.10) bull++; else if (body < -atr * 0.10) bear++;
    }

    private int StructureDirection(Bars bars, int i)
    {
        if (i < 12)
            return 0;
        var recentHigh = HighestHigh(bars, i - 5, i);
        var recentLow = LowestLow(bars, i - 5, i);
        var priorHigh = HighestHigh(bars, i - 11, i - 6);
        var priorLow = LowestLow(bars, i - 11, i - 6);
        var atr = Atr(bars, i);
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
        return true;
    }

    private double MinimumStopDistancePrice(double referencePrice)
    {
        if (Symbol.MinStopLossDistance <= 0)
            return 0;
        if (Symbol.MinDistanceType == SymbolMinDistanceType.Percentage)
            return referencePrice * Symbol.MinStopLossDistance / 100.0;
        return Symbol.MinStopLossDistance * Symbol.PipSize;
    }

    private double NormalizePrice(double price, RoundingMode mode)
    {
        if (Symbol.TickSize <= 0)
            return Math.Round(price, Symbol.Digits);
        var rawTicks = price / Symbol.TickSize;
        var ticks = mode == RoundingMode.Down ? Math.Floor(rawTicks + 1e-8) : Math.Ceiling(rawTicks - 1e-8);
        return Math.Round(ticks * Symbol.TickSize, Symbol.Digits);
    }

    private double Atr(Bars bars, int i)
    {
        var from = Math.Max(1, i - AtrPeriod + 1);
        double total = 0;
        var count = 0;
        for (var k = from; k <= i; k++)
        {
            var tr = Math.Max(bars.HighPrices[k] - bars.LowPrices[k],
                Math.Max(Math.Abs(bars.HighPrices[k] - bars.ClosePrices[k - 1]), Math.Abs(bars.LowPrices[k] - bars.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private double Efficiency(Bars bars, int from, int to)
    {
        if (to <= from)
            return 0;
        var net = Math.Abs(bars.ClosePrices[to] - bars.ClosePrices[from]);
        double path = 0;
        for (var k = from + 1; k <= to; k++)
            path += Math.Abs(bars.ClosePrices[k] - bars.ClosePrices[k - 1]);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double AverageClose(Bars bars, int from, int to)
    {
        from = Math.Max(0, from);
        double sum = 0;
        var count = 0;
        for (var k = from; k <= to; k++)
        {
            sum += bars.ClosePrices[k];
            count++;
        }
        return count == 0 ? bars.ClosePrices[to] : sum / count;
    }

    private double HighestHigh(Bars bars, int from, int to)
    {
        from = Math.Max(0, from);
        var v = double.MinValue;
        for (var k = from; k <= to; k++) v = Math.Max(v, bars.HighPrices[k]);
        return v;
    }

    private double LowestLow(Bars bars, int from, int to)
    {
        from = Math.Max(0, from);
        var v = double.MaxValue;
        for (var k = from; k <= to; k++) v = Math.Min(v, bars.LowPrices[k]);
        return v;
    }

    private enum RegimeState
    {
        Green,
        Yellow,
        Red
    }

    private sealed record Setup(int Direction, string Name, double Entry, double Stop, double Target, double Risk, string Reason);
}
