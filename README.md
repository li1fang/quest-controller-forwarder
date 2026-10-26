# Quest Controller Forwarder

Local controller telemetry, recording and pose annotation for Meta Quest headsets.

通过 Quest 头显读取左右手柄的 6DoF 姿态、速度和输入，转发到电脑，保留可追溯录制，并在本地浏览器选择动作区间、添加标签。

**需要头显作为追踪与通信中转。项目不提供 Touch Pro 脱离头显的直接蓝牙 / Wi-Fi 驱动。** 已在 Windows + Quest Pro / Touch Pro 上实测，其他硬件和长期稳定性见[验证范围](docs/validation.md)。

## 从哪里开始

| 目标 | 入口 | 说明 |
|---|---|---|
| 日常长时预览 / 录制 | `Record-Quest.cmd` | 打开无固定时长页面，手动开始和停止 |
| 启动即录制 | `Start-Quest-LAN.cmd` | 启动服务时创建第一段录制 |
| 离线回放 / 姿态标注 | `Annotate-Quest.cmd` | 默认打开最新完整录制，头显可以关闭 |
| USB 开发路径 | `Start-Quest.cmd` | 使用 ADB reverse，适合初始验证与调试 |

首次安装和构建见[设置指南](docs/build.md)。日常 LAN 流程见[日常使用](docs/daily-use.md)，动作区间操作见[标注指南](docs/annotation-use.md)。

## 日常采集

1. 头显开机、唤醒两只手柄；电脑双击预览入口。
2. 临时在头显打开 **Quest LAN Forwarder**，网页出现双手 6DoF 后摘下。日常不需要电脑 USB、Store PIN 或遮挡佩戴感应器。
3. 网页点击“开始录制”，结束一段点击“停止并保存”；保存后点击“再录一段”创建新的独立会话。
4. 全部结束时点“结束服务并释放保活”，恢复原有佩戴检测与休眠策略。只关闭网页或只停止录制仍保留预览和保活。

日常页为 `http://127.0.0.1:8787/capture`，没有五分钟倒计时；显示已录时长、写入量和剩余磁盘。录制按分钟 / 32 MiB 分块、约每秒落盘，磁盘低于 512 MiB 时自动停止并保存。它没有默认时长上限，实际运行受电量、存储和连接影响。建议按动作或批次停止保存，方便后续标注。

界面保留三维空间视图、左右手独立遥测与追踪状态，将录制操作集中在固定区域。录制完成后留在采集页，便于连续分段；顶部提供标注入口的启动说明。详见[界面与状态约定](docs/interface.md)。

0.8.1 使用通用 LAN APK，地址、证书指纹和令牌在运行时导入，换电脑或 IP 无需重新编译。首次升级或配对见[运行时配对](docs/runtime-pairing.md)。0.8.1 已验证配对跨升级保留、进入 XR focused、五分钟不休眠采集、再次录制及正常释放保活，操作者确认数据符合预期。本轮严格双手有效覆盖率为 70.8%，其中包含放下手柄的时段；按键本轮未复测，详见[验证范围](docs/validation.md)。保活使用临时租约和开发测试接口，固件兼容性需要实测。它不等于自动开机、自动打开 App，或永久修改休眠设置。

## 姿态标注

```powershell
pnpm install --frozen-lockfile --ignore-scripts
.\Annotate-Quest.cmd
# 或指定已完成录制
.\Annotate-Quest.cmd --session "recordings\YOUR_SESSION_DIRECTORY"
```

标注页支持三维回放、暂停、逐帧、拖动时间轴、慢放、起止帧选择和标签管理。标签独立保存在 `annotations.json`，包含帧 ID、手别、坐标段、质量计数和原始分块哈希；不修改原始数据。无效帧保留并明确显示，不能跨坐标段保存一个区间。

标注服务默认使用 `http://127.0.0.1:8788/annotate`，可与采集服务并存。先停止并保存需要标注的那一段，再打开标注；新录制可继续在采集页进行。长录制按索引读取需要的帧，浏览器只缓存有限窗口，不将整段姿态载入内存。

## 项目结构

```text
app/          Android NativeActivity / OpenXR 采集与 LAN 传输
pc/           Node 接收、存储、校验、回放和标注服务
web/          本地 Three.js 界面
scripts/      Windows 构建与启动脚本
diagnostics/ Java 离线策略测试及开发探针
docs/        使用、构建、协议与验证说明
third_party/  依赖说明与许可证；下载文件不入库
```

[协议和存储约定](docs/protocol.md)解释时间、坐标、有效性与标注区间。Node 服务只绑定本机网页端口，局域网接收使用固定证书校验的 TLS。录制默认写入 `recordings/`，配对材料位于 `.local/`；两者都不进入公开源代码。

## 开发与验证

```powershell
pnpm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-proximity-lease.ps1
```

Node 测试不需要头显；Android 构建需要 SDK/NDK/JDK。GitHub Actions 已配置 Windows / Ubuntu 的 Node 20 / 24 测试矩阵；结果以对应提交的实际 CI 为准。Android 配对策略另有 `scripts/test-lan-pairing.ps1` 离线测试。

不附带私人录制或演示动作标签。一次五分钟设备测试的双手严格 6DoF 覆盖率为 99.36%，短暂失效保留为质量标记；这不是零失效或多小时运行保证。

## 许可证与贡献

项目代码使用 [MIT](LICENSE)。第三方条款保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。旧版个性化 LAN APK 含配对令牌，不能公开分发。0.8.0 通用 APK 不含配对凭据；配对文件仍需保密，正式二进制发布前应完成设备验收并规划发布签名。

本项目独立开发，不由 Meta 或 Khronos 背书；固件、运行时和设备商标归各自所有者。
