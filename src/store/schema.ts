// The ProjectMeta document schema, per-project globalState key encoding and migration entry point.
// Pure: no vscode import, no filesystem. Orphan-reconcile state (missingSince, archived,
// tombstone) is local only, so it lives on LocalProjectMeta and a synced write cannot carry it.

// The current schema version. Bump when the stored shape changes and add a step
// to migrateProjectMeta.
export const SCHEMA_VERSION = 1;

// The prefix is versioned so a future incompatible layout can move to nest.meta.v2.
export const META_KEY_PREFIX = 'nest.meta.v1';
export const META_KEY_SEPARATOR = '::';

// Builds the synced globalState key from an encoded project directory name.
export function metaKeyFor(projectKey: string): string {
  return META_KEY_PREFIX + META_KEY_SEPARATOR + projectKey;
}

// True when a globalState key is a per-project meta key.
export function isMetaKey(key: string): boolean {
  return key.startsWith(META_KEY_PREFIX + META_KEY_SEPARATOR);
}

// Returns the project key from a meta key, or null for any other key.
export function projectKeyFromMetaKey(metaKey: string): string | null {
  if (!isMetaKey(metaKey)) {
    return null;
  }
  return metaKey.slice((META_KEY_PREFIX + META_KEY_SEPARATOR).length);
}

// A folder in the single-home hierarchy. parentId is null for a top-level folder.
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  color?: string;
}

// A tag, stored once and referenced by id from a chat's tags array.
export interface Tag {
  id: string;
  label: string;
  color?: string;
}

// A link between chats. A parent link nests the target under this chat in the Folders tree.
export interface Link {
  targetChatId: string;
  kind: 'parent' | 'related';
}

// The synced per-chat metadata, arbitrated last-writer-wins by the per-record updatedAt stamp.
// archivedAt and restoredAt travel with userArchived, so the side that wins the archive state
// supplies all three. userArchived is a deliberate user choice, unlike the local orphan archive.
// restoredAt counts as activity so auto-archive does not re-archive a restored chat.
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

// The per-project document stored under the meta key. It is the unit of Settings Sync and
// holds no local-only state.
export interface ProjectMeta {
  schemaVersion: number;
  folders: { [folderId: string]: Folder };
  tags: { [tagId: string]: Tag };
  chats: { [chatId: string]: ChatMeta };
  updatedAt: number;
  deviceId: string;
  // Fields from a newer schemaVersion that this build does not understand. migrateProjectMeta
  // stashes them here and writes them back so a sync does not strip them.
  __unknown?: { [k: string]: unknown };
}

// Local-only orphan state for one chat, kept off ProjectMeta so it never syncs.
// missingSince is when a reconcile pass first failed to find the chat on disk.
// archived flips after the grace window. tombstone marks a reversible removal.
export interface LocalChatState {
  missingSince: number | null;
  archived: boolean;
  tombstone: boolean;
}

// Local-only companion document, stored under a key excluded from setKeysForSync.
export interface LocalProjectMeta {
  schemaVersion: number;
  chats: { [chatId: string]: LocalChatState };
  // The last organize Apply on this device. Never synced.
  organize?: OrganizeLedger;
  // Chats you moved to Unsorted by hand, with when, so the fleet and organize rules leave them
  // there. Per device, like every hand move's tie-breaker here; never synced.
  unsortedByHand?: { [chatId: string]: number };
}

// What one organize Apply changed for one chat, so Undo can restore it. folderId is
// the folder Apply put the chat in, or null when Apply left the folder alone.
export interface OrganizeLedgerEntry {
  folderId: string | null;
  priorFolderId: string | null;
  tagsAdded: string[];
  pinned: boolean;
}

// The per-device organize record. snapshot holds the last Apply only. applied maps each chat
// a rule filed (and Undo has not reverted) to the chosen folder, so a hand-filed chat is detectable.
export interface OrganizeLedger {
  at: number;
  createdFolderIds: string[];
  createdTagIds: string[];
  snapshot: { [chatId: string]: OrganizeLedgerEntry };
  applied: { [chatId: string]: string };
}

