# Handoff: Claude Code — Chat Organizer Sidebar (side panel only)

## Overview
A VS Code sidebar (side-panel view) for organizing Claude Code sessions: full-text search, colored tags, a nested folder tree with drag-and-drop, starred / questions / unsorted sections, per-session archiving, a rich hover preview, and Markdown/JSON export. **This handoff covers the sidebar ONLY** — the earlier prototype also had an in-editor chat window; that has been intentionally removed here. Build only the side-panel view described below.

## About the design files
The files in this bundle are **design references authored in HTML** — a working prototype that shows the intended look and behavior. They are **not** production code to copy verbatim. The task is to **recreate this sidebar as a real VS Code extension** using the platform's normal patterns:
- A **WebviewView** contributed to the Activity Bar (`vscode.window.registerWebviewViewProvider`), OR
- A native **TreeView** (`vscode.window.createTreeView`) if you prefer OS-native rows — but note the tag pills, hover preview card, colored folder icons, inline search box, and context-health styling are much easier in a Webview. **Recommend a Webview** (React or plain TS) styled to match, reading VS Code theme tokens.

Persist state with the extension's `Memento`/global state or a JSON file in storage; the prototype keeps everything in memory.

## Fidelity
**High-fidelity.** Colors, spacing, typography, and interactions below are final — match them. This is Claude Code's warm palette on a light theme.

## The single screen: the sidebar panel
Fixed vertical column, **320px** wide, full height. Background `#FCFBF8`, right border `1px solid #E6E2D9`. Font stack: system UI (`-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`). Section header labels are 10px/600, letter-spacing 0.7px, color `#AEA99C`, uppercase.

Top-to-bottom:

### 1. Toolbar (row, padding 9px 9px 6px)
- **New session** button — LEFT-aligned. Pill, background `#d97757`, white text 12.5px/600, padding 5px 11px, radius 6px, a `+` glyph then the label "New session". Hover background `#c6613f`. Creates a new chat (prepended, becomes active).
- Flexible spacer.
- **⚙ Settings** icon button (27×27, radius 6) — opens the Settings sub-page (full-panel overlay). Active tint `#d97757` on `#F5EAE3`.
- **⇅ Sort** icon button — opens a small popover: **Newest first** (default), **Oldest first**, **Name (A–Z)**. Checkmark `#d97757` on the active one.

### 2. Search box (padding 0 9px 8px)
- Full-width input, radius 6, border `1px solid #E4E0D6`, background `#FBFAF6`, 13px text, magnifier icon at left (`#A6A294`).
- Placeholder: "Search chats & messages".
- **Focus glow:** border `#d97757`, `box-shadow: 0 0 0 1px #d97757, 0 0 14px 2px rgba(217,119,87,0.35)`, background `#fff`, transition 160ms.
- When non-empty, a `×` clear button appears at the right.
- **Full-text:** matches BOTH the chat title AND message body text. When a match is only in the body (not the title), the row shows a one-line **snippet** beneath the title (`You: …matched text…` / `Claude: …`), 11px, color `#9A958A`, truncated.

### 3. Tag filter chips (horizontal, scrollable, padding 0 9px 9px)
- One pill per tag. Inactive: transparent, text `#8C887E`, border `1px solid #E2DED4`. Active: background = tag color @15% alpha, text = tag color, border = tag color @45% alpha. Each pill has a 7px color dot.
- Clicking toggles that tag as a filter (multi-select, AND-combined with search). Filtering replaces the sectioned list with a flat "N RESULTS" list.

### 4. Scrolling list
When NOT filtering, sections render in this order (each hidden if its Settings toggle is off; Starred/Questions also hidden when empty; Unsorted always present):

- **STARRED** — chats with `starred:true`.
- **QUESTIONS** — chats awaiting the user's reply (`status:'question'`); rows show a blinking `?` badge. Show a folder breadcrumb on the right.
- **FOLDERS** — header row with a `＋` (new folder) and `⌃` (collapse one level) button. Then the nested folder tree.
- **UNSORTED** — chats with no folder (`folder:null`). This is the always-present catch-all (do not allow disabling in a way that loses access).
- **Archived (N)** — a single row at the very bottom (only if any archived); opens the Archive sub-page.

