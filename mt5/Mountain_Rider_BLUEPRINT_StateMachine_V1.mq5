#property strict
#property version "1.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// MOUNTAIN RIDER - BLUEPRINT STATE MACHINE V1
// =============================================================
// STRICT SEQUENCE. NOTHING IS RECALCULATED MID-SETUP.
//
// STATE 0: FIND M15 STORY
// BUY  = L1 -> H1 -> L2 -> H2, with L2>L1 and H2>H1
// SELL = H1 -> L1 -> H2 -> L2, with H2<H1 and L2<L1
// Once found, freeze the story.
//
// STATE 1: WAIT M5 BREAKOUT OF THE FROZEN M15 LEVEL
// BUY  breaks H2
// SELL breaks L2
// No entry on breakout.
//
// STATE 2: WAIT M5 RETEST OF THAT SAME FROZEN LEVEL
// BUY  retest must hold H2 and create a new HL above M15 L2
// SELL retest must hold L2 and create a new LH below M15 H2
// Freeze the retest.
//
// STATE 3: WAIT M1 TRIGGER
// BUY  closed M1 breaks minor pullback high
// SELL closed M1 breaks minor pullback low
// Must still be close to the retest level.
//
// STATE 4: HOLD TRADE
// No new setup. No breakeven. No tight trailing.
// Fib targets are managed.
// Final runner exits only on a CLOSED M15 structure break.
//
// STATE 5: RESET
// After failure/expiry/exit, require a genuinely NEW M15 story.
// One M15 leg = one attempt.
// =============================================================

#define MAX_SWINGS 40

struct SwingPoint
{
   int type;          // +1 high, -1 low
   double price;
   datetime time;
};

enum Direction
{
   DIR_NONE = 0,
   DIR_BUY  = 1,
   DIR_SELL = -1
};

enum EngineState
{
   FIND_M15_STORY = 0,
   WAIT_M5_BREAKOUT = 1,
   WAIT_M5_RETEST = 2,
   WAIT_M1_TRIGGER = 3,
   HOLD_TRADE = 4
};

// =============================================================
// INPUTS
// =============================================================
input double Lots = 0.01;
input ulong Magic = 260909101;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// M15 story
input int M15PivotWing = 3;
input int M15SeedLookbackBars = 320;
input int M15AverageRangeLookback = 12;
input double MinM15StructureStepRangeFrac = 0.10;
input double MinM15SwingLegRangeFrac = 1.00;
input int MinM15SwingSpacingBars = 2;
input double M15ExitBreakBufferRangeFrac = 0.10;

// M5 place
input int M5AverageRangeLookback = 12;
input double M5BreakBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.75;
input int BreakoutExpiryMinutes = 180;
input int RetestExpiryMinutes = 75;

// M1 trigger
input int M1PullbackLookback = 3;
input int MinM1BarsAfterRetest = 2;
input double MinM1RecoveryM5RangeFrac = 0.15;
input double MaxEntryDistanceFromM15LevelM5RangeFrac = 0.85;

// Stop
input double StopBreathingM5RangeFrac = 0.50;

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
SwingPoint swings[MAX_SWINGS];
int swingCount = 0;

EngineState state = FIND_M15_STORY;
Direction frozenDir = DIR_NONE;

// Frozen M15 story
SwingPoint frozenS1;
SwingPoint frozenS2;
SwingPoint frozenS3;
SwingPoint frozenS4;

double frozenBreakLevel = 0.0;      // BUY H2 / SELL L2
double frozenPreviousHL_LH = 0.0;   // BUY L2 / SELL H2
datetime frozenStoryKey = 0;
datetime lastConsumedStoryKey = 0;
datetime storyArmedAt = 0;

// Frozen M5 breakout/retest
 datetime breakoutClosedAt = 0;
double retestLow = 0.0;
double retestHigh = 0.0;
datetime retestConfirmedAt = 0;

// Fib anchors
// BUY : A = previous M15 HL, B = frozen H2, C = new M5 HL
// SELL: A = previous M15 LH, B = frozen L2, C = new M5 LH
double fibA = 0.0;
double fibB = 0.0;
double fibC = 0.0;

double tp1Price = 0.0;
double tp2Price = 0.0;
double tp3Price = 0.0;
bool tp1Hit = false;
bool tp2Hit = false;
bool tp3Hit = false;

