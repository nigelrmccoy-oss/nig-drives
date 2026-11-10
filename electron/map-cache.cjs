const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
exports.installMapCache = (ipc, dir, owner) => {
  const filename = key => {
    if (typeof key !== 'string' || key.length > 2048 || !/^(v150:|dem:)/.test(key)) throw new Error('Invalid map key');
    return path.join(dir, createHash('sha256').update(key).digest('hex') + '.json');
  };
  let serial = Promise.resolve();
  const handle = (op, fn) => ipc.handle('map-cache:' + op, (event, value) => {
    if (event.sender !== owner() || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted frame');
    const task = serial.then(() => fn(value));
    serial = task.catch(() => {}); return task;
  });
  handle('get', async key => {
    try { return JSON.parse(await fs.readFile(filename(key), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  });
  handle('put', async row => {
    const name = filename(row.key);
    if (!Number.isFinite(row.t) || row.data === undefined) throw new Error('Invalid map row');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(name + '.tmp', JSON.stringify(row)); await fs.rename(name + '.tmp', name);
  });
  const files = async () => (await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
  handle('stats', async () => {
    const names = await files(); let bytes = 0;
    for (const n of names) bytes += (await fs.stat(path.join(dir, n))).size;
    return { count: names.length, bytes };
  });
  handle('clear', async () => { for (const n of await files()) await fs.unlink(path.join(dir, n)); });
};
