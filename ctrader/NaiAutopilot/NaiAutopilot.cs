using System;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiAutopilot : Robot
{
    private const string Label = "NAI-AUTOPILOT";
    private const string RequiredSymbolText = "Volatility 25 (1s)";

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 2.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Minimum R:R", DefaultValue = 2.00, MinValue = 1.50, MaxValue = 5.00, Step = 0.10)]
    public double MinimumRR { get; set; }

    [Parameter("Daily Equity Stop %", DefaultValue = 3.00, MinValue = 1.00, MaxValue = 10.00, Step = 0.50)]
    public double DailyEquityStopPercent { get; set; }

    [Parameter("Cooldown M1 Bars", DefaultValue = 3, MinValue = 1, MaxValue = 20)]
    public int CooldownBars { get; set; }

    [Parameter("ATR Period", DefaultValue = 14, MinValue = 8, MaxValue = 50)]
    public int AtrPeriod { get; set; }

    [Parameter("Trend Lookback", DefaultValue = 30, MinValue = 15, MaxValue = 100)]
    public int TrendLookback { get; set; }

    [Parameter("Impulse Lookback", DefaultValue = 8, MinValue = 4, MaxValue = 20)]
    public int ImpulseLookback { get; set; }

    [Parameter("Break-even at R", DefaultValue = 1.0, MinValue = 0.5, MaxValue = 3.0, Step = 0.1)]
    public double BreakEvenAtR { get; set; }

    [Parameter("Trail at R", DefaultValue = 1.5, MinValue = 1.0, MaxValue = 5.0, Step = 0.1)]
    public double TrailAtR { get; set; }

    private Bars _signalBars = null!;
    private double _dayStartEquity;
    private DateTime _equityDay;
    private int _lastEntryBar = -1000;
    private bool _halted;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI AUTOPILOT BLOCKED: DEMO accounts only while under development.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI AUTOPILOT BLOCKED: attach it to Volatility 25 (1s) Index. Current symbol: {0}", SymbolName);
            Stop();
            return;
        }

        _signalBars = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _signalBars.BarClosed += OnSignalBarClosed;

        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;

        Print("NAI AUTOPILOT DEMO started | {0} | internal signal TF M1 | Risk {1:F2}% | Min RR {2:F2}", SymbolName, RiskPercent, MinimumRR);
        Print("SYMBOL CHECK | tick={0} pip={1} minVolume={2} maxVolume={3} step={4}",
            Symbol.TickSize, Symbol.PipSize, Symbol.VolumeInUnitsMin, Symbol.VolumeInUnitsMax, Symbol.VolumeInUnitsStep);
        Print("NAI DIAGNOSTICS ON | one status line will print after every closed M1 bar.");
    }

    protected override void OnStop()
    {
        if (_signalBars != null)
            _signalBars.BarClosed -= OnSignalBarClosed;
    }

    private void OnSignalBarClosed(BarClosedEventArgs args)
    {
        if (_halted || Account.IsLive)
            return;

        ResetDailyEquityAnchorIfNeeded();
        if (HitDailyEquityStop())
            return;

        ManagePosition();

        // BarClosed omits the new live bar. Count - 1 is therefore the bar that just closed.
        var i = _signalBars.Count - 1;
        if (i < Math.Max(TrendLookback + 10, 70))
        {
            Print("NAI STATUS | WARMING UP | M1 bars={0} need>{1}", i + 1, Math.Max(TrendLookback + 10, 70));
            return;
        }

        var openPosition = FindNaiPosition();
        if (openPosition != null)
        {
            PrintPositionDiagnostic(openPosition);
            return;
        }

        if (i - _lastEntryBar < CooldownBars)
        {
            Print("NAI STATUS | WAIT | cooldown {0}/{1} M1 bars", i - _lastEntryBar, CooldownBars);
            return;
        }

        PrintMarketDiagnostic(i);

        var plan = FindPullbackSniper(i) ?? FindReversalRetestSniper(i);
        if (plan == null)
            return;

        ExecutePlan(plan, i);
    }

    protected override void OnTick()
    {
        if (_halted || Account.IsLive)
            return;

        ResetDailyEquityAnchorIfNeeded();
        if (HitDailyEquityStop())
            return;

        ManagePosition();
    }

    private void PrintMarketDiagnostic(int i)
    {
        var atr = Atr(i);
        if (atr <= Symbol.TickSize * 5)
        {
            Print("NAI STATUS | WAIT | ATR too small {0:F2}", atr);
            return;
        }

        var trend = TrendDirection(i);
        var trendText = trend > 0 ? "LONG" : trend < 0 ? "SHORT" : "NONE";
        var impulseStart = i - ImpulseLookback;
        var impulseMove = _signalBars.ClosePrices[i - 2] - _signalBars.ClosePrices[impulseStart];
        var impulseAtr = Math.Abs(impulseMove) / atr;
        var impulseDirection = Math.Sign(impulseMove);
        var efficiency = Efficiency(impulseStart, i - 2);

        var pullbackText = "n/a";
        var rejectionText = "n/a";
        var rrText = "n/a";
        var pullbackGate = "NO";

        if (trend != 0)
        {
            var impulseHigh = HighestHigh(impulseStart, i - 1);
            var impulseLow = LowestLow(impulseStart, i - 1);
            var impulseRange = Math.Max(Symbol.TickSize, impulseHigh - impulseLow);
            var close = _signalBars.ClosePrices[i];
            var retracement = trend > 0 ? (impulseHigh - close) / impulseRange : (close - impulseLow) / impulseRange;
            var rejection = RejectionBar(i, trend, atr);
            pullbackText = $"{retracement:P0}";
            rejectionText = rejection ? "YES" : "NO";

            var recentLow = LowestLow(Math.Max(1, i - 4), i);
            var recentHigh = HighestHigh(Math.Max(1, i - 4), i);
            var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
            var stop = trend > 0 ? recentLow - atr * 0.18 : recentHigh + atr * 0.18;
            var risk = Math.Abs(entry - stop);
            var logicalTarget = trend > 0 ? impulseHigh : impulseLow;
            var availableReward = trend > 0 ? logicalTarget - entry : entry - logicalTarget;
            if (risk > Symbol.TickSize)
                rrText = (availableReward / risk).ToString("F2");

            var sameImpulse = impulseDirection == trend;
            var impulseGood = impulseAtr >= 1.4 && efficiency >= 0.58;
            var retraceGood = retracement >= 0.22 && retracement <= 0.58;
            var riskGood = risk >= atr * 0.35 && risk <= atr * 1.8;
            var rrGood = risk > Symbol.TickSize && availableReward / risk >= MinimumRR;
            pullbackGate = sameImpulse && impulseGood && retraceGood && rejection && riskGood && rrGood ? "READY" : "WAIT";
        }

        var priorHigh = HighestHigh(i - 24, i - 4);
        var priorLow = LowestLow(i - 24, i - 4);
        var longBreak = _signalBars.HighPrices[i - 2] > priorHigh + atr * 0.15;
        var shortBreak = _signalBars.LowPrices[i - 2] < priorLow - atr * 0.15;
        var reversalText = longBreak ? "LONG BREAK" : shortBreak ? "SHORT BREAK" : "NO BREAK";

        Print("NAI STATUS | {0} | trend={1} | impulse={2:F2}ATR eff={3:F2} aligned={4} | pullback={5} rejection={6} structureRR={7} | reversal={8}",
            pullbackGate, trendText, impulseAtr, efficiency, impulseDirection == trend ? "YES" : "NO", pullbackText, rejectionText, rrText, reversalText);
    }

    private void PrintPositionDiagnostic(Position p)
    {
        var originalRisk = p.TakeProfit.HasValue
            ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / MinimumRR
            : p.StopLoss.HasValue ? Math.Abs(p.EntryPrice - p.StopLoss.Value) : 0;
        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        Print("NAI STATUS | HOLD | {0} | entry={1} current={2} | P/L={3:F2} | R={4:F2} | SL={5} TP={6}",
            p.TradeType, p.EntryPrice, price, p.NetProfit, r,
            p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "--",
            p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "--");
    }

    private TradePlan? FindPullbackSniper(int i)
    {
        var atr = Atr(i);
        if (atr <= Symbol.TickSize * 5)
            return null;

        var trend = TrendDirection(i);
        if (trend == 0)
            return null;

        var impulseStart = i - ImpulseLookback;
        var impulseMove = _signalBars.ClosePrices[i - 2] - _signalBars.ClosePrices[impulseStart];
        var impulseDirection = Math.Sign(impulseMove);
        if (impulseDirection != trend)
            return null;

        var efficiency = Efficiency(impulseStart, i - 2);
        if (Math.Abs(impulseMove) < atr * 1.4 || efficiency < 0.58)
            return null;

        var impulseHigh = HighestHigh(impulseStart, i - 1);
        var impulseLow = LowestLow(impulseStart, i - 1);
        var impulseRange = Math.Max(Symbol.TickSize, impulseHigh - impulseLow);
        var close = _signalBars.ClosePrices[i];

        double retracement;
        if (trend > 0)
            retracement = (impulseHigh - close) / impulseRange;
        else
            retracement = (close - impulseLow) / impulseRange;

        if (retracement < 0.22 || retracement > 0.58)
            return null;

        if (!RejectionBar(i, trend, atr))
            return null;

        var recentLow = LowestLow(Math.Max(1, i - 4), i);
        var recentHigh = HighestHigh(Math.Max(1, i - 4), i);
        var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
        var stop = trend > 0 ? recentLow - atr * 0.18 : recentHigh + atr * 0.18;
        var risk = Math.Abs(entry - stop);
        if (risk < atr * 0.35 || risk > atr * 1.8)
            return null;

        var logicalTarget = trend > 0 ? impulseHigh : impulseLow;
        var availableReward = trend > 0 ? logicalTarget - entry : entry - logicalTarget;
        var rrToStructure = availableReward / risk;
        if (rrToStructure < MinimumRR)
            return null;

        var target = trend > 0 ? entry + risk * MinimumRR : entry - risk * MinimumRR;
        return new TradePlan(trend, "PULLBACK SNIPER", entry, stop, target, rrToStructure, atr,
            $"impulse={Math.Abs(impulseMove / atr):F2}ATR eff={efficiency:F2} retrace={retracement:P0} structureRR={rrToStructure:F2}");
    }

    private TradePlan? FindReversalRetestSniper(int i)
    {
        var atr = Atr(i);
        if (atr <= Symbol.TickSize * 5 || i < 50)
            return null;

        var priorHigh = HighestHigh(i - 24, i - 4);
        var priorLow = LowestLow(i - 24, i - 4);
        var close = _signalBars.ClosePrices[i];

        var longBreak = _signalBars.HighPrices[i - 2] > priorHigh + atr * 0.15;
        var shortBreak = _signalBars.LowPrices[i - 2] < priorLow - atr * 0.15;
        var direction = longBreak ? 1 : shortBreak ? -1 : 0;
        if (direction == 0)
            return null;

        var brokenLevel = direction > 0 ? priorHigh : priorLow;
        var retestDistance = Math.Abs((direction > 0 ? _signalBars.LowPrices[i] : _signalBars.HighPrices[i]) - brokenLevel);
        if (retestDistance > atr * 0.55)
            return null;

        if (!RejectionBar(i, direction, atr))
            return null;

        if (direction > 0 && close <= brokenLevel)
            return null;
        if (direction < 0 && close >= brokenLevel)
            return null;

        var entry = direction > 0 ? Symbol.Ask : Symbol.Bid;
        var stop = direction > 0 ? LowestLow(i - 3, i) - atr * 0.15 : HighestHigh(i - 3, i) + atr * 0.15;
        var risk = Math.Abs(entry - stop);
        if (risk < atr * 0.35 || risk > atr * 1.8)
            return null;

        var targetStructure = direction > 0 ? HighestHigh(i - 45, i - 5) : LowestLow(i - 45, i - 5);
        var room = direction > 0 ? targetStructure - entry : entry - targetStructure;
        var rrToStructure = room / risk;

        if (rrToStructure < MinimumRR)
        {
            var range = HighestHigh(i - 30, i) - LowestLow(i - 30, i);
            var expansionRoom = range / Math.Max(risk, Symbol.TickSize);
            if (expansionRoom < MinimumRR * 1.25)
                return null;
            rrToStructure = MinimumRR;
        }

        var target = direction > 0 ? entry + risk * MinimumRR : entry - risk * MinimumRR;
        return new TradePlan(direction, "REVERSAL RETEST", entry, stop, target, rrToStructure, atr,
            $"break={brokenLevel:F2} retest={retestDistance / atr:F2}ATR structureRR={rrToStructure:F2}");
    }

    private void ExecutePlan(TradePlan plan, int barIndex)
    {
        var stopPips = Math.Abs(plan.Entry - plan.Stop) / Symbol.PipSize;
        var takeProfitPips = Math.Abs(plan.Target - plan.Entry) / Symbol.PipSize;
        if (stopPips <= 0 || takeProfitPips / stopPips < MinimumRR - 0.02)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);

        // Never round UP to the broker minimum because that could exceed intended risk.
        if (volume < Symbol.VolumeInUnitsMin)
        {
            Print("NAI SKIP | calculated risk size {0} is below broker minimum {1}", volume, Symbol.VolumeInUnitsMin);
            return;
        }

        volume = Math.Min(Symbol.VolumeInUnitsMax, volume);

        var tradeType = plan.Direction > 0 ? TradeType.Buy : TradeType.Sell;
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, takeProfitPips, plan.Name);

        if (!result.IsSuccessful)
        {
            Print("NAI ENTRY REJECTED | {0} | {1}", plan.Name, result.Error);
            return;
        }

        _lastEntryBar = barIndex;
        Print("NAI ENTER {0} | {1} | entry {2} | SL {3} | TP {4} | RR {5:F2} | risk {6:F2}% | volume {7} | {8}",
            tradeType, plan.Name, result.Position.EntryPrice, plan.Stop, plan.Target, MinimumRR, RiskPercent, volume, plan.Reason);
    }

    private void ManagePosition()
    {
        var p = FindNaiPosition();
        if (p == null || p.StopLoss == null)
            return;

        // TP is fixed at MinimumRR × original risk, so it preserves 1R even after SL moves to break-even/trails.
        var originalRisk = p.TakeProfit.HasValue
            ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / MinimumRR
            : Math.Abs(p.EntryPrice - p.StopLoss.Value);

        if (originalRisk <= Symbol.TickSize)
            return;

        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = favorable / originalRisk;

        if (r >= BreakEvenAtR)
        {
            var breakEven = p.EntryPrice;
            var improve = p.TradeType == TradeType.Buy ? p.StopLoss.Value < breakEven : p.StopLoss.Value > breakEven;
            if (improve)
                ModifyPosition(p, breakEven, p.TakeProfit, false);
        }

        if (r >= TrailAtR)
        {
            var atr = Atr(Math.Max(1, _signalBars.Count - 1));
            var candidate = p.TradeType == TradeType.Buy
                ? LowestLow(Math.Max(1, _signalBars.Count - 5), _signalBars.Count - 1) - atr * 0.10
                : HighestHigh(Math.Max(1, _signalBars.Count - 5), _signalBars.Count - 1) + atr * 0.10;

            var improve = p.TradeType == TradeType.Buy ? candidate > (p.StopLoss ?? double.MinValue) && candidate < Symbol.Bid
                                                        : candidate < (p.StopLoss ?? double.MaxValue) && candidate > Symbol.Ask;
            if (improve)
                ModifyPosition(p, candidate, p.TakeProfit, false);
        }
    }

    private Position? FindNaiPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private void ResetDailyEquityAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay)
            return;
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
    }

    private bool HitDailyEquityStop()
    {
        if (_dayStartEquity <= 0)
            return false;
        var drawdown = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (drawdown < DailyEquityStopPercent)
            return false;

        _halted = true;
        var p = FindNaiPosition();
        if (p != null)
            ClosePosition(p);
        Print("NAI HALTED FOR THE DAY | equity drawdown {0:F2}% reached limit {1:F2}%", drawdown, DailyEquityStopPercent);
        return true;
    }

    private int TrendDirection(int i)
    {
        var fast = AverageClose(i - 7, i);
        var mediumNow = AverageClose(i - 19, i);
        var mediumPast = AverageClose(i - TrendLookback, i - TrendLookback + 9);
        var atr = Atr(i);
        var slope = mediumNow - mediumPast;

        if (fast > mediumNow && slope > atr * 0.55)
            return 1;
        if (fast < mediumNow && slope < -atr * 0.55)
            return -1;
        return 0;
    }

    private bool RejectionBar(int i, int direction, double atr)
    {
        var open = _signalBars.OpenPrices[i];
        var close = _signalBars.ClosePrices[i];
        var high = _signalBars.HighPrices[i];
        var low = _signalBars.LowPrices[i];
        var body = Math.Abs(close - open);
        var range = Math.Max(Symbol.TickSize, high - low);

        if (range < atr * 0.28 || body / range < 0.24)
            return false;

        if (direction > 0)
        {
            var lowerWick = Math.Min(open, close) - low;
            return close > open && close >= low + range * 0.62 && lowerWick >= body * 0.35;
        }

        var upperWick = high - Math.Max(open, close);
        return close < open && close <= high - range * 0.62 && upperWick >= body * 0.35;
    }

    private double Atr(int i)
    {
        var from = Math.Max(1, i - AtrPeriod + 1);
        double total = 0;
        var count = 0;
        for (var k = from; k <= i; k++)
        {
            var tr = Math.Max(_signalBars.HighPrices[k] - _signalBars.LowPrices[k],
                Math.Max(Math.Abs(_signalBars.HighPrices[k] - _signalBars.ClosePrices[k - 1]), Math.Abs(_signalBars.LowPrices[k] - _signalBars.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private double Efficiency(int from, int to)
    {
        if (to <= from)
            return 0;
        var net = Math.Abs(_signalBars.ClosePrices[to] - _signalBars.ClosePrices[from]);
        double path = 0;
        for (var k = from + 1; k <= to; k++)
            path += Math.Abs(_signalBars.ClosePrices[k] - _signalBars.ClosePrices[k - 1]);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double AverageClose(int from, int to)
    {
        from = Math.Max(0, from);
        if (to < from)
            return _signalBars.ClosePrices[to];
        double total = 0;
        var count = 0;
        for (var k = from; k <= to; k++)
        {
            total += _signalBars.ClosePrices[k];
            count++;
        }
        return count == 0 ? _signalBars.ClosePrices[to] : total / count;
    }

    private double HighestHigh(int from, int to)
    {
        from = Math.Max(0, from);
        var value = double.MinValue;
        for (var k = from; k <= to; k++)
            value = Math.Max(value, _signalBars.HighPrices[k]);
        return value;
    }

    private double LowestLow(int from, int to)
    {
        from = Math.Max(0, from);
        var value = double.MaxValue;
        for (var k = from; k <= to; k++)
            value = Math.Min(value, _signalBars.LowPrices[k]);
        return value;
    }

    private sealed record TradePlan(int Direction, string Name, double Entry, double Stop, double Target, double StructureRR, double Atr, string Reason);
}
