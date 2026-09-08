#property strict
#property version "5.31"
#include <Trade/Trade.mqh>
CTrade trade;

#define TBUF 4096

enum SetupState { IDLE=0, BUY_DEP, BUY_RET, SELL_DEP, SELL_RET };
enum Sig { SIG_NONE=0, SIG_BUY, SIG_SELL };

input double Lots=0.01;
input ulong Magic=260908531;
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

input double DepartureFrac=0.60;
input double RetestBandFrac=0.25;
input double ReclaimFrac=0.18;
input double WrongDepthFrac=0.18;
input int WrongSideSeconds=20;
input int RetestTimeoutMinutes=10;

// v5.31 fixes
input double RunnerLockM5Ranges=1.50;
input int EMAWrongClosesToExit=2;
input double EMADeepBreakM5Frac=0.25;

// tester shows about 0.30 each side at 0.01 lot => about 0.60 RT
input double CommissionPerLotRT=60.0;
input double CostSafetyMultiple=1.25;
input int ExpectedSlippagePoints=0;

input int PanelUpdateMs=500;
input bool Verbose=true;

SetupState st=IDLE;
int emaHandle=INVALID_HANDLE;
datetime lastM1=0,lastM5=0;

double slowM1=0,fastM1=0,avgM5=0;
long tickT[TBUF];
double tickP[TBUF];
int tickHead=0,tickStored=0;
double liveRange=0,adaptiveRange=0;

datetime vwapSession=0;
double vwapPV=0,vwapVol=0,liveVWAP=0;
bool haveVWAP=false;

datetime retestStart=0,wrongSince=0;
double retestExtreme=0;

bool waitFresh=false;
double mfe=0;
bool runnerLocked=false;
int emaWrongCloses=0;
string runnerHealth="FLAT",lastAction="WAITING";
ulongs lastPanelMs=0;

void Log(string s){ if(Verbose) Print("[V5.31] ",s); }

datetime SessionStart(datetime t){
   MqlDateTime d; TimeToStruct(t,d); int h=d.hour;
   d.hour=VWAPResetHour; d.min=0; d.sec=0;
   datetime x=StructToTime(d); if(h<VWAPResetHour) x-=86400; return x;
}

bool Bar(ENUM_TIMEFRAMES tf,int shift,MqlRates &b){ MqlRates a[1]; if(CopyRates(_Symbol,tf,shift,1,a)!=1) return false; b=a[0]; return true; }

double Vol(const MqlRates &b){ if(PreferRealVolume && b.real_volume>0) return (double)b.real_volume; return (double)b.tick_volume; }

bool AvgRange(ENUM_TIMEFRAMES tf,int start,int count,double &out){
   count=MathMax(2,count); MqlRates a[]; int n=CopyRates(_Symbol,tf,start,count,a); if(n!=count) return false;
   double s=0; int v=0; for(int i=0;i<n;i++){ double r=a[i].high-a[i].low; if(r>0){s+=r;v++;} }
   if(v==0) return false; out=s/v; return true;
}

double NormLots(double x){
   double mn=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),mx=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),stp=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(stp<=0) stp=mn; x=MathMax(mn,MathMin(mx,x)); if(stp>0) x=MathFloor((x-mn+1e-12)/stp)*stp+mn; return x;
}

void RecordTick(const MqlTick &t){ tickT[tickHead]=t.time_msc; tickP[tickHead]=t.bid; tickHead=(tickHead+1)%TBUF; if(tickStored<TBUF) tickStored++; }

bool LiveTickRange(long now,double &r){
   if(tickStored<LiveVolMinTicks) return false; long cut=(long)MathMax(1,LiveVolWindowSeconds)*1000;
   double hi=-1e100,lo=1e100; int n=0;
   for(int k=0;k<tickStored;k++){ int i=tickHead-1-k; while(i<0)i+=TBUF; long age=now-tickT[i]; if(age<0)continue; if(age>cut)break; hi=MathMax(hi,tickP[i]); lo=MathMin(lo,tickP[i]); n++; }
   if(n<MathMax(2,LiveVolMinTicks)) return false; r=MathMax(0.0,hi-lo); return true;
}

