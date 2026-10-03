# Windows 客户端分发方案

当前使用 Inno Setup 安装器、雨云对象存储 ROS、网站静态版本清单和用户主动安装更新。

原生客户端位于 `desktop/native-client/`，版本以 `version.h` 为准。安装包命名为 `XgoatCast-<版本>-win-x64-setup.exe`，只分发安装版。旧 Electron 原型不再用于发版。

安装包由发布脚本直接上传 ROS，使用永久 HTTPS 公开链接。网站服务器仅提供 `/downloads.html` 和 `latest.json`。发布页主区域只有最新安装包下载，旧版本显示折叠日志。

客户端启动时和每六小时检查更高版本，提示「立即更新 / 稍后」；立即更新打开发布页。网页唤起未收到客户端响应也提示前往同一页下载。

具体操作见 [发版流程](WINDOWS_CLIENT_RELEASE.md) 和 [雨云使用指南](RAINYUN_OBJECT_STORAGE.md)。
