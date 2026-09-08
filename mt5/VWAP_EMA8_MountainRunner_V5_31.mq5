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

input double DepartureAdaptiveFrac=0.60;
input double RetestBandAdaptiveFrac=0.25;
input double ReclaimAdaptiveFrac=0.18;
input double VWAPWrongDepthAdaptiveFrac=0.18;
input int VWAPWrongSideSeconds=20;
input int RetestTimeoutMinutes=10;

// V5.31 CHANGE #2: earlier Mountain Lock
input double RunnerActivateM5Ranges=1.50;

// V5.31 CHANGE #3: mature EMA exit
input int EMAExitWrongCloses=2;
input double EMAClearBreakM5RangeFrac=0.25;

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

void Log(string s){ if(VerboseLog) Print("[V5.31] ",s); }

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
   for(int i=0;i<n;i++){ double x=r[i].high-r[i].low; if(x>0){sum+=x;valid++;} }
   if(valid==0) return false; out=sum/valid; return true;
}

double NormVol(double req)
{
   double minv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),maxv=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0) step=minv; double v=MathMax(minv,MathMin(maxv,req));
   if(step>0) v=MathFloor((v-minv+1e-12)/step)*step+minv;
   int d=2; if(step>0){double lg=-MathLog10(step);d=(lg>0?(int)MathCeil(lg):0);d=MathMin(8,MathMax(0,d));}
   return NormalizeDouble(v,d);
}

void RecordTick(const MqlTick &t)
{
   tickTime[tickHead]=t.time_msc; tickBid[tickHead]=t.bid; tickHead++; if(tickHead>=TBUF) tickHead=0; if(tickStored<TBUF) tickStored++;
}

bool LiveRange(long now,double &range,int &samples)
{
   range=0;samples=0;if(tickStored<=0) return false; long cutoff=(long)MathMax(1,LiveVolWindowSeconds)*1000;
   double hi=-1e100,lo=1e100;
   for(int k=0;k<tickStored;k++){
      int idx=tickHead-1-k; while(idx<0) idx+=TBUF; long age=now-tickTime[idx]; if(age<0) continue; if(age>cutoff) break;
      double p=tickBid[idx]; if(p>hi)hi=p; if(p<lo)lo=p; samples++;
   }
   if(samples<MathMax(2,LiveVolMinTicks)) return false; range=MathMax(0.0,hi-lo); return true;
}

void RefreshRanges()
{
   double x=0; if(AvgRange(TriggerTF,1,SlowM1Lookback,x)) slowM1=x; if(AvgRange(TriggerTF,1,FastM1Lookback,x)) fastM1=x; if(AvgRange(MapTF,1,M5RangeLookback,x)) avgM5=x;
}

double Adaptive(long now)
{
   double base=0;
   if(slowM1>0 && fastM1>0){double wf=MathMax(0.0,MathMin(1.0,FastM1Weight));base=slowM1*(1.0-wf)+fastM1*wf;}
   else if(fastM1>0) base=fastM1; else base=slowM1;
   double lr=0; int s=0;
   if(LiveRange(now,lr,s)){liveTickRange=lr;base=MathMax(base,lr*MathMax(0.0,LiveVolWeight));} else liveTickRange=0;
   if(slowM1>0){double mn=slowM1*MathMax(0.05,MinAdaptiveVsSlow),mx=slowM1*MathMax(MinAdaptiveVsSlow,MaxAdaptiveVsSlow);base=MathMax(mn,MathMin(mx,base));}
   adaptiveRange=base; return base;
}

bool RebuildVWAP()
{
   datetime cur=iTime(_Symbol,MapTF,0); if(cur<=0) return false; datetime ss=SessionStart(cur);
   vwapSessionStart=ss; vwapPV=0; vwapVol=0; if(cur<=ss) return true;
   MqlRates b[]; int n=CopyRates(_Symbol,MapTF,ss,cur-1,b); if(n<=0) return true;
   for(int i=0;i<n;i++){double vol=BarVol(b[i]); if(vol<=0) continue; double hlc3=(b[i].high+b[i].low+b[i].close)/3.0; vwapPV+=hlc3*vol; vwapVol+=vol;}
   return true;
}

