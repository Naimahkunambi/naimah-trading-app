#property strict
#property version "5.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// SIMPLE MOUNTAIN RIDER V5 - EXACT STORY / RETEST / FIB
// =============================================================
// THIS VERSION CHANGES THE LOSS ENGINE, NOT JUST THE LABELS.
//
// M15 TELLS THE STORY AND DEFINES THE ACTUAL LEVEL.
// BUY STORY:
//      H1 -> L1 -> H2 -> L2
//      H2 > H1 and L2 > L1
//      H2 is THE level price must break and later retest.
//
// SELL STORY:
//      L1 -> H1 -> L2 -> H2
//      L2 < L1 and H2 < H1
//      L2 is THE level price must break and later retest.
//
// M5 DOES NOT INVENT A DIFFERENT BREAKOUT.
// It watches the exact M15 HH/LL story level.
// Closed M5 breaks it -> NO ENTRY -> wait for retest.
// Closed M5 retests it and holds -> M1 is allowed to trigger.
//
// M1 PULLS THE TRIGGER.
// Closed M1 must resume from the retest and break the short pullback.
// Entry is blocked if already too far from the M15 story level.
//
// ONE M15 LEG = ONE CHANCE.
// Once M5 breaks that M15 level, the leg is consumed whether the setup
// wins, loses, expires or fails. No repeated commission-churn on one story.
// A new opportunity requires a genuinely NEW M15 HH+HL / LL+LH leg.
//
// STOP:
// Below/above the full M5 retest extreme with breathing room.
//
// FIB:
// A = M15 pullback HL/LH that launched the breakout attempt.
// B = actual M5 breakout extension extreme before the retest.
// C = M5 retest HL/LH.
// TP1=1.272, TP2=1.618, TP3=2.000 by default.
//
// At 0.01 lot TP1/TP2 are milestones because the position cannot be split.
// TP3 CAN close the full minimum-lot position so Fib actually changes results.
// At larger volume TP1/TP2/TP3 can take partials and leave a runner.
//
// FINAL RUNNER:
// If volume remains after Fib partials, exit only on a CLOSED M15 break of
// the protected major HL/LH.
// =============================================================

#define MAX_SWINGS 40

struct SwingPoint
{
   int type;          // +1 high, -1 low
   double price;
   datetime time;
};

enum TrendDir
{
   DIR_NONE = 0,
   DIR_BUY  = 1,
   DIR_SELL = -1
};

enum SetupStage
{
   STAGE_IDLE = 0,
   STAGE_WAIT_M5_RETEST = 1,
   STAGE_WAIT_M1_TRIGGER = 2
};

// ---------- EXECUTION ----------
input double Lots = 0.01;
input ulong Magic = 260909005;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// ---------- M15 STORY ----------
input int M15PivotWing = 3;
input int M15SeedLookbackBars = 320;
input int M15RangeLookback = 12;
input double MinM15HHHLStepRangeFrac = 0.15;
input double M15StructureExitBufferRangeFrac = 0.10;

// ---------- M5 EXACT RETEST OF M15 LEVEL ----------
input int M5RangeLookback = 12;
input double M5BreakBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.75;
input int BreakoutExpiryMinutes = 180;
input int RetestExpiryMinutes = 75;

// ---------- M1 SNIPER ----------
input int M1PullbackBreakLookback = 3;
input double MinM1RecoveryM5RangeFrac = 0.20;
input double MaxEntryDistanceFromStoryLevelM5RangeFrac = 0.85;

// ---------- STOP ----------
input double StopBreathingM5RangeFrac = 0.40;

// ---------- FIB EXTENSIONS ----------
input double FibTP1 = 1.272;
input double FibTP2 = 1.618;
input double FibTP3 = 2.000;

input bool UseFibTargets = true;
input double TP1PartialPercent = 25.0;
input double TP2PartialPercent = 25.0;
input double TP3PartialPercent = 25.0;
input bool CloseWholeAtTP3WhenVolumeCannotSplit = true;

