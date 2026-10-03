# XgoatCast Windows 客户端原型

**当前开发版本已切换为 C++ 原生客户端，见 [native-client/README.md](native-client/README.md)。** 正式分发仅使用原生客户端安装包，见 [发布流程](../docs/WINDOWS_CLIENT_RELEASE.md)。下面保留的是旧 Electron 原型开发说明。

免登录，通过现有共享页唤起，选择整个屏幕或一个窗口。默认从共享声音中排除 KOOK / 开黑啦、黑盒语音、Discord，支持额外勾选当前音频软件或填写进程名。用户本机仍能听到这些软件，不采集麦克风。

## 原型能力与边界

- Electron 只运行随包的选择器和 Agora Web SDK，不加载第三方网站。
- 视频使用 Electron / Windows 桌面捕获，音频使用独立 Windows WASAPI 进程回环助手，过滤后转成一条自定义 Agora 音轨。
- 每秒枚举音频会话与进程树，对未排除的软件逐个采集后混合；新的软件音频约一秒内加入。排除按大小写不敏感的可执行文件名匹配，同时排除子进程。
- 默认进程名：`KOOK`、`Kaiheila`、`开黑啦`、`HeyBoxChat`、`HeyChat`、`黑盒语音`、`Discord`、`DiscordPTB`、`DiscordCanary`。厂商若更换进程名，需要在「其他软件进程名」添加；浏览器里的 KOOK 网页无法按网站排除，需排除整个浏览器进程。
- 不捕获 PID 0 的系统声音；无法确认安全的父进程树也会省略。因此它是“软件音频混合”，并非百分百覆盖 Windows 所有声音的系统回环。
- 音频排除配置在开始时生效，共享中修改需先停止。保留音频电平条便于实际检查，音频助手失败时停止共享，不自动切换全局系统音频。
- 过滤依赖进程快照（1 秒周期）；进程刚启动、退出或出现异常父子关系时仍需做实际软件兼容验证。原型不声明任意进程变化下零泄漏保证。
- 当前采用 48 kHz 双声道混音、100 ms 有界队列；大量软件同时出声、音频设备切换、多显示器/DPI、游戏全屏、锁屏/休眠尚需扩展实机验证。
- 断网、采集轨结束、音频助手退出或控制进程失去响应时停止共享。长会话声网凭证临近到期时停止并提示重新开始，尚未实现无缝续期。
- 发布包未做代码签名和自动更新；这是供内部验证的原型。不会自动安装或部署到生产环境。

## 原型开发

独立目录管理依赖，不修改仓库原有 npm workspace 锁文件。

```sh
cd desktop
npm ci
npm run build
npm start
```

Windows 构建使用系统 .NET Framework 4.x 的 C# 编译器；WSL 构建脚本也可调用 Windows 编译器。原型打包入口已移除；后续发版统一使用原生客户端安装器。

调用格式（由共享页自动生成，不需要用户手工填写）：

```text
xgoatcast://share?server=https%3A%2F%2F你的域名&t=现有令牌&cid=网页客户端标识&quality=1080p_2&lowLatency=0&optimizationMode=motion
```

支持 HTTPS 部署根地址及 localhost HTTP 调试地址，不支持部署在子路径。参数不会作为 shell 命令执行。

## 已执行的验证

- `npm test`：协议参数、默认排除与输入校验。
- `AudioBridge.exe --self-test`：父子进程排除、去重、含被排除子进程的祖先不能被整树采集。
- Windows `node.exe test/native-audio-smoke.cjs`：创建 440 / 880 / 1320 Hz 三路独立测试进程；分别以媒体程序、KOOK、HeyBoxChat 命名。对照未过滤与过滤输出，验证两路被排除、一路被保留。只采集测试 PID；不采集现有软件音频，不向网络发送音频。会短暂播放较轻的测试音。
- Windows Electron 运行 `test/electron-smoke.cjs`：独立本地会话服务器、真实屏幕/窗口枚举、真实合成窗口视频轨及图像像素验证，不连接 Agora。
- 服务端 `test/desktop-sharing.spec.ts`：客户端心跳、被动网页不保活、已停止会话不能被客户端心跳恢复；原浏览器共享回归测试。

正式声网房间的端到端推流、真实 KOOK/黑盒语音多人通话隔离尚需用户用自己的房间验收；测试进程验证不能代替所有软件版本的兼容测试。

## 实现参考

- https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
- https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode
- https://www.electronjs.org/docs/latest/api/desktop-capturer

本仓库包含自有实现，未复制微软示例源文件。
