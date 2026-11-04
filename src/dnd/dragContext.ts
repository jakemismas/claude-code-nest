// In-process carrier for the chat ids of a drag between the Folders and Tags views.
// VS Code 1.66 delivers a controller's custom DataTransferItem only to a drop in the same
// tree, so handleDrag stashes the ids here and handleDrop falls back to the stash when the
// DataTransfer yields none. The stash is single-entry and cleared when taken, so a stale
// one cannot leak into a later drop. No vscode import, so tests run without the host.

// The token identifies the drag that wrote the stash.
export interface DragStash {
  token: number;
  chatIds: string[];
}

// One pointer means one drag at a time, so a single slot suffices; a new drag overwrites an abandoned one.
let current: DragStash | undefined;
let nextToken = 1;

// An empty id list still stashes, so a drag with no chats replaces any older stash.
export function stashDrag(chatIds: string[]): number {
  const token = nextToken++;
  current = { token, chatIds: [...chatIds] };
  return token;
}

// Reads and clears the stash, so one drop consumes it once.
export function takeDrag(): DragStash | undefined {
  const taken = current;
  current = undefined;
  return taken;
}

// Reads the stash without clearing it; used by tests.
export function peekDrag(): DragStash | undefined {
  return current;
}

export function clearDrag(): void {
  current = undefined;
}