// Hold structure
Direction positionDir = DIR_NONE;
double initialPositionVolume = 0.0;
double protectedM15 = 0.0;
double confirmedM15Extreme = 0.0;
datetime confirmedM15ExtremeTime = 0;
double candidateM15Structure = 0.0;
datetime candidateM15StructureTime = 0;

// Ranges
 double avgM15Range = 0.0;
double avgM5Range = 0.0;

// Bar clocks
 datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

// Diagnostics
 int storyCount = 0;
int breakoutCount = 0;
int retestCount = 0;
int entryCount = 0;
int exitCount = 0;
int partialCount = 0;
int cancelCount = 0;
int lateBlockCount = 0;
string lastAction = "FIND M15 STORY";
ulong lastPanelMs = 0;

// =============================================================
// BASIC HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[BLUEPRINT-SM] ",text);
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
   MqlRates rates[];
   count=MathMax(2,count);

   if(CopyRates(_Symbol,tf,startShift,count,rates)!=count)
      return false;

   double total=0.0;
   int valid=0;

   for(int i=0;i<count;i++)
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

   return spread+
          commissionDistance+
          MathMax(0,ExpectedSlippagePoints)*_Point;
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

void ClearFrozenSetup()
{
   frozenDir=DIR_NONE;
   frozenBreakLevel=0.0;
   frozenPreviousHL_LH=0.0;
   frozenStoryKey=0;
   storyArmedAt=0;

   breakoutClosedAt=0;
   retestLow=0.0;
   retestHigh=0.0;
   retestConfirmedAt=0;

   fibA=0.0;
   fibB=0.0;
   fibC=0.0;
}

void ResetPositionState()
{
   positionDir=DIR_NONE;
   initialPositionVolume=0.0;
   protectedM15=0.0;
   confirmedM15Extreme=0.0;
   confirmedM15ExtremeTime=0;
   candidateM15Structure=0.0;
   candidateM15StructureTime=0;

   tp1Price=0.0;
   tp2Price=0.0;
   tp3Price=0.0;
   tp1Hit=false;
   tp2Hit=false;
   tp3Hit=false;
}

void RequireNewStory(string reason)
{
   lastConsumedStoryKey=frozenStoryKey;
   cancelCount++;
   ClearFrozenSetup();
   state=FIND_M15_STORY;
   lastAction=reason;
   Log(reason);
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

   exitCount++;
   lastAction=reason;
   Log(reason);

   ResetPositionState();
   ClearFrozenSetup();
   state=FIND_M15_STORY;
   return true;
}

void SyncBrokerClosedPosition()
{
   if(state==HOLD_TRADE && positionDir!=DIR_NONE && !HasPosition())
   {
      exitCount++;
      lastConsumedStoryKey=frozenStoryKey;
      lastAction="TRADE CLOSED BY STRUCTURAL SL/BROKER -> WAIT NEW M15 STORY";
      Log(lastAction);
      ResetPositionState();
      ClearFrozenSetup();
      state=FIND_M15_STORY;
   }
}

// =============================================================
// CONFIRMED M15 PIVOTS
// =============================================================
bool IsPivotHigh(int centerShift,int wing,double &price,datetime &when)
{
   MqlRates center;
   if(!GetBar(DirectionTF,centerShift,center))
      return false;

   for(int k=1;k<=wing;k++)
   {
      MqlRates newerBar,olderBar;
      if(!GetBar(DirectionTF,centerShift-k,newerBar) ||
         !GetBar(DirectionTF,centerShift+k,olderBar))
         return false;

      if(center.high<=newerBar.high || center.high<=olderBar.high)
         return false;
   }

   price=center.high;
   when=center.time;
   return true;
}

bool IsPivotLow(int centerShift,int wing,double &price,datetime &when)
{
   MqlRates center;
   if(!GetBar(DirectionTF,centerShift,center))
      return false;

   for(int k=1;k<=wing;k++)
   {
      MqlRates newerBar,olderBar;
      if(!GetBar(DirectionTF,centerShift-k,newerBar) ||
         !GetBar(DirectionTF,centerShift+k,olderBar))
         return false;

      if(center.low>=newerBar.low || center.low>=olderBar.low)
         return false;
   }

   price=center.low;
   when=center.time;
   return true;
}

