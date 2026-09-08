//+------------------------------------------------------------------+
//|        VWAP_EMA8_BehaviorRespect_V5_0.mq5                       |
//|                                                                  |
//| M5 = MAP                                                         |
//| VWAP = DIRECTION + RETEST AREA                                   |
//| LIVE PRICE / M1 = RECLAIM ENTRY                                  |
//| EMA8 M5 = RUNNER MANAGEMENT                                      |
//+------------------------------------------------------------------+
#property strict
#property version "5.00"

#include <Trade/Trade.mqh>
CTrade trade;

//====================================================================
// INPUTS
//====================================================================

input double InpV5_Lots                      = 0.01;
input ulong  InpV5_Magic                     = 26090850;
input int    InpV5_DeviationPoints           = 30;
input int    InpV5_EmergencySLPoints         = 0;

input ENUM_TIMEFRAMES InpV5_MapTF            = PERIOD_M5;
input ENUM_TIMEFRAMES InpV5_TriggerTF        = PERIOD_M1;

input int    InpV5_EMAPeriod                 = 8;

// VWAP
input int    InpV5_VWAPResetHour             = 0;
input bool   InpV5_PreferRealVolume          = false;

// Need price to actually live on one side first.
// This is NOT a trend score.
input int    InpV5_EstablishCloses           = 2;

// Normalise V25 movement using recent raw candle range.
// This is NOT ATR.
input int    InpV5_M1RangeLookback           = 20;
input int    InpV5_M5RangeLookback           = 12;

// Price must first leave VWAP before we call a return a retest.
input double InpV5_DepartureM1RangeFrac      = 0.60;

// How close price can come before VWAP interaction starts.
input double InpV5_RetestBandM1RangeFrac     = 0.25;

// How much live price must recover away from VWAP to trigger.
input double InpV5_ReclaimM1RangeFrac        = 0.18;

input bool   InpV5_RequireTriggerDirection   = true;

// VWAP failure = DEPTH + TIME.
// A quick wick through VWAP is allowed.
input double InpV5_VWAPWrongDepthM1Frac      = 0.18;
input int    InpV5_VWAPWrongSideSeconds      = 45;

// Stale VWAP interaction timeout.
input int    InpV5_RetestTimeoutMinutes      = 12;

// Once trade develops this far, EMA8 becomes primary manager.
input double InpV5_EMATakeoverM5RangeFrac    = 0.70;

// EMA loss:
// shallow first close through EMA is tolerated.
// deep break OR repeated closes = exit.
input double InpV5_EMADeepBreakM5RangeFrac   = 0.35;
input int    InpV5_EMAWrongSideCloses        = 2;

input bool   InpV5_UseEarlyVWAPFailureExit   = true;

input bool   InpV5_VerboseLog                = true;

//====================================================================
// STATE
//====================================================================

enum SETUP_STATE
{
   STATE_IDLE = 0,
   STATE_BUY_DEPARTED,
   STATE_BUY_RETEST,
   STATE_SELL_DEPARTED,
   STATE_SELL_RETEST
};

SETUP_STATE g_state = STATE_IDLE;

int g_emaHandle = INVALID_HANDLE;

datetime g_lastM5Bar = 0;

bool g_buyEstablished  = false;
bool g_sellEstablished = false;

datetime g_retestStart     = 0;
datetime g_wrongSideSince  = 0;

double g_retestExtreme = 0.0;

bool   g_emaTakeover       = false;
int    g_emaWrongCount     = 0;
double g_mfe               = 0.0;

string g_lastAction = "Waiting";

//====================================================================
// LOG
//====================================================================

void Log(string text)
{
   if(InpV5_VerboseLog)
      Print("[BEHAVIOR V5] ", text);
}

//====================================================================
// SESSION
//====================================================================

datetime SessionStart(datetime when)
{
   MqlDateTime dt;
   TimeToStruct(when, dt);

   int originalHour = dt.hour;

   dt.hour = InpV5_VWAPResetHour;
   dt.min  = 0;
   dt.sec  = 0;

   datetime start = StructToTime(dt);

   if(originalHour < InpV5_VWAPResetHour)
      start -= 86400;

   return start;
}

//====================================================================
// BAR
//====================================================================

bool GetBar(ENUM_TIMEFRAMES tf,
            int shift,
            MqlRates &bar)
{
   MqlRates r[1];

   if(CopyRates(_Symbol, tf, shift, 1, r) != 1)
      return false;

   bar = r[0];
   return true;
}

