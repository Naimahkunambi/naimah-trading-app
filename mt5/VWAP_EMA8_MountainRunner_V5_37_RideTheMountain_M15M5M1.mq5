#property strict
#property version "5.37"
#include <Trade/Trade.mqh>
CTrade trade;

#define SWINGBUF 12

enum TrendDir { TREND_NONE=0, TREND_BUY=1, TREND_SELL=-1 };
enum MapState { MAP_IDLE=0, MAP_BREAKOUT_ARMED=1, MAP_RETEST_ACTIVE=2 };

input double Lots=0.01;
input ulong Magic=260908537;
input int DeviationPoints=30;
input int EmergencySLPoints=0;
input ENUM_TIMEFRAMES DirectionTF=PERIOD_M15;
input ENUM_TIMEFRAMES MapTF=PERIOD_M5;
input ENUM_TIMEFRAMES EntryTF=PERIOD_M1;
input int VWAPResetHour=0;
input bool PreferRealVolume=false;

// M15 DIRECTION
input int M15PivotWing=2;
input double MinM15StructureStepPoints=0.0;

// M5 MAP / BREAKOUT ZONE
input int M5PivotWing=2;
input int M5RangeLookback=12;
input double BreakoutBufferM5RangeFrac=0.10;
input double RetestZoneM5RangeFrac=0.20;
input int BreakoutExpiryMinutes=90;
input bool OneTradePerBreakout=true;

// M1 ENTRY
input double MaxEntryDistanceM5RangeFrac=0.80;
input double SLBufferM5RangeFrac=0.05;
input double MinConfirmationM5RangeFrac=0.10;
input int MaxRetestMinutes=30;

// COST CONTROL
input double CommissionPerLotRT=58.0;
input double CostSafetyMultiple=1.25;
input int ExpectedSlippagePoints=0;

input int PanelUpdateMilliseconds=500;
input bool VerboseLog=true;

int m15Type[SWINGBUF];
double m15Price[SWINGBUF];
datetime m15Time[SWINGBUF];
int m15Count=0;

int m5Type[SWINGBUF];
double m5Price[SWINGBUF];
datetime m5Time[SWINGBUF];
int m5Count=0;

datetime lastM15Bar=0,lastM5Bar=0,lastM1Bar=0;
double avgM5Range=0;
TrendDir direction=TREND_NONE;

double m15PrevHigh=0,m15LastHigh=0,m15PrevLow=0,m15LastLow=0;
datetime m15LastHighTime=0,m15LastLowTime=0;

double mapBreakLevel=0;
double mapZoneLow=0,mapZoneHigh=0;
datetime mapBreakTime=0;
datetime mapSwingTime=0;
TrendDir mapDir=TREND_NONE;
MapState mapState=MAP_IDLE;
datetime consumedBreakTime=0;

double retestLow=0,retestHigh=0;
datetime retestStart=0;
int retestBars=0;

double positionStructureLevel=0;
TrendDir positionDir=TREND_NONE;

string lastAction="WAITING";
ulong lastPanelMs=0;
int breakoutsArmed=0,retestsSeen=0,entriesTaken=0,structureExits=0,lateEntryBlocks=0;

void Log(string s){if(VerboseLog)Print("[V5.37-RTM] ",s);}

bool GetBar(ENUM_TIMEFRAMES tf,int shift,MqlRates &bar)
{
   MqlRates a[1];
   if(CopyRates(_Symbol,tf,shift,1,a)!=1)return false;
   bar=a[0];return true;
}

double BarVol(const MqlRates &b)
{
   if(PreferRealVolume&&b.real_volume>0)return(double)b.real_volume;
   return(double)b.tick_volume;
}

