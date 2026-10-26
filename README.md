# Quest Controller Forwarder

Local controller telemetry, recording and pose annotation for Meta Quest headsets.

通过 Quest 头显读取左右手柄的 6DoF 姿态、速度和输入，转发到电脑，保留可追溯录制，并在本地浏览器选择动作区间、添加标签。

**需要头显作为追踪与通信中转。项目不提供 Touch Pro 脱离头显的直接蓝牙 / Wi-Fi 驱动。** 已在 Windows + Quest Pro / Touch Pro 上实测，其他硬件和长期稳定性见[验证范围](docs/validation.md)。

## 从哪里开始

| 目标 | 入口 | 说明 |
|---|---|---|
| 无线实时预览 / 录制 | `Start-Quest-LAN-Preview.cmd` | 先预览，准备好再点击开始录制 |
| 启动即录制 | `Start-Quest-LAN.cmd` | 启动服务时创建第一段录制 |
| 离线回放 / 姿态标注 | `Annotate-Quest.cmd` | 默认打开最新完整录制，头显可以关闭 |
| USB 开发路径 | `Start-Quest.cmd` | 使用 ADB reverse，适合初始验证与调试 |

首次安装和构建见[设置指南](docs/build.md)。日常 LAN 流程见[日常使用](docs/daily-use.md)，动作区间操作见[标注指南](docs/annotation-use.md)。

## 日常采集

1. 头显开机、唤醒两只手柄；电脑双击预览入口。
2. 临时在头显打开 **Quest LAN Forwarder**，网页出现双手 6DoF 后摘下。日常不需要电脑 USB、Store PIN 或遮挡佩戴感应器。
3. 网页点击“开始新采集”，结束一段点击“停止并保存”；可以连续新建多个独立会话。
4. 全部结束时点“结束服务并释放保活”，恢复原有佩戴检测与休眠策略。只关闭网页或只停止录制仍保留预览和保活。

当前 LAN 地址和证书在首次配对时固化到 App，换电脑地址需要重新配对 / 构建。保活使用开发测试接口，固件兼容性需要实测。它不等于自动开机、自动打开 App，或永久修改休眠设置。

## 姿态标注

```powershell
pnpm install --frozen-lockfile --ignore-scripts
.\Annotate-Quest.cmd
# 或指定已完成录制
.\Annotate-Quest.cmd --session "recordings\YOUR_SESSION_DIRECTORY"
```

标注页支持三维回放、暂停、逐帧、拖动时间轴、慢放、起止帧选择和标签管理。标签独立保存在 `annotations.json`，包含帧 ID、手别、坐标段、质量计数和原始分块哈希；不修改原始数据。无效帧保留并明确显示，不能跨坐标段保存一个区间。

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

Node 测试不需要头显；Android 构建需要 SDK/NDK/JDK。GitHub Actions 已配置 Windows / Ubuntu 的 Node 测试矩阵，远程执行结果以未来实际运行的 CI 为准。

不附带私人录制或演示动作标签。一次五分钟设备测试的双手严格 6DoF 覆盖率为 99.36%，短暂失效保留为质量标记；这不是零失效或多小时运行保证。

## 许可证与贡献

项目代码使用 [MIT](LICENSE)。第三方条款保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。个性化 LAN APK 含配对令牌，不能直接作为公开 Release 附件。

本项目独立开发，不由 Meta 或 Khronos 背书；固件、运行时和设备商标归各自所有者。