bool AddSwing(int type,double price,datetime when)
{
   if(swingCount>0 && swings[swingCount-1].time==when)
      return false;

   if(swingCount>0 && swings[swingCount-1].type==type)
   {
      bool replace=(type>0 ? price>swings[swingCount-1].price
                           : price<swings[swingCount-1].price);

      if(replace)
      {
         swings[swingCount-1].price=price;
         swings[swingCount-1].time=when;
         return true;
      }
      return false;
   }

   if(swingCount<MAX_SWINGS)
   {
      swings[swingCount].type=type;
      swings[swingCount].price=price;
      swings[swingCount].time=when;
      swingCount++;
      return true;
   }

   for(int i=1;i<MAX_SWINGS;i++)
      swings[i-1]=swings[i];

   swings[MAX_SWINGS-1].type=type;
   swings[MAX_SWINGS-1].price=price;
   swings[MAX_SWINGS-1].time=when;
   return true;
}

bool DetectNewestConfirmedM15Swing()
{
   int wing=MathMax(1,M15PivotWing);
   int center=wing+1;

   double hp=0.0,lp=0.0;
   datetime ht=0,lt=0;

   bool high=IsPivotHigh(center,wing,hp,ht);
   bool low =IsPivotLow(center,wing,lp,lt);

   if(high && low)
      return false;

   if(high)
      return AddSwing(1,hp,ht);

   if(low)
      return AddSwing(-1,lp,lt);

   return false;
}

void SeedM15Swings()
{
   swingCount=0;

   int wing=MathMax(1,M15PivotWing);
   int oldest=MathMax(wing+2,M15SeedLookbackBars);

   for(int shift=oldest;shift>=wing+1;shift--)
   {
      double hp=0.0,lp=0.0;
      datetime ht=0,lt=0;

      bool high=IsPivotHigh(shift,wing,hp,ht);
      bool low =IsPivotLow(shift,wing,lp,lt);

      if(high && low)
         continue;

      if(high)
         AddSwing(1,hp,ht);
      else if(low)
         AddSwing(-1,lp,lt);
   }
}

bool LatestFour(SwingPoint &s1,SwingPoint &s2,SwingPoint &s3,SwingPoint &s4)
{
   if(swingCount<4)
      return false;

   s1=swings[swingCount-4];
   s2=swings[swingCount-3];
   s3=swings[swingCount-2];
   s4=swings[swingCount-1];
   return true;
}

bool SwingSpacingOK(SwingPoint &s1,SwingPoint &s2,SwingPoint &s3,SwingPoint &s4)
{
   int minSeconds=MathMax(1,MinM15SwingSpacingBars)*PeriodSeconds(DirectionTF);

   return (s2.time-s1.time)>=minSeconds &&
          (s3.time-s2.time)>=minSeconds &&
          (s4.time-s3.time)>=minSeconds;
}