bool AvgRange(ENUM_TIMEFRAMES tf,int startShift,int count,double &out)
{
   count=MathMax(2,count);
   MqlRates r[];
   int n=CopyRates(_Symbol,tf,startShift,count,r);
   if(n!=count)return false;
   double sum=0;int valid=0;
   for(int i=0;i<n;i++){
      double x=r[i].high-r[i].low;
      if(x>0){sum+=x;valid++;}
   }
   if(valid==0)return false;
   out=sum/valid;return true;
}

double NormVol(double req)
{
   double minv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maxv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0)step=minv;
   double v=MathMax(minv,MathMin(maxv,req));
   if(step>0)v=MathFloor((v-minv+1e-12)/step)*step+minv;
   int d=2;
   if(step>0){double lg=-MathLog10(step);d=(lg>0?(int)MathCeil(lg):0);d=MathMin(8,MathMax(0,d));}
   return NormalizeDouble(v,d);
}

double TickValue()
{
   double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
   if(v>0)return v;
   double vp=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT);
   double vl=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(vp>0&&vl>0)return(vp+vl)*0.5;
   return MathMax(vp,vl);
}

double FrictionDistance(const MqlTick &t,double lots)
{
   double spread=MathMax(0.0,t.ask-t.bid);
   double commissionDist=0;
   double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE);
   double tv=TickValue();
   if(ts>0&&tv>0){
      double moneyPerPricePerLot=tv/ts;
      if(moneyPerPricePerLot>0)commissionDist=MathMax(0.0,CommissionPerLotRT)/moneyPerPricePerLot;
   }
   double slip=MathMax(0,ExpectedSlippagePoints)*_Point;
   return spread+commissionDist+slip;
}

bool TradeOK()
{
   uint rc=trade.ResultRetcode();
   return rc==TRADE_RETCODE_DONE||rc==TRADE_RETCODE_DONE_PARTIAL||rc==TRADE_RETCODE_PLACED;
}

bool FindPos(ulong &ticket,ENUM_POSITION_TYPE &type,double &open,double &profit)
{
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong t=PositionGetTicket(i);
      if(t==0||!PositionSelectByTicket(t))continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol)continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic)continue;
      ticket=t;
      type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      open=PositionGetDouble(POSITION_PRICE_OPEN);
      profit=PositionGetDouble(POSITION_PROFIT);
      return true;
   }
   return false;
}

bool HasPos(){ulong t;ENUM_POSITION_TYPE ty;double o,p;return FindPos(t,ty,o,p);}

void ResetMap()
{
   mapBreakLevel=0;mapZoneLow=0;mapZoneHigh=0;mapBreakTime=0;mapSwingTime=0;
   mapDir=TREND_NONE;mapState=MAP_IDLE;retestLow=0;retestHigh=0;retestStart=0;retestBars=0;
}

bool ClosePos(ulong ticket,string reason)
{
   bool ok=trade.PositionClose(ticket);
   if(!ok||!TradeOK()){Log("CLOSE failed: "+trade.ResultRetcodeDescription());return false;}
   lastAction=reason;Log(reason);
   positionStructureLevel=0;positionDir=TREND_NONE;
   return true;
}

bool IsPivotHigh(ENUM_TIMEFRAMES tf,int center,int wing,double &price,datetime &when)
{
   MqlRates c;if(!GetBar(tf,center,c))return false;
   for(int k=1;k<=wing;k++){
      MqlRates newer,older;
      if(!GetBar(tf,center-k,newer)||!GetBar(tf,center+k,older))return false;
      if(c.high<=newer.high||c.high<=older.high)return false;
   }
   price=c.high;when=c.time;return true;
}

bool IsPivotLow(ENUM_TIMEFRAMES tf,int center,int wing,double &price,datetime &when)
{
   MqlRates c;if(!GetBar(tf,center,c))return false;
   for(int k=1;k<=wing;k++){
      MqlRates newer,older;
      if(!GetBar(tf,center-k,newer)||!GetBar(tf,center+k,older))return false;
      if(c.low>=newer.low||c.low>=older.low)return false;
   }
   price=c.low;when=c.time;return true;
}

