#property strict
#property version "3.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// SIMPLE MOUNTAIN RIDER V3 - PERSISTENT REGIME
// =============================================================
// M15 = STORY / MOUNTAIN
//   * Establish BUY once structure proves HH + HL.
//   * Establish SELL once structure proves LH + LL.
//   * Once established, DO NOT flip because structure becomes "mixed".
//   * BUY stays BUY until a CLOSED M15 candle breaks the protected MAJOR HL.
//   * SELL stays SELL until a CLOSED M15 candle breaks the protected MAJOR LH.
//   * After a regime breaks, go NEUTRAL. Opposite regime must build fresh.
//
// IMPORTANT:
//   A new M15 pivot does NOT automatically ratchet the protected structure.
//   In BUY, a candidate HL is promoted only AFTER price closes above the
//   existing structural high. In SELL, a candidate LH is promoted only AFTER
//   price closes below the existing structural low.
//
// M5 = MAP
//   Closed breakout -> closed retest that holds.
//
// M1 = TRIGGER
//   Break of the short M1 pullback after the M5 retest.
//
// EXIT:
//   Normal exit is M15 closed-bar structure break.
//   Broker SL is emergency-only, placed beyond the M15 protected structure.
//
// NO TAKE PROFIT. ONE POSITION AT A TIME.
// =============================================================

// ---------- EXECUTION ----------
input double Lots = 0.01;
input ulong  Magic = 260909003;
input int    DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// ---------- M15 PERSISTENT REGIME ----------
input int    M15PivotWing = 3;
input int    M15SeedLookbackBars = 320;
input int    M15RangeLookback = 12;
input double MinM15StructureStepRangeFrac = 0.15;
input double M15BreakExitBufferRangeFrac = 0.05;

// Candidate HL/LH must be meaningfully beyond current protected structure.
input double MinPromotionStepM15RangeFrac = 0.10;

// Emergency broker stop only. Normal exit remains CLOSED M15 structure break.
input bool   UseEmergencyBrokerSL = true;
input double EmergencySLBeyondProtectedM15RangeFrac = 1.00;

// ---------- M5 MAP ----------
input int    M5BreakoutLookback = 12;
input int    M5RangeLookback = 12;
input double M5BreakoutBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.60;
input int    BreakoutExpiryMinutes = 120;
input int    RetestExpiryMinutes = 60;

// ---------- M1 TRIGGER ----------
input int    M1ConfirmationLookback = 3;
input double MinM1ConfirmationMoveM5RangeFrac = 0.20;
input double MaxEntryDistanceFromBreakM5RangeFrac = 1.00;

// ---------- COST ----------
input double CommissionPerLotRT = 58.0;
input double CostSafetyMultiple = 1.25;
input int    ExpectedSlippagePoints = 0;

input int    PanelUpdateMilliseconds = 500;
input bool   VerboseLog = true;

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

// -------------------------------------------------------------
// M15 RAW PIVOTS
// -------------------------------------------------------------
double prevM15High = 0.0;
double lastM15High = 0.0;
datetime prevM15HighTime = 0;
datetime lastM15HighTime = 0;

double prevM15Low = 0.0;
double lastM15Low = 0.0;
datetime prevM15LowTime = 0;
datetime lastM15LowTime = 0;

// -------------------------------------------------------------
// PERSISTENT REGIME STATE
// -------------------------------------------------------------
TrendDir regime = TREND_NONE;

// BUY:
// structuralExtreme = major high that must be broken to confirm candidate HL
// protectedStructure = currently confirmed major HL
//
// SELL:
// structuralExtreme = major low that must be broken to confirm candidate LH
// protectedStructure = currently confirmed major LH
double structuralExtreme = 0.0;
double protectedStructure = 0.0;

double candidateStructure = 0.0;
datetime candidateStructureTime = 0;
datetime structuralExtremeTime = 0;
datetime regimeStartTime = 0;

// After a regime break, pivots from before this time are forbidden from
// building the opposite regime. The new story must form after the break.
datetime freshStructureAfter = 0;

double avgM15Range = 0.0;
double avgM5Range = 0.0;

// -------------------------------------------------------------
// M5 BREAKOUT / RETEST
// -------------------------------------------------------------
SetupStage setupStage = SETUP_IDLE;
TrendDir setupDir = TREND_NONE;

