import { Channel, MessageType } from "./src/index.js";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "build", "test.wasm");

const child = spawn("wasmtime", [wasmPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

child.on("error", (err) => {
  process.stderr.write(`Failed to spawn wasmtime: ${err.message}\n`);
  process.exit(1);
});

class TestChannel extends Channel {
  public benching: boolean = false;

  onOpen() {
    process.stderr.write("<- [OPEN]\n");
  }

  onClose() {
    process.stderr.write("<- [CLOSE]\n");
    rl.close();
    child.kill();
  }

  onDataMessage(data: Buffer) {
    if (this.benching) return;
    process.stderr.write(`<- [DATA] ${data.toString("utf8")}\n`);
  }

  onPassthrough(data: Buffer) {
    process.stderr.write(`[stdout] ${data.toString("utf8")}`);
  }
}

const channel = new TestChannel(child.stdout!, child.stdin!);

const rl = createInterface({
  input: process.stdin,
  output: process.stderr,
});

process.stderr.write("WIPC Interactive Test (Node.js <-> AssemblyScript WASM)\n");
process.stderr.write("Commands:\n");
process.stderr.write("  open                 - send OPEN frame\n");
process.stderr.write("  close                - send CLOSE frame and exit\n");
process.stderr.write("  call <path> <params> - send CALL frame with payload\n");
process.stderr.write("  data <text>          - send DATA frame with text payload\n");
process.stderr.write("  bench <ops> <text>   - send n amount of packets with text payload\n\n");

rl.setPrompt("> ");
rl.prompt();

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  if (channel.benching) channel.benching = false;
  if (trimmed === "open") {
    process.stderr.write("-> [OPEN]\n");
    channel.send(MessageType.OPEN);
  } else if (trimmed === "close") {
    process.stderr.write("-> [CLOSE]\n");
    channel.send(MessageType.CLOSE);
    return;
  } else if (trimmed.startsWith("call ")) {
    const path = trimmed.slice(5);
    process.stderr.write(`-> [CALL] fs.readFile("${path}")\n`);
    channel.send(MessageType.CALL, Buffer.from(path, "utf8"));
  } else if (trimmed.startsWith("data ")) {
    const text = trimmed.slice(5);
    process.stderr.write(`-> [DATA] ${text}\n`);
    channel.send(MessageType.DATA, Buffer.from(text, "utf8"));
  } else if (trimmed.startsWith("bench ")) {
    const [opsStr = "", ...textParts] = trimmed.slice(6).split(" ");
    const count = parseInt(opsStr, 10);

    if (!Number.isFinite(count) || count <= 0) {
      process.stderr.write(`Invalid count: ${opsStr}\n`);
      return;
    }

    const text = textParts.join(" ");
    if (!text.length) {
      process.stderr.write(`Missing text payload\n`);
      return;
    }

    const textBuf = Buffer.from(text, "utf8");

    channel.benching = true;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      channel.send(MessageType.DATA, textBuf);
    }
    const end = performance.now();

    const duration = end - start;
    const opsPerSecond = Math.round((count / duration) * 1000);

    process.stderr.write(
      `-> [BENCH] ${count}x "${text}" (${duration.toFixed(2)}ms, ${opsPerSecond} ops/s)\n`,
    );
  } else {
    process.stderr.write(`-> [DATA] ${trimmed}\n`);
    channel.send(MessageType.DATA, Buffer.from(trimmed, "utf8"));
  }

  rl.prompt();
});

rl.on("close", () => {
  child.stdin!.end();
  child.kill();
  process.exit(0);
});

child.on("close", (code) => {
  process.stderr.write(`\nWASM process exited (code ${code})\n`);
  rl.close();
  process.exit(0);
});
