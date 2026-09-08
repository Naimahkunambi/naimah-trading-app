//+------------------------------------------------------------------+
//| VWAP_EMA8_SniperHold_V5_4.mq5                                  |
//| v5.40                                                            |
//| VWAP = direction + retest/reclaim entry                          |
//| EMA8 M5 = hold/exit manager                                      |
//| Young trades breathe; good jumps engage SNIPER HOLD;             |
//| mountains HARD LOCK; all exits go FLAT before fresh VWAP.        |
//+------------------------------------------------------------------+
#property strict
#property version "5.40"
#include <Trade/Trade.mqh>
CTrade trade;
#define V54_TICK_BUFFER 4096

input double InpV54_Lots=0.01;
input ulong InpV54_Magic=26090954;
input int InpV54_DeviationPoints=30;
input int InpV54_EmergencySLPoints=0;
input ENUM_TIMEFRAMES InpV54_MapTF=PERIOD_M5;
input ENUM_TIMEFRAMES InpV54_TriggerTF=PERIOD_M1;
input int InpV54_EMAPeriod=8;
input int InpV54_VWAPResetHour=0;
input bool InpV54_PreferRealVolume=false;
input int InpV54_SlowM1Lookback=20;
input int InpV54_FastM1Lookback=5;
input int InpV54_LiveVolWindowSeconds=30;
input int InpV54_LiveVolMinTicks=5;
input double InpV54_LiveVolWeight=1.00;
input double InpV54_FastM1Weight=0.60;
input double InpV54_MinAdaptiveVsSlow=0.45;
input double InpV54_MaxAdaptiveVsSlow=3.00;
input int InpV54_M5RangeLookback=12;
input double InpV54_DepartureAdaptiveFrac=0.60;
input double InpV54_RetestBandAdaptiveFrac=0.25;
input double InpV54_ReclaimAdaptiveFrac=0.18;
input double InpV54_VWAPWrongDepthAdaptiveFrac=0.18;
input int InpV54_VWAPWrongSideSeconds=20;
input int InpV54_RetestTimeoutMinutes=10;

// SNIPER HOLD controls
input int InpV54_YoungMinHoldSeconds=120;
input double InpV54_YoungAdverseAdaptiveFrac=0.75;
input double InpV54_SniperHoldM5Ranges=0.80;
input double InpV54_HardLockM5Ranges=2.00;
input int InpV54_SoftEMAExitWrongCloses=3;
input double InpV54_SoftEMADeepBreakM5RangeFrac=1.00;
input int InpV54_HardEMAExitWrongCloses=2;
input double InpV54_HardEMADeepBreakM5RangeFrac=0.75;

// Trading friction
input double InpV54_CommissionPerLotRT=58.0;
input double InpV54_CostSafetyMultiple=1.25;
input int InpV54_ExpectedSlippagePoints=0;
input int InpV54_PanelUpdateMilliseconds=500;
input bool InpV54_VerboseLog=true;

enum V54_SETUP_STATE{V54_IDLE=0,V54_BUY_DEPARTED,V54_BUY_RETEST,V54_SELL_DEPARTED,V54_SELL_RETEST};
enum V54_SIGNAL{V54_SIGNAL_NONE=0,V54_SIGNAL_BUY,V54_SIGNAL_SELL};

V54_SETUP_STATE g_state=V54_IDLE;
int g_emaHandle=INVALID_HANDLE;
datetime g_lastM1Bar=0,g_lastM5Bar=0;
double g_slowM1Range=0.0,g_fastM1Range=0.0,g_avgM5Range=0.0;
long g_tickTimeMsc[V54_TICK_BUFFER];
double g_tickBid[V54_TICK_BUFFER];
int g_tickHead=0,g_tickStored=0;
double g_liveTickRange=0.0,g_adaptiveRange=0.0;
datetime g_vwapSessionStart=0;
double g_vwapCompletedPV=0.0,g_vwapCompletedVol=0.0,g_liveVWAP=0.0;
bool g_haveLiveVWAP=false;
datetime g_retestStart=0,g_wrongSideSince=0;
double g_retestExtreme=0.0;
datetime g_positionOpenTime=0;
double g_mfe=0.0;
bool g_sniperHold=false,g_hardLock=false;
int g_emaWrongCloses=0;
string g_runnerHealth="FLAT",g_lastAction="Waiting";
double g_lastFrictionDistance=0.0,g_lastEstimatedRTCostMoney=0.0;
ulong g_lastPanelMs=0;

