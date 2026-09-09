#property strict
#property version "6.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// MOUNTAIN RIDER V6
// EXACT IDEA:
//   M15 TELLS THE STORY
//   M5 SHOWS THE PLACE
//   M1 PULLS THE TRIGGER
//
// BUY STORY ON M15:
//   L1 -> H1 -> L2 -> H2
//   L2 > L1  (higher low)
//   H2 > H1  (higher high)
//   H2 becomes THE ONLY breakout/retest level for this story leg.
//
// SELL STORY ON M15:
//   H1 -> L1 -> H2 -> L2
//   H2 < H1  (lower high)
//   L2 < L1  (lower low)
//   L2 becomes THE ONLY breakout/retest level for this story leg.
//
// M5:
//   Wait for a CLOSED M5 breakout of the exact M15 H2/L2.
//   NEVER enter the breakout.
//   Wait for price to return to that exact M15 level.
//   A CLOSED M5 candle must retest and HOLD the level.
//
// M1:
//   After the M5 retest holds, a CLOSED M1 candle must break the
//   short pullback in the M15 direction while still close to the retest.
//   That is the sniper entry.
//
// NO CHOP / NO OVERTRADING:
//   The M15 story itself must have meaningful swing size, spacing and
//   directional efficiency. One M15 story leg gets ONE breakout attempt.
//   If that attempt fails/expires/stops, the bot waits for a NEW M15 leg.
//
// STOP:
//   BUY below the complete M5 retest low + breathing room.
//   SELL above the complete M5 retest high + breathing room.
//   No tiny M1 stop. No automatic breakeven. No tight trailing.
//
// FIB EXTENSION:
//   BUY  A = M15 L2, B = breakout extension high, C = M5 retest low.
//   SELL A = M15 H2, B = breakout extension low,  C = M5 retest high.
//   TP1 1.272, TP2 1.618, TP3 2.000 by default.
//   If volume can split: partials at TP1/TP2/TP3 + runner.
//   If volume is only the minimum 0.01: TP1/TP2 are milestones and TP3
//   closes the full trade by default so a large winner cannot round-trip.
//
// FINAL RUNNER:
//   If volume remains, hold until a REAL CLOSED M15 structure break.
// =============================================================

#define MAX_SWINGS 40

struct SwingPoint
{
   int type;             // +1 = high, -1 = low
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

// =============================================================
// INPUTS
// =============================================================
input double Lots = 0.01;
input ulong Magic = 260909006;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// M15 story
input int M15PivotWing = 3;
input int M15SeedLookbackBars = 320;
input int M15RangeLookback = 12;
input double MinM15StepRangeFrac = 0.20;
input double MinM15ImpulseRangeFrac = 1.50;
input double MinStoryEfficiency = 0.45;
input int MinSwingSpacingBars = 2;
input double M15ExitBreakBufferRangeFrac = 0.10;

// M5 map
input int M5RangeLookback = 12;
input double M5BreakBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.75;
input int BreakoutExpiryMinutes = 180;
input int RetestExpiryMinutes = 75;

// M1 sniper
input int M1PullbackLookback = 3;
input double MinM1RecoveryM5RangeFrac = 0.20;
input double MaxEntryDistanceFromM15LevelM5RangeFrac = 0.85;

// stop
input double StopBreathingM5RangeFrac = 0.40;

// Fib extension targets
input bool UseFibTargets = true;
input double FibTP1 = 1.272;
input double FibTP2 = 1.618;
input double FibTP3 = 2.000;
input double TP1PartialPercent = 25.0;
input double TP2PartialPercent = 25.0;
input double TP3PartialPercent = 25.0;
input bool CloseMinimumLotAtTP3 = true;

// optional VWAP confluence for the M5 retest only
input bool UseVWAPRetestConfluence = false;
input int VWAPResetHour = 0;
input bool PreferRealVolume = false;
input double VWAPToleranceM5RangeFrac = 0.50;

// cost control
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
double storyLevel = 0.0;            // exact M15 HH/LL to break and retest
double storyLaunch = 0.0;           // M15 L2 for buy / H2 for sell
double protectedM15 = 0.0;          // final-runner structure level
datetime storyKeyTime = 0;          // newest M15 swing making story unique
bool storyConsumed = false;

SetupStage setupStage = STAGE_IDLE;
datetime m5BreakTime = 0;
double m5BreakExtreme = 0.0;

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

int storyCount = 0;
int breakoutCount = 0;
int retestCount = 0;
int entryCount = 0;
int exitCount = 0;
int partialCount = 0;
int cancelCount = 0;
int lateBlockCount = 0;
int chopRejectCount = 0;

string lastAction = "WAITING FOR CLEAN M15 STORY";
ulong lastPanelMs = 0;

// =============================================================
// BASIC HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V6] ",text);
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
   m5BreakTime=0;
   m5BreakExtreme=0.0;
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

