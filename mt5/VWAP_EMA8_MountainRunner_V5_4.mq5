//+------------------------------------------------------------------+
//| VWAP_EMA8_MountainRunner_V5_4.mq5                               |
//|                                                                  |
//| v5.40                                                            |
//|                                                                  |
//| CORE                                                             |
//| VWAP = direction + retest/reclaim entry                          |
//| EMA8 M5 = hold/exit after a real runner develops                 |
//|                                                                  |
//| V5.40 SURGICAL FIXES                                             |
//| 1) Young trade failure closes to FLAT. It does NOT instantly     |
//|    reverse. The opposite side must earn a fresh VWAP setup.      |
//| 2) Mature runner keeps its mountain lock, but after price closes |
//|    beyond EMA8 we also measure how much of peak MFE was given    |
//|    back. A meaningful giveback exits on the FIRST bad M5 close.  |
//| 3) Small EMA8 breathing still gets two completed M5 closes.      |
//|                                                                  |
//| No RSI/MACD/ATR/trend-score/OR filters.                           |
//+------------------------------------------------------------------+
#property strict
#property version "5.40"

#include <Trade/Trade.mqh>
CTrade trade;

#define V54_TICK_BUFFER 4096

//====================================================================
// INPUTS
//====================================================================

input double InpV54_Lots                         = 0.01;
input ulong  InpV54_Magic                        = 26090854;
input int    InpV54_DeviationPoints              = 30;
input int    InpV54_EmergencySLPoints            = 0;       // 0 = OFF

input ENUM_TIMEFRAMES InpV54_MapTF               = PERIOD_M5;
input ENUM_TIMEFRAMES InpV54_TriggerTF           = PERIOD_M1;
input int    InpV54_EMAPeriod                    = 8;

// VWAP
input int    InpV54_VWAPResetHour                = 0;
input bool   InpV54_PreferRealVolume             = false;

// V25 adaptive movement
input int    InpV54_SlowM1Lookback               = 20;
input int    InpV54_FastM1Lookback               = 5;
input int    InpV54_LiveVolWindowSeconds         = 30;
input int    InpV54_LiveVolMinTicks              = 5;
input double InpV54_LiveVolWeight                = 1.00;
input double InpV54_FastM1Weight                 = 0.60;
input double InpV54_MinAdaptiveVsSlow            = 0.45;
input double InpV54_MaxAdaptiveVsSlow            = 3.00;
input int    InpV54_M5RangeLookback              = 12;

// VWAP behavior
input double InpV54_DepartureAdaptiveFrac        = 0.60;
input double InpV54_RetestBandAdaptiveFrac       = 0.25;
input double InpV54_ReclaimAdaptiveFrac          = 0.18;
input double InpV54_VWAPWrongDepthAdaptiveFrac   = 0.18;
input int    InpV54_VWAPWrongSideSeconds         = 20;
input int    InpV54_RetestTimeoutMinutes         = 10;

// Mountain runner
input double InpV54_RunnerActivateM5Ranges       = 2.50;

// Mature runner EMA logic
input int    InpV54_EMAExitWrongCloses           = 2;
input double InpV54_EMADeepBreakM5RangeFrac      = 0.75;

// NEW: once a mature runner closes on the wrong side of EMA8,
// do not surrender more than this fraction of the best excursion.
// 0.25 = 25% of peak MFE.
input double InpV54_MaxMFEGivebackFrac           = 0.25;

// Trading friction
// Actual tester showed roughly 0.30 per side at 0.01 lot, so 60/lot RT
// is a conservative default for this V25 test environment.
input double InpV54_CommissionPerLotRT           = 60.0;
input double InpV54_CostSafetyMultiple           = 1.25;
input int    InpV54_ExpectedSlippagePoints       = 0;

// Display
input int    InpV54_PanelUpdateMilliseconds      = 500;
input bool   InpV54_VerboseLog                   = true;

//====================================================================
// TYPES / STATE
//====================================================================

enum V54_SETUP_STATE
{
   V54_IDLE = 0,
   V54_BUY_DEPARTED,
   V54_BUY_RETEST,
   V54_SELL_DEPARTED,
   V54_SELL_RETEST
};

enum V54_SIGNAL
{
   V54_SIGNAL_NONE = 0,
   V54_SIGNAL_BUY,
   V54_SIGNAL_SELL
};

V54_SETUP_STATE g_state = V54_IDLE;

int g_emaHandle = INVALID_HANDLE;

datetime g_lastM1Bar = 0;
datetime g_lastM5Bar = 0;

double g_slowM1Range = 0.0;
double g_fastM1Range = 0.0;
double g_avgM5Range  = 0.0;

