#property strict
#property version "5.36"
#include <Trade/Trade.mqh>
CTrade trade;

#define TBUF 4096
#define PIVBUF 16

input double Lots=0.01;
input ulong Magic=260908536;
input int DeviationPoints=30;
input int EmergencySLPoints=0;
input ENUM_TIMEFRAMES MapTF=PERIOD_M5;
input ENUM_TIMEFRAMES TriggerTF=PERIOD_M1;
input int EMAPeriod=8;
input int VWAPResetHour=0;
input bool PreferRealVolume=false;

input int SlowM1Lookback=20;
input int FastM1Lookback=5;
input int LiveVolWindowSeconds=30;
input int LiveVolMinTicks=5;
input double LiveVolWeight=1.0;
input double FastM1Weight=0.60;
input double MinAdaptiveVsSlow=0.45;
input double MaxAdaptiveVsSlow=3.0;
input int M5RangeLookback=12;

// STRUCTURE ENTRY BRAIN
// BUY: Low -> High -> Higher Low -> Break High -> First pullback -> Resume
// SELL: High -> Low -> Lower High -> Break Low -> First pullback -> Resume
input int PivotWingM1=2;
input double MinStructureImpulseM5Ranges=1.00;
input double MinHigherLowLowerHighM5Ranges=0.10;
input double MinStructurePullbackFraction=0.20;
input double MaxStructurePullbackFraction=0.75;
input double StructureBreakBufferM5Ranges=0.10;
input double MinBreakVWAPDistanceM5Ranges=0.20;
input int StructureArmExpiryMinutes=20;

input double MinPostBreakPullbackM5Ranges=0.25;
input double StructureResumeM5Ranges=0.15;
input double MaxEntryRiskM5Ranges=1.50;
input double YoungStructureInvalidationBufferM5Ranges=0.05;

// Mountain management
input double RunnerActivateM5Ranges=1.50;
input int EMAExitWrongCloses=3;
input double EMAClearBreakM5RangeFrac=0.60;

input double CommissionPerLotRT=58.0;
input double CostSafetyMultiple=1.25;
input int ExpectedSlippagePoints=0;
input int PanelUpdateMilliseconds=500;
input bool VerboseLog=true;

int emaHandle=INVALID_HANDLE;
datetime lastM1=0,lastM5=0;
double slowM1=0,fastM1=0,avgM5=0;
long tickTime[TBUF];
double tickBid[TBUF];
int tickHead=0,tickStored=0;
double liveTickRange=0,adaptiveRange=0;
datetime vwapSessionStart=0;
double vwapPV=0,vwapVol=0,liveVWAP=0;
bool haveVWAP=false;

double mfe=0;
bool runnerLocked=false;
int emaWrongCloses=0;
string runnerHealth="FLAT",lastAction="WAITING FOR STRUCTURE";
double lastFrictionDistance=0,lastRTCostMoney=0;
ulong lastPanelMs=0;

int pivotType[PIVBUF];
double pivotPrice[PIVBUF];
datetime pivotTime[PIVBUF];
int pivotCount=0;

bool structureArmed=false;
int structureDir=0;
datetime structureArmTime=0;
datetime structureKeyTime=0;
datetime lastConsumedStructureKey=0;
double structureBreakLevel=0;
double structureProtectLevel=0;
double structureBaseM5=0;
double postBreakExtreme=0;
bool firstPullbackSeen=false;
double firstPullbackExtreme=0;
int structuresArmed=0;
int structuresInvalidated=0;
int structureEntries=0;

double youngProtectLevel=0;
double entryBaseM5=0;

void Log(string s){if(VerboseLog)Print("[V5.36-SC] ",s);}

datetime SessionStart(datetime when)
{
   MqlDateTime dt;TimeToStruct(when,dt);int oh=dt.hour;
   dt.hour=VWAPResetHour;dt.min=0;dt.sec=0;
   datetime s=StructToTime(dt);if(oh<VWAPResetHour)s-=86400;return s;
}

bool GetBar(ENUM_TIMEFRAMES tf,int shift,MqlRates &bar)
{
   MqlRates a[1];if(CopyRates(_Symbol,tf,shift,1,a)!=1)return false;bar=a[0];return true;
}

double BarVol(const MqlRates &b)
{
   if(PreferRealVolume&&b.real_volume>0)return(double)b.real_volume;
   return(double)b.tick_volume;
}

