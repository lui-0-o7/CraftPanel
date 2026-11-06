'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let cache = null;
let cacheAt = 0;
const TTL = 60 * 1000;

function runVersion(javaPath) {
  try {
    const res = spawnSync(javaPath, ['-version'], {
      timeout: 8000,
      windowsHide: true,
      encoding: 'utf8',
    });
    const text = `${res.stderr || ''}${res.stdout || ''}`;
    const match = text.match(/version "([^"]+)"/);
    if (!match) return null;
    const raw = match[1];
    const parts = raw.split(/[._-]/);
    let major = parseInt(parts[0], 10);
    if (major === 1 && parts[1]) major = parseInt(parts[1], 10);
    let vendor = 'Java';
    if (/Temurin|Adoptium/i.test(text)) vendor = 'Eclipse Temurin';
    else if (/OpenJDK/i.test(text)) vendor = 'OpenJDK';
    else if (/Oracle/i.test(text)) vendor = 'Oracle JDK';
    else if (/Microsoft/i.test(text)) vendor = 'Microsoft OpenJDK';
    else if (/Zulu/i.test(text)) vendor = 'Azul Zulu';
    else if (/Corretto/i.test(text)) vendor = 'Amazon Corretto';
    return { path: javaPath, version: raw, major, vendor, label: `${vendor} ${raw}` };
  } catch {
    return null;
  }
}

function candidatePaths() {
  const found = new Set();
  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(p)) found.add(p);
  }

  // Java del PATH
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['java'], {
    timeout: 5000,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (which.status === 0 && which.stdout) {
    for (const line of which.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) found.add(p);
    }
  }

  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files (x86)\\Java',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft'),
      path.join(process.env.APPDATA || '', '.minecraft', 'runtime'),
    ];
    for (const root of roots) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const direct = path.join(root, entry.name, 'bin', 'java.exe');
        if (fs.existsSync(direct)) {
          found.add(direct);
          continue;
        }
        // Estructuras tipo .minecraft/runtime/java-runtime-xxx/windows-x64/java-runtime-xxx/bin/java.exe
        try {
          for (const sub of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            for (const arch of fs.readdirSync(path.join(root, entry.name, sub.name), { withFileTypes: true })) {
              if (!arch.isDirectory()) continue;
              for (const inner of fs.readdirSync(path.join(root, entry.name, sub.name, arch.name), { withFileTypes: true })) {
                if (!inner.isDirectory()) continue;
                const p = path.join(root, entry.name, sub.name, arch.name, inner.name, 'bin', 'java.exe');
                if (fs.existsSync(p)) found.add(p);
              }
            }
          }
        } catch {
          /* ignora */
        }
      }
    }
  } else {
    for (const dir of ['/usr/lib/jvm', '/usr/java', '/opt/java']) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name, 'bin', 'java');
        if (fs.existsSync(p)) found.add(p);
      }
    }
  }
  return [...found];
}

function detect(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  const result = [];
  const seen = new Set();
  for (const candidate of candidatePaths()) {
    const real = candidate.toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    const info = runVersion(candidate);
    if (info) result.push(info);
  }
  result.sort((a, b) => b.major - a.major);
  cache = result;
  cacheAt = Date.now();
  return result;
}

function resolve(preferred) {
  let custom = preferred;
  if (!custom) {
    try {
      custom = require('./store').get('javaPath');
    } catch {
      custom = '';
    }
  }
  if (custom && fs.existsSync(custom)) {
    const info = runVersion(custom);
    if (info) return info;
  }
  const all = detect();
  if (all.length) return all[0];
  return { path: 'java', version: 'desconocida', major: 0, vendor: 'Java', label: 'java (PATH)' };
}

function requirements(software, version) {
  // Requisitos mínimos aproximados de Java por versión de Minecraft.
  const v = String(version || '');
  const yearBased = /^(\d{2})\./.exec(v);
  if (yearBased) {
    const year = parseInt(yearBased[1], 10);
    if (year >= 26) return 25;
    if (year >= 25) return 21;
  }
  const m = /^1\.(\d+)/.exec(v);
  if (m) {
    const minor = parseInt(m[1], 10);
    if (minor >= 20 && minor <= 4) return 17;
    if (minor >= 18) return 17;
    if (minor === 17) return 16;
    if (minor >= 13) return 8;
    return 8;
  }
  if (software === 'paper') return 21;
  return 17;
}

module.exports = { detect, resolve, requirements, runVersion };