void Log(string s){if(InpV54_VerboseLog) Print("[SNIPER V5.40] ",s);}

datetime SessionStart(datetime when){MqlDateTime d;TimeToStruct(when,d);int h=d.hour;d.hour=InpV54_VWAPResetHour;d.min=0;d.sec=0;datetime x=StructToTime(d);if(h<InpV54_VWAPResetHour)x-=86400;return x;}
bool GetBar(ENUM_TIMEFRAMES tf,int shift,MqlRates &b){MqlRates a[1];if(CopyRates(_Symbol,tf,shift,1,a)!=1)return false;b=a[0];return true;}
double BarVol(const MqlRates &b){if(InpV54_PreferRealVolume&&b.real_volume>0)return(double)b.real_volume;return(double)b.tick_volume;}

bool AvgRange(ENUM_TIMEFRAMES tf,int shift,int count,double &out){count=MathMax(2,count);MqlRates r[];int n=CopyRates(_Symbol,tf,shift,count,r);if(n!=count)return false;double sum=0;int v=0;for(int i=0;i<n;i++){double z=r[i].high-r[i].low;if(z>0){sum+=z;v++;}}if(v==0)return false;out=sum/v;return true;}

double NormVol(double x){double mn=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),mx=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),st=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);if(st<=0)st=mn;x=MathMax(mn,MathMin(mx,x));if(st>0)x=MathFloor((x-mn+1e-12)/st)*st+mn;return MathMax(mn,MathMin(mx,x));}

void RecordTick(const MqlTick &t){g_tickTimeMsc[g_tickHead]=t.time_msc;g_tickBid[g_tickHead]=t.bid;g_tickHead++;if(g_tickHead>=V54_TICK_BUFFER)g_tickHead=0;if(g_tickStored<V54_TICK_BUFFER)g_tickStored++;}

bool LiveRange(long now,double &range,int &samples){range=0;samples=0;if(g_tickStored<=0)return false;long cutoff=(long)MathMax(1,InpV54_LiveVolWindowSeconds)*1000;double hi=-1e100,lo=1e100;for(int k=0;k<g_tickStored;k++){int i=g_tickHead-1-k;while(i<0)i+=V54_TICK_BUFFER;long age=now-g_tickTimeMsc[i];if(age<0)continue;if(age>cutoff)break;double p=g_tickBid[i];if(p>hi)hi=p;if(p<lo)lo=p;samples++;}if(samples<MathMax(2,InpV54_LiveVolMinTicks))return false;range=MathMax(0.0,hi-lo);return true;}

void RefreshRanges(){double x;if(AvgRange(InpV54_TriggerTF,1,InpV54_SlowM1Lookback,x))g_slowM1Range=x;if(AvgRange(InpV54_TriggerTF,1,InpV54_FastM1Lookback,x))g_fastM1Range=x;if(AvgRange(InpV54_MapTF,1,InpV54_M5RangeLookback,x))g_avgM5Range=x;}

double AdaptiveRange(long now){double s=g_slowM1Range,f=g_fastM1Range,b=0;if(s>0&&f>0){double w=MathMax(0.0,MathMin(1.0,InpV54_FastM1Weight));b=s*(1-w)+f*w;}else b=(f>0?f:s);double lr=0;int n=0;if(LiveRange(now,lr,n)){g_liveTickRange=lr;b=MathMax(b,lr*MathMax(0.0,InpV54_LiveVolWeight));}else g_liveTickRange=0;if(s>0){double mn=s*MathMax(0.05,InpV54_MinAdaptiveVsSlow),mx=s*MathMax(InpV54_MinAdaptiveVsSlow,InpV54_MaxAdaptiveVsSlow);b=MathMax(mn,MathMin(mx,b));}g_adaptiveRange=b;return b;}

