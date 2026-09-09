#property strict
#property version "1.20"

#include <Trade/Trade.mqh>
CTrade trade;

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

// ===================== INPUTS =====================
input double Lots = 0.01;
input ulong Magic = 260909112;
input int DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

input int M15PivotWing = 3;
input int M15SeedLookbackBars = 320;
input int M15AverageRangeLookback = 12;
input double MinM15StructureStepRangeFrac = 0.10;
input double MinM15SwingLegRangeFrac = 1.00;
input int MinM15SwingSpacingBars = 2;
input double M15ExitBreakBufferRangeFrac = 0.10;

// A frozen story cannot block the EA forever.
input int StoryExpiryMinutes = 720;

input int M5AverageRangeLookback = 12;
input double M5BreakBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.30;
input double M5MaxRetestDepthRangeFrac = 0.90;
input int BreakoutToRetestExpiryMinutes = 180;
input int RetestToM1ExpiryMinutes = 75;

input int M1PullbackLookback = 3;
input int MinM1BarsAfterRetest = 0;
input double MinM1RecoveryM5RangeFrac = 0.15;
input double MaxEntryDistanceFromM15LevelM5RangeFrac = 0.85;

input double StopBreathingM5RangeFrac = 0.50;

input bool UseFibTargets = true;
input double FibTP1 = 1.272;
input double FibTP2 = 1.618;
input double FibTP3 = 2.000;
input double TP1PartialPercent = 25.0;
input double TP2PartialPercent = 25.0;
input double TP3PartialPercent = 25.0;
input bool CloseMinimumLotAtTP3 = true;

input double CommissionPerLotRT = 58.0;
input double CostSafetyMultiple = 1.25;
input int ExpectedSlippagePoints = 0;

input int PanelUpdateMilliseconds = 500;
input bool VerboseLog = true;

// ===================== STATE =====================
SwingPoint swings[MAX_SWINGS];
int swingCount = 0;

EngineState state = FIND_M15_STORY;
Direction frozenDir = DIR_NONE;
Direction positionDir = DIR_NONE;

SwingPoint frozenS1;
SwingPoint frozenS2;
SwingPoint frozenS3;
SwingPoint frozenS4;

double frozenBreakLevel = 0.0;       // BUY H2 / SELL L2
double frozenPreviousHL_LH = 0.0;    // BUY L2 / SELL H2
datetime frozenStoryKey = 0;
datetime lastConsumedStoryKey = 0;
datetime storyArmedAt = 0;

datetime breakoutClosedAt = 0;

bool retestTouched = false;
datetime retestTouchTime = 0;
double developingRetestLow = 0.0;
double developingRetestHigh = 0.0;

double frozenRetestLow = 0.0;
double frozenRetestHigh = 0.0;
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

double initialPositionVolume = 0.0;
double protectedM15 = 0.0;
double confirmedM15Extreme = 0.0;
datetime confirmedM15ExtremeTime = 0;
double candidateM15Structure = 0.0;
datetime candidateM15StructureTime = 0;

double avgM15Range = 0.0;
double avgM5Range = 0.0;

datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

int storyCount = 0;
int storyExpiryCount = 0;
int breakoutCount = 0;
int retestTouchCount = 0;
int retestCount = 0;
int entryCount = 0;
int exitCount = 0;
int partialCount = 0;
int cancelCount = 0;
int lateBlockCount = 0;
int promotionCount = 0;

string lastAction = "FIND M15 STORY";
ulong lastPanelMs = 0;

// ===================== HELPERS =====================
void Log(string text)
{
   if(VerboseLog)
      Print("[BLUEPRINT-SM-1.2] ",text);
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

   return spread + commissionDistance + MathMax(0,ExpectedSlippagePoints)*_Point;
}

