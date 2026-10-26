# Contributing

Use Node.js 20+ and pnpm 10. Run `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm test`. Android changes also need the build described in docs/build.md; state separately whether hardware was tested.

Keep raw telemetry immutable. Store labels separately, preserve decimal-string timestamps and valid/tracked/null semantics, and split ranges at coordinate changes. Add focused tests for behavioral changes; use synthetic fixtures rather than copying private recordings into tests.

Do not commit pairing configuration, tokens, private keys, keystores, personalized APKs, raw recordings, Store PINs, or unredacted logs/screenshots. Build and runtime artifacts belong in ignored local directories. Avoid hardcoded device serials, PC addresses or user paths.

Describe the concrete behavior changed, verification performed, and any unverified hardware/platform assumptions in pull requests. CI tests prepared in this repository cover Node modules; passing CI alone does not establish device compatibility.
