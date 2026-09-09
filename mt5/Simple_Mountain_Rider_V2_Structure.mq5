#property strict
#property version "2.00"
#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// SIMPLE MOUNTAIN RIDER V2
// =============================================================
// M15 = TRUE MARKET STRUCTURE
//       BUY  only when Higher High + Higher Low
//       SELL only when Lower High + Lower Low
//       Direction does NOT flip because of one candle or EMA wiggle.
//
// M5  = MAP
//       Wait for a CLOSED M5 breakout of a real prior M5 high/low.
//       Then wait for a CLOSED M5 retest that HOLDS the broken level.
//
// M1  = TRIGGER
//       After the M5 retest exists, enter only when a CLOSED M1 candle
//       breaks the recent M1 pullback in the M15 direction.
//
// STOP = below/above the STRUCTURAL M5 retest, not a tiny M1 wick.
// EXIT = when a CLOSED M15 candle breaks the latest protected M15 HL/LH.
// NO TAKE PROFIT. ONE POSITION AT A TIME. ONE TRADE PER M5 BREAKOUT ANCHOR.
// =============================================================

input double Lots = 0.01;
input ulong Magic = 260909002;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// ---------- M15 STRUCTURE ----------
input int M15PivotWing = 3;                 // larger = calmer / fewer direction changes
input int M15SeedLookbackBars = 240;        // seeds structure before test start
input int M15RangeLookback = 12;
input double MinM15StructureStepRangeFrac = 0.15;
input double M15BreakExitBufferRangeFrac = 0.05;

// ---------- M5 MAP ----------
input int M5BreakoutLookback = 12;
input int M5RangeLookback = 12;
input double M5BreakoutBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.60;
input int BreakoutExpiryMinutes = 120;
input int RetestExpiryMinutes = 60;

// ---------- M1 CONFIRMATION ----------
input int M1ConfirmationLookback = 3;
input double MinM1ConfirmationMoveM5RangeFrac = 0.20;
input double MaxEntryDistanceFromBreakM5RangeFrac = 1.00;

// ---------- RISK ----------
input double SLBufferM5RangeFrac = 0.10;
input double CommissionPerLotRT = 58.0;
input double CostSafetyMultiple = 1.25;
input int ExpectedSlippagePoints = 0;

input int PanelUpdateMilliseconds = 500;
input bool VerboseLog = true;

enum TrendDir
{
   TREND_NONE = 0,
   TREND_BUY  = 1,
   TREND_SELL = -1
};

enum SetupStage
{
   SETUP_IDLE = 0,
   WAIT_M5_RETEST = 1,
   WAIT_M1_CONFIRM = 2
};

// M15 swing structure
double prevM15High = 0;
double lastM15High = 0;
datetime lastM15HighTime = 0;

double prevM15Low = 0;
double lastM15Low = 0;
datetime lastM15LowTime = 0;

TrendDir trend = TREND_NONE;
double avgM15Range = 0;
double avgM5Range = 0;

// M5 breakout/retest setup
SetupStage setupStage = SETUP_IDLE;
TrendDir setupDir = TREND_NONE;
double breakoutLevel = 0;
datetime breakoutTime = 0;
datetime breakoutAnchorTime = 0;
double retestLow = 0;
double retestHigh = 0;
datetime retestTime = 0;

// Prevent repeated entries from the same old breakout anchor
datetime consumedBuyAnchor = 0;
datetime consumedSellAnchor = 0;

// Position structure ownership
TrendDir positionDir = TREND_NONE;
double protectedM15Structure = 0;

// Timing
datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

// Diagnostics
int m5Breakouts = 0;
int m5Retests = 0;
int entries = 0;
int stopOrStructureExits = 0;
int setupCancels = 0;
int lateEntryBlocks = 0;
string lastAction = "WAITING FOR M15 STRUCTURE";
ulong lastPanelMs = 0;

void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V2] ", text);
}

bool GetBar(ENUM_TIMEFRAMES tf,int shift,MqlRates &bar)
{
   MqlRates one[1];
   if(CopyRates(_Symbol,tf,shift,1,one)!=1)
      return false;
   bar=one[0];
   return true;
}