   exitCount++;
   lastAction=reason;
   Log(reason);
   ResetPositionState();
   return true;
}

void SyncPositionState()
{
   if(positionDir!=DIR_NONE && !HasPosition())
   {
      exitCount++;
      lastAction="POSITION CLOSED BY STRUCTURAL STOP/BROKER";
      Log(lastAction);
      ResetPositionState();
   }
}

// =============================================================
// M15 SWING DETECTION
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
// M15 STORY QUALITY / CHOP REJECTION
// =============================================================
bool SpacingOK(SwingPoint &s1,SwingPoint &s2,SwingPoint &s3,SwingPoint &s4)
{
   int secondsPerBar=PeriodSeconds(DirectionTF);
   int minSeconds=MathMax(1,MinSwingSpacingBars)*secondsPerBar;

   if((s2.time-s1.time)<minSeconds) return false;
   if((s3.time-s2.time)<minSeconds) return false;
   if((s4.time-s3.time)<minSeconds) return false;

   return true;
}

double StoryEfficiency(SwingPoint &s1,SwingPoint &s2,SwingPoint &s3,SwingPoint &s4)
{
   double path=MathAbs(s2.price-s1.price)+
               MathAbs(s3.price-s2.price)+
               MathAbs(s4.price-s3.price);

   if(path<=0.0)
      return 0.0;

   double net=MathAbs(s4.price-s1.price);
   return net/path;
}

bool BuyStoryQuality(SwingPoint &l1,SwingPoint &h1,SwingPoint &l2,SwingPoint &h2)
{
   if(!(l1.type==-1 && h1.type==1 && l2.type==-1 && h2.type==1))
      return false;

   if(!SpacingOK(l1,h1,l2,h2))
      return false;

   double step=avgM15*MathMax(0.0,MinM15StepRangeFrac);
   double minImpulse=avgM15*MathMax(0.0,MinM15ImpulseRangeFrac);

   bool higherLow=(l2.price>=l1.price+step);
   bool higherHigh=(h2.price>=h1.price+step);
   bool impulse=(h2.price-l2.price)>=minImpulse;
   bool efficient=StoryEfficiency(l1,h1,l2,h2)>=MathMax(0.0,MinStoryEfficiency);

   return higherLow && higherHigh && impulse && efficient;
}

bool SellStoryQuality(SwingPoint &h1,SwingPoint &l1,SwingPoint &h2,SwingPoint &l2)
{
   if(!(h1.type==1 && l1.type==-1 && h2.type==1 && l2.type==-1))
      return false;

   if(!SpacingOK(h1,l1,h2,l2))
      return false;

   double step=avgM15*MathMax(0.0,MinM15StepRangeFrac);
   double minImpulse=avgM15*MathMax(0.0,MinM15ImpulseRangeFrac);

   bool lowerHigh=(h2.price<=h1.price-step);
   bool lowerLow=(l2.price<=l1.price-step);
   bool impulse=(h2.price-l2.price)>=minImpulse;
   bool efficient=StoryEfficiency(h1,l1,h2,l2)>=MathMax(0.0,MinStoryEfficiency);

   return lowerHigh && lowerLow && impulse && efficient;
}

