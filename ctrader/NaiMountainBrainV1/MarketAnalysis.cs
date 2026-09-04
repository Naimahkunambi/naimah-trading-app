using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;
using cAlgo.Robots.MountainBrain;

namespace cAlgo.Robots.MountainBrain;

public static class StructureMapper
{
    public static StructureSnapshot Build(Bars bars, string name, int fractalStrength, int maxLookback)
    {
        var snapshot = new StructureSnapshot { TimeFrameName = name };
        if (bars.Count < fractalStrength * 2 + 10)
            return snapshot;

        var lastClosed = bars.Count - 2;
        var first = Math.Max(fractalStrength, lastClosed - maxLookback);
        var swings = new List<SwingPoint>();

        for (var i = first; i <= lastClosed - fractalStrength; i++)
        {
            var high = bars.HighPrices[i];
            var low = bars.LowPrices[i];
            var isHigh = true;
            var isLow = true;

            for (var j = 1; j <= fractalStrength; j++)
            {
                if (bars.HighPrices[i - j] >= high || bars.HighPrices[i + j] > high) isHigh = false;
                if (bars.LowPrices[i - j] <= low || bars.LowPrices[i + j] < low) isLow = false;
            }

            if (isHigh)
                swings.Add(new SwingPoint { BarIndex = i, Time = bars.OpenTimes[i], Price = high, Kind = SwingKind.High });
            if (isLow)
                swings.Add(new SwingPoint { BarIndex = i, Time = bars.OpenTimes[i], Price = low, Kind = SwingKind.Low });
        }

        swings = swings.OrderBy(s => s.BarIndex).ThenBy(s => s.Kind).ToList();
        LabelStructure(swings);
        snapshot.Swings.AddRange(swings);

        var highs = swings.Where(s => s.Kind == SwingKind.High).ToList();
        var lows = swings.Where(s => s.Kind == SwingKind.Low).ToList();
        var lastHigh = highs.LastOrDefault();
        var lastLow = lows.LastOrDefault();

        snapshot.LastSwingHigh = lastHigh?.Price;
        snapshot.LastSwingLow = lastLow?.Price;
        snapshot.LastHighLabel = lastHigh?.Label ?? StructureLabel.None;
        snapshot.LastLowLabel = lastLow?.Label ?? StructureLabel.None;

        var upScore = swings.TakeLast(Math.Min(8, swings.Count)).Count(s => s.Label == StructureLabel.HH || s.Label == StructureLabel.HL);
        var downScore = swings.TakeLast(Math.Min(8, swings.Count)).Count(s => s.Label == StructureLabel.LH || s.Label == StructureLabel.LL);

        if (upScore >= 3 && upScore > downScore)
            snapshot.Direction = MarketDirection.Up;
        else if (downScore >= 3 && downScore > upScore)
            snapshot.Direction = MarketDirection.Down;
        else
            snapshot.Direction = MarketDirection.Neutral;

        snapshot.ProtectedLow = FindProtectedLow(swings);
        snapshot.ProtectedHigh = FindProtectedHigh(swings);

        var current = bars.ClosePrices[lastClosed];
        snapshot.NearestSupport = lows.Where(s => s.Price <= current).OrderByDescending(s => s.Price).Select(s => (double?)s.Price).FirstOrDefault();
        snapshot.NearestResistance = highs.Where(s => s.Price >= current).OrderBy(s => s.Price).Select(s => (double?)s.Price).FirstOrDefault();

        return snapshot;
    }

    private static void LabelStructure(List<SwingPoint> swings)
    {
        double? priorHigh = null;
        double? priorLow = null;
        foreach (var swing in swings)
        {
            if (swing.Kind == SwingKind.High)
            {
                if (priorHigh.HasValue)
                    swing.Label = swing.Price > priorHigh.Value ? StructureLabel.HH : StructureLabel.LH;
                priorHigh = swing.Price;
            }
            else
            {
                if (priorLow.HasValue)
                    swing.Label = swing.Price > priorLow.Value ? StructureLabel.HL : StructureLabel.LL;
                priorLow = swing.Price;
            }
        }
    }

    // Important HL = a low that is followed by a new HH.
    private static double? FindProtectedLow(List<SwingPoint> swings)
    {
        for (var i = swings.Count - 2; i >= 0; i--)
        {
            var s = swings[i];
            if (s.Kind != SwingKind.Low || s.Label != StructureLabel.HL)
                continue;
            if (swings.Skip(i + 1).Any(x => x.Kind == SwingKind.High && x.Label == StructureLabel.HH))
                return s.Price;
        }
        return null;
    }

    // Important LH = a high that is followed by a new LL.
    private static double? FindProtectedHigh(List<SwingPoint> swings)
    {
        for (var i = swings.Count - 2; i >= 0; i--)
        {
            var s = swings[i];
            if (s.Kind != SwingKind.High || s.Label != StructureLabel.LH)
                continue;
            if (swings.Skip(i + 1).Any(x => x.Kind == SwingKind.Low && x.Label == StructureLabel.LL))
                return s.Price;
        }
        return null;
    }
}