bool AvgRange(ENUM_TIMEFRAMES tf,int startShift,int count,double &out)
{
   count=MathMax(2,count);
   MqlRates rates[];
   int copied=CopyRates(_Symbol,tf,startShift,count,rates);
   if(copied!=count)
      return false;

   double total=0;
   int valid=0;
   for(int i=0;i<copied;i++)
   {
      double r=rates[i].high-rates[i].low;
      if(r>0)
      {
         total+=r;
         valid++;
      }
   }

   if(valid==0)
      return false;

   out=total/valid;
   return true;
}

double NormalizeVolume(double requested)
{
   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maxVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);

   if(step<=0)
      step=minVol;

   double v=MathMax(minVol,MathMin(maxVol,requested));
   v=MathFloor((v-minVol+1e-12)/step)*step+minVol;

   int digits=2;
   if(step>0)
   {
      double lg=-MathLog10(step);
      digits=(lg>0 ? (int)MathCeil(lg) : 0);
      digits=MathMax(0,MathMin(8,digits));
   }

   return NormalizeDouble(v,digits);
}

double TickValue()
{
   double tv=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(tv>0)
      return tv;

   double p=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT);
   double l=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);

   if(p>0 && l>0)
      return (p+l)*0.5;

   return MathMax(p,l);
}

double CostDistance()
{
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return 0;

   double spread=MathMax(0.0,tick.ask-tick.bid);
   double commissionDistance=0;

   double tickSize=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tickValue=TickValue();

   if(tickSize>0 && tickValue>0)
   {
      double moneyPerPricePerLot=tickValue/tickSize;
      if(moneyPerPricePerLot>0)
         commissionDistance=MathMax(0.0,CommissionPerLotRT)/moneyPerPricePerLot;
   }

   double slippage=MathMax(0,ExpectedSlippagePoints)*_Point;
   return spread+commissionDistance+slippage;
}

bool TradeResultOK()
{
   uint rc=trade.ResultRetcode();
   return rc==TRADE_RETCODE_DONE ||
          rc==TRADE_RETCODE_DONE_PARTIAL ||
          rc==TRADE_RETCODE_PLACED;
}

bool FindOurPosition(ulong &ticket,ENUM_POSITION_TYPE &type,double &openPrice)
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);
      if(t==0 || !PositionSelectByTicket(t))
         continue;

      if(PositionGetString(POSITION_SYMBOL)!=_Symbol)
         continue;

      if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic)
         continue;

      ticket=t;
      type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      openPrice=PositionGetDouble(POSITION_PRICE_OPEN);
      return true;
   }

   return false;
}

bool HasPosition()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   return FindOurPosition(ticket,type,openPrice);
}

void ResetSetup()
{
   setupStage=SETUP_IDLE;
   setupDir=TREND_NONE;
   breakoutLevel=0;
   breakoutTime=0;
   breakoutAnchorTime=0;
   retestLow=0;
   retestHigh=0;
   retestTime=0;
}

