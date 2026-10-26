# Security and private data

Keep `.local/`, recordings/, build/, dist/, device dumps, and all signing/pairing material private. A paired LAN APK embeds a secret token and is not a public binary release. Browser services bind only to loopback; do not expose them through public tunnels or add permissive CORS rules.

The LAN receiver pins its certificate and authenticates its one producer. Local mutation endpoints require a control token and validate Host/Origin. These controls do not isolate data from other programs already running as the same OS user.

The optional Windows Store PIN helper uses the current user's Credential Manager. It does not protect secrets from administrators or malicious processes under that account. Never include PIN values, credential exports, or unredacted network trust dumps in issues.

For a suspected vulnerability, use the hosting platform's private security-reporting channel when enabled. If it is unavailable, request a private contact channel in an issue without including exploit details, recordings or secrets. No public contact address is assigned before repository publication.