export const MAX_LEDGER_CHATS = 20000;

function ledgerIdList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => isSafeRecordId(v)).slice(0, MAX_LEDGER_CHATS) : [];
}

// Lifts a stored Unsorted-by-hand map of unknown shape to safe ids and finite times, capped.
export function normalizeUnsortedByHand(raw: unknown): { [chatId: string]: number } {
  const out: { [chatId: string]: number } = Object.create(null) as { [chatId: string]: number };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  let count = 0;
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_LEDGER_CHATS) {
      break;
    }
    if (isSafeRecordId(id) && typeof at === 'number' && Number.isFinite(at)) {
      out[id] = at;
      count++;
    }
  }
  return out;
}

// Lifts a stored organize ledger of unknown shape to a well-formed one, or null.
export function normalizeOrganizeLedger(raw: unknown): OrganizeLedger | null {
  if (!isObject(raw)) {
    return null;
  }
  const snapshot: { [chatId: string]: OrganizeLedgerEntry } = Object.create(null) as {
    [chatId: string]: OrganizeLedgerEntry;
  };
  const rawSnapshot = isObject(raw.snapshot) ? raw.snapshot : {};
  let count = 0;
  for (const [chatId, value] of Object.entries(rawSnapshot)) {
    if (!isSafeRecordId(chatId) || !isObject(value) || count >= MAX_LEDGER_CHATS) {
      continue;
    }
    snapshot[chatId] = {
      folderId: isSafeRecordId(value.folderId) ? value.folderId : null,
      priorFolderId: isSafeRecordId(value.priorFolderId) ? value.priorFolderId : null,
      tagsAdded: ledgerIdList(value.tagsAdded),
      pinned: value.pinned === true,
    };
    count++;
  }
  const applied: { [chatId: string]: string } = Object.create(null) as { [chatId: string]: string };
  const rawApplied = isObject(raw.applied) ? raw.applied : {};
  count = 0;
  for (const [chatId, folderId] of Object.entries(rawApplied)) {
    if (isSafeRecordId(chatId) && isSafeRecordId(folderId) && count < MAX_LEDGER_CHATS) {
      applied[chatId] = folderId;
      count++;
    }
  }
  return {
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    createdFolderIds: ledgerIdList(raw.createdFolderIds),
    createdTagIds: ledgerIdList(raw.createdTagIds),
    snapshot,
    applied,
  };
}

// Only #rrggbb is accepted. Folder colors arrive in importable documents and reach a CSS
// value in the webview, so nothing but a hex color may pass (a url(...) value would leak).
// The webview host's coerce() shares this rule.
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// True for a string in the strict #rrggbb shape.
export function isValidColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_PATTERN.test(value);
}

// Length cap for free text in the synced store (folder names, tag labels). Settings Sync
// limits item size, so one unbounded string could break sync of the whole store. Applied at
// normalize and at the store write sinks.
export const MAX_NAME_LENGTH = 200;

// Truncates free text to MAX_NAME_LENGTH.
export function clampName(value: string): string {
  return value.length > MAX_NAME_LENGTH ? value.slice(0, MAX_NAME_LENGTH) : value;
}

// Cap on a deviceId stamp: 128 covers a UUID, the dev-<hex> fallback and a machineId.
// An imported file supplies it verbatim, so it is capped like MAX_NAME_LENGTH.
// It is truncated, not dropped, so last-writer-wins still sees a stable non-empty foreign id.
export const MAX_DEVICE_ID_LENGTH = 128;

// Truncates a deviceId stamp to MAX_DEVICE_ID_LENGTH.
export function clampDeviceId(value: string): string {
  return value.length > MAX_DEVICE_ID_LENGTH
    ? value.slice(0, MAX_DEVICE_ID_LENGTH)
    : value;
}

