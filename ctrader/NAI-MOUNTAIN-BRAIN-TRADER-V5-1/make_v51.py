from pathlib import Path

base = Path('ctrader/NAI-MOUNTAIN-BRAIN-TRADER-V5/NAI-MOUNTAIN-BRAIN-TRADER-V5.cs')
out = Path('ctrader/NAI-MOUNTAIN-BRAIN-TRADER-V5-1/NAI-MOUNTAIN-BRAIN-TRADER-V5-1.cs')
s = base.read_text()

# Identity only. V5 trading and Waterfall Ratchet logic stay inherited byte-for-byte unless explicitly patched below.
s = s.replace('public class NaiMountainBrainTraderV5 : Robot', 'public class NaiMountainBrainTraderV51 : Robot')
s = s.replace('private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V5";', 'private const string Label = "NAI-MOUNTAIN-BRAIN-TRADER-V5-1";')
s = s.replace('NAI MOUNTAIN BRAIN TRADER V5 WATERFALL RATCHET STARTED', 'NAI MOUNTAIN BRAIN TRADER V5.1 WATERFALL RATCHET STARTED')
# Journal prefix only, to make screenshots unambiguous.
s = s.replace('"V5 ', '"V5.1 ')

needle = '''        [Parameter("Min M5 Efficiency", DefaultValue = 0.20, MinValue = 0.05, MaxValue = 0.60, Step = 0.05)]
        public double MinM5Efficiency { get; set; }

        [Parameter("Journal Detail", DefaultValue = true)]'''
replacement = '''        [Parameter("Min M5 Efficiency", DefaultValue = 0.20, MinValue = 0.05, MaxValue = 0.60, Step = 0.05)]
        public double MinM5Efficiency { get; set; }

        [Parameter("M1 Fallback Efficiency", DefaultValue = 0.50, MinValue = 0.35, MaxValue = 0.80, Step = 0.05)]
        public double M1FallbackEfficiency { get; set; }

        [Parameter("M1 Fallback Net / Noise", DefaultValue = 12.0, MinValue = 6.0, MaxValue = 30.0, Step = 1.0)]
        public double M1FallbackNoiseMultiple { get; set; }

        [Parameter("M1 Fallback Hold Seconds", DefaultValue = 420, MinValue = 120, MaxValue = 900, Step = 30)]
        public int M1FallbackHoldSeconds { get; set; }

        [Parameter("Journal Detail", DefaultValue = true)]'''
if needle not in s:
    raise SystemExit('parameter insertion anchor not found')
s = s.replace(needle, replacement, 1)

needle = '''        private double _emaAbsTick;
        private TradeType? _contextSide;
        private CycleState _state = CycleState.SeekingImpulse;'''
replacement = '''        private double _emaAbsTick;
        private TradeType? _contextSide;
        private string _contextSource = "NONE";
        private DateTime _fallbackContextBorn = DateTime.MinValue;
        private CycleState _state = CycleState.SeekingImpulse;'''
if needle not in s:
    raise SystemExit('field insertion anchor not found')
s = s.replace(needle, replacement, 1)

old_context = '''            TradeType? newContext = ReadM5Context();
            if (newContext != _contextSide)
            {
                string oldText = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
                string newText = newContext.HasValue ? newContext.Value.ToString() : "NEUTRAL";
                Print("V5.1 CONTEXT | {0} -> {1} | local cycle reset", oldText, newText);
                _contextSide = newContext;
                BeginFreshCycle(mid, newContext);
            }

            if (_contextSide.HasValue)
                AdvanceCycle(_contextSide.Value, mid);'''
new_context = '''            UpdateEffectiveContext(mid);

            if (_contextSide.HasValue)
                AdvanceCycle(_contextSide.Value, mid);'''
if old_context not in s:
    raise SystemExit('OnTick context block not found')
s = s.replace(old_context, new_context, 1)

anchor = '''        private LocalBias ReadLocalM1Bias(double liveMid)
        {'''
