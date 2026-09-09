#property strict
#property version "5.35"
#include <Trade/Trade.mqh>
CTrade trade;

#define TBUF 4096

enum SetupState { IDLE=0, BUY_DEP, BUY_RET, SELL_DEP, SELL_RET };

enum EntryPath { PATH_NONE=0, PATH_VWAP_RETEST, PATH_CONTINUATION };

input double Lots=0.01;
input ulong Magic=260908535;
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

// V5.35 REGIME BRAIN
// No flat-market entry is allowed until completed M1 price action proves
// directional expansion. This is scale-free movement efficiency plus
// meaningful net travel measured against M5 range.
input int EfficiencyLookbackM1=8;
input double MinMovementEfficiency=0.62;
input double MinExpansionNetM5Ranges=1.00;
input double MinExpansionVWAPDistanceM5Ranges=0.50;
input int ExpansionArmExpiryMinutes=30;

// ENTRY PATH A: original VWAP retest/reclaim after expansion is already proven.
input double RetestBandAdaptiveFrac=0.25;
input double ReclaimAdaptiveFrac=0.18;
input double VWAPWrongDepthAdaptiveFrac=0.18;
input int VWAPWrongSideSeconds=20;
input int RetestTimeoutMinutes=10;

// ENTRY PATH B: mountain continuation. If expansion runs away from VWAP,
// take the first controlled pullback toward M5 EMA8, then resume with trend.
input bool ContinuationEnabled=true;
input double ContinuationPullbackM5Ranges=0.35;
input double ContinuationEMAProximityM5Ranges=0.50;
input double ContinuationResumeM5Ranges=0.20;

// Runner maturity and mountain hold.
input double RunnerActivateM5Ranges=1.50;
input int EMAExitWrongCloses=3;
input double EMAClearBreakM5RangeFrac=0.60;

// Young zombie protection. Completely disabled after Mountain Lock.
input bool ZombieGuardEnabled=true;
input int ZombieMinAgeSeconds=1800;
input double ZombieMaxMFERanges=0.75;
input double ZombieMinMAERanges=0.75;
input double ZombieMaxNetProgressRanges=0.10;

// Original V5.31 young-failure logic is retained ONLY as an exit mechanism.
// It never opens a new trade in V5.35.
input double YoungFailDepartureAdaptiveFrac=0.60;
input double YoungFailRetestBandAdaptiveFrac=0.25;
input double YoungFailReclaimAdaptiveFrac=0.18;
input double YoungFailWrongDepthAdaptiveFrac=0.18;
input int YoungFailWrongSideSeconds=20;
input int YoungFailRetestTimeoutMinutes=10;

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
string runnerHealth="FLAT",lastAction="Waiting";
double lastFrictionDistance=0,lastRTCostMoney=0;
ulong lastPanelMs=0;

datetime youngEntryTime=0;
double youngEntryM5Range=0;
double youngMAE=0;
int zombieCuts=0;

// Expansion-entry brain.
bool expansionArmed=false;
int expansionDir=0; // +1 buy, -1 sell
datetime expansionArmTime=0;
double expansionBaseM5=0;
double expansionExtreme=0;
double expansionEfficiency=0;
double expansionNetR=0;
double expansionVWAPR=0;
bool vwapRetestSeen=false;
datetime vwapRetestStart=0;
datetime vwapWrongSideSince=0;
double vwapRetestExtreme=0;
bool continuationPullbackSeen=false;
double continuationPullbackExtreme=0;
int expansionArms=0;
int continuationEntries=0;
int vwapRetestEntries=0;
int regimeRejects=0;
datetime lastRegimeRejectBar=0;

// Separate state machine used ONLY to close a young trade when a complete
// opposite VWAP setup forms, preserving V5.31 young-failure behavior.
SetupState failState=IDLE;
datetime failRetestStart=0,failWrongSideSince=0;
double failRetestExtreme=0;

void Log(string s){if(VerboseLog)Print("[V5.35-EC] ",s);}

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
   if(PreferRealVolume&&b.real_volume>0)return(double)b.real_volume;return(double)b.tick_volume;
}