long   g_tickTimeMsc[V54_TICK_BUFFER];
double g_tickBid[V54_TICK_BUFFER];
int    g_tickHead = 0;
int    g_tickStored = 0;
double g_liveTickRange = 0.0;
double g_adaptiveRange = 0.0;

datetime g_vwapSessionStart = 0;
double   g_vwapCompletedPV  = 0.0;
double   g_vwapCompletedVol = 0.0;
double   g_liveVWAP         = 0.0;
bool     g_haveLiveVWAP     = false;

datetime g_retestStart = 0;
datetime g_wrongSideSince = 0;
double   g_retestExtreme = 0.0;

// Runner state
double g_mfe = 0.0;
bool   g_runnerLocked = false;
int    g_emaWrongCloses = 0;
double g_lastGivebackFrac = 0.0;
string g_runnerHealth = "FLAT";

// Cost display
double g_lastFrictionDistance = 0.0;
double g_lastEstimatedRTCostMoney = 0.0;

ulong  g_lastPanelMs = 0;
string g_lastAction = "Waiting";

//====================================================================
// LOG
//====================================================================

void V54Log(string text)
{
   if(InpV54_VerboseLog)
      Print("[BEHAVIOR V5.40] ", text);
}

//====================================================================
// BASIC HELPERS
//====================================================================

datetime V54SessionStart(datetime when)
{
   MqlDateTime dt;
   TimeToStruct(when, dt);

   int originalHour = dt.hour;

   dt.hour = InpV54_VWAPResetHour;
   dt.min  = 0;
   dt.sec  = 0;

   datetime start = StructToTime(dt);

   if(originalHour < InpV54_VWAPResetHour)
      start -= 86400;

   return start;
}

bool V54GetBar(ENUM_TIMEFRAMES tf, int shift, MqlRates &bar)
{
   MqlRates a[1];

   if(CopyRates(_Symbol, tf, shift, 1, a) != 1)
      return false;

   bar = a[0];
   return true;
}

double V54BarVolume(const MqlRates &bar)
{
   if(InpV54_PreferRealVolume && bar.real_volume > 0)
      return (double)bar.real_volume;

   return (double)bar.tick_volume;
}

bool V54AverageRange(ENUM_TIMEFRAMES tf,
                     int startShift,
                     int count,
                     double &result)
{
   count = MathMax(2, count);

   MqlRates rates[];
   int copied = CopyRates(_Symbol, tf, startShift, count, rates);

   if(copied != count)
      return false;

   double sum = 0.0;
   int valid = 0;

   for(int i = 0; i < copied; i++)
   {
      double r = rates[i].high - rates[i].low;

      if(r > 0.0)
      {
         sum += r;
         valid++;
      }
   }

   if(valid <= 0)
      return false;

   result = sum / valid;
   return true;
}

double V54NormalizeVolume(double requested)
{
   double minVol  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxVol  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double stepVol = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(stepVol <= 0.0)
      stepVol = minVol;

   double v = MathMax(minVol, MathMin(maxVol, requested));

   if(stepVol > 0.0)
      v = MathFloor((v - minVol + 1e-12) / stepVol) * stepVol + minVol;

   v = MathMax(minVol, MathMin(maxVol, v));

   int digits = 2;

   if(stepVol > 0.0)
   {
      double lg = -MathLog10(stepVol);
      digits = (lg > 0.0 ? (int)MathCeil(lg) : 0);
      digits = MathMin(8, MathMax(0, digits));
   }

   return NormalizeDouble(v, digits);
}

//====================================================================
// VOLATILITY
//====================================================================

void V54RecordTick(const MqlTick &tick)
{
   g_tickTimeMsc[g_tickHead] = tick.time_msc;
   g_tickBid[g_tickHead] = tick.bid;

   g_tickHead++;

   if(g_tickHead >= V54_TICK_BUFFER)
      g_tickHead = 0;

   if(g_tickStored < V54_TICK_BUFFER)
      g_tickStored++;
}

bool V54GetLiveTickRange(long nowMsc,
                         double &range,
                         int &samples)
{
   range = 0.0;
   samples = 0;

   if(g_tickStored <= 0)
      return false;

   long cutoff = (long)MathMax(1, InpV54_LiveVolWindowSeconds) * 1000;

   double hi = -1.0e100;
   double lo =  1.0e100;

   for(int k = 0; k < g_tickStored; k++)
   {
      int idx = g_tickHead - 1 - k;

      while(idx < 0)
         idx += V54_TICK_BUFFER;

      long age = nowMsc - g_tickTimeMsc[idx];

      if(age < 0)
         continue;

      if(age > cutoff)
         break;

      double p = g_tickBid[idx];

      if(p > hi) hi = p;
      if(p < lo) lo = p;

      samples++;
   }

   if(samples < MathMax(2, InpV54_LiveVolMinTicks))
      return false;

   range = MathMax(0.0, hi - lo);
   return true;
}