bool CloseCurrentPosition(string reason)
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;

   if(!FindOurPosition(ticket,type,openPrice))
      return false;

   if(!trade.PositionClose(ticket) || !TradeResultOK())
   {
      Log("CLOSE FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   stopOrStructureExits++;
   positionDir=TREND_NONE;
   protectedM15Structure=0;
   lastAction=reason;
   Log(reason);
   return true;
}

// -------------------------------------------------------------
// PIVOTS
// -------------------------------------------------------------
bool IsPivotHigh(ENUM_TIMEFRAMES tf,int centerShift,int wing,double &price,datetime &when)
{
   MqlRates center;
   if(!GetBar(tf,centerShift,center))
      return false;

   for(int k=1;k<=wing;k++)
   {
      MqlRates newerBar,olderBar;
      if(!GetBar(tf,centerShift-k,newerBar) || !GetBar(tf,centerShift+k,olderBar))
         return false;

      if(center.high<=newerBar.high || center.high<=olderBar.high)
         return false;
   }

   price=center.high;
   when=center.time;
   return true;
}

bool IsPivotLow(ENUM_TIMEFRAMES tf,int centerShift,int wing,double &price,datetime &when)
{
   MqlRates center;
   if(!GetBar(tf,centerShift,center))
      return false;

   for(int k=1;k<=wing;k++)
   {
      MqlRates newerBar,olderBar;
      if(!GetBar(tf,centerShift-k,newerBar) || !GetBar(tf,centerShift+k,olderBar))
         return false;

      if(center.low>=newerBar.low || center.low>=olderBar.low)
         return false;
   }

   price=center.low;
   when=center.time;
   return true;
}

void AcceptM15High(double price,datetime when)
{
   if(when==lastM15HighTime)
      return;

   prevM15High=lastM15High;
   lastM15High=price;
   lastM15HighTime=when;
}

void AcceptM15Low(double price,datetime when)
{
   if(when==lastM15LowTime)
      return;

   prevM15Low=lastM15Low;
   lastM15Low=price;
   lastM15LowTime=when;

   // Once in a BUY mountain, new confirmed HIGHER LOWS ratchet the
   // structural exit level upward. Never lower protection.
   if(HasPosition() && positionDir==TREND_BUY)
   {
      if(protectedM15Structure<=0 || price>protectedM15Structure)
      {
         protectedM15Structure=price;
         Log("BUY STRUCTURE RATCHET -> new protected M15 HL "+DoubleToString(price,_Digits));
      }
   }
}

void AcceptM15HighForSellProtection(double price)
{
   if(HasPosition() && positionDir==TREND_SELL)
   {
      if(protectedM15Structure<=0 || price<protectedM15Structure)
      {
         protectedM15Structure=price;
         Log("SELL STRUCTURE RATCHET -> new protected M15 LH "+DoubleToString(price,_Digits));
      }
   }
}

void DetectConfirmedM15PivotAtShift(int centerShift)
{
   int wing=MathMax(1,M15PivotWing);
   double hp=0,lp=0;
   datetime ht=0,lt=0;

   bool isHigh=IsPivotHigh(DirectionTF,centerShift,wing,hp,ht);
   bool isLow =IsPivotLow(DirectionTF,centerShift,wing,lp,lt);

   // An outside bar can theoretically qualify as both. Do not invent
   // an order between a high and low that the candle data cannot prove.
   if(isHigh && isLow)
      return;

   if(isHigh)
   {
      AcceptM15High(hp,ht);
      AcceptM15HighForSellProtection(hp);
   }
   else if(isLow)
   {
      AcceptM15Low(lp,lt);
   }
}

void SeedM15Structure()
{
   int wing=MathMax(1,M15PivotWing);
   int oldest=MathMax(wing+2,M15SeedLookbackBars);

   // Walk from old -> new so the final stored highs/lows are truly the latest.
   for(int shift=oldest;shift>=wing+1;shift--)
      DetectConfirmedM15PivotAtShift(shift);
}

void UpdateM15Trend()
{
   if(avgM15Range<=0)
      AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);

   if(prevM15High<=0 || lastM15High<=0 || prevM15Low<=0 || lastM15Low<=0)
   {
      trend=TREND_NONE;
      return;
   }

   double minStep=avgM15Range*MathMax(0.0,MinM15StructureStepRangeFrac);

   bool uptrend = (lastM15High>=prevM15High+minStep) &&
                  (lastM15Low >=prevM15Low +minStep);

   bool downtrend = (lastM15High<=prevM15High-minStep) &&
                    (lastM15Low <=prevM15Low -minStep);

   TrendDir oldTrend=trend;
   trend=uptrend ? TREND_BUY : (downtrend ? TREND_SELL : TREND_NONE);

   if(trend!=oldTrend)
   {
      if(trend==TREND_BUY)
         lastAction="M15 STRUCTURE = HH + HL -> BUY ONLY";
      else if(trend==TREND_SELL)
         lastAction="M15 STRUCTURE = LH + LL -> SELL ONLY";
      else
         lastAction="M15 STRUCTURE MIXED -> NO NEW TRADE";

      Log(lastAction);

      if(!HasPosition())
      {
         setupCancels++;
         ResetSetup();
      }
   }
}

// -------------------------------------------------------------
// M5 BREAKOUT MAP
// -------------------------------------------------------------
bool HighestHighWithTime(int startShift,int count,double &price,datetime &when)
{
   MqlRates rates[];
   int copied=CopyRates(_Symbol,MapTF,startShift,count,rates);
   if(copied!=count)
      return false;

   price=rates[0].high;
   when=rates[0].time;

   for(int i=1;i<copied;i++)
   {
      if(rates[i].high>price)
      {
         price=rates[i].high;
         when=rates[i].time;
      }
   }

   return true;
}

