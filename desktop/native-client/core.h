#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include <map>
#include <set>
#include <mutex>
#include <thread>
#include <atomic>
#include <functional>
#include <memory>
#include <stdexcept>
#include <algorithm>
#include <json.hpp>
#include "version.h"

namespace xc {
using Json = nlohmann::json;
std::string utf8(const std::wstring& s);
std::wstring wide(const std::string& s);
std::wstring lower(std::wstring s);
std::wstring stem(std::wstring s);
std::wstring errorText(HRESULT hr);
void check(HRESULT hr, const char* context);
unsigned windowsBuild();
struct Launch {
  std::string server, token, clientId, quality = "1080p_2";
  std::string launchId;
  bool lowLatency = false, detail = false;
};
Launch parseLaunch(const std::wstring& uri);
Json request(const Launch& launch, const std::string& endpoint, const Json* body = nullptr);
inline constexpr char DefaultServer[] = "https://cast.xgoat.top";
struct UpdateInfo {
  bool available = false;
  std::string version;
  std::string downloadUrl;
  std::string releasePageUrl;
  std::string notes;
  std::string publishedAt;
};
UpdateInfo parseUpdateManifest(const Json& manifest,const std::string& currentVersion);
UpdateInfo checkForUpdate();
constexpr UINT WM_UPDATE_RESULT = WM_APP+6;
enum class ServerConnection { Checking, Online, Offline };
bool probeServer(const std::string& origin);
class ServerMonitor {
 public:
  explicit ServerMonitor(HWND notify, unsigned intervalMs=15000);
  ~ServerMonitor();
  void watch(std::string origin);
  ServerConnection snapshot();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
void serverMonitorTest(const std::string& origin,const std::wstring& output);
constexpr UINT WM_SERVER_STATUS = WM_APP+4;
struct Preset { int width, height, fps; };
extern const std::map<std::string, Preset> qualities;
struct Settings {
  bool microphone = false;
  std::string microphoneDevice; // Empty follows the system default; enabling stays explicit.
  std::set<std::wstring> included;
  bool screens = true, audio = false, lowLatency = false, detail = false, loaded = false;
  std::string quality = "1080p_2";
  std::set<std::wstring> excluded = {L"kook",L"kaiheila",L"开黑啦",L"heyboxchat",L"heychat",L"黑盒语音",L"discord",L"discordptb",L"discordcanary"};
};
Settings readSettings();
void saveSettings(const Settings& settings);
struct Process { DWORD pid, parent; std::wstring name; std::wstring path; };
std::map<DWORD, Process> processes();
std::vector<Process> audioApps(bool groupComponents=false);
std::set<DWORD> selectAudio(const std::vector<Process>& apps, const std::map<DWORD,Process>& all, const std::set<std::wstring>& excluded, DWORD owner);
class Audio {
 public:
  Audio() = default;
  ~Audio() { stop(); }
  void start(std::set<std::wstring> excluded, std::function<void(const short*)> packet, std::function<void(std::string)> failure, std::set<DWORD> testPids = {});
  void stop();
  void include(std::set<std::wstring> names);
 private:
  std::mutex policyLock;
  std::set<std::wstring> included;
  bool inclusionMode=false;
  std::atomic<bool> running{false};
  std::thread thread;
};
struct Source { int64_t id; bool screen; std::wstring name; std::vector<unsigned char> image; int width=0,height=0; };
struct PreviewFrame { int width=0,height=0; ULONGLONG observedAt=0; std::vector<unsigned char> image; };
struct MicrophoneDevice { std::string id; std::wstring name; };
struct Microphones { std::vector<MicrophoneDevice> devices; std::wstring defaultName,error; std::string selected; };
constexpr UINT WM_MICROPHONES = WM_APP+5;
enum class Phase { Idle, Loading, Ready, Starting, Sharing, Stopping, Failed };
struct Snapshot {
  Phase phase = Phase::Idle;
  std::wstring message = L"从网页进入共享，无需登录";
  int viewers=0, idleSeconds=-1, noViewerSeconds=-1;
  ULONGLONG observedAt=0,serverObservedAt=0;
  std::wstring room;
  bool allowLowLatency=false, allowPreference=false;
  std::vector<std::string> allowedQualities;
  std::vector<Source> sources;
};
class Session {
 public:
  Session(HWND notify);
  ~Session();
  void launch(Launch launch, Settings settings);
  void refresh();
  void start(Source source, Settings settings);
  void stop();
  Snapshot snapshot();
  std::shared_ptr<const PreviewFrame> preview();
  void updateAudio(Settings settings);
  void refreshMicrophones();
  void selectMicrophone(std::string id);
  Microphones microphones();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
constexpr UINT WM_STATE = WM_APP+1;
void policyTests();
void previewTests();
void previewCaptureTest(const std::wstring& output);
void sdkSelfTest(const std::wstring& output);
}
