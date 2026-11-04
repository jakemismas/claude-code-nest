import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { LinkedChild } from '../model/links';
import { relativeTime } from './relativeTime';
import { OPEN_CHAT_COMMAND } from '../launch/uriLauncher';

// Renders a linked child in the Folders tree: a git-branch node under its parent chat. A
// broken child (target chat no longer scanned) is muted, with a placeholder label, an
// explanatory tooltip and no open command.

export const LINK_BRANCH_ICON = new vscode.ThemeIcon('git-branch');

// Branch glyph tinted with a theme color id so the muted row adapts to light and dark.
export const LINK_BROKEN_ICON = new vscode.ThemeIcon(
  'git-branch',
  new vscode.ThemeColor('disabledForeground'),
);

export const BROKEN_LINK_LABEL = '(linked chat unavailable)';

// Distinct contextValues let package.json menus give a broken child Unlink but no Open.
export const LINKED_CHILD_CONTEXT = 'claudeNest.linkedChild';
export const LINKED_CHILD_BROKEN_CONTEXT = 'claudeNest.linkedChildBroken';

// Sets the visual and command fields of a linked-child TreeItem in place. record is
// undefined when the target is unknown.
export function decorateLinkedChild(
  item: vscode.TreeItem,
  child: LinkedChild,
  record: ChatRecord | undefined,
): void {
  if (record === undefined || child.broken) {
    // The tooltip names the missing target so the user can find and unlink it.
    item.label = BROKEN_LINK_LABEL;
    item.description = undefined;
    item.iconPath = LINK_BROKEN_ICON;
    item.tooltip = `Linked chat ${child.chatId} is no longer present on disk.`;
    item.contextValue = LINKED_CHILD_BROKEN_CONTEXT;
    item.command = undefined;
    return;
  }
  item.label = record.title;
  item.description = relativeTime(record.timestamp);
  item.iconPath = LINK_BRANCH_ICON;
  item.tooltip = record.title + '\n' + record.sessionId;
  item.contextValue = LINKED_CHILD_CONTEXT;
  item.command = {
    command: OPEN_CHAT_COMMAND,
    title: 'Open Chat',
    arguments: [record.sessionId],
  };
}
