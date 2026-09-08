//+------------------------------------------------------------------+
//|        VWAP_EMA8_BehaviorRespect_V5_0.mq5                       |
//|                                                                  |
//| v5.10                                                            |
//|                                                                  |
//| STRATEGY IDENTITY                                                |
//| VWAP = DIRECTION + RETEST AREA                                   |
//| LIVE PRICE = RETEST / RECLAIM EXECUTION                          |
//| EMA8 M5 = RUNNER MANAGEMENT                                      |
//|                                                                  |
//| V25 EXECUTION UPGRADES                                           |
//| 1) VOLATILITY: slow M1 + fast M1 + live tick-window movement.   |
//| 2) SPEED: no 2x M5 entry gate; cached VWAP/ranges; live entry.   |
//| 3) COSTS: spread + learned/fallback commission economic floor.   |
//+------------------------------------------------------------------+
#property strict
#property version "5.10"

#include <Trade/Trade.mqh>
CTrade trade;

#define V51_TICK_BUFFER 4096

//====================================================================
// INPUTS
//====================================================================

//--- Trading
input double InpV51_Lots                         = 0.01;
input ulong  InpV51_Magic                        = 26090851;
input int    InpV51_DeviationPoints              = 30;
input int    InpV51_EmergencySLPoints            = 0;       // 0 = OFF

//--- Core strategy clocks
input ENUM_TIMEFRAMES InpV51_MapTF                = PERIOD_M5;
input ENUM_TIMEFRAMES InpV51_TriggerTF            = PERIOD_M1;
input int    InpV51_EMAPeriod                     = 8;

//--- VWAP
input int    InpV51_VWAPResetHour                 = 0;
input bool   InpV51_PreferRealVolume              = false;

//====================================================================
// 1) V25 VOLATILITY ENGINE
//====================================================================

// Slow environment
input int    InpV51_SlowM1Lookback                = 20;

// Faster environment response
input int    InpV51_FastM1Lookback                = 5;

// Live V25 movement window
input int    InpV51_LiveVolWindowSeconds          = 30;
input int    InpV51_LiveVolMinTicks               = 5;
input double InpV51_LiveVolWeight                  = 1.00;

// Blend completed M1 ranges. Live range can override upward immediately.
input double InpV51_FastM1Weight                   = 0.60;

// Sanity bounds versus slow M1 environment
input double InpV51_MinAdaptiveVsSlow              = 0.45;
input double InpV51_MaxAdaptiveVsSlow              = 3.00;

// M5 range is used only for EMA runner breathing / takeover
input int    InpV51_M5RangeLookback                = 12;

//====================================================================
// VWAP BEHAVIOR
//====================================================================

// A move away from VWAP itself establishes the side.
// No completed-M5 entry permission gate is used.
input double InpV51_DepartureAdaptiveFrac          = 0.60;

// Price entering this band starts a VWAP retest interaction.
input double InpV51_RetestBandAdaptiveFrac         = 0.25;

// Natural live reclaim distance before transaction-cost floor.
input double InpV51_ReclaimAdaptiveFrac            = 0.18;

// VWAP pierce is allowed. Failure requires DEPTH + TIME.
input double InpV51_VWAPWrongDepthAdaptiveFrac     = 0.18;
input int    InpV51_VWAPWrongSideSeconds           = 20;

// Stale interaction protection
input int    InpV51_RetestTimeoutMinutes           = 10;

//====================================================================
// EMA8 RUNNER MANAGEMENT
//====================================================================

// Once executable MFE reaches this fraction of normal M5 range,
// management responsibility transfers from VWAP to EMA8.
input double InpV51_EMATakeoverM5RangeFrac         = 0.70;

// One deep close through EMA8 exits immediately.
// Otherwise tolerate a shallow first close and require repeated loss.
input double InpV51_EMADeepBreakM5RangeFrac        = 0.35;
input int    InpV51_EMAWrongSideCloses             = 2;

input bool   InpV51_UseEarlyVWAPFailureExit        = true;

//====================================================================
// 3) TRANSACTION COST ENGINE
//====================================================================

// Fallback round-trip commission in ACCOUNT CURRENCY per 1.00 lot.
// 58.0 means 0.58 account-currency units at 0.01 lot.
// Auto-learning below replaces this once completed symbol trades exist.
input double InpV51_FallbackCommissionPerLotRT     = 58.0;
input bool   InpV51_AutoLearnCommission            = true;
input int    InpV51_CommissionHistoryDays          = 90;

// Entry reclaim/departure must be at least this multiple of
// live spread + round-trip commission price-equivalent.
input double InpV51_CostSafetyMultiple             = 1.25;

// Optional expected slippage cost, expressed as symbol points.
input int    InpV51_ExpectedSlippagePoints         = 0;

//====================================================================
// PERFORMANCE / DISPLAY
//====================================================================

