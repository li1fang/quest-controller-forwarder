# 通用 APK 与运行时配对（0.8.1）

**状态：0.8.1 已按本轮实际操作验收。** 已验证运行时配对跨原位升级保留、面板转入 XR focused、无电脑 USB / 不佩戴 / 无遮挡时五分钟数据流不间断、再次录制和结束后恢复显示关闭 / XR idle。操作者补充第一段中途放下过手柄、第二段没有再次尝试按键，并确认数据符合预期。本轮 70.8% 严格双手有效覆盖率保留了放下手柄的时段，不用来评价持续握持时的追踪稳定性；按键记为本轮未复测。0.7.0 的旧测量另有 99.36% 双手有效覆盖率，不能混作同一轮结果。两版沿用同一份 `ProximityLease`、`ProximityControl` 和原生 OpenXR 追踪代码。

0.8.0 的配对保存和 TLS 连接已在设备上成功，但面板进入采集的路径缺少清单中的 VR 类型声明，会留在桌面矩形窗口，不能作为日常采集版本。0.8.1 修正了这一路径：显式声明 2D / VR 活动、Horizon OS 69+ 混合活动支持，保持原生采集非导出、使用独立任务，并以 MAIN + NEW_TASK 启动后移除配对面板任务。同一台 Quest Pro 已观察到无需重新配对即进入 XR focused；采集质量结论见[验证范围](validation.md)。

## 选择与边界

一个通用 LAN APK 可用于不同电脑。电脑地址、端口、TLS 证书指纹、随机令牌通过配置导入；APK 本身不携带这些信息。换电脑或 IP 后更新配置，不重新编译或安装同一 APK。

第一版选择可信文件导入，降低协议和权限复杂度：

- 推荐的初始路径：电脑通过已授权的 USB ADB 一键安装/暂存配置，头显确认一次接收方。
- 头显内的 **Quest LAN Pairing** 入口也支持系统文件选择器导入，以后可用可信文件传输交付配置。Quest 固件的文件选择器可用性仍需实测；此路径不要求 ADB，但如何安全送达文件由使用者控制。
- 配对完成后，日常启动、预览、录制和保活释放均使用无线 TLS，不依赖 USB 或无线 ADB。首次进入 App 和配对面板可以临时佩戴。

尚未实现相机扫码、自动发现、一次性配对码服务或自动开机；这些不影响通用 APK 与运行时配置的成立。

## 电脑准备

```powershell
# 通用 APK 只构建一次；不接头显、不生成/读取配对凭据。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -Lan

# 创建电脑自己的 TLS 身份和令牌；已有配置则显式更新地址，保留身份。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-lan.ps1 -HostAddress YOUR_PRIVATE_PC_IP

# 仅查看准备结果，不运行任何 ADB 命令。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pair-lan.ps1 -Plan
```

`dist/quest-lan-forwarder.apk` 是通用构建。`.local/lan/receiver.json`、`server-key.pem`、`server-cert.pem` 保留在电脑。客户端导入文件 `.local/lan/lan-config.json` 只含 `version/host/port/cert_sha256/token`，不含服务器私钥，但令牌属于秘密，不能公开。

IP 改变时重新运行 prepare-lan，停止旧服务后再导入更新配置；证书身份和令牌保持不变。固定证书指纹才是本协议的认证依据，不依赖原 IP 的 SAN。换另一台电脑通常在那台电脑生成新身份再导入，避免复制服务器私钥。Windows 防火墙规则若绑定旧 IP 仍需单独检查，导入配置不会自动拓宽防火墙。

## 一次性 USB 导入 / 升级

1. 先正常保存并结束正在运行的实时采集服务，释放保活。离线标注服务可保持打开。
2. 头显开机并接 USB；首次连接需允许电脑 USB 调试。只连接一个已授权的 Quest，多个设备时显式选择 `-Serial`。
3. 双击 **Pair-Quest-LAN.cmd**。它核对 Quest 型号，原位更新同签名的通用 APK（`install -r`），不卸载、不清数据，然后暂存配对文件并打开配置面板。
4. 头显显示接收电脑地址和完整 SHA-256 指纹，与电脑窗口比较，选择 **Trust and save**，再点 **Start controller capture**。需要处理系统“继续”提示时在同一窗口处理。
5. 电脑启动预览，确认收到双手数据后拔掉电脑 USB，摘下头显，不遮挡感应器。

