// The ProjectMeta document schema for Claude Code Nest, plus the per-project
// globalState key encoding and the schema-version migration entry point.
//
// This module is PURE DATA and pure logic: no vscode import, no filesystem. It
// defines the self-contained ProjectMeta shape that is stored once per project
// under the synced globalState key `nest.meta.v1::<projectKey>`, the Folder,
// Tag, ChatMeta, and Link sub-shapes, and the migration that lifts an older
// stored document to the current schemaVersion.
//
// Sync boundary (ARCHITECTURE.md): the synced document carries folders, tags,
// chat folder/tags/links, and the updatedAt + deviceId stamps. Orphan-reconcile
// state (missingSince, archived, tombstone) is LOCAL ONLY and must never be
// synced. It is therefore modeled on a SEPARATE local document (LocalProjectMeta
// below), not on the synced ProjectMeta, so a synced write can never carry it.

// The current schema version. Bump when the stored shape changes and add a step
// to migrateProjectMeta.
export const SCHEMA_VERSION = 1;

// The synced-key prefix and separator. The full per-project key is
// `nest.meta.v1::<projectKey>`. The prefix is versioned so a future incompatible
// store layout can move to nest.meta.v2 without colliding.
export const META_KEY_PREFIX = 'nest.meta.v1';
export const META_KEY_SEPARATOR = '::';

// Build the synced globalState key for a project key (the encoded directory name
// from projectKeyResolver, e.g. c--Users-JakeMismas-Documents-Claude-Code---Nest).
export function metaKeyFor(projectKey: string): string {
  return META_KEY_PREFIX + META_KEY_SEPARATOR + projectKey;
}

// True when a globalState key is one of our per-project meta keys. Used to
// rebuild the full setKeysForSync union from the Memento's known keys.
export function isMetaKey(key: string): boolean {
  return key.startsWith(META_KEY_PREFIX + META_KEY_SEPARATOR);
}

// Recover the project key from a full meta key. Returns null when the key is not
// one of ours.
export function projectKeyFromMetaKey(metaKey: string): string | null {
  if (!isMetaKey(metaKey)) {
    return null;
  }
  return metaKey.slice((META_KEY_PREFIX + META_KEY_SEPARATOR).length);
}

// A single folder in the single-home hierarchy. parentId is null for a top-level
// folder. order is a sort hint among siblings. color is an optional per-folder
// curation scalar (a synced LWW field arbitrated by the project document's
// updatedAt, like the rest of the folder record); absent when the user has not
// set a color.
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  color?: string;
}

// A single tag. Stored once and referenced by id from a chat's tags array.
export interface Tag {
  id: string;
  label: string;
  color?: string;
}

// A link from one chat to another. kind distinguishes a parent link (renders the
// target nested beneath this chat in the Folders tree) from a plain related
// link. targetChatId is the linked chat's sessionId.
export interface Link {
  targetChatId: string;
  kind: 'parent' | 'related';
}

// The SYNCED per-chat metadata. folderId is the chat's single home folder (null
// when unfiled). tags references Tag ids. links are this chat's outbound links.
// updatedAt + deviceId are the per-record stamps used for last-writer-wins
// reconcile. This shape carries NO orphan state; that lives in LocalChatState.
//
// starred, userArchived, and archivedAt are optional curation scalars (Slice 3).
// They are SYNCED and arbitrated by the single per-record updatedAt stamp (there
// is no per-scalar stamp). archivedAt travels COUPLED to userArchived: when the
// LWW arbitration takes one side's archive state it takes that side's archivedAt
// with it, so the timestamp never desynchronizes from the flag. userArchived is
// the LOCAL user's archive decision and is distinct from the local-only
// orphan-reconcile archive in LocalChatState (that one is missing-on-disk driven,
// non-synced); userArchived is a deliberate, synced curation choice.
export interface ChatMeta {
  folderId: string | null;
  tags: string[];
  links: Link[];
  updatedAt: number;
  deviceId: string;
  starred?: boolean;
  userArchived?: boolean;
  archivedAt?: number;
}

