'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { slugify, uniqueDir, newId, isInside } = require('./paths');

const META_FILE = 'craftpanel.json';

function metaPath(dir) {
  return path.join(dir, META_FILE);
}

function readMeta(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(metaPath(dir), 'utf8'));
    if (!data || !data.id) return null;
    return data;
  } catch {
    return null;
  }
}

function writeMeta(dir, meta) {
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function list() {
  const base = store.serversDir();
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const meta = readMeta(dir);
    if (meta) out.push({ ...meta, dir });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
  return out;
}

function get(id) {
  return list().find((s) => s.id === id) || null;
}

function requireServer(id) {
  const server = get(id);
  if (!server) throw new Error('El servidor ya no existe');
  return server;
}

function validate({ name, port, edition }) {
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) throw new Error('El nombre debe tener al menos 2 caracteres');
  if (cleanName.length > 60) throw new Error('El nombre es demasiado largo (máximo 60)');
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error('El puerto debe estar entre 1 y 65535');
  }
  if (edition !== 'java' && edition !== 'bedrock') throw new Error('Edición no válida');
  return { name: cleanName, port: numericPort };
}

function portInUse(port, ignoreId = null) {
  return list().find((s) => Number(s.port) === Number(port) && s.id !== ignoreId) || null;
}

function create(options) {
  const { name, port } = validate(options);
  const edition = options.edition;
  const software = options.software;
  const base = store.serversDir();
  const dir = uniqueDir(base, slugify(name));

  const meta = {
    id: newId(),
    name,
    edition,
    software,
    version: String(options.version || ''),
    build: options.build || null,
    port,
    ramMB: Math.max(512, Number(options.ramMB) || (edition === 'bedrock' ? 1024 : 2048)),
    javaPath: options.javaPath || '',
    motd: options.motd || 'Servidor de Minecraft',
    onlineMode: options.onlineMode !== false,
    eulaAccepted: options.eulaAccepted === true,
    installed: false,
    createdAt: new Date().toISOString(),
    lastStartedAt: null,
  };

  fs.mkdirSync(dir, { recursive: true });
  writeMeta(dir, meta);
  return { meta, dir };
}

function update(id, patch) {
  const server = requireServer(id);
  const allowed = [
    'name',
    'port',
    'ramMB',
    'javaPath',
    'motd',
    'onlineMode',
    'eulaAccepted',
    'installed',
    'version',
    'build',
    'lastStartedAt',
    'notes',
    'autoRestart',
  ];
  const next = { ...server };
  for (const key of allowed) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim();
    if (clean.length < 2) throw new Error('El nombre debe tener al menos 2 caracteres');
    next.name = clean.slice(0, 60);
  }
  if (patch.port !== undefined) {
    const numericPort = Number(patch.port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new Error('El puerto debe estar entre 1 y 65535');
    }
    next.port = numericPort;
  }
  if (patch.ramMB !== undefined) {
    next.ramMB = Math.max(512, Math.min(65536, Number(patch.ramMB) || 1024));
  }
  delete next.dir;
  writeMeta(server.dir, next);
  return { ...next, dir: server.dir };
}

function remove(id, { deleteFiles = true } = {}) {
  const server = requireServer(id);
  const base = store.serversDir();
  if (!isInside(base, server.dir)) throw new Error('Ruta de servidor no válida');
  if (deleteFiles) {
    fs.rmSync(server.dir, { recursive: true, force: true, maxRetries: 3 });
  } else {
    fs.rmSync(metaPath(server.dir), { force: true });
  }
  return true;
}

function jarPath(server) {
  return path.join(server.dir, server.software === 'fabric' ? 'fabric-server-launch.jar' : 'server.jar');
}

function executable(server) {
  if (server.edition === 'bedrock') {
    return path.join(server.dir, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server');
  }
  return jarPath(server);
}

module.exports = {
  META_FILE,
  list,
  get,
  requireServer,
  create,
  update,
  remove,
  writeMeta,
  readMeta,
  portInUse,
  validate,
  jarPath,
  executable,
};
