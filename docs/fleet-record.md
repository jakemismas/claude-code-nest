# Fleet record

The fleet record is a JSON Lines file that an orchestrator writes and Nest reads. Nest
never writes, renames or deletes it. Nest reads `dev/fleet.jsonl` in each workspace
folder, in each linked folder, and in every path listed under `fleet.files` in
`.nest/config.json`.

Each line is one JSON object. Append a line when something happens. Nest folds the
lines in time order into one entry per session.

## Rules for every line

- Set `"v": 1`. A line with any other version is ignored.
- Set `event` to one of `launch`, `rename`, `rotate`, `end`, `backfill` or `organize`.
  An unknown event is ignored.
- Set `sessionId` to the chat's session id. It must match `^[0-9a-fA-F-]{8,64}$`, or
  the line is ignored.
- Set `at` to an ISO 8601 timestamp. A line with a missing or invalid value takes the time of the line before it.
- Unknown fields and unknown `role` values are ignored.
- Nest strips control characters from every string. Names and folders are capped at 200
  characters, tags at 40 characters (20 tags at most), paths at 1024 characters, and
  other strings at 200 characters.
- Nest skips a file over 8 MB and drops a line over 16 KB. A missing or unreadable file
  contributes nothing.

## Fields

| Field | Used by | Description |
| --- | --- | --- |
| `v` | all | Record version. Always `1`. |
| `event` | all | The event name. |
| `at` | all | When the event happened. |
| `sessionId` | all | The session the event is about. |
| `agent` | launch, backfill | Short agent name, shown as a tag on the row. |
| `name` | launch, backfill, rename | Display name of the chat. |
| `client` | launch, backfill | A label for the project the chat serves. |
| `ticket` | launch, backfill | Ticket or work item key. Use `null` for none. |
| `role` | launch, backfill | One of `orchestrator`, `build`, `fix`, `qa`, `spike`, `capture`, `review`, `intake`, `draft`. |
| `launchedBy` | launch, backfill | The session id of the launching chat, or a short marker such as `user`. |
| `cwd` | launch, backfill | Working directory of the session. |
| `previous`, `next` | rotate | Session ids of the retiring and the replacement orchestrator. Each must be a valid session id. |
| `folder` | organize | Folder name to group the chat under. One slash makes a sublevel. |
| `tags` | organize | Tag names for the chat. |
| `stage` | organize | The ticket's current stage, shown as a pill. |
| `outcome` | end | `done` or `failed`. |

## Events

The session ids below are made up.

### launch

A session starts. Creates the entry.

```json
{"v":1,"event":"launch","at":"2026-03-02T09:00:00Z","sessionId":"aaaa1111-0000-4000-8000-000000000001","agent":"planner","name":"Plan storefront search","ticket":"PROJ-101","role":"orchestrator","cwd":"/home/dev/shop","launchedBy":"user"}
```

### rename

Changes the display name of an existing entry. A `rename`, `organize` or `end` line for a session with no earlier `launch` or `backfill` is ignored.

```json
{"v":1,"event":"rename","at":"2026-03-02T09:05:00Z","sessionId":"aaaa1111-0000-4000-8000-000000000001","name":"Plan storefront search v2"}
```

### rotate

An orchestrator hands off to a fresh one. Write a `launch` line for the new orchestrator too, with `role` set to `orchestrator`. The newest orchestrator that no `rotate`
record names as `previous`, and that has not ended, is the current orchestrator. The
others are past, newest first.

```json
{"v":1,"event":"rotate","at":"2026-03-02T12:00:00Z","sessionId":"aaaa1111-0000-4000-8000-000000000002","previous":"aaaa1111-0000-4000-8000-000000000001","next":"aaaa1111-0000-4000-8000-000000000002"}
```

### end

A session finished. Nest shows it as done, or as failed when `outcome` is `failed`.

```json
{"v":1,"event":"end","at":"2026-03-02T13:30:00Z","sessionId":"bbbb2222-0000-4000-8000-000000000003","outcome":"done"}
```

### backfill

Records a session that already existed. It creates an entry like `launch`, but Nest
never treats it as a new pickup, so history never replays as a robin reaction.

```json
{"v":1,"event":"backfill","at":"2026-02-20T08:00:00Z","sessionId":"cccc3333-0000-4000-8000-000000000004","agent":"builder","name":"Add cart badge","ticket":"PROJ-099","role":"build","cwd":"/home/dev/shop/web"}
```

### organize

Places a chat in a virtual group and sets its stage. It changes only what the panel
shows and writes nothing to your folders.

```json
{"v":1,"event":"organize","at":"2026-03-02T10:00:00Z","sessionId":"bbbb2222-0000-4000-8000-000000000003","folder":"Storefront/Search","tags":["search"],"stage":"In review"}
```

## Write against it

1. Append one line per event. Never rewrite earlier lines.
2. Write each line in a single write so a reader never sees half a line.
3. Keep the file in `dev/fleet.jsonl`, or list its path under `fleet.files` in
   `.nest/config.json`.