void RefreshRanges(){ double x=0; if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x; if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x; if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x; }

double Adaptive(long now){
   double base=0; if(slowM1>0 && fastM1>0){ double w=MathMax(0.0,MathMin(1.0,FastM1Weight)); base=slowM1*(1-w)+fastM1*w; } else base=(fastM1>0?fastM1:slowM1);
   double lr=0; if(LiveTickRange(now,lr)){ liveRange=lr; base=MathMax(base,lr*MathMax(0.0,LiveVolWeight)); } else liveRange=0;
   if(slowM1>0){ double mn=slowM1*MathMax(0.05,MinAdaptiveVsSlow),mx=slowM1*MathMax(MinAdaptiveVsSlow,MaxAdaptiveVsSlow); base=MathMax(mn,MathMin(mx,base)); }
   adaptiveRange=base; return base;
}

bool RebuildVWAP(){
   datetime cur=iTime(_Symbol,MapTF,0); if(cur<=0) return false; datetime ss=SessionStart(cur); vwapSession=ss; vwapPV=0; vwapVol=0;
   if(cur<=ss) return true; MqlRates a[]; int n=CopyRates(_Symbol,MapTF,ss,cur-1,a); if(n<=0) return true;
   for(int i=0;i<n;i++){ double v=Vol(a[i]); if(v<=0)continue; double p=(a[i].high+a[i].low+a[i].close)/3.0; vwapPV+=p*v; vwapVol+=v; }
   return true;
}

bool UpdateVWAP(){
   MqlRates b; if(!Bar(MapTF,0,b)){haveVWAP=false;return false;} if(vwapSession!=SessionStart(b.time) && !RebuildVWAP()){haveVWAP=false;return false;}
   double pv=vwapPV,vv=vwapVol,v=Vol(b); if(v>0){ double p=(b.high+b.low+b.close)/3.0; pv+=p*v; vv+=v; }
   if(vv<=0){haveVWAP=false;return false;} liveVWAP=pv/vv; haveVWAP=true; return true;
}

bool EMA(int shift,double &e){ double a[1]; if(emaHandle==INVALID_HANDLE || CopyBuffer(emaHandle,0,shift,1,a)!=1 || a[0]==EMPTY_VALUE) return false; e=a[0]; return true; }

bool Pos(ulong &ticket,ENUM_POSITION_TYPE &type,double &open,double &profit){
   for(int i=PositionsTotal()-1;i>=0;i--){ ulong t=PositionGetTicket(i); if(t==0 || !PositionSelectByTicket(t))continue; if(PositionGetString(POSITION_SYMBOL)!=_Symbol)continue; if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic)continue; ticket=t; type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE); open=PositionGetDouble(POSITION_PRICE_OPEN); profit=PositionGetDouble(POSITION_PROFIT); return true; }
   return false;
}

bool HasPos(){ ulong t; ENUM_POSITION_TYPE ty; double o,p; return Pos(t,ty,o,p); }

bool TradeOK(){ uint r=trade.ResultRetcode(); return r==TRADE_RETCODE_DONE || r==TRADE_RETCODE_DONE_PARTIAL || r==TRADE_RETCODE_PLACED; }

void ResetSignal(){ st=IDLE; retestStart=0; wrongSince=0; retestExtreme=0; }
void ResetRunner(){ mfe=0; runnerLocked=false; emaWrongCloses=0; runnerHealth="BUILDING"; }

bool ClosePos(ulong ticket,string why){
   if(!trade.PositionClose(ticket) || !TradeOK()){ Log("CLOSE FAIL "+trade.ResultRetcodeDescription()); return false; }
   ResetSignal(); ResetRunner(); runnerHealth="FLAT"; waitFresh=true; lastAction=why+" | FLAT | WAIT FRESH VWAP"; Log(lastAction); return true;
}

