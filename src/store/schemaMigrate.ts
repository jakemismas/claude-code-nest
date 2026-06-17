// Export-file ENVELOPE migration and validation. This is DISTINCT from
// schema.ts migrateProjectMeta, which lifts ONE stored ProjectMeta document. The
// concern here is the EXPORT WRAPPER: the { version, exportedAt, projects } shape
// that an export writes and an import reads, plus its own format version that is
// SEPARATE from SCHEMA_VERSION.
//
// On import the flow is, in order:
//   1. parse the JSON text (the command module does the read; it hands us the
//      parsed unknown),
//   2. validateEnvelope (shape gate; reject a non-envelope before any migration),
//   3. migrateEnvelope (lift the envelope across export-format versions to
//      EXPORT_FORMAT_VERSION),
//   4. run EACH embedded per-project document through schema.migrateProjectMeta
//      (REUSED, never duplicated) so an export taken on an older or newer build
//      is normalized exactly like a stored document, preserving each project's
//      __unknown escrow,
//   5. THEN the additive merge in reconcileSync folds it into the live store.
//
// This module is PURE and vscode-free (unit-gate rule): no filesystem, no vscode.
// The command module owns the file read and parse; it passes us a parsed unknown
// and we return a typed, validated, migrated result or a structured error.

import {
  ProjectMeta,
  migrateProjectMeta,
} from './schema';

// The export-file format version. SEPARATE from SCHEMA_VERSION (the per-project
// document version): the envelope can gain wrapper-level fields without bumping
// the document schema, and vice versa. Bump this when the WRAPPER shape changes
// and add a step to migrateEnvelope.
export const EXPORT_FORMAT_VERSION = 1;

// The on-disk export envelope: a wrapper around multiple ProjectMeta documents
// keyed by projectKey, with a format version and an export timestamp. The
// embedded project docs are the SAME ProjectMeta shape the store persists, so a
// project round-trips through export/import without re-modeling.
export interface ExportEnvelope {
  // The export-format version (this module's, NOT SCHEMA_VERSION).
  version: number;
  // Epoch ms when the export was taken. Informational; not used for merge
  // arbitration (per-project/per-record updatedAt do that).
  exportedAt: number;
  // Every project's full ProjectMeta, keyed by the encoded projectKey (the same
  // string metaKeyFor consumes). An empty object is a valid empty export.
  projects: { [projectKey: string]: ProjectMeta };
}

// A migrated, validated envelope whose every embedded project has been run
// through migrateProjectMeta (normalized to the current document schema with
// __unknown escrow preserved for a forward-version project).
export interface NormalizedEnvelope {
  version: number;
  exportedAt: number;
  projects: { [projectKey: string]: ProjectMeta };
}

export type EnvelopeValidation =
  | { ok: true; envelope: RawEnvelope }
  | { ok: false; error: string };

// The envelope as it comes off disk BEFORE per-project migration: validated to
// the wrapper shape (version is a number, exportedAt is a number, projects is an
// object map) but the per-project values are still unknown until migrated.
export interface RawEnvelope {
  version: number;
  exportedAt: number;
  projects: { [projectKey: string]: unknown };
}

// Validate that a parsed value is the export-envelope WRAPPER shape, before any
// migration touches it. This is the scratch-copy gate the architecture requires:
// a malformed file is rejected here, BEFORE the live store is ever consulted. It
// checks only the wrapper (version/exportedAt/projects-is-an-object-map); the
// per-project documents are validated by migrateProjectMeta in the migrate step,
// which is total and never throws.
export function validateEnvelope(raw: unknown): EnvelopeValidation {
  if (!isObject(raw)) {
    return { ok: false, error: 'Not a Claude Code Nest export: the file is not a JSON object.' };
  }
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) {
    return {
      ok: false,
      error: 'Not a Claude Code Nest export: missing or non-numeric "version".',
    };
  }
  if (raw.version < 1) {
    return {
      ok: false,
      error: 'Not a Claude Code Nest export: "version" must be at least 1.',
    };
  }
  // exportedAt is informational; tolerate a missing/garbage stamp by treating it
  // as 0 rather than rejecting (an older or hand-edited export may lack it).
  const exportedAt =
    typeof raw.exportedAt === 'number' && Number.isFinite(raw.exportedAt)
      ? raw.exportedAt
      : 0;
  if (!isObject(raw.projects)) {
    return {
      ok: false,
      error: 'Not a Claude Code Nest export: "projects" must be an object map keyed by project.',
    };
  }
  // The keys must be strings (always true for an object) and the values must be
  // objects; a non-object project value is rejected here so the envelope is
  // wholesale-trustworthy before migration. An empty projects map is valid.
  for (const [projectKey, value] of Object.entries(raw.projects)) {
    if (projectKey.length === 0) {
      return { ok: false, error: 'Export contains an empty project key.' };
    }
    if (!isObject(value)) {
      return {
        ok: false,
        error: 'Export project "' + projectKey + '" is not an object.',
      };
    }
  }
  return {
    ok: true,
    envelope: {
      version: raw.version,
      exportedAt,
      projects: raw.projects as { [k: string]: unknown },
    },
  };
}

// Migrate a validated raw envelope to the current EXPORT_FORMAT_VERSION and run
// every embedded project through migrateProjectMeta (REUSED from schema.ts, never
// reimplemented). The per-project migration normalizes each document and, for a
// forward-version project, preserves its __unknown escrow so an export taken on a
// NEWER build does not strip that machine's richer fields on a round-trip through
// this build.
//
// deviceId + now supply the stamp for any embedded project document that lacks
// one (an upgrade-in-place of a stamp-less older project), exactly as
// migrateProjectMeta documents.
export function migrateEnvelope(
  envelope: RawEnvelope,
  deviceId: string,
  now: number,
): NormalizedEnvelope {
  // Wrapper-version migration steps slot in here, each lifting envelope version N
  // to N+1, BEFORE the per-project normalize pass. Version 1 is the current shape;
  // no wrapper transform is needed. A FORWARD wrapper version (a newer build's
  // export) is read as-is at the wrapper level: the per-project migration still
  // protects each document's unknown fields, and the wrapper carries no
  // behavioral fields beyond version/exportedAt/projects that this build would
  // strip.
  const lifted = envelope;

  const projects: { [projectKey: string]: ProjectMeta } = {};
  for (const [projectKey, value] of Object.entries(lifted.projects)) {
    // REUSE the stored-document migration; do NOT duplicate its logic. It is
    // total and defensive: it returns a well-formed ProjectMeta for any input and
    // escrows a forward-version project's unknown fields in __unknown.
    projects[projectKey] = migrateProjectMeta(value, deviceId, now);
  }

  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: lifted.exportedAt,
    projects,
  };
}

// Build a fresh export envelope from a set of per-project documents at the
// current format version. The command module supplies the live store's projects
// (each already a ProjectMeta with its stamps and any __unknown escrow) and the
// export timestamp; this returns the serializable envelope. Pure: no IO.
export function buildEnvelope(
  projects: { [projectKey: string]: ProjectMeta },
  now: number,
): ExportEnvelope {
  // Deep-copy so the envelope never aliases the caller's live store objects (a
  // later store mutation must not leak into an already-built export payload).
  const copy: { [projectKey: string]: ProjectMeta } = {};
  for (const [projectKey, meta] of Object.entries(projects)) {
    copy[projectKey] = JSON.parse(JSON.stringify(meta)) as ProjectMeta;
  }
  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now,
    projects: copy,
  };
}

function isObject(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
