import * as vscode from 'vscode';

// tagQuickPick: the vscode-bound multi-select tag picker (QuickPick with
// canPickMany), the PRIMARY tagging affordance per the slice plan. It presents
// every tag with the chat's currently-applied tags pre-picked, lets the user
// toggle many in one pass, and returns the FINAL selected tag-id set. The command
// layer (taggingCommands.ts) diffs that set against the current set and stages the
// adds and removes as one batched store write.
//
// This module imports vscode (the QuickPick API) and is therefore NOT imported by
// any unit test; the pure tag-diff logic it feeds lives in taggingCommands.ts
// behind an injectable seam so the command can be exercised headless. Keeping the
// raw QuickPick wiring here isolates the one piece that genuinely needs the vscode
// window.

// One selectable tag row in the multi-select picker.
export interface TagPickOption {
  tagId: string;
  label: string;
  // Whether this tag is currently applied to the chat (pre-picked on open).
  picked: boolean;
}

// A QuickPickItem carrying its tag id, so the resolved selection maps back to ids.
interface TagQuickPickItem extends vscode.QuickPickItem {
  tagId: string;
}

// Show the multi-select tag picker for a chat. Returns the FINAL set of selected
// tag ids (those the user left checked), or undefined when the picker was
// dismissed without confirming (Escape), so the caller can distinguish "confirmed
// an empty selection" (remove all tags) from "cancelled" (do nothing).
//
// canPickMany is true: the user toggles checkboxes and confirms once. The
// currently-applied tags are pre-picked so confirming without changes is a no-op
// the caller detects via the diff.
export function showTagMultiPick(
  options: TagPickOption[],
  placeholder: string,
): Thenable<string[] | undefined> {
  const items: TagQuickPickItem[] = options.map((option) => ({
    label: option.label,
    tagId: option.tagId,
    picked: option.picked,
  }));

  return vscode.window
    .showQuickPick(items, {
      canPickMany: true,
      placeHolder: placeholder,
      // Keep the picker open while toggling; the user confirms with Enter.
      ignoreFocusOut: false,
    })
    .then((picked) => {
      if (picked === undefined) {
        return undefined;
      }
      return picked.map((item) => item.tagId);
    });
}
