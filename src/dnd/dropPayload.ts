// dropPayload: the PURE payload-extraction helpers behind the drag-and-drop
// controller. Given the raw values found on a real DataTransfer (already pulled
// out of vscode types by the controller), these functions recover the dragged
// chat ids and pick which recognized MIME actually carried a Nest payload. They
// import no vscode types and touch no filesystem (ARCHITECTURE.md unit-gate
// rule), so the unit test exercises the controller's payload-parse edge cases
// (tolerant JSON, foreign DataTransfer, cross-view reserved-MIME carrier) without
// pulling vscode in. The vscode-bound controller (dndController.ts) reads the real
// DataTransferItem values and hands them here as plain unknowns.
//
// WHY a cross-view carrier MIME exists: VSCode 1.66 preserves a custom MIME set in
// handleDrag into handleDrop ONLY when the drop lands in the SAME tree's
// controller. A chat dragged from Folders and dropped on Tags is a CROSS-tree
// drop, so the shared custom chat MIME is stripped by the host; the only item the
// host carries between two trees of the same extension is the SOURCE tree's
// reserved MIME (application/vnd.code.tree.<treeidlowercase>). handleDrag
// therefore writes the SAME chat-id JSON under both the shared chat MIME (for a
// within-view drop) AND the controller's own reserved MIME (the cross-view
// carrier), and handleDrop reads whichever recognized MIME is present.

import { NEST_CHAT_MIME } from './dropReducer';

// The two per-view reserved MIME types VSCode derives from each tree's view id
// (application/vnd.code.tree.<viewidlowercase>). Duplicated as literals here
// (matching dndController's exported constants and the values asserted against
// package.json in the deferred integration test) so this pure module stays free
// of any import that could transitively pull vscode in.
export const FOLDERS_RESERVED_MIME = 'application/vnd.code.tree.claudenest.folders';
export const TAGS_RESERVED_MIME = 'application/vnd.code.tree.claudenest.tags';

// The ordered list of MIME types handleDrop will look under for a Nest chat-id
// payload. The shared chat MIME is checked FIRST (the within-view path, where the
// host preserves our custom item); the two reserved MIMEs are the cross-view
// carriers (the only item the host moves between two trees of the same
// extension). A drop carrying none of these is an unrecognized source and the
// reducer no-ops on the empty id list.
export const RECOGNIZED_PAYLOAD_MIMES: readonly string[] = [
  NEST_CHAT_MIME,
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
];

// Pick the recognized payload MIME present in a found-values map, in
// RECOGNIZED_PAYLOAD_MIMES priority order, returning the MIME and its raw value.
// The map keys are MIME strings and the values are the raw DataTransferItem.value
// the controller read (an unknown: our JSON string for a Nest-origin drag, or
// anything for a foreign one). A MIME mapped to undefined counts as absent (the
// host can offer a drop slot without a populated item). Returns undefined when no
// recognized MIME carried a value, which the controller maps to a no-op.
export function pickPayload(
  found: ReadonlyMap<string, unknown>,
): { mime: string; raw: unknown } | undefined {
  for (const mime of RECOGNIZED_PAYLOAD_MIMES) {
    if (found.has(mime)) {
      const raw = found.get(mime);
      if (raw !== undefined) {
        return { mime, raw };
      }
    }
  }
  return undefined;
}

// Recover the dragged chat ids from a raw DataTransferItem value. handleDrag
// serializes the id array as JSON, so the expected shape is a JSON string of a
// string[]. Tolerates anything else (a non-string value, malformed JSON, a
// non-array, a missing value) by returning [], and filters non-string elements,
// so a foreign or corrupt cross-view payload can never throw out of a drop; the
// reducer then no-ops on the empty list. String(raw) before JSON.parse mirrors
// how the controller previously coerced the DataTransferItem.value.
export function parseChatIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((v): v is string => typeof v === 'string');
}