bool RebuildVWAP(){datetime cur=iTime(_Symbol,InpV54_MapTF,0);if(cur<=0)return false;datetime ss=SessionStart(cur);g_vwapSessionStart=ss;g_vwapCompletedPV=0;g_vwapCompletedVol=0;if(cur<=ss)return true;MqlRates r[];int n=CopyRates(_Symbol,InpV54_MapTF,ss,cur-1,r);if(n<=0)return true;for(int i=0;i<n;i++){double v=BarVol(r[i]);if(v<=0)continue;double p=(r[i].high+r[i].low+r[i].close)/3.0;g_vwapCompletedPV+=p*v;g_vwapCompletedVol+=v;}return true;}

bool UpdateVWAP(){MqlRates b;if(!GetBar(InpV54_MapTF,0,b)){g_haveLiveVWAP=false;return false;}datetime ss=SessionStart(b.time);if(g_vwapSessionStart!=ss&&!RebuildVWAP()){g_haveLiveVWAP=false;return false;}double pv=g_vwapCompletedPV,vv=g_vwapCompletedVol,v=BarVol(b);if(v>0){double p=(b.high+b.low+b.close)/3.0;pv+=p*v;vv+=v;}if(vv<=0){g_haveLiveVWAP=false;return false;}g_liveVWAP=pv/vv;g_haveLiveVWAP=true;return true;}

bool GetEMA(int shift,double &ema){double v[1];if(g_emaHandle==INVALID_HANDLE||CopyBuffer(g_emaHandle,0,shift,1,v)!=1||v[0]==EMPTY_VALUE)return false;ema=v[0];return true;}

bool FindPos(ulong &ticket,ENUM_POSITION_TYPE &type,double &open,double &profit){for(int i=PositionsTotal()-1;i>=0;i--){ulong t=PositionGetTicket(i);if(t==0||!PositionSelectByTicket(t))continue;if(PositionGetString(POSITION_SYMBOL)!=_Symbol)continue;if((ulong)PositionGetInteger(POSITION_MAGIC)!=InpV54_Magic)continue;ticket=t;type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);open=PositionGetDouble(POSITION_PRICE_OPEN);profit=PositionGetDouble(POSITION_PROFIT);return true;}return false;}
bool HasPos(){ulong t;ENUM_POSITION_TYPE y;double o,p;return FindPos(t,y,o,p);}

double TickValue(){double v=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);if(v>0)return v;double a=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT),b=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);if(a>0&&b>0)return(a+b)*0.5;return MathMax(a,b);}

double Friction(const MqlTick &t,double lots,double &money){double spread=MathMax(0.0,t.ask-t.bid),tickSize=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),tickValue=TickValue(),commDist=0,spreadMoney=0,commMoney=MathMax(0.0,InpV54_CommissionPerLotRT)*lots;if(tickSize>0&&tickValue>0){double m=tickValue/tickSize;if(m>0)commDist=MathMax(0.0,InpV54_CommissionPerLotRT)/m;spreadMoney=(spread/tickSize)*tickValue*lots;}double slip=MathMax(0,InpV54_ExpectedSlippagePoints)*_Point,slipMoney=0;if(tickSize>0&&tickValue>0)slipMoney=(slip/tickSize)*tickValue*lots;g_lastFrictionDistance=spread+commDist+slip;g_lastEstimatedRTCostMoney=spreadMoney+commMoney+slipMoney;money=g_lastEstimatedRTCostMoney;return g_lastFrictionDistance;}

bool TradeOK(){uint r=trade.ResultRetcode();return r==TRADE_RETCODE_DONE||r==TRADE_RETCODE_DONE_PARTIAL||r==TRADE_RETCODE_PLACED;}
void ResetSignal(){g_state=V54_IDLE;g_retestStart=0;g_wrongSideSince=0;g_retestExtreme=0;}
void ResetRunner(){g_positionOpenTime=TimeCurrent();g_mfe=0;g_sniperHold=false;g_hardLock=false;g_emaWrongCloses=0;g_runnerHealth="NEW POSITION - BREATHE";}

