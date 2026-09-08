//+------------------------------------------------------------------+
//| VWAP_EMA8_MountainRunner_V5_3.mq5                               |
//|                                                                  |
//| v5.30                                                            |
//|                                                                  |
//| VWAP = direction + retest/reclaim entry                          |
//| EMA8 M5 = hold/exit AFTER a real runner has developed            |
//|                                                                  |
//| Fix: mature runners cannot be flipped by small opposite VWAP     |
//| noise. EMA8 owns the mature runner exit. After that exit, go     |
//| FLAT and require a fresh VWAP setup instead of instant reversal. |
//+------------------------------------------------------------------+
#property strict
#property version "5.30"

#include <Trade/Trade.mqh>
CTrade trade;

#define V53_TICK_BUFFER 4096

input double InpV53_Lots                         = 0.01;
input ulong  InpV53_Magic                        = 26090853;
input int    InpV53_DeviationPoints              = 30;
input int    InpV53_EmergencySLPoints            = 0;
input ENUM_TIMEFRAMES InpV53_MapTF               = PERIOD_M5;
input ENUM_TIMEFRAMES InpV53_TriggerTF           = PERIOD_M1;
input int    InpV53_EMAPeriod                    = 8;
input int    InpV53_VWAPResetHour                = 0;
input bool   InpV53_PreferRealVolume             = false;
input int    InpV53_SlowM1Lookback               = 20;
input int    InpV53_FastM1Lookback               = 5;
input int    InpV53_LiveVolWindowSeconds         = 30;
input int    InpV53_LiveVolMinTicks              = 5;
input double InpV53_LiveVolWeight                = 1.00;
input double InpV53_FastM1Weight                 = 0.60;
input double InpV53_MinAdaptiveVsSlow            = 0.45;
input double InpV53_MaxAdaptiveVsSlow            = 3.00;
input int    InpV53_M5RangeLookback              = 12;
input double InpV53_DepartureAdaptiveFrac        = 0.60;
input double InpV53_RetestBandAdaptiveFrac       = 0.25;
input double InpV53_ReclaimAdaptiveFrac          = 0.18;
input double InpV53_VWAPWrongDepthAdaptiveFrac   = 0.18;
input int    InpV53_VWAPWrongSideSeconds         = 20;
input int    InpV53_RetestTimeoutMinutes         = 10;

// A real jump must happen before EMA8 becomes the exit manager.
input double InpV53_RunnerActivateM5Ranges       = 2.50;
// Once mature: 2 shallow M5 closes beyond EMA8, or 1 deep close.
input int    InpV53_EMAExitWrongCloses           = 2;
input double InpV53_EMADeepBreakM5RangeFrac      = 0.75;

input double InpV53_CommissionPerLotRT           = 58.0;
input double InpV53_CostSafetyMultiple           = 1.25;
input int    InpV53_ExpectedSlippagePoints       = 0;
input int    InpV53_PanelUpdateMilliseconds      = 500;
input bool   InpV53_VerboseLog                   = true;

enum V53_SETUP_STATE
{
   V53_IDLE = 0,
   V53_BUY_DEPARTED,
   V53_BUY_RETEST,
   V53_SELL_DEPARTED,
   V53_SELL_RETEST
};

enum V53_SIGNAL
{
   V53_SIGNAL_NONE = 0,
   V53_SIGNAL_BUY,
   V53_SIGNAL_SELL
};

V53_SETUP_STATE g_state = V53_IDLE;
int g_emaHandle = INVALID_HANDLE;
datetime g_lastM1Bar = 0;
datetime g_lastM5Bar = 0;
double g_slowM1Range = 0.0;
double g_fastM1Range = 0.0;
double g_avgM5Range  = 0.0;
long   g_tickTimeMsc[V53_TICK_BUFFER];
double g_tickBid[V53_TICK_BUFFER];
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
double g_mfe = 0.0;
bool   g_runnerLocked = false;
int    g_emaWrongCloses = 0;
string g_runnerHealth = "FLAT";
double g_lastFrictionDistance = 0.0;
double g_lastEstimatedRTCostMoney = 0.0;
ulong  g_lastPanelMs = 0;
string g_lastAction = "Waiting";

