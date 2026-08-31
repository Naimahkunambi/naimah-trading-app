using System;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiAutopilot : Robot
{
    private const string Label = "NAI-AUTOPILOT";

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 2.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Minimum R:R", DefaultValue = 2.00, MinValue = 1.50, MaxValue = 5.00, Step = 0.10)]
    public double MinimumRR { get; set; }

    [Parameter("Daily Equity Stop %", DefaultValue = 3.00, MinValue = 1.00, MaxValue = 10.00, Step = 0.50)]
    public double DailyEquityStopPercent { get; set; }

    [Parameter("Cooldown Bars", DefaultValue = 3, MinValue = 1, MaxValue = 20)]
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

        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;
        Print("NAI AUTOPILOT DEMO started | {0} | {1} | Risk {2:F2}% | Min RR {3:F2}", SymbolName, TimeFrame, RiskPercent, MinimumRR);
    }

    protected override void OnBarClosed()
    {
        if (_halted || Account.IsLive)
            return;

        ResetDailyEquityAnchorIfNeeded();
        if (HitDailyEquityStop())
            return;

        ManagePosition();

        if (FindNaiPosition() != null)
            return;

        var i = Bars.Count - 2;
        if (i < Math.Max(TrendLookback + 10, 70))
            return;

        if (i - _lastEntryBar < CooldownBars)
            return;

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

    private TradePlan? FindPullbackSniper(int i)
    {
        var atr = Atr(i);
        if (atr <= Symbol.TickSize * 5)
            return null;

        var trend = TrendDirection(i);
        if (trend == 0)
            return null;

        var impulseStart = i - ImpulseLookback;
        var impulseMove = Bars.ClosePrices[i - 2] - Bars.ClosePrices[impulseStart];
        var impulseDirection = Math.Sign(impulseMove);
        if (impulseDirection != trend)
            return null;

        var efficiency = Efficiency(impulseStart, i - 2);
        if (Math.Abs(impulseMove) < atr * 1.4 || efficiency < 0.58)
            return null;

        var impulseHigh = HighestHigh(impulseStart, i - 1);
        var impulseLow = LowestLow(impulseStart, i - 1);
        var impulseRange = Math.Max(Symbol.TickSize, impulseHigh - impulseLow);
        var close = Bars.ClosePrices[i];

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
        if (atr <= Symbol.TickSize * 5 || i < 35)
            return null;

        var priorHigh = HighestHigh(i - 24, i - 4);
        var priorLow = LowestLow(i - 24, i - 4);
        var close = Bars.ClosePrices[i];
        var prevClose = Bars.ClosePrices[i - 1];

        var longBreak = Bars.HighPrices[i - 2] > priorHigh + atr * 0.15;
        var shortBreak = Bars.LowPrices[i - 2] < priorLow - atr * 0.15;
        var direction = longBreak ? 1 : shortBreak ? -1 : 0;
        if (direction == 0)
            return null;

        var brokenLevel = direction > 0 ? priorHigh : priorLow;
        var retestDistance = Math.Abs((direction > 0 ? Bars.LowPrices[i] : Bars.HighPrices[i]) - brokenLevel);
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

        // If the old structure is already behind the entry, demand fresh expansion room of at least 2R.
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
        volume = Math.Max(Symbol.VolumeInUnitsMin, Math.Min(Symbol.VolumeInUnitsMax, volume));

        var tradeType = plan.Direction > 0 ? TradeType.Buy : TradeType.Sell;
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, takeProfitPips, plan.Name);

        if (!result.IsSuccessful)
        {
            Print("NAI ENTRY REJECTED | {0} | {1}", plan.Name, result.Error);
            return;
        }

        _lastEntryBar = barIndex;
        Print("NAI ENTER {0} | {1} | entry {2} | SL {3} | TP {4} | RR {5:F2} | risk {6:F2}% | {7}",
            tradeType, plan.Name, result.Position.EntryPrice, plan.Stop, plan.Target, MinimumRR, RiskPercent, plan.Reason);
    }

    private void ManagePosition()
    {
        var p = FindNaiPosition();
        if (p == null || p.StopLoss == null)
            return;

        var originalRisk = Math.Abs(p.EntryPrice - p.StopLoss.Value);
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
            var atr = Atr(Math.Max(1, Bars.Count - 2));
            var candidate = p.TradeType == TradeType.Buy
                ? LowestLow(Math.Max(1, Bars.Count - 5), Bars.Count - 2) - atr * 0.10
                : HighestHigh(Math.Max(1, Bars.Count - 5), Bars.Count - 2) + atr * 0.10;

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
        var open = Bars.OpenPrices[i];
        var close = Bars.ClosePrices[i];
        var high = Bars.HighPrices[i];
        var low = Bars.LowPrices[i];
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
            var tr = Math.Max(Bars.HighPrices[k] - Bars.LowPrices[k],
                Math.Max(Math.Abs(Bars.HighPrices[k] - Bars.ClosePrices[k - 1]), Math.Abs(Bars.LowPrices[k] - Bars.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private double Efficiency(int from, int to)
    {
        if (to <= from)
            return 0;
        var net = Math.Abs(Bars.ClosePrices[to] - Bars.ClosePrices[from]);
        double path = 0;
        for (var k = from + 1; k <= to; k++)
            path += Math.Abs(Bars.ClosePrices[k] - Bars.ClosePrices[k - 1]);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double AverageClose(int from, int to)
    {
        from = Math.Max(0, from);
        if (to < from)
            return Bars.ClosePrices[to];
        double total = 0;
        var count = 0;
        for (var k = from; k <= to; k++)
        {
            total += Bars.ClosePrices[k];
            count++;
        }
        return count == 0 ? Bars.ClosePrices[to] : total / count;
    }

    private double HighestHigh(int from, int to)
    {
        from = Math.Max(0, from);
        var value = double.MinValue;
        for (var k = from; k <= to; k++)
            value = Math.Max(value, Bars.HighPrices[k]);
        return value;
    }

    private double LowestLow(int from, int to)
    {
        from = Math.Max(0, from);
        var value = double.MaxValue;
        for (var k = from; k <= to; k++)
            value = Math.Min(value, Bars.LowPrices[k]);
        return value;
    }

    private sealed record TradePlan(int Direction, string Name, double Entry, double Stop, double Target, double StructureRR, double Atr, string Reason);
}
