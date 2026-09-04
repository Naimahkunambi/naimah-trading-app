using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;
using cAlgo.Robots.MountainBrain;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiMountainBrainTraderV1 : Robot
{
    private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V1";
    private const int MaxTicks = 300;

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 1.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Target R", DefaultValue = 1.20, MinValue = 0.50, MaxValue = 3.00, Step = 0.10)]
    public double TargetR { get; set; }

    [Parameter("Break-even R", DefaultValue = 0.50, MinValue = 0.20, MaxValue = 1.50, Step = 0.10)]
    public double BreakEvenAtR { get; set; }

    [Parameter("Fractal Strength", DefaultValue = 2, MinValue = 1, MaxValue = 5)]
    public int FractalStrength { get; set; }

    [Parameter("Structure Lookback", DefaultValue = 160, MinValue = 60, MaxValue = 400)]
    public int StructureLookback { get; set; }

    [Parameter("Tick Recovery Count", DefaultValue = 1, MinValue = 1, MaxValue = 2)]
    public int RecoveryTicks { get; set; }

    private readonly List<double> _ticks = new();
    private Bars _m1 = null!;
    private Bars _m5 = null!;
    private Bars _m15 = null!;
    private StructureSnapshot _lastM1 = new();
    private StructureSnapshot _lastM5 = new();
    private StructureSnapshot _lastM15 = new();
    private long _lastStructureRefreshMinute = -1;
    private double _initialRiskPrice;
    private bool _beMoved;

    private int _signals;
    private int _entries;
    private int _wins;
    private int _losses;
    private int _scratches;
    private double _net;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI MOUNTAIN BRAIN TRADER V1 BLOCKED | DEMO ONLY");
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _m5 = MarketData.GetBars(TimeFrame.Minute5, SymbolName);
        _m15 = MarketData.GetBars(TimeFrame.Minute15, SymbolName);
        Positions.Closed += OnPositionClosed;

        RefreshStructure();

        Print("NAI MOUNTAIN BRAIN TRADER V1 STARTED | {0} | DEMO", SymbolName);
        Print("DIRECTION | M5 active mountain controls side");
        Print("LOCAL MAP | M1 provides pullback/swing structure; M1 NEUTRAL does NOT block");
        Print("ENTRY | live tick pullback -> continuation | recoveryTicks={0}", RecoveryTicks);
        Print("M15 | context/logging only, never a hard filter");
        Print("RISK | {0:F2}% | TP={1:F2}R | BE={2:F2}R | one position | immediate rescan", RiskPercent, TargetR, BreakEvenAtR);
    }

    protected override void OnStop()
    {
        Positions.Closed -= OnPositionClosed;
        PrintStats("BOT STOP");
    }

    protected override void OnTick()
    {
        if (Account.IsLive)
            return;

        var mid = (Symbol.Bid + Symbol.Ask) * 0.5;
        _ticks.Add(mid);
        if (_ticks.Count > MaxTicks)
            _ticks.RemoveAt(0);

        var minuteKey = Server.Time.Ticks / TimeSpan.TicksPerMinute;
        if (minuteKey != _lastStructureRefreshMinute)
        {
            _lastStructureRefreshMinute = minuteKey;
            RefreshStructure();
        }

        var open = FindPosition();
        if (open != null)
        {
            ManagePosition(open);
            return;
        }

        if (_ticks.Count < 45)
            return;

        ScanEntry();
    }

    private void RefreshStructure()
    {
        if (_m1.Count < 40 || _m5.Count < 40 || _m15.Count < 40)
            return;

        _lastM1 = StructureMapper.Build(_m1, "M1", FractalStrength, StructureLookback);
        _lastM5 = StructureMapper.Build(_m5, "M5", FractalStrength, Math.Min(StructureLookback, 140));
        _lastM15 = StructureMapper.Build(_m15, "M15", FractalStrength, Math.Min(StructureLookback, 100));
    }

    private void ScanEntry()
    {
        var activeDirection = _lastM5.Direction;
        if (activeDirection == MarketDirection.Neutral)
            return;

        var direction = activeDirection == MarketDirection.Up ? 1 : -1;
        if (!HasContinuationTrigger(direction, out var pattern))
            return;

        _signals++;
        ExecuteSignal(direction, pattern);
    }

    private bool HasContinuationTrigger(int direction, out string pattern)
    {
        pattern = "";
        if (RecoveryTicks <= 1)
        {
            if (_ticks.Count < 3)
                return false;

            var t1 = TickBack(0);
            var t2 = TickBack(1);
            var t3 = TickBack(2);

            if (direction > 0 && t2 < t3 && t1 > t2)
            {
                pattern = $"BUY continuation | T3={t3:F2} > T2={t2:F2} < T1={t1:F2}";
                return true;
            }

            if (direction < 0 && t2 > t3 && t1 < t2)
            {
                pattern = $"SELL continuation | T3={t3:F2} < T2={t2:F2} > T1={t1:F2}";
                return true;
            }

            return false;
        }

        if (_ticks.Count < 4)
            return false;

        var n1 = TickBack(0);
        var n2 = TickBack(1);
        var n3 = TickBack(2);
        var n4 = TickBack(3);

        if (direction > 0 && n4 > n3 && n2 > n3 && n1 > n2)
        {
            pattern = $"BUY 2R | T4={n4:F2}>T3={n3:F2}; T2>T3; T1>T2";
            return true;
        }

        if (direction < 0 && n4 < n3 && n2 < n3 && n1 < n2)
        {
            pattern = $"SELL 2R | T4={n4:F2}<T3={n3:F2}; T2<T3; T1<T2";
            return true;
        }

        return false;
    }

    private void ExecuteSignal(int direction, string pattern)
    {
        if (FindPosition() != null)
            return;

        var tradeType = direction > 0 ? TradeType.Buy : TradeType.Sell;
        var entry = direction > 0 ? Symbol.Ask : Symbol.Bid;
        var atr = MetricsEngine.Indicators(_m1).Atr;
        var tickVol = TickVolatility(34);
        var spread = Math.Max(Symbol.TickSize, Symbol.Ask - Symbol.Bid);
        var structural = StructuralStopReference(direction);
        var buffer = Math.Max(tickVol * 1.5, Math.Max(Symbol.TickSize * 2.0, atr * 0.03));

        double stopPrice;
        if (direction > 0)
            stopPrice = structural.HasValue && structural.Value < entry ? structural.Value - buffer : RecentTickLow(12) - buffer;
        else
            stopPrice = structural.HasValue && structural.Value > entry ? structural.Value + buffer : RecentTickHigh(12) + buffer;

        var riskPrice = Math.Abs(entry - stopPrice);
        var brokerMin = MinimumStopDistancePrice(entry);
        var minimumRisk = Math.Max(spread * 1.5, brokerMin + Symbol.TickSize * 2.0);
        if (riskPrice < minimumRisk)
        {
            riskPrice = minimumRisk;
            stopPrice = direction > 0 ? entry - riskPrice : entry + riskPrice;
        }

        var stopPips = riskPrice / Symbol.PipSize;
        var tpPips = stopPips * TargetR;
        if (stopPips <= 0 || tpPips <= 0)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin)
        {
            Print("MOUNTAIN TRADER | SKIP {0} | calculated volume below broker minimum", tradeType);
            return;
        }
        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, "M5-MOUNTAIN-TICK-CONT");
        if (!result.IsSuccessful)
        {
            Print("MOUNTAIN TRADER | ENTRY REJECTED | {0} | {1}", tradeType, result.Error);
            return;
        }

        _entries++;
        _initialRiskPrice = riskPrice;
        _beMoved = false;

        Print("MOUNTAIN TRADER | ENTER {0} | M15={1} M5={2} M1={3} | M1 protectedLow={4} protectedHigh={5} | entry={6:F2} SLref={7:F2} TP={8:F2}R | {9}",
            tradeType,
            Dir(_lastM15.Direction), Dir(_lastM5.Direction), Dir(_lastM1.Direction),
            Fmt(_lastM1.ProtectedLow), Fmt(_lastM1.ProtectedHigh),
            result.Position.EntryPrice, stopPrice, TargetR, pattern);
    }

    private void ManagePosition(Position p)
    {
        if (_beMoved || _initialRiskPrice <= Symbol.TickSize)
            return;

        var current = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? current - p.EntryPrice : p.EntryPrice - current;
        var liveR = favorable / _initialRiskPrice;
        if (liveR < BreakEvenAtR)
            return;

        var be = p.EntryPrice;
        if (p.StopLoss.HasValue)
        {
            var alreadyProtected = p.TradeType == TradeType.Buy ? p.StopLoss.Value >= be : p.StopLoss.Value <= be;
            if (alreadyProtected)
            {
                _beMoved = true;
                return;
            }
        }

        var result = ModifyPosition(p, be, p.TakeProfit, false);
        if (result.IsSuccessful)
        {
            _beMoved = true;
            Print("MOUNTAIN TRADER | BREAK-EVEN | {0} at {1:F2} liveR={2:F2}", p.TradeType, be, liveR);
        }
    }

    private double? StructuralStopReference(int direction)
    {
        if (direction > 0)
        {
            var lows = _lastM1.Swings.Where(s => s.Kind == SwingKind.Low).OrderByDescending(s => s.BarIndex).Take(4).ToList();
            var valid = lows.FirstOrDefault(s => s.Price < Symbol.Ask);
            return valid?.Price;
        }

        var highs = _lastM1.Swings.Where(s => s.Kind == SwingKind.High).OrderByDescending(s => s.BarIndex).Take(4).ToList();
        var sellValid = highs.FirstOrDefault(s => s.Price > Symbol.Bid);
        return sellValid?.Price;
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.SymbolName != SymbolName || p.Label != Label)
            return;

        if (p.NetProfit > 0.01) _wins++;
        else if (p.NetProfit < -0.01) _losses++;
        else _scratches++;
        _net += p.NetProfit;
        _initialRiskPrice = 0;
        _beMoved = false;

        Print("MOUNTAIN TRADER RESULT | {0} net={1:F2} reason={2} | W/L/S={3}/{4}/{5} totalNet={6:F2} | RESCAN NOW",
            p.TradeType, p.NetProfit, args.Reason, _wins, _losses, _scratches, _net);
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private double TickBack(int back) => _ticks[Math.Max(0, _ticks.Count - 1 - back)];

    private double TickVolatility(int window)
    {
        var n = Math.Min(window, _ticks.Count - 1);
        if (n <= 0) return Symbol.TickSize;
        var sum = 0.0;
        var from = _ticks.Count - 1 - n;
        for (var i = from + 1; i < _ticks.Count; i++)
            sum += Math.Abs(_ticks[i] - _ticks[i - 1]);
        return Math.Max(Symbol.TickSize, sum / n);
    }

    private double RecentTickLow(int window)
    {
        var n = Math.Min(window, _ticks.Count);
        var min = double.MaxValue;
        for (var i = _ticks.Count - n; i < _ticks.Count; i++) min = Math.Min(min, _ticks[i]);
        return min;
    }

    private double RecentTickHigh(int window)
    {
        var n = Math.Min(window, _ticks.Count);
        var max = double.MinValue;
        for (var i = _ticks.Count - n; i < _ticks.Count; i++) max = Math.Max(max, _ticks[i]);
        return max;
    }

    private double MinimumStopDistancePrice(double referencePrice)
    {
        if (Symbol.MinStopLossDistance <= 0)
            return 0;
        if (Symbol.MinDistanceType == SymbolMinDistanceType.Percentage)
            return referencePrice * Symbol.MinStopLossDistance / 100.0;
        return Symbol.MinStopLossDistance * Symbol.PipSize;
    }

    private static string Dir(MarketDirection d) => d == MarketDirection.Up ? "UP" : d == MarketDirection.Down ? "DOWN" : "NEUTRAL";
    private static string Fmt(double? v) => v.HasValue ? v.Value.ToString("F2") : "none";

    private void PrintStats(string trigger)
    {
        Print("=== NAI MOUNTAIN BRAIN TRADER V1 | {0} ===", trigger);
        Print("signals={0} entries={1} | W={2} L={3} scratch={4} | net={5:F2}", _signals, _entries, _wins, _losses, _scratches, _net);
        Print("=== END STATS ===");
    }
}

// build trigger only; strategy unchanged