void V53Log(string text)
{
   if(InpV53_VerboseLog)
      Print("[BEHAVIOR V5.30] ", text);
}

datetime V53SessionStart(datetime when)
{
   MqlDateTime dt;
   TimeToStruct(when, dt);
   int originalHour = dt.hour;
   dt.hour = InpV53_VWAPResetHour;
   dt.min = 0;
   dt.sec = 0;
   datetime start = StructToTime(dt);
   if(originalHour < InpV53_VWAPResetHour)
      start -= 86400;
   return start;
}

bool V53GetBar(ENUM_TIMEFRAMES tf, int shift, MqlRates &bar)
{
   MqlRates a[1];
   if(CopyRates(_Symbol, tf, shift, 1, a) != 1)
      return false;
   bar = a[0];
   return true;
}

double V53BarVolume(const MqlRates &bar)
{
   if(InpV53_PreferRealVolume && bar.real_volume > 0)
      return (double)bar.real_volume;
   return (double)bar.tick_volume;
}

bool V53AverageRange(ENUM_TIMEFRAMES tf, int startShift, int count, double &result)
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

double V53NormalizeVolume(double requested)
{
   double minVol = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxVol = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
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

void V53RecordTick(const MqlTick &tick)
{
   g_tickTimeMsc[g_tickHead] = tick.time_msc;
   g_tickBid[g_tickHead] = tick.bid;
   g_tickHead++;
   if(g_tickHead >= V53_TICK_BUFFER)
      g_tickHead = 0;
   if(g_tickStored < V53_TICK_BUFFER)
      g_tickStored++;
}

bool V53GetLiveTickRange(long nowMsc, double &range, int &samples)
{
   range = 0.0;
   samples = 0;
   if(g_tickStored <= 0)
      return false;
   long cutoff = (long)MathMax(1, InpV53_LiveVolWindowSeconds) * 1000;
   double hi = -1.0e100;
   double lo =  1.0e100;
   for(int k = 0; k < g_tickStored; k++)
   {
      int idx = g_tickHead - 1 - k;
      while(idx < 0)
         idx += V53_TICK_BUFFER;
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
   if(samples < MathMax(2, InpV53_LiveVolMinTicks))
      return false;
   range = MathMax(0.0, hi - lo);
   return true;
}

void V53RefreshRanges()
{
   double x = 0.0;
   if(V53AverageRange(InpV53_TriggerTF, 1, InpV53_SlowM1Lookback, x))
      g_slowM1Range = x;
   if(V53AverageRange(InpV53_TriggerTF, 1, InpV53_FastM1Lookback, x))
      g_fastM1Range = x;
   if(V53AverageRange(InpV53_MapTF, 1, InpV53_M5RangeLookback, x))
      g_avgM5Range = x;
}

double V53AdaptiveRange(long nowMsc)
{
   double slow = g_slowM1Range;
   double fast = g_fastM1Range;
   double base = 0.0;
   if(slow > 0.0 && fast > 0.0)
   {
      double wf = MathMax(0.0, MathMin(1.0, InpV53_FastM1Weight));
      base = slow * (1.0 - wf) + fast * wf;
   }
   else if(fast > 0.0)
      base = fast;
   else
      base = slow;
   double liveRange = 0.0;
   int samples = 0;
   if(V53GetLiveTickRange(nowMsc, liveRange, samples))
   {
      g_liveTickRange = liveRange;
      base = MathMax(base, liveRange * MathMax(0.0, InpV53_LiveVolWeight));
   }
   else
      g_liveTickRange = 0.0;
   if(slow > 0.0)
   {
      double minR = slow * MathMax(0.05, InpV53_MinAdaptiveVsSlow);
      double maxR = slow * MathMax(InpV53_MinAdaptiveVsSlow, InpV53_MaxAdaptiveVsSlow);
      base = MathMax(minR, MathMin(maxR, base));
   }
   g_adaptiveRange = base;
   return base;
}

bool V53RebuildVWAPCompletedCache()
{
   datetime currentOpen = iTime(_Symbol, InpV53_MapTF, 0);
   if(currentOpen <= 0)
      return false;
   datetime sessionStart = V53SessionStart(currentOpen);
   g_vwapSessionStart = sessionStart;
   g_vwapCompletedPV = 0.0;
   g_vwapCompletedVol = 0.0;
   if(currentOpen <= sessionStart)
      return true;
   MqlRates bars[];
   int copied = CopyRates(_Symbol, InpV53_MapTF, sessionStart, currentOpen - 1, bars);
   if(copied <= 0)
      return true;
   for(int i = 0; i < copied; i++)
   {
      double vol = V53BarVolume(bars[i]);
      if(vol <= 0.0)
         continue;
      double hlc3 = (bars[i].high + bars[i].low + bars[i].close) / 3.0;
      g_vwapCompletedPV += hlc3 * vol;
      g_vwapCompletedVol += vol;
   }
   return true;
}

bool V53UpdateLiveVWAP()
{
   MqlRates current;
   if(!V53GetBar(InpV53_MapTF, 0, current))
   {
      g_haveLiveVWAP = false;
      return false;
   }
   datetime requiredSession = V53SessionStart(current.time);
   if(g_vwapSessionStart != requiredSession)
   {
      if(!V53RebuildVWAPCompletedCache())
      {
         g_haveLiveVWAP = false;
         return false;
      }
   }
   double pv = g_vwapCompletedPV;
   double vv = g_vwapCompletedVol;
   double vol = V53BarVolume(current);
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

bool V53GetEMA(int shift, double &ema)
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

bool V53FindPosition(ulong &ticket, ENUM_POSITION_TYPE &type, double &openPrice, double &floatingProfit)
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
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpV53_Magic)
         continue;
      ticket = t;
      type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      floatingProfit = PositionGetDouble(POSITION_PROFIT);
      return true;
   }
   return false;
}