bool UpdateVWAP()
{
   MqlRates cur; if(!GetBar(MapTF,0,cur)){haveVWAP=false;return false;}
   datetime ss=SessionStart(cur.time); if(vwapSessionStart!=ss && !RebuildVWAP()){haveVWAP=false;return false;}
   double pv=vwapPV,vv=vwapVol,vol=BarVol(cur); if(vol>0){double hlc3=(cur.high+cur.low+cur.close)/3.0;pv+=hlc3*vol;vv+=vol;}
   if(vv<=0){haveVWAP=false;return false;} liveVWAP=pv/vv;haveVWAP=true;return true;
}

bool GetEMA(int shift,double &ema)
{
   if(emaHandle==INVALID_HANDLE) return false; double a[1]; if(CopyBuffer(emaHandle,0,shift,1,a)!=1) return false; if(a[0]==EMPTY_VALUE) return false; ema=a[0];return true;
}

bool FindPos(ulong &ticket,ENUM_POSITION_TYPE &type,double &open,double &profit)
{
   for(int i=PositionsTotal()-1;i>=0;i--){ulong t=PositionGetTicket(i);if(t==0||!PositionSelectByTicket(t))continue;if(PositionGetString(POSITION_SYMBOL)!=_Symbol)continue;if((ulong)PositionGetInteger(POSITION_MAGIC)!=Magic)continue;ticket=t;type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);open=PositionGetDouble(POSITION_PRICE_OPEN);profit=PositionGetDouble(POSITION_PROFIT);return true;} return false;
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
void ResetRunner(){mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="NEW POSITION - BUILDING";}

bool OpenBuy()
{
   if(HasPos()) return false; MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double lots=NormVol(Lots),sl=0;if(EmergencySLPoints>0)sl=NormalizeDouble(t.ask-EmergencySLPoints*_Point,_Digits);
   bool ok=trade.Buy(lots,_Symbol,0,sl,0,"V531_BUY");if(!ok||!TradeOK()){Log("BUY failed: "+trade.ResultRetcodeDescription());return false;}ResetSignal();ResetRunner();lastAction="BUY OPENED";Log(lastAction);return true;
}

bool OpenSell()
{
   if(HasPos()) return false; MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double lots=NormVol(Lots),sl=0;if(EmergencySLPoints>0)sl=NormalizeDouble(t.bid+EmergencySLPoints*_Point,_Digits);
   bool ok=trade.Sell(lots,_Symbol,0,sl,0,"V531_SELL");if(!ok||!TradeOK()){Log("SELL failed: "+trade.ResultRetcodeDescription());return false;}ResetSignal();ResetRunner();lastAction="SELL OPENED";Log(lastAction);return true;
}

bool ClosePos(ulong ticket,string reason)
{
   bool ok=trade.PositionClose(ticket);if(!ok||!TradeOK()){Log("CLOSE failed: "+trade.ResultRetcodeDescription());return false;}
   lastAction=reason;Log(reason);ResetSignal();mfe=0;runnerLocked=false;emaWrongCloses=0;runnerHealth="FLAT";return true;
}

void UpdateRunner(const MqlTick &t)
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){mfe=0;runnerLocked=false;return;}
   double exitPrice=(ty==POSITION_TYPE_BUY?t.bid:t.ask);double favorable=(ty==POSITION_TYPE_BUY?exitPrice-op:op-exitPrice);if(favorable>mfe)mfe=favorable;
   if(!runnerLocked&&avgM5>0&&mfe>=avgM5*MathMax(0.5,RunnerActivateM5Ranges)){runnerLocked=true;emaWrongCloses=0;runnerHealth="MOUNTAIN LOCKED - EMA8 OWNS EXIT";lastAction="RUNNER LOCKED";Log("RUNNER LOCKED at 1.50x M5");}
}

void ReviewEMA()
{
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf)){emaWrongCloses=0;runnerHealth="FLAT";return;}
   if(!runnerLocked){emaWrongCloses=0;runnerHealth="BUILDING - VWAP OWNS DECISION";return;}
   MqlRates b;double ema=0;if(!GetBar(MapTF,1,b)||!GetEMA(1,ema))return;
   bool wrong=false;double depth=0;if(ty==POSITION_TYPE_BUY){wrong=b.close<ema;if(wrong)depth=ema-b.close;}else{wrong=b.close>ema;if(wrong)depth=b.close-ema;}
   if(!wrong){emaWrongCloses=0;runnerHealth="EMA8 RESPECTED - HOLD";return;}
   emaWrongCloses++;double frac=(avgM5>0?depth/avgM5:0);bool clearBreak=frac>=MathMax(0.0,EMAClearBreakM5RangeFrac);bool repeated=emaWrongCloses>=MathMax(1,EMAExitWrongCloses);
   if(clearBreak||repeated){string why=clearBreak?"EMA8 EXIT - CLEAR 0.25x M5 LOSS":"EMA8 EXIT - 2 SHALLOW M5 CLOSES";if(ClosePos(tk,why)){lastAction=why+" | FLAT";Log("MATURE EXIT -> FLAT, WAIT FRESH VWAP");}return;}
   runnerHealth="EMA8 SHALLOW BREATHING - HOLD";
}