void ArmStory(TrendDir dir,double level,double launch,double protectedLevel,datetime keyTime)
{
   bool newStory=(dir!=storyDir || keyTime!=storyKeyTime || MathAbs(level-storyLevel)>_Point);
   if(!newStory)
      return;

   storyDir=dir;
   storyLevel=level;
   storyLaunch=launch;
   protectedM15=protectedLevel;
   storyKeyTime=keyTime;
   storyConsumed=false;
   storyCount++;

   if(setupStage!=STAGE_IDLE)
   {
      cancelCount++;
      ResetSetup();
   }

   lastAction=(dir==DIR_BUY ?
      "M15 BUY STORY READY -> WAIT BREAK OF EXACT HH" :
      "M15 SELL STORY READY -> WAIT BREAK OF EXACT LL");

   Log(lastAction+
       " | level="+DoubleToString(storyLevel,_Digits)+
       " | protected="+DoubleToString(protectedM15,_Digits));
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

   cancelCount++;
   ResetSetup();

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

   double exitBuffer=avgM15*MathMax(0.0,M15ExitBreakBufferRangeFrac);

   // Final runner exits only on real closed M15 break of the protected structure.
   if(storyDir==DIR_BUY && protectedM15>0.0 && closed.close<protectedM15-exitBuffer)
   {
      EndStory("BUY EXIT -> CLOSED M15 BROKE PROTECTED HL");
      return;
   }

   if(storyDir==DIR_SELL && protectedM15>0.0 && closed.close>protectedM15+exitBuffer)
   {
      EndStory("SELL EXIT -> CLOSED M15 BROKE PROTECTED LH");
      return;
   }

   SwingPoint s1,s2,s3,s4;
   if(!LatestFourM15(s1,s2,s3,s4))
      return;

   // BUY = L1 H1 L2 H2. Exact H2 becomes the M5 breakout/retest level.
   if(s1.type==-1 && s2.type==1 && s3.type==-1 && s4.type==1)
   {
      if(BuyStoryQuality(s1,s2,s3,s4))
      {
         ArmStory(DIR_BUY,s4.price,s3.price,s3.price,s4.time);
         return;
      }

      chopRejectCount++;
      lastAction="M15 BUY SHAPE REJECTED -> TOO CHOPPY / TOO SMALL";
      return;
   }

   // SELL = H1 L1 H2 L2. Exact L2 becomes the M5 breakout/retest level.
   if(s1.type==1 && s2.type==-1 && s3.type==1 && s4.type==-1)
   {
      if(SellStoryQuality(s1,s2,s3,s4))
      {
         ArmStory(DIR_SELL,s4.price,s3.price,s3.price,s4.time);
         return;
      }

      chopRejectCount++;
      lastAction="M15 SELL SHAPE REJECTED -> TOO CHOPPY / TOO SMALL";
      return;
   }

   // Mixed structure does not create a trade.
}

// =============================================================
// OPTIONAL VWAP RETEST CONFLUENCE
// =============================================================
datetime SessionStart(datetime when)
{
   MqlDateTime dt;
   TimeToStruct(when,dt);
   int originalHour=dt.hour;

   dt.hour=VWAPResetHour;
   dt.min=0;
   dt.sec=0;

   datetime start=StructToTime(dt);
   if(originalHour<VWAPResetHour)
      start-=86400;

   return start;
}

double VWAPVolume(const MqlRates &bar)
{
   if(PreferRealVolume && bar.real_volume>0)
      return (double)bar.real_volume;

   return (double)bar.tick_volume;
}

bool ClosedM5VWAP(datetime barTime,double &vwap)
{
   datetime start=SessionStart(barTime);
   datetime stop=barTime+PeriodSeconds(MapTF)-1;

   MqlRates rates[];
   int copied=CopyRates(_Symbol,MapTF,start,stop,rates);
   if(copied<=0)
      return false;

   double pv=0.0;
   double vol=0.0;

   for(int i=0;i<copied;i++)
   {
      double v=VWAPVolume(rates[i]);
      if(v<=0.0)
         continue;

      double hlc3=(rates[i].high+rates[i].low+rates[i].close)/3.0;
      pv+=hlc3*v;
      vol+=v;
   }

   if(vol<=0.0)
      return false;

   vwap=pv/vol;
   return true;
}

bool VWAPRetestOK(const MqlRates &bar)
{
   if(!UseVWAPRetestConfluence)
      return true;

   double vwap=0.0;
   if(!ClosedM5VWAP(bar.time,vwap))
      return false;

   double tolerance=avgM5*MathMax(0.0,VWAPToleranceM5RangeFrac);
   return bar.low<=vwap+tolerance && bar.high>=vwap-tolerance;
}

