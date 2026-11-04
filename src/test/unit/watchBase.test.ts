import * as assert from 'assert';
import * as path from 'path';

import { findWatchBase } from '../../fleet/watchBase';

function dirs(...existing: string[]): (p: string) => Promise<boolean> {
  const set = new Set(existing.map((p) => path.resolve(p)));
  return async (p) => set.has(path.resolve(p));
}

describe('findWatchBase', () => {
  const root = path.resolve('/w');
  const file = path.join(root, 'dev', 'fleet.jsonl');

  it('watches the file itself when its folder exists', async () => {
    const where = await findWatchBase(file, dirs(root, path.join(root, 'dev')));
    assert.deepStrictEqual(where, { base: path.join(root, 'dev'), name: 'fleet.jsonl', direct: true });
  });

  it('watches for the missing folder in the nearest folder that exists', async () => {
    const where = await findWatchBase(file, dirs(root));
    assert.deepStrictEqual(where, { base: root, name: 'dev', direct: false });
  });

  it('walks up past several missing folders', async () => {
    const deep = path.join(root, 'a', 'b', 'c', 'fleet.jsonl');
    const where = await findWatchBase(deep, dirs(root));
    assert.deepStrictEqual(where, { base: root, name: 'a', direct: false });
  });

  it('stops at the filesystem root', async () => {
    const where = await findWatchBase(file, dirs());
    assert.strictEqual(where.base, path.parse(root).root);
    assert.strictEqual(where.direct, false);
  });
});