bool AvgRange(ENUM_TIMEFRAMES tf,int startShift,int count,double &out)
{
   count=MathMax(2,count);MqlRates r[];int n=CopyRates(_Symbol,tf,startShift,count,r);if(n!=count)return false;
   double sum=0;int valid=0;
   for(int i=0;i<n;i++){double x=r[i].high-r[i].low;if(x>0){sum+=x;valid++;}}
   if(valid==0)return false;out=sum/valid;return true;
}

double NormVol(double req)
{
   double minv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),maxv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0)step=minv;double v=MathMax(minv,MathMin(maxv,req));
   if(step>0)v=MathFloor((v-minv+1e-12)/step)*step+minv;
   int d=2;if(step>0){double lg=-MathLog10(step);d=(lg>0?(int)MathCeil(lg):0);d=MathMin(8,MathMax(0,d));}
   return NormalizeDouble(v,d);
}

void RecordTick(const MqlTick &t)
{
   tickTime[tickHead]=t.time_msc;tickBid[tickHead]=t.bid;tickHead++;if(tickHead>=TBUF)tickHead=0;if(tickStored<TBUF)tickStored++;
}

bool LiveRange(long now,double &range,int &samples)
{
   range=0;samples=0;if(tickStored<=0)return false;long cutoff=(long)MathMax(1,LiveVolWindowSeconds)*1000;
   double hi=-1e100,lo=1e100;
   for(int k=0;k<tickStored;k++){
      int idx=tickHead-1-k;while(idx<0)idx+=TBUF;long age=now-tickTime[idx];if(age<0)continue;if(age>cutoff)break;
      double p=tickBid[idx];if(p>hi)hi=p;if(p<lo)lo=p;samples++;
   }
   if(samples<MathMax(2,LiveVolMinTicks))return false;range=MathMax(0.0,hi-lo);return true;
}

void RefreshRanges()
{
   double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;
}

double Adaptive(long now)
{
   double base=0;
   if(slowM1>0&&fastM1>0){double wf=MathMax(0.0,MathMin(1.0,FastM1Weight));base=slowM1*(1.0-wf)+fastM1*wf;}
   else if(fastM1>0)base=fastM1;else base=slowM1;
   double lr=0;int s=0;
   if(LiveRange(now,lr,s)){liveTickRange=lr;base=MathMax(base,lr*MathMax(0.0,LiveVolWeight));}else liveTickRange=0;
   if(slowM1>0){double mn=slowM1*MathMax(0.05,MinAdaptiveVsSlow),mx=slowM1*MathMax(MinAdaptiveVsSlow,MaxAdaptiveVsSlow);base=MathMax(mn,MathMin(mx,base));}
   adaptiveRange=base;return base;
}

bool RebuildVWAP()
{
   datetime cur=iTime(_Symbol,MapTF,0);if(cur<=0)return false;datetime ss=SessionStart(cur);
   vwapSessionStart=ss;vwapPV=0;vwapVol=0;if(cur<=ss)return true;
   MqlRates b[];int n=CopyRates(_Symbol,MapTF,ss,cur-1,b);if(n<=0)return true;
   for(int i=0;i<n;i++){double vol=BarVol(b[i]);if(vol<=0)continue;double hlc3=(b[i].high+b[i].low+b[i].close)/3.0;vwapPV+=hlc3*vol;vwapVol+=vol;}
   return true;
}

bool UpdateVWAP()
{
   MqlRates cur;if(!GetBar(MapTF,0,cur)){haveVWAP=false;return false;}
   datetime ss=SessionStart(cur.time);if(vwapSessionStart!=ss&&!RebuildVWAP()){haveVWAP=false;return false;}
   double pv=vwapPV,vv=vwapVol,vol=BarVol(cur);
   if(vol>0){double hlc3=(cur.high+cur.low+cur.close)/3.0;pv+=hlc3*vol;vv+=vol;}
   if(vv<=0){haveVWAP=false;return false;}liveVWAP=pv/vv;haveVWAP=true;return true;
}

bool GetEMA(int shift,double &ema)
{
   if(emaHandle==INVALID_HANDLE)return false;double a[1];if(CopyBuffer(emaHandle,0,shift,1,a)!=1)return false;if(a[0]==EMPTY_VALUE)return false;ema=a[0];return true;
}

