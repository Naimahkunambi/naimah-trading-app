#property strict
#property version "5.34"
#include <Trade/Trade.mqh>
CTrade trade;

#define TBUF 4096
#define CHOPBUF 64

enum SetupState { IDLE=0, BUY_DEP, BUY_RET, SELL_DEP, SELL_RET };
enum Sig { SIG_NONE=0, SIG_BUY, SIG_SELL };

input double Lots=0.01;
input ulong Magic=260908534;
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

// Core VWAP setup remains: depart -> first retest -> reclaim.
input double DepartureAdaptiveFrac=0.60;
input double MinVWAPDepartureM5RangeFrac=0.75;
input double RetestBandAdaptiveFrac=0.25;
input double ReclaimAdaptiveFrac=0.18;
input double VWAPWrongDepthAdaptiveFrac=0.18;
input int VWAPWrongSideSeconds=20;
input int RetestTimeoutMinutes=10;

// V5.34 CHOP LOCK
// A setup can arm only after clean one-sided behavior around VWAP.
input bool VWAPChopLockEnabled=true;
input int SameSideM1Closes=2;
input int VWAPCrossLookbackMinutes=10;
input int MaxVWAPCrossings=2;

input double RunnerActivateM5Ranges=1.50;

// V5.33 mountain breathing room preserved.
input int EMAExitWrongCloses=3;
input double EMAClearBreakM5RangeFrac=0.60;

// V5.32 zombie guard preserved. It disarms after Mountain Lock.
input bool ZombieGuardEnabled=true;
input int ZombieMinAgeSeconds=1800;
input double ZombieMaxMFERanges=0.75;
input double ZombieMinMAERanges=0.75;
input double ZombieMaxNetProgressRanges=0.10;

input double CommissionPerLotRT=58.0;
input double CostSafetyMultiple=1.25;
input int ExpectedSlippagePoints=0;
input int PanelUpdateMilliseconds=500;
input bool VerboseLog=true;

SetupState state=IDLE;
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
datetime retestStart=0,wrongSideSince=0;
double retestExtreme=0;
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

// Rolling completed-M1 VWAP-side history for Chop Lock.
datetime chopTime[CHOPBUF];
int chopSide[CHOPBUF]; // +1 above VWAP, -1 below VWAP, 0 exactly on VWAP
int chopHead=0,chopStored=0;
int chopBlocks=0;
datetime lastChopBlockBar=0;

void Log(string s){ if(VerboseLog) Print("[V5.34-CL] ",s); }

datetime SessionStart(datetime when)
{
   MqlDateTime dt; TimeToStruct(when,dt); int oh=dt.hour;
   dt.hour=VWAPResetHour; dt.min=0; dt.sec=0;
   datetime s=StructToTime(dt); if(oh<VWAPResetHour) s-=86400; return s;
}

bool GetBar(ENUM_TIMEFRAMES tf,int shift,MqlRates &bar)
{
   MqlRates a[1]; if(CopyRates(_Symbol,tf,shift,1,a)!=1) return false; bar=a[0]; return true;
}

double BarVol(const MqlRates &b)
{
   if(PreferRealVolume && b.real_volume>0) return (double)b.real_volume;
   return (double)b.tick_volume;
}

bool AvgRange(ENUM_TIMEFRAMES tf,int startShift,int count,double &out)
{
   count=MathMax(2,count); MqlRates r[]; int n=CopyRates(_Symbol,tf,startShift,count,r);
   if(n!=count) return false; double sum=0; int valid=0;
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
   double pv=vwapPV,vv=vwapVol,vol=BarVol(cur);if(vol>0){double hlc3=(cur.high+cur.low+cur.close)/3.0;pv+=hlc3*vol;vv+=vol;}
   if(vv<=0){haveVWAP=false;return false;}liveVWAP=pv/vv;haveVWAP=true;return true;
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
   double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),tv=TickValue();
   if(ts>0&&tv>0){double mpp=tv/ts;if(mpp>0)commissionDist=MathMax(0.0,CommissionPerLotRT)/mpp;spreadMoney=(spread/ts)*tv*lots;}
   double slip=MathMax(0,ExpectedSlippagePoints)*_Point,slipMoney=0;if(ts>0&&tv>0)slipMoney=(slip/ts)*tv*lots;
   lastFrictionDistance=spread+commissionDist+slip;lastRTCostMoney=spreadMoney+commissionMoney+slipMoney;money=lastRTCostMoney;return lastFrictionDistance;
}

