from pathlib import Path
import re

BASE = Path('ctrader/NAI-MOUNTAIN-BRAIN-TRADER-V3/NAI-MOUNTAIN-BRAIN-TRADER-V3.cs')
OUT = Path('ctrader/NAI-MOUNTAIN-BRAIN-V4-ACTIVE-TRAIL/NAI-MOUNTAIN-BRAIN-V4-ACTIVE-TRAIL.cs')

s = BASE.read_text()

# Identity only. The entry state machine below is inherited from V3.
s = s.replace('public class NaiMountainBrainTraderV3 : Robot', 'public class NaiMountainBrainV4ActiveTrail : Robot')
s = s.replace('private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V3";', 'private const string Label = "NAI-MOUNTAIN-BRAIN-V4-ACTIVE-TRAIL";')
s = s.replace('"V3 ', '"V4-ACTIVE ')
s = s.replace('NAI MOUNTAIN BRAIN TRADER V3 STARTED', 'NAI MOUNTAIN BRAIN V4 ACTIVE TRAIL STARTED')

# Money-management defaults only. Entry thresholds are intentionally untouched.
s = s.replace(
'''        [Parameter("Risk Safety Factor", DefaultValue = 0.70, MinValue = 0.40, MaxValue = 1.00, Step = 0.05)]
        public double RiskSafetyFactor { get; set; }

        [Parameter("Target R", DefaultValue = 1.20, MinValue = 0.80, MaxValue = 3.00, Step = 0.10)]
        public double TargetR { get; set; }''',
'''        [Parameter("Risk Safety Factor", DefaultValue = 0.60, MinValue = 0.35, MaxValue = 1.00, Step = 0.05)]
        public double RiskSafetyFactor { get; set; }

        [Parameter("Small Win Target R", DefaultValue = 0.45, MinValue = 0.25, MaxValue = 1.00, Step = 0.05)]
        public double TargetR { get; set; }

        [Parameter("Early Failure Exit R", DefaultValue = 0.30, MinValue = 0.15, MaxValue = 0.60, Step = 0.05)]
        public double EarlyFailureR { get; set; }

        [Parameter("Continuous Trail Start R", DefaultValue = 0.18, MinValue = 0.10, MaxValue = 0.40, Step = 0.02)]
        public double ContinuousTrailStartR { get; set; }

        [Parameter("Continuous Trail Distance R", DefaultValue = 0.20, MinValue = 0.10, MaxValue = 0.40, Step = 0.02)]
        public double ContinuousTrailDistanceR { get; set; }

        [Parameter("Min Trail Move R", DefaultValue = 0.03, MinValue = 0.01, MaxValue = 0.10, Step = 0.01)]
        public double MinTrailMoveR { get; set; }''',
1)

s = s.replace(
'''        private double _highestR;
        private int _trailFailureCount;
        private DateTime _lastStatusPrint = DateTime.MinValue;''',
'''        private double _highestR;
        private double _lastAppliedTrailLockR = double.NegativeInfinity;
        private DateTime _entryTime;
        private int _trailFailureCount;
        private DateTime _lastStatusPrint = DateTime.MinValue;''',
1)

s = s.replace(
'''            Print("ENTRY | M5 context + local mini-mountain break | no single-tick resumption");
            Print("PROTECTION | mandatory staged R locks + structure trail + broker fallback + failsafe exit");''',
'''            Print("ENTRY | V3 active engine preserved: M5 context + impulse + pullback + mini-mountain break + light 3/4 confirmation");
            Print("NO ENTRY REDUCTION | no pullback-ratio gate, no local-M1 veto, no V4/V5 extra permission filters");
            Print("MONEY | 0.45R small-win TP + early-failure exit + continuous best-R trailing after entry");''',
1)

s = s.replace(
'''                _initialRiskDistance = 0;
                _highestR = 0;
                _trailFailureCount = 0;
                BeginFreshCycle(mid, null);''',
'''                _initialRiskDistance = 0;
                _highestR = 0;
                _lastAppliedTrailLockR = double.NegativeInfinity;
                _entryTime = DateTime.MinValue;
                _trailFailureCount = 0;
                BeginFreshCycle(mid, null);''',
1)

