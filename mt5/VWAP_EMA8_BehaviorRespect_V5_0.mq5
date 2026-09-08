//+------------------------------------------------------------------+
//|        VWAP_EMA8_BehaviorRespect_V5_0.mq5                       |
//|                                                                  |
//| v5.20                                                            |
//|                                                                  |
//| CORE                                                             |
//| VWAP = side + retest / reclaim signal                            |
//| EMA8 = runner health / context, NOT a mechanical exit            |
//|                                                                  |
//| HOLD LOGIC                                                       |
//| Once BUY/SELL is open, HOLD it through EMA/VWAP noise.           |
//| Do not make little exit/re-entry trades.                          |
//| Close only when the FULL OPPOSITE VWAP setup confirms, then       |
//| reverse immediately into the new direction.                      |
//|                                                                  |
//| V25 EXECUTION                                                    |
//| Adaptive slow+fast+live volatility                               |
//| Cached/incremental VWAP                                          |
//| Spread + learned commission economic floor                       |
//+------------------------------------------------------------------+
#property strict
#property version "5.20"

#include <Trade/Trade.mqh>
CTrade trade;

#define V52_TICK_BUFFER 4096

//====================================================================
// INPUTS
//====================================================================

input double InpV52_Lots                         = 0.01;
input ulong  InpV52_Magic                        = 26090852;
input int    InpV52_DeviationPoints              = 30;
input int    InpV52_EmergencySLPoints            = 0;       // 0 = OFF

input ENUM_TIMEFRAMES InpV52_MapTF               = PERIOD_M5;
input ENUM_TIMEFRAMES InpV52_TriggerTF           = PERIOD_M1;
input int    InpV52_EMAPeriod                    = 8;

// VWAP session
input int    InpV52_VWAPResetHour                = 0;
input bool   InpV52_PreferRealVolume             = false;

// V25 volatility engine
input int    InpV52_SlowM1Lookback               = 20;
input int    InpV52_FastM1Lookback               = 5;
input int    InpV52_LiveVolWindowSeconds         = 30;
input int    InpV52_LiveVolMinTicks              = 5;
input double InpV52_LiveVolWeight                 = 1.00;
input double InpV52_FastM1Weight                  = 0.60;
input double InpV52_MinAdaptiveVsSlow             = 0.45;
input double InpV52_MaxAdaptiveVsSlow             = 3.00;
input int    InpV52_M5RangeLookback               = 12;

// VWAP behavior
input double InpV52_DepartureAdaptiveFrac         = 0.60;
input double InpV52_RetestBandAdaptiveFrac        = 0.25;
input double InpV52_ReclaimAdaptiveFrac           = 0.18;
input double InpV52_VWAPWrongDepthAdaptiveFrac    = 0.18;
input int    InpV52_VWAPWrongSideSeconds          = 20;
input int    InpV52_RetestTimeoutMinutes          = 10;

// EMA8 is now a HOLD monitor only.
// It may warn that the runner is weak, but it will NOT close a trade.
input double InpV52_EMADeepWarningM5RangeFrac     = 0.35;

// Transaction costs
input double InpV52_FallbackCommissionPerLotRT    = 58.0;
input bool   InpV52_AutoLearnCommission           = true;
input int    InpV52_CommissionHistoryDays         = 90;
input double InpV52_CostSafetyMultiple            = 1.25;
input int    InpV52_ExpectedSlippagePoints        = 0;

// UI / logs
input int    InpV52_PanelUpdateMilliseconds       = 500;
input bool   InpV52_VerboseLog                    = true;

//====================================================================
// TYPES / STATE
//====================================================================

enum V52_SETUP_STATE
{
   V52_IDLE = 0,
   V52_BUY_DEPARTED,
   V52_BUY_RETEST,
   V52_SELL_DEPARTED,
   V52_SELL_RETEST
};

enum V52_SIGNAL
{
   V52_SIGNAL_NONE = 0,
   V52_SIGNAL_BUY,
   V52_SIGNAL_SELL
};

struct V52CommissionGroup
{
   long   positionId;
   double cost;
   double entryVolume;
   bool   hasIn;
   bool   hasOut;
};

V52_SETUP_STATE g_state = V52_IDLE;

int g_emaHandle = INVALID_HANDLE;

datetime g_lastM1Bar = 0;
datetime g_lastM5Bar = 0;

// Cached ranges
double g_slowM1Range = 0.0;
double g_fastM1Range = 0.0;
double g_avgM5Range  = 0.0;

// Tick-window volatility
long   g_tickTimeMsc[V52_TICK_BUFFER];
double g_tickBid[V52_TICK_BUFFER];
int    g_tickHead = 0;
int    g_tickStored = 0;
double g_liveTickRange = 0.0;
double g_adaptiveRange = 0.0;