bool V53HasPosition()
{
   ulong t;
   ENUM_POSITION_TYPE ty;
   double op, pf;
   return V53FindPosition(t, ty, op, pf);
}

double V53TickValuePerLot()
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

double V53FrictionDistance(const MqlTick &tick, double lots, double &moneyCost)
{
   double spread = MathMax(0.0, tick.ask - tick.bid);
   double commissionDistance = 0.0;
   double spreadMoney = 0.0;
   double commissionMoney = MathMax(0.0, InpV53_CommissionPerLotRT) * lots;
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = V53TickValuePerLot();
   if(tickSize > 0.0 && tickValue > 0.0)
   {
      double moneyPerPriceUnitPerLot = tickValue / tickSize;
      if(moneyPerPriceUnitPerLot > 0.0)
         commissionDistance = MathMax(0.0, InpV53_CommissionPerLotRT) / moneyPerPriceUnitPerLot;
      spreadMoney = (spread / tickSize) * tickValue * lots;
   }
   double slipDistance = MathMax(0, InpV53_ExpectedSlippagePoints) * _Point;
   double slipMoney = 0.0;
   if(tickSize > 0.0 && tickValue > 0.0)
      slipMoney = (slipDistance / tickSize) * tickValue * lots;
   g_lastFrictionDistance = spread + commissionDistance + slipDistance;
   g_lastEstimatedRTCostMoney = spreadMoney + commissionMoney + slipMoney;
   moneyCost = g_lastEstimatedRTCostMoney;
   return g_lastFrictionDistance;
}

bool V53TradeOK()
{
   uint rc = trade.ResultRetcode();
   return rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL || rc == TRADE_RETCODE_PLACED;
}

void V53ResetSignalState()
{
   g_state = V53_IDLE;
   g_retestStart = 0;
   g_wrongSideSince = 0;
   g_retestExtreme = 0.0;
}

void V53ResetRunner()
{
   g_mfe = 0.0;
   g_runnerLocked = false;
   g_emaWrongCloses = 0;
   g_runnerHealth = "NEW POSITION - BUILDING";
}

