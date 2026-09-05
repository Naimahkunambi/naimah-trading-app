using System;
using System.Collections.Generic;
using cAlgo.API;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class NaiMountainStoryEngineV2 : Robot
    {
        private const string Label = "NAI-MOUNTAIN-STORY-ENGINE-V2";

        [Parameter("Risk %", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 2.00, Step = 0.05)]
        public double RiskPercent { get; set; }

        [Parameter("Risk Safety Factor", DefaultValue = 0.65, MinValue = 0.35, MaxValue = 1.00, Step = 0.05)]
        public double RiskSafetyFactor { get; set; }

        [Parameter("Base Trail Price Points", DefaultValue = 160.0, MinValue = 80.0, MaxValue = 600.0, Step = 5.0)]
        public double BaseTrailPoints { get; set; }

        [Parameter("Max Losing SLs Per Cycle", DefaultValue = 2, MinValue = 1, MaxValue = 5)]
        public int MaxLosingStopsPerCycle { get; set; }

        [Parameter("Journal Detail", DefaultValue = true)]
        public bool JournalDetail { get; set; }

        private Bars _m1;
        private Bars _m5;
        private Bars _m15;
        private Bars _h1;

        private readonly TickBuffer _ticks = new TickBuffer(512);
        private readonly ScaleTracker _micro = new ScaleTracker("MICRO");
        private readonly ScaleTracker _active = new ScaleTracker("ACTIVE");
        private readonly ScaleTracker _major = new ScaleTracker("MAJOR");
        private readonly LandscapeState _landscape = new LandscapeState();
        private readonly CycleFailureState _cycleFailures = new CycleFailureState();
        private readonly TradeState _trade = new TradeState();

        private double _lastMid;
        private double _noiseEma;
        private double _trailBenchmark;
        private double _microThreshold;
        private double _activeThreshold;
        private double _majorThreshold;

        private bool _pullbackSeen;
        private Direction _pullbackDirection = Direction.Unknown;
        private int _pullbackActiveVersion = -1;
        private int _pullbackMicroVersion = -1;
        private int _pullbackSerial;
        private int _lastTradedPullbackSerial = -1;
        private double _pullbackStartPrice;
        private double _pullbackExtreme;
        private double _pullbackProtectedPrice;

        private int _lastActiveVersion = -1;
        private Direction _lastActiveDirection = Direction.Unknown;
        private DateTime _lastLandscapeUpdate = DateTime.MinValue;
        private DateTime _lastStoryPrint = DateTime.MinValue;
        private DateTime _lastServerStopSync = DateTime.MinValue;
        private bool _hadPosition;
        private string _requestedCloseReason = string.Empty;

        private enum Direction
        {
            Unknown,
            Up,
            Down,
            Transition
        }

        private enum MountainPhase
        {
            Birth,
            Established,
            Pullback,
            Resumption,
            Mature,
            Exhaustion,
            Transition
        }

        private enum SwingKind
        {
            High,
            Low
        }

        private sealed class TickBuffer
        {
            private readonly double[] _values;
            private int _write;
            private int _count;

            public TickBuffer(int capacity)
            {
                _values = new double[capacity];
            }

            public int Count { get { return _count; } }

            public void Add(double value)
            {
                _values[_write] = value;
                _write++;
                if (_write >= _values.Length)
                    _write = 0;
                if (_count < _values.Length)
                    _count++;
            }

            public double Back(int barsBack)
            {
                if (_count == 0)
                    return 0;

                if (barsBack < 0)
                    barsBack = 0;
                if (barsBack >= _count)
                    barsBack = _count - 1;

                int index = _write - 1 - barsBack;
                while (index < 0)
                    index += _values.Length;
                return _values[index];
            }

            public double Delta(int lookback)
            {
                if (_count < lookback + 1)
                    return 0;
                return Back(0) - Back(lookback);
            }

            public int Aligned(Direction direction, int count)
            {
                if (_count < count + 1)
                    return 0;

                int aligned = 0;
                for (int i = 0; i < count; i++)
                {
                    double now = Back(i);
                    double previous = Back(i + 1);
                    if (direction == Direction.Up && now > previous)
                        aligned++;
                    if (direction == Direction.Down && now < previous)
                        aligned++;
                }
                return aligned;
            }

            public double Acceleration(int fastTicks, int slowTicks)
            {
                if (_count < slowTicks + 1 || fastTicks <= 0 || slowTicks <= fastTicks)
                    return 0;

                double fast = Delta(fastTicks) / fastTicks;
                double slow = Delta(slowTicks) / slowTicks;
                return fast - slow;
            }
        }

        private sealed class SwingPoint
        {
            public SwingKind Kind;
            public double Price;
            public DateTime Time;
        }

        private sealed class ScaleTracker
        {
            public readonly string Name;
            public Direction Direction = Direction.Unknown;
            public Direction TransitionCandidate = Direction.Unknown;
            public MountainPhase Phase = MountainPhase.Birth;
            public int Version;
            public DateTime StartedAt = DateTime.MinValue;
            public double Origin;
            public double Extreme;
            public double ProtectedPrice;
            public DateTime ProtectedTime = DateTime.MinValue;
            public double Progression = 1.0;
            public int Continuations;
            public double PreviousLegDistance;
            public double LastLegDistance;
            public double PreviousLegSeconds;
            public double LastLegSeconds;
            public double Threshold;

            public double LastHigh;
            public double PreviousHigh;
            public DateTime LastHighTime = DateTime.MinValue;
            public DateTime PreviousHighTime = DateTime.MinValue;
            public double LastLow;
            public double PreviousLow;
            public DateTime LastLowTime = DateTime.MinValue;
            public DateTime PreviousLowTime = DateTime.MinValue;

            private int _leg;
            private double _candidateHigh;
            private double _candidateLow;
            private DateTime _candidateHighTime = DateTime.MinValue;
            private DateTime _candidateLowTime = DateTime.MinValue;
            private bool _initialized;
            private DateTime _lastImpulseStart = DateTime.MinValue;
            private double _lastImpulseStartPrice;

            public ScaleTracker(string name)
            {
                Name = name;
            }

            public bool Update(double price, DateTime time, double threshold)
            {
                Threshold = Math.Max(threshold, 0.0000001);
                bool changed = false;

                if (!_initialized)
                {
                    _initialized = true;
                    _candidateHigh = price;
                    _candidateLow = price;
                    _candidateHighTime = time;
                    _candidateLowTime = time;
                    Origin = price;
                    Extreme = price;
                    StartedAt = time;
                    return false;
                }

                UpdateLivePhase(price, time);

                if (_leg == 0)
                {
                    if (price > _candidateHigh)
                    {
                        _candidateHigh = price;
                        _candidateHighTime = time;
                    }
                    if (price < _candidateLow)
                    {
                        _candidateLow = price;
                        _candidateLowTime = time;
                    }

                    if (price >= _candidateLow + Threshold)
                    {
                        _leg = 1;
                        _candidateHigh = price;
                        _candidateHighTime = time;
                    }
                    else if (price <= _candidateHigh - Threshold)
                    {
                        _leg = -1;
                        _candidateLow = price;
                        _candidateLowTime = time;
                    }
                    return false;
                }

                if (_leg > 0)
                {
                    if (price >= _candidateHigh)
                    {
                        _candidateHigh = price;
                        _candidateHighTime = time;
                    }
                    else if (price <= _candidateHigh - Threshold)
                    {
                        changed |= ConfirmSwing(new SwingPoint
                        {
                            Kind = SwingKind.High,
                            Price = _candidateHigh,
                            Time = _candidateHighTime
                        });

                        _leg = -1;
                        _candidateLow = price;
                        _candidateLowTime = time;
                    }
                }
                else
                {
                    if (price <= _candidateLow)
                    {
                        _candidateLow = price;
                        _candidateLowTime = time;
                    }
                    else if (price >= _candidateLow + Threshold)
                    {
                        changed |= ConfirmSwing(new SwingPoint
                        {
                            Kind = SwingKind.Low,
                            Price = _candidateLow,
                            Time = _candidateLowTime
                        });

                        _leg = 1;
                        _candidateHigh = price;
                        _candidateHighTime = time;
                    }
                }

                return changed;
            }

            private void UpdateLivePhase(double price, DateTime time)
            {
                double breakBuffer = Threshold * 0.15;

                if (Direction == Direction.Up)
                {
                    if (price > Extreme)
                    {
                        if (Phase == MountainPhase.Pullback)
                        {
                            Phase = MountainPhase.Resumption;
                            Continuations++;
                        }
                        else if (Phase != MountainPhase.Exhaustion)
                        {
                            Phase = MountainPhase.Established;
                        }
                        Extreme = price;
                    }
                    else if (Extreme - price >= Threshold)
                    {
                        if (Phase != MountainPhase.Transition && Phase != MountainPhase.Exhaustion)
                            Phase = MountainPhase.Pullback;
                    }

                    if (ProtectedPrice > 0 && price < ProtectedPrice - breakBuffer)
                    {
                        Phase = MountainPhase.Transition;
                        TransitionCandidate = Direction.Down;
                    }
                }
                else if (Direction == Direction.Down)
                {
                    if (Extreme == 0 || price < Extreme)
                    {
                        if (Phase == MountainPhase.Pullback)
                        {
                            Phase = MountainPhase.Resumption;
                            Continuations++;
                        }
                        else if (Phase != MountainPhase.Exhaustion)
                        {
                            Phase = MountainPhase.Established;
                        }
                        Extreme = price;
                    }
                    else if (price - Extreme >= Threshold)
                    {
                        if (Phase != MountainPhase.Transition && Phase != MountainPhase.Exhaustion)
                            Phase = MountainPhase.Pullback;
                    }

                    if (ProtectedPrice > 0 && price > ProtectedPrice + breakBuffer)
                    {
                        Phase = MountainPhase.Transition;
                        TransitionCandidate = Direction.Up;
                    }
                }

                if (Continuations >= 2 && PreviousLegDistance > 0 && LastLegDistance > 0)
                {
                    Progression = LastLegDistance / PreviousLegDistance;

                    bool distanceShrinking = Progression < 0.72;
                    bool takingLonger = PreviousLegSeconds > 0 && LastLegSeconds > PreviousLegSeconds * 1.15;

                    if (distanceShrinking && takingLonger)
                        Phase = MountainPhase.Exhaustion;
                    else if (Progression < 0.88 && Phase == MountainPhase.Established)
                        Phase = MountainPhase.Mature;
                }
            }

            private bool ConfirmSwing(SwingPoint swing)
            {
                if (swing.Kind == SwingKind.High)
                {
                    PreviousHigh = LastHigh;
                    PreviousHighTime = LastHighTime;
                    LastHigh = swing.Price;
                    LastHighTime = swing.Time;
                }
                else
                {
                    PreviousLow = LastLow;
                    PreviousLowTime = LastLowTime;
                    LastLow = swing.Price;
                    LastLowTime = swing.Time;
                }

                Direction pattern = DeterminePattern();
                bool changed = false;

                if (Direction == Direction.Unknown)
                {
                    if (pattern == Direction.Up || pattern == Direction.Down)
                    {
                        SetDirection(pattern, swing.Time);
                        changed = true;
                    }
                }
                else if (Direction == Direction.Up)
                {
                    if (LastLow > 0)
                    {
                        ProtectedPrice = LastLow;
                        ProtectedTime = LastLowTime;
                    }

                    if (swing.Kind == SwingKind.High && LastLow > 0)
                        RecordLeg(Math.Abs(LastHigh - LastLow), LastLowTime, LastHighTime);

                    if (pattern == Direction.Down && (Phase == MountainPhase.Transition || TransitionCandidate == Direction.Down))
                    {
                        SetDirection(Direction.Down, swing.Time);
                        changed = true;
                    }
                }
                else if (Direction == Direction.Down)
                {
                    if (LastHigh > 0)
                    {
                        ProtectedPrice = LastHigh;
                        ProtectedTime = LastHighTime;
                    }

                    if (swing.Kind == SwingKind.Low && LastHigh > 0)
                        RecordLeg(Math.Abs(LastHigh - LastLow), LastHighTime, LastLowTime);

                    if (pattern == Direction.Up && (Phase == MountainPhase.Transition || TransitionCandidate == Direction.Up))
                    {
                        SetDirection(Direction.Up, swing.Time);
                        changed = true;
                    }
                }

                return changed;
            }

            private Direction DeterminePattern()
            {
                if (LastHigh <= 0 || PreviousHigh <= 0 || LastLow <= 0 || PreviousLow <= 0)
                    return Direction.Unknown;

                double tolerance = Threshold * 0.08;
                bool hh = LastHigh > PreviousHigh + tolerance;
                bool hl = LastLow > PreviousLow + tolerance;
                bool lh = LastHigh < PreviousHigh - tolerance;
                bool ll = LastLow < PreviousLow - tolerance;

                if (hh && hl)
                    return Direction.Up;
                if (lh && ll)
                    return Direction.Down;
                return Direction.Unknown;
            }

            private void SetDirection(Direction direction, DateTime time)
            {
                Direction = direction;
                TransitionCandidate = Direction.Unknown;
                Phase = MountainPhase.Birth;
                Version++;
                StartedAt = time;
                Continuations = 0;
                PreviousLegDistance = 0;
                LastLegDistance = 0;
                PreviousLegSeconds = 0;
                LastLegSeconds = 0;
                Progression = 1.0;

                if (direction == Direction.Up)
                {
                    Origin = LastLow > 0 ? LastLow : LastHigh;
                    Extreme = LastHigh > 0 ? LastHigh : Origin;
                    ProtectedPrice = LastLow;
                    ProtectedTime = LastLowTime;
                }
                else
                {
                    Origin = LastHigh > 0 ? LastHigh : LastLow;
                    Extreme = LastLow > 0 ? LastLow : Origin;
                    ProtectedPrice = LastHigh;
                    ProtectedTime = LastHighTime;
                }

                _lastImpulseStart = time;
                _lastImpulseStartPrice = Origin;
            }

            private void RecordLeg(double distance, DateTime startTime, DateTime endTime)
            {
                if (distance <= 0)
                    return;

                double seconds = Math.Max(0.001, (endTime - startTime).TotalSeconds);
                if (LastLegDistance > 0)
                {
                    PreviousLegDistance = LastLegDistance;
                    PreviousLegSeconds = LastLegSeconds;
                }

                LastLegDistance = distance;
                LastLegSeconds = seconds;
                if (PreviousLegDistance > 0)
                    Progression = LastLegDistance / PreviousLegDistance;
            }

            public double AverageLegDistance()
            {
                if (LastLegDistance <= 0)
                    return 0;
                if (PreviousLegDistance <= 0)
                    return LastLegDistance;
                return (LastLegDistance + PreviousLegDistance) * 0.5;
            }

            public double ProjectTrendline(DateTime now)
            {
                if (Direction == Direction.Up && PreviousLow > 0 && LastLow > 0 && PreviousLowTime != DateTime.MinValue && LastLowTime > PreviousLowTime)
                {
                    double seconds = Math.Max(0.001, (LastLowTime - PreviousLowTime).TotalSeconds);
                    double slope = (LastLow - PreviousLow) / seconds;
                    return LastLow + slope * Math.Max(0, (now - LastLowTime).TotalSeconds);
                }

                if (Direction == Direction.Down && PreviousHigh > 0 && LastHigh > 0 && PreviousHighTime != DateTime.MinValue && LastHighTime > PreviousHighTime)
                {
                    double seconds = Math.Max(0.001, (LastHighTime - PreviousHighTime).TotalSeconds);
                    double slope = (LastHigh - PreviousHigh) / seconds;
                    return LastHigh + slope * Math.Max(0, (now - LastHighTime).TotalSeconds);
                }

                return 0;
            }

            public bool IsTrendlineBreached(double price, DateTime now, double tolerance)
            {
                double line = ProjectTrendline(now);
                if (line <= 0)
                    return false;

                if (Direction == Direction.Up)
                    return price < line - tolerance;
                if (Direction == Direction.Down)
                    return price > line + tolerance;
                return false;
            }
        }

        private sealed class LandscapeState
        {
            public Direction H1 = Direction.Unknown;
            public Direction M15 = Direction.Unknown;
            public Direction M5 = Direction.Unknown;
            public DateTime UpdatedAt = DateTime.MinValue;
        }

        private sealed class CycleFailureState
        {
            public int ActiveVersion = -1;
            public Direction Direction = Direction.Unknown;
            public int LosingStops;
            public bool Blocked;
            public double FirstFailedTrendline;
            public double LastFailedTrendline;
            public double LastFailedProtectedPrice;

            public void Reset(int version, Direction direction)
            {
                ActiveVersion = version;
                Direction = direction;
                LosingStops = 0;
                Blocked = false;
                FirstFailedTrendline = 0;
                LastFailedTrendline = 0;
                LastFailedProtectedPrice = 0;
            }
        }

        private sealed class TradeState
        {
            public long PositionId;
            public Direction Direction = Direction.Unknown;
            public int ActiveVersion = -1;
            public int PullbackSerial = -1;
            public double EntryPrice;
            public double InitialRiskDistance;
            public double EntryEquity;
            public double Mfe;
            public double Mae;
            public double TargetBenchmark;
            public double VirtualStop = double.NaN;
            public double EntryTrendline;
            public double EntryProtectedPrice;
            public double EntryTrailBenchmark;
            public double LastHealth;
            public string LastExitReason = string.Empty;

            public void Clear()
            {
                PositionId = 0;
                Direction = Direction.Unknown;
                ActiveVersion = -1;
                PullbackSerial = -1;
                EntryPrice = 0;
                InitialRiskDistance = 0;
                EntryEquity = 0;
                Mfe = 0;
                Mae = 0;
                TargetBenchmark = 0;
                VirtualStop = double.NaN;
                EntryTrendline = 0;
                EntryProtectedPrice = 0;
                EntryTrailBenchmark = 0;
                LastHealth = 0;
                LastExitReason = string.Empty;
            }
        }

        protected override void OnStart()
        {
            if (Account.IsLive)
            {
                Print("STORY ENGINE V2 SAFETY | LIVE ACCOUNT DETECTED | STOPPING. DEMO ONLY.");
                Stop();
                return;
            }

            _m1 = MarketData.GetBars(TimeFrame.Minute);
            _m5 = MarketData.GetBars(TimeFrame.Minute5);
            _m15 = MarketData.GetBars(TimeFrame.Minute15);
            _h1 = MarketData.GetBars(TimeFrame.Hour);

            _trailBenchmark = BaseTrailPoints;
            _lastMid = MidPrice();
            _noiseEma = Math.Max(Symbol.TickSize * 5, CurrentSpread() * 0.08);

            BootstrapFromM1();
            UpdateLandscape();
            Positions.Closed += Positions_Closed;

            _lastActiveVersion = _active.Version;
            _lastActiveDirection = _active.Direction;
            _cycleFailures.Reset(_active.Version, _active.Direction);

            Print("NAI MOUNTAIN STORY ENGINE V2 STARTED | DEMO ONLY");
            Print("LAW | TICKS BUILD MICRO / ACTIVE / MAJOR MOUNTAINS. TIMEFRAMES ARE LANDSCAPE ONLY.");
            Print("LAW | H1/M15/M5 NEVER AUTHORIZE OR VETO AN ENTRY.");
            Print("LAW | EACH DISTINCT MICRO PULLBACK CAN CREATE A NEW ENTRY INSIDE ONE ACTIVE MOUNTAIN.");
            Print("LAW | NO NORMAL FIXED TP. TP IS AN ADAPTIVE PROFIT-PROTECTION BENCHMARK.");
            Print("LAW | VIRTUAL TRAIL RUNS EVERY TICK. SERVER SL IS SECONDARY PROTECTION.");
            Print("LAW | TWO LOSING STOP-LOSSES BLOCK THE CURRENT ACTIVE MOUNTAIN CYCLE BY DEFAULT.");
            Print("TRAIL PRIOR | screenshot-derived initial benchmark={0:F1} price points | live retracements will adapt it", _trailBenchmark);
            PrintStory("STARTUP");
        }

        protected override void OnTick()
        {
            double bid = Symbol.Bid;
            double ask = Symbol.Ask;
            double mid = (bid + ask) * 0.5;
            double delta = _lastMid > 0 ? mid - _lastMid : 0;

            if (delta != 0)
            {
                double abs = Math.Abs(delta);
                _noiseEma = _noiseEma <= 0 ? abs : _noiseEma * 0.94 + abs * 0.06;
            }

            _ticks.Add(mid);
            UpdateThresholds();

            Position position = GetPosition();
            if (position != null)
            {
                _hadPosition = true;
                if (CheckVirtualStopFirst(position, bid, ask))
                {
                    _lastMid = mid;
                    return;
                }
            }

            bool microChanged = _micro.Update(mid, Server.Time, _microThreshold);
            bool activeChanged = _active.Update(mid, Server.Time, _activeThreshold);
            bool majorChanged = _major.Update(mid, Server.Time, _majorThreshold);

            if (_active.Version != _lastActiveVersion || _active.Direction != _lastActiveDirection)
            {
                Print("ACTIVE MOUNTAIN CHANGE | v{0}/{1} -> v{2}/{3} | failure memory + pullback cycle reset",
                    _lastActiveVersion, _lastActiveDirection, _active.Version, _active.Direction);

                _lastActiveVersion = _active.Version;
                _lastActiveDirection = _active.Direction;
                _cycleFailures.Reset(_active.Version, _active.Direction);
                ResetPullbackState();
            }

            if (Server.Time - _lastLandscapeUpdate >= TimeSpan.FromSeconds(30))
                UpdateLandscape();

            position = GetPosition();
            if (position != null)
            {
                ManageOpenTrade(position, bid, ask, mid);
            }
            else
            {
                if (_hadPosition)
                {
                    _hadPosition = false;
                    _trade.Clear();
                }

                UpdatePullbackAndMaybeTrade(mid);
            }

            if (Server.Time - _lastStoryPrint >= TimeSpan.FromSeconds(10))
            {
                _lastStoryPrint = Server.Time;
                PrintStory("LIVE");
            }

            _lastMid = mid;
        }

        private void BootstrapFromM1()
        {
            if (_m1 == null || _m1.Count < 20)
                return;

            int last = _m1.Count - 2;
            int start = Math.Max(1, last - 120);
            double sum = 0;
            int n = 0;

            for (int i = start; i <= last; i++)
            {
                sum += Math.Abs(_m1.ClosePrices[i] - _m1.ClosePrices[i - 1]);
                n++;
            }

            double barNoise = n > 0 ? sum / n : BaseTrailPoints;
            double spread = CurrentSpread();
            double microSeed = Math.Max(spread * 0.90, barNoise * 0.20);
            double activeSeed = Math.Max(spread * 2.00, barNoise * 0.70);
            double majorSeed = Math.Max(spread * 5.00, barNoise * 1.80);

            for (int i = start; i <= last; i++)
            {
                double price = _m1.ClosePrices[i];
                DateTime time = _m1.OpenTimes[i];
                _micro.Update(price, time, microSeed);
                _active.Update(price, time, activeSeed);
                _major.Update(price, time, majorSeed);
            }
        }

        private void UpdateThresholds()
        {
            double spread = CurrentSpread();
            double noise = Math.Max(_noiseEma, Symbol.TickSize * 5);

            _microThreshold = Math.Max(spread * 0.90, noise * 4.0);
            _activeThreshold = Math.Max(spread * 2.00, noise * 9.0);
            _majorThreshold = Math.Max(spread * 5.00, noise * 22.0);
        }

        private void UpdateLandscape()
        {
            _landscape.H1 = ReadBarDirection(_h1, 8);
            _landscape.M15 = ReadBarDirection(_m15, 12);
            _landscape.M5 = ReadBarDirection(_m5, 18);
            _landscape.UpdatedAt = Server.Time;
            _lastLandscapeUpdate = Server.Time;
        }

        private Direction ReadBarDirection(Bars bars, int lookback)
        {
            if (bars == null || bars.Count < lookback + 3)
                return Direction.Unknown;

            int last = bars.Count - 2;
            int start = Math.Max(0, last - lookback);
            double net = bars.ClosePrices[last] - bars.ClosePrices[start];
            double path = 0;

            for (int i = start + 1; i <= last; i++)
                path += Math.Abs(bars.ClosePrices[i] - bars.ClosePrices[i - 1]);

            if (path <= 0)
                return Direction.Unknown;

            double efficiency = Math.Abs(net) / path;
            if (efficiency < 0.18)
                return Direction.Unknown;

            return net > 0 ? Direction.Up : Direction.Down;
        }

        private void UpdatePullbackAndMaybeTrade(double mid)
        {
            Direction activeDirection = _active.Direction;
            if (activeDirection != Direction.Up && activeDirection != Direction.Down)
                return;

            if (_active.Phase == MountainPhase.Transition)
                return;

            if (_cycleFailures.Blocked && _cycleFailures.ActiveVersion == _active.Version)
                return;

            Direction opposite = Opposite(activeDirection);

            if (_micro.Direction == opposite)
            {
                bool newPullback = !_pullbackSeen ||
                                   _pullbackActiveVersion != _active.Version ||
                                   _pullbackMicroVersion != _micro.Version ||
                                   _pullbackDirection != opposite;

                if (newPullback)
                {
                    _pullbackSeen = true;
                    _pullbackDirection = opposite;
                    _pullbackActiveVersion = _active.Version;
                    _pullbackMicroVersion = _micro.Version;
                    _pullbackSerial++;
                    _pullbackStartPrice = _active.Extreme;
                    _pullbackExtreme = mid;
                    _pullbackProtectedPrice = _micro.ProtectedPrice;

                    if (JournalDetail)
                        Print("PULLBACK #{0} ARMED | active={1} v{2} micro={3} v{4} start={5:F2} protected={6:F2}",
                            _pullbackSerial, activeDirection, _active.Version, _micro.Direction, _micro.Version, _pullbackStartPrice, _pullbackProtectedPrice);
                }

                if (activeDirection == Direction.Up)
                    _pullbackExtreme = Math.Min(_pullbackExtreme, mid);
                else
                    _pullbackExtreme = Math.Max(_pullbackExtreme, mid);

                if (_micro.ProtectedPrice > 0)
                    _pullbackProtectedPrice = _micro.ProtectedPrice;

                return;
            }

            if (!_pullbackSeen || _pullbackActiveVersion != _active.Version)
                return;

            bool microBroken = PullbackBrokenInActiveDirection(activeDirection, mid);
            bool fastFollowThrough = FastFollowThrough(activeDirection);

            if (!microBroken || !fastFollowThrough)
                return;

            double observedRetracement = Math.Abs(_pullbackExtreme - _pullbackStartPrice);
            LearnTrailBenchmark(observedRetracement);

            if (_pullbackSerial == _lastTradedPullbackSerial)
                return;

            if (_cycleFailures.Blocked && _cycleFailures.ActiveVersion == _active.Version)
                return;

            OpenTrade(activeDirection, mid);
        }

        private bool PullbackBrokenInActiveDirection(Direction activeDirection, double mid)
        {
            double buffer = Math.Max(CurrentSpread() * 0.08, _noiseEma * 0.50);

            if (_micro.Direction == activeDirection)
                return true;

            if (_micro.Phase == MountainPhase.Transition && _micro.TransitionCandidate == activeDirection)
                return true;

            if (_pullbackProtectedPrice <= 0)
                return false;

            if (activeDirection == Direction.Up)
                return mid > _pullbackProtectedPrice + buffer;

            return mid < _pullbackProtectedPrice - buffer;
        }

        private bool FastFollowThrough(Direction direction)
        {
            if (_ticks.Count < 13)
                return false;

            int aligned = _ticks.Aligned(direction, 3);
            double fast = _ticks.Delta(4);
            double medium = _ticks.Delta(12);
            double accel = _ticks.Acceleration(3, 10);
            double noise = Math.Max(_noiseEma, Symbol.TickSize * 5);

            if (direction == Direction.Up)
            {
                return aligned >= 2 &&
                       fast > noise * 0.45 &&
                       medium > -_microThreshold * 0.35 &&
                       accel > -noise * 0.15;
            }

            return aligned >= 2 &&
                   fast < -noise * 0.45 &&
                   medium < _microThreshold * 0.35 &&
                   accel < noise * 0.15;
        }

        private void LearnTrailBenchmark(double observedRetracement)
        {
            if (observedRetracement <= 0)
                return;

            double min = Math.Max(CurrentSpread() * 1.30, 80.0);
            double max = Math.Max(min + 1, _activeThreshold * 2.50);
            double sample = Clamp(observedRetracement, min, max);
            double old = _trailBenchmark;
            _trailBenchmark = old * 0.85 + sample * 0.15;

            if (JournalDetail)
                Print("TRAIL LEARN | pullback={0:F1} sample={1:F1} benchmark {2:F1}->{3:F1}", observedRetracement, sample, old, _trailBenchmark);
        }

        private void OpenTrade(Direction direction, double mid)
        {
            if (GetPosition() != null)
                return;

            TradeType side = direction == Direction.Up ? TradeType.Buy : TradeType.Sell;
            double spread = CurrentSpread();
            double stopBuffer = Math.Max(spread * 0.30, _microThreshold * 0.25);
            double plannedEntry = side == TradeType.Buy ? Symbol.Ask : Symbol.Bid;
            double stopPrice = side == TradeType.Buy
                ? _pullbackExtreme - stopBuffer
                : _pullbackExtreme + stopBuffer;

            double riskDistance = Math.Abs(plannedEntry - stopPrice);
            double minRisk = Math.Max(spread * 1.10, _microThreshold * 1.10);
            if (riskDistance < minRisk)
            {
                riskDistance = minRisk;
                stopPrice = side == TradeType.Buy
                    ? plannedEntry - riskDistance
                    : plannedEntry + riskDistance;
            }

            double slPips = riskDistance / Symbol.PipSize;
            if (slPips <= 0)
                return;

            double riskAmount = Account.Equity * (RiskPercent / 100.0) * RiskSafetyFactor;
            double volume = Symbol.NormalizeVolumeInUnits(Symbol.VolumeForFixedRisk(riskAmount, slPips), RoundingMode.Down);
            if (volume < Symbol.VolumeInUnitsMin)
            {
                Print("ENTRY SKIP | volume below minimum | calculated={0} min={1}", volume, Symbol.VolumeInUnitsMin);
                return;
            }
            if (volume > Symbol.VolumeInUnitsMax)
                volume = Symbol.VolumeInUnitsMax;

            double activeLeg = _active.AverageLegDistance();
            if (activeLeg <= 0)
                activeLeg = riskDistance * 1.5;

            double targetBenchmark = riskDistance * 1.20 * 0.45 +
                                     activeLeg * 0.55 * 0.35 +
                                     _trailBenchmark * 1.30 * 0.20;
            targetBenchmark = Math.Max(targetBenchmark, _trailBenchmark * 1.20);
            if (activeLeg > 0)
                targetBenchmark = Math.Min(targetBenchmark, Math.Max(_trailBenchmark * 1.20, activeLeg * 0.90));

            double trendline = _active.ProjectTrendline(Server.Time);

            Print("ENTRY THESIS | {0} | active v{1} {2}/{3} | micro pullback #{4} BROKEN | protected={5:F2} trendline={6:F2} | trailBenchmark={7:F1} targetBenchmark={8:F1} | no fixed TP",
                side, _active.Version, _active.Direction, _active.Phase, _pullbackSerial, _active.ProtectedPrice, trendline, _trailBenchmark, targetBenchmark);

            TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, Label, slPips, null);
            if (!result.IsSuccessful || result.Position == null)
            {
                Print("ENTRY REJECTED | error={0}", result.Error);
                return;
            }

            Position position = result.Position;
            _trade.Clear();
            _trade.PositionId = position.Id;
            _trade.Direction = direction;
            _trade.ActiveVersion = _active.Version;
            _trade.PullbackSerial = _pullbackSerial;
            _trade.EntryPrice = position.EntryPrice;
            _trade.InitialRiskDistance = position.StopLoss.HasValue
                ? Math.Abs(position.EntryPrice - position.StopLoss.Value)
                : riskDistance;
            _trade.EntryEquity = Account.Equity;
            _trade.TargetBenchmark = targetBenchmark;
            _trade.EntryTrendline = trendline;
            _trade.EntryProtectedPrice = _active.ProtectedPrice;
            _trade.EntryTrailBenchmark = _trailBenchmark;
            _lastTradedPullbackSerial = _pullbackSerial;
            _hadPosition = true;
            _requestedCloseReason = string.Empty;

            Print("ENTERED | id={0} {1} entry={2:F2} SL={3} volume={4} riskDistance={5:F1} targetBenchmark={6:F1}",
                position.Id,
                side,
                position.EntryPrice,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("F2") : "NONE",
                position.VolumeInUnits,
                _trade.InitialRiskDistance,
                _trade.TargetBenchmark);
        }

        private bool CheckVirtualStopFirst(Position position, double bid, double ask)
        {
            if (double.IsNaN(_trade.VirtualStop))
                return false;

            bool hit = position.TradeType == TradeType.Buy
                ? bid <= _trade.VirtualStop
                : ask >= _trade.VirtualStop;

            if (!hit)
                return false;

            _requestedCloseReason = "VIRTUAL_TRAIL";
            _trade.LastExitReason = _requestedCloseReason;
            Print("VIRTUAL STOP HIT | id={0} stop={1:F2} bid={2:F2} ask={3:F2} mfe={4:F1}", position.Id, _trade.VirtualStop, bid, ask, _trade.Mfe);
            ClosePosition(position);
            return true;
        }

        private void ManageOpenTrade(Position position, double bid, double ask, double mid)
        {
            EnsureTradeState(position);

            double favorable = position.TradeType == TradeType.Buy
                ? bid - position.EntryPrice
                : position.EntryPrice - ask;
            double adverse = position.TradeType == TradeType.Buy
                ? position.EntryPrice - bid
                : ask - position.EntryPrice;

            if (favorable > _trade.Mfe)
                _trade.Mfe = favorable;
            if (adverse > _trade.Mae)
                _trade.Mae = adverse;

            bool trendlineBreached = _active.IsTrendlineBreached(mid, Server.Time, Math.Max(CurrentSpread() * 0.20, _noiseEma * 1.5));
            double health = ComputeTradeHealth(position, trendlineBreached);
            _trade.LastHealth = health;

            if (ThesisBroken(position, mid, trendlineBreached))
            {
                _requestedCloseReason = "THESIS_BROKEN";
                _trade.LastExitReason = _requestedCloseReason;
                Print("THESIS EXIT | id={0} active={1}/{2} micro={3}/{4} trendlineBroken={5} health={6:F2}",
                    position.Id, _active.Direction, _active.Phase, _micro.Direction, _micro.Phase, trendlineBreached, health);
                ClosePosition(position);
                return;
            }

            UpdateAdaptiveVirtualTrail(position, health, trendlineBreached);
            SyncServerStop(position);
        }

        private void EnsureTradeState(Position position)
        {
            if (_trade.PositionId == position.Id && _trade.EntryPrice > 0)
                return;

            _trade.Clear();
            _trade.PositionId = position.Id;
            _trade.Direction = position.TradeType == TradeType.Buy ? Direction.Up : Direction.Down;
            _trade.ActiveVersion = _active.Version;
            _trade.EntryPrice = position.EntryPrice;
            _trade.InitialRiskDistance = position.StopLoss.HasValue
                ? Math.Abs(position.EntryPrice - position.StopLoss.Value)
                : Math.Max(_trailBenchmark, CurrentSpread() * 2.0);
            _trade.EntryEquity = Account.Equity;
            _trade.TargetBenchmark = Math.Max(_trailBenchmark * 1.20, _trade.InitialRiskDistance * 1.20);
            _trade.EntryTrendline = _active.ProjectTrendline(Server.Time);
            _trade.EntryProtectedPrice = _active.ProtectedPrice;
            _trade.EntryTrailBenchmark = _trailBenchmark;
        }

        private double ComputeTradeHealth(Position position, bool trendlineBreached)
        {
            Direction tradeDirection = position.TradeType == TradeType.Buy ? Direction.Up : Direction.Down;
            double score = 0.55;

            if (_active.Direction == tradeDirection)
                score += 0.20;
            else if (_active.Direction == Opposite(tradeDirection))
                score -= 0.45;
            else if (_active.Direction == Direction.Transition)
                score -= 0.25;

            if (_active.Phase == MountainPhase.Established || _active.Phase == MountainPhase.Resumption)
                score += 0.15;
            else if (_active.Phase == MountainPhase.Pullback)
                score -= 0.05;
            else if (_active.Phase == MountainPhase.Mature)
                score -= 0.10;
            else if (_active.Phase == MountainPhase.Exhaustion)
                score -= 0.25;
            else if (_active.Phase == MountainPhase.Transition)
                score -= 0.30;

            if (_active.Progression >= 0.90)
                score += 0.08;
            else if (_active.Progression < 0.70)
                score -= 0.10;

            if (_micro.Direction == tradeDirection)
                score += 0.05;
            else if (_micro.Direction == Opposite(tradeDirection))
                score -= 0.08;

            if (trendlineBreached)
                score -= 0.15;

            return Clamp(score, 0, 1);
        }

        private bool ThesisBroken(Position position, double mid, bool trendlineBreached)
        {
            Direction tradeDirection = position.TradeType == TradeType.Buy ? Direction.Up : Direction.Down;
            Direction opposite = Opposite(tradeDirection);

            if (_active.Direction == opposite)
                return true;

            bool protectedBroken;
            double buffer = Math.Max(CurrentSpread() * 0.18, _noiseEma * 1.5);
            if (tradeDirection == Direction.Up)
                protectedBroken = _active.ProtectedPrice > 0 && mid < _active.ProtectedPrice - buffer;
            else
                protectedBroken = _active.ProtectedPrice > 0 && mid > _active.ProtectedPrice + buffer;

            bool oppositeMicroEstablished = _micro.Direction == opposite &&
                                            (_micro.Phase == MountainPhase.Established || _micro.Phase == MountainPhase.Resumption || _micro.Phase == MountainPhase.Mature);

            return protectedBroken && trendlineBreached && oppositeMicroEstablished;
        }

        private void UpdateAdaptiveVirtualTrail(Position position, double health, bool trendlineBreached)
        {
            if (_trade.Mfe <= 0)
                return;

            double spread = CurrentSpread();
            double baseDistance = Math.Max(_trailBenchmark, Math.Max(spread * 1.35, _noiseEma * 6.0));

            double healthFactor;
            if (health >= 0.78)
                healthFactor = 1.12;
            else if (health >= 0.60)
                healthFactor = 1.00;
            else if (health >= 0.42)
                healthFactor = 0.82;
            else
                healthFactor = 0.62;

            double targetFactor = 1.0;
            if (_trade.TargetBenchmark > 0)
            {
                double progress = _trade.Mfe / _trade.TargetBenchmark;
                if (progress >= 1.20)
                    targetFactor = 0.58;
                else if (progress >= 1.00)
                    targetFactor = 0.68;
                else if (progress >= 0.75)
                    targetFactor = 0.84;
            }

            double phaseFactor = 1.0;
            if (_active.Phase == MountainPhase.Mature)
                phaseFactor = 0.82;
            else if (_active.Phase == MountainPhase.Exhaustion)
                phaseFactor = 0.62;
            else if (_active.Phase == MountainPhase.Transition)
                phaseFactor = 0.52;

            double lineFactor = trendlineBreached ? 0.72 : 1.0;
            double trailDistance = baseDistance * healthFactor * targetFactor * phaseFactor * lineFactor;
            double minimumTrail = Math.Max(spread * 1.12, _noiseEma * 3.5);
            double maximumTrail = Math.Max(minimumTrail, baseDistance * 1.35);
            trailDistance = Clamp(trailDistance, minimumTrail, maximumTrail);

            double protectedDistance = _trade.Mfe - trailDistance;

            double tinyProfitActivation = Math.Max(spread * 1.35, _trade.TargetBenchmark * 0.35);
            if (_trade.Mfe >= tinyProfitActivation)
                protectedDistance = Math.Max(protectedDistance, spread * 0.05);

            if (protectedDistance <= 0)
                return;

            double candidate = position.TradeType == TradeType.Buy
                ? position.EntryPrice + protectedDistance
                : position.EntryPrice - protectedDistance;

            double structural = StructureTrailCandidate(position);
            if (structural > 0)
            {
                if (position.TradeType == TradeType.Buy && structural > candidate && structural < Symbol.Bid)
                    candidate = structural;
                else if (position.TradeType == TradeType.Sell && structural < candidate && structural > Symbol.Ask)
                    candidate = structural;
            }

            bool improves = double.IsNaN(_trade.VirtualStop) ||
                            (position.TradeType == TradeType.Buy && candidate > _trade.VirtualStop) ||
                            (position.TradeType == TradeType.Sell && candidate < _trade.VirtualStop);

            if (!improves)
                return;

            _trade.VirtualStop = candidate;

            if (JournalDetail)
                Print("VIRTUAL TRAIL | id={0} mfe={1:F1} target={2:F1} health={3:F2} phase={4} benchmark={5:F1} distance={6:F1} virtualSL={7:F2}",
                    position.Id, _trade.Mfe, _trade.TargetBenchmark, health, _active.Phase, _trailBenchmark, trailDistance, _trade.VirtualStop);
        }

        private double StructureTrailCandidate(Position position)
        {
            double buffer = Math.Max(CurrentSpread() * 0.18, _microThreshold * 0.20);

            if (position.TradeType == TradeType.Buy)
            {
                if (_micro.Direction == Direction.Up && _micro.ProtectedPrice > 0)
                    return _micro.ProtectedPrice - buffer;
                if (_active.Direction == Direction.Up && _active.ProtectedPrice > 0)
                    return _active.ProtectedPrice - buffer;
            }
            else
            {
                if (_micro.Direction == Direction.Down && _micro.ProtectedPrice > 0)
                    return _micro.ProtectedPrice + buffer;
                if (_active.Direction == Direction.Down && _active.ProtectedPrice > 0)
                    return _active.ProtectedPrice + buffer;
            }

            return 0;
        }

        private void SyncServerStop(Position position)
        {
            if (double.IsNaN(_trade.VirtualStop))
                return;

            bool enoughTime = Server.Time - _lastServerStopSync >= TimeSpan.FromMilliseconds(250);
            double materialMove = Math.Max(CurrentSpread() * 0.12, Symbol.TickSize * 8);
            bool improvement;

            if (!position.StopLoss.HasValue)
                improvement = true;
            else if (position.TradeType == TradeType.Buy)
                improvement = _trade.VirtualStop > position.StopLoss.Value + materialMove;
            else
                improvement = _trade.VirtualStop < position.StopLoss.Value - materialMove;

            if (!improvement || !enoughTime)
                return;

            double room = Math.Max(CurrentSpread() * 0.10, Symbol.TickSize * 4);
            bool brokerSideValid = position.TradeType == TradeType.Buy
                ? _trade.VirtualStop < Symbol.Bid - room
                : _trade.VirtualStop > Symbol.Ask + room;

            if (!brokerSideValid)
                return;

            _lastServerStopSync = Server.Time;
            TradeResult result = ModifyPosition(position, _trade.VirtualStop, position.TakeProfit);
            if (result.IsSuccessful)
            {
                if (JournalDetail)
                    Print("SERVER STOP SYNC | id={0} SL={1:F2}", position.Id, _trade.VirtualStop);
            }
            else
            {
                Print("SERVER STOP REJECTED | id={0} requested={1:F2} error={2} | virtual stop remains ACTIVE",
                    position.Id, _trade.VirtualStop, result.Error);
            }
        }

        private void Positions_Closed(PositionClosedEventArgs args)
        {
            Position position = args.Position;
            if (position == null || position.Label != Label || position.SymbolName != SymbolName)
                return;

            bool losingStop = (args.Reason == PositionCloseReason.StopLoss || args.Reason == PositionCloseReason.StopOut) && position.NetProfit < 0;

            if (losingStop && _trade.ActiveVersion == _cycleFailures.ActiveVersion)
            {
                _cycleFailures.LosingStops++;
                double line = _trade.EntryTrendline;
                if (_cycleFailures.FirstFailedTrendline == 0)
                    _cycleFailures.FirstFailedTrendline = line;
                _cycleFailures.LastFailedTrendline = line;
                _cycleFailures.LastFailedProtectedPrice = _trade.EntryProtectedPrice;

                Print("CYCLE LOSS MEMORY | active v{0} {1} | losing SL #{2}/{3} | entryTrendline={4:F2} protected={5:F2} net={6:F2}",
                    _cycleFailures.ActiveVersion,
                    _cycleFailures.Direction,
                    _cycleFailures.LosingStops,
                    MaxLosingStopsPerCycle,
                    line,
                    _trade.EntryProtectedPrice,
                    position.NetProfit);

                if (_cycleFailures.LosingStops >= MaxLosingStopsPerCycle)
                {
                    _cycleFailures.Blocked = true;
                    Print("CYCLE BLOCKED | active v{0} {1} | repeated losing SLs on same mountain/trendline family | WAIT FOR NEW ACTIVE MOUNTAIN",
                        _cycleFailures.ActiveVersion, _cycleFailures.Direction);
                }
            }
            else
            {
                Print("TRADE CLOSED | id={0} reason={1} requestedReason={2} net={3:F2} mfe={4:F1} mae={5:F1} | cycleSLs={6} blocked={7}",
                    position.Id,
                    args.Reason,
                    string.IsNullOrEmpty(_requestedCloseReason) ? "BROKER/OTHER" : _requestedCloseReason,
                    position.NetProfit,
                    _trade.Mfe,
                    _trade.Mae,
                    _cycleFailures.LosingStops,
                    _cycleFailures.Blocked);
            }

            _requestedCloseReason = string.Empty;
        }

        private void ResetPullbackState()
        {
            _pullbackSeen = false;
            _pullbackDirection = Direction.Unknown;
            _pullbackActiveVersion = -1;
            _pullbackMicroVersion = -1;
            _pullbackStartPrice = 0;
            _pullbackExtreme = 0;
            _pullbackProtectedPrice = 0;
        }

        private Position GetPosition()
        {
            Position[] positions = Positions.FindAll(Label, SymbolName);
            if (positions == null || positions.Length == 0)
                return null;
            return positions[0];
        }

        private Direction Opposite(Direction direction)
        {
            if (direction == Direction.Up)
                return Direction.Down;
            if (direction == Direction.Down)
                return Direction.Up;
            return Direction.Unknown;
        }

        private double CurrentSpread()
        {
            return Math.Max(Symbol.Ask - Symbol.Bid, Symbol.TickSize * 2);
        }

        private double MidPrice()
        {
            return (Symbol.Bid + Symbol.Ask) * 0.5;
        }

        private double Clamp(double value, double min, double max)
        {
            if (value < min)
                return min;
            if (value > max)
                return max;
            return value;
        }

        private void PrintStory(string tag)
        {
            double trendline = _active.ProjectTrendline(Server.Time);
            Print("STORY {0} | MAJOR v{1} {2}/{3} protected={4:F2} prog={5:F2} | ACTIVE v{6} {7}/{8} protected={9:F2} line={10:F2} prog={11:F2} | MICRO v{12} {13}/{14} | LANDSCAPE H1={15} M15={16} M5={17} [NO VETO] | pullback#{18} armed={19} | trailBench={20:F1} | cycleSL={21}/{22} blocked={23}",
                tag,
                _major.Version, _major.Direction, _major.Phase, _major.ProtectedPrice, _major.Progression,
                _active.Version, _active.Direction, _active.Phase, _active.ProtectedPrice, trendline, _active.Progression,
                _micro.Version, _micro.Direction, _micro.Phase,
                _landscape.H1, _landscape.M15, _landscape.M5,
                _pullbackSerial, _pullbackSeen,
                _trailBenchmark,
                _cycleFailures.LosingStops, MaxLosingStopsPerCycle, _cycleFailures.Blocked);
        }
    }
}