public static class MetricsEngine
{
    public static IndicatorSnapshot Indicators(Bars bars, int atrPeriod = 14)
    {
        var i = bars.Count - 2;
        if (i < 40)
            return new IndicatorSnapshot();

        return new IndicatorSnapshot
        {
            Ema5 = Ema(bars.ClosePrices, i, 5),
            Ema13 = Ema(bars.ClosePrices, i, 13),
            Ema34 = Ema(bars.ClosePrices, i, 34),
            Stochastic = Stochastic(bars, i, 14),
            Atr = Atr(bars, i, atrPeriod)
        };
    }

    public static TickMetrics TickMetrics(IReadOnlyList<double> ticks)
    {
        if (ticks.Count < 65)
            return new TickMetrics();

        var shortNet = ticks[^1] - ticks[^6];
        var mediumNet = ticks[^1] - ticks[^21];
        var prevMedium = ticks[^21] - ticks[^41];
        var vol = 0.0;
        var path = 0.0;
        for (var i = ticks.Count - 60; i < ticks.Count; i++)
        {
            var d = Math.Abs(ticks[i] - ticks[i - 1]);
            vol += d;
            path += d;
        }
        vol /= 60.0;
        var net60 = Math.Abs(ticks[^1] - ticks[^61]);

        return new TickMetrics
        {
            VelocityShort = shortNet / 5.0,
            VelocityMedium = mediumNet / 20.0,
            Acceleration = (mediumNet - prevMedium) / 20.0,
            TickVolatility = Math.Max(1e-9, vol),
            PathEfficiency = path <= 0 ? 0 : net60 / path
        };
    }

    public static double Ema(DataSeries series, int index, int period)
    {
        var from = Math.Max(0, index - period * 5);
        var alpha = 2.0 / (period + 1.0);
        var ema = series[from];
        for (var i = from + 1; i <= index; i++)
            ema = alpha * series[i] + (1.0 - alpha) * ema;
        return ema;
    }

    public static double Atr(Bars bars, int index, int period)
    {
        var from = Math.Max(1, index - period + 1);
        var sum = 0.0;
        var count = 0;
        for (var i = from; i <= index; i++)
        {
            var tr = Math.Max(bars.HighPrices[i] - bars.LowPrices[i],
                Math.Max(Math.Abs(bars.HighPrices[i] - bars.ClosePrices[i - 1]), Math.Abs(bars.LowPrices[i] - bars.ClosePrices[i - 1])));
            sum += tr;
            count++;
        }
        return count == 0 ? 0 : sum / count;
    }

    private static double Stochastic(Bars bars, int index, int period)
    {
        var from = Math.Max(0, index - period + 1);
        var high = double.MinValue;
        var low = double.MaxValue;
        for (var i = from; i <= index; i++)
        {
            high = Math.Max(high, bars.HighPrices[i]);
            low = Math.Min(low, bars.LowPrices[i]);
        }
        var range = high - low;
        return range <= 0 ? 50 : (bars.ClosePrices[index] - low) / range * 100.0;
    }
}