void V54RefreshRanges()
{
   double x = 0.0;

   if(V54AverageRange(InpV54_TriggerTF, 1, InpV54_SlowM1Lookback, x))
      g_slowM1Range = x;

   if(V54AverageRange(InpV54_TriggerTF, 1, InpV54_FastM1Lookback, x))
      g_fastM1Range = x;

   if(V54AverageRange(InpV54_MapTF, 1, InpV54_M5RangeLookback, x))
      g_avgM5Range = x;
}

double V54AdaptiveRange(long nowMsc)
{
   double slow = g_slowM1Range;
   double fast = g_fastM1Range;
   double base = 0.0;

   if(slow > 0.0 && fast > 0.0)
   {
      double wf = MathMax(0.0, MathMin(1.0, InpV54_FastM1Weight));
      base = slow * (1.0 - wf) + fast * wf;
   }
   else if(fast > 0.0)
      base = fast;
   else
      base = slow;

   double liveRange = 0.0;
   int samples = 0;

   if(V54GetLiveTickRange(nowMsc, liveRange, samples))
   {
      g_liveTickRange = liveRange;
      base = MathMax(base,
                     liveRange * MathMax(0.0, InpV54_LiveVolWeight));
   }
   else
      g_liveTickRange = 0.0;

   if(slow > 0.0)
   {
      double minR = slow * MathMax(0.05, InpV54_MinAdaptiveVsSlow);
      double maxR = slow * MathMax(InpV54_MinAdaptiveVsSlow,
                                   InpV54_MaxAdaptiveVsSlow);

      base = MathMax(minR, MathMin(maxR, base));
   }

   g_adaptiveRange = base;
   return base;
}

//====================================================================
// VWAP
//====================================================================

bool V54RebuildVWAPCompletedCache()
{
   datetime currentOpen = iTime(_Symbol, InpV54_MapTF, 0);

   if(currentOpen <= 0)
      return false;

   datetime sessionStart = V54SessionStart(currentOpen);

   g_vwapSessionStart = sessionStart;
   g_vwapCompletedPV  = 0.0;
   g_vwapCompletedVol = 0.0;

   if(currentOpen <= sessionStart)
      return true;

   MqlRates bars[];

   int copied = CopyRates(_Symbol,
                          InpV54_MapTF,
                          sessionStart,
                          currentOpen - 1,
                          bars);

   if(copied <= 0)
      return true;

   for(int i = 0; i < copied; i++)
   {
      double vol = V54BarVolume(bars[i]);

      if(vol <= 0.0)
         continue;

      double hlc3 = (bars[i].high + bars[i].low + bars[i].close) / 3.0;

      g_vwapCompletedPV  += hlc3 * vol;
      g_vwapCompletedVol += vol;
   }

   return true;
}

bool V54UpdateLiveVWAP()
{
   MqlRates current;

   if(!V54GetBar(InpV54_MapTF, 0, current))
   {
      g_haveLiveVWAP = false;
      return false;
   }

   datetime requiredSession = V54SessionStart(current.time);

   if(g_vwapSessionStart != requiredSession)
   {
      if(!V54RebuildVWAPCompletedCache())
      {
         g_haveLiveVWAP = false;
         return false;
      }
   }

   double pv = g_vwapCompletedPV;
   double vv = g_vwapCompletedVol;

   double vol = V54BarVolume(current);

   if(vol > 0.0)
   {
      double hlc3 = (current.high + current.low + current.close) / 3.0;
      pv += hlc3 * vol;
      vv += vol;
   }

   if(vv <= 0.0)
   {
      g_haveLiveVWAP = false;
      return false;
   }

   g_liveVWAP = pv / vv;
   g_haveLiveVWAP = true;
   return true;
}

//====================================================================
// EMA8
//====================================================================

bool V54GetEMA(int shift, double &ema)
{
   if(g_emaHandle == INVALID_HANDLE)
      return false;

   double v[1];

   if(CopyBuffer(g_emaHandle, 0, shift, 1, v) != 1)
      return false;

   if(v[0] == EMPTY_VALUE)
      return false;

   ema = v[0];
   return true;
}

//====================================================================
// POSITION
//====================================================================

bool V54FindPosition(ulong &ticket,
                     ENUM_POSITION_TYPE &type,
                     double &openPrice,
                     double &floatingProfit)
{
   ticket = 0;
   openPrice = 0.0;
   floatingProfit = 0.0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);

      if(t == 0 || !PositionSelectByTicket(t))
         continue;

      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpV54_Magic)
         continue;

      ticket = t;
      type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      floatingProfit = PositionGetDouble(POSITION_PROFIT);

      return true;
   }

   return false;
}

bool V54HasPosition()
{
   ulong t;
   ENUM_POSITION_TYPE ty;
   double op, pf;

   return V54FindPosition(t, ty, op, pf);
}