double breakoutLevel = 0.0;
datetime breakoutTime = 0;
datetime breakoutAnchorTime = 0;

double retestLow = 0.0;
double retestHigh = 0.0;
datetime retestTime = 0;

datetime consumedBuyAnchor = 0;
datetime consumedSellAnchor = 0;

// -------------------------------------------------------------
// POSITION STATE
// -------------------------------------------------------------
TrendDir positionDir = TREND_NONE;
bool waitNextM15AfterBrokerExit = false;

// -------------------------------------------------------------
// TIMING
// -------------------------------------------------------------
datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

// -------------------------------------------------------------
// DIAGNOSTICS
// -------------------------------------------------------------
int regimeStarts = 0;
int regimeBreaks = 0;
int structurePromotions = 0;
int m5Breakouts = 0;
int m5Retests = 0;
int entries = 0;
int exits = 0;
int setupCancels = 0;
int lateEntryBlocks = 0;

string lastAction = "WAITING FOR M15 REGIME";
ulong lastPanelMs = 0;

// =============================================================
// HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V3] ", text);
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

   double total=0.0;
   int valid=0;

   for(int i=0;i<copied;i++)
   {
      double r=rates[i].high-rates[i].low;
      if(r>0.0)
      {
         total+=r;
         valid++;
      }
   }

   if(valid<=0)
      return false;

   out=total/valid;
   return true;
}

double NormalizeVolume(double requested)
{
   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maxVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);

   if(step<=0.0)
      step=minVol;

   double v=MathMax(minVol,MathMin(maxVol,requested));
   v=MathFloor((v-minVol+1e-12)/step)*step+minVol;

   int digits=2;
   if(step>0.0)
   {
      double lg=-MathLog10(step);
      digits=(lg>0.0 ? (int)MathCeil(lg) : 0);
      digits=MathMax(0,MathMin(8,digits));
   }

   return NormalizeDouble(v,digits);
}

double TickValue()
{
   double tv=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(tv>0.0)
      return tv;

   double p=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT);
   double l=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);

   if(p>0.0 && l>0.0)
      return (p+l)*0.5;

   return MathMax(p,l);
}

