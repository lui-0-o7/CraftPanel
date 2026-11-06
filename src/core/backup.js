'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ZipWriter, extractZip } = require('./zip');
const store = require('./store');
const { ensureDir, isInside } = require('./paths');

function backupsDir(server) {
  return ensureDir(path.join(server.dir, 'backups'));
}

function walk(abs, rel, out) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    let items = [];
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      walk(path.join(abs, item.name), `${rel}/${item.name}`, out);
    }
  } else if (stat.isFile()) {
    out.push({ abs, rel, size: stat.size, mtime: stat.mtime });
  }
}

function collect(server) {
  const out = [];
  const add = (relPath) => {
    const abs = path.join(server.dir, relPath);
    if (!fs.existsSync(abs)) return;
    walk(abs, relPath.replace(/\\/g, '/'), out);
  };

  if (server.edition === 'bedrock') {
    for (const item of ['server.properties', 'allow-list.json', 'permissions.json', 'worlds', 'behavior_packs', 'resource_packs']) {
      add(item);
    }
  } else {
    for (const item of [
      'server.properties',
      'whitelist.json',
      'ops.json',
      'banned-players.json',
      'banned-ips.json',
      'plugins',
      'mods',
      'config',
    ]) {
      add(item);
    }
    let items = [];
    try {
      items = fs.readdirSync(server.dir, { withFileTypes: true });
    } catch {
      items = [];
    }
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (/^world/i.test(item.name)) add(item.name);
    }
  }
  return out;
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function create(server, { onProgress = () => {} } = {}) {
  const files = collect(server);
  if (!files.length) throw new Error('No hay archivos de mundo que copiar todavía. Inicia el servidor al menos una vez.');
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const targetDir = backupsDir(server);
  const name = `backup-${stamp()}.zip`;
  const finalPath = path.join(targetDir, name);
  const tmpPath = `${finalPath}.part`;

  onProgress({ percent: 0, message: `Comprimiendo ${files.length} archivos...` });
  const writer = new ZipWriter(tmpPath);
  let processed = 0;
  try {
    for (const file of files) {
      writer.addFile(file.rel, fs.readFileSync(file.abs), file.mtime);
      processed += file.size;
      onProgress({
        percent: total ? Math.min(99, (processed / total) * 100) : 50,
        message: `Comprimiendo ${file.rel}`,
      });
    }
    writer.close();
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      writer.close();
    } catch {
      /* ignora */
    }
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  prune(server, store.get('maxBackups'));
  onProgress({ percent: 100, message: 'Copia creada' });
  return { name, size: fs.statSync(finalPath).size, createdAt: new Date().toISOString() };
}

function list(server) {
  const dir = backupsDir(server);
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return items
    .filter((i) => i.isFile() && i.name.toLowerCase().endsWith('.zip'))
    .map((i) => {
      const full = path.join(dir, i.name);
      const stat = fs.statSync(full);
      return { name: i.name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function resolveBackup(server, name) {
  const dir = backupsDir(server);
  const clean = path.basename(String(name));
  if (!clean.toLowerCase().endsWith('.zip')) throw new Error('Copia no válida');
  const full = path.join(dir, clean);
  if (!isInside(dir, full)) throw new Error('Ruta de copia no válida');
  if (!fs.existsSync(full)) throw new Error('La copia ya no existe');
  return full;
}

async function restore(server, name, { onProgress = () => {} } = {}) {
  const full = resolveBackup(server, name);
  onProgress({ percent: 0, message: 'Restaurando copia...' });
  await extractZip(full, server.dir, {
    onProgress: (done, total, file) =>
      onProgress({
        percent: total ? (done / total) * 100 : 50,
        message: `Restaurando ${file || ''}`.trim(),
      }),
  });
  onProgress({ percent: 100, message: 'Copia restaurada' });
  return true;
}

function remove(server, name) {
  const full = resolveBackup(server, name);
  fs.rmSync(full, { force: true });
  return true;
}

function prune(server, max) {
  const limit = Number(max) || 0;
  if (limit <= 0) return;
  const items = list(server);
  for (const item of items.slice(limit)) {
    try {
      fs.rmSync(path.join(backupsDir(server), item.name), { force: true });
    } catch {
      /* ignora */
    }
  }
}

module.exports = { create, list, restore, remove, backupsDir, resolveBackup, prune };