//====================================================================
// COST FLOOR
//====================================================================

double V54TickValuePerLot()
{
   double v = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);

   if(v > 0.0)
      return v;

   double vp = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_PROFIT);
   double vl = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);

   if(vp > 0.0 && vl > 0.0)
      return (vp + vl) * 0.5;

   return MathMax(vp, vl);
}

double V54FrictionDistance(const MqlTick &tick,
                           double lots,
                           double &moneyCost)
{
   double spread = MathMax(0.0, tick.ask - tick.bid);
   double commissionDistance = 0.0;
   double spreadMoney = 0.0;
   double commissionMoney = MathMax(0.0, InpV54_CommissionPerLotRT) * lots;

   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = V54TickValuePerLot();

   if(tickSize > 0.0 && tickValue > 0.0)
   {
      double moneyPerPriceUnitPerLot = tickValue / tickSize;

      if(moneyPerPriceUnitPerLot > 0.0)
         commissionDistance =
            MathMax(0.0, InpV54_CommissionPerLotRT) /
            moneyPerPriceUnitPerLot;

      spreadMoney = (spread / tickSize) * tickValue * lots;
   }

   double slipDistance =
      MathMax(0, InpV54_ExpectedSlippagePoints) * _Point;

   double slipMoney = 0.0;

   if(tickSize > 0.0 && tickValue > 0.0)
      slipMoney = (slipDistance / tickSize) * tickValue * lots;

   g_lastFrictionDistance = spread + commissionDistance + slipDistance;
   g_lastEstimatedRTCostMoney = spreadMoney + commissionMoney + slipMoney;

   moneyCost = g_lastEstimatedRTCostMoney;
   return g_lastFrictionDistance;
}

//====================================================================
// TRADE HELPERS
//====================================================================

bool V54TradeOK()
{
   uint rc = trade.ResultRetcode();

   return rc == TRADE_RETCODE_DONE ||
          rc == TRADE_RETCODE_DONE_PARTIAL ||
          rc == TRADE_RETCODE_PLACED;
}

void V54ResetSignalState()
{
   g_state = V54_IDLE;
   g_retestStart = 0;
   g_wrongSideSince = 0;
   g_retestExtreme = 0.0;
}

void V54ResetRunner()
{
   g_mfe = 0.0;
   g_runnerLocked = false;
   g_emaWrongCloses = 0;
   g_lastGivebackFrac = 0.0;
   g_runnerHealth = "NEW POSITION - BUILDING";
}