double CostDistance()
{
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return 0.0;

   double spread=MathMax(0.0,tick.ask-tick.bid);
   double commissionDistance=0.0;

   double tickSize=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tickValue=TickValue();

   if(tickSize>0.0 && tickValue>0.0)
   {
      double moneyPerPricePerLot=tickValue/tickSize;
      if(moneyPerPricePerLot>0.0)
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
   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;

   return FindOurPosition(ticket,type,openPrice);
}

void SyncPositionState()
{
   if(positionDir!=TREND_NONE && !HasPosition())
   {
      positionDir=TREND_NONE;
      waitNextM15AfterBrokerExit=true;
      exits++;
      lastAction="BROKER/EMERGENCY EXIT DETECTED -> WAIT NEXT CLOSED M15";
      Log(lastAction);
   }
}

void ResetSetup()
{
   setupStage=SETUP_IDLE;
   setupDir=TREND_NONE;
   breakoutLevel=0.0;
   breakoutTime=0;
   breakoutAnchorTime=0;
   retestLow=0.0;
   retestHigh=0.0;
   retestTime=0;
}

void ClearRawPivots()
{
   prevM15High=0.0;
   lastM15High=0.0;
   prevM15HighTime=0;
   lastM15HighTime=0;

   prevM15Low=0.0;
   lastM15Low=0.0;
   prevM15LowTime=0;
   lastM15LowTime=0;
}

bool CloseCurrentPosition(string reason)
{
   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;

   if(!FindOurPosition(ticket,type,openPrice))
      return false;

   if(!trade.PositionClose(ticket) || !TradeResultOK())
   {
      Log("CLOSE FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=TREND_NONE;
   exits++;
   lastAction=reason;
   Log(reason);
   return true;
}

// =============================================================
// M15 PIVOTS
// =============================================================
bool IsPivotHigh(ENUM_TIMEFRAMES tf,int centerShift,int wing,double &price,datetime &when)
{
   MqlRates center;
   if(!GetBar(tf,centerShift,center))
      return false;

   for(int k=1;k<=wing;k++)
   {
      MqlRates newerBar,olderBar;

      if(!GetBar(tf,centerShift-k,newerBar) ||
         !GetBar(tf,centerShift+k,olderBar))
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

      if(!GetBar(tf,centerShift-k,newerBar) ||
         !GetBar(tf,centerShift+k,olderBar))
         return false;

      if(center.low>=newerBar.low || center.low>=olderBar.low)
         return false;
   }

   price=center.low;
   when=center.time;
   return true;
}

void StoreM15High(double price,datetime when)
{
   if(when==lastM15HighTime)
      return;

   if(regime==TREND_NONE &&
      freshStructureAfter>0 &&
      when<=freshStructureAfter)
      return;

   prevM15High=lastM15High;
   prevM15HighTime=lastM15HighTime;

   lastM15High=price;
   lastM15HighTime=when;

   if(regime==TREND_SELL)
   {
      double minPromotion=avgM15Range*MathMax(0.0,MinPromotionStepM15RangeFrac);

      // Only a LOWER HIGH can become a sell continuation candidate.
      if(protectedStructure>0.0 &&
         when>structuralExtremeTime &&
         price<protectedStructure-minPromotion)
      {
         // During one pullback, keep the highest valid lower-high candidate.
         // That protects the full pullback, not a tiny late micro-pivot.
         if(candidateStructure<=0.0 || price>candidateStructure)
         {
            candidateStructure=price;
            candidateStructureTime=when;
            Log("SELL CANDIDATE LH FORMED -> waiting for new structural LL | candidate="+
                DoubleToString(candidateStructure,_Digits));
         }
      }
   }
}

void StoreM15Low(double price,datetime when)
{
   if(when==lastM15LowTime)
      return;

   if(regime==TREND_NONE &&
      freshStructureAfter>0 &&
      when<=freshStructureAfter)
      return;

   prevM15Low=lastM15Low;
   prevM15LowTime=lastM15LowTime;

   lastM15Low=price;
   lastM15LowTime=when;

   if(regime==TREND_BUY)
   {
      double minPromotion=avgM15Range*MathMax(0.0,MinPromotionStepM15RangeFrac);

      // Only a HIGHER LOW can become a buy continuation candidate.
      if(protectedStructure>0.0 &&
         when>structuralExtremeTime &&
         price>protectedStructure+minPromotion)
      {
         // During one pullback, keep the lowest valid higher-low candidate.
         // That protects the full pullback, not a tiny late micro-pivot.
         if(candidateStructure<=0.0 || price<candidateStructure)
         {
            candidateStructure=price;
            candidateStructureTime=when;
            Log("BUY CANDIDATE HL FORMED -> waiting for new structural HH | candidate="+
                DoubleToString(candidateStructure,_Digits));
         }
      }
   }
}

void DetectConfirmedM15PivotAtShift(int centerShift)
{
   int wing=MathMax(1,M15PivotWing);

   double hp=0.0;
   double lp=0.0;
   datetime ht=0;
   datetime lt=0;

   bool isHigh=IsPivotHigh(DirectionTF,centerShift,wing,hp,ht);
   bool isLow =IsPivotLow(DirectionTF,centerShift,wing,lp,lt);

   // Outside bar can qualify as both. Candle data does not prove order.
   if(isHigh && isLow)
      return;

   if(isHigh)
      StoreM15High(hp,ht);
   else if(isLow)
      StoreM15Low(lp,lt);
}

void SeedM15Structure()
{
   ClearRawPivots();

   int wing=MathMax(1,M15PivotWing);
   int oldest=MathMax(wing+2,M15SeedLookbackBars);

   for(int shift=oldest;shift>=wing+1;shift--)
      DetectConfirmedM15PivotAtShift(shift);
}

// =============================================================
// PERSISTENT M15 REGIME
// =============================================================
void StartBuyRegime(double protectedHL,double majorHigh,string reason)
{
   regime=TREND_BUY;
   protectedStructure=protectedHL;
   structuralExtreme=majorHigh;
   structuralExtremeTime=iTime(_Symbol,DirectionTF,1);
   candidateStructure=0.0;
   candidateStructureTime=0;
   regimeStartTime=TimeCurrent();
   freshStructureAfter=0;
   regimeStarts++;

   if(setupStage!=SETUP_IDLE)
      setupCancels++;
   ResetSetup();

   lastAction=reason;
   Log(reason+
       " | protected major HL="+DoubleToString(protectedStructure,_Digits)+
       " | structural high="+DoubleToString(structuralExtreme,_Digits));
}

void StartSellRegime(double protectedLH,double majorLow,string reason)
{
   regime=TREND_SELL;
   protectedStructure=protectedLH;
   structuralExtreme=majorLow;
   structuralExtremeTime=iTime(_Symbol,DirectionTF,1);
   candidateStructure=0.0;
   candidateStructureTime=0;
   regimeStartTime=TimeCurrent();
   freshStructureAfter=0;
   regimeStarts++;

   if(setupStage!=SETUP_IDLE)
      setupCancels++;
   ResetSetup();

   lastAction=reason;
   Log(reason+
       " | protected major LH="+DoubleToString(protectedStructure,_Digits)+
       " | structural low="+DoubleToString(structuralExtreme,_Digits));
}

void GoNeutralAfterBreak(string reason,datetime breakBarTime)
{
   if(HasPosition())
      CloseCurrentPosition(reason);

   regime=TREND_NONE;
   protectedStructure=0.0;
   structuralExtreme=0.0;
   candidateStructure=0.0;
   candidateStructureTime=0;
   structuralExtremeTime=0;
   regimeStartTime=0;
   freshStructureAfter=breakBarTime;
   waitNextM15AfterBrokerExit=false;
   regimeBreaks++;

   setupCancels++;
   ResetSetup();

   // Critical: opposite regime must now build FRESH structure.
   // Do not use pre-break pivot labels to reverse instantly.
   ClearRawPivots();

   lastAction=reason+" -> NEUTRAL, WAIT FRESH M15 STRUCTURE";
   Log(lastAction);
}

void TryEstablishRegimeFromPivots()
{
   if(regime!=TREND_NONE || HasPosition())
      return;

   if(avgM15Range<=0.0)
      AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);

   if(prevM15High<=0.0 || lastM15High<=0.0 ||
      prevM15Low<=0.0  || lastM15Low<=0.0)
      return;

   MqlRates b;
   if(!GetBar(DirectionTF,1,b))
      return;

   double minStep=
      avgM15Range*MathMax(0.0,MinM15StructureStepRangeFrac);

   double breakBuffer=
      avgM15Range*MathMax(0.0,M15BreakExitBufferRangeFrac);

   // Fresh BUY proof:
   // 1) a prior high exists,
   // 2) a higher low formed AFTER that high,
   // 3) a CLOSED M15 candle then breaks that high.
   bool buySequence =
      lastM15HighTime<lastM15LowTime &&
      lastM15Low>=prevM15Low+minStep &&
      b.close>lastM15High+breakBuffer;

   // Fresh SELL proof:
   // 1) a prior low exists,
   // 2) a lower high formed AFTER that low,
   // 3) a CLOSED M15 candle then breaks that low.
   bool sellSequence =
      lastM15LowTime<lastM15HighTime &&
      lastM15High<=prevM15High-minStep &&
      b.close<lastM15Low-breakBuffer;

   // At tester start, we may already be inside an established mountain.
   // Allow a seeded current-story inference, but only when price still sits
   // on the correct side of the latest protected structure.
   bool seededBuy =
      freshStructureAfter==0 &&
      lastM15High>=prevM15High+minStep &&
      lastM15Low >=prevM15Low +minStep &&
      b.close>lastM15Low;

   bool seededSell =
      freshStructureAfter==0 &&
      lastM15High<=prevM15High-minStep &&
      lastM15Low <=prevM15Low -minStep &&
      b.close<lastM15High;

   if(buySequence || seededBuy)
   {
      StartBuyRegime(
         lastM15Low,
         MathMax(lastM15High,b.high),
         buySequence ?
            "M15 BUY REGIME LOCKED -> HL + CLOSED BREAK ABOVE PRIOR HIGH" :
            "M15 BUY REGIME SEEDED -> EXISTING HH + HL STORY");
   }
   else if(sellSequence || seededSell)
   {
      StartSellRegime(
         lastM15High,
         MathMin(lastM15Low,b.low),
         sellSequence ?
            "M15 SELL REGIME LOCKED -> LH + CLOSED BREAK BELOW PRIOR LOW" :
            "M15 SELL REGIME SEEDED -> EXISTING LH + LL STORY");
   }
}

void ProcessPersistentRegime()
{
   if(avgM15Range<=0.0)
      AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);

   MqlRates b;
   if(!GetBar(DirectionTF,1,b))
      return;

   double exitBuffer=
      avgM15Range*MathMax(0.0,M15BreakExitBufferRangeFrac);

   if(regime==TREND_BUY)
   {
      // Only the confirmed major HL can end the BUY story.
      if(protectedStructure>0.0 &&
         b.close<protectedStructure-exitBuffer)
      {
         GoNeutralAfterBreak(
            "BUY MOUNTAIN ENDED -> CLOSED M15 BROKE CONFIRMED MAJOR HL",
            b.time);
         return;
      }

      // A candidate HL earns promotion only if price resumes and closes
      // above the prior structural high.
      if(candidateStructure>0.0 &&
         structuralExtreme>0.0 &&
         b.close>structuralExtreme+exitBuffer)
      {
         if(candidateStructure>protectedStructure)
         {
            protectedStructure=candidateStructure;
            structurePromotions++;

            Log("BUY CONTINUATION CONFIRMED -> NEW HH PROVED THE HL | protected major HL="+
                DoubleToString(protectedStructure,_Digits));
         }

         candidateStructure=0.0;
         candidateStructureTime=0;
         structuralExtreme=MathMax(structuralExtreme,b.high);
         structuralExtremeTime=b.time;
      }
      else if(candidateStructure<=0.0 &&
              structuralExtreme>0.0 &&
              b.close>structuralExtreme+exitBuffer)
      {
         // Impulse extension without a completed pullback.
         // Move the mountain high, but DO NOT move the protected HL.
         structuralExtreme=MathMax(structuralExtreme,b.high);
         structuralExtremeTime=b.time;
      }

      return;
   }

   if(regime==TREND_SELL)
   {
      // Only the confirmed major LH can end the SELL story.
      if(protectedStructure>0.0 &&
         b.close>protectedStructure+exitBuffer)
      {
         GoNeutralAfterBreak(
            "SELL MOUNTAIN ENDED -> CLOSED M15 BROKE CONFIRMED MAJOR LH",
            b.time);
         return;
      }

      // A candidate LH earns promotion only if price resumes and closes
      // below the prior structural low.
      if(candidateStructure>0.0 &&
         structuralExtreme>0.0 &&
         b.close<structuralExtreme-exitBuffer)
      {
         if(candidateStructure<protectedStructure)
         {
            protectedStructure=candidateStructure;
            structurePromotions++;

            Log("SELL CONTINUATION CONFIRMED -> NEW LL PROVED THE LH | protected major LH="+
                DoubleToString(protectedStructure,_Digits));
         }

         candidateStructure=0.0;
         candidateStructureTime=0;
         structuralExtreme=MathMin(structuralExtreme,b.low);
         structuralExtremeTime=b.time;
      }
      else if(candidateStructure<=0.0 &&
              structuralExtreme>0.0 &&
              b.close<structuralExtreme-exitBuffer)
      {
         // Impulse extension without a completed pullback.
         // Move the mountain low, but DO NOT move the protected LH.
         structuralExtreme=MathMin(structuralExtreme,b.low);
         structuralExtremeTime=b.time;
      }

      return;
   }

   TryEstablishRegimeFromPivots();
}

// =============================================================
// M5 MAP
// =============================================================
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
   if(HasPosition() ||
      waitNextM15AfterBrokerExit ||
      setupStage!=SETUP_IDLE ||
      regime==TREND_NONE)
      return;

   if(!AvgRange(MapTF,1,M5RangeLookback,avgM5Range) ||
      avgM5Range<=0.0)
      return;

   MqlRates breakoutBar;
   if(!GetBar(MapTF,1,breakoutBar))
      return;

   double buffer=
      MathMax(avgM5Range*MathMax(0.0,M5BreakoutBufferRangeFrac),
              CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(regime==TREND_BUY)
   {
      double level=0.0;
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

         lastAction="M5 BUY BREAKOUT -> WAIT RETEST";
         Log(lastAction+" | level="+DoubleToString(level,_Digits));
      }
   }
   else if(regime==TREND_SELL)
   {
      double level=0.0;
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

         lastAction="M5 SELL BREAKOUT -> WAIT RETEST";
         Log(lastAction+" | level="+DoubleToString(level,_Digits));
      }
   }
}

