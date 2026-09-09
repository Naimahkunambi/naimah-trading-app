#property strict
#property version "1.00"
#include <Trade/Trade.mqh>
CTrade trade;

// =============================================================
// SIMPLE MOUNTAIN RIDER V1
// -------------------------------------------------------------
// M15 = direction
// M5  = breakout + retest area
// M1  = entry confirmation
// EXIT = M15 EMA8 breaks
// No TP. One position at a time.
// =============================================================

input double Lots = 0.01;
input ulong Magic = 260909001;
input int DeviationPoints = 30;

// Timeframes
input ENUM_TIMEFRAMES DirectionTF = PERIOD_M15;
input ENUM_TIMEFRAMES MapTF       = PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF     = PERIOD_M1;

// Trend / structure settings
input int EMAPeriod = 8;
input int M5BreakoutLookback = 12;       // previous 12 closed M5 bars
input int M5AverageRangeLookback = 12;
input double BreakoutBufferRangeFrac = 0.10;

// Retest / entry settings
input double RetestZoneRangeFrac = 0.25;
input double MaxRetestDepthRangeFrac = 0.70;
input double EntryConfirmRangeFrac = 0.15;
input int SetupExpiryMinutes = 60;

// Stop loss
input double SLBufferRangeFrac = 0.10;

// Costs
input double CommissionPerLotRT = 58.0;
input double CostSafetyMultiple = 1.25;

input bool VerboseLog = true;

int emaM15 = INVALID_HANDLE;

datetime lastM15Bar = 0;
datetime lastM5Bar  = 0;
datetime lastM1Bar  = 0;

int trend = 0;                  // +1 buy, -1 sell, 0 no trade
bool setupArmed = false;
int setupDir = 0;
double breakoutLevel = 0;
datetime breakoutTime = 0;
double retestLow = 0;
double retestHigh = 0;
bool retestSeen = false;

int entries = 0;
int exits = 0;
int blocked = 0;
string lastAction = "WAITING";

void Log(string text)
{
   if(VerboseLog) Print("[SIMPLE-MOUNTAIN] ", text);
}

bool GetBar(ENUM_TIMEFRAMES tf,int shift,MqlRates &bar)
{
   MqlRates a[1];
   if(CopyRates(_Symbol,tf,shift,1,a)!=1) return false;
   bar=a[0];
   return true;
}

bool GetEMA(int shift,double &value)
{
   if(emaM15==INVALID_HANDLE) return false;
   double a[1];
   if(CopyBuffer(emaM15,0,shift,1,a)!=1) return false;
   if(a[0]==EMPTY_VALUE) return false;
   value=a[0];
   return true;
}

bool AvgRange(ENUM_TIMEFRAMES tf,int startShift,int count,double &out)
{
   MqlRates r[];
   int n=CopyRates(_Symbol,tf,startShift,count,r);
   if(n!=count) return false;
   double sum=0;
   for(int i=0;i<n;i++) sum += (r[i].high-r[i].low);
   out=sum/count;
   return out>0;
}

double HighestHighM5(int startShift,int count)
{
   MqlRates r[];
   int n=CopyRates(_Symbol,MapTF,startShift,count,r);
   if(n!=count) return 0;
   double h=r[0].high;
   for(int i=1;i<n;i++) if(r[i].high>h) h=r[i].high;
   return h;
}

double LowestLowM5(int startShift,int count)
{
   MqlRates r[];
   int n=CopyRates(_Symbol,MapTF,startShift,count,r);
   if(n!=count) return 0;
   double l=r[0].low;
   for(int i=1;i<n;i++) if(r[i].low<l) l=r[i].low;
   return l;
}

double NormVol(double v)
{
   double minv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maxv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0) step=minv;
   v=MathMax(minv,MathMin(maxv,v));
   v=MathFloor((v-minv+1e-12)/step)*step+minv;
   return NormalizeDouble(v,2);
}

double TickValue()
{
   double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(v>0) return v;
   double vp=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT);
   double vl=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);
   return MathMax(vp,vl);
}

double CostDistance()
{
   MqlTick t;
   if(!SymbolInfoTick(_Symbol,t)) return 0;
   double spread=MathMax(0.0,t.ask-t.bid);
   double commissionDist=0;
   double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tv=TickValue();
   if(ts>0 && tv>0)
   {
      double moneyPerPricePerLot=tv/ts;
      if(moneyPerPricePerLot>0)
         commissionDist=CommissionPerLotRT/moneyPerPricePerLot;
   }
   return spread+commissionDist;
}

bool TradeOK()
{
   uint rc=trade.ResultRetcode();
   return rc==TRADE_RETCODE_DONE || rc==TRADE_RETCODE_DONE_PARTIAL || rc==TRADE_RETCODE_PLACED;
}

bool FindPosition(ulong &ticket,ENUM_POSITION_TYPE &type,double &openPrice)
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);
      if(t==0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic) continue;
      ticket=t;
      type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      openPrice=PositionGetDouble(POSITION_PRICE_OPEN);
      return true;
   }
   return false;
}

