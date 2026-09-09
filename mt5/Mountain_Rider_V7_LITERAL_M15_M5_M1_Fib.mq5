#property strict
#property version "7.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// MOUNTAIN RIDER V7 - LITERAL VERSION
// =============================================================
// WHAT THIS EA DOES, LITERALLY:
//
// 1) M15 TELLS THE STORY.
//
// BUY story:
//   L1 -> H1 -> L2 -> H2
//   L2 > L1  = Higher Low
//   H2 > H1  = Higher High
//   H2 becomes the EXACT breakout/retest level.
//
// SELL story:
//   H1 -> L1 -> H2 -> L2
//   H2 < H1  = Lower High
//   L2 < L1  = Lower Low
//   L2 becomes the EXACT breakout/retest level.
//
// 2) M5 SHOWS THE PLACE.
//
// BUY:
//   Wait for a CLOSED M5 candle to break ABOVE the exact M15 H2.
//   DO NOT BUY THE BREAKOUT.
//   Wait for price to return to H2.
//   The M5 retest must HOLD H2 on a CLOSED candle.
//   The retest low must still be ABOVE the previous M15 L2,
//   so it is genuinely a NEW Higher Low, not a broken uptrend.
//
// SELL:
//   Wait for a CLOSED M5 candle to break BELOW the exact M15 L2.
//   DO NOT SELL THE BREAKOUT.
//   Wait for price to return to L2.
//   The M5 retest must HOLD L2 on a CLOSED candle.
//   The retest high must still be BELOW the previous M15 H2,
//   so it is genuinely a NEW Lower High.
//
// 3) M1 PULLS THE TRIGGER.
//
// BUY:
//   After M5 retest holds, a CLOSED bullish M1 candle must break
//   the recent M1 pullback high while still near the M15 H2 level.
//
// SELL:
//   After M5 retest holds, a CLOSED bearish M1 candle must break
//   the recent M1 pullback low while still near the M15 L2 level.
//
// 4) ENTER EARLY, NEVER CHASE.
//   If M1 confirmation happens too far away from the M15 retest level,
//   the setup is cancelled. No late entry.
//
// 5) NEVER OVERTRADE.
//   ONE M15 STORY LEG = ONE BREAKOUT ATTEMPT.
//   If that attempt fails, expires, is late, or gets stopped,
//   the EA waits for a NEW M15 HH+HL / LH+LL story leg.
//
// 6) STOP LOSS.
//   BUY stop is below the COMPLETE M5 retest low plus breathing room.
//   SELL stop is above the COMPLETE M5 retest high plus breathing room.
//   No M1 stop. No automatic breakeven. No tight trailing.
//
// 7) HOLD THE TREND.
//   No ordinary take-profit on the final runner.
//   Final runner exits only when a CLOSED M15 candle breaks the
//   latest CONFIRMED major HL/LH structure.
//
// 8) FIBONACCI EXTENSION.
//   BUY : A = previous M15 HL (L2), B = breakout extension high,
//         C = M5 retest low / new HL.
//   SELL: A = previous M15 LH (H2), B = breakout extension low,
//         C = M5 retest high / new LH.
//
//   Default targets: 1.272 / 1.618 / 2.000.
//   With enough volume, partial closes are attempted.
//   With minimum 0.01 lot, TP1/TP2 are milestones and TP3 may close
//   the whole trade so a large winner does not round-trip to a loss.
//
// VWAP IS NOT USED IN V7 because it was discussed as an optional idea,
// not as a mandatory rule. Structure remains the strategy.
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
   SETUP_IDLE = 0,
   WAIT_M5_RETEST = 1,
   WAIT_M1_CONFIRM = 2
};

// =============================================================
// INPUTS
// =============================================================
input double Lots = 0.01;
input ulong Magic = 260909007;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// M15 structure
input int M15PivotWing = 3;
input int M15SeedLookbackBars = 320;
input int M15RangeLookback = 12;
input double MinM15StructureDifferenceRangeFrac = 0.10;
input double M15StructureExitBufferRangeFrac = 0.10;

// M5 breakout/retest
input int M5RangeLookback = 12;
input double M5BreakBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.75;
input int BreakoutExpiryMinutes = 180;
input int RetestExpiryMinutes = 75;

