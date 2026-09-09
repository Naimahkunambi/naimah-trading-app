#property strict
#property version "8.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// MOUNTAIN RIDER V8 - BLUEPRINT ONLY
// =============================================================
// FROM SCRATCH. ONLY THE BLUEPRINT:
//
// M15 = STORY
// BUY  : L1 -> H1 -> L2 -> H2, where L2>L1 and H2>H1
// SELL : H1 -> L1 -> H2 -> L2, where H2<H1 and L2<L1
//
// M5 = PLACE
// Wait for CLOSED M5 breakout of the EXACT M15 H2/L2.
// DO NOT enter the breakout.
// Wait for CLOSED M5 retest of that exact level.
// BUY retest must form a new HL above prior M15 L2.
// SELL retest must form a new LH below prior M15 H2.
//
// M1 = TRIGGER
// After retest holds, wait for CLOSED M1 break of the minor pullback.
// Enter only if still close to the retest level.
//
// STOP
// BUY  below complete M5 retest low + breathing room.
// SELL above complete M5 retest high + breathing room.
//
// HOLD
// No breakeven. No tight trailing. No small-pullback exit.
// Final runner exits only when CLOSED M15 breaks confirmed structure.
//
// FIB EXTENSION
// BUY  A=L2, B=H2, C=new M5 retest HL
// SELL A=H2, B=L2, C=new M5 retest LH
// TP1=1.272, TP2=1.618, TP3=2.000 by default.
//
// ONE M15 LEG = ONE ATTEMPT.
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
   WAIT_M1_TRIGGER = 2
};

// =============================================================
// INPUTS
// =============================================================
input double Lots = 0.01;
input ulong Magic = 260909008;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// M15 story
input int M15PivotWing = 3;
input int M15SeedLookbackBars = 320;
input int M15AverageRangeLookback = 12;
input double MinM15StructureDifferenceRangeFrac = 0.10;
input double MinM15LegSizeRangeFrac = 1.00;
input double M15StructureBreakBufferRangeFrac = 0.10;

// M5 place
input int M5AverageRangeLookback = 12;
input double M5BreakBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.75;
input int BreakoutExpiryMinutes = 180;
input int RetestExpiryMinutes = 75;

// M1 trigger
input int M1PullbackLookback = 3;
input double MinM1RecoveryM5RangeFrac = 0.15;
input double MaxEntryDistanceFromM15LevelM5RangeFrac = 0.85;

// Stop breathing
input double StopBreathingM5RangeFrac = 0.40;

// Fib extension
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
double storyLevel = 0.0;          // exact M15 H2 / L2
double storyLaunch = 0.0;         // previous M15 HL/LH

double protectedM15 = 0.0;
double structureExtreme = 0.0;    // current confirmed HH/LL
datetime structureExtremeTime = 0;
double candidateStructure = 0.0;  // next candidate HL/LH
datetime candidateStructureTime = 0;

datetime storyKeyTime = 0;
bool storyConsumed = false;

SetupStage setupStage = SETUP_IDLE;
datetime breakoutTime = 0;

double retestLow = 0.0;
double retestHigh = 0.0;
datetime retestConfirmedAt = 0;

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
double initialPositionVolume = 0.0;

double avgM15Range = 0.0;
double avgM5Range = 0.0;

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

string lastAction = "WAITING FOR M15 STORY";
ulong lastPanelMs = 0;

// =============================================================
// HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V8] ",text);
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
      lastAction="POSITION CLOSED BY STRUCTURAL SL/BROKER";
      Log(lastAction);
      ResetPositionState();
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

