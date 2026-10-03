#include "core.h"
#include <windowsx.h>
#include <shellapi.h>
#include <commctrl.h>
#include <shlobj.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <d2d1.h>
#include <dwrite.h>
#include <wrl/client.h>
#include <fstream>
#include <filesystem>
#include <sstream>
#include <cmath>

using namespace xc;
using namespace Gdiplus;
namespace {
constexpr wchar_t ClassName[]=L"XgoatCast.Native";
constexpr UINT WM_TRAY=WM_APP+2,WM_AUDIO_APPS=WM_APP+3;
HWND window=nullptr;
std::unique_ptr<Session> session;
std::unique_ptr<ServerMonitor> serverMonitor;
ServerConnection serverConnection=ServerConnection::Checking;
Settings settings;
Microphones microphones;
Snapshot state;
std::shared_ptr<const PreviewFrame> liveFrame;
std::wstring localMessage;
bool localError=false;
Launch launch;
bool hasLaunch=false,registered=false,registrationPrompt=false,registrationDismissed=false,quitting=false,audioLoading=false,smoke=false;
float scale=1;
int page=0,selected=-1,focusIndex=-1,hoverId=-1,pressedId=-1;
int hoverTip=-1;bool tipVisible=false;PointF pointerPos;
std::vector<int> visible;
bool audioPanel=false;
int audioOffset=0;
std::vector<std::wstring> audioNames;
std::wstring audioSearch;
std::map<std::wstring,HICON> appIcons;
std::thread updateThread;
std::atomic<bool> updateChecking=false;
UpdateInfo availableUpdate;
struct UpdateResult { bool interactive=false,ok=false; UpdateInfo info; std::wstring error; };
void act(int id);
void trayMenu();
bool expanded=false,previewMode=false,sourcePreview=false;
int popup=0,menuOffset=0;
void openPopup(int kind);
std::wstring microphoneName();
void systemAction(int id);
void checkForUpdates(bool interactive);
namespace layout {
constexpr float compactWidth=560,compactHeight=480,waitingWidth=480,waitingHeight=260,expandedWidth=1000,expandedHeight=820,titleHeight=56;
const RectF sources(24,132,640,560),sound(712,416,264,220);
const RectF livePreview(16,100,464,266),audioRail(500,140,48,220);
constexpr float statusHeight=56;constexpr int compactAudioRows=5;
constexpr float sourcePitch=210,audioPitch=44;
constexpr int audioRows=5;
}
bool smallPanel();
void resize();
void cancelInput();
float uiWidth(){return expanded?layout::expandedWidth:smallPanel()?layout::waitingWidth:layout::compactWidth;}
float uiHeight(){return expanded?layout::expandedHeight:smallPanel()?layout::waitingHeight:layout::compactHeight;}
void setExpanded(bool value);
void syncLayout(){setExpanded(!smallPanel()&&state.phase!=Phase::Sharing&&state.phase!=Phase::Stopping);RECT r{};GetClientRect(window,&r);if(r.right!=int(uiWidth()*scale)||r.bottom!=int(uiHeight()*scale)){cancelInput();resize();}}
std::wstring audioGroup(const std::wstring&name){if(name==L"kaiheila"||name==L"开黑啦")return L"kook";if(name==L"heychat"||name==L"黑盒语音")return L"heyboxchat";if(name==L"discordptb"||name==L"discordcanary")return L"discord";return name;}
std::vector<int> filteredApps(){std::vector<int> result;for(int i=0;i<(int)audioNames.size();++i)if(audioSearch.empty()||audioNames[i].find(stem(audioSearch))!=std::wstring::npos)result.push_back(i);return result;}
struct Hit {RectF rect;int id;};
std::vector<Hit> hits;
struct Tip {RectF rect;int id;std::wstring value;};
std::vector<Tip> tips;
std::thread appsThread;
HICON icon=nullptr,smallIcon=nullptr,genericIcon=nullptr;
void refreshWindowIcons(UINT dpi);

// Semantic roles. Decorative material highlights are separate from UI boundaries.
namespace ui {
const Color surfaceDefault(255,242,242,240),surfaceElevated(255,229,230,227);
const Color textPrimary(255,32,33,31),textSecondary(255,91,94,89);
const Color interactiveDefault(255,38,40,37),interactiveHover(255,52,54,50),interactiveActive(255,24,26,23);
const Color success(255,48,105,75),warning(255,137,82,22),error(255,160,52,45),info(255,54,91,130);
const Color borderDefault(255,115,121,113),seam(255,201,204,197),onInteractive(255,255,255,253);
const Color accentSurface(255,255,96,20),highlight(255,255,255,253),recess(255,220,226,219);
const Color selectedSurface(255,255,238,227),selectedBorder(255,173,81,32);
const Color controlTrack(255,226,228,223),controlHover(255,217,221,213),controlDisabled(255,235,236,232);
constexpr float controlRadius=4;
}
const Color orange=ui::accentSurface,text=ui::textPrimary,muted=ui::textSecondary,dim=ui::textSecondary;
const Color orangeInk(255,57,29,14),canvas=ui::surfaceDefault,paper=ui::highlight,line=ui::borderDefault,peach=ui::selectedSurface;
struct Motion {float from=0,to=0;ULONGLONG at=0;};
std::map<int,Motion> motions;
bool motionAllowed=true;
float motionValue(const Motion&m){float t=motionAllowed?std::min(1.f,(GetTickCount64()-m.at)/150.f):1.f;float ease=1-(1-t)*(1-t)*(1-t);return m.from+(m.to-m.from)*ease;}
float motion(int id,float target){auto [it,added]=motions.try_emplace(id,Motion{target,target,GetTickCount64()});auto&m=it->second;if(m.to!=target){m.from=motionValue(m);m.to=target;m.at=GetTickCount64();if(motionAllowed)SetTimer(window,4,16,nullptr);}return motionValue(m);}
Color blend(Color a,Color b,float t){return Color(BYTE(a.GetA()+(b.GetA()-a.GetA())*t),BYTE(a.GetR()+(b.GetR()-a.GetR())*t),BYTE(a.GetG()+(b.GetG()-a.GetG())*t),BYTE(a.GetB()+(b.GetB()-a.GetB())*t));}
std::wstring exePath(){std::wstring p(32768,0);DWORD n=GetModuleFileNameW(nullptr,p.data(),(DWORD)p.size());p.resize(n);return p;}
std::wstring regRead(const wchar_t* key,const wchar_t* name=nullptr){DWORD bytes=0;if(RegGetValueW(HKEY_CURRENT_USER,key,name,RRF_RT_REG_SZ,nullptr,nullptr,&bytes)!=ERROR_SUCCESS)return {};std::wstring s(bytes/sizeof(wchar_t),0);if(RegGetValueW(HKEY_CURRENT_USER,key,name,RRF_RT_REG_SZ,nullptr,s.data(),&bytes)!=ERROR_SUCCESS)return {};while(!s.empty()&&!s.back())s.pop_back();return s;}
void regWrite(const wchar_t* path,const wchar_t* name,const std::wstring& value){HKEY k=nullptr;auto result=RegCreateKeyExW(HKEY_CURRENT_USER,path,0,nullptr,0,KEY_SET_VALUE,nullptr,&k,nullptr);if(result!=ERROR_SUCCESS)throw std::runtime_error("无法注册网页唤起");result=RegSetValueExW(k,name,0,REG_SZ,reinterpret_cast<const BYTE*>(value.c_str()),(DWORD)((value.size()+1)*sizeof(wchar_t)));RegCloseKey(k);if(result!=ERROR_SUCCESS)throw std::runtime_error("无法保存网页唤起设置");}
std::wstring protocolCommand(){return L"\""+exePath()+L"\" \"%1\"";}
bool protocolRegistered(){return regRead(L"Software\\Classes\\xgoatcast\\shell\\open\\command")==protocolCommand();}
bool autoStart(){return regRead(L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",L"XgoatCast")==L"\""+exePath()+L"\" --tray";}
void registerProtocol(bool replaceExisting=false){
  auto previous=regRead(L"Software\\Classes\\xgoatcast\\shell\\open\\command");
  if(!replaceExisting&&!previous.empty()&&previous!=protocolCommand()&&MessageBoxW(window,L"网页唤起已指向另一份客户端，是否改为当前这一份？",L"启用网页唤起",MB_YESNO|MB_ICONQUESTION)!=IDYES)return;
  regWrite(L"Software\\Classes\\xgoatcast",nullptr,L"URL:XgoatCast");regWrite(L"Software\\Classes\\xgoatcast",L"URL Protocol",L"");
  regWrite(L"Software\\Classes\\xgoatcast\\DefaultIcon",nullptr,L"\""+exePath()+L"\",0");
  regWrite(L"Software\\Classes\\xgoatcast\\shell\\open\\command",nullptr,protocolCommand());
  registered=protocolRegistered();registrationPrompt=false;localMessage=L"网页唤起已启用";
}
void unregisterProtocol(){if(protocolRegistered())RegDeleteTreeW(HKEY_CURRENT_USER,L"Software\\Classes\\xgoatcast");if(autoStart()){HKEY key;if(RegOpenKeyExW(HKEY_CURRENT_USER,L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,KEY_SET_VALUE,&key)==ERROR_SUCCESS){RegDeleteValueW(key,L"XgoatCast");RegCloseKey(key);}}registered=false;localMessage=L"已取消本程序的网页唤起和开机启动";}
bool busy(){return state.phase==Phase::Starting||state.phase==Phase::Sharing||state.phase==Phase::Stopping||state.phase==Phase::Loading;}
void persist(){if(previewMode)return;try{saveSettings(settings);settings.loaded=true;}catch(const std::exception&e){localError=true;localMessage=wide(e.what());}}
void resize(){RECT r;GetWindowRect(window,&r);MONITORINFO mi{sizeof(mi)};GetMonitorInfoW(MonitorFromWindow(window,MONITOR_DEFAULTTONEAREST),&mi);
  if(!previewMode)scale=std::min(GetDpiForWindow(window)/96.f,std::min((mi.rcWork.right-mi.rcWork.left)/uiWidth(),(mi.rcWork.bottom-mi.rcWork.top)/uiHeight()));
  int w=int(uiWidth()*scale),h=int(uiHeight()*scale);SetWindowPos(window,nullptr,std::max(mi.rcWork.left,std::min(r.left,mi.rcWork.right-w)),std::max(mi.rcWork.top,std::min(r.top,mi.rcWork.bottom-h)),w,h,SWP_NOZORDER|SWP_NOACTIVATE);}
void cancelInput(){popup=0;hits.clear();tips.clear();hoverId=pressedId=focusIndex=-1;hoverTip=-1;tipVisible=false;KillTimer(window,6);if(GetCapture()==window)ReleaseCapture();}
void updateAudioNames(std::vector<std::wstring> next){if(next!=audioNames){cancelInput();audioNames=std::move(next);}InvalidateRect(window,nullptr,FALSE);}
void setExpanded(bool value){if(value&&!hasLaunch)return;if(expanded==value)return;expanded=value;cancelInput();
  resize();InvalidateRect(window,nullptr,FALSE);UpdateWindow(window);}
void show(){ShowWindow(window,SW_RESTORE);SetForegroundWindow(window);InvalidateRect(window,nullptr,FALSE);}
std::unique_ptr<GraphicsPath> rounded(RectF r,float radius){auto p=std::make_unique<GraphicsPath>();float d=radius*2;p->AddArc(r.X,r.Y,d,d,180,90);p->AddArc(r.GetRight()-d,r.Y,d,d,270,90);p->AddArc(r.GetRight()-d,r.GetBottom()-d,d,d,0,90);p->AddArc(r.X,r.GetBottom()-d,d,d,90,90);p->CloseFigure();return p;}
void fill(Graphics&g,RectF r,Color color,float radius=3){
  auto p=rounded(r,radius);
  bool neutral=color.GetValue()==paper.GetValue()||color.GetValue()==ui::controlTrack.GetValue()||color.GetValue()==ui::controlHover.GetValue()||color.GetValue()==ui::controlDisabled.GetValue();
  if(neutral){LinearGradientBrush face(r,blend(color,paper,.28f),blend(color,ui::recess,.035f),LinearGradientModeVertical);g.FillPath(&face,p.get());}
  else{SolidBrush brush(color);g.FillPath(&brush,p.get());}
}
void stroke(Graphics&g,RectF r,Color color,float width=1,float radius=3){auto p=rounded(r,radius);Pen pen(color,width);g.DrawPath(&pen,p.get());}
void hairline(Graphics&g,float x1,float y1,float x2,float y2,Color c){
  // A fine reflected edge gives the opaque surface depth without adding another frame.
  if(c.GetValue()==ui::seam.GetValue()){Pen sheen(Color(155,255,255,253),1);g.DrawLine(&sheen,x1,y1+1,x2,y2+1);}
  Pen pen(c,1);g.DrawLine(&pen,x1,y1,x2,y2);
}
struct TextRun {std::wstring value;RectF rect;float size;Color color;bool bold,center,wrap;RectF clip;bool numeric=false,symbol=false,emoji=false;};
std::vector<TextRun> textRuns;
void label(Graphics&,const std::wstring&s,RectF r,float size=15,Color color=text,bool bold=false,bool center=false){textRuns.push_back({s,r,size,color,bold,center,false,RectF(0,0,uiWidth(),uiHeight())});}
void glyph(Graphics&g,wchar_t code,RectF r,float size=16,Color ink=text){label(g,std::wstring(1,code),r,size,ink,false,true);textRuns.back().symbol=true;}
float textWidth(const std::wstring&value,float size,bool bold=false,const wchar_t*family=L"Microsoft YaHei UI"){
  using Microsoft::WRL::ComPtr;static ComPtr<IDWriteFactory> write;
  if(!write)check(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED,__uuidof(IDWriteFactory),reinterpret_cast<IUnknown**>(write.GetAddressOf())),"创建文字测量服务");
  ComPtr<IDWriteTextFormat> format;check(write->CreateTextFormat(family,nullptr,DWRITE_FONT_WEIGHT_LIGHT,DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,size,L"zh-CN",format.GetAddressOf()),"创建测量字体");
  ComPtr<IDWriteTextLayout> layout;check(write->CreateTextLayout(value.c_str(),(UINT32)value.size(),format.Get(),4096,128,layout.GetAddressOf()),"测量文字");DWRITE_TEXT_METRICS metrics{};check(layout->GetMetrics(&metrics),"读取文字尺寸");return std::ceil(metrics.widthIncludingTrailingWhitespace);
}
void drawText(HDC dc,const RECT& bounds){
  using Microsoft::WRL::ComPtr;
  static ComPtr<ID2D1Factory> factory;static ComPtr<IDWriteFactory> write;
  static ComPtr<ID2D1DCRenderTarget> target;
  if(!factory){check(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED,factory.GetAddressOf()),"创建绘图服务");check(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED,__uuidof(IDWriteFactory),reinterpret_cast<IUnknown**>(write.GetAddressOf())),"创建字体服务");}
  if(!target){auto props=D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_DEFAULT,D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM,D2D1_ALPHA_MODE_IGNORE),96,96);check(factory->CreateDCRenderTarget(&props,target.GetAddressOf()),"创建文字画布");}
  check(target->BindDC(dc,&bounds),"绑定文字画布");target->BeginDraw();target->SetTransform(D2D1::Matrix3x2F::Scale(scale,scale));target->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_CLEARTYPE);
  ComPtr<IDWriteRenderingParams> defaults,params;write->CreateMonitorRenderingParams(MonitorFromWindow(window,MONITOR_DEFAULTTONEAREST),defaults.GetAddressOf());if(defaults&&SUCCEEDED(write->CreateCustomRenderingParams(defaults->GetGamma(),defaults->GetEnhancedContrast(),defaults->GetClearTypeLevel(),defaults->GetPixelGeometry(),DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC,params.GetAddressOf())))target->SetTextRenderingParams(params.Get());
  for(auto&run:textRuns){
    ComPtr<IDWriteTextFormat> format;check(write->CreateTextFormat(run.emoji?L"Segoe UI Emoji":run.symbol?(windowsBuild()>=22000?L"Segoe Fluent Icons":L"Segoe MDL2 Assets"):run.numeric?L"Bahnschrift":L"Microsoft YaHei UI",nullptr,run.symbol||run.emoji?DWRITE_FONT_WEIGHT_NORMAL:DWRITE_FONT_WEIGHT_LIGHT,DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,run.size,L"zh-CN",format.GetAddressOf()),"创建字体");
    format->SetTextAlignment(run.center?DWRITE_TEXT_ALIGNMENT_CENTER:DWRITE_TEXT_ALIGNMENT_LEADING);format->SetParagraphAlignment(run.wrap?DWRITE_PARAGRAPH_ALIGNMENT_NEAR:DWRITE_PARAGRAPH_ALIGNMENT_CENTER);format->SetWordWrapping(run.wrap?DWRITE_WORD_WRAPPING_WRAP:DWRITE_WORD_WRAPPING_NO_WRAP);
    DWRITE_TRIMMING trimming{DWRITE_TRIMMING_GRANULARITY_CHARACTER,0,0};ComPtr<IDWriteInlineObject> ellipsis;write->CreateEllipsisTrimmingSign(format.Get(),ellipsis.GetAddressOf());format->SetTrimming(&trimming,ellipsis.Get());
    ComPtr<ID2D1SolidColorBrush> brush;target->CreateSolidColorBrush(D2D1::ColorF(run.color.GetR()/255.f,run.color.GetG()/255.f,run.color.GetB()/255.f,run.color.GetA()/255.f),brush.GetAddressOf());
    target->PushAxisAlignedClip(D2D1::RectF(run.clip.X,run.clip.Y,run.clip.GetRight(),run.clip.GetBottom()),D2D1_ANTIALIAS_MODE_ALIASED);
    auto options=D2D1_DRAW_TEXT_OPTIONS(D2D1_DRAW_TEXT_OPTIONS_CLIP|D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
    bool neutralInk=run.color.GetValue()==text.GetValue()||run.color.GetValue()==muted.GetValue();
    if(neutralInk&&!run.symbol&&!run.emoji){
      // A restrained white reflection sits behind the crisp Light glyphs, never a blurred foreground.
      ComPtr<ID2D1SolidColorBrush> reflection;target->CreateSolidColorBrush(D2D1::ColorF(1.f,1.f,.99f,.32f),reflection.GetAddressOf());
      target->DrawText(run.value.c_str(),(UINT32)run.value.size(),format.Get(),D2D1::RectF(run.rect.X,run.rect.Y+.55f,run.rect.GetRight(),run.rect.GetBottom()+.55f),reflection.Get(),options);
      if(run.size>=26){
        reflection->SetOpacity(.12f);
        for(auto offset:{PointF(-.8f,0),PointF(.8f,0),PointF(0,-.8f),PointF(0,.8f)})
          target->DrawText(run.value.c_str(),(UINT32)run.value.size(),format.Get(),D2D1::RectF(run.rect.X+offset.X,run.rect.Y+offset.Y,run.rect.GetRight()+offset.X,run.rect.GetBottom()+offset.Y),reflection.Get(),options);
      }
    }
    target->DrawText(run.value.c_str(),(UINT32)run.value.size(),format.Get(),D2D1::RectF(run.rect.X,run.rect.Y,run.rect.GetRight(),run.rect.GetBottom()),brush.Get(),options);target->PopAxisAlignedClip();
  }
  auto hr=target->EndDraw();if(hr==D2DERR_RECREATE_TARGET){target.Reset();InvalidateRect(window,nullptr,FALSE);}else check(hr,"绘制文字");
}
int remainingSeconds(){
  if(!hasLaunch)return -1;int remaining=-1;
  for(int seconds:{state.idleSeconds,state.noViewerSeconds})if(seconds>=0)remaining=remaining<0?seconds:std::min(remaining,seconds);
  if(remaining<0)return -1;int elapsed=state.observedAt?int((GetTickCount64()-state.observedAt)/1000):0;return std::max(0,remaining-elapsed);
}
bool smallPanel(){
  if(!hasLaunch)return true;
  if(state.phase==Phase::Sharing||state.phase==Phase::Stopping||state.phase==Phase::Starting)return false;
  return localError||state.phase==Phase::Idle||state.phase==Phase::Loading||state.phase==Phase::Failed||remainingSeconds()==0||(state.phase==Phase::Ready&&(state.allowedQualities.empty()||state.sources.empty()));
}
std::wstring countdownText(){int remaining=remainingSeconds();if(remaining<0)return {};
  auto two=[](int n){return (n<10?L"0":L"")+std::to_wstring(n);};return remaining>=3600?two(remaining/3600)+L":"+two(remaining/60%60)+L":"+two(remaining%60):two(remaining/60)+L":"+two(remaining%60);
}
bool canBeginSharing(){return hasLaunch&&!localError&&state.phase==Phase::Ready&&remainingSeconds()!=0&&selected>=0&&selected<(int)state.sources.size()&&std::find(state.allowedQualities.begin(),state.allowedQualities.end(),settings.quality)!=state.allowedQualities.end();}
std::wstring localizedStatus(std::wstring value){
  std::wstring key=value;std::transform(key.begin(),key.end(),key.begin(),[](wchar_t c){return wchar_t(towlower(c));});
  if(key.find(L"share ended")!=std::wstring::npos||key.find(L"session ended")!=std::wstring::npos)return L"共享已结束，请从网页重新发起";
  if(key.find(L"expired")!=std::wstring::npos)return L"共享链接已过期，请从网页重新发起";
  if(key.find(L"unauthorized")!=std::wstring::npos||key.find(L"invalid token")!=std::wstring::npos)return L"共享链接无效，请从网页重新获取";
  if(key.find(L"forbidden")!=std::wstring::npos)return L"没有共享权限，请检查服务器设置";
  if(key.find(L"not found")!=std::wstring::npos)return L"共享会话不存在，请从网页重新发起";
  if(key.find(L"timeout")!=std::wstring::npos||key.find(L"timed out")!=std::wstring::npos)return L"连接超时，请检查网络后重试";
  if(key.find(L"failed to fetch")!=std::wstring::npos||key.find(L"network error")!=std::wstring::npos)return L"网络连接失败，请检查网络后重试";
  bool chinese=std::any_of(value.begin(),value.end(),[](wchar_t c){return c>=0x3400&&c<=0x9fff;});
  if(!value.empty()&&!chinese)return L"服务暂不可用，请从网页重新发起共享";
  return value;
}
void signalDot(Graphics&g,float x,float y,Color color){
  bool white=color.GetValue()==paper.GetValue();
  Color emission=white?Color(255,250,255,251):color.GetValue()==ui::success.GetValue()?Color(255,86,220,151):Color(255,244,108,94);
  Color haze=white?Color(255,148,173,161):emission;
  // Cache the smooth radial falloff, rather than stacking visibly concentric circles on every repaint.
  constexpr int pixels=96;constexpr float diameter=32.f;
  static std::map<ARGB,std::vector<BYTE>> halos;
  auto [it,created]=halos.try_emplace(haze.GetValue());
  if(created){
    auto&data=it->second;data.resize(pixels*pixels*4);
    for(int py=0;py<pixels;++py)for(int px=0;px<pixels;++px){
      float dx=(px+.5f)/3.f-16.f,dy=(py+.5f)/3.f-16.f,d2=dx*dx+dy*dy;
      float a=(white?25.f:48.f)*std::exp(-d2/25.f)+(white?9.f:15.f)*std::exp(-d2/85.f);
      auto index=(py*pixels+px)*4;data[index]=haze.GetB();data[index+1]=haze.GetG();data[index+2]=haze.GetR();data[index+3]=BYTE(std::clamp(a,0.f,255.f));
    }
  }
  Bitmap halo(pixels,pixels,pixels*4,PixelFormat32bppARGB,it->second.data());
  g.DrawImage(&halo,RectF(x-diameter/2,y-diameter/2,diameter,diameter));
  RectF lens(x-3.25f,y-3.25f,6.5f,6.5f);
  LinearGradientBrush light(lens,blend(emission,paper,.66f),white?Color(255,227,238,231):blend(color,emission,.72f),LinearGradientModeVertical);
  g.FillEllipse(&light,lens);Pen edge(white?Color(125,145,167,153):Color(85,color.GetR(),color.GetG(),color.GetB()),.65f);g.DrawEllipse(&edge,lens);
  SolidBrush glint(Color(205,255,255,253));g.FillEllipse(&glint,x-1.35f,y-2.15f,2.1f,1.25f);
}
std::wstring helpFor(int id){
  if(id==1)return L"最小化到任务栏";if(id==2)return L"隐藏窗口，共享会继续运行；可从托盘重新打开";
  if(id==5)return L"打开 Xgoat 共享网页，从网页唤起客户端";if(id==6)return L"网页唤起、开机启动和退出设置";
  if(id==10||id==11||id==12)return busy()?L"停止当前共享后可切换或刷新画面":id==12?L"重新读取可共享的屏幕与窗口":id==10?L"只共享指定窗口":L"共享整块显示器的画面";
  if(id==20||id==21)return !state.allowPreference?L"服务器未开放画面偏好":busy()?L"停止当前共享后可更换画面偏好":id==20?L"画质优先，适合文字和细节":L"帧率优先，适合游戏和动态画面";
  if(id==22)return !state.allowLowLatency?L"服务器未开放低延迟模式":busy()?L"低延迟模式需停止共享后修改":settings.lowLatency?L"低延迟已开启，点击关闭":L"开启低延迟，减少画面等待";
  if(id==30)return (settings.microphone?L"麦克风已开启，点击静音 · ":L"点击开启麦克风 · ")+microphoneName();
  if(id==40&&remainingSeconds()==0&&state.phase!=Phase::Sharing)return L"等待共享已超时，请从网页重新发起";
  if(id==40)return state.phase==Phase::Sharing||state.phase==Phase::Starting?L"停止当前共享":selected<0?L"先选择一个共享画面":busy()?L"正在处理会话，请稍候":L"按当前画面和声音设置开始共享";
  if(id>=50&&id<1000)return busy()?L"停止当前共享后可更换画质":L"仅列出此服务器允许使用的画质";
  if(id>=1000&&id<20000){int index=id-1000;return index<(int)state.sources.size()?state.sources[index].name:L"选择共享画面";}
  if(id>=20000&&id<20000+(int)audioNames.size()){auto name=audioNames[id-20000];return name+(settings.included.count(name)?L" · 已加入共享，点击关闭":L" · 未共享声音，点击加入");}
  return {};
}
void hint(int id,RectF r,std::wstring value={}){if(value.empty())value=helpFor(id);if(!value.empty())tips.push_back({r,id,std::move(value)});}
void paintTooltip(Graphics&g){
  if(!tipVisible)return;auto it=std::find_if(tips.begin(),tips.end(),[](const Tip&t){return t.id==hoverTip;});if(it==tips.end())return;
  float width=std::min(332.f,uiWidth()-24),height=std::clamp(float((it->value.size()+20)/21)*18+24,60.f,uiHeight()-24);float x=std::clamp(pointerPos.X+12,12.f,uiWidth()-width-12),y=pointerPos.Y+18;
  if(y+height>uiHeight()-12)y=std::max(12.f,pointerPos.Y-height-12);
  fill(g,RectF(x,y,width,height),ui::interactiveDefault,8);label(g,it->value,RectF(x+14,y+12,width-28,height-24),13,paper);textRuns.back().wrap=true;
}
void changeTip(int id){if(id==hoverTip)return;hoverTip=id;tipVisible=false;KillTimer(window,6);if(id>=0)SetTimer(window,6,420,nullptr);InvalidateRect(window,nullptr,FALSE);}
void controlGlyph(Graphics&g,int id,float x,float y,Color color){
  wchar_t code=id==11?0xE7F4:id==10?0xE737:id==12?0xE72C:id==6?0xE713:id==5?0xE71B:0xE768;
  glyph(g,code,RectF(x,y,16,16),15,color);
}
void selectionTrack(Graphics&g,RectF r){fill(g,r,ui::controlTrack,ui::controlRadius);}
void button(Graphics&g,int id,RectF r,const std::wstring&s,bool primary=false,bool enabled=true,bool active=false){
  bool selector=id==10||id==11||id==20||id==21||(id>=50&&id<1000);
  bool quiet=id==6||id==12;
  bool stop=id==40&&(state.phase==Phase::Sharing||state.phase==Phase::Starting||state.phase==Phase::Stopping);
  float hover=motion(id*4,enabled&&hoverId==id?1.f:0.f),press=motion(id*4+1,enabled&&pressedId==id&&hoverId==id?1.f:0.f);
  Color ink=enabled?text:muted;
  if(primary){
    Color base=!enabled?ui::controlDisabled:stop?ui::interactiveDefault:orange;
    fill(g,r,blend(blend(base,stop?ui::interactiveHover:Color(255,243,83,10),hover*.65f),stop?ui::interactiveActive:Color(255,226,72,0),press*.7f),ui::controlRadius);
    ink=!enabled?muted:stop?paper:orangeInk;
    float size=r.Height<36?13.f:14.f,iconWidth=stop?8.f:16.f,gap=10.f;
    float contentWidth=std::min(r.Width-24,textWidth(s,size,true)+iconWidth+gap),x=r.X+(r.Width-contentWidth)/2,cy=r.Y+r.Height/2;
    if(stop)fill(g,RectF(x,cy-4,8,8),enabled?orange:muted,1);
    else controlGlyph(g,id,x,cy-7,ink);
    label(g,s,RectF(x+iconWidth+gap,r.Y+press,contentWidth-iconWidth-gap,r.Height),size,ink,true);
  }else if(selector){
    if(active){fill(g,r,enabled?paper:ui::controlDisabled,3);stroke(g,r,enabled?line:ui::seam,1,3);}
    else if(hover>0||press>0)fill(g,r,blend(ui::controlTrack,ui::controlHover,std::max(hover,press)),3);
    if(active&&enabled)ink=text;
    if(id==10||id==11){float x=r.X+(r.Width-52)/2;controlGlyph(g,id,x,r.Y+(r.Height-16)/2,ink);label(g,s,RectF(x+23,r.Y+press,33,r.Height),13,ink,active);}
    else label(g,s,RectF(r.X,r.Y+press,r.Width,r.Height),13,ink,active,true);
  }else{
    if(!quiet||hover>0||press>0)fill(g,r,blend(canvas,ui::controlTrack,std::max(hover,press)),ui::controlRadius);
    if(!quiet)stroke(g,r,ui::seam,1,ui::controlRadius);
    if(quiet){float width=id==6?78.f:52.f,x=r.X+(r.Width-width)/2;controlGlyph(g,id,x,r.Y+(r.Height-16)/2,ink);label(g,s,RectF(x+23,r.Y+press,width-20,r.Height),13,ink);}
    else label(g,s,r,13,ink,false,true);
  }
  if(enabled)hits.push_back({r,id});hint(id,r);
}
void switchFace(Graphics&g,int key,RectF r,bool value,bool enabled=true){
  float hover=motion(key*4,enabled&&hoverId==key?1.f:0.f);
  Color face=enabled?(value?orange:blend(paper,ui::controlTrack,hover*.45f)):ui::controlDisabled;
  fill(g,r,face,3);stroke(g,r,enabled?(value?ui::selectedBorder:hover>0?text:line):ui::seam,1,3);
  hairline(g,r.X+4,r.Y+1.5f,r.GetRight()-4,r.Y+1.5f,Color(110,255,255,253));
  if(value){Pen check(enabled?orangeInk:muted,1.7f);check.SetStartCap(LineCapRound);check.SetEndCap(LineCapRound);g.DrawLine(&check,r.X+5,r.Y+10,r.X+9,r.Y+14);g.DrawLine(&check,r.X+9,r.Y+14,r.X+15,r.Y+6);}
}
void toggle(Graphics&g,int id,RectF r,bool value,bool enabled=true){
  switchFace(g,id,r,value,enabled);if(enabled)hits.push_back({RectF(r.X-4,r.Y-5,r.Width+8,r.Height+10),id});hint(id,RectF(r.X-4,r.Y-5,r.Width+8,r.Height+10));
}
void iconButton(Graphics&g,int id,RectF r,bool close=false){
  float t=motion(id*4,hoverId==id?1.f:0.f);if(t>0)fill(g,r,blend(canvas,close?Color(255,248,220,214):ui::recess,t),3);
  Pen pen(text,1.5f);float cx=r.X+r.Width/2,cy=r.Y+r.Height/2;if(close){g.DrawLine(&pen,cx-4,cy-4,cx+4,cy+4);g.DrawLine(&pen,cx+4,cy-4,cx-4,cy+4);}else g.DrawLine(&pen,cx-5,cy+2,cx+5,cy+2);hits.push_back({r,id});hint(id,r);
}
void micGlyph(Graphics&g,float x,float y,Color color,bool mutedMic){
  Pen pen(color,1.8f);stroke(g,RectF(x+6,y,8,15),color,1.8f,4);g.DrawArc(&pen,RectF(x+2,y+5,16,17),0,180);g.DrawLine(&pen,x+10,y+22,x+10,y+27);g.DrawLine(&pen,x+5,y+27,x+15,y+27);if(mutedMic)g.DrawLine(&pen,x,y+1,x+21,y+25);
}
void sheepLogo(Graphics&g,RectF r){auto path=rounded(r,7);LinearGradientBrush brush(r,Color(255,255,107,53),Color(255,255,140,66),45.f);g.FillPath(&brush,path.get());label(g,L"🐑",r,24,text,false,true);textRuns.back().emoji=true;}

