#include "core.h"
#include <winhttp.h>
#include <shlobj.h>
#include <IAgoraRtcEngine.h>
#include <IAgoraMediaEngine.h>
#include <IAudioDeviceManager.h>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <filesystem>
#include <regex>

namespace xc {
std::string utf8(const std::wstring& s){if(s.empty())return {};int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),(int)s.size(),nullptr,0,nullptr,nullptr);if(!n)throw std::runtime_error("文字编码无效");std::string out(n,0);WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),out.data(),n,nullptr,nullptr);return out;}
std::wstring wide(const std::string& s){if(s.empty())return {};int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),(int)s.size(),nullptr,0);if(!n)throw std::runtime_error("文字编码无效");std::wstring out(n,0);MultiByteToWideChar(CP_UTF8,0,s.data(),(int)s.size(),out.data(),n);return out;}
std::wstring lower(std::wstring s){std::transform(s.begin(),s.end(),s.begin(),towlower);return s;}
std::wstring stem(std::wstring s){s=lower(s);auto at=s.find_last_of(L"/\\");if(at!=s.npos)s=s.substr(at+1);if(s.size()>4&&s.substr(s.size()-4)==L".exe")s.resize(s.size()-4);return s;}
std::wstring errorText(HRESULT hr){wchar_t* p=nullptr;FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER|FORMAT_MESSAGE_FROM_SYSTEM|FORMAT_MESSAGE_IGNORE_INSERTS,nullptr,hr,0,reinterpret_cast<wchar_t*>(&p),0,nullptr);std::wstring text=p?p:L"操作失败";if(p)LocalFree(p);return text;}
void check(HRESULT hr,const char* context){if(FAILED(hr))throw std::runtime_error(std::string(context)+": "+utf8(errorText(hr)));}
unsigned windowsBuild(){using Fn=LONG(WINAPI*)(OSVERSIONINFOW*);auto fn=reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlGetVersion"));OSVERSIONINFOW v{};v.dwOSVersionInfoSize=sizeof(v);return fn&&fn(&v)==0?v.dwBuildNumber:0;}
const std::map<std::string,Preset> qualities{{"480p_2",{640,480,30}},{"720p30",{1280,720,30}},{"1080p_2",{1920,1080,30}},{"1080p60",{1920,1080,60}},{"1440p30",{2560,1440,30}},{"1440p60",{2560,1440,60}},{"4k30",{3840,2160,30}}};
struct Url {
  std::wstring host,path;INTERNET_PORT port=0;bool secure=false;
  explicit Url(const std::string& raw,bool origin=false) {
  auto s=wide(raw);URL_COMPONENTS c{};c.dwStructSize=sizeof(c);
    c.dwHostNameLength=c.dwUrlPathLength=c.dwExtraInfoLength=c.dwUserNameLength=c.dwPasswordLength=DWORD(-1);
    if(!WinHttpCrackUrl(s.c_str(),0,0,&c))throw std::runtime_error("服务器地址无效");
    host.assign(c.lpszHostName,c.dwHostNameLength);path.assign(c.lpszUrlPath?c.lpszUrlPath:L"",c.dwUrlPathLength);port=c.nPort;secure=c.nScheme==INTERNET_SCHEME_HTTPS;
    if(c.dwUserNameLength||c.dwPasswordLength||host.empty()||
       (!secure&&(c.nScheme!=INTERNET_SCHEME_HTTP||(lower(host)!=L"localhost"&&host!=L"127.0.0.1"&&host!=L"[::1]"&&host!=L"::1")))||
       (origin&&(!path.empty()&&path!=L"/"||c.dwExtraInfoLength)))throw std::runtime_error("服务器必须为 HTTPS 网站根地址（本机调试除外）");
  }
};
struct VersionParts { int major=0, minor=0, patch=0; std::vector<std::string> prerelease; };
static bool parseVersion(const std::string& value,VersionParts& out){
  std::smatch match;
  if(!std::regex_match(value,match,std::regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$")))return false;
  try{out.major=std::stoi(match[1].str());out.minor=std::stoi(match[2].str());out.patch=std::stoi(match[3].str());}catch(...){return false;}
  if(match[4].matched){std::string rest=match[4].str();size_t at=0;while(at<=rest.size()){auto end=rest.find('.',at);if(end==std::string::npos)end=rest.size();if(end==at)return false;out.prerelease.push_back(rest.substr(at,end-at));if(end==rest.size())break;at=end+1;}}
  return true;
}
static int compareVersions(const VersionParts&a,const VersionParts&b){
  for(auto pair:{std::pair<int,int>{a.major,b.major},{a.minor,b.minor},{a.patch,b.patch}})if(pair.first!=pair.second)return pair.first<pair.second?-1:1;
  if(a.prerelease.empty()!=b.prerelease.empty())return a.prerelease.empty()?1:-1;
  for(size_t i=0;i<std::min(a.prerelease.size(),b.prerelease.size());++i){const auto&x=a.prerelease[i];const auto&y=b.prerelease[i];bool xn=std::regex_match(x,std::regex("0|[1-9][0-9]*")),yn=std::regex_match(y,std::regex("0|[1-9][0-9]*"));if(xn&&yn){auto xi=std::stoull(x),yi=std::stoull(y);if(xi!=yi)return xi<yi?-1:1;}else if(xn!=yn)return xn?-1:1;else if(x!=y)return x<y?-1:1;}
  if(a.prerelease.size()!=b.prerelease.size())return a.prerelease.size()<b.prerelease.size()?-1:1;return 0;
}
static std::string decode(std::string s){std::string out;auto hex=[](char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;};for(size_t i=0;i<s.size();++i){char c=s[i];if(c=='%'){if(i+2>=s.size()||hex(s[i+1])<0||hex(s[i+2])<0)throw std::runtime_error("共享链接编码无效");c=char(hex(s[i+1])*16+hex(s[i+2]));i+=2;}else if(c=='+')c=' ';if(!c||static_cast<unsigned char>(c)<32)throw std::runtime_error("共享链接包含非法字符");out+=c;}wide(out);return out;}
Launch parseLaunch(const std::wstring& input){
  auto s=utf8(input);if(s.size()>8192||s.find('#')!=s.npos)throw std::runtime_error("共享链接无效");
  auto q=s.find('?');auto head=s.substr(0,q);if(q==s.npos||(head!="xgoatcast://share"&&head!="xgoatcast://share/"))throw std::runtime_error("不是 XgoatCast 共享链接");
  std::map<std::string,std::string> fields;size_t at=q+1;
  while(at<s.size()){auto end=s.find('&',at);if(end==s.npos)end=s.size();auto pair=s.substr(at,end-at);auto eq=pair.find('=');if(eq==pair.npos)throw std::runtime_error("共享参数无效");auto key=decode(pair.substr(0,eq));if(!fields.emplace(key,decode(pair.substr(eq+1))).second)throw std::runtime_error("共享参数重复");at=end+1;}
  Launch l;l.server=fields["server"];Url url(l.server,true);while(!l.server.empty()&&l.server.back()=='/')l.server.pop_back();
  l.token=fields["t"];l.clientId=fields["cid"];l.launchId=fields["launchId"];
  if(!l.launchId.empty()&&!std::regex_match(l.launchId,std::regex("[a-zA-Z0-9_-]{16,128}")))throw std::runtime_error("客户端唤起标识无效");
  if(!std::regex_match(l.token,std::regex("[a-zA-Z0-9_-]{16,256}"))||!std::regex_match(l.clientId,std::regex("[a-zA-Z0-9_-]{16,128}")))throw std::runtime_error("共享链接缺少会话参数");
  if(fields.count("quality"))l.quality=fields["quality"];if(!qualities.count(l.quality))throw std::runtime_error("不支持的画质");
  l.lowLatency=fields["lowLatency"]=="1";l.detail=fields["optimizationMode"]=="detail";return l;
}
struct Internet {HINTERNET h=nullptr;explicit Internet(HINTERNET v):h(v){if(!h)throw std::runtime_error("无法连接共享服务器");}~Internet(){WinHttpCloseHandle(h);}operator HINTERNET()const{return h;}};
static Json requestJson(const std::string& origin,const std::wstring& path,const Json* body,int timeout=3000){
  Url url(origin,true);Internet session(WinHttpOpen(wide(std::string("XgoatCast/")+AppVersion).c_str(),WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,WINHTTP_NO_PROXY_NAME,WINHTTP_NO_PROXY_BYPASS,0));WinHttpSetTimeouts(session,timeout,timeout,timeout,timeout);
  Internet connection(WinHttpConnect(session,url.host.c_str(),url.port,0));
  Internet req(WinHttpOpenRequest(connection,body?L"POST":L"GET",path.c_str(),nullptr,WINHTTP_NO_REFERER,WINHTTP_DEFAULT_ACCEPT_TYPES,url.secure?WINHTTP_FLAG_SECURE:0));
  DWORD redirect=WINHTTP_OPTION_REDIRECT_POLICY_NEVER;WinHttpSetOption(req,WINHTTP_OPTION_REDIRECT_POLICY,&redirect,sizeof(redirect));
  std::string payload=body?body->dump():"";
  if(!WinHttpSendRequest(req,L"Content-Type: application/json\r\nCache-Control: no-cache\r\n",DWORD(-1),payload.empty()?nullptr:payload.data(),(DWORD)payload.size(),(DWORD)payload.size(),0)||!WinHttpReceiveResponse(req,nullptr))throw std::runtime_error("共享服务器连接中断，请检查网络");
  DWORD status=0,size=sizeof(status);if(!WinHttpQueryHeaders(req,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,nullptr,&status,&size,nullptr))throw std::runtime_error("服务器响应无效");
  std::string data;char buffer[8192];DWORD read=0;
  do{if(!WinHttpReadData(req,buffer,sizeof(buffer),&read))throw std::runtime_error("服务器响应中断");data.append(buffer,read);if(data.size()>1024*1024)throw std::runtime_error("服务器响应过大");}while(read);
  if(status<200||status>=300){auto error=Json::parse(data,nullptr,false);std::string message="服务器拒绝请求，请回网页检查会话（"+std::to_string(status)+"）";if(error.is_object()&&error.contains("message")&&error["message"].is_string())message=error["message"].get<std::string>();throw std::runtime_error(message);}
  auto result=Json::parse(data);if(!result.is_object())throw std::runtime_error("服务器响应格式无效");return result;
}
Json request(const Launch& launch,const std::string& endpoint,const Json* body){
  auto query="/api/share/"+endpoint+"?t="+launch.token+(endpoint=="token"?"&role=publisher":"");
  if(endpoint=="info"&&!launch.launchId.empty())query+="&role=publisher&desktopLaunchId="+launch.launchId+"&desktopClientId="+launch.clientId;
  return requestJson(launch.server,wide(query),body);
}
UpdateInfo parseUpdateManifest(const Json& result,const std::string& currentVersion){
  if(result.value("product",std::string())!="XgoatCast")throw std::runtime_error("更新清单不是 XgoatCast");
  auto version=result.value("version",std::string());VersionParts current,latest;if(!parseVersion(currentVersion,current)||!parseVersion(version,latest))throw std::runtime_error("更新版本号无效");
  if(compareVersions(latest,current)<=0)return {};
  auto download=result.value("downloadUrl",std::string());Url downloadUrl(download,false);if(!downloadUrl.secure)throw std::runtime_error("更新下载地址必须使用 HTTPS");
  auto page=result.value("releasePageUrl",std::string(DefaultServer)+ReleasePagePath);if(page.empty())page=std::string(DefaultServer)+ReleasePagePath;Url pageUrl(page,false);if(!pageUrl.secure)throw std::runtime_error("更新页面地址必须使用 HTTPS");
  auto notes=result.value("notes",std::string());if(notes.size()>4000)notes.resize(4000);
  return {true,version,download,page,notes,result.value("publishedAt",std::string())};
}
UpdateInfo checkForUpdate(){return parseUpdateManifest(requestJson(DefaultServer,wide(std::string(UpdateManifestPath)+"?client="+AppVersion),nullptr,5000),AppVersion);}
bool probeServer(const std::string& origin){
  // Existing anonymous backend route: a real JSON response, not a cached home page or session endpoint.
  auto result=requestJson(origin,L"/api/meta/admin-migration?probe="+std::to_wstring(GetTickCount64()),nullptr,1500);
  return result.value("canonicalPlatform",std::string())=="kook"&&result.contains("legacyAdminSunsetAt")&&result["legacyAdminSunsetAt"].is_number();
}
struct ServerMonitor::Impl {
  HWND notify;unsigned interval;std::mutex lock;std::condition_variable changed;std::thread worker;
  std::string origin;ServerConnection status=ServerConnection::Checking;bool quit=false;uint64_t generation=0;
  Impl(HWND target,unsigned period):notify(target),interval(period){worker=std::thread([this]{run();});}
  ~Impl(){{std::lock_guard<std::mutex> guard(lock);quit=true;}changed.notify_all();if(worker.joinable())worker.join();}
  void post(){if(notify)PostMessageW(notify,WM_SERVER_STATUS,0,0);}
  void watch(std::string next){
    if(!next.empty())Url validate(next,true);
    {std::lock_guard<std::mutex> guard(lock);origin=std::move(next);++generation;status=ServerConnection::Checking;}
    changed.notify_all();post();
  }
  ServerConnection snapshot(){std::lock_guard<std::mutex> guard(lock);return status;}
  void run(){
    std::unique_lock<std::mutex> guard(lock);
    while(!quit){
      changed.wait(guard,[this]{return quit||!origin.empty();});if(quit)break;
      auto target=origin;auto version=generation;guard.unlock();ServerConnection result=ServerConnection::Offline;
      try{if(probeServer(target))result=ServerConnection::Online;}catch(...){/* A network failure changes only the connection lamp, never the sharing session. */}
      guard.lock();if(quit)break;if(version!=generation)continue;status=result;guard.unlock();post();guard.lock();
      changed.wait_for(guard,std::chrono::milliseconds(interval),[this,version]{return quit||version!=generation;});
    }
  }
};
ServerMonitor::ServerMonitor(HWND notify,unsigned intervalMs):impl(std::make_unique<Impl>(notify,intervalMs)){}
ServerMonitor::~ServerMonitor()=default;
void ServerMonitor::watch(std::string origin){impl->watch(std::move(origin));}
ServerConnection ServerMonitor::snapshot(){return impl->snapshot();}
void serverMonitorTest(const std::string& origin,const std::wstring& output){
  // Local HTTP fixture sequences success -> HTTP failure / invalid JSON -> recovery.
  ServerMonitor monitor(nullptr,180);monitor.watch(origin);
  auto wait=[&](ServerConnection expected){auto deadline=GetTickCount64()+5000;while(GetTickCount64()<deadline){if(monitor.snapshot()==expected)return;Sleep(10);}throw std::runtime_error("Server monitor transition missing");};
  wait(ServerConnection::Online);wait(ServerConnection::Offline);wait(ServerConnection::Online);
  monitor.watch(origin);Sleep(40);monitor.watch("");Sleep(350);if(monitor.snapshot()!=ServerConnection::Checking)throw std::runtime_error("Old probe overwrote stopped monitor");
  std::ofstream file{std::filesystem::path(output)};file<<Json{{"startupWithoutToken",true},{"offlineDetected",true},{"automaticRecovery",true},{"pausedAfterLaunch",true},{"staleResultIgnored",true}}.dump(2);
}
static std::filesystem::path configDir(){wchar_t* path=nullptr;check(SHGetKnownFolderPath(FOLDERID_LocalAppData,0,nullptr,&path),"读取设置目录");std::filesystem::path p=std::filesystem::path(path)/L"XgoatCast";CoTaskMemFree(path);std::filesystem::create_directories(p);return p;}
Settings readSettings(){Settings s;try{std::ifstream in(configDir()/L"settings.json");if(!in)return s;Json j;in>>j;s.microphoneDevice=j.value("microphoneDevice",std::string());if(s.microphoneDevice.size()>511)s.microphoneDevice.clear();s.screens=j.value("screens",true);s.audio=j.value("audio",false);s.detail=j.value("detail",false);s.lowLatency=j.value("lowLatency",false);auto quality=j.value("quality",std::string("1080p_2"));if(qualities.count(quality))s.quality=quality;if(j.contains("excluded")&&j["excluded"].is_array()&&j["excluded"].size()<=300){s.excluded.clear();for(auto&x:j["excluded"]){auto name=stem(wide(x.get<std::string>()));if(!name.empty()&&name.size()<260)s.excluded.insert(name);}}s.loaded=true;}catch(...){}return s;}
void saveSettings(const Settings&s){Json j{{"microphoneDevice",s.microphoneDevice},{"screens",s.screens},{"audio",s.audio},{"detail",s.detail},{"lowLatency",s.lowLatency},{"quality",s.quality},{"excluded",Json::array()}};for(auto&n:s.excluded)j["excluded"].push_back(utf8(n));auto dir=configDir();{std::ofstream file(dir/L"settings.tmp",std::ios::binary|std::ios::trunc);file<<j.dump(2);file.flush();if(!file)throw std::runtime_error("无法保存设置");}if(!MoveFileExW((dir/L"settings.tmp").c_str(),(dir/L"settings.json").c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("无法保存设置");}

using namespace agora::rtc;
using agora::CHANNEL_PROFILE_COMMUNICATION;
using agora::CHANNEL_PROFILE_LIVE_BROADCASTING;
static Microphones recordingDevices(IRtcEngine* engine){
  Microphones result;AAudioDeviceManager manager(engine);
  if(!manager)throw std::runtime_error("无法读取麦克风设备，请检查音频设备");
  auto list=manager->enumerateRecordingDevices();
  if(!list)throw std::runtime_error("无法读取麦克风设备列表");
  try{
    char name[MAX_DEVICE_ID_LENGTH]{},id[MAX_DEVICE_ID_LENGTH]{};
    if(list->getDefaultDevice(name,id)>=0)result.defaultName=wide(name);
    for(int i=0;i<list->getCount();++i){
      if(list->getDevice(i,name,id)>=0&&id[0])result.devices.push_back({id,wide(name)});
    }
    list->release();return result;
  }catch(...){list->release();throw;}
}
static void useRecordingDevice(IRtcEngine* engine,const std::string& id){
  AAudioDeviceManager manager(engine);
  if(!manager)throw std::runtime_error("无法切换麦克风，请检查音频设备");
  int code=manager->followSystemRecordingDevice(id.empty());
  if(code>=0&&!id.empty())code=manager->setRecordingDevice(id.c_str());
  if(code<0)throw std::runtime_error("无法切换麦克风，请重新选择设备（"+std::to_string(code)+"）");
}

void sdkSelfTest(const std::wstring& output){
  auto hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);check(hr,"测试 COM");
  auto engine=createAgoraRtcEngine();if(!engine){CoUninitialize();throw std::runtime_error("无法创建 SDK");}
  agora::media::IMediaEngine* media=nullptr;IScreenCaptureSourceList* list=nullptr;
  IRtcEngineEventHandler events;
  auto require=[](int code,const char* stage){if(code<0)throw std::runtime_error(std::string("SDK 自检失败: ")+stage+" "+std::to_string(code));};
  try{
    // A syntactically valid dummy App ID, never used to join or publish.
    RtcEngineContext context;context.appId="bd5ba8360f564c74a4cd2e752b13039f";context.eventHandler=&events;
    auto log=utf8((std::filesystem::path(output).parent_path()/L"sdk-test.log").wstring());context.logConfig.filePath=log.c_str();
    require(engine->initialize(context),"initialize");require(engine->enableLocalAudio(false),"disable microphone");require(engine->enableLocalVideo(false),"disable camera");
    require(engine->queryInterface(AGORA_IID_MEDIA_ENGINE,reinterpret_cast<void**>(&media)),"media interface");
    AudioTrackConfig config;config.enableLocalPlayback=false;auto track=media->createCustomAudioTrack(AUDIO_TRACK_MIXABLE,config);
    if(track==0xffffffff)throw std::runtime_error("SDK 自定义音轨测试失败");require(media->destroyCustomAudioTrack(track),"destroy custom audio");
    auto microphones=recordingDevices(engine);useRecordingDevice(engine,{});
    for(auto&device:microphones.devices){
      useRecordingDevice(engine,device.id);AAudioDeviceManager manager(engine);char current[MAX_DEVICE_ID_LENGTH]{};
      require(manager->getRecordingDevice(current),"read selected microphone");
      if(device.id!=current)throw std::runtime_error("麦克风设备选择未生效");
    }
    useRecordingDevice(engine,{});
    // Zero-size images: enumerate handles only, never record a screen image.
    list=engine->getScreenCaptureSources(SIZE{0,0},SIZE{0,0},true);
    if(!list||list->getCount()==0)throw std::runtime_error("SDK 未返回画面来源");
    std::ofstream report{std::filesystem::path(output)};report<<"SDK initialization, custom audio track and source enumeration passed; count="<<list->getCount()<<"; microphone selection passed; microphones="<<microphones.devices.size()<<"\n";
    list->release();list=nullptr;media->release();media=nullptr;engine->release();CoUninitialize();
  }catch(...){if(list)list->release();if(media)media->release();engine->release();CoUninitialize();throw;}
}
// Observe only the screen track already being published. Preview never captures another source
// or writes into an SDK-owned frame; a bounded immutable copy is shared with the UI.
class ScreenPreview final : public agora::media::IVideoFrameObserver {
  std::mutex mutex;bool enabled=false;ULONGLONG last=0;
  std::shared_ptr<const PreviewFrame> frame;
 public:
  void enable(bool value){std::lock_guard<std::mutex> guard(mutex);enabled=value;frame.reset();last=0;}
  std::shared_ptr<const PreviewFrame> snapshot(){std::lock_guard<std::mutex> guard(mutex);return frame;}
  agora::media::base::VIDEO_PIXEL_FORMAT getVideoFormatPreference() override{return agora::media::base::VIDEO_PIXEL_I420;}
  uint32_t getObservedFramePosition() override{return agora::media::base::POSITION_POST_CAPTURER;}
  VIDEO_FRAME_PROCESS_MODE getVideoFrameProcessMode() override{return PROCESS_MODE_READ_ONLY;}
  bool onCaptureVideoFrame(VIDEO_SOURCE_TYPE source,VideoFrame& input) override{
    if(source!=VIDEO_SOURCE_SCREEN_PRIMARY)return true;
    try{
      std::lock_guard<std::mutex> guard(mutex);auto now=GetTickCount64();if(!enabled||(frame&&now-last<200))return true;
      if(input.type!=agora::media::base::VIDEO_PIXEL_I420||input.width<=0||input.height<=0||input.width>16384||input.height>16384||!input.yBuffer||!input.uBuffer||!input.vBuffer||input.yStride<input.width||input.uStride<(input.width+1)/2||input.vStride<(input.width+1)/2)return true;
      int rotation=input.rotation;if(rotation!=0&&rotation!=90&&rotation!=180&&rotation!=270)return true;
      bool sideways=rotation==90||rotation==270;int w=sideways?input.height:input.width,h=sideways?input.width:input.height;
      double scale=std::min(1.,std::min(640./w,360./h));auto next=std::make_shared<PreviewFrame>();next->width=std::max(1,int(w*scale));next->height=std::max(1,int(h*scale));next->observedAt=now;next->image.resize(size_t(next->width)*next->height*4);
      using ColorSpace=agora::media::base::ColorSpace;
      // The SDK documents full-range BT.709 when color metadata is unspecified.
      // Derive fixed-point coefficients once per accepted frame, before the bounded pixel loop.
      double kr=.2126,kb=.0722;
      if(input.colorSpace.matrix==ColorSpace::MATRIXID_BT470BG||input.colorSpace.matrix==ColorSpace::MATRIXID_SMPTE170M){kr=.299;kb=.114;}
      else if(input.colorSpace.matrix==ColorSpace::MATRIXID_BT2020_NCL){kr=.2627;kb=.0593;}
      bool limited=input.colorSpace.range==ColorSpace::RANGEID_LIMITED;
      double chroma=limited?255./224.:1.,kg=1.-kr-kb;
      auto fixed=[](double value){return int(value*65536.+.5);};
      int yOffset=limited?16:0,yGain=fixed(limited?255./219.:1.);
      int rV=fixed(2.*(1.-kr)*chroma),bU=fixed(2.*(1.-kb)*chroma);
      int gU=fixed(2.*kb*(1.-kb)/kg*chroma),gV=fixed(2.*kr*(1.-kr)/kg*chroma);
      auto channel=[](int value){return BYTE(std::clamp((value+32768)/65536,0,255));};
      for(int y=0;y<next->height;++y)for(int x=0;x<next->width;++x){int rx=x*w/next->width,ry=y*h/next->height,sx=rx,sy=ry;
        if(rotation==90){sx=ry;sy=input.height-1-rx;}else if(rotation==180){sx=input.width-1-rx;sy=input.height-1-ry;}else if(rotation==270){sx=input.width-1-ry;sy=rx;}
        int Y=yGain*(int(input.yBuffer[size_t(sy)*input.yStride+sx])-yOffset),U=int(input.uBuffer[size_t(sy/2)*input.uStride+sx/2])-128,V=int(input.vBuffer[size_t(sy/2)*input.vStride+sx/2])-128;
        auto out=next->image.data()+(size_t(y)*next->width+x)*4;
        out[0]=channel(Y+bU*U);out[1]=channel(Y-gU*U-gV*V);out[2]=channel(Y+rV*V);out[3]=255;
      }frame=std::move(next);last=now;
    }catch(...){/* Preview allocation failure must not interrupt publishing. */}
    return true;
  }
  bool onPreEncodeVideoFrame(VIDEO_SOURCE_TYPE,VideoFrame&) override{return true;}
  bool onRenderVideoFrame(const char*,agora::rtc::uid_t,VideoFrame&) override{return true;}
  bool onMediaPlayerVideoFrame(VideoFrame&,int) override{return true;}
  bool onTranscodedVideoFrame(VideoFrame&) override{return true;}
};
void previewTests(){
  auto require=[](bool ok){if(!ok)throw std::runtime_error("Screen preview test failed");};
  using ColorSpace=agora::media::base::ColorSpace;
  ScreenPreview preview;agora::media::base::VideoFrame input;input.type=agora::media::base::VIDEO_PIXEL_I420;input.width=4;input.height=2;input.yStride=6;input.uStride=input.vStride=3;
  input.colorSpace.matrix=ColorSpace::MATRIXID_SMPTE170M;input.colorSpace.range=ColorSpace::RANGEID_LIMITED;
  BYTE y[]={16,16,235,235,99,99,16,16,235,235,99,99},u[]={128,128,99},v[]={128,128,99};input.yBuffer=y;input.uBuffer=u;input.vBuffer=v;
  preview.onCaptureVideoFrame(VIDEO_SOURCE_SCREEN_PRIMARY,input);require(!preview.snapshot());preview.enable(true);
  preview.onCaptureVideoFrame(VIDEO_SOURCE_CAMERA_PRIMARY,input);require(!preview.snapshot());
  preview.onCaptureVideoFrame(VIDEO_SOURCE_SCREEN_PRIMARY,input);auto image=preview.snapshot();require(image&&image->width==4&&image->height==2&&image->image[0]==0&&image->image[8]==255&&image->image[3]==255);
  require(y[0]==16&&y[2]==235&&u[0]==128);input.yStride=1;preview.enable(true);preview.onCaptureVideoFrame(VIDEO_SOURCE_SCREEN_PRIMARY,input);require(!preview.snapshot());input.yStride=6;
  input.rotation=90;preview.onCaptureVideoFrame(VIDEO_SOURCE_SCREEN_PRIMARY,input);image=preview.snapshot();require(image&&image->width==2&&image->height==4&&image->image[0]==0&&image->image[24]==255);
  auto previous=image;preview.onCaptureVideoFrame(VIDEO_SOURCE_SCREEN_PRIMARY,input);require(preview.snapshot()==previous);preview.enable(false);require(!preview.snapshot());
  require(preview.getVideoFrameProcessMode()==agora::media::IVideoFrameObserver::PROCESS_MODE_READ_ONLY);
  auto color=[&](ColorSpace::MatrixID matrix,ColorSpace::RangeID range,BYTE Y,BYTE U,BYTE V,int R,int G,int B,int tolerance=0){
    agora::media::base::VideoFrame sample;sample.type=agora::media::base::VIDEO_PIXEL_I420;sample.width=sample.height=2;sample.yStride=2;sample.uStride=sample.vStride=1;
    BYTE ys[]={Y,Y,Y,Y};sample.yBuffer=ys;sample.uBuffer=&U;sample.vBuffer=&V;sample.colorSpace.matrix=matrix;sample.colorSpace.range=range;
    preview.enable(true);preview.onCaptureVideoFrame(VIDEO_SOURCE_SCREEN_PRIMARY,sample);auto result=preview.snapshot();require(result&&result->image.size()==16);
    for(size_t i=0;i<result->image.size();i+=4)require(std::abs(int(result->image[i])-B)<=tolerance&&std::abs(int(result->image[i+1])-G)<=tolerance&&std::abs(int(result->image[i+2])-R)<=tolerance&&result->image[i+3]==255);
    require(ys[0]==Y);
  };
  for(auto matrix:{ColorSpace::MATRIXID_SMPTE170M,ColorSpace::MATRIXID_BT470BG,ColorSpace::MATRIXID_BT709,ColorSpace::MATRIXID_BT2020_NCL}){
    color(matrix,ColorSpace::RANGEID_FULL,16,128,128,16,16,16);color(matrix,ColorSpace::RANGEID_FULL,235,128,128,235,235,235);
    color(matrix,ColorSpace::RANGEID_LIMITED,16,128,128,0,0,0);color(matrix,ColorSpace::RANGEID_LIMITED,235,128,128,255,255,255);
    color(matrix,ColorSpace::RANGEID_LIMITED,126,128,128,128,128,128);
  }
  // Independent reference RGB values for YCbCr (128,160,96), rounded to 8 bits.
  color(ColorSpace::MATRIXID_SMPTE170M,ColorSpace::RANGEID_FULL,128,160,96,83,140,185,1);
  color(ColorSpace::MATRIXID_BT709,ColorSpace::RANGEID_FULL,128,160,96,78,137,187,1);
  color(ColorSpace::MATRIXID_BT2020_NCL,ColorSpace::RANGEID_FULL,128,160,96,81,141,188,1);
  color(ColorSpace::MATRIXID_SMPTE170M,ColorSpace::RANGEID_LIMITED,128,160,96,79,144,195,1);
  color(ColorSpace::MATRIXID_BT709,ColorSpace::RANGEID_LIMITED,128,160,96,73,141,198,1);
  color(ColorSpace::MATRIXID_BT2020_NCL,ColorSpace::RANGEID_LIMITED,128,160,96,77,145,199,1);
  color(ColorSpace::MATRIXID_UNSPECIFIED,ColorSpace::RANGEID_INVALID,128,160,96,78,137,187,1);
}
void previewCaptureTest(const std::wstring& output){
  // Capture only this purpose-created solid-color window; never enumerate or capture the desktop.
  check(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED),"测试 COM");
  ScreenPreview preview;IRtcEngineEventHandler events;IRtcEngine* engine=nullptr;agora::media::IMediaEngine* media=nullptr;
  HBRUSH red=CreateSolidBrush(RGB(240,32,32)),blue=CreateSolidBrush(RGB(32,32,240));
  WNDCLASSW cls{};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(nullptr);cls.lpszClassName=L"XgoatCast.PreviewFixture";cls.hbrBackground=red;RegisterClassW(&cls);
  HWND fixture=CreateWindowExW(WS_EX_TOOLWINDOW,cls.lpszClassName,L"XgoatCast preview test",WS_POPUP,40,40,320,180,nullptr,nullptr,cls.hInstance,nullptr);
  auto cleanup=[&](){preview.enable(false);if(engine){if(media)media->registerVideoFrameObserver(nullptr);engine->stopPreview(VIDEO_SOURCE_SCREEN_PRIMARY);engine->stopScreenCapture();if(media)media->release();engine->release();}if(fixture)DestroyWindow(fixture);UnregisterClassW(cls.lpszClassName,cls.hInstance);DeleteObject(red);DeleteObject(blue);CoUninitialize();};
  auto require=[](bool ok,const char* action){if(!ok)throw std::runtime_error(action);};
  try{
    require(fixture!=nullptr,"Preview fixture window failed");ShowWindow(fixture,SW_SHOWNOACTIVATE);UpdateWindow(fixture);
    engine=createAgoraRtcEngine();require(engine!=nullptr,"Preview test engine failed");RtcEngineContext context;context.appId="bd5ba8360f564c74a4cd2e752b13039f";context.eventHandler=&events;
    auto log=utf8((std::filesystem::path(output).parent_path()/L"preview-sdk.log").wstring());context.logConfig.filePath=log.c_str();
    require(engine->initialize(context)>=0,"Preview SDK initialize failed");require(engine->enableLocalAudio(false)>=0,"Disable test microphone failed");require(engine->enableVideo()>=0,"Enable test video failed");require(engine->enableLocalVideo(false)>=0,"Disable test camera failed");
    require(engine->queryInterface(AGORA_IID_MEDIA_ENGINE,reinterpret_cast<void**>(&media))>=0&&media,"Preview media interface failed");preview.enable(true);require(media->registerVideoFrameObserver(&preview)>=0,"Preview observer registration failed");
    ScreenCaptureParameters params;params.dimensions=VideoDimensions(320,180);params.frameRate=5;params.captureMouseCursor=false;params.windowFocus=false;
    agora::rtc::Rectangle region;region.x=region.y=region.width=region.height=0;
    require(engine->startScreenCaptureByWindowId(reinterpret_cast<int64_t>(fixture),region,params)>=0,"Fixture capture failed");require(engine->startPreview(VIDEO_SOURCE_SCREEN_PRIMARY)>=0,"Screen preview start failed");
    auto waitColor=[&](bool wantBlue){auto deadline=GetTickCount64()+10000;while(GetTickCount64()<deadline){MSG msg;while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}auto image=preview.snapshot();if(image){auto pixel=image->image.data()+(size_t(image->height/2)*image->width+image->width/2)*4;if(wantBlue?pixel[0]>180&&pixel[2]<80:pixel[2]>180&&pixel[0]<80)return true;}Sleep(20);}return false;};
    require(waitColor(false),"No red fixture frame received from screen track");
    SetClassLongPtrW(fixture,GCLP_HBRBACKGROUND,reinterpret_cast<LONG_PTR>(blue));InvalidateRect(fixture,nullptr,TRUE);UpdateWindow(fixture);
    require(waitColor(true),"Preview did not update to blue fixture frame");auto image=preview.snapshot();
    std::ofstream report{std::filesystem::path(output)};report<<Json{{"screenTrackFrames",true},{"liveColorChange",true},{"width",image->width},{"height",image->height},{"fixtureOnly",true},{"joinedRoom",false}}.dump(2);cleanup();
  }catch(...){cleanup();throw;}
}
struct Session::Impl : IRtcEngineEventHandler {
  HWND notify;std::mutex lock,queueLock,errorLock;std::condition_variable changed;Snapshot state;Microphones microphones;std::string microphoneDevice;ULONGLONG microphonePoll=0;
  std::deque<std::function<void()>> commands;std::thread worker;std::atomic<bool> quit{false},cancel{false},joined{false},renew{false};
  std::string failure;Launch current;Json credentials;IRtcEngine* engine=nullptr;agora::media::IMediaEngine* media=nullptr;track_id_t track=0xffffffff;
  Audio audio;ScreenPreview screenPreview;bool claimed=false,streaming=false;ULONGLONG poll=0,tokenAt=0;std::string appId;
  explicit Impl(HWND h):notify(h){worker=std::thread([this]{run();});}
  ~Impl(){cancel=true;quit=true;changed.notify_all();if(worker.joinable())worker.join();}
  void update(Phase p,std::wstring message){ {std::lock_guard<std::mutex> guard(lock);state.phase=p;state.message=std::move(message);}PostMessageW(notify,WM_STATE,0,0);}
  Snapshot snapshot(){std::lock_guard<std::mutex> guard(lock);return state;}
  void enqueue(std::function<void()> fn){{std::lock_guard<std::mutex> guard(queueLock);commands.push_back(std::move(fn));}changed.notify_all();}
  void fail(std::string message){std::lock_guard<std::mutex> guard(errorLock);if(failure.empty())failure=std::move(message);}
  void ensure(){if(cancel||quit)throw std::runtime_error("共享已取消");std::lock_guard<std::mutex> guard(errorLock);if(!failure.empty())throw std::runtime_error(failure);}
  void sdk(int ret,const char* action){if(ret<0)throw std::runtime_error(std::string(action)+"失败（"+std::to_string(ret)+"）");}
  void onJoinChannelSuccess(const char*,uid_t,int) override{joined=true;}
  void onError(int err,const char*) override{fail("声网连接错误（"+std::to_string(err)+"）");}
  void onTokenPrivilegeWillExpire(const char*) override{renew=true;}
  void onRequestToken() override{renew=true;}
  void onLocalVideoStateChanged(VIDEO_SOURCE_TYPE source,LOCAL_VIDEO_STREAM_STATE status,LOCAL_VIDEO_STREAM_REASON reason) override {
    if(source==VIDEO_SOURCE_SCREEN_PRIMARY&&(status==LOCAL_VIDEO_STREAM_STATE_FAILED||reason==LOCAL_VIDEO_STREAM_REASON_SCREEN_CAPTURE_WINDOW_CLOSED))fail("共享窗口已关闭或采集不可用");
  }
  void onConnectionStateChanged(CONNECTION_STATE_TYPE status,CONNECTION_CHANGED_REASON_TYPE) override{if(status==CONNECTION_STATE_FAILED)fail("声网连接已断开");}
  void destroy(){screenPreview.enable(false);audio.stop();if(engine){if(media)media->registerVideoFrameObserver(nullptr);engine->stopScreenCapture();engine->leaveChannel();if(media&&track!=0xffffffff)media->destroyCustomAudioTrack(track);if(media){media->release();media=nullptr;}engine->release();engine=nullptr;}track=0xffffffff;joined=false;appId.clear();}
  void halt(bool notifyServer=true){
    bool wasClaimed=claimed;claimed=false;streaming=false;destroy();
    if(wasClaimed&&notifyServer)try{Json body=Json::object();request(current,"stop",&body);}catch(...){}
    std::lock_guard<std::mutex> guard(errorLock);failure.clear();
  }
  void init(){
    if(engine)return;
    credentials=request(current,"token");ensure();
    appId=credentials.at("appId").get<std::string>();if(appId.empty())throw std::runtime_error("服务器尚未配置声网");
    engine=createAgoraRtcEngine();if(!engine)throw std::runtime_error("无法启动声网引擎");
    RtcEngineContext context;context.appId=appId.c_str();context.eventHandler=this;context.audioScenario=AUDIO_SCENARIO_GAME_STREAMING;
    auto log=utf8((configDir()/L"agora.log").wstring());context.logConfig.filePath=log.c_str();context.logConfig.fileSizeInKB=512;
    sdk(engine->initialize(context),"初始化");
    sdk(engine->enableLocalAudio(false),"关闭麦克风");sdk(engine->enableLocalVideo(false),"关闭摄像头");
    sdk(engine->queryInterface(AGORA_IID_MEDIA_ENGINE,reinterpret_cast<void**>(&media)),"音频接口");
    refreshMicrophones(true);renew=false;tokenAt=GetTickCount64()+std::max(10,credentials.value("expireSec",3600)-60)*1000ULL;
  }
  void refreshMicrophones(bool apply=false){
    if(!engine)return;
    Microphones next;
    try{
      next=recordingDevices(engine);
      bool missing=!microphoneDevice.empty()&&std::none_of(next.devices.begin(),next.devices.end(),[&](const MicrophoneDevice& d){return d.id==microphoneDevice;});
      if(missing)microphoneDevice.clear();
      if(apply||missing)useRecordingDevice(engine,microphoneDevice);
      next.selected=microphoneDevice;
    }catch(const std::exception& e){next.selected=microphoneDevice;next.error=wide(e.what());}
    auto fingerprint=[](const Microphones& m){std::string value=utf8(m.defaultName)+m.selected+utf8(m.error);for(auto&d:m.devices)value+=d.id+utf8(d.name);return value;};
    bool changed=false;{std::lock_guard<std::mutex> guard(lock);changed=fingerprint(next)!=fingerprint(microphones);microphones=std::move(next);}
    if(changed)PostMessageW(notify,WM_MICROPHONES,0,0);
    microphonePoll=GetTickCount64()+3000;
  }
  void selectMicrophone(std::string id){
    if(!engine)return;
    auto previous=microphoneDevice;
    try{
      auto available=recordingDevices(engine);
      if(!id.empty()&&std::none_of(available.devices.begin(),available.devices.end(),[&](const MicrophoneDevice& d){return d.id==id;}))throw std::runtime_error("麦克风已断开，请选择其他设备");
      useRecordingDevice(engine,id);microphoneDevice=std::move(id);refreshMicrophones();
    }catch(const std::exception& e){
      try{useRecordingDevice(engine,previous);}catch(...){}
      {std::lock_guard<std::mutex> guard(lock);microphones.error=wide(e.what());}
      PostMessageW(notify,WM_MICROPHONES,0,0);
    }
  }
  void sources(){
    init();ensure();
    IScreenCaptureSourceList* list=engine->getScreenCaptureSources(SIZE{320,180},SIZE{32,32},true);
    if(!list)throw std::runtime_error("无法读取窗口列表");
    std::vector<Source> result;
    for(unsigned i=0;i<list->getCount();++i){auto entry=list->getSourceInfo(i);
      if(entry.type!=ScreenCaptureSourceType_Window&&entry.type!=ScreenCaptureSourceType_Screen)continue;
      if(entry.type==ScreenCaptureSourceType_Window&&entry.sourceId==reinterpret_cast<int64_t>(notify))continue;
      Source s{entry.sourceId,entry.type==ScreenCaptureSourceType_Screen,wide(entry.sourceName?entry.sourceName:"")};
      auto& image=entry.thumbImage;
      if(image.buffer&&image.width>0&&image.height>0&&image.width<=1000&&image.height<=1000&&image.length>=image.width*image.height*4){s.width=image.width;s.height=image.height;auto bytes=reinterpret_cast<const unsigned char*>(image.buffer);s.image.assign(bytes,bytes+s.width*s.height*4);}
      result.push_back(std::move(s));
    }
    list->release();{std::lock_guard<std::mutex> guard(lock);state.sources=std::move(result);}PostMessageW(notify,WM_STATE,0,0);
  }
  Json info(){auto j=request(current,"info");ensure();if(j.value("status","")=="ended")throw std::runtime_error("共享会话已结束，请重新获取链接");if(!streaming&&j.value("status","")=="active")throw std::runtime_error("此会话正在共享，请先在网页停止当前共享");{std::lock_guard<std::mutex> guard(lock);state.viewers=j.value("viewerCount",0);state.idleSeconds=j.value("idleRemainingSec",-1);state.noViewerSeconds=j.value("noViewerRemainingSec",-1);state.observedAt=GetTickCount64();state.serverObservedAt=state.observedAt;state.allowLowLatency=j.value("allowLowLatency",false);state.allowPreference=j.value("allowQualityPreference",false);state.room=wide(j.value("sharerUsername",std::string("共享会话")));state.allowedQualities.clear();if(j.contains("allowedQualities")&&j["allowedQualities"].is_array())for(auto&value:j["allowedQualities"])if(value.is_string()&&qualities.count(value.get<std::string>()))state.allowedQualities.push_back(value.get<std::string>());}PostMessageW(notify,WM_STATE,0,0);return j;}
  void load(Launch l){
    if(streaming)return;
    halt(false);ensure();{std::lock_guard<std::mutex> guard(lock);state=Snapshot{};}current=std::move(l);update(Phase::Loading,L"正在连接共享页…");
    info();poll=GetTickCount64()+2000;sources();update(Phase::Ready,L"选择一个画面，开始共享");
  }
  void begin(Source source,Settings settings){
    if(streaming||current.server.empty())return;ensure();{std::lock_guard<std::mutex> guard(errorLock);failure.clear();}
    update(Phase::Starting,L"正在启动共享…");auto j=info();
    if(j.value("status","")=="active")throw std::runtime_error("此会话正在共享，请先停止");
    if(j.contains("publisherClientId")&&!j["publisherClientId"].is_null()){auto owner=j["publisherClientId"].get<std::string>();if(!owner.empty()&&owner!=current.clientId)throw std::runtime_error("此会话正在其他客户端共享");}
    current.quality=settings.quality;
    if(!j.contains("allowedQualities")||std::find(j["allowedQualities"].begin(),j["allowedQualities"].end(),current.quality)==j["allowedQualities"].end())throw std::runtime_error("该画质未开放，请在客户端选择其他档位");
    destroy();init();ensure();
    current.lowLatency=j.value("status","")=="grace"?j.value("lowLatency",false):(settings.lowLatency&&j.value("allowLowLatency",false));
    current.detail=settings.detail&&j.value("allowQualityPreference",false);
    sdk(engine->setChannelProfile(current.lowLatency?CHANNEL_PROFILE_COMMUNICATION:CHANNEL_PROFILE_LIVE_BROADCASTING),"设置共享模式");
    sdk(engine->setClientRole(CLIENT_ROLE_BROADCASTER),"设置共享角色");
    sdk(engine->enableVideo(),"启用视频");sdk(engine->enableLocalVideo(false),"关闭摄像头");
    sdk(engine->enableLocalAudio(false),"关闭麦克风");
    sdk(engine->setScreenCaptureContentHint(current.detail?CONTENT_HINT_DETAILS:CONTENT_HINT_MOTION),"设置画面偏好");
    auto p=qualities.at(current.quality);ScreenCaptureParameters capture;
    capture.dimensions=VideoDimensions(p.width,p.height);capture.frameRate=p.fps;capture.captureMouseCursor=true;capture.windowFocus=false;
    if(j.contains("qualityBitrates")&&j["qualityBitrates"].is_object()&&j["qualityBitrates"].contains(current.quality))capture.bitrate=std::clamp(j["qualityBitrates"][current.quality].value("bitrateMax",0),0,50000);
    agora::rtc::Rectangle region;region.x=region.y=region.width=region.height=0;
    screenPreview.enable(true);if(media->registerVideoFrameObserver(&screenPreview)<0)screenPreview.enable(false);
    sdk(source.screen?engine->startScreenCaptureByDisplayId(static_cast<unsigned>(source.id),region,capture):engine->startScreenCaptureByWindowId(source.id,region,capture),"采集画面");
    ChannelMediaOptions options;options.publishCameraTrack=false;options.publishMicrophoneTrack=false;options.publishScreenTrack=true;options.autoSubscribeAudio=false;options.autoSubscribeVideo=false;options.clientRoleType=CLIENT_ROLE_BROADCASTER;
    options.channelProfile=current.lowLatency?CHANNEL_PROFILE_COMMUNICATION:CHANNEL_PROFILE_LIVE_BROADCASTING;
    options.publishMicrophoneTrack=settings.microphone;options.publishCustomAudioTrack=windowsBuild()>=20348;options.enableAudioRecordingOrPlayout=true;
    if(settings.microphone){if(!microphones.error.empty())throw std::runtime_error(utf8(microphones.error));if(microphones.devices.empty())throw std::runtime_error("没有可用麦克风，请关闭麦克风或连接设备");}
    sdk(engine->enableLocalAudio(settings.microphone),"设置麦克风");
    if(windowsBuild()>=20348){AudioTrackConfig config;config.enableLocalPlayback=false;track=media->createCustomAudioTrack(AUDIO_TRACK_MIXABLE,config);if(track==0xffffffff)throw std::runtime_error("无法创建软件声音轨道");options.publishCustomAudioTrackId=track;}
    joined=false;sdk(engine->joinChannel(credentials.at("token").get<std::string>().c_str(),credentials.at("channel").get<std::string>().c_str(),credentials.at("uid").get<unsigned>(),options),"加入共享");
    auto deadline=GetTickCount64()+15000;while(!joined){ensure();if(GetTickCount64()>deadline)throw std::runtime_error("共享连接超时");Sleep(20);}ensure();
    audio.include(settings.included);
    if(windowsBuild()>=20348)audio.start({},[this](const short* pcm){agora::media::IAudioFrameObserverBase::AudioFrame frame;frame.type=agora::media::IAudioFrameObserverBase::FRAME_TYPE_PCM16;frame.samplesPerChannel=480;frame.bytesPerSample=agora::rtc::TWO_BYTES_PER_SAMPLE;frame.channels=2;frame.samplesPerSec=48000;frame.buffer=const_cast<short*>(pcm);frame.renderTimeMs=engine->getCurrentMonotonicTimeInMs();if(media->pushAudioFrame(&frame,track)<0)fail("发送软件声音失败");},[this](auto message){fail(message);});
    ensure();Json body{{"quality",current.quality},{"clientId",current.clientId},{"lowLatency",current.lowLatency}};
    // Treat a lost start response as possibly claimed, so cleanup still attempts server stop.
    claimed=true;auto response=request(current,"start",&body);if(!response.value("ok",false)){claimed=false;throw std::runtime_error(response.value("message",std::string("服务器拒绝开始共享")));}
    ensure();streaming=true;poll=GetTickCount64()+2000;update(Phase::Sharing,L"正在共享 · 关闭面板后继续");
  }
  void tick(){
    if(engine&&GetTickCount64()>=microphonePoll)refreshMicrophones();
    if(!streaming){if(!current.server.empty()&&snapshot().phase==Phase::Ready&&GetTickCount64()>=poll){poll=GetTickCount64()+2000;info();}return;}ensure();auto now=GetTickCount64();
    if(now>=poll){poll=now+2000;auto j=info();if(j.value("status","")!="active"||j.value("publisherClientId",std::string())!=current.clientId){halt(false);update(Phase::Ready,L"共享已从网页停止");return;}Json body{{"clientId",current.clientId}};if(!request(current,"heartbeat",&body).value("ok",false))throw std::runtime_error("服务器已停止共享");}
    if(renew||now>=tokenAt){auto token=request(current,"token");ensure();if(token.value("appId","")!=appId||token.value("channel","")!=credentials.value("channel",""))throw std::runtime_error("共享配置已变更，请重新开始");sdk(engine->renewToken(token.at("token").get<std::string>().c_str()),"续期共享");renew=false;tokenAt=now+std::max(10,token.value("expireSec",3600)-60)*1000ULL;}
  }
  void run(){CoInitializeEx(nullptr,COINIT_MULTITHREADED);while(!quit){std::function<void()> fn;{std::unique_lock<std::mutex> guard(queueLock);changed.wait_for(guard,std::chrono::milliseconds(100),[this]{return quit||!commands.empty();});if(quit)break;if(!commands.empty()){fn=std::move(commands.front());commands.pop_front();}}
      try{if(fn)fn();tick();}catch(const std::exception&e){halt();update(cancel?Phase::Ready:Phase::Failed,wide(e.what()));}}
    halt();CoUninitialize();
  }
};
Session::Session(HWND h):impl(std::make_unique<Impl>(h)){}
Session::~Session()=default;
void Session::launch(Launch l,Settings settings){impl->cancel=false;impl->enqueue([p=impl.get(),l,settings]{p->microphoneDevice=settings.microphoneDevice;p->load(l);});}
void Session::refresh(){impl->enqueue([p=impl.get()]{if(!p->current.server.empty()&&!p->streaming)p->sources();});}
void Session::start(Source s,Settings settings){impl->cancel=false;impl->enqueue([p=impl.get(),s=std::move(s),settings]{p->begin(s,settings);});}
void Session::updateAudio(Settings settings){impl->enqueue([p=impl.get(),settings]{
  p->audio.include(settings.included);if(p->streaming){p->sdk(p->engine->enableLocalAudio(settings.microphone),"设置麦克风");ChannelMediaOptions options;options.publishMicrophoneTrack=settings.microphone;options.enableAudioRecordingOrPlayout=true;p->sdk(p->engine->updateChannelMediaOptions(options),"更新麦克风");}
});}
void Session::refreshMicrophones(){impl->enqueue([p=impl.get()]{p->refreshMicrophones();});}
void Session::selectMicrophone(std::string id){impl->enqueue([p=impl.get(),id=std::move(id)]{p->selectMicrophone(id);});}
Microphones Session::microphones(){std::lock_guard<std::mutex> guard(impl->lock);return impl->microphones;}
void Session::stop(){impl->cancel=true;impl->enqueue([p=impl.get()]{p->update(Phase::Stopping,L"正在停止共享…");p->halt();p->cancel=false;p->update(p->current.server.empty()?Phase::Idle:Phase::Ready,L"共享已停止");});}
Snapshot Session::snapshot(){return impl->snapshot();}
std::shared_ptr<const PreviewFrame> Session::preview(){return impl->screenPreview.snapshot();}
}
