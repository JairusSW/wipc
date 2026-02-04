import { MessageType, Frame, readFrame, writeFrame } from "./";

// Continuous echo responder: reads frames in a loop, echoes each one back.
// Exits on CLOSE or EOF.
while (true) {
  const frame: Frame | null = readFrame();
  if (frame === null) break;

  const f = frame as Frame;
  writeFrame(f.type, f.payload);

  if (f.type == MessageType.CLOSE) break;
}
