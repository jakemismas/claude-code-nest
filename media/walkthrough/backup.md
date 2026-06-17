# Back up your library

Your folders, tags, and links are stored in extension state and synced
best-effort through Settings Sync. Cross-machine sync is last-writer-wins per
project, so the export JSON is the authoritative backup.

- Export Library writes a human-readable JSON of every project.
- Import Library merges a JSON additively; it never deletes a project absent from
  the file.
- Optional auto-export writes debounced snapshots to global storage with
  retention.

Point your canonical export at a synced or git-tracked location so it survives a
machine reset.
