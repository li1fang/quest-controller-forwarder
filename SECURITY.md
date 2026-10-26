# Security and private data

Keep `.local/`, recordings/, build/, dist/, device dumps, and all signing/pairing material private. Legacy personalized LAN APKs embed a secret token and must not be shared. The 0.8.0 universal APK packages no pairing data; its public binary release still requires hardware acceptance and a release-signing plan. Browser services bind only to loopback; do not expose them through public tunnels or add permissive CORS rules.

The LAN receiver pins its certificate and authenticates its one producer. Local mutation endpoints require a control token and validate Host/Origin. These controls do not isolate data from other programs already running as the same OS user.

Runtime pairing files contain a bearer token, certificate SHA-256 and a private IPv4 endpoint, but no server private key. Import them only from your trusted receiver PC, using an authorized USB ADB link or another trusted file-transfer method. Compare the displayed endpoint and fingerprint before confirming. The app does not learn pins from unauthenticated LAN discovery and never disables certificate validation. A different endpoint on the same PC can retain its certificate pin; moving to another PC should normally create new credentials and require a new import.

The setup panel copies confirmed pairing to app-private internal storage with backup disabled. USB staging is deleted after a verified save; user-selected source documents remain at their original location and should be removed when no longer needed. Do not put pairing documents in public Downloads links, repositories, screenshots or support bundles. Uninstalling/clearing app data removes the saved pairing. End the live receiver service before re-pairing; the reconnect path reloads configuration without changing recording or annotation schemas.

The optional Windows Store PIN helper uses the current user's Credential Manager. It does not protect secrets from administrators or malicious processes under that account. Never include PIN values, credential exports, or unredacted network trust dumps in issues.

For a suspected vulnerability, use the hosting platform's private security-reporting channel when enabled. If it is unavailable, request a private contact channel in an issue without including exploit details, recordings or secrets. No public contact address is assigned before repository publication.
