# Backup compatibility fixtures

`vision-1.0.2-sanitized.visionbak.enc` was produced by the `createBundle()` and `encryptBundle()`
implementations from Git tag `v1.0.2` (commit `3333be41924417884f4b3abfb1a72a3bd1171007`)
with the release's declared `archiver` dependency. It contains only synthetic SQL, a synthetic text
attachment, metadata, and synthetic frontend state. Its documented synthetic passphrase is
`vision-v1.0.2-fixture`. Keep the file immutable so the current reader is tested against encrypted
bytes written by the older release instead of against its own writer.

SHA-256: `096068975bedafbf7ac0e77a2c57ba4ee13bf4bf37b32bca5064fd27e3bbf766`

`vision-2026-10-zip-writer.visionbak.enc` was produced on 2026-10-26 by `createBundle()` and
`encryptBundle()` at commit `7334283a`, after #349 replaced `archiver` with the in-repo zip writer
(`zip-writer.ts`). It holds synthetic SQL, a synthetic attachment with a non-ASCII name
(`attachments/tx-002/reçu été.txt`, UTF-8 name flag), metadata and synthetic frontend state. Its
synthetic passphrase is `vision-zip-writer-fixture`. The Swift tests open this exact file, so Vision
Native is tested against bytes the current Electron writer produces.

SHA-256: `3961705002cdfe92a41b9ba92b17b6030c53c711454ac226080930548d47453d`