void AppendSwing(int &types[],double &prices[],datetime &times[],int &count,int type,double price,datetime when)
{
   if(count>0&&types[count-1]==type){
      bool replace=(type>0?price>prices[count-1]:price<prices[count-1]);
      if(replace){prices[count-1]=price;times[count-1]=when;}
      return;
   }
   if(count<SWINGBUF){types[count]=type;prices[count]=price;times[count]=when;count++;return;}
   for(int i=1;i<SWINGBUF;i++){types[i-1]=types[i];prices[i-1]=prices[i];times[i-1]=times[i];}
   types[SWINGBUF-1]=type;prices[SWINGBUF-1]=price;times[SWINGBUF-1]=when;
}

void DetectM15Swing()
{
   int wing=MathMax(1,M15PivotWing),center=wing+1;
   double hp=0,lp=0;datetime ht=0,lt=0;
   bool hi=IsPivotHigh(DirectionTF,center,wing,hp,ht);
   bool lo=IsPivotLow(DirectionTF,center,wing,lp,lt);
   if(hi&&lo)return;
   if(hi)AppendSwing(m15Type,m15Price,m15Time,m15Count,1,hp,ht);
   else if(lo)AppendSwing(m15Type,m15Price,m15Time,m15Count,-1,lp,lt);
}

void DetectM5Swing()
{
   int wing=MathMax(1,M5PivotWing),center=wing+1;
   double hp=0,lp=0;datetime ht=0,lt=0;
   bool hi=IsPivotHigh(MapTF,center,wing,hp,ht);
   bool lo=IsPivotLow(MapTF,center,wing,lp,lt);
   if(hi&&lo)return;
   if(hi)AppendSwing(m5Type,m5Price,m5Time,m5Count,1,hp,ht);
   else if(lo)AppendSwing(m5Type,m5Price,m5Time,m5Count,-1,lp,lt);
}

bool LastTwoOfType(int types[],double prices[],datetime times[],int count,int wanted,double &prev,double &last,datetime &lastTime)
{
   int found=0;
   for(int i=count-1;i>=0;i--){
      if(types[i]!=wanted)continue;
      if(found==0){last=prices[i];lastTime=times[i];found++;}
      else{prev=prices[i];return true;}
   }
   return false;
}

void UpdateM15Direction()
{
   double ph=0,lh=0,pl=0,ll=0;datetime lht=0,llt=0;
   bool haveH=LastTwoOfType(m15Type,m15Price,m15Time,m15Count,1,ph,lh,lht);
   bool haveL=LastTwoOfType(m15Type,m15Price,m15Time,m15Count,-1,pl,ll,llt);
   if(!haveH||!haveL){direction=TREND_NONE;return;}

   m15PrevHigh=ph;m15LastHigh=lh;m15PrevLow=pl;m15LastLow=ll;m15LastHighTime=lht;m15LastLowTime=llt;
   double step=MathMax(0.0,MinM15StructureStepPoints)*_Point;
   bool up=(lh>ph+step)&&(ll>pl+step);
   bool down=(lh<ph-step)&&(ll<pl-step);

   TrendDir old=direction;
   direction=up?TREND_BUY:(down?TREND_SELL:TREND_NONE);
   if(direction!=old){
      lastAction=(direction==TREND_BUY?"M15 UPTREND":(direction==TREND_SELL?"M15 DOWNTREND":"M15 NO CLEAR TREND"));
      Log(lastAction);
      if(!HasPos())ResetMap();
   }
}

bool LatestM5Swing(int wanted,double &price,datetime &when)
{
   for(int i=m5Count-1;i>=0;i--){
      if(m5Type[i]==wanted){price=m5Price[i];when=m5Time[i];return true;}
   }
   return false;
}