bool AllowBuy(){ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return true;if(runnerLocked)return false;return ty==POSITION_TYPE_SELL;}
bool AllowSell(){ulong tk;ENUM_POSITION_TYPE ty;double op,pf;if(!FindPos(tk,ty,op,pf))return true;if(runnerLocked)return false;return ty==POSITION_TYPE_BUY;}

bool ExecuteSignal(Sig sig)
{
   if(sig==SIG_NONE)return false;ulong tk;ENUM_POSITION_TYPE ty;double op,pf;bool have=FindPos(tk,ty,op,pf);
   if(!have) return sig==SIG_BUY?OpenBuy():OpenSell();
   if(runnerLocked){ResetSignal();lastAction="OPPOSITE VWAP IGNORED - EMA8 OWNS RUNNER";return false;}
   if((ty==POSITION_TYPE_BUY&&sig==SIG_BUY)||(ty==POSITION_TYPE_SELL&&sig==SIG_SELL)){ResetSignal();return false;}

   // V5.31 CHANGE #1: close young failure to FLAT, never reverse instantly.
   string reason=(sig==SIG_BUY?"YOUNG SELL FAILED - FULL BUY VWAP":"YOUNG BUY FAILED - FULL SELL VWAP");
   if(!ClosePos(tk,reason))return false;
   lastAction=reason+" | FLAT - FRESH VWAP REQUIRED";
   Log("NO INSTANT YOUNG REVERSAL");
   return false;
}

void ProcessSignal(const MqlTick &t)
{
   if(!haveVWAP)return;
   if(HasPos()&&runnerLocked){if(state!=IDLE)ResetSignal();return;}
   double price=t.bid,vwap=liveVWAP,ad=Adaptive(t.time_msc);if(ad<=0)return;
   double naturalDeparture=ad*MathMax(0.0,DepartureAdaptiveFrac),band=ad*MathMax(0.0,RetestBandAdaptiveFrac),naturalReclaim=ad*MathMax(0.0,ReclaimAdaptiveFrac),wrongDepth=ad*MathMax(0.0,VWAPWrongDepthAdaptiveFrac);
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money),floor=fr*MathMax(1.0,CostSafetyMultiple),departure=MathMax(naturalDeparture,floor),reclaim=MathMax(naturalReclaim,floor);
   bool allowBuy=AllowBuy(),allowSell=AllowSell();

   if(state==IDLE){if(allowBuy&&price>=vwap+departure){state=BUY_DEP;lastAction="BUY SIDE ESTABLISHED";return;}if(allowSell&&price<=vwap-departure){state=SELL_DEP;lastAction="SELL SIDE ESTABLISHED";return;}return;}
   if((state==BUY_DEP||state==BUY_RET)&&!allowBuy){ResetSignal();return;}if((state==SELL_DEP||state==SELL_RET)&&!allowSell){ResetSignal();return;}
   if(state==BUY_DEP){if(price<=vwap+band){state=BUY_RET;retestStart=TimeCurrent();retestExtreme=price;wrongSideSince=0;lastAction="BUY VWAP RETEST";}return;}
   if(state==SELL_DEP){if(price>=vwap-band){state=SELL_RET;retestStart=TimeCurrent();retestExtreme=price;wrongSideSince=0;lastAction="SELL VWAP RETEST";}return;}
   if(state==BUY_RET){retestExtreme=MathMin(retestExtreme,price);if(RetestTimeoutMinutes>0&&retestStart>0&&TimeCurrent()-retestStart>RetestTimeoutMinutes*60){ResetSignal();return;}if(price<vwap-wrongDepth){if(wrongSideSince==0)wrongSideSince=TimeCurrent();if(TimeCurrent()-wrongSideSince>=MathMax(1,VWAPWrongSideSeconds)){ResetSignal();return;}}else if(price>=vwap)wrongSideSince=0;bool reclaimed=price>=vwap+reclaim,bounced=price>=retestExtreme+reclaim;if(reclaimed&&bounced)ExecuteSignal(SIG_BUY);return;}
   if(state==SELL_RET){retestExtreme=MathMax(retestExtreme,price);if(RetestTimeoutMinutes>0&&retestStart>0&&TimeCurrent()-retestStart>RetestTimeoutMinutes*60){ResetSignal();return;}if(price>vwap+wrongDepth){if(wrongSideSince==0)wrongSideSince=TimeCurrent();if(TimeCurrent()-wrongSideSince>=MathMax(1,VWAPWrongSideSeconds)){ResetSignal();return;}}else if(price<=vwap)wrongSideSince=0;bool reclaimed=price<=vwap-reclaim,dropped=price<=retestExtreme-reclaim;if(reclaimed&&dropped)ExecuteSignal(SIG_SELL);return;}
}

