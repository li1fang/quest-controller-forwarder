# Data, coordinates and annotation contract

## Telemetry

Native OpenXR emits newline-delimited JSON with schema `quest-usb-v1`. `kind=frame` contains both hands; `kind=status` reports XR lifecycle states. Position is grip-space metres, quaternion order is `[x,y,z,w]`, linear velocity is m/s, angular velocity rad/s. LOCAL is right-handed: +X right, +Y up, -Z forward. Y=0 is not necessarily the floor.

`focused`, `pose_active`, and separate position/orientation valid and tracked flags distinguish actual tracking from inferred or unavailable values. Unavailable fields are null, not zero. Strict dual-hand 6DoF requires all relevant flags on both hands. Button touch is distinct from button press.

Device monotonic and OpenXR timestamps remain decimal strings to preserve 64-bit precision. `sample_time_source` distinguishes current-monotonic sampling from predicted-display fallback. PC receipt time is a separate clock; do not subtract the two as a network-latency estimate.

## LAN

The app connects to the paired PC over TLS (default 19428), pins the certificate, and presents a random token. This is headset-to-PC forwarding, not direct Touch Pro controller radio support. A single active producer prevents mixing controllers from multiple headsets. Congestion may discard old sender frames in favour of the newest; recording is not a device-local lossless logger.

An opted-in app can receive bounded `prox-lease-v1` controls from the authenticated receiver. In-app proximity requests expire when the live receiver stops renewing, and normal disconnect requests automation_disable. This development mechanism does not guarantee universal firmware support or change permanent sleep settings. Offline replay/annotation never renews this lease.

## Session storage

Each recording has a unique directory with manifest.json, raw/NNNNNN.jsonl, events.jsonl and annotations.json. Chunks rotate after 60 seconds or 32 MiB. Data and manifest checkpoints are synced approximately once per second; normal stop finalizes hashes. A crash tail is reported as incomplete, never silently presented as a completed recording.

The PC adds `capture.sample_id`, `app_run_id`, `connection_id`, `coordinate_segment_id`, receipt UTC and receipt monotonic time. Coordinate segments change across app/reference-space changes. Frames with invalid tracking remain in raw storage. Annotation does not resample, smooth, interpolate or rewrite raw data.

## Annotation

`quest-pose-annotations-v1` retains session_id, an annotations array, and raw_files with filenames and SHA-256. Each annotation contains id, free-text label, side (left/right/both), start_sample_id, end_sample_id, coordinate_segment_id, notes, creation/update UTC and per-interval tracking quality counts. Both endpoints are inclusive.

Ranges cannot span coordinate segments. The UI frame index excludes status packets; sample IDs refer to original recording packets. Deleted annotations remain in deleted_annotations with deletion IDs and restoration markers. Atomic replacement under an exclusive lock prevents concurrent appends from overwriting one another. A source-hash or identity mismatch prevents saving.

The first version uses separate JSON files rather than a database. It has no automatic gesture classification or video synchronization.
