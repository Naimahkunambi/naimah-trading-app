using System;
using System.Collections.Generic;

namespace cAlgo.Robots.MountainBrain;

public enum MarketDirection
{
    Down = -1,
    Neutral = 0,
    Up = 1
}

public enum SwingKind
{
    High,
    Low
}

public enum StructureLabel
{
    None,
    HH,
    HL,
    LH,
    LL
}

public enum MountainStage
{
    Chop,
    Base,
    Birth,
    EarlyTrend,
    EstablishedTrend,
    Pullback,
    PullbackEnding,
    Resumption,
    Mature,
    Exhaustion,
    StructureBreak
}

public sealed class SwingPoint
{
    public int BarIndex { get; init; }
    public DateTime Time { get; init; }
    public double Price { get; init; }
    public SwingKind Kind { get; init; }
    public StructureLabel Label { get; set; }
}

public sealed class StructureSnapshot
{
    public string TimeFrameName { get; init; } = "";
    public MarketDirection Direction { get; set; }
    public StructureLabel LastHighLabel { get; set; }
    public StructureLabel LastLowLabel { get; set; }
    public double? ProtectedHigh { get; set; }
    public double? ProtectedLow { get; set; }
    public double? LastSwingHigh { get; set; }
    public double? LastSwingLow { get; set; }
    public double? NearestResistance { get; set; }
    public double? NearestSupport { get; set; }
    public List<SwingPoint> Swings { get; init; } = new();
}

public sealed class TickMetrics
{
    public double VelocityShort { get; init; }
    public double VelocityMedium { get; init; }
    public double Acceleration { get; init; }
    public double TickVolatility { get; init; }
    public double PathEfficiency { get; init; }
}

public sealed class IndicatorSnapshot
{
    public double Ema5 { get; init; }
    public double Ema13 { get; init; }
    public double Ema34 { get; init; }
    public double Stochastic { get; init; }
    public double Atr { get; init; }
}

public sealed class MountainLeg
{
    public DateTime StartTime { get; init; }
    public DateTime EndTime { get; init; }
    public double StartPrice { get; init; }
    public double EndPrice { get; init; }
    public double Distance => EndPrice - StartPrice;
    public double AbsDistance => Math.Abs(Distance);
    public double DurationSeconds => Math.Max(1.0, (EndTime - StartTime).TotalSeconds);
    public double Velocity => Distance / DurationSeconds;
}

public sealed class MountainSnapshot
{
    public long MountainId { get; init; }
    public MarketDirection Direction { get; set; }
    public MountainStage Stage { get; set; }
    public DateTime StartTime { get; set; }
    public double StartPrice { get; set; }
    public double CurrentExtreme { get; set; }
    public double? ProtectedLevel { get; set; }
    public double DistanceFromStart { get; set; }
    public double ProgressionRatio { get; set; }
    public double PullbackDepth { get; set; }
    public double TrendEfficiency { get; set; }
    public bool ProgressionWeakening { get; set; }
    public bool StructureBroken { get; set; }
    public List<MountainLeg> Legs { get; init; } = new();
}

public sealed class StorySnapshot
{
    public DateTime Time { get; init; }
    public StructureSnapshot M1 { get; init; } = new();
    public StructureSnapshot M5 { get; init; } = new();
    public StructureSnapshot M15 { get; init; } = new();
    public MountainSnapshot Mountain { get; init; } = new();
    public TickMetrics Tick { get; init; } = new();
    public IndicatorSnapshot Indicators { get; init; } = new();
    public string Narrative { get; init; } = "";
}