bool AvgRange(ENUM_TIMEFRAMES tf,int startShift,int count,double &out)
{
   count=MathMax(2,count);MqlRates r[];int n=CopyRates(_Symbol,tf,startShift,count,r);if(n!=count)return false;
   double sum=0;int valid=0;for(int i=0;i<n;i++){double x=r[i].high-r[i].low;if(x>0){sum+=x;valid++;}}
   if(valid==0)return false;out=sum/valid;return true;
}

double NormVol(double req)
{
   double minv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),maxv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0)step=minv;double v=MathMax(minv,MathMin(maxv,req));if(step>0)v=MathFloor((v-minv+1e-12)/step)*step+minv;
   int d=2;if(step>0){double lg=-MathLog10(step);d=(lg>0?(int)MathCeil(lg):0);d=MathMin(8,MathMax(0,d));}return NormalizeDouble(v,d);
}

void RecordTick(const MqlTick &t)
{
   tickTime[tickHead]=t.time_msc;tickBid[tickHead]=t.bid;tickHead++;if(tickHead>=TBUF)tickHead=0;if(tickStored<TBUF)tickStored++;
}

bool LiveRange(long now,double &range,int &samples)
{
   range=0;samples=0;if(tickStored<=0)return false;long cutoff=(long)MathMax(1,LiveVolWindowSeconds)*1000;double hi=-1e100,lo=1e100;
   for(int k=0;k<tickStored;k++){int idx=tickHead-1-k;while(idx<0)idx+=TBUF;long age=now-tickTime[idx];if(age<0)continue;if(age>cutoff)break;double p=tickBid[idx];if(p>hi)hi=p;if(p<lo)lo=p;samples++;}
   if(samples<MathMax(2,LiveVolMinTicks))return false;range=MathMax(0.0,hi-lo);return true;
}

void RefreshRanges()
{
   double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;
}

double Adaptive(long now)
{
   double base=0;if(slowM1>0&&fastM1>0){double wf=MathMax(0.0,MathMin(1.0,FastM1Weight));base=slowM1*(1.0-wf)+fastM1*wf;}else if(fastM1>0)base=fastM1;else base=slowM1;
   double lr=0;int s=0;if(LiveRange(now,lr,s)){liveTickRange=lr;base=MathMax(base,lr*MathMax(0.0,LiveVolWeight));}else liveTickRange=0;
   if(slowM1>0){double mn=slowM1*MathMax(0.05,MinAdaptiveVsSlow),mx=slowM1*MathMax(MinAdaptiveVsSlow,MaxAdaptiveVsSlow);base=MathMax(mn,MathMin(mx,base));}
   adaptiveRange=base;return base;
}

bool RebuildVWAP()
{
   datetime cur=iTime(_Symbol,MapTF,0);if(cur<=0)return false;datetime ss=SessionStart(cur);vwapSessionStart=ss;vwapPV=0;vwapVol=0;if(cur<=ss)return true;
   MqlRates b[];int n=CopyRates(_Symbol,MapTF,ss,cur-1,b);if(n<=0)return true;
   for(int i=0;i<n;i++){double vol=BarVol(b[i]);if(vol<=0)continue;double hlc3=(b[i].high+b[i].low+b[i].close)/3.0;vwapPV+=hlc3*vol;vwapVol+=vol;}return true;
}

bool UpdateVWAP()
{
   MqlRates cur;if(!GetBar(MapTF,0,cur)){haveVWAP=false;return false;}datetime ss=SessionStart(cur.time);if(vwapSessionStart!=ss&&!RebuildVWAP()){haveVWAP=false;return false;}
   double pv=vwapPV,vv=vwapVol,vol=BarVol(cur);if(vol>0){double hlc3=(cur.high+cur.low+cur.close)/3.0;pv+=hlc3*vol;vv+=vol;}if(vv<=0){haveVWAP=false;return false;}liveVWAP=pv/vv;haveVWAP=true;return true;
}

bool GetEMA(int shift,double &ema)
{
   if(emaHandle==INVALID_HANDLE)return false;double a[1];if(CopyBuffer(emaHandle,0,shift,1,a)!=1)return false;if(a[0]==EMPTY_VALUE)return false;ema=a[0];return true;
}

bool FindPos(ulong &ticket,ENUM_POSITION_TYPE &type,double &open,double &profit)
{
   for(int i=PositionsTotal()-1;i>=0;i--){ulong t=PositionGetTicket(i);if(t==0||!PositionSelectByTicket(t))continue;if(PositionGetString(POSITION_SYMBOL)!=_Symbol)continue;if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic)continue;ticket=t;type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);open=PositionGetDouble(POSITION_PRICE_OPEN);profit=PositionGetDouble(POSITION_PROFIT);return true;}return false;
}