// The SYNCED, self-contained per-project document stored under the meta key.
// Per ARCHITECTURE.md this is the unit of Settings Sync: an opaque value that a
// foreign device can wholesale-replace, so it is kept self-contained and free of
// any local-only orphan state.
export interface ProjectMeta {
  schemaVersion: number;
  folders: { [folderId: string]: Folder };
  tags: { [tagId: string]: Tag };
  chats: { [chatId: string]: ChatMeta };
  updatedAt: number;
  deviceId: string;
  // Forward-compatibility carrier. When a NEWER extension wrote this document
  // (schemaVersion > our SCHEMA_VERSION), any top-level fields this build does
  // not understand are stashed here verbatim by migrateProjectMeta and replayed
  // on write, so mutating a newer-schema document does not silently strip the
  // newer machine's richer data and clobber it on the next sync. Absent for
  // same- or older-version documents. Not part of the logical schema; it is a
  // pass-through escrow and carries no extension behavior.
  __unknown?: { [k: string]: unknown };
}

// The LOCAL-ONLY orphan-reconcile state for one chat. Never synced. missingSince
// is the epoch ms when a reconcile pass first failed to observe the chat on
// disk; archived flips true after the grace window; tombstone marks a
// user-gated, reversible permanent removal. Kept on a separate document so it can
// never ride along in a synced ProjectMeta write.
export interface LocalChatState {
  missingSince: number | null;
  archived: boolean;
  tombstone: boolean;
}

// The LOCAL-ONLY companion document for a project, holding the orphan state keyed
// by chatId. Stored under a non-synced key (see metadataStore.localKeyFor) so it
// is excluded from setKeysForSync.
export interface LocalProjectMeta {
  schemaVersion: number;
  chats: { [chatId: string]: LocalChatState };
}

// The only color shape this schema accepts: a 6-digit hex triplet (#rrggbb),
// the exact form the native color picker emits. A folder color travels in a
// SYNCED, importable library document, so it is attacker-influenceable; it later
// reaches a CSS sink in the webview (background: var(--chip-color)) where a value
// like url(https://evil/x) would become an exfiltration beacon. The strict
// pattern admits nothing but a hex color, so no CSS token can ride through. A
// 3-digit (#fff) or named (red) value is intentionally rejected: the picker never
// emits them, so dropping them costs nothing and keeps the rule simple. Shared
// with the webview host's coerce() so both boundaries enforce one rule.
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// True when a value is a string in the strict #rrggbb color shape. Used at the
// normalize boundary (and the webview host) to drop any other color verbatim.
export function isValidColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_PATTERN.test(value);
}

// The allowed shape of a record id (folder id, tag id, chat id): one to 64
// characters from the URL-safe alphabet. Note this pattern ALONE still admits the
// bare Object.prototype member names (constructor, prototype, toString, valueOf,
// hasOwnProperty); isSafeRecordId rejects those separately because they are the
// actual hazard at the downstream bare-object resolve sites.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Object.prototype member names that pass ID_PATTERN but resolve to an INHERITED
// value at a bare-object index (e.g. meta.folders['constructor'] returns the
// Object constructor, not undefined). The resolve sites (rollup/tokenRollup.ts,
// views/orgPanelModel.ts, views/chatMeta.ts) index the folders/tags maps with a
// stored id and treat a non-undefined hit as a real record, so one of these ids
// surviving normalize produces a phantom "Object" folder/tag label and mis-files
// the chat. A minted id is a UUID/prefixed-hex (idFactory.ts) and is never one of
// these, so rejecting them at the normalize boundary drops only untrusted garbage.
const PROTOTYPE_RECORD_IDS = new Set<string>([
  'constructor',
  'prototype',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

// True when a value is a string in the allowed record-id shape AND is not an
// Object.prototype member name. Used at the normalize boundary to drop a folder
// reference or tag id an untrusted imported document carries in a malformed or
// prototype-confusing form. Exported because the SAME rule must gate the MAP KEYS
// (not just the references) here, the merge-side keys in exportImport.ts, and the
// archive body-file sessionId in archiveBodyStore.ts: an untrusted map key like
// '../../../x' otherwise reaches a filesystem path sink (Uri.joinPath collapses
// '..' and escapes globalStorage), and a prototype-name key survives as a phantom
// own-record. Confining every boundary to this one predicate is the primary fix.
export function isSafeRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ID_PATTERN.test(value) &&
    !PROTOTYPE_RECORD_IDS.has(value)
  );
}

// A fresh, empty synced document for a project. updatedAt + deviceId are stamped
// by the caller at write time; an empty document records the supplied stamp.
export function emptyProjectMeta(deviceId: string, now: number): ProjectMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    folders: {},
    tags: {},
    chats: {},
    updatedAt: now,
    deviceId,
  };
}

// A fresh, empty local companion document for a project.
export function emptyLocalProjectMeta(): LocalProjectMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    chats: {},
  };
}

