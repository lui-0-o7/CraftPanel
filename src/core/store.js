'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configFile, defaultServersDir, ensureDir } = require('./paths');

const DEFAULTS = {
  serversDir: '',
  javaPath: '',
  cloudflaredPath: '',
  maxBackups: 10,
  confirmStop: true,
  lastServerId: '',
};

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    saved = {};
  }
  cache = { ...DEFAULTS, ...saved };
  if (!cache.serversDir) cache.serversDir = defaultServersDir();
  ensureDir(cache.serversDir);
  return cache;
}

function save(patch = {}) {
  const current = load();
  cache = { ...current, ...patch };
  ensureDir(cache.serversDir);
  fs.writeFileSync(configFile(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

function get(key) {
  return load()[key];
}

function serversDir() {
  return ensureDir(load().serversDir);
}

module.exports = { load, save, get, serversDir, DEFAULTS };
