import { Channel, MessageType } from "../src/index.ts";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { strict as assert } from "node:assert";
import { test, describe, after } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAGIC = Buffer.from("WIPC");
const HEADER_SIZE = 9;

function buildFrame(type, payload) {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32LE(body.length, 5);
  return Buffer.concat([header, body]);
}

function parseFrame(buf) {
  if (buf.length < HEADER_SIZE) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  const type = buf.readUInt8(4);
  const length = buf.readUInt32LE(5);
  if (buf.length < HEADER_SIZE + length) return null;
  const payload = buf.subarray(HEADER_SIZE, HEADER_SIZE + length);
  return { type, payload };
}

// ── Unit Tests ───────────────────────────────────────────────────────────────

describe("Frame encoding", () => {
  test("encode OPEN frame (no payload)", () => {
    const frame = buildFrame(MessageType.OPEN);
    assert.equal(frame.length, HEADER_SIZE);
    assert.ok(frame.subarray(0, 4).equals(MAGIC));
    assert.equal(frame.readUInt8(4), MessageType.OPEN);
    assert.equal(frame.readUInt32LE(5), 0);
  });

  test("encode CALL frame with JSON payload", () => {
    const json = Buffer.from(JSON.stringify({ ping: true }), "utf8");
    const frame = buildFrame(MessageType.CALL, json);
    assert.equal(frame.length, HEADER_SIZE + json.length);
    assert.equal(frame.readUInt8(4), MessageType.CALL);
    assert.equal(frame.readUInt32LE(5), json.length);
    assert.ok(frame.subarray(HEADER_SIZE).equals(json));
  });

  test("encode DATA frame with binary payload", () => {
    const payload = Buffer.from([0x00, 0xff, 0x42, 0xde, 0xad]);
    const frame = buildFrame(MessageType.DATA, payload);
    assert.equal(frame.length, HEADER_SIZE + 5);
    assert.equal(frame.readUInt8(4), MessageType.DATA);
    assert.equal(frame.readUInt32LE(5), 5);
    assert.ok(frame.subarray(HEADER_SIZE).equals(payload));
  });

  test("encode CLOSE frame (no payload)", () => {
    const frame = buildFrame(MessageType.CLOSE);
    assert.equal(frame.length, HEADER_SIZE);
    assert.equal(frame.readUInt8(4), MessageType.CLOSE);
    assert.equal(frame.readUInt32LE(5), 0);
  });
});

describe("Frame decoding", () => {
  test("decode valid OPEN frame", () => {
    const raw = buildFrame(MessageType.OPEN);
    const frame = parseFrame(raw);
    assert.notEqual(frame, null);
    assert.equal(frame.type, MessageType.OPEN);
    assert.equal(frame.payload.length, 0);
  });

  test("decode valid CALL frame with JSON", () => {
    const json = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const raw = buildFrame(MessageType.CALL, json);
    const frame = parseFrame(raw);
    assert.notEqual(frame, null);
    assert.equal(frame.type, MessageType.CALL);
    assert.deepEqual(JSON.parse(frame.payload.toString("utf8")), {
      hello: "world",
    });
  });

  test("decode returns null for too-short buffer", () => {
    const frame = parseFrame(Buffer.from([0x57, 0x49]));
    assert.equal(frame, null);
  });

  test("decode returns null for bad magic", () => {
    const raw = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const frame = parseFrame(raw);
    assert.equal(frame, null);
  });

  test("decode returns null for incomplete payload", () => {
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt8(MessageType.DATA, 4);
    header.writeUInt32LE(100, 5);
    const frame = parseFrame(header);
    assert.equal(frame, null);
  });

  test("round-trip encode/decode", () => {
    const payload = Buffer.from(JSON.stringify({ round: "trip" }), "utf8");
    const raw = buildFrame(MessageType.CALL, payload);
    const frame = parseFrame(raw);
    assert.notEqual(frame, null);
    assert.equal(frame.type, MessageType.CALL);
    assert.ok(frame.payload.equals(payload));
  });
});