public static class MountainTracker
{
    public static MountainSnapshot Build(StructureSnapshot m1, Bars bars, TickMetrics tick, IndicatorSnapshot indicators, long mountainId)
    {
        var lastClosed = bars.Count - 2;
        var current = bars.ClosePrices[lastClosed];
        var direction = m1.Direction;
        var stage = MountainStage.Chop;

        var ordered = m1.Swings.OrderBy(s => s.BarIndex).ToList();
        var directionalSwings = ordered.TakeLast(Math.Min(12, ordered.Count)).ToList();
        var start = FindMountainStart(directionalSwings, direction) ?? directionalSwings.FirstOrDefault();
        var startPrice = start?.Price ?? current;
        var startTime = start?.Time ?? bars.OpenTimes[lastClosed];

        var legs = new List<MountainLeg>();
        for (var i = 1; i < directionalSwings.Count; i++)
        {
            var a = directionalSwings[i - 1];
            var b = directionalSwings[i];
            legs.Add(new MountainLeg
            {
                StartTime = a.Time,
                EndTime = b.Time,
                StartPrice = a.Price,
                EndPrice = b.Price
            });
        }

        var extreme = direction == MarketDirection.Up
            ? directionalSwings.Where(s => s.Kind == SwingKind.High).Select(s => s.Price).DefaultIfEmpty(current).Max()
            : direction == MarketDirection.Down
                ? directionalSwings.Where(s => s.Kind == SwingKind.Low).Select(s => s.Price).DefaultIfEmpty(current).Min()
                : current;

        var protectedLevel = direction == MarketDirection.Up ? m1.ProtectedLow : m1.ProtectedHigh;
        var structureBroken = protectedLevel.HasValue &&
            (direction == MarketDirection.Up ? current < protectedLevel.Value : direction == MarketDirection.Down && current > protectedLevel.Value);

        var impulseLegs = legs.Where(l => direction == MarketDirection.Up ? l.Distance > 0 : direction == MarketDirection.Down ? l.Distance < 0 : false).ToList();
        var progressionRatio = 1.0;
        var weakening = false;
        if (impulseLegs.Count >= 2)
        {
            var prev = impulseLegs[^2].AbsDistance;
            var last = impulseLegs[^1].AbsDistance;
            progressionRatio = prev <= 0 ? 1 : last / prev;
            weakening = progressionRatio < 0.65;
        }

        var mountainDistance = Math.Abs(extreme - startPrice);
        var pullbackDepth = mountainDistance <= 0 ? 0 : Math.Abs(extreme - current) / mountainDistance;
        var ageSwings = directionalSwings.Count;

        if (direction == MarketDirection.Neutral)
            stage = MountainStage.Chop;
        else if (structureBroken)
            stage = MountainStage.StructureBreak;
        else if (ageSwings <= 3)
            stage = MountainStage.Birth;
        else if (ageSwings <= 5)
            stage = MountainStage.EarlyTrend;
        else
        {
            var movingAgainst = direction == MarketDirection.Up ? tick.VelocityShort < 0 : tick.VelocityShort > 0;
            var turningBack = direction == MarketDirection.Up
                ? tick.VelocityShort > 0 && tick.Acceleration > 0
                : tick.VelocityShort < 0 && tick.Acceleration < 0;

            if (pullbackDepth > 0.08 && movingAgainst)
                stage = MountainStage.Pullback;
            else if (pullbackDepth > 0.08 && turningBack)
                stage = MountainStage.PullbackEnding;
            else if (weakening && Math.Abs(tick.VelocityMedium) < tick.TickVolatility * 0.25)
                stage = MountainStage.Exhaustion;
            else if (ageSwings >= 9)
                stage = MountainStage.Mature;
            else if (turningBack && pullbackDepth > 0.02)
                stage = MountainStage.Resumption;
            else
                stage = MountainStage.EstablishedTrend;
        }

        return new MountainSnapshot
        {
            MountainId = mountainId,
            Direction = direction,
            Stage = stage,
            StartTime = startTime,
            StartPrice = startPrice,
            CurrentExtreme = extreme,
            ProtectedLevel = protectedLevel,
            DistanceFromStart = Math.Abs(current - startPrice),
            ProgressionRatio = progressionRatio,
            PullbackDepth = pullbackDepth,
            TrendEfficiency = tick.PathEfficiency,
            ProgressionWeakening = weakening,
            StructureBroken = structureBroken,
            Legs = legs
        };
    }

    private static SwingPoint? FindMountainStart(List<SwingPoint> swings, MarketDirection direction)
    {
        if (swings.Count == 0 || direction == MarketDirection.Neutral)
            return null;

        if (direction == MarketDirection.Up)
            return swings.FirstOrDefault(s => s.Kind == SwingKind.Low);
        return swings.FirstOrDefault(s => s.Kind == SwingKind.High);
    }
}

public static class StoryEngine
{
    public static string BuildNarrative(StructureSnapshot m1, StructureSnapshot m5, StructureSnapshot m15, MountainSnapshot mountain, TickMetrics tick, IndicatorSnapshot indicators)
    {
        var higher = $"M15 {Dir(m15.Direction)} / M5 {Dir(m5.Direction)} / M1 {Dir(m1.Direction)}";
        var protectedText = mountain.ProtectedLevel.HasValue ? mountain.ProtectedLevel.Value.ToString("F2") : "none";
        var progress = mountain.ProgressionWeakening ? "WEAKENING" : "HEALTHY/UNKNOWN";
        var location = $"support={Fmt(m1.NearestSupport)} resistance={Fmt(m1.NearestResistance)}";
        var momentum = $"v5={tick.VelocityShort:F3} v20={tick.VelocityMedium:F3} accel={tick.Acceleration:F3} eff={tick.PathEfficiency:F2}";
        var ema = indicators.Ema5 > indicators.Ema13 && indicators.Ema13 > indicators.Ema34 ? "EMA STACK UP" :
            indicators.Ema5 < indicators.Ema13 && indicators.Ema13 < indicators.Ema34 ? "EMA STACK DOWN" : "EMA MIXED";

        return $"{higher} | MOUNTAIN {Dir(mountain.Direction)} {mountain.Stage} | protected={protectedText} | pullback={mountain.PullbackDepth:P0} | progression={progress} ({mountain.ProgressionRatio:F2}) | {location} | {ema} stoch={indicators.Stochastic:F0} ATR={indicators.Atr:F2} | {momentum}";
    }

    private static string Dir(MarketDirection d) => d == MarketDirection.Up ? "UP" : d == MarketDirection.Down ? "DOWN" : "NEUTRAL";
    private static string Fmt(double? v) => v.HasValue ? v.Value.ToString("F2") : "none";
}
