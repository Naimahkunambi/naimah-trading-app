using System;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiRunnerV1RegimeV2 : Robot
{
    private const string Label = "NAI-RUNNER-V1-REGIME-V2";
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

    private Bars _m1 = null!;
    private Bars _m5 = null!;
    private Bars _m15 = null!;

    private DateTime _lastLiveM1Open = DateTime.MinValue;
    private DateTime _lastRegimePrint = DateTime.MinValue;
    private double _dayStartEquity;
    private DateTime _equityDay;
    private int _lastEntryIndex = -10000;
    private bool _halted;
    private int _scanCount;
    private double? _lastStopRequestPrice;
    private RegimeState _regime = RegimeState.Mixed;
    private int _m15Score;
    private int _m5Score;
    private string _regimeReason = "warming up";
    private TradeMeta? _activeMeta;

    private int _bullScans;
    private int _bearScans;
    private int _mixedBlockedScans;
    private int _transitionBlockedScans;
    private int _longTrades;
    private int _shortTrades;
    private int _longWins;
    private int _longLosses;
    private int _longScratch;
    private int _shortWins;
    private int _shortLosses;
    private int _shortScratch;
    private int _pullbackInvalidationExits;
    private int _momentumInvalidationExits;
    private double _longNet;
    private double _shortNet;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI RUNNER V1 REGIME V2 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI RUNNER V1 REGIME V2 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _m5 = MarketData.GetBars(TimeFrame.Minute5, SymbolName);
        _m15 = MarketData.GetBars(TimeFrame.Minute15, SymbolName);
        _dayStartEquity = Account.Equity;
        _equityDay = Server.Time.Date;

        Positions.Closed += OnPositionClosed;
        RefreshRegime();

        Print("NAI RUNNER V1 REGIME V2 STARTED | {0} | DEMO | LONG+SHORT", SymbolName);
        Print("ENTRY CORE | EXACT RUNNER V1 | Pullback Runner + Momentum Runner | mirrored both directions");
        Print("PERMISSION | BULL=LONG | BEAR=SHORT | MIXED/TRANSITION=WAIT | exhaustion blocks late entries");
        Print("EXIT OWNERSHIP | PULLBACK exits only on pullback structure failure | MOMENTUM exits only on breakout failure");
        Print("NO GENERIC OPPOSITE-VOTE PANIC EXIT | regime never closes an existing trade");
        Print("RISK | {0:F2}% | TP={1:F2}R | BE={2:F2}R | TRAIL={3:F2}R", RiskPercent, TargetR, BreakEvenAtR, TrailAtR);
        PrintRegime("START");
    }

    protected override void OnStop()
    {
        Positions.Closed -= OnPositionClosed;
        PrintStats("BOT STOP");
    }

    protected override void OnTick()
    {
        if (_halted || Account.IsLive)
            return;

        ResetDailyAnchorIfNeeded();
        if (HitDailyStop())
            return;

        ManageOpenPosition();

        if (_m1 == null || _m1.Count < 45 || _m5.Count < 30 || _m15.Count < 30)
            return;

        var liveOpen = _m1.OpenTimes[_m1.Count - 1];
        if (liveOpen == _lastLiveM1Open)
            return;

        _lastLiveM1Open = liveOpen;
        var closedIndex = _m1.Count - 2;
        RefreshRegime();
        ProcessClosedMinute(closedIndex);
    }

    private void ProcessClosedMinute(int i)
    {
        _scanCount++;
        if (i < 35)
            return;

        var open = FindRunnerPosition();
        if (open != null)
        {
            EvaluateSetupInvalidation(open, i);
            var stillOpen = FindRunnerPosition();
            if (stillOpen != null)
                PrintPositionStatus(stillOpen, i);
            return;
        }

        var barsSinceEntry = i - _lastEntryIndex;
        if (barsSinceEntry < CooldownBars)
        {
            Print("NAI RUNNER | WAIT | scan={0} cooldown={1}/{2}", _scanCount, barsSinceEntry, CooldownBars);
            return;
        }

        if (_regime == RegimeState.Mixed)
        {
            _mixedBlockedScans++;
            Print("NAI PERMISSION | MIXED | NO TRADE | M15={0} M5={1} | {2}", _m15Score, _m5Score, _regimeReason);
            return;
        }

        if (_regime == RegimeState.Transition)
        {
            _transitionBlockedScans++;
            Print("NAI PERMISSION | TRANSITION | NO TRADE | M15={0} M5={1} | {2}", _m15Score, _m5Score, _regimeReason);
            return;
        }

        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize * 5)
        {
            Print("NAI RUNNER | WAIT | scan={0} ATR={1:F2} too small", _scanCount, atr);
            return;
        }

        TrendVotes(i, out var bull, out var bear);
        var trend = bull >= 3 && bull > bear ? 1 : bear >= 3 && bear > bull ? -1 : 0;
        var permittedDirection = _regime == RegimeState.Bull ? 1 : -1;

        if (_regime == RegimeState.Bull) _bullScans++;
        else _bearScans++;

        if (trend != permittedDirection)
        {
            Print("NAI RUNNER | WAIT | regime={0} but V1 M1 direction not aligned | votes={1}/{2}", _regime.ToString().ToUpperInvariant(), bull, bear);
            return;
        }

        // Original V1 order is untouched: Pullback first, then Momentum.
        var setup = FindPullbackEntry(i, trend, atr) ?? FindMomentumEntry(i, trend, atr);
        if (setup == null)
        {
            var fast = AverageClose(_m1, i - 5, i);
            var slow = AverageClose(_m1, i - 17, i);
            var distance = Math.Abs(_m1.ClosePrices[i] - fast) / atr;
            Print("NAI RUNNER | WAIT | regime={0} direction={1} votes={2}/{3} but no V1 setup | fastSlow={4:F2}ATR priceFast={5:F2}ATR",
                _regime.ToString().ToUpperInvariant(), trend > 0 ? "LONG" : "SHORT", bull, bear, Math.Abs(fast - slow) / atr, distance);
            return;
        }

        if (!EntryEnvironmentHealthy(setup, i, atr, out var blockReason))
        {
            _transitionBlockedScans++;
            Print("NAI PERMISSION | TRANSITION/EXHAUSTION BLOCK | {0} {1} | {2}", setup.Direction > 0 ? "LONG" : "SHORT", setup.Name, blockReason);
            return;
        }

        ExecuteSetup(setup, i);
    }

    // Exact original Runner V1 Pullback entry thresholds.
    private Setup? FindPullbackEntry(int i, int trend, double atr)
    {
        var fast = AverageClose(_m1, i - 5, i);
        var slow = AverageClose(_m1, i - 17, i);
        var open = _m1.OpenPrices[i];
        var close = _m1.ClosePrices[i];
        var high = _m1.HighPrices[i];
        var low = _m1.LowPrices[i];
        var range = Math.Max(Symbol.TickSize, high - low);
        var body = Math.Abs(close - open);

        var trendSeparated = trend > 0 ? fast > slow + atr * 0.05 : fast < slow - atr * 0.05;
        if (!trendSeparated)
            return null;

        var touchedValue = trend > 0 ? low <= fast + atr * 0.18 : high >= fast - atr * 0.18;
        var closedBack = trend > 0 ? close > fast : close < fast;
        var candleAligned = trend > 0 ? close > open : close < open;
        var closeStrong = trend > 0 ? close >= low + range * 0.58 : close <= high - range * 0.58;

        if (!touchedValue || !closedBack || !candleAligned || !closeStrong || body < atr * 0.12)
            return null;

        var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = trend > 0 ? LowestLow(_m1, i - 4, i) : HighestHigh(_m1, i - 4, i);
        var stop = trend > 0 ? swing - atr * 0.10 : swing + atr * 0.10;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.45)
        {
            risk = atr * 0.55;
            stop = trend > 0 ? entry - risk : entry + risk;
        }
        if (risk > atr * 1.55)
            return null;

        var target = trend > 0 ? entry + risk * TargetR : entry - risk * TargetR;
        return new Setup(trend, "PULLBACK RUNNER", entry, stop, target, risk, swing,
            $"valueTouch fast={fast:F2} body={body / atr:F2}ATR risk={risk / atr:F2}ATR swing={swing:F2}");
    }

    // Exact original Runner V1 Momentum entry thresholds.
    private Setup? FindMomentumEntry(int i, int trend, double atr)
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
        var broke = trend > 0 ? close > priorHigh : close < priorLow;
        var aligned = trend > 0 ? close > open : close < open;
        var closeStrong = trend > 0 ? close >= low + range * 0.70 : close <= high - range * 0.70;
        var distanceFromFast = Math.Abs(close - fast) / atr;
        var efficiency = Efficiency(_m1, i - 4, i);

        if (!broke || !aligned || !closeStrong || body < atr * 0.28 || efficiency < 0.48 || distanceFromFast > 1.25)
            return null;

        var entry = trend > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = trend > 0 ? LowestLow(_m1, i - 3, i) : HighestHigh(_m1, i - 3, i);
        var stop = trend > 0 ? swing - atr * 0.08 : swing + atr * 0.08;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.50)
        {
            risk = atr * 0.60;
            stop = trend > 0 ? entry - risk : entry + risk;
        }
        if (risk > atr * 1.40)
            return null;

        var target = trend > 0 ? entry + risk * TargetR : entry - risk * TargetR;
        var breakoutLevel = trend > 0 ? priorHigh : priorLow;
        return new Setup(trend, "MOMENTUM RUNNER", entry, stop, target, risk, breakoutLevel,
            $"break4={breakoutLevel:F2} eff={efficiency:F2} body={body / atr:F2}ATR fastDist={distanceFromFast:F2}ATR");
    }

    private bool EntryEnvironmentHealthy(Setup setup, int i, double atr, out string reason)
    {
        reason = "healthy";
        var direction = setup.Direction;
        var fastNow = AverageClose(_m1, i - 5, i);
        var fastPast = AverageClose(_m1, i - 8, i - 3);
        var fastSlope = (fastNow - fastPast) / atr;
        var move3 = (_m1.ClosePrices[i] - _m1.ClosePrices[i - 3]) / atr;

        if (direction > 0 && (fastSlope < -0.03 || move3 < -0.12))
        {
            reason = $"M1 turning against LONG slope={fastSlope:F2}ATR move3={move3:F2}ATR";
            return false;
        }

        if (direction < 0 && (fastSlope > 0.03 || move3 > 0.12))
        {
            reason = $"M1 turning against SHORT slope={fastSlope:F2}ATR move3={move3:F2}ATR";
            return false;
        }

        // Momentum is the setup most vulnerable to entering the final burst of a move.
        // Do not alter its V1 entry thresholds; this is a separate permission veto for obvious late extension.
        if (setup.Name == "MOMENTUM RUNNER")
        {
            var fastDistance = Math.Abs(_m1.ClosePrices[i] - fastNow) / atr;
            var runMove = direction > 0
                ? (_m1.ClosePrices[i] - _m1.ClosePrices[Math.Max(0, i - 5)]) / atr
                : (_m1.ClosePrices[Math.Max(0, i - 5)] - _m1.ClosePrices[i]) / atr;
            var body = Math.Abs(_m1.ClosePrices[i] - _m1.OpenPrices[i]) / atr;

            if (fastDistance >= 0.90 && runMove >= 1.35 && body >= 0.55)
            {
                reason = $"late momentum burst fastDist={fastDistance:F2}ATR run5={runMove:F2}ATR body={body:F2}ATR";
                return false;
            }
        }

        return true;
    }

    private void ExecuteSetup(Setup setup, int i)
    {
        var stopPips = Math.Abs(setup.Entry - setup.Stop) / Symbol.PipSize;
        var tpPips = Math.Abs(setup.Target - setup.Entry) / Symbol.PipSize;
        if (stopPips <= 0 || tpPips <= 0)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);

        if (volume < Symbol.VolumeInUnitsMin)
        {
            Print("NAI RUNNER | SKIP | risk-size {0} below broker min {1} | stop={2:F0} pips", volume, Symbol.VolumeInUnitsMin, stopPips);
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var tradeType = setup.Direction > 0 ? TradeType.Buy : TradeType.Sell;
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, setup.Name);

        if (!result.IsSuccessful)
        {
            Print("NAI RUNNER | ENTRY REJECTED | {0} | {1}", setup.Name, result.Error);
            return;
        }

        _lastEntryIndex = i;
        _lastStopRequestPrice = null;
        _activeMeta = new TradeMeta(setup.Direction, setup.Name, i, setup.InvalidationLevel, Atr(_m1, i));
        if (tradeType == TradeType.Buy) _longTrades++; else _shortTrades++;

        Print("NAI RUNNER | ENTER {0} | {1} | entry={2} SL={3} TP={4} volume={5} target={6:F2}R | regime={7} M15={8} M5={9} | invalidation={10:F2} | {11}",
            tradeType, setup.Name, result.Position.EntryPrice, setup.Stop, setup.Target, volume, TargetR,
            _regime.ToString().ToUpperInvariant(), _m15Score, _m5Score, setup.InvalidationLevel, setup.Reason);
    }

    private void EvaluateSetupInvalidation(Position p, int i)
    {
        var meta = _activeMeta;
        if (meta == null || i <= meta.EntryBarIndex)
            return;

        var age = i - meta.EntryBarIndex;
        if (age > 4)
            return;

        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize)
            return;

        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;

        // Once the trade has reached the protection phase, BE/trailing owns management.
        if (r >= BreakEvenAtR)
            return;

        var close = _m1.ClosePrices[i];
        var open = _m1.OpenPrices[i];
        var fast = AverageClose(_m1, i - 5, i);
        var invalid = false;
        var explanation = "";

        if (meta.SetupName == "PULLBACK RUNNER")
        {
            if (meta.Direction > 0)
            {
                invalid = close < meta.InvalidationLevel && close < fast && close < open;
                explanation = $"LONG pullback swing failed close={close:F2} swing={meta.InvalidationLevel:F2} fast={fast:F2}";
            }
            else
            {
                invalid = close > meta.InvalidationLevel && close > fast && close > open;
                explanation = $"SHORT pullback swing failed close={close:F2} swing={meta.InvalidationLevel:F2} fast={fast:F2}";
            }
        }
        else if (meta.SetupName == "MOMENTUM RUNNER")
        {
            var reclaimBuffer = atr * 0.03;
            if (meta.Direction > 0)
            {
                invalid = close < meta.InvalidationLevel - reclaimBuffer && close < open;
                explanation = $"LONG breakout failed close={close:F2} break={meta.InvalidationLevel:F2}";
            }
            else
            {
                invalid = close > meta.InvalidationLevel + reclaimBuffer && close > open;
                explanation = $"SHORT breakout failed close={close:F2} break={meta.InvalidationLevel:F2}";
            }
        }

        if (!invalid)
            return;

        var result = ClosePosition(p);
        if (!result.IsSuccessful)
        {
            Print("NAI INVALIDATION | CLOSE REJECTED | {0} | error={1}", meta.SetupName, result.Error);
            return;
        }

        if (meta.SetupName == "PULLBACK RUNNER") _pullbackInvalidationExits++;
        else if (meta.SetupName == "MOMENTUM RUNNER") _momentumInvalidationExits++;

        Print("NAI INVALIDATION | {0} EXIT | age={1} R={2:F2} | {3}", meta.SetupName, age, r, explanation);
    }

    private void ManageOpenPosition()
    {
        var p = FindRunnerPosition();
        if (p == null || !p.TakeProfit.HasValue || !p.StopLoss.HasValue)
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

        if (r >= TrailAtR && _m1.Count > 5)
        {
            var i = _m1.Count - 2;
            var atr = Atr(_m1, i);
            var candidate = p.TradeType == TradeType.Buy
                ? LowestLow(_m1, i - 2, i) - atr * 0.08
                : HighestHigh(_m1, i - 2, i) + atr * 0.08;
            TryMoveStop(p, candidate, "TRAIL", r);
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
            Print("NAI RUNNER | {0} SUCCESS | {1} SL->{2:F2} | liveR={3:F2}", reason, p.TradeType, candidate, liveR);
        else
            Print("NAI RUNNER | {0} REJECTED | requested={1:F2} error={2}", reason, candidate, result.Error);
    }

    private void PrintPositionStatus(Position p, int i)
    {
        var originalRisk = p.TakeProfit.HasValue ? Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR : 0;
        var price = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? price - p.EntryPrice : p.EntryPrice - price;
        var r = originalRisk > Symbol.TickSize ? favorable / originalRisk : 0;
        var setup = _activeMeta?.SetupName ?? "unknown/restart";
        Print("NAI RUNNER | HOLD | {0} {1} P/L={2:F2} R={3:F2} SL={4} TP={5} | regimeNow={6}",
            p.TradeType, setup, p.NetProfit, r,
            p.StopLoss.HasValue ? p.StopLoss.Value.ToString("F2") : "--",
            p.TakeProfit.HasValue ? p.TakeProfit.Value.ToString("F2") : "--",
            _regime.ToString().ToUpperInvariant());
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.Label != Label || p.SymbolName != SymbolName)
            return;

        var intendedRisk = Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        var isWin = p.NetProfit > intendedRisk * 0.15;
        var isLoss = p.NetProfit < -intendedRisk * 0.15;

        if (p.TradeType == TradeType.Buy)
        {
            _longNet += p.NetProfit;
            if (isWin) _longWins++;
            else if (isLoss) _longLosses++;
            else _longScratch++;
        }
        else
        {
            _shortNet += p.NetProfit;
            if (isWin) _shortWins++;
            else if (isLoss) _shortLosses++;
            else _shortScratch++;
        }

        var setupName = _activeMeta?.SetupName ?? "unknown/restart";
        _lastStopRequestPrice = null;
        _activeMeta = null;
        Print("NAI RESULT | {0} {1} | net={2:F2} reason={3}", p.TradeType, setupName, p.NetProfit, args.Reason);
        PrintStats("TRADE CLOSED");
    }

    private void PrintStats(string trigger)
    {
        Print("=== NAI V1 REGIME V2 STATS | {0} ===", trigger);
        Print("LONG | trades={0} W={1} L={2} scratch={3} net={4:F2}", _longTrades, _longWins, _longLosses, _longScratch, _longNet);
        Print("SHORT | trades={0} W={1} L={2} scratch={3} net={4:F2}", _shortTrades, _shortWins, _shortLosses, _shortScratch, _shortNet);
        Print("PERMISSION | BULL_SCANS={0} BEAR_SCANS={1} MIXED_BLOCKED={2} TRANSITION_BLOCKED={3}", _bullScans, _bearScans, _mixedBlockedScans, _transitionBlockedScans);
        Print("INVALIDATION EXITS | PULLBACK={0} MOMENTUM={1}", _pullbackInvalidationExits, _momentumInvalidationExits);
        Print("TOTAL NET | {0:F2}", _longNet + _shortNet);
        Print("=== END NAI V1 REGIME V2 STATS ===");
    }

    private void RefreshRegime()
    {
        if (_m5.Count < 25 || _m15.Count < 25)
        {
            _regime = RegimeState.Mixed;
            _regimeReason = "warming up";
            return;
        }

        _m15Score = ContextScore(_m15, _m15.Count - 2);
        _m5Score = ContextScore(_m5, _m5.Count - 2);

        var baseDirection = 0;
        if (_m15Score >= 2 && _m5Score >= 1) baseDirection = 1;
        else if (_m15Score <= -2 && _m5Score <= -1) baseDirection = -1;

        if (baseDirection == 0)
        {
            _regime = RegimeState.Mixed;
            _regimeReason = "M15/M5 do not agree strongly enough";
        }
        else if (HigherTimeframeTransition(baseDirection, out var transitionReason))
        {
            _regime = RegimeState.Transition;
            _regimeReason = transitionReason;
        }
        else
        {
            _regime = baseDirection > 0 ? RegimeState.Bull : RegimeState.Bear;
            _regimeReason = baseDirection > 0 ? "M15/M5 bullish and still progressing" : "M15/M5 bearish and still progressing";
        }

        if (_lastRegimePrint == DateTime.MinValue || Server.Time - _lastRegimePrint >= TimeSpan.FromMinutes(5))
        {
            PrintRegime("UPDATE");
            _lastRegimePrint = Server.Time;
        }
    }

    private bool HigherTimeframeTransition(int direction, out string reason)
    {
        reason = "";
        var i = _m5.Count - 2;
        var atr = Atr(_m5, i);
        if (atr <= Symbol.TickSize)
            return true;

        var fastNow = AverageClose(_m5, i - 5, i);
        var fastPast = AverageClose(_m5, i - 8, i - 3);
        var slope = (fastNow - fastPast) / atr;
        var move2 = (_m5.ClosePrices[i] - _m5.ClosePrices[i - 2]) / atr;
        var structure = StructureDirection(_m5, i);

        if (direction > 0)
        {
            if (slope < -0.02)
            {
                reason = $"bull context but M5 fast slope turned down {slope:F2}ATR";
                return true;
            }
            if (move2 < -0.18)
            {
                reason = $"bull context but M5 move2 reversed {move2:F2}ATR";
                return true;
            }
            if (structure < 0)
            {
                reason = "bull context but M5 structure turned bearish";
                return true;
            }
        }
        else
        {
            if (slope > 0.02)
            {
                reason = $"bear context but M5 fast slope turned up {slope:F2}ATR";
                return true;
            }
            if (move2 > 0.18)
            {
                reason = $"bear context but M5 move2 reversed {move2:F2}ATR";
                return true;
            }
            if (structure > 0)
            {
                reason = "bear context but M5 structure turned bullish";
                return true;
            }
        }

        return false;
    }

    private int ContextScore(Bars bars, int i)
    {
        if (i < 20)
            return 0;

        var atr = Atr(bars, i);
        if (atr <= Symbol.TickSize)
            return 0;

        var score = 0;
        var fast = AverageClose(bars, i - 5, i);
        var slow = AverageClose(bars, i - 17, i);
        if (fast > slow + atr * 0.05) score++;
        else if (fast < slow - atr * 0.05) score--;

        var fastPast = AverageClose(bars, i - 9, i - 4);
        if (fast > fastPast + atr * 0.05) score++;
        else if (fast < fastPast - atr * 0.05) score--;

        var move3 = bars.ClosePrices[i] - bars.ClosePrices[i - 3];
        if (move3 > atr * 0.18) score++;
        else if (move3 < -atr * 0.18) score--;

        var structure = StructureDirection(bars, i);
        if (structure > 0) score++;
        else if (structure < 0) score--;

        return score;
    }

    private void PrintRegime(string source)
    {
        Print("NAI REGIME | {0} | {1} | M15={2} M5={3} | {4}", source, _regime.ToString().ToUpperInvariant(), _m15Score, _m5Score, _regimeReason);
    }

    private Position? FindRunnerPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    // Exact original V1 M1 trend votes.
    private void TrendVotes(int i, out int bull, out int bear)
    {
        bull = 0;
        bear = 0;
        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize)
            return;

        var fast = AverageClose(_m1, i - 5, i);
        var slow = AverageClose(_m1, i - 17, i);
        if (fast > slow + atr * 0.04) bull++; else if (fast < slow - atr * 0.04) bear++;

        var fastPast = AverageClose(_m1, i - 9, i - 4);
        if (fast > fastPast + atr * 0.05) bull++; else if (fast < fastPast - atr * 0.05) bear++;

        var move3 = _m1.ClosePrices[i] - _m1.ClosePrices[i - 3];
        if (move3 > atr * 0.12) bull++; else if (move3 < -atr * 0.12) bear++;

        var structure = StructureDirection(_m1, i);
        if (structure > 0) bull++; else if (structure < 0) bear++;

        var body = _m1.ClosePrices[i] - _m1.OpenPrices[i];
        if (body > atr * 0.10) bull++; else if (body < -atr * 0.10) bear++;
    }

    private int StructureDirection(Bars bars, int i)
    {
        if (i < 12)
            return 0;
        var recentHigh = HighestHigh(bars, i - 5, i);
        var recentLow = LowestLow(bars, i - 5, i);
        var priorHigh = HighestHigh(bars, i - 11, i - 6);
        var priorLow = LowestLow(bars, i - 11, i - 6);
        var atr = Atr(bars, i);
        var tol = atr * 0.05;
        if (recentHigh > priorHigh + tol && recentLow >= priorLow - tol) return 1;
        if (recentLow < priorLow - tol && recentHigh <= priorHigh + tol) return -1;
        return 0;
    }

    private void ResetDailyAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay)
            return;
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        Print("NAI RUNNER | NEW DAY | equity anchor={0:F2}", _dayStartEquity);
    }

    private bool HitDailyStop()
    {
        if (_dayStartEquity <= 0)
            return false;
        var dd = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (dd < DailyEquityStopPercent)
            return false;

        _halted = true;
        var p = FindRunnerPosition();
        if (p != null)
            ClosePosition(p);
        Print("NAI RUNNER HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
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

    private double Atr(Bars bars, int i)
    {
        var from = Math.Max(1, i - AtrPeriod + 1);
        double total = 0;
        var count = 0;
        for (var k = from; k <= i; k++)
        {
            var tr = Math.Max(bars.HighPrices[k] - bars.LowPrices[k],
                Math.Max(Math.Abs(bars.HighPrices[k] - bars.ClosePrices[k - 1]), Math.Abs(bars.LowPrices[k] - bars.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private double Efficiency(Bars bars, int from, int to)
    {
        if (to <= from)
            return 0;
        var net = Math.Abs(bars.ClosePrices[to] - bars.ClosePrices[from]);
        double path = 0;
        for (var k = from + 1; k <= to; k++)
            path += Math.Abs(bars.ClosePrices[k] - bars.ClosePrices[k - 1]);
        return path <= Symbol.TickSize ? 0 : net / path;
    }

    private double AverageClose(Bars bars, int from, int to)
    {
        from = Math.Max(0, from);
        double sum = 0;
        var count = 0;
        for (var k = from; k <= to; k++)
        {
            sum += bars.ClosePrices[k];
            count++;
        }
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

    private enum RegimeState
    {
        Bull,
        Mixed,
        Transition,
        Bear
    }

    private sealed record Setup(int Direction, string Name, double Entry, double Stop, double Target, double Risk, double InvalidationLevel, string Reason);
    private sealed record TradeMeta(int Direction, string SetupName, int EntryBarIndex, double InvalidationLevel, double EntryAtr);
}