// ---------- COST ----------
input double CommissionPerLotRT = 58.0;
input double CostSafetyMultiple = 1.25;
input int ExpectedSlippagePoints = 0;

input int PanelUpdateMilliseconds = 500;
input bool VerboseLog = true;

// =============================================================
// STATE
// =============================================================
SwingPoint m15Swings[MAX_SWINGS];
int m15SwingCount = 0;

TrendDir storyDir = DIR_NONE;
double storyLevel = 0.0;             // exact M15 HH/LL to break/retest
double storyLaunchPoint = 0.0;       // latest M15 HL/LH before breakout
double protectedM15Structure = 0.0;  // final runner structure exit

datetime storySwingTime = 0;         // newest HL/LH making this leg unique
bool storyLegConsumed = false;

SetupStage setupStage = STAGE_IDLE;
datetime m5BreakoutTime = 0;

double retestLow = 0.0;
double retestHigh = 0.0;
datetime retestConfirmTime = 0;

double fibA = 0.0;
double fibB = 0.0;
double fibC = 0.0;

double tp1Price = 0.0;
double tp2Price = 0.0;
double tp3Price = 0.0;
bool tp1Hit = false;
bool tp2Hit = false;
bool tp3Hit = false;

double initialPositionVolume = 0.0;
TrendDir positionDir = DIR_NONE;

double avgM15Range = 0.0;
double avgM5Range = 0.0;

datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

int storyLegs = 0;
int breakouts = 0;
int retests = 0;
int entries = 0;
int exits = 0;
int stopsOrBrokerExits = 0;
int partials = 0;
int cancelledSetups = 0;
int lateBlocks = 0;

string lastAction = "WAITING FOR M15 STORY";
ulong lastPanelMs = 0;

// =============================================================
// HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V5] ",text);
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
   double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(v>0.0)
      return v;

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

bool FindOurPosition(ulong &ticket,ENUM_POSITION_TYPE &type,double &openPrice,double &volume)
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
      volume=PositionGetDouble(POSITION_VOLUME);
      return true;
   }

   return false;
}

bool HasPosition()
{
   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   double volume=0.0;

   return FindOurPosition(ticket,type,openPrice,volume);
}

void ResetSetup()
{
   setupStage=STAGE_IDLE;
   m5BreakoutTime=0;

   retestLow=0.0;
   retestHigh=0.0;
   retestConfirmTime=0;

   fibA=0.0;
   fibB=0.0;
   fibC=0.0;
}

void ResetPositionTargets()
{
   positionDir=DIR_NONE;
   initialPositionVolume=0.0;

   tp1Price=0.0;
   tp2Price=0.0;
   tp3Price=0.0;

   tp1Hit=false;
   tp2Hit=false;
   tp3Hit=false;
}

