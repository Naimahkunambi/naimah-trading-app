#property strict
#property version "4.00"

#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// SIMPLE MOUNTAIN RIDER V4 - FIB SNIPER
// =============================================================
// M15 TELLS THE STORY
//   BUY  = Low -> High -> Higher Low -> CLOSED break above High
//   SELL = High -> Low -> Lower High -> CLOSED break below Low
//   Once a regime is confirmed, it stays persistent until its confirmed
//   protected M15 HL/LH is broken by a CLOSED M15 candle.
//
// M5 SHOWS THE PLACE
//   Wait for a real M5 swing breakout in the M15 direction.
//   DO NOT ENTER THE BREAKOUT.
//   Wait for price to come back and retest the broken M5 level.
//   The retest must HOLD on a CLOSED M5 candle.
//
// M1 PULLS THE TRIGGER
//   After the M5 retest, a CLOSED M1 candle must break the short pullback
//   in the trend direction. Entry must still be close to the retest.
//
// FIBONACCI EXTENSION
//   BUY : A = M5 swing low before breakout high
//         B = broken M5 swing high
//         C = M5 retest low / new HL
//   SELL: A = M5 swing high before breakout low
//         B = broken M5 swing low
//         C = M5 retest high / new LH
//   Targets are projected from C using AB length.
//
// TP1 / TP2 / TP3 are virtual partial-profit levels.
// The final runner has NO TP and exits on the M15 structure break.
// If the symbol's minimum lot prevents a partial close, the target is still
// recorded as HIT and the runner is left open.
//
// STOP LOSS
//   BUY  = below the structural M5 retest low + breathing room
//   SELL = above the structural M5 retest high + breathing room
//
// ONE POSITION AT A TIME. ONE TRADE PER M5 BREAKOUT ANCHOR.
// =============================================================

#define MAX_SWINGS 32

struct SwingPoint
{
   int type;          // +1 high, -1 low
   double price;
   datetime time;
};

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

// ---------- EXECUTION ----------
input double Lots = 0.01;
input ulong  Magic = 260909004;
input int    DeviationPoints = 50;

input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// ---------- M15 STORY ----------
input int    M15PivotWing = 3;
input int    M15SeedLookbackBars = 320;
input int    M15RangeLookback = 12;
input double MinM15HigherLowLowerHighStepRangeFrac = 0.15;
input double M15StructureBreakBufferRangeFrac = 0.05;
input double MinM15PromotionStepRangeFrac = 0.10;

// ---------- M5 MAP ----------
input int    M5PivotWing = 2;
input int    M5SeedLookbackBars = 220;
input int    M5RangeLookback = 12;
input double M5BreakoutBufferRangeFrac = 0.10;
input double M5RetestZoneRangeFrac = 0.25;
input double M5MaxRetestDepthRangeFrac = 0.70;
input int    BreakoutExpiryMinutes = 120;
input int    RetestExpiryMinutes = 60;

// Optional VWAP confluence. Structure remains the boss.
input bool   UseVWAPRetestConfluence = false;
input int    VWAPResetHour = 0;
input bool   PreferRealVolume = false;
input double VWAPRetestToleranceM5RangeFrac = 0.50;

// ---------- M1 SNIPER ENTRY ----------
input int    M1ConfirmationLookback = 3;
input double MinM1RecoveryM5RangeFrac = 0.20;
input double MaxEntryDistanceFromBreakM5RangeFrac = 0.85;

// ---------- STOP ----------
input double StopBufferBeyondRetestM5RangeFrac = 0.25;

// ---------- FIBONACCI TARGETS ----------
input double FibTP1 = 1.272;
input double FibTP2 = 1.618;
input double FibTP3 = 2.000;

input bool   UseFibPartialProfits = true;
input double TP1PartialPercent = 20.0;
input double TP2PartialPercent = 20.0;
input double TP3PartialPercent = 20.0;

// ---------- COST CONTROL ----------
input double CommissionPerLotRT = 58.0;
input double CostSafetyMultiple = 1.25;
input int    ExpectedSlippagePoints = 0;

input int    PanelUpdateMilliseconds = 500;
input bool   VerboseLog = true;

// =============================================================
// GLOBAL STATE
// =============================================================
SwingPoint m15Swings[MAX_SWINGS];
int m15SwingCount = 0;

SwingPoint m5Swings[MAX_SWINGS];
int m5SwingCount = 0;

TrendDir regime = TREND_NONE;