void NewM1(){datetime c=iTime(_Symbol,TriggerTF,0);if(c<=0||c==lastM1)return;lastM1=c;double x=0;if(AvgRange(TriggerTF,1,SlowM1Lookback,x))slowM1=x;if(AvgRange(TriggerTF,1,FastM1Lookback,x))fastM1=x;}
void NewM5(){datetime c=iTime(_Symbol,MapTF,0);if(c<=0||c==lastM5)return;lastM5=c;RebuildVWAP();double x=0;if(AvgRange(MapTF,1,M5RangeLookback,x))avgM5=x;ReviewEMA();}

string StateName(){switch(state){case BUY_DEP:return"BUY DEPARTED";case BUY_RET:return"BUY RETEST";case SELL_DEP:return"SELL DEPARTED";case SELL_RET:return"SELL RETEST";default:return"IDLE";}}

void Panel(const MqlTick &t)
{
   ulong now=GetTickCount64();if(lastPanelMs>0&&now-lastPanelMs<(ulong)MathMax(50,PanelUpdateMilliseconds))return;lastPanelMs=now;
   ulong tk;ENUM_POSITION_TYPE ty;double op,pf;string pos="NONE";if(FindPos(tk,ty,op,pf))pos=(ty==POSITION_TYPE_BUY?"BUY":"SELL")+string(runnerLocked?" | MOUNTAIN LOCK":" | BUILDING");
   double lots=NormVol(Lots),money=0,fr=Friction(t,lots,money);
   Comment("VWAP + EMA8 MOUNTAIN RUNNER v5.31\n","POSITION: ",pos,"\nSTATE: ",StateName(),"\nVWAP: ",(haveVWAP?DoubleToString(liveVWAP,_Digits):"n/a"),"\nRUNNER: ",runnerHealth,"\nMFE: ",DoubleToString(mfe,2),"\nM5 AVG RANGE: ",DoubleToString(avgM5,2),"\nLOCK AT 1.50x: ",DoubleToString(avgM5*RunnerActivateM5Ranges,2),"\nEMA WRONG CLOSES: ",IntegerToString(emaWrongCloses),"\nEMA CLEAR BREAK: ",DoubleToString(EMAClearBreakM5RangeFrac,2),"\nADAPTIVE RANGE: ",DoubleToString(adaptiveRange,2),"\nEST RT COST: ",DoubleToString(money,4),"\nFRICTION DIST: ",DoubleToString(fr,2),"\nLAST: ",lastAction);
}

int OnInit()
{
   if(MapTF!=PERIOD_M5||TriggerTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;
   emaHandle=iMA(_Symbol,MapTF,EMAPeriod,0,MODE_EMA,PRICE_CLOSE);if(emaHandle==INVALID_HANDLE)return INIT_FAILED;
   trade.SetExpertMagicNumber(Magic);trade.SetDeviationInPoints(DeviationPoints);trade.SetTypeFillingBySymbol(_Symbol);trade.SetAsyncMode(false);
   RefreshRanges();RebuildVWAP();MqlTick t;if(SymbolInfoTick(_Symbol,t)){RecordTick(t);UpdateVWAP();Adaptive(t.time_msc);}
   Log("INIT V5.31 | young fail->flat | lock 1.50x M5 | clear EMA exit 0.25x M5");return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){if(emaHandle!=INVALID_HANDLE)IndicatorRelease(emaHandle);Comment("");}
void OnTick(){MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;RecordTick(t);NewM1();NewM5();if(!UpdateVWAP())return;UpdateRunner(t);ProcessSignal(t);Panel(t);}
