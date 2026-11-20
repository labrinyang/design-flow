/** Chat-style composing: Enter sends, Shift/Option+Enter breaks the line, and an IME's confirming Enter is left alone. */
export function sendsOnKey(e: { key: string; shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229;
}