double protectedM15Structure = 0.0; // confirmed major HL for BUY / LH for SELL
double m15StructuralExtreme = 0.0;   // confirmed HH for BUY / LL for SELL
datetime m15StructuralExtremeTime = 0;
double candidateM15Structure = 0.0;
datetime candidateM15StructureTime = 0;
datetime regimeStartTime = 0;

double avgM15Range = 0.0;
double avgM5Range = 0.0;

SetupStage setupStage = SETUP_IDLE;
TrendDir setupDir = TREND_NONE;

double fibA = 0.0;
double fibB = 0.0;
double fibC = 0.0;

double breakoutLevel = 0.0;
datetime breakoutTime = 0;
datetime breakoutAnchorTime = 0;

double retestLow = 0.0;
double retestHigh = 0.0;
datetime retestTime = 0;

datetime consumedBuyAnchor = 0;
datetime consumedSellAnchor = 0;

TrendDir positionDir = TREND_NONE;
double positionInitialVolume = 0.0;

double tp1Price = 0.0;
double tp2Price = 0.0;
double tp3Price = 0.0;
bool tp1Hit = false;
bool tp2Hit = false;
bool tp3Hit = false;

datetime lastM15Bar = 0;
datetime lastM5Bar = 0;
datetime lastM1Bar = 0;

int regimeStarts = 0;
int regimeBreaks = 0;
int m15Promotions = 0;
int m5Breakouts = 0;
int m5Retests = 0;
int entries = 0;
int exits = 0;
int partials = 0;
int setupCancels = 0;
int lateBlocks = 0;

string lastAction = "WAITING FOR M15 STORY";
ulong lastPanelMs = 0;

// =============================================================
// BASIC HELPERS
// =============================================================
void Log(string text)
{
   if(VerboseLog)
      Print("[MOUNTAIN-V4] ", text);
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
   setupDir=TREND_NONE;

   fibA=0.0;
   fibB=0.0;
   fibC=0.0;

   breakoutLevel=0.0;
   breakoutTime=0;
   breakoutAnchorTime=0;

   retestLow=0.0;
   retestHigh=0.0;
   retestTime=0;
}

void ResetPositionTargets()
{
   positionDir=TREND_NONE;
   positionInitialVolume=0.0;

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
   if(positionDir!=TREND_NONE && !HasPosition())
   {
      exits++;
      lastAction="POSITION CLOSED BY SL/BROKER";
      Log(lastAction);
      ResetPositionTargets();
   }
}

// =============================================================
// SWING ENGINE
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