void ArmM5Breakout()
{
   if(HasPos()||direction==TREND_NONE||mapState!=MAP_IDLE||avgM5Range<=0)return;
   MqlRates b;if(!GetBar(MapTF,1,b))return;
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;
   double lots=NormVol(Lots);
   double buffer=MathMax(avgM5Range*MathMax(0.0,BreakoutBufferM5RangeFrac),FrictionDistance(t,lots)*MathMax(1.0,CostSafetyMultiple));
   double zoneHalf=avgM5Range*MathMax(0.0,RetestZoneM5RangeFrac);

   if(direction==TREND_BUY){
      double level=0;datetime st=0;if(!LatestM5Swing(1,level,st))return;
      if(OneTradePerBreakout&&st==consumedBreakTime)return;
      if(b.close>=level+buffer){
         mapDir=TREND_BUY;mapState=MAP_BREAKOUT_ARMED;mapBreakLevel=level;mapSwingTime=st;mapBreakTime=b.time;
         mapZoneLow=level-zoneHalf;mapZoneHigh=level+zoneHalf;breakoutsArmed++;
         lastAction="M5 BUY BREAKOUT -> WAIT RETEST";Log(lastAction);
      }
   }else if(direction==TREND_SELL){
      double level=0;datetime st=0;if(!LatestM5Swing(-1,level,st))return;
      if(OneTradePerBreakout&&st==consumedBreakTime)return;
      if(b.close<=level-buffer){
         mapDir=TREND_SELL;mapState=MAP_BREAKOUT_ARMED;mapBreakLevel=level;mapSwingTime=st;mapBreakTime=b.time;
         mapZoneLow=level-zoneHalf;mapZoneHigh=level+zoneHalf;breakoutsArmed++;
         lastAction="M5 SELL BREAKOUT -> WAIT RETEST";Log(lastAction);
      }
   }
}

void UpdateRetestFromM1()
{
   if(mapState==MAP_IDLE||HasPos())return;
   if(direction!=mapDir||direction==TREND_NONE){lastAction="SETUP CANCELLED: M15 DIRECTION LOST";ResetMap();return;}
   if(BreakoutExpiryMinutes>0&&TimeCurrent()-mapBreakTime>BreakoutExpiryMinutes*60){lastAction="BREAKOUT EXPIRED";ResetMap();return;}

   MqlRates b;if(!GetBar(EntryTF,1,b))return;
   if(mapState==MAP_BREAKOUT_ARMED){
      bool touched=(b.low<=mapZoneHigh&&b.high>=mapZoneLow);
      if(!touched)return;
      mapState=MAP_RETEST_ACTIVE;retestStart=b.time;retestLow=b.low;retestHigh=b.high;retestBars=1;retestsSeen++;
      lastAction=(mapDir==TREND_BUY?"BUY":"SELL")+string(" RETEST ACTIVE -> WAIT M1 CONFIRMATION");Log(lastAction);return;
   }

   if(mapState==MAP_RETEST_ACTIVE){
      retestBars++;
      if(b.low<retestLow)retestLow=b.low;
      if(b.high>retestHigh)retestHigh=b.high;
      if(MaxRetestMinutes>0&&TimeCurrent()-retestStart>MaxRetestMinutes*60){lastAction="RETEST EXPIRED";ResetMap();return;}

      MqlRates prev;if(!GetBar(EntryTF,2,prev))return;
      MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;
      double lots=NormVol(Lots);
      double confirmFloor=MathMax(avgM5Range*MathMax(0.0,MinConfirmationM5RangeFrac),FrictionDistance(t,lots)*MathMax(1.0,CostSafetyMultiple));

      if(mapDir==TREND_BUY){
         bool heldZone=(b.close>=mapBreakLevel);
         bool brokePullback=(b.close>=prev.high&&b.close-prev.high>=0.0);
         bool meaningful=(b.close-retestLow)>=confirmFloor;
         if(heldZone&&brokePullback&&meaningful)OpenFromRetest(TREND_BUY,b.close);
      }else if(mapDir==TREND_SELL){
         bool heldZone=(b.close<=mapBreakLevel);
         bool brokePullback=(b.close<=prev.low&&prev.low-b.close>=0.0);
         bool meaningful=(retestHigh-b.close)>=confirmFloor;
         if(heldZone&&brokePullback&&meaningful)OpenFromRetest(TREND_SELL,b.close);
      }
   }
}