bool HasPosition()
{
   ulong t; ENUM_POSITION_TYPE ty; double op;
   return FindPosition(t,ty,op);
}

void ResetSetup()
{
   setupArmed=false;
   setupDir=0;
   breakoutLevel=0;
   breakoutTime=0;
   retestLow=0;
   retestHigh=0;
   retestSeen=false;
}

bool CloseCurrent(string reason)
{
   ulong ticket; ENUM_POSITION_TYPE type; double openPrice;
   if(!FindPosition(ticket,type,openPrice)) return false;
   if(!trade.PositionClose(ticket) || !TradeOK())
   {
      Log("Close failed: "+trade.ResultRetcodeDescription());
      return false;
   }
   exits++;
   lastAction=reason;
   Log(reason);
   return true;
}

void UpdateM15Trend()
{
   MqlRates b1,b2;
   double e1=0,e2=0;
   if(!GetBar(DirectionTF,1,b1) || !GetBar(DirectionTF,2,b2)) return;
   if(!GetEMA(1,e1) || !GetEMA(2,e2)) return;

   int old=trend;
   if(b1.close>e1 && e1>e2)
      trend=1;
   else if(b1.close<e1 && e1<e2)
      trend=-1;
   else
      trend=0;

   if(trend!=old)
   {
      lastAction=(trend==1?"M15 BUY TREND":(trend==-1?"M15 SELL TREND":"M15 NO CLEAR TREND"));
      Log(lastAction);
      if(!HasPosition()) ResetSetup();
   }
}

void LookForM5Breakout()
{
   if(HasPosition() || setupArmed || trend==0) return;

   double avg=0;
   if(!AvgRange(MapTF,1,M5AverageRangeLookback,avg)) return;

   MqlRates b;
   if(!GetBar(MapTF,1,b)) return;

   double buffer=MathMax(avg*BreakoutBufferRangeFrac,CostDistance()*CostSafetyMultiple);

   if(trend==1)
   {
      double level=HighestHighM5(2,M5BreakoutLookback);
      if(level>0 && b.close>level+buffer)
      {
         setupArmed=true;
         setupDir=1;
         breakoutLevel=level;
         breakoutTime=b.time;
         retestSeen=false;
         lastAction="M5 BUY BREAKOUT. WAIT RETEST.";
         Log(lastAction);
      }
   }
   else if(trend==-1)
   {
      double level=LowestLowM5(2,M5BreakoutLookback);
      if(level>0 && b.close<level-buffer)
      {
         setupArmed=true;
         setupDir=-1;
         breakoutLevel=level;
         breakoutTime=b.time;
         retestSeen=false;
         lastAction="M5 SELL BREAKOUT. WAIT RETEST.";
         Log(lastAction);
      }
   }
}

bool OpenTrade(int dir,double sl)
{
   if(HasPosition()) return false;

   double vol=NormVol(Lots);
   sl=NormalizeDouble(sl,_Digits);
   bool ok=false;

   if(dir==1)
      ok=trade.Buy(vol,_Symbol,0,sl,0,"SIMPLE_MOUNTAIN_BUY");
   else
      ok=trade.Sell(vol,_Symbol,0,sl,0,"SIMPLE_MOUNTAIN_SELL");

   if(!ok || !TradeOK())
   {
      Log("Entry failed: "+trade.ResultRetcodeDescription());
      return false;
   }

   entries++;
   lastAction=(dir==1?"BUY OPENED":"SELL OPENED");
   Log(lastAction);
   ResetSetup();
   return true;
}