//====================================================================
// RANGE
//====================================================================

bool AverageRange(ENUM_TIMEFRAMES tf,
                  int startShift,
                  int count,
                  double &result)
{
   MqlRates r[];

   if(CopyRates(_Symbol,
                tf,
                startShift,
                count,
                r) != count)
      return false;

   double sum = 0.0;
   int valid = 0;

   for(int i = 0; i < count; i++)
   {
      double range = r[i].high - r[i].low;

      if(range > 0)
      {
         sum += range;
         valid++;
      }
   }

   if(valid == 0)
      return false;

   result = sum / valid;

   return true;
}

//====================================================================
// VWAP
//====================================================================

double BarVolume(const MqlRates &bar)
{
   if(InpV5_PreferRealVolume &&
      bar.real_volume > 0)
   {
      return (double)bar.real_volume;
   }

   return (double)bar.tick_volume;
}

bool GetVWAP(int shift,
             double &vwap)
{
   datetime target =
      iTime(_Symbol,
            InpV5_MapTF,
            shift);

   if(target <= 0)
      return false;

   datetime start =
      SessionStart(target);

   MqlRates bars[];

   int copied =
      CopyRates(_Symbol,
                InpV5_MapTF,
                start,
                target,
                bars);

   if(copied <= 0)
      return false;

   double pv = 0.0;
   double volume = 0.0;

   for(int i = 0; i < copied; i++)
   {
      double vol =
         BarVolume(bars[i]);

      if(vol <= 0)
         continue;

      double hlc3 =
         (
            bars[i].high +
            bars[i].low +
            bars[i].close
         ) / 3.0;

      pv += hlc3 * vol;
      volume += vol;
   }

   if(volume <= 0)
      return false;

   vwap = pv / volume;

   return true;
}

//====================================================================
// EMA
//====================================================================

bool GetEMA(int shift,
            double &ema)
{
   double b[1];

   if(CopyBuffer(g_emaHandle,
                 0,
                 shift,
                 1,
                 b) != 1)
   {
      return false;
   }

   ema = b[0];

   return ema != EMPTY_VALUE;
}

//====================================================================
// POSITION
//====================================================================

bool FindPosition(ulong &ticket,
                  ENUM_POSITION_TYPE &type,
                  double &openPrice)
{
   for(int i = PositionsTotal() - 1;
       i >= 0;
       i--)
   {
      ulong t = PositionGetTicket(i);

      if(t == 0 ||
         !PositionSelectByTicket(t))
         continue;

      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpV5_Magic)
         continue;

      ticket = t;

      type =
         (ENUM_POSITION_TYPE)
         PositionGetInteger(POSITION_TYPE);

      openPrice =
         PositionGetDouble(POSITION_PRICE_OPEN);

      return true;
   }

   return false;
}

bool HasPosition()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double price;

   return FindPosition(
      ticket,
      type,
      price
   );
}

//====================================================================
// MAP
//====================================================================

bool Established(bool buy)
{
   int required =
      MathMax(
         1,
         InpV5_EstablishCloses
      );

   for(int shift = 1;
       shift <= required;
       shift++)
   {
      MqlRates bar;
      double vwap;

      if(!GetBar(
            InpV5_MapTF,
            shift,
            bar))
         return false;

      if(!GetVWAP(
            shift,
            vwap))
         return false;

      if(buy)
      {
         if(bar.close <= vwap)
            return false;
      }
      else
      {
         if(bar.close >= vwap)
            return false;
      }
   }

   return true;
}

void RefreshMap()
{
   g_buyEstablished =
      Established(true);

   g_sellEstablished =
      Established(false);

   if(
      (g_state == STATE_BUY_DEPARTED ||
       g_state == STATE_BUY_RETEST)
      &&
      !g_buyEstablished
   )
   {
      Log("BUY setup cancelled: no longer established above VWAP");

      g_state = STATE_IDLE;
      g_retestStart = 0;
      g_wrongSideSince = 0;
   }

   if(
      (g_state == STATE_SELL_DEPARTED ||
       g_state == STATE_SELL_RETEST)
      &&
      !g_sellEstablished
   )
   {
      Log("SELL setup cancelled: no longer established below VWAP");

      g_state = STATE_IDLE;
      g_retestStart = 0;
      g_wrongSideSince = 0;
   }
}

//====================================================================
// TRADE RESULT
//====================================================================

bool TradeOK()
{
   uint ret =
      trade.ResultRetcode();

   return
      ret == TRADE_RETCODE_DONE ||
      ret == TRADE_RETCODE_DONE_PARTIAL ||
      ret == TRADE_RETCODE_PLACED;
}

