using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;
using cAlgo.Robots.MountainBrain;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiMountainBrainTraderV2 : Robot
{
    private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V2";
    private const int MaxTicks = 600;

    private enum CycleState
    {
        SeekingImpulse,
        WaitingPullback,
        PullbackArmed,
        InTrade
    }

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 1.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Sizing Safety %", DefaultValue = 85, MinValue = 65, MaxValue = 95, Step = 5)]
    public double SizingSafetyPercent { get; set; }

    [Parameter("Target R", DefaultValue = 1.20, MinValue = 0.80, MaxValue = 3.00, Step = 0.10)]
    public double TargetR { get; set; }

    [Parameter("Break-even R", DefaultValue = 0.50, MinValue = 0.30, MaxValue = 1.00, Step = 0.05)]
    public double BreakEvenAtR { get; set; }

    [Parameter("Break-even Lock R", DefaultValue = 0.05, MinValue = 0.00, MaxValue = 0.25, Step = 0.05)]
    public double BreakEvenLockR { get; set; }

    [Parameter("Trail Start R", DefaultValue = 0.70, MinValue = 0.50, MaxValue = 1.20, Step = 0.05)]
    public double TrailStartR { get; set; }

    [Parameter("Min Impulse TickVol", DefaultValue = 6.0, MinValue = 3.0, MaxValue = 12.0, Step = 0.5)]
    public double MinImpulseTickVol { get; set; }

    [Parameter("Min Pullback TickVol", DefaultValue = 4.0, MinValue = 2.0, MaxValue = 8.0, Step = 0.5)]
    public double MinPullbackTickVol { get; set; }

    [Parameter("Max Pullback Ratio", DefaultValue = 0.82, MinValue = 0.55, MaxValue = 0.95, Step = 0.01)]
    public double MaxPullbackRatio { get; set; }

    [Parameter("Min Pullback Ticks", DefaultValue = 3, MinValue = 2, MaxValue = 10)]
    public int MinPullbackTicks { get; set; }

    [Parameter("Micro Break Lookback", DefaultValue = 4, MinValue = 3, MaxValue = 8)]
    public int MicroBreakLookback { get; set; }

    [Parameter("Fractal Strength", DefaultValue = 2, MinValue = 1, MaxValue = 5)]
    public int FractalStrength { get; set; }

    [Parameter("Structure Lookback", DefaultValue = 160, MinValue = 60, MaxValue = 400)]
    public int StructureLookback { get; set; }

    private readonly List<double> _ticks = new();
    private Bars _m1 = null!;
    private Bars _m5 = null!;
    private Bars _m15 = null!;
    private StructureSnapshot _lastM1 = new();
    private StructureSnapshot _lastM5 = new();
    private StructureSnapshot _lastM15 = new();
    private long _lastStructureRefreshMinute = -1;

    private CycleState _cycleState = CycleState.SeekingImpulse;
    private int _cycleDirection;
    private int _cycleNumber;
    private double _impulseStart;
    private double _impulseExtreme;
    private double _impulseDistance;
    private double _pullbackExtreme;
    private double _armedPullbackDistance;
    private int _pullbackTicks;
    private string _lastCycleReason = "startup";

    private double _initialRiskPrice;
    private double _entryRiskCapUsd;
    private bool _beProtected;
    private double _bestFavorablePrice;

    private int _signals;
    private int _entries;
    private int _wins;
    private int _losses;
    private int _scratches;
    private int _rejectedPullbacks;
    private int _hardRiskExits;
    private double _net;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI MOUNTAIN BRAIN TRADER V2 BLOCKED | DEMO ONLY");
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _m5 = MarketData.GetBars(TimeFrame.Minute5, SymbolName);
        _m15 = MarketData.GetBars(TimeFrame.Minute15, SymbolName);
        Positions.Closed += OnPositionClosed;

        RefreshStructure();
        var direction = DirectionInt(_lastM5.Direction);
        ResetCycle(direction, MidPrice(), "startup");

        Print("NAI MOUNTAIN BRAIN TRADER V2 STARTED | {0} | DEMO", SymbolName);
        Print("FLOW | M5 direction -> fresh tick impulse -> distinct pullback -> rollover -> micro break + acceleration -> entry");
        Print("RESET | every closed trade must earn a NEW impulse + NEW pullback before another entry");
        Print("M1 | local map only; M1 NEUTRAL does NOT block | M15 context only");
        Print("RISK | requested={0:F2}% | sizing safety={1:F0}% | hard floating-loss cap={0:F2}% of entry equity", RiskPercent, SizingSafetyPercent);
        Print("MANAGEMENT | BE={0:F2}R lock={1:F2}R | structure trail from {2:F2}R | TP={3:F2}R", BreakEvenAtR, BreakEvenLockR, TrailStartR, TargetR);
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

        var mid = MidPrice();
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
            _cycleState = CycleState.InTrade;
            ManagePosition(open);
            return;
        }

        if (_ticks.Count < 70)
            return;

        var activeDirection = DirectionInt(_lastM5.Direction);
        if (activeDirection == 0)
        {
            if (_cycleDirection != 0)
                ResetCycle(0, mid, "M5 neutral");
            return;
        }

        if (activeDirection != _cycleDirection)
            ResetCycle(activeDirection, mid, "M5 direction changed");

        AdvanceCycle(activeDirection, mid);
    }

    private void RefreshStructure()
    {
        if (_m1.Count < 40 || _m5.Count < 40 || _m15.Count < 40)
            return;

        _lastM1 = StructureMapper.Build(_m1, "M1", FractalStrength, StructureLookback);
        _lastM5 = StructureMapper.Build(_m5, "M5", FractalStrength, Math.Min(StructureLookback, 140));
        _lastM15 = StructureMapper.Build(_m15, "M15", FractalStrength, Math.Min(StructureLookback, 100));
    }

    private void AdvanceCycle(int direction, double price)
    {
        var tickVol = TickVolatility(48);
        var atr = Math.Max(Symbol.TickSize, MetricsEngine.Indicators(_m1).Atr);
        var spread = Math.Max(Symbol.TickSize, Symbol.Ask - Symbol.Bid);

        var minImpulse = Math.Max(spread * 1.35, Math.Max(tickVol * MinImpulseTickVol, atr * 0.055));
        var minPullback = Math.Max(spread * 1.10, Math.Max(tickVol * MinPullbackTickVol, atr * 0.035));
        var minTurn = Math.Max(Symbol.TickSize * 2.0, Math.Max(tickVol * 1.25, spread * 0.20));

        if (_cycleState == CycleState.SeekingImpulse)
        {
            SeekImpulse(direction, price, minImpulse);
            return;
        }

        if (_cycleState == CycleState.WaitingPullback)
        {
            TrackForPullback(direction, price, minPullback);
            return;
        }

        if (_cycleState != CycleState.PullbackArmed)
            return;

        _pullbackTicks++;
        var counterMove = CounterMoveFromImpulse(direction, price);
        if (IsFurtherCountertrend(direction, price, _pullbackExtreme))
            _pullbackExtreme = price;

        var currentPullback = Math.Abs(_pullbackExtreme - _impulseExtreme);
        var retracement = _impulseDistance <= Symbol.TickSize ? 1.0 : currentPullback / _impulseDistance;

        if (retracement > MaxPullbackRatio)
        {
            _rejectedPullbacks++;
            Print("CYCLE #{0} REJECT PULLBACK | dir={1} retrace={2:P0} > {3:P0} | this is no longer a clean continuation", _cycleNumber, Side(direction), retracement, MaxPullbackRatio);
            ResetCycle(direction, price, "pullback too deep; require fresh impulse");
            return;
        }

        var turnDistance = direction > 0 ? price - _pullbackExtreme : _pullbackExtreme - price;
        if (_pullbackTicks < MinPullbackTicks || turnDistance < minTurn)
            return;

        if (!HasPrecisionRollover(direction, tickVol, out var triggerText))
            return;

        _signals++;
        ExecuteSignal(direction, triggerText, tickVol, atr, spread);
    }

    private void SeekImpulse(int direction, double price, double minImpulse)
    {
        if (_impulseStart == 0)
        {
            _impulseStart = price;
            _impulseExtreme = price;
        }

        if (direction > 0)
        {
            if (price < _impulseStart)
            {
                _impulseStart = price;
                _impulseExtreme = price;
            }
            if (price > _impulseExtreme)
                _impulseExtreme = price;
        }
        else
        {
            if (price > _impulseStart)
            {
                _impulseStart = price;
                _impulseExtreme = price;
            }
            if (price < _impulseExtreme)
                _impulseExtreme = price;
        }

        _impulseDistance = DirectionalDistance(direction, _impulseStart, _impulseExtreme);
        if (_impulseDistance < minImpulse)
            return;

        _cycleState = CycleState.WaitingPullback;
        _pullbackExtreme = _impulseExtreme;
        _armedPullbackDistance = 0;
        _pullbackTicks = 0;
        Print("CYCLE #{0} IMPULSE READY | {1} | distance={2:F2} | now waiting for a distinct pullback", _cycleNumber, Side(direction), _impulseDistance);
    }

    private void TrackForPullback(int direction, double price, double minPullback)
    {
        if (IsFurtherWithTrend(direction, price, _impulseExtreme))
        {
            _impulseExtreme = price;
            _impulseDistance = DirectionalDistance(direction, _impulseStart, _impulseExtreme);
            return;
        }

        var pullback = CounterMoveFromImpulse(direction, price);
        if (pullback < minPullback)
            return;

        _cycleState = CycleState.PullbackArmed;
        _pullbackExtreme = price;
        _armedPullbackDistance = pullback;
        _pullbackTicks = 1;
        Print("CYCLE #{0} PULLBACK ARMED | {1} | impulse={2:F2} pullback={3:F2} ({4:P0}) | waiting rollover + micro break", _cycleNumber, Side(direction), _impulseDistance, pullback, _impulseDistance <= 0 ? 0 : pullback / _impulseDistance);
    }

    private bool HasPrecisionRollover(int direction, double tickVol, out string text)
    {
        text = "";
        var need = Math.Max(10, MicroBreakLookback + 6);
        if (_ticks.Count < need)
            return false;

        var price = TickBack(0);
        var microLevel = direction > 0 ? PriorTickHigh(MicroBreakLookback) : PriorTickLow(MicroBreakLookback);
        var microBreak = direction > 0 ? price > microLevel : price < microLevel;
        if (!microBreak)
            return false;

        var aligned = 0;
        for (var i = 0; i < 3; i++)
        {
            var delta = TickBack(i) - TickBack(i + 1);
            if (direction * delta > 0)
                aligned++;
        }
        if (aligned < 2)
            return false;

        var vNow = (TickBack(0) - TickBack(4)) / 4.0;
        var vPrev = (TickBack(4) - TickBack(8)) / 4.0;
        var acceleration = vNow - vPrev;
        var velocityFloor = Math.Max(Symbol.TickSize, tickVol * 0.12);
        var accelFloor = Math.Max(Symbol.TickSize * 0.25, tickVol * 0.04);

        if (direction * vNow <= velocityFloor)
            return false;
        if (direction * acceleration <= accelFloor)
            return false;

        text = $"freshPullback={_armedPullbackDistance:F2} extreme={_pullbackExtreme:F2} | microBreak={microLevel:F2} | aligned={aligned}/3 | v={vNow:F3} accel={acceleration:F3}";
        return true;
    }

    private void ExecuteSignal(int direction, string triggerText, double tickVol, double atr, double spread)
    {
        if (FindPosition() != null)
            return;

        var tradeType = direction > 0 ? TradeType.Buy : TradeType.Sell;
        var entry = direction > 0 ? Symbol.Ask : Symbol.Bid;
        var stopBuffer = Math.Max(spread * 0.25, Math.Max(tickVol * 1.75, atr * 0.015));
        var stopPrice = direction > 0 ? _pullbackExtreme - stopBuffer : _pullbackExtreme + stopBuffer;
        var riskPrice = Math.Abs(entry - stopPrice);
        var brokerMin = MinimumStopDistancePrice(entry);
        var minimumRisk = Math.Max(spread * 1.15, brokerMin + Symbol.TickSize * 2.0);

        if (riskPrice < minimumRisk)
        {
            riskPrice = minimumRisk;
            stopPrice = direction > 0 ? entry - riskPrice : entry + riskPrice;
        }

        var stopPips = riskPrice / Symbol.PipSize;
        var tpPips = stopPips * TargetR;
        if (stopPips <= 0 || tpPips <= 0)
            return;

        var sizingRiskPercent = RiskPercent * SizingSafetyPercent / 100.0;
        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, sizingRiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin)
        {
            Print("V2 SKIP | {0} | safe calculated volume below broker minimum", tradeType);
            ResetCycle(direction, MidPrice(), "volume below minimum");
            return;
        }
        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

        var riskCapUsd = Account.Equity * RiskPercent / 100.0;
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, "FRESH-PULLBACK-MICROBREAK");
        if (!result.IsSuccessful)
        {
            Print("V2 ENTRY REJECTED | {0} | {1}", tradeType, result.Error);
            ResetCycle(direction, MidPrice(), "entry rejected");
            return;
        }

        _entries++;
        _cycleState = CycleState.InTrade;
        _initialRiskPrice = riskPrice;
        _entryRiskCapUsd = riskCapUsd;
        _beProtected = false;
        _bestFavorablePrice = result.Position.EntryPrice;

        Print("V2 ENTER {0} | cycle=#{1} | M15={2} M5={3} M1={4} | entry={5:F2} pullbackExtreme={6:F2} stopRef={7:F2} riskPrice={8:F2} | safeSizing={9:F3}% hardCap=${10:F2} TP={11:F2}R | {12}",
            tradeType, _cycleNumber, Dir(_lastM15.Direction), Dir(_lastM5.Direction), Dir(_lastM1.Direction),
            result.Position.EntryPrice, _pullbackExtreme, stopPrice, riskPrice, sizingRiskPercent, riskCapUsd, TargetR, triggerText);
    }

    private void ManagePosition(Position p)
    {
        if (_initialRiskPrice <= Symbol.TickSize)
            return;

        if (_entryRiskCapUsd > 0 && p.NetProfit <= -_entryRiskCapUsd)
        {
            var close = ClosePosition(p);
            if (close.IsSuccessful)
            {
                _hardRiskExits++;
                Print("V2 HARD RISK EXIT | {0} floatingNet={1:F2} cap=-${2:F2}", p.TradeType, p.NetProfit, _entryRiskCapUsd);
            }
            return;
        }

        var direction = p.TradeType == TradeType.Buy ? 1 : -1;
        var current = direction > 0 ? Symbol.Bid : Symbol.Ask;
        if (direction > 0)
            _bestFavorablePrice = Math.Max(_bestFavorablePrice, current);
        else
            _bestFavorablePrice = Math.Min(_bestFavorablePrice, current);

        var favorable = direction > 0 ? current - p.EntryPrice : p.EntryPrice - current;
        var liveR = favorable / _initialRiskPrice;

        if (!_beProtected && liveR >= BreakEvenAtR)
            TryMoveToLockedBreakEven(p, direction, liveR);

        if (liveR >= TrailStartR)
            TryStructureTrail(p, direction, liveR);
    }

    private void TryMoveToLockedBreakEven(Position p, int direction, double liveR)
    {
        var lockPrice = p.EntryPrice + direction * (_initialRiskPrice * BreakEvenLockR);
        if (!IsValidImprovement(p, direction, lockPrice) || !HasBrokerRoom(direction, lockPrice))
            return;

        var result = ModifyPosition(p, lockPrice, p.TakeProfit, false);
        if (result.IsSuccessful)
        {
            _beProtected = true;
            Print("V2 PROTECT | {0} | liveR={1:F2} | stop -> {2:F2} ({3:F2}R locked)", p.TradeType, liveR, lockPrice, BreakEvenLockR);
        }
    }

    private void TryStructureTrail(Position p, int direction, double liveR)
    {
        var tickVol = TickVolatility(36);
        var spread = Math.Max(Symbol.TickSize, Symbol.Ask - Symbol.Bid);
        var buffer = Math.Max(spread * 0.18, tickVol * 1.25);
        var swing = direction > 0 ? FindRecentTickSwingLow(2, 48) : FindRecentTickSwingHigh(2, 48);

        double candidate;
        var source = "swing";
        if (swing.HasValue)
            candidate = direction > 0 ? swing.Value - buffer : swing.Value + buffer;
        else
        {
            var lockR = liveR >= 1.0 ? 0.45 : 0.18;
            candidate = p.EntryPrice + direction * (_initialRiskPrice * lockR);
            source = $"fallback-{lockR:F2}R";
        }

        var minimumLocked = p.EntryPrice + direction * (_initialRiskPrice * (liveR >= 1.0 ? 0.35 : 0.08));
        if (direction > 0)
            candidate = Math.Max(candidate, minimumLocked);
        else
            candidate = Math.Min(candidate, minimumLocked);

        if (!IsValidImprovement(p, direction, candidate) || !HasBrokerRoom(direction, candidate))
            return;

        var result = ModifyPosition(p, candidate, p.TakeProfit, false);
        if (result.IsSuccessful)
        {
            _beProtected = true;
            Print("V2 TRAIL | {0} | liveR={1:F2} | source={2} stop -> {3:F2}", p.TradeType, liveR, source, candidate);
        }
    }

    private bool IsValidImprovement(Position p, int direction, double candidate)
    {
        if (!p.StopLoss.HasValue)
            return true;
        return direction > 0 ? candidate > p.StopLoss.Value + Symbol.TickSize : candidate < p.StopLoss.Value - Symbol.TickSize;
    }

    private bool HasBrokerRoom(int direction, double stopPrice)
    {
        var current = direction > 0 ? Symbol.Bid : Symbol.Ask;
        var min = MinimumStopDistancePrice(current) + Symbol.TickSize;
        return direction > 0 ? stopPrice < current - min : stopPrice > current + min;
    }

    private double? FindRecentTickSwingLow(int strength, int lookback)
    {
        if (_ticks.Count < strength * 2 + 4)
            return null;
        var from = Math.Max(strength, _ticks.Count - lookback);
        var to = _ticks.Count - strength - 1;
        for (var i = to; i >= from; i--)
        {
            var value = _ticks[i];
            var ok = true;
            for (var j = 1; j <= strength; j++)
                if (_ticks[i - j] <= value || _ticks[i + j] < value) ok = false;
            if (ok) return value;
        }
        return null;
    }

    private double? FindRecentTickSwingHigh(int strength, int lookback)
    {
        if (_ticks.Count < strength * 2 + 4)
            return null;
        var from = Math.Max(strength, _ticks.Count - lookback);
        var to = _ticks.Count - strength - 1;
        for (var i = to; i >= from; i--)
        {
            var value = _ticks[i];
            var ok = true;
            for (var j = 1; j <= strength; j++)
                if (_ticks[i - j] >= value || _ticks[i + j] > value) ok = false;
            if (ok) return value;
        }
        return null;
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

        Print("V2 RESULT | {0} net={1:F2} reason={2} | W/L/S={3}/{4}/{5} net={6:F2} | OLD SETUP RETIRED; require fresh impulse + pullback",
            p.TradeType, p.NetProfit, args.Reason, _wins, _losses, _scratches, _net);

        _initialRiskPrice = 0;
        _entryRiskCapUsd = 0;
        _beProtected = false;
        _bestFavorablePrice = 0;

        var direction = DirectionInt(_lastM5.Direction);
        ResetCycle(direction, MidPrice(), "position closed; no duplicate re-entry");
    }

    private void ResetCycle(int direction, double price, string reason)
    {
        _cycleNumber++;
        _cycleDirection = direction;
        _cycleState = CycleState.SeekingImpulse;
        _impulseStart = price;
        _impulseExtreme = price;
        _impulseDistance = 0;
        _pullbackExtreme = price;
        _armedPullbackDistance = 0;
        _pullbackTicks = 0;
        _lastCycleReason = reason;
        if (direction != 0)
            Print("CYCLE #{0} RESET | dir={1} | {2}", _cycleNumber, Side(direction), reason);
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private double MidPrice() => (Symbol.Bid + Symbol.Ask) * 0.5;
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

    private double PriorTickHigh(int lookback)
    {
        var count = Math.Min(lookback, _ticks.Count - 1);
        var max = double.MinValue;
        for (var back = 1; back <= count; back++)
            max = Math.Max(max, TickBack(back));
        return max;
    }

    private double PriorTickLow(int lookback)
    {
        var count = Math.Min(lookback, _ticks.Count - 1);
        var min = double.MaxValue;
        for (var back = 1; back <= count; back++)
            min = Math.Min(min, TickBack(back));
        return min;
    }

    private double MinimumStopDistancePrice(double referencePrice)
    {
        if (Symbol.MinStopLossDistance <= 0)
            return 0;
        if (Symbol.MinDistanceType == SymbolMinDistanceType.Percentage)
            return referencePrice * Symbol.MinStopLossDistance / 100.0;
        return Symbol.MinStopLossDistance * Symbol.PipSize;
    }

    private double CounterMoveFromImpulse(int direction, double price) => direction > 0 ? _impulseExtreme - price : price - _impulseExtreme;
    private static bool IsFurtherWithTrend(int direction, double price, double extreme) => direction > 0 ? price > extreme : price < extreme;
    private static bool IsFurtherCountertrend(int direction, double price, double extreme) => direction > 0 ? price < extreme : price > extreme;
    private static double DirectionalDistance(int direction, double start, double end) => Math.Max(0, direction * (end - start));
    private static int DirectionInt(MarketDirection d) => d == MarketDirection.Up ? 1 : d == MarketDirection.Down ? -1 : 0;
    private static string Side(int direction) => direction > 0 ? "BUY/UP" : direction < 0 ? "SELL/DOWN" : "NEUTRAL";
    private static string Dir(MarketDirection d) => d == MarketDirection.Up ? "UP" : d == MarketDirection.Down ? "DOWN" : "NEUTRAL";

    private void PrintStats(string trigger)
    {
        Print("=== NAI MOUNTAIN BRAIN TRADER V2 | {0} ===", trigger);
        Print("signals={0} entries={1} | W={2} L={3} scratch={4} | rejectedDeepPullbacks={5} hardRiskExits={6} | net={7:F2}",
            _signals, _entries, _wins, _losses, _scratches, _rejectedPullbacks, _hardRiskExits, _net);
        Print("lastCycle=#{0} state={1} dir={2} reason={3}", _cycleNumber, _cycleState, Side(_cycleDirection), _lastCycleReason);
        Print("=== END STATS ===");
    }
}