bool FindPos(ulong &ticket,ENUM_POSITION_TYPE &type,double &open,double &profit)
{
   for(int i=PositionsTotal()-1;i>=0;i--){
      ulong t=PositionGetTicket(i);if(t==0||!PositionSelectByTicket(t))continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol)continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic)continue;
      ticket=t;type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);open=PositionGetDouble(POSITION_PRICE_OPEN);profit=PositionGetDouble(POSITION_PROFIT);return true;
   }
   return false;
}

bool HasPos(){ulong t;ENUM_POSITION_TYPE ty;double o,p;return FindPos(t,ty,o,p);}

double TickValue()
{
   double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);if(v>0)return v;
   double vp=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT),vl=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(vp>0&&vl>0)return(vp+vl)*0.5;return MathMax(vp,vl);
}

double Friction(const MqlTick &t,double lots,double &money)
{
   double spread=MathMax(0.0,t.ask-t.bid),commissionDist=0,spreadMoney=0,commissionMoney=MathMax(0.0,CommissionPerLotRT)*lots;
   double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),tv=TickValue();
   if(ts>0&&tv>0){double mpp=tv/ts;if(mpp>0)commissionDist=MathMax(0.0,CommissionPerLotRT)/mpp;spreadMoney=(spread/ts)*tv*lots;}
   double slip=MathMax(0,ExpectedSlippagePoints)*_Point,slipMoney=0;if(ts>0&&tv>0)slipMoney=(slip/ts)*tv*lots;
   lastFrictionDistance=spread+commissionDist+slip;lastRTCostMoney=spreadMoney+commissionMoney+slipMoney;money=lastRTCostMoney;return lastFrictionDistance;
}

bool TradeOK()
{
   uint rc=trade.ResultRetcode();return rc==TRADE_RETCODE_DONE||rc==TRADE_RETCODE_DONE_PARTIAL||rc==TRADE_RETCODE_PLACED;
}

void ResetStructure()
{
   structureArmed=false;structureDir=0;structureArmTime=0;structureKeyTime=0;structureBreakLevel=0;structureProtectLevel=0;structureBaseM5=0;postBreakExtreme=0;firstPullbackSeen=false;firstPullbackExtreme=0;
}

void ResetRunner()
{
   mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="NEW POSITION - STRUCTURE OWNS YOUNG RISK";
}

void ClearRunner()
{
   mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="FLAT";youngProtectLevel=0;entryBaseM5=0;
}

bool ClosePos(ulong ticket,string reason)
{
   bool ok=trade.PositionClose(ticket);if(!ok||!TradeOK()){Log("CLOSE failed: "+trade.ResultRetcodeDescription());return false;}
   lastAction=reason;Log(reason);ClearRunner();return true;
}

bool IsPivotHigh(int center,int wing,double &price,datetime &when)
{
   MqlRates c;if(!GetBar(TriggerTF,center,c))return false;
   for(int k=1;k<=wing;k++){
      MqlRates a,b;if(!GetBar(TriggerTF,center-k,a)||!GetBar(TriggerTF,center+k,b))return false;
      if(c.high<=a.high||c.high<=b.high)return false;
   }
   price=c.high;when=c.time;return true;
}

bool IsPivotLow(int center,int wing,double &price,datetime &when)
{
   MqlRates c;if(!GetBar(TriggerTF,center,c))return false;
   for(int k=1;k<=wing;k++){
      MqlRates a,b;if(!GetBar(TriggerTF,center-k,a)||!GetBar(TriggerTF,center+k,b))return false;
      if(c.low>=a.low||c.low>=b.low)return false;
   }
   price=c.low;when=c.time;return true;
}

void AppendPivot(int type,double price,datetime when)
{
   if(pivotCount>0&&pivotType[pivotCount-1]==type){
      bool replace=(type>0?price>pivotPrice[pivotCount-1]:price<pivotPrice[pivotCount-1]);
      if(replace){pivotPrice[pivotCount-1]=price;pivotTime[pivotCount-1]=when;}
      return;
   }
   if(pivotCount<PIVBUF){pivotType[pivotCount]=type;pivotPrice[pivotCount]=price;pivotTime[pivotCount]=when;pivotCount++;return;}
   for(int i=1;i<PIVBUF;i++){pivotType[i-1]=pivotType[i];pivotPrice[i-1]=pivotPrice[i];pivotTime[i-1]=pivotTime[i];}
   pivotType[PIVBUF-1]=type;pivotPrice[PIVBUF-1]=price;pivotTime[PIVBUF-1]=when;
}

