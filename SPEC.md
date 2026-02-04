# WIPC Protocol Specification

**Version:** 1.0

## Overview

WIPC (Wire IPC) is a framed binary protocol for bidirectional communication over stdin/stdout pipes. It provides framing, buffering, and resync. It does not prescribe payload encoding, RPC semantics, or method dispatch -- those are left to the application.

## Transport

WIPC operates over two byte streams:

- **Host to guest:** the guest's stdin
- **Guest to host:** the guest's stdout

The guest's stderr is not part of the protocol and is reserved for human-readable output.

WIPC frames may be interleaved with non-WIPC data on stdout. A conforming host parser must handle this by scanning for the magic bytes and treating everything else as passthrough data.

## Frame Format

Each frame consists of a fixed 9-byte header followed by a variable-length payload.

```
┌────────┬─────────┬─────────┬────────────────────────────────────────────────────────┐
│ Offset │ Size    │ Field   │ Description                                            │
├────────┼─────────┼─────────┼────────────────────────────────────────────────────────┤
│      0 │ 4 bytes │ MAGIC   │ ASCII "WIPC" (bytes 57 49 50 43)                       │
│      4 │ 1 byte  │ TYPE    │ Message type identifier                                │
│      5 │ 4 bytes │ LENGTH  │ Payload length in bytes, unsigned 32-bit little-endian │
│      9 │ N bytes │ PAYLOAD │ Opaque payload (N = LENGTH)                            │
└────────┴─────────┴─────────┴────────────────────────────────────────────────────────┘
```

**Header size:** 9 bytes

**Maximum payload size:** 2^32 - 1 bytes (~4 GiB)

### Byte Order

All multi-byte integers are **little-endian**. This matches the native byte order of WebAssembly and x86/x64, avoiding byte-swap overhead on the most common targets.

## Message Types

```
┌───────┬───────┬───────────┬────────────────────────────────────┐
│ Value │ Name  │ Direction │ Description                        │
├───────┼───────┼───────────┼────────────────────────────────────┤
│  0x00 │ OPEN  │ Either    │ Channel initialization / handshake │
│  0x01 │ CLOSE │ Either    │ Graceful shutdown request          │
│  0x02 │ CALL  │ Either    │ Request-response exchange          │
│  0x03 │ DATA  │ Either    │ Raw data transfer                  │
└───────┴───────┴───────────┴────────────────────────────────────┘
```

Values 0x04 through 0xFF are reserved for future use.

### OPEN (0x00)

Signals readiness to communicate. Payload is optional. Either side may send OPEN. No response is required.

### CLOSE (0x01)

Requests graceful shutdown. The receiver should finish in-progress work and exit. Payload is optional.

A well-behaved guest should exit after sending or receiving CLOSE. A well-behaved host should stop sending frames after receiving CLOSE.

### CALL (0x02)

Intended for request-response exchanges. The payload format is application-defined.

WIPC does not prescribe an RPC schema. A common pattern is JSON with an `id` field for matching responses:

```json
{ "id": 1, "method": "doSomething", "params": ["arg"] }
```

```json
{ "id": 1, "result": "value" }
```

But you are free to use any encoding: protobuf, msgpack, CBOR, raw bytes, or anything else.

### DATA (0x03)

Raw data transfer. The payload is opaque bytes with no prescribed encoding.

## Stream Safety

### Partial Reads

Frames may arrive split across multiple read calls. Implementations must buffer incoming bytes and only process complete frames.

### Coexistence with Non-WIPC Data

A guest may write non-WIPC data to stdout (e.g., `console.log`). A conforming host parser must:

1. Buffer incoming bytes
2. Search for the 4-byte MAGIC sequence `WIPC`
3. Emit all bytes before the magic as passthrough data
4. Attempt to parse a frame starting at the magic
5. If the frame is incomplete, wait for more data
6. If the frame is complete, dispatch it and continue

### Resynchronization

If a parser encounters corrupted or unexpected data:

1. Scan forward byte-by-byte for the next occurrence of `WIPC`
2. Discard all bytes before it
3. Resume normal parsing

This ensures the channel recovers from corruption, interleaved output, or partial writes.

### Magic Collision

The 4-byte sequence `WIPC` (`57 49 50 43`) may theoretically appear in non-WIPC data. In practice this is unlikely, but for safety:

- Use stderr for all human-readable output
- The parser validates the full header (magic + type + length) before accepting a frame

## Implementation Notes

### For Guest Implementors

- Write frames to stdout, read frames from stdin
- Use stderr for all debug/log output
- The guest is responsible for its own payload encoding

### For Host Implementors

- Spawn the guest with `stdio: ["pipe", "pipe", "inherit"]`
- Attach the parser to the guest's stdout (input) and stdin (output)
- Handle `onPassthrough` for non-WIPC output

### Porting to Other Languages

A minimal WIPC implementation requires:

1. Write 9 header bytes + payload to stdout
2. Read bytes from stdin, scan for magic, parse header, read payload

No special runtime features are needed beyond basic stdin/stdout I/O. WIPC can be implemented in any language: Rust, C, Go, Zig, Python, Java, AssemblyScript, etc.
