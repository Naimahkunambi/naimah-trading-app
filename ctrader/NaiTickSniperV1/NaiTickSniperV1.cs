using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiTickSniperV2 : Robot
{
    private const string Label = "NAI-TICK-SNIPER-V2";
    private const string RequiredSymbolText = "Volatility 25 (1s)";
    private const int MaxTickHistory = 220;
    private const double SetupLifetimeSeconds = 45.0;

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 1.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Target R", DefaultValue = 1.50, MinValue = 1.20, MaxValue = 3.00, Step = 0.10)]
    public double TargetR { get; set; }

    [Parameter("Daily Equity Stop %", DefaultValue = 2.00, MinValue = 1.00, MaxValue = 5.00, Step = 0.50)]
    public double DailyEquityStopPercent { get; set; }

    [Parameter("ATR Period", DefaultValue = 14, MinValue = 8, MaxValue = 40)]
    public int AtrPeriod { get; set; }

    [Parameter("Break-even at R", DefaultValue = 0.80, MinValue = 0.50, MaxValue = 1.50, Step = 0.10)]
    public double BreakEvenAtR { get; set; }

    [Parameter("Trail at R", DefaultValue = 1.20, MinValue = 0.80, MaxValue = 2.50, Step = 0.10)]
    public double TrailAtR { get; set; }

    [Parameter("Cooldown Seconds", DefaultValue = 10, MinValue = 0, MaxValue = 120)]
    public int CooldownSeconds { get; set; }

    [Parameter("Local Direction Ticks", DefaultValue = 60, MinValue = 30, MaxValue = 120)]
    public int LocalDirectionTicks { get; set; }

    [Parameter("Impulse Window Ticks", DefaultValue = 24, MinValue = 12, MaxValue = 50)]
    public int ImpulseWindowTicks { get; set; }

    [Parameter("Impulse Min TickVol", DefaultValue = 3.5, MinValue = 1.5, MaxValue = 10.0, Step = 0.25)]
    public double ImpulseMinTickVol { get; set; }

    [Parameter("Impulse Min Efficiency", DefaultValue = 0.42, MinValue = 0.20, MaxValue = 0.90, Step = 0.01)]
    public double ImpulseMinEfficiency { get; set; }

    [Parameter("Pullback Min %", DefaultValue = 0.10, MinValue = 0.03, MaxValue = 0.35, Step = 0.01)]
    public double PullbackMinFraction { get; set; }

    [Parameter("Pullback Max %", DefaultValue = 0.65, MinValue = 0.35, MaxValue = 0.85, Step = 0.01)]
    public double PullbackMaxFraction { get; set; }

    [Parameter("Turn Window Ticks", DefaultValue = 6, MinValue = 3, MaxValue = 12)]
    public int TurnWindowTicks { get; set; }

    [Parameter("Confirm Advancing Ticks", DefaultValue = 2, MinValue = 1, MaxValue = 4)]
    public int ConfirmAdvancingTicks { get; set; }

    [Parameter("Direct Confirm Ticks", DefaultValue = 2, MinValue = 1, MaxValue = 4)]
    public int DirectConfirmTicks { get; set; }

    [Parameter("Max Chase TickVol", DefaultValue = 8.0, MinValue = 3.0, MaxValue = 20.0, Step = 0.5)]
    public double MaxChaseTickVol { get; set; }

    private Bars _m1 = null!;
    private readonly List<TickPoint> _ticks = new();
    private TickState _state = TickState.Searching;
    private TickSetup? _setup;
    private DateTime _equityDay;
    private double _dayStartEquity;
    private bool _halted;
    private DateTime _lastCloseTime = DateTime.MinValue;
    private double? _lastStopRequestPrice;

    private int _impulses;
    private int _pullbacks;
    private int _turns;
    private int _entries;
    private int _directEntries;
    private int _pullbackEntries;
    private int _longTrades;
    private int _shortTrades;
    private int _wins;
    private int _losses;
    private int _scratches;
    private int _missedNoChase;
    private int _failedSetups;
    private double _net;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI TICK SNIPER V2 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI TICK SNIPER V2 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        Positions.Closed += OnPositionClosed;

        Print("NAI TICK SNIPER V2 STARTED | {0} | DEMO", SymbolName);
        Print("ENTRY BRAIN | TICKS ONLY FOR RECOGNITION | 60-tick local direction | ~24-tick impulse | 6-tick turn | 2 advancing ticks");
        Print("ENTRY PATH A | IMPULSE -> PULLBACK -> TURN -> {0} advancing ticks -> ENTRY", ConfirmAdvancingTicks);
        Print("ENTRY PATH B | STRONG DIRECT IMPULSE -> {0} continuation ticks -> ENTRY", DirectConfirmTicks);
        Print("M1 ROLE | safety/risk scale only | M1 does NOT detect fast movement, choose direction, or grant permission");
        Print("RISK | {0:F2}% | TP={1:F2}R | BE={2:F2}R | TRAIL={3:F2}R | cooldown={4}s", RiskPercent, TargetR, BreakEvenAtR, TrailAtR, CooldownSeconds);
        Print("FAST SETTINGS | local={0} impulse={1} minMove={2:F1} tickVol eff>={3:F2} pullback={4:P0}-{5:P0} maxChase={6:F1} tickVol",
            LocalDirectionTicks, ImpulseWindowTicks, ImpulseMinTickVol, ImpulseMinEfficiency, PullbackMinFraction, PullbackMaxFraction, MaxChaseTickVol);
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

        ResetDailyAnchorIfNeeded();
        if (_halted)
            return;
        if (HitDailyStop())
            return;

        ManageOpenPosition();

        var mid = (Symbol.Bid + Symbol.Ask) * 0.5;
        AddTick(mid);

        if (FindPosition() != null)
            return;

        if (_lastCloseTime != DateTime.MinValue && (Server.Time - _lastCloseTime).TotalSeconds < CooldownSeconds)
            return;

        var minimumTicks = Math.Max(LocalDirectionTicks + 2, Math.Max(ImpulseWindowTicks + 2, 70));
        if (_ticks.Count < minimumTicks)
            return;

        var tickVol = TickVolatility(LocalDirectionTicks);
        if (tickVol <= 0)
            return;

        if (_setup != null && (Server.Time - _setup.CreatedAt).TotalSeconds > SetupLifetimeSeconds)
        {
            _failedSetups++;
            ResetSetup("setup expired");
        }

        AdvanceStateMachine(mid, tickVol);
    }

    private void AddTick(double price)
    {
        _ticks.Add(new TickPoint(Server.Time, price));
        if (_ticks.Count > MaxTickHistory)
            _ticks.RemoveAt(0);
    }

    private void AdvanceStateMachine(double price, double tickVol)
    {
        switch (_state)
        {
            case TickState.Searching:
                TryFindImpulse(tickVol);
                break;
            case TickState.ImpulseFound:
                TrackImpulsePullbackOrDirect(price, tickVol);
                break;
            case TickState.Pullback:
                TrackPullbackAndTurn(price, tickVol);
                break;
            case TickState.ConfirmingTurn:
                TrackTurnConfirmation(price, tickVol);
                break;
            case TickState.ConfirmingDirect:
                TrackDirectConfirmation(price, tickVol);
                break;
        }
    }

    private void TryFindImpulse(double tickVol)
    {
        var n = Math.Min(ImpulseWindowTicks, _ticks.Count - 1);
        if (n < 8)
            return;

        var from = _ticks.Count - 1 - n;
        var to = _ticks.Count - 1;
        var start = _ticks[from].Price;
        var end = _ticks[to].Price;
        var net = end - start;
        var absNet = Math.Abs(net);
        var path = PathDistance(from, to);
        if (path <= Symbol.TickSize)
            return;

        var efficiency = absNet / path;
        var moveTickVol = absNet / tickVol;
        if (moveTickVol < ImpulseMinTickVol || efficiency < ImpulseMinEfficiency)
            return;

        var direction = net > 0 ? 1 : -1;
        var localDirection = LocalDirection(tickVol);

        // Local direction is informational unless it is very strongly opposite.
        var localNet = PriceFromBack(0) - PriceFromBack(Math.Min(LocalDirectionTicks, _ticks.Count - 1));
        var strongOpposite = localDirection != 0 && localDirection != direction && Math.Abs(localNet) >= tickVol * 8.0;
        if (strongOpposite)
            return;

        var windowMin = MinPriceRange(from, to);
        var windowMax = MaxPriceRange(from, to);
        var basePrice = direction > 0 ? windowMin : windowMax;
        var extreme = direction > 0 ? windowMax : windowMin;
        var impulseSize = Math.Abs(extreme - basePrice);

        _setup = new TickSetup(direction, basePrice, extreme, impulseSize, tickVol, Server.Time, localDirection);
        _setup.LastDirectPrice = end;
        _state = TickState.ImpulseFound;
        _impulses++;

        Print("NAI TICK | IMPULSE {0} | size={1:F1} tickVol eff={2:F2} local={3} base={4:F2} extreme={5:F2}",
            direction > 0 ? "UP" : "DOWN", impulseSize / tickVol, efficiency, LocalText(localDirection), basePrice, extreme);
    }

    private void TrackImpulsePullbackOrDirect(double price, double tickVol)
    {
        var s = _setup;
        if (s == null)
        {
            ResetSetup("missing impulse setup");
            return;
        }

        var madeNewExtreme = s.Direction > 0 ? price > s.Extreme : price < s.Extreme;
        if (madeNewExtreme)
        {
            s.Extreme = price;
            s.ImpulseSize = Math.Abs(s.Extreme - s.Base);

            var advanced = s.Direction > 0
                ? price > s.LastDirectPrice + Symbol.TickSize * 0.25
                : price < s.LastDirectPrice - Symbol.TickSize * 0.25;
            if (advanced)
            {
                s.DirectConfirmTicks++;
                s.LastDirectPrice = price;
            }

            if (s.DirectConfirmTicks >= DirectConfirmTicks)
            {
                _state = TickState.ConfirmingDirect;
                TrackDirectConfirmation(price, tickVol);
            }
            return;
        }

        var retrace = RetraceFraction(s, price);
        if (retrace > PullbackMaxFraction + 0.12)
        {
            _failedSetups++;
            ResetSetup($"impulse retraced too deeply {retrace:P0}");
            return;
        }

        if (retrace >= PullbackMinFraction && retrace <= PullbackMaxFraction)
        {
            s.CandidateTurn = price;
            s.PullbackStartedAt = Server.Time;
            s.TurnConfirmTicks = 0;
            s.LastTurnConfirmPrice = 0;
            _state = TickState.Pullback;
            _pullbacks++;

            Print("NAI TICK | PULLBACK {0} | retrace={1:P0} candidate={2:F2}",
                s.Direction > 0 ? "LONG" : "SHORT", retrace, price);
        }
    }

    private void TrackPullbackAndTurn(double price, double tickVol)
    {
        var s = _setup;
        if (s == null)
        {
            ResetSetup("missing pullback setup");
            return;
        }

        if (s.Direction > 0)
            s.CandidateTurn = Math.Min(s.CandidateTurn, price);
        else
            s.CandidateTurn = Math.Max(s.CandidateTurn, price);

        var retrace = RetraceFraction(s, price);
        if (retrace > PullbackMaxFraction + 0.12)
        {
            _failedSetups++;
            ResetSetup($"pullback failed retrace={retrace:P0}");
            return;
        }

        if (_ticks.Count < TurnWindowTicks * 2 + 2)
            return;

        var recentNet = PriceFromBack(0) - PriceFromBack(TurnWindowTicks);
        var previousNet = PriceFromBack(TurnWindowTicks) - PriceFromBack(TurnWindowTicks * 2);
        var minTurn = tickVol * 1.5;

        var turned = s.Direction > 0
            ? recentNet >= minTurn && recentNet > previousNet + tickVol * 0.5
            : recentNet <= -minTurn && recentNet < previousNet - tickVol * 0.5;
        if (!turned)
            return;

        s.LastTurnConfirmPrice = price;
        s.TurnConfirmTicks = 0;
        _state = TickState.ConfirmingTurn;
        _turns++;

        Print("NAI TICK | TURN {0} | candidate={1:F2} recent={2:F1} tickVol previous={3:F1} tickVol",
            s.Direction > 0 ? "UP" : "DOWN", s.CandidateTurn, recentNet / tickVol, previousNet / tickVol);
    }

    private void TrackTurnConfirmation(double price, double tickVol)
    {
        var s = _setup;
        if (s == null)
        {
            ResetSetup("missing turn setup");
            return;
        }

        var failedTurn = s.Direction > 0
            ? price < s.CandidateTurn - tickVol * 2.0
            : price > s.CandidateTurn + tickVol * 2.0;
        if (failedTurn)
        {
            s.TurnConfirmTicks = 0;
            s.LastTurnConfirmPrice = 0;
            _state = TickState.Pullback;
            Print("NAI TICK | TURN FAILED | back into pullback");
            return;
        }

        var advanced = s.Direction > 0
            ? price > s.LastTurnConfirmPrice + Symbol.TickSize * 0.25
            : price < s.LastTurnConfirmPrice - Symbol.TickSize * 0.25;
        if (advanced)
        {
            s.TurnConfirmTicks++;
            s.LastTurnConfirmPrice = price;
        }

        if (s.TurnConfirmTicks < ConfirmAdvancingTicks)
            return;

        var moveFromTurn = s.Direction > 0
            ? price - s.CandidateTurn
            : s.CandidateTurn - price;
        if (moveFromTurn > tickVol * MaxChaseTickVol)
        {
            _missedNoChase++;
            ResetSetup($"turn already ran {moveFromTurn / tickVol:F1} tickVol");
            return;
        }

        ExecuteTickEntry(s, tickVol, EntryPath.PullbackTurn);
    }

    private void TrackDirectConfirmation(double price, double tickVol)
    {
        var s = _setup;
        if (s == null)
        {
            ResetSetup("missing direct setup");
            return;
        }

        var recentNet = PriceFromBack(0) - PriceFromBack(Math.Min(6, _ticks.Count - 1));
        var continuationAlive = s.Direction > 0 ? recentNet > 0 : recentNet < 0;
        if (!continuationAlive)
        {
            s.DirectConfirmTicks = 0;
            _state = TickState.ImpulseFound;
            return;
        }

        var extensionFromDetection = s.Direction > 0
            ? price - s.DetectionExtreme
            : s.DetectionExtreme - price;
        if (extensionFromDetection > tickVol * MaxChaseTickVol)
        {
            _missedNoChase++;
            ResetSetup($"direct move already ran {extensionFromDetection / tickVol:F1} tickVol");
            return;
        }

        ExecuteTickEntry(s, tickVol, EntryPath.DirectContinuation);
    }

    private void ExecuteTickEntry(TickSetup s, double tickVol, EntryPath path)
    {
        var tradeType = s.Direction > 0 ? TradeType.Buy : TradeType.Sell;
        var entry = s.Direction > 0 ? Symbol.Ask : Symbol.Bid;
        var m1Atr = _m1 != null && _m1.Count > AtrPeriod + 3 ? Atr(_m1.Count - 2) : 0;

        double stop;
        if (path == EntryPath.PullbackTurn)
        {
            var buffer = Math.Max(Symbol.TickSize * 2.0, tickVol * 1.5);
            stop = s.Direction > 0 ? s.CandidateTurn - buffer : s.CandidateTurn + buffer;
        }
        else
        {
            var recentOpposite = s.Direction > 0 ? MinPriceBack(12, 1) : MaxPriceBack(12, 1);
            var buffer = Math.Max(Symbol.TickSize * 2.0, tickVol * 1.5);
            stop = s.Direction > 0 ? recentOpposite - buffer : recentOpposite + buffer;
        }

        var risk = Math.Abs(entry - stop);
        var minimumRisk = Math.Max(Symbol.TickSize * 6.0, tickVol * 3.0);
        if (risk < minimumRisk)
        {
            risk = minimumRisk;
            stop = s.Direction > 0 ? entry - risk : entry + risk;
        }

        // M1 ATR is safety only. It does not decide whether the fast tick setup exists.
        if (m1Atr > Symbol.TickSize && risk > m1Atr * 1.80)
        {
            _missedNoChase++;
            ResetSetup($"safety stop too wide {risk / m1Atr:F2} M1ATR");
            return;
        }

        var stopPips = risk / Symbol.PipSize;
        var tpPips = stopPips * TargetR;
        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);

        if (volume < Symbol.VolumeInUnitsMin)
        {
            _failedSetups++;
            ResetSetup($"volume {volume} below broker minimum");
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var comment = path == EntryPath.PullbackTurn ? "TICK PULLBACK TURN" : "TICK DIRECT CONTINUATION";
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, comment);
        if (!result.IsSuccessful)
        {
            _failedSetups++;
            Print("NAI TICK | ENTRY REJECTED | {0}", result.Error);
            ResetSetup("broker rejected entry");
            return;
        }

        _entries++;
        if (path == EntryPath.PullbackTurn) _pullbackEntries++; else _directEntries++;
        if (tradeType == TradeType.Buy) _longTrades++; else _shortTrades++;
        _lastStopRequestPrice = null;

        var localDirection = LocalDirection(tickVol);
        Print("NAI TICK | ENTER {0} | path={1} entry={2:F2} SLref={3:F2} risk={4:F1} tickVol TP={5:F2}R | impulse={6:F1} tickVol retrace={7:P0} local={8}",
            tradeType, path, result.Position.EntryPrice, stop, risk / tickVol, TargetR,
            s.ImpulseSize / tickVol, RetraceFraction(s, entry), LocalText(localDirection));

        _setup = null;
        _state = TickState.Searching;
    }

    private void ManageOpenPosition()
    {
        var p = FindPosition();
        if (p == null || !p.StopLoss.HasValue || !p.TakeProfit.HasValue)
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

        if (r >= TrailAtR && _ticks.Count >= 16)
        {
            var tickVol = TickVolatility(Math.Min(LocalDirectionTicks, _ticks.Count - 1));
            var raw = p.TradeType == TradeType.Buy
                ? MinPriceBack(12, 1) - tickVol
                : MaxPriceBack(12, 1) + tickVol;
            TryMoveStop(p, raw, "TICK TRAIL", r);
        }
    }

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
            Print("NAI TICK | {0} SUCCESS | SL->{1:F2} liveR={2:F2}", reason, candidate, liveR);
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.SymbolName != SymbolName || p.Label != Label)
            return;

        _lastCloseTime = Server.Time;
        _lastStopRequestPrice = null;
        ResetSetup("trade closed");

        var intendedRisk = Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        if (p.NetProfit > intendedRisk * 0.15) _wins++;
        else if (p.NetProfit < -intendedRisk * 0.15) _losses++;
        else _scratches++;
        _net += p.NetProfit;

        Print("NAI TICK RESULT | {0} net={1:F2} reason={2} | W/L/S={3}/{4}/{5} totalNet={6:F2}",
            p.TradeType, p.NetProfit, args.Reason, _wins, _losses, _scratches, _net);
        PrintStats("TRADE CLOSED");
    }

    private void ResetSetup(string reason)
    {
        if (_setup != null && reason != "trade closed")
            Print("NAI TICK | RESET | state={0} dir={1} | {2}", _state, _setup.Direction > 0 ? "LONG" : "SHORT", reason);
        _setup = null;
        _state = TickState.Searching;
    }

    private int LocalDirection(double tickVol)
    {
        var back = Math.Min(LocalDirectionTicks, _ticks.Count - 1);
        if (back < 10 || tickVol <= 0)
            return 0;

        var net = PriceFromBack(0) - PriceFromBack(back);
        if (net >= tickVol * 3.0) return 1;
        if (net <= -tickVol * 3.0) return -1;
        return 0;
    }

    private double TickVolatility(int window)
    {
        var n = Math.Min(window, _ticks.Count - 1);
        if (n <= 0)
            return Math.Max(Symbol.TickSize, 0.0000001);

        var from = _ticks.Count - 1 - n;
        var to = _ticks.Count - 1;
        var sum = 0.0;
        var count = 0;
        for (var i = from + 1; i <= to; i++)
        {
            sum += Math.Abs(_ticks[i].Price - _ticks[i - 1].Price);
            count++;
        }

        return Math.Max(Symbol.TickSize, count == 0 ? Symbol.TickSize : sum / count);
    }

    private double PathDistance(int from, int to)
    {
        var path = 0.0;
        for (var i = from + 1; i <= to; i++)
            path += Math.Abs(_ticks[i].Price - _ticks[i - 1].Price);
        return path;
    }

    private double RetraceFraction(TickSetup s, double price)
    {
        if (s.ImpulseSize <= Symbol.TickSize)
            return 0;
        return s.Direction > 0
            ? Math.Max(0, (s.Extreme - price) / s.ImpulseSize)
            : Math.Max(0, (price - s.Extreme) / s.ImpulseSize);
    }

    private double PriceFromBack(int back)
    {
        var index = Math.Max(0, _ticks.Count - 1 - back);
        return _ticks[index].Price;
    }

    private double MaxPriceBack(int backFrom, int backTo)
    {
        var newest = Math.Max(0, _ticks.Count - 1 - backTo);
        var oldest = Math.Max(0, _ticks.Count - 1 - backFrom);
        if (oldest > newest)
            (oldest, newest) = (newest, oldest);
        var max = double.MinValue;
        for (var i = oldest; i <= newest; i++) max = Math.Max(max, _ticks[i].Price);
        return max;
    }

    private double MinPriceBack(int backFrom, int backTo)
    {
        var newest = Math.Max(0, _ticks.Count - 1 - backTo);
        var oldest = Math.Max(0, _ticks.Count - 1 - backFrom);
        if (oldest > newest)
            (oldest, newest) = (newest, oldest);
        var min = double.MaxValue;
        for (var i = oldest; i <= newest; i++) min = Math.Min(min, _ticks[i].Price);
        return min;
    }

    private double MaxPriceRange(int from, int to)
    {
        var max = double.MinValue;
        for (var i = from; i <= to; i++) max = Math.Max(max, _ticks[i].Price);
        return max;
    }

    private double MinPriceRange(int from, int to)
    {
        var min = double.MaxValue;
        for (var i = from; i <= to; i++) min = Math.Min(min, _ticks[i].Price);
        return min;
    }

    private double Atr(int i)
    {
        var from = Math.Max(1, i - AtrPeriod + 1);
        double total = 0;
        var count = 0;
        for (var k = from; k <= i; k++)
        {
            var tr = Math.Max(_m1.HighPrices[k] - _m1.LowPrices[k],
                Math.Max(Math.Abs(_m1.HighPrices[k] - _m1.ClosePrices[k - 1]), Math.Abs(_m1.LowPrices[k] - _m1.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private void ResetDailyAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay)
            return;
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        _lastCloseTime = DateTime.MinValue;
        ResetSetup("new day");
        Print("NAI TICK | NEW DAY | equity anchor={0:F2}", _dayStartEquity);
    }

    private bool HitDailyStop()
    {
        if (_dayStartEquity <= 0)
            return false;
        var dd = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (dd < DailyEquityStopPercent)
            return false;

        _halted = true;
        var p = FindPosition();
        if (p != null)
            ClosePosition(p);
        Print("NAI TICK HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
        PrintStats("DAILY STOP");
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

    private string LocalText(int direction) => direction > 0 ? "UP" : direction < 0 ? "DOWN" : "NEUTRAL";

    private void PrintStats(string trigger)
    {
        Print("=== NAI TICK SNIPER V2 STATS | {0} ===", trigger);
        Print("STATES | impulses={0} pullbacks={1} turns={2} entries={3} failed={4} noChase={5}", _impulses, _pullbacks, _turns, _entries, _failedSetups, _missedNoChase);
        Print("ENTRY PATHS | direct={0} pullbackTurn={1}", _directEntries, _pullbackEntries);
        Print("TRADES | long={0} short={1} | W={2} L={3} scratch={4} | net={5:F2}", _longTrades, _shortTrades, _wins, _losses, _scratches, _net);
        Print("=== END NAI TICK SNIPER V2 STATS ===");
    }

    private enum TickState
    {
        Searching,
        ImpulseFound,
        Pullback,
        ConfirmingTurn,
        ConfirmingDirect
    }

    private enum EntryPath
    {
        PullbackTurn,
        DirectContinuation
    }

    private sealed record TickPoint(DateTime Time, double Price);

    private sealed class TickSetup
    {
        public TickSetup(int direction, double basePrice, double extreme, double impulseSize, double tickVol, DateTime createdAt, int localDirection)
        {
            Direction = direction;
            Base = basePrice;
            Extreme = extreme;
            DetectionExtreme = extreme;
            ImpulseSize = impulseSize;
            TickVolAtImpulse = tickVol;
            CreatedAt = createdAt;
            LocalDirectionAtImpulse = localDirection;
            CandidateTurn = extreme;
            LastDirectPrice = extreme;
        }

        public int Direction { get; }
        public double Base { get; }
        public double Extreme { get; set; }
        public double DetectionExtreme { get; }
        public double ImpulseSize { get; set; }
        public double TickVolAtImpulse { get; }
        public DateTime CreatedAt { get; }
        public int LocalDirectionAtImpulse { get; }
        public DateTime PullbackStartedAt { get; set; }
        public double CandidateTurn { get; set; }
        public int TurnConfirmTicks { get; set; }
        public double LastTurnConfirmPrice { get; set; }
        public int DirectConfirmTicks { get; set; }
        public double LastDirectPrice { get; set; }
    }
}