bool CloseCurrentPosition(string reason)
{
   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   double volume=0.0;

   if(!FindOurPosition(ticket,type,openPrice,volume))
      return false;

   if(!trade.PositionClose(ticket) || !TradeResultOK())
   {
      Log("CLOSE FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   exits++;
   lastAction=reason;
   Log(reason);
   ResetPositionTargets();
   return true;
}

void SyncPositionState()
{
   if(positionDir!=DIR_NONE && !HasPosition())
   {
      stopsOrBrokerExits++;
      exits++;
      lastAction="POSITION CLOSED BY STRUCTURAL SL/BROKER";
      Log(lastAction);
      ResetPositionTargets();
   }
}

// =============================================================
// M15 SWINGS
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

void AddM15Swing(int type,double price,datetime when)
{
   if(m15SwingCount>0 && m15Swings[m15SwingCount-1].time==when)
      return;

   // Consecutive same-type pivots are compressed into the more extreme one.
   if(m15SwingCount>0 && m15Swings[m15SwingCount-1].type==type)
   {
      bool replace=(type>0 ? price>m15Swings[m15SwingCount-1].price
                           : price<m15Swings[m15SwingCount-1].price);

      if(replace)
      {
         m15Swings[m15SwingCount-1].price=price;
         m15Swings[m15SwingCount-1].time=when;
      }
      return;
   }

   if(m15SwingCount<MAX_SWINGS)
   {
      m15Swings[m15SwingCount].type=type;
      m15Swings[m15SwingCount].price=price;
      m15Swings[m15SwingCount].time=when;
      m15SwingCount++;
      return;
   }

   for(int i=1;i<MAX_SWINGS;i++)
      m15Swings[i-1]=m15Swings[i];

   m15Swings[MAX_SWINGS-1].type=type;
   m15Swings[MAX_SWINGS-1].price=price;
   m15Swings[MAX_SWINGS-1].time=when;
}

void DetectM15PivotAtShift(int centerShift)
{
   int wing=MathMax(1,M15PivotWing);

   double hp=0.0,lp=0.0;
   datetime ht=0,lt=0;

   bool high=IsPivotHigh(DirectionTF,centerShift,wing,hp,ht);
   bool low =IsPivotLow(DirectionTF,centerShift,wing,lp,lt);

   // Do not invent sequencing for an outside bar.
   if(high && low)
      return;

   if(high)
      AddM15Swing(1,hp,ht);
   else if(low)
      AddM15Swing(-1,lp,lt);
}

void SeedM15Swings()
{
   m15SwingCount=0;

   int wing=MathMax(1,M15PivotWing);
   int oldest=MathMax(wing+2,M15SeedLookbackBars);

   for(int shift=oldest;shift>=wing+1;shift--)
      DetectM15PivotAtShift(shift);
}

bool LatestFourM15(SwingPoint &s1,SwingPoint &s2,SwingPoint &s3,SwingPoint &s4)
{
   if(m15SwingCount<4)
      return false;

   s1=m15Swings[m15SwingCount-4];
   s2=m15Swings[m15SwingCount-3];
   s3=m15Swings[m15SwingCount-2];
   s4=m15Swings[m15SwingCount-1];
   return true;
}

// =============================================================
// M15 STORY
// =============================================================
void ArmNewStoryLeg(TrendDir dir,double level,double launchPoint,double protectedLevel,datetime uniqueSwingTime)
{
   bool genuinelyNew=(uniqueSwingTime!=storySwingTime ||
                      dir!=storyDir ||
                      MathAbs(level-storyLevel)>_Point);

   if(!genuinelyNew)
      return;

   storyDir=dir;
   storyLevel=level;
   storyLaunchPoint=launchPoint;
   protectedM15Structure=protectedLevel;
   storySwingTime=uniqueSwingTime;
   storyLegConsumed=false;
   storyLegs++;

   if(setupStage!=STAGE_IDLE)
   {
      cancelledSetups++;
      ResetSetup();
   }

   if(dir==DIR_BUY)
      lastAction="NEW M15 BUY LEG -> WAIT M5 BREAK OF EXACT M15 HH";
   else
      lastAction="NEW M15 SELL LEG -> WAIT M5 BREAK OF EXACT M15 LL";

   Log(lastAction+
       " | STORY LEVEL="+DoubleToString(storyLevel,_Digits)+
       " | PROTECTED="+DoubleToString(protectedM15Structure,_Digits));
}

void EndM15Story(string reason)
{
   if(HasPosition())
      CloseCurrentPosition(reason);

   storyDir=DIR_NONE;
   storyLevel=0.0;
   storyLaunchPoint=0.0;
   protectedM15Structure=0.0;
   storySwingTime=0;
   storyLegConsumed=false;

   cancelledSetups++;
   ResetSetup();

   lastAction=reason+" -> WAIT FRESH M15 STORY";
   Log(lastAction);
}

void EvaluateM15Story()
{
   if(avgM15Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   // Persistent-story exit first. Small M1/M5 pullbacks do not matter.
   double exitBuffer=avgM15Range*MathMax(0.0,M15StructureExitBufferRangeFrac);

   if(storyDir==DIR_BUY && protectedM15Structure>0.0)
   {
      if(closed.close<protectedM15Structure-exitBuffer)
      {
         EndM15Story("BUY MOUNTAIN ENDED -> CLOSED M15 BROKE MAJOR HL");
         return;
      }
   }
   else if(storyDir==DIR_SELL && protectedM15Structure>0.0)
   {
      if(closed.close>protectedM15Structure+exitBuffer)
      {
         EndM15Story("SELL MOUNTAIN ENDED -> CLOSED M15 BROKE MAJOR LH");
         return;
      }
   }

   SwingPoint s1,s2,s3,s4;
   if(!LatestFourM15(s1,s2,s3,s4))
      return;

   double step=avgM15Range*MathMax(0.0,MinM15HHHLStepRangeFrac);

   // BUY STORY READY FOR NEXT BREAKOUT:
   // H1 -> L1 -> H2 -> L2, with H2 higher and L2 higher.
   // M5 must now break/retest H2. M5 may NOT invent another level.
   bool buyPattern=(s1.type==1 && s2.type==-1 && s3.type==1 && s4.type==-1);

   if(buyPattern)
   {
      bool higherHigh=(s3.price>=s1.price+step);
      bool higherLow =(s4.price>=s2.price+step);

      if(higherHigh && higherLow)
      {
         ArmNewStoryLeg(
            DIR_BUY,
            s3.price,   // exact M15 HH to break and retest
            s4.price,   // latest M15 HL launching next attempt
            s4.price,   // major protected HL
            s4.time);
         return;
      }
   }

   // SELL STORY READY FOR NEXT BREAKOUT:
   // L1 -> H1 -> L2 -> H2, with L2 lower and H2 lower.
   bool sellPattern=(s1.type==-1 && s2.type==1 && s3.type==-1 && s4.type==1);

   if(sellPattern)
   {
      bool lowerLow =(s3.price<=s1.price-step);
      bool lowerHigh=(s4.price<=s2.price-step);

      if(lowerLow && lowerHigh)
      {
         ArmNewStoryLeg(
            DIR_SELL,
            s3.price,   // exact M15 LL to break and retest
            s4.price,   // latest M15 LH launching next attempt
            s4.price,   // major protected LH
            s4.time);
         return;
      }
   }

   // If the current mountain remains valid but the latest four swings are
   // temporarily mixed, KEEP the existing story. Do not flip to neutral.
}

// =============================================================
// M5 MAPS THE EXACT M15 STORY LEVEL
// =============================================================
void LookForExactM15LevelBreak()
{
   if(HasPosition() ||
      setupStage!=STAGE_IDLE ||
      storyDir==DIR_NONE ||
      storyLegConsumed ||
      avgM5Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   double buffer=MathMax(
      avgM5Range*MathMax(0.0,M5BreakBufferRangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY)
   {
      if(closed.close>storyLevel+buffer)
      {
         setupStage=STAGE_WAIT_M5_RETEST;
         storyLegConsumed=true; // one M15 leg gets only one breakout attempt
         m5BreakoutTime=closed.time;

         fibA=storyLaunchPoint;
         fibB=closed.high;
         fibC=0.0;

         breakouts++;
         lastAction="M5 BROKE EXACT M15 HH -> NO CHASE / WAIT RETEST";
         Log(lastAction+
             " | M15 HH="+DoubleToString(storyLevel,_Digits));
      }
   }
   else if(storyDir==DIR_SELL)
   {
      if(closed.close<storyLevel-buffer)
      {
         setupStage=STAGE_WAIT_M5_RETEST;
         storyLegConsumed=true; // one M15 leg gets only one breakout attempt
         m5BreakoutTime=closed.time;

         fibA=storyLaunchPoint;
         fibB=closed.low;
         fibC=0.0;

         breakouts++;
         lastAction="M5 BROKE EXACT M15 LL -> NO CHASE / WAIT RETEST";
         Log(lastAction+
             " | M15 LL="+DoubleToString(storyLevel,_Digits));
      }
   }
}

void ProcessExactM15LevelRetest()
{
   if(HasPosition() || setupStage==STAGE_IDLE || storyDir==DIR_NONE)
      return;

   if(avgM5Range<=0.0)
      return;

   if(BreakoutExpiryMinutes>0 &&
      TimeCurrent()-m5BreakoutTime>BreakoutExpiryMinutes*60)
   {
      cancelledSetups++;
      lastAction="M15 STORY BREAKOUT EXPIRED -> LEG REMAINS CONSUMED";
      Log(lastAction);
      ResetSetup();
      return;
   }

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   if(closed.time<=m5BreakoutTime)
      return;

   // Keep B as the actual breakout extension extreme BEFORE C/retest.
   if(setupStage==STAGE_WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY && closed.high>fibB)
         fibB=closed.high;

      if(storyDir==DIR_SELL && (fibB<=0.0 || closed.low<fibB))
         fibB=closed.low;
   }

   double zone=avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(setupStage==STAGE_WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY)
      {
         bool visitedStoryLevel=(closed.low<=storyLevel+zone);
         bool didNotCollapse=(closed.low>=storyLevel-maxDepth);
         bool closedHolding=(closed.close>=storyLevel);

         if(visitedStoryLevel && didNotCollapse && closedHolding)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            fibC=retestLow;
            retestConfirmTime=TimeCurrent();
            setupStage=STAGE_WAIT_M1_TRIGGER;
            retests++;

            lastAction="M5 RETESTED M15 HH AND HELD -> NEW HL / WAIT M1";
            Log(lastAction+
                " | C="+DoubleToString(fibC,_Digits));
         }
         else if(closed.close<storyLevel-maxDepth)
         {
            cancelledSetups++;
            lastAction="BUY RETEST FAILED -> CLOSED M5 LOST M15 HH";
            Log(lastAction);
            ResetSetup();
         }
      }
      else
      {
         bool visitedStoryLevel=(closed.high>=storyLevel-zone);
         bool didNotCollapse=(closed.high<=storyLevel+maxDepth);
         bool closedHolding=(closed.close<=storyLevel);

         if(visitedStoryLevel && didNotCollapse && closedHolding)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            fibC=retestHigh;
            retestConfirmTime=TimeCurrent();
            setupStage=STAGE_WAIT_M1_TRIGGER;
            retests++;

            lastAction="M5 RETESTED M15 LL AND HELD -> NEW LH / WAIT M1";
            Log(lastAction+
                " | C="+DoubleToString(fibC,_Digits));
         }
         else if(closed.close>storyLevel+maxDepth)
         {
            cancelledSetups++;
            lastAction="SELL RETEST FAILED -> CLOSED M5 LOST M15 LL";
            Log(lastAction);
            ResetSetup();
         }
      }

      return;
   }

   if(setupStage==STAGE_WAIT_M1_TRIGGER)
   {
      if(RetestExpiryMinutes>0 &&
         TimeCurrent()-retestConfirmTime>RetestExpiryMinutes*60)
      {
         cancelledSetups++;
         lastAction="RETEST EXPIRED WITHOUT M1 SNIPER -> LEG REMAINS CONSUMED";
         Log(lastAction);
         ResetSetup();
         return;
      }

      // Let the full M5 retest breathe before entry. If it deepens but still
      // holds the M15 story level, C and the future SL move with that retest.
      if(storyDir==DIR_BUY)
      {
         if(closed.low<retestLow)
         {
            retestLow=closed.low;
            fibC=retestLow;
         }

         if(closed.high>retestHigh)
            retestHigh=closed.high;

         if(closed.close<storyLevel-maxDepth)
         {
            cancelledSetups++;
            lastAction="BUY RETEST STRUCTURE FAILED BEFORE ENTRY";
            Log(lastAction);
            ResetSetup();
         }
      }
      else
      {
         if(closed.high>retestHigh)
         {
            retestHigh=closed.high;
            fibC=retestHigh;
         }

         if(closed.low<retestLow)
            retestLow=closed.low;

         if(closed.close>storyLevel+maxDepth)
         {
            cancelledSetups++;
            lastAction="SELL RETEST STRUCTURE FAILED BEFORE ENTRY";
            Log(lastAction);
            ResetSetup();
         }
      }
   }
}

// =============================================================
// M1 SNIPER
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

void BuildFibTargets()
{
   double impulse=MathAbs(fibB-fibA);

   if(impulse<=0.0 || fibC<=0.0)
   {
      tp1Price=0.0;
      tp2Price=0.0;
      tp3Price=0.0;
      return;
   }

   if(storyDir==DIR_BUY)
   {
      tp1Price=fibC+impulse*MathMax(0.0,FibTP1);
      tp2Price=fibC+impulse*MathMax(0.0,FibTP2);
      tp3Price=fibC+impulse*MathMax(0.0,FibTP3);
   }
   else
   {
      tp1Price=fibC-impulse*MathMax(0.0,FibTP1);
      tp2Price=fibC-impulse*MathMax(0.0,FibTP2);
      tp3Price=fibC-impulse*MathMax(0.0,FibTP3);
   }
}

bool OpenSniperTrade()
{
   if(HasPosition() ||
      setupStage!=STAGE_WAIT_M1_TRIGGER ||
      storyDir==DIR_NONE ||
      avgM5Range<=0.0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(storyDir==DIR_BUY ? tick.ask : tick.bid);

   double maxDistance=
      avgM5Range*MathMax(0.0,MaxEntryDistanceFromStoryLevelM5RangeFrac);

   if(MathAbs(entry-storyLevel)>maxDistance)
   {
      lateBlocks++;
      lastAction="NO TRADE -> M1 CONFIRMED TOO LATE / TOO FAR FROM M15 LEVEL";
      Log(lastAction);
      ResetSetup();
      return false;
   }

   double breathing=MathMax(
      avgM5Range*MathMax(0.0,StopBreathingM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   double sl=(storyDir==DIR_BUY ? retestLow-breathing
                               : retestHigh+breathing);

   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(storyDir==DIR_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V5_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V5_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=storyDir;
   initialPositionVolume=volume;
   tp1Hit=false;
   tp2Hit=false;
   tp3Hit=false;

   BuildFibTargets();

   entries++;

   lastAction=(storyDir==DIR_BUY ? "BUY" : "SELL")+
              string(" SNIPER OPEN -> ONE TRADE FOR THIS M15 LEG");

   Log(lastAction+
       " | SL="+DoubleToString(sl,_Digits)+
       " | FIB A="+DoubleToString(fibA,_Digits)+
       " B="+DoubleToString(fibB,_Digits)+
       " C="+DoubleToString(fibC,_Digits)+
       " | TP1="+DoubleToString(tp1Price,_Digits)+
       " TP2="+DoubleToString(tp2Price,_Digits)+
       " TP3="+DoubleToString(tp3Price,_Digits));

   // Keep Fib A/B/C in the position target state; only clear setup timing.
   setupStage=STAGE_IDLE;
   m5BreakoutTime=0;
   retestLow=0.0;
   retestHigh=0.0;
   retestConfirmTime=0;

   return true;
}

void ProcessM1Trigger()
{
   if(HasPosition() ||
      setupStage!=STAGE_WAIT_M1_TRIGGER ||
      storyDir==DIR_NONE)
      return;

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   // Retest was confirmed at the M5 close. Do not reuse an earlier M1 bar.
   if(signal.time<retestConfirmTime)
      return;

   int lookback=MathMax(2,M1PullbackBreakLookback);

   double minRecovery=MathMax(
      avgM5Range*MathMax(0.0,MinM1RecoveryM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY)
   {
      double pullbackHigh=HighestM1High(2,lookback);
      if(pullbackHigh<=0.0)
         return;

      bool bullish=(signal.close>signal.open);
      bool stillAboveStory=(signal.close>storyLevel);
      bool brokePullback=(signal.close>pullbackHigh);
      bool recoveredEnough=(signal.close-fibC>=minRecovery);

      if(bullish && stillAboveStory && brokePullback && recoveredEnough)
         OpenSniperTrade();
   }
   else
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0.0)
         return;

      bool bearish=(signal.close<signal.open);
      bool stillBelowStory=(signal.close<storyLevel);
      bool brokePullback=(signal.close<pullbackLow);
      bool recoveredEnough=(fibC-signal.close>=minRecovery);

      if(bearish && stillBelowStory && brokePullback && recoveredEnough)
         OpenSniperTrade();
   }
}

// =============================================================
// FIB MANAGEMENT
// =============================================================
double PartialCloseVolume(double percent,double currentVolume)
{
   if(percent<=0.0)
      return 0.0;

   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);

   if(step<=0.0)
      step=minVol;

   double requested=initialPositionVolume*(percent/100.0);
   double closeVol=MathFloor(requested/step+1e-12)*step;

   if(closeVol<minVol)
      return 0.0;

   // Do not accidentally kill the final runner through a partial.
   if(currentVolume-closeVol<minVol)
   {
      closeVol=currentVolume-minVol;
      closeVol=MathFloor(closeVol/step+1e-12)*step;
   }

   if(closeVol<minVol)
      return 0.0;

   return NormalizeDouble(closeVol,8);
}

bool TryPartialAtFib(string label,double percent)
{
   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   double currentVolume=0.0;

   if(!FindOurPosition(ticket,type,openPrice,currentVolume))
      return false;

   double closeVol=PartialCloseVolume(percent,currentVolume);
   if(closeVol<=0.0)
   {
      Log(label+" HIT -> LOT TOO SMALL TO SPLIT");
      return false;
   }

   if(!trade.PositionClosePartial(ticket,closeVol) || !TradeResultOK())
   {
      Log(label+" PARTIAL FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   partials++;
   Log(label+" PARTIAL CLOSED | "+DoubleToString(closeVol,8));
   return true;
}

void ManageFibTargets()
{
   if(!UseFibTargets || positionDir==DIR_NONE || !HasPosition())
      return;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return;

   double price=(positionDir==DIR_BUY ? tick.bid : tick.ask);

   if(!tp1Hit && tp1Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp1Price : price<=tp1Price);
      if(hit)
      {
         tp1Hit=true;
         TryPartialAtFib("TP1 "+DoubleToString(FibTP1,3),TP1PartialPercent);
      }
   }

   if(!tp2Hit && tp2Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp2Price : price<=tp2Price);
      if(hit)
      {
         tp2Hit=true;
         TryPartialAtFib("TP2 "+DoubleToString(FibTP2,3),TP2PartialPercent);
      }
   }

   if(!tp3Hit && tp3Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp3Price : price<=tp3Price);
      if(hit)
      {
         tp3Hit=true;

         bool partialDone=TryPartialAtFib(
            "TP3 "+DoubleToString(FibTP3,3),
            TP3PartialPercent);

         // THIS IS THE IMPORTANT 0.01-LOT FIX.
         // If the account cannot split 0.01, Fib no longer does nothing.
         if(!partialDone && CloseWholeAtTP3WhenVolumeCannotSplit)
         {
            CloseCurrentPosition(
               "TP3 FIB TARGET HIT -> MIN LOT CANNOT SPLIT, CLOSE FULL TRADE");
         }
      }
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
   DetectM15PivotAtShift(center);
   EvaluateM15Story();
}

void OnNewM5()
{
   datetime current=iTime(_Symbol,MapTF,0);
   if(current<=0 || current==lastM5Bar)
      return;

   lastM5Bar=current;

   AvgRange(MapTF,1,M5RangeLookback,avgM5Range);

   if(setupStage==STAGE_IDLE)
      LookForExactM15LevelBreak();
   else
      ProcessExactM15LevelRetest();
}

void OnNewM1()
{
   datetime current=iTime(_Symbol,EntryTF,0);
   if(current<=0 || current==lastM1Bar)
      return;

   lastM1Bar=current;
   ProcessM1Trigger();
}

// =============================================================
// PANEL
// =============================================================
string StoryText()
{
   if(storyDir==DIR_BUY)
      return "BUY: M15 HH + HL";

   if(storyDir==DIR_SELL)
      return "SELL: M15 LL + LH";

   return "NO CLEAR M15 STORY";
}

string SetupText()
{
   if(setupStage==STAGE_WAIT_M5_RETEST)
      return "M15 LEVEL BROKEN -> WAIT M5 RETEST";

   if(setupStage==STAGE_WAIT_M1_TRIGGER)
      return "M5 RETEST HELD -> WAIT M1 SNIPER";

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
   double volume=0.0;
   string pos="NONE";

   if(FindOurPosition(ticket,type,openPrice,volume))
      pos=(type==POSITION_TYPE_BUY ? "BUY" : "SELL");

   Comment(
      "MOUNTAIN RIDER V5 - EXACT M15 STORY RETEST\n",
      "POSITION: ",pos," | VOL: ",DoubleToString(volume,4),"\n",
      "M15 STORY: ",StoryText(),"\n",
      "EXACT M15 LEVEL TO BREAK/RETEST: ",DoubleToString(storyLevel,_Digits),"\n",
      "M15 LAUNCH HL/LH: ",DoubleToString(storyLaunchPoint,_Digits),"\n",
      "PROTECTED M15 STRUCTURE: ",DoubleToString(protectedM15Structure,_Digits),"\n",
      "THIS M15 LEG CONSUMED: ",(storyLegConsumed?"YES":"NO"),"\n",
      "SETUP: ",SetupText(),"\n",
      "FIB A/B/C: ",DoubleToString(fibA,_Digits)," / ",
                       DoubleToString(fibB,_Digits)," / ",
                       DoubleToString(fibC,_Digits),"\n",
      "TP1: ",DoubleToString(tp1Price,_Digits)," [",(tp1Hit?"HIT":"WAIT"),"]",
      " | TP2: ",DoubleToString(tp2Price,_Digits)," [",(tp2Hit?"HIT":"WAIT"),"]",
      " | TP3: ",DoubleToString(tp3Price,_Digits)," [",(tp3Hit?"HIT":"WAIT"),"]\n",
      "STORY LEGS: ",IntegerToString(storyLegs),
      " | BREAKOUTS: ",IntegerToString(breakouts),
      " | RETESTS: ",IntegerToString(retests),"\n",
      "ENTRIES: ",IntegerToString(entries),
      " | PARTIALS: ",IntegerToString(partials),
      " | EXITS: ",IntegerToString(exits),"\n",
      "CANCELS: ",IntegerToString(cancelledSetups),
      " | LATE BLOCKS: ",IntegerToString(lateBlocks),
      " | STOP/BROKER EXITS: ",IntegerToString(stopsOrBrokerExits),"\n",
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

   SeedM15Swings();

   storyDir=DIR_NONE;
   storyLevel=0.0;
   storyLaunchPoint=0.0;
   protectedM15Structure=0.0;
   storySwingTime=0;
   storyLegConsumed=false;

   ResetSetup();
   ResetPositionTargets();

   // Seeded swings may already describe a clean HH+HL / LL+LH story.
   EvaluateM15Story();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   Log("INIT V5 EXACT STORY / RETEST / FIB");
   Log("M15 DEFINES THE HH/LL. M5 ONLY BREAKS AND RETESTS THAT EXACT M15 LEVEL.");
   Log("ONE M15 LEG = ONE BREAKOUT ATTEMPT. NO M5-INVENTED REENTRY CHURN.");
   Log("0.01 LOT: TP1/TP2 MILESTONES; TP3 CAN CLOSE FULL TRADE SO FIB ACTUALLY MATTERS.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");

   Log("DEINIT V5 | storyLegs="+IntegerToString(storyLegs)+
       " | breakouts="+IntegerToString(breakouts)+
       " | retests="+IntegerToString(retests)+
       " | entries="+IntegerToString(entries)+
       " | exits="+IntegerToString(exits));
}

void OnTick()
{
   SyncPositionState();

   OnNewM15();
   OnNewM5();
   OnNewM1();

   ManageFibTargets();
   Panel();
}