void AddM5Swing(int type,double price,datetime when)
{
   if(m5SwingCount>0 && m5Swings[m5SwingCount-1].time==when)
      return;

   if(m5SwingCount>0 && m5Swings[m5SwingCount-1].type==type)
   {
      bool replace=(type>0 ? price>m5Swings[m5SwingCount-1].price
                           : price<m5Swings[m5SwingCount-1].price);
      if(replace)
      {
         m5Swings[m5SwingCount-1].price=price;
         m5Swings[m5SwingCount-1].time=when;
      }
      return;
   }

   if(m5SwingCount<MAX_SWINGS)
   {
      m5Swings[m5SwingCount].type=type;
      m5Swings[m5SwingCount].price=price;
      m5Swings[m5SwingCount].time=when;
      m5SwingCount++;
      return;
   }

   for(int i=1;i<MAX_SWINGS;i++)
      m5Swings[i-1]=m5Swings[i];

   m5Swings[MAX_SWINGS-1].type=type;
   m5Swings[MAX_SWINGS-1].price=price;
   m5Swings[MAX_SWINGS-1].time=when;
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

void DetectM5PivotAtShift(int centerShift)
{
   int wing=MathMax(1,M5PivotWing);

   double hp=0.0,lp=0.0;
   datetime ht=0,lt=0;

   bool high=IsPivotHigh(MapTF,centerShift,wing,hp,ht);
   bool low =IsPivotLow(MapTF,centerShift,wing,lp,lt);

   if(high && low)
      return;

   if(high)
      AddM5Swing(1,hp,ht);
   else if(low)
      AddM5Swing(-1,lp,lt);
}

void SeedM15Swings()
{
   m15SwingCount=0;

   int wing=MathMax(1,M15PivotWing);
   int oldest=MathMax(wing+2,M15SeedLookbackBars);

   for(int shift=oldest;shift>=wing+1;shift--)
      DetectM15PivotAtShift(shift);
}

void SeedM5Swings()
{
   m5SwingCount=0;

   int wing=MathMax(1,M5PivotWing);
   int oldest=MathMax(wing+2,M5SeedLookbackBars);

   for(int shift=oldest;shift>=wing+1;shift--)
      DetectM5PivotAtShift(shift);
}

// =============================================================
// M15 STORY / PERSISTENT REGIME
// =============================================================
void StartBuyRegime(double higherLow,double brokenHigh,datetime breakTime)
{
   regime=TREND_BUY;
   protectedM15Structure=higherLow;
   m15StructuralExtreme=brokenHigh;
   m15StructuralExtremeTime=breakTime;
   candidateM15Structure=0.0;
   candidateM15StructureTime=0;
   regimeStartTime=breakTime;
   regimeStarts++;

   ResetSetup();

   lastAction="M15 BUY STORY LOCKED -> HL + CLOSED BREAK ABOVE HH";
   Log(lastAction+
       " | protectedHL="+DoubleToString(protectedM15Structure,_Digits)+
       " | HH="+DoubleToString(m15StructuralExtreme,_Digits));
}

void StartSellRegime(double lowerHigh,double brokenLow,datetime breakTime)
{
   regime=TREND_SELL;
   protectedM15Structure=lowerHigh;
   m15StructuralExtreme=brokenLow;
   m15StructuralExtremeTime=breakTime;
   candidateM15Structure=0.0;
   candidateM15StructureTime=0;
   regimeStartTime=breakTime;
   regimeStarts++;

   ResetSetup();

   lastAction="M15 SELL STORY LOCKED -> LH + CLOSED BREAK BELOW LL";
   Log(lastAction+
       " | protectedLH="+DoubleToString(protectedM15Structure,_Digits)+
       " | LL="+DoubleToString(m15StructuralExtreme,_Digits));
}

void EndRegime(string reason)
{
   if(HasPosition())
      CloseCurrentPosition(reason);

   regime=TREND_NONE;
   protectedM15Structure=0.0;
   m15StructuralExtreme=0.0;
   m15StructuralExtremeTime=0;
   candidateM15Structure=0.0;
   candidateM15StructureTime=0;
   regimeStartTime=0;
   regimeBreaks++;

   ResetSetup();

   // The next direction must build a fresh story after this break.
   m15SwingCount=0;

   lastAction=reason+" -> NEUTRAL / WAIT FRESH M15 STORY";
   Log(lastAction);
}

void TryStartRegime()
{
   if(regime!=TREND_NONE || m15SwingCount<3)
      return;

   if(avgM15Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   double minStep=avgM15Range*MathMax(0.0,MinM15HigherLowLowerHighStepRangeFrac);
   double breakBuffer=avgM15Range*MathMax(0.0,M15StructureBreakBufferRangeFrac);

   SwingPoint s1=m15Swings[m15SwingCount-3];
   SwingPoint s2=m15Swings[m15SwingCount-2];
   SwingPoint s3=m15Swings[m15SwingCount-1];

   // BUY: Low -> High -> Higher Low -> closed break above High.
   if(s1.type==-1 && s2.type==1 && s3.type==-1)
   {
      bool higherLow=(s3.price>=s1.price+minStep);
      bool breakHigh=(closed.close>s2.price+breakBuffer);

      if(higherLow && breakHigh)
      {
         StartBuyRegime(s3.price,MathMax(s2.price,closed.high),closed.time);
         return;
      }
   }

   // SELL: High -> Low -> Lower High -> closed break below Low.
   if(s1.type==1 && s2.type==-1 && s3.type==1)
   {
      bool lowerHigh=(s3.price<=s1.price-minStep);
      bool breakLow=(closed.close<s2.price-breakBuffer);

      if(lowerHigh && breakLow)
      {
         StartSellRegime(s3.price,MathMin(s2.price,closed.low),closed.time);
         return;
      }
   }
}

void UpdateCandidateFromNewestM15Swing()
{
   if(regime==TREND_NONE || m15SwingCount<=0)
      return;

   SwingPoint newest=m15Swings[m15SwingCount-1];

   if(newest.time<=m15StructuralExtremeTime)
      return;

   double minPromotion=avgM15Range*MathMax(0.0,MinM15PromotionStepRangeFrac);

   if(regime==TREND_BUY && newest.type==-1)
   {
      if(newest.price>protectedM15Structure+minPromotion)
      {
         if(candidateM15Structure<=0.0 || newest.price<candidateM15Structure)
         {
            candidateM15Structure=newest.price;
            candidateM15StructureTime=newest.time;
            Log("BUY CANDIDATE HL -> waits for new HH proof | "+
                DoubleToString(candidateM15Structure,_Digits));
         }
      }
   }
   else if(regime==TREND_SELL && newest.type==1)
   {
      if(newest.price<protectedM15Structure-minPromotion)
      {
         if(candidateM15Structure<=0.0 || newest.price>candidateM15Structure)
         {
            candidateM15Structure=newest.price;
            candidateM15StructureTime=newest.time;
            Log("SELL CANDIDATE LH -> waits for new LL proof | "+
                DoubleToString(candidateM15Structure,_Digits));
         }
      }
   }
}

void ProcessM15Story()
{
   if(avgM15Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(DirectionTF,1,closed))
      return;

   double breakBuffer=avgM15Range*MathMax(0.0,M15StructureBreakBufferRangeFrac);

   if(regime==TREND_BUY)
   {
      // Actual structure break: CLOSED M15 below confirmed major HL.
      if(closed.close<protectedM15Structure-breakBuffer)
      {
         EndRegime("BUY EXIT -> CLOSED M15 BROKE CONFIRMED MAJOR HL");
         return;
      }

      // Promote a candidate HL only AFTER the market proves it with a new HH.
      if(candidateM15Structure>0.0 &&
         closed.close>m15StructuralExtreme+breakBuffer)
      {
         protectedM15Structure=candidateM15Structure;
         candidateM15Structure=0.0;
         candidateM15StructureTime=0;
         m15StructuralExtreme=MathMax(m15StructuralExtreme,closed.high);
         m15StructuralExtremeTime=closed.time;
         m15Promotions++;

         Log("BUY HL PROMOTED -> NEW HH PROVED IT | protectedHL="+
             DoubleToString(protectedM15Structure,_Digits));
      }
      else if(candidateM15Structure<=0.0 &&
              closed.close>m15StructuralExtreme+breakBuffer)
      {
         // Extension without a completed pullback. Update the high only.
         m15StructuralExtreme=MathMax(m15StructuralExtreme,closed.high);
         m15StructuralExtremeTime=closed.time;
      }

      return;
   }

   if(regime==TREND_SELL)
   {
      // Actual structure break: CLOSED M15 above confirmed major LH.
      if(closed.close>protectedM15Structure+breakBuffer)
      {
         EndRegime("SELL EXIT -> CLOSED M15 BROKE CONFIRMED MAJOR LH");
         return;
      }

      // Promote a candidate LH only AFTER the market proves it with a new LL.
      if(candidateM15Structure>0.0 &&
         closed.close<m15StructuralExtreme-breakBuffer)
      {
         protectedM15Structure=candidateM15Structure;
         candidateM15Structure=0.0;
         candidateM15StructureTime=0;
         m15StructuralExtreme=MathMin(m15StructuralExtreme,closed.low);
         m15StructuralExtremeTime=closed.time;
         m15Promotions++;

         Log("SELL LH PROMOTED -> NEW LL PROVED IT | protectedLH="+
             DoubleToString(protectedM15Structure,_Digits));
      }
      else if(candidateM15Structure<=0.0 &&
              closed.close<m15StructuralExtreme-breakBuffer)
      {
         // Extension without a completed pullback. Update the low only.
         m15StructuralExtreme=MathMin(m15StructuralExtreme,closed.low);
         m15StructuralExtremeTime=closed.time;
      }

      return;
   }

   TryStartRegime();
}

// =============================================================
// VWAP CONFLUENCE
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

double VolumeForVWAP(const MqlRates &bar)
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
      double v=VolumeForVWAP(rates[i]);
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

bool RetestHasVWAPConfluence(const MqlRates &bar)
{
   if(!UseVWAPRetestConfluence)
      return true;

   double vwap=0.0;
   if(!ClosedM5VWAP(bar.time,vwap))
      return false;

   double tolerance=avgM5Range*MathMax(0.0,VWAPRetestToleranceM5RangeFrac);

   // Bar only needs to visit the VWAP neighborhood. Structure still decides
   // whether the retest is valid.
   return bar.low<=vwap+tolerance && bar.high>=vwap-tolerance;
}

// =============================================================
// M5 MAP
// =============================================================
bool FindLatestBuyAB(double &a,double &b,datetime &bTime)
{
   if(m5SwingCount<2)
      return false;

   for(int i=m5SwingCount-1;i>=1;i--)
   {
      if(m5Swings[i].type!=1)
         continue;

      for(int j=i-1;j>=0;j--)
      {
         if(m5Swings[j].type==-1)
         {
            a=m5Swings[j].price;
            b=m5Swings[i].price;
            bTime=m5Swings[i].time;
            return b>a;
         }
      }
   }

   return false;
}

bool FindLatestSellAB(double &a,double &b,datetime &bTime)
{
   if(m5SwingCount<2)
      return false;

   for(int i=m5SwingCount-1;i>=1;i--)
   {
      if(m5Swings[i].type!=-1)
         continue;

      for(int j=i-1;j>=0;j--)
      {
         if(m5Swings[j].type==1)
         {
            a=m5Swings[j].price;
            b=m5Swings[i].price;
            bTime=m5Swings[i].time;
            return a>b;
         }
      }
   }

   return false;
}

void LookForM5Breakout()
{
   if(HasPosition() || setupStage!=SETUP_IDLE || regime==TREND_NONE)
      return;

   if(avgM5Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   double buffer=MathMax(
      avgM5Range*MathMax(0.0,M5BreakoutBufferRangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(regime==TREND_BUY)
   {
      double a=0.0,b=0.0;
      datetime anchor=0;

      if(!FindLatestBuyAB(a,b,anchor))
         return;

      if(anchor==consumedBuyAnchor)
         return;

      if(closed.close>b+buffer)
      {
         setupStage=WAIT_M5_RETEST;
         setupDir=TREND_BUY;
         fibA=a;
         fibB=b;
         breakoutLevel=b;
         breakoutTime=closed.time;
         breakoutAnchorTime=anchor;
         m5Breakouts++;

         lastAction="M5 BUY BREAKOUT -> DO NOT CHASE / WAIT RETEST";
         Log(lastAction+
             " | A="+DoubleToString(fibA,_Digits)+
             " | B="+DoubleToString(fibB,_Digits));
      }
   }
   else if(regime==TREND_SELL)
   {
      double a=0.0,b=0.0;
      datetime anchor=0;

      if(!FindLatestSellAB(a,b,anchor))
         return;

      if(anchor==consumedSellAnchor)
         return;

      if(closed.close<b-buffer)
      {
         setupStage=WAIT_M5_RETEST;
         setupDir=TREND_SELL;
         fibA=a;
         fibB=b;
         breakoutLevel=b;
         breakoutTime=closed.time;
         breakoutAnchorTime=anchor;
         m5Breakouts++;

         lastAction="M5 SELL BREAKOUT -> DO NOT CHASE / WAIT RETEST";
         Log(lastAction+
             " | A="+DoubleToString(fibA,_Digits)+
             " | B="+DoubleToString(fibB,_Digits));
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
      lastAction="SETUP CANCELLED -> M15 STORY CHANGED";
      Log(lastAction);
      ResetSetup();
      return;
   }

   if(BreakoutExpiryMinutes>0 &&
      TimeCurrent()-breakoutTime>BreakoutExpiryMinutes*60)
   {
      setupCancels++;
      lastAction="BREAKOUT EXPIRED WITHOUT RETEST";
      Log(lastAction);
      ResetSetup();
      return;
   }

   if(avgM5Range<=0.0)
      return;

   MqlRates closed;
   if(!GetBar(MapTF,1,closed))
      return;

   if(closed.time<=breakoutTime)
      return;

   double zone=avgM5Range*MathMax(0.0,M5RetestZoneRangeFrac);
   double maxDepth=avgM5Range*MathMax(0.0,M5MaxRetestDepthRangeFrac);

   if(setupStage==WAIT_M5_RETEST)
   {
      if(setupDir==TREND_BUY)
      {
         bool touched=(closed.low<=breakoutLevel+zone);
         bool depthOK=(closed.low>=breakoutLevel-maxDepth);
         bool held=(closed.close>=breakoutLevel);
         bool vwapOK=RetestHasVWAPConfluence(closed);

         if(touched && depthOK && held && vwapOK)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestTime=closed.time;
            fibC=retestLow;
            setupStage=WAIT_M1_CONFIRM;
            m5Retests++;

            lastAction="M5 BUY RETEST HELD -> NEW HL / WAIT M1 TRIGGER";
            Log(lastAction+
                " | C="+DoubleToString(fibC,_Digits));
         }
         else if(closed.close<breakoutLevel-maxDepth)
         {
            setupCancels++;
            lastAction="BUY RETEST FAILED -> M5 LOST BREAKOUT LEVEL";
            Log(lastAction);
            ResetSetup();
         }
      }
      else if(setupDir==TREND_SELL)
      {
         bool touched=(closed.high>=breakoutLevel-zone);
         bool depthOK=(closed.high<=breakoutLevel+maxDepth);
         bool held=(closed.close<=breakoutLevel);
         bool vwapOK=RetestHasVWAPConfluence(closed);

         if(touched && depthOK && held && vwapOK)
         {
            retestLow=closed.low;
            retestHigh=closed.high;
            retestTime=closed.time;
            fibC=retestHigh;
            setupStage=WAIT_M1_CONFIRM;
            m5Retests++;

            lastAction="M5 SELL RETEST HELD -> NEW LH / WAIT M1 TRIGGER";
            Log(lastAction+
                " | C="+DoubleToString(fibC,_Digits));
         }
         else if(closed.close>breakoutLevel+maxDepth)
         {
            setupCancels++;
            lastAction="SELL RETEST FAILED -> M5 LOST BREAKOUT LEVEL";
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
         lastAction="RETEST EXPIRED WITHOUT M1 CONFIRMATION";
         Log(lastAction);
         ResetSetup();
         return;
      }

      if(setupDir==TREND_BUY)
      {
         if(closed.low<retestLow)
         {
            retestLow=closed.low;
            fibC=retestLow;
         }

         if(closed.high>retestHigh)
            retestHigh=closed.high;

         if(closed.close<breakoutLevel-maxDepth)
         {
            setupCancels++;
            lastAction="BUY RETEST STRUCTURE FAILED BEFORE ENTRY";
            Log(lastAction);
            ResetSetup();
         }
      }
      else if(setupDir==TREND_SELL)
      {
         if(closed.high>retestHigh)
         {
            retestHigh=closed.high;
            fibC=retestHigh;
         }

         if(closed.low<retestLow)
            retestLow=closed.low;

         if(closed.close>breakoutLevel+maxDepth)
         {
            setupCancels++;
            lastAction="SELL RETEST STRUCTURE FAILED BEFORE ENTRY";
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

void BuildFibTargets(TrendDir dir)
{
   double impulse=MathAbs(fibB-fibA);

   if(impulse<=0.0)
   {
      tp1Price=0.0;
      tp2Price=0.0;
      tp3Price=0.0;
      return;
   }

   if(dir==TREND_BUY)
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

bool OpenMountainTrade(TrendDir dir)
{
   if(HasPosition() ||
      setupStage!=WAIT_M1_CONFIRM ||
      dir!=regime ||
      avgM5Range<=0.0 ||
      fibA<=0.0 || fibB<=0.0 || fibC<=0.0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return false;

   double entry=(dir==TREND_BUY ? tick.ask : tick.bid);

   double maxDistance=
      avgM5Range*MathMax(0.0,MaxEntryDistanceFromBreakM5RangeFrac);

   if(MathAbs(entry-breakoutLevel)>maxDistance)
   {
      lateBlocks++;
      lastAction="ENTRY BLOCKED -> TOO LATE / TOO FAR FROM RETEST";
      Log(lastAction);
      ResetSetup();
      return false;
   }

   double stopBuffer=MathMax(
      avgM5Range*MathMax(0.0,StopBufferBeyondRetestM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   double sl=(dir==TREND_BUY ? retestLow-stopBuffer
                             : retestHigh+stopBuffer);

   sl=NormalizeDouble(sl,_Digits);

   double volume=NormalizeVolume(Lots);
   bool ok=false;

   if(dir==TREND_BUY)
      ok=trade.Buy(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V4_BUY");
   else
      ok=trade.Sell(volume,_Symbol,0.0,sl,0.0,"MOUNTAIN_V4_SELL");

   if(!ok || !TradeResultOK())
   {
      Log("ENTRY FAILED: "+trade.ResultRetcodeDescription());
      return false;
   }

   positionDir=dir;
   positionInitialVolume=volume;
   tp1Hit=false;
   tp2Hit=false;
   tp3Hit=false;

   BuildFibTargets(dir);

   if(dir==TREND_BUY)
      consumedBuyAnchor=breakoutAnchorTime;
   else
      consumedSellAnchor=breakoutAnchorTime;

   entries++;

   string side=(dir==TREND_BUY ? "BUY" : "SELL");

   lastAction=side+" SNIPER ENTRY -> HOLD THE MOUNTAIN";
   Log(lastAction+
       " | SL="+DoubleToString(sl,_Digits)+
       " | TP1="+DoubleToString(tp1Price,_Digits)+
       " | TP2="+DoubleToString(tp2Price,_Digits)+
       " | TP3="+DoubleToString(tp3Price,_Digits));

   ResetSetup();
   return true;
}

void ProcessM1Confirmation()
{
   if(HasPosition() ||
      setupStage!=WAIT_M1_CONFIRM ||
      setupDir==TREND_NONE ||
      setupDir!=regime)
      return;

   MqlRates signal;
   if(!GetBar(EntryTF,1,signal))
      return;

   if(signal.time<=retestTime)
      return;

   int lookback=MathMax(2,M1ConfirmationLookback);

   double minRecovery=MathMax(
      avgM5Range*MathMax(0.0,MinM1RecoveryM5RangeFrac),
      CostDistance()*MathMax(1.0,CostSafetyMultiple));

   if(setupDir==TREND_BUY)
   {
      double pullbackHigh=HighestM1High(2,lookback);
      if(pullbackHigh<=0.0)
         return;

      bool aboveBreakout=(signal.close>breakoutLevel);
      bool bullish=(signal.close>signal.open);
      bool breaksPullback=(signal.close>pullbackHigh);
      bool recovered=(signal.close-retestLow>=minRecovery);

      if(aboveBreakout && bullish && breaksPullback && recovered)
         OpenMountainTrade(TREND_BUY);
   }
   else
   {
      double pullbackLow=LowestM1Low(2,lookback);
      if(pullbackLow<=0.0)
         return;

      bool belowBreakout=(signal.close<breakoutLevel);
      bool bearish=(signal.close<signal.open);
      bool breaksPullback=(signal.close<pullbackLow);
      bool recovered=(retestHigh-signal.close>=minRecovery);

      if(belowBreakout && bearish && breaksPullback && recovered)
         OpenMountainTrade(TREND_SELL);
   }
}

// =============================================================
// FIB PARTIALS + FINAL RUNNER
// =============================================================
double NormalizePartialVolume(double requested,double currentVolume)
{
   double minVol=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);

   if(step<=0.0)
      step=minVol;

   double closeVol=MathFloor(requested/step+1e-12)*step;

   if(closeVol<minVol)
      return 0.0;

   // Keep at least the minimum volume alive as the runner.
   if(currentVolume-closeVol<minVol)
   {
      closeVol=currentVolume-minVol;
      closeVol=MathFloor(closeVol/step+1e-12)*step;
   }

   if(closeVol<minVol)
      return 0.0;

   return NormalizeDouble(closeVol,8);
}

void TryPartial(string label,double percent)
{
   if(!UseFibPartialProfits || percent<=0.0)
   {
      Log(label+" HIT -> partial profits disabled / runner continues");
      return;
   }

   ulong ticket=0;
   ENUM_POSITION_TYPE type;
   double openPrice=0.0;
   double currentVolume=0.0;

   if(!FindOurPosition(ticket,type,openPrice,currentVolume))
      return;

   double requested=positionInitialVolume*(percent/100.0);
   double closeVol=NormalizePartialVolume(requested,currentVolume);

   if(closeVol<=0.0)
   {
      Log(label+" HIT -> volume too small for partial close; runner continues");
      return;
   }

   if(!trade.PositionClosePartial(ticket,closeVol) || !TradeResultOK())
   {
      Log(label+" HIT -> partial close failed: "+trade.ResultRetcodeDescription());
      return;
   }

   partials++;
   Log(label+" PARTIAL TAKEN | volume="+DoubleToString(closeVol,8));
}

void ManageFibTargets()
{
   if(positionDir==TREND_NONE || !HasPosition())
      return;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol,tick))
      return;

   double price=(positionDir==TREND_BUY ? tick.bid : tick.ask);

   if(!tp1Hit && tp1Price>0.0)
   {
      bool hit=(positionDir==TREND_BUY ? price>=tp1Price : price<=tp1Price);
      if(hit)
      {
         tp1Hit=true;
         TryPartial("FIB TP1 "+DoubleToString(FibTP1,3),TP1PartialPercent);
      }
   }

   if(!tp2Hit && tp2Price>0.0)
   {
      bool hit=(positionDir==TREND_BUY ? price>=tp2Price : price<=tp2Price);
      if(hit)
      {
         tp2Hit=true;
         TryPartial("FIB TP2 "+DoubleToString(FibTP2,3),TP2PartialPercent);
      }
   }

   if(!tp3Hit && tp3Price>0.0)
   {
      bool hit=(positionDir==TREND_BUY ? price>=tp3Price : price<=tp3Price);
      if(hit)
      {
         tp3Hit=true;
         TryPartial("FIB TP3 "+DoubleToString(FibTP3,3),TP3PartialPercent);
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
   int before=m15SwingCount;
   DetectM15PivotAtShift(center);

   if(m15SwingCount!=before)
      UpdateCandidateFromNewestM15Swing();

   ProcessM15Story();
}

void OnNewM5()
{
   datetime current=iTime(_Symbol,MapTF,0);
   if(current<=0 || current==lastM5Bar)
      return;

   lastM5Bar=current;

   AvgRange(MapTF,1,M5RangeLookback,avgM5Range);

   int center=MathMax(1,M5PivotWing)+1;
   DetectM5PivotAtShift(center);

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
      return "BUY STORY LOCKED";

   if(regime==TREND_SELL)
      return "SELL STORY LOCKED";

   return "NEUTRAL / WAIT STORY";
}

string SetupText()
{
   if(setupStage==WAIT_M5_RETEST)
      return "BREAKOUT DONE -> WAIT M5 RETEST";

   if(setupStage==WAIT_M1_CONFIRM)
      return "RETEST HELD -> WAIT M1 SNIPER";

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
   string position="NONE";

   if(FindOurPosition(ticket,type,openPrice,volume))
      position=(type==POSITION_TYPE_BUY ? "BUY" : "SELL");

   Comment(
      "MOUNTAIN RIDER V4 - FIB SNIPER\n",
      "POSITION: ",position," | VOL: ",DoubleToString(volume,4),"\n",
      "M15 STORY: ",RegimeText(),"\n",
      "PROTECTED M15 HL/LH: ",DoubleToString(protectedM15Structure,_Digits),"\n",
      "M15 EXTREME HH/LL: ",DoubleToString(m15StructuralExtreme,_Digits),"\n",
      "CANDIDATE HL/LH: ",DoubleToString(candidateM15Structure,_Digits),"\n",
      "M5 MAP: ",SetupText(),"\n",
      "FIB A/B/C: ",DoubleToString(fibA,_Digits)," / ",
                       DoubleToString(fibB,_Digits)," / ",
                       DoubleToString(fibC,_Digits),"\n",
      "BREAKOUT LEVEL: ",DoubleToString(breakoutLevel,_Digits),"\n",
      "RETEST LOW/HIGH: ",DoubleToString(retestLow,_Digits)," / ",
                            DoubleToString(retestHigh,_Digits),"\n",
      "TP1: ",DoubleToString(tp1Price,_Digits)," [",(tp1Hit?"HIT":"WAIT"),"]",
      " | TP2: ",DoubleToString(tp2Price,_Digits)," [",(tp2Hit?"HIT":"WAIT"),"]",
      " | TP3: ",DoubleToString(tp3Price,_Digits)," [",(tp3Hit?"HIT":"WAIT"),"]\n",
      "REGIMES: ",IntegerToString(regimeStarts),
      " | BREAKS: ",IntegerToString(regimeBreaks),
      " | PROMOTIONS: ",IntegerToString(m15Promotions),"\n",
      "M5 BREAKOUTS: ",IntegerToString(m5Breakouts),
      " | RETESTS: ",IntegerToString(m5Retests),
      " | ENTRIES: ",IntegerToString(entries),"\n",
      "PARTIALS: ",IntegerToString(partials),
      " | EXITS: ",IntegerToString(exits),
      " | CANCELS: ",IntegerToString(setupCancels),
      " | LATE BLOCKS: ",IntegerToString(lateBlocks),"\n",
      "VWAP CONFLUENCE: ",(UseVWAPRetestConfluence?"ON":"OFF"),"\n",
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

   if(M15PivotWing<1 || M15PivotWing>12 ||
      M5PivotWing<1 || M5PivotWing>8)
      return INIT_PARAMETERS_INCORRECT;

   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   AvgRange(DirectionTF,1,M15RangeLookback,avgM15Range);
   AvgRange(MapTF,1,M5RangeLookback,avgM5Range);

   SeedM15Swings();
   SeedM5Swings();

   regime=TREND_NONE;
   protectedM15Structure=0.0;
   m15StructuralExtreme=0.0;
   candidateM15Structure=0.0;

   ResetSetup();
   ResetPositionTargets();

   // If the test starts inside an already mature sequence, the next closed
   // M15 bar can establish the story from the seeded swings.
   TryStartRegime();

   lastM15Bar=iTime(_Symbol,DirectionTF,0);
   lastM5Bar=iTime(_Symbol,MapTF,0);
   lastM1Bar=iTime(_Symbol,EntryTF,0);

   Log("INIT MOUNTAIN RIDER V4 - FIB SNIPER");
   Log("M15 STORY -> M5 BREAKOUT -> WAIT RETEST -> M1 CONFIRM -> ENTRY");
   Log("NO CHASE. NO TP ON FINAL RUNNER. EXIT FINAL RUNNER ON REAL CLOSED M15 STRUCTURE BREAK.");
   Log("FIB EXTENSION A-B-C -> TP1 / TP2 / TP3 PARTIALS WHEN VOLUME ALLOWS.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Comment("");

   Log("DEINIT V4 | regimes="+IntegerToString(regimeStarts)+
       " | breaks="+IntegerToString(regimeBreaks)+
       " | entries="+IntegerToString(entries)+
       " | partials="+IntegerToString(partials)+
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
