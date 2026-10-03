# Windows 客户端发布与更新

当前构建版本为 `0.0.1-beta.1`，后续只发布 Windows x64 安装包。下载入口统一为 `https://cast.xgoat.top/downloads.html`。安装程序放在雨云对象存储，网站只提供发布页与版本清单，用户下载不经过网站服务器。

## 自动完成整套发版

`npm run release:all` 顺序完成原生构建、界面回归、服务端与上传测试、安装包打包、对象存储上传及网站部署，任一步失败即停止。仓库没有 GitHub Actions 自动发布任务；该命令使用发布机已有的 MSVC、Inno Setup、S3 私密配置与 SSH 登录，不把密钥写入仓库。

WSL 使用：

```bash
npm run release:all -- --stage=/mnt/c/你的构建目录 --toolchain=/mnt/c/工具链/setup_x64.bat --compiler=/mnt/c/工具链/ISCC.exe
```

运行前递增版本并写发布说明。首个正式 Beta 将此前测试包归档，发布清单从 `0.0.1-beta.1` 开始；正式安装包使用 `downloads/windows/official/` 前缀，测试对象继续保留。后续版本严格递增，不覆盖已发布包。

## 一次发版的顺序

1. 备份当前客户端源码到 `desktop/native-client/versions/`，保留历史安装包。
2. 递增 `desktop/native-client/version.h` 的 SemVer，例如 `0.0.1-beta.2`；同步 `app.rc` 的 `ProductVersion`、四段数字文件版本、`app.manifest` 的数字版本及安装器默认版本。
3. 写入 `docs/releases/<版本>.md` 更新说明。
4. 构建原生客户端并生成安装包。
5. 执行上传命令。脚本上传到对象存储，确认公开链接后才更新网站版本清单。
6. 部署网站，让发布页和客户端更新检测读取新清单。

### 构建安装包

Windows 发布机需要 Node.js 22、MSVC x64、Windows SDK 和 Inno Setup 6。在 x64 Developer Command Prompt 中：

```text
cd desktop/native-client
node fetch-deps.cjs
node build.cjs
node build-installer.cjs
```

产物为 `desktop/native-client/out/XgoatCast-<版本>-win-x64-setup.exe`。`build-installer.cjs` 校对源码与资源版本，并拒绝覆盖同名安装包。构建目录 `out/XgoatCast-win-x64/` 可以替换，带版本号的安装包不可替换。

WSL 构建需为 `build.cjs` 提供 Windows 磁盘上的 `--stage` 和 MSVC 的 `--toolchain`；安装器提供独立 `--stage` 及 `--compiler=<ISCC.exe路径>`。各参数使用 `--参数=路径` 格式。

### 配置雨云对象存储

产品独立面板入口为 `https://app.rainyun.com/panel/`。完整网页操作说明见 [雨云对象存储使用指南](RAINYUN_OBJECT_STORAGE.md)。复制 `.env.release.example` 为根目录 `.env.release`，或放到 `~/.config/xgoatcast/release.env`：

```dotenv
CLIENT_RELEASE_PROVIDER=rainyun
S3_ENDPOINT=https://控制台显示的API端点
S3_REGION=rainyun
S3_BUCKET=你的存储桶名称
S3_ACCESS_KEY_ID=实例的AccessKey
S3_SECRET_ACCESS_KEY=实例的SecretKey
S3_PREFIX=downloads/windows/official
S3_PUBLIC_BASE_URL=
```

账号密码仅用于网页登录；脚本使用 S3 访问密钥。私密文件权限设为 `0600`，不会进入 Git、网站、客户端或 Docker 镜像。CI 使用同名 Secrets。`S3_PUBLIC_BASE_URL` 留空时下载地址为 `https://API端点/桶名/对象路径`；使用自定义桶域名时填写域名根地址。

存储桶和实例应允许安装包匿名读取；下载链接不能使用会过期的预签名地址。公共下载桶仅存放安装包。实例层公共访问可能影响其下所有桶，私密文件应使用独立私有实例。

### 上传并生成清单

在项目根目录安装开发依赖后执行：

```bash
npm ci
# 本地检查版本、安装包名称与哈希，不访问对象存储。
npm run release:client -- --notes-file docs/releases/0.0.1-beta.1.md --dry-run
# 上传当前版本安装包，生成公开下载清单及历史日志。
npm run release:client -- --notes-file docs/releases/0.0.1-beta.1.md
# 将网站、服务端和版本清单一起部署。
bash deploy.sh
```

可选参数：`--file <安装包路径>`、`--version <SemVer>`、`--site https://网站根域名`、`--env-file <私密配置文件>`；`--check-login` 仅确认桶访问权限。默认使用雨云。历史蓝奏云适配器保留在源码中，当前流程不依赖蓝奏云。

对象按版本归档，例如：

```text
downloads/windows/official/0.0.1-beta.1/XgoatCast-0.0.1-beta.1-win-x64-setup.exe
```

脚本不覆盖已存在的不同安装包；同版本、同文件、同说明重复执行会复用对象。上传使用 Content-MD5，记录 SHA-256，上传完成后确认远端大小、哈希元数据及匿名链接。遇到网络、权限或公开访问错误时保留原最新清单，可重跑同一命令继续；不同文件或日志必须递增版本。

## 发布页与更新检测

- `web/public/downloads/windows/latest.json`：当前最新版本、安装包公开链接、SHA-256、日期和说明。
- `web/public/downloads/windows/releases/<版本>.json`：历史发布记录。
- `web/public/downloads/windows/history.json`：按版本倒序的更新日志，只含版本、日期、通道和说明。
- 发布页主区域只有最新版的一个「下载」按钮，旧版本下面是默认折叠的日志。
- 首页「客户端下载」、分享页「下载共享客户端」、客户端「立即更新」均打开 `/downloads.html`。

客户端启动时和运行期间每六小时读取固定网站的 `latest.json`，也可在菜单的「关于」中手动「检查更新」。按 SemVer 判断是否有更高版本，发现新版本显示「立即更新 / 稍后」，立即更新打开发布页；稍后仍可从菜单立即更新。同一新版本不会在每轮自动检查中重复弹窗。检查失败不影响共享。

更新清单与安装包链接必须为 HTTPS。`latest.json` 禁止缓存。此流程由用户下载安装程序，不在后台替换正在共享的客户端；更新前应停止共享、退出旧客户端再安装。

网页每次唤起附独立 `launchId`，客户端向服务端回报对应标识。分享页在 Windows 共享按钮下常驻「下载共享客户端」链接，收到响应后显示客户端已响应；没有 12 秒下载提示或浏览器打开提示。

## 网站发版与回滚

`bash deploy.sh` 本地构建全部前后端，上传运行文件，重建容器并等待健康检查。首次部署当前累积改动前，保留当前镜像、运行文件和 SQLite 在线备份，保护 `.env` 和数据卷。

线上确认 `/downloads.html`、`/downloads/windows/latest.json` 可访问，且最新下载链接无需登录。客户端相关改动可运行 `npm run test:release`，原生界面与版本检测可用 Windows Node 执行 `desktop/native-client/test-ui.cjs`。

紧急撤回客户端版本时，将历史版本清单恢复为 `latest.json` 后部署网站；不要覆盖旧安装包。修复版本必须使用更高版本号。网站故障用保留的镜像和运行文件回滚，数据库恢复只在确实需要时使用部署前备份，避免覆盖部署后的用户数据。