new_open = r'''        private void OpenTrade(TradeType side, double mid, int score, int aligned, double shortMove, double mediumMove, double accel)
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
                Print("V4-ACTIVE ENTRY SKIP | calculated volume {0} below symbol minimum {1}", volume, Symbol.VolumeInUnitsMin);
                BeginFreshCycle(mid, side);
                return;
            }

            volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

            Print("V4-ACTIVE THESIS | cycle={0} {1} | V3 active entry DNA | score={2}/4 aligned={3}/3 short={4:F2} medium={5:F2} accel={6:F2} | pullbackExtreme={7:F2} break={8:F2} | target={9:F2}R plannedRisk=${10:F2}",
                _cycleId, side, score, aligned, shortMove, mediumMove, accel, _pullbackExtreme, _breakLevel, TargetR, riskAmount);

            TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, Label, slPips, tpPips);
            Position position = result.IsSuccessful ? result.Position : null;

            // cTrader/Deriv occasionally returned TechnicalError when SL/TP were attached to the market order.
            // Do not throw away a valid setup. Retry the SAME entry without changing the signal, then attach protection immediately.
            if (position == null)
            {
                Print("V4-ACTIVE PRIMARY ORDER FAILED | cycle={0} error={1} | retrying same entry then attaching SL/TP", _cycleId, result.Error);
                TradeResult retry = ExecuteMarketOrder(side, SymbolName, volume, Label);
                if (!retry.IsSuccessful || retry.Position == null)
                {
                    Print("V4-ACTIVE ENTRY REJECTED | cycle={0} retryError={1}", _cycleId, retry.Error);
                    BeginFreshCycle(mid, side);
                    return;
                }

                position = retry.Position;
                double absoluteStop = side == TradeType.Buy ? position.EntryPrice - riskPrice : position.EntryPrice + riskPrice;
                double absoluteTp = side == TradeType.Buy ? position.EntryPrice + riskPrice * TargetR : position.EntryPrice - riskPrice * TargetR;
                absoluteStop = Math.Round(absoluteStop, Symbol.Digits);
                absoluteTp = Math.Round(absoluteTp, Symbol.Digits);

                TradeResult protect = ModifyPosition(position, absoluteStop, absoluteTp);
                if (!protect.IsSuccessful)
                {
                    Print("V4-ACTIVE FALLBACK PROTECTION FAILED | id={0} error={1} | closing immediately", position.Id, protect.Error);
                    ClosePosition(position);
                    BeginFreshCycle(mid, side);
                    return;
                }

                Print("V4-ACTIVE FALLBACK ORDER PROTECTED | id={0} SL={1:F2} TP={2:F2}", position.Id, absoluteStop, absoluteTp);
            }

            _activePositionId = position.Id;
            _entryEquity = Account.Equity;
            _initialRiskDistance = position.StopLoss.HasValue
                ? Math.Abs(position.EntryPrice - position.StopLoss.Value)
                : riskPrice;
            _highestR = 0;
            _lastAppliedTrailLockR = double.NegativeInfinity;
            _entryTime = Server.Time;
            _trailFailureCount = 0;
            _hadPosition = true;
            _state = CycleState.InTrade;

            Print("V4-ACTIVE ENTER {0} | id={1} entry={2:F2} SL={3} TP={4} volume={5} initialR={6:F2} | ACTIVE ENTRY + SMALL WIN + TRAIL",
                side,
                position.Id,
                position.EntryPrice,
                position.StopLoss.HasValue ? position.StopLoss.Value.ToString("F2") : "NONE",
                position.TakeProfit.HasValue ? position.TakeProfit.Value.ToString("F2") : "NONE",
                position.VolumeInUnits,
                _initialRiskDistance);
        }'''

pattern = r'        private void OpenTrade\(TradeType side, double mid, int score, int aligned, double shortMove, double mediumMove, double accel\)\n        \{.*?\n        \}\n\n        private void ManageOpenPosition'
s, n = re.subn(pattern, new_open + '\n\n        private void ManageOpenPosition', s, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f'OpenTrade replacement count={n}')