bool OpenFromRetest(TrendDir dir,double confirmClose)
{
   if(HasPos()||mapState!=MAP_RETEST_ACTIVE||avgM5Range<=0)return false;
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;
   double entry=(dir==TREND_BUY?t.ask:t.bid);
   double maxDist=avgM5Range*MathMax(0.0,MaxEntryDistanceM5RangeFrac);
   double dist=MathAbs(entry-mapBreakLevel);
   if(dist>maxDist){lateEntryBlocks++;lastAction="ENTRY BLOCKED: TOO LATE/FAR FROM RETEST";Log(lastAction);ResetMap();return false;}

   double slBuffer=MathMax(avgM5Range*MathMax(0.0,SLBufferM5RangeFrac),FrictionDistance(t,NormVol(Lots))*MathMax(1.0,CostSafetyMultiple));
   double sl=(dir==TREND_BUY?retestLow-slBuffer:retestHigh+slBuffer);
   if(EmergencySLPoints>0){
      double emergency=(dir==TREND_BUY?t.ask-EmergencySLPoints*_Point:t.bid+EmergencySLPoints*_Point);
      if(dir==TREND_BUY)sl=MathMax(sl,emergency);else sl=MathMin(sl,emergency);
   }
   sl=NormalizeDouble(sl,_Digits);

   bool ok=false;
   if(dir==TREND_BUY)ok=trade.Buy(NormVol(Lots),_Symbol,0,sl,0,"V537_RTM_BUY");
   else ok=trade.Sell(NormVol(Lots),_Symbol,0,sl,0,"V537_RTM_SELL");
   if(!ok||!TradeOK()){Log("ENTRY failed: "+trade.ResultRetcodeDescription());return false;}

   positionDir=dir;
   positionStructureLevel=(dir==TREND_BUY?m15LastLow:m15LastHigh);
   consumedBreakTime=mapSwingTime;
   entriesTaken++;
   lastAction=(dir==TREND_BUY?"BUY":"SELL")+string(" OPENED AFTER BREAKOUT + RETEST + M1 CONFIRMATION");Log(lastAction);
   ResetMap();
   return true;
}

void UpdatePositionStructureLevel()
{
   if(!HasPos()||positionDir==TREND_NONE)return;
   if(positionDir==TREND_BUY&&m15LastLow>0){
      if(positionStructureLevel<=0||m15LastLow>positionStructureLevel)positionStructureLevel=m15LastLow;
   }else if(positionDir==TREND_SELL&&m15LastHigh>0){
      if(positionStructureLevel<=0||m15LastHigh<positionStructureLevel)positionStructureLevel=m15LastHigh;
   }
}

void CheckM15StructureExit()
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return;
   if(positionStructureLevel<=0)return;
   MqlRates b;if(!GetBar(DirectionTF,1,b))return;

   if(ty==POSITION_TYPE_BUY&&b.close<positionStructureLevel){
      if(ClosePos(tk,"EXIT: M15 UPTREND STRUCTURE BROKE"))structureExits++;
   }else if(ty==POSITION_TYPE_SELL&&b.close>positionStructureLevel){
      if(ClosePos(tk,"EXIT: M15 DOWNTREND STRUCTURE BROKE"))structureExits++;
   }
}

void NewM15()
{
   datetime c=iTime(_Symbol,DirectionTF,0);if(c<=0||c==lastM15Bar)return;lastM15Bar=c;
   DetectM15Swing();UpdateM15Direction();UpdatePositionStructureLevel();CheckM15StructureExit();
}

