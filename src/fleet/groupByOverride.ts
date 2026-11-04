// Pure helpers for the per-workspace "Group chats by" override. No vscode, no filesystem.
import { GROUP_BY_VALUES, GroupBy } from './nestConfig';

// workspaceState key. Per workspace, never synced.
export const GROUP_BY_OVERRIDE_KEY = 'claudeNest.orgPanel.groupByOverride';

// Returns the mode when it is one of the four known values, else null.
export function coerceGroupByMode(value: unknown): GroupBy | null {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value)
    ? (value as GroupBy)
    : null;
}

// A stored override is meaningful only when it names a concrete mode; "auto" and anything
// unknown mean no override.
export function coerceGroupByOverride(value: unknown): GroupBy | null {
  const mode = coerceGroupByMode(value);
  return mode === null || mode === 'auto' ? null : mode;
}

// The override wins over the layout file's value; with no override the layout value stands.
export function effectiveGroupBy(override: unknown, layoutGroupBy: GroupBy): GroupBy {
  return coerceGroupByOverride(override) ?? layoutGroupBy;
}

export type SettingsInbound =
  | { type: 'setGroupBy'; mode: GroupBy }
  | { type: 'setRobinAnimations'; on: boolean };

// The inbound gate for the two settings messages. Unknown modes and non-boolean values
// are dropped.
export function coerceSettingsInbound(raw: unknown): SettingsInbound | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as { type?: unknown; mode?: unknown; on?: unknown };
  if (obj.type === 'setGroupBy') {
    const mode = coerceGroupByMode(obj.mode);
    return mode === null ? null : { type: 'setGroupBy', mode };
  }
  if (obj.type === 'setRobinAnimations') {
    return typeof obj.on === 'boolean' ? { type: 'setRobinAnimations', on: obj.on } : null;
  }
  return null;
}
