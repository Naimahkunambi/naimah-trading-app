using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiMountainDecisionV1 : Robot
{
    private const string Label = "NAI-MOUNTAIN-V1";
    private const string RequiredSymbolText = "Volatility 25 (1s)";
    private const int MaxTickBuffer = 240;

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

    [Parameter("Max Chase ATR", DefaultValue = 0.24, MinValue = 0.08, MaxValue = 0.60, Step = 0.02)]
    public double MaxChaseAtr { get; set; }

    [Parameter("Early Validation Bars", DefaultValue = 3, MinValue = 2, MaxValue = 6)]
    public int EarlyValidationBars { get; set; }

    [Parameter("Early Emergency R", DefaultValue = 0.45, MinValue = 0.25, MaxValue = 0.80, Step = 0.05)]
    public double EarlyEmergencyR { get; set; }

    private Bars _m1 = null!;
    private Bars _m5 = null!;
    private Bars _m15 = null!;

    private DateTime _lastM1Open = DateTime.MinValue;
    private DateTime _lastM5Open = DateTime.MinValue;
    private DateTime _lastM15Open = DateTime.MinValue;
    private DateTime _summaryHour = DateTime.MinValue;

    private double _dayStartEquity;
    private DateTime _equityDay;
    private bool _halted;
    private int _lastEntryM1Index = -10000;
    private double? _lastStopRequestPrice;

    private readonly Queue<int> _m5Trajectory = new();
    private readonly Queue<int> _m15Trajectory = new();
    private readonly Queue<int> _m1Trajectory = new();
    private readonly List<TickPoint> _ticks = new();

    private MountainSnapshot _mountain = MountainSnapshot.Neutral;
    private TickMountainState? _tickMountain;
    private SetupPlan? _armedPlan;
    private DateTime _armedAt = DateTime.MinValue;
    private TradeMeta? _activeMeta;

    private readonly Dictionary<string, BucketStats> _sessionMemory = new();
    private readonly HashSet<string> _blockedEarlyBuckets = new();

    private int _hourDecisions;
    private int _hourLongDecisions;
    private int _hourShortDecisions;
    private int _hourWaits;
    private int _hourSkips;
    private int _hourEntries;
    private int _hourWins;
    private int _hourLosses;
    private int _hourScratch;
    private int _hourLongTrades;
    private int _hourShortTrades;
    private double _hourNet;
    private int _hourBullForecasts;
    private int _hourBearForecasts;
    private int _hourForecastConfirmed;
    private int _hourForecastFailed;
    private int _hourEarlyEntries;
    private int _hourEarlyConfirmed;
    private int _hourEarlyFailed;
    private int _hourLateSkips;
    private readonly Dictionary<string, int> _hourRejectReasons = new();

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI MOUNTAIN V1 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI MOUNTAIN V1 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _m5 = MarketData.GetBars(TimeFrame.Minute5, SymbolName);
        _m15 = MarketData.GetBars(TimeFrame.Minute15, SymbolName);

        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;
        _summaryHour = FloorToHour(Server.Time);

        Positions.Closed += OnPositionClosed;
        SeedTrajectory();
        RefreshMountain(force: true);

        Print("NAI MOUNTAIN DECISION V1 STARTED | {0} | DEMO | TRUE TICK MOUNTAIN ENTRY", SymbolName);
        Print("ENTRY ENGINE | rolling ticks -> impulse -> pullback -> turn -> micro-retest -> break -> acceleration -> entry");
        Print("M15/M5 CONTEXT ONLY | scores cannot manufacture an entry and cannot close a valid tick entry after execution");
        Print("ENTRY WARMUP | collecting live ticks; first mountain scan begins after 40 ticks");
        Print("RISK | {0:F2}% | target={1:F2}R | BE={2:F2}R | trail={3:F2}R", RiskPercent, TargetR, BreakEvenAtR, TrailAtR);
        Print("SESSION MEMORY | tracks direction+stage+setup; weak early buckets can be blocked after repeated evidence");
        Print("HOURLY SUMMARY ON | screenshot block beginning '=== NAI MOUNTAIN HOURLY ==='");
    }

    protected override void OnStop()
    {
        Positions.Closed -= OnPositionClosed;
        if (_summaryHour != DateTime.MinValue)
            PrintHourlySummary("BOT STOP");
    }

    protected override void OnTick()
    {
        if (_halted || Account.IsLive)
            return;

        AddLiveTick();
        ResetDailyAnchorIfNeeded();
        if (HitDailyStop())
            return;

        CheckHourlyBoundary();
        RefreshMountain(force: false);
        ManageOpenPositionFast();
        ProcessNewM1IfNeeded();

        if (FindPosition() != null)
            return;

        if (!InCooldown())
            AdvanceTrueTickMountain();
        else
            ResetTickMountain("cooldown", false);

        TryExecuteArmedPlan();
    }

    private void AddLiveTick()
    {
        var mid = (Symbol.Bid + Symbol.Ask) / 2.0;
        if (_ticks.Count > 0 && Math.Abs(_ticks[_ticks.Count - 1].Price - mid) < Symbol.TickSize * 0.25)
            return;

        _ticks.Add(new TickPoint(Server.Time, mid));
        while (_ticks.Count > MaxTickBuffer)
            _ticks.RemoveAt(0);
    }

    private void SeedTrajectory()
    {
        for (var offset = 3; offset >= 1; offset--)
        {
            var i5 = Math.Max(20, _m5.Count - 1 - offset);
            var i15 = Math.Max(20, _m15.Count - 1 - offset);
            if (i5 < _m5.Count) Push(_m5Trajectory, ContextScore(_m5, i5), 5);
            if (i15 < _m15.Count) Push(_m15Trajectory, ContextScore(_m15, i15), 5);
        }
    }

    private void RefreshMountain(bool force)
    {
        if (_m5.Count < 30 || _m15.Count < 30 || _m1.Count < 45)
            return;

        var m5Open = _m5.OpenTimes[_m5.Count - 1];
        var m15Open = _m15.OpenTimes[_m15.Count - 1];
        var changed5 = m5Open != _lastM5Open;
        var changed15 = m15Open != _lastM15Open;

        if (!force && !changed5 && !changed15)
            return;

        if (changed5)
        {
            _lastM5Open = m5Open;
            Push(_m5Trajectory, ContextScore(_m5, _m5.Count - 2), 5);
        }

        if (changed15)
        {
            _lastM15Open = m15Open;
            Push(_m15Trajectory, ContextScore(_m15, _m15.Count - 2), 5);
        }

        _mountain = BuildMountainSnapshot();
        PrintMountainContext("HTF UPDATE");

        if (_tickMountain != null && HasStrongOppositeContext(_tickMountain.Direction))
            ResetTickMountain("strong opposite HTF veto", true);

        if (_armedPlan != null && HasStrongOppositeContext(_armedPlan.Direction))
        {
            RegisterSkip("HTF veto before execution");
            Print("NAI ENTRY | CANCEL ARMED {0} | strong opposite context", _armedPlan.Direction);
            _armedPlan = null;
        }
    }

    private MountainSnapshot BuildMountainSnapshot()
    {
        var s5 = Last(_m5Trajectory);
        var s15 = Last(_m15Trajectory);
        var d5 = Delta(_m5Trajectory);
        var d15 = Delta(_m15Trajectory);
        var i1 = _m1.Count - 2;
        var s1 = ContextScore(_m1, i1);
        var atr1 = Atr(_m1, i1);
        var fast = AverageClose(_m1, i1 - 5, i1);
        var extension = atr1 > 0 ? Math.Abs(_m1.ClosePrices[i1] - fast) / atr1 : 0;
        var efficiency = Efficiency(_m1, i1 - 6, i1);

        var bull = 0;
        var bear = 0;
        if (s15 >= 1) bull += 2; else if (s15 <= -1) bear += 2;
        if (s5 >= 1) bull += 2; else if (s5 <= -1) bear += 2;
        if (s1 >= 2) bull += 2; else if (s1 <= -2) bear += 2;
        if (d15 > 0) bull += 2; else if (d15 < 0) bear += 2;
        if (d5 > 0) bull += 2; else if (d5 < 0) bear += 2;

        DirectionChoice direction;
        var strength = Math.Max(bull, bear);
        if (bull >= bear + 2 && bull >= 5) direction = DirectionChoice.Long;
        else if (bear >= bull + 2 && bear >= 5) direction = DirectionChoice.Short;
        else direction = DirectionChoice.None;

        MountainStage stage;
        var accelerating = direction == DirectionChoice.Long ? d5 > 0 || d15 > 0 : direction == DirectionChoice.Short ? d5 < 0 || d15 < 0 : false;
        var aligned = direction == DirectionChoice.Long ? s15 >= 2 && s5 >= 2 && s1 >= 2 : direction == DirectionChoice.Short ? s15 <= -2 && s5 <= -2 && s1 <= -2 : false;
        var oppositeM1 = direction == DirectionChoice.Long ? s1 <= -2 : direction == DirectionChoice.Short ? s1 >= 2 : false;

        if (direction == DirectionChoice.None) stage = MountainStage.Base;
        else if (oppositeM1 && !accelerating) stage = MountainStage.Failing;
        else if (extension >= 1.05 || (aligned && !accelerating && efficiency < 0.50)) stage = MountainStage.Mature;
        else if (aligned && (extension >= 0.35 || efficiency >= 0.55)) stage = MountainStage.Climbing;
        else stage = MountainStage.Forming;

        var reason = $"M15={s15} d15={d15:+#;-#;0} | M5={s5} d5={d5:+#;-#;0} | M1={s1} | ext={extension:F2}ATR eff={efficiency:F2}";
        return new MountainSnapshot(direction, stage, strength, s15, s5, s1, d15, d5, extension, efficiency, reason);
    }

    private void ProcessNewM1IfNeeded()
    {
        if (_m1.Count < 45)
            return;

        var liveOpen = _m1.OpenTimes[_m1.Count - 1];
        if (liveOpen == _lastM1Open)
            return;

        _lastM1Open = liveOpen;
        var i = _m1.Count - 2;
        Push(_m1Trajectory, ContextScore(_m1, i), 8);
        _mountain = BuildMountainSnapshot();
        _hourDecisions++;

        if (FindPosition() == null && _tickMountain == null && _armedPlan == null)
            RegisterWait(_ticks.Count < 40 ? "tick warmup" : "tick mountain searching");
    }

    private bool InCooldown()
    {
        if (_m1.Count < 3)
            return true;
        return (_m1.Count - 2) - _lastEntryM1Index < CooldownBars;
    }

    private void AdvanceTrueTickMountain()
    {
        if (_ticks.Count < 40 || _armedPlan != null)
            return;

        var atr = Atr(_m1, _m1.Count - 2);
        if (atr <= Symbol.TickSize * 5)
            return;

        if (_tickMountain == null)
        {
            var impulse = FindBestTickImpulse(atr);
            if (impulse == null)
                return;

            if (HasStrongOppositeContext(impulse.Direction))
                return;

            var bucket = BucketKey(impulse.Direction, MountainStage.Forming, "TICK_MOUNTAIN");
            if (_blockedEarlyBuckets.Contains(bucket))
                return;

            _tickMountain = new TickMountainState
            {
                Direction = impulse.Direction,
                Phase = TickPhase.Pullback,
                CreatedAt = Server.Time,
                Base = impulse.Base,
                Extreme = impulse.Extreme,
                ImpulseDistance = Math.Abs(impulse.Extreme - impulse.Base),
                ImpulseAtr = impulse.ImpulseAtr,
                Atr = atr,
                CandidateTurn = impulse.Extreme,
                CandidateTurnIndex = _ticks.Count - 1,
                PullbackStartIndex = -1,
                Bucket = bucket
            };

            if (impulse.Direction == DirectionChoice.Long) _hourBullForecasts++; else _hourBearForecasts++;
            Print("NAI TICK MOUNTAIN | IMPULSE {0} | {1:F2}ATR | base={2:F2} extreme={3:F2} | waiting pullback", impulse.Direction, impulse.ImpulseAtr, impulse.Base, impulse.Extreme);
            return;
        }

        var state = _tickMountain;
        if ((Server.Time - state.CreatedAt).TotalMinutes > 3.5)
        {
            ResetTickMountain("setup expired", true);
            return;
        }

        if (HasStrongOppositeContext(state.Direction))
        {
            ResetTickMountain("HTF veto", true);
            return;
        }

        var price = _ticks[_ticks.Count - 1].Price;

        if (state.Phase == TickPhase.Pullback)
        {
            AdvancePullback(state, price, atr);
            return;
        }

        if (state.Phase == TickPhase.Rebound)
        {
            AdvanceRebound(state, price, atr);
            return;
        }

        if (state.Phase == TickPhase.AwaitBreak)
            AdvanceBreakAndAcceleration(state, price, atr);
    }

    private TickImpulse? FindBestTickImpulse(double atr)
    {
        TickImpulse? best = null;
        var n = _ticks.Count;

        for (var length = 12; length <= 36; length += 4)
        {
            if (n < length + 2)
                continue;

            var from = n - length;
            var to = n - 1;

            var minIndex = IndexOfMinTick(from, to);
            var maxIndex = IndexOfMaxTick(from, to);

            if (minIndex < maxIndex && maxIndex >= to - 4)
            {
                var distance = _ticks[maxIndex].Price - _ticks[minIndex].Price;
                var efficiency = TickEfficiency(minIndex, maxIndex);
                var ratio = DirectionalTickRatio(minIndex, maxIndex, DirectionChoice.Long);
                var impulseAtr = distance / atr;
                if (impulseAtr >= 0.42 && impulseAtr <= 1.45 && efficiency >= 0.58 && ratio >= 0.58)
                {
                    var candidate = new TickImpulse(DirectionChoice.Long, _ticks[minIndex].Price, _ticks[maxIndex].Price, impulseAtr, efficiency, ratio);
                    if (best == null || ImpulseQuality(candidate) > ImpulseQuality(best)) best = candidate;
                }
            }

            if (maxIndex < minIndex && minIndex >= to - 4)
            {
                var distance = _ticks[maxIndex].Price - _ticks[minIndex].Price;
                var efficiency = TickEfficiency(maxIndex, minIndex);
                var ratio = DirectionalTickRatio(maxIndex, minIndex, DirectionChoice.Short);
                var impulseAtr = distance / atr;
                if (impulseAtr >= 0.42 && impulseAtr <= 1.45 && efficiency >= 0.58 && ratio >= 0.58)
                {
                    var candidate = new TickImpulse(DirectionChoice.Short, _ticks[maxIndex].Price, _ticks[minIndex].Price, impulseAtr, efficiency, ratio);
                    if (best == null || ImpulseQuality(candidate) > ImpulseQuality(best)) best = candidate;
                }
            }
        }

        return best;
    }

    private static double ImpulseQuality(TickImpulse x) => x.ImpulseAtr * x.Efficiency * x.DirectionalRatio;

    private void AdvancePullback(TickMountainState state, double price, double atr)
    {
        if (state.Direction == DirectionChoice.Long && price > state.Extreme)
        {
            state.Extreme = price;
            state.ImpulseDistance = state.Extreme - state.Base;
            state.CandidateTurn = price;
            state.CandidateTurnIndex = _ticks.Count - 1;
            state.PullbackStartIndex = -1;
            return;
        }

        if (state.Direction == DirectionChoice.Short && price < state.Extreme)
        {
            state.Extreme = price;
            state.ImpulseDistance = state.Base - state.Extreme;
            state.CandidateTurn = price;
            state.CandidateTurnIndex = _ticks.Count - 1;
            state.PullbackStartIndex = -1;
            return;
        }

        var retrace = state.Direction == DirectionChoice.Long
            ? (state.Extreme - price) / state.ImpulseDistance
            : (price - state.Extreme) / state.ImpulseDistance;

        if (state.PullbackStartIndex < 0 && retrace >= 0.08)
            state.PullbackStartIndex = _ticks.Count - 1;

        if (state.Direction == DirectionChoice.Long && price < state.CandidateTurn)
        {
            state.CandidateTurn = price;
            state.CandidateTurnIndex = _ticks.Count - 1;
        }
        else if (state.Direction == DirectionChoice.Short && price > state.CandidateTurn)
        {
            state.CandidateTurn = price;
            state.CandidateTurnIndex = _ticks.Count - 1;
        }

        var baseBroken = state.Direction == DirectionChoice.Long
            ? price <= state.Base + atr * 0.03
            : price >= state.Base - atr * 0.03;

        if (baseBroken || retrace > 0.60)
        {
            ResetTickMountain(baseBroken ? "impulse base broken" : "pullback too deep", true);
            return;
        }

        if (retrace < 0.14 || retrace > 0.55 || state.PullbackStartIndex < 0)
            return;

        if (!DetectTickTurn(state.Direction, state.CandidateTurnIndex, atr, out var ratio, out var net, out var reboundVelocity))
            return;

        state.RetraceFraction = retrace;
        state.PullbackVelocity = PullbackVelocity(state.PullbackStartIndex, state.CandidateTurnIndex);
        state.ReboundPivot = price;
        state.ReboundVelocity = reboundVelocity;
        state.Phase = TickPhase.Rebound;

        Print("NAI TICK MOUNTAIN | TURN {0} | retrace={1:P0} turn={2:F2} tickRatio={3:P0} rebound={4:F2}ATR | waiting micro-retest", state.Direction, retrace, state.CandidateTurn, ratio, Math.Abs(net) / atr);
    }

    private bool DetectTickTurn(DirectionChoice direction, int turnIndex, double atr, out double ratio, out double net, out double velocity)
    {
        ratio = 0;
        net = 0;
        velocity = 0;

        var end = _ticks.Count - 1;
        if (turnIndex < 0 || end - turnIndex < 4)
            return false;

        var from = Math.Max(turnIndex, end - 7);
        net = _ticks[end].Price - _ticks[from].Price;
        var directionalNet = direction == DirectionChoice.Long ? net : -net;
        ratio = DirectionalTickRatio(from, end, direction);
        velocity = Math.Abs(net) / Math.Max(1, end - from);

        var awayFromTurn = direction == DirectionChoice.Long
            ? _ticks[end].Price - _ticks[turnIndex].Price
            : _ticks[turnIndex].Price - _ticks[end].Price;

        return directionalNet >= atr * 0.035 && awayFromTurn >= atr * 0.045 && ratio >= 0.60;
    }

    private void AdvanceRebound(TickMountainState state, double price, double atr)
    {
        if (state.Direction == DirectionChoice.Long)
        {
            if (price > state.ReboundPivot)
            {
                state.ReboundPivot = price;
                return;
            }

            if (price <= state.CandidateTurn - atr * 0.02)
            {
                ResetTickMountain("turn failed before break", true);
                return;
            }

            var microRetest = state.ReboundPivot - price;
            if (microRetest < Math.Max(atr * 0.015, Symbol.TickSize * 2.0))
                return;
        }
        else
        {
            if (price < state.ReboundPivot)
            {
                state.ReboundPivot = price;
                return;
            }

            if (price >= state.CandidateTurn + atr * 0.02)
            {
                ResetTickMountain("turn failed before break", true);
                return;
            }

            var microRetest = price - state.ReboundPivot;
            if (microRetest < Math.Max(atr * 0.015, Symbol.TickSize * 2.0))
                return;
        }

        state.MicroBreak = state.ReboundPivot;
        state.BreakArmedIndex = _ticks.Count - 1;
        state.Phase = TickPhase.AwaitBreak;
        Print("NAI TICK MOUNTAIN | MICRO RETEST HELD {0} | turn={1:F2} break={2:F2} | waiting break+acceleration", state.Direction, state.CandidateTurn, state.MicroBreak);
    }

    private void AdvanceBreakAndAcceleration(TickMountainState state, double price, double atr)
    {
        var turnFailed = state.Direction == DirectionChoice.Long
            ? price <= state.CandidateTurn - atr * 0.02
            : price >= state.CandidateTurn + atr * 0.02;
        if (turnFailed)
        {
            ResetTickMountain("micro retest broke candidate turn", true);
            return;
        }

        var broke = state.Direction == DirectionChoice.Long
            ? price > state.MicroBreak + Symbol.TickSize
            : price < state.MicroBreak - Symbol.TickSize;
        if (!broke)
            return;

        var beyondBreak = state.Direction == DirectionChoice.Long
            ? (price - state.MicroBreak) / atr
            : (state.MicroBreak - price) / atr;
        var fromTurn = state.Direction == DirectionChoice.Long
            ? (price - state.CandidateTurn) / atr
            : (state.CandidateTurn - price) / atr;

        if (beyondBreak > MaxChaseAtr || fromTurn > 0.50)
        {
            _hourLateSkips++;
            ResetTickMountain("missed mountain/no chase", false);
            return;
        }

        if (!AccelerationConfirmed(state.Direction, state.PullbackVelocity, atr, out var tickRatio, out var velocityRatio, out var netAtr))
            return;

        var risk = state.Direction == DirectionChoice.Long
            ? price - (state.CandidateTurn - atr * 0.10)
            : (state.CandidateTurn + atr * 0.10) - price;

        if (risk < atr * 0.35)
            risk = atr * 0.42;

        if (risk > atr * 1.25)
        {
            ResetTickMountain("stop too wide", false);
            return;
        }

        var bucket = state.Bucket;
        if (_blockedEarlyBuckets.Contains(bucket))
        {
            ResetTickMountain("session memory blocked bucket", false);
            return;
        }

        _armedPlan = new SetupPlan(
            state.Direction,
            "TICK_MOUNTAIN",
            price,
            risk,
            MountainStage.Forming,
            true,
            bucket,
            $"impulse={state.ImpulseAtr:F2}ATR retrace={state.RetraceFraction:P0} turn={state.CandidateTurn:F2} microBreak={state.MicroBreak:F2} tickRatio={tickRatio:P0} velocityRatio={velocityRatio:F2} net8={netAtr:F2}ATR");

        _armedAt = Server.Time;
        if (state.Direction == DirectionChoice.Long) _hourLongDecisions++; else _hourShortDecisions++;
        _hourForecastConfirmed++;
        _hourEarlyConfirmed++;

        Print("NAI DECISION | TICK MOUNTAIN READY {0} | turn={1:F2} break={2:F2} ratio={3:P0} speedX={4:F2} | entryRef={5:F2}", state.Direction, state.CandidateTurn, state.MicroBreak, tickRatio, velocityRatio, price);
        _tickMountain = null;
    }

    private bool AccelerationConfirmed(DirectionChoice direction, double pullbackVelocity, double atr, out double ratio, out double velocityRatio, out double netAtr)
    {
        ratio = 0;
        velocityRatio = 0;
        netAtr = 0;
        if (_ticks.Count < 9)
            return false;

        var to = _ticks.Count - 1;
        var from = to - 8;
        var net = _ticks[to].Price - _ticks[from].Price;
        var directionalNet = direction == DirectionChoice.Long ? net : -net;
        ratio = DirectionalTickRatio(from, to, direction);
        var velocity = Math.Abs(net) / 8.0;
        var baseline = Math.Max(Symbol.TickSize, pullbackVelocity);
        velocityRatio = velocity / baseline;
        netAtr = directionalNet / atr;

        return ratio >= 0.625 && directionalNet >= atr * 0.04 && velocityRatio >= 0.85;
    }

    private double PullbackVelocity(int from, int to)
    {
        if (from < 0 || to <= from || to >= _ticks.Count)
            return Symbol.TickSize;

        double sum = 0;
        var count = 0;
        for (var i = from + 1; i <= to; i++)
        {
            sum += Math.Abs(_ticks[i].Price - _ticks[i - 1].Price);
            count++;
        }
        return count == 0 ? Symbol.TickSize : sum / count;
    }

    private void ResetTickMountain(string reason, bool failedForecast)
    {
        if (_tickMountain == null)
            return;

        if (failedForecast)
        {
            _hourForecastFailed++;
            _hourEarlyFailed++;
        }
        RegisterSkip(reason);
        Print("NAI TICK MOUNTAIN | RESET {0} | {1}", _tickMountain.Direction, reason);
        _tickMountain = null;
    }

    private bool HasStrongOppositeContext(DirectionChoice direction)
    {
        if (direction == DirectionChoice.Long)
            return _mountain.M5Score <= -2 || _mountain.M15Score <= -3;
        if (direction == DirectionChoice.Short)
            return _mountain.M5Score >= 2 || _mountain.M15Score >= 3;
        return true;
    }

    private void TryExecuteArmedPlan()
    {
        var plan = _armedPlan;
        if (plan == null)
            return;

        if ((Server.Time - _armedAt).TotalSeconds > 12)
        {
            RegisterSkip("armed tick entry expired");
            _armedPlan = null;
            return;
        }

        if (HasStrongOppositeContext(plan.Direction))
        {
            RegisterSkip("HTF veto before execution");
            _armedPlan = null;
            return;
        }

        var atr = Atr(_m1, _m1.Count - 2);
        var marketPrice = plan.Direction == DirectionChoice.Long ? Symbol.Ask : Symbol.Bid;
        var chase = plan.Direction == DirectionChoice.Long
            ? (marketPrice - plan.EntryReference) / atr
            : (plan.EntryReference - marketPrice) / atr;

        if (chase > MaxChaseAtr)
        {
            _hourLateSkips++;
            RegisterSkip("chased away after confirmation");
            _armedPlan = null;
            return;
        }

        ExecutePlan(plan, _m1.Count - 2, marketPrice);
    }

    private void ExecutePlan(SetupPlan plan, int i, double marketPrice)
    {
        var risk = plan.RiskDistance;
        var stop = plan.Direction == DirectionChoice.Long ? marketPrice - risk : marketPrice + risk;
        var target = plan.Direction == DirectionChoice.Long ? marketPrice + risk * TargetR : marketPrice - risk * TargetR;
        var stopPips = Math.Abs(marketPrice - stop) / Symbol.PipSize;
        var tpPips = Math.Abs(target - marketPrice) / Symbol.PipSize;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin)
        {
            RegisterSkip("risk-size below minimum");
            _armedPlan = null;
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var type = plan.Direction == DirectionChoice.Long ? TradeType.Buy : TradeType.Sell;
        var result = ExecuteMarketOrder(type, SymbolName, volume, Label, stopPips, tpPips, $"{plan.Stage}:{plan.Name}");

        if (!result.IsSuccessful)
        {
            RegisterSkip("entry rejected");
            Print("NAI EXECUTION | REJECTED | {0} error={1}", plan.Direction, result.Error);
            _armedPlan = null;
            return;
        }

        _hourEntries++;
        _hourEarlyEntries++;
        if (type == TradeType.Buy) _hourLongTrades++; else _hourShortTrades++;
        _lastEntryM1Index = i;
        _lastStopRequestPrice = null;
        _activeMeta = new TradeMeta(plan.Direction, plan.Stage, plan.Name, true, true, i, plan.Bucket, risk, Account.Balance * RiskPercent / 100.0);
        _armedPlan = null;
        _tickMountain = null;

        Print("NAI EXECUTION | ENTER {0} | TRUE TICK MOUNTAIN | entry={1:F2} SL={2:F2} TP={3:F2} | {4}", type, result.Position.EntryPrice, stop, target, plan.Reason);
    }

    private void ManageOpenPositionFast()
    {
        var p = FindPosition();
        if (p == null || !p.TakeProfit.HasValue || !p.StopLoss.HasValue)
            return;

        var originalRisk = Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR;
        if (originalRisk <= Symbol.TickSize)
            return;

        var marketPrice = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? marketPrice - p.EntryPrice : p.EntryPrice - marketPrice;
        var r = favorable / originalRisk;

        // Entry is already confirmed by live tick geometry. HTF score changes are not allowed to close it.
        if (r >= BreakEvenAtR)
        {
            var improve = p.TradeType == TradeType.Buy ? p.StopLoss.Value < p.EntryPrice : p.StopLoss.Value > p.EntryPrice;
            if (improve)
                TryMoveStop(p, p.EntryPrice, "BREAK-EVEN", r);
        }

        if (r >= TrailAtR && _m1.Count > 5)
        {
            var i = _m1.Count - 2;
            var atr = Atr(_m1, i);
            var raw = p.TradeType == TradeType.Buy
                ? LowestLow(_m1, i - 2, i) - atr * 0.08
                : HighestHigh(_m1, i - 2, i) + atr * 0.08;
            TryMoveStop(p, raw, "TRAIL", r);
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
            if (candidate <= p.StopLoss.Value + Symbol.TickSize) return;
        }
        else
        {
            candidate = Math.Max(candidate, NormalizePrice(Symbol.Ask + safety, RoundingMode.Up));
            if (candidate >= p.StopLoss.Value - Symbol.TickSize) return;
        }

        if (_lastStopRequestPrice.HasValue && Math.Abs(candidate - _lastStopRequestPrice.Value) < Symbol.TickSize * 0.5)
            return;

        _lastStopRequestPrice = candidate;
        var result = ModifyPosition(p, candidate, p.TakeProfit, false);
        if (result.IsSuccessful)
            Print("NAI POSITION | {0} SUCCESS | {1} SL->{2:F2} R={3:F2}", reason, p.TradeType, candidate, liveR);
        else
            Print("NAI POSITION | {0} REJECTED | requested={1:F2} error={2}", reason, candidate, result.Error);
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.Label != Label || p.SymbolName != SymbolName)
            return;

        var meta = _activeMeta;
        _lastStopRequestPrice = null;
        _hourNet += p.NetProfit;

        var intendedRiskCash = meta?.RiskCash > 0 ? meta.RiskCash : Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        var resultR = intendedRiskCash > 0 ? p.NetProfit / intendedRiskCash : 0;

        if (p.NetProfit > intendedRiskCash * 0.15) _hourWins++;
        else if (p.NetProfit < -intendedRiskCash * 0.15) _hourLosses++;
        else _hourScratch++;

        if (meta != null)
            UpdateSessionMemory(meta, resultR);

        Print("NAI RESULT | {0} | net={1:F2} approxR={2:F2} reason={3} | mountainMeta={4}", p.TradeType, p.NetProfit, resultR, args.Reason, meta == null ? "none" : meta.Bucket);
        _activeMeta = null;
        _tickMountain = null;
    }

    private void UpdateSessionMemory(TradeMeta meta, double resultR)
    {
        if (!_sessionMemory.TryGetValue(meta.Bucket, out var stats))
            stats = new BucketStats();

        stats.Trades++;
        stats.SumR += resultR;
        if (resultR > 0.15) stats.Wins++;
        else if (resultR < -0.15) stats.Losses++;
        else stats.Scratches++;
        _sessionMemory[meta.Bucket] = stats;

        if (meta.EarlyForecast && stats.Trades >= 6 && stats.SumR <= -1.50 && stats.Wins <= stats.Losses)
        {
            if (_blockedEarlyBuckets.Add(meta.Bucket))
                Print("NAI MEMORY | EARLY BUCKET BLOCKED FOR SESSION | {0} | trades={1} W={2} L={3} sumR={4:F2}", meta.Bucket, stats.Trades, stats.Wins, stats.Losses, stats.SumR);
        }
    }

    private void CheckHourlyBoundary()
    {
        var hour = FloorToHour(Server.Time);
        if (hour == _summaryHour)
            return;

        PrintHourlySummary("HOUR COMPLETE");
        ResetHourlyCounters();
        _summaryHour = hour;
    }

    private void PrintHourlySummary(string trigger)
    {
        var topReason = TopRejectReason();
        var topMemory = TopMemoryBucket();
        Print("=== NAI MOUNTAIN HOURLY ===");
        Print("WINDOW | {0:yyyy-MM-dd HH}:00 UTC | {1}", _summaryHour, trigger);
        Print("MOUNTAIN NOW | direction={0} stage={1} strength={2} | {3}", _mountain.Direction, _mountain.Stage, _mountain.Strength, _mountain.Reason);
        Print("FORECASTS | bull={0} bear={1} confirmed={2} failed={3} | lateSkipped={4}", _hourBullForecasts, _hourBearForecasts, _hourForecastConfirmed, _hourForecastFailed, _hourLateSkips);
        Print("DECISIONS | total={0} long={1} short={2} wait={3} skip={4} | topBlock={5}", _hourDecisions, _hourLongDecisions, _hourShortDecisions, _hourWaits, _hourSkips, topReason);
        Print("TRADES | entries={0} W={1} L={2} scratch={3} | LONG={4} SHORT={5}", _hourEntries, _hourWins, _hourLosses, _hourScratch, _hourLongTrades, _hourShortTrades);
        Print("EARLY | entries={0} confirmed={1} failed={2}", _hourEarlyEntries, _hourEarlyConfirmed, _hourEarlyFailed);
        Print("P/L | hourNet={0:F2} | equity={1:F2} balance={2:F2} | dayFromStart={3:F2}", _hourNet, Account.Equity, Account.Balance, Account.Equity - _dayStartEquity);
        Print("MEMORY | buckets={0} blockedEarly={1} | bestSample={2}", _sessionMemory.Count, _blockedEarlyBuckets.Count, topMemory);
        Print("STATE | tickMountain={0} armed={1} open={2} halted={3}", _tickMountain == null ? "NO" : _tickMountain.Direction + ":" + _tickMountain.Phase, _armedPlan == null ? "NO" : _armedPlan.Direction + ":" + _armedPlan.Name, FindPosition() == null ? "NO" : FindPosition()!.TradeType.ToString(), _halted);
        Print("=== END NAI MOUNTAIN HOURLY ===");
    }

    private string TopRejectReason()
    {
        if (_hourRejectReasons.Count == 0) return "none";
        var x = _hourRejectReasons.OrderByDescending(v => v.Value).ThenBy(v => v.Key).First();
        return x.Key + " x" + x.Value;
    }

    private string TopMemoryBucket()
    {
        if (_sessionMemory.Count == 0) return "none";
        var x = _sessionMemory.OrderByDescending(v => v.Value.Trades >= 3 ? v.Value.SumR : double.MinValue).ThenByDescending(v => v.Value.Trades).First();
        return $"{x.Key} T={x.Value.Trades} W={x.Value.Wins} L={x.Value.Losses} sumR={x.Value.SumR:F2}";
    }

    private void ResetHourlyCounters()
    {
        _hourDecisions = _hourLongDecisions = _hourShortDecisions = _hourWaits = _hourSkips = 0;
        _hourEntries = _hourWins = _hourLosses = _hourScratch = _hourLongTrades = _hourShortTrades = 0;
        _hourBullForecasts = _hourBearForecasts = _hourForecastConfirmed = _hourForecastFailed = 0;
        _hourEarlyEntries = _hourEarlyConfirmed = _hourEarlyFailed = _hourLateSkips = 0;
        _hourNet = 0;
        _hourRejectReasons.Clear();
    }

    private void RegisterWait(string reason) { _hourWaits++; RegisterReason(reason); }
    private void RegisterSkip(string reason) { _hourSkips++; RegisterReason(reason); }
    private void RegisterReason(string reason)
    {
        if (_hourRejectReasons.TryGetValue(reason, out var n)) _hourRejectReasons[reason] = n + 1;
        else _hourRejectReasons[reason] = 1;
    }

    private void PrintMountainContext(string source)
    {
        Print("NAI MOUNTAIN | {0} | direction={1} stage={2} strength={3} | {4}", source, _mountain.Direction, _mountain.Stage, _mountain.Strength, _mountain.Reason);
    }

    private int ContextScore(Bars bars, int i)
    {
        if (i < 20) return 0;
        var atr = Atr(bars, i);
        if (atr <= 0) return 0;

        var score = 0;
        var fast = AverageClose(bars, i - 5, i);
        var slow = AverageClose(bars, i - 17, i);
        if (fast > slow + atr * 0.05) score++; else if (fast < slow - atr * 0.05) score--;

        var move3 = bars.ClosePrices[i] - bars.ClosePrices[i - 3];
        if (move3 > atr * 0.16) score++; else if (move3 < -atr * 0.16) score--;

        var recentHigh = HighestHigh(bars, i - 5, i);
        var recentLow = LowestLow(bars, i - 5, i);
        var priorHigh = HighestHigh(bars, i - 11, i - 6);
        var priorLow = LowestLow(bars, i - 11, i - 6);
        if (recentHigh > priorHigh + atr * 0.04 && recentLow >= priorLow - atr * 0.05) score++;
        else if (recentLow < priorLow - atr * 0.04 && recentHigh <= priorHigh + atr * 0.05) score--;

        var efficiency = Efficiency(bars, i - 6, i);
        var net = bars.ClosePrices[i] - bars.ClosePrices[i - 6];
        if (efficiency >= 0.52 && net > atr * 0.30) score++;
        else if (efficiency >= 0.52 && net < -atr * 0.30) score--;

        return score;
    }

    private void ResetDailyAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay) return;
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        Print("NAI DAY RESET | equity anchor={0:F2}", _dayStartEquity);
    }

    private bool HitDailyStop()
    {
        if (_dayStartEquity <= 0) return false;
        var dd = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (dd < DailyEquityStopPercent) return false;

        _halted = true;
        _armedPlan = null;
        _tickMountain = null;
        var p = FindPosition();
        if (p != null) ClosePosition(p);
        Print("NAI HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
        return true;
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private int IndexOfMinTick(int from, int to)
    {
        var idx = from;
        var value = _ticks[from].Price;
        for (var i = from + 1; i <= to; i++)
            if (_ticks[i].Price < value) { value = _ticks[i].Price; idx = i; }
        return idx;
    }

    private int IndexOfMaxTick(int from, int to)
    {
        var idx = from;
        var value = _ticks[from].Price;
        for (var i = from + 1; i <= to; i++)
            if (_ticks[i].Price > value) { value = _ticks[i].Price; idx = i; }
        return idx;
    }

    private double TickEfficiency(int from, int to)
    {
        if (to <= from) return 0;
        var net = Math.Abs(_ticks[to].Price - _ticks[from].Price);
        double path = 0;
        for (var i = from + 1; i <= to; i++) path += Math.Abs(_ticks[i].Price - _ticks[i - 1].Price);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double DirectionalTickRatio(int from, int to, DirectionChoice direction)
    {
        if (to <= from) return 0;
        var good = 0;
        var total = 0;
        for (var i = from + 1; i <= to; i++)
        {
            var delta = _ticks[i].Price - _ticks[i - 1].Price;
            if (Math.Abs(delta) < Symbol.TickSize * 0.25) continue;
            total++;
            if (direction == DirectionChoice.Long && delta > 0) good++;
            if (direction == DirectionChoice.Short && delta < 0) good++;
        }
        return total == 0 ? 0 : (double)good / total;
    }

    private double MinimumStopDistancePrice(double referencePrice)
    {
        if (Symbol.MinStopLossDistance <= 0) return 0;
        if (Symbol.MinDistanceType == SymbolMinDistanceType.Percentage) return referencePrice * Symbol.MinStopLossDistance / 100.0;
        return Symbol.MinStopLossDistance * Symbol.PipSize;
    }

    private double NormalizePrice(double price, RoundingMode mode)
    {
        if (Symbol.TickSize <= 0) return Math.Round(price, Symbol.Digits);
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
            var tr = Math.Max(bars.HighPrices[k] - bars.LowPrices[k], Math.Max(Math.Abs(bars.HighPrices[k] - bars.ClosePrices[k - 1]), Math.Abs(bars.LowPrices[k] - bars.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private double Efficiency(Bars bars, int from, int to)
    {
        if (to <= from) return 0;
        var net = Math.Abs(bars.ClosePrices[to] - bars.ClosePrices[from]);
        double path = 0;
        for (var k = from + 1; k <= to; k++) path += Math.Abs(bars.ClosePrices[k] - bars.ClosePrices[k - 1]);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double AverageClose(Bars bars, int from, int to)
    {
        from = Math.Max(0, from);
        double sum = 0;
        var count = 0;
        for (var k = from; k <= to; k++) { sum += bars.ClosePrices[k]; count++; }
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

    private static void Push(Queue<int> q, int value, int max)
    {
        q.Enqueue(value);
        while (q.Count > max) q.Dequeue();
    }

    private static int Last(Queue<int> q) => q.Count == 0 ? 0 : q.Last();
    private static int Delta(Queue<int> q) => q.Count < 2 ? 0 : q.Last() - q.Reverse().Skip(1).First();
    private static DateTime FloorToHour(DateTime t) => new DateTime(t.Year, t.Month, t.Day, t.Hour, 0, 0, t.Kind);
    private static string BucketKey(DirectionChoice direction, MountainStage stage, string setup) => $"{direction}-{stage}-{setup}";

    private enum DirectionChoice { None, Long, Short }
    private enum MountainStage { Base, Forming, Climbing, Mature, Failing }
    private enum TickPhase { Pullback, Rebound, AwaitBreak }

    private sealed record TickPoint(DateTime Time, double Price);
    private sealed record TickImpulse(DirectionChoice Direction, double Base, double Extreme, double ImpulseAtr, double Efficiency, double DirectionalRatio);

    private sealed record MountainSnapshot(DirectionChoice Direction, MountainStage Stage, int Strength, int M15Score, int M5Score, int M1Score, int M15Delta, int M5Delta, double ExtensionAtr, double Efficiency, string Reason)
    {
        public static MountainSnapshot Neutral => new(DirectionChoice.None, MountainStage.Base, 0, 0, 0, 0, 0, 0, 0, 0, "warming up");
    }

    private sealed record SetupPlan(DirectionChoice Direction, string Name, double EntryReference, double RiskDistance, MountainStage Stage, bool EarlyForecast, string Bucket, string Reason);
    private sealed record TradeMeta(DirectionChoice Direction, MountainStage Stage, string Setup, bool EarlyForecast, bool Confirmed, int EntryBarIndex, string Bucket, double RiskDistance, double RiskCash);

    private sealed class TickMountainState
    {
        public DirectionChoice Direction { get; set; }
        public TickPhase Phase { get; set; }
        public DateTime CreatedAt { get; set; }
        public double Base { get; set; }
        public double Extreme { get; set; }
        public double ImpulseDistance { get; set; }
        public double ImpulseAtr { get; set; }
        public double Atr { get; set; }
        public double CandidateTurn { get; set; }
        public int CandidateTurnIndex { get; set; }
        public int PullbackStartIndex { get; set; }
        public double RetraceFraction { get; set; }
        public double PullbackVelocity { get; set; }
        public double ReboundVelocity { get; set; }
        public double ReboundPivot { get; set; }
        public double MicroBreak { get; set; }
        public int BreakArmedIndex { get; set; }
        public string Bucket { get; set; } = "";
    }

    private sealed class BucketStats
    {
        public int Trades { get; set; }
        public int Wins { get; set; }
        public int Losses { get; set; }
        public int Scratches { get; set; }
        public double SumR { get; set; }
    }
}