helpers = r'''        private void UpdateEffectiveContext(double mid)
        {
            TradeType? rawM5 = ReadM5Context();
            TradeType? strongM1 = ReadStrongM1Fallback(mid);
            TradeType? candidate = _contextSide;
            string source = _contextSource;

            // M5 always has priority whenever it is genuinely directional.
            if (rawM5.HasValue)
            {
                candidate = rawM5;
                source = "M5";
                _fallbackContextBorn = DateTime.MinValue;
            }
            else if (_contextSource == "M1-FALLBACK" && _contextSide.HasValue)
            {
                // A strong opposite M1 mountain can flip a latched fallback immediately.
                if (strongM1.HasValue && strongM1.Value != _contextSide.Value)
                {
                    candidate = strongM1;
                    source = "M1-FALLBACK";
                    _fallbackContextBorn = Server.Time;
                }
                else
                {
                    LocalBias local = ReadLocalM1Bias(mid);
                    bool ordinaryOpposite = (_contextSide == TradeType.Sell && local == LocalBias.Up) ||
                                            (_contextSide == TradeType.Buy && local == LocalBias.Down);
                    bool expired = _fallbackContextBorn != DateTime.MinValue &&
                                   (Server.Time - _fallbackContextBorn).TotalSeconds > M1FallbackHoldSeconds;

                    // Keep the fallback through the pullback itself. Only release it after the hold
                    // window has expired AND ordinary M1 structure is actually opposing it.
                    if (expired && ordinaryOpposite)
                    {
                        candidate = null;
                        source = "NONE";
                        _fallbackContextBorn = DateTime.MinValue;
                    }
                }
            }
            else if (strongM1.HasValue)
            {
                candidate = strongM1;
                source = "M1-FALLBACK";
                _fallbackContextBorn = Server.Time;
            }
            else
            {
                candidate = null;
                source = "NONE";
            }

            if (candidate != _contextSide || source != _contextSource)
            {
                string oldText = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
                string newText = candidate.HasValue ? candidate.Value.ToString() : "NEUTRAL";
                Print("V5.1 CONTEXT | {0}/{1} -> {2}/{3} | local cycle reset", oldText, _contextSource, newText, source);
                _contextSide = candidate;
                _contextSource = source;
                BeginFreshCycle(mid, candidate);
            }
        }

        private TradeType? ReadStrongM1Fallback(double liveMid)
        {
            if (_m1 == null || _m1.Count < 9)
                return null;

            int lastClosed = _m1.Count - 2;
            int start = Math.Max(0, lastClosed - 5);
            if (lastClosed <= start)
                return null;

            double first = _m1.ClosePrices[start];
            double net = liveMid - first;
            double path = 0;
            double previous = first;
            int upSteps = 0;
            int downSteps = 0;

            for (int i = start + 1; i <= lastClosed; i++)
            {
                double close = _m1.ClosePrices[i];
                double delta = close - previous;
                path += Math.Abs(delta);
                if (delta > 0) upSteps++;
                if (delta < 0) downSteps++;
                previous = close;
            }

            double liveDelta = liveMid - previous;
            path += Math.Abs(liveDelta);
            if (liveDelta > 0) upSteps++;
            if (liveDelta < 0) downSteps++;

            if (path <= Symbol.TickSize)
                return null;

            double efficiency = Math.Abs(net) / path;
            double minimumNet = Math.Max(CurrentSpreadPrice() * 1.50, NoisePrice() * M1FallbackNoiseMultiple);
            int directionalSteps = net > 0 ? upSteps : downSteps;

            // This is intentionally stronger than ordinary LocalM1. It may provide context only
            // when M5 is neutral, so it must look like a real local mountain rather than one candle.
            if (Math.Abs(net) < minimumNet || efficiency < M1FallbackEfficiency || directionalSteps < 3)
                return null;

            return net > 0 ? TradeType.Buy : TradeType.Sell;
        }

'''
if anchor not in s:
    raise SystemExit('helper insertion anchor not found')
s = s.replace(anchor, helpers + anchor, 1)

old_status = '''        private void PrintStatus(double mid)
        {
            string context = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
            LocalBias local = ReadLocalM1Bias(mid);
            double ratio = _impulseDistance > Symbol.TickSize ? _pullbackDistance / _impulseDistance : 0;
            Print("V5.1 STATUS | M5={0} localM1={1} state={2} cycle={3} pb/imp={4:P0} mid={5:F2} noise={6:F2}",
                context, local, _state, _cycleId, ratio, mid, NoisePrice());
        }'''
new_status = '''        private void PrintStatus(double mid)
        {
            TradeType? rawM5 = ReadM5Context();
            string rawM5Text = rawM5.HasValue ? rawM5.Value.ToString() : "NEUTRAL";
            string effective = _contextSide.HasValue ? _contextSide.Value.ToString() : "NEUTRAL";
            LocalBias local = ReadLocalM1Bias(mid);
            double ratio = _impulseDistance > Symbol.TickSize ? _pullbackDistance / _impulseDistance : 0;
            Print("V5.1 STATUS | rawM5={0} effective={1}/{2} localM1={3} state={4} cycle={5} pb/imp={6:P0} mid={7:F2} noise={8:F2}",
                rawM5Text, effective, _contextSource, local, _state, _cycleId, ratio, mid, NoisePrice());
        }'''
if old_status not in s:
    raise SystemExit('status block not found')
s = s.replace(old_status, new_status, 1)

# Add startup explanation without touching exit rules.
startup_anchor = '            Print("ENTRY ENGINE | frozen from V4");\n'
startup_add = ('            Print("ENTRY ENGINE | frozen from V4");\n'
               '            Print("V5.1 CONTEXT PATCH | M5 directional has priority; when M5 is neutral, strong M1 may latch temporary context through its pullback");\n')
if startup_anchor not in s:
    raise SystemExit('startup anchor not found')
s = s.replace(startup_anchor, startup_add, 1)

out.write_text(s)
print(f'generated {out} from {base}')
