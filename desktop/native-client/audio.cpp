#include "core.h"
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <wrl.h>
#include <deque>
#include <future>
#include <chrono>
#include <mmsystem.h>

namespace xc {
using Microsoft::WRL::ComPtr;
std::map<DWORD, Process> processes() {
  HANDLE h=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
  if(h==INVALID_HANDLE_VALUE) throw std::runtime_error("无法读取软件列表");
  std::map<DWORD,Process> result;
  PROCESSENTRY32W e{}; e.dwSize=sizeof(e);
  if(!Process32FirstW(h,&e)){CloseHandle(h);throw std::runtime_error("无法读取软件列表");}
  do {result.emplace(e.th32ProcessID,Process{e.th32ProcessID,e.th32ParentProcessID,stem(e.szExeFile)});} while(Process32NextW(h,&e));
  CloseHandle(h); return result;
}
static std::vector<Process> groupAudioApps(const std::vector<Process>& apps,const std::map<DWORD,Process>& all);
std::vector<Process> audioApps(bool groupComponents) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  check(CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_ALL,IID_PPV_ARGS(&enumerator)),"音频设备");
  ComPtr<IMMDeviceCollection> devices;
  check(enumerator->EnumAudioEndpoints(eRender,DEVICE_STATE_ACTIVE,&devices),"音频设备列表");
  UINT count=0;check(devices->GetCount(&count),"音频设备数量");
  std::set<DWORD> ids;
  for(UINT i=0;i<count;++i) {
    ComPtr<IMMDevice> device;check(devices->Item(i,&device),"音频设备");
    ComPtr<IAudioSessionManager2> manager;
    check(device->Activate(__uuidof(IAudioSessionManager2),CLSCTX_ALL,nullptr,reinterpret_cast<void**>(manager.GetAddressOf())),"软件声音列表");
    ComPtr<IAudioSessionEnumerator> sessions;check(manager->GetSessionEnumerator(&sessions),"软件声音列表");
    int total=0;check(sessions->GetCount(&total),"软件声音列表");
    for(int j=0;j<total;++j) {
      ComPtr<IAudioSessionControl> control;check(sessions->GetSession(j,&control),"软件声音");
      AudioSessionState state;check(control->GetState(&state),"音频会话状态");if(state==AudioSessionStateExpired)continue;
      ComPtr<IAudioSessionControl2> extra;check(control.As(&extra),"软件声音进程");
      DWORD pid=0;check(extra->GetProcessId(&pid),"软件声音进程");if(pid)ids.insert(pid);
    }
  }
  auto all=processes();std::vector<Process> result;
  for(auto pid:ids)if(all.count(pid))result.push_back(all.at(pid));
  if(groupComponents)result=groupAudioApps(result,all);
  std::sort(result.begin(),result.end(),[](const auto&a,const auto&b){return a.name<b.name;});return result;
}
static bool descendant(DWORD pid,DWORD ancestor,const std::map<DWORD,Process>& all) {
  std::set<DWORD> seen;
  while(pid && seen.insert(pid).second) {if(pid==ancestor)return true;auto it=all.find(pid);if(it==all.end())break;pid=it->second.parent;}return false;
}
std::set<DWORD> selectAudio(const std::vector<Process>& apps,const std::map<DWORD,Process>& all,const std::set<std::wstring>& excluded,DWORD owner) {
  std::set<DWORD> blocked{owner};
  for(auto&[id,p]:all)if(excluded.count(stem(p.name)))blocked.insert(id);
  std::set<DWORD> safe,result;
  for(auto&p:apps)if(all.count(p.pid)) {
    bool allowed=true;
    for(auto id:blocked)if(descendant(p.pid,id,all)||descendant(id,p.pid,all)){allowed=false;break;}
    if(allowed)safe.insert(p.pid);
  }
  for(auto id:safe){bool nested=false;for(auto other:safe)if(id!=other&&descendant(id,other,all)){nested=true;break;}if(!nested)result.insert(id);}
  return result;
}
bool systemConsole(const Process& p){
  if(stem(p.name)!=L"conhost")return false;
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,p.pid);if(!process)return false;
  wchar_t path[32768],system[MAX_PATH];DWORD length=32768;
  bool ok=QueryFullProcessImageNameW(process,0,path,&length)&&GetSystemDirectoryW(system,MAX_PATH);CloseHandle(process);
  return ok&&lower(path)==lower(std::wstring(system)+L"\\conhost.exe");
}
std::wstring processPath(const Process&p){
  if(!p.path.empty())return lower(p.path);
  HANDLE handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,p.pid);if(!handle)return {};
  wchar_t path[32768];DWORD length=32768;bool ok=QueryFullProcessImageNameW(handle,0,path,&length)!=FALSE;CloseHandle(handle);
  return ok?lower(std::wstring(path,length)):std::wstring();
}
std::set<DWORD> includedComponents(const std::map<DWORD,Process>& all,const std::set<std::wstring>& included){
  std::set<DWORD> result;
  if(!included.count(L"qqmusic"))return result;
  for(auto&[pid,root]:all)if(stem(root.name)==L"qqmusic"){
    auto path=processPath(root);auto slash=path.find_last_of(L"\\");if(slash==path.npos)continue;auto folder=path.substr(0,slash+1);
    // QQ Music ships browsers, cloud and audio helpers with separate executable names.
    // Only descendants installed under this exact QQMusic folder inherit its toggle.
    if(folder.size()<9||folder.substr(folder.size()-9)!=L"\\qqmusic\\")continue;
    for(auto&[childPid,child]:all)if(childPid!=pid&&descendant(childPid,pid,all)){
      auto childPath=processPath(child);if(!childPath.empty()&&childPath.compare(0,folder.size(),folder)==0)result.insert(childPid);
    }
  }
  return result;
}
static std::vector<Process> groupAudioApps(const std::vector<Process>& apps,const std::map<DWORD,Process>& all){
  auto components=includedComponents(all,{L"qqmusic"});std::map<DWORD,Process> groups;
  for(auto p:apps){
    if(components.count(p.pid))for(auto&[pid,root]:all)if(stem(root.name)==L"qqmusic"&&descendant(p.pid,pid,all)){p=root;break;}
    groups.emplace(p.pid,std::move(p));
  }
  std::vector<Process> result;for(auto&[pid,p]:groups)result.push_back(p);return result;
}
std::set<DWORD> selectIncludedAudio(const std::vector<Process>& apps,const std::map<DWORD,Process>& all,const std::set<std::wstring>& included,DWORD owner){
  std::vector<Process> selected;std::set<std::wstring> blocked;auto components=includedComponents(all,included);
  for(auto&p:apps)if(included.count(stem(p.name))||components.count(p.pid))selected.push_back(p);
  // Capture includes descendants: reject trees containing an unselected process.
  for(auto&[pid,p]:all)if(!included.count(stem(p.name))&&!components.count(pid)&&!systemConsole(p))for(auto&candidate:selected)
    if(descendant(pid,candidate.pid,all))blocked.insert(stem(p.name));
  return selectAudio(selected,all,blocked,owner);
}
class Activation final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,IActivateAudioInterfaceCompletionHandler,Microsoft::WRL::FtmBase> {
 public:
  HANDLE done=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  HRESULT result=E_PENDING;
  ComPtr<IAudioClient> client;
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  PROPVARIANT property{};
  ~Activation(){CloseHandle(done);}
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
    ComPtr<IUnknown> value;HRESULT hr=E_FAIL;
    result=operation->GetActivateResult(&hr,&value);
    if(SUCCEEDED(result))result=hr;
    if(SUCCEEDED(result))result=value.As(&client);
    SetEvent(done);return S_OK;
  }
};
class Capture {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  HANDLE event=nullptr;
  std::deque<float> samples;
 public:
  explicit Capture(DWORD pid) {
    auto activation=Microsoft::WRL::Make<Activation>();
    activation->params.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation->params.ProcessLoopbackParams.TargetProcessId=pid;
    activation->params.ProcessLoopbackParams.ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    activation->property.vt=VT_BLOB;
    activation->property.blob.cbSize=sizeof(activation->params);
    activation->property.blob.pBlobData=reinterpret_cast<BYTE*>(&activation->params);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),&activation->property,activation.Get(),&operation),"启动软件音频");
    if(WaitForSingleObject(activation->done,10000)!=WAIT_OBJECT_0)throw std::runtime_error("启动软件音频超时");
    check(activation->result,"启动软件音频");client=activation->client;
    WAVEFORMATEX format{WAVE_FORMAT_PCM,2,48000,192000,4,16,0};
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,0,0,&format,nullptr),"初始化软件音频");
    check(client->GetService(IID_PPV_ARGS(&capture)),"软件音频数据");
    event=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    if(!event)throw std::runtime_error("无法创建音频事件");
    HRESULT hr=client->SetEventHandle(event);if(SUCCEEDED(hr))hr=client->Start();
    if(FAILED(hr)){CloseHandle(event);event=nullptr;check(hr,"开始软件音频");}
  }
  ~Capture(){if(client)client->Stop();if(event)CloseHandle(event);}
  void mix(float* out) {
    UINT32 available=0;check(capture->GetNextPacketSize(&available),"读取软件音频");
    while(available) {
      BYTE* data=nullptr;DWORD flags=0;UINT32 frames=0;
      check(capture->GetBuffer(&data,&frames,&flags,nullptr,nullptr),"读取软件音频");
      const short* pcm=reinterpret_cast<short*>(data);
      for(UINT32 i=0;i<frames*2;++i)samples.push_back((flags&AUDCLNT_BUFFERFLAGS_SILENT)?0.f:pcm[i]/32768.f);
      check(capture->ReleaseBuffer(frames),"释放软件音频");
      while(samples.size()>9600)samples.pop_front();
      check(capture->GetNextPacketSize(&available),"读取软件音频");
    }
    for(int i=0;i<960&&!samples.empty();++i){out[i]+=samples.front();samples.pop_front();}
  }
};
void Audio::start(std::set<std::wstring> excluded,std::function<void(const short*)> packet,std::function<void(std::string)> failure,std::set<DWORD> testPids) {
  stop();if(windowsBuild()<20348)throw std::runtime_error("软件声音过滤需要 Windows 11，请先取消共享声音");
  running=true;
  auto ready=std::make_shared<std::promise<void>>();auto future=ready->get_future();
  thread=std::thread([this,excluded=std::move(excluded),packet,failure,ready,testPids=std::move(testPids)]{
    HRESULT com=CoInitializeEx(nullptr,COINIT_MULTITHREADED);timeBeginPeriod(1);bool announced=false;
    try {
      check(com,"初始化音频线程");
      std::map<DWORD,std::unique_ptr<Capture>> captures;
      ULONGLONG refresh=0,next=GetTickCount64();
      while(running) {
        auto now=GetTickCount64();
        if(now>=refresh) {
          auto all=processes();auto apps=audioApps();
          if(!testPids.empty())apps.erase(std::remove_if(apps.begin(),apps.end(),[&](const Process&p){return !testPids.count(p.pid);}),apps.end());
          auto roots=selectAudio(apps,all,excluded,GetCurrentProcessId());
          {std::lock_guard<std::mutex> guard(policyLock);if(inclusionMode)roots=selectIncludedAudio(apps,all,included,GetCurrentProcessId());}
          for(auto it=captures.begin();it!=captures.end();)if(!roots.count(it->first))it=captures.erase(it);else ++it;
          for(auto pid:roots)if(!captures.count(pid)){if(!running)break;captures.emplace(pid,std::make_unique<Capture>(pid));}
          if(!announced){announced=true;ready->set_value();}
          refresh=GetTickCount64()+250;
        }
        if(GetTickCount64()>=next) {
          float mix[960]{};short output[960]{};
          for(auto&[id,capture]:captures)capture->mix(mix);
          for(int i=0;i<960;++i)output[i]=static_cast<short>(std::clamp(mix[i],-1.f,0.999969f)*32768.f);
          if(running)packet(output);
          next+=10;if(GetTickCount64()>next+100)next=GetTickCount64();
        }
        Sleep(2);
      }
    } catch(const std::exception&e){running=false;if(!announced){announced=true;ready->set_exception(std::current_exception());}else failure(e.what());}
    if(!announced)ready->set_exception(std::make_exception_ptr(std::runtime_error("音频启动已取消")));
    timeEndPeriod(1);if(SUCCEEDED(com))CoUninitialize();
  });
  try{future.get();}catch(...){stop();throw;}
}
void Audio::include(std::set<std::wstring> names){std::lock_guard<std::mutex> guard(policyLock);included=std::move(names);inclusionMode=true;}
void Audio::stop(){running=false;if(thread.joinable())thread.join();}
void policyTests() {
  std::map<DWORD,Process> tree{{100,{100,0,L"explorer"}},{101,{101,100,L"KOOK.exe"}},{102,{102,101,L"helper"}},{103,{103,100,L"heyboxchat"}},{104,{104,100,L"game"}},{105,{105,104,L"renderer"}},{106,{106,100,L"XgoatCast"}}};
  std::vector<Process> apps;for(auto&[id,p]:tree)apps.push_back(p);
  if(!selectIncludedAudio(apps,tree,{},106).empty())throw std::runtime_error("默认静音测试失败");
  if(selectIncludedAudio(apps,tree,{L"game",L"renderer"},106)!=std::set<DWORD>{104})throw std::runtime_error("点选程序测试失败");
  if(!selectIncludedAudio(apps,tree,{L"game"},106).empty())throw std::runtime_error("未选子进程隔离测试失败");
  if(!selectIncludedAudio(apps,tree,{L"xgoatcast"},106).empty())throw std::runtime_error("本程序隔离测试失败");
  {
    std::map<DWORD,Process> music{{201,{201,0,L"qqmusic",L"C:\\Program Files\\Tencent\\QQMusic\\QQMusic.exe"}}};
    auto require=[&](std::vector<Process> active,std::set<std::wstring> names,std::set<DWORD> expected){if(selectIncludedAudio(active,music,names,999)!=expected)throw std::runtime_error("QQ Music dynamic component policy failed");};
    require({music.at(201)},{L"qqmusic"},{201});
    music[202]={202,201,L"qmbrowser",L"C:\\Program Files\\Tencent\\QQMusic\\qmbrowser\\qmbrowser.exe"};
    music[203]={203,201,L"qmweiyun",L"C:\\Program Files\\Tencent\\QQMusic\\QMWeiyun.exe"};
    require({music.at(201)},{L"qqmusic"},{201}); // Late silent helpers must not mute the parent.
    require({music.at(202)},{L"qqmusic"},{202}); // Audio may move to a helper after sharing starts.
    require({music.at(201),music.at(202)},{L"qqmusic"},{201}); // Never mix the same tree twice.
    require({music.at(201),music.at(202)},{},{});
    auto grouped=groupAudioApps({music.at(201),music.at(202)},music);if(grouped.size()!=1||grouped.front().pid!=201)throw std::runtime_error("QQ Music UI grouping failed");
    music[204]={204,201,L"otherplayer",L"C:\\OtherApp\\OtherPlayer.exe"};
    require({music.at(201)},{L"qqmusic"},{}); // A separate unselected child still blocks the broad tree.
    require({music.at(202)},{L"qqmusic"},{202}); // The safe component may still be captured alone.
    music.erase(204);music[203].path=L"C:\\OtherApp\\QMWeiyun.exe";
    require({music.at(201)},{L"qqmusic"},{}); // Names alone never authorize another executable location.
  }
  // A silent background voice process is already blocked before its audio
  // session (or child renderer session) appears on a later refresh.
  std::vector<Process> dormant{tree.at(104)};
  if(selectAudio(dormant,tree,{L"kook",L"heyboxchat"},106)!=std::set<DWORD>{104})throw std::runtime_error("静音后台进程策略测试失败");
  dormant.push_back(tree.at(102));dormant.push_back(tree.at(103));
  if(selectAudio(dormant,tree,{L"kook",L"heyboxchat"},106)!=std::set<DWORD>{104})throw std::runtime_error("后台进程开始发声后屏蔽失败");
  if(selectAudio(apps,tree,{L"kook",L"heyboxchat"},106)!=std::set<DWORD>{104})throw std::runtime_error("音频策略测试失败");
  tree[107]={107,104,L"kook"};apps.push_back(tree[107]);
  if(selectIncludedAudio(apps,tree,{L"game",L"renderer"},106)!=std::set<DWORD>{105})throw std::runtime_error("新增未选程序隔离测试失败");
  if(selectAudio(apps,tree,{L"kook",L"heyboxchat"},106)!=std::set<DWORD>{105})throw std::runtime_error("音频嵌套策略测试失败");
}
}