bool OpenBuy(){if(HasPos())return false;MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double sl=0;if(InpV54_EmergencySLPoints>0)sl=NormalizeDouble(t.ask-InpV54_EmergencySLPoints*_Point,_Digits);bool ok=trade.Buy(NormVol(InpV54_Lots),_Symbol,0,sl,0,"V54_SNIPER_BUY");if(!ok||!TradeOK()){Log("BUY failed: "+trade.ResultRetcodeDescription());return false;}ResetSignal();ResetRunner();g_lastAction="BUY OPENED - SNIPER BREATHING";Log(g_lastAction);return true;}

bool OpenSell(){if(HasPos())return false;MqlTick t;if(!SymbolInfoTick(_Symbol,t))return false;double sl=0;if(InpV54_EmergencySLPoints>0)sl=NormalizeDouble(t.bid+InpV54_EmergencySLPoints*_Point,_Digits);bool ok=trade.Sell(NormVol(InpV54_Lots),_Symbol,0,sl,0,"V54_SNIPER_SELL");if(!ok||!TradeOK()){Log("SELL failed: "+trade.ResultRetcodeDescription());return false;}ResetSignal();ResetRunner();g_lastAction="SELL OPENED - SNIPER BREATHING";Log(g_lastAction);return true;}

bool CloseFlat(ulong ticket,string why){bool ok=trade.PositionClose(ticket);if(!ok||!TradeOK()){Log("CLOSE failed: "+trade.ResultRetcodeDescription());return false;}g_lastAction=why;Log(why);ResetSignal();g_positionOpenTime=0;g_mfe=0;g_sniperHold=false;g_hardLock=false;g_emaWrongCloses=0;g_runnerHealth="FLAT";return true;}

void UpdateRunner(const MqlTick &t){ulong k;ENUM_POSITION_TYPE y;double o,p;if(!FindPos(k,y,o,p)){g_mfe=0;g_sniperHold=false;g_hardLock=false;return;}double x=(y==POSITION_TYPE_BUY?t.bid:t.ask),fav=(y==POSITION_TYPE_BUY?x-o:o-x);if(fav>g_mfe)g_mfe=fav;if(!g_sniperHold&&g_avgM5Range>0&&g_mfe>=g_avgM5Range*MathMax(0.10,InpV54_SniperHoldM5Ranges)){g_sniperHold=true;g_emaWrongCloses=0;g_runnerHealth="SNIPER HOLD - NO VWAP FLIP";g_lastAction="SNIPER HOLD ENGAGED";Log("SNIPER HOLD ENGAGED - good jump achieved; stop flip-flopping");}if(!g_hardLock&&g_avgM5Range>0&&g_mfe>=g_avgM5Range*MathMax(InpV54_SniperHoldM5Ranges,InpV54_HardLockM5Ranges)){g_hardLock=true;g_sniperHold=true;g_emaWrongCloses=0;g_runnerHealth="HARD MOUNTAIN LOCK - EMA8 OWNS EXIT";g_lastAction="HARD MOUNTAIN LOCK";Log("HARD MOUNTAIN LOCK - hold until real EMA8 loss");}}

