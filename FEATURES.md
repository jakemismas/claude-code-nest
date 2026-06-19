> Source spec for Sprint 2 (the original feature brief plus the UI mockup). This is
> the raw intent. The authoritative, buildable contract is SPRINT-2-PLAN.md, and
> DECISIONS.md records what was dropped and why. In particular, the entire "Chat
> window" section below was found impossible for a third-party extension (sandboxed
> webview, no live-state read, no session-drive channel) and is NOT being built; its
> honest residue (a per-chat token total from the transcript, tag editing in Nest's
> own panel) is folded into the surviving features. See V2-RESEARCH.md sections 4-5.

# Claude Code - Chat Organizer (sidebar extension)

A VS Code side panel for organizing Claude Code sessions, plus an in-window chat view with context/token tooling. Light theme, Claude Code palette (#d97757).

## Sidebar

- **Search (full-text)** - matches both chat titles and message content; shows a matching snippet under the title.
- **Tag filter chips** - click colored tags to filter; combine with search.
- **Sort** - Newest first / Oldest first / Name (A-Z).
- **Sections** (each toggleable in Settings):
  - **Starred** - pinned chats up top; hidden when none.
  - **Questions** - chats awaiting your reply (blinking `?`); hidden when none.
  - **Folders** - nested folder tree; per-folder color and chat count.
  - **Unsorted** - catch-all for chats not in a folder; always present.
- **Folders**
  - Nested (one level of subfolders), collapsible; "collapse one level" button.
  - Create with a name prompt; **double-click to rename**; right-click to set color.
  - **Drag-and-drop** chats between folders (drop on Unsorted to unfile).
- **Tags** - right-click a chat to toggle tags or **create a new tag** (name + color).
- **Rich hover preview** - hover a row for a card with folder, age, token count, tags, and first/last messages.
- **Archiving** - chats past a keep-window (7d-never, set in Settings) move to an **Archive** view; archive is searchable; **Restore** brings them back. **Starred chats are never archived.**
- **Export** - any chat to **Markdown** or **JSON** (right-click; also on archived rows).

## Chat window

- **Tag bar** beside the session title - chips with remove (x) and **+ Tag** to add existing or create new.
- **Context-health bar** - fills with context usage; color shifts healthy to filling to nearly full.
- **Compact button** - hover shows the estimated tokens it would free (and previews the freed portion on the bar); click to compact.
- **Token usage** - live "used / 200K tokens" readout.
- **Transcript + composer** - message thread with a reply box.

## Density

- Two density modes (Comfortable / Compact) shown side by side.

## Notes / open questions for the team

- Archive currently triggers on the keep-window setting; should starred-exempt also apply to manual archive? (today: yes - manual archive is hidden for starred.)
- Token budget hard-coded to 200K for the demo.
- Export is client-side (Markdown/JSON); real version would pull the full transcript.
