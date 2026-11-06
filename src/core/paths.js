'use strict';

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

function userDataDir() {
  return app.getPath('userData');
}

function defaultServersDir() {
  return path.join(userDataDir(), 'servers');
}

function configFile() {
  return path.join(userDataDir(), 'config.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'servidor';
}

function uniqueDir(base, slug) {
  let candidate = path.join(base, slug);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(base, `${slug}-${i}`);
    i += 1;
  }
  return candidate;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  userDataDir,
  defaultServersDir,
  configFile,
  ensureDir,
  isInside,
  slugify,
  uniqueDir,
  newId,
};