bool V53OpenBuy()
{
   if(V53HasPosition())
      return false;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;
   double lots = V53NormalizeVolume(InpV53_Lots);
   double sl = 0.0;
   if(InpV53_EmergencySLPoints > 0)
      sl = NormalizeDouble(tick.ask - InpV53_EmergencySLPoints * _Point, _Digits);
   bool ok = trade.Buy(lots, _Symbol, 0.0, sl, 0.0, "V53_MOUNTAIN_BUY");
   if(!ok || !V53TradeOK())
   {
      V53Log("BUY failed: " + trade.ResultRetcodeDescription());
      return false;
   }
   V53ResetSignalState();
   V53ResetRunner();
   g_lastAction = "BUY OPENED";
   V53Log("BUY OPENED - BUILD THE RUNNER");
   return true;
}

bool V53OpenSell()
{
   if(V53HasPosition())
      return false;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;
   double lots = V53NormalizeVolume(InpV53_Lots);
   double sl = 0.0;
   if(InpV53_EmergencySLPoints > 0)
      sl = NormalizeDouble(tick.bid + InpV53_EmergencySLPoints * _Point, _Digits);
   bool ok = trade.Sell(lots, _Symbol, 0.0, sl, 0.0, "V53_MOUNTAIN_SELL");
   if(!ok || !V53TradeOK())
   {
      V53Log("SELL failed: " + trade.ResultRetcodeDescription());
      return false;
   }
   V53ResetSignalState();
   V53ResetRunner();
   g_lastAction = "SELL OPENED";
   V53Log("SELL OPENED - BUILD THE RUNNER");
   return true;
}

bool V53Close(ulong ticket, string reason)
{
   bool ok = trade.PositionClose(ticket);
   if(!ok || !V53TradeOK())
   {
      V53Log("CLOSE failed: " + trade.ResultRetcodeDescription());
      return false;
   }
   g_lastAction = reason;
   V53Log(reason);
   V53ResetSignalState();
   g_mfe = 0.0;
   g_runnerLocked = false;
   g_emaWrongCloses = 0;
   g_runnerHealth = "FLAT";
   return true;
}

void V53UpdateRunner(const MqlTick &tick)
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;
   if(!V53FindPosition(ticket, type, openPrice, floatingProfit))
   {
      g_mfe = 0.0;
      g_runnerLocked = false;
      return;
   }
   double exitPrice = (type == POSITION_TYPE_BUY ? tick.bid : tick.ask);
   double favorable = (type == POSITION_TYPE_BUY ? exitPrice - openPrice : openPrice - exitPrice);
   if(favorable > g_mfe)
      g_mfe = favorable;
   if(!g_runnerLocked && g_avgM5Range > 0.0 && g_mfe >= g_avgM5Range * MathMax(0.5, InpV53_RunnerActivateM5Ranges))
   {
      g_runnerLocked = true;
      g_emaWrongCloses = 0;
      g_runnerHealth = "MOUNTAIN LOCKED - EMA8 OWNS EXIT";
      g_lastAction = "RUNNER LOCKED";
      V53Log("RUNNER LOCKED - good move achieved; opposite VWAP noise cannot flip it");
   }
}

void V53ReviewEMAOnCompletedM5()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;
   if(!V53FindPosition(ticket, type, openPrice, floatingProfit))
   {
      g_emaWrongCloses = 0;
      g_runnerHealth = "FLAT";
      return;
   }
   if(!g_runnerLocked)
   {
      g_emaWrongCloses = 0;
      g_runnerHealth = "BUILDING - VWAP STILL OWNS DECISION";
      return;
   }
   MqlRates bar;
   double ema = 0.0;
   if(!V53GetBar(InpV53_MapTF, 1, bar) || !V53GetEMA(1, ema))
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
      g_runnerHealth = "EMA8 RESPECTED - HOLD";
      return;
   }
   g_emaWrongCloses++;
   double depthFrac = 0.0;
   if(g_avgM5Range > 0.0)
      depthFrac = depth / g_avgM5Range;
   bool deepBreak = depthFrac >= MathMax(0.0, InpV53_EMADeepBreakM5RangeFrac);
   bool repeatedBreak = g_emaWrongCloses >= MathMax(1, InpV53_EMAExitWrongCloses);
   if(deepBreak || repeatedBreak)
   {
      string why = (deepBreak ? "EMA8 RUNNER EXIT - deep completed M5 break" : "EMA8 RUNNER EXIT - repeated completed M5 closes");
      if(V53Close(ticket, why))
      {
         g_lastAction = why + " | FLAT, WAIT FRESH VWAP";
         V53Log("NO INSTANT REVERSAL - waiting for fresh VWAP retest/reclaim");
      }
      return;
   }
   g_runnerHealth = "EMA8 BREATHING 1/" + IntegerToString(MathMax(1, InpV53_EMAExitWrongCloses)) + " - HOLD";
}

