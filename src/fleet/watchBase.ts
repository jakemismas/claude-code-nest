// Where to watch for a file whose folder may not exist yet. A file watcher on a missing
// folder never fires, so the watch sits on the nearest folder that exists and waits for
// the next missing entry on the way to the file to appear.
import * as path from 'path';

export interface WatchBase {
  // The folder to watch.
  readonly base: string;
  // The one entry inside base to watch for.
  readonly name: string;
  // True when base is the file's own folder, so name is the file itself.
  readonly direct: boolean;
}

export async function findWatchBase(filePath: string, isDirectory: (p: string) => Promise<boolean>): Promise<WatchBase> {
  let child = filePath;
  let dir = path.dirname(filePath);
  while (!(await isDirectory(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    child = dir;
    dir = parent;
  }
  return { base: dir, name: path.basename(child), direct: child === filePath };
}
