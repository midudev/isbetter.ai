export interface SSEEvent {
  event: string;
  data: string;
}

function parseFrame(frame: string): SSEEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export class SSEDecoder {
  private buffer = "";

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() || "";
    return frames.map(parseFrame).filter((event): event is SSEEvent => event !== null);
  }

  finish(chunk = ""): SSEEvent[] {
    const events = this.push(chunk);
    const final = parseFrame(this.buffer);
    this.buffer = "";
    if (final) events.push(final);
    return events;
  }
}

export function decodeSSEText(text: string): SSEEvent[] {
  const decoder = new SSEDecoder();
  return decoder.finish(text);
}
