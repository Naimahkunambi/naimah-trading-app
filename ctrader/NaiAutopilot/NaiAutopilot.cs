using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiDecisionEngineV1 : Robot
{
    private const string Label = "NAI-DECISION-V1";
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

    [Parameter("Max Chase ATR", DefaultValue = 0.28, MinValue = 0.10, MaxValue = 0.80, Step = 0.02)]
    public double MaxChaseAtr { get; set; }

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

    private RegimeState _regime = RegimeState.Mixed;
    private DirectionChoice _legalDirection = DirectionChoice.None;
    private string _contextReason = "warming up";
    private SetupPlan? _armedPlan;
    private DateTime _armedAt = DateTime.MinValue;

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
    private readonly Dictionary<string, int> _hourRejectReasons = new();

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI DECISION V1 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI DECISION V1 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
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
        RefreshContext(force: true);

        Print("NAI DECISION ENGINE V1 STARTED | {0} | DEMO | M15/M5 context + M1 decisions + tick execution", SymbolName);
        Print("DECISION CHOICES | LONG / SHORT / WAIT / SKIP | risk={0:F2}% target={1:F2}R BE={2:F2}R trail={3:F2}R chaseMax={4:F2}ATR", RiskPercent, TargetR, BreakEvenAtR, TrailAtR, MaxChaseAtr);
        Print("HOURLY SUMMARY ON | screenshot the block beginning '=== NAI HOURLY SUMMARY ==='");
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
        RefreshContext(force: false);
        ManageOpenPosition();

        if (FindDecisionPosition() != null)
            return;

        ProcessNewM1IfNeeded();
        TryExecuteArmedPlan();
    }

    private void RefreshContext(bool force)
    {
        if (_m5.Count < 30 || _m15.Count < 30)
            return;

        var m5Open = _m5.OpenTimes[_m5.Count - 1];
        var m15Open = _m15.OpenTimes[_m15.Count - 1];
        if (!force && m5Open == _lastM5Open && m15Open == _lastM15Open)
            return;

        _lastM5Open = m5Open;
        _lastM15Open = m15Open;

        var i5 = _m5.Count - 2;
        var i15 = _m15.Count - 2;
        var s5 = ContextScore(_m5, i5);
        var s15 = ContextScore(_m15, i15);

        var strongBull15 = s15 >= 3;
        var strongBear15 = s15 <= -3;
        var bull5 = s5 >= 2;
        var bear5 = s5 <= -2;

        if (strongBull15 && bull5)
        {
            _regime = RegimeState.Bull;
            _legalDirection = DirectionChoice.Long;
            _contextReason = $"M15={s15} M5={s5} aligned bull";
        }
        else if (strongBear15 && bear5)
        {
            _regime = RegimeState.Bear;
            _legalDirection = DirectionChoice.Short;
            _contextReason = $"M15={s15} M5={s5} aligned bear";
        }
        else if ((strongBull15 && bear5) || (strongBear15 && bull5))
        {
            _regime = RegimeState.Transition;
            _legalDirection = DirectionChoice.None;
            _contextReason = $"M15={s15} conflicts M5={s5}";
        }
        else
        {
            _regime = RegimeState.Mixed;
            _legalDirection = DirectionChoice.None;
            _contextReason = $"M15={s15} M5={s5} insufficient alignment";
        }

        Print("NAI CONTEXT | regime={0} legal={1} | {2}", _regime, _legalDirection, _contextReason);

        if (_armedPlan != null && _armedPlan.Direction != _legalDirection)
        {
            Print("NAI DECISION | CANCEL ARMED | context changed from {0} to legal={1}", _armedPlan.Direction, _legalDirection);
            _armedPlan = null;
        }
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
        _hourDecisions++;

        var barsSinceEntry = i - _lastEntryM1Index;
        if (barsSinceEntry < CooldownBars)
        {
            RegisterWait("cooldown");
            Print("NAI DECISION | WAIT | cooldown {0}/{1} | regime={2}", barsSinceEntry, CooldownBars, _regime);
            return;
        }

        if (_legalDirection == DirectionChoice.None)
        {
            if (_regime == RegimeState.Transition)
                RegisterWait("timeframe conflict");
            else
                RegisterSkip("mixed/chop");

            Print("NAI DECISION | {0} | regime={1} | {2}", _regime == RegimeState.Transition ? "WAIT" : "SKIP", _regime, _contextReason);
            return;
        }

        var atr = Atr(_m1, i);
        if (atr <= Symbol.TickSize * 5)
        {
            RegisterSkip("ATR too small");
            return;
        }

        var dir = _legalDirection == DirectionChoice.Long ? 1 : -1;
        M1TrendVotes(i, out var bull, out var bear);
        var m1Aligned = dir > 0 ? bull >= 3 && bull > bear : bear >= 3 && bear > bull;

        if (!m1Aligned)
        {
            RegisterWait("M1 not aligned");
            Print("NAI DECISION | WAIT | regime={0} legal={1} but M1 votes={2}/{3}", _regime, _legalDirection, bull, bear);
            return;
        }

        var setup = FindPullbackEntry(i, dir, atr) ?? FindMomentumEntry(i, dir, atr);
        if (setup == null)
        {
            RegisterWait("no valid setup");
            Print("NAI DECISION | WAIT | {0} legal | M1 aligned {1}/{2} | no pullback/momentum setup", _legalDirection, bull, bear);
            return;
        }

        var fast = AverageClose(_m1, i - 5, i);
        var closedPrice = _m1.ClosePrices[i];
        var extension = Math.Abs(closedPrice - fast) / atr;
        if (extension > 1.10)
        {
            RegisterSkip("late/extended");
            Print("NAI DECISION | SKIP | direction={0} setup={1} | TOO EXTENDED {2:F2}ATR from value", _legalDirection, setup.Name, extension);
            return;
        }

        _armedPlan = setup;
        _armedAt = Server.Time;
        if (setup.Direction == DirectionChoice.Long) _hourLongDecisions++; else _hourShortDecisions++;

        Print("NAI DECISION | ARM {0} | regime={1} setup={2} | planned={3:F2} chaseLimit={4:F2}ATR | {5}", setup.Direction, _regime, setup.Name, setup.EntryReference, MaxChaseAtr, setup.Reason);
    }

    private void TryExecuteArmedPlan()
    {
        var plan = _armedPlan;
        if (plan == null)
            return;

        if ((Server.Time - _armedAt).TotalMinutes > 1.2)
        {
            RegisterSkip("armed setup expired");
            Print("NAI DECISION | SKIP | armed {0} setup expired", plan.Direction);
            _armedPlan = null;
            return;
        }

        if (_legalDirection != plan.Direction)
        {
            RegisterSkip("context invalidated");
            _armedPlan = null;
            return;
        }

        var i = _m1.Count - 2;
        var atr = Atr(_m1, i);
        if (atr <= 0)
            return;

        var marketPrice = plan.Direction == DirectionChoice.Long ? Symbol.Ask : Symbol.Bid;
        var chase = plan.Direction == DirectionChoice.Long
            ? (marketPrice - plan.EntryReference) / atr
            : (plan.EntryReference - marketPrice) / atr;

        if (chase > MaxChaseAtr)
        {
            RegisterSkip("chased away");
            Print("NAI DECISION | SKIP | {0} moved {1:F2}ATR beyond planned entry | no chase", plan.Direction, chase);
            _armedPlan = null;
            return;
        }

        if (chase < -0.35)
            return;

        ExecutePlan(plan, i, marketPrice, atr);
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

        var trendSeparated = dir > 0 ? fast > slow + atr * 0.05 : fast < slow - atr * 0.05;
        var touchedValue = dir > 0 ? low <= fast + atr * 0.18 : high >= fast - atr * 0.18;
        var closedBack = dir > 0 ? close > fast : close < fast;
        var candleAligned = dir > 0 ? close > open : close < open;
        var closeStrong = dir > 0 ? close >= low + range * 0.58 : close <= high - range * 0.58;

        if (!trendSeparated || !touchedValue || !closedBack || !candleAligned || !closeStrong || body < atr * 0.12)
            return null;

        var entry = dir > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = dir > 0 ? LowestLow(_m1, i - 4, i) : HighestHigh(_m1, i - 4, i);
        var stop = dir > 0 ? swing - atr * 0.10 : swing + atr * 0.10;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.45)
        {
            risk = atr * 0.55;
            stop = dir > 0 ? entry - risk : entry + risk;
        }
        if (risk > atr * 1.55)
            return null;

        return new SetupPlan(dir > 0 ? DirectionChoice.Long : DirectionChoice.Short, "PULLBACK", entry, risk, $"valueTouch body={body / atr:F2}ATR risk={risk / atr:F2}ATR");
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
        var closeStrong = dir > 0 ? close >= low + range * 0.70 : close <= high - range * 0.70;
        var distanceFromFast = Math.Abs(close - fast) / atr;
        var efficiency = Efficiency(_m1, i - 4, i);

        if (!broke || !aligned || !closeStrong || body < atr * 0.28 || efficiency < 0.48 || distanceFromFast > 1.25)
            return null;

        var entry = dir > 0 ? Symbol.Ask : Symbol.Bid;
        var swing = dir > 0 ? LowestLow(_m1, i - 3, i) : HighestHigh(_m1, i - 3, i);
        var stop = dir > 0 ? swing - atr * 0.08 : swing + atr * 0.08;
        var risk = Math.Abs(entry - stop);

        if (risk < atr * 0.50)
            risk = atr * 0.60;
        if (risk > atr * 1.40)
            return null;

        return new SetupPlan(dir > 0 ? DirectionChoice.Long : DirectionChoice.Short, "MOMENTUM", entry, risk, $"break4 eff={efficiency:F2} body={body / atr:F2}ATR fastDist={distanceFromFast:F2}ATR");
    }

    private void ExecutePlan(SetupPlan plan, int i, double marketPrice, double atr)
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
            Print("NAI EXECUTION | SKIP | volume={0} below min={1}", volume, Symbol.VolumeInUnitsMin);
            _armedPlan = null;
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var type = plan.Direction == DirectionChoice.Long ? TradeType.Buy : TradeType.Sell;
        var result = ExecuteMarketOrder(type, SymbolName, volume, Label, stopPips, tpPips, $"{_regime}:{plan.Name}");

        if (!result.IsSuccessful)
        {
            RegisterSkip("entry rejected");
            Print("NAI EXECUTION | REJECTED | {0} {1} | error={2}", plan.Direction, plan.Name, result.Error);
            _armedPlan = null;
            return;
        }

        _hourEntries++;
        if (type == TradeType.Buy) _hourLongTrades++; else _hourShortTrades++;
        _lastEntryM1Index = i;
        _entryM1Index = i;
        _lastStopRequestPrice = null;
        _armedPlan = null;

        Print("NAI EXECUTION | ENTER {0} | regime={1} setup={2} entry={3:F2} SL={4:F2} TP={5:F2} risk={6:F2}% target={7:F2}R | {8}", type, _regime, plan.Name, result.Position.EntryPrice, stop, target, RiskPercent, TargetR, plan.Reason);
    }

    private void ManageOpenPosition()
    {
        var p = FindDecisionPosition();
        if (p == null || !p.TakeProfit.HasValue || !p.StopLoss.HasValue)
            return;

        var originalRisk = Math.Abs(p.TakeProfit.Value - p.EntryPrice) / TargetR;
        if (originalRisk <= Symbol.TickSize)
            return;

        var marketPrice = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var favorable = p.TradeType == TradeType.Buy ? marketPrice - p.EntryPrice : p.EntryPrice - marketPrice;
        var r = favorable / originalRisk;

        // Fast thesis protection: if higher-timeframe context now legalizes the opposite side, close weak trade.
        var thesisBroken = p.TradeType == TradeType.Buy ? _legalDirection == DirectionChoice.Short : _legalDirection == DirectionChoice.Long;
        if (thesisBroken && r < 0.40)
        {
            var result = ClosePosition(p);
            if (result.IsSuccessful)
                Print("NAI POSITION | THESIS BROKEN EXIT | {0} R={1:F2} newLegal={2}", p.TradeType, r, _legalDirection);
            return;
        }

        if (r >= BreakEvenAtR)
        {
            var improveToBe = p.TradeType == TradeType.Buy ? p.StopLoss.Value < p.EntryPrice : p.StopLoss.Value > p.EntryPrice;
            if (improveToBe)
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
            var maxLegal = NormalizePrice(Symbol.Bid - safety, RoundingMode.Down);
            candidate = Math.Min(candidate, maxLegal);
            if (candidate <= p.StopLoss.Value + Symbol.TickSize) return;
        }
        else
        {
            var minLegal = NormalizePrice(Symbol.Ask + safety, RoundingMode.Up);
            candidate = Math.Max(candidate, minLegal);
            if (candidate >= p.StopLoss.Value - Symbol.TickSize) return;
        }

        if (_lastStopRequestPrice.HasValue && Math.Abs(candidate - _lastStopRequestPrice.Value) < Symbol.TickSize * 0.5)
            return;

        _lastStopRequestPrice = candidate;
        var result = ModifyPosition(p, candidate, p.TakeProfit, false);
        if (result.IsSuccessful)
            Print("NAI POSITION | {0} SUCCESS | {1} SL->{2:F2} R={3:F2}", reason, p.TradeType, candidate, liveR);
        else
            Print("NAI POSITION | {0} REJECTED | {1} requested={2:F2} error={3}", reason, p.TradeType, candidate, result.Error);
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.Label != Label || p.SymbolName != SymbolName)
            return;

        _lastStopRequestPrice = null;
        _entryM1Index = -1;
        _hourNet += p.NetProfit;

        var intendedRiskCash = Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        if (p.NetProfit > intendedRiskCash * 0.15) _hourWins++;
        else if (p.NetProfit < -intendedRiskCash * 0.15) _hourLosses++;
        else _hourScratch++;

        Print("NAI RESULT | {0} | net={1:F2} reason={2} | hourlyNet={3:F2}", p.TradeType, p.NetProfit, args.Reason, _hourNet);
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
        var topReason = _hourRejectReasons.Count == 0
            ? "none"
            : _hourRejectReasons.OrderByDescending(x => x.Value).ThenBy(x => x.Key).First().Key + " x" + _hourRejectReasons.OrderByDescending(x => x.Value).ThenBy(x => x.Key).First().Value;

        Print("=== NAI HOURLY SUMMARY ===");
        Print("WINDOW | {0:yyyy-MM-dd HH}:00 UTC | {1}", _summaryHour, trigger);
        Print("MARKET | regime={0} legal={1} | {2}", _regime, _legalDirection, _contextReason);
        Print("DECISIONS | total={0} long={1} short={2} wait={3} skip={4} | topBlock={5}", _hourDecisions, _hourLongDecisions, _hourShortDecisions, _hourWaits, _hourSkips, topReason);
        Print("TRADES | entries={0} W={1} L={2} scratch={3} | LONG={4} SHORT={5}", _hourEntries, _hourWins, _hourLosses, _hourScratch, _hourLongTrades, _hourShortTrades);
        Print("P/L | net={0:F2} | equity={1:F2} balance={2:F2} | dayFromStart={3:F2}", _hourNet, Account.Equity, Account.Balance, Account.Equity - _dayStartEquity);
        Print("STATE | armed={0} openPosition={1} halted={2}", _armedPlan == null ? "NO" : _armedPlan.Direction + ":" + _armedPlan.Name, FindDecisionPosition() == null ? "NO" : FindDecisionPosition()!.TradeType.ToString(), _halted);
        Print("=== END NAI HOURLY SUMMARY ===");
    }

    private void ResetHourlyCounters()
    {
        _hourDecisions = 0;
        _hourLongDecisions = 0;
        _hourShortDecisions = 0;
        _hourWaits = 0;
        _hourSkips = 0;
        _hourEntries = 0;
        _hourWins = 0;
        _hourLosses = 0;
        _hourScratch = 0;
        _hourLongTrades = 0;
        _hourShortTrades = 0;
        _hourNet = 0;
        _hourRejectReasons.Clear();
    }

    private void RegisterWait(string reason)
    {
        _hourWaits++;
        RegisterReason(reason);
    }

    private void RegisterSkip(string reason)
    {
        _hourSkips++;
        RegisterReason(reason);
    }

    private void RegisterReason(string reason)
    {
        if (_hourRejectReasons.TryGetValue(reason, out var count)) _hourRejectReasons[reason] = count + 1;
        else _hourRejectReasons[reason] = 1;
    }

    private int ContextScore(Bars bars, int i)
    {
        if (i < 20)
            return 0;

        var atr = Atr(bars, i);
        if (atr <= 0)
            return 0;

        var score = 0;
        var fast = AverageClose(bars, i - 5, i);
        var slow = AverageClose(bars, i - 17, i);
        if (fast > slow + atr * 0.05) score++; else if (fast < slow - atr * 0.05) score--;

        var move3 = bars.ClosePrices[i] - bars.ClosePrices[i - 3];
        if (move3 > atr * 0.18) score++; else if (move3 < -atr * 0.18) score--;

        var recentHigh = HighestHigh(bars, i - 5, i);
        var recentLow = LowestLow(bars, i - 5, i);
        var priorHigh = HighestHigh(bars, i - 11, i - 6);
        var priorLow = LowestLow(bars, i - 11, i - 6);
        if (recentHigh > priorHigh + atr * 0.05 && recentLow >= priorLow - atr * 0.05) score++;
        else if (recentLow < priorLow - atr * 0.05 && recentHigh <= priorHigh + atr * 0.05) score--;

        var efficiency = Efficiency(bars, i - 6, i);
        var net = bars.ClosePrices[i] - bars.ClosePrices[i - 6];
        if (efficiency >= 0.55 && net > atr * 0.35) score++;
        else if (efficiency >= 0.55 && net < -atr * 0.35) score--;

        return score;
    }

    private void M1TrendVotes(int i, out int bull, out int bear)
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
        if (Server.Time.Date == _equityDay)
            return;

        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        Print("NAI DAY RESET | equity anchor={0:F2}", _dayStartEquity);
    }

    private bool HitDailyStop()
    {
        if (_dayStartEquity <= 0)
            return false;

        var dd = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (dd < DailyEquityStopPercent)
            return false;

        _halted = true;
        _armedPlan = null;
        var p = FindDecisionPosition();
        if (p != null)
            ClosePosition(p);
        Print("NAI HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
        return true;
    }

    private Position? FindDecisionPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

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
            var tr = Math.Max(bars.HighPrices[k] - bars.LowPrices[k], Math.Max(Math.Abs(bars.HighPrices[k] - bars.ClosePrices[k - 1]), Math.Abs(bars.LowPrices[k] - bars.ClosePrices[k - 1])));
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

    private static DateTime FloorToHour(DateTime t) => new DateTime(t.Year, t.Month, t.Day, t.Hour, 0, 0, t.Kind);

    private enum RegimeState { Bull, Bear, Mixed, Transition }
    private enum DirectionChoice { None, Long, Short }
    private sealed record SetupPlan(DirectionChoice Direction, string Name, double EntryReference, double RiskDistance, string Reason);
}