//====================================================================
// ENTRY
//====================================================================

bool Buy()
{
   if(HasPosition())
      return false;

   MqlTick tick;

   if(!SymbolInfoTick(
         _Symbol,
         tick))
      return false;

   double sl = 0;

   if(InpV5_EmergencySLPoints > 0)
   {
      sl =
         NormalizeDouble(
            tick.ask -
            InpV5_EmergencySLPoints *
            _Point,
            _Digits
         );
   }

   bool ok =
      trade.Buy(
         InpV5_Lots,
         _Symbol,
         0,
         sl,
         0,
         "VWAP_RECLAIM_BUY"
      );

   if(!ok || !TradeOK())
   {
      Log(
         "BUY FAILED: " +
         trade.ResultRetcodeDescription()
      );

      return false;
   }

   g_state = STATE_IDLE;

   g_emaTakeover = false;
   g_emaWrongCount = 0;
   g_wrongSideSince = 0;
   g_mfe = 0;

   g_lastAction =
      "BUY LIVE VWAP RECLAIM";

   Log(g_lastAction);

   return true;
}

bool Sell()
{
   if(HasPosition())
      return false;

   MqlTick tick;

   if(!SymbolInfoTick(
         _Symbol,
         tick))
      return false;

   double sl = 0;

   if(InpV5_EmergencySLPoints > 0)
   {
      sl =
         NormalizeDouble(
            tick.bid +
            InpV5_EmergencySLPoints *
            _Point,
            _Digits
         );
   }

   bool ok =
      trade.Sell(
         InpV5_Lots,
         _Symbol,
         0,
         sl,
         0,
         "VWAP_RECLAIM_SELL"
      );

   if(!ok || !TradeOK())
   {
      Log(
         "SELL FAILED: " +
         trade.ResultRetcodeDescription()
      );

      return false;
   }

   g_state = STATE_IDLE;

   g_emaTakeover = false;
   g_emaWrongCount = 0;
   g_wrongSideSince = 0;
   g_mfe = 0;

   g_lastAction =
      "SELL LIVE VWAP RECLAIM";

   Log(g_lastAction);

   return true;
}

//====================================================================
// CLOSE
//====================================================================

bool CloseTrade(ulong ticket,
                string reason)
{
   bool ok =
      trade.PositionClose(ticket);

   if(!ok || !TradeOK())
   {
      Log(
         "EXIT FAILED: " +
         trade.ResultRetcodeDescription()
      );

      return false;
   }

   g_lastAction =
      "EXIT: " +
      reason;

   Log(g_lastAction);

   g_state = STATE_IDLE;

   g_emaTakeover = false;
   g_emaWrongCount = 0;
   g_wrongSideSince = 0;
   g_mfe = 0;

   return true;
}

//====================================================================
// LIVE VWAP ENTRY LOGIC
//====================================================================