bool OpenBuy(){
   if(HasPos())return false; MqlTick t; if(!SymbolInfoTick(_Symbol,t))return false; double sl=0; if(EmergencySLPoints>0)sl=NormalizeDouble(t.ask-EmergencySLPoints*_Point,_Digits);
   if(!trade.Buy(NormLots(Lots),_Symbol,0,sl,0,"V531_BUY") || !TradeOK()){Log("BUY FAIL "+trade.ResultRetcodeDescription());return false;}
   ResetSignal(); ResetRunner(); waitFresh=false; lastAction="BUY OPENED"; Log(lastAction); return true;
}

bool OpenSell(){
   if(HasPos())return false; MqlTick t; if(!SymbolInfoTick(_Symbol,t))return false; double sl=0; if(EmergencySLPoints>0)sl=NormalizeDouble(t.bid+EmergencySLPoints*_Point,_Digits);
   if(!trade.Sell(NormLots(Lots),_Symbol,0,sl,0,"V531_SELL") || !TradeOK()){Log("SELL FAIL "+trade.ResultRetcodeDescription());return false;}
   ResetSignal(); ResetRunner(); waitFresh=false; lastAction="SELL OPENED"; Log(lastAction); return true;
}

double TickValuePerLot(){ double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE); if(v>0)return v; double a=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT),b=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS); return (a>0&&b>0?(a+b)/2.0:MathMax(a,b)); }

double Friction(const MqlTick &t,double lots,double &money){
   double spread=MathMax(0.0,t.ask-t.bid),ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),tv=TickValuePerLot(),cd=0,sm=0;
   if(ts>0&&tv>0){ double mppu=tv/ts; if(mppu>0)cd=MathMax(0.0,CommissionPerLotRT)/mppu; sm=(spread/ts)*tv*lots; }
   double sd=MathMax(0,ExpectedSlippagePoints)*_Point,slm=(ts>0&&tv>0?(sd/ts)*tv*lots:0); money=sm+MathMax(0.0,CommissionPerLotRT)*lots+slm; return spread+cd+sd;
}

void UpdateRunner(const MqlTick &t){
   ulong ticket; ENUM_POSITION_TYPE ty; double op,pf; if(!Pos(ticket,ty,op,pf)){mfe=0;runnerLocked=false;return;}
   double px=(ty==POSITION_TYPE_BUY?t.bid:t.ask),fav=(ty==POSITION_TYPE_BUY?px-op:op-px); if(fav>mfe)mfe=fav;
   double lock=avgM5*MathMax(0.5,RunnerLockM5Ranges); if(!runnerLocked && avgM5>0 && mfe>=lock){ runnerLocked=true; emaWrongCloses=0; runnerHealth="MOUNTAIN LOCKED - EMA8 OWNS EXIT"; lastAction="RUNNER LOCKED @ "+DoubleToString(RunnerLockM5Ranges,2)+"x M5"; Log(lastAction); }
}

void ManageEMA(){
   ulong ticket; ENUM_POSITION_TYPE ty; double op,pf; if(!Pos(ticket,ty,op,pf)){emaWrongCloses=0;runnerHealth="FLAT";return;} if(!runnerLocked){emaWrongCloses=0;runnerHealth="BUILDING - VWAP OWNS DECISION";return;}
   MqlRates b; double e=0; if(!Bar(MapTF,1,b)||!EMA(1,e))return; bool wrong=false; double depth=0;
   if(ty==POSITION_TYPE_BUY){wrong=b.close<e;if(wrong)depth=e-b.close;} else {wrong=b.close>e;if(wrong)depth=b.close-e;}
   if(!wrong){emaWrongCloses=0;runnerHealth="EMA8 RESPECTED - HOLD";return;}
   emaWrongCloses++; double frac=(avgM5>0?depth/avgM5:0); bool deep=frac>=MathMax(0.0,EMADeepBreakM5Frac); bool repeat=emaWrongCloses>=MathMax(1,EMAWrongClosesToExit);
   if(deep||repeat){ string why=(deep?"EMA8 RUNNER EXIT REAL BREAK "+DoubleToString(frac,2)+"xM5":"EMA8 RUNNER EXIT 2 SHALLOW CLOSES"); ClosePos(ticket,why); return; }
   runnerHealth="EMA8 SHALLOW BREATHING 1/"+IntegerToString(MathMax(1,EMAWrongClosesToExit))+" - HOLD";
}