void ReviewEMA(){ulong k;ENUM_POSITION_TYPE y;double o,p;if(!FindPos(k,y,o,p)){g_emaWrongCloses=0;g_runnerHealth="FLAT";return;}if(!g_sniperHold){g_emaWrongCloses=0;g_runnerHealth="YOUNG - GIVE IT ROOM";return;}MqlRates b;double ema;if(!GetBar(InpV54_MapTF,1,b)||!GetEMA(1,ema))return;bool wrong=false;double depth=0;if(y==POSITION_TYPE_BUY){wrong=b.close<ema;if(wrong)depth=ema-b.close;}else{wrong=b.close>ema;if(wrong)depth=b.close-ema;}if(!wrong){g_emaWrongCloses=0;g_runnerHealth=(g_hardLock?"HARD LOCK EMA8 RESPECTED - HOLD":"SNIPER EMA8 RESPECTED - HOLD");return;}g_emaWrongCloses++;double frac=(g_avgM5Range>0?depth/g_avgM5Range:0);int need=(g_hardLock?MathMax(1,InpV54_HardEMAExitWrongCloses):MathMax(1,InpV54_SoftEMAExitWrongCloses));double deep=(g_hardLock?MathMax(0.0,InpV54_HardEMADeepBreakM5RangeFrac):MathMax(0.0,InpV54_SoftEMADeepBreakM5RangeFrac));if(frac>=deep||g_emaWrongCloses>=need){string why=(g_hardLock?"HARD LOCK":"SNIPER HOLD")+string(frac>=deep?" EMA8 EXIT - deep break":" EMA8 EXIT - confirmed loss");if(CloseFlat(k,why)){g_lastAction=why+" | FLAT, WAIT FRESH VWAP";Log("NO INSTANT REVERSE");}return;}g_runnerHealth=(g_hardLock?"HARD LOCK EMA BREATHING ":"SNIPER EMA BREATHING ")+IntegerToString(g_emaWrongCloses)+"/"+IntegerToString(need);}

bool AllowBuy(){ulong k;ENUM_POSITION_TYPE y;double o,p;if(!FindPos(k,y,o,p))return true;if(g_sniperHold||g_hardLock)return false;return y==POSITION_TYPE_SELL;}
bool AllowSell(){ulong k;ENUM_POSITION_TYPE y;double o,p;if(!FindPos(k,y,o,p))return true;if(g_sniperHold||g_hardLock)return false;return y==POSITION_TYPE_BUY;}

bool ExecuteSignal(V54_SIGNAL s,const MqlTick &t){if(s==V54_SIGNAL_NONE)return false;ulong k;ENUM_POSITION_TYPE y;double o,p;bool have=FindPos(k,y,o,p);if(!have)return(s==V54_SIGNAL_BUY?OpenBuy():OpenSell());if(g_sniperHold||g_hardLock){ResetSignal();g_lastAction="OPPOSITE VWAP IGNORED - SNIPER HOLD";return false;}if((y==POSITION_TYPE_BUY&&s==V54_SIGNAL_BUY)||(y==POSITION_TYPE_SELL&&s==V54_SIGNAL_SELL)){ResetSignal();return false;}int age=(g_positionOpenTime>0?(int)(TimeCurrent()-g_positionOpenTime):0);if(age<MathMax(0,InpV54_YoungMinHoldSeconds)){ResetSignal();g_lastAction="YOUNG OPPOSITE SIGNAL IGNORED - MIN HOLD";return false;}double x=(y==POSITION_TYPE_BUY?t.bid:t.ask);double adverse=(y==POSITION_TYPE_BUY?o-x:x-o);adverse=MathMax(0.0,adverse);double a=MathMax(g_adaptiveRange,g_fastM1Range),money=0,fr=Friction(t,NormVol(InpV54_Lots),money);double wrong=MathMax(a*MathMax(0.0,InpV54_YoungAdverseAdaptiveFrac),fr*MathMax(1.0,InpV54_CostSafetyMultiple));if(adverse<wrong){ResetSignal();g_lastAction="OPPOSITE VWAP SEEN BUT TRADE NOT MATERIALY WRONG - HOLD";return false;}string why=(y==POSITION_TYPE_BUY?"YOUNG BUY INVALIDATED - CLOSE FLAT":"YOUNG SELL INVALIDATED - CLOSE FLAT");if(CloseFlat(k,why)){g_lastAction=why+" | WAIT FRESH VWAP";return true;}return false;}