bool HasPos(){ulong t;ENUM_POSITION_TYPE ty;double o,p;return FindPos(t,ty,o,p);}

double TickValue(){double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);if(v>0)return v;double vp=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT),vl=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);if(vp>0&&vl>0)return(vp+vl)*0.5;return MathMax(vp,vl);}

double Friction(const MqlTick &t,double lots,double &money)
{
   double spread=MathMax(0.0,t.ask-t.bid),commissionDist=0,spreadMoney=0,commissionMoney=MathMax(0.0,CommissionPerLotRT)*lots;
   double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),tv=TickValue();if(ts>0&&tv>0){double mpp=tv/ts;if(mpp>0)commissionDist=MathMax(0.0,CommissionPerLotRT)/mpp;spreadMoney=(spread/ts)*tv*lots;}
   double slip=MathMax(0,ExpectedSlippagePoints)*_Point,slipMoney=0;if(ts>0&&tv>0)slipMoney=(slip/ts)*tv*lots;lastFrictionDistance=spread+commissionDist+slip;lastRTCostMoney=spreadMoney+commissionMoney+slipMoney;money=lastRTCostMoney;return lastFrictionDistance;
}

bool TradeOK(){uint rc=trade.ResultRetcode();return rc==TRADE_RETCODE_DONE||rc==TRADE_RETCODE_DONE_PARTIAL||rc==TRADE_RETCODE_PLACED;}

void ResetFailState(){failState=IDLE;failRetestStart=0;failWrongSideSince=0;failRetestExtreme=0;}

void ResetExpansion()
{
   expansionArmed=false;expansionDir=0;expansionArmTime=0;expansionBaseM5=0;expansionExtreme=0;expansionEfficiency=0;expansionNetR=0;expansionVWAPR=0;
   vwapRetestSeen=false;vwapRetestStart=0;vwapWrongSideSince=0;vwapRetestExtreme=0;continuationPullbackSeen=false;continuationPullbackExtreme=0;
}

void ResetRunner()
{
   mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="NEW POSITION - BUILDING";youngEntryTime=TimeCurrent();youngEntryM5Range=(avgM5>0?avgM5:0);youngMAE=0;ResetFailState();
}

void ClearRunner()
{
   mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="FLAT";youngEntryTime=0;youngEntryM5Range=0;youngMAE=0;ResetFailState();
}

bool MovementEfficiency(double &eff,double &netSigned,double &path,int &dir)
{
   int look=MathMax(3,EfficiencyLookbackM1);MqlRates r[];int n=CopyRates(_Symbol,TriggerTF,1,look+1,r);if(n!=look+1)return false;
   path=0;for(int i=1;i<n;i++)path+=MathAbs(r[i].close-r[i-1].close);netSigned=r[n-1].close-r[0].close;
   if(path<=0){eff=0;dir=0;return true;}eff=MathAbs(netSigned)/path;dir=(netSigned>0?1:(netSigned<0?-1:0));return true;
}

void NoteRegimeReject(string why)
{
   datetime b=iTime(_Symbol,TriggerTF,0);if(b!=lastRegimeRejectBar){lastRegimeRejectBar=b;regimeRejects++;Log("REGIME REJECT | "+why);}lastAction="REGIME REJECT | "+why;
}

void ArmExpansion(int dir,double eff,double netR,double vwapR,double px)
{
   ResetExpansion();expansionArmed=true;expansionDir=dir;expansionArmTime=TimeCurrent();expansionBaseM5=MathMax(avgM5,_Point);expansionExtreme=px;expansionEfficiency=eff;expansionNetR=netR;expansionVWAPR=vwapR;expansionArms++;
   lastAction=(dir>0?"BUY":"SELL")+string(" EXPANSION ARMED | Eff=")+DoubleToString(eff,2)+" | Net="+DoubleToString(netR,2)+"R | VWAP="+DoubleToString(vwapR,2)+"R";Log(lastAction);
}

