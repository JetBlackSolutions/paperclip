/** Known reader failures are settled tool errors, not unknown write effects.
 * Only catch exact domain errors after the reader transaction has rolled back.
 * Storage/transport failures retain normal uncertain-dispatch recovery.
 */
const READER_ERRORS = new Set([
  "paperclip_current_wake_comments_already_complete",
  "paperclip_current_wake_comments_binding_changed",
  "paperclip_current_wake_comments_binding_not_authorized",
  "paperclip_current_wake_comments_cursor_invalid",
  "paperclip_current_wake_comments_cursor_out_of_order",
  "paperclip_current_wake_comments_input_invalid",
  "paperclip_current_wake_comments_snapshot_changed",
]);

export async function currentWakeCommentsOutcome<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Error) || !READER_ERRORS.has(error.message)) throw error;
    return { outcome: "failed" as const, error: { code: error.message, message: error.message } };
  }
}