void ProcessM1Entry()
{
   if(!setupArmed || HasPosition()) return;

   if(trend!=setupDir || trend==0)
   {
      lastAction="SETUP CANCELLED. M15 TREND CHANGED.";
      ResetSetup();
      return;
   }

   if(SetupExpiryMinutes>0 && TimeCurrent()-breakoutTime>SetupExpiryMinutes*60)
   {
      lastAction="SETUP EXPIRED";
      ResetSetup();
      return;
   }

   double avg=0;
   if(!AvgRange(MapTF,1,M5AverageRangeLookback,avg)) return;

   MqlRates b,prev;
   if(!GetBar(EntryTF,1,b) || !GetBar(EntryTF,2,prev)) return;

   double zone=avg*RetestZoneRangeFrac;
   double maxDepth=avg*MaxRetestDepthRangeFrac;
   double confirm=MathMax(avg*EntryConfirmRangeFrac,CostDistance()*CostSafetyMultiple);
   double slBuffer=MathMax(avg*SLBufferRangeFrac,CostDistance()*CostSafetyMultiple);

   if(setupDir==1)
   {
      // First wait for price to come back near the broken M5 level.
      if(!retestSeen)
      {
         bool touched=(b.low<=breakoutLevel+zone && b.low>=breakoutLevel-maxDepth);
         if(touched)
         {
            retestSeen=true;
            retestLow=b.low;
            retestHigh=b.high;
            lastAction="BUY RETEST SEEN. WAIT CONFIRMATION.";
            Log(lastAction);
         }
         return;
      }

      if(b.low<retestLow) retestLow=b.low;
      if(b.high>retestHigh) retestHigh=b.high;

      // If the retest falls too deep below the broken level, cancel it.
      if(b.close<breakoutLevel-maxDepth)
      {
         blocked++;
         lastAction="BUY RETEST FAILED. CANCEL.";
         Log(lastAction);
         ResetSetup();
         return;
      }

      // Entry only after a CLOSED M1 candle resumes upward.
      bool backAboveLevel=(b.close>breakoutLevel);
      bool breaksPreviousM1=(b.close>prev.high);
      bool movedEnough=(b.close-retestLow>=confirm);

      if(backAboveLevel && breaksPreviousM1 && movedEnough)
      {
         double sl=retestLow-slBuffer;
         OpenTrade(1,sl);
      }
   }
   else if(setupDir==-1)
   {
      if(!retestSeen)
      {
         bool touched=(b.high>=breakoutLevel-zone && b.high<=breakoutLevel+maxDepth);
         if(touched)
         {
            retestSeen=true;
            retestLow=b.low;
            retestHigh=b.high;
            lastAction="SELL RETEST SEEN. WAIT CONFIRMATION.";
            Log(lastAction);
         }
         return;
      }

      if(b.low<retestLow) retestLow=b.low;
      if(b.high>retestHigh) retestHigh=b.high;

      if(b.close>breakoutLevel+maxDepth)
      {
         blocked++;
         lastAction="SELL RETEST FAILED. CANCEL.";
         Log(lastAction);
         ResetSetup();
         return;
      }

      bool backBelowLevel=(b.close<breakoutLevel);
      bool breaksPreviousM1=(b.close<prev.low);
      bool movedEnough=(retestHigh-b.close>=confirm);

      if(backBelowLevel && breaksPreviousM1 && movedEnough)
      {
         double sl=retestHigh+slBuffer;
         OpenTrade(-1,sl);
      }
   }
}

void CheckM15Exit()
{
   ulong ticket; ENUM_POSITION_TYPE type; double openPrice;
   if(!FindPosition(ticket,type,openPrice)) return;

   MqlRates b;
   double ema=0;
   if(!GetBar(DirectionTF,1,b) || !GetEMA(1,ema)) return;

   if(type==POSITION_TYPE_BUY && b.close<ema)
      CloseCurrent("EXIT BUY: M15 CLOSED BELOW EMA8");
   else if(type==POSITION_TYPE_SELL && b.close>ema)
      CloseCurrent("EXIT SELL: M15 CLOSED ABOVE EMA8");
}

void NewM15()
{
   datetime t=iTime(_Symbol,DirectionTF,0);
   if(t<=0 || t==lastM15Bar) return;
   lastM15Bar=t;
   UpdateM15Trend();
   CheckM15Exit();
}

void NewM5()
{
   datetime t=iTime(_Symbol,MapTF,0);
   if(t<=0 || t==lastM5Bar) return;
   lastM5Bar=t;
   LookForM5Breakout();
}

void NewM1()
{
   datetime t=iTime(_Symbol,EntryTF,0);
   if(t<=0 || t==lastM1Bar) return;
   lastM1Bar=t;
   ProcessM1Entry();
}

string TrendText()
{
   if(trend==1) return "BUY ONLY";
   if(trend==-1) return "SELL ONLY";
   return "WAIT";
}

void Panel()
{
   double avg=0;AvgRange(MapTF,1,M5AverageRangeLookback,avg);
   Comment(
      "SIMPLE MOUNTAIN RIDER V1\n",
      "M15 DIRECTION: ",TrendText(),"\n",
      "M5 BREAKOUT LEVEL: ",DoubleToString(breakoutLevel,_Digits),"\n",
      "SETUP ARMED: ",(setupArmed?"YES":"NO"),"\n",
      "RETEST SEEN: ",(retestSeen?"YES":"NO"),"\n",
      "M5 AVG RANGE: ",DoubleToString(avg,2),"\n",
      "ENTRIES: ",IntegerToString(entries)," | EXITS: ",IntegerToString(exits)," | BLOCKED: ",IntegerToString(blocked),"\n",
      "LAST: ",lastAction
   );
}

int OnInit()
{
   if(DirectionTF!=PERIOD_M15 || MapTF!=PERIOD_M5 || EntryTF!=PERIOD_M1)
      return INIT_PARAMETERS_INCORRECT;

   emaM15=iMA(_Symbol,DirectionTF,EMAPeriod,0,MODE_EMA,PRICE_CLOSE);
   if(emaM15==INVALID_HANDLE) return INIT_FAILED;

   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   Log("INIT SIMPLE MOUNTAIN RIDER V1");
   Log("M15 direction -> M5 breakout -> M1 retest confirmation -> M15 EMA8 exit");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(emaM15!=INVALID_HANDLE) IndicatorRelease(emaM15);
   Comment("");
}

void OnTick()
{
   NewM15();
   NewM5();
   NewM1();
   Panel();
}