bool V54OpenBuy()
{
   if(V54HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double lots = V54NormalizeVolume(InpV54_Lots);
   double sl = 0.0;

   if(InpV54_EmergencySLPoints > 0)
      sl = NormalizeDouble(tick.ask -
                           InpV54_EmergencySLPoints * _Point,
                           _Digits);

   bool ok = trade.Buy(lots,
                       _Symbol,
                       0.0,
                       sl,
                       0.0,
                       "V54_MOUNTAIN_BUY");

   if(!ok || !V54TradeOK())
   {
      V54Log("BUY failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   V54ResetSignalState();
   V54ResetRunner();

   g_lastAction = "BUY OPENED - BUILDING";
   V54Log(g_lastAction);
   return true;
}

bool V54OpenSell()
{
   if(V54HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double lots = V54NormalizeVolume(InpV54_Lots);
   double sl = 0.0;

   if(InpV54_EmergencySLPoints > 0)
      sl = NormalizeDouble(tick.bid +
                           InpV54_EmergencySLPoints * _Point,
                           _Digits);

   bool ok = trade.Sell(lots,
                        _Symbol,
                        0.0,
                        sl,
                        0.0,
                        "V54_MOUNTAIN_SELL");

   if(!ok || !V54TradeOK())
   {
      V54Log("SELL failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   V54ResetSignalState();
   V54ResetRunner();

   g_lastAction = "SELL OPENED - BUILDING";
   V54Log(g_lastAction);
   return true;
}

bool V54Close(ulong ticket, string reason)
{
   bool ok = trade.PositionClose(ticket);

   if(!ok || !V54TradeOK())
   {
      V54Log("CLOSE failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   V54ResetSignalState();
   g_mfe = 0.0;
   g_runnerLocked = false;
   g_emaWrongCloses = 0;
   g_lastGivebackFrac = 0.0;
   g_runnerHealth = "FLAT";

   g_lastAction = reason;
   V54Log(reason);
   return true;
}

//====================================================================
// RUNNER MFE + LOCK
//====================================================================

void V54UpdateRunner(const MqlTick &tick)
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;

   if(!V54FindPosition(ticket, type, openPrice, floatingProfit))
   {
      g_mfe = 0.0;
      g_runnerLocked = false;
      return;
   }

   double exitPrice =
      (type == POSITION_TYPE_BUY ? tick.bid : tick.ask);

   double favorable =
      (type == POSITION_TYPE_BUY ?
       exitPrice - openPrice :
       openPrice - exitPrice);

   if(favorable > g_mfe)
      g_mfe = favorable;

   if(!g_runnerLocked &&
      g_avgM5Range > 0.0 &&
      g_mfe >= g_avgM5Range *
               MathMax(0.5, InpV54_RunnerActivateM5Ranges))
   {
      g_runnerLocked = true;
      g_emaWrongCloses = 0;
      g_lastGivebackFrac = 0.0;
      g_runnerHealth = "MOUNTAIN LOCKED - EMA8 OWNS EXIT";
      g_lastAction = "RUNNER LOCKED";

      V54Log("RUNNER LOCKED - VWAP flip noise disabled; EMA8 now owns mature trade");
   }
}

//====================================================================
// EMA8 MATURE-RUNNER EXIT
//====================================================================

void V54ReviewEMAOnCompletedM5()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;

   if(!V54FindPosition(ticket, type, openPrice, floatingProfit))
   {
      g_emaWrongCloses = 0;
      g_lastGivebackFrac = 0.0;
      g_runnerHealth = "FLAT";
      return;
   }

   if(!g_runnerLocked)
   {
      g_emaWrongCloses = 0;
      g_lastGivebackFrac = 0.0;
      g_runnerHealth = "BUILDING - VWAP OWNS DECISION";
      return;
   }

   MqlRates bar;
   double ema = 0.0;

   if(!V54GetBar(InpV54_MapTF, 1, bar) ||
      !V54GetEMA(1, ema))
      return;

   bool wrong = false;
   double depth = 0.0;

   if(type == POSITION_TYPE_BUY)
   {
      wrong = bar.close < ema;
      if(wrong) depth = ema - bar.close;
   }
   else
   {
      wrong = bar.close > ema;
      if(wrong) depth = bar.close - ema;
   }

   if(!wrong)
   {
      g_emaWrongCloses = 0;
      g_lastGivebackFrac = 0.0;
      g_runnerHealth = "EMA8 RESPECTED - HOLD";
      return;
   }

   g_emaWrongCloses++;

   double depthFrac = 0.0;

   if(g_avgM5Range > 0.0)
      depthFrac = depth / g_avgM5Range;

   // Favorable movement remaining at this completed M5 close.
   double favorableAtClose =
      (type == POSITION_TYPE_BUY ?
       bar.close - openPrice :
       openPrice - bar.close);

   favorableAtClose = MathMax(0.0, favorableAtClose);

   double givebackFrac = 0.0;

   if(g_mfe > 0.0)
      givebackFrac = MathMax(0.0,
                             MathMin(1.0,
                                     (g_mfe - favorableAtClose) / g_mfe));

   g_lastGivebackFrac = givebackFrac;

   bool meaningfulPeakGiveback =
      givebackFrac >= MathMax(0.0,
                              MathMin(1.0,
                                      InpV54_MaxMFEGivebackFrac));

   bool deepBreak =
      depthFrac >= MathMax(0.0,
                           InpV54_EMADeepBreakM5RangeFrac);

   bool repeatedBreak =
      g_emaWrongCloses >= MathMax(1,
                                  InpV54_EMAExitWrongCloses);

   // IMPORTANT:
   // After a mature mountain, a first completed M5 close beyond EMA8 is
   // enough IF we have already surrendered a meaningful part of peak MFE.
   // This is designed to stop the "great mountain -> exit much lower" issue.
   if(meaningfulPeakGiveback || deepBreak || repeatedBreak)
   {
      string why;

      if(meaningfulPeakGiveback)
      {
         why = "EMA8 PROFIT LOCK EXIT - " +
               DoubleToString(givebackFrac * 100.0, 1) +
               "% MFE giveback";
      }
      else if(deepBreak)
      {
         why = "EMA8 RUNNER EXIT - deep completed M5 break";
      }
      else
      {
         why = "EMA8 RUNNER EXIT - repeated completed M5 closes";
      }

      if(V54Close(ticket, why))
      {
         g_lastAction = why + " | FLAT - WAIT FRESH VWAP";
         V54Log("MATURE EXIT -> FLAT. No automatic reversal.");
      }

      return;
   }

   g_runnerHealth =
      "EMA8 BREATHING - HOLD | giveback=" +
      DoubleToString(givebackFrac * 100.0, 1) + "%";
}

//====================================================================
// SIGNAL PERMISSION
//====================================================================

bool V54AllowBuyCandidate()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;

   if(!V54FindPosition(ticket, type, openPrice, floatingProfit))
      return true;

   // Never flip a mature runner from VWAP noise.
   if(g_runnerLocked)
      return false;

   // Young SELL can be invalidated by a full BUY setup.
   return type == POSITION_TYPE_SELL;
}

bool V54AllowSellCandidate()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;

   if(!V54FindPosition(ticket, type, openPrice, floatingProfit))
      return true;

   if(g_runnerLocked)
      return false;

   return type == POSITION_TYPE_BUY;
}

bool V54ExecuteSignal(V54_SIGNAL signal)
{
   if(signal == V54_SIGNAL_NONE)
      return false;

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;

   bool have =
      V54FindPosition(ticket, type, openPrice, floatingProfit);

   // Flat = normal VWAP entry.
   if(!have)
   {
      if(signal == V54_SIGNAL_BUY)
         return V54OpenBuy();

      return V54OpenSell();
   }

   // Mature runner cannot be flipped by VWAP behavior.
   if(g_runnerLocked)
   {
      V54ResetSignalState();
      g_lastAction = "OPPOSITE VWAP SIGNAL IGNORED - MOUNTAIN LOCK";
      return false;
   }

   // Same side = keep current trade.
   if((type == POSITION_TYPE_BUY  && signal == V54_SIGNAL_BUY) ||
      (type == POSITION_TYPE_SELL && signal == V54_SIGNAL_SELL))
   {
      V54ResetSignalState();
      return false;
   }

   // V5.40 KEY FIX:
   // A young trade may be wrong, so close it on the full opposite VWAP signal.
   // BUT DO NOT open the opposite trade on the same signal/tick.
   // The market must now establish that new side, return to VWAP and reclaim
   // it again. This removes BUY->SELL->BUY ping-pong and double commissions.
   string reason =
      (signal == V54_SIGNAL_BUY ?
       "YOUNG SELL FAILED - CLOSE FLAT, WAIT FRESH BUY" :
       "YOUNG BUY FAILED - CLOSE FLAT, WAIT FRESH SELL");

   if(V54Close(ticket, reason))
   {
      V54Log("NO YOUNG INSTANT REVERSAL - opposite side must earn a fresh setup");
      return true;
   }

   return false;
}

//====================================================================
// LIVE VWAP SIGNAL ENGINE
//====================================================================

void V54ProcessSignal(const MqlTick &tick)
{
   if(!g_haveLiveVWAP)
      return;

   // Mature runner: EMA8 owns it completely.
   if(V54HasPosition() && g_runnerLocked)
   {
      if(g_state != V54_IDLE)
         V54ResetSignalState();

      return;
   }

   double price = tick.bid;
   double vwap = g_liveVWAP;

   double adaptive = V54AdaptiveRange(tick.time_msc);

   if(adaptive <= 0.0)
      return;

   double naturalDeparture =
      adaptive * MathMax(0.0, InpV54_DepartureAdaptiveFrac);

   double band =
      adaptive * MathMax(0.0, InpV54_RetestBandAdaptiveFrac);

   double naturalReclaim =
      adaptive * MathMax(0.0, InpV54_ReclaimAdaptiveFrac);

   double wrongDepth =
      adaptive * MathMax(0.0, InpV54_VWAPWrongDepthAdaptiveFrac);

   double lots = V54NormalizeVolume(InpV54_Lots);
   double moneyCost = 0.0;
   double friction = V54FrictionDistance(tick, lots, moneyCost);

   double costFloor =
      friction * MathMax(1.0, InpV54_CostSafetyMultiple);

   double departure = MathMax(naturalDeparture, costFloor);
   double reclaim   = MathMax(naturalReclaim, costFloor);

   bool allowBuy = V54AllowBuyCandidate();
   bool allowSell = V54AllowSellCandidate();

   // ---------------------------------------------------------------
   // IDLE -> side established
   // ---------------------------------------------------------------
   if(g_state == V54_IDLE)
   {
      if(allowBuy && price >= vwap + departure)
      {
         g_state = V54_BUY_DEPARTED;
         g_lastAction = "BUY SIDE ESTABLISHED";
         return;
      }

      if(allowSell && price <= vwap - departure)
      {
         g_state = V54_SELL_DEPARTED;
         g_lastAction = "SELL SIDE ESTABLISHED";
         return;
      }

      return;
   }

   if((g_state == V54_BUY_DEPARTED ||
       g_state == V54_BUY_RETEST) && !allowBuy)
   {
      V54ResetSignalState();
      return;
   }

   if((g_state == V54_SELL_DEPARTED ||
       g_state == V54_SELL_RETEST) && !allowSell)
   {
      V54ResetSignalState();
      return;
   }

   // ---------------------------------------------------------------
   // DEPARTURE -> RETEST
   // ---------------------------------------------------------------
   if(g_state == V54_BUY_DEPARTED)
   {
      if(price <= vwap + band)
      {
         g_state = V54_BUY_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;
         g_lastAction = "BUY VWAP RETEST";
      }

      return;
   }

   if(g_state == V54_SELL_DEPARTED)
   {
      if(price >= vwap - band)
      {
         g_state = V54_SELL_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;
         g_lastAction = "SELL VWAP RETEST";
      }

      return;
   }

   // ---------------------------------------------------------------
   // BUY RETEST
   // ---------------------------------------------------------------
   if(g_state == V54_BUY_RETEST)
   {
      g_retestExtreme = MathMin(g_retestExtreme, price);

      if(InpV54_RetestTimeoutMinutes > 0 &&
         g_retestStart > 0 &&
         TimeCurrent() - g_retestStart >
            InpV54_RetestTimeoutMinutes * 60)
      {
         V54ResetSignalState();
         return;
      }

      if(price < vwap - wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         if(TimeCurrent() - g_wrongSideSince >=
            MathMax(1, InpV54_VWAPWrongSideSeconds))
         {
            V54ResetSignalState();
            return;
         }
      }
      else if(price >= vwap)
         g_wrongSideSince = 0;

      bool reclaimed = price >= vwap + reclaim;
      bool bounced = price >= g_retestExtreme + reclaim;

      if(reclaimed && bounced)
         V54ExecuteSignal(V54_SIGNAL_BUY);

      return;
   }

   // ---------------------------------------------------------------
   // SELL RETEST
   // ---------------------------------------------------------------
   if(g_state == V54_SELL_RETEST)
   {
      g_retestExtreme = MathMax(g_retestExtreme, price);

      if(InpV54_RetestTimeoutMinutes > 0 &&
         g_retestStart > 0 &&
         TimeCurrent() - g_retestStart >
            InpV54_RetestTimeoutMinutes * 60)
      {
         V54ResetSignalState();
         return;
      }

      if(price > vwap + wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         if(TimeCurrent() - g_wrongSideSince >=
            MathMax(1, InpV54_VWAPWrongSideSeconds))
         {
            V54ResetSignalState();
            return;
         }
      }
      else if(price <= vwap)
         g_wrongSideSince = 0;

      bool reclaimed = price <= vwap - reclaim;
      bool dropped = price <= g_retestExtreme - reclaim;

      if(reclaimed && dropped)
         V54ExecuteSignal(V54_SIGNAL_SELL);

      return;
   }
}

//====================================================================
// NEW BAR EVENTS
//====================================================================

void V54ProcessNewM1()
{
   datetime current = iTime(_Symbol, InpV54_TriggerTF, 0);

   if(current <= 0 || current == g_lastM1Bar)
      return;

   g_lastM1Bar = current;

   double x = 0.0;

   if(V54AverageRange(InpV54_TriggerTF,
                      1,
                      InpV54_SlowM1Lookback,
                      x))
      g_slowM1Range = x;

   if(V54AverageRange(InpV54_TriggerTF,
                      1,
                      InpV54_FastM1Lookback,
                      x))
      g_fastM1Range = x;
}

void V54ProcessNewM5()
{
   datetime current = iTime(_Symbol, InpV54_MapTF, 0);

   if(current <= 0 || current == g_lastM5Bar)
      return;

   g_lastM5Bar = current;

   V54RebuildVWAPCompletedCache();

   double x = 0.0;

   if(V54AverageRange(InpV54_MapTF,
                      1,
                      InpV54_M5RangeLookback,
                      x))
      g_avgM5Range = x;

   // Completed M5 only for mature runner exits.
   V54ReviewEMAOnCompletedM5();
}

//====================================================================
// PANEL
//====================================================================

string V54StateName()
{
   switch(g_state)
   {
      case V54_BUY_DEPARTED:  return "BUY DEPARTED";
      case V54_BUY_RETEST:    return "BUY RETEST";
      case V54_SELL_DEPARTED: return "SELL DEPARTED";
      case V54_SELL_RETEST:   return "SELL RETEST";
      default:                 return "IDLE";
   }
}

void V54Panel(const MqlTick &tick)
{
   ulong nowMs = GetTickCount64();

   if(g_lastPanelMs > 0 &&
      nowMs - g_lastPanelMs <
         (ulong)MathMax(50, InpV54_PanelUpdateMilliseconds))
      return;

   g_lastPanelMs = nowMs;

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;

   string position = "NONE";

   if(V54FindPosition(ticket, type, openPrice, floatingProfit))
   {
      string phase =
         (g_runnerLocked ? " | MOUNTAIN LOCK" : " | BUILDING");

      position =
         (type == POSITION_TYPE_BUY ? "BUY" : "SELL") + phase;
   }

   double lots = V54NormalizeVolume(InpV54_Lots);
   double money = 0.0;
   double friction = V54FrictionDistance(tick, lots, money);

   Comment(
      "VWAP + EMA8 MOUNTAIN RUNNER v5.40\n",
      "POSITION: ", position, "\n",
      "STATE: ", V54StateName(), "\n",
      "VWAP: ",
      (g_haveLiveVWAP ? DoubleToString(g_liveVWAP, _Digits) : "n/a"),
      "\nRUNNER: ", g_runnerHealth,
      "\nMFE: ", DoubleToString(g_mfe, 2),
      "\nMFE GIVEBACK: ",
      DoubleToString(g_lastGivebackFrac * 100.0, 1), "%",
      "\nM5 AVG RANGE: ", DoubleToString(g_avgM5Range, 2),
      "\nLOCK AT: ",
      DoubleToString(g_avgM5Range * InpV54_RunnerActivateM5Ranges, 2),
      "\nEMA WRONG CLOSES: ", IntegerToString(g_emaWrongCloses),
      "\nADAPTIVE RANGE: ", DoubleToString(g_adaptiveRange, 2),
      "\nEST RT COST: ", DoubleToString(money, 4),
      "\nFRICTION DIST: ", DoubleToString(friction, 2),
      "\nLAST: ", g_lastAction
   );
}

//====================================================================
// INIT / DEINIT / TICK
//====================================================================

int OnInit()
{
   if(InpV54_MapTF != PERIOD_M5 ||
      InpV54_TriggerTF != PERIOD_M1)
   {
      Print("v5.40 requires M5 map + M1/live execution.");
      return INIT_PARAMETERS_INCORRECT;
   }

   if(InpV54_Lots <= 0.0 ||
      InpV54_EMAPeriod < 1 ||
      InpV54_SlowM1Lookback < 2 ||
      InpV54_FastM1Lookback < 2 ||
      InpV54_M5RangeLookback < 2 ||
      InpV54_LiveVolWindowSeconds < 1 ||
      InpV54_LiveVolMinTicks < 2 ||
      InpV54_FastM1Weight < 0.0 ||
      InpV54_FastM1Weight > 1.0 ||
      InpV54_MinAdaptiveVsSlow <= 0.0 ||
      InpV54_MaxAdaptiveVsSlow < InpV54_MinAdaptiveVsSlow ||
      InpV54_DepartureAdaptiveFrac < 0.0 ||
      InpV54_RetestBandAdaptiveFrac < 0.0 ||
      InpV54_ReclaimAdaptiveFrac < 0.0 ||
      InpV54_VWAPWrongDepthAdaptiveFrac < 0.0 ||
      InpV54_VWAPWrongSideSeconds < 1 ||
      InpV54_RetestTimeoutMinutes < 0 ||
      InpV54_RunnerActivateM5Ranges <= 0.0 ||
      InpV54_EMAExitWrongCloses < 1 ||
      InpV54_EMADeepBreakM5RangeFrac < 0.0 ||
      InpV54_MaxMFEGivebackFrac < 0.0 ||
      InpV54_MaxMFEGivebackFrac > 1.0 ||
      InpV54_CommissionPerLotRT < 0.0 ||
      InpV54_CostSafetyMultiple < 1.0 ||
      InpV54_VWAPResetHour < 0 ||
      InpV54_VWAPResetHour > 23)
   {
      Print("v5.40 invalid inputs.");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_emaHandle =
      iMA(_Symbol,
          InpV54_MapTF,
          InpV54_EMAPeriod,
          0,
          MODE_EMA,
          PRICE_CLOSE);

   if(g_emaHandle == INVALID_HANDLE)
   {
      Print("EMA8 handle failed. Error=", GetLastError());
      return INIT_FAILED;
   }

   trade.SetExpertMagicNumber(InpV54_Magic);
   trade.SetDeviationInPoints(InpV54_DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   V54RefreshRanges();
   V54RebuildVWAPCompletedCache();

   MqlTick tick;

   if(SymbolInfoTick(_Symbol, tick))
   {
      V54RecordTick(tick);
      V54UpdateLiveVWAP();
      V54AdaptiveRange(tick.time_msc);
   }

   V54Log(
      "INIT | young failures close FLAT, no instant reverse | "
      "mature runner uses EMA8 + MFE giveback profit lock"
   );

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(g_emaHandle != INVALID_HANDLE)
      IndicatorRelease(g_emaHandle);

   Comment("");
}

void OnTick()
{
   MqlTick tick;

   if(!SymbolInfoTick(_Symbol, tick))
      return;

   V54RecordTick(tick);

   V54ProcessNewM1();
   V54ProcessNewM5();

   if(!V54UpdateLiveVWAP())
      return;

   V54UpdateRunner(tick);
   V54ProcessSignal(tick);
   V54Panel(tick);
}
//+------------------------------------------------------------------+