// =============================================================
// M5 MAP: BREAK AND RETEST THE EXACT M15 LEVEL
// =============================================================
void LookForM5Breakout()
{
   if(HasPosition() || setupStage!=STAGE_IDLE || storyDir==DIR_NONE || storyConsumed || avgM5<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   double buffer=MathMax(
      avgM5*MathMax(0.0,M5BreakBufferRangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(storyDir==DIR_BUY && closed.close>storyLevel+buffer)
   {
      storyConsumed=true;                  // one attempt for this M15 leg
      setupStage=STAGE_WAIT_M5_RETEST;
      m5BreakTime=closed.time;
      m5BreakExtreme=closed.high;
      fibA=storyLaunch;
      fibB=m5BreakExtreme;
      breakoutCount++;

      lastAction="M5 BROKE M15 HH -> DO NOT BUY / WAIT RETEST";
      Log(lastAction+" | HH="+DoubleToString(storyLevel,_Digits));
      return;
   }

   if(storyDir==DIR_SELL && closed.close<storyLevel-buffer)
   {
      storyConsumed=true;                  // one attempt for this M15 leg
      setupStage=STAGE_WAIT_M5_RETEST;
      m5BreakTime=closed.time;
      m5BreakExtreme=closed.low;
      fibA=storyLaunch;
      fibB=m5BreakExtreme;
      breakoutCount++;

      lastAction="M5 BROKE M15 LL -> DO NOT SELL / WAIT RETEST";
      Log(lastAction+" | LL="+DoubleToString(storyLevel,_Digits));
   }
}

void ProcessM5Retest()
{
   if(HasPosition() || setupStage==STAGE_IDLE || storyDir==DIR_NONE || avgM5<=0.0)
      return;

   if(BreakoutExpiryMinutes>0 && TimeCurrent()-m5BreakTime>BreakoutExpiryMinutes*60)
   {
      cancelCount++;
      lastAction="BREAKOUT EXPIRED -> NO TRADE / WAIT NEW M15 LEG";
      Log(lastAction);
      ResetSetup();
      return;
   }

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   if(closed.time<=m5BreakTime)
      return;

   // B follows the breakout extension only before the retest is confirmed.
   if(setupStage==STAGE_WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY && closed.high>m5BreakExtreme)
      {
         m5BreakExtreme=closed.high;
         fibB=m5BreakExtreme;
      }
      else if(storyDir==DIR_SELL && closed.low<m5BreakExtreme)
      {
         m5BreakExtreme=closed.low;
         fibB=m5BreakExtreme;
      }
   }

   double zone=avgM5*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(setupStage==STAGE_WAIT_M5_RETEST)
   {
      if(storyDir==DIR_BUY)
      {
         bool touched=(closed.low<=storyLevel+zone);
         bool depthOK=(closed.low>=storyLevel-maxDepth);
         bool held=(closed.close>=storyLevel);
         bool vwapOK=VWAPRetestOK(closed);

         if(touched && depthOK && held && vwapOK)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestTime=TimeCurrent();
            fibC=retestLow;
            setupStage=STAGE_WAIT_M1_TRIGGER;
            retestCount++;

            lastAction="M5 RETESTED M15 HH AND HELD -> WAIT M1 SNIPER";
            Log(lastAction+" | C="+DoubleToString(fibC,_Digits));
            return;
         }

         if(closed.close<storyLevel-maxDepth)
         {
            cancelCount++;
            lastAction="BUY RETEST FAILED -> M5 LOST M15 HH";
            Log(lastAction);
            ResetSetup();
            return;
         }
      }
      else
      {
         bool touched=(closed.high>=storyLevel-zone);
         bool depthOK=(closed.high<=storyLevel+maxDepth);
         bool held=(closed.close<=storyLevel);
         bool vwapOK=VWAPRetestOK(closed);

         if(touched && depthOK && held && vwapOK)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestTime=TimeCurrent();
            fibC=retestHigh;
            setupStage=STAGE_WAIT_M1_TRIGGER;
            retestCount++;

            lastAction="M5 RETESTED M15 LL AND HELD -> WAIT M1 SNIPER";
            Log(lastAction+" | C="+DoubleToString(fibC,_Digits));
            return;
         }

         if(closed.close>storyLevel+maxDepth)
         {
            cancelCount++;
            lastAction="SELL RETEST FAILED -> M5 LOST M15 LL";
            Log(lastAction);
            ResetSetup();
            return;
         }
      }

      return;
   }

   if(setupStage==STAGE_WAIT_M1_TRIGGER)
   {
      if(RetestExpiryMinutes>0 && TimeCurrent()-retestTime>RetestExpiryMinutes*60)
      {
         cancelCount++;
         lastAction="RETEST EXPIRED -> NO LATE ENTRY / WAIT NEW M15 LEG";
         Log(lastAction);
         ResetSetup();
         return;
      }

      // Let the whole M5 retest breathe while it still holds the story level.
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
            cancelCount++;
            lastAction="BUY RETEST BROKE BEFORE ENTRY -> CANCEL";
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
            cancelCount++;
            lastAction="SELL RETEST BROKE BEFORE ENTRY -> CANCEL";
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

   double h=rates[0].high;
   for(int i=1;i<copied;i++)
      if(rates[i].high>h)
         h=rates[i].high;

   return h;
}

double LowestM1Low(int startShift,int count)
{
   MqlRates rates[];
   int copied=CopyRates(_Symbol,EntryTF,startShift,count,rates);
   if(copied!=count)
      return 0.0;

   double l=rates[0].low;
   for(int i=1;i<copied;i++)
      if(rates[i].low<l)
         l=rates[i].low;

   return l;
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
   if(HasPosition() || setupStage!=STAGE_WAIT_M1_TRIGGER || storyDir==DIR_NONE || avgM5<=0.0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(storyDir==DIR_BUY ? tick.ask : tick.bid);
   double maxDistance=avgM5*MathMax(0.0,MaxEntryDistanceFromM15LevelM5RangeFrac);

   if(MathAbs(entry-storyLevel)>maxDistance)
   {
      lateBlockCount++;
      lastAction="NO TRADE -> ENTRY IS TOO LATE / TOO FAR FROM RETEST";
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
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V6_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V6_SELL");

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
   entryCount++;

   lastAction=(positionDir==DIR_BUY ? "BUY" : "SELL")+
              string(" SNIPER OPEN -> HOLD THE MOUNTAIN");

   Log(lastAction+
       " | SL="+DoubleToString(sl,_Digits)+
       " | TP1="+DoubleToString(tp1Price,_Digits)+
       " | TP2="+DoubleToString(tp2Price,_Digits)+
       " | TP3="+DoubleToString(tp3Price,_Digits));

   // Keep Fib values and targets for position management.
   setupStage=STAGE_IDLE;
   m5BreakTime=0;
   m5BreakExtreme=0.0;
   retestLow=0.0;
   retestHigh=0.0;
   retestTime=0;

   return true;
}

void ProcessM1Trigger()
{
   if(HasPosition() || setupStage!=STAGE_WAIT_M1_TRIGGER || storyDir==DIR_NONE)
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
      bool holdsM15Level=(signal.close>storyLevel);
      bool breaksPullback=(signal.close>pullbackHigh);
      bool enoughRecovery=(signal.close-fibC>=minRecovery);

      if(bullish && holdsM15Level && breaksPullback && enoughRecovery)
         OpenSniperTrade();
   }
   else
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0.0)
         return;

      bool bearish=(signal.close<signal.open);
      bool holdsM15Level=(signal.close<storyLevel);
      bool breaksPullback=(signal.close<pullbackLow);
      bool enoughRecovery=(fibC-signal.close>=minRecovery);

      if(bearish && holdsM15Level && breaksPullback && enoughRecovery)
         OpenSniperTrade();
   }
}

