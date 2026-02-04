<h1 align="center"><pre>╦ ╦ ╦ ╔═╗ ╔═╗
║║║ ║ ╠═╝ ║  
╚╩╝ ╩ ╩   ╚═╝</pre></h1>

<p align="center">
  <a href="https://github.com/JairusSW/wipc/actions"><img src="https://github.com/JairusSW/wipc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/wipc"><img src="https://img.shields.io/npm/v/wipc" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/wipc" alt="license"></a>
</p>

**Wire IPC** -- minimal binary framing over standard i/o.

WIPC gives you a bidirectional byte channel between any two processes connected by pipes. It handles framing, buffering, and resync. Everything else -- payload encoding, RPC semantics, method dispatch -- is yours to define.

If a process can read `stdin` and write `stdout`, it can speak WIPC.

## Install

```sh
npm install wipc
```

## Example: Echo

### Host (Node.js / Bun)

```ts
import { Channel, MessageType } from "wipc";
import { spawn } from "node:child_process";

const child = spawn("wasmtime", ["./build/test.wasm"], {
  stdio: ["pipe", "pipe", "inherit"],
});

class Echo extends Channel {
  onDataMessage(data: Buffer) {
    console.log("<-", data.toString("utf8"));
  }

  onPassthrough(data: Buffer) {
    // Anything the guest writes to stdout that isn't a WIPC frame
    process.stderr.write(data);
  }
}

const ch = new Echo(child.stdout!, child.stdin!);
ch.send(MessageType.DATA, Buffer.from("hello"));
```

### Guest (AssemblyScript)

```ts
import { readFrame, writeFrame, MessageType, Frame } from "wipc/assembly/channel";

while (true) {
  const frame: Frame | null = readFrame();
  if (frame === null) break;
  writeFrame(frame.type, frame.payload);
  if (frame.type == MessageType.CLOSE) break;
}
```

That's it. The guest reads frames, echoes them back. The host sends frames, receives echoes.

## Wire Format

9-byte header, then payload:

```
0       4      5         9        9+N
┌───────┬──────┬─────────┬─────────┐
│ WIPC  │ type │ length  │ payload │
└───────┴──────┴─────────┴─────────┘
  4 B     1 B     u32 LE     N B

```

```
┌────────┬──────┬─────────┬──────────────────────┐
│ Offset │ Size │ Field   │ Description          │
├────────┼──────┼─────────┼──────────────────────┤
│      0 │    4 │ MAGIC   │ ASCII "WIPC"         │
│      4 │    1 │ TYPE    │ Message type         │
│      5 │    4 │ LENGTH  │ Payload size, u32 LE │
│      9 │    N │ PAYLOAD │ Opaque bytes         │
└────────┴──────┴─────────┴──────────────────────┘
```

### Message Types

```
┌───────┬───────┬────────────────────────────┐
│ Value │ Name  │ Purpose                    │
├───────┼───────┼────────────────────────────┤
│  0x00 │ OPEN  │ Channel initialization     │
│  0x01 │ CLOSE │ Graceful shutdown          │
│  0x02 │ CALL  │ RPC / request-response     │
│  0x03 │ DATA  │ Raw data transfer          │
└───────┴───────┴────────────────────────────┘
```

Payloads are opaque. WIPC does not prescribe encoding -- use JSON, protobuf, raw bytes, whatever fits your use case.

See [SPEC.md](./SPEC.md) for the full protocol specification.

## Architecture

```
  ┌───────────────┐
  │      FFI      │
  └───────────────┘
          │
┌────────────────────┐    stdin / stdout (WIPC)   ┌───────────────────────┐
│        Host        │  <──────────────────────>  │     Guest / Child     │
└────────────────────┘                            └───────────────────────┘
          │
  ┌───────────────┐
  │  passthrough  │
  └───────────────┘

```

WIPC frames and regular stdout coexist on the same stream. The `Channel` parser separates them: frames are dispatched, everything else goes to `onPassthrough()`.

## API

### `Channel`

```ts
import { Channel, MessageType } from "wipc";
```

**Sending:**

- `send(type, payload?)` -- send a frame
- `sendJSON(type, msg)` -- send a frame with a JSON-encoded payload

**Receiving** (override in a subclass):

- `onOpen()` -- OPEN frame
- `onClose()` -- CLOSE frame
- `onCall(msg)` -- CALL frame (payload parsed as JSON)
- `onDataMessage(data)` -- DATA frame (raw Buffer)
- `onPassthrough(data)` -- non-WIPC bytes

### Guest API (AssemblyScript)

```ts
import { readFrame, writeFrame, MessageType } from "wipc/assembly";
```

- `writeFrame(type, payload?)` -- write a frame to stdout
- `readFrame(): Frame | null` -- blocking read from stdin
- `encode(type, payload): ArrayBuffer` -- encode without sending
- `decode(data): Frame | null` -- decode without reading

## Building

```sh
npm run asbuild          # build all targets
npm run asbuild:debug    # debug build
npm run asbuild:release  # release build
npm test                 # run test suite
```

## Performance

Node.js Channel encode/decode and in-process echo round-trip (Node v25):

```
Encode
  small (27 B)           ~7M ops/s     144 MB/s
  1 KB                   ~3M ops/s     3.4 GB/s
  64 KB                  ~156K ops/s   10 GB/s

Decode (zero-copy view)
  small (27 B)           ~9M ops/s
  1 KB                   ~9M ops/s
  64 KB                  ~9M ops/s

Decode + copy
  small (27 B)           ~7M ops/s     148 MB/s
  1 KB                   ~4M ops/s     3.6 GB/s
  64 KB                  ~156K ops/s   10 GB/s

Channel round-trip (in-process echo)
  small (27 B)           ~507K rt/s    22 MB/s
```

Decoding returns a `subarray` view -- no copies, constant time regardless of payload size. When you need to own the data, `Buffer.from()` copies at memcpy speed. Encoding cost is dominated by `Buffer.concat`. Round-trip throughput is limited by Node.js stream backpressure, not framing overhead.

Run benchmarks yourself:

```sh
npm run bench
```

## Runtime Requirements

**Host:** Any runtime that WIPC is ported to.

**Guest:** Anything that reads stdin and writes stdout. The included AssemblyScript library targets WASI runtimes (Wasmtime, Wasmer). Porting to Rust, C, Go, or any other language is straightforward -- see [SPEC.md](./SPEC.md).

## License

This project is distributed under an open source license. Work on this project is done by passion, but if you want to support it financially, you can do so by making a donation to the project's [GitHub Sponsors](https://github.com/sponsors/JairusSW) page.

You can view the full license using the following link: [License](./LICENSE)

## Contact

Please send all issues to [GitHub Issues](https://github.com/JairusSW/wipc/issues) and to converse, please send me an email at [me@jairus.dev](mailto:me@jairus.dev)

- **Email:** Send me inquiries, questions, or requests at [me@jairus.dev](mailto:me@jairus.dev)
- **GitHub:** Visit the official GitHub repository [Here](https://github.com/JairusSW/wipc)
- **Website:** Visit my official website at [jairus.dev](https://jairus.dev/)
- **Discord:** Contact me at [My Discord](https://discord.com/users/600700584038760448) or on the [AssemblyScript Discord Server](https://discord.gg/assemblyscript/)
