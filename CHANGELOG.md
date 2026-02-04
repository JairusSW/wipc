# Changelog

## 0.1.1

- Fixed typo in README.md

## 0.1.0

Initial release.

- Binary framed IPC over stdin/stdout
- 9-byte header: 4-byte `WIPC` magic, 1-byte type, 4-byte u32 LE payload length
- Message types: OPEN, CLOSE, CALL, DATA
- Node.js `Channel` class with stream parsing, buffering, and resync
- Passthrough support for non-WIPC bytes on stdout
- AssemblyScript guest library (`readFrame`, `writeFrame`, `encode`, `decode`)
- Zero-copy frame decoding (subarray views)
- Protocol specification (SPEC.md)
- CI with GitHub Actions (Node.js 22, 24)
- Strict TypeScript, ESLint, Prettier