// Cap on records in each of folders, tags and chats. Valid ids alone do not bound the record
// count, so a hostile import could persist a multi-megabyte document under one synced key.
// Real libraries stay far below 10000, so truncation only drops crafted junk.
export const MAX_COLLECTION_RECORDS = 10000;

// Cap on tag references on one chat, bounding the per-chat array.
export const MAX_CHAT_TAGS = 100;

// Cap on links on one chat, same reason as MAX_CHAT_TAGS.
export const MAX_CHAT_LINKS = 200;

// Record id shape: 1 to 64 URL-safe characters. It still admits Object.prototype names,
// which isSafeRecordId rejects.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Names such as 'constructor' pass ID_PATTERN but resolve to an inherited value on a plain
// object (meta.folders['constructor'] is not undefined), which would show a phantom folder or tag.
// Minted ids never collide with them, so rejecting them drops only untrusted data.
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

// True for a string matching ID_PATTERN that is not an Object.prototype name. It gates map keys
// too, since a key such as '../../../x' would escape globalStorage at a filesystem path sink.
export function isSafeRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ID_PATTERN.test(value) &&
    !PROTOTYPE_RECORD_IDS.has(value)
  );
}

// Cap on a project key: a directory name is at most 255 bytes on every supported platform.
export const MAX_PROJECT_KEY_LENGTH = 256;

// Project key shape: the output alphabet of encodeProjectKey. Underscore is excluded,
// which also rules out '__proto__'.
const PROJECT_KEY_PATTERN = /^[A-Za-z0-9-]{1,256}$/;

// True for a string matching PROJECT_KEY_PATTERN that is not an Object.prototype name.
// An import key becomes a synced globalState key with no removal path, so both the import
// boundary and the store write sink check it.
export function isSafeProjectKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PROJECT_KEY_PATTERN.test(value) &&
    !PROTOTYPE_RECORD_IDS.has(value)
  );
}

// Rebuilds folders, tags and chats as null-prototype maps in place on a cloned document.
// A JSON clone restores Object.prototype on them, which would let a prototype-name key
// resolve to an inherited member. Serialized output is unchanged.
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

// A new empty document stamped with the supplied deviceId and time.
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

// A new empty local companion document.
export function emptyLocalProjectMeta(): LocalProjectMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    chats: {},
  };
}