// Lift a stored value (of unknown or older shape) to the current ProjectMeta
// schema. Defensive: a value read back from globalState may be undefined (never
// written), partially shaped (older version), or corrupt (a foreign-device write
// of a different layout). It always returns a well-formed ProjectMeta at
// SCHEMA_VERSION; unknown fields are dropped and missing fields are defaulted.
//
// deviceId + now supply the stamp for a document that has none (an
// upgrade-in-place of a stamp-less older value).
export function migrateProjectMeta(
  raw: unknown,
  deviceId: string,
  now: number,
): ProjectMeta {
  if (!isObject(raw)) {
    return emptyProjectMeta(deviceId, now);
  }
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;

  // Future migration steps slot in here, each lifting version N to N+1 before
  // the normalize pass. For schemaVersion 0 (a pre-versioned or unversioned
  // document) the normalize pass below is sufficient; it tolerates a missing
  // schemaVersion and defaults every field.
  if (version > SCHEMA_VERSION) {
    // A value written by a NEWER extension than this one. Normalizing alone
    // would DROP every top-level field this build does not understand and
    // re-stamp the document to our (older) SCHEMA_VERSION; a later mutation
    // would then persist and re-sync that lossy shape, wholesale-replacing the
    // newer machine's richer document under the per-key, opaque-value,
    // no-field-merge sync model. To avoid that cross-machine data loss we keep
    // the document at its ORIGINAL (newer) schemaVersion and stash every unknown
    // top-level field verbatim in __unknown, so a write replays them and the
    // foreign machine's data survives a round-trip through this older build.
    const meta = normalizeProjectMeta(raw, deviceId, now);
    meta.schemaVersion = version;
    const unknown = collectUnknownTopLevel(raw);
    if (unknown !== null) {
      meta.__unknown = unknown;
    }
    return meta;
  }
  return normalizeProjectMeta(raw, deviceId, now);
}

// The set of top-level keys this schema understands. Any other top-level field
// on a forward-version document is escrowed in __unknown and replayed on write.
const KNOWN_TOP_LEVEL = new Set<string>([
  'schemaVersion',
  'folders',
  'tags',
  'chats',
  'updatedAt',
  'deviceId',
  '__unknown',
]);

// Gather every top-level field NOT in the known set, preserving its value
// verbatim (deep-copied so the escrow never aliases the stored value). Returns
// null when there is nothing unknown to preserve.
function collectUnknownTopLevel(
  raw: { [k: string]: unknown },
): { [k: string]: unknown } | null {
  let result: { [k: string]: unknown } | null = null;
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      if (result === null) {
        result = {};
      }
      result[key] = JSON.parse(JSON.stringify(value));
    }
  }
  return result;
}