bool TradeOK(){uint rc=trade.ResultRetcode();return rc==TRADE_RETCODE_DONE||rc==TRADE_RETCODE_DONE_PARTIAL||rc==TRADE_RETCODE_PLACED;}

void ResetSignal(){state=IDLE;retestStart=0;wrongSideSince=0;retestExtreme=0;}

void ResetRunner()
{
   mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="NEW POSITION - BUILDING";
   youngEntryTime=TimeCurrent();youngEntryM5Range=(avgM5>0?avgM5:0);youngMAE=0;
}

void ClearRunner()
{
   mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="FLAT";youngEntryTime=0;youngEntryM5Range=0;youngMAE=0;
}

void PushChopSide(datetime when,int side)
{
   chopTime[chopHead]=when;chopSide[chopHead]=side;chopHead++;if(chopHead>=CHOPBUF)chopHead=0;if(chopStored<CHOPBUF)chopStored++;
}

int ChopIndexFromNewest(int k)
{
   int idx=chopHead-1-k;while(idx<0)idx+=CHOPBUF;return idx;
}

int ConsecutiveM1Side(int dir)
{
   int need=MathMax(1,SameSideM1Closes),count=0;
   for(int k=0;k<chopStored&&k<need;k++){
      int idx=ChopIndexFromNewest(k);int s=chopSide[idx];
      if(s==dir)count++;else break;
   }
   return count;
}

int RecentVWAPCrossings()
{
   int bars=MathMax(1,VWAPCrossLookbackMinutes)+1;
   int n=MathMin(chopStored,bars);
   if(n<2)return 0;
   int prev=0,crosses=0;
   for(int k=n-1;k>=0;k--){
      int idx=ChopIndexFromNewest(k);int s=chopSide[idx];
      if(s==0)continue;
      if(prev!=0&&s!=prev)crosses++;
      prev=s;
   }
   return crosses;
}

bool ChopHistoryReady()
{
   if(!VWAPChopLockEnabled)return true;
   int need=MathMax(MathMax(1,SameSideM1Closes),MathMax(1,VWAPCrossLookbackMinutes)+1);
   return chopStored>=need;
}

bool CleanVWAPSide(int dir,string &why)
{
   if(!VWAPChopLockEnabled){why="OFF";return true;}
   if(!ChopHistoryReady()){why="WARMUP";return false;}
   int same=ConsecutiveM1Side(dir),crosses=RecentVWAPCrossings();
   if(same<MathMax(1,SameSideM1Closes)){why="NEED SAME-SIDE M1 CLOSES "+IntegerToString(same)+"/"+IntegerToString(MathMax(1,SameSideM1Closes));return false;}
   if(crosses>MathMax(0,MaxVWAPCrossings)){why="VWAP CHOP "+IntegerToString(crosses)+" CROSSES";return false;}
   why="CLEAN | same="+IntegerToString(same)+" | crosses="+IntegerToString(crosses);return true;
}

void RecordCompletedM1Side()
{
   if(!haveVWAP)return;
   MqlRates b;if(!GetBar(TriggerTF,1,b))return;
   int side=0;if(b.close>liveVWAP)side=1;else if(b.close<liveVWAP)side=-1;
   PushChopSide(b.time,side);
}

bool OpenBuy()
{
   if(HasPos())return false;MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double lots=NormVol(Lots),sl=0;if(EmergencySLPoints>0)sl=NormalizeDouble(t.ask-EmergencySLPoints*_Point,_Digits);
   bool ok=trade.Buy(lots,_Symbol,0,sl,0,"V534_CL_BUY");if(!ok||!TradeOK()){Log("BUY failed: "+trade.ResultRetcodeDescription());return false;}ResetSignal();ResetRunner();lastAction="BUY OPENED";Log(lastAction+" | clean VWAP setup accepted");return true;
}