// M1 sniper
input int M1PullbackLookback = 3;
input double MinM1RecoveryM5RangeFrac = 0.15;
input double MaxEntryDistanceFromM15LevelM5RangeFrac = 0.85;

// Stop breathing room
input double StopBreathingM5RangeFrac = 0.40;

// Fibonacci extension
input bool UseFibTargets = true;
input double FibTP1 = 1.272;
input double FibTP2 = 1.618;
input double FibTP3 = 2.000;
input double TP1PartialPercent = 25.0;
input double TP2PartialPercent = 25.0;
input double TP3PartialPercent = 25.0;
input bool CloseMinimumLotAtTP3 = true;

// Cost awareness
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
double storyLevel = 0.0;          // exact M15 H2 / L2 to break and retest
double storyLaunch = 0.0;         // previous M15 L2 / H2

double protectedM15 = 0.0;        // final runner structure level
datetime storyKeyTime = 0;        // makes each M15 leg unique
bool storyConsumed = false;

SetupStage setupStage = SETUP_IDLE;
datetime breakoutTime = 0;
double breakoutExtreme = 0.0;

double retestLow = 0.0;
double retestHigh = 0.0;
datetime retestTime = 0;

double fibA = 0.0;
double fibB = 0.0;
double fibC = 0.0;
double tp1Price = 0.0;
double tp2Price = 0.0;
double tp3Price = 0.0;
bool tp1Hit = false;
bool tp2Hit = false;
bool tp3Hit = false;

TrendDir positionDir = DIR_NONE;
double initialVolume = 0.0;

double avgM15 = 0.0;
double avgM5 = 0.0;

datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

int stories = 0;
int breakouts = 0;
int retests = 0;
int entries = 0;
int exits = 0;
int partials = 0;
int cancels = 0;
int lateBlocks = 0;

string lastAction = "WAITING FOR M15 HH+HL / LH+LL";
ulong lastPanelMs = 0;

// =============================================================
// BASIC HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V7] ",text);
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
   setupStage=SETUP_IDLE;
   breakoutTime=0;
   breakoutExtreme=0.0;
   retestLow=0.0;
   retestHigh=0.0;
   retestTime=0;
   fibA=0.0;
   fibB=0.0;
   fibC=0.0;
}

void ResetPositionState()
{
   positionDir=DIR_NONE;
   initialVolume=0.0;
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
   ResetPositionState();
   return true;
}