void DetectExpansion()
{
   if(!haveVWAP||HasPos())return;
   double eff=0,net=0,path=0;int dir=0;if(!MovementEfficiency(eff,net,path,dir)||dir==0||avgM5<=0)return;
   MqlRates b;if(!GetBar(TriggerTF,1,b))return;double base=MathMax(avgM5,_Point);double netR=MathAbs(net)/base;double vwapR=MathAbs(b.close-liveVWAP)/base;
   bool sideAligned=(dir>0?b.close>liveVWAP:b.close<liveVWAP);
   if(eff<MinMovementEfficiency){if(!expansionArmed)NoteRegimeReject("EFF "+DoubleToString(eff,2)+" < "+DoubleToString(MinMovementEfficiency,2));return;}
   if(netR<MinExpansionNetM5Ranges){if(!expansionArmed)NoteRegimeReject("NET "+DoubleToString(netR,2)+"R < "+DoubleToString(MinExpansionNetM5Ranges,2));return;}
   if(vwapR<MinExpansionVWAPDistanceM5Ranges){if(!expansionArmed)NoteRegimeReject("VWAP DIST "+DoubleToString(vwapR,2)+"R < "+DoubleToString(MinExpansionVWAPDistanceM5Ranges,2));return;}
   if(!sideAligned){if(!expansionArmed)NoteRegimeReject("NET DIRECTION NOT ALIGNED WITH VWAP SIDE");return;}
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;double px=(dir>0?t.bid:t.ask);
   if(!expansionArmed||expansionDir!=dir)ArmExpansion(dir,eff,netR,vwapR,px);
}

bool OpenTrade(int dir,EntryPath path)
{
   if(HasPos())return false;MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double lots=NormVol(Lots),sl=0;string comment;
   if(dir>0){if(EmergencySLPoints>0)sl=NormalizeDouble(t.ask-EmergencySLPoints*_Point,_Digits);comment=(path==PATH_CONTINUATION?"V535_CONT_BUY":"V535_VWAP_BUY");if(!trade.Buy(lots,_Symbol,0,sl,0,comment)||!TradeOK()){Log("BUY failed: "+trade.ResultRetcodeDescription());return false;}}
   else{if(EmergencySLPoints>0)sl=NormalizeDouble(t.bid+EmergencySLPoints*_Point,_Digits);comment=(path==PATH_CONTINUATION?"V535_CONT_SELL":"V535_VWAP_SELL");if(!trade.Sell(lots,_Symbol,0,sl,0,comment)||!TradeOK()){Log("SELL failed: "+trade.ResultRetcodeDescription());return false;}}
   if(path==PATH_CONTINUATION)continuationEntries++;else if(path==PATH_VWAP_RETEST)vwapRetestEntries++;
   string tag=(path==PATH_CONTINUATION?"MOUNTAIN CONTINUATION":"VWAP RETEST");lastAction=(dir>0?"BUY":"SELL")+string(" OPENED | ")+tag;Log(lastAction);ResetExpansion();ResetRunner();return true;
}

bool ClosePos(ulong ticket,string reason)
{
   bool ok=trade.PositionClose(ticket);if(!ok||!TradeOK()){Log("CLOSE failed: "+trade.ResultRetcodeDescription());return false;}lastAction=reason;Log(reason);ResetExpansion();ClearRunner();return true;
}

void UpdateRunner(const MqlTick &t)
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){ClearRunner();return;}double px=(ty==POSITION_TYPE_BUY?t.bid:t.ask);double favorable=(ty==POSITION_TYPE_BUY?px-op:op-px),adverse=(ty==POSITION_TYPE_BUY?op-px:px-op);
   if(favorable>mfe)mfe=favorable;if(adverse>youngMAE)youngMAE=adverse;
   if(!runnerLocked&&avgM5>0&&mfe>=avgM5*MathMax(0.5,RunnerActivateM5Ranges)){runnerLocked=true;emaWrongCloses=0;ResetFailState();runnerHealth="MOUNTAIN LOCKED - EMA8 OWNS EXIT";lastAction="RUNNER LOCKED";Log("RUNNER LOCKED at "+DoubleToString(RunnerActivateM5Ranges,2)+"x M5 | young guards DISARMED");}
}