describe("Channel class (buffering, resync, passthrough)", () => {
  test("handles partial reads (data arriving in chunks)", async () => {
    const received = [];
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, enc, cb) {
        cb();
      },
    });

    class TestChannel extends Channel {
      onCall(msg) {
        received.push(msg);
      }
    }

    const _ch = new TestChannel(readable, writable);

    const json = Buffer.from(JSON.stringify({ chunked: true }), "utf8");
    const frame = buildFrame(MessageType.CALL, json);

    // Send frame in two chunks
    readable.push(frame.subarray(0, 4));
    await new Promise((r) => setTimeout(r, 10));
    readable.push(frame.subarray(4));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { chunked: true });
  });

  test("passes through non-WIPC data before a frame", async () => {
    const received = [];
    const passthrough = [];
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, enc, cb) {
        cb();
      },
    });

    class TestChannel extends Channel {
      onCall(msg) {
        received.push(msg);
      }
      onPassthrough(data) {
        passthrough.push(Buffer.from(data));
      }
    }

    const _ch = new TestChannel(readable, writable);

    const garbage = Buffer.from("hello world\n");
    const json = Buffer.from(JSON.stringify({ after: "text" }), "utf8");
    const frame = buildFrame(MessageType.CALL, json);

    readable.push(Buffer.concat([garbage, frame]));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { after: "text" });
    assert.equal(passthrough.length, 1);
    assert.ok(passthrough[0].equals(garbage));
  });

  test("passes through data when no frame present", async () => {
    const passthrough = [];
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, enc, cb) {
        cb();
      },
    });

    class TestChannel extends Channel {
      onPassthrough(data) {
        passthrough.push(Buffer.from(data));
      }
    }

    const _ch = new TestChannel(readable, writable);

    const text = Buffer.from("just some text output\n");
    readable.push(text);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(passthrough.length, 1);
    assert.ok(passthrough[0].equals(text));
  });

  test("handles multiple frames in one chunk", async () => {
    const received = [];
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, enc, cb) {
        cb();
      },
    });

    class TestChannel extends Channel {
      onCall(msg) {
        received.push(msg);
      }
      onOpen() {
        received.push("OPEN");
      }
    }

    const _ch = new TestChannel(readable, writable);

    const frame1 = buildFrame(MessageType.OPEN);
    const json = Buffer.from(JSON.stringify({ multi: true }), "utf8");
    const frame2 = buildFrame(MessageType.CALL, json);

    readable.push(Buffer.concat([frame1, frame2]));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(received.length, 2);
    assert.equal(received[0], "OPEN");
    assert.deepEqual(received[1], { multi: true });
  });

  test("send produces correct wire format", () => {
    const chunks = [];
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });

    const ch = new Channel(readable, writable);
    const payload = Buffer.from(JSON.stringify({ test: 1 }), "utf8");
    ch.send(MessageType.CALL, payload);

    const sent = Buffer.concat(chunks);
    assert.ok(sent.subarray(0, 4).equals(MAGIC));
    assert.equal(sent.readUInt8(4), MessageType.CALL);
    assert.equal(sent.readUInt32LE(5), payload.length);
    assert.ok(sent.subarray(HEADER_SIZE).equals(payload));
  });

  test("sendJSON serializes and sends correctly", () => {
    const chunks = [];
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });

    const ch = new Channel(readable, writable);
    ch.sendJSON(MessageType.CALL, { key: "value" });

    const sent = Buffer.concat(chunks);
    const frame = parseFrame(sent);
    assert.notEqual(frame, null);
    assert.equal(frame.type, MessageType.CALL);
    assert.deepEqual(JSON.parse(frame.payload.toString("utf8")), {
      key: "value",
    });
  });
});

// ── Integration Tests ────────────────────────────────────────────────────────

describe("Integration: Node.js <-> Node.js echo", () => {
  let child;

  after(() => {
    if (child && !child.killed) {
      child.kill();
    }
  });

  test("echo OPEN frame", async () => {
    const result = await spawnEchoAndExchange(MessageType.OPEN);
    assert.equal(result.type, MessageType.OPEN);
    assert.equal(result.payload.length, 0);
  });

  test("echo CALL frame with JSON", async () => {
    const payload = Buffer.from(JSON.stringify({ ping: true }), "utf8");
    const result = await spawnEchoAndExchange(MessageType.CALL, payload);
    assert.equal(result.type, MessageType.CALL);
    assert.deepEqual(JSON.parse(result.payload.toString("utf8")), {
      ping: true,
    });
  });

  test("echo DATA frame with binary", async () => {
    const payload = Buffer.from([
      0x01, 0x02, 0x03, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe,
      0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01,
      0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02,
      0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03,
      0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff,
      0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe,
      0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff,
      0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe,
      0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0x01,
      0x02, 0x03, 0xff, 0xfe,
    ]);
    const result = await spawnEchoAndExchange(MessageType.DATA, payload);
    assert.equal(result.type, MessageType.DATA);
    assert.ok(result.payload.equals(payload));
  });
});

function spawnEchoAndExchange(type, payload) {
  return new Promise((resolve, reject) => {
    const echoPath = join(__dirname, "echo.js");
    const proc = spawn("node", ["--experimental-transform-types", echoPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    let buffer = Buffer.alloc(0);

    proc.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length >= HEADER_SIZE) {
        if (!buffer.subarray(0, 4).equals(MAGIC)) {
          reject(new Error("Bad magic in response"));
          proc.kill();
          return;
        }

        const len = buffer.readUInt32LE(5);
        if (buffer.length >= HEADER_SIZE + len) {
          const frame = parseFrame(buffer);
          proc.kill();
          resolve(frame);
        }
      }
    });

    proc.on("error", reject);

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Echo process timed out"));
    }, 5000);

    proc.on("close", () => {
      clearTimeout(timeout);
    });

    // Send the frame
    const frame = buildFrame(type, payload);
    proc.stdin.write(frame);
  });
}