// =============================================================
// STATE 0: FIND AND FREEZE M15 STORY
// =============================================================
void TryFreezeM15Story()
{
   if(state!=FIND_M15_STORY || HasPosition() || avgM15Range<=0.0)
      return;

   SwingPoint s1,s2,s3,s4;
   if(!LatestFour(s1,s2,s3,s4))
      return;

   if(s4.time==lastConsumedStoryKey)
      return;

   if(!SwingSpacingOK(s1,s2,s3,s4))
      return;

   double minStep=avgM15Range*MathMax(0.0,MinM15StructureStepRangeFrac);
   double minLeg=avgM15Range*MathMax(0.0,MinM15SwingLegRangeFrac);

   // BUY: L1 -> H1 -> L2 -> H2
   if(s1.type==-1 && s2.type==1 && s3.type==-1 && s4.type==1)
   {
      bool higherLow=(s3.price>s1.price+minStep);
      bool higherHigh=(s4.price>s2.price+minStep);
      bool leg1=(s2.price-s1.price)>=minLeg;
      bool leg2=(s4.price-s3.price)>=minLeg;

      if(higherLow && higherHigh && leg1 && leg2)
      {
         frozenS1=s1;
         frozenS2=s2;
         frozenS3=s3;
         frozenS4=s4;
         frozenDir=DIR_BUY;
         frozenBreakLevel=s4.price;       // H2
         frozenPreviousHL_LH=s3.price;    // L2
         frozenStoryKey=s4.time;
         storyArmedAt=iTime(_Symbol,DirectionTF,0);
         state=WAIT_M5_BREAKOUT;
         storyCount++;

         lastAction="M15 BUY STORY FROZEN -> WAIT M5 BREAK OF H2";
         Log(lastAction+
             " | L1="+DoubleToString(s1.price,_Digits)+
             " H1="+DoubleToString(s2.price,_Digits)+
             " L2="+DoubleToString(s3.price,_Digits)+
             " H2="+DoubleToString(s4.price,_Digits));
         return;
      }
   }

   // SELL: H1 -> L1 -> H2 -> L2
   if(s1.type==1 && s2.type==-1 && s3.type==1 && s4.type==-1)
   {
      bool lowerHigh=(s3.price<s1.price-minStep);
      bool lowerLow=(s4.price<s2.price-minStep);
      bool leg1=(s1.price-s2.price)>=minLeg;
      bool leg2=(s3.price-s4.price)>=minLeg;

      if(lowerHigh && lowerLow && leg1 && leg2)
      {
         frozenS1=s1;
         frozenS2=s2;
         frozenS3=s3;
         frozenS4=s4;
         frozenDir=DIR_SELL;
         frozenBreakLevel=s4.price;       // L2
         frozenPreviousHL_LH=s3.price;    // H2
         frozenStoryKey=s4.time;
         storyArmedAt=iTime(_Symbol,DirectionTF,0);
         state=WAIT_M5_BREAKOUT;
         storyCount++;

         lastAction="M15 SELL STORY FROZEN -> WAIT M5 BREAK OF L2";
         Log(lastAction+
             " | H1="+DoubleToString(s1.price,_Digits)+
             " L1="+DoubleToString(s2.price,_Digits)+
             " H2="+DoubleToString(s3.price,_Digits)+
             " L2="+DoubleToString(s4.price,_Digits));
      }
   }
}