void ProcessEntry()
{
   if(HasPosition())
      return;

   MqlTick tick;

   if(!SymbolInfoTick(
         _Symbol,
         tick))
      return;

   double price =
      (
         tick.bid +
         tick.ask
      ) / 2.0;

   double vwap;
   double avgM1;

   if(!GetVWAP(0, vwap))
      return;

   if(!AverageRange(
         InpV5_TriggerTF,
         1,
         InpV5_M1RangeLookback,
         avgM1))
      return;

   double departure =
      avgM1 *
      InpV5_DepartureM1RangeFrac;

   double band =
      avgM1 *
      InpV5_RetestBandM1RangeFrac;

   double reclaim =
      avgM1 *
      InpV5_ReclaimM1RangeFrac;

   double wrongDepth =
      avgM1 *
      InpV5_VWAPWrongDepthM1Frac;

   double m1Open =
      iOpen(
         _Symbol,
         InpV5_TriggerTF,
         0
      );

   //==============================================================
   // WAITING
   //==============================================================

   if(g_state == STATE_IDLE)
   {
      if(
         g_buyEstablished &&
         price >= vwap + departure
      )
      {
         g_state =
            STATE_BUY_DEPARTED;

         g_lastAction =
            "BUY move established away from VWAP";

         Log(g_lastAction);

         return;
      }

      if(
         g_sellEstablished &&
         price <= vwap - departure
      )
      {
         g_state =
            STATE_SELL_DEPARTED;

         g_lastAction =
            "SELL move established away from VWAP";

         Log(g_lastAction);

         return;
      }

      return;
   }

   //==============================================================
   // BUY HAS MOVED AWAY -> WAIT RETURN
   //==============================================================

   if(g_state ==
      STATE_BUY_DEPARTED)
   {
      if(!g_buyEstablished)
      {
         g_state =
            STATE_IDLE;

         return;
      }

      if(price <=
         vwap + band)
      {
         g_state =
            STATE_BUY_RETEST;

         g_retestStart =
            TimeCurrent();

         g_retestExtreme =
            price;

         g_wrongSideSince =
            0;

         g_lastAction =
            "BUY VWAP RETEST START";

         Log(g_lastAction);
      }

      return;
   }

   //==============================================================
   // SELL HAS MOVED AWAY -> WAIT RETURN
   //==============================================================

   if(g_state ==
      STATE_SELL_DEPARTED)
   {
      if(!g_sellEstablished)
      {
         g_state =
            STATE_IDLE;

         return;
      }

      if(price >=
         vwap - band)
      {
         g_state =
            STATE_SELL_RETEST;

         g_retestStart =
            TimeCurrent();

         g_retestExtreme =
            price;

         g_wrongSideSince =
            0;

         g_lastAction =
            "SELL VWAP RETEST START";

         Log(g_lastAction);
      }

      return;
   }

   //==============================================================
   // BUY RETEST
   //==============================================================

   if(g_state ==
      STATE_BUY_RETEST)
   {
      g_retestExtreme =
         MathMin(
            g_retestExtreme,
            price
         );

      if(
         InpV5_RetestTimeoutMinutes > 0 &&
         TimeCurrent() -
         g_retestStart >
         InpV5_RetestTimeoutMinutes *
         60
      )
      {
         g_state =
            STATE_IDLE;

         g_wrongSideSince =
            0;

         g_lastAction =
            "BUY RETEST EXPIRED";

         Log(g_lastAction);

         return;
      }

      if(price <
         vwap - wrongDepth)
      {
         if(g_wrongSideSince == 0)
         {
            g_wrongSideSince =
               TimeCurrent();
         }

         int duration =
            (int)(
               TimeCurrent() -
               g_wrongSideSince
            );

         if(duration >=
            InpV5_VWAPWrongSideSeconds)
         {
            g_state =
               STATE_IDLE;

            g_wrongSideSince =
               0;

            g_lastAction =
               "BUY VWAP FAILED: accepted below";

            Log(g_lastAction);

            return;
         }
      }
      else if(price >= vwap)
      {
         g_wrongSideSince = 0;
      }

      bool reclaimed =
         price >=
         vwap + reclaim;

      bool bounced =
         price >=
         g_retestExtreme +
         reclaim;

      bool directionOK =
         !InpV5_RequireTriggerDirection ||
         price > m1Open;

      if(
         reclaimed &&
         bounced &&
         directionOK
      )
      {
         Buy();
      }

      return;
   }

   //==============================================================
   // SELL RETEST
   //==============================================================

   if(g_state ==
      STATE_SELL_RETEST)
   {
      g_retestExtreme =
         MathMax(
            g_retestExtreme,
            price
         );

      if(
         InpV5_RetestTimeoutMinutes > 0 &&
         TimeCurrent() -
         g_retestStart >
         InpV5_RetestTimeoutMinutes *
         60
      )
      {
         g_state =
            STATE_IDLE;

         g_wrongSideSince =
            0;

         g_lastAction =
            "SELL RETEST EXPIRED";

         Log(g_lastAction);

         return;
      }

      if(price >
         vwap + wrongDepth)
      {
         if(g_wrongSideSince == 0)
         {
            g_wrongSideSince =
               TimeCurrent();
         }

         int duration =
            (int)(
               TimeCurrent() -
               g_wrongSideSince
            );

         if(duration >=
            InpV5_VWAPWrongSideSeconds)
         {
            g_state =
               STATE_IDLE;

            g_wrongSideSince =
               0;

            g_lastAction =
               "SELL VWAP FAILED: accepted above";

            Log(g_lastAction);

            return;
         }
      }
      else if(price <= vwap)
      {
         g_wrongSideSince =
            0;
      }

      bool reclaimed =
         price <=
         vwap - reclaim;

      bool bounced =
         price <=
         g_retestExtreme -
         reclaim;

      bool directionOK =
         !InpV5_RequireTriggerDirection ||
         price < m1Open;

      if(
         reclaimed &&
         bounced &&
         directionOK
      )
      {
         Sell();
      }

      return;
   }
}

