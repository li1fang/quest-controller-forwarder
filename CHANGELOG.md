# Changelog

## Unreleased

- Refined the existing dark spatial workbench: shared capture/annotation chrome, a stable recording control area, elapsed-time emphasis, and separate keepalive shutdown controls. Preserved the original Three.js scene, cyan/violet controller telemetry and raw data behavior.
- Explicit preview, saving, saved, low-space and disconnected recording feedback. Browser disconnection marks statistics as last received rather than claiming live recording or a newly confirmed save.
- This frontend update has offline regression coverage; browser visual review was blocked by local permission settings, and fresh device acceptance is deferred.

- Daily manual recording entry (`Record-Quest.cmd`, `/capture`) without an idle validation countdown; elapsed time, data size, free space and low-space finalization are shown independently of tracking.
- File-backed annotation frame windows and indexed range quality preserve old recordings while avoiding whole-pose retention for long sessions. Annotation defaults to port 8788 alongside live capture on 8787.
- Incremental event-log hashing, monotonic session duration, disk reserve protection and an explicit offline bounded-memory benchmark.

- 0.8.1 launch fix: declare panel/immersive activity types and hybrid support; launch OpenXR in its own task and remove only the setup task. Capture remains non-exported. Add a manifest regression guard for the on-device rectangular-window failure in 0.8.0.

- Universal LAN APK with runtime pairing import, private atomic storage, a separate setup panel, and authorized-USB pairing helper. Endpoint updates preserve TLS identity without a rebuild. The 0.8.1 immersive launch, recording and shutdown workflow has scoped device acceptance; see `docs/validation.md` for putdown periods and button-retest limits.
- Original 0.7.0 proximity lease, telemetry and immutable recording/annotation formats retained.

- Portable Node test enumeration for Windows Node 20; receiver shutdown now waits for actual stream resource closure and is idempotent.

- Offline annotation workspace: verified replay, pause/step/seek, speed and interval controls, free-text hand-specific labels, editing and recoverable deletion.
- Labels persist separately with source hashes and coordinate/quality references; originals are not rewritten.
- MIT license, retained dependency notices, setup/contribution/security docs, Node CI configuration, and clean source export tooling.
- Preview-first LAN launcher and normal keepalive shutdown instructions.

## 0.7.0 device app

- Paired LAN forwarding with bounded in-app proximity keepalive and power/lifecycle diagnostics.
- Five-minute uncovered keepalive measurement completed on Quest Pro; brief dual input unavailability remains recorded as a limitation.

Earlier USB and wireless-ADB work remains available in the code. Private research chronology is not part of public source history.
