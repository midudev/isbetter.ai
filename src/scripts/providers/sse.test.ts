import { describe, expect, it } from "vitest";
import { decodeSSEText, SSEDecoder } from "./sse";

describe("SSEDecoder", () => {
  it("preserves partial frames between chunks", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"choices":[{"delta":{"content":"hel')).toEqual([]);
    expect(decoder.push('lo"}}]}\n\n')).toEqual([
      { event: "message", data: '{"choices":[{"delta":{"content":"hello"}}]}' },
    ]);
  });

  it("flushes a final event without a trailing newline", () => {
    expect(decodeSSEText('event: message\ndata: {"usage":{"total_tokens":4}}')).toEqual([
      { event: "message", data: '{"usage":{"total_tokens":4}}' },
    ]);
  });

  it("joins multiple data lines and ignores comments", () => {
    expect(decodeSSEText(": keepalive\nevent: update\ndata: first\ndata: second\n\n")).toEqual([
      { event: "update", data: "first\nsecond" },
    ]);
  });
});