bool LowestLowWithTime(int startShift,int count,double &price,datetime &when)
{
   MqlRates rates[];
   int copied=CopyRates(_Symbol,MapTF,startShift,count,rates);
   if(copied!=count)
      return false;

   price=rates[0].low;
   when=rates[0].time;

   for(int i=1;i<copied;i++)
   {
      if(rates[i].low<price)
      {
         price=rates[i].low;
         when=rates[i].time;
      }
   }

   return true;
}

void LookForM5Breakout()
{
   if(HasPosition() || setupStage!=SETUP_IDLE || trend==TREND_NONE)
      return;

   if(!AvgRange(MapTF,1,M5RangeLookback,avgM5Range) || avgM5Range<=0)
      return;

   MqlRates breakoutBar;
   if(!GetBar(MapTF,1,breakoutBar))
      return;

   double buffer=MathMax(avgM5Range*MathMax(0.0,M5BreakoutBufferRangeFrac),
                         CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(trend==TREND_BUY)
   {
      double level=0;
      datetime anchor=0;
      if(!HighestHighWithTime(2,M5BreakoutLookback,level,anchor))
         return;

      if(anchor==consumedBuyAnchor)
         return;

      if(breakoutBar.close>level+buffer)
      {
         setupStage=WAIT_M5_RETEST;
         setupDir=TREND_BUY;
         breakoutLevel=level;
         breakoutTime=breakoutBar.time;
         breakoutAnchorTime=anchor;
         m5Breakouts++;
         lastAction="M5 BUY BREAKOUT -> WAIT FOR M5 RETEST";
         Log(lastAction+" | level="+DoubleToString(level,_Digits));
      }
   }
   else if(trend==TREND_SELL)
   {
      double level=0;
      datetime anchor=0;
      if(!LowestLowWithTime(2,M5BreakoutLookback,level,anchor))
         return;

      if(anchor==consumedSellAnchor)
         return;

      if(breakoutBar.close<level-buffer)
      {
         setupStage=WAIT_M5_RETEST;
         setupDir=TREND_SELL;
         breakoutLevel=level;
         breakoutTime=breakoutBar.time;
         breakoutAnchorTime=anchor;
         m5Breakouts++;
         lastAction="M5 SELL BREAKOUT -> WAIT FOR M5 RETEST";
         Log(lastAction+" | level="+DoubleToString(level,_Digits));
      }
   }
}

void ProcessM5Retest()
{
   if(HasPosition() || setupStage==SETUP_IDLE)
      return;

   if(trend!=setupDir || trend==TREND_NONE)
   {
      setupCancels++;
      lastAction="SETUP CANCELLED -> M15 STRUCTURE NO LONGER AGREES";
      Log(lastAction);
      ResetSetup();
      return;
   }

   if(BreakoutExpiryMinutes>0 &&
      TimeCurrent()-breakoutTime>BreakoutExpiryMinutes*60)
   {
      setupCancels++;
      lastAction="M5 BREAKOUT EXPIRED WITHOUT VALID RETEST";
      Log(lastAction);
      ResetSetup();
      return;
   }

   if(!AvgRange(MapTF,1,M5RangeLookback,avgM5Range) || avgM5Range<=0)
      return;

   MqlRates b;
   if(!GetBar(MapTF,1,b))
      return;

   // Never call the breakout candle itself a retest.
   if(b.time<=breakoutTime)
      return;

   double zone=avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(setupStage==WAIT_M5_RETEST)
   {
      if(setupDir==TREND_BUY)
      {
         bool touched=(b.low<=breakoutLevel+zone);
         bool notTooDeep=(b.low>=breakoutLevel-maxDepth);
         bool heldOnClose=(b.close>=breakoutLevel);

         if(touched && notTooDeep && heldOnClose)
         {
            retestLow=b.low;
            retestHigh=b.high;
            retestTime=b.time;
            setupStage=WAIT_M1_CONFIRM;
            m5Retests++;
            lastAction="M5 BUY RETEST HELD -> WAIT M1 BREAK OF PULLBACK";
            Log(lastAction+" | retestLow="+DoubleToString(retestLow,_Digits));
         }
         else if(b.close<breakoutLevel-maxDepth)
         {
            setupCancels++;
            lastAction="BUY BREAKOUT FAILED -> M5 CLOSED TOO DEEP BELOW LEVEL";
            Log(lastAction);
            ResetSetup();
         }
      }
      else if(setupDir==TREND_SELL)
      {
         bool touched=(b.high>=breakoutLevel-zone);
         bool notTooDeep=(b.high<=breakoutLevel+maxDepth);
         bool heldOnClose=(b.close<=breakoutLevel);

         if(touched && notTooDeep && heldOnClose)
         {
            retestLow=b.low;
            retestHigh=b.high;
            retestTime=b.time;
            setupStage=WAIT_M1_CONFIRM;
            m5Retests++;
            lastAction="M5 SELL RETEST HELD -> WAIT M1 BREAK OF PULLBACK";
            Log(lastAction+" | retestHigh="+DoubleToString(retestHigh,_Digits));
         }
         else if(b.close>breakoutLevel+maxDepth)
         {
            setupCancels++;
            lastAction="SELL BREAKOUT FAILED -> M5 CLOSED TOO DEEP ABOVE LEVEL";
            Log(lastAction);
            ResetSetup();
         }
      }

      return;
   }

   // Once a structural M5 retest exists, later M5 bars may deepen the same
   // retest while still holding the breakout. This makes the stop structural,
   // not a tiny M1 stop.
   if(setupStage==WAIT_M1_CONFIRM)
   {
      if(RetestExpiryMinutes>0 &&
         TimeCurrent()-retestTime>RetestExpiryMinutes*60)
      {
         setupCancels++;
         lastAction="M5 RETEST EXPIRED WITHOUT M1 CONFIRMATION";
         Log(lastAction);
         ResetSetup();
         return;
      }

      if(setupDir==TREND_BUY)
      {
         if(b.low<retestLow)
            retestLow=b.low;
         if(b.high>retestHigh)
            retestHigh=b.high;

         if(b.close<breakoutLevel-maxDepth)
         {
            setupCancels++;
            lastAction="BUY RETEST STRUCTURE FAILED BEFORE ENTRY";
            Log(lastAction);
            ResetSetup();
         }
      }
      else if(setupDir==TREND_SELL)
      {
         if(b.low<retestLow)
            retestLow=b.low;
         if(b.high>retestHigh)
            retestHigh=b.high;

         if(b.close>breakoutLevel+maxDepth)
         {
            setupCancels++;
            lastAction="SELL RETEST STRUCTURE FAILED BEFORE ENTRY";
            Log(lastAction);
            ResetSetup();
         }
      }
   }
}

// -------------------------------------------------------------
// M1 CONFIRMATION + ENTRY
// -------------------------------------------------------------
double HighestM1High(int startShift,int count)
{
   MqlRates rates[];
   int copied=CopyRates(_Symbol,EntryTF,startShift,count,rates);
   if(copied!=count)
      return 0;

   double high=rates[0].high;
   for(int i=1;i<copied;i++)
      if(rates[i].high>high)
         high=rates[i].high;

   return high;
}

double LowestM1Low(int startShift,int count)
{
   MqlRates rates[];
   int copied=CopyRates(_Symbol,EntryTF,startShift,count,rates);
   if(copied!=count)
      return 0;

   double low=rates[0].low;
   for(int i=1;i<copied;i++)
      if(rates[i].low<low)
         low=rates[i].low;

   return low;
}

bool OpenMountainTrade(TrendDir dir)
{
   if(HasPosition() || setupStage!=WAIT_M1_CONFIRM || avgM5Range<=0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(dir==TREND_BUY ? tick.ask : tick.bid);
   double distanceFromBreak=MathAbs(entry-breakoutLevel);
   double maxDistance=avgM5Range*MathMax(0.0,MaxEntryDistanceFromBreakM5RangeFrac);

   if(distanceFromBreak>maxDistance)
   {
      lateEntryBlocks++;
      lastAction="ENTRY BLOCKED -> MOVE ALREADY TOO FAR FROM M5 RETEST";
      Log(lastAction);
      ResetSetup();
      return false;
   }

   double slBuffer=MathMax(avgM5Range*MathMax(0.0,SLBufferM5RangeFrac),
                           CostDistance()*MathMax(1.0,CostSafetyMultiple));

   double sl=(dir==TREND_BUY ? retestLow-slBuffer : retestHigh+slBuffer);
   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(dir==TREND_BUY)
      ok=trade.Buy(volume,_Symbol,0,sl,0,"MOUNTAIN_V2_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0,sl,0,"MOUNTAIN_V2_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=dir;
   protectedM15Structure=(dir==TREND_BUY ? lastM15Low : lastM15High);

   if(dir==TREND_BUY)
      consumedBuyAnchor=breakoutAnchorTime;
   else
      consumedSellAnchor=breakoutAnchorTime;

   entries++;
   lastAction=(dir==TREND_BUY ? "BUY" : "SELL")+
              string(" OPENED -> M5 STRUCTURAL SL + M15 STRUCTURE EXIT");
   Log(lastAction+" | protectedM15="+DoubleToString(protectedM15Structure,_Digits));

   ResetSetup();
   return true;
}

void ProcessM1Confirmation()
{
   if(HasPosition() || setupStage!=WAIT_M1_CONFIRM || setupDir==TREND_NONE)
      return;

   if(trend!=setupDir)
   {
      setupCancels++;
      lastAction="ENTRY CANCELLED -> M15 STRUCTURE CHANGED";
      Log(lastAction);
      ResetSetup();
      return;
   }

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   // M1 confirmation must happen AFTER the M5 retest was established.
   if(signal.time<=retestTime)
      return;

   int lookback=MathMax(2,M1ConfirmationLookback);
   double confirmDistance=MathMax(avgM5Range*MathMax(0.0,MinM1ConfirmationMoveM5RangeFrac),
                                  CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(setupDir==TREND_BUY)
   {
      double pullbackHigh=HighestM1High(2,lookback);
      if(pullbackHigh<=0)
         return;

      bool aboveBreakout=(signal.close>breakoutLevel);
      bool breaksPullback=(signal.close>pullbackHigh);
      bool enoughRecovery=(signal.close-retestLow>=confirmDistance);
      bool bullishClose=(signal.close>signal.open);

      if(aboveBreakout && breaksPullback && enoughRecovery && bullishClose)
         OpenMountainTrade(TREND_BUY);
   }
   else if(setupDir==TREND_SELL)
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0)
         return;

      bool belowBreakout=(signal.close<breakoutLevel);
      bool breaksPullback=(signal.close<pullbackLow);
      bool enoughRecovery=(retestHigh-signal.close>=confirmDistance);
      bool bearishClose=(signal.close<signal.open);

      if(belowBreakout && breaksPullback && enoughRecovery && bearishClose)
         OpenMountainTrade(TREND_SELL);
   }
}

// -------------------------------------------------------------
// M15 STRUCTURE EXIT
// -------------------------------------------------------------
void CheckM15StructureExit()
{
   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;

   if(!FindOurPosition(ticket,type,openPrice) || protectedM15Structure<=0)
      return;

   MqlRates closedM15;
   if(!GetBar(DirectionTF,1,closedM15))
      return;

   if(avgM15Range<=0)
      AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);

   double buffer=avgM15Range*MathMax(0.0,M15BreakExitBufferRangeFrac);

   if(type==POSITION_TYPE_BUY)
   {
      if(closedM15.close<protectedM15Structure-buffer)
         CloseCurrentPosition("EXIT BUY -> CLOSED M15 BROKE PROTECTED HIGHER LOW");
   }
   else if(type==POSITION_TYPE_SELL)
   {
      if(closedM15.close>protectedM15Structure+buffer)
         CloseCurrentPosition("EXIT SELL -> CLOSED M15 BROKE PROTECTED LOWER HIGH");
   }
}

// -------------------------------------------------------------
// NEW BAR EVENTS
// -------------------------------------------------------------
void OnNewM15()
{
   datetime current=iTime(_Symbol,DirectionTF,0);
   if(current<=0 || current==lastM15Bar)
      return;

   lastM15Bar=current;

   AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);

   int center=MathMax(1,M15PivotWing)+1;
   DetectConfirmedM15PivotAtShift(center);
   UpdateM15Trend();
   CheckM15StructureExit();
}