// Incremental VWAP cache
datetime g_vwapSessionStart = 0;
double   g_vwapCompletedPV  = 0.0;
double   g_vwapCompletedVol = 0.0;
double   g_liveVWAP         = 0.0;
bool     g_haveLiveVWAP     = false;

// Retest state
datetime g_retestStart = 0;
datetime g_wrongSideSince = 0;
double   g_retestExtreme = 0.0;

// Runner state
double g_mfe = 0.0;
int    g_emaWrongCloses = 0;
bool   g_emaDeepWarning = false;
string g_runnerHealth = "FLAT";

// Cost state
double g_commissionPerLotRT = 0.0;
double g_lastSpreadDistance = 0.0;
double g_lastCommissionDistance = 0.0;
double g_lastFrictionDistance = 0.0;
double g_lastEstimatedRTCostMoney = 0.0;
bool   g_refreshCommissionNextM1 = false;

// UI
ulong  g_lastPanelMs = 0;
string g_lastAction = "Waiting";

//====================================================================
// LOG
//====================================================================

void V52Log(string text)
{
   if(InpV52_VerboseLog)
      Print("[BEHAVIOR V5.20] ", text);
}

//====================================================================
// BASIC HELPERS
//====================================================================

datetime V52SessionStart(datetime when)
{
   MqlDateTime dt;
   TimeToStruct(when, dt);

   int originalHour = dt.hour;

   dt.hour = InpV52_VWAPResetHour;
   dt.min  = 0;
   dt.sec  = 0;

   datetime start = StructToTime(dt);

   if(originalHour < InpV52_VWAPResetHour)
      start -= 86400;

   return start;
}

bool V52GetBar(ENUM_TIMEFRAMES tf,
               int shift,
               MqlRates &bar)
{
   MqlRates arr[1];

   if(CopyRates(_Symbol, tf, shift, 1, arr) != 1)
      return false;

   bar = arr[0];
   return true;
}

double V52BarVolume(const MqlRates &bar)
{
   if(InpV52_PreferRealVolume && bar.real_volume > 0)
      return (double)bar.real_volume;

   return (double)bar.tick_volume;
}

