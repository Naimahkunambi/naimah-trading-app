using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;
using cAlgo.Robots.MountainBrain;

namespace cAlgo.Robots;

// Build trigger only. Strategy logic unchanged.
[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class NaiMountainBrainV1 : Robot
{
    private const int MaxTicks = 500;
    private readonly List<double> _ticks = new();
    private Bars _m1 = null!;
    private Bars _m5 = null!;
    private Bars _m15 = null!;
    private StorySnapshot? _lastStory;
    private long _mountainId = 1;
    private DateTime _lastStoryPrint = DateTime.MinValue;

    [Parameter("Fractal Strength", DefaultValue = 2, MinValue = 1, MaxValue = 5)]
    public int FractalStrength { get; set; }

    [Parameter("Structure Lookback Bars", DefaultValue = 180, MinValue = 60, MaxValue = 500)]
    public int StructureLookback { get; set; }

    [Parameter("Story Print Seconds", DefaultValue = 5, MinValue = 1, MaxValue = 60)]
    public int StoryPrintSeconds { get; set; }

    protected override void OnStart()
    {
        _m1 = MarketData.GetBars(TimeFrame.Minute, SymbolName);
        _m5 = MarketData.GetBars(TimeFrame.Minute5, SymbolName);
        _m15 = MarketData.GetBars(TimeFrame.Minute15, SymbolName);

        Print("NAI MOUNTAIN BRAIN V1 STARTED | {0}", SymbolName);
        Print("MODE | OBSERVE ONLY | NO ORDERS WILL BE SENT");
        Print("BOOT | rebuilding recent M1/M5/M15 structure and mountain story");

        BuildStory(true);
    }

    protected override void OnTick()
    {
        var mid = (Symbol.Bid + Symbol.Ask) * 0.5;
        _ticks.Add(mid);
        if (_ticks.Count > MaxTicks)
            _ticks.RemoveAt(0);

        if (_ticks.Count < 70)
            return;

        BuildStory(false);
    }

    private void BuildStory(bool forcePrint)
    {
        if (_m1.Count < 50 || _m5.Count < 50 || _m15.Count < 50)
            return;

        var m1 = StructureMapper.Build(_m1, "M1", FractalStrength, StructureLookback);
        var m5 = StructureMapper.Build(_m5, "M5", FractalStrength, Math.Min(StructureLookback, 140));
        var m15 = StructureMapper.Build(_m15, "M15", FractalStrength, Math.Min(StructureLookback, 100));

        var tickMetrics = MetricsEngine.TickMetrics(_ticks);
        var indicators = MetricsEngine.Indicators(_m1);
        var mountain = MountainTracker.Build(m1, _m1, tickMetrics, indicators, _mountainId);

        if (_lastStory != null && mountain.Direction != _lastStory.Mountain.Direction && mountain.Direction != MarketDirection.Neutral)
            _mountainId++;

        mountain = MountainTracker.Build(m1, _m1, tickMetrics, indicators, _mountainId);
        var narrative = StoryEngine.BuildNarrative(m1, m5, m15, mountain, tickMetrics, indicators);

        _lastStory = new StorySnapshot
        {
            Time = Server.Time,
            M1 = m1,
            M5 = m5,
            M15 = m15,
            Mountain = mountain,
            Tick = tickMetrics,
            Indicators = indicators,
            Narrative = narrative
        };

        DrawStory(_lastStory);

        if (forcePrint || _lastStoryPrint == DateTime.MinValue || (Server.Time - _lastStoryPrint).TotalSeconds >= StoryPrintSeconds)
        {
            _lastStoryPrint = Server.Time;
            Print("MOUNTAIN STORY | {0}", narrative);
        }
    }

    private void DrawStory(StorySnapshot story)
    {
        var m = story.Mountain;
        var text =
            $"NAI MOUNTAIN BRAIN V1\n" +
            $"M15: {story.M15.Direction}   M5: {story.M5.Direction}   M1: {story.M1.Direction}\n" +
            $"Mountain: {m.Direction}   Stage: {m.Stage}\n" +
            $"Protected: {(m.ProtectedLevel.HasValue ? m.ProtectedLevel.Value.ToString("F2") : "none")}\n" +
            $"Pullback: {m.PullbackDepth:P0}   Progression: {m.ProgressionRatio:F2}\n" +
            $"Tick velocity: {story.Tick.VelocityShort:F3}   Accel: {story.Tick.Acceleration:F3}\n" +
            $"Stoch: {story.Indicators.Stochastic:F0}   ATR: {story.Indicators.Atr:F2}\n" +
            "OBSERVE ONLY - NO TRADING";

        Chart.DrawStaticText("NAI_MOUNTAIN_STORY", text, VerticalAlignment.Top, HorizontalAlignment.Left, Color.White);

        var swings = story.M1.Swings.TakeLast(14).ToList();
        for (var i = 1; i < swings.Count; i++)
        {
            var a = swings[i - 1];
            var b = swings[i];
            Chart.DrawTrendLine($"NAI_STRUCT_{i}", a.Time, a.Price, b.Time, b.Price, Color.Cyan, 1, LineStyle.Solid);
        }

        if (story.M1.ProtectedLow.HasValue)
            Chart.DrawHorizontalLine("NAI_PROTECTED_LOW", story.M1.ProtectedLow.Value, Color.Green, 1, LineStyle.Dots);
        else
            Chart.RemoveObject("NAI_PROTECTED_LOW");

        if (story.M1.ProtectedHigh.HasValue)
            Chart.DrawHorizontalLine("NAI_PROTECTED_HIGH", story.M1.ProtectedHigh.Value, Color.Red, 1, LineStyle.Dots);
        else
            Chart.RemoveObject("NAI_PROTECTED_HIGH");
    }
}