When filtering: a `N RESULTS` label then the flat matching rows (with snippets).

### Chat row
- Flex row, radius 4, padding 5px 8px, indented by depth (top-level 11px, subfolder child 29px, deeper 47px), 13px text color `#2B2A27`.
- Left status slot (15px): blinking orange `?` badge for `status:'question'` (14px circle, `#d97757`, white `?`, `@keyframes ccblink` opacity 1→0.25→1 over 1.15s) OR a solid 8px `#d97757` dot for `status:'done'`.
- Title (flex, ellipsis).
- Optional folder breadcrumb (in search results & Questions), 10.5px `#B0AB9E`.
- Tag pills (label pills, color @15% bg / full color text, radius 4, 10.5px).
- Relative time, 10.5px `#A8A398`, tabular-nums, min-width 42px, right-aligned (`35m`, `3h`, `1d`, `2w`, `1mo`).
- Star toggle: filled `★` `#d97757` when starred; hollow `☆` `#D6D0C2` otherwise (hover `#d97757`).
- **Active row** (currently open): background `#F6E5DB` + inset 2px left border `#d97757`. This is the ONLY row highlight — starred rows are NOT tinted.
- Hover background `#F0EEE6`.
- Rows are `draggable`.

### Folder row
- Flex row, radius 4, 13px/600 color `#3A3833`. Chevron (`▸`/`▾`), a colored folder-shape SVG (fill = folder color, default `#C2A56E`), name (ellipsis), and a chat count on the right.
- **Click** toggles expand/collapse. **Double-click** enters inline rename (text input, Enter commits, Esc/blur cancels-or-commits). **Right-click** opens a folder color picker (8 swatches).
- Nesting is one level of subfolders under a top folder (tree supports parent→child).
- Top folder count = chats in it + its subfolders.

## Interactions & behavior
- **Open chat:** click a row → sets it active (the extension would reveal that session; here it just highlights).
- **Star:** click the star; starring an archived chat also un-archives it.
- **Drag-and-drop:** drag a chat row onto a folder row to move it into that folder (folder shows a drop highlight: background `#FAE6DC`, inset ring `#d97757`). Drop onto the **UNSORTED** header to clear its folder.
- **Sort:** applies to every list (Newest = ascending age, Oldest = descending, Name = A–Z).
- **Collapse one level (`⌃`):** collapses the deepest currently-open folder level first; repeated clicks fold upward; once all folded, the next click re-expands all.
- **New folder (`＋`):** opens a small "New folder" popover with a name input + Create/Cancel.
- **Rich hover preview:** hovering a chat row for ~0ms shows a floating card (270px) near the cursor with: title, `folder · age · NNk tok`, tag pills, and the first user message + last assistant message (each clamped to 3 lines). A 130ms leave delay + the card being hoverable keeps it up while the pointer travels to it.
- **Right-click a chat → context menu:**
  - TAGS list — click a tag to toggle it on the chat (checkmark shows current).
  - **＋ Create new tag** — switches the menu to a name input + an 8-color swatch picker + Add/Cancel; the new tag is created and applied to the chat.
  - **⤓ Export as Markdown** / **⤓ Export as JSON** — downloads the transcript (`# title` + `**You:**/**Claude:**` lines for MD; `{title,tags,tokens,messages}` for JSON).
  - **🗄 Archive chat** — only shown if the chat is not starred and not already archived. Starred chats instead show a note: "★ Starred chats are kept and never archived."
- **Settings sub-page** (⚙, full-panel overlay with a `‹` back button):
  - **Archiving → Keep chats for:** select 7 days / 14 days / 30 days (default) / 90 days / 1 year / Never. Chats older than this move to Archive automatically. Starred chats are exempt.
  - **Sidebar sections** toggles (all ON by default): Starred, Questions, Folders, Unsorted. Each is a pill switch (on = `#d97757`).