bool OpenSell()
{
   if(HasPos())return false;MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double lots=NormVol(Lots),sl=0;if(EmergencySLPoints>0)sl=NormalizeDouble(t.bid+EmergencySLPoints*_Point,_Digits);
   bool ok=trade.Sell(lots,_Symbol,0,sl,0,"V534_CL_SELL");if(!ok||!TradeOK()){Log("SELL failed: "+trade.ResultRetcodeDescription());return false;}ResetSignal();ResetRunner();lastAction="SELL OPENED";Log(lastAction+" | clean VWAP setup accepted");return true;
}

bool ClosePos(ulong ticket,string reason)
{
   bool ok=trade.PositionClose(ticket);if(!ok||!TradeOK()){Log("CLOSE failed: "+trade.ResultRetcodeDescription());return false;}
   lastAction=reason;Log(reason);ResetSignal();ClearRunner();return true;
}

void UpdateRunner(const MqlTick &t)
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){ClearRunner();return;}
   double exitPrice=(ty==POSITION_TYPE_BUY?t.bid:t.ask);
   double favorable=(ty==POSITION_TYPE_BUY?exitPrice-op:op-exitPrice),adverse=(ty==POSITION_TYPE_BUY?op-exitPrice:exitPrice-op);
   if(favorable>mfe)mfe=favorable;if(adverse>youngMAE)youngMAE=adverse;
   if(!runnerLocked&&avgM5>0&&mfe>=avgM5*MathMax(0.5,RunnerActivateM5Ranges)){
      runnerLocked=true;emaWrongCloses=0;runnerHealth="MOUNTAIN LOCKED - EMA8 OWNS EXIT";lastAction="RUNNER LOCKED";
      Log("RUNNER LOCKED at "+DoubleToString(RunnerActivateM5Ranges,2)+"x M5 | Zombie Guard DISARMED | Mountain Hold ARMED");
   }
}

bool CheckZombieGuard(const MqlTick &t)
{
   if(!ZombieGuardEnabled||runnerLocked)return false;
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return false;if(youngEntryTime<=0||youngEntryM5Range<=0)return false;
   int age=(int)MathMax(0,(long)(TimeCurrent()-youngEntryTime));if(age<MathMax(1,ZombieMinAgeSeconds))return false;
   double exitPrice=(ty==POSITION_TYPE_BUY?t.bid:t.ask),net=(ty==POSITION_TYPE_BUY?exitPrice-op:op-exitPrice),base=MathMax(youngEntryM5Range,_Point);
   double mfeR=mfe/base,maeR=youngMAE/base,netR=net/base;
   bool stale=(mfeR<=MathMax(0.0,ZombieMaxMFERanges)),hurt=(maeR>=MathMax(0.0,ZombieMinMAERanges)),notProgressing=(netR<=ZombieMaxNetProgressRanges);
   if(!(stale&&hurt&&notProgressing))return false;
   string reason="ZOMBIE GUARD EXIT | age="+IntegerToString(age)+"s | MFE="+DoubleToString(mfeR,2)+"R | MAE="+DoubleToString(maeR,2)+"R | NET="+DoubleToString(netR,2)+"R";
   if(!ClosePos(tk,reason))return false;zombieCuts++;lastAction=reason+" | FLAT - FRESH VWAP REQUIRED";return true;
}

