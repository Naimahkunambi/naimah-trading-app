from pathlib import Path

base = Path('ctrader/NAI-MOUNTAIN-BRAIN-TRADER-V4/NAI-MOUNTAIN-BRAIN-TRADER-V4.cs')
out = Path('ctrader/NAI-MOUNTAIN-BRAIN-TRADER-V4-TRAIL/NAI-MOUNTAIN-BRAIN-TRADER-V4-TRAIL.cs')
s = base.read_text()

# Identity only. Entry engine remains V4 exactly.
s = s.replace('public class NaiMountainBrainTraderV4 : Robot', 'public class NaiMountainBrainTraderV4Trail : Robot')
s = s.replace('private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V4";', 'private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V4-TRAIL";')
s = s.replace('NAI MOUNTAIN BRAIN TRADER V4 STARTED', 'NAI MOUNTAIN BRAIN TRADER V4 + CONTINUOUS TRAIL STARTED')
s = s.replace('"V4 ', '"V4-TRAIL ')

# Add only trailing parameters. No entry parameter is changed.
needle = '''        [Parameter("Small Win Target R", DefaultValue = 0.45, MinValue = 0.25, MaxValue = 1.00, Step = 0.05)]
        public double TargetR { get; set; }

        [Parameter("Early Failure Exit R", DefaultValue = 0.30, MinValue = 0.15, MaxValue = 0.60, Step = 0.05)]'''
replacement = '''        [Parameter("Small Win Target R", DefaultValue = 0.45, MinValue = 0.25, MaxValue = 1.00, Step = 0.05)]
        public double TargetR { get; set; }

        [Parameter("Continuous Trail Start R", DefaultValue = 0.18, MinValue = 0.10, MaxValue = 0.40, Step = 0.02)]
        public double ContinuousTrailStartR { get; set; }

        [Parameter("Continuous Trail Distance R", DefaultValue = 0.20, MinValue = 0.10, MaxValue = 0.40, Step = 0.02)]
        public double ContinuousTrailDistanceR { get; set; }

        [Parameter("Min Trail Move R", DefaultValue = 0.03, MinValue = 0.01, MaxValue = 0.10, Step = 0.01)]
        public double MinTrailMoveR { get; set; }

        [Parameter("Early Failure Exit R", DefaultValue = 0.30, MinValue = 0.15, MaxValue = 0.60, Step = 0.05)]'''
if needle not in s:
    raise SystemExit('parameter anchor not found')
s = s.replace(needle, replacement, 1)

needle = '''        private double _highestR;
        private DateTime _entryTime;
        private DateTime _lastStatusPrint = DateTime.MinValue;'''
replacement = '''        private double _highestR;
        private double _lastAppliedTrailLockR = double.NegativeInfinity;
        private DateTime _entryTime;
        private DateTime _lastStatusPrint = DateTime.MinValue;'''
if needle not in s:
    raise SystemExit('field anchor not found')
s = s.replace(needle, replacement, 1)

# Startup explanation. Trading entry code remains untouched.
needle = '''            Print("V4-TRAIL LAW 3 | preserve small wins; wrong thesis exits early instead of holding to full stop");'''
replacement = '''            Print("V4-TRAIL LAW 3 | preserve small wins; wrong thesis exits early instead of holding to full stop");
            Print("V4-TRAIL ONLY CHANGE | continuous trailing added after entry; V4 entry logic and 0.45R TP unchanged");'''
if needle not in s:
    raise SystemExit('startup anchor not found')
s = s.replace(needle, replacement, 1)

# Reset trail memory when prior trade closes.
needle = '''                _initialRiskDistance = 0;
                _highestR = 0;
                _entryTime = DateTime.MinValue;'''
replacement = '''                _initialRiskDistance = 0;
                _highestR = 0;
                _lastAppliedTrailLockR = double.NegativeInfinity;
                _entryTime = DateTime.MinValue;'''
if needle not in s:
    raise SystemExit('close reset anchor not found')
s = s.replace(needle, replacement, 1)

# Reset trail memory on a fresh entry.
needle = '''            _initialRiskDistance = p.StopLoss.HasValue ? Math.Abs(p.EntryPrice - p.StopLoss.Value) : riskPrice;
            _highestR = 0;
            _entryTime = Server.Time;'''
replacement = '''            _initialRiskDistance = p.StopLoss.HasValue ? Math.Abs(p.EntryPrice - p.StopLoss.Value) : riskPrice;
            _highestR = 0;
            _lastAppliedTrailLockR = double.NegativeInfinity;
            _entryTime = Server.Time;'''
if needle not in s:
    raise SystemExit('entry reset anchor not found')
s = s.replace(needle, replacement, 1)

# IMPORTANT: use BEST R, not current R, so the trailing stop can never mentally loosen on a retrace.
s = s.replace('            double? lockR = RequiredLockR(r);', '            double? lockR = RequiredLockR(_highestR);', 1)

# Throttle tiny broker modifications, without changing any entry decision.
needle = '''            if (!lockR.HasValue)
                return;

            double desired = StopForLockedR(p, lockR.Value);'''
replacement = '''            if (!lockR.HasValue)
                return;

            if (!double.IsNegativeInfinity(_lastAppliedTrailLockR) &&
                lockR.Value < _lastAppliedTrailLockR + MinTrailMoveR)
                return;

            double desired = StopForLockedR(p, lockR.Value);'''
if needle not in s:
    raise SystemExit('trail throttle anchor not found')
s = s.replace(needle, replacement, 1)

# Record successful lock and make the journal explicit.
needle = '''            if (result.IsSuccessful)
            {
                Print("V4-TRAIL PROTECT SUCCESS | id={0} newSL={1:F2}", p.Id, desired);
                return;
            }'''
replacement = '''            if (result.IsSuccessful)
            {
                _lastAppliedTrailLockR = Math.Max(_lastAppliedTrailLockR, lockR.Value);
                Print("V4-TRAIL CONTINUOUS TRAIL SUCCESS | id={0} bestR={1:F2} lock={2:F2}R newSL={3:F2}", p.Id, _highestR, lockR.Value, desired);
                return;
            }'''
if needle not in s:
    raise SystemExit('success anchor not found')
s = s.replace(needle, replacement, 1)

# Preserve V4's original three safety floors, then ADD a continuous best-R ratchet on top.
old = '''        private double? RequiredLockR(double r)
        {
            if (r >= 0.38) return 0.16;
            if (r >= 0.28) return 0.05;
            if (r >= 0.18) return -0.10;
            return null;
        }'''
new = '''        private double? RequiredLockR(double bestR)
        {
            double? v4Floor = null;
            if (bestR >= 0.38) v4Floor = 0.16;
            else if (bestR >= 0.28) v4Floor = 0.05;
            else if (bestR >= 0.18) v4Floor = -0.10;

            if (bestR < ContinuousTrailStartR)
                return v4Floor;

            double continuousLock = bestR - ContinuousTrailDistanceR;
            return v4Floor.HasValue ? Math.Max(v4Floor.Value, continuousLock) : continuousLock;
        }'''
if old not in s:
    raise SystemExit('RequiredLockR block not found')
s = s.replace(old, new, 1)

out.write_text(s)
print(f'generated {out} from {base}')