std::wstring qualityName(const std::string&q){static const std::map<std::string,std::wstring> names{{"480p_2",L"480p · 30"},{"720p30",L"720p · 30"},{"1080p_2",L"1080p · 30"},{"1080p60",L"1080p · 60"},{"1440p30",L"1440p · 30"},{"1440p60",L"1440p · 60"},{"4k30",L"4K · 30"}};auto it=names.find(q);return it==names.end()?wide(q):it->second;}
int sourceScrollMax(){return std::max(0,int(((visible.size()+1)/2)*layout::sourcePitch-layout::sources.Height));}
void refreshVisible(){visible.clear();for(int i=0;i<(int)state.sources.size();++i)if(state.sources[i].screen==settings.screens)visible.push_back(i);page=std::clamp(page,0,sourceScrollMax());}
std::wstring selectedSourceName(){return selected>=0&&selected<(int)state.sources.size()?state.sources[selected].name:L"尚未选择画面";}
void drawPreview(Graphics&g){
  auto r=layout::livePreview;fill(g,r,Color(255,25,28,28),3);
  // A static screen may emit no new WGC frames. Lifecycle events invalidate the frame.
  bool current=liveFrame&&!liveFrame->image.empty();
  if(current){auto&frame=*liveFrame;Bitmap bitmap(frame.width,frame.height,frame.width*4,PixelFormat32bppARGB,const_cast<BYTE*>(frame.image.data()));
    auto saved=g.Save();auto clip=rounded(r,3);g.SetClip(clip.get(),CombineModeIntersect);g.SetInterpolationMode(InterpolationModeHighQualityBilinear);
    float f=std::min(r.Width/frame.width,r.Height/frame.height);g.DrawImage(&bitmap,RectF(r.X+(r.Width-frame.width*f)/2,r.Y+(r.Height-frame.height*f)/2,frame.width*f,frame.height*f));g.Restore(saved);
  }else{
    label(g,state.phase==Phase::Stopping?L"正在停止共享":liveFrame?L"预览暂时不可用":L"正在等待共享画面",RectF(r.X+24,r.Y+123,r.Width-48,30),16,paper,false,true);
    label(g,L"此处显示正在共享的画面",RectF(r.X+24,r.Y+158,r.Width-48,24),12,Color(255,181,186,179),false,true);
  }
  stroke(g,r,ui::interactiveDefault,1,3);
}
void paintCompactSound(Graphics&g){
  bool enabled=state.phase==Phase::Sharing;bool supported=windowsBuild()>=20348;
  fill(g,RectF(496,56,64,314),paper,2);hairline(g,496,56,496,370,ui::seam);
  auto audioIcon=[&](int id,RectF r,bool on,HICON icon,bool mic){
    bool available=enabled&&(mic||supported);
    float hover=motion(id*4,available&&hoverId==id?1.f:0.f),press=motion(id*4+1,available&&pressedId==id&&hoverId==id?1.f:0.f);
    Color base=on?ui::selectedSurface:paper;fill(g,r,blend(base,ui::controlTrack,std::max(hover*.65f,press)),ui::controlRadius);
    if(mic)micGlyph(g,r.X+10,r.Y+6,on?text:muted,!on);
    else if(icon){auto dc=g.GetHDC();DrawIconEx(dc,int((r.X+8)*scale),int((r.Y+8)*scale),icon,int(24*scale),int(24*scale),0,nullptr,DI_NORMAL);g.ReleaseHDC(dc);}
    if(on){fill(g,RectF(r.X+27,r.Y+27,12,12),orange,2);Pen check(orangeInk,1.3f);g.DrawLine(&check,r.X+30,r.Y+33,r.X+32,r.Y+35);g.DrawLine(&check,r.X+32,r.Y+35,r.X+36,r.Y+30);}
    if(available)hits.push_back({r,id});hint(id,r);
  };
  audioIcon(30,RectF(504,72,40,40),settings.microphone,nullptr,true);hairline(g,504,126,544,126,ui::seam);
  auto filtered=filteredApps();audioOffset=std::clamp(audioOffset,0,std::max(0,(int)filtered.size()-layout::compactAudioRows));
  for(int j=audioOffset;j<std::min(audioOffset+layout::compactAudioRows,(int)filtered.size());++j){int i=filtered[j];auto&name=audioNames[i];
    audioIcon(20000+i,RectF(504,140+(j-audioOffset)*44.f,40,40),settings.included.count(name)!=0,appIcons.count(name)?appIcons[name]:genericIcon,false);
  }
  if(filtered.size()>layout::compactAudioRows){float height=layout::audioRail.Height*layout::compactAudioRows/filtered.size();fill(g,RectF(552,140+(layout::audioRail.Height-height)*audioOffset/(filtered.size()-layout::compactAudioRows),2,height),line,1);}

}
void paintStatusFooter(Graphics&g){
  float top=uiHeight()-layout::statusHeight;hairline(g,16,top,uiWidth()-16,top,ui::seam);
  bool expired=hasLaunch&&remainingSeconds()==0&&state.phase!=Phase::Sharing&&state.phase!=Phase::Starting&&state.phase!=Phase::Stopping;
  std::wstring notice;
  Color light=paper;
  if(localError){notice=localizedStatus(localMessage);light=ui::error;}
  else if(expired){notice=L"等待共享已超时，请从网页重新发起";light=ui::error;}
  else if(state.phase==Phase::Failed){notice=localizedStatus(state.message);light=ui::error;}
  else if(!localMessage.empty())notice=localizedStatus(localMessage);
  else if(hasLaunch&&state.phase==Phase::Sharing){notice=L"共享中";light=ui::success;}
  else if(hasLaunch&&state.phase==Phase::Starting)notice=L"正在启动共享…";
  else if(hasLaunch&&state.phase==Phase::Stopping)notice=L"正在停止共享…";
  else if(!hasLaunch){
    if(serverConnection==ServerConnection::Online){notice=L"连接服务器成功，等待网页唤起";light=ui::success;}
    else if(serverConnection==ServerConnection::Offline){notice=L"无法连接服务器，将自动重试";light=ui::error;}
    else notice=L"正在检测服务器连接…";
  }
  else if(hasLaunch&&state.phase==Phase::Ready&&state.allowedQualities.empty()){notice=L"服务器未开放可用画质，请在网页检查权限";light=ui::error;}
  else if(hasLaunch&&state.phase==Phase::Ready&&state.sources.empty()){notice=L"没有可共享画面，请从网页重新发起";light=paper;}
  else if(hasLaunch&&state.phase==Phase::Ready&&(state.message.find(L"停止")!=std::wstring::npos||state.message.find(L"结束")!=std::wstring::npos))notice=localizedStatus(state.message);
  else if(hasLaunch&&state.serverObservedAt&&GetTickCount64()-state.serverObservedAt<10000){notice=L"连接服务器成功";light=ui::success;}
  else if(hasLaunch&&state.phase==Phase::Loading)notice=L"正在连接服务器…";
  else notice=hasLaunch?L"正在确认服务器连接…":L"等待网页唤起，尚未连接服务器";
  signalDot(g,28,top+28,light);label(g,notice,RectF(44,top+10,uiWidth()-64,36),13,text);hint(9001,RectF(16,top+4,uiWidth()-32,48),notice);
}
void paintSession(Graphics&g){
  bool live=state.phase==Phase::Sharing,starting=state.phase==Phase::Starting,stopping=state.phase==Phase::Stopping;
  auto count=countdownText();
  bool canStart=canBeginSharing();
  if(smallPanel()){
    float top=layout::titleHeight+(uiHeight()-layout::titleHeight-layout::statusHeight-76)/2;
    label(g,L"等待网页接入",RectF(24,top,432,40),28,text,true,true);
    label(g,L"从共享网页发起，选择你要分享的画面。",RectF(24,top+48,432,28),14,muted,false,true);
    paintStatusFooter(g);

  }else if(expanded){
    hairline(g,688,84,688,764,ui::seam);
    bool expired=remainingSeconds()==0&&!live&&!starting;
    paintStatusFooter(g);
    RectF action(712,650,264,100);bool enabled=live||starting||canStart;
    Color base=enabled?orange:ui::controlDisabled,ink=enabled?orangeInk:muted;
    fill(g,action,enabled&&pressedId==40&&hoverId==40?Color(255,226,72,0):enabled&&hoverId==40?Color(255,246,88,15):base,8);
    label(g,live||starting?L"停止共享":expired?L"等待已超时":L"开始共享",RectF(732,660,224,24),14,ink);
    if(!count.empty()&&!live&&!starting){float size=std::min(40.f,136.f*40.f/std::max(1.f,textWidth(count,40,false,L"Bahnschrift")));label(g,count,RectF(732,689,136,48),size,ink);textRuns.back().numeric=true;}
    else glyph(g,live||starting?0xE71A:0xE768,RectF(732,694,32,36),26,ink);
    label(g,std::to_wstring(state.viewers)+L" 人观看",RectF(874,705,82,28),12,ink,false,true);
    if(enabled)hits.push_back({action,40});hint(40,action);
  }else{
    label(g,selectedSourceName(),RectF(16,64,464,28),13,text,true);hint(9004,RectF(16,64,464,28),selectedSourceName());
    drawPreview(g);paintCompactSound(g);
    glyph(g,0xE716,RectF(20,384,20,24),18,muted);
    auto viewers=std::to_wstring(state.viewers);float numberWidth=std::min(100.f,textWidth(viewers,26,true,L"Bahnschrift"));
    label(g,viewers,RectF(48,378,numberWidth,34),26,text,true);textRuns.back().numeric=true;
    label(g,L"人观看",RectF(56+numberWidth,382,52,26),12,muted);
    if(state.viewers==0&&state.noViewerSeconds>=0){
      auto caption=L"（"+std::to_wstring(remainingSeconds())+L"秒后自动停止）";
      RectF timeout(108+numberWidth,382,272-numberWidth,26);label(g,caption,timeout,12,muted);
      hint(9002,timeout,L"无人观看时按服务器期限自动停止；有人加入观看后取消");
    }
    button(g,40,RectF(396,378,140,36),stopping?L"正在停止":L"停止共享",true,live||starting);
    paintStatusFooter(g);
  }
}
void sourceImage(Graphics&g,const Source&src,RectF r){
  fill(g,r,ui::surfaceElevated,3);
  if(!src.image.empty()&&src.width>0&&src.height>0){Bitmap bitmap(src.width,src.height,src.width*4,PixelFormat32bppARGB,const_cast<BYTE*>(src.image.data()));float f=std::min(r.Width/src.width,r.Height/src.height);auto saved=g.Save();g.SetClip(r,CombineModeIntersect);g.SetInterpolationMode(InterpolationModeHighQualityBilinear);g.DrawImage(&bitmap,RectF(r.X+(r.Width-src.width*f)/2,r.Y+(r.Height-src.height*f)/2,src.width*f,src.height*f));g.Restore(saved);}
  else glyph(g,src.screen?0xE7F4:0xE737,RectF(r.X,r.Y+(r.Height-32)/2,r.Width,32),26,muted);
}
void paintSources(Graphics&g){
  label(g,L"共享画面",RectF(24,87,180,28),18,text,true);
  button(g,12,RectF(360,86,88,32),L"刷新",false,!busy());
  selectionTrack(g,RectF(470,82,194,40));
  button(g,11,RectF(474,86,90,32),L"屏幕",false,!busy(),settings.screens);
  button(g,10,RectF(568,86,90,32),L"窗口",false,!busy(),!settings.screens);
  if(sourcePreview&&selected>=0&&selected<(int)state.sources.size()){
    sourceImage(g,state.sources[selected],RectF(24,132,640,360));
    label(g,selectedSourceName(),RectF(24,511,488,32),15,text,true);hint(9004,RectF(24,511,488,32),selectedSourceName());
    button(g,46,RectF(528,511,136,36),L"更换画面",false,!busy());return;
  }
  refreshVisible();auto viewport=layout::sources;auto gridState=g.Save();g.SetClip(viewport);
  if(visible.empty()){
    label(g,state.phase==Phase::Loading?L"正在读取画面…":L"暂无可共享画面",RectF(64,275,560,38),21,text,false,true);
    label(g,L"打开目标窗口后，点击右上方刷新",RectF(64,321,560,26),13,muted,false,true);
    hint(9006,viewport,L"打开目标窗口后点击刷新");
  }
  for(int i=0;i<(int)visible.size();++i){
    int index=visible[i];auto&src=state.sources[index];float x=24+(i%2)*328.f,y=132+(i/2)*layout::sourcePitch-page;
    if(y+198<=viewport.Y||y>=viewport.GetBottom())continue;
    RectF card(x,y,312,198),preview(x+7,y+7,298,149);bool chosen=index==selected;
    float hover=motion((1000+index)*4,hoverId==1000+index?1.f:0.f);
    fill(g,card,blend(paper,ui::surfaceElevated,hover*.35f),4);
    fill(g,preview,ui::surfaceElevated,2);
    if(!src.image.empty()){
      Bitmap bitmap(src.width,src.height,src.width*4,PixelFormat32bppARGB,const_cast<BYTE*>(src.image.data()));auto saved=g.Save();auto clip=rounded(preview,2);g.SetClip(clip.get(),CombineModeIntersect);
      float factor=std::min(preview.Width/src.width,preview.Height/src.height);g.DrawImage(&bitmap,RectF(preview.X+(preview.Width-src.width*factor)/2,preview.Y+(preview.Height-src.height*factor)/2,src.width*factor,src.height*factor));g.Restore(saved);
    }else{
      float cx=x+156,cy=y+81;Pen pen(line,1.8f);stroke(g,RectF(cx-24,cy-19,48,32),line,1.8f,3);g.DrawLine(&pen,cx,cy+13,cx,cy+22);g.DrawLine(&pen,cx-12,cy+22,cx+12,cy+22);
    }
    stroke(g,RectF(x+.75f,y+.75f,310.5f,196.5f),chosen?text:ui::seam,chosen?1.5f:1.f,4);
    if(chosen){fill(g,RectF(x+280,y+168,18,18),orange,3);Pen check(orangeInk,1.6f);g.DrawLine(&check,x+284,y+176,x+288,y+180);g.DrawLine(&check,x+288,y+180,x+294,y+173);}
    label(g,src.name,RectF(x+14,y+162,246,28),14,text,chosen);textRuns.back().clip=viewport;
    card.Intersect(viewport);if(!busy())hits.push_back({card,1000+index});hint(1000+index,card);
  }g.Restore(gridState);
  if(sourceScrollMax()>0){float thumb=viewport.Height*viewport.Height/(viewport.Height+sourceScrollMax());fill(g,RectF(672,viewport.Y+(viewport.Height-thumb)*page/sourceScrollMax(),3,thumb),line,1.5f);}

}
std::wstring appName(const std::wstring&name){
  static const std::map<std::wstring,std::wstring> names{{L"kook",L"KOOK"},{L"heyboxchat",L"黑盒语音"},{L"discord",L"Discord"},{L"chrome",L"Google Chrome"},{L"qqmusic",L"QQ 音乐"},{L"msedge",L"Microsoft Edge"},{L"notepad",L"记事本"},{L"explorer",L"Windows 资源管理器"},{L"cmd",L"命令提示符"},{L"powershell",L"PowerShell"},{L"music",L"音乐"}};
  auto it=names.find(name);return it==names.end()?name:it->second;
}
std::wstring microphoneName(){
  if(settings.microphoneDevice.empty())return microphones.defaultName.empty()?L"默认设备":L"默认设备 · "+microphones.defaultName;
  auto current=std::find_if(microphones.devices.begin(),microphones.devices.end(),[](const MicrophoneDevice& d){return d.id==settings.microphoneDevice;});
  return current==microphones.devices.end()?L"设备已断开":current->name;
}
struct MenuItem {int id;std::wstring label;bool checked=false,enabled=true;};
std::vector<MenuItem> menuItems(){
  std::vector<MenuItem> items;if(popup==1){for(size_t i=0;i<state.allowedQualities.size();++i)items.push_back({50+(int)i,qualityName(state.allowedQualities[i]),settings.quality==state.allowedQualities[i]});}
  if(popup==3){items.push_back({40000,microphones.defaultName.empty()?L"默认设备":L"默认设备 · "+microphones.defaultName,settings.microphoneDevice.empty()});for(size_t i=0;i<microphones.devices.size();++i)items.push_back({40001+int(i),microphones.devices[i].name,settings.microphoneDevice==microphones.devices[i].id});}
  if(popup==2)items={{30002,L"停止共享",false,state.phase==Phase::Sharing||state.phase==Phase::Starting},{30003,L"登录 Windows 后启动",autoStart()},{30004,registered?L"取消网页唤起注册":L"启用网页唤起"},{30006,L"关于"},{30005,L"退出 XgoatCast"}};
  if(popup==2&&availableUpdate.available)items.insert(items.end()-1,{30007,L"立即更新"});
  return items;
}
void openPopup(int kind){bool close=popup==kind;cancelInput();popup=close?0:kind;menuOffset=0;focusIndex=popup?0:-1;if(popup==3){auto items=menuItems();for(size_t i=0;i<items.size();++i)if(items[i].checked)focusIndex=int(i);}if(popup==1){auto current=std::find(state.allowedQualities.begin(),state.allowedQualities.end(),settings.quality);if(current!=state.allowedQualities.end())focusIndex=int(current-state.allowedQualities.begin());}InvalidateRect(window,nullptr,FALSE);UpdateWindow(window);}
void paintMenu(Graphics&g){
  auto items=menuItems();float width=264.f,x=712.f,y=popup==3?370.f:174.f;
  float rowHeight=popup==3?36.f:40.f;int rows=popup==3?std::min(8,int(items.size())):int(items.size());
  menuOffset=std::clamp(menuOffset,0,std::max(0,int(items.size())-rows));
  if(focusIndex>=0){if(focusIndex<menuOffset)menuOffset=focusIndex;if(focusIndex>=menuOffset+rows)menuOffset=focusIndex-rows+1;}
  RectF box(x,y,width,rows*rowHeight+12);hits.clear();tips.clear();fill(g,box,paper,4);stroke(g,box,line,1,4);
  for(int i=menuOffset;i<menuOffset+rows;++i){auto&item=items[i];RectF row(x+6,y+6+(i-menuOffset)*rowHeight,width-12,rowHeight);
    if(item.enabled&&(hoverId==item.id||focusIndex==i))fill(g,row,ui::controlTrack,3);
    if(item.checked){fill(g,RectF(row.X+10,row.Y+(rowHeight-8)/2,8,8),orange,1);}
    label(g,item.label,RectF(row.X+30,row.Y,row.Width-42,row.Height),13,item.enabled?text:muted,item.checked);
    if(item.enabled)hits.push_back({row,item.id});hint(item.id,row,item.label);
  }
  if(int(items.size())>rows){float height=(box.Height-12)*rows/items.size();fill(g,RectF(box.GetRight()-4,box.Y+6+(box.Height-12-height)*menuOffset/(items.size()-rows),2,height),line,1);}
}
void paintSound(Graphics&g){
  bool enabled=hasLaunch&&state.phase!=Phase::Starting&&state.phase!=Phase::Stopping,audioSupported=windowsBuild()>=20348;
  label(g,L"共享设置",RectF(712,84,264,28),18,text,true);
  RectF quality(712,124,264,42);fill(g,quality,!busy()?paper:ui::controlDisabled,4);stroke(g,quality,hoverId==45?text:line,1,4);
  label(g,state.allowedQualities.empty()?L"等待服务器提供画质":qualityName(settings.quality),RectF(728,124,192,42),15,text,true);glyph(g,0xE70D,RectF(932,124,24,42),12,muted);if(!busy()&&!state.allowedQualities.empty())hits.push_back({quality,45});hint(45,quality,L"选择服务器允许的分辨率与帧率；停止共享后可调整");
  selectionTrack(g,RectF(712,182,264,38));button(g,20,RectF(716,186,126,30),L"画质优先",false,!busy()&&state.allowPreference,settings.detail&&state.allowPreference);button(g,21,RectF(846,186,126,30),L"帧率优先",false,!busy()&&state.allowPreference,!settings.detail||!state.allowPreference);
  glyph(g,0xE945,RectF(724,247,24,28),22,muted);label(g,L"低延迟",RectF(760,240,172,25),14,text,true);label(g,state.allowLowLatency?L"减少画面等待":L"服务器未开放",RectF(760,267,172,20),12,muted);toggle(g,22,RectF(944,250,20,20),settings.lowLatency&&state.allowLowLatency,!busy()&&state.allowLowLatency);
  micGlyph(g,724,306,settings.microphone?text:muted,!settings.microphone);label(g,L"麦克风",RectF(760,302,172,24),14,text,true);toggle(g,30,RectF(944,308,20,20),settings.microphone,enabled);
  RectF device(756,334,220,30);if(hoverId==31)fill(g,device,paper,3);
  auto deviceName=microphoneName();label(g,deviceName,RectF(760,334,184,30),12,muted);glyph(g,0xE70D,RectF(948,334,16,30),10,muted);
  if(enabled)hits.push_back({device,31});hint(31,device,deviceName+L"；点击切换麦克风设备");
  hairline(g,712,374,976,374,ui::seam);label(g,L"程序声音",RectF(712,382,264,28),18,text,true);
  auto filtered=filteredApps();audioOffset=std::clamp(audioOffset,0,std::max(0,(int)filtered.size()-layout::audioRows));
  for(int j=audioOffset;j<std::min(audioOffset+layout::audioRows,(int)filtered.size());++j){int i=filtered[j];auto name=audioNames[i];bool on=settings.included.count(name)!=0;float y=layout::sound.Y+(j-audioOffset)*layout::audioPitch;RectF row(712,y,264,40);
    if(on||hoverId==20000+i)fill(g,row,paper,3);hairline(g,760,y+40,964,y+40,ui::seam);
    HICON appIcon=appIcons.count(name)?appIcons[name]:genericIcon;if(appIcon){auto dc=g.GetHDC();DrawIconEx(dc,int(724*scale),int((y+8)*scale),appIcon,int(24*scale),int(24*scale),0,nullptr,DI_NORMAL);g.ReleaseHDC(dc);}
    label(g,appName(name),RectF(760,y,168,40),13,text);switchFace(g,20000+i,RectF(944,y+10,20,20),on,enabled&&audioSupported);if(enabled&&audioSupported)hits.push_back({row,20000+i});hint(20000+i,row);
  }
  if(filtered.empty())label(g,audioLoading?L"正在读取程序…":L"暂无正在发声的程序",RectF(712,450,264,30),13,muted);
  if(filtered.size()>layout::audioRows){float thumb=220.f*layout::audioRows/filtered.size();fill(g,RectF(983,416+(220-thumb)*audioOffset/(filtered.size()-layout::audioRows),2,thumb),line,1);}
  if(!audioSupported)hint(9020,layout::sound,L"当前系统不支持程序声音共享");
}
void paint(HDC dc){
  textRuns.clear();
  RECT cr;GetClientRect(window,&cr);int w=cr.right,h=cr.bottom;
  BITMAPINFO bi{};bi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);bi.bmiHeader.biWidth=w;bi.bmiHeader.biHeight=-h;bi.bmiHeader.biPlanes=1;bi.bmiHeader.biBitCount=32;bi.bmiHeader.biCompression=BI_RGB;
  void* bits;HBITMAP buffer=CreateDIBSection(dc,&bi,DIB_RGB_COLORS,&bits,nullptr,0);HDC mem=CreateCompatibleDC(dc);auto old=SelectObject(mem,buffer);
  {Graphics g(mem);g.SetSmoothingMode(SmoothingModeAntiAlias);g.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);g.ScaleTransform(scale,scale);
    g.Clear(canvas);hits.clear();tips.clear();float W=uiWidth(),H=uiHeight();
    // Fully opaque frosted material: broad reflected light, with no desktop sampling or window alpha.
    LinearGradientBrush material(RectF(0,0,W,H),Color(255,249,249,247),Color(255,238,241,237),LinearGradientModeVertical);g.FillRectangle(&material,0.f,0.f,W,H);
    sheepLogo(g,RectF(20,10,36,36));label(g,L"XgoatCast",RectF(64,13,190,31),19,text,true);

    iconButton(g,1,RectF(W-92,12,32,32));iconButton(g,2,RectF(W-48,12,32,32),true);
    hairline(g,0,56,W,56,ui::seam);
    paintSession(g);if(expanded){paintSources(g);paintSound(g);}
    if(!popup&&focusIndex>=0&&focusIndex<(int)hits.size()){auto r=hits[focusIndex].rect;r.Inflate(2,2);stroke(g,r,ui::info,2,3);}
  }
  drawText(mem,cr);
  if(popup){textRuns.clear();{Graphics overlay(mem);overlay.SetSmoothingMode(SmoothingModeAntiAlias);overlay.ScaleTransform(scale,scale);paintMenu(overlay);}drawText(mem,cr);}
  if(tipVisible&&!popup){textRuns.clear();{Graphics overlay(mem);overlay.SetSmoothingMode(SmoothingModeAntiAlias);overlay.ScaleTransform(scale,scale);paintTooltip(overlay);}drawText(mem,cr);}
  BitBlt(dc,0,0,w,h,mem,0,0,SRCCOPY);SelectObject(mem,old);DeleteDC(mem);DeleteObject(buffer);
}
CLSID pngEncoder(){UINT count=0,bytes=0;GetImageEncodersSize(&count,&bytes);std::vector<BYTE> data(bytes);auto encoders=reinterpret_cast<ImageCodecInfo*>(data.data());GetImageEncoders(count,bytes,encoders);for(UINT i=0;i<count;++i)if(wcscmp(encoders[i].MimeType,L"image/png")==0)return encoders[i].Clsid;throw std::runtime_error("找不到 PNG 编码器");}
void capturePreview(const std::wstring&output){
  RECT r;GetClientRect(window,&r);HDC screen=GetDC(window);HDC memory=CreateCompatibleDC(screen);HBITMAP bitmap=CreateCompatibleBitmap(screen,r.right,r.bottom);auto old=SelectObject(memory,bitmap);paint(memory);SelectObject(memory,old);DeleteDC(memory);ReleaseDC(window,screen);
  Bitmap image(bitmap,nullptr);auto encoder=pngEncoder();if(image.Save(output.c_str(),&encoder,nullptr)!=Ok){DeleteObject(bitmap);throw std::runtime_error("无法保存界面预览");}DeleteObject(bitmap);
}
std::shared_ptr<const PreviewFrame> syntheticPreview(){
  // A deterministic test pattern, used only by --render-* / --ui-test, never as a live fallback.
  auto frame=std::make_shared<PreviewFrame>();frame->width=960;frame->height=540;frame->observedAt=GetTickCount64();frame->image.resize(960*540*4);
  for(int y=0;y<540;++y)for(int x=0;x<960;++x){int r=36+x*25/960,g=49+y*16/540,b=64+x*18/960;
    if(y<30){r=24;g=29;b=34;}else if(x<160){r=43;g=49;b=52;}
    else if(x>186&&x<936&&y>62&&y<464){r=221;g=224;b=218;
      if(y<103){r=191;g=199;b=191;}else if(x<365){r=198;g=207;b=196;}
      else if(y>141&&y<173){r=62;g=74;b=65;}
      else if((y>204&&y<219)||(y>246&&y<261)||(y>288&&y<303)){if(x<810){r=146;g=158;b=144;}}
      else if(x>760&&y>378&&y<431){r=255;g=96;b=20;}
    }
    auto i=(y*960+x)*4;frame->image[i]=BYTE(b);frame->image[i+1]=BYTE(g);frame->image[i+2]=BYTE(r);frame->image[i+3]=255;
  }return frame;
}
void renderPreview(const std::wstring& output,bool showRegistration,bool showAudio,int compactMode=0){
  previewMode=true;sourcePreview=compactMode==0;expanded=!showAudio&&(compactMode==0||compactMode==2);settings.microphone=false;settings.detail=true;
  settings.audio=true;settings.screens=true;settings.quality="1080p_2";hasLaunch=true;registered=!showRegistration;registrationPrompt=showRegistration;state.phase=Phase::Ready;state.message=L"选择一个画面，开始共享";state.room=L"我的共享";state.allowLowLatency=true;state.allowPreference=true;
  state.allowedQualities={"480p_2","720p30","1080p_2","1080p60","1440p30","1440p60","4k30"};state.sources={{1,true,L"显示器 1"},{2,true,L"显示器 2"},{3,true,L"显示器 3"}};selected=0;settings.lowLatency=false;audioPanel=showAudio;audioNames={L"notepad",L"explorer",L"cmd",L"powershell",L"chrome",L"discord",L"music"};scale=showRegistration?1.5f:1.f;hasLaunch=!showAudio;if(compactMode==1||compactMode==3){state.phase=Phase::Sharing;state.message=L"画面与声音正在共享";settings.lowLatency=true;settings.microphone=true;}if(compactMode==2){selected=-1;}SetWindowPos(window,nullptr,0,0,int(uiWidth()*scale),int(uiHeight()*scale),SWP_NOMOVE|SWP_NOZORDER);settings.included={L"notepad"};{wchar_t system[MAX_PATH];GetSystemDirectoryW(system,MAX_PATH);std::wstring base=system;std::wstring windows=base.substr(0,base.find_last_of(L"\\"));for(auto&[name,path]:std::vector<std::pair<std::wstring,std::wstring>>{{L"notepad",base+L"\\notepad.exe"},{L"explorer",windows+L"\\explorer.exe"},{L"cmd",base+L"\\cmd.exe"},{L"powershell",windows+L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"}}){SHFILEINFOW info{};if(SHGetFileInfoW(path.c_str(),0,&info,sizeof(info),SHGFI_ICON|SHGFI_LARGEICON))appIcons[name]=info.hIcon;}}state.viewers=compactMode==1?3:0;state.idleSeconds=compactMode==1||compactMode==3?-1:120;state.noViewerSeconds=compactMode==3?93:-1;state.observedAt=GetTickCount64();state.serverObservedAt=state.observedAt;
  if(compactMode==1||compactMode==3)liveFrame=syntheticPreview();else liveFrame.reset();
  if(compactMode==0){auto fixture=syntheticPreview();state.sources[0].width=fixture->width;state.sources[0].height=fixture->height;state.sources[0].image=fixture->image;}
  microphones.defaultName=L"麦克风 (Realtek Audio)";microphones.devices={{"fixture-internal",L"麦克风 (Realtek Audio)"},{"fixture-usb",L"USB 麦克风"}};settings.microphoneDevice.clear();
  capturePreview(output);
}
std::vector<BYTE> logoPixels(int size){
  // Rasterize against the actual orange face at 4x, then apply fractional rounded coverage.
  // No white matte is baked into the transparent edge.
  constexpr int samples=4;int large=size*samples;
  BITMAPINFO info{};info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);info.bmiHeader.biWidth=large;info.bmiHeader.biHeight=-large;info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;
  void* pixels=nullptr;HDC dc=CreateCompatibleDC(nullptr);HBITMAP bitmap=CreateDIBSection(dc,&info,DIB_RGB_COLORS,&pixels,nullptr,0);auto old=SelectObject(dc,bitmap);
  float previousScale=scale;scale=large/32.f;textRuns.clear();
  {Graphics g(dc);g.SetSmoothingMode(SmoothingModeAntiAlias);g.Clear(orange);g.ScaleTransform(scale,scale);RectF face(0,0,32,32);LinearGradientBrush material(face,Color(255,255,107,53),Color(255,255,140,66),45.f);g.FillRectangle(&material,face);label(g,L"🐑",face,24,text,false,true);textRuns.back().emoji=true;}
  RECT bounds{0,0,large,large};drawText(dc,bounds);textRuns.clear();scale=previousScale;
  auto source=static_cast<const BYTE*>(pixels);std::vector<BYTE> result(size*size*4);
  for(int y=0;y<size;++y)for(int x=0;x<size;++x){int covered=0,sum[3]{};
    for(int sy=0;sy<samples;++sy)for(int sx=0;sx<samples;++sx){int px=x*samples+sx,py=y*samples+sy;float xx=(px+.5f)*32/large,yy=(py+.5f)*32/large,dx=std::max({7.f-xx,xx-25.f,0.f}),dy=std::max({7.f-yy,yy-25.f,0.f});
      if(dx*dx+dy*dy>49)continue;++covered;auto pixel=source+(py*large+px)*4;for(int c=0;c<3;++c)sum[c]+=pixel[c];
    }
    auto pixel=result.data()+(y*size+x)*4;if(covered){for(int c=0;c<3;++c)pixel[c]=BYTE(sum[c]/covered);pixel[3]=BYTE((covered*255+samples*samples/2)/(samples*samples));}
  }
  SelectObject(dc,old);DeleteDC(dc);DeleteObject(bitmap);return result;
}
void exportIcons(const std::wstring& path){
  const std::vector<int> sizes{16,20,24,32,40,48,64,96,128,256};std::vector<std::vector<BYTE>> frames;
  for(int size:sizes){auto pixels=logoPixels(size);DWORD stride=((size+31)/32)*4;std::vector<BYTE> frame(40+size*size*4+stride*size,0);
    BITMAPINFOHEADER header{};header.biSize=40;header.biWidth=size;header.biHeight=size*2;header.biPlanes=1;header.biBitCount=32;memcpy(frame.data(),&header,40);
    for(int y=0;y<size;++y){memcpy(frame.data()+40+y*size*4,pixels.data()+(size-1-y)*size*4,size*4);for(int x=0;x<size;++x)if(!pixels[((size-1-y)*size+x)*4+3])frame[40+size*size*4+y*stride+x/8]|=BYTE(0x80>>(x%8));}
    frames.push_back(std::move(frame));
  }
  std::ofstream out{std::filesystem::path(path),std::ios::binary};auto word=[&](WORD n){out.write((char*)&n,2);};auto dword=[&](DWORD n){out.write((char*)&n,4);};word(0);word(1);word(WORD(sizes.size()));DWORD offset=6+16*DWORD(sizes.size());
  for(size_t i=0;i<sizes.size();++i){BYTE entry[4]{BYTE(sizes[i]==256?0:sizes[i]),BYTE(sizes[i]==256?0:sizes[i]),0,0};out.write((char*)entry,4);word(1);word(32);dword(DWORD(frames[i].size()));dword(offset);offset+=DWORD(frames[i].size());}
  for(auto&frame:frames)out.write((char*)frame.data(),frame.size());if(!out)throw std::runtime_error("无法导出程序图标");
}
void refreshWindowIcons(UINT dpi){
  int largeSize=GetSystemMetricsForDpi(SM_CXICON,dpi),smallSize=GetSystemMetricsForDpi(SM_CXSMICON,dpi);
  auto load=[&](int size){return static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr),MAKEINTRESOURCEW(101),IMAGE_ICON,size,size,0));};
  HICON next=load(largeSize),nextSmall=load(smallSize);if(!next||!nextSmall){if(next)DestroyIcon(next);if(nextSmall)DestroyIcon(nextSmall);throw std::runtime_error("无法加载程序图标");}
  auto previous=icon,previousSmall=smallIcon;icon=next;smallIcon=nextSmall;
  if(window){SetClassLongPtrW(window,GCLP_HICON,reinterpret_cast<LONG_PTR>(icon));SetClassLongPtrW(window,GCLP_HICONSM,reinterpret_cast<LONG_PTR>(smallIcon));SendMessageW(window,WM_SETICON,ICON_BIG,reinterpret_cast<LPARAM>(icon));SendMessageW(window,WM_SETICON,ICON_SMALL,reinterpret_cast<LPARAM>(smallIcon));}
  if(previous)DestroyIcon(previous);if(previousSmall)DestroyIcon(previousSmall);
}
void tray(bool add){NOTIFYICONDATAW n{};n.cbSize=sizeof(n);n.hWnd=window;n.uID=1;n.uFlags=NIF_ICON|NIF_MESSAGE|NIF_TIP;n.uCallbackMessage=WM_TRAY;n.hIcon=smallIcon;wcscpy_s(n.szTip,state.phase==Phase::Sharing?L"XgoatCast · 正在共享":L"XgoatCast · 等待共享");Shell_NotifyIconW(add?NIM_ADD:NIM_MODIFY,&n);}
void receive(const std::wstring& uri){
  if(busy()){localMessage=L"请先停止当前共享，再切换会话";show();return;}
  auto next=parseLaunch(uri);
  if(serverMonitor)serverMonitor->watch("");
  launch=next;hasLaunch=true;liveFrame.reset();settings.screens=true;settings.included.clear();settings.microphone=false;resize();act(33);selected=-1;sourcePreview=false;page=0;localMessage.clear();localError=false;state=Snapshot{};state.phase=Phase::Loading;syncLayout();session->launch(next,settings);show();
}
void act(int id){
  if(id!=33){localMessage.clear();localError=false;}
  if(id==1){ShowWindow(window,SW_MINIMIZE);return;}
  if(id==2){ShowWindow(window,SW_HIDE);return;}
  if(id==5)ShellExecuteW(window,L"open",L"https://cast.xgoat.top",nullptr,nullptr,SW_SHOWNORMAL);

  if(id==31&&!busy()){if(session)session->refreshMicrophones();openPopup(3);return;}
  if(id>=40000&&id<=40000+int(microphones.devices.size())){auto device=id==40000?std::string():microphones.devices[id-40001].id;cancelInput();if(session)session->selectMicrophone(device);else settings.microphoneDevice=device;InvalidateRect(window,nullptr,FALSE);return;}
  if(id==45&&!busy()){openPopup(1);return;}
  if(id>=30001&&id<=30007){cancelInput();systemAction(id-29900);return;}
  if(id==46){sourcePreview=false;cancelInput();}

  if(id==3)registerProtocol();
  if(id==4){registrationPrompt=false;registrationDismissed=true;}
  if(id==10||id==11){sourcePreview=false;settings.screens=id==11;selected=-1;page=0;persist();}
  if(id==12){session->refresh();localMessage=L"正在刷新画面列表…";}
  if(id==13)--page;if(id==14)++page;
  if(id==20||id==21){settings.detail=id==20;persist();}
  if(id==22){settings.lowLatency=!settings.lowLatency;persist();}
  if(id>=50&&id<50+(int)state.allowedQualities.size()){settings.quality=state.allowedQualities[id-50];cancelInput();persist();}
  if(id==30){settings.microphone=!settings.microphone;if(session)session->updateAudio(settings);}
  if(id==33&&!audioLoading){
    if(appsThread.joinable())appsThread.join();audioLoading=true;
    appsThread=std::thread([]{HRESULT com=CoInitializeEx(nullptr,COINIT_MULTITHREADED);auto result=std::make_unique<std::vector<Process>>();try{*result=audioApps(true);}catch(...){}if(SUCCEEDED(com))CoUninitialize();if(PostMessageW(window,WM_AUDIO_APPS,0,reinterpret_cast<LPARAM>(result.get())))result.release();});
  }
  if(id==34)--audioOffset;if(id==35)++audioOffset;if(id==36)audioPanel=false;
  if(id>=20000&&id<20000+(int)audioNames.size()){auto name=audioNames[id-20000];bool on=!settings.included.count(name);auto set=[&](const std::wstring& n){if(on)settings.included.insert(n);else settings.included.erase(n);};set(name);if(name==L"kook"){set(L"kaiheila");set(L"开黑啦");}if(name==L"heyboxchat"){set(L"heychat");set(L"黑盒语音");}if(name==L"discord"){set(L"discordptb");set(L"discordcanary");}if(session)session->updateAudio(settings);}

  if(id>=1000&&id<20000){selected=id-1000;sourcePreview=true;cancelInput();}
  if(id==40){if(state.phase==Phase::Sharing||state.phase==Phase::Starting){state.phase=Phase::Stopping;session->stop();}else if(canBeginSharing()){persist();session->start(state.sources[selected],settings);state.phase=Phase::Starting;}}
  InvalidateRect(window,nullptr,FALSE);
}
HWND trayPopup=nullptr;int trayHover=-1,trayPressed=-1;float trayScale=1;
std::vector<MenuItem> trayItems;
void paintTrayPopup(HWND h,HDC dc){
  RECT r{};GetClientRect(h,&r);
  auto target=dc;auto memory=CreateCompatibleDC(target);auto bitmap=CreateCompatibleBitmap(target,r.right,r.bottom);auto previous=SelectObject(memory,bitmap);dc=memory;
  HBRUSH background=CreateSolidBrush(RGB(255,255,253));FillRect(dc,&r,background);DeleteObject(background);
  HFONT font=CreateFontW(-int(14*trayScale),0,0,0,FW_LIGHT,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Microsoft YaHei UI");auto old=SelectObject(dc,font);SetBkMode(dc,TRANSPARENT);
  for(size_t i=0;i<trayItems.size();++i){auto& item=trayItems[i];RECT row{int(6*trayScale),int((6+i*40)*trayScale),r.right-int(6*trayScale),int((46+i*40)*trayScale)};
    if(int(i)==trayHover&&item.enabled){auto brush=CreateSolidBrush(RGB(226,228,223));FillRect(dc,&row,brush);DeleteObject(brush);}
    if(item.checked){RECT mark{int(16*trayScale),row.top+int(16*trayScale),int(23*trayScale),row.top+int(23*trayScale)};auto brush=CreateSolidBrush(RGB(255,96,20));FillRect(dc,&mark,brush);DeleteObject(brush);}
    row.left=int(36*trayScale);SetTextColor(dc,item.enabled?RGB(32,33,31):RGB(115,121,113));DrawTextW(dc,item.label.c_str(),-1,&row,DT_SINGLELINE|DT_VCENTER|DT_END_ELLIPSIS);
  }SelectObject(dc,old);DeleteObject(font);
  BitBlt(target,0,0,r.right,r.bottom,memory,0,0,SRCCOPY);SelectObject(memory,previous);DeleteObject(bitmap);DeleteDC(memory);
}
void setTrayHover(HWND h,int next){
  if(next==trayHover)return;
  auto invalidate=[&](int row){if(row<0)return;RECT r{};GetClientRect(h,&r);r.top=int((6+row*40)*trayScale);r.bottom=int((46+row*40)*trayScale);InvalidateRect(h,&r,FALSE);};
  invalidate(trayHover);trayHover=next;invalidate(trayHover);
}
LRESULT CALLBACK trayPopupProc(HWND h,UINT msg,WPARAM wp,LPARAM lp){
  auto rowAt=[&](){RECT r{};GetClientRect(h,&r);int x=GET_X_LPARAM(lp),y=GET_Y_LPARAM(lp);int i=int((y/trayScale-6)/40);return x>=6*trayScale&&x<r.right-6*trayScale&&y>=6*trayScale&&y<(6+trayItems.size()*40)*trayScale&&i>=0&&i<int(trayItems.size())&&trayItems[i].enabled?i:-1;};
  auto choose=[&](int row){if(row>=0&&row<int(trayItems.size())&&trayItems[row].enabled){int id=trayItems[row].id;DestroyWindow(h);PostMessageW(window,WM_APP+8,id-29900,0);}};
  switch(msg){
    case WM_ERASEBKGND:return 1;
    case WM_PAINT:{PAINTSTRUCT ps{};auto dc=BeginPaint(h,&ps);paintTrayPopup(h,dc);EndPaint(h,&ps);return 0;}
    case WM_MOUSEMOVE:{setTrayHover(h,rowAt());TRACKMOUSEEVENT track{sizeof(track),TME_LEAVE,h,0};TrackMouseEvent(&track);return 0;}
    case WM_MOUSELEAVE:setTrayHover(h,-1);trayPressed=-1;return 0;
    case WM_LBUTTONDOWN:trayPressed=rowAt();return 0;
    case WM_LBUTTONUP:if(trayPressed==rowAt())choose(trayPressed);return 0;
    case WM_KEYDOWN:if(wp==VK_ESCAPE){DestroyWindow(h);return 0;}if(wp==VK_RETURN||wp==VK_SPACE){choose(trayHover);return 0;}if(wp==VK_UP||wp==VK_DOWN||wp==VK_TAB){int n=int(trayItems.size()),next=trayHover;for(int i=0;i<n;++i){next=next<0?(wp==VK_UP?n-1:0):(next+(wp==VK_UP?n-1:1))%n;if(trayItems[next].enabled)break;}setTrayHover(h,next);return 0;}break;
    case WM_ACTIVATE:if(LOWORD(wp)==WA_INACTIVE){DestroyWindow(h);return 0;}break;
    case WM_DESTROY:trayPopup=nullptr;return 0;
  }return DefWindowProcW(h,msg,wp,lp);
}
void trayMenu(){
  if(trayPopup){SetForegroundWindow(trayPopup);return;}
  trayItems={{30002,L"停止共享",false,state.phase==Phase::Sharing||state.phase==Phase::Starting},{30003,L"登录 Windows 后启动",autoStart()},{30004,registered?L"取消网页唤起注册":L"启用网页唤起"},{30006,L"关于"},{30005,L"退出 XgoatCast"}};
  if(availableUpdate.available)trayItems.insert(trayItems.end()-1,{30007,L"立即更新"});
  POINT cursor{};GetCursorPos(&cursor);NOTIFYICONIDENTIFIER identity{sizeof(identity),window,1};RECT anchor{};if(SUCCEEDED(Shell_NotifyIconGetRect(&identity,&anchor)))cursor={anchor.right,anchor.top};
  MONITORINFO monitor{sizeof(monitor)};GetMonitorInfoW(MonitorFromPoint(cursor,MONITOR_DEFAULTTONEAREST),&monitor);
  trayScale=GetDpiForWindow(window)/96.f;int w=int(264*trayScale)+2,h=int((12+trayItems.size()*40)*trayScale)+2;
  int x=std::clamp(cursor.x-w,monitor.rcWork.left,std::max(monitor.rcWork.left,monitor.rcWork.right-w));int y=std::clamp(cursor.y-h,monitor.rcWork.top,std::max(monitor.rcWork.top,monitor.rcWork.bottom-h));
  static bool registeredClass=false;if(!registeredClass){WNDCLASSW c{};c.hInstance=GetModuleHandleW(nullptr);c.lpfnWndProc=trayPopupProc;c.lpszClassName=L"XgoatCast.TrayMenu";c.hCursor=LoadCursorW(nullptr,IDC_ARROW);RegisterClassW(&c);registeredClass=true;}
  trayHover=-1;trayPressed=-1;trayPopup=CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_TOPMOST,L"XgoatCast.TrayMenu",L"XgoatCast",WS_POPUP|WS_BORDER,x,y,w,h,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);ShowWindow(trayPopup,SW_SHOWNORMAL);SetForegroundWindow(trayPopup);
}