bool AllowBuy(){ ulong t; ENUM_POSITION_TYPE ty; double o,p; if(!Pos(t,ty,o,p))return true; if(runnerLocked)return false; return ty==POSITION_TYPE_SELL; }
bool AllowSell(){ ulong t; ENUM_POSITION_TYPE ty; double o,p; if(!Pos(t,ty,o,p))return true; if(runnerLocked)return false; return ty==POSITION_TYPE_BUY; }

bool Execute(Sig s){
   ulong t; ENUM_POSITION_TYPE ty; double o,p; bool have=Pos(t,ty,o,p); if(!have)return (s==SIG_BUY?OpenBuy():OpenSell()); if(runnerLocked){ResetSignal();return false;}
   if((ty==POSITION_TYPE_BUY&&s==SIG_BUY)||(ty==POSITION_TYPE_SELL&&s==SIG_SELL)){ResetSignal();return false;}
   // v5.31: young failure CLOSES ONLY. Never instant reverse.
   return ClosePos(t,(s==SIG_BUY?"YOUNG SELL FAILED - CLOSE ONLY":"YOUNG BUY FAILED - CLOSE ONLY"));
}

void SignalEngine(const MqlTick &t){
   if(!haveVWAP)return; if(HasPos()&&runnerLocked){if(st!=IDLE)ResetSignal();return;}
   double price=t.bid,vwap=liveVWAP,a=Adaptive(t.time_msc); if(a<=0)return; double band=a*RetestBandFrac,wrong=a*WrongDepthFrac;
   double money=0,fr=Friction(t,NormLots(Lots),money),floor=fr*MathMax(1.0,CostSafetyMultiple); double dep=MathMax(a*DepartureFrac,floor),rec=MathMax(a*ReclaimFrac,floor);
   if(waitFresh){ if(MathAbs(price-vwap)<=band){waitFresh=false;ResetSignal();lastAction="FRESH VWAP BASE RESET";Log(lastAction);} return; }
   bool ab=AllowBuy(),as=AllowSell();
   if(st==IDLE){ if(ab&&price>=vwap+dep){st=BUY_DEP;lastAction="BUY SIDE ESTABLISHED";return;} if(as&&price<=vwap-dep){st=SELL_DEP;lastAction="SELL SIDE ESTABLISHED";return;} return; }
   if((st==BUY_DEP||st==BUY_RET)&&!ab){ResetSignal();return;} if((st==SELL_DEP||st==SELL_RET)&&!as){ResetSignal();return;}
   if(st==BUY_DEP){ if(price<=vwap+band){st=BUY_RET;retestStart=TimeCurrent();retestExtreme=price;wrongSince=0;lastAction="BUY VWAP RETEST";} return; }
   if(st==SELL_DEP){ if(price>=vwap-band){st=SELL_RET;retestStart=TimeCurrent();retestExtreme=price;wrongSince=0;lastAction="SELL VWAP RETEST";} return; }
   if(st==BUY_RET){ retestExtreme=MathMin(retestExtreme,price); if(RetestTimeoutMinutes>0&&TimeCurrent()-retestStart>RetestTimeoutMinutes*60){ResetSignal();return;} if(price<vwap-wrong){if(wrongSince==0)wrongSince=TimeCurrent(); if(TimeCurrent()-wrongSince>=WrongSideSeconds){ResetSignal();return;}} else if(price>=vwap)wrongSince=0; if(price>=vwap+rec&&price>=retestExtreme+rec)Execute(SIG_BUY); return; }
   if(st==SELL_RET){ retestExtreme=MathMax(retestExtreme,price); if(RetestTimeoutMinutes>0&&TimeCurrent()-retestStart>RetestTimeoutMinutes*60){ResetSignal();return;} if(price>vwap+wrong){if(wrongSince==0)wrongSince=TimeCurrent(); if(TimeCurrent()-wrongSince>=WrongSideSeconds){ResetSignal();return;}} else if(price<=vwap)wrongSince=0; if(price<=vwap-rec&&price<=retestExtreme-rec)Execute(SIG_SELL); return; }
}