// Lifts a stored value of unknown shape to a well-formed ProjectMeta. Total: it never throws.
// deviceId and now stamp a document that has none.
export function migrateProjectMeta(
  raw: unknown,
  deviceId: string,
  now: number,
): ProjectMeta {
  if (!isObject(raw)) {
    return emptyProjectMeta(deviceId, now);
  }
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;

  // Version steps go here, each lifting N to N+1 before normalize. Version 0 needs none.
  if (version > SCHEMA_VERSION) {
    // A newer build wrote this. Keep its schemaVersion and escrow unknown top-level fields in
    // __unknown so a write from this build does not strip them under whole-value sync.
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

// Top-level keys this schema understands. Any other key on a newer document is escrowed.
const KNOWN_TOP_LEVEL = new Set<string>([
  'schemaVersion',
  'folders',
  'tags',
  'chats',
  'updatedAt',
  'deviceId',
  '__unknown',
]);

// Cap on the serialized size of the __unknown escrow, which is rewritten on every sync.
// An import claiming a huge schemaVersion could otherwise put an arbitrary blob on the synced surface.
export const MAX_UNKNOWN_ESCROW_LENGTH = 64 * 1024;

// Collects unknown top-level fields, deep-copied, within the MAX_UNKNOWN_ESCROW_LENGTH budget.
// An oversized field is dropped and the smaller ones are kept. Returns null when nothing is kept.
// defineProperty keeps a '__proto__' key as an own entry instead of rebinding the prototype.
function collectUnknownTopLevel(
  raw: { [k: string]: unknown },
): { [k: string]: unknown } | null {
  let result: { [k: string]: unknown } | null = null;
  let budget = MAX_UNKNOWN_ESCROW_LENGTH;
  const add = (key: string, value: unknown): void => {
    const json = JSON.stringify(value);
    if (json === undefined) {
      // A value that is not JSON-serializable cannot survive a synced write.
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
  // A document that already round-tripped holds its escrow nested under __unknown. Folding it
  // back in keeps the escrow from being lost on the second read. Live top-level fields win.
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

// Coerces a loosely shaped object to a strict ProjectMeta. Pure and total.
function normalizeProjectMeta(
  raw: { [k: string]: unknown },
  deviceId: string,
  now: number,
): ProjectMeta {
  // Null-prototype maps, so a key such as 'constructor' never resolves to an inherited member.
  // Every map key must pass isSafeRecordId: a chat key reaches archiveBodyStore.bodyFileUri,
  // so a path-like or prototype-name key drops the whole entry.
  // Each map is capped at MAX_COLLECTION_RECORDS; extra entries are dropped in iteration order.
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
    // An imported document supplies the stamp verbatim, so it is clamped.
    deviceId:
      typeof raw.deviceId === 'string' ? clampDeviceId(raw.deviceId) : deviceId,
  };
}

function normalizeFolder(id: string, value: unknown): Folder | null {
  if (!isObject(value)) {
    return null;
  }
  // Truncate rather than drop, so an over-long name keeps its folder.
  const name = typeof value.name === 'string' ? clampName(value.name) : null;
  if (name === null) {
    return null;
  }
  const folder: Folder = {
    id,
    name,
    // An unsafe parent reference becomes null (top level).
    parentId: isSafeRecordId(value.parentId) ? value.parentId : null,
    order: typeof value.order === 'number' ? value.order : 0,
  };
  // A non-hex color is dropped so an imported document cannot reach the webview's --chip-color with a CSS token.
  if (isValidColor(value.color)) {
    folder.color = value.color;
  }
  return folder;
}

function normalizeTag(id: string, value: unknown): Tag | null {
  if (!isObject(value)) {
    return null;
  }
  // Truncate like normalizeFolder.
  const label = typeof value.label === 'string' ? clampName(value.label) : null;
  if (label === null) {
    return null;
  }
  const tag: Tag = { id, label };
  // A non-hex color is dropped. Tag color has no postMessage setter, so this is its only check
  // before the --chip-color sink.
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
  // Keep only safe tag ids and cap both per-chat arrays so an import cannot carry an unbounded one.
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
    // An unsafe folderId becomes null (unfiled).
    folderId: isSafeRecordId(value.folderId) ? value.folderId : null,
    tags,
    links,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    // Clamped like the project-level stamp.
    deviceId:
      typeof value.deviceId === 'string' ? clampDeviceId(value.deviceId) : deviceId,
  };
  // Optional scalars pass through unchanged. archivedAt is kept even without userArchived;
  // the merge keeps the pair coupled.
  if (typeof value.starred === 'boolean') {
    chat.starred = value.starred;
  }
  if (typeof value.userArchived === 'boolean') {
    chat.userArchived = value.userArchived;
  }
  if (typeof value.archivedAt === 'number') {
    chat.archivedAt = value.archivedAt;
  }
  if (typeof value.restoredAt === 'number') {
    chat.restoredAt = value.restoredAt;
  }
  return chat;
}

function normalizeLink(value: unknown): Link | null {
  if (!isObject(value)) {
    return null;
  }
  // Same rule as the addLink write sink: an unsafe target drops the link.
  if (!isSafeRecordId(value.targetChatId)) {
    return null;
  }
  const kind = value.kind === 'parent' ? 'parent' : 'related';
  return { targetChatId: value.targetChatId, kind };
}

function isObject(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