input int    InpV51_PanelUpdateMilliseconds        = 500;
input bool   InpV51_VerboseLog                     = true;

//====================================================================
// STATE
//====================================================================

enum V51_SETUP_STATE
{
   V51_IDLE = 0,
   V51_BUY_DEPARTED,
   V51_BUY_RETEST,
   V51_SELL_DEPARTED,
   V51_SELL_RETEST
};

V51_SETUP_STATE g_state = V51_IDLE;

int g_emaHandle = INVALID_HANDLE;

// New-bar clocks
datetime g_lastM1Bar = 0;
datetime g_lastM5Bar = 0;

// Cached M1/M5 environment
double g_slowM1Range = 0.0;
double g_fastM1Range = 0.0;
double g_avgM5Range  = 0.0;
double g_currentM1Open = 0.0;

// Live tick-window buffer
long   g_tickTimeMsc[V51_TICK_BUFFER];
double g_tickBid[V51_TICK_BUFFER];
int    g_tickHead = 0;
int    g_tickStored = 0;

double g_liveTickRange = 0.0;
double g_adaptiveRange = 0.0;

// Incremental VWAP cache for COMPLETED M5 bars in current session
datetime g_vwapSessionStart = 0;
double   g_vwapCompletedPV   = 0.0;
double   g_vwapCompletedVol  = 0.0;
double   g_liveVWAP          = 0.0;
bool     g_haveLiveVWAP      = false;

// Retest state
datetime g_retestStart = 0;
datetime g_wrongSideSince = 0;
double   g_retestExtreme = 0.0;

// Position management
bool   g_emaTakeover = false;
int    g_emaWrongCount = 0;
double g_mfe = 0.0;

// Cost state
double g_commissionPerLotRT = 0.0;
double g_lastSpreadDistance = 0.0;
double g_lastCommissionDistance = 0.0;
double g_lastFrictionDistance = 0.0;
double g_lastEstimatedRoundTripCostMoney = 0.0;
bool   g_refreshCommissionNextM1 = false;

// Panel/log state
ulong  g_lastPanelMs = 0;
string g_lastAction = "Waiting";

//====================================================================
// COMMISSION GROUP FOR AUTO-LEARNING
//====================================================================

struct V51CommissionGroup
{
   long   positionId;
   double cost;
   double entryVolume;
   bool   hasIn;
   bool   hasOut;
};

//====================================================================
// LOG
//====================================================================

void V51Log(string text)
{
   if(InpV51_VerboseLog)
      Print("[BEHAVIOR V5.10] ", text);
}

//====================================================================
// GENERAL HELPERS
//====================================================================

datetime V51SessionStart(datetime when)
{
   MqlDateTime dt;
   TimeToStruct(when, dt);

   int originalHour = dt.hour;

   dt.hour = InpV51_VWAPResetHour;
   dt.min  = 0;
   dt.sec  = 0;

   datetime start = StructToTime(dt);

   if(originalHour < InpV51_VWAPResetHour)
      start -= 86400;

   return start;
}

bool V51GetBar(ENUM_TIMEFRAMES tf,
               int shift,
               MqlRates &bar)
{
   MqlRates rates[1];

   if(CopyRates(_Symbol, tf, shift, 1, rates) != 1)
      return false;

   bar = rates[0];
   return true;
}

double V51BarVolume(const MqlRates &bar)
{
   if(InpV51_PreferRealVolume && bar.real_volume > 0)
      return (double)bar.real_volume;

   return (double)bar.tick_volume;
}

bool V51AverageRange(ENUM_TIMEFRAMES tf,
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

   if(valid == 0)
      return false;

   result = sum / valid;
   return true;
}

double V51NormalizeVolume(double requested)
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
// 1) LIVE V25 VOLATILITY ENGINE
//====================================================================

void V51RecordTick(const MqlTick &tick)
{
   g_tickTimeMsc[g_tickHead] = tick.time_msc;
   g_tickBid[g_tickHead] = tick.bid;

   g_tickHead++;
   if(g_tickHead >= V51_TICK_BUFFER)
      g_tickHead = 0;

   if(g_tickStored < V51_TICK_BUFFER)
      g_tickStored++;
}