bool AddM15Swing(int type,double price,datetime when)
{
   if(m15SwingCount>0 && m15Swings[m15SwingCount-1].time==when)
      return false;

   if(m15SwingCount>0 && m15Swings[m15SwingCount-1].type==type)
   {
      bool replace=(type>0 ? price>m15Swings[m15SwingCount-1].price
                           : price<m15Swings[m15SwingCount-1].price);

      if(replace)
      {
         m15Swings[m15SwingCount-1].price=price;
         m15Swings[m15SwingCount-1].time=when;
         return true;
      }
      return false;
   }

   if(m15SwingCount<MAX_SWINGS)
   {
      m15Swings[m15SwingCount].type=type;
      m15Swings[m15SwingCount].price=price;
      m15Swings[m15SwingCount].time=when;
      m15SwingCount++;
      return true;
   }

   for(int i=1;i<MAX_SWINGS;i++)
      m15Swings[i-1]=m15Swings[i];

   m15Swings[MAX_SWINGS-1].type=type;
   m15Swings[MAX_SWINGS-1].price=price;
   m15Swings[MAX_SWINGS-1].time=when;
   return true;
}

bool DetectM15PivotAtShift(int centerShift)
{
   int wing=MathMax(1,M15PivotWing);

   double hp=0.0,lp=0.0;
   datetime ht=0,lt=0;

   bool high=IsPivotHigh(DirectionTF,centerShift,wing,hp,ht);
   bool low =IsPivotLow(DirectionTF,centerShift,wing,lp,lt);

   if(high && low)
      return false;

   if(high)
      return AddM15Swing(1,hp,ht);

   if(low)
      return AddM15Swing(-1,lp,lt);

   return false;
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
// DYNAMIC CONFIRMED M15 STRUCTURE FOR HOLD/EXIT
// =============================================================
void UpdateStructureFromLatestSwing()
{
   if(storyDir==DIR_NONE || m15SwingCount<=0)
      return;

   SwingPoint s=m15Swings[m15SwingCount-1];

   if(storyDir==DIR_BUY)
   {
      if(s.type==-1 && s.time>structureExtremeTime && s.price>protectedM15)
      {
         candidateStructure=s.price;
         candidateStructureTime=s.time;
         Log("BUY CANDIDATE HL FORMED -> WAIT NEW HH TO CONFIRM");
      }
   }
   else if(storyDir==DIR_SELL)
   {
      if(s.type==1 && s.time>structureExtremeTime && s.price<protectedM15)
      {
         candidateStructure=s.price;
         candidateStructureTime=s.time;
         Log("SELL CANDIDATE LH FORMED -> WAIT NEW LL TO CONFIRM");
      }
   }
}

void ProcessM15HoldStructure()
{
   if(storyDir==DIR_NONE || avgM15Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   double buffer=avgM15Range*MathMax(0.0,M15StructureBreakBufferRangeFrac);

   if(storyDir==DIR_BUY)
   {
      if(closed.close<protectedM15-buffer)
      {
         if(HasPosition())
            CloseCurrentPosition("BUY EXIT -> REAL CLOSED M15 BREAK OF CONFIRMED HL");

         storyDir=DIR_NONE;
         storyLevel=0.0;
         storyLaunch=0.0;
         protectedM15=0.0;
         structureExtreme=0.0;
         structureExtremeTime=0;
         candidateStructure=0.0;
         candidateStructureTime=0;
         storyKeyTime=0;
         storyConsumed=false;
         ResetSetup();
         m15SwingCount=0;
         lastAction="BUY MOUNTAIN ENDED -> WAIT FRESH M15 STORY";
         Log(lastAction);
         return;
      }

      if(candidateStructure>0.0 && closed.close>structureExtreme+buffer)
      {
         protectedM15=candidateStructure;
         candidateStructure=0.0;
         candidateStructureTime=0;
         structureExtreme=closed.high;
         structureExtremeTime=closed.time;
         Log("BUY STRUCTURE ADVANCED -> NEW HL CONFIRMED BY NEW HH");
      }
      else if(candidateStructure<=0.0 && closed.close>structureExtreme+buffer)
      {
         structureExtreme=closed.high;
         structureExtremeTime=closed.time;
      }
   }
   else if(storyDir==DIR_SELL)
   {
      if(closed.close>protectedM15+buffer)
      {
         if(HasPosition())
            CloseCurrentPosition("SELL EXIT -> REAL CLOSED M15 BREAK OF CONFIRMED LH");

         storyDir=DIR_NONE;
         storyLevel=0.0;
         storyLaunch=0.0;
         protectedM15=0.0;
         structureExtreme=0.0;
         structureExtremeTime=0;
         candidateStructure=0.0;
         candidateStructureTime=0;
         storyKeyTime=0;
         storyConsumed=false;
         ResetSetup();
         m15SwingCount=0;
         lastAction="SELL MOUNTAIN ENDED -> WAIT FRESH M15 STORY";
         Log(lastAction);
         return;
      }

      if(candidateStructure>0.0 && closed.close<structureExtreme-buffer)
      {
         protectedM15=candidateStructure;
         candidateStructure=0.0;
         candidateStructureTime=0;
         structureExtreme=closed.low;
         structureExtremeTime=closed.time;
         Log("SELL STRUCTURE ADVANCED -> NEW LH CONFIRMED BY NEW LL");
      }
      else if(candidateStructure<=0.0 && closed.close<structureExtreme-buffer)
      {
         structureExtreme=closed.low;
         structureExtremeTime=closed.time;
      }
   }
}

// =============================================================
// M15 STORY
// =============================================================
void ArmStory(TrendDir dir,double exactLevel,double launch,double protectedLevel,datetime keyTime)
{
   storyDir=dir;
   storyLevel=exactLevel;
   storyLaunch=launch;
   protectedM15=protectedLevel;
   structureExtreme=exactLevel;
   structureExtremeTime=keyTime;
   candidateStructure=0.0;
   candidateStructureTime=0;
   storyKeyTime=keyTime;
   storyConsumed=false;
   stories++;

   ResetSetup();

   lastAction=(dir==DIR_BUY ?
      "M15 BUY STORY READY -> WAIT M5 BREAK OF EXACT H2" :
      "M15 SELL STORY READY -> WAIT M5 BREAK OF EXACT L2");

   Log(lastAction+
       " | exact level="+DoubleToString(storyLevel,_Digits)+
       " | protected="+DoubleToString(protectedM15,_Digits));
}

void EvaluateM15Story()
{
   if(avgM15Range<=0.0 || HasPosition() || setupStage!=SETUP_IDLE)
      return;

   SwingPoint s1,s2,s3,s4;
   if(!LatestFourM15(s1,s2,s3,s4))
      return;

   double minDiff=avgM15Range*MathMax(0.0,MinM15StructureDifferenceRangeFrac);
   double minLeg=avgM15Range*MathMax(0.0,MinM15LegSizeRangeFrac);

   // BUY: L1 -> H1 -> L2 -> H2
   if(s1.type==-1 && s2.type==1 && s3.type==-1 && s4.type==1)
   {
      bool higherLow=(s3.price>s1.price+minDiff);
      bool higherHigh=(s4.price>s2.price+minDiff);
      bool leg1=((s2.price-s1.price)>=minLeg);
      bool leg2=((s4.price-s3.price)>=minLeg);

      bool fresh=(storyDir==DIR_NONE || storyDir==DIR_BUY) &&
                 (s4.time!=storyKeyTime);

      if(higherLow && higherHigh && leg1 && leg2 && fresh)
      {
         ArmStory(DIR_BUY,s4.price,s3.price,s3.price,s4.time);
         return;
      }
   }

   // SELL: H1 -> L1 -> H2 -> L2
   if(s1.type==1 && s2.type==-1 && s3.type==1 && s4.type==-1)
   {
      bool lowerHigh=(s3.price<s1.price-minDiff);
      bool lowerLow=(s4.price<s2.price-minDiff);
      bool leg1=((s1.price-s2.price)>=minLeg);
      bool leg2=((s3.price-s4.price)>=minLeg);

      bool fresh=(storyDir==DIR_NONE || storyDir==DIR_SELL) &&
                 (s4.time!=storyKeyTime);

      if(lowerHigh && lowerLow && leg1 && leg2 && fresh)
      {
         ArmStory(DIR_SELL,s4.price,s3.price,s3.price,s4.time);
         return;
      }
   }
}

// =============================================================
// M5 PLACE
// =============================================================
void LookForM5Breakout()
{
   if(HasPosition() || setupStage!=SETUP_IDLE || storyDir==DIR_NONE || storyConsumed || avgM5Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   double buffer=MathMax(
      avgM5Range*MathMax(0.0,M5BreakBufferRangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY && closed.close>storyLevel+buffer)
   {
      storyConsumed=true;
      setupStage=WAIT_M5_RETEST;
      breakoutTime=closed.time;
      fibA=storyLaunch;
      fibB=storyLevel;
      breakouts++;
      lastAction="M5 BROKE EXACT M15 H2 -> DO NOT BUY / WAIT RETEST";
      Log(lastAction);
      return;
   }

   if(storyDir==DIR_SELL && closed.close<storyLevel-buffer)
   {
      storyConsumed=true;
      setupStage=WAIT_M5_RETEST;
      breakoutTime=closed.time;
      fibA=storyLaunch;
      fibB=storyLevel;
      breakouts++;
      lastAction="M5 BROKE EXACT M15 L2 -> DO NOT SELL / WAIT RETEST";
      Log(lastAction);
   }
}

void ProcessM5Retest()
{
   if(HasPosition() || setupStage==SETUP_IDLE || storyDir==DIR_NONE || avgM5Range<=0.0)
      return;

   if(BreakoutExpiryMinutes>0 && TimeCurrent()-breakoutTime>BreakoutExpiryMinutes*60)
   {
      cancels++;
      lastAction="SETUP EXPIRED -> NO RETEST / WAIT NEW M15 LEG";
      Log(lastAction);
      ResetSetup();
      return;
   }

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   if(closed.time<=breakoutTime)
      return;

   double zone=avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(setupStage==WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY)
      {
         bool cameBack=(closed.low<=storyLevel+zone);
         bool heldLevel=(closed.close>=storyLevel);
         bool depthOK=(closed.low>=storyLevel-maxDepth);
         bool newHL=(closed.low>storyLaunch);

         if(cameBack && heldLevel && depthOK && newHL)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestConfirmedAt=iTime(_Symbol,MapTF,0);
            fibC=retestLow;
            setupStage=WAIT_M1_TRIGGER;
            retests++;
            lastAction="M5 RETEST HELD H2 -> NEW HL FORMED / WAIT M1";
            Log(lastAction);
            return;
         }

         if(closed.low<=storyLaunch || closed.close<storyLevel-maxDepth)
         {
            cancels++;
            lastAction="BUY SETUP FAILED -> RETEST DID NOT HOLD STRUCTURE";
            Log(lastAction);
            ResetSetup();
            return;
         }
      }
      else if(storyDir==DIR_SELL)
      {
         bool cameBack=(closed.high>=storyLevel-zone);
         bool heldLevel=(closed.close<=storyLevel);
         bool depthOK=(closed.high<=storyLevel+maxDepth);
         bool newLH=(closed.high<storyLaunch);

         if(cameBack && heldLevel && depthOK && newLH)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestConfirmedAt=iTime(_Symbol,MapTF,0);
            fibC=retestHigh;
            setupStage=WAIT_M1_TRIGGER;
            retests++;
            lastAction="M5 RETEST HELD L2 -> NEW LH FORMED / WAIT M1";
            Log(lastAction);
            return;
         }

         if(closed.high>=storyLaunch || closed.close>storyLevel+maxDepth)
         {
            cancels++;
            lastAction="SELL SETUP FAILED -> RETEST DID NOT HOLD STRUCTURE";
            Log(lastAction);
            ResetSetup();
            return;
         }
      }

      return;
   }

   if(setupStage==WAIT_M1_TRIGGER)
   {
      if(RetestExpiryMinutes>0 && TimeCurrent()-retestConfirmedAt>RetestExpiryMinutes*60)
      {
         cancels++;
         lastAction="NO LATE ENTRY -> M1 NEVER CONFIRMED";
         Log(lastAction);
         ResetSetup();
         return;
      }

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
            lastAction="BUY CANCELLED BEFORE ENTRY -> NEW HL FAILED";
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
            lastAction="SELL CANCELLED BEFORE ENTRY -> NEW LH FAILED";
            Log(lastAction);
            ResetSetup();
         }
      }
   }
}