//====================================================================
// LIVE POSITION
//====================================================================

void ProcessLivePosition()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;

   if(!FindPosition(
         ticket,
         type,
         openPrice))
      return;

   MqlTick tick;

   if(!SymbolInfoTick(
         _Symbol,
         tick))
      return;

   double price =
      (
         tick.bid +
         tick.ask
      ) / 2.0;

   double avgM1;
   double avgM5;
   double vwap;

   if(!AverageRange(
         InpV5_TriggerTF,
         1,
         InpV5_M1RangeLookback,
         avgM1))
      return;

   if(!AverageRange(
         InpV5_MapTF,
         1,
         InpV5_M5RangeLookback,
         avgM5))
      return;

   if(!GetVWAP(0, vwap))
      return;

   double favorable = 0;

   if(type ==
      POSITION_TYPE_BUY)
   {
      favorable =
         price - openPrice;
   }
   else
   {
      favorable =
         openPrice - price;
   }

   if(favorable > g_mfe)
      g_mfe = favorable;

   //==============================================================
   // EMA TAKEOVER
   //==============================================================

   if(
      !g_emaTakeover &&
      g_mfe >=
      avgM5 *
      InpV5_EMATakeoverM5RangeFrac
   )
   {
      g_emaTakeover =
         true;

      g_wrongSideSince =
         0;

      g_lastAction =
         "EMA8 TAKEOVER - RUNNER MODE";

      Log(g_lastAction);
   }

   //==============================================================
   // EARLY VWAP FAILURE
   //==============================================================

   if(
      InpV5_UseEarlyVWAPFailureExit &&
      !g_emaTakeover
   )
   {
      double depth =
         avgM1 *
         InpV5_VWAPWrongDepthM1Frac;

      bool wrong = false;

      if(type ==
         POSITION_TYPE_BUY)
      {
         wrong =
            price <
            vwap - depth;
      }
      else
      {
         wrong =
            price >
            vwap + depth;
      }

      if(wrong)
      {
         if(g_wrongSideSince == 0)
         {
            g_wrongSideSince =
               TimeCurrent();
         }

         int duration =
            (int)(
               TimeCurrent() -
               g_wrongSideSince
            );

         if(duration >=
            InpV5_VWAPWrongSideSeconds)
         {
            CloseTrade(
               ticket,
               type ==
               POSITION_TYPE_BUY
               ?
               "VWAP accepted below"
               :
               "VWAP accepted above"
            );

            return;
         }
      }
      else
      {
         g_wrongSideSince =
            0;
      }
   }
}

//====================================================================
// EMA RUNNER MANAGEMENT ON COMPLETED M5 BAR
//====================================================================

void ManageEMA()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;

   if(!FindPosition(
         ticket,
         type,
         openPrice))
      return;

   if(!g_emaTakeover)
      return;

   MqlRates bar;

   double ema;
   double avgM5;

   if(!GetBar(
         InpV5_MapTF,
         1,
         bar))
      return;

   if(!GetEMA(
         1,
         ema))
      return;

   if(!AverageRange(
         InpV5_MapTF,
         1,
         InpV5_M5RangeLookback,
         avgM5))
      return;

   bool wrong = false;
   double depth = 0;

   if(type ==
      POSITION_TYPE_BUY)
   {
      wrong =
         bar.close < ema;

      if(wrong)
         depth =
            ema - bar.close;
   }
   else
   {
      wrong =
         bar.close > ema;

      if(wrong)
         depth =
            bar.close - ema;
   }

   if(!wrong)
   {
      if(g_emaWrongCount > 0)
      {
         Log(
            "EMA8 reclaimed - HOLD"
         );
      }

      g_emaWrongCount = 0;

      g_lastAction =
         "EMA8 RESPECTED - HOLD";

      return;
   }

   double depthFrac =
      depth / avgM5;

   if(depthFrac >=
      InpV5_EMADeepBreakM5RangeFrac)
   {
      CloseTrade(
         ticket,
         "EMA8 deep loss " +
         DoubleToString(
            depthFrac,
            2
         ) +
         "R"
      );

      return;
   }

   g_emaWrongCount++;

   if(g_emaWrongCount >=
      InpV5_EMAWrongSideCloses)
   {
      CloseTrade(
         ticket,
         "EMA8 accepted wrong side"
      );

      return;
   }

   g_lastAction =
      "EMA8 BREATHING - HOLD " +
      IntegerToString(
         g_emaWrongCount
      ) +
      "/" +
      IntegerToString(
         InpV5_EMAWrongSideCloses
      );

   Log(g_lastAction);
}

