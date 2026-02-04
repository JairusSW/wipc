import { Channel, MessageType } from "../src/index.ts";
import { PassThrough } from "node:stream";

(globalThis as Record<string, unknown>).__bench_sink = 0;
function blackbox<T>(x: T): T {
  (globalThis as Record<string, unknown>).__bench_sink = x;
  return x;
}

const MAGIC = Buffer.from("WIPC");
const HEADER_SIZE = 9;

function buildFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

function parseFrame(buf: Buffer): { type: number; payload: Buffer } | null {
  if (buf.length < HEADER_SIZE) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  const type = buf.readUInt8(4);
  const length = buf.readUInt32LE(5);
  if (buf.length < HEADER_SIZE + length) return null;
  const payload = buf.subarray(HEADER_SIZE, HEADER_SIZE + length);
  return { type, payload };
}

function formatNumber(n: number): string {
  const str = n.toString();
  let result = "";
  const offset = str.length % 3;
  for (let i = 0; i < str.length; i++) {
    if (i > 0 && (i - offset) % 3 === 0) result += ",";
    result += str.charAt(i);
  }
  return result;
}

function bench(name: string, fn: () => void, ops: number, bytesPerOp = 0) {
  const warmup = Math.floor(ops / 10);
  for (let i = 0; i < warmup; i++) fn();

  const start = performance.now();
  for (let i = 0; i < ops; i++) fn();
  const end = performance.now();

  const elapsed = Math.max(0.001, end - start);
  const opsPerSec = Math.round((ops * 1000) / elapsed);

  let log = `  ${name}\n`;
  log += `    ${formatNumber(Math.round(elapsed))}ms | ${formatNumber(opsPerSec)} ops/s`;

  if (bytesPerOp > 0) {
    const mbPerSec = Math.round((bytesPerOp * ops) / (elapsed / 1000) / (1000 * 1000));
    log += ` | ${formatNumber(mbPerSec)} MB/s`;
  }

  console.log(log + "\n");
}

const OPS = 1_000_000;

const smallPayload = Buffer.from(JSON.stringify({ id: 1, msg: "hello" }), "utf8");
const mediumPayload = Buffer.alloc(1024, 0x42);
const largePayload = Buffer.alloc(64 * 1024, 0xab);

console.log("WIPC Frame Benchmarks\n");

// ── Encode ───────────────────────────────────────────────────────────────────

console.log("Encode");

bench(
  "encode small (27 B)",
  () => {
    blackbox(buildFrame(MessageType.DATA, smallPayload));
  },
  OPS,
  smallPayload.length,
);

bench(
  "encode 1 KB",
  () => {
    blackbox(buildFrame(MessageType.DATA, mediumPayload));
  },
  OPS,
  mediumPayload.length,
);

bench(
  "encode 64 KB",
  () => {
    blackbox(buildFrame(MessageType.DATA, largePayload));
  },
  100_000,
  largePayload.length,
);

// ── Decode ───────────────────────────────────────────────────────────────────

console.log("Decode (zero-copy, returns subarray view)");

const smallFrame = buildFrame(MessageType.DATA, smallPayload);
const mediumFrame = buildFrame(MessageType.DATA, mediumPayload);
const largeFrame = buildFrame(MessageType.DATA, largePayload);

bench(
  "decode small (27 B)",
  () => {
    const f = parseFrame(smallFrame)!;
    blackbox(f.payload[f.payload.length - 1]);
  },
  OPS,
  smallPayload.length,
);

bench(
  "decode 1 KB",
  () => {
    const f = parseFrame(mediumFrame)!;
    blackbox(f.payload[f.payload.length - 1]);
  },
  OPS,
  mediumPayload.length,
);

bench(
  "decode 64 KB",
  () => {
    const f = parseFrame(largeFrame)!;
    blackbox(f.payload[f.payload.length - 1]);
  },
  OPS,
  largePayload.length,
);

console.log("Decode + copy (Buffer.from)");

bench(
  "decode+copy small (27 B)",
  () => {
    const f = parseFrame(smallFrame)!;
    blackbox(Buffer.from(f.payload));
  },
  OPS,
  smallPayload.length,
);

bench(
  "decode+copy 1 KB",
  () => {
    const f = parseFrame(mediumFrame)!;
    blackbox(Buffer.from(f.payload));
  },
  OPS,
  mediumPayload.length,
);

bench(
  "decode+copy 64 KB",
  () => {
    const f = parseFrame(largeFrame)!;
    blackbox(Buffer.from(f.payload));
  },
  100_000,
  largePayload.length,
);

console.log("Channel round-trip (in-process echo)");

const ECHO_OPS = 500_000;

await new Promise<void>((done) => {
  let count = 0;

  const aToB = new PassThrough();
  const bToA = new PassThrough();

  class Sender extends Channel {
    onDataMessage() {
      count++;
    }
  }

  class Echo extends Channel {
    onDataMessage(data: Buffer) {
      this.send(MessageType.DATA, data);
    }
  }

  const sender = new Sender(bToA, aToB);
  // Echo must be instantiated to attach its listener to aToB
  new Echo(aToB, bToA);

  const warmupOps = Math.floor(ECHO_OPS / 10);
  count = 0;
  for (let i = 0; i < warmupOps; i++) {
    sender.send(MessageType.DATA, smallPayload);
  }

  setTimeout(() => {
    count = 0;
    const start = performance.now();
    for (let i = 0; i < ECHO_OPS; i++) {
      sender.send(MessageType.DATA, smallPayload);
    }

    setTimeout(() => {
      const elapsed = Math.max(0.001, performance.now() - start);
      const roundTrips = count;
      const rps = Math.round((roundTrips * 1000) / elapsed);
      const mbPerSec = Math.round(
        (smallPayload.length * roundTrips * 2) / (elapsed / 1000) / (1000 * 1000),
      );

      console.log(`  echo small (27 B)`);
      console.log(
        `    ${formatNumber(roundTrips)} round-trips in ${formatNumber(Math.round(elapsed))}ms | ${formatNumber(rps)} rt/s | ${formatNumber(mbPerSec)} MB/s\n`,
      );

      done();
    }, 500);
  }, 100);
});

console.log("Done.");
