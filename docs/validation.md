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

Automated Node tests use clearly synthetic protocol fixtures, temporary files and loopback sockets. They check storage integrity, control guards, source immutability, and annotation boundaries; they do not substitute for hardware acceptance. Java proximity-policy tests run without Android hardware.

Raw recordings, personal device/network diagnostics and private research screenshots are intentionally absent from the public source snapshot. Contributors should provide redacted, minimal reproductions.