- **Archive sub-page** (full-panel overlay with `‹` back):
  - Its own **Search archived** box with a **gray** focus glow (`#A6A294` ring / `rgba(120,114,102,0.30)` bloom) — deliberately different from the main orange glow.
  - Each archived row: title, `folder · age`, a `⤓` export button, and a **Restore** button (hover fills `#d97757`). Restore returns the chat to its folder/Unsorted.
  - Empty states: "Nothing archived." / "No archived chats match your search."

## State management
Per-session model (`chats[]`): `{ id, title, folder|null, tags:[tagId], starred:bool, mins:int (age), tokens:int, status?:'question'|'done', archived?:bool, messages:[{role:'user'|'assistant', text}] }`.
`folders[]`: `{ id, name, parent|null, color }`. `tags[]`: `{ id, label, color }`.
UI state: `search`, `activeTags[]`, `sort`, `activeId`, `expanded{folderId:bool}`, `dragId`, `dropFolder`, `renamingId`, `hoverId`, section toggles, `archiveAfter`, `archiveSearch`, and the context-menu descriptor. In the real extension, persist `chats/folders/tags` + settings; derive the rest at runtime. Real sessions/titles/timestamps/token counts come from Claude Code's session store rather than the mock array.

## Design tokens
- **Accent (Claude orange):** `#d97757`; hover/pressed `#c6613f`; deep text accent `#C15F3C`.
- **Surfaces:** panel `#FCFBF8`; input `#FBFAF6`; hover row `#F0EEE6`; active row `#F6E5DB`; overlay pages `#FCFBF8`; drop target `#FAE6DC`.
- **Borders/dividers:** `#E6E2D9`, `#E4E0D6`, `#ECE8DF`, `#F1EDE4`.
- **Text:** primary `#2B2A27`; secondary `#8C887E` / `#9A958A`; muted `#A8A398` / `#B0AB9E`; section labels `#AEA99C`.
- **Tag palette (also folder-color choices):** `#d97757, #c6613f, #B14F36, #9A6B1E, #5E7148, #3F7572, #4F6582, #7B5C82`. Default tag mapping used in the mock: bug `#B14F36`, feature `#9A6B1E`, refactor `#5E7148`, research `#4F6582`, idea `#7B5C82`, docs `#3F7572`. Default folder color `#C2A56E`.
- **Radii:** rows/pills/inputs 4–6px; buttons 6–7px; popovers/cards 8–11px.
- **Type:** section labels 10px/600; rows 13px; meta 10.5–11.5px; sub-page titles use **Newsreader** serif 16px/600 (headings only — body stays system UI).
- **Shadows:** popover `0 10px 28px rgba(40,33,20,0.16)`; context menu `0 12px 32px rgba(40,33,20,0.18)`; hover card `0 14px 38px rgba(40,33,20,0.20)`.
- **Animation:** `@keyframes ccblink` (opacity 1→0.25→1, 1.15s) for the question badge; 160ms ease for focus transitions.

## Assets
No image assets — all icons are inline SVG (search, folder shape, archive box, chevrons) or text glyphs (⚙ ⇅ ＋ ⌃ ★ ☆ ‹ × ⤓ 🗄). The folder icon is a simple rounded folder `<path>` filled with the folder's color. In the extension, prefer VS Code Codicons or your own SVGs; keep the colored-folder treatment. The **Newsreader** serif font is loaded from Google Fonts for sub-page headings — substitute any available serif if offline.

## Files in this bundle
- `ChatSidebar.html` — self-contained, offline-ready build of the sidebar (open in any browser; React is embedded, no network needed). This is the definitive visual + behavioral reference.
- `ChatSidebar.dc.html` — the authoring source (template + logic class) for the same sidebar.
- Ignore anything related to a "chat window", "context-health bar", "Compact", token strip, transcript, or composer — those belong to the removed editor pane and are **out of scope** for this handoff.