void ProcessM5Retest()
{
   if(HasPosition() || setupStage==SETUP_IDLE)
      return;

   if(regime!=setupDir || regime==TREND_NONE)
   {
      setupCancels++;
      lastAction="SETUP CANCELLED -> PERSISTENT M15 REGIME NO LONGER AGREES";
      Log(lastAction);
      ResetSetup();
      return;
   }

   if(BreakoutExpiryMinutes>0 &&
      TimeCurrent()-breakoutTime>BreakoutExpiryMinutes*60)
   {
      setupCancels++;
      lastAction="M5 BREAKOUT EXPIRED";
      Log(lastAction);
      ResetSetup();
      return;
   }

   if(!AvgRange(MapTF,1,M5RangeLookback,avgM5Range) ||
      avgM5Range<=0.0)
      return;

   MqlRates b;
   if(!GetBar(MapTF,1,b))
      return;

   if(b.time<=breakoutTime)
      return;

   double zone=
      avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);

   double maxDepth=
      avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

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

            lastAction="M5 BUY RETEST HELD -> WAIT M1 PULLBACK BREAK";
            Log(lastAction+" | retestLow="+DoubleToString(retestLow,_Digits));
         }
         else if(b.close<breakoutLevel-maxDepth)
         {
            setupCancels++;
            lastAction="BUY BREAKOUT FAILED -> M5 LOST LEVEL";
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

            lastAction="M5 SELL RETEST HELD -> WAIT M1 PULLBACK BREAK";
            Log(lastAction+" | retestHigh="+DoubleToString(retestHigh,_Digits));
         }
         else if(b.close>breakoutLevel+maxDepth)
         {
            setupCancels++;
            lastAction="SELL BREAKOUT FAILED -> M5 LOST LEVEL";
            Log(lastAction);
            ResetSetup();
         }
      }

      return;
   }

   if(setupStage==WAIT_M1_CONFIRM)
   {
      if(RetestExpiryMinutes>0 &&
         TimeCurrent()-retestTime>RetestExpiryMinutes*60)
      {
         setupCancels++;
         lastAction="M5 RETEST EXPIRED WITHOUT M1 CONFIRM";
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
            lastAction="BUY RETEST FAILED BEFORE ENTRY";
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
            lastAction="SELL RETEST FAILED BEFORE ENTRY";
            Log(lastAction);
            ResetSetup();
         }
      }
   }
}