bool CheckZombieGuard(const MqlTick &t)
{
   if(!ZombieGuardEnabled||runnerLocked)return false;ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return false;if(youngEntryTime<=0||youngEntryM5Range<=0)return false;
   int age=(int)MathMax(0,(long)(TimeCurrent()-youngEntryTime));if(age<MathMax(1,ZombieMinAgeSeconds))return false;double px=(ty==POSITION_TYPE_BUY?t.bid:t.ask),net=(ty==POSITION_TYPE_BUY?px-op:op-px),base=MathMax(youngEntryM5Range,_Point);
   double mfeR=mfe/base,maeR=youngMAE/base,netR=net/base;bool stale=mfeR<=MathMax(0.0,ZombieMaxMFERanges),hurt=maeR>=MathMax(0.0,ZombieMinMAERanges),notProgressing=netR<=ZombieMaxNetProgressRanges;
   if(!(stale&&hurt&&notProgressing))return false;string reason="ZOMBIE GUARD EXIT | age="+IntegerToString(age)+"s | MFE="+DoubleToString(mfeR,2)+"R | MAE="+DoubleToString(maeR,2)+"R | NET="+DoubleToString(netR,2)+"R";
   if(!ClosePos(tk,reason))return false;zombieCuts++;return true;
}

void ProcessYoungOppositeVWAP(const MqlTick &t)
{
   if(runnerLocked||!haveVWAP)return;ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){ResetFailState();return;}
   double ad=Adaptive(t.time_msc);if(ad<=0)return;double price=t.bid,vwap=liveVWAP;
   double dep=ad*MathMax(0.0,YoungFailDepartureAdaptiveFrac),band=ad*MathMax(0.0,YoungFailRetestBandAdaptiveFrac),rec=ad*MathMax(0.0,YoungFailReclaimAdaptiveFrac),wrong=ad*MathMax(0.0,YoungFailWrongDepthAdaptiveFrac);
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money),floor=fr*MathMax(1.0,CostSafetyMultiple);dep=MathMax(dep,floor);rec=MathMax(rec,floor);

   if(ty==POSITION_TYPE_BUY){
      if(failState==IDLE){if(price<=vwap-dep){failState=SELL_DEP;lastAction="YOUNG BUY: OPPOSITE SELL SIDE ESTABLISHED";}return;}
      if(failState==SELL_DEP){if(price>=vwap-band){failState=SELL_RET;failRetestStart=TimeCurrent();failRetestExtreme=price;failWrongSideSince=0;}return;}
      if(failState!=SELL_RET){ResetFailState();return;}
      failRetestExtreme=MathMax(failRetestExtreme,price);if(YoungFailRetestTimeoutMinutes>0&&TimeCurrent()-failRetestStart>YoungFailRetestTimeoutMinutes*60){ResetFailState();return;}
      if(price>vwap+wrong){if(failWrongSideSince==0)failWrongSideSince=TimeCurrent();if(TimeCurrent()-failWrongSideSince>=MathMax(1,YoungFailWrongSideSeconds)){ResetFailState();return;}}else if(price<=vwap)failWrongSideSince=0;
      bool reclaimed=price<=vwap-rec,dropped=price<=failRetestExtreme-rec;if(reclaimed&&dropped)ClosePos(tk,"YOUNG BUY FAILED - FULL SELL VWAP");return;
   }

   if(ty==POSITION_TYPE_SELL){
      if(failState==IDLE){if(price>=vwap+dep){failState=BUY_DEP;lastAction="YOUNG SELL: OPPOSITE BUY SIDE ESTABLISHED";}return;}
      if(failState==BUY_DEP){if(price<=vwap+band){failState=BUY_RET;failRetestStart=TimeCurrent();failRetestExtreme=price;failWrongSideSince=0;}return;}
      if(failState!=BUY_RET){ResetFailState();return;}
      failRetestExtreme=MathMin(failRetestExtreme,price);if(YoungFailRetestTimeoutMinutes>0&&TimeCurrent()-failRetestStart>YoungFailRetestTimeoutMinutes*60){ResetFailState();return;}
      if(price<vwap-wrong){if(failWrongSideSince==0)failWrongSideSince=TimeCurrent();if(TimeCurrent()-failWrongSideSince>=MathMax(1,YoungFailWrongSideSeconds)){ResetFailState();return;}}else if(price>=vwap)failWrongSideSince=0;
      bool reclaimed=price>=vwap+rec,bounced=price>=failRetestExtreme+rec;if(reclaimed&&bounced)ClosePos(tk,"YOUNG SELL FAILED - FULL BUY VWAP");return;
   }
}