// =============================================================
// M1 TRIGGER
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
      tp1Price=fibC+impulse*FibTP1;
      tp2Price=fibC+impulse*FibTP2;
      tp3Price=fibC+impulse*FibTP3;
   }
   else
   {
      tp1Price=fibC-impulse*FibTP1;
      tp2Price=fibC-impulse*FibTP2;
      tp3Price=fibC-impulse*FibTP3;
   }
}

bool OpenSniperTrade()
{
   if(HasPosition() || setupStage!=WAIT_M1_TRIGGER || storyDir==DIR_NONE || avgM5Range<=0.0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(storyDir==DIR_BUY ? tick.ask : tick.bid);
   double maxDistance=avgM5Range*MathMax(0.0,MaxEntryDistanceFromM15LevelM5RangeFrac);

   if(MathAbs(entry-storyLevel)>maxDistance)
   {
      lateBlocks++;
      lastAction="ENTRY BLOCKED -> TOO LATE / TOO FAR FROM RETEST";
      Log(lastAction);
      ResetSetup();
      return false;
   }

   double breathing=MathMax(
      avgM5Range*MathMax(0.0,StopBreathingM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   double sl=(storyDir==DIR_BUY ? retestLow-breathing : retestHigh+breathing);
   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(storyDir==DIR_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V8_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V8_SELL");

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

   lastAction=(positionDir==DIR_BUY ? "BUY" : "SELL")+
              string(" SNIPER ENTRY -> HOLD THE MOUNTAIN");

   Log(lastAction+
       " | SL="+DoubleToString(sl,_Digits)+
       " | TP1="+DoubleToString(tp1Price,_Digits)+
       " | TP2="+DoubleToString(tp2Price,_Digits)+
       " | TP3="+DoubleToString(tp3Price,_Digits));

   setupStage=SETUP_IDLE;
   breakoutTime=0;
   retestLow=0.0;
   retestHigh=0.0;
   retestConfirmedAt=0;

   return true;
}

void ProcessM1Trigger()
{
   if(HasPosition() || setupStage!=WAIT_M1_TRIGGER || storyDir==DIR_NONE)
      return;

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   if(signal.time<retestConfirmedAt)
      return;

   int lookback=MathMax(2,M1PullbackLookback);
   double minRecovery=MathMax(
      avgM5Range*MathMax(0.0,MinM1RecoveryM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY)
   {
      double pullbackHigh=HighestM1High(2,lookback);
      if(pullbackHigh<=0.0)
         return;

      bool bullish=(signal.close>signal.open);
      bool holdsLevel=(signal.close>storyLevel);
      bool breaksPullback=(signal.close>pullbackHigh);
      bool enoughRecovery=(signal.close-fibC>=minRecovery);

      if(bullish && holdsLevel && breaksPullback && enoughRecovery)
         OpenSniperTrade();
   }
   else
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0.0)
         return;

      bool bearish=(signal.close<signal.open);
      bool holdsLevel=(signal.close<storyLevel);
      bool breaksPullback=(signal.close<pullbackLow);
      bool enoughRecovery=(fibC-signal.close>=minRecovery);

      if(bearish && holdsLevel && breaksPullback && enoughRecovery)
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
         TryPartial("TP1 "+DoubleToString(FibTP1,3),TP1PartialPercent);
      }
   }

   if(!tp2Hit && tp2Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp2Price : price<=tp2Price);
      if(hit)
      {
         tp2Hit=true;
         TryPartial("TP2 "+DoubleToString(FibTP2,3),TP2PartialPercent);
      }
   }

   if(!tp3Hit && tp3Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp3Price : price<=tp3Price);
      if(hit)
      {
         tp3Hit=true;
         bool partialDone=TryPartial("TP3 "+DoubleToString(FibTP3,3),TP3PartialPercent);

         if(!partialDone && CloseMinimumLotAtTP3)
            CloseCurrentPosition("TP3 HIT -> CLOSE MINIMUM-LOT WINNER");
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

   int center=MathMax(1,M15PivotWing)+1;
   bool swingChanged=DetectM15PivotAtShift(center);

   if(swingChanged)
      UpdateStructureFromLatestSwing();

   ProcessM15HoldStructure();

   if(!HasPosition() && setupStage==SETUP_IDLE)
      EvaluateM15Story();
}

void OnNewM5()
{
   datetime current=iTime(_Symbol,MapTF,0);
   if(current<=0 || current==lastM5Bar)
      return;

   lastM5Bar=current;
   AvgRange(MapTF,1,M5AverageRangeLookback,avgM5Range);

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
   ProcessM1Trigger();
}

// =============================================================
// PANEL
// =============================================================
string StoryText()
{
   if(storyDir==DIR_BUY)
      return "BUY: HH + HL";
   if(storyDir==DIR_SELL)
      return "SELL: LH + LL";
   return "WAIT";
}

string SetupText()
{
   if(setupStage==WAIT_M5_RETEST)
      return "BREAKOUT DONE -> WAIT EXACT RETEST";
   if(setupStage==WAIT_M1_TRIGGER)
      return "RETEST HELD -> WAIT M1 TRIGGER";
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
      "MOUNTAIN RIDER V8 - BLUEPRINT ONLY\n",
      "M15 STORY: ",StoryText(),"\n",
      "M5 PLACE: ",SetupText(),"\n",
      "POSITION: ",pos," | VOL: ",DoubleToString(volume,4),"\n",
      "EXACT M15 LEVEL: ",DoubleToString(storyLevel,_Digits),"\n",
      "PREVIOUS HL/LH: ",DoubleToString(storyLaunch,_Digits),"\n",
      "PROTECTED M15 HL/LH: ",DoubleToString(protectedM15,_Digits),"\n",
      "STORY USED: ",(storyConsumed?"YES":"NO"),"\n",
      "FIB A/B/C: ",DoubleToString(fibA,_Digits)," / ",
                       DoubleToString(fibB,_Digits)," / ",
                       DoubleToString(fibC,_Digits),"\n",
      "TP1: ",DoubleToString(tp1Price,_Digits)," [",(tp1Hit?"HIT":"WAIT"),"]",
      " | TP2: ",DoubleToString(tp2Price,_Digits)," [",(tp2Hit?"HIT":"WAIT"),"]",
      " | TP3: ",DoubleToString(tp3Price,_Digits)," [",(tp3Hit?"HIT":"WAIT"),"]\n",
      "STORIES: ",IntegerToString(stories),
      " | BREAKOUTS: ",IntegerToString(breakouts),
      " | RETESTS: ",IntegerToString(retests),
      " | ENTRIES: ",IntegerToString(entries),"\n",
      "PARTIALS: ",IntegerToString(partials),
      " | EXITS: ",IntegerToString(exits),
      " | CANCELS: ",IntegerToString(cancels),
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

   AvgRange(DirectionTF,1,M15AverageRangeLookback,avgM15Range);
   AvgRange(MapTF,1,M5AverageRangeLookback,avgM5Range);

   SeedM15Swings();

   storyDir=DIR_NONE;
   storyLevel=0.0;
   storyLaunch=0.0;
   protectedM15=0.0;
   structureExtreme=0.0;
   structureExtremeTime=0;
   candidateStructure=0.0;
   candidateStructureTime=0;
   storyKeyTime=0;
   storyConsumed=false;

   ResetSetup();
   ResetPositionState();
   EvaluateM15Story();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   Log("INIT V8 BLUEPRINT ONLY");
   Log("M15 STORY -> M5 EXACT BREAKOUT/RETEST -> M1 TRIGGER -> HOLD -> FIB TARGETS / REAL M15 STRUCTURE EXIT");
   Log("NO VWAP. NO EMA. NO RSI. NO BREAKOUT ENTRY. NO BREAKEVEN. NO TIGHT TRAILING.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");

   Log("DEINIT V8 | stories="+IntegerToString(stories)+
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