// =============================================================
// STATE 1: WAIT FOR FRESH M5 BREAKOUT
// =============================================================
void ProcessM5Breakout()
{
   if(state!=WAIT_M5_BREAKOUT || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   MqlRates b1,b2;
   if(!GetBar(MapTF,1,b1) || !GetBar(MapTF,2,b2))
      return;

   // Story must be known before this breakout closes. No historical chasing.
   if(b1.time<storyArmedAt)
      return;

   double buffer=MathMax(
      avgM5Range*MathMax(0.0,M5BreakBufferRangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(frozenDir==DIR_BUY)
   {
      bool crossedFresh=(b2.close<=frozenBreakLevel &&
                         b1.close>frozenBreakLevel+buffer);

      if(crossedFresh)
      {
         breakoutClosedAt=iTime(_Symbol,MapTF,0);
         fibA=frozenPreviousHL_LH;
         fibB=frozenBreakLevel;
         state=WAIT_M5_RETEST;
         breakoutCount++;

         lastAction="M5 BROKE FROZEN H2 -> NO BUY / WAIT EXACT RETEST";
         Log(lastAction);
      }
   }
   else
   {
      bool crossedFresh=(b2.close>=frozenBreakLevel &&
                         b1.close<frozenBreakLevel-buffer);

      if(crossedFresh)
      {
         breakoutClosedAt=iTime(_Symbol,MapTF,0);
         fibA=frozenPreviousHL_LH;
         fibB=frozenBreakLevel;
         state=WAIT_M5_RETEST;
         breakoutCount++;

         lastAction="M5 BROKE FROZEN L2 -> NO SELL / WAIT EXACT RETEST";
         Log(lastAction);
      }
   }
}

// =============================================================
// STATE 2: WAIT FOR EXACT M5 RETEST AND FREEZE IT
// =============================================================
void ProcessM5Retest()
{
   if(state!=WAIT_M5_RETEST || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   if(BreakoutExpiryMinutes>0 &&
      TimeCurrent()-breakoutClosedAt>BreakoutExpiryMinutes*60)
   {
      RequireNewStory("BREAKOUT EXPIRED WITHOUT RETEST -> WAIT NEW M15 STORY");
      return;
   }

   MqlRates b;
   if(!GetBar(MapTF,1,b))
      return;

   if(b.time<breakoutClosedAt)
      return;

   double zone=avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(frozenDir==DIR_BUY)
   {
      bool touched=(b.low<=frozenBreakLevel+zone);
      bool heldOnClose=(b.close>=frozenBreakLevel);
      bool depthOK=(b.low>=frozenBreakLevel-maxDepth);
      bool newHL=(b.low>frozenPreviousHL_LH);

      if(touched && heldOnClose && depthOK && newHL)
      {
         retestLow=b.low;
         retestHigh=b.high;
         retestConfirmedAt=iTime(_Symbol,MapTF,0);
         fibC=retestLow;
         state=WAIT_M1_TRIGGER;
         retestCount++;

         lastAction="M5 RETEST FROZEN -> NEW HL ABOVE OLD L2 / WAIT M1";
         Log(lastAction+
             " | H2="+DoubleToString(frozenBreakLevel,_Digits)+
             " | newHL="+DoubleToString(retestLow,_Digits));
         return;
      }

      if(b.low<=frozenPreviousHL_LH || b.close<frozenBreakLevel-maxDepth)
      {
         RequireNewStory("BUY RETEST FAILED STRUCTURE -> WAIT NEW M15 STORY");
         return;
      }
   }
   else
   {
      bool touched=(b.high>=frozenBreakLevel-zone);
      bool heldOnClose=(b.close<=frozenBreakLevel);
      bool depthOK=(b.high<=frozenBreakLevel+maxDepth);
      bool newLH=(b.high<frozenPreviousHL_LH);

      if(touched && heldOnClose && depthOK && newLH)
      {
         retestLow=b.low;
         retestHigh=b.high;
         retestConfirmedAt=iTime(_Symbol,MapTF,0);
         fibC=retestHigh;
         state=WAIT_M1_TRIGGER;
         retestCount++;

         lastAction="M5 RETEST FROZEN -> NEW LH BELOW OLD H2 / WAIT M1";
         Log(lastAction+
             " | L2="+DoubleToString(frozenBreakLevel,_Digits)+
             " | newLH="+DoubleToString(retestHigh,_Digits));
         return;
      }

      if(b.high>=frozenPreviousHL_LH || b.close>frozenBreakLevel+maxDepth)
      {
         RequireNewStory("SELL RETEST FAILED STRUCTURE -> WAIT NEW M15 STORY");
      }
   }
}

// =============================================================
// STATE 3: WAIT FOR M1 SNIPER TRIGGER
// =============================================================
double HighestM1High(int startShift,int count)
{
   MqlRates rates[];
   if(CopyRates(_Symbol,EntryTF,startShift,count,rates)!=count)
      return 0.0;

   double h=rates[0].high;
   for(int i=1;i<count;i++)
      if(rates[i].high>h)
         h=rates[i].high;

   return h;
}

double LowestM1Low(int startShift,int count)
{
   MqlRates rates[];
   if(CopyRates(_Symbol,EntryTF,startShift,count,rates)!=count)
      return 0.0;

   double l=rates[0].low;
   for(int i=1;i<count;i++)
      if(rates[i].low<l)
         l=rates[i].low;

   return l;
}

void BuildFibTargets()
{
   double leg=MathAbs(fibB-fibA);

   if(leg<=0.0 || fibC<=0.0)
   {
      tp1Price=0.0;
      tp2Price=0.0;
      tp3Price=0.0;
      return;
   }

   if(positionDir==DIR_BUY)
   {
      tp1Price=fibC+leg*FibTP1;
      tp2Price=fibC+leg*FibTP2;
      tp3Price=fibC+leg*FibTP3;
   }
   else
   {
      tp1Price=fibC-leg*FibTP1;
      tp2Price=fibC-leg*FibTP2;
      tp3Price=fibC-leg*FibTP3;
   }
}

bool OpenSniperTrade()
{
   if(state!=WAIT_M1_TRIGGER || frozenDir==DIR_NONE || HasPosition())
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(frozenDir==DIR_BUY ? tick.ask : tick.bid);
   double maxDistance=avgM5Range*MathMax(0.0,MaxEntryDistanceFromM15LevelM5RangeFrac);

   if(MathAbs(entry-frozenBreakLevel)>maxDistance)
   {
      lateBlockCount++;
      RequireNewStory("M1 CONFIRMED TOO LATE -> WAIT NEW M15 STORY");
      return false;
   }

   double breathing=MathMax(
      avgM5Range*MathMax(0.0,StopBreathingM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   double sl=(frozenDir==DIR_BUY ? retestLow-breathing
                                : retestHigh+breathing);
   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(frozenDir==DIR_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"BLUEPRINT_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"BLUEPRINT_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=frozenDir;
   initialPositionVolume=volume;

   // M15 owns the final runner exit.
   protectedM15=frozenPreviousHL_LH;
   confirmedM15Extreme=frozenBreakLevel;
   confirmedM15ExtremeTime=frozenStoryKey;
   candidateM15Structure=0.0;
   candidateM15StructureTime=0;

   BuildFibTargets();
   state=HOLD_TRADE;
   entryCount++;

   lastAction=(positionDir==DIR_BUY ? "BUY" : "SELL")+
              string(" SNIPER ENTRY -> HOLD THE MOUNTAIN");

   Log(lastAction+
       " | SL="+DoubleToString(sl,_Digits)+
       " | TP1="+DoubleToString(tp1Price,_Digits)+
       " | TP2="+DoubleToString(tp2Price,_Digits)+
       " | TP3="+DoubleToString(tp3Price,_Digits));

   return true;
}

void ProcessM1Trigger()
{
   if(state!=WAIT_M1_TRIGGER || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   if(RetestExpiryMinutes>0 &&
      TimeCurrent()-retestConfirmedAt>RetestExpiryMinutes*60)
   {
      RequireNewStory("M1 NEVER CONFIRMED RETEST -> WAIT NEW M15 STORY");
      return;
   }

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   int barSeconds=PeriodSeconds(EntryTF);
   if(signal.time<retestConfirmedAt+MathMax(1,MinM1BarsAfterRetest)*barSeconds)
      return;

   int lookback=MathMax(2,M1PullbackLookback);
   double minRecovery=MathMax(
      avgM5Range*MathMax(0.0,MinM1RecoveryM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(frozenDir==DIR_BUY)
   {
      double minorHigh=HighestM1High(2,lookback);
      if(minorHigh<=0.0)
         return;

      bool bullish=(signal.close>signal.open);
      bool holdsRetestLevel=(signal.close>frozenBreakLevel);
      bool breaksMinorPullback=(signal.close>minorHigh);
      bool recovered=(signal.close-fibC>=minRecovery);

      if(bullish && holdsRetestLevel && breaksMinorPullback && recovered)
         OpenSniperTrade();
   }
   else
   {
      double minorLow=LowestM1Low(2,lookback);
      if(minorLow<=0.0)
         return;

      bool bearish=(signal.close<signal.open);
      bool holdsRetestLevel=(signal.close<frozenBreakLevel);
      bool breaksMinorPullback=(signal.close<minorLow);
      bool recovered=(fibC-signal.close>=minRecovery);

      if(bearish && holdsRetestLevel && breaksMinorPullback && recovered)
         OpenSniperTrade();
   }
}

// =============================================================
// STATE 4: HOLD THE MOUNTAIN
// M15 structure can advance only after a candidate HL/LH is PROVEN
// by a new HH/LL. Small pullbacks do not move protection.
// =============================================================
void UpdateHoldCandidateFromNewestSwing()
{
   if(state!=HOLD_TRADE || swingCount<=0)
      return;

   SwingPoint s=swings[swingCount-1];

   if(positionDir==DIR_BUY)
   {
      if(s.type==-1 &&
         s.time>confirmedM15ExtremeTime &&
         s.price>protectedM15)
      {
         if(candidateM15Structure<=0.0 || s.price<candidateM15Structure)
         {
            candidateM15Structure=s.price;
            candidateM15StructureTime=s.time;
            Log("BUY CANDIDATE M15 HL -> WAIT NEW HH TO PROVE IT");
         }
      }
   }
   else if(positionDir==DIR_SELL)
   {
      if(s.type==1 &&
         s.time>confirmedM15ExtremeTime &&
         s.price<protectedM15)
      {
         if(candidateM15Structure<=0.0 || s.price>candidateM15Structure)
         {
            candidateM15Structure=s.price;
            candidateM15StructureTime=s.time;
            Log("SELL CANDIDATE M15 LH -> WAIT NEW LL TO PROVE IT");
         }
      }
   }
}

void ProcessM15HoldExit()
{
   if(state!=HOLD_TRADE || positionDir==DIR_NONE || !HasPosition() || avgM15Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   double buffer=avgM15Range*MathMax(0.0,M15ExitBreakBufferRangeFrac);

   if(positionDir==DIR_BUY)
   {
      // Final exit only on CLOSED M15 break of confirmed protected HL.
      if(closed.close<protectedM15-buffer)
      {
         lastConsumedStoryKey=frozenStoryKey;
         CloseCurrentPosition("BUY EXIT -> REAL CLOSED M15 STRUCTURE BREAK");
         return;
      }

      // Ratchet only after a candidate HL is proven by a new HH.
      if(candidateM15Structure>0.0 &&
         closed.close>confirmedM15Extreme+buffer)
      {
         protectedM15=candidateM15Structure;
         candidateM15Structure=0.0;
         candidateM15StructureTime=0;
         confirmedM15Extreme=closed.high;
         confirmedM15ExtremeTime=closed.time;
         Log("BUY M15 STRUCTURE ADVANCED -> NEW HL NOW PROTECTED");
      }
      else if(candidateM15Structure<=0.0 &&
              closed.close>confirmedM15Extreme+buffer)
      {
         confirmedM15Extreme=closed.high;
         confirmedM15ExtremeTime=closed.time;
      }
   }
   else
   {
      if(closed.close>protectedM15+buffer)
      {
         lastConsumedStoryKey=frozenStoryKey;
         CloseCurrentPosition("SELL EXIT -> REAL CLOSED M15 STRUCTURE BREAK");
         return;
      }

      if(candidateM15Structure>0.0 &&
         closed.close<confirmedM15Extreme-buffer)
      {
         protectedM15=candidateM15Structure;
         candidateM15Structure=0.0;
         candidateM15StructureTime=0;
         confirmedM15Extreme=closed.low;
         confirmedM15ExtremeTime=closed.time;
         Log("SELL M15 STRUCTURE ADVANCED -> NEW LH NOW PROTECTED");
      }
      else if(candidateM15Structure<=0.0 &&
              closed.close<confirmedM15Extreme-buffer)
      {
         confirmedM15Extreme=closed.low;
         confirmedM15ExtremeTime=closed.time;
      }
   }
}

// =============================================================
// FIB TARGET MANAGEMENT
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

   partialCount++;
   Log(label+" PARTIAL CLOSED | volume="+DoubleToString(closeVol,8));
   return true;
}

void ManageFibTargets()
{
   if(state!=HOLD_TRADE || !UseFibTargets || positionDir==DIR_NONE || !HasPosition())
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
         {
            lastConsumedStoryKey=frozenStoryKey;
            CloseCurrentPosition("FIB TP3 HIT -> CLOSE MINIMUM-LOT WINNER");
         }
      }
   }
}

// =============================================================
// BAR EVENTS
// =============================================================
void OnNewM15()
{
   datetime current=iTime(_Symbol,DirectionTF,0);
   if(current<=0 || current==lastM15Bar)
      return;

   lastM15Bar=current;
   AvgRange(DirectionTF,1,M15AverageRangeLookback,avgM15Range);

   bool newSwing=DetectNewestConfirmedM15Swing();

   if(state==HOLD_TRADE)
   {
      if(newSwing)
         UpdateHoldCandidateFromNewestSwing();

      ProcessM15HoldExit();
   }
   else if(state==FIND_M15_STORY)
   {
      TryFreezeM15Story();
   }
}

void OnNewM5()
{
   datetime current=iTime(_Symbol,MapTF,0);
   if(current<=0 || current==lastM5Bar)
      return;

   lastM5Bar=current;
   AvgRange(MapTF,1,M5AverageRangeLookback,avgM5Range);

   if(state==WAIT_M5_BREAKOUT)
      ProcessM5Breakout();
   else if(state==WAIT_M5_RETEST)
      ProcessM5Retest();
}

void OnNewM1()
{
   datetime current=iTime(_Symbol,EntryTF,0);
   if(current<=0 || current==lastM1Bar)
      return;

   lastM1Bar=current;

   if(state==WAIT_M1_TRIGGER)
      ProcessM1Trigger();
}

// =============================================================
// PANEL
// =============================================================
string StateText()
{
   if(state==FIND_M15_STORY)   return "0 FIND M15 STORY";
   if(state==WAIT_M5_BREAKOUT) return "1 WAIT M5 BREAKOUT";
   if(state==WAIT_M5_RETEST)   return "2 WAIT M5 RETEST";
   if(state==WAIT_M1_TRIGGER)  return "3 WAIT M1 TRIGGER";
   if(state==HOLD_TRADE)       return "4 HOLD TRADE";
   return "UNKNOWN";
}

string DirText()
{
   if(frozenDir==DIR_BUY || positionDir==DIR_BUY) return "BUY";
   if(frozenDir==DIR_SELL || positionDir==DIR_SELL) return "SELL";
   return "NONE";
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
      "MOUNTAIN RIDER - STRICT BLUEPRINT STATE MACHINE\n",
      "STATE: ",StateText(),"\n",
      "DIRECTION: ",DirText(),"\n",
      "POSITION: ",pos," | VOL: ",DoubleToString(volume,4),"\n",
      "FROZEN M15 LEVEL H2/L2: ",DoubleToString(frozenBreakLevel,_Digits),"\n",
      "PREVIOUS M15 HL/LH: ",DoubleToString(frozenPreviousHL_LH,_Digits),"\n",
      "FROZEN RETEST LOW/HIGH: ",DoubleToString(retestLow,_Digits)," / ",DoubleToString(retestHigh,_Digits),"\n",
      "PROTECTED M15 STRUCTURE: ",DoubleToString(protectedM15,_Digits),"\n",
      "FIB A/B/C: ",DoubleToString(fibA,_Digits)," / ",DoubleToString(fibB,_Digits)," / ",DoubleToString(fibC,_Digits),"\n",
      "TP1: ",DoubleToString(tp1Price,_Digits)," [",(tp1Hit?"HIT":"WAIT"),"]",
      " | TP2: ",DoubleToString(tp2Price,_Digits)," [",(tp2Hit?"HIT":"WAIT"),"]",
      " | TP3: ",DoubleToString(tp3Price,_Digits)," [",(tp3Hit?"HIT":"WAIT"),"]\n",
      "STORIES: ",IntegerToString(storyCount),
      " | BREAKOUTS: ",IntegerToString(breakoutCount),
      " | RETESTS: ",IntegerToString(retestCount),
      " | ENTRIES: ",IntegerToString(entryCount),"\n",
      "PARTIALS: ",IntegerToString(partialCount),
      " | EXITS: ",IntegerToString(exitCount),
      " | CANCELS: ",IntegerToString(cancelCount),
      " | LATE BLOCKS: ",IntegerToString(lateBlockCount),"\n",
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

   AvgRange(DirectionTF,1,M15AverageRangeLookback,avgM15Range);
   AvgRange(MapTF,1,M5AverageRangeLookback,avgM5Range);

   SeedM15Swings();

   state=FIND_M15_STORY;
   lastConsumedStoryKey=0;
   ClearFrozenSetup();
   ResetPositionState();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   TryFreezeM15Story();

   Log("INIT STRICT BLUEPRINT STATE MACHINE");
   Log("M15 FREEZES STORY -> M5 BREAKS -> M5 RETESTS -> M1 TRIGGERS -> HOLD");
   Log("NO MID-SETUP RECALCULATION. NO BREAKOUT ENTRY. ONE STORY = ONE ATTEMPT.");
   Log("NO BREAKEVEN. NO TIGHT TRAIL. FINAL RUNNER EXITS ON REAL CLOSED M15 STRUCTURE BREAK.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");
   Log("DEINIT | stories="+IntegerToString(storyCount)+
       " | entries="+IntegerToString(entryCount)+
       " | exits="+IntegerToString(exitCount));
}

void OnTick()
{
   SyncBrokerClosedPosition();

   OnNewM15();
   OnNewM5();
   OnNewM1();

   ManageFibTargets();
   Panel();
}