void SyncPositionState()
{
   if(positionDir!=DIR_NONE && !HasPosition())
   {
      exits++;
      lastAction="POSITION CLOSED BY STOP/BROKER";
      Log(lastAction);
      ResetPositionState();
   }
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

void AddM15Swing(int type,double price,datetime when)
{
   if(m15SwingCount>0 && m15Swings[m15SwingCount-1].time==when)
      return;

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
void ArmStory(TrendDir dir,double exactLevel,double launchPoint,double protectedLevel,datetime keyTime)
{
   bool isNew=(dir!=storyDir || keyTime!=storyKeyTime || MathAbs(exactLevel-storyLevel)>_Point);
   if(!isNew)
      return;

   storyDir=dir;
   storyLevel=exactLevel;
   storyLaunch=launchPoint;
   protectedM15=protectedLevel;
   storyKeyTime=keyTime;
   storyConsumed=false;
   stories++;

   if(setupStage!=SETUP_IDLE)
   {
      cancels++;
      ResetSetup();
   }

   lastAction=(dir==DIR_BUY ?
      "M15 BUY STORY: HH + HL -> WAIT M5 BREAK OF HH" :
      "M15 SELL STORY: LH + LL -> WAIT M5 BREAK OF LL");

   Log(lastAction+
       " | exact level="+DoubleToString(storyLevel,_Digits)+
       " | prior HL/LH="+DoubleToString(storyLaunch,_Digits));
}

void EndStory(string reason)
{
   if(HasPosition())
      CloseCurrentPosition(reason);

   storyDir=DIR_NONE;
   storyLevel=0.0;
   storyLaunch=0.0;
   protectedM15=0.0;
   storyKeyTime=0;
   storyConsumed=false;

   ResetSetup();

   // Force a completely new story after a real structure break.
   m15SwingCount=0;

   lastAction=reason+" -> WAIT NEW M15 STORY";
   Log(lastAction);
}

void EvaluateM15Story()
{
   if(avgM15<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   double exitBuffer=avgM15*MathMax(0.0,M15StructureExitBufferRangeFrac);

   // The final runner only cares about a real CLOSED M15 structure break.
   if(storyDir==DIR_BUY && protectedM15>0.0)
   {
      if(closed.close<protectedM15-exitBuffer)
      {
         EndStory("BUY EXIT: CLOSED M15 BROKE PROTECTED HIGHER LOW");
         return;
      }
   }

   if(storyDir==DIR_SELL && protectedM15>0.0)
   {
      if(closed.close>protectedM15+exitBuffer)
      {
         EndStory("SELL EXIT: CLOSED M15 BROKE PROTECTED LOWER HIGH");
         return;
      }
   }

   SwingPoint s1,s2,s3,s4;
   if(!LatestFourM15(s1,s2,s3,s4))
      return;

   double minDifference=avgM15*MathMax(0.0,MinM15StructureDifferenceRangeFrac);

   // BUY = L1 -> H1 -> L2 -> H2
   if(s1.type==-1 && s2.type==1 && s3.type==-1 && s4.type==1)
   {
      bool higherLow=(s3.price>s1.price+minDifference);
      bool higherHigh=(s4.price>s2.price+minDifference);

      if(higherLow && higherHigh)
      {
         // H2 is the exact level M5 must break and later retest.
         // L2 is the previous higher low and the major structure protection.
         ArmStory(DIR_BUY,s4.price,s3.price,s3.price,s4.time);
         return;
      }
   }

   // SELL = H1 -> L1 -> H2 -> L2
   if(s1.type==1 && s2.type==-1 && s3.type==1 && s4.type==-1)
   {
      bool lowerHigh=(s3.price<s1.price-minDifference);
      bool lowerLow=(s4.price<s2.price-minDifference);

      if(lowerHigh && lowerLow)
      {
         // L2 is the exact level M5 must break and later retest.
         // H2 is the previous lower high and the major structure protection.
         ArmStory(DIR_SELL,s4.price,s3.price,s3.price,s4.time);
         return;
      }
   }

   // Anything else is simply NO TRADE. No indicator is allowed to override it.
}

// =============================================================
// M5: EXACT BREAKOUT + RETEST
// =============================================================
void LookForM5Breakout()
{
   if(HasPosition() || setupStage!=SETUP_IDLE || storyDir==DIR_NONE || storyConsumed || avgM5<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   double buffer=MathMax(
      avgM5*MathMax(0.0,M5BreakBufferRangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY && closed.close>storyLevel+buffer)
   {
      storyConsumed=true;
      setupStage=WAIT_M5_RETEST;
      breakoutTime=closed.time;
      breakoutExtreme=closed.high;

      fibA=storyLaunch;
      fibB=breakoutExtreme;

      breakouts++;
      lastAction="M5 BROKE EXACT M15 HH -> HOLD / WAIT RETEST";
      Log(lastAction);
      return;
   }

   if(storyDir==DIR_SELL && closed.close<storyLevel-buffer)
   {
      storyConsumed=true;
      setupStage=WAIT_M5_RETEST;
      breakoutTime=closed.time;
      breakoutExtreme=closed.low;

      fibA=storyLaunch;
      fibB=breakoutExtreme;

      breakouts++;
      lastAction="M5 BROKE EXACT M15 LL -> HOLD / WAIT RETEST";
      Log(lastAction);
   }
}

void ProcessM5Retest()
{
   if(HasPosition() || setupStage==SETUP_IDLE || storyDir==DIR_NONE || avgM5<=0.0)
      return;

   if(BreakoutExpiryMinutes>0 && TimeCurrent()-breakoutTime>BreakoutExpiryMinutes*60)
   {
      cancels++;
      lastAction="NO TRADE: BREAKOUT NEVER RETESTED / WAIT NEW M15 LEG";
      Log(lastAction);
      ResetSetup();
      return;
   }

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   if(closed.time<=breakoutTime)
      return;

   // Before the retest is confirmed, B follows the breakout extension.
   if(setupStage==WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY && closed.high>breakoutExtreme)
      {
         breakoutExtreme=closed.high;
         fibB=breakoutExtreme;
      }
      else if(storyDir==DIR_SELL && closed.low<breakoutExtreme)
      {
         breakoutExtreme=closed.low;
         fibB=breakoutExtreme;
      }
   }

   double zone=avgM5*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(setupStage==WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY)
      {
         bool cameBackToHH=(closed.low<=storyLevel+zone);
         bool heldHHOnClose=(closed.close>=storyLevel);
         bool notTooDeep=(closed.low>=storyLevel-maxDepth);

         // THIS IS THE USER'S NEW HIGHER LOW RULE:
         // The new retest HL must remain above the previous M15 HL.
         bool genuinelyNewHL=(closed.low>storyLaunch);

         if(cameBackToHH && heldHHOnClose && notTooDeep && genuinelyNewHL)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestTime=TimeCurrent();
            fibC=retestLow;
            setupStage=WAIT_M1_CONFIRM;
            retests++;

            lastAction="M5 RETEST HELD M15 HH -> NEW HIGHER LOW FORMED / WAIT M1";
            Log(lastAction);
            return;
         }

         // If price destroys the previous M15 HL, this is not a buy story anymore.
         if(closed.low<=storyLaunch || closed.close<storyLevel-maxDepth)
         {
            cancels++;
            lastAction="BUY CANCELLED: RETEST DID NOT CREATE A NEW HIGHER LOW";
            Log(lastAction);
            ResetSetup();
            return;
         }
      }
      else
      {
         bool cameBackToLL=(closed.high>=storyLevel-zone);
         bool heldLLOnClose=(closed.close<=storyLevel);
         bool notTooDeep=(closed.high<=storyLevel+maxDepth);

         // THIS IS THE USER'S NEW LOWER HIGH RULE:
         // The new retest LH must remain below the previous M15 LH.
         bool genuinelyNewLH=(closed.high<storyLaunch);

         if(cameBackToLL && heldLLOnClose && notTooDeep && genuinelyNewLH)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestTime=TimeCurrent();
            fibC=retestHigh;
            setupStage=WAIT_M1_CONFIRM;
            retests++;

            lastAction="M5 RETEST HELD M15 LL -> NEW LOWER HIGH FORMED / WAIT M1";
            Log(lastAction);
            return;
         }

         if(closed.high>=storyLaunch || closed.close>storyLevel+maxDepth)
         {
            cancels++;
            lastAction="SELL CANCELLED: RETEST DID NOT CREATE A NEW LOWER HIGH";
            Log(lastAction);
            ResetSetup();
            return;
         }
      }

      return;
   }

   if(setupStage==WAIT_M1_CONFIRM)
   {
      if(RetestExpiryMinutes>0 && TimeCurrent()-retestTime>RetestExpiryMinutes*60)
      {
         cancels++;
         lastAction="NO LATE ENTRY: M1 NEVER CONFIRMED THE RETEST";
         Log(lastAction);
         ResetSetup();
         return;
      }

      // The M5 retest may breathe while the structure remains valid.
      if(storyDir==DIR_BUY)
      {
         if(closed.low<retestLow)
         {
            retestLow=closed.low;
            fibC=retestLow;
         }

         if(closed.high>retestHigh)
            retestHigh=closed.high;

         if(closed.low<=storyLaunch || closed.close<storyLevel-maxDepth)
         {
            cancels++;
            lastAction="BUY CANCELLED BEFORE ENTRY: NEW HL FAILED";
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

         if(closed.high>=storyLaunch || closed.close>storyLevel+maxDepth)
         {
            cancels++;
            lastAction="SELL CANCELLED BEFORE ENTRY: NEW LH FAILED";
            Log(lastAction);
            ResetSetup();
         }
      }
   }
}

// =============================================================
// M1 SNIPER TRIGGER
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

   if(positionDir==DIR_BUY)
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
   if(HasPosition() || setupStage!=WAIT_M1_CONFIRM || storyDir==DIR_NONE || avgM5<=0.0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(storyDir==DIR_BUY ? tick.ask : tick.bid);
   double maxDistance=avgM5*MathMax(0.0,MaxEntryDistanceFromM15LevelM5RangeFrac);

   if(MathAbs(entry-storyLevel)>maxDistance)
   {
      lateBlocks++;
      lastAction="ENTRY BLOCKED: CONFIRMATION CAME TOO LATE";
      Log(lastAction);
      ResetSetup();
      return false;
   }

   double breathing=MathMax(
      avgM5*MathMax(0.0,StopBreathingM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   double sl=(storyDir==DIR_BUY ? retestLow-breathing : retestHigh+breathing);
   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(storyDir==DIR_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V7_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V7_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=storyDir;
   initialVolume=volume;
   tp1Hit=false;
   tp2Hit=false;
   tp3Hit=false;

   BuildFibTargets();
   entries++;

   lastAction=(positionDir==DIR_BUY ? "BUY" : "SELL")+
              string(" SNIPER ENTRY -> HOLD UNTIL REAL M15 BREAK");

   Log(lastAction+
       " | SL="+DoubleToString(sl,_Digits)+
       " | TP1="+DoubleToString(tp1Price,_Digits)+
       " | TP2="+DoubleToString(tp2Price,_Digits)+
       " | TP3="+DoubleToString(tp3Price,_Digits));

   // Keep Fib values and targets for the active position.
   setupStage=SETUP_IDLE;
   breakoutTime=0;
   breakoutExtreme=0.0;
   retestLow=0.0;
   retestHigh=0.0;
   retestTime=0;

   return true;
}

void ProcessM1Confirmation()
{
   if(HasPosition() || setupStage!=WAIT_M1_CONFIRM || storyDir==DIR_NONE)
      return;

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   if(signal.time<retestTime)
      return;

   int lookback=MathMax(2,M1PullbackLookback);

   double minRecovery=MathMax(
      avgM5*MathMax(0.0,MinM1RecoveryM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY)
   {
      double pullbackHigh=HighestM1High(2,lookback);
      if(pullbackHigh<=0.0)
         return;

      bool bullish=(signal.close>signal.open);
      bool stillHoldingHH=(signal.close>storyLevel);
      bool breaksPullback=(signal.close>pullbackHigh);
      bool recoveredEnough=(signal.close-fibC>=minRecovery);

      if(bullish && stillHoldingHH && breaksPullback && recoveredEnough)
         OpenSniperTrade();
   }
   else
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0.0)
         return;

      bool bearish=(signal.close<signal.open);
      bool stillHoldingLL=(signal.close<storyLevel);
      bool breaksPullback=(signal.close<pullbackLow);
      bool recoveredEnough=(fibC-signal.close>=minRecovery);

      if(bearish && stillHoldingLL && breaksPullback && recoveredEnough)
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

   double requested=initialVolume*(percent/100.0);
   double closeVol=MathFloor(requested/step+1e-12)*step;

   if(closeVol<minVol)
      return 0.0;

   // Leave at least one minimum lot alive as the runner.
   if(currentVolume-closeVol<minVol)
   {
      closeVol=currentVolume-minVol;
      closeVol=MathFloor(closeVol/step+1e-12)*step;
   }

   if(closeVol<minVol)
      return 0.0;

   return NormalizeDouble(closeVol,8);
}

bool TryPartial(string label,double percent)
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
      Log(label+" HIT -> MINIMUM LOT CANNOT PARTIAL");
      return false;
   }

   if(!trade.PositionClosePartial(ticket,closeVol) || !TradeResultOK())
   {
      Log(label+" PARTIAL FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   partials++;
   Log(label+" PARTIAL CLOSED | volume="+DoubleToString(closeVol,8));
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
         TryPartial("FIB TP1 "+DoubleToString(FibTP1,3),TP1PartialPercent);
      }
   }

   if(!tp2Hit && tp2Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp2Price : price<=tp2Price);
      if(hit)
      {
         tp2Hit=true;
         TryPartial("FIB TP2 "+DoubleToString(FibTP2,3),TP2PartialPercent);
      }
   }

   if(!tp3Hit && tp3Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp3Price : price<=tp3Price);
      if(hit)
      {
         tp3Hit=true;
         bool partialDone=TryPartial("FIB TP3 "+DoubleToString(FibTP3,3),TP3PartialPercent);

         if(!partialDone && CloseMinimumLotAtTP3)
            CloseCurrentPosition("FIB TP3 HIT -> CLOSE MINIMUM LOT WINNER");
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
   AvgRange(DirectionTF,1,M15RangeLookback,avgM15);

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
   AvgRange(MapTF,1,M5RangeLookback,avgM5);

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
string StoryText()
{
   if(storyDir==DIR_BUY)
      return "BUY: M15 HH + HL";
   if(storyDir==DIR_SELL)
      return "SELL: M15 LH + LL";
   return "WAIT: NO VALID M15 STORY";
}

string SetupText()
{
   if(setupStage==WAIT_M5_RETEST)
      return "M5 BROKE M15 LEVEL -> WAIT RETEST";
   if(setupStage==WAIT_M1_CONFIRM)
      return "NEW HL/LH FORMED -> WAIT M1 TRIGGER";
   return "IDLE";
}

void Panel()
{
   ulong now=GetTickCount64();
   if(lastPanelMs>0 && now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))
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
      "MOUNTAIN RIDER V7 - LITERAL\n",
      "POSITION: ",pos," | VOL: ",DoubleToString(volume,4),"\n",
      "M15 STORY: ",StoryText(),"\n",
      "EXACT M15 HH/LL: ",DoubleToString(storyLevel,_Digits),"\n",
      "PREVIOUS M15 HL/LH: ",DoubleToString(storyLaunch,_Digits),"\n",
      "PROTECTED M15 STRUCTURE: ",DoubleToString(protectedM15,_Digits),"\n",
      "STORY USED: ",(storyConsumed?"YES":"NO"),"\n",
      "M5: ",SetupText(),"\n",
      "FIB A/B/C: ",DoubleToString(fibA,_Digits)," / ",
                       DoubleToString(fibB,_Digits)," / ",
                       DoubleToString(fibC,_Digits),"\n",
      "TP1: ",DoubleToString(tp1Price,_Digits)," [",(tp1Hit?"HIT":"WAIT"),"]",
      " | TP2: ",DoubleToString(tp2Price,_Digits)," [",(tp2Hit?"HIT":"WAIT"),"]",
      " | TP3: ",DoubleToString(tp3Price,_Digits)," [",(tp3Hit?"HIT":"WAIT"),"]\n",
      "STORIES: ",IntegerToString(stories),
      " | BREAKOUTS: ",IntegerToString(breakouts),
      " | RETESTS: ",IntegerToString(retests),"\n",
      "ENTRIES: ",IntegerToString(entries),
      " | PARTIALS: ",IntegerToString(partials),
      " | EXITS: ",IntegerToString(exits),"\n",
      "CANCELS: ",IntegerToString(cancels),
      " | LATE BLOCKS: ",IntegerToString(lateBlocks),"\n",
      "LAST: ",lastAction
   );
}

// =============================================================
// INIT / DEINIT / TICK
// =============================================================
int OnInit()
{
   if(DirectionTF!=PERIOD_M15 || MapTF!=PERIOD_M5 || EntryTF!=PERIOD_M1)
      return INIT_PARAMETERS_INCORRECT;

   if(M15PivotWing<1 || M15PivotWing>12)
      return INIT_PARAMETERS_INCORRECT;

   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   AvgRange(DirectionTF,1,M15RangeLookback,avgM15);
   AvgRange(MapTF,1,M5RangeLookback,avgM5);

   SeedM15Swings();

   storyDir=DIR_NONE;
   storyLevel=0.0;
   storyLaunch=0.0;
   protectedM15=0.0;
   storyKeyTime=0;
   storyConsumed=false;

   ResetSetup();
   ResetPositionState();
   EvaluateM15Story();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   Log("INIT MOUNTAIN RIDER V7 LITERAL");
   Log("M15 STORY -> EXACT M15 HH/LL -> M5 BREAK -> WAIT -> M5 RETEST + NEW HL/LH -> M1 TRIGGER");
   Log("ONE M15 LEG = ONE ATTEMPT. NO CHASE. NO BREAKEVEN. NO TIGHT TRAIL. FINAL RUNNER EXITS ON M15 STRUCTURE BREAK.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");
   Log("DEINIT V7 | stories="+IntegerToString(stories)+
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