void ReviewEMA()
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){emaWrongCloses=0;runnerHealth="FLAT";return;}
   if(!runnerLocked){emaWrongCloses=0;runnerHealth="BUILDING - VWAP OWNS DECISION";return;}
   MqlRates b;double ema=0;if(!GetBar(MapTF,1,b)||!GetEMA(1,ema))return;
   bool wrong=false;double depth=0;
   if(ty==POSITION_TYPE_BUY){wrong=b.close<ema;if(wrong)depth=ema-b.close;}else{wrong=b.close>ema;if(wrong)depth=b.close-ema;}
   if(!wrong){emaWrongCloses=0;runnerHealth="EMA8 RESPECTED - HOLD MOUNTAIN";return;}
   emaWrongCloses++;double frac=(avgM5>0?depth/avgM5:0);
   bool clearBreak=frac>=MathMax(0.0,EMAClearBreakM5RangeFrac),repeated=emaWrongCloses>=MathMax(1,EMAExitWrongCloses);
   if(clearBreak||repeated){
      string why=clearBreak?"EMA8 EXIT - DEEP "+DoubleToString(EMAClearBreakM5RangeFrac,2)+"x M5 LOSS":"EMA8 EXIT - "+IntegerToString(EMAExitWrongCloses)+" WRONG M5 CLOSES";
      if(ClosePos(tk,why)){lastAction=why+" | FLAT";Log("MATURE EXIT -> FLAT, WAIT FRESH VWAP");}return;
   }
   runnerHealth="EMA8 BREATHING - HOLD | wrong closes="+IntegerToString(emaWrongCloses)+"/"+IntegerToString(EMAExitWrongCloses)+" | depth="+DoubleToString(frac,2)+"R";
}

bool AllowBuy(){ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return true;if(runnerLocked)return false;return ty==POSITION_TYPE_SELL;}
bool AllowSell(){ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return true;if(runnerLocked)return false;return ty==POSITION_TYPE_BUY;}

bool ExecuteSignal(Sig sig)
{
   if(sig==SIG_NONE)return false;ulong tk;ENUM_POSITION_TYPE ty;double op,pf;bool have=FindPos(tk,ty,op,pf);
   if(!have)return sig==SIG_BUY?OpenBuy():OpenSell();
   if(runnerLocked){ResetSignal();lastAction="OPPOSITE VWAP IGNORED - EMA8 OWNS RUNNER";return false;}
   if((ty==POSITION_TYPE_BUY&&sig==SIG_BUY)||(ty==POSITION_TYPE_SELL&&sig==SIG_SELL)){ResetSignal();return false;}
   string reason=(sig==SIG_BUY?"YOUNG SELL FAILED - FULL BUY VWAP":"YOUNG BUY FAILED - FULL SELL VWAP");
   if(!ClosePos(tk,reason))return false;lastAction=reason+" | FLAT - FRESH VWAP REQUIRED";Log("NO INSTANT YOUNG REVERSAL");return false;
}

void NoteChopBlock(string why)
{
   datetime bar=iTime(_Symbol,TriggerTF,0);
   if(bar!=lastChopBlockBar){lastChopBlockBar=bar;chopBlocks++;Log("CHOP LOCK BLOCK | "+why);}
   lastAction="CHOP LOCK | "+why;
}

