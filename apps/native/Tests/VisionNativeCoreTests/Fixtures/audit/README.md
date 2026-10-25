# Electron audit-anchor fixture

These files were written by the Electron audit anchor (`packaging/electron/audit-anchor.ts`,
`createAuditAnchor`) through `packaging/electron/scripts/native-audit-fixture.ts`:

```sh
bun packaging/electron/build.ts
node packaging/electron/out/scripts/native-audit-fixture.js apps/native/Tests/VisionNativeCoreTests/Fixtures/audit
```

The script uses a fake Keychain witness held in memory and a fake `safeStorage` that encodes
exactly like Electron's on macOS (Chromium OSCrypt `v10`: AES-128-CBC with an IV of 16 spaces
under PBKDF2-HMAC-SHA1(password, `saltysalt`, 1003 rounds, 16 bytes)) with the synthetic
"Safe Storage" password `vision-native-audit-fixture-safe-storage`. It enrolls a synthetic
history at sequence 5, closes a checkpoint at sequence 12, records a retention boundary through
sequence 4 and exports a protected transfer with the synthetic password
`vision-native-audit-fixture-transfer`.

| File              | Content                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `key.enc`         | `audit-anchor/key.enc`: base64 of the `v10` encoding of the base64 key   |
| `checkpoint.json` | `audit-anchor/checkpoint.json`: the signed receipt, as Electron wrote it |
| `witness.json`    | The witness value the Keychain item holds                                |
| `transfer.vat`    | `exportProtectedTransfer` output                                         |
| `expected.json`   | The passwords and `readTrustedCheckpoint()` (metadata, receipt hash, id) |

The key is random on every run, so a rerun replaces every file; commit them together. No real
financial data or credentials are involved.