void ProcessSignal(const MqlTick &t){if(!g_haveLiveVWAP)return;if(HasPos()&&(g_sniperHold||g_hardLock)){if(g_state!=V54_IDLE)ResetSignal();return;}double price=t.bid,vwap=g_liveVWAP,a=AdaptiveRange(t.time_msc);if(a<=0)return;double naturalDep=a*MathMax(0.0,InpV54_DepartureAdaptiveFrac),band=a*MathMax(0.0,InpV54_RetestBandAdaptiveFrac),naturalRec=a*MathMax(0.0,InpV54_ReclaimAdaptiveFrac),wrongDepth=a*MathMax(0.0,InpV54_VWAPWrongDepthAdaptiveFrac),money=0,fr=Friction(t,NormVol(InpV54_Lots),money),cost=fr*MathMax(1.0,InpV54_CostSafetyMultiple),dep=MathMax(naturalDep,cost),rec=MathMax(naturalRec,cost);bool buy=AllowBuy(),sell=AllowSell();if(g_state==V54_IDLE){if(buy&&price>=vwap+dep){g_state=V54_BUY_DEPARTED;g_lastAction="BUY SIDE ESTABLISHED";return;}if(sell&&price<=vwap-dep){g_state=V54_SELL_DEPARTED;g_lastAction="SELL SIDE ESTABLISHED";return;}return;}if((g_state==V54_BUY_DEPARTED||g_state==V54_BUY_RETEST)&&!buy){ResetSignal();return;}if((g_state==V54_SELL_DEPARTED||g_state==V54_SELL_RETEST)&&!sell){ResetSignal();return;}if(g_state==V54_BUY_DEPARTED){if(price<=vwap+band){g_state=V54_BUY_RETEST;g_retestStart=TimeCurrent();g_retestExtreme=price;g_wrongSideSince=0;g_lastAction="BUY VWAP RETEST";}return;}if(g_state==V54_SELL_DEPARTED){if(price>=vwap-band){g_state=V54_SELL_RETEST;g_retestStart=TimeCurrent();g_retestExtreme=price;g_wrongSideSince=0;g_lastAction="SELL VWAP RETEST";}return;}if(g_state==V54_BUY_RETEST){g_retestExtreme=MathMin(g_retestExtreme,price);if(InpV54_RetestTimeoutMinutes>0&&g_retestStart>0&&TimeCurrent()-g_retestStart>InpV54_RetestTimeoutMinutes*60){ResetSignal();return;}if(price<vwap-wrongDepth){if(g_wrongSideSince==0)g_wrongSideSince=TimeCurrent();if(TimeCurrent()-g_wrongSideSince>=MathMax(1,InpV54_VWAPWrongSideSeconds)){ResetSignal();return;}}else if(price>=vwap)g_wrongSideSince=0;if(price>=vwap+rec&&price>=g_retestExtreme+rec)ExecuteSignal(V54_SIGNAL_BUY,t);return;}if(g_state==V54_SELL_RETEST){g_retestExtreme=MathMax(g_retestExtreme,price);if(InpV54_RetestTimeoutMinutes>0&&g_retestStart>0&&TimeCurrent()-g_retestStart>InpV54_RetestTimeoutMinutes*60){ResetSignal();return;}if(price>vwap+wrongDepth){if(g_wrongSideSince==0)g_wrongSideSince=TimeCurrent();if(TimeCurrent()-g_wrongSideSince>=MathMax(1,InpV54_VWAPWrongSideSeconds)){ResetSignal();return;}}else if(price<=vwap)g_wrongSideSince=0;if(price<=vwap-rec&&price<=g_retestExtreme-rec)ExecuteSignal(V54_SIGNAL_SELL,t);return;}}

void NewM1(){datetime c=iTime(_Symbol,InpV54_TriggerTF,0);if(c<=0||c==g_lastM1Bar)return;g_lastM1Bar=c;double x;if(AvgRange(InpV54_TriggerTF,1,InpV54_SlowM1Lookback,x))g_slowM1Range=x;if(AvgRange(InpV54_TriggerTF,1,InpV54_FastM1Lookback,x))g_fastM1Range=x;}
void NewM5(){datetime c=iTime(_Symbol,InpV54_MapTF,0);if(c<=0||c==g_lastM5Bar)return;g_lastM5Bar=c;RebuildVWAP();double x;if(AvgRange(InpV54_MapTF,1,InpV54_M5RangeLookback,x))g_avgM5Range=x;ReviewEMA();}

