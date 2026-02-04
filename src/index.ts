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

export class Channel {
  private static readonly MAGIC = Buffer.from("WIPC");
  private static readonly HEADER_SIZE = 9;

  private buffer = Buffer.alloc(0);

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.input.on("data", (chunk) => this.onData(chunk as Buffer));
  }

  send(type: MessageType, payload?: Buffer) {
    const body = payload ?? Buffer.alloc(0);

    const header = Buffer.alloc(Channel.HEADER_SIZE);
    Channel.MAGIC.copy(header, 0); // magic
    header.writeUInt8(type, 4); // type
    header.writeUInt32LE(body.length, 5); // length

    this.output.write(Buffer.concat([header, body]));
  }

  sendJSON(type: MessageType, msg: unknown) {
    const json = Buffer.from(JSON.stringify(msg), "utf8");
    this.send(type, json);
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.buffer.length === 0) return;

      // Look for WIPC magic
      const idx = this.buffer.indexOf(Channel.MAGIC);

      if (idx === -1) {
        // No magic found — everything in the buffer is passthrough data
        this.onPassthrough(this.buffer);
        this.buffer = Buffer.alloc(0);
        return;
      }

      // Emit any bytes before the magic as passthrough
      if (idx > 0) {
        this.onPassthrough(this.buffer.subarray(0, idx));
        this.buffer = this.buffer.subarray(idx);
      }

      // Need full header to proceed
      if (this.buffer.length < Channel.HEADER_SIZE) return;

      const type = this.buffer.readUInt8(4);
      const length = this.buffer.readUInt32LE(5);

      const frameSize = Channel.HEADER_SIZE + length;
      if (this.buffer.length < frameSize) return;

      const payload = this.buffer.subarray(Channel.HEADER_SIZE, frameSize);
      this.buffer = this.buffer.subarray(frameSize);

      this.handleFrame(type, payload);
    }
  }

  private handleFrame(type: MessageType, payload: Buffer) {
    switch (type) {
      case MessageType.OPEN:
        this.onOpen();
        break;

      case MessageType.CLOSE:
        this.onClose();
        break;

      case MessageType.CALL:
        this.onCall(JSON.parse(payload.toString("utf8")));
        break;

      case MessageType.DATA:
        this.onDataMessage(payload);
        break;

      default:
        throw new Error(`Unknown frame type: ${type}`);
    }
  }

  /** Called for bytes on the stream that are NOT WIPC frames (e.g. console.log output from WASM). */
  protected onPassthrough(_data: Buffer) {}
  protected onOpen() {}
  protected onClose() {}
  protected onCall(_msg: unknown) {}
  protected onDataMessage(_data: Buffer) {}
}