已安装通用 APK 后，只更新配置用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pair-lan.ps1
```

省略 `-Install` 不运行 APK 安装，更不会编译。源码构建使用原有私有开发签名；签名不符时 Android 会拒绝覆盖，脚本不会自动卸载。首个公开二进制 Release 尚未发布。

配对暂存于目标 App 的外部专用目录，采用 pending 文件传完再重命名。只有面板确认后才写入 App 内部私有目录，原子保存并校验回读成功后删除暂存文件。非法输入保留已保存的配置，不会降级为无证书校验或 USB 传输。若取消导入，暂存仍保留，下次启动再次询问；可从可信电脑修正/移除该暂存文件。

## 头显文件导入

通过可信途径把客户端配置文件送到头显可选择的位置，打开 **Quest LAN Pairing → Import pairing file…**，选择并核对指纹，再保存。App 只读取该文件，不索取广泛存储权限，不保留文件 URI 权限；保存后使用内部副本。用户选择的原文件不会被自动删除，用完应手动移除。

已配对后，正常打开 **Quest LAN Forwarder** 会直接进入原生采集。需要重新配对/忘记接收方时使用独立 **Quest LAN Pairing** 入口。修改配对前结束接收服务；原生发送器下一次重连读取新配置。没有有效配置时停在配对界面，不启动采集或保活。

## 数据与保活

遥测仍为 `quest-usb-v1`，认证握手仍为 `quest-lan-v1`。录制文件、坐标分段、质量标记和独立 `annotations.json` 不变。断线期间的帧不补写、不伪造，不跨坐标段标注。

预览和录制使用已认证 TLS 连接上的十秒保活租约。停止一段录制仍维持预览；点击 **结束服务并释放保活** 才停止续租并请求恢复正常佩戴检测。配置面板本身不发保活租约，也不修改系统永久休眠设置。

## 集中实机复核流程

预计约 8–10 分钟；此前无须操作设备。

1. 短暂 USB：同签名升级、导入当前电脑配置并确认一次；临时佩戴打开采集。
2. 拔 USB、摘下头显、保持感应器物理无遮挡。程序开始 5 分钟 motion-only 录制；双手柄轻动，避免系统/菜单键。
3. 自动收尾后短录一段，抽查扳机、握把、ABXY/摇杆，核对“停止并保存 → 再开始”仍正常。无需重新佩戴或重复配对。
4. 正常结束服务，核查租约撤销与恢复休眠；离线审计新录制、回放并在隔离副本上核对标注，不修改原始数据。

若希望现场证明“重新配对不重新安装”，可在同一窗口选择第二份测试接收方配置；这是额外用例，不把同一台电脑的配置切换宣称为第二台实体电脑验收。默认先完成上面一轮，避免无必要的重复插拔与佩戴。

区分三项结果：配对/启动成功、持续运行无休眠、追踪质量。沿用先前对短暂输入无效的容忍，不把约 1.91 秒历史波动重新列为修复任务。新版若失败先保存证据，按本地 Git 保留的 0.7.0 代码准备同签名回退；不通过卸载或清数据解决版本问题。

## 实现依据

配置使用 Android [内部专用存储](https://developer.android.com/training/data-storage/app-specific)、[AtomicFile](https://developer.android.com/reference/android/util/AtomicFile) 和用户明确选择的 [Storage Access Framework 文件导入](https://developer.android.com/training/data-storage/shared/documents-files)。活动类型与任务切换遵循 Meta 的[混合应用说明](https://developers.meta.com/vr/documentation/spatial-sdk/hybrid-apps-overview/)和[原生清单要求](https://developers.meta.com/vr/documentation/native/android/mobile-native-manifest/)。构建包含 `test-lan-manifest.ps1` 回归检查，拒绝丢失 VR 类型、扩大原生入口导出权限或合并配对/采集任务的清单。这些静态检查不替代设备验收。