void NewBars(){
   datetime m1=iTime(_Symbol,TriggerTF,0); if(m1>0&&m1!=lastM1){lastM1=m1;double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;}
   datetime m5=iTime(_Symbol,MapTF,0); if(m5>0&&m5!=lastM5){lastM5=m5;RebuildVWAP();double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;ManageEMA();}
}

string StateName(){ if(st==BUY_DEP)return"BUY DEP";if(st==BUY_RET)return"BUY RET";if(st==SELL_DEP)return"SELL DEP";if(st==SELL_RET)return"SELL RET";return"IDLE"; }

void Panel(const MqlTick &t){
   ulong now=GetTickCount64(); if(lastPanelMs>0&&now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMs))return; lastPanelMs=now;
   ulong tk; ENUM_POSITION_TYPE ty; double op,pf; string pos="NONE"; if(Pos(tk,ty,op,pf))pos=(ty==POSITION_TYPE_BUY?"BUY":"SELL")+string(runnerLocked?" | MOUNTAIN LOCK":" | BUILDING");
   double money=0,fr=Friction(t,NormLots(Lots),money);
   Comment("VWAP + EMA8 MOUNTAIN RUNNER v5.31\n","POSITION: ",pos,"\nSTATE: ",StateName(),"\nFRESH WAIT: ",(waitFresh?"YES":"NO"),"\nVWAP: ",(haveVWAP?DoubleToString(liveVWAP,_Digits):"n/a"),"\nRUNNER: ",runnerHealth,"\nMFE: ",DoubleToString(mfe,2),"\nM5 AVG: ",DoubleToString(avgM5,2),"\nLOCK @: ",DoubleToString(avgM5*RunnerLockM5Ranges,2),"\nEMA DEEP EXIT: ",DoubleToString(EMADeepBreakM5Frac,2),"xM5\nADAPTIVE: ",DoubleToString(adaptiveRange,2),"\nRT COST: ",DoubleToString(money,2),"\nFRICTION: ",DoubleToString(fr,2),"\nLAST: ",lastAction);
}

int OnInit(){
   if(MapTF!=PERIOD_M5||TriggerTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;
   emaHandle=iMA(_Symbol,MapTF,EMAPeriod,0,MODE_EMA,PRICE_CLOSE); if(emaHandle==INVALID_HANDLE)return INIT_FAILED;
   trade.SetExpertMagicNumber(Magic); trade.SetDeviationInPoints(DeviationPoints); trade.SetTypeFillingBySymbol(_Symbol); trade.SetAsyncMode(false);
   RefreshRanges(); RebuildVWAP(); MqlTick t; if(SymbolInfoTick(_Symbol,t)){RecordTick(t);UpdateVWAP();Adaptive(t.time_msc);} Log("INIT v5.31 | young fail close-only | lock 1.50xM5 | EMA deep exit 0.25xM5"); return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){ if(emaHandle!=INVALID_HANDLE)IndicatorRelease(emaHandle); Comment(""); }

void OnTick(){ MqlTick t; if(!SymbolInfoTick(_Symbol,t))return; RecordTick(t); NewBars(); if(!UpdateVWAP())return; UpdateRunner(t); SignalEngine(t); Panel(t); }