bool V51GetLiveTickRange(long nowMsc,
                         double &range,
                         int &samples)
{
   range = 0.0;
   samples = 0;

   if(g_tickStored <= 0)
      return false;

   long cutoff = (long)MathMax(1, InpV51_LiveVolWindowSeconds) * 1000;

   double hi = -DBL_MAX;
   double lo = DBL_MAX;

   for(int k = 0; k < g_tickStored; k++)
   {
      int idx = g_tickHead - 1 - k;

      while(idx < 0)
         idx += V51_TICK_BUFFER;

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

   if(samples < MathMax(2, InpV51_LiveVolMinTicks) ||
      hi == -DBL_MAX ||
      lo == DBL_MAX)
   {
      return false;
   }

   range = MathMax(0.0, hi - lo);
   return true;
}

void V51RefreshM1RangeCache()
{
   double slow = 0.0;
   double fast = 0.0;

   if(V51AverageRange(InpV51_TriggerTF,
                      1,
                      InpV51_SlowM1Lookback,
                      slow))
   {
      g_slowM1Range = slow;
   }

   if(V51AverageRange(InpV51_TriggerTF,
                      1,
                      InpV51_FastM1Lookback,
                      fast))
   {
      g_fastM1Range = fast;
   }

   g_currentM1Open = iOpen(_Symbol, InpV51_TriggerTF, 0);
}

void V51RefreshM5RangeCache()
{
   double r = 0.0;

   if(V51AverageRange(InpV51_MapTF,
                      1,
                      InpV51_M5RangeLookback,
                      r))
   {
      g_avgM5Range = r;
   }
}

double V51AdaptiveRange(long nowMsc)
{
   double slow = g_slowM1Range;
   double fast = g_fastM1Range;

   double base = 0.0;

   if(slow > 0.0 && fast > 0.0)
   {
      double wFast = MathMax(0.0, MathMin(1.0, InpV51_FastM1Weight));
      base = slow * (1.0 - wFast) + fast * wFast;
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

   if(V51GetLiveTickRange(nowMsc, liveRange, samples))
   {
      g_liveTickRange = liveRange;
      base = MathMax(base,
                     liveRange * MathMax(0.0, InpV51_LiveVolWeight));
   }
   else
   {
      g_liveTickRange = 0.0;
   }

   if(slow > 0.0)
   {
      double minR = slow * MathMax(0.05, InpV51_MinAdaptiveVsSlow);
      double maxR = slow * MathMax(InpV51_MinAdaptiveVsSlow,
                                   InpV51_MaxAdaptiveVsSlow);

      base = MathMax(minR, MathMin(maxR, base));
   }

   g_adaptiveRange = base;
   return base;
}

//====================================================================
// 2) FAST INCREMENTAL VWAP
//====================================================================

bool V51RebuildVWAPCompletedCache()
{
   datetime currentOpen = iTime(_Symbol, InpV51_MapTF, 0);

   if(currentOpen <= 0)
      return false;

   datetime sessionStart = V51SessionStart(currentOpen);

   g_vwapSessionStart = sessionStart;
   g_vwapCompletedPV = 0.0;
   g_vwapCompletedVol = 0.0;

   // At the first M5 bar of the session there are no completed bars yet.
   if(currentOpen <= sessionStart)
      return true;

   MqlRates bars[];

   int copied = CopyRates(_Symbol,
                          InpV51_MapTF,
                          sessionStart,
                          currentOpen - 1,
                          bars);

   if(copied <= 0)
      return true;

   for(int i = 0; i < copied; i++)
   {
      double vol = V51BarVolume(bars[i]);

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

bool V51UpdateLiveVWAP()
{
   MqlRates current;

   if(!V51GetBar(InpV51_MapTF, 0, current))
   {
      g_haveLiveVWAP = false;
      return false;
   }

   datetime requiredSession = V51SessionStart(current.time);

   if(g_vwapSessionStart != requiredSession)
   {
      if(!V51RebuildVWAPCompletedCache())
      {
         g_haveLiveVWAP = false;
         return false;
      }
   }

   double pv = g_vwapCompletedPV;
   double vv = g_vwapCompletedVol;

   double currentVol = V51BarVolume(current);

   if(currentVol > 0.0)
   {
      double currentHLC3 = (current.high +
                            current.low +
                            current.close) / 3.0;

      pv += currentHLC3 * currentVol;
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

bool V51GetEMA(int shift,
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
// POSITION HELPERS
//====================================================================

bool V51FindPosition(ulong &ticket,
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

      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpV51_Magic)
         continue;

      ticket = t;
      type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      floatingProfit = PositionGetDouble(POSITION_PROFIT);

      return true;
   }

   return false;
}

bool V51HasPosition()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double profit;

   return V51FindPosition(ticket, type, openPrice, profit);
}

//====================================================================
// 3) COMMISSION + SPREAD ENGINE
//====================================================================

int V51FindCommissionGroup(V51CommissionGroup &groups[],
                           long positionId)
{
   int n = ArraySize(groups);

   for(int i = 0; i < n; i++)
   {
      if(groups[i].positionId == positionId)
         return i;
   }

   return -1;
}

void V51RefreshCommissionEstimate()
{
   g_commissionPerLotRT = MathMax(0.0, InpV51_FallbackCommissionPerLotRT);

   if(!InpV51_AutoLearnCommission)
      return;

   datetime toTime = TimeCurrent();
   datetime fromTime = toTime - (datetime)MathMax(1, InpV51_CommissionHistoryDays) * 86400;

   if(!HistorySelect(fromTime, toTime))
      return;

   V51CommissionGroup groups[];

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

      int idx = V51FindCommissionGroup(groups, positionId);

      if(idx < 0)
      {
         int oldSize = ArraySize(groups);
         ArrayResize(groups, oldSize + 1);

         idx = oldSize;

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

   int groupsTotal = ArraySize(groups);

   for(int i = 0; i < groupsTotal; i++)
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
      // Money cost per 1.00 lot for a completed round trip.
      g_commissionPerLotRT = totalCost / totalEntryVolume;

      V51Log("Commission learned from " +
             IntegerToString(completed) +
             " completed " + _Symbol +
             " positions: " +
             DoubleToString(g_commissionPerLotRT, 4) +
             " account-currency / lot RT");
   }
}

double V51TickValuePerLot()
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

double V51FrictionDistance(const MqlTick &tick,
                           double lots,
                           double &moneyCost)
{
   double spread = MathMax(0.0, tick.ask - tick.bid);
   double commissionDistance = 0.0;
   double spreadMoney = 0.0;
   double commissionMoney = MathMax(0.0, g_commissionPerLotRT) * lots;

   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = V51TickValuePerLot();

   if(tickSize > 0.0 && tickValue > 0.0)
   {
      double moneyPerPriceUnitPerLot = tickValue / tickSize;

      if(moneyPerPriceUnitPerLot > 0.0)
      {
         commissionDistance =
            MathMax(0.0, g_commissionPerLotRT) /
            moneyPerPriceUnitPerLot;

         spreadMoney =
            (spread / tickSize) * tickValue * lots;
      }
   }

   double slippageDistance =
      MathMax(0, InpV51_ExpectedSlippagePoints) * _Point;

   double slippageMoney = 0.0;

   if(tickSize > 0.0 && tickValue > 0.0)
   {
      slippageMoney =
         (slippageDistance / tickSize) * tickValue * lots;
   }

   g_lastSpreadDistance = spread;
   g_lastCommissionDistance = commissionDistance;
   g_lastFrictionDistance = spread + commissionDistance + slippageDistance;

   moneyCost = spreadMoney + commissionMoney + slippageMoney;
   g_lastEstimatedRoundTripCostMoney = moneyCost;

   return g_lastFrictionDistance;
}

//====================================================================
// TRADE RESULT
//====================================================================

bool V51TradeOK()
{
   uint rc = trade.ResultRetcode();

   return rc == TRADE_RETCODE_DONE ||
          rc == TRADE_RETCODE_DONE_PARTIAL ||
          rc == TRADE_RETCODE_PLACED;
}

//====================================================================
// ORDER FUNCTIONS
//====================================================================

bool V51OpenBuy(double effectiveReclaim,
                double adaptiveRange,
                double friction)
{
   if(V51HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double lots = V51NormalizeVolume(InpV51_Lots);

   double sl = 0.0;

   if(InpV51_EmergencySLPoints > 0)
   {
      sl = NormalizeDouble(tick.ask -
                           InpV51_EmergencySLPoints * _Point,
                           _Digits);
   }

   bool ok = trade.Buy(lots,
                       _Symbol,
                       0.0,
                       sl,
                       0.0,
                       "V51_VWAP_RECLAIM_BUY");

   if(!ok || !V51TradeOK())
   {
      V51Log("BUY failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   g_state = V51_IDLE;
   g_retestStart = 0;
   g_wrongSideSince = 0;
   g_emaTakeover = false;
   g_emaWrongCount = 0;
   g_mfe = 0.0;

   g_lastAction =
      "BUY LIVE RECLAIM | vol=" +
      DoubleToString(adaptiveRange, 2) +
      " reclaim=" +
      DoubleToString(effectiveReclaim, 2) +
      " friction=" +
      DoubleToString(friction, 2);

   V51Log(g_lastAction);
   return true;
}

bool V51OpenSell(double effectiveReclaim,
                 double adaptiveRange,
                 double friction)
{
   if(V51HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   double lots = V51NormalizeVolume(InpV51_Lots);

   double sl = 0.0;

   if(InpV51_EmergencySLPoints > 0)
   {
      sl = NormalizeDouble(tick.bid +
                           InpV51_EmergencySLPoints * _Point,
                           _Digits);
   }

   bool ok = trade.Sell(lots,
                        _Symbol,
                        0.0,
                        sl,
                        0.0,
                        "V51_VWAP_RECLAIM_SELL");

   if(!ok || !V51TradeOK())
   {
      V51Log("SELL failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   g_state = V51_IDLE;
   g_retestStart = 0;
   g_wrongSideSince = 0;
   g_emaTakeover = false;
   g_emaWrongCount = 0;
   g_mfe = 0.0;

   g_lastAction =
      "SELL LIVE RECLAIM | vol=" +
      DoubleToString(adaptiveRange, 2) +
      " reclaim=" +
      DoubleToString(effectiveReclaim, 2) +
      " friction=" +
      DoubleToString(friction, 2);

   V51Log(g_lastAction);
   return true;
}

bool V51ClosePosition(ulong ticket,
                      string reason)
{
   bool ok = trade.PositionClose(ticket);

   if(!ok || !V51TradeOK())
   {
      V51Log("EXIT failed: " + trade.ResultRetcodeDescription());
      return false;
   }

   g_lastAction = "EXIT: " + reason;
   V51Log(g_lastAction);

   g_state = V51_IDLE;
   g_retestStart = 0;
   g_wrongSideSince = 0;
   g_emaTakeover = false;
   g_emaWrongCount = 0;
   g_mfe = 0.0;

   // Refresh commission once history has had a chance to register the close.
   g_refreshCommissionNextM1 = true;

   return true;
}

//====================================================================
// LIVE VWAP ENTRY ENGINE
//====================================================================

void V51ProcessEntry(const MqlTick &tick)
{
   if(V51HasPosition() || !g_haveLiveVWAP)
      return;

   // MT5 chart bars are Bid-based, so use Bid for VWAP behavior.
   // Orders still execute at Ask for buys and Bid for sells.
   double price = tick.bid;
   double vwap = g_liveVWAP;

   double adaptive = V51AdaptiveRange(tick.time_msc);

   if(adaptive <= 0.0)
      return;

   double naturalDeparture =
      adaptive * MathMax(0.0, InpV51_DepartureAdaptiveFrac);

   double band =
      adaptive * MathMax(0.0, InpV51_RetestBandAdaptiveFrac);

   double naturalReclaim =
      adaptive * MathMax(0.0, InpV51_ReclaimAdaptiveFrac);

   double wrongDepth =
      adaptive * MathMax(0.0, InpV51_VWAPWrongDepthAdaptiveFrac);

   double moneyCost = 0.0;
   double lots = V51NormalizeVolume(InpV51_Lots);
   double friction = V51FrictionDistance(tick, lots, moneyCost);

   double costFloor =
      friction * MathMax(1.0, InpV51_CostSafetyMultiple);

   // Transaction cost is execution reality, not a new strategy filter.
   // We simply refuse to define a meaningful departure/reclaim smaller
   // than the amount the trade must pay to exist.
   double departure = MathMax(naturalDeparture, costFloor);
   double reclaim   = MathMax(naturalReclaim, costFloor);

   // ---------------------------------------------------------------
   // IDLE
   // No 1x/2x completed-M5 permission gate.
   // Moving a meaningful distance to one side of VWAP ESTABLISHES it.
   // ---------------------------------------------------------------
   if(g_state == V51_IDLE)
   {
      if(price >= vwap + departure)
      {
         g_state = V51_BUY_DEPARTED;
         g_lastAction = "BUY side established live; waiting VWAP return";
         V51Log(g_lastAction);
         return;
      }

      if(price <= vwap - departure)
      {
         g_state = V51_SELL_DEPARTED;
         g_lastAction = "SELL side established live; waiting VWAP return";
         V51Log(g_lastAction);
         return;
      }

      return;
   }

   // ---------------------------------------------------------------
   // DEPARTURE -> RETURN
   // ---------------------------------------------------------------
   if(g_state == V51_BUY_DEPARTED)
   {
      if(price <= vwap + band)
      {
         g_state = V51_BUY_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;

         g_lastAction = "BUY VWAP RETEST LIVE";
         V51Log(g_lastAction);
      }

      return;
   }

   if(g_state == V51_SELL_DEPARTED)
   {
      if(price >= vwap - band)
      {
         g_state = V51_SELL_RETEST;
         g_retestStart = TimeCurrent();
         g_retestExtreme = price;
         g_wrongSideSince = 0;

         g_lastAction = "SELL VWAP RETEST LIVE";
         V51Log(g_lastAction);
      }

      return;
   }

   // ---------------------------------------------------------------
   // BUY RETEST
   // ---------------------------------------------------------------
   if(g_state == V51_BUY_RETEST)
   {
      g_retestExtreme = MathMin(g_retestExtreme, price);

      if(InpV51_RetestTimeoutMinutes > 0 &&
         g_retestStart > 0 &&
         TimeCurrent() - g_retestStart >
            InpV51_RetestTimeoutMinutes * 60)
      {
         g_state = V51_IDLE;
         g_wrongSideSince = 0;
         g_lastAction = "BUY retest expired";
         V51Log(g_lastAction);
         return;
      }

      // V25 can pierce VWAP violently.
      // Failure = meaningful depth AND remaining there.
      if(price < vwap - wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         int secondsWrong = (int)(TimeCurrent() - g_wrongSideSince);

         if(secondsWrong >= MathMax(1, InpV51_VWAPWrongSideSeconds))
         {
            g_state = V51_IDLE;
            g_wrongSideSince = 0;
            g_lastAction = "BUY retest failed: VWAP accepted below";
            V51Log(g_lastAction);
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
         V51OpenBuy(reclaim, adaptive, friction);
      }

      return;
   }

   // ---------------------------------------------------------------
   // SELL RETEST
   // ---------------------------------------------------------------
   if(g_state == V51_SELL_RETEST)
   {
      g_retestExtreme = MathMax(g_retestExtreme, price);

      if(InpV51_RetestTimeoutMinutes > 0 &&
         g_retestStart > 0 &&
         TimeCurrent() - g_retestStart >
            InpV51_RetestTimeoutMinutes * 60)
      {
         g_state = V51_IDLE;
         g_wrongSideSince = 0;
         g_lastAction = "SELL retest expired";
         V51Log(g_lastAction);
         return;
      }

      if(price > vwap + wrongDepth)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         int secondsWrong = (int)(TimeCurrent() - g_wrongSideSince);

         if(secondsWrong >= MathMax(1, InpV51_VWAPWrongSideSeconds))
         {
            g_state = V51_IDLE;
            g_wrongSideSince = 0;
            g_lastAction = "SELL retest failed: VWAP accepted above";
            V51Log(g_lastAction);
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
         V51OpenSell(reclaim, adaptive, friction);
      }

      return;
   }
}

//====================================================================
// LIVE POSITION MANAGEMENT
//====================================================================

void V51ProcessLivePosition(const MqlTick &tick)
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   if(!V51FindPosition(ticket, type, openPrice, floatingProfit))
      return;

   if(!g_haveLiveVWAP)
      return;

   double executableExitPrice =
      (type == POSITION_TYPE_BUY ? tick.bid : tick.ask);

   double favorable =
      (type == POSITION_TYPE_BUY ?
       executableExitPrice - openPrice :
       openPrice - executableExitPrice);

   if(favorable > g_mfe)
      g_mfe = favorable;

   // ---------------------------------------------------------------
   // EMA TAKEOVER
   // ---------------------------------------------------------------
   if(!g_emaTakeover &&
      g_avgM5Range > 0.0 &&
      g_mfe >= g_avgM5Range *
               MathMax(0.0, InpV51_EMATakeoverM5RangeFrac))
   {
      g_emaTakeover = true;
      g_wrongSideSince = 0;

      g_lastAction = "EMA8 TAKEOVER - RUNNER MODE";
      V51Log(g_lastAction);
   }

   // ---------------------------------------------------------------
   // EARLY VWAP FAILURE BEFORE EMA TAKES OVER
   // ---------------------------------------------------------------
   if(InpV51_UseEarlyVWAPFailureExit &&
      !g_emaTakeover)
   {
      double adaptive = V51AdaptiveRange(tick.time_msc);

      if(adaptive <= 0.0)
         return;

      double wrongDepth =
         adaptive * MathMax(0.0, InpV51_VWAPWrongDepthAdaptiveFrac);

      // Chart/VWAP relationship uses Bid price.
      double chartPrice = tick.bid;

      bool wrong =
         (type == POSITION_TYPE_BUY ?
          chartPrice < g_liveVWAP - wrongDepth :
          chartPrice > g_liveVWAP + wrongDepth);

      if(wrong)
      {
         if(g_wrongSideSince == 0)
            g_wrongSideSince = TimeCurrent();

         int secondsWrong = (int)(TimeCurrent() - g_wrongSideSince);

         if(secondsWrong >= MathMax(1, InpV51_VWAPWrongSideSeconds))
         {
            V51ClosePosition(
               ticket,
               type == POSITION_TYPE_BUY ?
               "VWAP accepted below before EMA takeover" :
               "VWAP accepted above before EMA takeover"
            );
            return;
         }
      }
      else
      {
         g_wrongSideSince = 0;
      }
   }
}

//====================================================================
// EMA8 MANAGEMENT ON COMPLETED M5 BAR
//====================================================================

void V51ManageEMAOnCompletedM5()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   if(!V51FindPosition(ticket, type, openPrice, floatingProfit))
      return;

   if(!g_emaTakeover || g_avgM5Range <= 0.0)
      return;

   MqlRates bar;
   double ema = 0.0;

   if(!V51GetBar(InpV51_MapTF, 1, bar) ||
      !V51GetEMA(1, ema))
   {
      return;
   }

   bool wrongSide = false;
   double depth = 0.0;

   if(type == POSITION_TYPE_BUY)
   {
      wrongSide = bar.close < ema;

      if(wrongSide)
         depth = ema - bar.close;
   }
   else
   {
      wrongSide = bar.close > ema;

      if(wrongSide)
         depth = bar.close - ema;
   }

   if(!wrongSide)
   {
      if(g_emaWrongCount > 0)
         V51Log("EMA8 reclaimed - normal breathing, HOLD");

      g_emaWrongCount = 0;
      g_lastAction = "EMA8 respected - HOLD";
      return;
   }

   double depthFrac = depth / g_avgM5Range;

   if(depthFrac >= MathMax(0.0, InpV51_EMADeepBreakM5RangeFrac))
   {
      V51ClosePosition(
         ticket,
         "EMA8 REAL LOSS: deep close " +
         DoubleToString(depthFrac, 2) +
         "x M5 range"
      );
      return;
   }

   g_emaWrongCount++;

   if(g_emaWrongCount >= MathMax(1, InpV51_EMAWrongSideCloses))
   {
      V51ClosePosition(
         ticket,
         "EMA8 REAL LOSS: " +
         IntegerToString(g_emaWrongCount) +
         " consecutive shallow closes"
      );
      return;
   }

   g_lastAction =
      "EMA8 breathing - HOLD " +
      IntegerToString(g_emaWrongCount) +
      "/" +
      IntegerToString(MathMax(1, InpV51_EMAWrongSideCloses));

   V51Log(g_lastAction);
}

//====================================================================
// NEW BAR EVENTS
//====================================================================

void V51ProcessNewM1()
{
   datetime current = iTime(_Symbol, InpV51_TriggerTF, 0);

   if(current <= 0 || current == g_lastM1Bar)
      return;

   g_lastM1Bar = current;

   V51RefreshM1RangeCache();

   if(g_refreshCommissionNextM1)
   {
      V51RefreshCommissionEstimate();
      g_refreshCommissionNextM1 = false;
   }
}

void V51ProcessNewM5()
{
   datetime current = iTime(_Symbol, InpV51_MapTF, 0);

   if(current <= 0 || current == g_lastM5Bar)
      return;

   g_lastM5Bar = current;

   // Heavy work happens once per M5 bar, not every tick.
   V51RebuildVWAPCompletedCache();
   V51RefreshM5RangeCache();

   // Manage the runner using the M5 bar that just completed.
   V51ManageEMAOnCompletedM5();
}

//====================================================================
// PANEL
//====================================================================

string V51StateName()
{
   switch(g_state)
   {
      case V51_BUY_DEPARTED:  return "BUY DEPARTED";
      case V51_BUY_RETEST:    return "BUY RETEST";
      case V51_SELL_DEPARTED: return "SELL DEPARTED";
      case V51_SELL_RETEST:   return "SELL RETEST";
      default:                 return "IDLE";
   }
}

void V51Panel(const MqlTick &tick)
{
   ulong nowMs = GetTickCount64();

   if(g_lastPanelMs > 0 &&
      nowMs - g_lastPanelMs < (ulong)MathMax(50, InpV51_PanelUpdateMilliseconds))
   {
      return;
   }

   g_lastPanelMs = nowMs;

   double ema = 0.0;
   bool haveEMA = V51GetEMA(0, ema);

   double adaptive = V51AdaptiveRange(tick.time_msc);

   double lots = V51NormalizeVolume(InpV51_Lots);
   double moneyCost = 0.0;
   double friction = V51FrictionDistance(tick, lots, moneyCost);
   double costFloor = friction * MathMax(1.0, InpV51_CostSafetyMultiple);

   double naturalReclaim =
      adaptive * MathMax(0.0, InpV51_ReclaimAdaptiveFrac);

   double effectiveReclaim = MathMax(naturalReclaim, costFloor);

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   double floatingProfit;

   string position = "NONE";

   if(V51FindPosition(ticket, type, openPrice, floatingProfit))
      position = (type == POSITION_TYPE_BUY ? "BUY" : "SELL");

   int wrongSeconds = 0;

   if(g_wrongSideSince > 0)
      wrongSeconds = (int)(TimeCurrent() - g_wrongSideSince);

   Comment(
      "VWAP + EMA8 BEHAVIOR v5.10\n",
      "STATE: ", V51StateName(), "\n",
      "VWAP: ",
      (g_haveLiveVWAP ? DoubleToString(g_liveVWAP, _Digits) : "n/a"),
      "\nEMA8 M5: ",
      (haveEMA ? DoubleToString(ema, _Digits) : "n/a"),
      "\nSLOW M1 RANGE: ", DoubleToString(g_slowM1Range, 2),
      "\nFAST M1 RANGE: ", DoubleToString(g_fastM1Range, 2),
      "\nLIVE ", IntegerToString(InpV51_LiveVolWindowSeconds),
      "s RANGE: ", DoubleToString(g_liveTickRange, 2),
      "\nADAPTIVE RANGE: ", DoubleToString(adaptive, 2),
      "\nSPREAD DIST: ", DoubleToString(g_lastSpreadDistance, 2),
      "\nCOMMISSION / LOT RT: ", DoubleToString(g_commissionPerLotRT, 4),
      "\nCOMMISSION DIST: ", DoubleToString(g_lastCommissionDistance, 2),
      "\nEST RT COST MONEY: ", DoubleToString(moneyCost, 4),
      "\nCOST FLOOR: ", DoubleToString(costFloor, 2),
      "\nEFFECTIVE RECLAIM: ", DoubleToString(effectiveReclaim, 2),
      "\nPOSITION: ", position,
      "\nEMA TAKEOVER: ", (g_emaTakeover ? "YES - RUNNER" : "NO - VWAP THESIS"),
      "\nEMA WRONG CLOSES: ", IntegerToString(g_emaWrongCount),
      "\nVWAP WRONG SEC: ", IntegerToString(wrongSeconds),
      "\nMFE EXECUTABLE: ", DoubleToString(g_mfe, 2),
      "\nLAST: ", g_lastAction
   );
}

//====================================================================
// INIT / DEINIT / TICK
//====================================================================

int OnInit()
{
   if(InpV51_MapTF != PERIOD_M5)
   {
      Print("v5.10 requires M5 map timeframe.");
      return INIT_PARAMETERS_INCORRECT;
   }

   if(InpV51_TriggerTF != PERIOD_M1)
   {
      Print("v5.10 requires M1 trigger/range timeframe.");
      return INIT_PARAMETERS_INCORRECT;
   }

   if(InpV51_Lots <= 0.0 ||
      InpV51_EMAPeriod < 1 ||
      InpV51_SlowM1Lookback < 2 ||
      InpV51_FastM1Lookback < 2 ||
      InpV51_M5RangeLookback < 2 ||
      InpV51_LiveVolWindowSeconds < 1 ||
      InpV51_LiveVolMinTicks < 2 ||
      InpV51_FastM1Weight < 0.0 ||
      InpV51_FastM1Weight > 1.0 ||
      InpV51_MinAdaptiveVsSlow <= 0.0 ||
      InpV51_MaxAdaptiveVsSlow < InpV51_MinAdaptiveVsSlow ||
      InpV51_DepartureAdaptiveFrac < 0.0 ||
      InpV51_RetestBandAdaptiveFrac < 0.0 ||
      InpV51_ReclaimAdaptiveFrac < 0.0 ||
      InpV51_VWAPWrongDepthAdaptiveFrac < 0.0 ||
      InpV51_VWAPWrongSideSeconds < 1 ||
      InpV51_RetestTimeoutMinutes < 0 ||
      InpV51_EMATakeoverM5RangeFrac < 0.0 ||
      InpV51_EMADeepBreakM5RangeFrac < 0.0 ||
      InpV51_EMAWrongSideCloses < 1 ||
      InpV51_FallbackCommissionPerLotRT < 0.0 ||
      InpV51_CommissionHistoryDays < 1 ||
      InpV51_CostSafetyMultiple < 1.0 ||
      InpV51_VWAPResetHour < 0 ||
      InpV51_VWAPResetHour > 23)
   {
      Print("v5.10 invalid input parameters.");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_emaHandle = iMA(_Symbol,
                     InpV51_MapTF,
                     InpV51_EMAPeriod,
                     0,
                     MODE_EMA,
                     PRICE_CLOSE);

   if(g_emaHandle == INVALID_HANDLE)
   {
      Print("EMA8 handle failed. Error=", GetLastError());
      return INIT_FAILED;
   }

   trade.SetExpertMagicNumber(InpV51_Magic);
   trade.SetDeviationInPoints(InpV51_DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   g_lastM1Bar = 0;
   g_lastM5Bar = 0;
   g_state = V51_IDLE;

   V51RefreshM1RangeCache();
   V51RefreshM5RangeCache();
   V51RebuildVWAPCompletedCache();
   V51RefreshCommissionEstimate();

   MqlTick tick;
   if(SymbolInfoTick(_Symbol, tick))
   {
      V51RecordTick(tick);
      V51UpdateLiveVWAP();
      V51AdaptiveRange(tick.time_msc);
   }

   V51Log(
      "INIT v5.10 | FAST live VWAP reclaim | adaptive V25 volatility | "
      "spread+commission economic floor | EMA8 runner"
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

   // Ultra-light work first: record the live V25 tick.
   V51RecordTick(tick);

   // Cached range/VWAP rebuilds only when a new bar begins.
   V51ProcessNewM1();
   V51ProcessNewM5();

   // Current-session VWAP only adds the live M5 bar to cached sums.
   if(!V51UpdateLiveVWAP())
      return;

   // Existing trade gets priority over a new entry.
   V51ProcessLivePosition(tick);

   if(!V51HasPosition())
      V51ProcessEntry(tick);

   // UI refresh is throttled so it does not slow a 1-second market.
   V51Panel(tick);
}
//+------------------------------------------------------------------+