void checkForUpdates(bool interactive){
  if(updateChecking.exchange(true)){if(interactive){localError=false;localMessage=L"正在检查更新，请稍候";InvalidateRect(window,nullptr,FALSE);}return;}
  if(updateThread.joinable())updateThread.join();
  if(interactive){localError=false;localMessage=L"正在检查更新…";InvalidateRect(window,nullptr,FALSE);}
  updateThread=std::thread([interactive]{
    auto result=std::make_unique<UpdateResult>();result->interactive=interactive;
    try{result->info=xc::checkForUpdate();result->ok=true;}catch(const std::exception&e){result->error=wide(e.what());}
    updateChecking=false;
    auto raw=result.release();if(window&&PostMessageW(window,WM_UPDATE_RESULT,0,reinterpret_cast<LPARAM>(raw))){ }else delete raw;
  });
}
void openUpdatePage(){
  if(!availableUpdate.available)return;
  auto page=wide(availableUpdate.releasePageUrl);
  if(INT_PTR(ShellExecuteW(window,L"open",page.c_str(),nullptr,nullptr,SW_SHOWNORMAL))<=32){localError=true;localMessage=L"无法打开浏览器，请前往 cast.xgoat.top/downloads.html 更新";show();}
}
int updatePrompt(const UpdateInfo& info,bool test=false){
  std::wstring title=L"发现新版本 "+wide(info.version);
  std::wstring content=L"当前版本："+wide(AppVersion)+L"\n\n"+wide(info.notes)+L"\n\n立即更新将打开客户端发布页。安装前请停止共享并退出客户端。";
  TASKDIALOG_BUTTON buttons[]={{1001,L"立即更新"},{1002,L"稍后"}};
  TASKDIALOGCONFIG config{};config.cbSize=sizeof(config);config.hwndParent=window;
  config.dwFlags=TDF_ALLOW_DIALOG_CANCELLATION|TDF_SIZE_TO_CONTENT;config.pszWindowTitle=L"XgoatCast 更新";
  config.pszMainIcon=TD_INFORMATION_ICON;config.pszMainInstruction=title.c_str();config.pszContent=content.c_str();
  config.cButtons=2;config.pButtons=buttons;config.nDefaultButton=1001;
  if(test)config.pfCallback=[](HWND h,UINT message,WPARAM,LPARAM,LONG_PTR)->HRESULT{if(message==TDN_CREATED)PostMessageW(h,TDM_CLICK_BUTTON,1001,0);return S_OK;};
  int choice=0;check(TaskDialogIndirect(&config,&choice,nullptr,nullptr),"无法显示更新提示");return choice;
}
int aboutPrompt(bool test=false){
  const auto site=wide(DefaultServer);
  const std::wstring content=L"版本："+wide(AppVersion)+L"\n官网：<a href=\""+site+L"\">"+site+L"</a>";
  TASKDIALOG_BUTTON buttons[]={{1001,L"检查更新"}};
  TASKDIALOGCONFIG config{};config.cbSize=sizeof(config);config.hwndParent=window;
  config.dwFlags=TDF_ALLOW_DIALOG_CANCELLATION|TDF_SIZE_TO_CONTENT|TDF_ENABLE_HYPERLINKS;
  config.pszWindowTitle=L"关于 XgoatCast";config.pszMainInstruction=L"XgoatCast";config.pszContent=content.c_str();
  config.cButtons=1;config.pButtons=buttons;config.dwCommonButtons=TDCBF_CLOSE_BUTTON;
  config.pfCallback=[](HWND h,UINT message,WPARAM,LPARAM lp,LONG_PTR testing)->HRESULT{
    if(message==TDN_HYPERLINK_CLICKED){if(INT_PTR(ShellExecuteW(h,L"open",reinterpret_cast<const wchar_t*>(lp),nullptr,nullptr,SW_SHOWNORMAL))<=32)MessageBoxW(h,L"无法打开浏览器，请访问 https://cast.xgoat.top",L"XgoatCast",MB_OK|MB_ICONINFORMATION);}
    if(testing&&message==TDN_CREATED)PostMessageW(h,TDM_CLICK_BUTTON,1001,0);
    return S_OK;
  };config.lpCallbackData=test?1:0;
  int choice=0;check(TaskDialogIndirect(&config,&choice,nullptr,nullptr),"无法显示关于窗口");return choice;
}
void systemAction(int item){
  if(item==102&&session&&(state.phase==Phase::Sharing||state.phase==Phase::Starting))act(40);
  if(item==103){if(autoStart()){HKEY k;if(RegOpenKeyExW(HKEY_CURRENT_USER,L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,KEY_SET_VALUE,&k)==ERROR_SUCCESS){RegDeleteValueW(k,L"XgoatCast");RegCloseKey(k);}}else regWrite(L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",L"XgoatCast",L"\""+exePath()+L"\" --tray");}
  if(item==104){if(registered)unregisterProtocol();else registerProtocol();}if(item==105){quitting=true;DestroyWindow(window);}else InvalidateRect(window,nullptr,FALSE);
  if(item==106&&aboutPrompt()==1001){show();checkForUpdates(true);}
  if(item==107)openUpdatePage();
}
LRESULT CALLBACK wndProc(HWND h,UINT message,WPARAM wp,LPARAM lp){try{
  switch(message){
    case WM_APP+8:systemAction(int(wp));return 0;
    case WM_ERASEBKGND:return 1;
    case WM_PAINT:{PAINTSTRUCT ps;auto dc=BeginPaint(h,&ps);paint(dc);EndPaint(h,&ps);return 0;}
    case WM_NCCALCSIZE:return 0;
    case WM_NCPAINT:return 0;
    case WM_NCACTIVATE:return TRUE;
    case WM_NCHITTEST:{POINT p{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};ScreenToClient(h,&p);float x=p.x/scale,y=p.y/scale;if(y<layout::titleHeight){for(auto&hit:hits)if(hit.rect.Contains(x,y))return HTCLIENT;return HTCAPTION;}return HTCLIENT;}
    case WM_MOUSEMOVE:{PointF p(GET_X_LPARAM(lp)/scale,GET_Y_LPARAM(lp)/scale);pointerPos=p;int nextTip=-1;for(auto&tip:tips)if(tip.rect.Contains(p)){nextTip=tip.id;break;}changeTip(nextTip);int next=-1;for(auto&hit:hits)if(hit.rect.Contains(p)){next=hit.id;break;}if(next!=hoverId){hoverId=next;if(popup&&next>=0)focusIndex=-1;InvalidateRect(h,nullptr,FALSE);}TRACKMOUSEEVENT track{sizeof(track),TME_LEAVE,h,0};TrackMouseEvent(&track);return 0;}
    case WM_MOUSELEAVE:changeTip(-1);hoverId=-1;InvalidateRect(h,nullptr,FALSE);return 0;
    case WM_LBUTTONDOWN:{if(popup){PointF point(GET_X_LPARAM(lp)/scale,GET_Y_LPARAM(lp)/scale);if(std::none_of(hits.begin(),hits.end(),[&](const Hit&hit){return hit.rect.Contains(point);})){cancelInput();InvalidateRect(h,nullptr,FALSE);return 0;}}changeTip(-1);PointF p(GET_X_LPARAM(lp)/scale,GET_Y_LPARAM(lp)/scale);pressedId=-1;for(auto&hit:hits)if(hit.rect.Contains(p)){pressedId=hit.id;hoverId=hit.id;SetCapture(h);break;}InvalidateRect(h,nullptr,FALSE);return 0;}
    case WM_LBUTTONUP:{int pressed=pressedId;pressedId=-1;if(GetCapture()==h)ReleaseCapture();PointF p(GET_X_LPARAM(lp)/scale,GET_Y_LPARAM(lp)/scale);for(auto hit:hits)if(hit.id==pressed&&hit.rect.Contains(p)){act(hit.id);break;}InvalidateRect(h,nullptr,FALSE);return 0;}
    case WM_CANCELMODE:if(GetCapture()==h)ReleaseCapture();[[fallthrough]];
    case WM_CAPTURECHANGED:pressedId=-1;InvalidateRect(h,nullptr,FALSE);return 0;
    case WM_SETCURSOR:if(LOWORD(lp)==HTCLIENT&&hoverId>=0){SetCursor(LoadCursorW(nullptr,IDC_HAND));return TRUE;}break;
    case WM_SETTINGCHANGE:{BOOL animate=TRUE;SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animate,0);motionAllowed=animate!=FALSE;InvalidateRect(h,nullptr,FALSE);return 0;}
    case WM_KEYDOWN:if(popup&&wp==VK_TAB){auto items=menuItems();if(!items.empty())focusIndex=(focusIndex+((GetKeyState(VK_SHIFT)&0x8000)?int(items.size())-1:1)+int(items.size()))%int(items.size());InvalidateRect(h,nullptr,FALSE);return 0;}if(popup&&(wp==VK_UP||wp==VK_DOWN)){auto items=menuItems();if(!items.empty())focusIndex=focusIndex<0?(wp==VK_UP?(int)items.size()-1:0):(focusIndex+(wp==VK_UP?(int)items.size()-1:1))%(int)items.size();InvalidateRect(h,nullptr,FALSE);return 0;}if(wp==VK_ESCAPE){if(popup){cancelInput();InvalidateRect(h,nullptr,FALSE);return 0;}if(audioPanel){audioPanel=false;InvalidateRect(h,nullptr,FALSE);}else ShowWindow(h,SW_HIDE);return 0;}if(wp==VK_TAB){changeTip(-1);if(!hits.empty())focusIndex=focusIndex<0?((GetKeyState(VK_SHIFT)&0x8000)?(int)hits.size()-1:0):(focusIndex+((GetKeyState(VK_SHIFT)&0x8000)?(int)hits.size()-1:1))%(int)hits.size();InvalidateRect(h,nullptr,FALSE);return 0;}if((wp==VK_RETURN||wp==VK_SPACE)&&popup&&focusIndex>=0){auto items=menuItems();if(focusIndex<int(items.size())&&items[focusIndex].enabled)act(items[focusIndex].id);return 0;}if((wp==VK_RETURN||wp==VK_SPACE)&&focusIndex>=0&&focusIndex<(int)hits.size()){act(hits[focusIndex].id);return 0;}break;
    case WM_CHAR:if(audioPanel&&!registrationPrompt){if(wp==VK_BACK){if(!audioSearch.empty())audioSearch.pop_back();}else if(wp>=32&&wp<127&&audioSearch.size()<80)audioSearch+=(wchar_t)wp;audioOffset=0;InvalidateRect(h,nullptr,FALSE);return 0;}break;
    case WM_MOUSEWHEEL:{if(popup){if(popup==3){menuOffset+=GET_WHEEL_DELTA_WPARAM(wp)<0?1:-1;focusIndex=-1;changeTip(-1);InvalidateRect(h,nullptr,FALSE);}return 0;}changeTip(-1);POINT p{GET_X_LPARAM(lp),GET_Y_LPARAM(lp)};ScreenToClient(h,&p);int delta=GET_WHEEL_DELTA_WPARAM(wp)<0?1:-1;if((expanded&&layout::sound.Contains(p.x/scale,p.y/scale))||(!expanded&&hasLaunch&&layout::audioRail.Contains(p.x/scale,p.y/scale)))audioOffset+=delta;else if(expanded&&!sourcePreview&&layout::sources.Contains(p.x/scale,p.y/scale))page+=delta*int(layout::sourcePitch);refreshVisible();InvalidateRect(h,nullptr,FALSE);return 0;}
    case WM_KILLFOCUS:if(popup){cancelInput();InvalidateRect(h,nullptr,FALSE);}return 0;
    case WM_DPICHANGED:cancelInput();scale=HIWORD(wp)/96.f;refreshWindowIcons(HIWORD(wp));tray(false);{auto r=reinterpret_cast<RECT*>(lp);SetWindowPos(h,nullptr,r->left,r->top,0,0,SWP_NOSIZE|SWP_NOZORDER);resize();}return 0;
    case WM_CLOSE:ShowWindow(h,SW_HIDE);return 0;
    case WM_COPYDATA:{auto c=reinterpret_cast<COPYDATASTRUCT*>(lp);if(c->dwData!=0x58434754||c->cbData<sizeof(wchar_t)||c->cbData>16384||c->cbData%sizeof(wchar_t)||!c->lpData)return FALSE;auto s=static_cast<const wchar_t*>(c->lpData);size_t n=c->cbData/sizeof(wchar_t);if(s[n-1]!=0)return FALSE;receive(std::wstring(s,n-1));return TRUE;}
    case WM_MICROPHONES:if(session){auto next=session->microphones();bool changed=next.devices.size()!=microphones.devices.size();if(!changed)for(size_t i=0;i<next.devices.size();++i)if(next.devices[i].id!=microphones.devices[i].id){changed=true;break;}if(changed&&popup==3)cancelInput();microphones=std::move(next);if(settings.microphoneDevice!=microphones.selected){settings.microphoneDevice=microphones.selected;persist();}if(!microphones.error.empty()){localError=true;localMessage=microphones.error;syncLayout();}InvalidateRect(h,nullptr,FALSE);}return 0;
    case WM_UPDATE_RESULT:{
      std::unique_ptr<UpdateResult> result(reinterpret_cast<UpdateResult*>(lp));if(quitting||!result)return 0;
      if(!result->ok){if(result->interactive){localError=true;localMessage=L"检查更新失败："+result->error;show();}}
      else if(result->info.available){
        bool first=availableUpdate.version!=result->info.version;availableUpdate=result->info;
        localError=false;localMessage=L"发现新版本 "+wide(availableUpdate.version)+L"，可在菜单选择立即更新";
        if(first||result->interactive){show();if(updatePrompt(availableUpdate)==1001)openUpdatePage();}
      }else{availableUpdate={};if(result->interactive){localError=false;localMessage=L"当前已是最新版本（v"+wide(AppVersion)+L"）";show();}}
      InvalidateRect(h,nullptr,FALSE);return 0;
    }
    case WM_SERVER_STATUS:if(serverMonitor&&!hasLaunch){serverConnection=serverMonitor->snapshot();InvalidateRect(h,nullptr,FALSE);}return 0;
    case WM_STATE:{auto old=selected>=0&&selected<(int)state.sources.size()?state.sources[selected].id:int64_t(-1);bool screen=selected>=0&&selected<(int)state.sources.size()?state.sources[selected].screen:false;auto previousQualities=state.allowedQualities;state=session->snapshot();if(popup==1&&previousQualities!=state.allowedQualities)cancelInput();if(state.phase!=Phase::Sharing)liveFrame.reset();selected=-1;for(int i=0;i<(int)state.sources.size();++i)if(state.sources[i].id==old&&state.sources[i].screen==screen)selected=i;if(selected<0)sourcePreview=false;if(!state.allowedQualities.empty()&&std::find(state.allowedQualities.begin(),state.allowedQualities.end(),settings.quality)==state.allowedQualities.end()){settings.quality=state.allowedQualities.front();persist();}localMessage.clear();localError=false;syncLayout();tray(false);InvalidateRect(h,nullptr,FALSE);return 0;}
    case WM_AUDIO_APPS:{audioLoading=false;std::unique_ptr<std::vector<Process>> apps(reinterpret_cast<std::vector<Process>*>(lp));if(quitting)return 0;std::set<std::wstring> names;for(auto&p:*apps)if(p.pid>4&&p.pid!=GetCurrentProcessId()&&!p.name.empty()){auto name=audioGroup(p.name);names.insert(name);if(!appIcons.count(name)){HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,p.pid);wchar_t path[32768];DWORD len=32768;if(process){if(QueryFullProcessImageNameW(process,0,path,&len)){SHFILEINFOW info{};if(SHGetFileInfoW(path,0,&info,sizeof(info),SHGFI_ICON|SHGFI_LARGEICON))appIcons[name]=info.hIcon;}CloseHandle(process);}}}updateAudioNames(std::vector<std::wstring>(names.begin(),names.end()));return 0;}
    case WM_TRAY:if(lp==WM_LBUTTONDBLCLK||lp==WM_LBUTTONUP)show();if(lp==WM_RBUTTONUP)trayMenu();return 0;
    case WM_QUERYENDSESSION:session->stop();return TRUE;
    case WM_TIMER:if(smoke){quitting=true;DestroyWindow(h);}else if(wp==8){checkForUpdates(false);}else if(wp==7){if(session&&state.phase==Phase::Sharing&&IsWindowVisible(h)&&!IsIconic(h)){liveFrame=session->preview();InvalidateRect(h,nullptr,FALSE);}}else if(wp==6){KillTimer(h,6);tipVisible=hoverTip>=0;InvalidateRect(h,nullptr,FALSE);}else if(wp==2||wp==4){if(wp==2)syncLayout();InvalidateRect(h,nullptr,FALSE);if(wp==4&&(!motionAllowed||std::none_of(motions.begin(),motions.end(),[](const auto& item){return item.second.from!=item.second.to&&GetTickCount64()-item.second.at<150;})))KillTimer(h,4);}else if(wp==3&&hasLaunch&&!audioLoading)act(33);return 0;
    case WM_DESTROY:{quitting=true;NOTIFYICONDATAW n{};n.cbSize=sizeof(n);n.hWnd=h;n.uID=1;Shell_NotifyIconW(NIM_DELETE,&n);PostQuitMessage(0);return 0;}
  }
  static const UINT taskbarCreated=RegisterWindowMessageW(L"TaskbarCreated");if(message==taskbarCreated){tray(true);return 0;}
 }catch(const std::exception&e){localError=true;localMessage=wide(e.what());InvalidateRect(h,nullptr,FALSE);}return DefWindowProcW(h,message,wp,lp);}
