# Windows 客户端原生 SDK 研判

核对日期：2026-09-14。本文区分官方能力、实测包体积和待验证事项，不代表原生客户端已完成。

## 结论

优先验证 C++ 原生 Windows 界面 + 声网 Windows RTC SDK + WASAPI 按进程音频采集。与 Electron 相比，该方案不携带浏览器；与 WebView2 方案相比，不需要额外浏览器运行时，也不需要跨 JS 桥传递采集数据。代价是需要重新实现客户端外壳和 SDK 接入，原生自绘界面也需要处理 DPI、键盘操作、拖动和托盘生命周期。

30 MB **压缩下载包**有实测依据：选取 SDK 的 11 个 x64 候选运行库重新 ZIP 压缩，得到 24,825,067 字节（24.83 MB / 23.68 MiB），约有 5.17 MB 留给客户端、资源、必要运行库和合规材料。这个包尚未经过 SDK 初始化、采集、推流的完整运行验证，不能称为最终可运行最小包。

30 MB **解压占用**无法由本次 SDK 达成：仅主 DLL 就有 42,340,856 字节；候选运行库共 58,348,456 字节。

## MCP 接入结果

- 项目新增 `.codex/config.toml`，只注册 `shengwang-docs`，未修改全局配置。
- 地址：`https://doc-mcp.shengwang.cn/mcp`，Streamable HTTP，无需填写密钥。
- `codex mcp get shengwang-docs` 确认 enabled=true。
- 实际完成 initialize、tools/list、search-docs、get-doc-content 请求，读取了 Windows 下载、屏幕共享、音频采集及体积优化文档。
- 此服务器是开发期文档查询服务，不集成到最终客户端，也不改变用户登录流程。
- 当前会话未动态出现该服务器的原生工具条目；本次通过 HTTP 调用其 MCP 接口完成核查，不将“配置成功”混同于当前工具目录热加载成功。
- 文档搜索有跨平台混合结果；MDX 还包含其他平台的条件内容。必须核对 platform filter、公开 API 和下载包头文件，不能把 Android Lite 或 macOS 排除自身音频字段当作 Windows 能力。