void ReviewEMA()
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){emaWrongCloses=0;runnerHealth="FLAT";return;}if(!runnerLocked){emaWrongCloses=0;runnerHealth="BUILDING - YOUNG PHASE";return;}
   MqlRates b;double ema=0;if(!GetBar(MapTF,1,b)||!GetEMA(1,ema))return;bool wrong=false;double depth=0;if(ty==POSITION_TYPE_BUY){wrong=b.close<ema;if(wrong)depth=ema-b.close;}else{wrong=b.close>ema;if(wrong)depth=b.close-ema;}
   if(!wrong){emaWrongCloses=0;runnerHealth="EMA8 RESPECTED - HOLD MOUNTAIN";return;}emaWrongCloses++;double frac=(avgM5>0?depth/avgM5:0);bool clearBreak=frac>=MathMax(0.0,EMAClearBreakM5RangeFrac),repeated=emaWrongCloses>=MathMax(1,EMAExitWrongCloses);
   if(clearBreak||repeated){string why=clearBreak?"EMA8 EXIT - DEEP "+DoubleToString(EMAClearBreakM5RangeFrac,2)+"x M5 LOSS":"EMA8 EXIT - "+IntegerToString(EMAExitWrongCloses)+" WRONG M5 CLOSES";if(ClosePos(tk,why)){lastAction=why+" | FLAT";Log("MATURE EXIT -> FLAT, FRESH EXPANSION REQUIRED");}return;}
   runnerHealth="EMA8 BREATHING - HOLD | wrong closes="+IntegerToString(emaWrongCloses)+"/"+IntegerToString(EMAExitWrongCloses)+" | depth="+DoubleToString(frac,2)+"R";
}