void uiSelfTest(const std::wstring&output){
  auto require=[](bool ok,const char*message){if(!ok)throw std::runtime_error(message);};
  renderPreview(output+L".png",false,false);motionAllowed=true;
  require(aboutPrompt(true)==1001,"About check-update button did not respond");
  {popup=2;auto items=menuItems();require(std::any_of(items.begin(),items.end(),[](const MenuItem&i){return i.id==30006&&i.label==L"关于";}),"Settings menu omitted About");popup=0;}
  {UpdateInfo update{true,"0.0.1-beta.3","https://example.com/setup.exe","https://cast.xgoat.top/downloads.html","测试更新提示","2026-10-04"};
    require(updatePrompt(update,true)==1001,"Immediate update button did not respond");
    availableUpdate=update;popup=2;auto items=menuItems();require(std::any_of(items.begin(),items.end(),[](const MenuItem&i){return i.id==30007&&i.label==L"立即更新";}),"Update action missing after dismissing dialog");availableUpdate={};popup=0;}

  {auto allowed=state.allowedQualities;auto quality=settings.quality;state.allowedQualities={"720p30","1080p60"};settings.quality="1080p60";popup=1;auto menu=menuItems();require(menu.size()==2&&menu[0].id==50&&menu[1].id==51&&!menu[0].checked&&menu[1].checked,"Quality menu ignored server policy or current selection");state.allowedQualities=allowed;settings.quality=quality;popup=0;}
  sourcePreview=false;capturePreview(output+L".grid.png");
  {auto oldPhase=state.phase;auto oldSeconds=state.idleSeconds;auto oldObserved=state.observedAt;state.phase=Phase::Ready;state.idleSeconds=1;state.observedAt=GetTickCount64()-2000;syncLayout();require(!expanded&&uiWidth()==480,"Expired session did not collapse");capturePreview(output+L".expired.png");require(!canBeginSharing()&&std::none_of(hits.begin(),hits.end(),[](const Hit&h){return h.id==40;}),"Expired start is clickable");act(40);require(state.phase==Phase::Ready,"Expired start was executed");state.idleSeconds=-1;require(canBeginSharing(),"Unlimited session cannot start");require(localizedStatus(L"share ended").find(L"共享已结束")!=std::wstring::npos,"Status was not translated");state.phase=oldPhase;state.idleSeconds=oldSeconds;state.observedAt=oldObserved;syncLayout();capturePreview(output+L".grid.png");}
  {auto phase=state.phase;auto message=state.message;state.phase=Phase::Failed;state.message=L"share ended";syncLayout();capturePreview(output+L".error-status.png");state.phase=Phase::Loading;state.message=L"正在读取会话";capturePreview(output+L".notice-status.png");state.phase=phase;state.message=message;syncLayout();capturePreview(output+L".grid.png");}
  {auto saved=state;bool savedLocalError=localError;auto savedMessage=localMessage;
    state.phase=Phase::Ready;state.allowedQualities.clear();syncLayout();require(!expanded&&uiWidth()==480,"No-quality session remained expanded");
    state=saved;state.sources.clear();syncLayout();require(!expanded&&uiWidth()==480,"No-source session remained expanded");
    state=saved;localError=true;localMessage=L"无法连接服务器";syncLayout();require(!expanded&&!canBeginSharing(),"Local error still permits sharing");
    state=saved;localError=savedLocalError;localMessage=savedMessage;syncLayout();capturePreview(output+L".grid.png");}
  {bool savedLaunch=hasLaunch;auto savedConnection=serverConnection;auto savedMessage=localMessage;bool savedError=localError;
    hasLaunch=false;localMessage.clear();localError=false;
    auto hasCaption=[&](const wchar_t*caption){return std::any_of(textRuns.begin(),textRuns.end(),[&](const TextRun&r){return r.value==caption;});};
    for(auto item:std::vector<std::pair<ServerConnection,std::wstring>>{{ServerConnection::Checking,L"正在检测服务器连接…"},{ServerConnection::Online,L"连接服务器成功，等待网页唤起"},{ServerConnection::Offline,L"无法连接服务器，将自动重试"}}){
      serverConnection=item.first;syncLayout();capturePreview(output+(item.first==ServerConnection::Checking?L".waiting-checking.png":item.first==ServerConnection::Online?L".waiting-online.png":L".waiting-offline.png"));
      require(!expanded&&uiWidth()==480&&hasCaption(item.second.c_str()),"Waiting panel ignored connection result");
    }
    serverConnection=ServerConnection::Online;localError=true;localMessage=L"共享链接无效";capturePreview(output+L".waiting-priority.png");require(hasCaption(L"共享链接无效")&&!hasCaption(L"连接服务器成功，等待网页唤起"),"Connection result overwrote an error");
    hasLaunch=true;localError=false;localMessage.clear();state.serverObservedAt=GetTickCount64();serverConnection=ServerConnection::Offline;syncLayout();capturePreview(output+L".session-connection.png");require(hasCaption(L"连接服务器成功"),"Official-site failure leaked into session status");
    hasLaunch=savedLaunch;serverConnection=savedConnection;localMessage=savedMessage;localError=savedError;syncLayout();capturePreview(output+L".grid.png");
  }
  // Use the actual painted rectangles; no Session exists so these cannot start capture.
  auto pointFor=[&](int id){auto it=std::find_if(hits.begin(),hits.end(),[&](const Hit&h){return h.id==id;});require(it!=hits.end(),"Missing input target");return MAKELPARAM(int(it->rect.X+it->rect.Width/2),int(it->rect.Y+it->rect.Height/2));};
  auto second=pointFor(1001),first=pointFor(1000);
  selected=0;wndProc(window,WM_LBUTTONDOWN,0,second);wndProc(window,WM_LBUTTONUP,0,MAKELPARAM(150,750));require(selected==0,"Drag-out activated a source");
  wndProc(window,WM_LBUTTONDOWN,0,second);wndProc(window,WM_LBUTTONUP,0,second);require(selected==1&&sourcePreview,"Source click did not open preview");capturePreview(output+L".selected.png");require(std::none_of(hits.begin(),hits.end(),[](const Hit&hit){return hit.id>=1000&&hit.id<20000;}),"Selected preview retained source grid");act(46);capturePreview(output+L".grid.png");require(!sourcePreview,"Change source did not restore grid");
  wndProc(window,WM_LBUTTONDOWN,0,first);wndProc(window,WM_CANCELMODE,0,0);require(GetCapture()!=window,"Cancelled press retained capture");wndProc(window,WM_LBUTTONUP,0,first);require(selected==1,"Cancelled press activated a source");
  act(45);capturePreview(output+L".quality-menu.png");require(popup==1&&hits.size()==state.allowedQualities.size(),"Quality dropdown did not open");int currentQuality=int(std::find(state.allowedQualities.begin(),state.allowedQualities.end(),settings.quality)-state.allowedQualities.begin());require(focusIndex==currentQuality,"Menu did not focus current quality");int nextQuality=(currentQuality+1)%int(state.allowedQualities.size());wndProc(window,WM_KEYDOWN,VK_DOWN,0);require(focusIndex==nextQuality,"Menu arrow navigation failed");auto previousQuality=settings.quality;wndProc(window,WM_KEYDOWN,VK_RETURN,0);require(popup==0&&settings.quality==state.allowedQualities[nextQuality],"Keyboard menu selection failed");settings.quality=previousQuality;act(45);wndProc(window,WM_KEYDOWN,VK_ESCAPE,0);capturePreview(output+L".grid.png");require(popup==0,"Escape did not close menu");
  {bool wasOn=settings.microphone;act(31);capturePreview(output+L".microphone-menu.png");require(popup==3&&hits.size()==3,"Microphone dropdown did not open");wndProc(window,WM_KEYDOWN,VK_DOWN,0);wndProc(window,WM_KEYDOWN,VK_RETURN,0);require(!popup&&settings.microphoneDevice=="fixture-internal"&&settings.microphone==wasOn,"Device selection enabled recording or selected the wrong device");act(31);capturePreview(output+L".microphone-selected.png");wndProc(window,WM_KEYDOWN,VK_UP,0);wndProc(window,WM_KEYDOWN,VK_RETURN,0);require(settings.microphoneDevice.empty()&&settings.microphone==wasOn,"Default microphone selection failed");act(31);wndProc(window,WM_KEYDOWN,VK_ESCAPE,0);require(!popup,"Microphone menu Escape failed");capturePreview(output+L".grid.png");}
  {auto saved=microphones;for(int i=0;i<10;++i)microphones.devices.push_back({"fixture-extra-"+std::to_string(i),L"USB 输入设备 "+std::to_wstring(i+1)});act(31);capturePreview(output+L".microphone-scroll.png");require(hits.size()==8,"Microphone menu did not bound a long device list");for(size_t i=0;i<microphones.devices.size();++i)wndProc(window,WM_KEYDOWN,VK_DOWN,0);capturePreview(output+L".microphone-scroll-last.png");require(menuOffset>0,"Keyboard did not reveal microphone beyond first page");wndProc(window,WM_KEYDOWN,VK_RETURN,0);require(settings.microphoneDevice=="fixture-extra-9","Long microphone list selected wrong device");microphones=saved;settings.microphoneDevice.clear();capturePreview(output+L".grid.png");}
  {bool wasVisible=IsWindowVisible(window)!=FALSE;trayMenu();require(trayPopup&&(IsWindowVisible(window)!=FALSE)==wasVisible,"Tray menu opened the main window");require(std::none_of(trayItems.begin(),trayItems.end(),[](const MenuItem&i){return i.id==30001;}),"Tray retained Open action");RECT bounds{};GetWindowRect(trayPopup,&bounds);MONITORINFO monitor{sizeof(monitor)};GetMonitorInfoW(MonitorFromWindow(trayPopup,MONITOR_DEFAULTTONEAREST),&monitor);require(bounds.left>=monitor.rcWork.left&&bounds.top>=monitor.rcWork.top&&bounds.right<=monitor.rcWork.right&&bounds.bottom<=monitor.rcWork.bottom,"Tray menu outside work area");
    require(std::any_of(trayItems.begin(),trayItems.end(),[](const MenuItem&i){return i.id==30006&&i.label==L"关于";}),"Tray menu omitted About");
    UpdateWindow(trayPopup);int row=int(std::find_if(trayItems.begin(),trayItems.end(),[](const MenuItem&i){return i.id==30006;})-trayItems.begin());
    const auto point=MAKELPARAM(int(80*trayScale),int((26+row*40)*trayScale));
    SendMessageW(trayPopup,WM_MOUSEMOVE,0,point);require(trayHover==row&&GetUpdateRect(trayPopup,nullptr,FALSE),"Tray hover did not invalidate changed row");UpdateWindow(trayPopup);
    for(int i=0;i<30;++i)SendMessageW(trayPopup,WM_MOUSEMOVE,0,MAKELPARAM(int((80+i)*trayScale),int((26+row*40)*trayScale)));
    require(!GetUpdateRect(trayPopup,nullptr,FALSE),"Tray repainted unchanged hover row");
    SendMessageW(trayPopup,WM_MOUSELEAVE,0,0);require(trayHover==-1,"Tray hover stuck after mouse left");UpdateWindow(trayPopup);
    require(SendMessageW(trayPopup,WM_ERASEBKGND,0,0)==1,"Tray background erase was not suppressed");
    SendMessageW(trayPopup,WM_KEYDOWN,VK_DOWN,0);require(trayHover>=0&&trayItems[trayHover].enabled,"Tray keyboard focus selected disabled row");
    RECT r{};GetClientRect(trayPopup,&r);auto dc=GetDC(trayPopup);auto mem=CreateCompatibleDC(dc);auto bitmap=CreateCompatibleBitmap(dc,r.right,r.bottom);auto previous=SelectObject(mem,bitmap);paintTrayPopup(trayPopup,mem);SelectObject(mem,previous);DeleteDC(mem);ReleaseDC(trayPopup,dc);{Bitmap image(bitmap,nullptr);auto encoder=pngEncoder();image.Save((output+L".tray-menu.png").c_str(),&encoder,nullptr);}DeleteObject(bitmap);
    SendMessageW(trayPopup,WM_KEYDOWN,VK_ESCAPE,0);require(!trayPopup,"Tray menu did not close");}
  auto audioRow=std::find_if(hits.begin(),hits.end(),[](const Hit&h){return h.id==20000;});require(audioRow!=hits.end()&&audioRow->rect.X>=712&&audioRow->rect.GetRight()<=976,"Sound panel is not an independent column");
  state.phase=Phase::Sharing;state.idleSeconds=-1;state.noViewerSeconds=93;state.observedAt=GetTickCount64();liveFrame=syntheticPreview();syncLayout();
  require(uiWidth()==560&&uiHeight()==480,"Compact dimensions incorrect");capturePreview(output+L".compact.png");
  require(std::none_of(hits.begin(),hits.end(),[](const Hit&h){return h.id==7||h.id==45||h.id==22||(h.id>=50&&h.id<20000);}),"Collapsed controller retained video settings controls");
  require(std::any_of(hits.begin(),hits.end(),[](const Hit&h){return h.id==30;}),"Compact microphone missing");
  auto mic=pointFor(30);bool before=settings.microphone;wndProc(window,WM_LBUTTONDOWN,0,mic);wndProc(window,WM_LBUTTONUP,0,mic);require(settings.microphone!=before,"Compact microphone click did not toggle");
  if(windowsBuild()>=20348){auto app=pointFor(20000);bool wasOn=settings.included.count(audioNames[0])!=0;wndProc(window,WM_LBUTTONDOWN,0,app);wndProc(window,WM_LBUTTONUP,0,app);require((settings.included.count(audioNames[0])!=0)!=wasOn,"Compact app sound click did not toggle");}
  if(windowsBuild()>=20348){auto app=pointFor(20000);auto names=audioNames;auto included=settings.included;wndProc(window,WM_LBUTTONDOWN,0,app);auto next=names;next.insert(next.begin(),L"new-audio-app");updateAudioNames(next);require(pressedId==-1&&GetCapture()!=window&&hits.empty(),"Audio refresh retained stale press");capturePreview(output+L".audio-refresh.png");wndProc(window,WM_LBUTTONUP,0,app);require(settings.included==included,"Audio refresh toggled the wrong program");updateAudioNames(names);capturePreview(output+L".compact.png");}
  require(layout::livePreview.Width*layout::livePreview.Height>uiWidth()*(uiHeight()-layout::titleHeight-layout::statusHeight)*.5f,"Preview does not dominate the compact layout");
  {
    auto hasCaption=[&](const wchar_t*caption){return std::any_of(textRuns.begin(),textRuns.end(),[&](const TextRun&r){return r.value==caption;});};
    auto savedViewers=state.viewers;state.viewers=0;state.observedAt=GetTickCount64();capturePreview(output+L".zero-viewers.png");require(hasCaption(L"（93秒后自动停止）")&&!hasCaption(L"无人观看剩余"),"Zero-viewer inline timeout missing");
    auto notice=std::find_if(textRuns.begin(),textRuns.end(),[](const TextRun&r){return r.value==L"共享中";});require(notice!=textRuns.end()&&notice->rect.Y==uiHeight()-layout::statusHeight+10,"Sharing status is not in the common footer");
    state.viewers=3;capturePreview(output+L".with-viewers.png");require(std::none_of(tips.begin(),tips.end(),[](const Tip&t){return t.id==9002;}),"Viewers retained automatic-stop hint");state.viewers=savedViewers;capturePreview(output+L".compact.png");
    require((GetWindowLongPtrW(window,GWL_STYLE)&(WS_BORDER|WS_DLGFRAME|WS_THICKFRAME))==0,"Window retained a system frame");
    refreshWindowIcons(144);ICONINFO info{};require(GetIconInfo(icon,&info)!=FALSE,"Cannot read DPI icon");BITMAP bitmap{};GetObjectW(info.hbmColor,sizeof(bitmap),&bitmap);require(bitmap.bmWidth==48&&bitmap.bmHeight==48,"Taskbar icon uses the wrong DPI size");DeleteObject(info.hbmColor);DeleteObject(info.hbmMask);
    require(GetIconInfo(smallIcon,&info)!=FALSE,"Cannot read small icon");GetObjectW(info.hbmColor,sizeof(bitmap),&bitmap);require(bitmap.bmWidth==24&&bitmap.bmHeight==24,"Tray icon uses the wrong DPI size");DeleteObject(info.hbmColor);DeleteObject(info.hbmMask);refreshWindowIcons(GetDpiForWindow(window));
  }
  require(!tipVisible,"Hints were visible by default");wndProc(window,WM_MOUSEMOVE,0,MAKELPARAM(300,396));require(hoverTip==9002&&!tipVisible,"Countdown hover did not wait for dwell");wndProc(window,WM_TIMER,6,0);require(tipVisible,"Delayed tooltip did not appear");capturePreview(output+L".tooltip.png");wndProc(window,WM_MOUSELEAVE,0,0);require(!tipVisible&&hoverTip==-1,"Hover hint remained after leaving");
  state.idleSeconds=125;state.noViewerSeconds=-1;state.observedAt=GetTickCount64()-2000;require(countdownText()==L"02:03","Idle countdown drift");
  state.idleSeconds=-1;state.noViewerSeconds=1;state.observedAt=GetTickCount64()-2000;require(countdownText()==L"00:00","Countdown did not clamp at zero");
  state.noViewerSeconds=-1;require(countdownText().empty(),"No-deadline sharing was given a false limit");capturePreview(output+L".no-deadline.png");
  require(std::none_of(tips.begin(),tips.end(),[](const Tip&t){return t.id==9002;}),"No-deadline sharing retained timer UI");
  hasLaunch=false;syncLayout();resize();require(uiHeight()==260,"Waiting panel did not shrink");setExpanded(true);require(!expanded&&countdownText().empty(),"Waiting mode expanded or fabricated a countdown");capturePreview(output+L".waiting.png");
  require(std::none_of(tips.begin(),tips.end(),[](const Tip&t){return t.id==9002;}),"Waiting retained timer UI");
  hasLaunch=true;state.phase=Phase::Loading;syncLayout();require(!expanded&&uiWidth()==480,"Connecting session should use waiting panel");
  state.phase=Phase::Ready;syncLayout();require(expanded,"Ready session lost source selection");
  state.phase=Phase::Sharing;syncLayout();require(!expanded,"Sharing did not collapse automatically");
  state.phase=Phase::Stopping;syncLayout();require(!expanded,"Stopping reopened settings early");
  state.phase=Phase::Ready;syncLayout();require(expanded,"Stopped session did not restore setup");
  state.phase=Phase::Sharing;syncLayout();state.phase=Phase::Failed;syncLayout();require(!expanded&&uiWidth()==480,"Failed session did not return to waiting panel");
  state.phase=Phase::Ready;state.idleSeconds=120;state.observedAt=GetTickCount64();syncLayout();
  capturePreview(output+L".ready.png");require(std::none_of(hits.begin(),hits.end(),[](const Hit&h){return h.id==7;}),"Manual layout action is still present");
  wndProc(window,WM_KEYDOWN,VK_ESCAPE,0);require(expanded,"Escape manually collapsed settings");
  auto checkBounds=[&](){for(auto&hit:hits){require(hit.rect.X>=0&&hit.rect.Y>=0&&hit.rect.GetRight()<=uiWidth()&&hit.rect.GetBottom()<=uiHeight(),"Control outside client area");}for(size_t a=0;a<hits.size();++a)for(size_t b=a+1;b<hits.size();++b)require(!hits[a].rect.IntersectsWith(hits[b].rect),"Controls have overlapping hit areas");};
  checkBounds();
  // Resize is synchronous regardless of system animation settings.
  for(bool animations:{false,true}){
    motionAllowed=animations;setExpanded(true);RECT actual{};GetClientRect(window,&actual);require(expanded&&actual.right==1000&&actual.bottom==820,"Expansion did not settle immediately");
    capturePreview(output+L".expanded.png");checkBounds();require(std::any_of(hits.begin(),hits.end(),[](const Hit&h){return h.id==1000;}),"Expanded controls not immediately available");
    setExpanded(false);GetClientRect(window,&actual);require(!expanded&&actual.right==560&&actual.bottom==480,"Collapse did not settle immediately");
  }
  setExpanded(true);capturePreview(output+L".expanded.png");
  auto screenPoint=[&](float x,float y){POINT p{int(x*scale),int(y*scale)};ClientToScreen(window,&p);return MAKELPARAM(p.x,p.y);};
  require(wndProc(window,WM_NCHITTEST,0,screenPoint(320,30))==HTCAPTION,"Title bar not draggable");
  for(int id:{1,2}){auto it=std::find_if(hits.begin(),hits.end(),[&](const Hit&hit){return hit.id==id;});require(it!=hits.end(),"Missing title bar action");require(wndProc(window,WM_NCHITTEST,0,screenPoint(it->rect.X+8,it->rect.Y+8))==HTCLIENT,"Title bar action starts dragging");}
  auto sources=state.sources;for(int i=0;i<7;++i)state.sources.push_back({10+i,true,L"滚动测试画面"});refreshVisible();
  page=0;audioOffset=0;wndProc(window,WM_MOUSEWHEEL,MAKEWPARAM(0,-WHEEL_DELTA),screenPoint(100,600));require(page>0&&audioOffset==0,"Source scroll affected sound panel");
  int sourcePage=page;wndProc(window,WM_MOUSEWHEEL,MAKEWPARAM(0,-WHEEL_DELTA),screenPoint(950,490));capturePreview(output+L".scrolled.png");require(audioOffset==1&&page==sourcePage,"Sound scroll affected source grid");checkBounds();
  state.phase=Phase::Sharing;syncLayout();capturePreview(output+L".rail.png");audioOffset=0;
  wndProc(window,WM_MOUSEWHEEL,MAKEWPARAM(0,-WHEEL_DELTA),screenPoint(520,200));capturePreview(output+L".rail-scroll.png");require(audioOffset==1&&page==sourcePage,"Compact sound rail did not scroll independently");checkBounds();
  state.phase=Phase::Ready;syncLayout();state.sources=sources;page=audioOffset=0;capturePreview(output+L".expanded.png");
  state.idleSeconds=3661;state.observedAt=GetTickCount64();require(countdownText()==L"01:01:01","Hour countdown format incorrect");capturePreview(output+L".long-countdown.png");state.idleSeconds=120;
  state.phase=Phase::Sharing;capturePreview(output+L".live-expanded.png");require(std::none_of(hits.begin(),hits.end(),[](const Hit&hit){return hit.id==10||hit.id==11||hit.id==12||hit.id==45||hit.id==22||(hit.id>=50&&hit.id<20000);}),"Shared video settings remained editable while live");
  require(std::any_of(hits.begin(),hits.end(),[](const Hit&hit){return hit.id==30;}),"Live microphone control disappeared");state.phase=Phase::Ready;
  auto luminance=[](Color c){auto linear=[](float v){v/=255;return v<=.04045f?v/12.92f:std::pow((v+.055f)/1.055f,2.4f);};return .2126f*linear(c.GetR())+.7152f*linear(c.GetG())+.0722f*linear(c.GetB());};
  auto contrast=[&](Color a,Color b){float x=luminance(a),y=luminance(b);return (std::max(x,y)+.05f)/(std::min(x,y)+.05f);};
  Json ratios=Json::object();auto checkRatio=[&](const char*name,Color a,Color b,float minimum){float ratio=contrast(a,b);ratios[name]=ratio;require(ratio>=minimum,name);};
  checkRatio("primary/default",text,canvas,7);checkRatio("secondary/default",muted,canvas,4.5f);checkRatio("secondary/elevated",muted,ui::surfaceElevated,4.5f);
  checkRatio("label/interactive",ui::onInteractive,ui::interactiveDefault,4.5f);checkRatio("label/hover",ui::onInteractive,ui::interactiveHover,4.5f);checkRatio("label/active",ui::onInteractive,ui::interactiveActive,4.5f);checkRatio("label/selected",orangeInk,peach,4.5f);
  checkRatio("border/default",line,canvas,3);checkRatio("border/elevated",line,ui::surfaceElevated,3);
  for(auto&item:std::vector<std::pair<const char*,Color>>{{"success",ui::success},{"warning",ui::warning},{"error",ui::error},{"info",ui::info}})checkRatio(item.first,item.second,canvas,4.5f);
  checkRatio("label/orange",orangeInk,orange,4.5f);
  settings.lowLatency=true;motions[90]=Motion{0,1,GetTickCount64()-75};capturePreview(output+L".switch.png");
  std::ofstream file{std::filesystem::path(output)};file<<Json{{"aboutDialog",true},{"trayHoverRendering",true},{"updatePrompt",true},{"microphoneSelection",true},{"sharedStatusFooter",true},{"inlineAutoStop",true},{"framelessWindow",true},{"dpiIcons",true},{"waitingConnection",true},{"connectionPriority",true},{"trayMenuPlacement",true},{"blockedSmallPanel",true},{"customMenus",true},{"selectionPreview",true},{"qualityMenuPolicy",true},{"pointerCancellation",true},{"sourceSelection",true},{"compactHitTargets",true},{"waitingGuard",true},{"reducedMotion",true},{"immediateExpansion",true},{"countdownSemantics",true},{"hoverHints",true},{"independentSoundPanel",true},{"compactControlsHidden",true},{"layoutBounds",true},{"scrollRegions",true},{"titlebarHitTargets",true},{"automaticLayout",true},{"compactAudioInteraction",true},{"audioRefreshCancellation",true},{"previewPresentation",true},{"waitingHasNoTimer",true},{"noManualLayout",true},{"contrast",ratios}}.dump(2);
}
void selfTest(const std::wstring& output){
  Json manifest={{"product","XgoatCast"},{"version","0.0.1-beta.2"},{"downloadUrl","https://example.com/setup.exe"},{"releasePageUrl","https://cast.xgoat.top/downloads.html"},{"notes","版本更新"}};
  auto update=parseUpdateManifest(manifest,"0.0.1-beta.1");if(!update.available||update.releasePageUrl!="https://cast.xgoat.top/downloads.html")throw std::runtime_error("更新检测测试失败");
  if(parseUpdateManifest(manifest,"0.0.1-beta.2").available||parseUpdateManifest(manifest,"0.0.1").available)throw std::runtime_error("重复或旧版本触发了更新");
  manifest["releasePageUrl"]="http://example.com";bool rejected=false;try{parseUpdateManifest(manifest,"0.0.1-beta.1");}catch(...){rejected=true;}if(!rejected)throw std::runtime_error("不安全更新页面未被拒绝");
  policyTests();previewTests();auto l=parseLaunch(L"xgoatcast://share?server=https%3A%2F%2Fexample.com&t=abcdefghijklmnop&cid=abcdefghijklmnop");if(l.server!="https://example.com"||l.quality!="1080p_2")throw std::runtime_error("URL 解析测试失败");for(auto url:{L"xgoatcast://share?server=http%3A%2F%2Fevil.example&t=abcdefghijklmnop&cid=abcdefghijklmnop",L"xgoatcast://share?server=https%3A%2F%2Fexample.com%2Fbad&t=abcdefghijklmnop&cid=abcdefghijklmnop",L"xgoatcast://share?server=https%3A%2F%2Fexample.com&t=abcdefghijklmnop&t=duplicate0000000&cid=abcdefghijklmnop"}){bool rejected=false;try{parseLaunch(url);}catch(...){rejected=true;}if(!rejected)throw std::runtime_error("非法 URL 未被拒绝");}std::ofstream file{std::filesystem::path(output)};file<<"URL and audio policy tests passed\n";}
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int){
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
  int argc=0;auto argv=CommandLineToArgvW(GetCommandLineW(),&argc);std::wstring iconOutput,uri,report,serverReport,serverOrigin,previewReport,audioConfig,audioOutput,renderOutput,uiReport;int compactMode=0;bool hidden=false,sdkTest=false,serverProbe=false,renderRegistration=false,renderAudio=false;
  for(int i=1;i<argc;++i){std::wstring a=argv[i];if((a==L"--server-test"||a==L"--server-probe")&&i+2<argc){serverOrigin=argv[++i];serverReport=argv[++i];serverProbe=a==L"--server-probe";}if(a==L"--export-icon"&&i+1<argc)iconOutput=argv[++i];if(a.rfind(L"xgoatcast:",0)==0)uri=a;if(a==L"--preview-test"&&i+1<argc)previewReport=argv[++i];if(a==L"--ui-test"&&i+1<argc)uiReport=argv[++i];if(a==L"--tray")hidden=true;if(a==L"--smoke")smoke=true;if(a==L"--self-test"&&i+1<argc)report=argv[++i];if(a==L"--sdk-test"&&i+1<argc){report=argv[++i];sdkTest=true;}if(a==L"--audio-test"&&i+2<argc){audioConfig=argv[++i];audioOutput=argv[++i];}if((a==L"--render-test"||a==L"--render-registration"||a==L"--render-audio"||a==L"--render-sharing"||a==L"--render-ready"||a==L"--render-countdown")&&i+1<argc){renderOutput=argv[++i];renderRegistration=a==L"--render-registration";renderAudio=a==L"--render-audio";compactMode=a==L"--render-sharing"?1:a==L"--render-ready"?2:a==L"--render-countdown"?3:0;}}LocalFree(argv);
  try{
    if(!serverReport.empty()){if(serverProbe){if(!probeServer(utf8(serverOrigin)))throw std::runtime_error("Server probe rejected response");std::ofstream file{std::filesystem::path(serverReport)};file<<Json{{"online",true},{"endpoint","/api/meta/admin-migration"}}.dump(2);}else serverMonitorTest(utf8(serverOrigin),serverReport);return 0;}
    if(!previewReport.empty()){previewCaptureTest(previewReport);return 0;}
    if(!report.empty()){if(sdkTest)sdkSelfTest(report);else selfTest(report);return 0;}
    if(!audioConfig.empty()){
      std::ifstream input{std::filesystem::path(audioConfig)};Json config;input>>config;
      auto pids=config.at("pids").get<std::set<DWORD>>();if(pids.empty()||pids.size()>10||pids.count(0))throw std::runtime_error("测试必须限制到明确的音源进程");
      std::set<std::wstring> excluded;for(auto&name:config.at("excluded"))excluded.insert(stem(wide(name.get<std::string>())));
      std::ofstream output{std::filesystem::path(audioOutput),std::ios::binary};if(!output)throw std::runtime_error("无法写入测试结果");
      std::string failure;Audio test;if(config.contains("included")){std::set<std::wstring> names;for(auto&n:config["included"])names.insert(stem(wide(n.get<std::string>())));test.include(names);}test.start(excluded,[&](const short*pcm){output.write(reinterpret_cast<const char*>(pcm),1920);},[&](std::string error){failure=error;},pids);
      int duration=std::clamp(config.value("captureMs",3200),2000,10000);
      if(config.value("toggleOff",false)){Sleep(1500);test.include({});Sleep(duration-1500);}
      else if(config.value("toggleOn",false)){Sleep(1000);std::set<std::wstring> names;for(auto&n:config.at("includedAfter"))names.insert(stem(wide(n.get<std::string>())));test.include(names);Sleep(duration-1000);}
      else Sleep(duration);test.stop();output.close();if(!failure.empty())throw std::runtime_error(failure);return 0;
    }
    HANDLE mutex=CreateMutexW(nullptr,FALSE,L"Local\\XgoatCast.Native");if(GetLastError()==ERROR_ALREADY_EXISTS&&!smoke&&renderOutput.empty()&&uiReport.empty()&&iconOutput.empty()){HWND other=FindWindowW(ClassName,nullptr);if(other){if(!uri.empty()){COPYDATASTRUCT data{0x58434754,(DWORD)((uri.size()+1)*sizeof(wchar_t)),uri.data()};DWORD_PTR result;SendMessageTimeoutW(other,WM_COPYDATA,0,reinterpret_cast<LPARAM>(&data),SMTO_ABORTIFHUNG,3000,&result);}ShowWindow(other,SW_RESTORE);SetForegroundWindow(other);}CloseHandle(mutex);return 0;}
    HRESULT com=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);GdiplusStartupInput startup;ULONG_PTR token;GdiplusStartup(&token,&startup,nullptr);
    if(!iconOutput.empty()){exportIcons(iconOutput);GdiplusShutdown(token);if(SUCCEEDED(com))CoUninitialize();return 0;}
    settings=readSettings();if(windowsBuild()<20348)settings.audio=false;refreshWindowIcons(GetDpiForSystem());{SHFILEINFOW info{};if(SHGetFileInfoW(L"program.exe",FILE_ATTRIBUTE_NORMAL,&info,sizeof(info),SHGFI_ICON|SHGFI_LARGEICON|SHGFI_USEFILEATTRIBUTES))genericIcon=info.hIcon;}WNDCLASSEXW c{};c.cbSize=sizeof(c);c.hInstance=instance;c.lpszClassName=ClassName;c.lpfnWndProc=wndProc;c.hCursor=LoadCursorW(nullptr,IDC_ARROW);c.hIcon=icon;c.hIconSm=smallIcon;RegisterClassExW(&c);
    scale=GetDpiForSystem()/96.f;window=CreateWindowExW(WS_EX_APPWINDOW,ClassName,L"XgoatCast · 共享",WS_POPUP|WS_MINIMIZEBOX|WS_SYSMENU,CW_USEDEFAULT,CW_USEDEFAULT,int(uiWidth()*scale),int(uiHeight()*scale),nullptr,nullptr,instance,nullptr);if(!window)throw std::runtime_error("无法创建共享窗口");
    BOOL dark=FALSE;DwmSetWindowAttribute(window,20,&dark,sizeof(dark));DWMNCRENDERINGPOLICY noFrame=DWMNCRP_DISABLED;DwmSetWindowAttribute(window,DWMWA_NCRENDERING_POLICY,&noFrame,sizeof(noFrame));DWORD corner=3;DwmSetWindowAttribute(window,33,&corner,sizeof(corner));DWORD border=0xfffffffe;DwmSetWindowAttribute(window,34,&border,sizeof(border));MARGINS margins{0,0,0,0};DwmExtendFrameIntoClientArea(window,&margins);
    {BOOL animate=TRUE;SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animate,0);motionAllowed=animate!=FALSE;}
    resize();
    if(!renderOutput.empty()||!uiReport.empty()){if(!uiReport.empty())uiSelfTest(uiReport);else renderPreview(renderOutput,renderRegistration,renderAudio,compactMode);DestroyWindow(window);if(genericIcon)DestroyIcon(genericIcon);DestroyIcon(icon);DestroyIcon(smallIcon);GdiplusShutdown(token);if(SUCCEEDED(com))CoUninitialize();CloseHandle(mutex);return 0;}
    registered=protocolRegistered();if(!registered&&!smoke){registerProtocol(true);localMessage.clear();}SetTimer(window,2,1000,nullptr);SetTimer(window,3,3000,nullptr);SetTimer(window,7,200,nullptr);session=std::make_unique<Session>(window);if(!smoke&&uri.empty()){serverMonitor=std::make_unique<ServerMonitor>(window);serverMonitor->watch(DefaultServer);}tray(true);if(!hidden)show();if(!uri.empty())receive(uri);if(!smoke){SetTimer(window,8,6*60*60*1000,nullptr);checkForUpdates(false);}if(smoke)SetTimer(window,1,3000,nullptr);
    MSG msg;while(GetMessageW(&msg,nullptr,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}serverMonitor.reset();session.reset();if(appsThread.joinable())appsThread.join();if(updateThread.joinable())updateThread.join();for(auto&[name,h]:appIcons)DestroyIcon(h);if(genericIcon)DestroyIcon(genericIcon);DestroyIcon(icon);DestroyIcon(smallIcon);GdiplusShutdown(token);if(SUCCEEDED(com))CoUninitialize();CloseHandle(mutex);return 0;
  }catch(const std::exception&e){if(!previewReport.empty()){std::ofstream file{std::filesystem::path(previewReport+L".error")};file<<e.what();}else if(!serverReport.empty()){std::ofstream file{std::filesystem::path(serverReport+L".error")};file<<e.what();}else if(!uiReport.empty()){std::ofstream file{std::filesystem::path(uiReport+L".error")};file<<e.what();}else if(!report.empty()){std::ofstream file{std::filesystem::path(report)};file<<e.what();}else if(!audioOutput.empty()){std::ofstream file{std::filesystem::path(audioOutput+L".error")};file<<e.what();}else MessageBoxW(nullptr,wide(e.what()).c_str(),L"XgoatCast",MB_ICONERROR);return 1;}
}