//====================================================================
// NEW M5
//====================================================================

void ProcessNewM5()
{
   datetime current =
      iTime(
         _Symbol,
         InpV5_MapTF,
         0
      );

   if(current <= 0 ||
      current == g_lastM5Bar)
      return;

   g_lastM5Bar =
      current;

   RefreshMap();

   ManageEMA();
}

//====================================================================
// PANEL
//====================================================================

string StateName()
{
   switch(g_state)
   {
      case STATE_BUY_DEPARTED:
         return "BUY DEPARTED";

      case STATE_BUY_RETEST:
         return "BUY RETEST";

      case STATE_SELL_DEPARTED:
         return "SELL DEPARTED";

      case STATE_SELL_RETEST:
         return "SELL RETEST";

      default:
         return "IDLE";
   }
}

void Panel()
{
   double vwap;
   double ema;

   bool haveVWAP =
      GetVWAP(0, vwap);

   bool haveEMA =
      GetEMA(0, ema);

   string world =
      "NEUTRAL";

   if(g_buyEstablished)
      world = "BUY WORLD";

   if(g_sellEstablished)
      world = "SELL WORLD";

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;

   string position =
      "NONE";

   if(FindPosition(
         ticket,
         type,
         openPrice))
   {
      position =
         type ==
         POSITION_TYPE_BUY
         ?
         "BUY"
         :
         "SELL";
   }

   int wrongSeconds = 0;

   if(g_wrongSideSince > 0)
   {
      wrongSeconds =
         (int)(
            TimeCurrent() -
            g_wrongSideSince
         );
   }

   Comment(
      "VWAP + EMA8 BEHAVIOR V5\n",
      "M5 MAP: ", world, "\n",
      "STATE: ", StateName(), "\n",
      "VWAP: ",
      haveVWAP
      ?
      DoubleToString(vwap, _Digits)
      :
      "n/a",
      "\n",
      "EMA8: ",
      haveEMA
      ?
      DoubleToString(ema, _Digits)
      :
      "n/a",
      "\n",
      "POSITION: ", position, "\n",
      "EMA TAKEOVER: ",
      g_emaTakeover
      ?
      "YES"
      :
      "NO",
      "\n",
      "EMA WRONG CLOSES: ",
      g_emaWrongCount,
      "\n",
      "VWAP WRONG SIDE SEC: ",
      wrongSeconds,
      "\n",
      "MFE: ",
      DoubleToString(g_mfe, 2),
      "\n",
      "LAST: ",
      g_lastAction
   );
}

//====================================================================
// INIT
//====================================================================

int OnInit()
{
   if(InpV5_MapTF !=
      PERIOD_M5)
   {
      Print(
         "V5 requires M5 map timeframe"
      );

      return
         INIT_PARAMETERS_INCORRECT;
   }

   if(InpV5_TriggerTF !=
      PERIOD_M1)
   {
      Print(
         "V5 requires M1 trigger timeframe"
      );

      return
         INIT_PARAMETERS_INCORRECT;
   }

   g_emaHandle =
      iMA(
         _Symbol,
         InpV5_MapTF,
         InpV5_EMAPeriod,
         0,
         MODE_EMA,
         PRICE_CLOSE
      );

   if(g_emaHandle ==
      INVALID_HANDLE)
   {
      Print(
         "EMA handle failed: ",
         GetLastError()
      );

      return
         INIT_FAILED;
   }

   trade.SetExpertMagicNumber(
      InpV5_Magic
   );

   trade.SetDeviationInPoints(
      InpV5_DeviationPoints
   );

   trade.SetTypeFillingBySymbol(
      _Symbol
   );

   trade.SetAsyncMode(false);

   g_lastM5Bar = 0;

   RefreshMap();

   Log(
      "V5 INIT | M5 map | live VWAP reclaim | EMA8 runner"
   );

   return
      INIT_SUCCEEDED;
}

//====================================================================
// DEINIT
//====================================================================

void OnDeinit(const int reason)
{
   if(g_emaHandle !=
      INVALID_HANDLE)
   {
      IndicatorRelease(
         g_emaHandle
      );
   }

   Comment("");
}

//====================================================================
// TICK
//====================================================================

void OnTick()
{
   ProcessNewM5();

   ProcessLivePosition();

   ProcessEntry();

   Panel();
}
//+------------------------------------------------------------------+
