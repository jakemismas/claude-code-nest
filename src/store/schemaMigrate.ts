// Validates and migrates the export file wrapper ({ version, exportedAt, projects }).
// Each embedded project document goes through schema.migrateProjectMeta, so an export from
// an older or newer build normalizes like a stored document. Pure and vscode-free.

import {
  ProjectMeta,
  isSafeProjectKey,
  migrateProjectMeta,
} from './schema';

// Wrapper format version, independent of SCHEMA_VERSION. Bump it when the wrapper shape
// changes and add a step to migrateEnvelope.
export const EXPORT_FORMAT_VERSION = 1;

// Each accepted project key becomes a synced globalState key and the store cannot remove
// keys, so a cap stops a junk envelope from polluting every synced machine.
export const MAX_ENVELOPE_PROJECTS = 1000;

// Per-document size cap in JSON characters. An oversized value breaks that project's
// Settings Sync item with no removal path. An oversized entry is skipped and counted.
export const MAX_PROJECT_DOCUMENT_LENGTH = 2 * 1024 * 1024;

// The on-disk export envelope: ProjectMeta documents keyed by projectKey.
export interface ExportEnvelope {
  // Wrapper format version, not SCHEMA_VERSION.
  version: number;
  // Epoch ms of the export. Informational: per-record updatedAt arbitrates merges.
  exportedAt: number;
  // Keyed by the encoded projectKey that metaKeyFor consumes.
  projects: { [projectKey: string]: ProjectMeta };
}

// An envelope whose projects have all been run through migrateProjectMeta.
export interface NormalizedEnvelope {
  version: number;
  exportedAt: number;
  projects: { [projectKey: string]: ProjectMeta };
}

export type EnvelopeValidation =
  | { ok: true; envelope: RawEnvelope }
  | { ok: false; error: string };

// The envelope after wrapper validation but before per-project migration.
// skippedProjects counts dropped entries so the import command can report them.
export interface RawEnvelope {
  version: number;
  exportedAt: number;
  projects: { [projectKey: string]: unknown };
  skippedProjects: number;
}

// Checks the wrapper shape before any migration. Rejects a malformed file before the live store is read.
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
  // A missing or invalid exportedAt becomes 0, since older or hand-edited exports may lack it.
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
  // An entry with an unsafe key, a non-object value or an oversized document is skipped and
  // counted, not a whole-file rejection: pre-0.2.0 backups can hold one legacy-invalid key
  // among valid projects. The key is never echoed because it can be arbitrarily large.
  const entries = Object.entries(raw.projects);
  if (entries.length > MAX_ENVELOPE_PROJECTS) {
    return {
      ok: false,
      error:
        'Export contains too many projects (more than ' +
        String(MAX_ENVELOPE_PROJECTS) +
        ').',
    };
  }
  // Null prototype because the keys come from an untrusted file.
  const projects: { [projectKey: string]: unknown } =
    Object.create(null) as { [projectKey: string]: unknown };
  let skippedProjects = 0;
  for (const [projectKey, value] of entries) {
    if (!isSafeProjectKey(projectKey) || !isObject(value)) {
      skippedProjects++;
      continue;
    }
    if (JSON.stringify(value).length > MAX_PROJECT_DOCUMENT_LENGTH) {
      skippedProjects++;
      continue;
    }
    projects[projectKey] = value;
  }
  return {
    ok: true,
    envelope: {
      version: raw.version,
      exportedAt,
      projects,
      skippedProjects,
    },
  };
}

// Lifts the wrapper to EXPORT_FORMAT_VERSION and runs each project through migrateProjectMeta,
// which keeps a newer build's __unknown fields. deviceId and now stamp stamp-less documents.
export function migrateEnvelope(
  envelope: RawEnvelope,
  deviceId: string,
  now: number,
): NormalizedEnvelope {
  // Wrapper version steps go here. A newer wrapper version is read as-is.
  const lifted = envelope;

  // Null prototype so a prototype-shaped key that slips past validateEnvelope stays inert.
  const projects: { [projectKey: string]: ProjectMeta } =
    Object.create(null) as { [projectKey: string]: ProjectMeta };
  for (const [projectKey, value] of Object.entries(lifted.projects)) {
    // migrateProjectMeta is total: it returns a valid ProjectMeta for any input.
    projects[projectKey] = migrateProjectMeta(value, deviceId, now);
  }

  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: lifted.exportedAt,
    projects,
  };
}

// Builds an envelope at the current format version from per-project documents. Pure: no IO.
export function buildEnvelope(
  projects: { [projectKey: string]: ProjectMeta },
  now: number,
): ExportEnvelope {
  // Deep copy so later store mutations do not leak into the export payload.
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