bool V53AllowBuyCandidate()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;
   if(!V53FindPosition(ticket, type, openPrice, floatingProfit))
      return true;
   if(g_runnerLocked)
      return false;
   return type == POSITION_TYPE_SELL;
}

bool V53AllowSellCandidate()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;
   if(!V53FindPosition(ticket, type, openPrice, floatingProfit))
      return true;
   if(g_runnerLocked)
      return false;
   return type == POSITION_TYPE_BUY;
}

bool V53ExecuteSignal(V53_SIGNAL signal)
{
   if(signal == V53_SIGNAL_NONE)
      return false;
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;
   bool have = V53FindPosition(ticket, type, openPrice, floatingProfit);
   if(!have)
   {
      if(signal == V53_SIGNAL_BUY)
         return V53OpenBuy();
      return V53OpenSell();
   }
   if(g_runnerLocked)
   {
      V53ResetSignalState();
      g_lastAction = "OPPOSITE VWAP SIGNAL IGNORED - EMA8 OWNS MATURE RUNNER";
      return false;
   }
   if((type == POSITION_TYPE_BUY && signal == V53_SIGNAL_BUY) || (type == POSITION_TYPE_SELL && signal == V53_SIGNAL_SELL))
   {
      V53ResetSignalState();
      return false;
   }
   string reason = (signal == V53_SIGNAL_BUY ? "YOUNG SELL FAILED - FULL BUY VWAP SIGNAL" : "YOUNG BUY FAILED - FULL SELL VWAP SIGNAL");
   if(!V53Close(ticket, reason))
      return false;
   if(signal == V53_SIGNAL_BUY)
      return V53OpenBuy();
   return V53OpenSell();
}