void NewM5()
{
   datetime c=iTime(_Symbol,MapTF,0);if(c<=0||c==lastM5Bar)return;lastM5Bar=c;
   double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5Range=x;
   DetectM5Swing();ArmM5Breakout();
}

void NewM1()
{
   datetime c=iTime(_Symbol,EntryTF,0);if(c<=0||c==lastM1Bar)return;lastM1Bar=c;
   UpdateRetestFromM1();
}

string TrendName()
{
   if(direction==TREND_BUY)return "UPTREND / BUY ONLY";
   if(direction==TREND_SELL)return "DOWNTREND / SELL ONLY";
   return "NO CLEAR M15 TREND";
}

string MapName()
{
   if(mapState==MAP_BREAKOUT_ARMED)return "BREAKOUT ARMED / WAIT RETEST";
   if(mapState==MAP_RETEST_ACTIVE)return "RETEST ACTIVE / WAIT M1 CONFIRM";
   return "IDLE";
}

void Panel()
{
   ulong now=GetTickCount64();if(lastPanelMs>0&&now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))return;lastPanelMs=now;
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;string pos="NONE";
   if(FindPos(tk,ty,op,pf))pos=(ty==POSITION_TYPE_BUY?"BUY":"SELL")+string(" | STRUCT EXIT LEVEL ")+DoubleToString(positionStructureLevel,_Digits);
   Comment("RIDE THE MOUNTAIN v5.37 | M15 -> M5 -> M1\n",
           "POSITION: ",pos,
           "\nM15 DIRECTION: ",TrendName(),
           "\nM15 HIGH: ",DoubleToString(m15LastHigh,_Digits)," | PREV HIGH: ",DoubleToString(m15PrevHigh,_Digits),
           "\nM15 LOW: ",DoubleToString(m15LastLow,_Digits)," | PREV LOW: ",DoubleToString(m15PrevLow,_Digits),
           "\nM5 MAP: ",MapName(),
           "\nBREAK LEVEL: ",DoubleToString(mapBreakLevel,_Digits)," | ZONE: ",DoubleToString(mapZoneLow,_Digits)," - ",DoubleToString(mapZoneHigh,_Digits),
           "\nRETEST LOW/HIGH: ",DoubleToString(retestLow,_Digits)," / ",DoubleToString(retestHigh,_Digits),
           "\nM5 AVG RANGE: ",DoubleToString(avgM5Range,2),
           "\nARMED: ",IntegerToString(breakoutsArmed)," | RETESTS: ",IntegerToString(retestsSeen)," | ENTRIES: ",IntegerToString(entriesTaken),
           "\nLATE BLOCKS: ",IntegerToString(lateEntryBlocks)," | STRUCTURE EXITS: ",IntegerToString(structureExits),
           "\nLAST: ",lastAction);
}

int OnInit()
{
   if(DirectionTF!=PERIOD_M15||MapTF!=PERIOD_M5||EntryTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;
   if(M15PivotWing<1||M15PivotWing>5||M5PivotWing<1||M5PivotWing>5)return INIT_PARAMETERS_INCORRECT;
   trade.SetExpertMagicNumber(Magic);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);
   double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5Range=x;
   ResetMap();
   Log("INIT V5.37 RIDE THE MOUNTAIN");
   Log("M15 = DIRECTION + STRUCTURE EXIT | M5 = BREAKOUT MAP | M1 = RETEST CONFIRMATION ENTRY");
   Log("NO TAKE PROFIT | FIXED RETEST SL | EXIT ONLY ON M15 STRUCTURE BREAK OR SL");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Log("DEINIT V5.37 | armed="+IntegerToString(breakoutsArmed)+" | retests="+IntegerToString(retestsSeen)+" | entries="+IntegerToString(entriesTaken)+" | structure exits="+IntegerToString(structureExits));
   Comment("");
}

void OnTick()
{
   NewM15();
   NewM5();
   NewM1();
   Panel();
}
