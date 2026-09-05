using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class NaiMountainStoryEngineV1 : Robot
    {
        private const string Label = "NAI-MOUNTAIN-STORY-ENGINE-V1";

        [Parameter("Risk %", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 2.00, Step = 0.05)]
        public double RiskPercent { get; set; }

        [Parameter("Risk Safety Factor", DefaultValue = 0.60, MinValue = 0.35, MaxValue = 1.00, Step = 0.05)]
        public double RiskSafetyFactor { get; set; }

        [Parameter("Entry Score", DefaultValue = 0.58, MinValue = 0.40, MaxValue = 0.85, Step = 0.02)]
        public double EntryScoreThreshold { get; set; }

        [Parameter("Trail Start R", DefaultValue = 0.18, MinValue = 0.10, MaxValue = 0.50, Step = 0.02)]
        public double TrailStartR { get; set; }

        [Parameter("Trail Distance R", DefaultValue = 0.20, MinValue = 0.10, MaxValue = 0.50, Step = 0.02)]
        public double TrailDistanceR { get; set; }

        [Parameter("Little Win Milestone R", DefaultValue = 0.45, MinValue = 0.25, MaxValue = 1.00, Step = 0.05)]
        public double LittleWinMilestoneR { get; set; }

        [Parameter("Little Win Lock R", DefaultValue = 0.20, MinValue = 0.05, MaxValue = 0.60, Step = 0.05)]
        public double LittleWinLockR { get; set; }

        [Parameter("Emergency TP R", DefaultValue = 3.00, MinValue = 1.50, MaxValue = 6.00, Step = 0.25)]
        public double EmergencyTargetR { get; set; }

        [Parameter("Swing Strength", DefaultValue = 2, MinValue = 1, MaxValue = 4)]
        public int SwingStrength { get; set; }

        [Parameter("Bootstrap M1 Bars", DefaultValue = 120, MinValue = 40, MaxValue = 400)]
        public int BootstrapBars { get; set; }

        [Parameter("Journal Detail", DefaultValue = true)]
        public bool JournalDetail { get; set; }

        private Bars _m1;
        private Bars _m5;
        private Bars _m15;
        private Bars _h1;

        private readonly List<TickPoint> _ticks = new List<TickPoint>();
        private readonly List<SwingPoint> _swings = new List<SwingPoint>();
        private readonly List<TradeEpisode> _memory = new List<TradeEpisode>();

        private MountainState _mountain = new MountainState();
        private ContextSnapshot _context = new ContextSnapshot();
        private TriggerState _trigger = new TriggerState();
        private TradeState _trade = new TradeState();

        private double _lastMid;
        private double _emaAbsTick;
        private int _lastM1Count;
        private DateTime _lastContextUpdate = DateTime.MinValue;
        private DateTime _lastStoryPrint = DateTime.MinValue;
        private bool _hadPosition;

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
            Exhaustion,
            Transition
        }

        private enum SwingKind
        {
            High,
            Low
        }

        private enum MarketEventType
        {
            SwingHigh,
            SwingLow,
            ProtectedBreak,
            NewExtreme,
            PullbackStarted,
            ResumptionSeen,
            ExhaustionSeen
        }

        private sealed class TickPoint
        {
            public DateTime Time;
            public double Bid;
            public double Ask;
            public double Mid;
        }

        private sealed class SwingPoint
        {
            public SwingKind Kind;
            public int Index;
            public DateTime Time;
            public double Price;
        }

        private sealed class MarketEvent
        {
            public MarketEventType Type;
            public double Price;
            public DateTime Time;
            public SwingPoint Swing;
        }

        private sealed class Leg
        {
            public double Distance;
            public double DurationSeconds;
            public DateTime EndTime;
        }

        private sealed class MountainState
        {
            public Direction Direction = Direction.Unknown;
            public Direction TransitionCandidate = Direction.Unknown;
            public MountainPhase Phase = MountainPhase.Birth;
            public DateTime StartedAt = DateTime.MinValue;
            public double Origin;
            public double CurrentExtreme;
            public double ProtectedPrice;
            public DateTime ProtectedTime = DateTime.MinValue;
            public double PullbackExtreme;
            public double PullbackDepth;
            public double Velocity;
            public double Acceleration;
            public double Progression = 1.0;
            public int Continuations;
            public int Version;
            public readonly List<Leg> Legs = new List<Leg>();
        }

        private sealed class ContextSnapshot
        {
            public Direction H1 = Direction.Unknown;
            public Direction M15 = Direction.Unknown;
            public Direction M5 = Direction.Unknown;
            public double H1RangePosition;
            public double M15RangePosition;
            public double M5RangePosition;
            public DateTime UpdatedAt;
        }

        private sealed class TriggerState
        {
            public int MountainVersion = -1;
            public bool PullbackArmed;
            public double PullbackExtreme;
            public double PullbackStartExtreme;
            public int TriggerId;
            public DateTime ArmedAt = DateTime.MinValue;
        }

        private sealed class EntryEvidence
        {
            public Direction Direction;
            public double Alignment;
            public double Velocity;
            public double Acceleration;
            public double MicroBreak;
            public double Turn;
            public double Memory;
            public double Score;
        }

        private sealed class TradeState
        {
            public long PositionId;
            public Direction Direction = Direction.Unknown;
            public MountainPhase EntryPhase;
            public DateTime EntryTime = DateTime.MinValue;
            public double EntryPrice;
            public double InitialRiskDistance;
            public double EntryEquity;
            public double BestR;
            public double WorstR;
            public double LastNetProfit;
            public double LastAppliedLockR = double.NegativeInfinity;
            public double EntryPullbackDepth;
            public double EntryProgression;
            public double EntryVelocity;
            public double EntryScore;
            public int MountainVersion;
            public int TicksAlive;
        }

        private sealed class TradeEpisode
        {
            public Direction Direction;
            public MountainPhase Phase;
            public double PullbackDepth;
            public double Progression;
            public double Velocity;
            public double EntryScore;
            public double BestR;
            public double WorstR;
            public double NetProfit;
            public bool Won;
            public DateTime Time;
        }

        protected override void OnStart()
        {
            if (Account.IsLive)
            {
                Print("STORY ENGINE SAFETY | LIVE ACCOUNT DETECTED | STOPPING. DEMO ONLY.");
                Stop();
                return;
            }

            _m1 = MarketData.GetBars(TimeFrame.Minute);
            _m5 = MarketData.GetBars(TimeFrame.Minute5);
            _m15 = MarketData.GetBars(TimeFrame.Minute15);
            _h1 = MarketData.GetBars(TimeFrame.Hour);

            _lastMid = MidPrice();
            _lastM1Count = _m1.Count;

            BootstrapStructure();
            UpdateContext();
            ResetTriggerForMountain();

            Print("NAI MOUNTAIN STORY ENGINE V1 STARTED | DEMO ONLY");
            Print("LAW | H1/M15/M5 = CONTEXT ONLY. THEY NEVER VETO OR AUTHORIZE AN ENTRY.");
            Print("LAW | M1 PERSISTENT MOUNTAIN = CURRENT STORY AUTHORITY.");
            Print("LAW | TICKS = ENTRY TIMING. MEMORY = WEIGHT, NOT BOUNCER.");
            Print("LAW | TRAIL USES BEST R AND CAN ONLY TIGHTEN, NEVER LOOSEN.");
            Print("MEMORY | session memory enabled; no cross-restart persistence in this build.");
            PrintStory("STARTUP");
        }

        protected override void OnTick()
        {
            double mid = MidPrice();
            UpdateTickTape(mid);

            if (_m1.Count != _lastM1Count)
            {
                _lastM1Count = _m1.Count;
                ProcessNewM1Bar();
            }

            if (Server.Time - _lastContextUpdate >= TimeSpan.FromSeconds(30))
                UpdateContext();

            UpdateLiveMountain(mid);

            Position position = GetPosition();
            if (position != null)
            {
                _hadPosition = true;
                ManageTrade(position);
            }
            else
            {
                if (_hadPosition)
                {
                    _hadPosition = false;
                    RecordClosedTradeEpisode();
                    ResetTradeState();
                    ResetTriggerForMountain();
                }

                EvaluateAndTrade(mid);
            }

            if (Server.Time - _lastStoryPrint >= TimeSpan.FromSeconds(12))
            {
                _lastStoryPrint = Server.Time;
                PrintStory("LIVE");
            }

            _lastMid = mid;
        }

        private void UpdateTickTape(double mid)
        {
            if (_lastMid > 0)
            {
                double move = Math.Abs(mid - _lastMid);
                if (move > 0)
                    _emaAbsTick = _emaAbsTick <= 0 ? move : _emaAbsTick * 0.94 + move * 0.06;
            }

            _ticks.Add(new TickPoint
            {
                Time = Server.Time,
                Bid = Symbol.Bid,
                Ask = Symbol.Ask,
                Mid = mid
            });

            if (_ticks.Count > 360)
                _ticks.RemoveRange(0, _ticks.Count - 360);
        }

        private void BootstrapStructure()
        {
            _swings.Clear();
            if (_m1 == null || _m1.Count < SwingStrength * 2 + 10)
                return;

            int lastClosed = _m1.Count - 2;
            int first = Math.Max(SwingStrength, lastClosed - BootstrapBars);
            int lastCandidate = lastClosed - SwingStrength;

            for (int i = first; i <= lastCandidate; i++)
                DetectAndAddSwingAt(i, false);

            InferInitialMountain();
        }

        private void ProcessNewM1Bar()
        {
            if (_m1.Count < SwingStrength * 2 + 5)
                return;

            int lastClosed = _m1.Count - 2;
            int candidate = lastClosed - SwingStrength;
            if (candidate <= SwingStrength)
                return;

            List<MarketEvent> events = new List<MarketEvent>();
            SwingPoint swing = DetectAndAddSwingAt(candidate, true);
            if (swing != null)
            {
                events.Add(new MarketEvent
                {
                    Type = swing.Kind == SwingKind.High ? MarketEventType.SwingHigh : MarketEventType.SwingLow,
                    Price = swing.Price,
                    Time = swing.Time,
                    Swing = swing
                });
            }

            double close = _m1.ClosePrices[lastClosed];
            double breakBuffer = Math.Max(CurrentSpreadPrice() * 0.25, CurrentNoise() * 1.2);

            if (_mountain.Direction == Direction.Up && _mountain.ProtectedPrice > 0 && close < _mountain.ProtectedPrice - breakBuffer)
            {
                events.Add(new MarketEvent { Type = MarketEventType.ProtectedBreak, Price = close, Time = Server.Time });
            }
            else if (_mountain.Direction == Direction.Down && _mountain.ProtectedPrice > 0 && close > _mountain.ProtectedPrice + breakBuffer)
            {
                events.Add(new MarketEvent { Type = MarketEventType.ProtectedBreak, Price = close, Time = Server.Time });
            }

            foreach (MarketEvent evt in events)
                ProcessMarketEvent(evt);

            if (_mountain.Direction == Direction.Transition)
                TryConfirmTransition();
        }

        private SwingPoint DetectAndAddSwingAt(int index, bool avoidDuplicate)
        {
            if (index - SwingStrength < 0 || index + SwingStrength >= _m1.Count)
                return null;

            bool high = true;
            bool low = true;
            double h = _m1.HighPrices[index];
            double l = _m1.LowPrices[index];

            for (int j = 1; j <= SwingStrength; j++)
            {
                if (h <= _m1.HighPrices[index - j] || h < _m1.HighPrices[index + j])
                    high = false;
                if (l >= _m1.LowPrices[index - j] || l > _m1.LowPrices[index + j])
                    low = false;
            }

            SwingPoint created = null;
            if (high)
                created = new SwingPoint { Kind = SwingKind.High, Index = index, Time = _m1.OpenTimes[index], Price = h };
            else if (low)
                created = new SwingPoint { Kind = SwingKind.Low, Index = index, Time = _m1.OpenTimes[index], Price = l };

            if (created == null)
                return null;

            if (avoidDuplicate && _swings.Any(x => x.Index == created.Index && x.Kind == created.Kind))
                return null;

            _swings.Add(created);
            if (_swings.Count > 120)
                _swings.RemoveRange(0, _swings.Count - 120);

            return created;
        }

        private void InferInitialMountain()
        {
            List<SwingPoint> highs = _swings.Where(x => x.Kind == SwingKind.High).TakeLast(3).ToList();
            List<SwingPoint> lows = _swings.Where(x => x.Kind == SwingKind.Low).TakeLast(3).ToList();

            Direction inferred = Direction.Unknown;
            if (highs.Count >= 2 && lows.Count >= 2)
            {
                bool hh = highs[highs.Count - 1].Price > highs[highs.Count - 2].Price;
                bool hl = lows[lows.Count - 1].Price > lows[lows.Count - 2].Price;
                bool lh = highs[highs.Count - 1].Price < highs[highs.Count - 2].Price;
                bool ll = lows[lows.Count - 1].Price < lows[lows.Count - 2].Price;

                if (hh && hl) inferred = Direction.Up;
                else if (lh && ll) inferred = Direction.Down;
            }

            if (inferred == Direction.Unknown && _m1.Count > 25)
            {
                int last = _m1.Count - 2;
                double net = _m1.ClosePrices[last] - _m1.ClosePrices[Math.Max(0, last - 18)];
                inferred = net >= 0 ? Direction.Up : Direction.Down;
            }

            _mountain.Direction = inferred;
            _mountain.Phase = MountainPhase.Established;
            _mountain.StartedAt = Server.Time;
            _mountain.Version++;

            if (inferred == Direction.Up)
            {
                SwingPoint low = lows.LastOrDefault();
                SwingPoint high = highs.LastOrDefault();
                _mountain.ProtectedPrice = low != null ? low.Price : _m1.LowPrices[_m1.Count - 2];
                _mountain.ProtectedTime = low != null ? low.Time : Server.Time;
                _mountain.CurrentExtreme = high != null ? high.Price : MidPrice();
                _mountain.Origin = _mountain.ProtectedPrice;
            }
            else if (inferred == Direction.Down)
            {
                SwingPoint high = highs.LastOrDefault();
                SwingPoint low = lows.LastOrDefault();
                _mountain.ProtectedPrice = high != null ? high.Price : _m1.HighPrices[_m1.Count - 2];
                _mountain.ProtectedTime = high != null ? high.Time : Server.Time;
                _mountain.CurrentExtreme = low != null ? low.Price : MidPrice();
                _mountain.Origin = _mountain.ProtectedPrice;
            }

            RebuildLegMetrics();
        }

        private void ProcessMarketEvent(MarketEvent evt)
        {
            if (evt.Type == MarketEventType.ProtectedBreak)
            {
                if (_mountain.Direction == Direction.Up)
                    BeginTransition(Direction.Down, evt.Price);
                else if (_mountain.Direction == Direction.Down)
                    BeginTransition(Direction.Up, evt.Price);
                return;
            }

            if (evt.Swing == null)
                return;

            if (_mountain.Direction == Direction.Up)
            {
                if (evt.Swing.Kind == SwingKind.Low && evt.Swing.Price > _mountain.ProtectedPrice)
                {
                    _mountain.ProtectedPrice = evt.Swing.Price;
                    _mountain.ProtectedTime = evt.Swing.Time;
                    _mountain.Phase = MountainPhase.Pullback;
                }

                if (evt.Swing.Kind == SwingKind.High && evt.Swing.Price > _mountain.CurrentExtreme)
                {
                    AddDirectionalLeg(evt.Swing.Price, evt.Swing.Time);
                    _mountain.CurrentExtreme = evt.Swing.Price;
                    _mountain.Continuations++;
                    _mountain.Phase = IsExhausting() ? MountainPhase.Exhaustion : MountainPhase.Established;
                }
            }
            else if (_mountain.Direction == Direction.Down)
            {
                if (evt.Swing.Kind == SwingKind.High && (_mountain.ProtectedPrice <= 0 || evt.Swing.Price < _mountain.ProtectedPrice))
                {
                    _mountain.ProtectedPrice = evt.Swing.Price;
                    _mountain.ProtectedTime = evt.Swing.Time;
                    _mountain.Phase = MountainPhase.Pullback;
                }

                if (evt.Swing.Kind == SwingKind.Low && (_mountain.CurrentExtreme <= 0 || evt.Swing.Price < _mountain.CurrentExtreme))
                {
                    AddDirectionalLeg(evt.Swing.Price, evt.Swing.Time);
                    _mountain.CurrentExtreme = evt.Swing.Price;
                    _mountain.Continuations++;
                    _mountain.Phase = IsExhausting() ? MountainPhase.Exhaustion : MountainPhase.Established;
                }
            }
        }

        private void BeginTransition(Direction candidate, double price)
        {
            if (_mountain.Direction == Direction.Transition && _mountain.TransitionCandidate == candidate)
                return;

            Print("STORY STRUCTURE BREAK | {0} mountain protected structure broke at {1:F2} | candidate={2}", _mountain.Direction, price, candidate);
            _mountain.Direction = Direction.Transition;
            _mountain.TransitionCandidate = candidate;
            _mountain.Phase = MountainPhase.Transition;
            _mountain.Version++;
            ResetTriggerForMountain();
        }

        private void TryConfirmTransition()
        {
            Direction candidate = _mountain.TransitionCandidate;
            if (candidate == Direction.Unknown)
                return;

            List<SwingPoint> highs = _swings.Where(x => x.Kind == SwingKind.High).TakeLast(2).ToList();
            List<SwingPoint> lows = _swings.Where(x => x.Kind == SwingKind.Low).TakeLast(2).ToList();
            if (highs.Count < 2 || lows.Count < 2)
                return;

            bool confirmDown = highs[1].Price < highs[0].Price && lows[1].Price < lows[0].Price;
            bool confirmUp = highs[1].Price > highs[0].Price && lows[1].Price > lows[0].Price;

            if ((candidate == Direction.Down && confirmDown) || (candidate == Direction.Up && confirmUp))
                StartNewMountain(candidate);
        }

        private void StartNewMountain(Direction direction)
        {
            _mountain = new MountainState
            {
                Direction = direction,
                Phase = MountainPhase.Birth,
                StartedAt = Server.Time,
                Version = _mountain.Version + 1
            };

            List<SwingPoint> highs = _swings.Where(x => x.Kind == SwingKind.High).TakeLast(2).ToList();
            List<SwingPoint> lows = _swings.Where(x => x.Kind == SwingKind.Low).TakeLast(2).ToList();

            if (direction == Direction.Up)
            {
                SwingPoint low = lows.LastOrDefault();
                SwingPoint high = highs.LastOrDefault();
                _mountain.ProtectedPrice = low != null ? low.Price : MidPrice();
                _mountain.ProtectedTime = low != null ? low.Time : Server.Time;
                _mountain.CurrentExtreme = high != null ? high.Price : MidPrice();
                _mountain.Origin = _mountain.ProtectedPrice;
            }
            else
            {
                SwingPoint high = highs.LastOrDefault();
                SwingPoint low = lows.LastOrDefault();
                _mountain.ProtectedPrice = high != null ? high.Price : MidPrice();
                _mountain.ProtectedTime = high != null ? high.Time : Server.Time;
                _mountain.CurrentExtreme = low != null ? low.Price : MidPrice();
                _mountain.Origin = _mountain.ProtectedPrice;
            }

            Print("STORY NEW MOUNTAIN CONFIRMED | direction={0} protected={1:F2} version={2}", direction, _mountain.ProtectedPrice, _mountain.Version);
            ResetTriggerForMountain();
        }

        private void UpdateLiveMountain(double mid)
        {
            if (_mountain.Direction != Direction.Up && _mountain.Direction != Direction.Down)
                return;

            double noise = CurrentNoise();
            double pullbackNeed = Math.Max(CurrentSpreadPrice() * 0.70, noise * 4.0);
            double turnNeed = Math.Max(CurrentSpreadPrice() * 0.25, noise * 1.5);

            if (_mountain.Direction == Direction.Up)
            {
                if (mid > _mountain.CurrentExtreme)
                {
                    _mountain.CurrentExtreme = mid;
                    _mountain.PullbackDepth = 0;
                    _mountain.Phase = IsExhausting() ? MountainPhase.Exhaustion : MountainPhase.Established;
                }
                else
                {
                    double pb = _mountain.CurrentExtreme - mid;
                    _mountain.PullbackDepth = pb;
                    if (pb >= pullbackNeed && mid > _mountain.ProtectedPrice)
                    {
                        _mountain.Phase = MountainPhase.Pullback;
                        _mountain.PullbackExtreme = _mountain.PullbackExtreme <= 0 ? mid : Math.Min(_mountain.PullbackExtreme, mid);
                    }
                    if (_mountain.Phase == MountainPhase.Pullback && mid - _mountain.PullbackExtreme >= turnNeed && RecentDirectionScore(Direction.Up, 3) >= 2)
                        _mountain.Phase = MountainPhase.Resumption;
                }
            }
            else
            {
                if (_mountain.CurrentExtreme <= 0 || mid < _mountain.CurrentExtreme)
                {
                    _mountain.CurrentExtreme = mid;
                    _mountain.PullbackDepth = 0;
                    _mountain.Phase = IsExhausting() ? MountainPhase.Exhaustion : MountainPhase.Established;
                }
                else
                {
                    double pb = mid - _mountain.CurrentExtreme;
                    _mountain.PullbackDepth = pb;
                    if (pb >= pullbackNeed && mid < _mountain.ProtectedPrice)
                    {
                        _mountain.Phase = MountainPhase.Pullback;
                        _mountain.PullbackExtreme = _mountain.PullbackExtreme <= 0 ? mid : Math.Max(_mountain.PullbackExtreme, mid);
                    }
                    if (_mountain.Phase == MountainPhase.Pullback && _mountain.PullbackExtreme - mid >= turnNeed && RecentDirectionScore(Direction.Down, 3) >= 2)
                        _mountain.Phase = MountainPhase.Resumption;
                }
            }

            _mountain.Velocity = DeltaTicks(5);
            _mountain.Acceleration = TickAcceleration();
        }

        private void EvaluateAndTrade(double mid)
        {
            if (_mountain.Direction != Direction.Up && _mountain.Direction != Direction.Down)
                return;

            if (_trigger.MountainVersion != _mountain.Version)
                ResetTriggerForMountain();

            double noise = CurrentNoise();
            double pullbackNeed = Math.Max(CurrentSpreadPrice() * 0.60, noise * 3.5);

            if (_mountain.Direction == Direction.Up)
            {
                if (!_trigger.PullbackArmed)
                {
                    double pb = _mountain.CurrentExtreme - mid;
                    if (pb >= pullbackNeed && mid > _mountain.ProtectedPrice)
                    {
                        _trigger.PullbackArmed = true;
                        _trigger.PullbackStartExtreme = _mountain.CurrentExtreme;
                        _trigger.PullbackExtreme = mid;
                        _trigger.ArmedAt = Server.Time;
                        _trigger.TriggerId++;
                        Print("TRIGGER ARMED | #{0} UP mountain pullback | high={1:F2} lowNow={2:F2}", _trigger.TriggerId, _trigger.PullbackStartExtreme, mid);
                    }
                    return;
                }
                _trigger.PullbackExtreme = Math.Min(_trigger.PullbackExtreme, mid);
            }
            else
            {
                if (!_trigger.PullbackArmed)
                {
                    double pb = mid - _mountain.CurrentExtreme;
                    if (pb >= pullbackNeed && mid < _mountain.ProtectedPrice)
                    {
                        _trigger.PullbackArmed = true;
                        _trigger.PullbackStartExtreme = _mountain.CurrentExtreme;
                        _trigger.PullbackExtreme = mid;
                        _trigger.ArmedAt = Server.Time;
                        _trigger.TriggerId++;
                        Print("TRIGGER ARMED | #{0} DOWN mountain pullback | low={1:F2} highNow={2:F2}", _trigger.TriggerId, _trigger.PullbackStartExtreme, mid);
                    }
                    return;
                }
                _trigger.PullbackExtreme = Math.Max(_trigger.PullbackExtreme, mid);
            }

            if (!StructureStillIntact())
                return;

            EntryEvidence evidence = BuildEntryEvidence(mid);
            if (JournalDetail && evidence.Score >= EntryScoreThreshold - 0.08)
            {
                Print("ENTRY EVIDENCE | dir={0} score={1:F2} align={2:F2} vel={3:F2} accel={4:F2} break={5:F2} turn={6:F2} memory={7:F2}",
                    evidence.Direction, evidence.Score, evidence.Alignment, evidence.Velocity, evidence.Acceleration, evidence.MicroBreak, evidence.Turn, evidence.Memory);
            }

            if (evidence.Score >= EntryScoreThreshold)
                OpenTrade(evidence);
        }

        private EntryEvidence BuildEntryEvidence(double mid)
        {
            Direction direction = _mountain.Direction;
            double noise = CurrentNoise();

            int aligned = RecentDirectionScore(direction, 3);
            double alignment = aligned / 3.0;

            double shortMove = DeltaTicks(4);
            double velocityRaw = direction == Direction.Up ? shortMove : -shortMove;
            double velocity = Clamp01(0.5 + velocityRaw / Math.Max(noise * 4.0, Symbol.TickSize));

            double accelRaw = TickAcceleration();
            double accelDirectional = direction == Direction.Up ? accelRaw : -accelRaw;
            double acceleration = Clamp01(0.5 + accelDirectional / Math.Max(noise * 2.5, Symbol.TickSize));

            double microBreak = HasMicroBreak(direction, 6) ? 1.0 : 0.0;

            double turnDistance = direction == Direction.Up
                ? mid - _trigger.PullbackExtreme
                : _trigger.PullbackExtreme - mid;
            double turn = Clamp01(turnDistance / Math.Max(noise * 2.0, CurrentSpreadPrice() * 0.35));

            double memory = MemorySimilarityScore(direction, _mountain.PullbackDepth, _mountain.Progression, _mountain.Velocity);

            double score =
                alignment * 0.24 +
                velocity * 0.20 +
                acceleration * 0.14 +
                microBreak * 0.20 +
                turn * 0.17 +
                memory * 0.05;

            return new EntryEvidence
            {
                Direction = direction,
                Alignment = alignment,
                Velocity = velocity,
                Acceleration = acceleration,
                MicroBreak = microBreak,
                Turn = turn,
                Memory = memory,
                Score = score
            };
        }

        private void OpenTrade(EntryEvidence evidence)
        {
            if (GetPosition() != null)
                return;

            TradeType side = evidence.Direction == Direction.Up ? TradeType.Buy : TradeType.Sell;
            double plannedEntry = side == TradeType.Buy ? Symbol.Ask : Symbol.Bid;
            double buffer = Math.Max(CurrentSpreadPrice() * 0.30, CurrentNoise() * 1.2);
            double structuralStop = side == TradeType.Buy
                ? _trigger.PullbackExtreme - buffer
                : _trigger.PullbackExtreme + buffer;

            double riskPrice = Math.Abs(plannedEntry - structuralStop);
            double minRisk = Math.Max(CurrentSpreadPrice() * 1.10, CurrentNoise() * 4.0);
            if (riskPrice < minRisk)
                riskPrice = minRisk;

            double slPips = riskPrice / Symbol.PipSize;
            double tpPips = slPips * EmergencyTargetR;
            double riskAmount = Account.Equity * (RiskPercent / 100.0) * RiskSafetyFactor;
            double rawVolume = Symbol.VolumeForFixedRisk(riskAmount, slPips);
            double volume = Symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);

            if (volume < Symbol.VolumeInUnitsMin)
            {
                Print("ENTRY SKIP | volume {0} below minimum {1}", volume, Symbol.VolumeInUnitsMin);
                ResetTriggerForMountain();
                return;
            }

            volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

            Print("STORY ENTRY THESIS | {0} | CURRENT M1={1}/{2} protected={3:F2} | context H1={4} M15={5} M5={6} (knowledge only) | score={7:F2} plannedRisk=${8:F2}",
                side, _mountain.Direction, _mountain.Phase, _mountain.ProtectedPrice, _context.H1, _context.M15, _context.M5, evidence.Score, riskAmount);

            TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, Label, slPips, tpPips);
            Position p = result.IsSuccessful ? result.Position : null;

            if (p == null)
            {
                Print("PRIMARY ORDER FAILED | error={0} | retrying same story entry then attaching protection", result.Error);
                TradeResult retry = ExecuteMarketOrder(side, SymbolName, volume, Label);
                if (!retry.IsSuccessful || retry.Position == null)
                {
                    Print("ENTRY REJECTED | retryError={0}", retry.Error);
                    ResetTriggerForMountain();
                    return;
                }

                p = retry.Position;
                double stop = side == TradeType.Buy ? p.EntryPrice - riskPrice : p.EntryPrice + riskPrice;
                double tp = side == TradeType.Buy ? p.EntryPrice + riskPrice * EmergencyTargetR : p.EntryPrice - riskPrice * EmergencyTargetR;
                stop = Math.Round(stop, Symbol.Digits);
                tp = Math.Round(tp, Symbol.Digits);
                TradeResult protect = ModifyPosition(p, stop, tp);
                if (!protect.IsSuccessful)
                {
                    Print("FALLBACK PROTECTION FAILED | id={0} error={1} | closing", p.Id, protect.Error);
                    ClosePosition(p);
                    ResetTriggerForMountain();
                    return;
                }
            }

            _trade = new TradeState
            {
                PositionId = p.Id,
                Direction = evidence.Direction,
                EntryPhase = _mountain.Phase,
                EntryTime = Server.Time,
                EntryPrice = p.EntryPrice,
                InitialRiskDistance = p.StopLoss.HasValue ? Math.Abs(p.EntryPrice - p.StopLoss.Value) : riskPrice,
                EntryEquity = Account.Equity,
                BestR = 0,
                WorstR = 0,
                LastAppliedLockR = double.NegativeInfinity,
                EntryPullbackDepth = _mountain.PullbackDepth,
                EntryProgression = _mountain.Progression,
                EntryVelocity = _mountain.Velocity,
                EntryScore = evidence.Score,
                MountainVersion = _mountain.Version,
                TicksAlive = 0
            };
            _hadPosition = true;
            _trigger.PullbackArmed = false;

            Print("STORY ENTER {0} | id={1} entry={2:F2} SL={3} emergencyTP={4} volume={5} | mountainVersion={6}",
                side, p.Id, p.EntryPrice,
                p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "NONE",
                p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "NONE",
                p.VolumeInUnits, _mountain.Version);
        }

        private void ManageTrade(Position p)
        {
            if (_trade.InitialRiskDistance <= Symbol.TickSize)
            {
                if (p.StopLoss.HasValue)
                    _trade.InitialRiskDistance = Math.Abs(p.EntryPrice - p.StopLoss.Value);
                if (_trade.InitialRiskDistance <= Symbol.TickSize)
                    return;
            }

            _trade.TicksAlive++;
            double favorable = p.TradeType == TradeType.Buy ? Symbol.Bid - p.EntryPrice : p.EntryPrice - Symbol.Ask;
            double r = favorable / _trade.InitialRiskDistance;
            _trade.BestR = Math.Max(_trade.BestR, r);
            _trade.WorstR = Math.Min(_trade.WorstR, r);
            _trade.LastNetProfit = p.NetProfit;

            bool storyInvalid =
                _mountain.Direction == Direction.Transition ||
                (_trade.Direction == Direction.Up && _mountain.Direction == Direction.Down) ||
                (_trade.Direction == Direction.Down && _mountain.Direction == Direction.Up);

            // Do not confuse opening spread with a failed thesis. Structural invalidation is the exit authority.
            if (storyInvalid && _trade.TicksAlive >= 3)
            {
                Print("STORY INVALIDATION EXIT | id={0} tradeDir={1} currentStory={2}/{3} r={4:F2}", p.Id, _trade.Direction, _mountain.Direction, _mountain.Phase, r);
                ClosePosition(p);
                return;
            }

            if (_trade.BestR < TrailStartR)
                return;

            double desiredLockR = _trade.BestR - TrailDistanceR;
            if (_trade.BestR >= LittleWinMilestoneR)
                desiredLockR = Math.Max(desiredLockR, LittleWinLockR);

            if (!double.IsNegativeInfinity(_trade.LastAppliedLockR) && desiredLockR <= _trade.LastAppliedLockR + 0.02)
                return;

            double ratchetStop = StopForLockedR(p, desiredLockR);
            double? structureStop = RecentStructureTrail(p);
            double desired = ChooseMoreProtectiveStop(p.TradeType, ratchetStop, structureStop);

            if (!IsImprovement(p, desired))
                return;

            if (!IsValidStopSide(p.TradeType, desired))
                desired = BrokerRoomFallback(p, desiredLockR);

            if (!IsImprovement(p, desired))
                return;

            Print("TRAIL REQUEST | id={0} bestR={1:F2} currentR={2:F2} lock≈{3:F2}R oldSL={4} newSL={5:F2}",
                p.Id, _trade.BestR, r, desiredLockR,
                p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "NONE", desired);

            TradeResult result = ModifyPosition(p, desired, p.TakeProfit);
            if (result.IsSuccessful)
            {
                double actualLock = LockRFromStop(p, desired);
                _trade.LastAppliedLockR = Math.Max(_trade.LastAppliedLockR, actualLock);
                Print("TRAIL SUCCESS | id={0} newSL={1:F2} actualLock={2:F2}R bestR={3:F2}", p.Id, desired, actualLock, _trade.BestR);
                return;
            }

            Print("TRAIL REJECTED | id={0} error={1} | trying pure-R fallback", p.Id, result.Error);
            double fallback = BrokerRoomFallback(p, desiredLockR);
            if (IsImprovement(p, fallback) && IsValidStopSide(p.TradeType, fallback))
            {
                TradeResult retry = ModifyPosition(p, fallback, p.TakeProfit);
                if (retry.IsSuccessful)
                {
                    double actualLock = LockRFromStop(p, fallback);
                    _trade.LastAppliedLockR = Math.Max(_trade.LastAppliedLockR, actualLock);
                    Print("TRAIL FALLBACK SUCCESS | id={0} newSL={1:F2} actualLock={2:F2}R", p.Id, fallback, actualLock);
                    return;
                }
                Print("TRAIL FALLBACK REJECTED | id={0} error={1}", p.Id, retry.Error);
            }

            if (_trade.BestR >= LittleWinMilestoneR)
            {
                Print("TRAIL FAILSAFE EXIT | id={0} bestR={1:F2} | little-win milestone reached but broker protection failed", p.Id, _trade.BestR);
                ClosePosition(p);
            }
        }

        private void RecordClosedTradeEpisode()
        {
            if (_trade.PositionId == 0)
                return;

            TradeEpisode ep = new TradeEpisode
            {
                Direction = _trade.Direction,
                Phase = _trade.EntryPhase,
                PullbackDepth = _trade.EntryPullbackDepth,
                Progression = _trade.EntryProgression,
                Velocity = _trade.EntryVelocity,
                EntryScore = _trade.EntryScore,
                BestR = _trade.BestR,
                WorstR = _trade.WorstR,
                NetProfit = _trade.LastNetProfit,
                Won = _trade.LastNetProfit > 0,
                Time = Server.Time
            };
            _memory.Add(ep);
            if (_memory.Count > 250)
                _memory.RemoveRange(0, _memory.Count - 250);

            Print("MEMORY EPISODE STORED | n={0} dir={1} phase={2} bestR={3:F2} worstR={4:F2} lastNet={5:F2}",
                _memory.Count, ep.Direction, ep.Phase, ep.BestR, ep.WorstR, ep.NetProfit);
        }

        private double MemorySimilarityScore(Direction direction, double pullbackDepth, double progression, double velocity)
        {
            List<TradeEpisode> same = _memory.Where(x => x.Direction == direction).ToList();
            if (same.Count < 8)
                return 0.50;

            double noise = Math.Max(CurrentNoise(), Symbol.TickSize);
            var nearest = same
                .Select(x => new
                {
                    Episode = x,
                    Distance =
                        Math.Abs(x.PullbackDepth - pullbackDepth) / (noise * 8.0) +
                        Math.Abs(x.Progression - progression) * 0.8 +
                        Math.Abs(x.Velocity - velocity) / (noise * 6.0)
                })
                .OrderBy(x => x.Distance)
                .Take(12)
                .ToList();

            if (nearest.Count == 0)
                return 0.50;

            double weightedWins = 0;
            double weights = 0;
            foreach (var item in nearest)
            {
                double w = 1.0 / (1.0 + item.Distance);
                weights += w;
                weightedWins += w * (item.Episode.Won ? 1.0 : 0.0);
            }

            return weights > 0 ? weightedWins / weights : 0.50;
        }

        private void UpdateContext()
        {
            _context = new ContextSnapshot
            {
                H1 = ReadContextDirection(_h1, 12),
                M15 = ReadContextDirection(_m15, 16),
                M5 = ReadContextDirection(_m5, 18),
                H1RangePosition = ReadRangePosition(_h1, 20),
                M15RangePosition = ReadRangePosition(_m15, 24),
                M5RangePosition = ReadRangePosition(_m5, 30),
                UpdatedAt = Server.Time
            };
            _lastContextUpdate = Server.Time;
        }

        private Direction ReadContextDirection(Bars bars, int lookback)
        {
            if (bars == null || bars.Count < lookback + 3)
                return Direction.Unknown;

            int last = bars.Count - 2;
            int start = Math.Max(0, last - lookback);
            double net = bars.ClosePrices[last] - bars.ClosePrices[start];
            double path = 0;
            for (int i = start + 1; i <= last; i++)
                path += Math.Abs(bars.ClosePrices[i] - bars.ClosePrices[i - 1]);

            if (path <= Symbol.TickSize)
                return Direction.Unknown;

            double efficiency = Math.Abs(net) / path;
            if (efficiency < 0.18)
                return Direction.Unknown;
            return net >= 0 ? Direction.Up : Direction.Down;
        }

        private double ReadRangePosition(Bars bars, int lookback)
        {
            if (bars == null || bars.Count < lookback + 3)
                return 0.5;

            int last = bars.Count - 2;
            int start = Math.Max(0, last - lookback);
            double high = double.MinValue;
            double low = double.MaxValue;
            for (int i = start; i <= last; i++)
            {
                high = Math.Max(high, bars.HighPrices[i]);
                low = Math.Min(low, bars.LowPrices[i]);
            }
            if (high <= low)
                return 0.5;
            return Clamp01((bars.ClosePrices[last] - low) / (high - low));
        }

        private void AddDirectionalLeg(double newExtreme, DateTime time)
        {
            if (_mountain.CurrentExtreme <= 0)
                return;

            double distance = Math.Abs(newExtreme - _mountain.CurrentExtreme);
            double duration = _mountain.Legs.Count == 0
                ? Math.Max(1.0, (time - _mountain.StartedAt).TotalSeconds)
                : Math.Max(1.0, (time - _mountain.Legs.Last().EndTime).TotalSeconds);

            _mountain.Legs.Add(new Leg { Distance = distance, DurationSeconds = duration, EndTime = time });
            if (_mountain.Legs.Count > 12)
                _mountain.Legs.RemoveAt(0);

            if (_mountain.Legs.Count >= 2)
            {
                double prev = _mountain.Legs[_mountain.Legs.Count - 2].Distance;
                _mountain.Progression = prev > Symbol.TickSize ? distance / prev : 1.0;
            }
        }

        private void RebuildLegMetrics()
        {
            _mountain.Legs.Clear();
            List<SwingPoint> directional = _mountain.Direction == Direction.Up
                ? _swings.Where(x => x.Kind == SwingKind.High).TakeLast(6).ToList()
                : _swings.Where(x => x.Kind == SwingKind.Low).TakeLast(6).ToList();

            for (int i = 1; i < directional.Count; i++)
            {
                double distance = Math.Abs(directional[i].Price - directional[i - 1].Price);
                double duration = Math.Max(1.0, (directional[i].Time - directional[i - 1].Time).TotalSeconds);
                _mountain.Legs.Add(new Leg { Distance = distance, DurationSeconds = duration, EndTime = directional[i].Time });
            }

            if (_mountain.Legs.Count >= 2)
            {
                double prev = _mountain.Legs[_mountain.Legs.Count - 2].Distance;
                double last = _mountain.Legs[_mountain.Legs.Count - 1].Distance;
                _mountain.Progression = prev > Symbol.TickSize ? last / prev : 1.0;
            }
        }

        private bool IsExhausting()
        {
            if (_mountain.Legs.Count < 3)
                return false;

            Leg a = _mountain.Legs[_mountain.Legs.Count - 3];
            Leg b = _mountain.Legs[_mountain.Legs.Count - 2];
            Leg c = _mountain.Legs[_mountain.Legs.Count - 1];
            bool shrinking = c.Distance < b.Distance * 0.75 && b.Distance < a.Distance * 0.90;
            bool slower = c.DurationSeconds > b.DurationSeconds * 1.10;
            return shrinking && slower;
        }

        private bool StructureStillIntact()
        {
            if (_mountain.Direction == Direction.Up)
                return _mountain.ProtectedPrice <= 0 || Symbol.Bid > _mountain.ProtectedPrice;
            if (_mountain.Direction == Direction.Down)
                return _mountain.ProtectedPrice <= 0 || Symbol.Ask < _mountain.ProtectedPrice;
            return false;
        }

        private int RecentDirectionScore(Direction direction, int count)
        {
            if (_ticks.Count < count + 1)
                return 0;

            int score = 0;
            for (int i = _ticks.Count - count; i < _ticks.Count; i++)
            {
                double delta = _ticks[i].Mid - _ticks[i - 1].Mid;
                if (direction == Direction.Up && delta > 0) score++;
                if (direction == Direction.Down && delta < 0) score++;
            }
            return score;
        }

        private bool HasMicroBreak(Direction direction, int lookback)
        {
            if (_ticks.Count < lookback + 2)
                return false;

            int current = _ticks.Count - 1;
            int start = current - lookback;
            if (direction == Direction.Up)
            {
                double priorHigh = double.MinValue;
                for (int i = start; i < current; i++)
                    priorHigh = Math.Max(priorHigh, _ticks[i].Ask);
                return Symbol.Ask > priorHigh;
            }
            else
            {
                double priorLow = double.MaxValue;
                for (int i = start; i < current; i++)
                    priorLow = Math.Min(priorLow, _ticks[i].Bid);
                return Symbol.Bid < priorLow;
            }
        }

        private double DeltaTicks(int lookback)
        {
            if (_ticks.Count < lookback + 1)
                return 0;
            return _ticks[_ticks.Count - 1].Mid - _ticks[_ticks.Count - 1 - lookback].Mid;
        }

        private double TickAcceleration()
        {
            if (_ticks.Count < 8)
                return 0;

            double recent = 0;
            double prior = 0;
            for (int i = _ticks.Count - 3; i < _ticks.Count; i++)
                recent += _ticks[i].Mid - _ticks[i - 1].Mid;
            for (int i = _ticks.Count - 6; i < _ticks.Count - 3; i++)
                prior += _ticks[i].Mid - _ticks[i - 1].Mid;

            return recent / 3.0 - prior / 3.0;
        }

        private double? RecentStructureTrail(Position p)
        {
            if (_ticks.Count < 10 || _trade.InitialRiskDistance <= Symbol.TickSize)
                return null;

            int from = Math.Max(2, _ticks.Count - 28);
            int to = _ticks.Count - 3;
            double buffer = Math.Max(CurrentSpreadPrice() * 0.18, CurrentNoise());
            double breathe = Math.Max(_trade.InitialRiskDistance * 0.10, CurrentSpreadPrice() * 0.35);

            if (p.TradeType == TradeType.Buy)
            {
                for (int i = to; i >= from; i--)
                {
                    double x = _ticks[i].Bid;
                    if (x <= _ticks[i - 1].Bid && x <= _ticks[i - 2].Bid && x < _ticks[i + 1].Bid && x <= _ticks[i + 2].Bid)
                    {
                        double candidate = x - buffer;
                        if (candidate < Symbol.Bid - breathe)
                            return candidate;
                    }
                }
            }
            else
            {
                for (int i = to; i >= from; i--)
                {
                    double x = _ticks[i].Ask;
                    if (x >= _ticks[i - 1].Ask && x >= _ticks[i - 2].Ask && x > _ticks[i + 1].Ask && x >= _ticks[i + 2].Ask)
                    {
                        double candidate = x + buffer;
                        if (candidate > Symbol.Ask + breathe)
                            return candidate;
                    }
                }
            }
            return null;
        }

        private double ChooseMoreProtectiveStop(TradeType side, double ratchet, double? structure)
        {
            if (!structure.HasValue)
                return ratchet;
            return side == TradeType.Buy ? Math.Max(ratchet, structure.Value) : Math.Min(ratchet, structure.Value);
        }

        private double StopForLockedR(Position p, double lockR)
        {
            return p.TradeType == TradeType.Buy
                ? p.EntryPrice + lockR * _trade.InitialRiskDistance
                : p.EntryPrice - lockR * _trade.InitialRiskDistance;
        }

        private double LockRFromStop(Position p, double stop)
        {
            if (_trade.InitialRiskDistance <= Symbol.TickSize)
                return double.NegativeInfinity;
            return p.TradeType == TradeType.Buy
                ? (stop - p.EntryPrice) / _trade.InitialRiskDistance
                : (p.EntryPrice - stop) / _trade.InitialRiskDistance;
        }

        private double BrokerRoomFallback(Position p, double lockR)
        {
            double room = Math.Max(CurrentSpreadPrice() * 0.60, Math.Max(CurrentNoise() * 1.5, Symbol.TickSize * 10));
            double lockStop = StopForLockedR(p, lockR);
            return p.TradeType == TradeType.Buy
                ? Math.Min(Symbol.Bid - room, lockStop)
                : Math.Max(Symbol.Ask + room, lockStop);
        }

        private bool IsValidStopSide(TradeType side, double stop)
        {
            double room = Math.Max(Symbol.TickSize * 3, CurrentSpreadPrice() * 0.08);
            return side == TradeType.Buy ? stop < Symbol.Bid - room : stop > Symbol.Ask + room;
        }

        private bool IsImprovement(Position p, double candidate)
        {
            if (!p.StopLoss.HasValue)
                return true;
            return p.TradeType == TradeType.Buy
                ? candidate > p.StopLoss.Value + Symbol.TickSize
                : candidate < p.StopLoss.Value - Symbol.TickSize;
        }

        private void ResetTriggerForMountain()
        {
            _trigger = new TriggerState
            {
                MountainVersion = _mountain.Version,
                TriggerId = _trigger != null ? _trigger.TriggerId : 0
            };
        }

        private void ResetTradeState()
        {
            _trade = new TradeState();
        }

        private Position GetPosition()
        {
            return Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);
        }

        private double MidPrice()
        {
            return (Symbol.Bid + Symbol.Ask) * 0.5;
        }

        private double CurrentSpreadPrice()
        {
            return Math.Max(Symbol.Ask - Symbol.Bid, Symbol.TickSize * 2);
        }

        private double CurrentNoise()
        {
            return Math.Max(_emaAbsTick, Symbol.TickSize * 5);
        }

        private double Clamp01(double x)
        {
            return Math.Max(0.0, Math.Min(1.0, x));
        }

        private void PrintStory(string tag)
        {
            if (!JournalDetail && tag == "LIVE")
                return;

            double memoryScore = MemorySimilarityScore(_mountain.Direction, _mountain.PullbackDepth, _mountain.Progression, _mountain.Velocity);
            Print("STORY {0} | CURRENT M1={1}/{2} v={3} protected={4:F2} extreme={5:F2} pb={6:F2} progression={7:F2} cont={8} | CONTEXT H1={9} M15={10} M5={11} | trigger={12} memoryN={13} memScore={14:F2}",
                tag,
                _mountain.Direction,
                _mountain.Phase,
                _mountain.Version,
                _mountain.ProtectedPrice,
                _mountain.CurrentExtreme,
                _mountain.PullbackDepth,
                _mountain.Progression,
                _mountain.Continuations,
                _context.H1,
                _context.M15,
                _context.M5,
                _trigger.PullbackArmed ? "ARMED" : "WAIT_PULLBACK",
                _memory.Count,
                memoryScore);
        }
    }
}