// =============================================================
// FIB PROFIT MANAGEMENT
// =============================================================
double PartialVolume(double percent,double currentVolume)
{
   if(percent<=0.0)
      return 0.0;

   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);

   if(step<=0.0)
      step=minVol;

   double wanted=initialVolume*(percent/100.0);
   double closeVol=MathFloor(wanted/step+1e-12)*step;

   if(closeVol<minVol)
      return 0.0;

   // Leave one minimum lot as the runner.
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

   double closeVol=PartialVolume(percent,currentVolume);
   if(closeVol<=0.0)
   {
      Log(label+" HIT -> VOLUME TOO SMALL TO SPLIT");
      return false;
   }

   if(!trade.PositionClosePartial(ticket,closeVol) || !TradeResultOK())
   {
      Log(label+" PARTIAL FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   partialCount++;
   Log(label+" PARTIAL TAKEN | volume="+DoubleToString(closeVol,8));
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
            CloseCurrentPosition("FIB TP3 HIT -> MINIMUM LOT CLOSED IN PROFIT");
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

   if(setupStage==STAGE_IDLE)
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
      return "BUY: M15 HH + HL";
   if(storyDir==DIR_SELL)
      return "SELL: M15 LH + LL";
   return "WAIT: NO CLEAN STORY";
}

string SetupText()
{
   if(setupStage==STAGE_WAIT_M5_RETEST)
      return "BREAKOUT DONE -> WAIT EXACT RETEST";
   if(setupStage==STAGE_WAIT_M1_TRIGGER)
      return "RETEST HELD -> WAIT M1 SNIPER";
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
      "MOUNTAIN RIDER V6 - M15 STORY / M5 PLACE / M1 TRIGGER\n",
      "POSITION: ",pos," | VOL: ",DoubleToString(volume,4),"\n",
      "M15 STORY: ",StoryText(),"\n",
      "EXACT M15 HH/LL LEVEL: ",DoubleToString(storyLevel,_Digits),"\n",
      "M15 LAUNCH HL/LH: ",DoubleToString(storyLaunch,_Digits),"\n",
      "PROTECTED M15 STRUCTURE: ",DoubleToString(protectedM15,_Digits),"\n",
      "STORY CONSUMED: ",(storyConsumed?"YES":"NO"),"\n",
      "M5 MAP: ",SetupText(),"\n",
      "FIB A/B/C: ",DoubleToString(fibA,_Digits)," / ",
                       DoubleToString(fibB,_Digits)," / ",
                       DoubleToString(fibC,_Digits),"\n",
      "TP1: ",DoubleToString(tp1Price,_Digits)," [",(tp1Hit?"HIT":"WAIT"),"]",
      " | TP2: ",DoubleToString(tp2Price,_Digits)," [",(tp2Hit?"HIT":"WAIT"),"]",
      " | TP3: ",DoubleToString(tp3Price,_Digits)," [",(tp3Hit?"HIT":"WAIT"),"]\n",
      "STORIES: ",IntegerToString(storyCount),
      " | CHOP REJECTS: ",IntegerToString(chopRejectCount),"\n",
      "BREAKOUTS: ",IntegerToString(breakoutCount),
      " | RETESTS: ",IntegerToString(retestCount),
      " | ENTRIES: ",IntegerToString(entryCount),"\n",
      "PARTIALS: ",IntegerToString(partialCount),
      " | EXITS: ",IntegerToString(exitCount),
      " | CANCELS: ",IntegerToString(cancelCount),
      " | LATE BLOCKS: ",IntegerToString(lateBlockCount),"\n",
      "VWAP RETEST CONFLUENCE: ",(UseVWAPRetestConfluence?"ON":"OFF"),"\n",
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

   Log("INIT MOUNTAIN RIDER V6");
   Log("M15 STORY DEFINES EXACT HH/LL. M5 BREAKS AND RETESTS THAT SAME LEVEL. M1 TRIGGERS.");
   Log("NO CHASE. ONE ATTEMPT PER M15 LEG. CHOP REJECTED BY STRUCTURE QUALITY. NO TIGHT TRAILING.");
   Log("FIB TP1/TP2/TP3 ACTIVE. MIN 0.01 LOT CLOSES FULL AT TP3 BY DEFAULT.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");

   Log("DEINIT V6 | stories="+IntegerToString(storyCount)+
       " | chopRejects="+IntegerToString(chopRejectCount)+
       " | entries="+IntegerToString(entryCount)+
       " | exits="+IntegerToString(exitCount));
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
