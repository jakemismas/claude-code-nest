import * as vscode from 'vscode';

// tagQuickPick: the vscode-bound multi-select tag picker (QuickPick with canPickMany). Applied tags are pre-picked and the final selected tag-id set is returned.
// taggingCommands.ts diffs it against the current set; that logic sits behind an injectable seam so tests never import this module.

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

// Show the multi-select tag picker for a chat. Returns the final selected tag ids, or undefined when dismissed, so the caller can tell "confirmed empty" (remove all) from "cancelled" (do nothing).
// Applied tags are pre-picked, so confirming without changes yields an empty diff.
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