bool V52AverageRange(ENUM_TIMEFRAMES tf,
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

double V52NormalizeVolume(double requested)
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
// VOLATILITY ENGINE
//====================================================================

void V52RecordTick(const MqlTick &tick)
{
   g_tickTimeMsc[g_tickHead] = tick.time_msc;
   g_tickBid[g_tickHead] = tick.bid;

   g_tickHead++;

   if(g_tickHead >= V52_TICK_BUFFER)
      g_tickHead = 0;

   if(g_tickStored < V52_TICK_BUFFER)
      g_tickStored++;
}

bool V52GetLiveTickRange(long nowMsc,
                         double &range,
                         int &samples)
{
   range = 0.0;
   samples = 0;

   if(g_tickStored <= 0)
      return false;

   long cutoff = (long)MathMax(1, InpV52_LiveVolWindowSeconds) * 1000;

   double hi = -1.0e100;
   double lo =  1.0e100;

   for(int k = 0; k < g_tickStored; k++)
   {
      int idx = g_tickHead - 1 - k;

      while(idx < 0)
         idx += V52_TICK_BUFFER;

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

   if(samples < MathMax(2, InpV52_LiveVolMinTicks))
      return false;

   range = MathMax(0.0, hi - lo);
   return true;
}

void V52RefreshM1RangeCache()
{
   double slow = 0.0;
   double fast = 0.0;

   if(V52AverageRange(InpV52_TriggerTF,
                      1,
                      InpV52_SlowM1Lookback,
                      slow))
   {
      g_slowM1Range = slow;
   }

   if(V52AverageRange(InpV52_TriggerTF,
                      1,
                      InpV52_FastM1Lookback,
                      fast))
   {
      g_fastM1Range = fast;
   }
}

void V52RefreshM5RangeCache()
{
   double r = 0.0;

   if(V52AverageRange(InpV52_MapTF,
                      1,
                      InpV52_M5RangeLookback,
                      r))
   {
      g_avgM5Range = r;
   }
}

double V52AdaptiveRange(long nowMsc)
{
   double slow = g_slowM1Range;
   double fast = g_fastM1Range;
   double base = 0.0;

   if(slow > 0.0 && fast > 0.0)
   {
      double wf = MathMax(0.0, MathMin(1.0, InpV52_FastM1Weight));
      base = slow * (1.0 - wf) + fast * wf;
   }
   else if(fast > 0.0)
   {
      base = fast;
   }
   else
   {
      base = slow;
   }

   double liveRange = 0.0;
   int samples = 0;

   if(V52GetLiveTickRange(nowMsc, liveRange, samples))
   {
      g_liveTickRange = liveRange;

      base = MathMax(base,
                     liveRange * MathMax(0.0, InpV52_LiveVolWeight));
   }
   else
   {
      g_liveTickRange = 0.0;
   }

   if(slow > 0.0)
   {
      double minR = slow * MathMax(0.05, InpV52_MinAdaptiveVsSlow);
      double maxR = slow * MathMax(InpV52_MinAdaptiveVsSlow,
                                   InpV52_MaxAdaptiveVsSlow);

      base = MathMax(minR, MathMin(maxR, base));
   }

   g_adaptiveRange = base;
   return base;
}

//====================================================================
// FAST / INCREMENTAL VWAP
//====================================================================

bool V52RebuildVWAPCompletedCache()
{
   datetime currentOpen = iTime(_Symbol, InpV52_MapTF, 0);

   if(currentOpen <= 0)
      return false;

   datetime sessionStart = V52SessionStart(currentOpen);

   g_vwapSessionStart = sessionStart;
   g_vwapCompletedPV  = 0.0;
   g_vwapCompletedVol = 0.0;

   if(currentOpen <= sessionStart)
      return true;

   MqlRates bars[];

   int copied = CopyRates(_Symbol,
                          InpV52_MapTF,
                          sessionStart,
                          currentOpen - 1,
                          bars);

   if(copied <= 0)
      return true;

   for(int i = 0; i < copied; i++)
   {
      double vol = V52BarVolume(bars[i]);

      if(vol <= 0.0)
         continue;

      double hlc3 = (bars[i].high +
                      bars[i].low +
                      bars[i].close) / 3.0;

      g_vwapCompletedPV  += hlc3 * vol;
      g_vwapCompletedVol += vol;
   }

   return true;
}

bool V52UpdateLiveVWAP()
{
   MqlRates current;

   if(!V52GetBar(InpV52_MapTF, 0, current))
   {
      g_haveLiveVWAP = false;
      return false;
   }

   datetime requiredSession = V52SessionStart(current.time);

   if(g_vwapSessionStart != requiredSession)
   {
      if(!V52RebuildVWAPCompletedCache())
      {
         g_haveLiveVWAP = false;
         return false;
      }
   }

   double pv = g_vwapCompletedPV;
   double vv = g_vwapCompletedVol;

   double currentVol = V52BarVolume(current);

   if(currentVol > 0.0)
   {
      double hlc3 = (current.high + current.low + current.close) / 3.0;

      pv += hlc3 * currentVol;
      vv += currentVol;
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

bool V52GetEMA(int shift,
               double &ema)
{
   if(g_emaHandle == INVALID_HANDLE)
      return false;

   double values[1];

   if(CopyBuffer(g_emaHandle, 0, shift, 1, values) != 1)
      return false;

   if(values[0] == EMPTY_VALUE)
      return false;

   ema = values[0];
   return true;
}

//====================================================================
// POSITION
//====================================================================

bool V52FindPosition(ulong &ticket,
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

      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpV52_Magic)
         continue;

      ticket = t;
      type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      floatingProfit = PositionGetDouble(POSITION_PROFIT);

      return true;
   }

   return false;
}

bool V52HasPosition()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double profit;

   return V52FindPosition(ticket, type, openPrice, profit);
}

//====================================================================
// COMMISSION / COST ENGINE
//====================================================================

int V52FindCommissionGroup(V52CommissionGroup &groups[],
                           long positionId)
{
   for(int i = 0; i < ArraySize(groups); i++)
   {
      if(groups[i].positionId == positionId)
         return i;
   }

   return -1;
}

void V52RefreshCommissionEstimate()
{
   g_commissionPerLotRT = MathMax(0.0, InpV52_FallbackCommissionPerLotRT);

   if(!InpV52_AutoLearnCommission)
      return;

   datetime toTime = TimeCurrent();
   datetime fromTime = toTime - (datetime)MathMax(1, InpV52_CommissionHistoryDays) * 86400;

   if(!HistorySelect(fromTime, toTime))
      return;

   V52CommissionGroup groups[];
   int deals = HistoryDealsTotal();

   for(int i = 0; i < deals; i++)
   {
      ulong deal = HistoryDealGetTicket(i);

      if(deal == 0)
         continue;

      if(HistoryDealGetString(deal, DEAL_SYMBOL) != _Symbol)
         continue;

      long positionId = (long)HistoryDealGetInteger(deal, DEAL_POSITION_ID);

      if(positionId <= 0)
         continue;

      ENUM_DEAL_ENTRY entry =
         (ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal, DEAL_ENTRY);

      double volume = HistoryDealGetDouble(deal, DEAL_VOLUME);
      double commission = MathAbs(HistoryDealGetDouble(deal, DEAL_COMMISSION));
      double fee = MathAbs(HistoryDealGetDouble(deal, DEAL_FEE));

      int idx = V52FindCommissionGroup(groups, positionId);

      if(idx < 0)
      {
         int n = ArraySize(groups);
         ArrayResize(groups, n + 1);

         idx = n;
         groups[idx].positionId = positionId;
         groups[idx].cost = 0.0;
         groups[idx].entryVolume = 0.0;
         groups[idx].hasIn = false;
         groups[idx].hasOut = false;
      }

      groups[idx].cost += commission + fee;

      if(entry == DEAL_ENTRY_IN || entry == DEAL_ENTRY_INOUT)
      {
         groups[idx].hasIn = true;
         groups[idx].entryVolume += volume;
      }

      if(entry == DEAL_ENTRY_OUT ||
         entry == DEAL_ENTRY_OUT_BY ||
         entry == DEAL_ENTRY_INOUT)
      {
         groups[idx].hasOut = true;
      }
   }

   double totalCost = 0.0;
   double totalEntryVolume = 0.0;
   int completed = 0;

   for(int i = 0; i < ArraySize(groups); i++)
   {
      if(!groups[i].hasIn ||
         !groups[i].hasOut ||
         groups[i].entryVolume <= 0.0)
      {
         continue;
      }

      totalCost += groups[i].cost;
      totalEntryVolume += groups[i].entryVolume;
      completed++;
   }

   if(completed > 0 && totalEntryVolume > 0.0)
   {
      g_commissionPerLotRT = totalCost / totalEntryVolume;

      V52Log("Commission learned: " +
             DoubleToString(g_commissionPerLotRT, 4) +
             " account-currency / lot RT from " +
             IntegerToString(completed) +
             " completed positions");
   }
}

double V52TickValuePerLot()
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

double V52FrictionDistance(const MqlTick &tick,
                           double lots,
                           double &moneyCost)
{
   double spread = MathMax(0.0, tick.ask - tick.bid);
   double commissionDistance = 0.0;
   double spreadMoney = 0.0;
   double commissionMoney = MathMax(0.0, g_commissionPerLotRT) * lots;

   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = V52TickValuePerLot();

   if(tickSize > 0.0 && tickValue > 0.0)
   {
      double moneyPerPriceUnitPerLot = tickValue / tickSize;

      if(moneyPerPriceUnitPerLot > 0.0)
         commissionDistance = MathMax(0.0, g_commissionPerLotRT) /
                              moneyPerPriceUnitPerLot;

      spreadMoney = (spread / tickSize) * tickValue * lots;
   }

   double slippageDistance =
      MathMax(0, InpV52_ExpectedSlippagePoints) * _Point;

   double slippageMoney = 0.0;

   if(tickSize > 0.0 && tickValue > 0.0)
      slippageMoney = (slippageDistance / tickSize) * tickValue * lots;

   g_lastSpreadDistance = spread;
   g_lastCommissionDistance = commissionDistance;
   g_lastFrictionDistance = spread + commissionDistance + slippageDistance;
   g_lastEstimatedRTCostMoney = spreadMoney + commissionMoney + slippageMoney;

   moneyCost = g_lastEstimatedRTCostMoney;
   return g_lastFrictionDistance;
}

//====================================================================
// TRADE HELPERS
//====================================================================

bool V52TradeOK()
{
   uint rc = trade.ResultRetcode();

   return rc == TRADE_RETCODE_DONE ||
          rc == TRADE_RETCODE_DONE_PARTIAL ||
          rc == TRADE_RETCODE_PLACED;
}

void V52ResetSignalState()
{
   g_state = V52_IDLE;
   g_retestStart = 0;
   g_wrongSideSince = 0;
   g_retestExtreme = 0.0;
}

void V52ResetRunnerState()
{
   g_mfe = 0.0;
   g_emaWrongCloses = 0;
   g_emaDeepWarning = false;
   g_runnerHealth = "NEW POSITION - HOLD";
}

bool V52OpenBuy()
{
   if(V52HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double lots = V52NormalizeVolume(InpV52_Lots);
   double sl = 0.0;

   if(InpV52_EmergencySLPoints > 0)
   {
      sl = NormalizeDouble(tick.ask -
                           InpV52_EmergencySLPoints * _Point,
                           _Digits);
   }

   bool ok = trade.Buy(lots,
                       _Symbol,
                       0.0,
                       sl,
                       0.0,
                       "V52_HOLD_BUY");

   if(!ok || !V52TradeOK())
   {
      V52Log("BUY failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   V52ResetSignalState();
   V52ResetRunnerState();

   g_lastAction = "BUY OPENED - HOLD UNTIL FULL SELL SIGNAL";
   V52Log(g_lastAction);

   return true;
}

bool V52OpenSell()
{
   if(V52HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double lots = V52NormalizeVolume(InpV52_Lots);
   double sl = 0.0;

   if(InpV52_EmergencySLPoints > 0)
   {
      sl = NormalizeDouble(tick.bid +
                           InpV52_EmergencySLPoints * _Point,
                           _Digits);
   }

   bool ok = trade.Sell(lots,
                        _Symbol,
                        0.0,
                        sl,
                        0.0,
                        "V52_HOLD_SELL");

   if(!ok || !V52TradeOK())
   {
      V52Log("SELL failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   V52ResetSignalState();
   V52ResetRunnerState();

   g_lastAction = "SELL OPENED - HOLD UNTIL FULL BUY SIGNAL";
   V52Log(g_lastAction);

   return true;
}

bool V52CloseCurrent(ulong ticket,
                     string reason)
{
   bool ok = trade.PositionClose(ticket);

   if(!ok || !V52TradeOK())
   {
      V52Log("CLOSE failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   g_lastAction = "CLOSE FOR REVERSAL: " + reason;
   V52Log(g_lastAction);

   g_refreshCommissionNextM1 = true;
   return true;
}

bool V52ExecuteSignal(V52_SIGNAL signal)
{
   if(signal == V52_SIGNAL_NONE)
      return false;

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   bool havePosition =
      V52FindPosition(ticket, type, openPrice, floatingProfit);

   // Flat: normal entry.
   if(!havePosition)
   {
      if(signal == V52_SIGNAL_BUY)
         return V52OpenBuy();

      return V52OpenSell();
   }

   // Same-side signal: DO NOTHING. Keep holding the existing runner.
   if((type == POSITION_TYPE_BUY  && signal == V52_SIGNAL_BUY) ||
      (type == POSITION_TYPE_SELL && signal == V52_SIGNAL_SELL))
   {
      V52ResetSignalState();
      return false;
   }

   // Opposite FULL signal: this is the ONLY normal exit.
   string reason =
      (signal == V52_SIGNAL_BUY ?
       "FULL BUY VWAP SIGNAL" :
       "FULL SELL VWAP SIGNAL");

   if(!V52CloseCurrent(ticket, reason))
      return false;

   // Synchronous CTrade close is complete here. Reverse immediately.
   bool reversed = false;

   if(signal == V52_SIGNAL_BUY)
      reversed = V52OpenBuy();
   else
      reversed = V52OpenSell();

   if(reversed)
   {
      g_lastAction =
         (signal == V52_SIGNAL_BUY ?
          "REVERSED SELL -> BUY" :
          "REVERSED BUY -> SELL");

      V52Log(g_lastAction);
   }

   return reversed;
}

//====================================================================
// WHICH SIGNAL ARE WE ALLOWED TO SEARCH FOR?
//====================================================================

bool V52AllowBuyCandidate()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   if(!V52FindPosition(ticket, type, openPrice, floatingProfit))
      return true;

   // While SELL is open, only look for the BUY that will replace it.
   return type == POSITION_TYPE_SELL;
}

bool V52AllowSellCandidate()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   if(!V52FindPosition(ticket, type, openPrice, floatingProfit))
      return true;

   // While BUY is open, only look for the SELL that will replace it.
   return type == POSITION_TYPE_BUY;
}

//====================================================================
// LIVE SIGNAL ENGINE
//====================================================================

void V52ProcessSignal(const MqlTick &tick)
{
   if(!g_haveLiveVWAP)
      return;

   double price = tick.bid;
   double vwap  = g_liveVWAP;

   double adaptive = V52AdaptiveRange(tick.time_msc);

   if(adaptive <= 0.0)
      return;

   double naturalDeparture =
      adaptive * MathMax(0.0, InpV52_DepartureAdaptiveFrac);

   double band =
      adaptive * MathMax(0.0, InpV52_RetestBandAdaptiveFrac);

   double naturalReclaim =
      adaptive * MathMax(0.0, InpV52_ReclaimAdaptiveFrac);

   double wrongDepth =
      adaptive * MathMax(0.0, InpV52_VWAPWrongDepthAdaptiveFrac);

   double lots = V52NormalizeVolume(InpV52_Lots);
   double moneyCost = 0.0;
   double friction = V52FrictionDistance(tick, lots, moneyCost);

   double costFloor =
      friction * MathMax(1.0, InpV52_CostSafetyMultiple);

   double departure = MathMax(naturalDeparture, costFloor);
   double reclaim   = MathMax(naturalReclaim, costFloor);

   bool allowBuy  = V52AllowBuyCandidate();
   bool allowSell = V52AllowSellCandidate();

   // ---------------------------------------------------------------
   // IDLE: establish a meaningful side away from VWAP.
   // When a trade is already open, ONLY the opposite side can arm.
   // ---------------------------------------------------------------
   if(g_state == V52_IDLE)
   {
      if(allowBuy && price >= vwap + departure)
      {
         g_state = V52_BUY_DEPARTED;
         g_lastAction = "BUY side established; waiting VWAP return";
         V52Log(g_lastAction);
         return;
      }

      if(allowSell && price <= vwap - departure)
      {
         g_state = V52_SELL_DEPARTED;
         g_lastAction = "SELL side established; waiting VWAP return";
         V52Log(g_lastAction);
         return;
      }

      return;
   }

   // If position direction changed externally, discard a now-invalid candidate.
   if((g_state == V52_BUY_DEPARTED || g_state == V52_BUY_RETEST) && !allowBuy)
   {
      V52ResetSignalState();
      return;
   }

   if((g_state == V52_SELL_DEPARTED || g_state == V52_SELL_RETEST) && !allowSell)
   {
      V52ResetSignalState();
      return;
   }

   // ---------------------------------------------------------------
   // DEPARTURE -> RETEST
   // ---------------------------------------------------------------
   if(g_state == V52_BUY_DEPARTED)
   {
      if(price <= vwap + band)
      {
         g_state = V52_BUY_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;

         g_lastAction = "BUY VWAP RETEST ACTIVE";
         V52Log(g_lastAction);
      }

      return;
   }

   if(g_state == V52_SELL_DEPARTED)
   {
      if(price >= vwap - band)
      {
         g_state = V52_SELL_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;

         g_lastAction = "SELL VWAP RETEST ACTIVE";
         V52Log(g_lastAction);
      }

      return;
   }

   // ---------------------------------------------------------------
   // BUY RETEST
   // ---------------------------------------------------------------
   if(g_state == V52_BUY_RETEST)
   {
      g_retestExtreme = MathMin(g_retestExtreme, price);

      if(InpV52_RetestTimeoutMinutes > 0 &&
         g_retestStart > 0 &&
         TimeCurrent() - g_retestStart >
            InpV52_RetestTimeoutMinutes * 60)
      {
         V52ResetSignalState();
         g_lastAction = "BUY retest expired; existing position unchanged";
         return;
      }

      if(price < vwap - wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         int secondsWrong = (int)(TimeCurrent() - g_wrongSideSince);

         if(secondsWrong >= MathMax(1, InpV52_VWAPWrongSideSeconds))
         {
            V52ResetSignalState();
            g_lastAction = "BUY candidate failed; existing position unchanged";
            return;
         }
      }
      else if(price >= vwap)
      {
         g_wrongSideSince = 0;
      }

      bool reclaimedVWAP = price >= vwap + reclaim;
      bool bouncedFromLow = price >= g_retestExtreme + reclaim;

      if(reclaimedVWAP && bouncedFromLow)
      {
         V52ExecuteSignal(V52_SIGNAL_BUY);
      }

      return;
   }

   // ---------------------------------------------------------------
   // SELL RETEST
   // ---------------------------------------------------------------
   if(g_state == V52_SELL_RETEST)
   {
      g_retestExtreme = MathMax(g_retestExtreme, price);

      if(InpV52_RetestTimeoutMinutes > 0 &&
         g_retestStart > 0 &&
         TimeCurrent() - g_retestStart >
            InpV52_RetestTimeoutMinutes * 60)
      {
         V52ResetSignalState();
         g_lastAction = "SELL retest expired; existing position unchanged";
         return;
      }

      if(price > vwap + wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         int secondsWrong = (int)(TimeCurrent() - g_wrongSideSince);

         if(secondsWrong >= MathMax(1, InpV52_VWAPWrongSideSeconds))
         {
            V52ResetSignalState();
            g_lastAction = "SELL candidate failed; existing position unchanged";
            return;
         }
      }
      else if(price <= vwap)
      {
         g_wrongSideSince = 0;
      }

      bool reclaimedVWAP = price <= vwap - reclaim;
      bool droppedFromHigh = price <= g_retestExtreme - reclaim;

      if(reclaimedVWAP && droppedFromHigh)
      {
         V52ExecuteSignal(V52_SIGNAL_SELL);
      }

      return;
   }
}

//====================================================================
// RUNNER MANAGEMENT
//====================================================================

void V52UpdateRunnerMFE(const MqlTick &tick)
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   if(!V52FindPosition(ticket, type, openPrice, floatingProfit))
   {
      g_mfe = 0.0;
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
}

void V52ReviewEMAOnCompletedM5()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   if(!V52FindPosition(ticket, type, openPrice, floatingProfit))
   {
      g_emaWrongCloses = 0;
      g_emaDeepWarning = false;
      g_runnerHealth = "FLAT";
      return;
   }

   MqlRates bar;
   double ema = 0.0;

   if(!V52GetBar(InpV52_MapTF, 1, bar) ||
      !V52GetEMA(1, ema))
   {
      return;
   }

   bool wrong = false;
   double depth = 0.0;

   if(type == POSITION_TYPE_BUY)
   {
      wrong = bar.close < ema;

      if(wrong)
         depth = ema - bar.close;
   }
   else
   {
      wrong = bar.close > ema;

      if(wrong)
         depth = bar.close - ema;
   }

   if(!wrong)
   {
      g_emaWrongCloses = 0;
      g_emaDeepWarning = false;
      g_runnerHealth = "EMA8 RESPECTED - HOLD";
      return;
   }

   g_emaWrongCloses++;

   double depthFrac = 0.0;

   if(g_avgM5Range > 0.0)
      depthFrac = depth / g_avgM5Range;

   g_emaDeepWarning =
      depthFrac >= MathMax(0.0, InpV52_EMADeepWarningM5RangeFrac);

   // IMPORTANT: EMA loss is INFORMATION only in v5.20.
   // We keep the trade until a full opposite VWAP setup confirms.
   if(g_emaDeepWarning)
   {
      g_runnerHealth =
         "EMA8 DEEP LOSS WARNING - STILL HOLDING FOR OPPOSITE VWAP SIGNAL";
   }
   else
   {
      g_runnerHealth =
         "EMA8 BREATHING/WRONG SIDE - STILL HOLDING";
   }
}

//====================================================================
// NEW BAR EVENTS
//====================================================================

void V52ProcessNewM1()
{
   datetime current = iTime(_Symbol, InpV52_TriggerTF, 0);

   if(current <= 0 || current == g_lastM1Bar)
      return;

   g_lastM1Bar = current;
   V52RefreshM1RangeCache();

   if(g_refreshCommissionNextM1)
   {
      V52RefreshCommissionEstimate();
      g_refreshCommissionNextM1 = false;
   }
}

void V52ProcessNewM5()
{
   datetime current = iTime(_Symbol, InpV52_MapTF, 0);

   if(current <= 0 || current == g_lastM5Bar)
      return;

   g_lastM5Bar = current;

   V52RebuildVWAPCompletedCache();
   V52RefreshM5RangeCache();
   V52ReviewEMAOnCompletedM5();
}

//====================================================================
// PANEL
//====================================================================

string V52StateName()
{
   switch(g_state)
   {
      case V52_BUY_DEPARTED:  return "BUY DEPARTED";
      case V52_BUY_RETEST:    return "BUY RETEST";
      case V52_SELL_DEPARTED: return "SELL DEPARTED";
      case V52_SELL_RETEST:   return "SELL RETEST";
      default:                 return "IDLE";
   }
}

void V52Panel(const MqlTick &tick)
{
   ulong nowMs = GetTickCount64();

   if(g_lastPanelMs > 0 &&
      nowMs - g_lastPanelMs <
         (ulong)MathMax(50, InpV52_PanelUpdateMilliseconds))
   {
      return;
   }

   g_lastPanelMs = nowMs;

   double adaptive = V52AdaptiveRange(tick.time_msc);
   double lots = V52NormalizeVolume(InpV52_Lots);
   double moneyCost = 0.0;
   double friction = V52FrictionDistance(tick, lots, moneyCost);
   double costFloor = friction * MathMax(1.0, InpV52_CostSafetyMultiple);

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   string position = "NONE";

   if(V52FindPosition(ticket, type, openPrice, floatingProfit))
      position = (type == POSITION_TYPE_BUY ? "BUY - HOLDING" : "SELL - HOLDING");

   Comment(
      "VWAP + EMA8 BEHAVIOR v5.20\n",
      "MODE: HOLD UNTIL FULL OPPOSITE VWAP SIGNAL\n",
      "POSITION: ", position, "\n",
      "SIGNAL STATE: ", V52StateName(), "\n",
      "VWAP: ",
      (g_haveLiveVWAP ? DoubleToString(g_liveVWAP, _Digits) : "n/a"),
      "\nRUNNER HEALTH: ", g_runnerHealth,
      "\nEMA WRONG CLOSES: ", IntegerToString(g_emaWrongCloses),
      "\nMFE: ", DoubleToString(g_mfe, 2),
      "\nSLOW M1 RANGE: ", DoubleToString(g_slowM1Range, 2),
      "\nFAST M1 RANGE: ", DoubleToString(g_fastM1Range, 2),
      "\nLIVE ", IntegerToString(InpV52_LiveVolWindowSeconds),
      "s RANGE: ", DoubleToString(g_liveTickRange, 2),
      "\nADAPTIVE RANGE: ", DoubleToString(adaptive, 2),
      "\nEST RT COST: ", DoubleToString(moneyCost, 4),
      "\nCOST FLOOR: ", DoubleToString(costFloor, 2),
      "\nCOMMISSION / LOT RT: ", DoubleToString(g_commissionPerLotRT, 4),
      "\nLAST: ", g_lastAction
   );
}

//====================================================================
// INIT / DEINIT / TICK
//====================================================================

int OnInit()
{
   if(InpV52_MapTF != PERIOD_M5 ||
      InpV52_TriggerTF != PERIOD_M1)
   {
      Print("v5.20 requires M5 map + M1/live execution.");
      return INIT_PARAMETERS_INCORRECT;
   }

   if(InpV52_Lots <= 0.0 ||
      InpV52_EMAPeriod < 1 ||
      InpV52_SlowM1Lookback < 2 ||
      InpV52_FastM1Lookback < 2 ||
      InpV52_M5RangeLookback < 2 ||
      InpV52_LiveVolWindowSeconds < 1 ||
      InpV52_LiveVolMinTicks < 2 ||
      InpV52_FastM1Weight < 0.0 ||
      InpV52_FastM1Weight > 1.0 ||
      InpV52_MinAdaptiveVsSlow <= 0.0 ||
      InpV52_MaxAdaptiveVsSlow < InpV52_MinAdaptiveVsSlow ||
      InpV52_DepartureAdaptiveFrac < 0.0 ||
      InpV52_RetestBandAdaptiveFrac < 0.0 ||
      InpV52_ReclaimAdaptiveFrac < 0.0 ||
      InpV52_VWAPWrongDepthAdaptiveFrac < 0.0 ||
      InpV52_VWAPWrongSideSeconds < 1 ||
      InpV52_RetestTimeoutMinutes < 0 ||
      InpV52_FallbackCommissionPerLotRT < 0.0 ||
      InpV52_CommissionHistoryDays < 1 ||
      InpV52_CostSafetyMultiple < 1.0 ||
      InpV52_VWAPResetHour < 0 ||
      InpV52_VWAPResetHour > 23)
   {
      Print("v5.20 invalid inputs.");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_emaHandle = iMA(_Symbol,
                     InpV52_MapTF,
                     InpV52_EMAPeriod,
                     0,
                     MODE_EMA,
                     PRICE_CLOSE);

   if(g_emaHandle == INVALID_HANDLE)
   {
      Print("EMA8 handle failed. Error=", GetLastError());
      return INIT_FAILED;
   }

   trade.SetExpertMagicNumber(InpV52_Magic);
   trade.SetDeviationInPoints(InpV52_DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   g_state = V52_IDLE;
   g_lastM1Bar = 0;
   g_lastM5Bar = 0;

   V52RefreshM1RangeCache();
   V52RefreshM5RangeCache();
   V52RebuildVWAPCompletedCache();
   V52RefreshCommissionEstimate();

   MqlTick tick;

   if(SymbolInfoTick(_Symbol, tick))
   {
      V52RecordTick(tick);
      V52UpdateLiveVWAP();
      V52AdaptiveRange(tick.time_msc);
   }

   V52Log(
      "INIT v5.20 | HOLD THROUGH NOISE | no EMA/VWAP micro exits | "
      "reverse only on full opposite VWAP retest/reclaim"
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

   V52RecordTick(tick);

   // Heavy history work only on new bars.
   V52ProcessNewM1();
   V52ProcessNewM5();

   if(!V52UpdateLiveVWAP())
      return;

   // Keep measuring the existing mountain/valley while we hold it.
   V52UpdateRunnerMFE(tick);

   // Crucially, signal engine keeps running WHILE a position is open.
   // It searches only for the opposite full VWAP setup.
   V52ProcessSignal(tick);

   V52Panel(tick);
}
//+------------------------------------------------------------------+
