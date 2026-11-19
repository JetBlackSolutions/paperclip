import { describe, expect, it } from "vitest";
import { currentWakeCommentsOutcome } from "./current-wake-comments-outcome.js";

describe("current wake comments semantic outcome", () => {
  it.each([
    "already_complete", "binding_changed", "binding_not_authorized", "cursor_invalid",
    "cursor_out_of_order", "input_invalid", "snapshot_changed",
  ])("settles known %s rejection rather than stranding the external tool call", async suffix => {
    const code = `paperclip_current_wake_comments_${suffix}`;
    await expect(currentWakeCommentsOutcome(async () => { throw new Error(code); }))
      .resolves.toEqual({ outcome: "failed", error: { code, message: code } });
  });
  it("preserves successful page and receipt", async () => {
    const page = { complete: true, comments: [{ body: "Current request" }] };
    expect(await currentWakeCommentsOutcome(async () => page)).toBe(page);
  });
  it.each(["database disconnected", "paperclip_current_wake_comments_unknown", "paperclip_current_wake_comments_cursor_invalid secret"])("does not hide unknown effect or leak error text: %s", async message => {
    const error = new Error(message);
    await expect(currentWakeCommentsOutcome(async () => { throw error; })).rejects.toBe(error);
  });
});