bool TradeResultOK()
{
   uint rc=trade.ResultRetcode();
   return rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_DONE_PARTIAL || rc==TRADE_RETCODE_PLACED;
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

void ClearSetup()
{
   frozenDir=DIR_NONE;
   frozenBreakLevel=0.0;
   frozenPreviousHL_LH=0.0;
   frozenStoryKey=0;
   storyArmedAt=0;
   breakoutClosedAt=0;

   retestTouched=false;
   retestTouchTime=0;
   developingRetestLow=0.0;
   developingRetestHigh=0.0;
   frozenRetestLow=0.0;
   frozenRetestHigh=0.0;
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

void ConsumeAndReset(string reason)
{
   lastConsumedStoryKey=frozenStoryKey;
   cancelCount++;
   ClearSetup();
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
   ClearSetup();
   state=FIND_M15_STORY;
   return true;
}

void SyncBrokerClosedPosition()
{
   if(state==HOLD_TRADE && positionDir!=DIR_NONE && !HasPosition())
   {
      exitCount++;
      lastConsumedStoryKey=frozenStoryKey;
      lastAction="TRADE CLOSED BY STOP/BROKER -> WAIT NEW M15 STORY";
      Log(lastAction);
      ResetPositionState();
      ClearSetup();
      state=FIND_M15_STORY;
   }
}

// ===================== M15 SWINGS =====================
bool IsPivotHigh(int centerShift,int wing,double &price,datetime &when)
{
   MqlRates center;
   if(!GetBar(DirectionTF,centerShift,center))
      return false;

   for(int k=1;k<=wing;k++)
   {
      MqlRates newerBar,olderBar;
      if(!GetBar(DirectionTF,centerShift-k,newerBar) || !GetBar(DirectionTF,centerShift+k,olderBar))
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
      if(!GetBar(DirectionTF,centerShift-k,newerBar) || !GetBar(DirectionTF,centerShift+k,olderBar))
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
      bool replace=(type>0 ? price>swings[swingCount-1].price : price<swings[swingCount-1].price);
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

bool DetectNewestConfirmedSwing()
{
   int wing=MathMax(1,M15PivotWing);
   int center=wing+1;

   double hp=0.0,lp=0.0;
   datetime ht=0,lt=0;

   bool high=IsPivotHigh(center,wing,hp,ht);
   bool low=IsPivotLow(center,wing,lp,lt);

   if(high && low)
      return false;
   if(high)
      return AddSwing(1,hp,ht);
   if(low)
      return AddSwing(-1,lp,lt);

   return false;
}

void SeedSwings()
{
   swingCount=0;
   int wing=MathMax(1,M15PivotWing);
   int oldest=MathMax(wing+2,M15SeedLookbackBars);

   for(int shift=oldest;shift>=wing+1;shift--)
   {
      double hp=0.0,lp=0.0;
      datetime ht=0,lt=0;

      bool high=IsPivotHigh(shift,wing,hp,ht);
      bool low=IsPivotLow(shift,wing,lp,lt);

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

bool SpacingOK(SwingPoint &s1,SwingPoint &s2,SwingPoint &s3,SwingPoint &s4)
{
   int minSeconds=MathMax(1,MinM15SwingSpacingBars)*PeriodSeconds(DirectionTF);

   return (s2.time-s1.time)>=minSeconds &&
          (s3.time-s2.time)>=minSeconds &&
          (s4.time-s3.time)>=minSeconds;
}

// ===================== STATE 0: FREEZE STORY =====================
void TryFreezeStory()
{
   if(state!=FIND_M15_STORY || HasPosition() || avgM15Range<=0.0)
      return;

   SwingPoint s1,s2,s3,s4;
   if(!LatestFour(s1,s2,s3,s4))
      return;

   if(s4.time==lastConsumedStoryKey)
      return;

   if(!SpacingOK(s1,s2,s3,s4))
      return;

   double minStep=avgM15Range*MathMax(0.0,MinM15StructureStepRangeFrac);
   double minLeg=avgM15Range*MathMax(0.0,MinM15SwingLegRangeFrac);

   if(s1.type==-1 && s2.type==1 && s3.type==-1 && s4.type==1)
   {
      bool higherLow=(s3.price>s1.price+minStep);
      bool higherHigh=(s4.price>s2.price+minStep);
      bool leg1=(s2.price-s1.price)>=minLeg;
      bool leg2=(s4.price-s3.price)>=minLeg;

      if(higherLow && higherHigh && leg1 && leg2)
      {
         frozenS1=s1; frozenS2=s2; frozenS3=s3; frozenS4=s4;
         frozenDir=DIR_BUY;
         frozenBreakLevel=s4.price;
         frozenPreviousHL_LH=s3.price;
         frozenStoryKey=s4.time;
         storyArmedAt=TimeCurrent();
         state=WAIT_M5_BREAKOUT;
         storyCount++;

         lastAction="M15 BUY STORY FROZEN -> WAIT FRESH M5 BREAK OF H2";
         Log(lastAction+" | H2="+DoubleToString(frozenBreakLevel,_Digits));
         return;
      }
   }

   if(s1.type==1 && s2.type==-1 && s3.type==1 && s4.type==-1)
   {
      bool lowerHigh=(s3.price<s1.price-minStep);
      bool lowerLow=(s4.price<s2.price-minStep);
      bool leg1=(s1.price-s2.price)>=minLeg;
      bool leg2=(s3.price-s4.price)>=minLeg;

      if(lowerHigh && lowerLow && leg1 && leg2)
      {
         frozenS1=s1; frozenS2=s2; frozenS3=s3; frozenS4=s4;
         frozenDir=DIR_SELL;
         frozenBreakLevel=s4.price;
         frozenPreviousHL_LH=s3.price;
         frozenStoryKey=s4.time;
         storyArmedAt=TimeCurrent();
         state=WAIT_M5_BREAKOUT;
         storyCount++;

         lastAction="M15 SELL STORY FROZEN -> WAIT FRESH M5 BREAK OF L2";
         Log(lastAction+" | L2="+DoubleToString(frozenBreakLevel,_Digits));
      }
   }
}

// ===================== STATE 1: BREAKOUT =====================
void ProcessM5Breakout()
{
   if(state!=WAIT_M5_BREAKOUT || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   if(StoryExpiryMinutes>0 && TimeCurrent()-storyArmedAt>StoryExpiryMinutes*60)
   {
      storyExpiryCount++;
      ConsumeAndReset("FROZEN STORY EXPIRED BEFORE BREAKOUT -> SCAN NEW M15 STORY");
      return;
   }

   MqlRates b1,b2;
   if(!GetBar(MapTF,1,b1) || !GetBar(MapTF,2,b2))
      return;

   double buffer=MathMax(avgM5Range*MathMax(0.0,M5BreakBufferRangeFrac),CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(frozenDir==DIR_BUY)
   {
      bool freshBreak=(b2.close<=frozenBreakLevel && b1.close>frozenBreakLevel+buffer);
      if(freshBreak)
      {
         breakoutClosedAt=iTime(_Symbol,MapTF,0);
         fibA=frozenPreviousHL_LH;
         fibB=frozenBreakLevel;
         state=WAIT_M5_RETEST;
         breakoutCount++;
         lastAction="M5 BROKE FROZEN H2 -> NO BUY / WAIT RETEST";
         Log(lastAction);
      }
   }
   else
   {
      bool freshBreak=(b2.close>=frozenBreakLevel && b1.close<frozenBreakLevel-buffer);
      if(freshBreak)
      {
         breakoutClosedAt=iTime(_Symbol,MapTF,0);
         fibA=frozenPreviousHL_LH;
         fibB=frozenBreakLevel;
         state=WAIT_M5_RETEST;
         breakoutCount++;
         lastAction="M5 BROKE FROZEN L2 -> NO SELL / WAIT RETEST";
         Log(lastAction);
      }
   }
}

// ===================== STATE 2: MULTI-CANDLE RETEST =====================
void ProcessM5Retest()
{
   if(state!=WAIT_M5_RETEST || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   if(BreakoutToRetestExpiryMinutes>0 && TimeCurrent()-breakoutClosedAt>BreakoutToRetestExpiryMinutes*60)
   {
      ConsumeAndReset("BREAKOUT EXPIRED WITHOUT RETEST -> WAIT NEW M15 STORY");
      return;
   }

   MqlRates b;
   if(!GetBar(MapTF,1,b))
      return;

   double zone=avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(frozenDir==DIR_BUY)
   {
      if(!retestTouched && b.low<=frozenBreakLevel+zone)
      {
         retestTouched=true;
         retestTouchTime=b.time;
         developingRetestLow=b.low;
         developingRetestHigh=b.high;
         retestTouchCount++;
         lastAction="BUY RETEST TOUCHED H2 -> LET PULLBACK FORM";
         Log(lastAction);
      }

      if(!retestTouched)
         return;

      if(b.low<developingRetestLow) developingRetestLow=b.low;
      if(b.high>developingRetestHigh) developingRetestHigh=b.high;

      if(developingRetestLow<=frozenPreviousHL_LH)
      {
         ConsumeAndReset("BUY RETEST BROKE PREVIOUS M15 HL -> INVALID STORY");
         return;
      }

      if(b.close<frozenBreakLevel-maxDepth)
      {
         ConsumeAndReset("BUY RETEST CLOSED TOO DEEP BELOW H2 -> INVALID");
         return;
      }

      if(b.close>=frozenBreakLevel && developingRetestLow>frozenPreviousHL_LH)
      {
         frozenRetestLow=developingRetestLow;
         frozenRetestHigh=developingRetestHigh;
         fibC=frozenRetestLow;
         retestConfirmedAt=iTime(_Symbol,MapTF,0);
         state=WAIT_M1_TRIGGER;
         retestCount++;
         lastAction="BUY RETEST CONFIRMED -> NEW HL FROZEN / WAIT M1";
         Log(lastAction+" | newHL="+DoubleToString(frozenRetestLow,_Digits));
      }
   }
   else
   {
      if(!retestTouched && b.high>=frozenBreakLevel-zone)
      {
         retestTouched=true;
         retestTouchTime=b.time;
         developingRetestLow=b.low;
         developingRetestHigh=b.high;
         retestTouchCount++;
         lastAction="SELL RETEST TOUCHED L2 -> LET PULLBACK FORM";
         Log(lastAction);
      }

      if(!retestTouched)
         return;

      if(b.low<developingRetestLow) developingRetestLow=b.low;
      if(b.high>developingRetestHigh) developingRetestHigh=b.high;

      if(developingRetestHigh>=frozenPreviousHL_LH)
      {
         ConsumeAndReset("SELL RETEST BROKE PREVIOUS M15 LH -> INVALID STORY");
         return;
      }

      if(b.close>frozenBreakLevel+maxDepth)
      {
         ConsumeAndReset("SELL RETEST CLOSED TOO DEEP ABOVE L2 -> INVALID");
         return;
      }

      if(b.close<=frozenBreakLevel && developingRetestHigh<frozenPreviousHL_LH)
      {
         frozenRetestLow=developingRetestLow;
         frozenRetestHigh=developingRetestHigh;
         fibC=frozenRetestHigh;
         retestConfirmedAt=iTime(_Symbol,MapTF,0);
         state=WAIT_M1_TRIGGER;
         retestCount++;
         lastAction="SELL RETEST CONFIRMED -> NEW LH FROZEN / WAIT M1";
         Log(lastAction+" | newLH="+DoubleToString(frozenRetestHigh,_Digits));
      }
   }
}

void CheckRetestStillValid()
{
   if(state!=WAIT_M1_TRIGGER || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   MqlRates b;
   if(!GetBar(MapTF,1,b))
      return;

   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(frozenDir==DIR_BUY)
   {
      if(b.low<=frozenPreviousHL_LH || b.close<frozenBreakLevel-maxDepth)
         ConsumeAndReset("BUY RETEST FAILED BEFORE M1 ENTRY -> WAIT NEW STORY");
   }
   else
   {
      if(b.high>=frozenPreviousHL_LH || b.close>frozenBreakLevel+maxDepth)
         ConsumeAndReset("SELL RETEST FAILED BEFORE M1 ENTRY -> WAIT NEW STORY");
   }
}

// ===================== STATE 3: M1 TRIGGER =====================
double HighestM1High(int startShift,int count)
{
   MqlRates rates[];
   if(CopyRates(_Symbol,EntryTF,startShift,count,rates)!=count)
      return 0.0;

   double high=rates[0].high;
   for(int i=1;i<count;i++)
      if(rates[i].high>high) high=rates[i].high;
   return high;
}

double LowestM1Low(int startShift,int count)
{
   MqlRates rates[];
   if(CopyRates(_Symbol,EntryTF,startShift,count,rates)!=count)
      return 0.0;

   double low=rates[0].low;
   for(int i=1;i<count;i++)
      if(rates[i].low<low) low=rates[i].low;
   return low;
}

void BuildFibTargets()
{
   double leg=MathAbs(fibB-fibA);
   if(leg<=0.0 || fibC<=0.0)
      return;

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
      ConsumeAndReset("M1 CONFIRMATION TOO LATE -> WAIT NEW M15 STORY");
      return false;
   }

   double breathing=MathMax(avgM5Range*MathMax(0.0,StopBreathingM5RangeFrac),CostDistance()*MathMax(1.0,CostSafetyMultiple));
   double sl=(frozenDir==DIR_BUY ? frozenRetestLow-breathing : frozenRetestHigh+breathing);
   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(frozenDir==DIR_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"BLUEPRINT_1_2_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"BLUEPRINT_1_2_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=frozenDir;
   initialPositionVolume=volume;
   protectedM15=frozenPreviousHL_LH;
   confirmedM15Extreme=frozenBreakLevel;
   confirmedM15ExtremeTime=frozenStoryKey;
   candidateM15Structure=0.0;
   candidateM15StructureTime=0;

   BuildFibTargets();
   state=HOLD_TRADE;
   entryCount++;

   lastAction=(positionDir==DIR_BUY ? "BUY" : "SELL")+string(" SNIPER ENTRY -> HOLD MOUNTAIN");
   Log(lastAction+" | SL="+DoubleToString(sl,_Digits));
   return true;
}

void ProcessM1Trigger()
{
   if(state!=WAIT_M1_TRIGGER || frozenDir==DIR_NONE || avgM5Range<=0.0)
      return;

   if(RetestToM1ExpiryMinutes>0 && TimeCurrent()-retestConfirmedAt>RetestToM1ExpiryMinutes*60)
   {
      ConsumeAndReset("M1 NEVER CONFIRMED RETEST -> WAIT NEW M15 STORY");
      return;
   }

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   int waitSeconds=MathMax(0,MinM1BarsAfterRetest)*PeriodSeconds(EntryTF);
   if(signal.time<retestConfirmedAt+waitSeconds)
      return;

   int lookback=MathMax(2,M1PullbackLookback);
   double minRecovery=MathMax(avgM5Range*MathMax(0.0,MinM1RecoveryM5RangeFrac),CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(frozenDir==DIR_BUY)
   {
      double minorHigh=HighestM1High(2,lookback);
      if(minorHigh<=0.0) return;

      bool bullish=(signal.close>signal.open);
      bool aboveLevel=(signal.close>frozenBreakLevel);
      bool breaksPullback=(signal.close>minorHigh);
      bool recovered=(signal.close-frozenRetestLow>=minRecovery);

      if(bullish && aboveLevel && breaksPullback && recovered)
         OpenSniperTrade();
   }
   else
   {
      double minorLow=LowestM1Low(2,lookback);
      if(minorLow<=0.0) return;

      bool bearish=(signal.close<signal.open);
      bool belowLevel=(signal.close<frozenBreakLevel);
      bool breaksPullback=(signal.close<minorLow);
      bool recovered=(frozenRetestHigh-signal.close>=minRecovery);

      if(bearish && belowLevel && breaksPullback && recovered)
         OpenSniperTrade();
   }
}

// ===================== STATE 4: HOLD + M15 STRUCTURE =====================
void UpdateHoldCandidateFromNewestSwing()
{
   if(state!=HOLD_TRADE || swingCount<=0)
      return;

   SwingPoint s=swings[swingCount-1];

   if(positionDir==DIR_BUY)
   {
      if(s.type==-1 && s.time>confirmedM15ExtremeTime && s.price>protectedM15)
      {
         candidateM15Structure=s.price;
         candidateM15StructureTime=s.time;
         Log("BUY CANDIDATE HL -> WAIT NEW HH TO CONFIRM");
      }
   }
   else if(positionDir==DIR_SELL)
   {
      if(s.type==1 && s.time>confirmedM15ExtremeTime && s.price<protectedM15)
      {
         candidateM15Structure=s.price;
         candidateM15StructureTime=s.time;
         Log("SELL CANDIDATE LH -> WAIT NEW LL TO CONFIRM");
      }
   }
}

void ProcessM15HoldExitAndPromotion()
{
   if(state!=HOLD_TRADE || positionDir==DIR_NONE || !HasPosition() || avgM15Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   double buffer=avgM15Range*MathMax(0.0,M15ExitBreakBufferRangeFrac);

   if(positionDir==DIR_BUY)
   {
      if(closed.close<protectedM15-buffer)
      {
         lastConsumedStoryKey=frozenStoryKey;
         CloseCurrentPosition("BUY EXIT -> CLOSED M15 BROKE CONFIRMED HL");
         return;
      }

      if(candidateM15Structure>0.0 && closed.close>confirmedM15Extreme+buffer)
      {
         protectedM15=candidateM15Structure;
         candidateM15Structure=0.0;
         candidateM15StructureTime=0;
         confirmedM15Extreme=closed.high;
         confirmedM15ExtremeTime=closed.time;
         promotionCount++;
         Log("BUY STRUCTURE PROMOTED -> NEW HL PROTECTED");
      }
      else if(candidateM15Structure<=0.0 && closed.close>confirmedM15Extreme+buffer)
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
         CloseCurrentPosition("SELL EXIT -> CLOSED M15 BROKE CONFIRMED LH");
         return;
      }

      if(candidateM15Structure>0.0 && closed.close<confirmedM15Extreme-buffer)
      {
         protectedM15=candidateM15Structure;
         candidateM15Structure=0.0;
         candidateM15StructureTime=0;
         confirmedM15Extreme=closed.low;
         confirmedM15ExtremeTime=closed.time;
         promotionCount++;
         Log("SELL STRUCTURE PROMOTED -> NEW LH PROTECTED");
      }
      else if(candidateM15Structure<=0.0 && closed.close<confirmedM15Extreme-buffer)
      {
         confirmedM15Extreme=closed.low;
         confirmedM15ExtremeTime=closed.time;
      }
   }
}

// ===================== FIB MANAGEMENT =====================
double PartialCloseVolume(double percent,double currentVolume)
{
   if(percent<=0.0) return 0.0;

   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=minVol;

   double requested=initialPositionVolume*(percent/100.0);
   double closeVol=MathFloor(requested/step+1e-12)*step;

   if(closeVol<minVol) return 0.0;

   if(currentVolume-closeVol<minVol)
   {
      closeVol=currentVolume-minVol;
      closeVol=MathFloor(closeVol/step+1e-12)*step;
   }

   if(closeVol<minVol) return 0.0;
   return NormalizeDouble(closeVol,8);
}

bool TryPartial(string label,double percent)
{
   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   double currentVolume=0.0;

   if(!FindOurPosition(ticket,type,openPrice,currentVolume)) return false;

   double closeVol=PartialCloseVolume(percent,currentVolume);
   if(closeVol<=0.0)
   {
      Log(label+" HIT -> MIN LOT CANNOT PARTIAL");
      return false;
   }

   if(!trade.PositionClosePartial(ticket,closeVol) || !TradeResultOK())
   {
      Log(label+" PARTIAL FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   partialCount++;
   Log(label+" PARTIAL CLOSED");
   return true;
}

void ManageFibTargets()
{
   if(state!=HOLD_TRADE || !UseFibTargets || positionDir==DIR_NONE || !HasPosition())
      return;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick)) return;

   double price=(positionDir==DIR_BUY ? tick.bid : tick.ask);

   if(!tp1Hit && tp1Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp1Price : price<=tp1Price);
      if(hit)
      {
         tp1Hit=true;
         TryPartial("FIB TP1",TP1PartialPercent);
      }
   }

   if(!tp2Hit && tp2Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp2Price : price<=tp2Price);
      if(hit)
      {
         tp2Hit=true;
         TryPartial("FIB TP2",TP2PartialPercent);
      }
   }

   if(!tp3Hit && tp3Price>0.0)
   {
      bool hit=(positionDir==DIR_BUY ? price>=tp3Price : price<=tp3Price);
      if(hit)
      {
         tp3Hit=true;
         bool partialDone=TryPartial("FIB TP3",TP3PartialPercent);
         if(!partialDone && CloseMinimumLotAtTP3)
         {
            lastConsumedStoryKey=frozenStoryKey;
            CloseCurrentPosition("FIB TP3 HIT -> CLOSE MINIMUM-LOT WINNER");
         }
      }
   }
}

// ===================== BAR EVENTS =====================
void OnNewM15()
{
   datetime current=iTime(_Symbol,DirectionTF,0);
   if(current<=0 || current==lastM15Bar) return;

   lastM15Bar=current;
   AvgRange(DirectionTF,1,M15AverageRangeLookback,avgM15Range);

   bool newSwing=DetectNewestConfirmedSwing();

   if(state==HOLD_TRADE)
   {
      if(newSwing) UpdateHoldCandidateFromNewestSwing();
      ProcessM15HoldExitAndPromotion();
   }
   else if(state==FIND_M15_STORY)
   {
      TryFreezeStory();
   }
}

void OnNewM5()
{
   datetime current=iTime(_Symbol,MapTF,0);
   if(current<=0 || current==lastM5Bar) return;

   lastM5Bar=current;
   AvgRange(MapTF,1,M5AverageRangeLookback,avgM5Range);

   if(state==WAIT_M5_BREAKOUT)
      ProcessM5Breakout();
   else if(state==WAIT_M5_RETEST)
      ProcessM5Retest();
   else if(state==WAIT_M1_TRIGGER)
      CheckRetestStillValid();
}

void OnNewM1()
{
   datetime current=iTime(_Symbol,EntryTF,0);
   if(current<=0 || current==lastM1Bar) return;

   lastM1Bar=current;
   if(state==WAIT_M1_TRIGGER)
      ProcessM1Trigger();
}

string StateText()
{
   if(state==FIND_M15_STORY) return "0 FIND M15 STORY";
   if(state==WAIT_M5_BREAKOUT) return "1 WAIT M5 BREAKOUT";
   if(state==WAIT_M5_RETEST) return "2 WAIT M5 RETEST";
   if(state==WAIT_M1_TRIGGER) return "3 WAIT M1 TRIGGER";
   if(state==HOLD_TRADE) return "4 HOLD TRADE";
   return "UNKNOWN";
}

void Panel()
{
   ulong now=GetTickCount64();
   if(lastPanelMs>0 && now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds)) return;
   lastPanelMs=now;

   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   double volume=0.0;
   string pos="NONE";

   if(FindOurPosition(ticket,type,openPrice,volume))
      pos=(type==POSITION_TYPE_BUY ? "BUY" : "SELL");

   Comment(
      "BLUEPRINT STATE MACHINE V1.2\n",
      "STATE: ",StateText(),"\n",
      "POSITION: ",pos,"\n",
      "FROZEN LEVEL: ",DoubleToString(frozenBreakLevel,_Digits),"\n",
      "OLD HL/LH: ",DoubleToString(frozenPreviousHL_LH,_Digits),"\n",
      "RETEST TOUCHED: ",(retestTouched?"YES":"NO"),"\n",
      "DEVELOPING RETEST L/H: ",DoubleToString(developingRetestLow,_Digits)," / ",DoubleToString(developingRetestHigh,_Digits),"\n",
      "FROZEN RETEST L/H: ",DoubleToString(frozenRetestLow,_Digits)," / ",DoubleToString(frozenRetestHigh,_Digits),"\n",
      "PROTECTED M15: ",DoubleToString(protectedM15,_Digits),"\n",
      "TP1/TP2/TP3: ",DoubleToString(tp1Price,_Digits)," / ",DoubleToString(tp2Price,_Digits)," / ",DoubleToString(tp3Price,_Digits),"\n",
      "STORIES: ",IntegerToString(storyCount)," | EXPIRIES: ",IntegerToString(storyExpiryCount),"\n",
      "BREAKOUTS: ",IntegerToString(breakoutCount)," | RETEST TOUCHES: ",IntegerToString(retestTouchCount)," | RETESTS: ",IntegerToString(retestCount),"\n",
      "ENTRIES: ",IntegerToString(entryCount)," | EXITS: ",IntegerToString(exitCount)," | PROMOTIONS: ",IntegerToString(promotionCount),"\n",
      "LAST: ",lastAction
   );
}

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

   SeedSwings();
   ClearSetup();
   ResetPositionState();

   state=FIND_M15_STORY;
   lastConsumedStoryKey=0;

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   TryFreezeStory();

   Log("INIT BLUEPRINT STATE MACHINE V1.2");
   Log("FIX: STORIES EXPIRE INSTEAD OF DEADLOCKING THE EA.");
   Log("FIX: RETEST IS MULTI-CANDLE AND FREEZES ONLY AFTER M5 HOLD/RECLAIM.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");
   Log("DEINIT V1.2 | stories="+IntegerToString(storyCount)+
       " | expiries="+IntegerToString(storyExpiryCount)+
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
