using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiTickSniperV1 : Robot
{
    private const string Label = "NAI-TICK-SNIPER-V1";
    private const string RequiredSymbolText = "Volatility 25 (1s)";
    private const int MaxTickHistory = 160;

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

    [Parameter("Impulse Window Ticks", DefaultValue = 30, MinValue = 15, MaxValue = 80)]
    public int ImpulseWindowTicks { get; set; }

    [Parameter("Impulse Min ATR", DefaultValue = 0.22, MinValue = 0.10, MaxValue = 0.80, Step = 0.01)]
    public double ImpulseMinAtr { get; set; }

    [Parameter("Impulse Min Efficiency", DefaultValue = 0.58, MinValue = 0.30, MaxValue = 0.90, Step = 0.01)]
    public double ImpulseMinEfficiency { get; set; }

    [Parameter("Pullback Min %", DefaultValue = 0.14, MinValue = 0.05, MaxValue = 0.40, Step = 0.01)]
    public double PullbackMinFraction { get; set; }

    [Parameter("Pullback Max %", DefaultValue = 0.58, MinValue = 0.30, MaxValue = 0.85, Step = 0.01)]
    public double PullbackMaxFraction { get; set; }

    [Parameter("Confirm Advancing Ticks", DefaultValue = 3, MinValue = 1, MaxValue = 6)]
    public int ConfirmAdvancingTicks { get; set; }

    [Parameter("Max Chase ATR", DefaultValue = 0.16, MinValue = 0.05, MaxValue = 0.50, Step = 0.01)]
    public double MaxChaseAtr { get; set; }

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
            Print("NAI TICK SNIPER V1 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI TICK SNIPER V1 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        Positions.Closed += OnPositionClosed;

        Print("NAI TICK SNIPER V1 STARTED | {0} | DEMO", SymbolName);
        Print("ENTRY BRAIN | TICK-NATIVE | impulse -> pullback -> turn -> micro-break -> {0} advancing ticks -> entry", ConfirmAdvancingTicks);
        Print("M1 ROLE | ATR scale + logging only | M1 does NOT choose direction or grant permission");
        Print("RISK | {0:F2}% | TP={1:F2}R | BE={2:F2}R | TRAIL={3:F2}R | cooldown={4}s", RiskPercent, TargetR, BreakEvenAtR, TrailAtR, CooldownSeconds);
        Print("TICK PARAMETERS | impulse={0} ticks minMove={1:F2}ATR eff>={2:F2} pullback={3:P0}-{4:P0} maxChase={5:F2}ATR",
            ImpulseWindowTicks, ImpulseMinAtr, ImpulseMinEfficiency, PullbackMinFraction, PullbackMaxFraction, MaxChaseAtr);
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

        if (_m1 == null || _m1.Count < Math.Max(20, AtrPeriod + 3) || _ticks.Count < Math.Max(ImpulseWindowTicks + 5, 40))
            return;

        var atr = Atr(_m1.Count - 2);
        if (atr <= Symbol.TickSize * 5)
            return;

        AdvanceStateMachine(mid, atr);
    }

    private void AddTick(double price)
    {
        _ticks.Add(new TickPoint(Server.Time, price));
        if (_ticks.Count > MaxTickHistory)
            _ticks.RemoveAt(0);
    }

    private void AdvanceStateMachine(double price, double atr)
    {
        switch (_state)
        {
            case TickState.Searching:
                TryFindImpulse(atr);
                break;
            case TickState.ImpulseFound:
                TrackImpulseOrPullback(price, atr);
                break;
            case TickState.Pullback:
                TrackPullbackAndTurn(price, atr);
                break;
            case TickState.TurnDetected:
            case TickState.Confirming:
                TrackBreakAndConfirmation(price, atr);
                break;
        }
    }

    private void TryFindImpulse(double atr)
    {
        var n = Math.Min(ImpulseWindowTicks, _ticks.Count - 1);
        if (n < 10)
            return;

        var from = _ticks.Count - 1 - n;
        var to = _ticks.Count - 1;
        var start = _ticks[from].Price;
        var end = _ticks[to].Price;
        var net = end - start;
        var absNet = Math.Abs(net);
        var path = 0.0;
        for (var i = from + 1; i <= to; i++)
            path += Math.Abs(_ticks[i].Price - _ticks[i - 1].Price);

        if (path <= Symbol.TickSize)
            return;

        var efficiency = absNet / path;
        var moveAtr = absNet / atr;
        if (moveAtr < ImpulseMinAtr || efficiency < ImpulseMinEfficiency)
            return;

        var direction = net > 0 ? 1 : -1;
        var windowMin = _ticks.Skip(from).Take(n + 1).Min(t => t.Price);
        var windowMax = _ticks.Skip(from).Take(n + 1).Max(t => t.Price);
        var nearExtreme = direction > 0
            ? (windowMax - end) <= atr * 0.05
            : (end - windowMin) <= atr * 0.05;
        if (!nearExtreme)
            return;

        var basePrice = direction > 0 ? windowMin : windowMax;
        var extreme = direction > 0 ? windowMax : windowMin;
        var impulseSize = Math.Abs(extreme - basePrice);
        if (impulseSize < atr * ImpulseMinAtr)
            return;

        _setup = new TickSetup(direction, basePrice, extreme, impulseSize, atr, Server.Time);
        _state = TickState.ImpulseFound;
        _impulses++;

        Print("NAI TICK | IMPULSE {0} | size={1:F2}ATR eff={2:F2} base={3:F2} extreme={4:F2}",
            direction > 0 ? "UP" : "DOWN", impulseSize / atr, efficiency, basePrice, extreme);
    }

    private void TrackImpulseOrPullback(double price, double atr)
    {
        var s = _setup;
        if (s == null)
        {
            ResetSetup("missing setup");
            return;
        }

        if (s.Direction > 0 && price > s.Extreme)
        {
            s.Extreme = price;
            s.ImpulseSize = Math.Abs(s.Extreme - s.Base);
            return;
        }
        if (s.Direction < 0 && price < s.Extreme)
        {
            s.Extreme = price;
            s.ImpulseSize = Math.Abs(s.Extreme - s.Base);
            return;
        }

        var retrace = RetraceFraction(s, price);
        if (retrace > PullbackMaxFraction + 0.12)
        {
            _failedSetups++;
            ResetSetup($"impulse retraced too deeply {retrace:P0}");
            return;
        }

        if (retrace < PullbackMinFraction)
            return;

        if (retrace > PullbackMaxFraction)
            return;

        s.CandidateTurn = price;
        s.PullbackStartedAt = Server.Time;
        s.BreakSeen = false;
        s.ConfirmTicks = 0;
        _state = TickState.Pullback;
        _pullbacks++;

        Print("NAI TICK | PULLBACK {0} | retrace={1:P0} candidate={2:F2}",
            s.Direction > 0 ? "LONG" : "SHORT", retrace, price);
    }

    private void TrackPullbackAndTurn(double price, double atr)
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
        if (retrace > PullbackMaxFraction + 0.12 || BrokeImpulseBase(s, price, atr))
        {
            _failedSetups++;
            ResetSetup($"pullback failed retrace={retrace:P0}");
            return;
        }

        if (_ticks.Count < 10)
            return;

        var recentNet = PriceFromBack(0) - PriceFromBack(4);
        var previousNet = PriceFromBack(4) - PriceFromBack(8);
        var minTurnMove = Math.Max(Symbol.TickSize * 2.0, atr * 0.02);

        var turned = s.Direction > 0
            ? recentNet >= minTurnMove && recentNet > previousNet
            : recentNet <= -minTurnMove && recentNet < previousNet;
        if (!turned)
            return;

        s.MicroBreak = s.Direction > 0
            ? MaxPriceBack(6, 1)
            : MinPriceBack(6, 1);
        s.BreakSeen = false;
        s.ConfirmTicks = 0;
        s.LastConfirmPrice = 0;
        _state = TickState.TurnDetected;
        _turns++;

        Print("NAI TICK | TURN {0} | candidate={1:F2} microBreak={2:F2} recent4={3:F2}ATR prev4={4:F2}ATR",
            s.Direction > 0 ? "UP" : "DOWN", s.CandidateTurn, s.MicroBreak, recentNet / atr, previousNet / atr);
    }

    private void TrackBreakAndConfirmation(double price, double atr)
    {
        var s = _setup;
        if (s == null)
        {
            ResetSetup("missing confirmation setup");
            return;
        }

        var retrace = RetraceFraction(s, price);
        if (retrace > PullbackMaxFraction + 0.12 || BrokeImpulseBase(s, price, atr))
        {
            _failedSetups++;
            ResetSetup("structure failed before entry");
            return;
        }

        var crossed = s.Direction > 0
            ? price >= s.MicroBreak + Symbol.TickSize
            : price <= s.MicroBreak - Symbol.TickSize;

        if (!s.BreakSeen)
        {
            if (!crossed)
            {
                if (s.Direction > 0)
                    s.CandidateTurn = Math.Min(s.CandidateTurn, price);
                else
                    s.CandidateTurn = Math.Max(s.CandidateTurn, price);
                return;
            }

            s.BreakSeen = true;
            s.ConfirmTicks = 1;
            s.LastConfirmPrice = price;
            _state = TickState.Confirming;
            Print("NAI TICK | MICRO BREAK {0} | price={1:F2} level={2:F2} | confirm=1/{3}",
                s.Direction > 0 ? "LONG" : "SHORT", price, s.MicroBreak, ConfirmAdvancingTicks);
            return;
        }

        var failedBreak = s.Direction > 0
            ? price < s.MicroBreak - Symbol.TickSize
            : price > s.MicroBreak + Symbol.TickSize;
        if (failedBreak)
        {
            s.BreakSeen = false;
            s.ConfirmTicks = 0;
            s.LastConfirmPrice = 0;
            _state = TickState.Pullback;
            Print("NAI TICK | BREAK FAILED | back into pullback");
            return;
        }

        var advanced = s.Direction > 0
            ? price > s.LastConfirmPrice + Symbol.TickSize * 0.25
            : price < s.LastConfirmPrice - Symbol.TickSize * 0.25;
        if (advanced)
        {
            s.ConfirmTicks++;
            s.LastConfirmPrice = price;
        }

        if (s.ConfirmTicks < ConfirmAdvancingTicks)
            return;

        var beyondBreakAtr = s.Direction > 0
            ? (price - s.MicroBreak) / atr
            : (s.MicroBreak - price) / atr;
        if (beyondBreakAtr > MaxChaseAtr)
        {
            _missedNoChase++;
            ResetSetup($"missed/no-chase {beyondBreakAtr:F2}ATR beyond micro-break");
            return;
        }

        ExecuteTickEntry(s, atr);
    }

    private void ExecuteTickEntry(TickSetup s, double atr)
    {
        var tradeType = s.Direction > 0 ? TradeType.Buy : TradeType.Sell;
        var entry = s.Direction > 0 ? Symbol.Ask : Symbol.Bid;
        var buffer = Math.Max(Symbol.TickSize * 2.0, atr * 0.08);
        var stop = s.Direction > 0 ? s.CandidateTurn - buffer : s.CandidateTurn + buffer;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.30)
        {
            risk = atr * 0.35;
            stop = s.Direction > 0 ? entry - risk : entry + risk;
        }

        if (risk > atr * 1.20)
        {
            _missedNoChase++;
            ResetSetup($"risk too wide {risk / atr:F2}ATR");
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
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, "TICK PULLBACK SNIPER");
        if (!result.IsSuccessful)
        {
            _failedSetups++;
            Print("NAI TICK | ENTRY REJECTED | {0}", result.Error);
            ResetSetup("broker rejected entry");
            return;
        }

        _entries++;
        if (tradeType == TradeType.Buy) _longTrades++; else _shortTrades++;
        _lastStopRequestPrice = null;

        var m1i = _m1.Count - 2;
        var m1Move3 = m1i >= 3 ? (_m1.ClosePrices[m1i] - _m1.ClosePrices[m1i - 3]) / atr : 0;
        Print("NAI TICK | ENTER {0} | entry={1:F2} candidateTurn={2:F2} SLref={3:F2} risk={4:F2}ATR TP={5:F2}R | impulse={6:F2}ATR retrace={7:P0} microBreak={8:F2} confirms={9} | M1move3={10:F2}ATR",
            tradeType, result.Position.EntryPrice, s.CandidateTurn, stop, risk / atr, TargetR,
            s.ImpulseSize / atr, RetraceFraction(s, entry), s.MicroBreak, s.ConfirmTicks, m1Move3);

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
            var atr = _m1.Count > AtrPeriod + 3 ? Atr(_m1.Count - 2) : originalRisk;
            var raw = p.TradeType == TradeType.Buy
                ? MinPriceBack(12, 1) - atr * 0.04
                : MaxPriceBack(12, 1) + atr * 0.04;
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

    private bool BrokeImpulseBase(TickSetup s, double price, double atr)
    {
        var buffer = atr * 0.04;
        return s.Direction > 0 ? price < s.Base - buffer : price > s.Base + buffer;
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

    private void PrintStats(string trigger)
    {
        Print("=== NAI TICK SNIPER V1 STATS | {0} ===", trigger);
        Print("STATES | impulses={0} pullbacks={1} turns={2} entries={3} failed={4} noChase={5}", _impulses, _pullbacks, _turns, _entries, _failedSetups, _missedNoChase);
        Print("TRADES | long={0} short={1} | W={2} L={3} scratch={4} | net={5:F2}", _longTrades, _shortTrades, _wins, _losses, _scratches, _net);
        Print("=== END NAI TICK SNIPER V1 STATS ===");
    }

    private enum TickState
    {
        Searching,
        ImpulseFound,
        Pullback,
        TurnDetected,
        Confirming
    }

    private sealed record TickPoint(DateTime Time, double Price);

    private sealed class TickSetup
    {
        public TickSetup(int direction, double basePrice, double extreme, double impulseSize, double atr, DateTime createdAt)
        {
            Direction = direction;
            Base = basePrice;
            Extreme = extreme;
            ImpulseSize = impulseSize;
            AtrAtImpulse = atr;
            CreatedAt = createdAt;
            CandidateTurn = extreme;
        }

        public int Direction { get; }
        public double Base { get; }
        public double Extreme { get; set; }
        public double ImpulseSize { get; set; }
        public double AtrAtImpulse { get; }
        public DateTime CreatedAt { get; }
        public DateTime PullbackStartedAt { get; set; }
        public double CandidateTurn { get; set; }
        public double MicroBreak { get; set; }
        public bool BreakSeen { get; set; }
        public int ConfirmTicks { get; set; }
        public double LastConfirmPrice { get; set; }
    }
}
