// Pure helpers that pick the Nest payload out of a drop's DataTransfer values and parse the
// dragged chat ids. They take plain unknowns and have no vscode import.
// VS Code 1.66 keeps a custom MIME for a drop in the same tree only; a cross-tree drop
// falls back to the stash in dragContext.ts, which the controller handles.

import { NEST_CHAT_MIME } from './dropReducer';

// VS Code derives these from each view id (application/vnd.code.tree.<viewidlowercase>).
// Literals here keep this module free of vscode imports.
export const FOLDERS_RESERVED_MIME = 'application/vnd.code.tree.claudenest.folders';
export const TAGS_RESERVED_MIME = 'application/vnd.code.tree.claudenest.tags';

// In priority order. The shared chat MIME comes first because the host preserves it for a drop in the same tree.
export const RECOGNIZED_PAYLOAD_MIMES: readonly string[] = [
  NEST_CHAT_MIME,
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
];

// A MIME mapped to undefined counts as absent, because the host can offer a slot without an item.
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

// Expects a JSON string of a string[]. Anything else returns [], so a foreign or corrupt
// payload never throws out of a drop.
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