// Coerce a loosely-shaped object into a strict ProjectMeta, dropping unknown
// fields and defaulting missing ones. Pure and total.
function normalizeProjectMeta(
  raw: { [k: string]: unknown },
  deviceId: string,
  now: number,
): ProjectMeta {
  // Build the three id-keyed maps with a NULL prototype (defense in depth): a bare
  // {} inherits Object.prototype, so an attacker map KEY like 'constructor' or
  // '__proto__' would resolve to an inherited value at a downstream bare-object
  // index even if it never became an own key. A null-proto map has no inherited
  // members, so a non-own index is always undefined. The key validation below is
  // the PRIMARY fix; this prototype hygiene is the backstop. The maps still
  // serialize as plain JSON objects on a synced/exported write.
  //
  // EVERY map KEY is now gated by isSafeRecordId, not just the references inside a
  // record. The map key is the id an attacker-authored import or a foreign-device
  // synced document re-keys a record under, and a chat's key flows verbatim to the
  // archive body-file path sink (archiveBodyStore.bodyFileUri). A key like
  // '../../../../Users/victim/evil' or a prototype name is DROPPED here (the whole
  // entry), so it can never reach that sink or produce a phantom record. A
  // legitimate id (a UUID session id, a minted folder/tag id) passes unchanged, so
  // no real record is lost.
  const folders: { [id: string]: Folder } = Object.create(null) as { [id: string]: Folder };
  if (isObject(raw.folders)) {
    for (const [id, value] of Object.entries(raw.folders)) {
      if (!isSafeRecordId(id)) {
        continue;
      }
      const folder = normalizeFolder(id, value);
      if (folder !== null) {
        folders[id] = folder;
      }
    }
  }

  const tags: { [id: string]: Tag } = Object.create(null) as { [id: string]: Tag };
  if (isObject(raw.tags)) {
    for (const [id, value] of Object.entries(raw.tags)) {
      if (!isSafeRecordId(id)) {
        continue;
      }
      const tag = normalizeTag(id, value);
      if (tag !== null) {
        tags[id] = tag;
      }
    }
  }

  const chats: { [id: string]: ChatMeta } = Object.create(null) as { [id: string]: ChatMeta };
  if (isObject(raw.chats)) {
    for (const [id, value] of Object.entries(raw.chats)) {
      if (!isSafeRecordId(id)) {
        continue;
      }
      const chat = normalizeChat(value, deviceId, now);
      if (chat !== null) {
        chats[id] = chat;
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    folders,
    tags,
    chats,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : deviceId,
  };
}

function normalizeFolder(id: string, value: unknown): Folder | null {
  if (!isObject(value)) {
    return null;
  }
  const name = typeof value.name === 'string' ? value.name : null;
  if (name === null) {
    return null;
  }
  const folder: Folder = {
    id,
    name,
    parentId: typeof value.parentId === 'string' ? value.parentId : null,
    order: typeof value.order === 'number' ? value.order : 0,
  };
  // color is an optional curation scalar: carry it through when present so it is
  // not stripped on every read/migrate, default-absent otherwise. Validate it
  // against the strict #rrggbb shape (isValidColor); a value that is not a hex
  // color is DROPPED here so an untrusted imported library document cannot smuggle
  // a CSS token (e.g. url(...)) through to the webview's --chip-color sink.
  if (isValidColor(value.color)) {
    folder.color = value.color;
  }
  return folder;
}

function normalizeTag(id: string, value: unknown): Tag | null {
  if (!isObject(value)) {
    return null;
  }
  const label = typeof value.label === 'string' ? value.label : null;
  if (label === null) {
    return null;
  }
  const tag: Tag = { id, label };
  // color is an optional curation scalar: carry it through when present so it is
  // not stripped on every read/migrate, default-absent otherwise. Validate it
  // against the strict #rrggbb shape (isValidColor); a value that is not a hex
  // color is DROPPED here so an untrusted imported library document cannot smuggle
  // a CSS token (e.g. url(...)) through to the webview's --chip-color sink. A tag
  // color reaches the SAME --chip-color CSS sink as a folder color (buildTagChips
  // -> media/orgPanel.js), and tag color has no postMessage setter, so this is the
  // sole boundary; it mirrors normalizeFolder exactly.
  if (isValidColor(value.color)) {
    tag.color = value.color;
  }
  return tag;
}

function normalizeChat(
  value: unknown,
  deviceId: string,
  now: number,
): ChatMeta | null {
  if (!isObject(value)) {
    return null;
  }
  // Tag ids are references into the tags map; keep only the ones in the safe
  // record-id shape so a malformed or prototype-name entry from an untrusted
  // imported document cannot ride through and confuse a downstream lookup.
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((t): t is string => isSafeRecordId(t))
    : [];
  const links = Array.isArray(value.links)
    ? value.links.map(normalizeLink).filter((l): l is Link => l !== null)
    : [];
  const chat: ChatMeta = {
    // folderId is a reference into the folders map; an unfiled chat is null.
    // Validate the format the same way: drop a malformed or prototype-name
    // folderId to null rather than carry it into a downstream folder lookup.
    folderId: isSafeRecordId(value.folderId) ? value.folderId : null,
    tags,
    links,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : deviceId,
  };
  // Optional curation scalars (Slice 3): carry them through when present so they
  // are not stripped on every read/migrate. archivedAt is carried independently
  // of userArchived here (a defensive normalize must not drop a stored field);
  // the LWW merge is what keeps the pair coupled on arbitration.
  if (typeof value.starred === 'boolean') {
    chat.starred = value.starred;
  }
  if (typeof value.userArchived === 'boolean') {
    chat.userArchived = value.userArchived;
  }
  if (typeof value.archivedAt === 'number') {
    chat.archivedAt = value.archivedAt;
  }
  return chat;
}

function normalizeLink(value: unknown): Link | null {
  if (!isObject(value)) {
    return null;
  }
  const targetChatId =
    typeof value.targetChatId === 'string' ? value.targetChatId : null;
  if (targetChatId === null) {
    return null;
  }
  const kind = value.kind === 'parent' ? 'parent' : 'related';
  return { targetChatId, kind };
}

function isObject(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