void ProcessSignal(const MqlTick &t)
{
   if(!haveVWAP)return;
   if(HasPos()&&runnerLocked){if(state!=IDLE)ResetSignal();return;}

   double price=t.bid,vwap=liveVWAP,ad=Adaptive(t.time_msc);if(ad<=0)return;
   double naturalDeparture=ad*MathMax(0.0,DepartureAdaptiveFrac);
   double m5Departure=(avgM5>0?avgM5*MathMax(0.0,MinVWAPDepartureM5RangeFrac):0.0);
   double band=ad*MathMax(0.0,RetestBandAdaptiveFrac);
   double naturalReclaim=ad*MathMax(0.0,ReclaimAdaptiveFrac);
   double wrongDepth=ad*MathMax(0.0,VWAPWrongDepthAdaptiveFrac);
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money),costFloor=fr*MathMax(1.0,CostSafetyMultiple);
   double departure=MathMax(costFloor,MathMax(naturalDeparture,m5Departure));
   double reclaim=MathMax(naturalReclaim,costFloor);
   bool allowBuy=AllowBuy(),allowSell=AllowSell();

   if(state==IDLE){
      if(allowBuy&&price>=vwap+departure){
         string why="";if(!CleanVWAPSide(1,why)){NoteChopBlock("BUY "+why);return;}
         state=BUY_DEP;lastAction="BUY CLEAN DEPARTURE | "+DoubleToString((avgM5>0?(price-vwap)/avgM5:0),2)+" M5R";Log(lastAction);return;
      }
      if(allowSell&&price<=vwap-departure){
         string why="";if(!CleanVWAPSide(-1,why)){NoteChopBlock("SELL "+why);return;}
         state=SELL_DEP;lastAction="SELL CLEAN DEPARTURE | "+DoubleToString((avgM5>0?(vwap-price)/avgM5:0),2)+" M5R";Log(lastAction);return;
      }
      return;
   }

   if((state==BUY_DEP||state==BUY_RET)&&!allowBuy){ResetSignal();return;}
   if((state==SELL_DEP||state==SELL_RET)&&!allowSell){ResetSignal();return;}

   if(state==BUY_DEP){
      // First return to the VWAP retest band becomes the one permitted retest.
      if(price<=vwap+band){state=BUY_RET;retestStart=TimeCurrent();retestExtreme=price;wrongSideSince=0;lastAction="BUY FIRST RETEST";return;}
   }
   if(state==SELL_DEP){
      if(price>=vwap-band){state=SELL_RET;retestStart=TimeCurrent();retestExtreme=price;wrongSideSince=0;lastAction="SELL FIRST RETEST";return;}
   }

   if(state==BUY_RET){
      retestExtreme=MathMin(retestExtreme,price);
      if(RetestTimeoutMinutes>0&&retestStart>0&&TimeCurrent()-retestStart>RetestTimeoutMinutes*60){ResetSignal();lastAction="BUY RETEST EXPIRED - FRESH DEPARTURE REQUIRED";return;}
      if(price<vwap-wrongDepth){
         if(wrongSideSince==0)wrongSideSince=TimeCurrent();
         if(TimeCurrent()-wrongSideSince>=MathMax(1,VWAPWrongSideSeconds)){ResetSignal();lastAction="BUY RETEST FAILED - FRESH CLEAN DEPARTURE REQUIRED";return;}
      }else if(price>=vwap)wrongSideSince=0;
      bool reclaimed=price>=vwap+reclaim,bounced=price>=retestExtreme+reclaim;
      if(reclaimed&&bounced)ExecuteSignal(SIG_BUY);return;
   }

   if(state==SELL_RET){
      retestExtreme=MathMax(retestExtreme,price);
      if(RetestTimeoutMinutes>0&&retestStart>0&&TimeCurrent()-retestStart>RetestTimeoutMinutes*60){ResetSignal();lastAction="SELL RETEST EXPIRED - FRESH DEPARTURE REQUIRED";return;}
      if(price>vwap+wrongDepth){
         if(wrongSideSince==0)wrongSideSince=TimeCurrent();
         if(TimeCurrent()-wrongSideSince>=MathMax(1,VWAPWrongSideSeconds)){ResetSignal();lastAction="SELL RETEST FAILED - FRESH CLEAN DEPARTURE REQUIRED";return;}
      }else if(price<=vwap)wrongSideSince=0;
      bool reclaimed=price<=vwap-reclaim,dropped=price<=retestExtreme-reclaim;
      if(reclaimed&&dropped)ExecuteSignal(SIG_SELL);return;
   }
}

void NewM1()
{
   datetime c=iTime(_Symbol,TriggerTF,0);if(c<=0||c==lastM1)return;lastM1=c;
   double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;
   RecordCompletedM1Side();
}

void NewM5()
{
   datetime c=iTime(_Symbol,MapTF,0);if(c<=0||c==lastM5)return;lastM5=c;RebuildVWAP();double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;ReviewEMA();
}

string StateName(){switch(state){case BUY_DEP:return"BUY DEPARTED";case BUY_RET:return"BUY RETEST";case SELL_DEP:return"SELL DEPARTED";case SELL_RET:return"SELL RETEST";default:return"IDLE";}}

