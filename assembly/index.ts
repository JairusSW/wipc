import {
  fd_read,
  errno,
  errnoToString,
} from "@assemblyscript/wasi-shim/assembly/bindings/wasi_snapshot_preview1";

// offset  size   field
// -------------------------
// 0       4      magic ("WIPC")
// 4       1      type
// 5       4      payload_length (uint32, LE)
// 9       N      payload

export enum MessageType {
  OPEN = 0x00,
  CLOSE = 0x01,
  CALL = 0x02,
  DATA = 0x03,
}

const MAGIC_W: u8 = 0x57; // 'W'
const MAGIC_I: u8 = 0x49; // 'I'
const MAGIC_P: u8 = 0x50; // 'P'
const MAGIC_C: u8 = 0x43; // 'C'
const HEADER_SIZE: u32 = 9;

const STDIN: u32 = 0;

// Reusable iovec buffer: [buf_ptr, buf_len, nread/nwritten]
const iovecBuf = memory.data(3 * sizeof<usize>());

function readExact(
  fd: u32,
  buffer: ArrayBuffer,
  offset: u32,
  length: u32,
): bool {
  let pos: usize = <usize>offset;
  let remaining: usize = <usize>length;
  while (remaining > 0) {
    store<usize>(iovecBuf, changetype<usize>(buffer) + pos);
    store<usize>(iovecBuf, remaining, sizeof<usize>());
    const err = fd_read(fd, iovecBuf, 1, iovecBuf + 2 * sizeof<usize>());
    if (err != errno.SUCCESS) throw new Error(errnoToString(err));
    const nread = load<usize>(iovecBuf, 2 * sizeof<usize>());
    if (nread == 0) return false; // EOF
    pos += nread;
    remaining -= nread;
  }
  return true;
}

export class Frame {
  constructor(
    public type: MessageType,
    public payload: Uint8Array,
  ) {}
}

export function encode(
  type: MessageType,
  payload: Uint8Array | null,
): ArrayBuffer {
  const payloadLen = payload ? payload.length : 0;
  const buf = new ArrayBuffer(HEADER_SIZE + payloadLen);
  const base = changetype<usize>(buf);

  // Magic "WIPC"
  store<u8>(base, MAGIC_W, 0);
  store<u8>(base, MAGIC_I, 1);
  store<u8>(base, MAGIC_P, 2);
  store<u8>(base, MAGIC_C, 3);

  // Type
  store<u8>(base, <u8>type, 4);

  // Length (little-endian u32)
  store<u32>(base, <u32>payloadLen, 5);

  // Payload
  if (payload && payloadLen > 0) {
    memory.copy(base + HEADER_SIZE, payload.dataStart, payloadLen);
  }

  return buf;
}

export function decode(data: Uint8Array): Frame | null {
  if (<u32>data.length < HEADER_SIZE) return null;

  const base = data.dataStart;

  // Validate magic
  if (
    load<u8>(base, 0) != MAGIC_W ||
    load<u8>(base, 1) != MAGIC_I ||
    load<u8>(base, 2) != MAGIC_P ||
    load<u8>(base, 3) != MAGIC_C
  ) {
    return null;
  }

  const type = <MessageType>load<u8>(base, 4);

  // Read length (little-endian u32)
  const len: u32 = load<u32>(base, 5);

  if (<u32>data.length < HEADER_SIZE + len) return null;

  const payload = new Uint8Array(<i32>len);
  if (len > 0) {
    memory.copy(payload.dataStart, base + HEADER_SIZE, len);
  }

  return new Frame(type, payload);
}

export function writeFrame(
  type: MessageType,
  payload: Uint8Array | null = null,
): void {
  const buf = encode(type, payload);
  process.stdout.write(buf);
}

export function readFrame(): Frame | null {
  const headerBuf = new ArrayBuffer(HEADER_SIZE);
  const base = changetype<usize>(headerBuf);

  // Read until we find a valid magic header
  while (true) {
    if (!readExact(STDIN, headerBuf, 0, 1)) return null;
    if (load<u8>(base, 0) != MAGIC_W) continue;

    if (!readExact(STDIN, headerBuf, 1, 1)) return null;
    if (load<u8>(base, 1) != MAGIC_I) continue;

    if (!readExact(STDIN, headerBuf, 2, 1)) return null;
    if (load<u8>(base, 2) != MAGIC_P) continue;

    if (!readExact(STDIN, headerBuf, 3, 1)) return null;
    if (load<u8>(base, 3) != MAGIC_C) continue;

    // We have the magic, read type + length (5 bytes)
    if (!readExact(STDIN, headerBuf, 4, 5)) return null;

    const type = <MessageType>load<u8>(base, 4);
    const len: u32 = load<u32>(base, 5);

    const payload = new Uint8Array(<i32>len);
    if (len > 0) {
      if (!readExact(STDIN, payload.buffer, 0, len)) return null;
    }

    return new Frame(type, payload);
  }
}