void DetectNewestPivot()
{
   int wing=MathMax(1,PivotWingM1),center=wing+1;double hp=0,lp=0;datetime ht=0,lt=0;
   bool hi=IsPivotHigh(center,wing,hp,ht),lo=IsPivotLow(center,wing,lp,lt);
   if(hi&&lo){lastAction="AMBIGUOUS PIVOT SKIPPED";return;}
   if(hi)AppendPivot(1,hp,ht);else if(lo)AppendPivot(-1,lp,lt);
}

bool LatestBuyPattern(double &l1,double &h1,double &l2,datetime &key)
{
   if(pivotCount<3)return false;int i=pivotCount-3;
   if(pivotType[i]!=-1||pivotType[i+1]!=1||pivotType[i+2]!=-1)return false;
   l1=pivotPrice[i];h1=pivotPrice[i+1];l2=pivotPrice[i+2];key=pivotTime[i+2];return true;
}

bool LatestSellPattern(double &h1,double &l1,double &h2,datetime &key)
{
   if(pivotCount<3)return false;int i=pivotCount-3;
   if(pivotType[i]!=1||pivotType[i+1]!=-1||pivotType[i+2]!=1)return false;
   h1=pivotPrice[i];l1=pivotPrice[i+1];h2=pivotPrice[i+2];key=pivotTime[i+2];return true;
}

void ArmStructure(int dir,datetime key,double breakLevel,double protectLevel,double base,double breakClose)
{
   ResetStructure();structureArmed=true;structureDir=dir;structureArmTime=TimeCurrent();structureKeyTime=key;lastConsumedStructureKey=key;structureBreakLevel=breakLevel;structureProtectLevel=protectLevel;structureBaseM5=MathMax(base,_Point);postBreakExtreme=breakClose;structuresArmed++;
   lastAction=(dir>0?"BUY":"SELL")+string(" STRUCTURE BOS ARMED | BREAK=")+DoubleToString(breakLevel,_Digits)+" | PROTECT="+DoubleToString(protectLevel,_Digits);Log(lastAction);
}

void EvaluateStructureBreak()
{
   if(HasPos()||structureArmed||!haveVWAP||avgM5<=0)return;
   MqlRates b;if(!GetBar(TriggerTF,1,b))return;
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;double money=0,fr=Friction(t,NormVol(Lots),money);
   double base=MathMax(avgM5,_Point),breakBuffer=MathMax(base*MathMax(0.0,StructureBreakBufferM5Ranges),fr*MathMax(1.0,CostSafetyMultiple));

   double l1=0,h1=0,l2=0;datetime key=0;
   if(LatestBuyPattern(l1,h1,l2,key)&&key!=lastConsumedStructureKey){
      double impulse=h1-l1;
      if(impulse>0){
         double pb=h1-l2,pbf=pb/impulse;
         bool meaningful=impulse>=base*MathMax(0.0,MinStructureImpulseM5Ranges);
         bool higherLow=(l2-l1)>=base*MathMax(0.0,MinHigherLowLowerHighM5Ranges);
         bool pullbackOK=pbf>=MathMax(0.0,MinStructurePullbackFraction)&&pbf<=MathMax(MinStructurePullbackFraction,MaxStructurePullbackFraction);
         bool bos=b.close>=h1+breakBuffer;
         bool vwapSide=b.close>liveVWAP&&((b.close-liveVWAP)/base)>=MathMax(0.0,MinBreakVWAPDistanceM5Ranges);
         if(meaningful&&higherLow&&pullbackOK&&bos&&vwapSide){ArmStructure(1,key,h1,l2,base,b.close);return;}
      }
   }

   double sh1=0,sl1=0,sh2=0;datetime skey=0;
   if(LatestSellPattern(sh1,sl1,sh2,skey)&&skey!=lastConsumedStructureKey){
      double impulse=sh1-sl1;
      if(impulse>0){
         double pb=sh2-sl1,pbf=pb/impulse;
         bool meaningful=impulse>=base*MathMax(0.0,MinStructureImpulseM5Ranges);
         bool lowerHigh=(sh1-sh2)>=base*MathMax(0.0,MinHigherLowLowerHighM5Ranges);
         bool pullbackOK=pbf>=MathMax(0.0,MinStructurePullbackFraction)&&pbf<=MathMax(MinStructurePullbackFraction,MaxStructurePullbackFraction);
         bool bos=b.close<=sl1-breakBuffer;
         bool vwapSide=b.close<liveVWAP&&((liveVWAP-b.close)/base)>=MathMax(0.0,MinBreakVWAPDistanceM5Ranges);
         if(meaningful&&lowerHigh&&pullbackOK&&bos&&vwapSide){ArmStructure(-1,skey,sl1,sh2,base,b.close);return;}
      }
   }
}

