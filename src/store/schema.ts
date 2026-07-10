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
// restoredAt is the third member of the archive group: the epoch ms of the user's
// last DELIBERATE restore (unarchive). It exists so automation can tell a restored
// chat apart from one that merely aged past the auto-archive window: the policy
// treats restoredAt as activity for the archive decision, so a restore is not
// silently re-archived on the next pass. It travels COUPLED to the archive pair
// (the side that supplies userArchived supplies both timestamps): archiving sets
// archivedAt and clears restoredAt; unarchiving clears archivedAt and stamps
// restoredAt.
export interface ChatMeta {
  folderId: string | null;
  tags: string[];
  links: Link[];
  updatedAt: number;
  deviceId: string;
  starred?: boolean;
  userArchived?: boolean;
  archivedAt?: number;
  restoredAt?: number;
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

// The single shared length cap for user-supplied FREE-TEXT persisted to the
// SYNCED store (folder names, tag labels). The synced document lives under one
// Settings Sync item per project, and Settings Sync enforces per-item size
// limits, so one unbounded string (a giant paste into a rename box, or a
// tampered webview message) could silently break sync of the entire curation
// store across devices. The cap closes the class at BOTH boundaries: the
// normalize ingest path (import / sync-merge) truncates here, and the store's
// upsertFolder/upsertTag write sinks truncate with the same constant, covering
// the webview handlers and the native input-box command paths alike. 200 chars
// is far beyond any legible name and keeps the worst-case document small.
export const MAX_NAME_LENGTH = 200;

// Truncate a free-text field to the shared cap. Exported so every boundary
// (normalize, store sinks, webview coerce) applies the identical rule.
export function clampName(value: string): string {
  return value.length > MAX_NAME_LENGTH ? value.slice(0, MAX_NAME_LENGTH) : value;
}

// The maximum accepted length of a deviceId carried on a stored or imported
// document. A legitimate id is a UUID (36 chars), the dev-<hex> fallback
// (~40 chars), or vscode.env.machineId (64 hex chars); 128 covers them all with
// headroom. The stamp travels in the SYNCED document and an imported library
// file supplies it verbatim, so an unbounded value is the same
// break-Settings-Sync payload the MAX_NAME_LENGTH rationale describes.
// TRUNCATED (not dropped) so LWW self/foreign classification still sees a
// stable, non-empty foreign id; a clamped foreign id can never collide with
// this install's own (always-legal-length) id.
export const MAX_DEVICE_ID_LENGTH = 128;

// Truncate a deviceId stamp to the shared cap. Applied at the normalize
// boundary for both the project-level and per-chat stamps.
export function clampDeviceId(value: string): string {
  return value.length > MAX_DEVICE_ID_LENGTH
    ? value.slice(0, MAX_DEVICE_ID_LENGTH)
    : value;
}

// The maximum number of records accepted in EACH of the three id-keyed
// collections (folders, tags, chats) of one project document. Every record key
// is a valid 1-64-char id, so the free-text/deviceId/escrow caps above do not
// bound the RECORD COUNT dimension: a hostile imported library file (or a
// crafted foreign synced value) could otherwise carry millions of
// charset-valid entries in one project and persist a multi-megabyte document
// under the project's single synced globalState key, the exact
// break-Settings-Sync payload the other caps exist to prevent. Enforced at the
// normalize boundary so BOTH ingest paths (import migration and stored/synced
// read-back) are covered. A decade of heavy daily use tops out at a few
// thousand chats per project; 10000 admits every organic library with a wide
// margin, so truncation only ever drops crafted junk.
export const MAX_COLLECTION_RECORDS = 10000;

// The maximum number of tag references on ONE chat. Tag ids are 1-64 chars
// each, so an unbounded per-chat array is the same uncapped-size sink as the
// record-count dimension above, just one level down. No legible curation has
// more than a few dozen tags on a chat; 100 is far beyond organic use.
export const MAX_CHAT_TAGS = 100;

// The maximum number of links on ONE chat, same rationale as MAX_CHAT_TAGS
// (each link carries a 1-64-char target id plus a kind).
export const MAX_CHAT_LINKS = 200;

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

// The maximum accepted length of a PROJECT key. A legitimate key is a
// ~/.claude/projects directory name produced by encodeProjectKey, and a
// filesystem name component caps at 255 bytes on every platform Claude Code
// runs on, so 256 admits every real key with headroom.
export const MAX_PROJECT_KEY_LENGTH = 256;

// The allowed shape of a project key: the exact output alphabet of
// encodeProjectKey (projectKeyResolver.ts replaces every character outside
// [A-Za-z0-9-] with a hyphen), bounded to MAX_PROJECT_KEY_LENGTH. Underscore is
// deliberately NOT admitted (the encoder never emits it), which also excludes
// '__proto__' structurally.
const PROJECT_KEY_PATTERN = /^[A-Za-z0-9-]{1,256}$/;

// True when a value is a string in the allowed PROJECT-key shape and is not an
// Object.prototype member name. A project key from an untrusted import
// envelope is minted VERBATIM into a synced globalState key
// (metaKeyFor -> 'nest.meta.v1::<key>') and registered with setKeysForSync,
// and the store has no key-removal path, so an unbounded or junk key would
// durably pollute the SYNCED surface across every machine on the profile.
// This is the record-id discipline (isSafeRecordId) applied at the envelope
// level: the same rule gates the import boundary (schemaMigrate.
// validateEnvelope) and the store's write sink (metadataStore.mutate), so a
// hostile key is rejected before it can mint a synced key at EITHER boundary.
// The prototype-name exclusion is defense in depth for any bare-object map
// keyed by projectKey ('constructor' passes the charset); no real path ever
// encodes to one of those names.
export function isSafeProjectKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PROJECT_KEY_PATTERN.test(value) &&
    !PROTOTYPE_RECORD_IDS.has(value)
  );
}