void OnNewM5()
{
   datetime current=iTime(_Symbol,MapTF,0);
   if(current<=0 || current==lastM5Bar)
      return;

   lastM5Bar=current;
   AvgRange(MapTF,1,M5RangeLookback,avgM5Range);

   if(setupStage==SETUP_IDLE)
      LookForM5Breakout();
   else
      ProcessM5Retest();
}

void OnNewM1()
{
   datetime current=iTime(_Symbol,EntryTF,0);
   if(current<=0 || current==lastM1Bar)
      return;

   lastM1Bar=current;
   ProcessM1Confirmation();
}

string TrendText()
{
   if(trend==TREND_BUY)
      return "HH + HL -> BUY ONLY";
   if(trend==TREND_SELL)
      return "LH + LL -> SELL ONLY";
   return "MIXED STRUCTURE -> WAIT";
}

string SetupText()
{
   if(setupStage==WAIT_M5_RETEST)
      return "WAITING FOR M5 RETEST";
   if(setupStage==WAIT_M1_CONFIRM)
      return "M5 RETEST HELD -> WAIT M1 CONFIRM";
   return "IDLE";
}

void Panel()
{
   ulong now=GetTickCount64();
   if(lastPanelMs>0 && now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))
      return;
   lastPanelMs=now;

   ulong ticket;
   ENUM_POSITION_TYPE type;
   double openPrice;
   string position="NONE";

   if(FindOurPosition(ticket,type,openPrice))
      position=(type==POSITION_TYPE_BUY ? "BUY" : "SELL");

   Comment(
      "SIMPLE MOUNTAIN RIDER V2 - TRUE STRUCTURE\n",
      "POSITION: ",position,"\n",
      "M15 DIRECTION: ",TrendText(),"\n",
      "M15 HIGHS: ",DoubleToString(prevM15High,_Digits)," -> ",DoubleToString(lastM15High,_Digits),"\n",
      "M15 LOWS:  ",DoubleToString(prevM15Low,_Digits)," -> ",DoubleToString(lastM15Low,_Digits),"\n",
      "PROTECTED M15 STRUCTURE: ",DoubleToString(protectedM15Structure,_Digits),"\n",
      "M5 SETUP: ",SetupText(),"\n",
      "BREAKOUT LEVEL: ",DoubleToString(breakoutLevel,_Digits),"\n",
      "M5 RETEST LOW/HIGH: ",DoubleToString(retestLow,_Digits)," / ",DoubleToString(retestHigh,_Digits),"\n",
      "M15 AVG RANGE: ",DoubleToString(avgM15Range,2)," | M5 AVG RANGE: ",DoubleToString(avgM5Range,2),"\n",
      "BREAKOUTS: ",IntegerToString(m5Breakouts),
      " | RETESTS: ",IntegerToString(m5Retests),
      " | ENTRIES: ",IntegerToString(entries),"\n",
      "CANCELS: ",IntegerToString(setupCancels),
      " | LATE BLOCKS: ",IntegerToString(lateEntryBlocks),
      " | EXITS: ",IntegerToString(stopOrStructureExits),"\n",
      "LAST: ",lastAction
   );
}