// =============================================================
// M1 ENTRY
// =============================================================
double HighestM1High(int startShift,int count)
{
   MqlRates rates[];
   int copied=CopyRates(_Symbol,EntryTF,startShift,count,rates);
   if(copied!=count)
      return 0.0;

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
      return 0.0;

   double low=rates[0].low;

   for(int i=1;i<copied;i++)
      if(rates[i].low<low)
         low=rates[i].low;

   return low;
}

double EmergencySLForEntry(TrendDir dir)
{
   if(!UseEmergencyBrokerSL ||
      protectedStructure<=0.0 ||
      avgM15Range<=0.0)
      return 0.0;

   double extra=
      avgM15Range*MathMax(0.0,EmergencySLBeyondProtectedM15RangeFrac);

   extra=MathMax(extra,
                 CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(dir==TREND_BUY)
      return NormalizeDouble(protectedStructure-extra,_Digits);

   return NormalizeDouble(protectedStructure+extra,_Digits);
}

bool OpenMountainTrade(TrendDir dir)
{
   if(HasPosition() ||
      setupStage!=WAIT_M1_CONFIRM ||
      avgM5Range<=0.0 ||
      dir!=regime ||
      protectedStructure<=0.0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(dir==TREND_BUY ? tick.ask : tick.bid);

   double distanceFromBreak=MathAbs(entry-breakoutLevel);
   double maxDistance=
      avgM5Range*MathMax(0.0,MaxEntryDistanceFromBreakM5RangeFrac);

   if(distanceFromBreak>maxDistance)
   {
      lateEntryBlocks++;
      lastAction="ENTRY BLOCKED -> MOVE TOO FAR FROM RETEST";
      Log(lastAction);
      ResetSetup();
      return false;
   }

   double sl=EmergencySLForEntry(dir);

   // Never let an emergency structural stop invalidate an otherwise valid
   // order if the seeded structure is unexpectedly on the wrong side.
   if(sl>0.0)
   {
      if((dir==TREND_BUY && sl>=entry) ||
         (dir==TREND_SELL && sl<=entry))
      {
         Log("EMERGENCY SL SKIPPED -> STRUCTURAL LEVEL NOT ON SAFE SIDE OF ENTRY");
         sl=0.0;
      }
   }

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(dir==TREND_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V3_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V3_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=dir;

   if(dir==TREND_BUY)
      consumedBuyAnchor=breakoutAnchorTime;
   else
      consumedSellAnchor=breakoutAnchorTime;

   entries++;

   string side=(dir==TREND_BUY ? "BUY" : "SELL");
   lastAction=side+" OPENED -> PERSISTENT M15 REGIME OWNS HOLD";

   Log(lastAction+
       " | protected major structure="+DoubleToString(protectedStructure,_Digits)+
       " | emergencySL="+DoubleToString(sl,_Digits));

   ResetSetup();
   return true;
}

void ProcessM1Confirmation()
{
   if(HasPosition() ||
      setupStage!=WAIT_M1_CONFIRM ||
      setupDir==TREND_NONE)
      return;

   if(regime!=setupDir)
   {
      setupCancels++;
      lastAction="ENTRY CANCELLED -> M15 REGIME CHANGED";
      Log(lastAction);
      ResetSetup();
      return;
   }

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   if(signal.time<=retestTime)
      return;

   int lookback=MathMax(2,M1ConfirmationLookback);

   double confirmDistance=
      MathMax(avgM5Range*MathMax(0.0,MinM1ConfirmationMoveM5RangeFrac),
              CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(setupDir==TREND_BUY)
   {
      double pullbackHigh=HighestM1High(2,lookback);
      if(pullbackHigh<=0.0)
         return;

      bool aboveBreakout=(signal.close>breakoutLevel);
      bool breaksPullback=(signal.close>pullbackHigh);
      bool enoughRecovery=(signal.close-retestLow>=confirmDistance);
      bool bullishClose=(signal.close>signal.open);

      if(aboveBreakout &&
         breaksPullback &&
         enoughRecovery &&
         bullishClose)
         OpenMountainTrade(TREND_BUY);
   }
   else if(setupDir==TREND_SELL)
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0.0)
         return;

      bool belowBreakout=(signal.close<breakoutLevel);
      bool breaksPullback=(signal.close<pullbackLow);
      bool enoughRecovery=(retestHigh-signal.close>=confirmDistance);
      bool bearishClose=(signal.close<signal.open);

      if(belowBreakout &&
         breaksPullback &&
         enoughRecovery &&
         bearishClose)
         OpenMountainTrade(TREND_SELL);
   }
}

// =============================================================
// NEW BAR EVENTS
// =============================================================
void OnNewM15()
{
   datetime current=iTime(_Symbol,DirectionTF,0);

   if(current<=0 || current==lastM15Bar)
      return;

   lastM15Bar=current;

   AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);

   int center=MathMax(1,M15PivotWing)+1;
   DetectConfirmedM15PivotAtShift(center);

   ProcessPersistentRegime();

   // If an emergency broker stop happened intrabar, do not allow a new
   // entry until this closed M15 bar has had a chance to judge the regime.
   waitNextM15AfterBrokerExit=false;
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

// =============================================================
// PANEL
// =============================================================
string RegimeText()
{
   if(regime==TREND_BUY)
      return "BUY REGIME LOCKED";
   if(regime==TREND_SELL)
      return "SELL REGIME LOCKED";

   return "NEUTRAL - BUILD FRESH STRUCTURE";
}

string SetupText()
{
   if(setupStage==WAIT_M5_RETEST)
      return "WAIT M5 RETEST";

   if(setupStage==WAIT_M1_CONFIRM)
      return "M5 RETEST HELD -> WAIT M1";

   return "IDLE";
}

void Panel()
{
   ulong now=GetTickCount64();

   if(lastPanelMs>0 &&
      now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))
      return;

   lastPanelMs=now;

   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   string position="NONE";

   if(FindOurPosition(ticket,type,openPrice))
      position=(type==POSITION_TYPE_BUY ? "BUY" : "SELL");

   Comment(
      "SIMPLE MOUNTAIN RIDER V3 - PERSISTENT REGIME\n",
      "POSITION: ",position,"\n",
      "M15 STORY: ",RegimeText(),"\n",
      "PROTECTED MAJOR STRUCTURE: ",
         DoubleToString(protectedStructure,_Digits),"\n",
      "STRUCTURAL EXTREME TO BEAT: ",
         DoubleToString(structuralExtreme,_Digits),"\n",
      "CANDIDATE HL/LH: ",
         DoubleToString(candidateStructure,_Digits),"\n",
      "RAW M15 HIGHS: ",
         DoubleToString(prevM15High,_Digits)," -> ",
         DoubleToString(lastM15High,_Digits),"\n",
      "RAW M15 LOWS: ",
         DoubleToString(prevM15Low,_Digits)," -> ",
         DoubleToString(lastM15Low,_Digits),"\n",
      "M5 SETUP: ",SetupText(),"\n",
      "BREAKOUT LEVEL: ",DoubleToString(breakoutLevel,_Digits),"\n",
      "M5 RETEST LOW/HIGH: ",
         DoubleToString(retestLow,_Digits)," / ",
         DoubleToString(retestHigh,_Digits),"\n",
      "M15 AVG RANGE: ",DoubleToString(avgM15Range,2),
         " | M5 AVG RANGE: ",DoubleToString(avgM5Range,2),"\n",
      "REGIME STARTS: ",IntegerToString(regimeStarts),
         " | BREAKS: ",IntegerToString(regimeBreaks),
         " | PROMOTIONS: ",IntegerToString(structurePromotions),"\n",
      "BREAKOUTS: ",IntegerToString(m5Breakouts),
         " | RETESTS: ",IntegerToString(m5Retests),
         " | ENTRIES: ",IntegerToString(entries),
         " | EXITS: ",IntegerToString(exits),"\n",
      "CANCELS: ",IntegerToString(setupCancels),
         " | LATE BLOCKS: ",IntegerToString(lateEntryBlocks),"\n",
      "LAST: ",lastAction
   );
}

// =============================================================
// INIT / DEINIT / TICK
// =============================================================
int OnInit()
{
   if(DirectionTF!=PERIOD_M15 ||
      MapTF!=PERIOD_M5 ||
      EntryTF!=PERIOD_M1)
      return INIT_PARAMETERS_INCORRECT;

   if(M15PivotWing<1 || M15PivotWing>12)
      return INIT_PARAMETERS_INCORRECT;

   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);
   AvgRange(MapTF,1,M5RangeLookback,avgM5Range);

   // Seed only once. After a regime break, V3 intentionally rebuilds
   // fresh structure instead of reusing old pre-break pivots.
   SeedM15Structure();

   regime=TREND_NONE;
   protectedStructure=0.0;
   structuralExtreme=0.0;
   candidateStructure=0.0;
   candidateStructureTime=0;
   structuralExtremeTime=0;
   freshStructureAfter=0;
   waitNextM15AfterBrokerExit=false;

   TryEstablishRegimeFromPivots();
   ResetSetup();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   Log("INIT SIMPLE MOUNTAIN RIDER V3 - PERSISTENT REGIME");
   Log("M15 STORY STAYS LOCKED UNTIL CONFIRMED MAJOR HL/LH BREAKS.");
   Log("NEW HL/LH IS NOT PROMOTED UNTIL A NEW HH/LL PROVES IT.");
   Log("M5 MAP + M1 TRIGGER. NO TP. NORMAL EXIT = CLOSED M15 STRUCTURE BREAK.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");

   Log("DEINIT V3 | regimeStarts="+IntegerToString(regimeStarts)+
       " | regimeBreaks="+IntegerToString(regimeBreaks)+
       " | promotions="+IntegerToString(structurePromotions)+
       " | entries="+IntegerToString(entries)+
       " | exits="+IntegerToString(exits));
}

void OnTick()
{
   SyncPositionState();

   OnNewM15();
   OnNewM5();
   OnNewM1();

   Panel();
}
