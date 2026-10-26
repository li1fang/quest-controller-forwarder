# Validation scope

The development setup is Windows with Quest Pro / Touch Pro, Android API 34. Results below are observations from that setup, not a vendor support guarantee.

| Path | Observed result |
|---|---|
| USB + headset forwarding | Positions, rotations, linear/angular velocities, triggers, grips, ABXY and sticks were checked against physical input |
| App-native LAN TLS | Data continued after unplugging PC USB |
| Unworn and physically uncovered, in-app keepalive | One 300-second measurement completed without recorded screen sleep, XR pause, focus loss, disconnect or sequence gap |
| Tracking quality in that measurement | 21,433 / 21,571 strict dual-hand frames (99.36%); one approximately 1.91-second interval with both pose actions unavailable, then recovery |
| Storage | Six raw chunks and events passed hash, protocol and counter audits; invalid frames retained |
| Annotation | Browser playback, exact frame selection, half-speed selected-range playback, persistence, editing and recoverable deletion checked using an isolated copy of recorded data |

The brief input loss is accepted as an operating limitation and is not an active investigation. Its exact hardware/runtime cause was not established. Keepalive and tracking quality are separate claims; the five-minute result is not a multi-hour endurance or cold-boot automation result.

The 99.36% uncovered five-minute hardware result above belongs to device app 0.7.0. The original proximity lease code and native tracking code are retained in 0.8.1.

## Runtime pairing / app 0.8.1

The 0.8.0 setup saved pairing and authenticated TLS, but the launch path could leave native capture in a desktop panel. Version 0.8.1 restores manifest VR classification, declares supported hybrid activity handling, and separates setup/capture tasks while keeping capture non-exported. On the same Quest Pro, the saved pairing survived an in-place update without reimport and the corrected launch entered XR focused using TLS 1.3.

The operator confirmed USB unplugged, headset unworn and proximity physically uncovered. These physical conditions remain operator observations, not independently measured by the app.

| 0.8.1 check | Observed result |
|---|---|
| Formal 300-second measurement | 21,563 frames, all focused; zero disconnects, sequence gaps, stale episodes, app restarts or coordinate changes |
| Strict dual-hand tracking in that measurement | 15,267 / 21,563 frames (70.8%); longest uninterrupted strict interval about 56.88 s |
| First restart of recording | Separate complete 60-second recording, 4,326 frames; both pose actions unavailable throughout. The operator later confirmed no button retest was attempted in this second recording |
| Further guarded short recording | Separate complete 60-second recording, 4,330 frames, 3,292 strict dual-hand frames; grip press/release captured on each hand, without comprehensive button coverage |
| Storage / annotation | All three originals pass integrity audit; replay and separate-label add/edit/reopen pass on an isolated copy, originals and their zero human labels unchanged |
| Normal shutdown | Non-renewing diagnostic connection observed lease=0, override=false, release_count=1, interactive=false, display OFF and XR idle; diagnostic receiver then closed |

The operator subsequently confirmed that controllers were put down during the first measurement, no button retest was attempted in the second, and the data met expectations. The acquisition, recording and shutdown workflow is accepted for those actual operating conditions; no further hardware window is required for this acceptance.

The 70.8% counter is retained, including controller put-down periods. It is not an estimate of tracking reliability while both controllers are continuously held and moved, and the operator statement does not identify the cause of every invalid frame. Button retesting is classified as not performed in this run, not as a demonstrated button failure or a new full-coverage pass. Earlier input validation remains separate. The historical 1.91-second 0.7.0 interval remains outside the active investigation.

Automated Node tests use clearly synthetic protocol fixtures, temporary files and loopback sockets. They check storage integrity, control guards, source immutability, and annotation boundaries; they do not substitute for hardware acceptance. Java proximity-policy tests run without Android hardware.

Raw recordings, personal device/network diagnostics and private research screenshots are intentionally absent from the public source snapshot. Contributors should provide redacted, minimal reproductions.
