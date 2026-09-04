using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiCometLastMan3T : Robot
{
    private const string Label = "NAI-COMET-LMS-3T";
    private const string RequiredSymbolText = "Volatility 25 (1s)";
    private const int MaxTickHistory = 240;

    [Parameter("Mode: 1=COMET 2=LMSv3 3=LMSv4", DefaultValue = 2, MinValue = 1, MaxValue = 3)]
    public int Mode { get; set; }

    [Parameter("Risk % / Trade", DefaultValue = 0.50, MinValue = 0.10, MaxValue = 1.00, Step = 0.10)]
    public double RiskPercent { get; set; }

    [Parameter("Normal Hold Ticks", DefaultValue = 3, MinValue = 3, MaxValue = 3)]
    public int HoldTicks { get; set; }

    [Parameter("Emergency SL TickVol", DefaultValue = 8.0, MinValue = 4.0, MaxValue = 30.0, Step = 0.5)]
    public double EmergencySlTickVol { get; set; }

    [Parameter("Daily Equity Stop %", DefaultValue = 2.00, MinValue = 1.00, MaxValue = 5.00, Step = 0.50)]
    public double DailyEquityStopPercent { get; set; }

    private readonly List<double> _ticks = new();
    private long _tickSerial;
    private long _entryTickSerial = -1;
    private DateTime _equityDay;
    private double _dayStartEquity;
    private bool _halted;
    private EntryMeta? _activeMeta;

    private int _signals;
    private int _entries;
    private int _longTrades;
    private int _shortTrades;
    private int _wins;
    private int _losses;
    private int _scratches;
    private int _threeTickExits;
    private int _emergencyStops;
    private double _net;

    protected override void OnStart()
    {
        if (Account.IsLive)
        {
            Print("NAI COMET LAST MAN 3T BLOCKED | DEMO accounts only.");
            Stop();
            return;
        }

        if (string.IsNullOrWhiteSpace(SymbolName) || SymbolName.IndexOf(RequiredSymbolText, StringComparison.OrdinalIgnoreCase) < 0)
        {
            Print("NAI COMET LAST MAN 3T BLOCKED | attach to Volatility 25 (1s) Index | current={0}", SymbolName);
            Stop();
            return;
        }

        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        Positions.Closed += OnPositionClosed;

        Print("NAI COMET LAST MAN 3T STARTED | {0} | DEMO | mode={1}", SymbolName, ModeName());
        Print("NORMAL TRADE LIFE | ENTER -> tick1 -> tick2 -> tick3 -> CLOSE -> scan again");
        Print("MODE 1 COMET | EMA13/34 + 1-tick pullback + 1 recovery");
        Print("MODE 2 LMS V3 | EMA5/13/34 + 1-tick pullback + 1 recovery");
        Print("MODE 3 LMS V4 | EMA5/13/34 + pullback + TWO recovery ticks");
        Print("NO TP / NO BE / NO TRAIL | emergency SL is catastrophe protection only | risk={0:F2}%", RiskPercent);
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
        if (_halted || HitDailyStop())
            return;

        _tickSerial++;
        var mid = (Symbol.Bid + Symbol.Ask) * 0.5;
        _ticks.Add(mid);
        if (_ticks.Count > MaxTickHistory)
            _ticks.RemoveAt(0);

        var open = FindPosition();
        if (open != null)
        {
            ManageThreeTickExit(open);
            return;
        }

        if (_ticks.Count < 40)
            return;

        ScanEntry();
    }

    private void ScanEntry()
    {
        var ema13 = Ema(13);
        var ema34 = Ema(34);
        var ema5 = Ema(5);

        int direction;
        if (Mode == 1)
        {
            if (ema13 > ema34) direction = 1;
            else if (ema13 < ema34) direction = -1;
            else return;
        }
        else
        {
            if (ema5 > ema13 && ema13 > ema34) direction = 1;
            else if (ema5 < ema13 && ema13 < ema34) direction = -1;
            else return;
        }

        if (!PatternMatches(direction, out var pullbackPrice, out var patternText))
            return;

        _signals++;
        ExecuteSignal(direction, pullbackPrice, ema5, ema13, ema34, patternText);
    }

    private bool PatternMatches(int direction, out double pullbackPrice, out string patternText)
    {
        pullbackPrice = 0;
        patternText = "";

        if (Mode == 3)
        {
            if (_ticks.Count < 4)
                return false;

            var t1 = TickBack(0);
            var t2 = TickBack(1);
            var t3 = TickBack(2);
            var t4 = TickBack(3);

            if (direction > 0)
            {
                if (!(t4 > t3 && t2 > t3 && t1 > t2))
                    return false;
                pullbackPrice = t3;
                patternText = $"LMS V4 LONG | T4={t4:F2}>T3={t3:F2}; T2={t2:F2}>T3; T1={t1:F2}>T2";
                return true;
            }

            if (!(t4 < t3 && t2 < t3 && t1 < t2))
                return false;
            pullbackPrice = t3;
            patternText = $"LMS V4 SHORT | T4={t4:F2}<T3={t3:F2}; T2={t2:F2}<T3; T1={t1:F2}<T2";
            return true;
        }

        if (_ticks.Count < 3)
            return false;

        var n1 = TickBack(0);
        var n2 = TickBack(1);
        var n3 = TickBack(2);

        if (direction > 0)
        {
            if (!(n1 > n2 && n2 < n3))
                return false;
            pullbackPrice = n2;
            patternText = $"1R LONG | T3={n3:F2} > T2={n2:F2} < T1={n1:F2}";
            return true;
        }

        if (!(n1 < n2 && n2 > n3))
            return false;
        pullbackPrice = n2;
        patternText = $"1R SHORT | T3={n3:F2} < T2={n2:F2} > T1={n1:F2}";
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

        // Emergency stop only. Normal exit is always after exactly 3 live ticks.
        var emergencyDistance = Math.Max(Math.Max(tickVol * EmergencySlTickVol, spread * 3.0), brokerMin + Symbol.TickSize * 2.0);
        var stopPips = emergencyDistance / Symbol.PipSize;
        if (stopPips <= 0)
            return;

        var volume = Symbol.VolumeForProportionalRisk(ProportionalAmountType.Equity, RiskPercent, stopPips, RoundingMode.Down);
        volume = Symbol.NormalizeVolumeInUnits(volume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin)
            return;
        volume = Math.Min(volume, Symbol.VolumeInUnitsMax);

        var result = ExecuteMarketOrder(tradeType, SymbolName, volume, Label, stopPips, null, ModeName());
        if (!result.IsSuccessful)
        {
            Print("NAI 3T | ENTRY REJECTED | {0} | {1}", tradeType, result.Error);
            return;
        }

        _entries++;
        if (tradeType == TradeType.Buy) _longTrades++; else _shortTrades++;
        _entryTickSerial = _tickSerial;
        _activeMeta = new EntryMeta(tradeType, Server.Time, pullbackPrice, ema5, ema13, ema34, tickVol, patternText);

        Print("NAI 3T | ENTER {0} | mode={1} entry={2:F2} emergencySL={3:F1} tickVol volume={4} | EMA5={5:F2} EMA13={6:F2} EMA34={7:F2} | {8}",
            tradeType, ModeName(), result.Position.EntryPrice, emergencyDistance / Math.Max(Symbol.TickSize, tickVol), volume,
            ema5, ema13, ema34, patternText);
    }

    private void ManageThreeTickExit(Position p)
    {
        if (_entryTickSerial < 0)
            return;

        var heldTicks = _tickSerial - _entryTickSerial;
        if (heldTicks < HoldTicks)
            return;

        var result = ClosePosition(p);
        if (result.IsSuccessful)
        {
            _threeTickExits++;
            Print("NAI 3T | NORMAL EXIT | {0} after {1} ticks | floating={2:F2}", p.TradeType, heldTicks, p.NetProfit);
        }
    }

    private void OnPositionClosed(PositionClosedEventArgs args)
    {
        var p = args.Position;
        if (p.SymbolName != SymbolName || p.Label != Label)
            return;

        var intendedRisk = Math.Max(0.01, Account.Balance * RiskPercent / 100.0);
        if (p.NetProfit > intendedRisk * 0.05) _wins++;
        else if (p.NetProfit < -intendedRisk * 0.05) _losses++;
        else _scratches++;
        _net += p.NetProfit;

        if (args.Reason == PositionCloseReason.StopLoss)
            _emergencyStops++;

        var duration = _activeMeta != null ? (Server.Time - _activeMeta.EntryTime).TotalSeconds : 0;
        Print("NAI 3T RESULT | {0} mode={1} net={2:F2} reason={3} duration={4:F1}s | W/L/S={5}/{6}/{7} netTotal={8:F2}",
            p.TradeType, ModeName(), p.NetProfit, args.Reason, duration, _wins, _losses, _scratches, _net);

        _entryTickSerial = -1;
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

        var from = _ticks.Count - 1 - n;
        var sum = 0.0;
        for (var i = from + 1; i < _ticks.Count; i++)
            sum += Math.Abs(_ticks[i] - _ticks[i - 1]);
        return Math.Max(Symbol.TickSize, sum / n);
    }

    private double TickBack(int back)
    {
        var index = Math.Max(0, _ticks.Count - 1 - back);
        return _ticks[index];
    }

    private Position? FindPosition() => Positions.FirstOrDefault(p => p.SymbolName == SymbolName && p.Label == Label);

    private void ResetDailyAnchorIfNeeded()
    {
        if (Server.Time.Date == _equityDay)
            return;

        _equityDay = Server.Time.Date;
        _dayStartEquity = Account.Equity;
        _halted = false;
        Print("NAI 3T | NEW DAY | equity anchor={0:F2}", _dayStartEquity);
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
        Print("NAI 3T HALTED | daily drawdown={0:F2}% limit={1:F2}%", dd, DailyEquityStopPercent);
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

    private string ModeName()
    {
        if (Mode == 1) return "COMET";
        if (Mode == 3) return "LAST-MAN-V4";
        return "LAST-MAN-V3";
    }

    private void PrintStats(string trigger)
    {
        Print("=== NAI COMET LAST MAN 3T STATS | {0} ===", trigger);
        Print("MODE | {0} | signals={1} entries={2}", ModeName(), _signals, _entries);
        Print("TRADES | long={0} short={1} | W={2} L={3} scratch={4} | net={5:F2}", _longTrades, _shortTrades, _wins, _losses, _scratches, _net);
        Print("EXITS | normal3Tick={0} emergencySL={1}", _threeTickExits, _emergencyStops);
        Print("=== END NAI COMET LAST MAN 3T STATS ===");
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
