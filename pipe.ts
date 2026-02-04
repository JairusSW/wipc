import { Channel, MessageType } from "./src/index.ts";
import { createInterface } from "node:readline";

class TestChannel extends Channel {
  public benching: boolean = false;
  onOpen() {
    process.stdout.write("<- [OPEN]\n");
  }

  onClose() {
    process.stdout.write("<- [CLOSE]\n");
    rl.close();
  }

  onCall(msg: unknown) {
    process.stdout.write(`<- [CALL] ${JSON.stringify(msg)}\n`);
  }

  onDataMessage(data: Buffer) {
    if (this.benching) return;
    process.stdout.write(`<- [DATA] ${data.toString("utf8")}\n`);
  }
}

const channel = new TestChannel(process.stdin, process.stdout);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

process.stdout.write("WIO Interactive Echo (Node.js <-> AssemblyScript WASM)\n");
process.stdout.write("Commands:\n");
process.stdout.write("  open               - send OPEN frame\n");
process.stdout.write("  close              - send CLOSE frame and exit\n");
process.stdout.write("  call <json>        - send CALL frame with JSON payload\n");
process.stdout.write("  data <text>        - send DATA frame with text payload\n");
process.stdout.write("  bench <ops> <text> - send n amount of packets with text payload\n");
process.stdout.write("  <anything>         - send as CALL frame with { message: ... }\n\n");

rl.setPrompt("wio> ");
rl.prompt();

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  if (trimmed === "open") {
    process.stdout.write("-> [OPEN]\n");
    channel.send(MessageType.OPEN);
  } else if (trimmed === "close") {
    process.stdout.write("-> [CLOSE]\n");
    channel.send(MessageType.CLOSE);
    return;
  } else if (trimmed.startsWith("call ")) {
    const json = trimmed.slice(5);
    try {
      const parsed = JSON.parse(json);
      process.stdout.write(`-> [CALL] ${JSON.stringify(parsed)}\n`);
      channel.sendJSON(MessageType.CALL, parsed);
    } catch {
      process.stdout.write(`Invalid JSON: ${json}\n`);
    }
  } else if (trimmed.startsWith("data ")) {
    const text = trimmed.slice(5);
    process.stdout.write(`-> [DATA] ${text}\n`);
    channel.send(MessageType.DATA, Buffer.from(text, "utf8"));
  } else if (trimmed.startsWith("bench ")) {
    const [opsStr = "", ...textParts] = trimmed.slice(6).split(" ");
    const count = parseInt(opsStr, 10);

    if (!Number.isFinite(count) || count <= 0) {
      process.stdout.write(`Invalid count: ${opsStr}\n`);
      return;
    }

    const text = textParts.join(" ");
    if (!text.length) {
      process.stdout.write(`Missing text payload\n`);
      return;
    }

    const textBuf = Buffer.from(text, "utf8");

    channel.benching = true;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      channel.send(MessageType.DATA, textBuf);
    }
    const end = performance.now();
    channel.benching = false;

    const duration = end - start;
    const opsPerSecond = Math.round((count / duration) * 1000);

    process.stdout.write(
      `-> [BENCH] ${count}x "${text}" (${duration.toFixed(2)}ms, ${opsPerSecond} ops/s)\n`,
    );
  } else {
    const msg = { message: trimmed };
    process.stdout.write(`-> [CALL] ${JSON.stringify(msg)}\n`);
    channel.sendJSON(MessageType.CALL, msg);
  }

  rl.prompt();
});
