using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class NaiMountainBrainTraderV3 : Robot
    {
        private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V3";

        [Parameter("Risk %", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 2.00, Step = 0.05)]
        public double RiskPercent { get; set; }

        [Parameter("Risk Safety Factor", DefaultValue = 0.70, MinValue = 0.40, MaxValue = 1.00, Step = 0.05)]
        public double RiskSafetyFactor { get; set; }

        [Parameter("Target R", DefaultValue = 1.20, MinValue = 0.80, MaxValue = 3.00, Step = 0.10)]
        public double TargetR { get; set; }

        [Parameter("M5 Lookback Bars", DefaultValue = 12, MinValue = 6, MaxValue = 30)]
        public int M5LookbackBars { get; set; }

        [Parameter("Min M5 Efficiency", DefaultValue = 0.20, MinValue = 0.05, MaxValue = 0.60, Step = 0.05)]
        public double MinM5Efficiency { get; set; }

        [Parameter("Journal Detail", DefaultValue = true)]
        public bool JournalDetail { get; set; }

        private Bars _m5;
        private readonly List<TickPoint> _ticks = new List<TickPoint>();
        private double _lastMid;
        private double _emaAbsTick;
        private TradeType? _contextSide;
        private CycleState _state = CycleState.SeekingImpulse;
        private int _cycleId;

        private double _anchor;
        private double _impulseStart;
        private double _impulseExtreme;
        private double _pullbackExtreme;
        private double _reactionExtreme;
        private double _bounceExtreme;
        private double _breakLevel;

        private bool _hadPosition;
        private long _activePositionId;
        private double _entryEquity;
        private double _initialRiskDistance;
        private double _highestR;
        private int _trailFailureCount;
        private DateTime _lastStatusPrint = DateTime.MinValue;

        private enum CycleState
        {
            SeekingImpulse,
            SeekingPullback,
            PullbackBuilding,
            ReactionLeg,
            AwaitingBreak,
            InTrade
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
                Print("V3 SAFETY | LIVE ACCOUNT DETECTED | STOPPING. DEMO ONLY.");
                Stop();
                return;
            }

            _m5 = MarketData.GetBars(TimeFrame.Minute5);
            double mid = MidPrice();
            _lastMid = mid;
            _anchor = mid;
            _cycleId = 1;

            Print("NAI MOUNTAIN BRAIN TRADER V3 STARTED | DEMO ONLY");
            Print("ENTRY | M5 context + local mini-mountain break | no single-tick resumption");
            Print("PROTECTION | mandatory staged R locks + structure trail + broker fallback + failsafe exit");
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
                Print("V3 RESET | prior trade closed | old setup retired | fresh impulse + pullback required");
                _hadPosition = false;
                _activePositionId = 0;
                _initialRiskDistance = 0;
                _highestR = 0;
                _trailFailureCount = 0;
                BeginFreshCycle(mid, null);
            }

            TradeType? newContext = ReadM5Context();
            if (newContext != _contextSide)
            {
                string oldText = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
                string newText = newContext.HasValue ? newContext.Value.ToString() : "NEUTRAL";
                Print("V3 CONTEXT | {0} -> {1} | local cycle reset", oldText, newText);
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

            if (_ticks.Count > 240)
                _ticks.RemoveRange(0, _ticks.Count - 240);
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

        private void AdvanceCycle(TradeType side, double mid)
        {
            double impulseNeed = ImpulseThreshold();
            double pullbackNeed = PullbackThreshold();
            double turnNeed = TurnThreshold();
            double bounceNeed = MicroBounceThreshold();
            double breakBuffer = BreakBuffer();

            if (_state == CycleState.SeekingImpulse)
            {
                if (_anchor == 0)
                    _anchor = mid;

                if (side == TradeType.Sell)
                    _anchor = Math.Max(_anchor, mid);
                else
                    _anchor = Math.Min(_anchor, mid);

                double impulse = side == TradeType.Sell ? _anchor - mid : mid - _anchor;
                if (impulse >= impulseNeed)
                {
                    _impulseStart = _anchor;
                    _impulseExtreme = mid;
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

                double pullback = side == TradeType.Sell ? mid - _impulseExtreme : _impulseExtreme - mid;
                if (pullback >= pullbackNeed)
                {
                    _pullbackExtreme = mid;
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
                    if (mid > _impulseStart + turnNeed)
                    {
                        RejectAndRestart(side, mid, "pullback erased prior impulse");
                        return;
                    }

                    if (_pullbackExtreme - mid >= turnNeed)
                    {
                        _reactionExtreme = mid;
                        _state = CycleState.ReactionLeg;
                        LogState("PULLBACK PEAK CONFIRMED", side, mid, _pullbackExtreme - mid, turnNeed);
                    }
                }
                else
                {
                    _pullbackExtreme = Math.Min(_pullbackExtreme, mid);
                    if (mid < _impulseStart - turnNeed)
                    {
                        RejectAndRestart(side, mid, "pullback erased prior impulse");
                        return;
                    }

                    if (mid - _pullbackExtreme >= turnNeed)
                    {
                        _reactionExtreme = mid;
                        _state = CycleState.ReactionLeg;
                        LogState("PULLBACK TROUGH CONFIRMED", side, mid, mid - _pullbackExtreme, turnNeed);
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
                        _state = CycleState.PullbackBuilding;
                        LogSimple("PULLBACK EXTENDED | new local high | waiting for a fresh turn");
                        return;
                    }

                    _reactionExtreme = Math.Min(_reactionExtreme, mid);
                    if (mid - _reactionExtreme >= bounceNeed)
                    {
                        _breakLevel = _reactionExtreme;
                        _bounceExtreme = mid;
                        _state = CycleState.AwaitingBreak;
                        LogState("MICRO LOW CONFIRMED", side, mid, mid - _reactionExtreme, bounceNeed);
                    }
                }
                else
                {
                    if (mid < _pullbackExtreme)
                    {
                        _pullbackExtreme = mid;
                        _state = CycleState.PullbackBuilding;
                        LogSimple("PULLBACK EXTENDED | new local low | waiting for a fresh turn");
                        return;
                    }

                    _reactionExtreme = Math.Max(_reactionExtreme, mid);
                    if (_reactionExtreme - mid >= bounceNeed)
                    {
                        _breakLevel = _reactionExtreme;
                        _bounceExtreme = mid;
                        _state = CycleState.AwaitingBreak;
                        LogState("MICRO HIGH CONFIRMED", side, mid, _reactionExtreme - mid, bounceNeed);
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
                        _state = CycleState.PullbackBuilding;
                        LogSimple("BREAK CANCELLED | pullback made a new high");
                        return;
                    }

                    if (mid <= _breakLevel - breakBuffer)
                        TryEnterFromMiniMountain(side, mid);
                }
                else
                {
                    _bounceExtreme = Math.Min(_bounceExtreme, mid);
                    if (mid < _pullbackExtreme)
                    {
                        _pullbackExtreme = mid;
                        _state = CycleState.PullbackBuilding;
                        LogSimple("BREAK CANCELLED | pullback made a new low");
                        return;
                    }

                    if (mid >= _breakLevel + breakBuffer)
                        TryEnterFromMiniMountain(side, mid);
                }
            }
        }

        private void TryEnterFromMiniMountain(TradeType side, double mid)
        {
            int aligned = AlignedRecentTicks(side, 3);
            double shortMove = DeltaTicks(4);
            double mediumMove = DeltaTicks(10);
            double accel = TickAcceleration();
            double noise = NoisePrice();

            int score = 0;
            if (aligned >= 2) score++;
            if (side == TradeType.Sell ? shortMove < -noise * 0.50 : shortMove > noise * 0.50) score++;
            if (side == TradeType.Sell ? mediumMove < TurnThreshold() * 0.50 : mediumMove > -TurnThreshold() * 0.50) score++;
            if (side == TradeType.Sell ? accel <= noise * 0.25 : accel >= -noise * 0.25) score++;

            if (score < 3)
            {
                if (JournalDetail)
                    Print("V3 BREAK SEEN | cycle={0} side={1} score={2}/4 aligned={3}/3 short={4:F2} medium={5:F2} accel={6:F2} | waiting follow-through",
                        _cycleId, side, score, aligned, shortMove, mediumMove, accel);
                return;
            }

            OpenTrade(side, mid, score, aligned, shortMove, mediumMove, accel);
        }

        private void OpenTrade(TradeType side, double mid, int score, int aligned, double shortMove, double mediumMove, double accel)
        {
            if (GetPosition() != null)
                return;

            double spread = CurrentSpreadPrice();
            double stopBuffer = Math.Max(spread * 0.30, NoisePrice() * 1.50);
            double plannedEntry = side == TradeType.Buy ? Symbol.Ask : Symbol.Bid;
            double stopPrice = side == TradeType.Sell ? _pullbackExtreme + stopBuffer : _pullbackExtreme - stopBuffer;
            double riskPrice = Math.Abs(plannedEntry - stopPrice);
            double minRiskPrice = Math.Max(spread * 1.10, NoisePrice() * 4.0);

            if (riskPrice < minRiskPrice)
            {
                riskPrice = minRiskPrice;
                stopPrice = side == TradeType.Sell ? plannedEntry + riskPrice : plannedEntry - riskPrice;
            }

            double slPips = riskPrice / Symbol.PipSize;
            double tpPips = slPips * TargetR;
            double riskAmount = Account.Equity * (RiskPercent / 100.0) * RiskSafetyFactor;
            double rawVolume = Symbol.VolumeForFixedRisk(riskAmount, slPips);
            double volume = Symbol.NormalizeVolumeInUnits(rawVolume, RoundingMode.Down);

            if (volume < Symbol.VolumeInUnitsMin)
            {
                Print("V3 ENTRY SKIP | calculated volume {0} below symbol minimum {1}", volume, Symbol.VolumeInUnitsMin);
                BeginFreshCycle(mid, side);
                return;
            }

            volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

            Print("V3 THESIS | cycle={0} {1} | M5 context={1} | local opposite mini-mountain completed + reaction swing broke | score={2}/4 aligned={3}/3 short={4:F2} medium={5:F2} accel={6:F2} | pullbackExtreme={7:F2} break={8:F2} | plannedRisk=${9:F2}",
                _cycleId, side, score, aligned, shortMove, mediumMove, accel, _pullbackExtreme, _breakLevel, riskAmount);

            TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, Label, slPips, tpPips);
            if (!result.IsSuccessful || result.Position == null)
            {
                Print("V3 ENTRY REJECTED | cycle={0} error={1}", _cycleId, result.Error);
                BeginFreshCycle(mid, side);
                return;
            }

            Position position = result.Position;
            _activePositionId = position.Id;
            _entryEquity = Account.Equity;
            _initialRiskDistance = position.StopLoss.HasValue
                ? Math.Abs(position.EntryPrice - position.StopLoss.Value)
                : riskPrice;
            _highestR = 0;
            _trailFailureCount = 0;
            _hadPosition = true;
            _state = CycleState.InTrade;

            Print("V3 ENTER {0} | id={1} entry={2:F2} SL={3} TP={4} volume={5} initialR={6:F2} price-units",
                side,
                position.Id,
                position.EntryPrice,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("F2") : "NONE",
                position.TakeProfit.HasValue ? position.TakeProfit.Value.ToString("F2") : "NONE",
                position.VolumeInUnits,
                _initialRiskDistance);
        }

        private void ManageOpenPosition(Position position)
        {
            if (_initialRiskDistance <= Symbol.TickSize)
            {
                if (position.StopLoss.HasValue)
                    _initialRiskDistance = Math.Abs(position.EntryPrice - position.StopLoss.Value);
                if (_initialRiskDistance <= Symbol.TickSize)
                    return;
            }

            double favorable = position.TradeType == TradeType.Buy
                ? Symbol.Bid - position.EntryPrice
                : position.EntryPrice - Symbol.Ask;
            double r = favorable / _initialRiskDistance;
            _highestR = Math.Max(_highestR, r);

            double hardLossCap = _entryEquity * (RiskPercent / 100.0);
            if (position.NetProfit <= -hardLossCap)
            {
                Print("V3 HARD RISK EXIT | id={0} net={1:F2} cap={2:F2}", position.Id, position.NetProfit, hardLossCap);
                ClosePosition(position);
                return;
            }

            double? lockR = RequiredLockR(r);
            if (!lockR.HasValue)
                return;

            double fallback = StopForLockedR(position, lockR.Value);
            double? structure = StructureTrailCandidate(position);
            double desired = CombineStructureAndLock(position.TradeType, structure, fallback);

            if (!IsImprovement(position, desired))
                return;

            if (TryStopMove(position, desired, "STRUCTURE+LOCK", r, lockR.Value))
                return;

            if (Math.Abs(desired - fallback) > Symbol.TickSize && IsImprovement(position, fallback))
            {
                if (TryStopMove(position, fallback, "R-FALLBACK", r, lockR.Value))
                    return;
            }

            double roomStop = BrokerRoomFallback(position, lockR.Value);
            if (IsImprovement(position, roomStop))
            {
                if (TryStopMove(position, roomStop, "BROKER-ROOM-FALLBACK", r, lockR.Value))
                    return;
            }

            _trailFailureCount++;
            Print("V3 TRAIL ALL REJECTED | id={0} r={1:F2} failures={2} | FAILSAFE EXIT to protect reached profit", position.Id, r, _trailFailureCount);
            ClosePosition(position);
        }

        private double? RequiredLockR(double r)
        {
            if (r >= 1.10) return 0.60;
            if (r >= 0.90) return 0.40;
            if (r >= 0.70) return 0.20;
            if (r >= 0.50) return 0.05;
            if (r >= 0.30) return -0.45;
            return null;
        }

        private double StopForLockedR(Position position, double lockR)
        {
            if (position.TradeType == TradeType.Buy)
                return position.EntryPrice + lockR * _initialRiskDistance;
            return position.EntryPrice - lockR * _initialRiskDistance;
        }

        private double? StructureTrailCandidate(Position position)
        {
            if (_ticks.Count < 8)
                return null;

            int start = Math.Max(0, _ticks.Count - 14);
            double buffer = Math.Max(CurrentSpreadPrice() * 0.18, NoisePrice() * 1.0);

            if (position.TradeType == TradeType.Sell)
            {
                double recentHigh = _ticks.Skip(start).Max(t => t.Ask);
                return recentHigh + buffer;
            }

            double recentLow = _ticks.Skip(start).Min(t => t.Bid);
            return recentLow - buffer;
        }

        private double CombineStructureAndLock(TradeType side, double? structure, double fallback)
        {
            if (!structure.HasValue)
                return fallback;

            return side == TradeType.Sell
                ? Math.Min(structure.Value, fallback)
                : Math.Max(structure.Value, fallback);
        }

        private double BrokerRoomFallback(Position position, double lockR)
        {
            double room = Math.Max(CurrentSpreadPrice() * 0.55, Math.Max(NoisePrice() * 1.5, Symbol.TickSize * 10));
            double lockStop = StopForLockedR(position, lockR);

            if (position.TradeType == TradeType.Sell)
            {
                double minimumValid = Symbol.Ask + room;
                return Math.Max(minimumValid, lockStop);
            }

            double maximumValid = Symbol.Bid - room;
            return Math.Min(maximumValid, lockStop);
        }

        private bool TryStopMove(Position position, double stop, string reason, double r, double lockR)
        {
            if (!IsOnCorrectSide(position.TradeType, stop))
            {
                Print("V3 TRAIL CANDIDATE INVALID | id={0} reason={1} stop={2:F2} bid={3:F2} ask={4:F2}", position.Id, reason, stop, Symbol.Bid, Symbol.Ask);
                return false;
            }

            Print("V3 TRAIL REQUEST | id={0} reason={1} r={2:F2} lock={3:F2}R oldSL={4} newSL={5:F2}",
                position.Id,
                reason,
                r,
                lockR,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("F2") : "NONE",
                stop);

            TradeResult result = ModifyPosition(position, stop, position.TakeProfit);
            if (result.IsSuccessful)
            {
                _trailFailureCount = 0;
                Print("V3 TRAIL SUCCESS | id={0} reason={1} newSL={2:F2} r={3:F2}", position.Id, reason, stop, r);
                return true;
            }

            Print("V3 TRAIL REJECTED | id={0} reason={1} requestedSL={2:F2} error={3}", position.Id, reason, stop, result.Error);
            return false;
        }

        private bool IsImprovement(Position position, double candidate)
        {
            if (!position.StopLoss.HasValue)
                return true;

            if (position.TradeType == TradeType.Buy)
                return candidate > position.StopLoss.Value + Symbol.TickSize;

            return candidate < position.StopLoss.Value - Symbol.TickSize;
        }

        private bool IsOnCorrectSide(TradeType side, double stop)
        {
            double room = Math.Max(Symbol.TickSize * 3, CurrentSpreadPrice() * 0.08);
            if (side == TradeType.Buy)
                return stop < Symbol.Bid - room;
            return stop > Symbol.Ask + room;
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

        private void RejectAndRestart(TradeType side, double mid, string reason)
        {
            Print("V3 CYCLE REJECTED | cycle={0} side={1} reason={2} | fresh impulse required", _cycleId, side, reason);
            BeginFreshCycle(mid, side);
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
            if (side.HasValue && JournalDetail)
                Print("V3 CYCLE #{0} | {1} context | SEEKING FRESH IMPULSE", _cycleId, side.Value);
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
            Print("V3 STATUS | context={0} state={1} cycle={2} mid={3:F2} noise={4:F2} spread={5:F2} impNeed={6:F2} pbNeed={7:F2}",
                context, _state, _cycleId, mid, NoisePrice(), CurrentSpreadPrice(), ImpulseThreshold(), PullbackThreshold());
        }

        private void LogState(string name, TradeType side, double mid, double observed, double needed)
        {
            if (!JournalDetail) return;
            Print("V3 CYCLE #{0} | {1} | {2} | mid={3:F2} observed={4:F2} need={5:F2} pullbackExtreme={6:F2}",
                _cycleId, side, name, mid, observed, needed, _pullbackExtreme);
        }

        private void LogSimple(string text)
        {
            if (JournalDetail)
                Print("V3 CYCLE #{0} | {1}", _cycleId, text);
        }
    }
}