bool OpenStructureTrade(int dir)
{
   if(HasPos()||!structureArmed)return false;MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;
   double px=(dir>0?t.ask:t.bid),risk=(dir>0?px-structureProtectLevel:structureProtectLevel-px),base=MathMax(structureBaseM5,_Point);
   if(risk<=0||risk>base*MathMax(0.1,MaxEntryRiskM5Ranges)){
      lastAction="STRUCTURE ENTRY REJECTED - RISK "+DoubleToString(risk/base,2)+"R";Log(lastAction);structuresInvalidated++;ResetStructure();return false;
   }
   double lots=NormVol(Lots),sl=0;string comment=(dir>0?"V536_STRUCT_BUY":"V536_STRUCT_SELL");
   if(dir>0){if(EmergencySLPoints>0)sl=NormalizeDouble(t.ask-EmergencySLPoints*_Point,_Digits);if(!trade.Buy(lots,_Symbol,0,sl,0,comment)||!TradeOK()){Log("BUY failed: "+trade.ResultRetcodeDescription());return false;}}
   else{if(EmergencySLPoints>0)sl=NormalizeDouble(t.bid+EmergencySLPoints*_Point,_Digits);if(!trade.Sell(lots,_Symbol,0,sl,0,comment)||!TradeOK()){Log("SELL failed: "+trade.ResultRetcodeDescription());return false;}}
   youngProtectLevel=structureProtectLevel;entryBaseM5=structureBaseM5;structureEntries++;
   lastAction=(dir>0?"BUY":"SELL")+string(" STRUCTURE CONTINUATION OPENED | risk=")+DoubleToString(risk/base,2)+"R";Log(lastAction);ResetStructure();ResetRunner();return true;
}

void ProcessArmedStructure(const MqlTick &t)
{
   if(!structureArmed||HasPos())return;
   if(StructureArmExpiryMinutes>0&&TimeCurrent()-structureArmTime>StructureArmExpiryMinutes*60){lastAction="STRUCTURE EXPIRED - NO FIRST PULLBACK";structuresInvalidated++;ResetStructure();return;}
   double base=MathMax(structureBaseM5,_Point),px=(structureDir>0?t.bid:t.ask),invalidBuffer=base*MathMax(0.0,YoungStructureInvalidationBufferM5Ranges);

   if(structureDir>0){
      if(px<=structureProtectLevel-invalidBuffer){lastAction="BUY STRUCTURE INVALIDATED BEFORE ENTRY";structuresInvalidated++;ResetStructure();return;}
      if(px>postBreakExtreme)postBreakExtreme=px;
      if(!firstPullbackSeen&&postBreakExtreme-px>=base*MathMax(0.0,MinPostBreakPullbackM5Ranges)){
         firstPullbackSeen=true;firstPullbackExtreme=px;lastAction="BUY FIRST POST-BOS PULLBACK";Log(lastAction);
      }
      if(firstPullbackSeen){
         if(px<firstPullbackExtreme)firstPullbackExtreme=px;
         double resume=base*MathMax(0.0,StructureResumeM5Ranges);
         bool resumed=px>=firstPullbackExtreme+resume;
         bool holdsBreak=px>=structureBreakLevel;
         bool vwapOK=px>liveVWAP;
         if(resumed&&holdsBreak&&vwapOK){OpenStructureTrade(1);return;}
      }
   }else{
      if(px>=structureProtectLevel+invalidBuffer){lastAction="SELL STRUCTURE INVALIDATED BEFORE ENTRY";structuresInvalidated++;ResetStructure();return;}
      if(postBreakExtreme==0||px<postBreakExtreme)postBreakExtreme=px;
      if(!firstPullbackSeen&&px-postBreakExtreme>=base*MathMax(0.0,MinPostBreakPullbackM5Ranges)){
         firstPullbackSeen=true;firstPullbackExtreme=px;lastAction="SELL FIRST POST-BOS PULLBACK";Log(lastAction);
      }
      if(firstPullbackSeen){
         if(px>firstPullbackExtreme)firstPullbackExtreme=px;
         double resume=base*MathMax(0.0,StructureResumeM5Ranges);
         bool resumed=px<=firstPullbackExtreme-resume;
         bool holdsBreak=px<=structureBreakLevel;
         bool vwapOK=px<liveVWAP;
         if(resumed&&holdsBreak&&vwapOK){OpenStructureTrade(-1);return;}
      }
   }
}

