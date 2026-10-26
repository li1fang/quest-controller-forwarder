# Third-party notices

Project-authored source is provided under the root MIT LICENSE. Dependencies retain their own terms.

| Component | Use | License / retained notice |
|---|---|---|
| Three.js 0.186.1 | Local browser rendering; installed with pnpm | MIT, `third_party/licenses/threejs-MIT.txt` |
| Khronos OpenXR Android loader / headers 1.1.65 | Android APK loader and native API headers | Upstream artifact license retained verbatim in `third_party/licenses/OpenXR-LICENSE.txt`; headers declare Apache-2.0 OR MIT |
| Android native_app_glue | NDK source compiled into the APK | Apache-2.0; copyright 2010 The Android Open Source Project; retained NDK notices |
| Android NDK C++ runtime / toolchain support | Native C++ build, including static runtime | Upstream NDK `NOTICE` and `NOTICE.toolchain` retained as `third_party/licenses/Android-NDK-NOTICE*.txt` |

OpenXR AAR URL and checksum are pinned in `scripts/build.ps1` and `third_party/README.md`. The downloaded AAR, SDK, NDK, JDK, and node_modules are not part of the source export. The APK build includes this notice, the project license, and the retained third-party license directory in META-INF.

Meta's headset runtime and firmware remain external proprietary prerequisites. They are not included or relicensed by this project. The in-app proximity approach was informed by Meta developer documentation and the MIT-licensed QuestNavKeepAwake source; no QuestNav source was copied into this implementation.