void ProcessExpansionEntry(const MqlTick &t)
{
   if(!expansionArmed||HasPos()||!haveVWAP)return;
   if(ExpansionArmExpiryMinutes>0&&TimeCurrent()-expansionArmTime>ExpansionArmExpiryMinutes*60){lastAction="EXPANSION EXPIRED - WAIT NEW MOVE";ResetExpansion();return;}

   int dir=expansionDir;double px=(dir>0?t.bid:t.ask),base=MathMax(expansionBaseM5,_Point),vwap=liveVWAP;double ad=Adaptive(t.time_msc);if(ad<=0)return;
   double band=ad*MathMax(0.0,RetestBandAdaptiveFrac),naturalReclaim=ad*MathMax(0.0,ReclaimAdaptiveFrac),wrongDepth=ad*MathMax(0.0,VWAPWrongDepthAdaptiveFrac);
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money),reclaim=MathMax(naturalReclaim,fr*MathMax(1.0,CostSafetyMultiple));

   if(dir>0){
      if(px>expansionExtreme)expansionExtreme=px;
      // If pullback reaches VWAP retest territory, original VWAP path owns it.
      if(!vwapRetestSeen&&px<=vwap+band){vwapRetestSeen=true;continuationPullbackSeen=false;vwapRetestStart=TimeCurrent();vwapRetestExtreme=px;vwapWrongSideSince=0;lastAction="BUY VWAP RETEST PATH";}
      if(vwapRetestSeen){
         vwapRetestExtreme=MathMin(vwapRetestExtreme,px);if(RetestTimeoutMinutes>0&&TimeCurrent()-vwapRetestStart>RetestTimeoutMinutes*60){ResetExpansion();lastAction="BUY VWAP RETEST EXPIRED";return;}
         if(px<vwap-wrongDepth){if(vwapWrongSideSince==0)vwapWrongSideSince=TimeCurrent();if(TimeCurrent()-vwapWrongSideSince>=MathMax(1,VWAPWrongSideSeconds)){ResetExpansion();lastAction="BUY EXPANSION INVALIDATED BELOW VWAP";return;}}else if(px>=vwap)vwapWrongSideSince=0;
         if(px>=vwap+reclaim&&px>=vwapRetestExtreme+reclaim){OpenTrade(1,PATH_VWAP_RETEST);return;}return;
      }

      if(ContinuationEnabled){
         double pullback=expansionExtreme-px;double ema=0;bool haveE=GetEMA(0,ema);bool nearEMA=haveE&&MathAbs(px-ema)<=base*MathMax(0.0,ContinuationEMAProximityM5Ranges);
         if(!continuationPullbackSeen&&pullback>=base*MathMax(0.0,ContinuationPullbackM5Ranges)&&nearEMA&&px>vwap){continuationPullbackSeen=true;continuationPullbackExtreme=px;lastAction="BUY FIRST CONTINUATION PULLBACK";Log(lastAction);}
         if(continuationPullbackSeen){if(px<continuationPullbackExtreme)continuationPullbackExtreme=px;if(px<=vwap+band){vwapRetestSeen=true;continuationPullbackSeen=false;vwapRetestStart=TimeCurrent();vwapRetestExtreme=px;return;}double e=0;if(GetEMA(0,e)&&px>e&&px>vwap&&px>=continuationPullbackExtreme+base*MathMax(0.0,ContinuationResumeM5Ranges)){OpenTrade(1,PATH_CONTINUATION);return;}}
      }
   }else{
      if(expansionExtreme==0||px<expansionExtreme)expansionExtreme=px;
      if(!vwapRetestSeen&&px>=vwap-band){vwapRetestSeen=true;continuationPullbackSeen=false;vwapRetestStart=TimeCurrent();vwapRetestExtreme=px;vwapWrongSideSince=0;lastAction="SELL VWAP RETEST PATH";}
      if(vwapRetestSeen){
         vwapRetestExtreme=MathMax(vwapRetestExtreme,px);if(RetestTimeoutMinutes>0&&TimeCurrent()-vwapRetestStart>RetestTimeoutMinutes*60){ResetExpansion();lastAction="SELL VWAP RETEST EXPIRED";return;}
         if(px>vwap+wrongDepth){if(vwapWrongSideSince==0)vwapWrongSideSince=TimeCurrent();if(TimeCurrent()-vwapWrongSideSince>=MathMax(1,VWAPWrongSideSeconds)){ResetExpansion();lastAction="SELL EXPANSION INVALIDATED ABOVE VWAP";return;}}else if(px<=vwap)vwapWrongSideSince=0;
         if(px<=vwap-reclaim&&px<=vwapRetestExtreme-reclaim){OpenTrade(-1,PATH_VWAP_RETEST);return;}return;
      }

      if(ContinuationEnabled){
         double pullback=px-expansionExtreme;double ema=0;bool haveE=GetEMA(0,ema);bool nearEMA=haveE&&MathAbs(px-ema)<=base*MathMax(0.0,ContinuationEMAProximityM5Ranges);
         if(!continuationPullbackSeen&&pullback>=base*MathMax(0.0,ContinuationPullbackM5Ranges)&&nearEMA&&px<vwap){continuationPullbackSeen=true;continuationPullbackExtreme=px;lastAction="SELL FIRST CONTINUATION PULLBACK";Log(lastAction);}
         if(continuationPullbackSeen){if(px>continuationPullbackExtreme)continuationPullbackExtreme=px;if(px>=vwap-band){vwapRetestSeen=true;continuationPullbackSeen=false;vwapRetestStart=TimeCurrent();vwapRetestExtreme=px;return;}double e=0;if(GetEMA(0,e)&&px<e&&px<vwap&&px<=continuationPullbackExtreme-base*MathMax(0.0,ContinuationResumeM5Ranges)){OpenTrade(-1,PATH_CONTINUATION);return;}}
      }
   }
}

void NewM1()
{
   datetime c=iTime(_Symbol,TriggerTF,0);if(c<=0||c==lastM1)return;lastM1=c;double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;DetectExpansion();
}

void NewM5()
{
   datetime c=iTime(_Symbol,MapTF,0);if(c<=0||c==lastM5)return;lastM5=c;RebuildVWAP();double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;ReviewEMA();
}