int OnInit()
{
   if(DirectionTF!=PERIOD_M15 || MapTF!=PERIOD_M5 || EntryTF!=PERIOD_M1)
      return INIT_PARAMETERS_INCORRECT;

   if(M15PivotWing<1 || M15PivotWing>8)
      return INIT_PARAMETERS_INCORRECT;

   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);
   AvgRange(MapTF,1,M5RangeLookback,avgM5Range);

   SeedM15Structure();
   UpdateM15Trend();
   ResetSetup();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   Log("INIT SIMPLE MOUNTAIN RIDER V2");
   Log("M15 TRUE HH/HL OR LH/LL -> M5 BREAKOUT -> M5 STRUCTURAL RETEST -> M1 CONFIRM -> HOLD UNTIL M15 STRUCTURE BREAK");
   Log("NO EMA DIRECTION. NO EMA EXIT. NO TAKE PROFIT. NO TINY M1 STOP.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");
   Log("DEINIT V2 | breakouts="+IntegerToString(m5Breakouts)+
       " | retests="+IntegerToString(m5Retests)+
       " | entries="+IntegerToString(entries)+
       " | exits="+IntegerToString(stopOrStructureExits));
}

void OnTick()
{
   OnNewM15();
   OnNewM5();
   OnNewM1();
   Panel();
}
