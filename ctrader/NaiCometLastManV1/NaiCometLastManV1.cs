using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiCometLastManV1 : Robot
{
    private const string Label = "NAI-COMET-LAST-MAN-V1";
    private const string RequiredSymbolText = "Volatility 25 (1s)";
    private const int MaxTickHistory = 240;

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 1.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Target R", DefaultValue = 1.20, MinValue = 0.50, MaxValue = 3.00, Step = 0.10)]
    public double TargetR { get; set; }

    [Parameter("Break-even at R", DefaultValue = 0.50, MinValue = 0.20, MaxValue = 1.50, Step = 0.10)]
    public double BreakEvenAtR { get; set; }

    [Parameter("Trail at R", DefaultValue = 0.80, MinValue = 0.40, MaxValue = 2.00, Step = 0.10)]
    public double TrailAtR { get; set; }

    [Parameter("Max Hold Ticks", DefaultValue = 30, MinValue = 3, MaxValue = 180)]
    public int MaxHoldTicks { get; set; }

    [Parameter("Recovery Ticks", DefaultValue = 1, MinValue = 1, MaxValue = 2)]
    public int RecoveryTicks { get; set; }

    [Parameter("Daily Equity Stop %", DefaultValue = 2.00, MinValue = 1.00, MaxValue = 5.00, Step = 0.50)]
    public double DailyEquityStopPercent { get; set; }

    [Parameter("M1 ATR Safety Period", DefaultValue = 14, MinValue = 8, MaxValue = 40)]
    public int AtrPeriod { get; set; }

    private readonly List<double> _ticks = new();
    private Bars _m1 = null!;
    private long _tickSerial;
    private long _entryTickSerial = -1;
    private DateTime _equityDay;
    private double _dayStartEquity;
    private bool _halted;
    private double? _lastStopRequestPrice;
    private EntryMeta? _activeMeta;

    private int _signals;
    private int _entries;
    private int _longTrades;
    private int _shortTrades;
    private int _wins;
    private int _losses;
    private int _scratches;
    private int _timeExits;
    private int _beMoves;
    private int _trailMoves;
    private int _riskSkips;
    private double _net;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI COMET LAST MAN V1 BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI COMET LAST MAN V1 BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        Positions.Closed += OnPositionClosed;

        Print("NAI COMET LAST MAN V1 STARTED | {0} | DEMO | LONG+SHORT", SymbolName);
        Print("DIRECTION | live tick EMA5/13/34 alignment only");
        Print("ENTRY | COMET/LAST MAN tick pullback + continuation | RecoveryTicks={0}", RecoveryTicks);
        Print("NO FRESH-SIGNAL LOCK | after close, next live tick may form the next setup immediately");
        Print("CFD TRANSLATION | structural micro SL | risk={0:F2}% | target={1:F2}R | BE={2:F2}R | trail={3:F2}R | maxHold={4} ticks", RiskPercent, TargetR, BreakEvenAtR, TrailAtR, MaxHoldTicks);
    }

    protected override void OnStop()
    {
        Positions.Closed -= OnPositionClosed;
        PrintStats("BOT STOP");
    }

    protected override void OnTick()
    {
        if (Account.IsLive)
            return;

        ResetDailyAnchorIfNeeded();
        if (_halted)
            return;
        if (HitDailyStop())
            return;

        _tickSerial++;
        var mid = (Symbol.Bid + Symbol.Ask) * 0.5;
        _ticks.Add(mid);
        if (_ticks.Count > MaxTickHistory)
            _ticks.RemoveAt(0);

        var open = FindPosition();
        if (open != null)
        {
            ManageOpenPosition(open);
            return;
        }

        if (_ticks.Count < 40)
            return;

        ScanEntry();
    }

    private void ScanEntry()
    {
        var ema5 = Ema(5);
        var ema13 = Ema(13);
        var ema34 = Ema(34);

        var longAligned = ema5 > ema13 && ema13 > ema34;
        var shortAligned = ema5 < ema13 && ema13 < ema34;
        if (!longAligned && !shortAligned)
            return;

        var direction = longAligned ? 1 : -1;
        if (!HasCometPattern(direction, out var pullbackPrice, out var patternText))
            return;

        _signals++;
        ExecuteSignal(direction, pullbackPrice, ema5, ema13, ema34, patternText);
    }

    private bool HasCometPattern(int direction, out double pullbackPrice, out string patternText)
    {
        pullbackPrice = 0;
        patternText = "";

        if (RecoveryTicks <= 1)
        {
            if (_ticks.Count < 3)
                return false;

            var t1 = TickBack(0);
            var t2 = TickBack(1);
            var t3 = TickBack(2);

            if (direction > 0)
            {
                var ok = t1 > t2 && t2 < t3;
                if (!ok) return false;
                pullbackPrice = t2;
                patternText = $"COMET 1R | T3={t3:F2} > T2={t2:F2} < T1={t1:F2}";
                return true;
            }

            var shortOk = t1 < t2 && t2 > t3;
            if (!shortOk) return false;
            pullbackPrice = t2;
            patternText = $"COMET 1R | T3={t3:F2} < T2={t2:F2} > T1={t1:F2}";
            return true;
        }

        if (_ticks.Count < 4)
            return false;

        var d1 = TickBack(0);
        var d2 = TickBack(1);
        var d3 = TickBack(2);
        var d4 = TickBack(3);

        if (direction > 0)
        {
            var ok = d4 > d3 && d2 > d3 && d1 > d2;
            if (!ok) return false;
            pullbackPrice = d3;
            patternText = $"LAST MAN 2R | T4={d4:F2} > T3={d3:F2}; T2={d2:F2} > T3; T1={d1:F2} > T2";
            return true;
        }

        var shortOk2 = d4 < d3 && d2 < d3 && d1 < d2;
        if (!shortOk2) return false;
        pullbackPrice = d3;
        patternText = $"LAST MAN 2R | T4={d4:F2} < T3={d3:F2}; T2={d2:F2} < T3; T1={d1:F2} < T2";
        return true;
    }

    private void ExecuteSignal(int direction, double pullbackPrice, double ema5, double ema13, double ema34, string patternText)
    {
        if (FindPosition() != null)
            return;

        var tradeType = direction > 0 ? TradeType.Buy : TradeType.Sell;
        var entry = direction > 0 ? Symbol.Ask : Symbol.Bid;
        var tickVol = TickVolatility(34);
        var spread = Math.Max(Symbol.TickSize, Symbol.Ask - Symbol.Bid);
        var brokerMin = MinimumStopDistancePrice(entry);
        var buffer = Math.Max(Symbol.TickSize * 2.0, tickVol * 1.25);
        var structuralStop = direction > 0 ? pullbackPrice - buffer : pullbackPrice + buffer;
        var risk = Math.Abs(entry - structuralStop);

        var minimumRisk = Math.Max(Math.Max(spread * 1.5, tickVol * 2.0), brokerMin + Symbol.TickSize * 2.0);
        if (risk < minimumRisk)
        {
            risk = minimumRisk;
            structuralStop = direction > 0 ? entry - risk : entry + risk;
        }

        var m1Atr = _m1 != null && _m1.Count > AtrPeriod + 3 ? Atr(_m1.Count - 2) : 0;
        if (m1Atr > Symbol.TickSize && risk > m1Atr * 1.50)
        {
            _riskSkips++;
            Print("NAI COMET | SKIP {0} | micro stop too wide {1:F2} M1ATR | {2}", tradeType, risk / m1Atr, patternText);
            return;
        }

        var stopPips = risk / Symbol.PipSize;
        var tpPips = stopPips * TargetR;
        if (stopPips <= 0 || tpPips <= 0)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin)
        {
            _riskSkips++;
            Print("NAI COMET | SKIP {0} | volume {1} below broker min {2}", tradeType, volume, Symbol.VolumeInUnitsMin);
            return;
        }

        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);
        var comment = RecoveryTicks <= 1 ? "COMET-1R" : "LAST-MAN-2R";
        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, tpPips, comment);
        if (!result.IsSuccessful)
        {
            Print("NAI COMET | ENTRY REJECTED | {0} | error={1}", tradeType, result.Error);
            return;
        }

        _entries++;
        if (tradeType == TradeType.Buy) _longTrades++; else _shortTrades++;
        _entryTickSerial = _tickSerial;
        _lastStopRequestPrice = null;
        _activeMeta = new EntryMeta(tradeType, Server.Time, pullbackPrice, ema5, ema13, ema34, tickVol, patternText);

        Print("NAI COMET | ENTER {0} | entry={1:F2} pullback={2:F2} SLref={3:F2} risk={4:F1} tickVol TP={5:F2}R | EMA5={6:F2} EMA13={7:F2} EMA34={8:F2} | {9}",
            tradeType, result.Position.EntryPrice, pullbackPrice, structuralStop, risk / Math.Max(Symbol.TickSize, tickVol), TargetR,
            ema5, ema13, ema34, patternText);
    }

    private void ManageOpenPosition(Position p)
    {
        if (!p.StopLoss.HasValue || !p.TakeProfit.HasValue)
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
            if (improve && TryMoveStop(p, be, "BREAK-EVEN", r))
                _beMoves++;
        }

        if (r >= TrailAtR && _ticks.Count >= 8)
        {
            var tickVol = TickVolatility(34);
            var raw = p.TradeType == TradeType.Buy
                ? MinTickBack(6, 1) - tickVol
                : MaxTickBack(6, 1) + tickVol;
            if (TryMoveStop(p, raw, "TICK TRAIL", r))
                _trailMoves++;
        }

        var heldTicks = _entryTickSerial >= 0 ? _tickSerial - _entryTickSerial : 0;
        if (heldTicks >= MaxHoldTicks)
        {
            var result = ClosePosition(p);
            if (result.IsSuccessful)
            {
                _timeExits++;
                Print("NAI COMET | TIME EXIT | {0} held={1} ticks liveR={2:F2}", p.TradeType, heldTicks, r);
            }
        }
    }

    private bool TryMoveStop(Position p, double rawCandidate, string reason, double liveR)
    {
        if (!p.StopLoss.HasValue)
            return false;

        var candidate = NormalizePrice(rawCandidate, p.TradeType == TradeType.Buy ? RoundingMode.Down : RoundingMode.Up);
        var reference = p.TradeType == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
        var minDistancePrice = MinimumStopDistancePrice(reference);
        var safety = Math.Max(minDistancePrice + Symbol.TickSize * 2.0, (Symbol.Ask - Symbol.Bid) + Symbol.TickSize * 2.0);

        if (p.TradeType == TradeType.Buy)
        {
            candidate = Math.Min(candidate, NormalizePrice(Symbol.Bid - safety, RoundingMode.Down));
            if (candidate <= p.StopLoss.Value + Symbol.TickSize)
                return false;
        }
        else
        {
            candidate = Math.Max(candidate, NormalizePrice(Symbol.Ask + safety, RoundingMode.Up));
            if (candidate >= p.StopLoss.Value - Symbol.TickSize)
                return false;
        }

        if (_lastStopRequestPrice.HasValue && Math.Abs(candidate - _lastStopRequestPrice.Value) < Symbol.TickSize * 0.5)
            return false;

        _lastStopRequestPrice = candidate;
        var result = ModifyPosition(p, candidate, p.TakeProfit, false);
        if (!result.IsSuccessful)
            return false;

        Print("NAI COMET | {0} SUCCESS | {1} SL->{2:F2} liveR={3:F2}", reason, p.TradeType, candidate, liveR);
        return true;
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.SymbolName != SymbolName || p.Label != Label)
            return;

        var intendedRisk = Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        if (p.NetProfit > intendedRisk * 0.15) _wins++;
        else if (p.NetProfit < -intendedRisk * 0.15) _losses++;
        else _scratches++;
        _net += p.NetProfit;

        var held = _activeMeta != null ? (Server.Time - _activeMeta.EntryTime).TotalSeconds : 0;
        Print("NAI COMET RESULT | {0} net={1:F2} reason={2} held={3:F0}s | W/L/S={4}/{5}/{6} totalNet={7:F2}",
            p.TradeType, p.NetProfit, args.Reason, held, _wins, _losses, _scratches, _net);

        _entryTickSerial = -1;
        _lastStopRequestPrice = null;
        _activeMeta = null;
        PrintStats("TRADE CLOSED");
    }

    private double Ema(int period)
    {
        var alpha = 2.0 / (period + 1.0);
        var from = Math.Max(0, _ticks.Count - Math.Max(period * 5, 40));
        var ema = _ticks[from];
        for (var i = from + 1; i < _ticks.Count; i++)
            ema = alpha * _ticks[i] + (1.0 - alpha) * ema;
        return ema;
    }

    private double TickVolatility(int window)
    {
        var n = Math.Min(window, _ticks.Count - 1);
        if (n <= 0)
            return Symbol.TickSize;

        var sum = 0.0;
        var from = _ticks.Count - 1 - n;
        for (var i = from + 1; i < _ticks.Count; i++)
            sum += Math.Abs(_ticks[i] - _ticks[i - 1]);
        return Math.Max(Symbol.TickSize, sum / n);
    }

    private double TickBack(int back)
    {
        var index = Math.Max(0, _ticks.Count - 1 - back);
        return _ticks[index];
    }

    private double MinTickBack(int backFrom, int backTo)
    {
        var newest = Math.Max(0, _ticks.Count - 1 - backTo);
        var oldest = Math.Max(0, _ticks.Count - 1 - backFrom);
        if (oldest > newest) (oldest, newest) = (newest, oldest);
        var v = double.MaxValue;
        for (var i = oldest; i <= newest; i++) v = Math.Min(v, _ticks[i]);
        return v;
    }

    private double MaxTickBack(int backFrom, int backTo)
    {
        var newest = Math.Max(0, _ticks.Count - 1 - backTo);
        var oldest = Math.Max(0, _ticks.Count - 1 - backFrom);
        if (oldest > newest) (oldest, newest) = (newest, oldest);
        var v = double.MinValue;
        for (var i = oldest; i <= newest; i++) v = Math.Max(v, _ticks[i]);
        return v;
    }

    private double Atr(int i)
    {
        var from = Math.Max(1, i - AtrPeriod + 1);
        double total = 0;
        var count = 0;
        for (var k = from; k <= i; k++)
        {
            var tr = Math.Max(_m1.HighPrices[k] - _m1.LowPrices[k],
                Math.Max(Math.Abs(_m1.HighPrices[k] - _m1.ClosePrices[k - 1]), Math.Abs(_m1.LowPrices[k] - _m1.ClosePrices[k - 1])));
            total += tr;
            count++;
        }
        return count == 0 ? 0 : total / count;
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private void ResetDailyAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay)
            return;

        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        Print("NAI COMET | NEW DAY | equity anchor={0:F2}", _dayStartEquity);
    }

    private bool HitDailyStop()
    {
        if (_dayStartEquity <= 0)
            return false;

        var dd = (_dayStartEquity - Account.Equity) / _dayStartEquity * 100.0;
        if (dd < DailyEquityStopPercent)
            return false;

        _halted = true;
        var p = FindPosition();
        if (p != null)
            ClosePosition(p);
        Print("NAI COMET HALTED | daily equity drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
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

    private void PrintStats(string trigger)
    {
        Print("=== NAI COMET LAST MAN V1 STATS | {0} ===", trigger);
        Print("FLOW | signals={0} entries={1} riskSkips={2} timeExits={3}", _signals, _entries, _riskSkips, _timeExits);
        Print("TRADES | long={0} short={1} | W={2} L={3} scratch={4} | net={5:F2}", _longTrades, _shortTrades, _wins, _losses, _scratches, _net);
        Print("PROTECTION | BE moves={0} trail moves={1} | RecoveryTicks={2}", _beMoves, _trailMoves, RecoveryTicks);
        Print("=== END NAI COMET LAST MAN V1 STATS ===");
    }

    private sealed record EntryMeta(
        TradeType TradeType,
        DateTime EntryTime,
        double PullbackPrice,
        double Ema5,
        double Ema13,
        double Ema34,
        double TickVol,
        string Pattern);
}