void UpdateRunner(const MqlTick &t)
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){mfe=0;runnerLocked=false;return;}
   double px=(ty==POSITION_TYPE_BUY?t.bid:t.ask),favorable=(ty==POSITION_TYPE_BUY?px-op:op-px);if(favorable>mfe)mfe=favorable;
   if(!runnerLocked&&avgM5>0&&mfe>=avgM5*MathMax(0.5,RunnerActivateM5Ranges)){
      runnerLocked=true;emaWrongCloses=0;youngProtectLevel=0;runnerHealth="MOUNTAIN LOCKED - EMA8 OWNS EXIT";lastAction="RUNNER LOCKED";Log("RUNNER LOCKED | STRUCTURE INVALIDATION DISARMED");
   }
}

bool ManageYoungStructureInvalidation(const MqlTick &t)
{
   if(runnerLocked||youngProtectLevel<=0)return false;ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return false;
   double base=MathMax(entryBaseM5,_Point),buf=base*MathMax(0.0,YoungStructureInvalidationBufferM5Ranges);
   bool invalid=(ty==POSITION_TYPE_BUY?t.bid<=youngProtectLevel-buf:t.ask>=youngProtectLevel+buf);
   if(!invalid)return false;
   string why=(ty==POSITION_TYPE_BUY?"YOUNG BUY":"YOUNG SELL")+string(" STRUCTURE INVALIDATED | protect=")+DoubleToString(youngProtectLevel,_Digits);
   return ClosePos(tk,why);
}

void ReviewEMA()
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){emaWrongCloses=0;runnerHealth="FLAT";return;}
   if(!runnerLocked){emaWrongCloses=0;runnerHealth="YOUNG - STRUCTURE OWNS RISK";return;}
   MqlRates b;double ema=0;if(!GetBar(MapTF,1,b)||!GetEMA(1,ema))return;
   bool wrong=false;double depth=0;
   if(ty==POSITION_TYPE_BUY){wrong=b.close<ema;if(wrong)depth=ema-b.close;}else{wrong=b.close>ema;if(wrong)depth=b.close-ema;}
   if(!wrong){emaWrongCloses=0;runnerHealth="EMA8 RESPECTED - HOLD MOUNTAIN";return;}
   emaWrongCloses++;double frac=(avgM5>0?depth/avgM5:0);
   bool clearBreak=frac>=MathMax(0.0,EMAClearBreakM5RangeFrac),repeated=emaWrongCloses>=MathMax(1,EMAExitWrongCloses);
   if(clearBreak||repeated){
      string why=clearBreak?"EMA8 EXIT - DEEP "+DoubleToString(EMAClearBreakM5RangeFrac,2)+"x M5 LOSS":"EMA8 EXIT - "+IntegerToString(EMAExitWrongCloses)+" WRONG M5 CLOSES";
      if(ClosePos(tk,why)){lastAction=why+" | FLAT";Log("MATURE EXIT -> WAIT NEW STRUCTURE");}return;
   }
   runnerHealth="EMA8 BREATHING - HOLD | wrong closes="+IntegerToString(emaWrongCloses)+"/"+IntegerToString(EMAExitWrongCloses)+" | depth="+DoubleToString(frac,2)+"R";
}

void NewM1()
{
   datetime c=iTime(_Symbol,TriggerTF,0);if(c<=0||c==lastM1)return;lastM1=c;
   double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;
   DetectNewestPivot();EvaluateStructureBreak();
}

void NewM5()
{
   datetime c=iTime(_Symbol,MapTF,0);if(c<=0||c==lastM5)return;lastM5=c;RebuildVWAP();double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;ReviewEMA();
}

