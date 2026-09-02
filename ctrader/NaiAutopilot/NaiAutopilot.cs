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
    private int _entryM1Index = -1;
    private double? _lastStopRequestPrice;

    private readonly Queue<int> _m5Trajectory = new();
    private readonly Queue<int> _m15Trajectory = new();
    private readonly Queue<int> _m1Trajectory = new();

    private MountainSnapshot _mountain = MountainSnapshot.Neutral;
    private SetupPlan? _armedPlan;
    private DateTime _armedAt = DateTime.MinValue;
    private TradeMeta? _activeMeta;

    private MountainEntryState? _entryState;
    private double _lastObservedTick = double.NaN;

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

        Print("NAI MOUNTAIN DECISION V1 STARTED | {0} | DEMO | trajectory memory + REAL mountain entry", SymbolName);
        Print("ENTRY FIX | impulse -> pullback -> candidate turn -> micro break -> 3 confirming ticks -> entry");
        Print("M15/M5 ARE CONTEXT ONLY | strong opposite context can veto, but scores cannot manufacture an entry");
        Print("MOUNTAIN STAGES | BASE / FORMING / CLIMBING / MATURE / FAILING | choices LONG / SHORT / WAIT / SKIP");
        Print("RISK | {0:F2}% | target={1:F2}R | BE={2:F2}R | trail={3:F2}R | earlyEmergency=-{4:F2}R", RiskPercent, TargetR, BreakEvenAtR, TrailAtR, EarlyEmergencyR);
        Print("SESSION MEMORY | tracks direction+stage+setup; weak EARLY buckets can be blocked after repeated evidence");
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

        ResetDailyAnchorIfNeeded();
        if (HitDailyStop())
            return;

        CheckHourlyBoundary();
        RefreshMountain(force: false);
        ManageOpenPositionFast();

        if (FindPosition() != null)
            return;

        ProcessNewM1IfNeeded();
        AdvanceMountainEntryOnTick();
        TryExecuteArmedPlan();
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

        if (_entryState != null && HasStrongOppositeContext(_entryState.Direction))
        {
            Print("NAI ENTRY | RESET | strong opposite HTF veto appeared for {0}", _entryState.Direction);
            _entryState = null;
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

        var bullTrajectory = 0;
        var bearTrajectory = 0;

        if (s15 >= 1) bullTrajectory += 2; else if (s15 <= -1) bearTrajectory += 2;
        if (s5 >= 1) bullTrajectory += 2; else if (s5 <= -1) bearTrajectory += 2;
        if (s1 >= 2) bullTrajectory += 2; else if (s1 <= -2) bearTrajectory += 2;
        if (d15 > 0) bullTrajectory += 2; else if (d15 < 0) bearTrajectory += 2;
        if (d5 > 0) bullTrajectory += 2; else if (d5 < 0) bearTrajectory += 2;

        DirectionChoice direction;
        var strength = Math.Max(bullTrajectory, bearTrajectory);
        if (bullTrajectory >= bearTrajectory + 2 && bullTrajectory >= 5) direction = DirectionChoice.Long;
        else if (bearTrajectory >= bullTrajectory + 2 && bearTrajectory >= 5) direction = DirectionChoice.Short;
        else direction = DirectionChoice.None;

        MountainStage stage;
        var accelerating = direction == DirectionChoice.Long ? d5 > 0 || d15 > 0 : direction == DirectionChoice.Short ? d5 < 0 || d15 < 0 : false;
        var strongAligned = direction == DirectionChoice.Long ? s15 >= 2 && s5 >= 2 && s1 >= 2 : direction == DirectionChoice.Short ? s15 <= -2 && s5 <= -2 && s1 <= -2 : false;
        var oppositeM1 = direction == DirectionChoice.Long ? s1 <= -2 : direction == DirectionChoice.Short ? s1 >= 2 : false;

        if (direction == DirectionChoice.None)
            stage = MountainStage.Base;
        else if (oppositeM1 && !accelerating)
            stage = MountainStage.Failing;
        else if (extension >= 1.05 || (strongAligned && !accelerating && efficiency < 0.50))
            stage = MountainStage.Mature;
        else if (strongAligned && (extension >= 0.35 || efficiency >= 0.55))
            stage = MountainStage.Climbing;
        else
            stage = MountainStage.Forming;

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
        var s1 = ContextScore(_m1, i);
        Push(_m1Trajectory, s1, 8);
        _mountain = BuildMountainSnapshot();
        _hourDecisions++;

        ValidateActiveForecastOnNewBar(i);

        if (FindPosition() != null)
            return;

        var barsSinceEntry = i - _lastEntryM1Index;
        if (barsSinceEntry < CooldownBars)
        {
            RegisterWait("cooldown");
            _entryState = null;
            Print("NAI ENTRY | WAIT | cooldown {0}/{1}", barsSinceEntry, CooldownBars);
            return;
        }

        RefreshEntryStateFromClosedBars(i);
    }

    private void RefreshEntryStateFromClosedBars(int i)
    {
        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize * 5)
        {
            RegisterSkip("ATR too small");
            _entryState = null;
            return;
        }

        if (_entryState != null)
        {
            if ((Server.Time - _entryState.CreatedAt).TotalMinutes > 3.2)
            {
                RegisterSkip("mountain setup expired");
                Print("NAI ENTRY | RESET | {0} setup expired", _entryState.Direction);
                _entryState = null;
            }
            else
            {
                RefreshCandidateTurnFromLatestBar(i, atr);
                return;
            }
        }

        var longCandidate = DetectPullbackMountainCandidate(i, DirectionChoice.Long, atr);
        var shortCandidate = DetectPullbackMountainCandidate(i, DirectionChoice.Short, atr);

        MountainEntryState? selected = null;
        if (longCandidate != null && shortCandidate != null)
            selected = longCandidate.ImpulseAtr >= shortCandidate.ImpulseAtr ? longCandidate : shortCandidate;
        else
            selected = longCandidate ?? shortCandidate;

        if (selected == null)
        {
            var directLong = DetectDirectMountainCandidate(i, DirectionChoice.Long, atr);
            var directShort = DetectDirectMountainCandidate(i, DirectionChoice.Short, atr);
            if (directLong != null && directShort != null)
                selected = directLong.ImpulseAtr >= directShort.ImpulseAtr ? directLong : directShort;
            else
                selected = directLong ?? directShort;
        }

        if (selected == null)
        {
            RegisterWait("no impulse-pullback mountain");
            return;
        }

        if (HasStrongOppositeContext(selected.Direction))
        {
            RegisterSkip("HTF veto");
            Print("NAI ENTRY | VETO {0} | M15={1} M5={2} | geometry found but context strongly opposite",
                selected.Direction, _mountain.M15Score, _mountain.M5Score);
            return;
        }

        var bucketStage = _mountain.Stage == MountainStage.Mature ? MountainStage.Forming : _mountain.Stage;
        var bucket = BucketKey(selected.Direction, bucketStage, selected.Kind);
        if (_blockedEarlyBuckets.Contains(bucket))
        {
            RegisterSkip("session memory blocked bucket");
            Print("NAI MEMORY | BLOCK ENTRY | {0}", bucket);
            return;
        }

        selected.Bucket = bucket;
        selected.Stage = bucketStage;
        _entryState = selected;
        _lastObservedTick = selected.Direction == DirectionChoice.Long ? Symbol.Ask : Symbol.Bid;

        if (selected.Direction == DirectionChoice.Long) _hourBullForecasts++; else _hourBearForecasts++;
        Print("NAI ENTRY | IMPULSE+PULLBACK FOUND | {0} {1} | impulse={2:F2}ATR retrace={3:P0} turn={4:F2} break={5:F2} | waiting live micro-break",
            selected.Direction, selected.Kind, selected.ImpulseAtr, selected.RetraceFraction, selected.CandidateTurn, selected.MicroBreak);
    }

    private MountainEntryState? DetectPullbackMountainCandidate(int i, DirectionChoice direction, double atr)
    {
        if (i < 12)
            return null;

        MountainEntryState? best = null;

        for (var impulseEnd = i - 1; impulseEnd >= i - 4; impulseEnd--)
        {
            for (var lookback = 3; lookback <= 6; lookback++)
            {
                var impulseStart = impulseEnd - lookback;
                if (impulseStart < 2)
                    continue;

                var start = _m1.ClosePrices[impulseStart];
                var end = _m1.ClosePrices[impulseEnd];
                var move = direction == DirectionChoice.Long ? end - start : start - end;
                if (move < atr * 0.80)
                    continue;

                var efficiency = Efficiency(_m1, impulseStart, impulseEnd);
                if (efficiency < 0.52)
                    continue;

                if (direction == DirectionChoice.Long && _m1.HighPrices[impulseEnd] <= _m1.HighPrices[impulseStart])
                    continue;
                if (direction == DirectionChoice.Short && _m1.LowPrices[impulseEnd] >= _m1.LowPrices[impulseStart])
                    continue;

                var pullbackStart = impulseEnd + 1;
                if (pullbackStart > i)
                    continue;

                var impulseExtreme = direction == DirectionChoice.Long
                    ? HighestHigh(_m1, impulseStart, impulseEnd)
                    : LowestLow(_m1, impulseStart, impulseEnd);

                var impulseBase = direction == DirectionChoice.Long
                    ? LowestLow(_m1, impulseStart, impulseEnd)
                    : HighestHigh(_m1, impulseStart, impulseEnd);

                var candidateTurn = direction == DirectionChoice.Long
                    ? LowestLow(_m1, pullbackStart, i)
                    : HighestHigh(_m1, pullbackStart, i);

                var impulseDistance = Math.Abs(impulseExtreme - impulseBase);
                if (impulseDistance <= Symbol.TickSize)
                    continue;

                var retrace = direction == DirectionChoice.Long
                    ? (impulseExtreme - candidateTurn) / impulseDistance
                    : (candidateTurn - impulseExtreme) / impulseDistance;

                if (retrace < 0.16 || retrace > 0.58)
                    continue;

                var pullbackMoved = direction == DirectionChoice.Long
                    ? _m1.ClosePrices[i] < _m1.ClosePrices[impulseEnd] - atr * 0.08
                    : _m1.ClosePrices[i] > _m1.ClosePrices[impulseEnd] + atr * 0.08;
                if (!pullbackMoved)
                    continue;

                if (direction == DirectionChoice.Long && candidateTurn <= impulseBase + atr * 0.05)
                    continue;
                if (direction == DirectionChoice.Short && candidateTurn >= impulseBase - atr * 0.05)
                    continue;

                var breakFrom = Math.Max(pullbackStart, i - 2);
                var microBreak = direction == DirectionChoice.Long
                    ? HighestHigh(_m1, breakFrom, i)
                    : LowestLow(_m1, breakFrom, i);

                var current = direction == DirectionChoice.Long ? Symbol.Ask : Symbol.Bid;
                var distanceFromTurn = Math.Abs(current - candidateTurn) / atr;
                if (distanceFromTurn > 0.75)
                    continue;

                var candidate = new MountainEntryState
                {
                    Direction = direction,
                    Kind = "MOUNTAIN_TURN",
                    Stage = MountainStage.Forming,
                    Bucket = "",
                    CreatedAt = Server.Time,
                    ImpulseStartIndex = impulseStart,
                    ImpulseEndIndex = impulseEnd,
                    CandidateTurn = candidateTurn,
                    MicroBreak = microBreak,
                    ImpulseBase = impulseBase,
                    ImpulseExtreme = impulseExtreme,
                    ImpulseAtr = impulseDistance / atr,
                    RetraceFraction = retrace,
                    AtrAtDetection = atr,
                    Direct = false
                };

                if (best == null || candidate.ImpulseAtr > best.ImpulseAtr)
                    best = candidate;
            }
        }

        return best;
    }

    private MountainEntryState? DetectDirectMountainCandidate(int i, DirectionChoice direction, double atr)
    {
        if (i < 8)
            return null;

        var from = i - 4;
        var start = _m1.ClosePrices[from];
        var end = _m1.ClosePrices[i];
        var move = direction == DirectionChoice.Long ? end - start : start - end;
        if (move < atr * 0.90 || move > atr * 1.80)
            return null;

        var efficiency = Efficiency(_m1, from, i);
        if (efficiency < 0.70)
            return null;

        var fast = AverageClose(_m1, i - 5, i);
        var extension = Math.Abs(end - fast) / atr;
        if (extension > 0.55)
            return null;

        var alignedBars = 0;
        for (var k = i - 3; k <= i; k++)
        {
            if (direction == DirectionChoice.Long && _m1.ClosePrices[k] > _m1.OpenPrices[k]) alignedBars++;
            if (direction == DirectionChoice.Short && _m1.ClosePrices[k] < _m1.OpenPrices[k]) alignedBars++;
        }
        if (alignedBars < 3)
            return null;

        var impulseBase = direction == DirectionChoice.Long ? LowestLow(_m1, from, i) : HighestHigh(_m1, from, i);
        var impulseExtreme = direction == DirectionChoice.Long ? HighestHigh(_m1, from, i) : LowestLow(_m1, from, i);
        var microBreak = direction == DirectionChoice.Long ? _m1.HighPrices[i] : _m1.LowPrices[i];

        return new MountainEntryState
        {
            Direction = direction,
            Kind = "DIRECT_MOUNTAIN",
            Stage = MountainStage.Climbing,
            Bucket = "",
            CreatedAt = Server.Time,
            ImpulseStartIndex = from,
            ImpulseEndIndex = i,
            CandidateTurn = direction == DirectionChoice.Long ? _m1.LowPrices[i] : _m1.HighPrices[i],
            MicroBreak = microBreak,
            ImpulseBase = impulseBase,
            ImpulseExtreme = impulseExtreme,
            ImpulseAtr = Math.Abs(impulseExtreme - impulseBase) / atr,
            RetraceFraction = 0,
            AtrAtDetection = atr,
            Direct = true
        };
    }

    private void RefreshCandidateTurnFromLatestBar(int i, double atr)
    {
        var state = _entryState;
        if (state == null)
            return;

        if (state.Direction == DirectionChoice.Long)
        {
            if (_m1.LowPrices[i] <= state.ImpulseBase + atr * 0.05)
            {
                Print("NAI ENTRY | RESET LONG | impulse base broken before entry");
                _entryState = null;
                return;
            }

            if (!state.Direct && _m1.LowPrices[i] < state.CandidateTurn)
            {
                state.CandidateTurn = _m1.LowPrices[i];
                state.MicroBreak = Math.Max(_m1.HighPrices[i], _m1.HighPrices[Math.Max(0, i - 1)]);
                state.BreakSeen = false;
                state.ConfirmTicks = 0;
            }
        }
        else
        {
            if (_m1.HighPrices[i] >= state.ImpulseBase - atr * 0.05)
            {
                Print("NAI ENTRY | RESET SHORT | impulse base broken before entry");
                _entryState = null;
                return;
            }

            if (!state.Direct && _m1.HighPrices[i] > state.CandidateTurn)
            {
                state.CandidateTurn = _m1.HighPrices[i];
                state.MicroBreak = Math.Min(_m1.LowPrices[i], _m1.LowPrices[Math.Max(0, i - 1)]);
                state.BreakSeen = false;
                state.ConfirmTicks = 0;
            }
        }
    }

    private void AdvanceMountainEntryOnTick()
    {
        var state = _entryState;
        if (state == null || _armedPlan != null || FindPosition() != null)
            return;

        if ((Server.Time - state.CreatedAt).TotalMinutes > 3.2)
        {
            RegisterSkip("mountain live state expired");
            _entryState = null;
            return;
        }

        if (HasStrongOppositeContext(state.Direction))
        {
            RegisterSkip("HTF veto");
            Print("NAI ENTRY | VETO LIVE {0} | M15={1} M5={2}", state.Direction, _mountain.M15Score, _mountain.M5Score);
            _entryState = null;
            return;
        }

        var price = state.Direction == DirectionChoice.Long ? Symbol.Ask : Symbol.Bid;
        var atr = state.AtrAtDetection > 0 ? state.AtrAtDetection : Atr(_m1, _m1.Count - 2);

        var beyondBreak = state.Direction == DirectionChoice.Long
            ? (price - state.MicroBreak) / atr
            : (state.MicroBreak - price) / atr;

        if (beyondBreak > MaxChaseAtr)
        {
            _hourLateSkips++;
            RegisterSkip("missed mountain/no chase");
            Print("NAI ENTRY | MISSED MOUNTAIN {0} | already {1:F2}ATR beyond micro-break", state.Direction, beyondBreak);
            _entryState = null;
            return;
        }

        var broke = state.Direction == DirectionChoice.Long
            ? price > state.MicroBreak + Symbol.TickSize
            : price < state.MicroBreak - Symbol.TickSize;

        if (!state.BreakSeen)
        {
            if (!broke)
            {
                _lastObservedTick = price;
                return;
            }

            state.BreakSeen = true;
            state.ConfirmTicks = 0;
            state.LastConfirmPrice = price;
            _lastObservedTick = price;
            Print("NAI ENTRY | MICRO BREAK {0} | turn={1:F2} break={2:F2} first={3:F2}", state.Direction, state.CandidateTurn, state.MicroBreak, price);
            return;
        }

        var failedBreak = state.Direction == DirectionChoice.Long
            ? price < state.MicroBreak - Symbol.TickSize * 2
            : price > state.MicroBreak + Symbol.TickSize * 2;

        if (failedBreak)
        {
            state.BreakSeen = false;
            state.ConfirmTicks = 0;
            state.LastConfirmPrice = price;
            _lastObservedTick = price;
            Print("NAI ENTRY | BREAK FAILED | {0} back through micro level", state.Direction);
            return;
        }

        var advances = state.Direction == DirectionChoice.Long
            ? price > state.LastConfirmPrice
            : price < state.LastConfirmPrice;

        if (advances)
        {
            state.ConfirmTicks++;
            state.LastConfirmPrice = price;
        }

        _lastObservedTick = price;

        if (state.ConfirmTicks < 3)
            return;

        var risk = state.Direction == DirectionChoice.Long
            ? price - (state.CandidateTurn - atr * 0.10)
            : (state.CandidateTurn + atr * 0.10) - price;

        if (risk < atr * 0.35)
            risk = atr * 0.42;

        if (risk > atr * 1.25)
        {
            RegisterSkip("mountain stop too wide");
            Print("NAI ENTRY | SKIP {0} | stop distance={1:F2}ATR too wide", state.Direction, risk / atr);
            _entryState = null;
            return;
        }

        var stage = state.Stage == MountainStage.Base ? MountainStage.Forming : state.Stage;
        var early = !state.Direct && stage != MountainStage.Climbing;
        var bucket = string.IsNullOrWhiteSpace(state.Bucket) ? BucketKey(state.Direction, stage, state.Kind) : state.Bucket;

        _armedPlan = new SetupPlan(
            state.Direction,
            state.Kind,
            price,
            risk,
            stage,
            early,
            bucket,
            $"impulse={state.ImpulseAtr:F2}ATR retrace={state.RetraceFraction:P0} turn={state.CandidateTurn:F2} break={state.MicroBreak:F2} confirmTicks={state.ConfirmTicks}");

        _armedAt = Server.Time;
        if (state.Direction == DirectionChoice.Long) _hourLongDecisions++; else _hourShortDecisions++;

        Print("NAI DECISION | READY {0} | {1} | micro-break held + {2} confirming ticks | entryRef={3:F2}",
            state.Direction, state.Kind, state.ConfirmTicks, price);

        _entryState = null;
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

        if ((Server.Time - _armedAt).TotalMinutes > 1.2)
        {
            RegisterSkip("armed setup expired");
            _armedPlan = null;
            return;
        }

        if (HasStrongOppositeContext(plan.Direction))
        {
            RegisterSkip("HTF veto before execution");
            Print("NAI DECISION | CANCEL {0} | strong opposite HTF veto before execution", plan.Direction);
            _armedPlan = null;
            return;
        }

        var i = _m1.Count - 2;
        var atr = Atr(_m1, i);
        if (atr <= 0)
            return;

        var marketPrice = plan.Direction == DirectionChoice.Long ? Symbol.Ask : Symbol.Bid;
        var chase = plan.Direction == DirectionChoice.Long ? (marketPrice - plan.EntryReference) / atr : (plan.EntryReference - marketPrice) / atr;

        if (chase > MaxChaseAtr)
        {
            RegisterSkip("chased away");
            _hourLateSkips++;
            Print("NAI DECISION | SKIP CHASE | {0} moved {1:F2}ATR beyond confirmed entry", plan.Direction, chase);
            _armedPlan = null;
            return;
        }

        if (chase < -0.35)
            return;

        ExecutePlan(plan, i, marketPrice);
    }

    private SetupPlan? FindPullbackEntry(int i, int dir, double atr)
    {
        var fast = AverageClose(_m1, i - 5, i);
        var slow = AverageClose(_m1, i - 17, i);
        var open = _m1.OpenPrices[i];
        var close = _m1.ClosePrices[i];
        var high = _m1.HighPrices[i];
        var low = _m1.LowPrices[i];
        var range = Math.Max(Symbol.TickSize, high - low);
        var body = Math.Abs(close - open);

        var trendSeparated = dir > 0 ? fast > slow + atr * 0.04 : fast < slow - atr * 0.04;
        var touchedValue = dir > 0 ? low <= fast + atr * 0.22 : high >= fast - atr * 0.22;
        var closedBack = dir > 0 ? close > fast : close < fast;
        var candleAligned = dir > 0 ? close > open : close < open;
        var closeStrong = dir > 0 ? close >= low + range * 0.56 : close <= high - range * 0.56;

        if (!trendSeparated || !touchedValue || !closedBack || !candleAligned || !closeStrong || body < atr * 0.10)
            return null;

        var entry = dir > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = dir > 0 ? LowestLow(_m1, i - 4, i) : HighestHigh(_m1, i - 4, i);
        var stop = dir > 0 ? swing - atr * 0.10 : swing + atr * 0.10;
        var risk = Math.Abs(entry - stop);
        if (risk < atr * 0.42) risk = atr * 0.52;
        if (risk > atr * 1.45) return null;

        return new SetupPlan(dir > 0 ? DirectionChoice.Long : DirectionChoice.Short, "PULLBACK", entry, risk, MountainStage.Base, false, "", $"valueTouch body={body / atr:F2}ATR risk={risk / atr:F2}ATR");
    }

    private SetupPlan? FindMomentumEntry(int i, int dir, double atr)
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
        var broke = dir > 0 ? close > priorHigh : close < priorLow;
        var aligned = dir > 0 ? close > open : close < open;
        var closeStrong = dir > 0 ? close >= low + range * 0.68 : close <= high - range * 0.68;
        var distanceFromFast = Math.Abs(close - fast) / atr;
        var efficiency = Efficiency(_m1, i - 4, i);

        if (!broke || !aligned || !closeStrong || body < atr * 0.24 || efficiency < 0.46 || distanceFromFast > 1.05)
            return null;

        var entry = dir > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = dir > 0 ? LowestLow(_m1, i - 3, i) : HighestHigh(_m1, i - 3, i);
        var stop = dir > 0 ? swing - atr * 0.08 : swing + atr * 0.08;
        var risk = Math.Abs(entry - stop);
        if (risk < atr * 0.46) risk = atr * 0.56;
        if (risk > atr * 1.30) return null;

        return new SetupPlan(dir > 0 ? DirectionChoice.Long : DirectionChoice.Short, "MOMENTUM", entry, risk, MountainStage.Base, false, "", $"break4 eff={efficiency:F2} body={body / atr:F2}ATR fastDist={distanceFromFast:F2}ATR");
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
            Print("NAI EXECUTION | REJECTED | {0} {1} error={2}", plan.Direction, plan.Name, result.Error);
            _armedPlan = null;
            return;
        }

        _hourEntries++;
        if (type == TradeType.Buy) _hourLongTrades++; else _hourShortTrades++;
        if (plan.EarlyForecast) _hourEarlyEntries++;
        _lastEntryM1Index = i;
        _entryM1Index = i;
        _lastStopRequestPrice = null;
        _activeMeta = new TradeMeta(plan.Direction, plan.Stage, plan.Name, plan.EarlyForecast, false, i, plan.Bucket, risk, Account.Balance * RiskPercent / 100.0);
        _armedPlan = null;
        _entryState = null;

        Print("NAI EXECUTION | ENTER {0} | mountain={1} setup={2} EARLY={3} entry={4:F2} SL={5:F2} TP={6:F2} | validateBars={7}", type, plan.Stage, plan.Name, plan.EarlyForecast, result.Position.EntryPrice, stop, target, EarlyValidationBars);
    }

    private void ValidateActiveForecastOnNewBar(int i)
    {
        var p = FindPosition();
        var meta = _activeMeta;
        if (p == null || meta == null || !meta.EarlyForecast || meta.Confirmed)
            return;

        var age = i - meta.EntryBarIndex;
        if (age < 1)
            return;

        var directionStill = _mountain.Direction == meta.Direction;
        var confirms = directionStill && (_mountain.Stage == MountainStage.Climbing || (_mountain.Stage == MountainStage.Forming && _mountain.Strength >= 7));

        if (confirms)
        {
            _activeMeta = meta with { Confirmed = true };
            _hourForecastConfirmed++;
            _hourEarlyConfirmed++;
            Print("NAI FORECAST | CONFIRMED | {0} mountain after {1} bars | stage={2} strength={3}", meta.Direction, age, _mountain.Stage, _mountain.Strength);
            return;
        }

        if (age >= EarlyValidationBars || _mountain.Stage == MountainStage.Failing || (_mountain.Direction != DirectionChoice.None && _mountain.Direction != meta.Direction))
        {
            var result = ClosePosition(p);
            if (result.IsSuccessful)
            {
                _hourForecastFailed++;
                _hourEarlyFailed++;
                Print("NAI FORECAST | FAILED EARLY EXIT | {0} age={1} stageNow={2} directionNow={3}", meta.Direction, age, _mountain.Stage, _mountain.Direction);
            }
        }
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
        var meta = _activeMeta;

        if (meta != null && meta.EarlyForecast && !meta.Confirmed && r <= -EarlyEmergencyR)
        {
            var result = ClosePosition(p);
            if (result.IsSuccessful)
            {
                _hourForecastFailed++;
                _hourEarlyFailed++;
                Print("NAI FORECAST | EMERGENCY ABORT | {0} reached {1:F2}R before confirmation", meta.Direction, r);
            }
            return;
        }

        var oppositeStrong = _mountain.Direction != DirectionChoice.None && meta != null && _mountain.Direction != meta.Direction && _mountain.Strength >= 7;
        if (oppositeStrong && r < 0.40)
        {
            var result = ClosePosition(p);
            if (result.IsSuccessful)
                Print("NAI POSITION | THESIS BROKEN EXIT | {0} R={1:F2} oppositeMountain={2}/{3}", p.TradeType, r, _mountain.Direction, _mountain.Stage);
            return;
        }

        if (r >= BreakEvenAtR)
        {
            var improve = p.TradeType == TradeType.Buy ? p.StopLoss.Value < p.EntryPrice : p.StopLoss.Value > p.EntryPrice;
            if (improve) TryMoveStop(p, p.EntryPrice, "BREAK-EVEN", r);
        }

        if (r >= TrailAtR && _m1.Count > 5)
        {
            var i = _m1.Count - 2;
            var atr = Atr(_m1, i);
            var raw = p.TradeType == TradeType.Buy ? LowestLow(_m1, i - 2, i) - atr * 0.08 : HighestHigh(_m1, i - 2, i) + atr * 0.08;
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
        _entryM1Index = -1;
        _hourNet += p.NetProfit;

        var intendedRiskCash = meta?.RiskCash > 0 ? meta.RiskCash : Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        var resultR = intendedRiskCash > 0 ? p.NetProfit / intendedRiskCash : 0;

        if (p.NetProfit > intendedRiskCash * 0.15) _hourWins++;
        else if (p.NetProfit < -intendedRiskCash * 0.15) _hourLosses++;
        else _hourScratch++;

        if (meta != null)
        {
            UpdateSessionMemory(meta, resultR);
            if (meta.EarlyForecast && !meta.Confirmed && p.NetProfit > intendedRiskCash * 0.15)
            {
                _hourForecastConfirmed++;
                _hourEarlyConfirmed++;
            }
        }

        Print("NAI RESULT | {0} | net={1:F2} approxR={2:F2} reason={3} | mountainMeta={4}", p.TradeType, p.NetProfit, resultR, args.Reason, meta == null ? "none" : meta.Bucket);
        _activeMeta = null;
        _entryState = null;
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
        Print("STATE | armed={0} open={1} halted={2}", _armedPlan == null ? "NO" : _armedPlan.Direction + ":" + _armedPlan.Stage + ":" + _armedPlan.Name, FindPosition() == null ? "NO" : FindPosition()!.TradeType.ToString(), _halted);
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

    private void M1TrendVotes(int i, out int bull, out int bear)
    {
        bull = bear = 0;
        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize) return;

        var fast = AverageClose(_m1, i - 5, i);
        var slow = AverageClose(_m1, i - 17, i);
        if (fast > slow + atr * 0.04) bull++; else if (fast < slow - atr * 0.04) bear++;

        var fastPast = AverageClose(_m1, i - 9, i - 4);
        if (fast > fastPast + atr * 0.05) bull++; else if (fast < fastPast - atr * 0.05) bear++;

        var move3 = _m1.ClosePrices[i] - _m1.ClosePrices[i - 3];
        if (move3 > atr * 0.12) bull++; else if (move3 < -atr * 0.12) bear++;

        var recentHigh = HighestHigh(_m1, i - 5, i);
        var recentLow = LowestLow(_m1, i - 5, i);
        var priorHigh = HighestHigh(_m1, i - 11, i - 6);
        var priorLow = LowestLow(_m1, i - 11, i - 6);
        if (recentHigh > priorHigh + atr * 0.05 && recentLow >= priorLow - atr * 0.05) bull++;
        else if (recentLow < priorLow - atr * 0.05 && recentHigh <= priorHigh + atr * 0.05) bear++;

        var body = _m1.ClosePrices[i] - _m1.OpenPrices[i];
        if (body > atr * 0.10) bull++; else if (body < -atr * 0.10) bear++;
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
        _entryState = null;
        var p = FindPosition();
        if (p != null) ClosePosition(p);
        Print("NAI HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
        return true;
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

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

    private sealed record MountainSnapshot(DirectionChoice Direction, MountainStage Stage, int Strength, int M15Score, int M5Score, int M1Score, int M15Delta, int M5Delta, double ExtensionAtr, double Efficiency, string Reason)
    {
        public static MountainSnapshot Neutral => new(DirectionChoice.None, MountainStage.Base, 0, 0, 0, 0, 0, 0, 0, 0, "warming up");
    }

    private sealed record SetupPlan(DirectionChoice Direction, string Name, double EntryReference, double RiskDistance, MountainStage Stage, bool EarlyForecast, string Bucket, string Reason);
    private sealed record TradeMeta(DirectionChoice Direction, MountainStage Stage, string Setup, bool EarlyForecast, bool Confirmed, int EntryBarIndex, string Bucket, double RiskDistance, double RiskCash);

    private sealed class MountainEntryState
    {
        public DirectionChoice Direction { get; set; }
        public string Kind { get; set; } = "";
        public MountainStage Stage { get; set; }
        public string Bucket { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public int ImpulseStartIndex { get; set; }
        public int ImpulseEndIndex { get; set; }
        public double CandidateTurn { get; set; }
        public double MicroBreak { get; set; }
        public double ImpulseBase { get; set; }
        public double ImpulseExtreme { get; set; }
        public double ImpulseAtr { get; set; }
        public double RetraceFraction { get; set; }
        public double AtrAtDetection { get; set; }
        public bool Direct { get; set; }
        public bool BreakSeen { get; set; }
        public int ConfirmTicks { get; set; }
        public double LastConfirmPrice { get; set; }
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
