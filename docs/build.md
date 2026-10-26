# Build and first setup

## PC tools

Node.js 20+ and pnpm 10 are used for the local receiver, replay, and annotation UI. Install dependencies with:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

The browser uses local Three.js files; there is no CDN requirement. The Android build scripts and Windows launchers are tested on Windows. Node-only replay and recording modules use standard Node APIs; hardware acquisition on other hosts has not been validated.

## Android tools

The tested build uses JDK 21, Android SDK platform 34, build-tools 35.0.0, NDK 27.2.12479018 and CMake 3.22.1. By default they are under `C:\Android\jdk-21` and `C:\Android\Sdk`.

```powershell
# Downloads tools; Android SDK licenses are presented for the operator to review.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-toolchain.ps1
# Build the USB variant (does not install or launch it).
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

Existing installations may be selected with `-Sdk` and `-Jdk` on build.ps1. AAR downloads are SHA-256 checked. A local development signing key is generated under ignored build/; keep it private and backed up if upgrading the same installed app. A newly generated key cannot update another key's installed APK in place.

## LAN pairing and installation

1. Enable developer mode / USB debugging on your own headset. Connect once and approve that computer in the headset.
2. Find the PC's private IPv4 reachable from the headset. Use a stable address; the current minimal client embeds the paired address.
3. Generate pairing and build the LAN APK:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-lan.ps1 -HostAddress YOUR_PRIVATE_PC_IP
adb devices
adb -s YOUR_USB_SERIAL install -r dist/quest-lan-forwarder.apk
```

The script creates a pinned TLS certificate and random pairing token in `.local/lan/`, with current-Windows-user ACLs. OpenSSL from Git for Windows or PATH is required. If Windows blocks the incoming connection, inspect the rule and run `Allow-Quest-LAN.cmd` as Administrator. The helper reads the paired PC address and scopes TCP 19428 to its private /24 subnet and the chosen Node executable; other network layouts need an explicitly reviewed scoped rule.

The personalized LAN APK contains its pairing token. Do not attach it to a public release or share it as a universal installer. Source distribution is the supported preparation here; each user builds their own paired APK. Changing PC address or pairing requires rebuilding/reinstalling that APK.

Daily operation uses `Start-Quest-LAN-Preview.cmd`, then manual app launch on the headset; see [daily use](daily-use.md). No USB, wireless ADB or Store PIN is required during LAN operation. USB and wireless ADB are alternate development paths, not prerequisites for offline annotation.

## Offline annotation without a headset

Copy a finalized session directory (manifest, raw chunks, events and annotations) into recordings/, then run `Annotate-Quest.cmd`. Integrity must pass. Real recordings are private inputs and are not shipped with the project. See [annotation use](annotation-use.md).