// Defense-in-depth backstop for the write path. A JSON.parse(JSON.stringify(...))
// clone re-attaches Object.prototype to the folders/tags/chats maps, voiding the
// null-prototype hygiene normalizeProjectMeta builds in. This rebuilds those three
// maps as Object.create(null) in place on a freshly-cloned document, copying only
// own enumerable entries, so a non-own index (a prototype-name key that slipped a
// gate) resolves to undefined instead of an inherited Object member, and a write
// through one of those maps can never reach Object.prototype. The maps still
// serialize as plain JSON objects, so a synced/exported write is unchanged.
// Mutates and returns the supplied document (callers pass their own fresh clone).
export function nullProtoMaps(meta: ProjectMeta): ProjectMeta {
  meta.folders = rebuildNullProto(meta.folders);
  meta.tags = rebuildNullProto(meta.tags);
  meta.chats = rebuildNullProto(meta.chats);
  return meta;
}

function rebuildNullProto<T>(source: { [k: string]: T }): { [k: string]: T } {
  const out: { [k: string]: T } = Object.create(null) as { [k: string]: T };
  if (source) {
    for (const key of Object.keys(source)) {
      out[key] = source[key];
    }
  }
  return out;
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

// The maximum TOTAL serialized size (in JSON characters, keys included) of the
// __unknown escrow. The escrow exists to protect a NEWER build's few extra
// top-level fields across a round-trip through this build; it is replayed on
// EVERY write of the synced document, so an unbounded escrow is the exact
// break-Settings-Sync payload the MAX_NAME_LENGTH rationale describes, and an
// attacker-authored import claiming schemaVersion 999 could otherwise carry an
// arbitrarily large blob straight onto the synced surface. 64K is orders of
// magnitude beyond any plausible legitimate forward-schema delta while staying
// far under the per-item sync limits.
export const MAX_UNKNOWN_ESCROW_LENGTH = 64 * 1024;

// Gather every top-level field NOT in the known set, preserving its value
// verbatim (deep-copied so the escrow never aliases the stored value) UP TO the
// shared escrow size budget: a field whose serialized size (key + value) would
// push the total past MAX_UNKNOWN_ESCROW_LENGTH is dropped, and the smaller
// fields around it are kept, so a single oversized (hostile or pathological)
// field cannot ride the escrow onto the synced surface or take the legitimate
// small fields down with it. Returns null when there is nothing to preserve.
// Entries are added with Object.defineProperty (not assignment) so an unknown
// field literally named '__proto__' (JSON.parse creates it as an OWN key on the
// source) becomes an own entry here too instead of silently rebinding the
// result map's prototype; the map keeps a normal prototype so it compares and
// serializes as a plain JSON object.
function collectUnknownTopLevel(
  raw: { [k: string]: unknown },
): { [k: string]: unknown } | null {
  let result: { [k: string]: unknown } | null = null;
  let budget = MAX_UNKNOWN_ESCROW_LENGTH;
  const add = (key: string, value: unknown): void => {
    const json = JSON.stringify(value);
    if (json === undefined) {
      // Not JSON-serializable (undefined/function/symbol): it could never
      // survive the synced write anyway; skip rather than throw in the parse.
      return;
    }
    const cost = key.length + json.length;
    if (cost > budget) {
      return;
    }
    budget -= cost;
    if (result === null) {
      result = {};
    }
    Object.defineProperty(result, key, {
      value: JSON.parse(json),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      add(key, value);
    }
  }
  // A document that already round-tripped through this build carries its escrow
  // NESTED under __unknown (the write path persists the ProjectMeta as-is; it
  // does not expand the escrow back to top level). '__unknown' is in the known
  // set, so without folding its entries back in here the escrow would survive
  // exactly ONE write and the newer machine's fields would be silently lost on
  // the second read, defeating the escrow's whole purpose. Direct top-level
  // fields win over a previously-escrowed entry of the same name (they are the
  // newer build's live values); both share the one size budget.
  if (isObject(raw.__unknown)) {
    for (const [key, value] of Object.entries(raw.__unknown)) {
      if (
        !KNOWN_TOP_LEVEL.has(key) &&
        (result === null || !Object.prototype.hasOwnProperty.call(result, key))
      ) {
        add(key, value);
      }
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
  //
  // EVERY map is also COUNT-capped at MAX_COLLECTION_RECORDS (see its comment):
  // key-charset validity alone does not bound the record-count dimension, and an
  // uncapped collection is the same break-Settings-Sync payload as an uncapped
  // string. Entries past the cap are dropped in iteration order; an organic
  // library never comes near the cap, so only crafted junk is truncated.
  const folders: { [id: string]: Folder } = Object.create(null) as { [id: string]: Folder };
  let folderCount = 0;
  if (isObject(raw.folders)) {
    for (const [id, value] of Object.entries(raw.folders)) {
      if (folderCount >= MAX_COLLECTION_RECORDS) {
        break;
      }
      if (!isSafeRecordId(id)) {
        continue;
      }
      const folder = normalizeFolder(id, value);
      if (folder !== null) {
        folders[id] = folder;
        folderCount++;
      }
    }
  }

  const tags: { [id: string]: Tag } = Object.create(null) as { [id: string]: Tag };
  let tagCount = 0;
  if (isObject(raw.tags)) {
    for (const [id, value] of Object.entries(raw.tags)) {
      if (tagCount >= MAX_COLLECTION_RECORDS) {
        break;
      }
      if (!isSafeRecordId(id)) {
        continue;
      }
      const tag = normalizeTag(id, value);
      if (tag !== null) {
        tags[id] = tag;
        tagCount++;
      }
    }
  }

  const chats: { [id: string]: ChatMeta } = Object.create(null) as { [id: string]: ChatMeta };
  let chatCount = 0;
  if (isObject(raw.chats)) {
    for (const [id, value] of Object.entries(raw.chats)) {
      if (chatCount >= MAX_COLLECTION_RECORDS) {
        break;
      }
      if (!isSafeRecordId(id)) {
        continue;
      }
      const chat = normalizeChat(value, deviceId, now);
      if (chat !== null) {
        chats[id] = chat;
        chatCount++;
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    folders,
    tags,
    chats,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    // Clamp the stamp (see MAX_DEVICE_ID_LENGTH): an imported document supplies
    // it verbatim and it persists on the synced surface.
    deviceId:
      typeof raw.deviceId === 'string' ? clampDeviceId(raw.deviceId) : deviceId,
  };
}

function normalizeFolder(id: string, value: unknown): Folder | null {
  if (!isObject(value)) {
    return null;
  }
  // Truncate to the shared free-text cap (MAX_NAME_LENGTH) rather than dropping
  // the record: a foreign/imported document with an over-long name keeps its
  // folder, but the oversized payload never re-enters the synced store.
  const name = typeof value.name === 'string' ? clampName(value.name) : null;
  if (name === null) {
    return null;
  }
  const folder: Folder = {
    id,
    name,
    // parentId is a REFERENCE into the folders map, exactly like a chat's
    // folderId: gate it with the same record-id rule so a malformed,
    // prototype-name, or unbounded parent reference from an untrusted imported
    // document is dropped to null (top-level) instead of persisting on the
    // synced surface and reaching a downstream bare-object folder lookup.
    parentId: isSafeRecordId(value.parentId) ? value.parentId : null,
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
  // Truncated to the shared free-text cap, mirroring normalizeFolder (see there).
  const label = typeof value.label === 'string' ? clampName(value.label) : null;
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
  // Both per-chat arrays are LENGTH-capped (MAX_CHAT_TAGS / MAX_CHAT_LINKS):
  // each surviving entry is a valid id, so without the cap an untrusted
  // document could still carry an unbounded array per chat onto the synced
  // surface (the uncapped-size class, one level below the record-count cap).
  const tags = Array.isArray(value.tags)
    ? value.tags
        .filter((t): t is string => isSafeRecordId(t))
        .slice(0, MAX_CHAT_TAGS)
    : [];
  const links = Array.isArray(value.links)
    ? value.links
        .map(normalizeLink)
        .filter((l): l is Link => l !== null)
        .slice(0, MAX_CHAT_LINKS)
    : [];
  const chat: ChatMeta = {
    // folderId is a reference into the folders map; an unfiled chat is null.
    // Validate the format the same way: drop a malformed or prototype-name
    // folderId to null rather than carry it into a downstream folder lookup.
    folderId: isSafeRecordId(value.folderId) ? value.folderId : null,
    tags,
    links,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    // Clamped for the same reason as the project-level stamp (see
    // MAX_DEVICE_ID_LENGTH): the per-record stamp is synced and import-supplied.
    deviceId:
      typeof value.deviceId === 'string' ? clampDeviceId(value.deviceId) : deviceId,
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
  // restoredAt: the deliberate-restore stamp the auto-archive policy treats as
  // activity. Carried like the other optional curation scalars so a defensive
  // normalize never strips a stored restore intent.
  if (typeof value.restoredAt === 'number') {
    chat.restoredAt = value.restoredAt;
  }
  return chat;
}

function normalizeLink(value: unknown): Link | null {
  if (!isObject(value)) {
    return null;
  }
  // targetChatId is a REFERENCE into the chats map; the store's addLink sink
  // already gates it with isSafeRecordId, so the normalize boundary must apply
  // the identical rule (one rule at both boundaries, like names and colors). A
  // malformed, prototype-name, or unbounded target drops the link.
  if (!isSafeRecordId(value.targetChatId)) {
    return null;
  }
  const kind = value.kind === 'parent' ? 'parent' : 'related';
  return { targetChatId: value.targetChatId, kind };
}

function isObject(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
