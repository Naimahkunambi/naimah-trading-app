using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class NaiMountainBrainTraderV5 : Robot
    {
        private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V5";

        [Parameter("Risk %", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 2.00, Step = 0.05)]
        public double RiskPercent { get; set; }

        [Parameter("Risk Safety Factor", DefaultValue = 0.60, MinValue = 0.35, MaxValue = 1.00, Step = 0.05)]
        public double RiskSafetyFactor { get; set; }

        [Parameter("Little Win Milestone R", DefaultValue = 0.45, MinValue = 0.25, MaxValue = 1.00, Step = 0.05)]
        public double LittleWinMilestoneR { get; set; }

        [Parameter("Emergency TP R", DefaultValue = 3.00, MinValue = 1.50, MaxValue = 6.00, Step = 0.25)]
        public double EmergencyTargetR { get; set; }

        [Parameter("Trail Giveback Min R", DefaultValue = 0.25, MinValue = 0.10, MaxValue = 0.60, Step = 0.05)]
        public double TrailGivebackMinR { get; set; }

        [Parameter("Trail Giveback %", DefaultValue = 30.0, MinValue = 15.0, MaxValue = 60.0, Step = 5.0)]
        public double TrailGivebackPercent { get; set; }

        [Parameter("Min Trail Step R", DefaultValue = 0.05, MinValue = 0.02, MaxValue = 0.20, Step = 0.01)]
        public double MinTrailStepR { get; set; }

        [Parameter("Early Failure Exit R", DefaultValue = 0.30, MinValue = 0.15, MaxValue = 0.60, Step = 0.05)]
        public double EarlyFailureR { get; set; }

        [Parameter("Min Pullback / Impulse", DefaultValue = 0.20, MinValue = 0.10, MaxValue = 0.50, Step = 0.05)]
        public double MinPullbackRatio { get; set; }

        [Parameter("Max Pullback / Impulse", DefaultValue = 0.72, MinValue = 0.50, MaxValue = 0.95, Step = 0.05)]
        public double MaxPullbackRatio { get; set; }

        [Parameter("Min Reaction / Pullback", DefaultValue = 0.32, MinValue = 0.15, MaxValue = 0.70, Step = 0.05)]
        public double MinReactionRatio { get; set; }

        [Parameter("M5 Lookback Bars", DefaultValue = 12, MinValue = 6, MaxValue = 30)]
        public int M5LookbackBars { get; set; }

        [Parameter("Min M5 Efficiency", DefaultValue = 0.20, MinValue = 0.05, MaxValue = 0.60, Step = 0.05)]
        public double MinM5Efficiency { get; set; }

        [Parameter("Journal Detail", DefaultValue = true)]
        public bool JournalDetail { get; set; }

        private Bars _m5;
        private Bars _m1;
        private readonly List<TickPoint> _ticks = new List<TickPoint>();
        private double _lastMid;
        private double _emaAbsTick;
        private TradeType? _contextSide;
        private CycleState _state = CycleState.SeekingImpulse;
        private int _cycleId = 1;

        private double _anchor;
        private double _impulseStart;
        private double _impulseExtreme;
        private double _pullbackExtreme;
        private double _reactionExtreme;
        private double _bounceExtreme;
        private double _breakLevel;
        private double _impulseDistance;
        private double _pullbackDistance;

        private bool _hadPosition;
        private double _entryEquity;
        private double _initialRiskDistance;
        private double _highestR;
        private DateTime _entryTime;
        private DateTime _lastStatusPrint = DateTime.MinValue;
        private bool _ratchetArmed;
        private double _lastAppliedLockR = double.NegativeInfinity;
        private int _consecutiveTrailRejects;

        private enum CycleState
        {
            SeekingImpulse,
            SeekingPullback,
            PullbackBuilding,
            ReactionLeg,
            AwaitingBreak,
            InTrade
        }

        private enum LocalBias
        {
            Down,
            Neutral,
            Up
        }

        private class TickPoint
        {
            public DateTime Time { get; set; }
            public double Mid { get; set; }
            public double Bid { get; set; }
            public double Ask { get; set; }
        }

        protected override void OnStart()
        {
            if (Account.IsLive)
            {
                Print("V5 SAFETY | LIVE ACCOUNT DETECTED | STOPPING. DEMO ONLY.");
                Stop();
                return;
            }

            _m5 = MarketData.GetBars(TimeFrame.Minute5);
            _m1 = MarketData.GetBars(TimeFrame.Minute);
            _lastMid = MidPrice();
            _anchor = _lastMid;

            Print("NAI MOUNTAIN BRAIN TRADER V5 WATERFALL RATCHET STARTED | DEMO ONLY");
            Print("ENTRY ENGINE | frozen from V4");
            Print("EXIT ENGINE | little-win milestone becomes profit lock, not normal exit");
            Print("RATCHET | follows BEST R only forward + confirmed micro structure | never loosens stop");
            Print("EMERGENCY TP | {0:F2}R ceiling", EmergencyTargetR);
        }

        protected override void OnTick()
        {
            double mid = MidPrice();
            UpdateTickTape(mid);

            Position position = GetPosition();
            if (position != null)
            {
                _hadPosition = true;
                _state = CycleState.InTrade;
                ManageOpenPosition(position);
                _lastMid = mid;
                return;
            }

            if (_hadPosition)
            {
                Print("V5 RESET | prior trade closed | old setup retired | fresh impulse + meaningful pullback required");
                _hadPosition = false;
                ResetTradeMemory();
                BeginFreshCycle(mid, _contextSide);
            }

            TradeType? newContext = ReadM5Context();
            if (newContext != _contextSide)
            {
                string oldText = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
                string newText = newContext.HasValue ? newContext.Value.ToString() : "NEUTRAL";
                Print("V5 CONTEXT | {0} -> {1} | local cycle reset", oldText, newText);
                _contextSide = newContext;
                BeginFreshCycle(mid, newContext);
            }

            if (_contextSide.HasValue)
                AdvanceCycle(_contextSide.Value, mid);

            if (Server.Time - _lastStatusPrint >= TimeSpan.FromSeconds(15))
            {
                _lastStatusPrint = Server.Time;
                PrintStatus(mid);
            }

            _lastMid = mid;
        }

        private void UpdateTickTape(double mid)
        {
            if (_lastMid > 0)
            {
                double move = Math.Abs(mid - _lastMid);
                if (move > 0)
                    _emaAbsTick = _emaAbsTick <= 0 ? move : (_emaAbsTick * 0.94 + move * 0.06);
            }

            _ticks.Add(new TickPoint
            {
                Time = Server.Time,
                Mid = mid,
                Bid = Symbol.Bid,
                Ask = Symbol.Ask
            });

            if (_ticks.Count > 300)
                _ticks.RemoveRange(0, _ticks.Count - 300);
        }

        private TradeType? ReadM5Context()
        {
            if (_m5 == null || _m5.Count < M5LookbackBars + 3)
                return null;

            int last = _m5.Count - 2;
            int start = Math.Max(0, last - M5LookbackBars);
            if (last <= start)
                return null;

            double first = _m5.ClosePrices[start];
            double final = _m5.ClosePrices[last];
            double net = final - first;
            double path = 0;

            for (int i = start + 1; i <= last; i++)
                path += Math.Abs(_m5.ClosePrices[i] - _m5.ClosePrices[i - 1]);

            if (path <= Symbol.TickSize)
                return null;

            double efficiency = Math.Abs(net) / path;
            int recentStart = Math.Max(start, last - 3);
            double recentNet = final - _m5.ClosePrices[recentStart];
            double meaningful = Math.Max(CurrentSpreadPrice() * 3.0, NoisePrice() * 18.0);

            bool sameSign = Math.Sign(net) == Math.Sign(recentNet) && Math.Sign(net) != 0;
            bool directional = efficiency >= MinM5Efficiency || (sameSign && Math.Abs(net) >= meaningful);

            if (!directional || Math.Abs(net) < meaningful * 0.40)
                return null;

            return net > 0 ? TradeType.Buy : TradeType.Sell;
        }

        private LocalBias ReadLocalM1Bias(double liveMid)
        {
            if (_m1 == null || _m1.Count < 7)
                return LocalBias.Neutral;

            int lastClosed = _m1.Count - 2;
            int start = Math.Max(0, lastClosed - 3);
            double first = _m1.ClosePrices[start];
            double net = liveMid - first;
            double path = 0;
            double previous = first;

            for (int i = start + 1; i <= lastClosed; i++)
            {
                path += Math.Abs(_m1.ClosePrices[i] - previous);
                previous = _m1.ClosePrices[i];
            }
            path += Math.Abs(liveMid - previous);

            if (path <= Symbol.TickSize)
                return LocalBias.Neutral;

            double efficiency = Math.Abs(net) / path;
            double threshold = Math.Max(CurrentSpreadPrice() * 0.80, NoisePrice() * 8.0);

            if (Math.Abs(net) < threshold || efficiency < 0.42)
                return LocalBias.Neutral;

            return net > 0 ? LocalBias.Up : LocalBias.Down;
        }

        private void AdvanceCycle(TradeType side, double mid)
        {
            double impulseNeed = ImpulseThreshold();
            double pullbackNeed = PullbackThreshold();
            double turnNeed = TurnThreshold();
            double bounceNeed = MicroBounceThreshold();
            double breakBuffer = BreakBuffer();

            if (_state == CycleState.SeekingImpulse)
            {
                if (side == TradeType.Sell)
                    _anchor = Math.Max(_anchor, mid);
                else
                    _anchor = Math.Min(_anchor, mid);

                double impulse = side == TradeType.Sell ? _anchor - mid : mid - _anchor;
                if (impulse >= impulseNeed)
                {
                    _impulseStart = _anchor;
                    _impulseExtreme = mid;
                    _impulseDistance = impulse;
                    _state = CycleState.SeekingPullback;
                    LogState("IMPULSE READY", side, mid, impulse, impulseNeed);
                }
                return;
            }

            if (_state == CycleState.SeekingPullback)
            {
                if (side == TradeType.Sell)
                    _impulseExtreme = Math.Min(_impulseExtreme, mid);
                else
                    _impulseExtreme = Math.Max(_impulseExtreme, mid);

                _impulseDistance = Math.Abs(_impulseStart - _impulseExtreme);
                double pullback = side == TradeType.Sell ? mid - _impulseExtreme : _impulseExtreme - mid;

                if (pullback >= pullbackNeed)
                {
                    _pullbackExtreme = mid;
                    _pullbackDistance = pullback;
                    _state = CycleState.PullbackBuilding;
                    LogState("PULLBACK ARMED", side, mid, pullback, pullbackNeed);
                }
                return;
            }

            if (_state == CycleState.PullbackBuilding)
            {
                if (side == TradeType.Sell)
                {
                    _pullbackExtreme = Math.Max(_pullbackExtreme, mid);
                    _pullbackDistance = _pullbackExtreme - _impulseExtreme;

                    if (mid >= _impulseStart)
                    {
                        RejectAndRestart(side, mid, "pullback erased the sell impulse");
                        return;
                    }

                    if (_pullbackExtreme - mid >= turnNeed)
                    {
                        _reactionExtreme = mid;
                        _state = CycleState.ReactionLeg;
                        LogState("PULLBACK PEAK TURNED", side, mid, _pullbackExtreme - mid, turnNeed);
                    }
                }
                else
                {
                    _pullbackExtreme = Math.Min(_pullbackExtreme, mid);
                    _pullbackDistance = _impulseExtreme - _pullbackExtreme;

                    if (mid <= _impulseStart)
                    {
                        RejectAndRestart(side, mid, "pullback erased the buy impulse");
                        return;
                    }

                    if (mid - _pullbackExtreme >= turnNeed)
                    {
                        _reactionExtreme = mid;
                        _state = CycleState.ReactionLeg;
                        LogState("PULLBACK TROUGH TURNED", side, mid, mid - _pullbackExtreme, turnNeed);
                    }
                }
                return;
            }

            if (_state == CycleState.ReactionLeg)
            {
                if (side == TradeType.Sell)
                {
                    if (mid > _pullbackExtreme)
                    {
                        _pullbackExtreme = mid;
                        _pullbackDistance = _pullbackExtreme - _impulseExtreme;
                        _state = CycleState.PullbackBuilding;
                        LogSimple("LOCAL BUY STILL ALIVE | new pullback high | no SELL");
                        return;
                    }

                    _reactionExtreme = Math.Min(_reactionExtreme, mid);
                    double reaction = _pullbackExtreme - _reactionExtreme;
                    if (reaction >= bounceNeed && ReactionRatio(reaction) >= MinReactionRatio)
                    {
                        _breakLevel = _reactionExtreme;
                        _bounceExtreme = mid;
                        _state = CycleState.AwaitingBreak;
                        LogState("BEARISH REACTION ESTABLISHED", side, mid, reaction, _pullbackDistance * MinReactionRatio);
                    }
                }
                else
                {
                    if (mid < _pullbackExtreme)
                    {
                        _pullbackExtreme = mid;
                        _pullbackDistance = _impulseExtreme - _pullbackExtreme;
                        _state = CycleState.PullbackBuilding;
                        LogSimple("LOCAL SELL STILL ALIVE | new pullback low | no BUY");
                        return;
                    }

                    _reactionExtreme = Math.Max(_reactionExtreme, mid);
                    double reaction = _reactionExtreme - _pullbackExtreme;
                    if (reaction >= bounceNeed && ReactionRatio(reaction) >= MinReactionRatio)
                    {
                        _breakLevel = _reactionExtreme;
                        _bounceExtreme = mid;
                        _state = CycleState.AwaitingBreak;
                        LogState("BULLISH REACTION ESTABLISHED", side, mid, reaction, _pullbackDistance * MinReactionRatio);
                    }
                }
                return;
            }

            if (_state == CycleState.AwaitingBreak)
            {
                if (side == TradeType.Sell)
                {
                    _bounceExtreme = Math.Max(_bounceExtreme, mid);
                    if (mid > _pullbackExtreme)
                    {
                        _pullbackExtreme = mid;
                        _pullbackDistance = _pullbackExtreme - _impulseExtreme;
                        _state = CycleState.PullbackBuilding;
                        LogSimple("LOCAL BUY RECLAIMED HIGH | sell thesis cancelled");
                        return;
                    }

                    if (mid <= _breakLevel - breakBuffer)
                        TryEnter(side, mid);
                }
                else
                {
                    _bounceExtreme = Math.Min(_bounceExtreme, mid);
                    if (mid < _pullbackExtreme)
                    {
                        _pullbackExtreme = mid;
                        _pullbackDistance = _impulseExtreme - _pullbackExtreme;
                        _state = CycleState.PullbackBuilding;
                        LogSimple("LOCAL SELL RECLAIMED LOW | buy thesis cancelled");
                        return;
                    }

                    if (mid >= _breakLevel + breakBuffer)
                        TryEnter(side, mid);
                }
            }
        }

        private void TryEnter(TradeType side, double mid)
        {
            if (_impulseDistance <= Symbol.TickSize || _pullbackDistance <= Symbol.TickSize)
                return;

            double pullbackRatio = _pullbackDistance / _impulseDistance;
            if (pullbackRatio < MinPullbackRatio)
            {
                Print("V5 NO CHASE | cycle={0} {1} | pullback only {2:P0} of impulse | waterfall / tiny reset rejected", _cycleId, side, pullbackRatio);
                BeginFreshCycle(mid, side);
                return;
            }

            if (pullbackRatio > MaxPullbackRatio)
            {
                Print("V5 NO ENTRY | cycle={0} {1} | pullback {2:P0} of impulse is too deep | old context may be failing", _cycleId, side, pullbackRatio);
                BeginFreshCycle(mid, side);
                return;
            }

            LocalBias localBias = ReadLocalM1Bias(mid);
            if (side == TradeType.Sell && localBias == LocalBias.Up)
            {
                if (JournalDetail)
                    Print("V5 WAIT | context=SELL but LOCAL M1=UP | context is not permission | waiting for local buy to fail");
                return;
            }
            if (side == TradeType.Buy && localBias == LocalBias.Down)
            {
                if (JournalDetail)
                    Print("V5 WAIT | context=BUY but LOCAL M1=DOWN | context is not permission | waiting for local sell to fail");
                return;
            }

            int aligned = AlignedRecentTicks(side, 5);
            double shortMove = DeltaTicks(5);
            double mediumMove = DeltaTicks(12);
            double noise = NoisePrice();

            bool tickResumption = aligned >= 3 && (side == TradeType.Sell ? shortMove < -noise * 0.60 : shortMove > noise * 0.60);
            bool mediumNotOpposing = side == TradeType.Sell ? mediumMove <= noise * 2.0 : mediumMove >= -noise * 2.0;

            if (!tickResumption || !mediumNotOpposing)
            {
                if (JournalDetail)
                    Print("V5 BREAK WAIT | cycle={0} {1} | aligned={2}/5 short={3:F2} medium={4:F2} | structure broke but follow-through not ready", _cycleId, side, aligned, shortMove, mediumMove);
                return;
            }

            OpenTrade(side, mid, pullbackRatio, localBias, aligned, shortMove, mediumMove);
        }

        private void OpenTrade(TradeType side, double mid, double pullbackRatio, LocalBias localBias, int aligned, double shortMove, double mediumMove)
        {
            if (GetPosition() != null)
                return;

            double spread = CurrentSpreadPrice();
            double stopBuffer = Math.Max(spread * 0.25, NoisePrice() * 1.25);
            double plannedEntry = side == TradeType.Buy ? Symbol.Ask : Symbol.Bid;
            double structuralStop = side == TradeType.Sell ? _pullbackExtreme + stopBuffer : _pullbackExtreme - stopBuffer;
            double riskPrice = Math.Abs(plannedEntry - structuralStop);
            double minRiskPrice = Math.Max(spread * 1.05, NoisePrice() * 3.5);

            if (riskPrice < minRiskPrice)
                riskPrice = minRiskPrice;

            double slPips = riskPrice / Symbol.PipSize;
            double tpPips = slPips * EmergencyTargetR;
            double riskAmount = Account.Equity * (RiskPercent / 100.0) * RiskSafetyFactor;
            double rawVolume = Symbol.VolumeForFixedRisk(riskAmount, slPips);
            double volume = Symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);

            if (volume < Symbol.VolumeInUnitsMin)
            {
                Print("V5 ENTRY SKIP | volume {0} below minimum {1}", volume, Symbol.VolumeInUnitsMin);
                BeginFreshCycle(mid, side);
                return;
            }

            volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

            Print("V5 THESIS | {0} | V4 ENTRY FROZEN | pb/imp={1:P0} localM1={2} aligned={3}/5 short={4:F2} medium={5:F2} | littleWin={6:F2}R emergencyTP={7:F2}R plannedRisk=${8:F2}",
                side, pullbackRatio, localBias, aligned, shortMove, mediumMove, LittleWinMilestoneR, EmergencyTargetR, riskAmount);

            TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, Label, slPips, tpPips);
            if (!result.IsSuccessful || result.Position == null)
            {
                Print("V5 ENTRY REJECTED | error={0}", result.Error);
                BeginFreshCycle(mid, side);
                return;
            }

            Position p = result.Position;
            _entryEquity = Account.Equity;
            _initialRiskDistance = p.StopLoss.HasValue ? Math.Abs(p.EntryPrice - p.StopLoss.Value) : riskPrice;
            _highestR = 0;
            _entryTime = Server.Time;
            _hadPosition = true;
            _state = CycleState.InTrade;
            _ratchetArmed = false;
            _lastAppliedLockR = double.NegativeInfinity;
            _consecutiveTrailRejects = 0;

            Print("V5 ENTER {0} | id={1} entry={2:F2} SL={3} emergencyTP={4} volume={5} | waterfall ratchet mode",
                side,
                p.Id,
                p.EntryPrice,
                p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "NONE",
                p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "NONE",
                p.VolumeInUnits);
        }

        private void ManageOpenPosition(Position p)
        {
            if (_initialRiskDistance <= Symbol.TickSize)
            {
                if (p.StopLoss.HasValue)
                    _initialRiskDistance = Math.Abs(p.EntryPrice - p.StopLoss.Value);
                if (_initialRiskDistance <= Symbol.TickSize)
                    return;
            }

            double favorable = p.TradeType == TradeType.Buy ? Symbol.Bid - p.EntryPrice : p.EntryPrice - Symbol.Ask;
            double r = favorable / _initialRiskDistance;
            _highestR = Math.Max(_highestR, r);
            double seconds = (Server.Time - _entryTime).TotalSeconds;

            double hardLossCap = _entryEquity * (RiskPercent / 100.0) * 0.75;
            if (p.NetProfit <= -hardLossCap)
            {
                Print("V5 HARD LOSS CAP | id={0} net={1:F2} cap={2:F2} | closing", p.Id, p.NetProfit, hardLossCap);
                ClosePosition(p);
                return;
            }

            // Frozen V4 bad-trade exits.
            if (_highestR < 0.10 && r <= -EarlyFailureR)
            {
                Print("V5 EARLY FAILURE EXIT | id={0} r={1:F2} bestR={2:F2} | no follow-through after entry", p.Id, r, _highestR);
                ClosePosition(p);
                return;
            }

            if (seconds >= 20 && _highestR < 0.10 && r < -0.10)
            {
                Print("V5 STALE THESIS EXIT | id={0} age={1:F0}s r={2:F2} bestR={3:F2} | trade never proved itself", p.Id, seconds, r, _highestR);
                ClosePosition(p);
                return;
            }

            LocalBias liveLocal = ReadLocalM1Bias(MidPrice());
            bool localAgainst = p.TradeType == TradeType.Sell ? liveLocal == LocalBias.Up : liveLocal == LocalBias.Down;
            if (localAgainst && _highestR < 0.12 && r <= -0.18)
            {
                Print("V5 LOCAL INVALIDATION EXIT | id={0} local={1} r={2:F2} bestR={3:F2}", p.Id, liveLocal, r, _highestR);
                ClosePosition(p);
                return;
            }

            if (!_ratchetArmed && _highestR >= LittleWinMilestoneR)
            {
                _ratchetArmed = true;
                Print("V5 LITTLE WIN SECURED MODE ARMED | id={0} bestR={1:F2} | fixed small TP ignored; now milking waterfall with ratchet", p.Id, _highestR);
            }

            double? lockR = RequiredLockRFromBestR(_highestR);
            if (!lockR.HasValue)
                return;

            // Move only in meaningful R steps to avoid broker modification spam.
            if (!double.IsNegativeInfinity(_lastAppliedLockR) && lockR.Value < _lastAppliedLockR + MinTrailStepR)
                return;

            double ratchetStop = StopForLockedR(p, lockR.Value);
            double? structureStop = _ratchetArmed ? ConfirmedMicroStructureStop(p) : null;
            double desired = MoreProtectiveStop(p.TradeType, ratchetStop, structureStop);

            if (!IsImprovement(p, desired))
                return;

            if (!IsValidStopSide(p.TradeType, desired))
                desired = BrokerRoomFallback(p, lockR.Value);

            if (!IsImprovement(p, desired))
                return;

            if (TryProtect(p, desired, lockR.Value, r, "RATCHET+STRUCTURE"))
                return;

            // Structure can be rejected if too close. Fall back to the pure R ratchet.
            if (Math.Abs(desired - ratchetStop) > Symbol.TickSize && IsImprovement(p, ratchetStop) && IsValidStopSide(p.TradeType, ratchetStop))
            {
                if (TryProtect(p, ratchetStop, lockR.Value, r, "PURE-R-RATCHET"))
                    return;
            }

            double brokerFallback = BrokerRoomFallback(p, lockR.Value);
            if (IsImprovement(p, brokerFallback) && IsValidStopSide(p.TradeType, brokerFallback))
            {
                if (TryProtect(p, brokerFallback, lockR.Value, r, "BROKER-ROOM-FALLBACK"))
                    return;
            }

            _consecutiveTrailRejects++;
            Print("V5 TRAIL ALL REJECTED | id={0} count={1} bestR={2:F2} currentR={3:F2}", p.Id, _consecutiveTrailRejects, _highestR, r);

            // Once the little-win milestone has been reached, repeated inability to protect is unacceptable.
            if (_ratchetArmed && _consecutiveTrailRejects >= 3)
            {
                Print("V5 PROTECTION FAILSAFE EXIT | id={0} | ratchet armed but broker rejected 3 protection attempts", p.Id);
                ClosePosition(p);
            }
        }

        private double? RequiredLockRFromBestR(double bestR)
        {
            // Before the little-win milestone, preserve V4's gentle protection personality.
            if (bestR < LittleWinMilestoneR)
            {
                if (bestR >= 0.28) return 0.05;
                if (bestR >= 0.18) return -0.10;
                return null;
            }

            // Once the little win is reached, it becomes a floor, not an exit.
            // Allow the market to breathe by giving back either a minimum R amount or a percentage of MFE.
            double giveback = Math.Max(TrailGivebackMinR, bestR * (TrailGivebackPercent / 100.0));
            double lockR = bestR - giveback;

            // At the 0.45R default milestone, guarantee at least about +0.20R.
            double milestoneFloor = Math.Max(0.05, LittleWinMilestoneR - TrailGivebackMinR);
            return Math.Max(milestoneFloor, lockR);
        }

        private double StopForLockedR(Position p, double lockR)
        {
            return p.TradeType == TradeType.Buy
                ? p.EntryPrice + lockR * _initialRiskDistance
                : p.EntryPrice - lockR * _initialRiskDistance;
        }

        private double? ConfirmedMicroStructureStop(Position p)
        {
            if (_ticks.Count < 9)
                return null;

            int from = Math.Max(2, _ticks.Count - 24);
            int to = _ticks.Count - 3; // require two later ticks to confirm the swing
            if (to < from)
                return null;

            double buffer = Math.Max(CurrentSpreadPrice() * 0.18, NoisePrice() * 1.0);

            if (p.TradeType == TradeType.Sell)
            {
                for (int i = to; i >= from; i--)
                {
                    double x = _ticks[i].Ask;
                    if (x >= _ticks[i - 1].Ask && x >= _ticks[i - 2].Ask &&
                        x > _ticks[i + 1].Ask && x >= _ticks[i + 2].Ask)
                    {
                        double candidate = x + buffer;
                        // Do not strangle the waterfall. Leave at least 0.12R of breathing room from current ask.
                        if (candidate >= Symbol.Ask + Math.Max(_initialRiskDistance * 0.12, CurrentSpreadPrice() * 0.40))
                            return candidate;
                    }
                }
                return null;
            }

            for (int i = to; i >= from; i--)
            {
                double x = _ticks[i].Bid;
                if (x <= _ticks[i - 1].Bid && x <= _ticks[i - 2].Bid &&
                    x < _ticks[i + 1].Bid && x <= _ticks[i + 2].Bid)
                {
                    double candidate = x - buffer;
                    if (candidate <= Symbol.Bid - Math.Max(_initialRiskDistance * 0.12, CurrentSpreadPrice() * 0.40))
                        return candidate;
                }
            }
            return null;
        }

        private double MoreProtectiveStop(TradeType side, double ratchetStop, double? structureStop)
        {
            if (!structureStop.HasValue)
                return ratchetStop;

            return side == TradeType.Sell
                ? Math.Min(ratchetStop, structureStop.Value)
                : Math.Max(ratchetStop, structureStop.Value);
        }

        private bool TryProtect(Position p, double stop, double lockR, double currentR, string reason)
        {
            Print("V5 TRAIL REQUEST | id={0} reason={1} bestR={2:F2} currentR={3:F2} lock={4:F2}R oldSL={5} newSL={6:F2}",
                p.Id,
                reason,
                _highestR,
                currentR,
                lockR,
                p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "NONE",
                stop);

            TradeResult result = ModifyPosition(p, stop, p.TakeProfit);
            if (result.IsSuccessful)
            {
                _lastAppliedLockR = Math.Max(_lastAppliedLockR, lockR);
                _consecutiveTrailRejects = 0;
                Print("V5 TRAIL SUCCESS | id={0} reason={1} newSL={2:F2} guaranteedLock≈{3:F2}R", p.Id, reason, stop, lockR);
                return true;
            }

            Print("V5 TRAIL REJECTED | id={0} reason={1} requestedSL={2:F2} error={3}", p.Id, reason, stop, result.Error);
            return false;
        }

        private double BrokerRoomFallback(Position p, double lockR)
        {
            double room = Math.Max(CurrentSpreadPrice() * 0.55, Math.Max(NoisePrice() * 1.5, Symbol.TickSize * 10));
            double lockStop = StopForLockedR(p, lockR);

            if (p.TradeType == TradeType.Sell)
                return Math.Max(Symbol.Ask + room, lockStop);

            return Math.Min(Symbol.Bid - room, lockStop);
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

        private void ResetTradeMemory()
        {
            _initialRiskDistance = 0;
            _highestR = 0;
            _entryTime = DateTime.MinValue;
            _ratchetArmed = false;
            _lastAppliedLockR = double.NegativeInfinity;
            _consecutiveTrailRejects = 0;
        }

        private double ReactionRatio(double reactionDistance)
        {
            if (_pullbackDistance <= Symbol.TickSize)
                return 0;
            return reactionDistance / _pullbackDistance;
        }

        private int AlignedRecentTicks(TradeType side, int count)
        {
            if (_ticks.Count < count + 1)
                return 0;

            int aligned = 0;
            for (int i = _ticks.Count - count; i < _ticks.Count; i++)
            {
                double delta = _ticks[i].Mid - _ticks[i - 1].Mid;
                if (side == TradeType.Buy ? delta > 0 : delta < 0)
                    aligned++;
            }
            return aligned;
        }

        private double DeltaTicks(int lookback)
        {
            if (_ticks.Count < lookback + 1)
                return 0;
            return _ticks[_ticks.Count - 1].Mid - _ticks[_ticks.Count - 1 - lookback].Mid;
        }

        private void BeginFreshCycle(double mid, TradeType? side)
        {
            _cycleId++;
            _state = CycleState.SeekingImpulse;
            _anchor = mid;
            _impulseStart = 0;
            _impulseExtreme = 0;
            _pullbackExtreme = 0;
            _reactionExtreme = 0;
            _bounceExtreme = 0;
            _breakLevel = 0;
            _impulseDistance = 0;
            _pullbackDistance = 0;

            if (side.HasValue && JournalDetail)
                Print("V5 CYCLE #{0} | {1} context | SEEKING FRESH IMPULSE", _cycleId, side.Value);
        }

        private void RejectAndRestart(TradeType side, double mid, string reason)
        {
            Print("V5 CYCLE REJECTED | cycle={0} side={1} reason={2}", _cycleId, side, reason);
            BeginFreshCycle(mid, side);
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

        private double NoisePrice()
        {
            return Math.Max(_emaAbsTick, Symbol.TickSize * 5);
        }

        private double ImpulseThreshold()
        {
            return Math.Max(CurrentSpreadPrice() * 1.10, NoisePrice() * 7.0);
        }

        private double PullbackThreshold()
        {
            return Math.Max(CurrentSpreadPrice() * 0.65, NoisePrice() * 4.0);
        }

        private double TurnThreshold()
        {
            return Math.Max(CurrentSpreadPrice() * 0.28, NoisePrice() * 2.0);
        }

        private double MicroBounceThreshold()
        {
            return Math.Max(CurrentSpreadPrice() * 0.20, NoisePrice() * 1.5);
        }

        private double BreakBuffer()
        {
            return Math.Max(CurrentSpreadPrice() * 0.05, NoisePrice() * 0.35);
        }

        private void PrintStatus(double mid)
        {
            string context = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
            LocalBias local = ReadLocalM1Bias(mid);
            double ratio = _impulseDistance > Symbol.TickSize ? _pullbackDistance / _impulseDistance : 0;
            Print("V5 STATUS | M5={0} localM1={1} state={2} cycle={3} pb/imp={4:P0} mid={5:F2} noise={6:F2}",
                context, local, _state, _cycleId, ratio, mid, NoisePrice());
        }

        private void LogState(string name, TradeType side, double mid, double observed, double needed)
        {
            if (!JournalDetail) return;
            double ratio = _impulseDistance > Symbol.TickSize ? _pullbackDistance / _impulseDistance : 0;
            Print("V5 CYCLE #{0} | {1} | {2} | mid={3:F2} observed={4:F2} need={5:F2} pb/imp={6:P0}",
                _cycleId, side, name, mid, observed, needed, ratio);
        }

        private void LogSimple(string text)
        {
            if (JournalDetail)
                Print("V5 CYCLE #{0} | {1}", _cycleId, text);
        }
    }
}