void V53ProcessSignal(const MqlTick &tick)
{
   if(!g_haveLiveVWAP)
      return;
   if(V53HasPosition() && g_runnerLocked)
   {
      if(g_state != V53_IDLE)
         V53ResetSignalState();
      return;
   }
   double price = tick.bid;
   double vwap = g_liveVWAP;
   double adaptive = V53AdaptiveRange(tick.time_msc);
   if(adaptive <= 0.0)
      return;
   double naturalDeparture = adaptive * MathMax(0.0, InpV53_DepartureAdaptiveFrac);
   double band = adaptive * MathMax(0.0, InpV53_RetestBandAdaptiveFrac);
   double naturalReclaim = adaptive * MathMax(0.0, InpV53_ReclaimAdaptiveFrac);
   double wrongDepth = adaptive * MathMax(0.0, InpV53_VWAPWrongDepthAdaptiveFrac);
   double lots = V53NormalizeVolume(InpV53_Lots);
   double moneyCost = 0.0;
   double friction = V53FrictionDistance(tick, lots, moneyCost);
   double costFloor = friction * MathMax(1.0, InpV53_CostSafetyMultiple);
   double departure = MathMax(naturalDeparture, costFloor);
   double reclaim = MathMax(naturalReclaim, costFloor);
   bool allowBuy = V53AllowBuyCandidate();
   bool allowSell = V53AllowSellCandidate();
   if(g_state == V53_IDLE)
   {
      if(allowBuy && price >= vwap + departure)
      {
         g_state = V53_BUY_DEPARTED;
         g_lastAction = "BUY SIDE ESTABLISHED";
         return;
      }
      if(allowSell && price <= vwap - departure)
      {
         g_state = V53_SELL_DEPARTED;
         g_lastAction = "SELL SIDE ESTABLISHED";
         return;
      }
      return;
   }
   if((g_state == V53_BUY_DEPARTED || g_state == V53_BUY_RETEST) && !allowBuy)
   {
      V53ResetSignalState();
      return;
   }
   if((g_state == V53_SELL_DEPARTED || g_state == V53_SELL_RETEST) && !allowSell)
   {
      V53ResetSignalState();
      return;
   }
   if(g_state == V53_BUY_DEPARTED)
   {
      if(price <= vwap + band)
      {
         g_state = V53_BUY_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;
         g_lastAction = "BUY VWAP RETEST";
      }
      return;
   }
   if(g_state == V53_SELL_DEPARTED)
   {
      if(price >= vwap - band)
      {
         g_state = V53_SELL_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;
         g_lastAction = "SELL VWAP RETEST";
      }
      return;
   }
   if(g_state == V53_BUY_RETEST)
   {
      g_retestExtreme = MathMin(g_retestExtreme, price);
      if(InpV53_RetestTimeoutMinutes > 0 && g_retestStart > 0 && TimeCurrent() - g_retestStart > InpV53_RetestTimeoutMinutes * 60)
      {
         V53ResetSignalState();
         return;
      }
      if(price < vwap - wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();
         if(TimeCurrent() - g_wrongSideSince >= MathMax(1, InpV53_VWAPWrongSideSeconds))
         {
            V53ResetSignalState();
            return;
         }
      }
      else if(price >= vwap)
         g_wrongSideSince = 0;
      bool reclaimed = price >= vwap + reclaim;
      bool bounced = price >= g_retestExtreme + reclaim;
      if(reclaimed && bounced)
         V53ExecuteSignal(V53_SIGNAL_BUY);
      return;
   }
   if(g_state == V53_SELL_RETEST)
   {
      g_retestExtreme = MathMax(g_retestExtreme, price);
      if(InpV53_RetestTimeoutMinutes > 0 && g_retestStart > 0 && TimeCurrent() - g_retestStart > InpV53_RetestTimeoutMinutes * 60)
      {
         V53ResetSignalState();
         return;
      }
      if(price > vwap + wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();
         if(TimeCurrent() - g_wrongSideSince >= MathMax(1, InpV53_VWAPWrongSideSeconds))
         {
            V53ResetSignalState();
            return;
         }
      }
      else if(price <= vwap)
         g_wrongSideSince = 0;
      bool reclaimed = price <= vwap - reclaim;
      bool dropped = price <= g_retestExtreme - reclaim;
      if(reclaimed && dropped)
         V53ExecuteSignal(V53_SIGNAL_SELL);
      return;
   }
}

void V53ProcessNewM1()
{
   datetime current = iTime(_Symbol, InpV53_TriggerTF, 0);
   if(current <= 0 || current == g_lastM1Bar)
      return;
   g_lastM1Bar = current;
   double x = 0.0;
   if(V53AverageRange(InpV53_TriggerTF, 1, InpV53_SlowM1Lookback, x))
      g_slowM1Range = x;
   if(V53AverageRange(InpV53_TriggerTF, 1, InpV53_FastM1Lookback, x))
      g_fastM1Range = x;
}

void V53ProcessNewM5()
{
   datetime current = iTime(_Symbol, InpV53_MapTF, 0);
   if(current <= 0 || current == g_lastM5Bar)
      return;
   g_lastM5Bar = current;
   V53RebuildVWAPCompletedCache();
   double x = 0.0;
   if(V53AverageRange(InpV53_MapTF, 1, InpV53_M5RangeLookback, x))
      g_avgM5Range = x;
   V53ReviewEMAOnCompletedM5();
}

string V53StateName()
{
   switch(g_state)
   {
      case V53_BUY_DEPARTED: return "BUY DEPARTED";
      case V53_BUY_RETEST: return "BUY RETEST";
      case V53_SELL_DEPARTED: return "SELL DEPARTED";
      case V53_SELL_RETEST: return "SELL RETEST";
      default: return "IDLE";
   }
}

