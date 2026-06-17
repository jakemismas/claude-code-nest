import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { LinkedChild } from '../model/links';
import { relativeTime } from './relativeTime';
import { OPEN_CHAT_COMMAND } from './flatProvider';

// linkDecoration: the rendering of a linkedChild occurrence in the Folders tree.
// A linked child renders as a distinct node (composite id `${parentChatId}>link>
// ${chatId}`) nested beneath its one designated parent chat-member occurrence, with
// a git-branch ThemeIcon. A BROKEN child (its target chat id no longer resolves to a
// scanned record) renders MUTED: a placeholder label, a muted (disabled-foreground)
// icon, an explanatory tooltip, and NO open command (there is nothing to open).
//
// Read-only chokepoint (ARCHITECTURE.md): this module performs NO filesystem writes.
// It only constructs vscode TreeItems and ThemeIcons. It sits inside the read-only
// surface with no carve-out (only src/settings/claudeSettingsIO.ts and src/test/**
// are exempt), which is correct for a pure decoration module: the eslint
// no-restricted-syntax bank applies here in full, and nothing in it can write under
// ~/.claude.

// The ThemeIcon a linked child uses when its target resolves: a git-branch glyph,
// signalling the link/branch relationship (ARCHITECTURE.md / PLAN.md "git-branch
// ThemeIcon"). Built once and shared; ThemeIcon is immutable.
export const LINK_BRANCH_ICON = new vscode.ThemeIcon('git-branch');

// The ThemeIcon a BROKEN linked child uses: the same branch glyph tinted with the
// disabled-foreground theme color so the row reads as muted/unavailable. The color
// is a standard VSCode theme color id, so it adapts to light/dark themes.
export const LINK_BROKEN_ICON = new vscode.ThemeIcon(
  'git-branch',
  new vscode.ThemeColor('disabledForeground'),
);

// The label shown for a broken linked child (its target chat is missing). Kept
// generic and client-neutral; the tooltip carries the missing chat id for
// diagnosis.
export const BROKEN_LINK_LABEL = '(linked chat unavailable)';

// The contextValue that gates a linked-child row's context menu: a resolvable child
// offers Unlink; a broken child offers Unlink too (so a dangling link can be cleaned
// up) but no Open. Distinct values let package.json target each.
export const LINKED_CHILD_CONTEXT = 'claudeNest.linkedChild';
export const LINKED_CHILD_BROKEN_CONTEXT = 'claudeNest.linkedChildBroken';

// Apply the linked-child decoration to a freshly-constructed TreeItem in place. The
// caller (foldersProvider.LinkedChildItem) owns the TreeItem subclass and its ids;
// this function sets only the VISUAL + behavioral fields that distinguish a linked
// child from a folder member: label/description, icon, tooltip, contextValue, and
// the open command (omitted for a broken child). Keeping the decoration here lets
// the provider stay a thin id/memoization shell and matches the slice's "view
// decoration" module boundary.
//
// record is the resolved ChatRecord for the child's target, or undefined when the
// target is BROKEN (unknown chat id). child carries the composite id and the broken
// flag; broken is derived from record === undefined but is passed through on the
// LinkedChild so the memoization predicate and this decoration agree on one source.
export function decorateLinkedChild(
  item: vscode.TreeItem,
  child: LinkedChild,
  record: ChatRecord | undefined,
): void {
  if (record === undefined || child.broken) {
    // Muted, label-only, no open command. The tooltip names the missing target so a
    // user can find and unlink it.
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