配置依据：[声网 MCP 接入](https://doc.shengwang.cn/doc/rtc/android/mcp-integrate)、[Codex MCP 配置](https://developers.openai.com/codex/mcp)。

## 体积实测

采用官方 Windows 下载页当日提供的 v4.6.2 FULL；MCP 与实际网页的下载链接一致。未将 Android v4.6.3 当成 Windows 版本。

- [官方 Windows 下载页](https://doc.shengwang.cn/doc/rtc/windows/resources)
- [官方 SDK 压缩包](https://download.shengwang.cn/sdk/release/Shengwang_Native_SDK_for_Windows_v4.6.2_FULL.zip)
- 原始 ZIP：98,403,387 字节，包含 x86、x64、开发文档、示例及可选扩展。
- 原始 ZIP SHA-256：`fecad7d6b3f6a647e04408dc7a23401098ab80d8a96bbf504b0c5d2062e5e5c9`。

候选运行库：

| 文件 | 未压缩字节 |
| --- | ---: |
| agora_rtc_sdk.dll | 42,340,856 |
| libaosl.dll | 1,302,008 |
| libagora-fdkaac.dll | 814,584 |
| libagora-ffmpeg.dll | 8,536,056 |
| libagora-soundtouch.dll | 163,832 |
| video_dec.dll | 1,305,080 |
| libagora_screen_capture_extension.dll | 1,382,392 |
| libagora-wgc.dll | 215,032 |
| libagora_video_encoder_extension.dll | 247,800 |
| video_enc.dll | 1,675,768 |
| glfw3.dll | 365,048 |

在 SDK 的 `sdk/x86_64` 目录使用以下命令重新压缩（输出到新的测试文件）：

```sh
zip -9 -j candidate-x64-runtime.zip agora_rtc_sdk.dll libaosl.dll \
  libagora-fdkaac.dll libagora-ffmpeg.dll libagora-soundtouch.dll \
  video_dec.dll libagora_screen_capture_extension.dll libagora-wgc.dll \
  libagora_video_encoder_extension.dll video_enc.dll glfw3.dll
```

候选 ZIP SHA-256：`00f29efbbf48e09f774e7ed699853450814677b27a7c26b16b491ec47ae41903`。

已检查全部候选 DLL 的 PE 静态导入表：主 DLL 直接依赖 aosl、ffmpeg、soundtouch、fdkaac 和 video_dec。不能因为“不播放文件”或“只发流”就删除这些直接依赖。屏幕采集扩展和 WGC 库保留，视频编码扩展和 video_enc 保留，glfw3 保守保留。未发现这些文件静态导入 VC 运行库 DLL，但这不代表最终 EXE 不会需要运行库，也不证明动态加载依赖完整。

本次未破坏 DLL、未使用 UPX、未把运行依赖改成首次启动偷偷下载。未压缩文档、头文件和链接用 `.lib` 进入候选包；AI 降噪、美颜、虚拟背景、空间音频等本任务不使用的可选插件不进入候选包。最终发行仍需复核供应商许可材料和所有实际依赖。

删除可选插件的依据：[减小 App 体积](https://doc.shengwang.cn/doc/rtc/windows/best-practice/reduce-app-size)。该文档的 Lite SDK 小节仅适用于 Android/iOS，不能推断存在可下载的 Windows Lite SDK。

## 功能核对

| 产品需求 | 原生实现路径 | 边界 |
| --- | --- | --- |
| 选择窗口 / 全屏 | getScreenCaptureSources + startScreenCaptureByWindowId / startScreenCaptureByDisplayId | 官方支持；需验证目标软件、遮挡、最小化、GPU 和多显示器行为 |
| 画质优先 / 帧率优先 | setScreenCaptureContentHint 的 CONTENT_HINT_DETAILS / CONTENT_HINT_MOTION；配合屏幕采集分辨率、帧率和码率 | 不把摄像头编码参数直接套用到屏幕流；不同 SDK 的优化行为不保证完全相同 |
| 低延迟 | 保留现有产品的 rtc / live 场景切换，原生对应频道场景，观看端同步 | 不等同于只调一个编码参数，也不承诺固定毫秒延迟 |
| 声音开关 | 不勾选时不启动自定义音频采集、不发布音频 | 麦克风默认关闭，不回退到全系统混音 |
| KOOK、黑盒语音等排除 | WASAPI 按允许进程树采集、混音后，createCustomAudioTrack + pushAudioFrame | 需维护进程列表、去重、进程退出/重启、采样时钟和设备变化；动态进程场景必须测漏音 |
| 现有网页观看 | 原生发布到现有频道，使用现有下发的数值 UID 和 RTC 凭据，优先保持 H.264 | 无需因此重做观看页；仍需真实频道验证、令牌续期和停止共享测试 |
| 绿色启动、网页唤起、托盘 | Win32 用户级协议注册、单实例通知、托盘图标 | 首次用户点击注册；注册文件路径变化后需重新注册；浏览器仍可能确认打开应用 |
| 极简玻璃界面 | 原生无边框窗口、轻量自绘和 DWM 背景 | 官方系统背景 API 要求 Windows 11 build 22621；旧系统/禁用透明效果时提供深色不透明降级 |

音频的关键区别：

- `enableLoopbackRecording` 是声卡混音采集，不是“所选窗口专属音频”。官方明确提醒会包含其他进程的声音。
- `excludeWindowList` 排除的是画面窗口，不能当作声音排除列表。
- 下载包中的 `excludeCurrentProcessAudio` 位于 macOS 条件编译分支；既不是 Windows 能力，也不是多软件排除名单。
- 本次核对的 Windows 公开 API 和头文件中未找到可直接传入多个待屏蔽软件/PID 的接口。若供应商另有私有参数或定制版本，需要其确认后再评估，不能据此承诺。
- Windows 进程回环采集官方要求 build 20348 或更新，普通 Windows 10 消费者版本不能笼统承诺支持；建议首版面向 Windows 11。

依据：[Windows 屏幕共享](https://doc.shengwang.cn/doc/rtc/windows/basic-features/screen-share)、[屏幕采集 API](https://doc.shengwang.cn/api-ref/rtc/windows/API/toc_screencapture)、[音频采集 API](https://doc.shengwang.cn/api-ref/rtc/windows/API/toc_audio_capture)、SDK 自带 `IAgoraMediaEngine.h` 与 `AgoraBase.h`、[微软进程回环采集示例](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)、[DWM 系统背景](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type)。

本地现有实现已核对：`useScreenShare.ts` 与 `useAgoraView.ts` 均使用 H.264，并依据 lowLatency 切换 rtc/live；服务器给 publisher 下发数值 UID。原生迁移不需要改变现有产品的共享/观看令牌设计，也不增加用户登录或绑定。

## 其他路线

- **C# + 原生 SDK**：可作为界面开发效率优先的备选，但仍要打包底层原生 DLL。官方 Windows 页面链接的 NuGet `agora_rtc_sdk` 当日稳定版是 4.2.1，不能默认和 C++ 4.6.2 同步。需要核对仓库源码、绑定版本和 .NET 发行方式；不能把自包含 .NET 的体积忽略。
- **WebView2 + 原生 SDK**：可复用网页样式，但额外引入 WebView2 依赖和界面桥接；传音视频应留在原生，不跨 JS 桥逐帧传输。现阶段的小面板不一定值得为此增加依赖。
- **WebView2 + Web SDK**：下载包可能更小，但窗口采集和原生过滤声音如何送入 Web SDK 仍要验证。不是简单替换 Electron 的外壳。
- **Flutter / Electron / Unity / Unreal 等封装**：语言绑定并不会自动缩小底层媒体库，还需考虑各自框架运行时；本次未实测其最终包，不给出虚构体积。
- **RTSA C SDK**：不能只看小体积。官方说明它不包含采集和视频编解码；平台清单主要是 Linux/RTOS，未找到现成 Windows 桌面发行依据。为了当前需求自建采集、编码、码率适配和互通，不是优先路线。

依据：[C# NuGet](https://www.nuget.org/packages/agora_rtc_sdk/)、[官方 C# 仓库](https://github.com/AgoraIO-Extensions/Agora-C_Sharp-SDK)、[RTSA 产品概述](https://doc.shengwang.cn/doc/rtsa/c/overview/product-overview)。

## 建议的下一步验收门槛（尚未实施）

1. 在独立目录做最小 C++ 共享验证，保留现有 Electron 原型可用，不直接替换。
2. 固定 x64、候选 DLL 和轻量原生窗口；测试干净 Windows 环境运行，不依赖开发工具残留。
3. 实际频道由网页观看：窗口/屏幕、H.264、画质/帧率偏好、rtc/live、停止和重连均通过。
4. 接入已有音频策略，验证 KOOK/黑盒真实应用、多进程重启、设备切换、无麦克风及失败时不漏音。
5. 再补齐极简 UI、用户级网页唤起注册、托盘、偏好记忆。首次默认窗口且声音关闭；后续记住共享类别、声音、排除列表和模式，但不自动开始采集。
6. 测最终 ZIP 必须小于 30,000,000 字节，并报告解压体积。若超限，分析真实新增依赖后再决策，不能用隐藏下载掩盖。

本次仅完成文档 MCP 接入、官方资料/头文件/依赖审查和候选包体积测试；未完成原生客户端编译、真实 Agora 推流或真实语音软件过滤验收，未改动现有客户端、服务器或网页业务实现。