void Panel(const MqlTick &t)
{
   ulong now=GetTickCount64();if(lastPanelMs>0&&now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))return;lastPanelMs=now;
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;string pos="NONE";int age=0;double mfeR=0,maeR=0,netR=0;if(FindPos(tk,ty,op,pf)){pos=(ty==POSITION_TYPE_BUY?"BUY":"SELL")+string(runnerLocked?" | MOUNTAIN LOCK":" | YOUNG");if(!runnerLocked&&youngEntryTime>0&&youngEntryM5Range>0){age=(int)MathMax(0,(long)(TimeCurrent()-youngEntryTime));double px=(ty==POSITION_TYPE_BUY?t.bid:t.ask),base=MathMax(youngEntryM5Range,_Point);mfeR=mfe/base;maeR=youngMAE/base;netR=(ty==POSITION_TYPE_BUY?px-op:op-px)/base;}}
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money);string arm=(expansionArmed?(expansionDir>0?"BUY":"SELL"):"NONE");
   Comment("VWAP + EMA8 MOUNTAIN RUNNER v5.35 EXPANSION CONTINUATION\n",
           "POSITION: ",pos,"\nREGIME ARM: ",arm," | Eff: ",DoubleToString(expansionEfficiency,2)," | Net: ",DoubleToString(expansionNetR,2),"R | VWAP: ",DoubleToString(expansionVWAPR,2),"R",
           "\nENTRY PATH: ",(vwapRetestSeen?"VWAP RETEST":(continuationPullbackSeen?"CONTINUATION PULLBACK":"WAITING PULLBACK")),
           "\nARMS: ",IntegerToString(expansionArms)," | REGIME REJECTS: ",IntegerToString(regimeRejects)," | VWAP ENTRIES: ",IntegerToString(vwapRetestEntries)," | CONT ENTRIES: ",IntegerToString(continuationEntries),
           "\nM5 AVG RANGE: ",DoubleToString(avgM5,2),"\nRUNNER: ",runnerHealth,"\nMFE: ",DoubleToString(mfe,2)," | LOCK: ",DoubleToString(avgM5*RunnerActivateM5Ranges,2),
           "\nEMA WRONG CLOSES: ",IntegerToString(emaWrongCloses),"/",IntegerToString(EMAExitWrongCloses)," | DEEP EXIT: ",DoubleToString(EMAClearBreakM5RangeFrac,2),"R",
           "\nYOUNG AGE: ",IntegerToString(age)," sec | MFE_R: ",DoubleToString(mfeR,2)," | MAE_R: ",DoubleToString(maeR,2)," | NET_R: ",DoubleToString(netR,2),
           "\nZOMBIE CUTS: ",IntegerToString(zombieCuts),"\nEST RT COST: ",DoubleToString(money,4)," | FRICTION: ",DoubleToString(fr,2),"\nLAST: ",lastAction);
}

int OnInit()
{
   if(MapTF!=PERIOD_M5||TriggerTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;emaHandle=iMA(_Symbol,MapTF,EMAPeriod,0,MODE_EMA,PRICE_CLOSE);if(emaHandle==INVALID_HANDLE)return INIT_FAILED;
   trade.SetExpertMagicNumber(Magic);trade.SetDeviationInPoints(DeviationPoints);trade.SetTypeFillingBySymbol(_Symbol);trade.SetAsyncMode(false);RefreshRanges();RebuildVWAP();MqlTick t;if(SymbolInfoTick(_Symbol,t)){RecordTick(t);UpdateVWAP();Adaptive(t.time_msc);}ResetExpansion();ClearRunner();
   Log("INIT V5.35 | NO ENTRY IN UNPROVEN CHOP | TWO ENTRY PATHS AFTER EXPANSION");
   Log("REGIME DEFAULT | 8 M1 efficiency >=0.62 | net >=1.00x M5 | VWAP distance >=0.50x M5");
   Log("PATH A VWAP RETEST | PATH B first EMA8 continuation pullback");
   Log("MOUNTAIN HOLD | 3 wrong M5 closes OR deep 0.60x M5 EMA loss");return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Log("DEINIT V5.35 | arms="+IntegerToString(expansionArms)+" | regime rejects="+IntegerToString(regimeRejects)+" | VWAP entries="+IntegerToString(vwapRetestEntries)+" | continuation entries="+IntegerToString(continuationEntries)+" | zombie cuts="+IntegerToString(zombieCuts));
   if(emaHandle!=INVALID_HANDLE)IndicatorRelease(emaHandle);Comment("");
}

void OnTick()
{
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;RecordTick(t);NewM5();if(!UpdateVWAP())return;NewM1();UpdateRunner(t);
   if(HasPos()){
      if(CheckZombieGuard(t)){Panel(t);return;}
      ProcessYoungOppositeVWAP(t);Panel(t);return;
   }
   ProcessExpansionEntry(t);Panel(t);
}
