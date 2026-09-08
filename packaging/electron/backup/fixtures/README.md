# Backup compatibility fixtures

`vision-1.0.2-sanitized.visionbak.enc` was produced by the `createBundle()` and `encryptBundle()`
implementations from Git tag `v1.0.2` (commit `3333be41924417884f4b3abfb1a72a3bd1171007`)
with the release's declared `archiver` dependency. It contains only synthetic SQL, a synthetic text
attachment, metadata, and synthetic frontend state. Its documented synthetic passphrase is
`vision-v1.0.2-fixture`. Keep the file immutable so the current reader is tested against encrypted
bytes written by the older release instead of against its own writer.

SHA-256: `096068975bedafbf7ac0e77a2c57ba4ee13bf4bf37b32bca5064fd27e3bbf766`