string PivotSummary()
{
   string s="";int start=MathMax(0,pivotCount-5);
   for(int i=start;i<pivotCount;i++)s+=(pivotType[i]>0?"H":"L")+DoubleToString(pivotPrice[i],0)+(i<pivotCount-1?" > ":"");
   return s;
}

void Panel(const MqlTick &t)
{
   ulong now=GetTickCount64();if(lastPanelMs>0&&now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))return;lastPanelMs=now;
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;string pos="NONE";if(FindPos(tk,ty,op,pf))pos=(ty==POSITION_TYPE_BUY?"BUY":"SELL")+string(runnerLocked?" | MOUNTAIN LOCK":" | YOUNG STRUCTURE");
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money);
   string arm=(structureArmed?(structureDir>0?"BUY BOS":"SELL BOS"):"NONE");
   Comment("VWAP + EMA8 MOUNTAIN RUNNER v5.36 STRUCTURE CONTINUATION\n",
           "POSITION: ",pos,"\nVWAP: ",(haveVWAP?DoubleToString(liveVWAP,_Digits):"n/a"),"\nPIVOTS: ",PivotSummary(),
           "\nARM: ",arm," | BREAK: ",DoubleToString(structureBreakLevel,_Digits)," | PROTECT: ",DoubleToString(structureProtectLevel,_Digits),
           "\nFIRST PULLBACK: ",(firstPullbackSeen?"YES":"NO")," | ARMED: ",IntegerToString(structuresArmed)," | INVALID: ",IntegerToString(structuresInvalidated)," | ENTRIES: ",IntegerToString(structureEntries),
           "\nRUNNER: ",runnerHealth," | MFE: ",DoubleToString(mfe,2)," | M5 RANGE: ",DoubleToString(avgM5,2),
           "\nEMA WRONG: ",IntegerToString(emaWrongCloses),"/",IntegerToString(EMAExitWrongCloses)," | DEEP EXIT: ",DoubleToString(EMAClearBreakM5RangeFrac,2),"R",
           "\nYOUNG PROTECT: ",DoubleToString(youngProtectLevel,_Digits),"\nADAPTIVE RANGE: ",DoubleToString(Adaptive(t.time_msc),2),
           "\nEST RT COST: ",DoubleToString(money,4)," | FRICTION: ",DoubleToString(fr,2),"\nLAST: ",lastAction);
}

int OnInit()
{
   if(MapTF!=PERIOD_M5||TriggerTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;
   if(PivotWingM1<1||PivotWingM1>5)return INIT_PARAMETERS_INCORRECT;
   emaHandle=iMA(_Symbol,MapTF,EMAPeriod,0,MODE_EMA,PRICE_CLOSE);if(emaHandle==INVALID_HANDLE)return INIT_FAILED;
   trade.SetExpertMagicNumber(Magic);trade.SetDeviationInPoints(DeviationPoints);trade.SetTypeFillingBySymbol(_Symbol);trade.SetAsyncMode(false);
   RefreshRanges();RebuildVWAP();MqlTick t;if(SymbolInfoTick(_Symbol,t)){RecordTick(t);UpdateVWAP();Adaptive(t.time_msc);}ResetStructure();ClearRunner();
   Log("INIT V5.36 STRUCTURE CONTINUATION | legacy flat VWAP entry REMOVED in this experiment");
   Log("BUY = L-H-HL + meaningful impulse + close BOS above H + above VWAP + FIRST post-BOS pullback + resume");
   Log("SELL = H-L-LH + meaningful impulse + close BOS below L + below VWAP + FIRST post-BOS pullback + resume");
   Log("YOUNG = structure invalidation | MATURE = EMA8 mountain hold");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Log("DEINIT V5.36 | armed="+IntegerToString(structuresArmed)+" | invalid="+IntegerToString(structuresInvalidated)+" | entries="+IntegerToString(structureEntries));
   if(emaHandle!=INVALID_HANDLE)IndicatorRelease(emaHandle);Comment("");
}

void OnTick()
{
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;RecordTick(t);
   NewM5();if(!UpdateVWAP())return;NewM1();UpdateRunner(t);
   if(HasPos()){
      if(ManageYoungStructureInvalidation(t)){Panel(t);return;}
      Panel(t);return;
   }
   ProcessArmedStructure(t);Panel(t);
}