void Panel(const MqlTick &t)
{
   ulong now=GetTickCount64();if(lastPanelMs>0&&now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))return;lastPanelMs=now;
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;string pos="NONE";int age=0;double mfeR=0,maeR=0,netR=0;
   if(FindPos(tk,ty,op,pf)){
      pos=(ty==POSITION_TYPE_BUY?"BUY":"SELL")+string(runnerLocked?" | MOUNTAIN LOCK":" | BUILDING");
      if(!runnerLocked&&youngEntryTime>0&&youngEntryM5Range>0){age=(int)MathMax(0,(long)(TimeCurrent()-youngEntryTime));double px=(ty==POSITION_TYPE_BUY?t.bid:t.ask),base=MathMax(youngEntryM5Range,_Point);mfeR=mfe/base;maeR=youngMAE/base;netR=(ty==POSITION_TYPE_BUY?px-op:op-px)/base;}
   }
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money);
   int sameBuy=ConsecutiveM1Side(1),sameSell=ConsecutiveM1Side(-1),crosses=RecentVWAPCrossings();
   Comment("VWAP + EMA8 MOUNTAIN RUNNER v5.34 CHOP LOCK\n",
           "POSITION: ",pos,"\nSTATE: ",StateName(),"\nVWAP: ",(haveVWAP?DoubleToString(liveVWAP,_Digits):"n/a"),
           "\nCHOP READY: ",(ChopHistoryReady()?"YES":"WARMUP")," | CROSSES: ",IntegerToString(crosses),"/",IntegerToString(MaxVWAPCrossings),
           "\nSAME-SIDE M1: BUY ",IntegerToString(sameBuy)," | SELL ",IntegerToString(sameSell)," | NEED ",IntegerToString(SameSideM1Closes),
           "\nMIN CLEAN DEPARTURE: ",DoubleToString(MinVWAPDepartureM5RangeFrac,2)," x M5 | CHOP BLOCKS: ",IntegerToString(chopBlocks),
           "\nM5 AVG RANGE: ",DoubleToString(avgM5,2),"\nRUNNER: ",runnerHealth,"\nMFE: ",DoubleToString(mfe,2)," | LOCK: ",DoubleToString(avgM5*RunnerActivateM5Ranges,2),
           "\nEMA WRONG CLOSES: ",IntegerToString(emaWrongCloses),"/",IntegerToString(EMAExitWrongCloses)," | DEEP EXIT: ",DoubleToString(EMAClearBreakM5RangeFrac,2),"R",
           "\nYOUNG AGE: ",IntegerToString(age)," sec | MFE_R: ",DoubleToString(mfeR,2)," | MAE_R: ",DoubleToString(maeR,2)," | NET_R: ",DoubleToString(netR,2),
           "\nZOMBIE CUTS: ",IntegerToString(zombieCuts),"\nADAPTIVE RANGE: ",DoubleToString(adaptiveRange,2),"\nEST RT COST: ",DoubleToString(money,4)," | FRICTION: ",DoubleToString(fr,2),
           "\nLAST: ",lastAction);
}

int OnInit()
{
   if(MapTF!=PERIOD_M5||TriggerTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;
   emaHandle=iMA(_Symbol,MapTF,EMAPeriod,0,MODE_EMA,PRICE_CLOSE);if(emaHandle==INVALID_HANDLE)return INIT_FAILED;
   trade.SetExpertMagicNumber(Magic);trade.SetDeviationInPoints(DeviationPoints);trade.SetTypeFillingBySymbol(_Symbol);trade.SetAsyncMode(false);
   RefreshRanges();RebuildVWAP();MqlTick t;if(SymbolInfoTick(_Symbol,t)){RecordTick(t);UpdateVWAP();Adaptive(t.time_msc);}ClearRunner();
   Log("INIT V5.34 CHOP LOCK | VWAP depart/retest/reclaim preserved");
   Log("CHOP DEFAULT | 2 same-side completed M1 closes | max 2 VWAP side changes in 10m | min 0.75x M5 departure | first retest only");
   Log("MOUNTAIN DEFAULT | 3 wrong M5 closes OR deep 0.60x M5 EMA loss | Zombie Guard preserved");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Log("DEINIT V5.34 | chop blocks="+IntegerToString(chopBlocks)+" | zombie cuts="+IntegerToString(zombieCuts));
   if(emaHandle!=INVALID_HANDLE)IndicatorRelease(emaHandle);Comment("");
}

void OnTick()
{
   MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;
   RecordTick(t);
   NewM5();
   if(!UpdateVWAP())return;
   NewM1();
   UpdateRunner(t);
   if(CheckZombieGuard(t)){Panel(t);return;}
   ProcessSignal(t);
   Panel(t);
}