new_manage = r'''        private void ManageOpenPosition(Position position)
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
            double seconds = _entryTime == DateTime.MinValue ? 0 : (Server.Time - _entryTime).TotalSeconds;

            // V4-style loss control. Post-entry only. It cannot reduce entry frequency.
            double hardLossCap = _entryEquity * (RiskPercent / 100.0) * 0.75;
            if (position.NetProfit <= -hardLossCap)
            {
                Print("V4-ACTIVE HARD LOSS CAP | id={0} net={1:F2} cap={2:F2} | closing", position.Id, position.NetProfit, hardLossCap);
                ClosePosition(position);
                return;
            }

            if (_highestR < 0.10 && r <= -EarlyFailureR)
            {
                Print("V4-ACTIVE EARLY FAILURE EXIT | id={0} r={1:F2} bestR={2:F2} | trade never proved itself", position.Id, r, _highestR);
                ClosePosition(position);
                return;
            }

            if (seconds >= 20 && _highestR < 0.10 && r < -0.10)
            {
                Print("V4-ACTIVE STALE THESIS EXIT | id={0} age={1:F0}s r={2:F2} bestR={3:F2}", position.Id, seconds, r, _highestR);
                ClosePosition(position);
                return;
            }

            double? lockR = RequiredLockR(_highestR);
            if (!lockR.HasValue)
                return;

            if (!double.IsNegativeInfinity(_lastAppliedTrailLockR) &&
                lockR.Value < _lastAppliedTrailLockR + MinTrailMoveR)
                return;

            double desired = StopForLockedR(position, lockR.Value);

            // If price retraced through the desired ratchet before broker modification, protect what remains.
            if (!IsOnCorrectSide(position.TradeType, desired))
            {
                if (r <= lockR.Value + 0.03 && r > 0)
                {
                    Print("V4-ACTIVE TRAIL CATCH-UP EXIT | id={0} currentR={1:F2} bestR={2:F2} desiredLock={3:F2}R", position.Id, r, _highestR, lockR.Value);
                    ClosePosition(position);
                    return;
                }

                desired = BrokerRoomFallback(position, lockR.Value);
            }

            if (!IsImprovement(position, desired))
                return;

            if (TryStopMove(position, desired, "CONTINUOUS-BEST-R", r, lockR.Value))
            {
                _lastAppliedTrailLockR = Math.Max(_lastAppliedTrailLockR, LockRFromStop(position, desired));
                return;
            }

            double fallback = BrokerRoomFallback(position, lockR.Value);
            if (IsImprovement(position, fallback) && Math.Abs(fallback - desired) > Symbol.TickSize)
            {
                if (TryStopMove(position, fallback, "BROKER-ROOM-FALLBACK", r, lockR.Value))
                {
                    _lastAppliedTrailLockR = Math.Max(_lastAppliedTrailLockR, LockRFromStop(position, fallback));
                    return;
                }
            }

            _trailFailureCount++;
            Print("V4-ACTIVE TRAIL ALL REJECTED | id={0} r={1:F2} bestR={2:F2} failures={3} | closing to preserve reached profit", position.Id, r, _highestR, _trailFailureCount);
            ClosePosition(position);
        }'''

pattern = r'        private void ManageOpenPosition\(Position position\)\n        \{.*?\n        \}\n\n        private double\? RequiredLockR'
s, n = re.subn(pattern, new_manage + '\n\n        private double? RequiredLockR', s, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f'ManageOpenPosition replacement count={n}')

old_lock = r'''        private double? RequiredLockR(double r)
        {
            if (r >= 1.10) return 0.60;
            if (r >= 0.90) return 0.40;
            if (r >= 0.70) return 0.20;
            if (r >= 0.50) return 0.05;
            if (r >= 0.30) return -0.45;
            return null;
        }'''
new_lock = r'''        private double? RequiredLockR(double bestR)
        {
            if (bestR < ContinuousTrailStartR)
                return null;

            // V4 small-win floors plus a continuous ratchet based on BEST achieved R.
            double floor = -0.10;
            if (bestR >= 0.38) floor = 0.16;
            else if (bestR >= 0.28) floor = 0.05;

            double continuousLock = bestR - ContinuousTrailDistanceR;
            return Math.Max(floor, continuousLock);
        }'''
if old_lock not in s:
    raise SystemExit('old RequiredLockR block not found')
s = s.replace(old_lock, new_lock, 1)

# Add helper to report the real lock achieved by broker-room fallback.
needle = r'''        private double StopForLockedR(Position position, double lockR)
        {
            if (position.TradeType == TradeType.Buy)
                return position.EntryPrice + lockR * _initialRiskDistance;
            return position.EntryPrice - lockR * _initialRiskDistance;
        }'''
replacement = needle + r'''

        private double LockRFromStop(Position position, double stop)
        {
            if (_initialRiskDistance <= Symbol.TickSize)
                return double.NegativeInfinity;

            return position.TradeType == TradeType.Buy
                ? (stop - position.EntryPrice) / _initialRiskDistance
                : (position.EntryPrice - stop) / _initialRiskDistance;
        }'''
if needle not in s:
    raise SystemExit('StopForLockedR anchor not found')
s = s.replace(needle, replacement, 1)

# Build-time invariants: protect the exact intent of this recovery build.
required = [
    'TryEnterFromMiniMountain(side, mid)',
    'AlignedRecentTicks(side, 3)',
    'if (score < 3)',
    'ContinuousTrailStartR',
    'Small Win Target R',
    'retrying same entry then attaching SL/TP'
]
for token in required:
    if token not in s:
        raise SystemExit(f'missing required invariant: {token}')

banned = [
    'Min Pullback / Impulse',
    'Max Pullback / Impulse',
    'ReadLocalM1Bias',
    'LOCAL M1=UP',
    'LOCAL M1=DOWN',
    'aligned={3}/5'
]
for token in banned:
    if token in s:
        raise SystemExit(f'blocked filter leaked into active build: {token}')

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(s)
print(f'generated {OUT} from V3 active-entry source')
print('ENTRY DNA: V3 | EXIT/MONEY: V4 small-win + early loss control | TRAIL: continuous best-R')