string StateName(){switch(g_state){case V54_BUY_DEPARTED:return"BUY DEPARTED";case V54_BUY_RETEST:return"BUY RETEST";case V54_SELL_DEPARTED:return"SELL DEPARTED";case V54_SELL_RETEST:return"SELL RETEST";default:return"IDLE";}}

void Panel(const MqlTick &t){ulong now=GetTickCount64();if(g_lastPanelMs>0&&now-g_lastPanelMs<(ulong)MathMax(50,InpV54_PanelUpdateMilliseconds))return;g_lastPanelMs=now;ulong k;ENUM_POSITION_TYPE y;double o,p;string pos="NONE";if(FindPos(k,y,o,p)){string phase=" | YOUNG";if(g_sniperHold)phase=" | SNIPER HOLD";if(g_hardLock)phase=" | HARD LOCK";pos=(y==POSITION_TYPE_BUY?"BUY":"SELL")+phase;}double money=0,fr=Friction(t,NormVol(InpV54_Lots),money);Comment("VWAP + EMA8 SNIPER HOLD v5.40\nPOSITION: ",pos,"\nSTATE: ",StateName(),"\nVWAP: ",(g_haveLiveVWAP?DoubleToString(g_liveVWAP,_Digits):"n/a"),"\nRUNNER: ",g_runnerHealth,"\nMFE: ",DoubleToString(g_mfe,2),"\nSNIPER AT: ",DoubleToString(g_avgM5Range*InpV54_SniperHoldM5Ranges,2),"\nHARD LOCK AT: ",DoubleToString(g_avgM5Range*InpV54_HardLockM5Ranges,2),"\nEMA WRONG: ",IntegerToString(g_emaWrongCloses),"\nADAPTIVE RANGE: ",DoubleToString(g_adaptiveRange,2),"\nEST RT COST: ",DoubleToString(money,4),"\nFRICTION: ",DoubleToString(fr,2),"\nLAST: ",g_lastAction);}

int OnInit(){if(InpV54_MapTF!=PERIOD_M5||InpV54_TriggerTF!=PERIOD_M1)return INIT_PARAMETERS_INCORRECT;if(InpV54_Lots<=0||InpV54_SniperHoldM5Ranges<=0||InpV54_HardLockM5Ranges<InpV54_SniperHoldM5Ranges||InpV54_SoftEMAExitWrongCloses<1||InpV54_HardEMAExitWrongCloses<1||InpV54_CostSafetyMultiple<1)return INIT_PARAMETERS_INCORRECT;g_emaHandle=iMA(_Symbol,InpV54_MapTF,InpV54_EMAPeriod,0,MODE_EMA,PRICE_CLOSE);if(g_emaHandle==INVALID_HANDLE)return INIT_FAILED;trade.SetExpertMagicNumber(InpV54_Magic);trade.SetDeviationInPoints(InpV54_DeviationPoints);trade.SetTypeFillingBySymbol(_Symbol);trade.SetAsyncMode(false);RefreshRanges();RebuildVWAP();MqlTick t;if(SymbolInfoTick(_Symbol,t)){RecordTick(t);UpdateVWAP();AdaptiveRange(t.time_msc);}Log("INIT | young trades breathe | sniper hold | hard lock | EMA8 exits to FLAT");return INIT_SUCCEEDED;}
void OnDeinit(const int reason){if(g_emaHandle!=INVALID_HANDLE)IndicatorRelease(g_emaHandle);Comment("");}
void OnTick(){MqlTick t;if(!SymbolInfoTick(_Symbol,t))return;RecordTick(t);NewM1();NewM5();if(!UpdateVWAP())return;UpdateRunner(t);ProcessSignal(t);Panel(t);}
//+------------------------------------------------------------------+