void V53Panel(const MqlTick &tick)
{
   ulong nowMs = GetTickCount64();
   if(g_lastPanelMs > 0 && nowMs - g_lastPanelMs < (ulong)MathMax(50, InpV53_PanelUpdateMilliseconds))
      return;
   g_lastPanelMs = nowMs;
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice, floatingProfit;
   string position = "NONE";
   if(V53FindPosition(ticket, type, openPrice, floatingProfit))
   {
      string phase = (g_runnerLocked ? " | MOUNTAIN LOCK" : " | BUILDING");
      position = (type == POSITION_TYPE_BUY ? "BUY" : "SELL") + phase;
   }
   double lots = V53NormalizeVolume(InpV53_Lots);
   double money = 0.0;
   double friction = V53FrictionDistance(tick, lots, money);
   Comment(
      "VWAP + EMA8 MOUNTAIN RUNNER v5.30\n",
      "POSITION: ", position, "\n",
      "STATE: ", V53StateName(), "\n",
      "VWAP: ", (g_haveLiveVWAP ? DoubleToString(g_liveVWAP, _Digits) : "n/a"),
      "\nRUNNER: ", g_runnerHealth,
      "\nMFE: ", DoubleToString(g_mfe, 2),
      "\nM5 AVG RANGE: ", DoubleToString(g_avgM5Range, 2),
      "\nLOCK AT: ", DoubleToString(g_avgM5Range * InpV53_RunnerActivateM5Ranges, 2),
      "\nEMA WRONG CLOSES: ", IntegerToString(g_emaWrongCloses),
      "\nADAPTIVE RANGE: ", DoubleToString(g_adaptiveRange, 2),
      "\nEST RT COST: ", DoubleToString(money, 4),
      "\nFRICTION DIST: ", DoubleToString(friction, 2),
      "\nLAST: ", g_lastAction
   );
}

int OnInit()
{
   if(InpV53_MapTF != PERIOD_M5 || InpV53_TriggerTF != PERIOD_M1)
      return INIT_PARAMETERS_INCORRECT;
   if(InpV53_Lots <= 0.0 || InpV53_EMAPeriod < 1 || InpV53_SlowM1Lookback < 2 || InpV53_FastM1Lookback < 2 || InpV53_M5RangeLookback < 2 || InpV53_LiveVolWindowSeconds < 1 || InpV53_LiveVolMinTicks < 2 || InpV53_FastM1Weight < 0.0 || InpV53_FastM1Weight > 1.0 || InpV53_MinAdaptiveVsSlow <= 0.0 || InpV53_MaxAdaptiveVsSlow < InpV53_MinAdaptiveVsSlow || InpV53_RunnerActivateM5Ranges <= 0.0 || InpV53_EMAExitWrongCloses < 1 || InpV53_EMADeepBreakM5RangeFrac < 0.0 || InpV53_CostSafetyMultiple < 1.0 || InpV53_VWAPResetHour < 0 || InpV53_VWAPResetHour > 23)
      return INIT_PARAMETERS_INCORRECT;
   g_emaHandle = iMA(_Symbol, InpV53_MapTF, InpV53_EMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
   if(g_emaHandle == INVALID_HANDLE)
      return INIT_FAILED;
   trade.SetExpertMagicNumber(InpV53_Magic);
   trade.SetDeviationInPoints(InpV53_DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);
   V53RefreshRanges();
   V53RebuildVWAPCompletedCache();
   MqlTick tick;
   if(SymbolInfoTick(_Symbol, tick))
   {
      V53RecordTick(tick);
      V53UpdateLiveVWAP();
      V53AdaptiveRange(tick.time_msc);
   }
   V53Log("INIT | mature runner cannot be flipped by VWAP noise | EMA8 exits mature runner | after EMA exit go FLAT");
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
   V53RecordTick(tick);
   V53ProcessNewM1();
   V53ProcessNewM5();
   if(!V53UpdateLiveVWAP())
      return;
   V53UpdateRunner(tick);
   V53ProcessSignal(tick);
   V53Panel(tick);
}
//+------------------------------------------------------------------+
