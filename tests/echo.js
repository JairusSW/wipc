// Echo server: reads WIO frames from stdin, echoes them back on stdout.
// Used as a child process for integration tests.

import { Channel, MessageType } from "../src/index.ts";

class EchoChannel extends Channel {
  onOpen() {
    this.send(MessageType.OPEN);
  }

  onClose() {
    this.send(MessageType.CLOSE);
    process.exit(0);
  }

  onCall(msg) {
    this.sendJSON(MessageType.CALL, msg);
  }

  onDataMessage(data) {
    this.send(MessageType.DATA, data);
  }
}

new EchoChannel(process.stdin, process.stdout);
