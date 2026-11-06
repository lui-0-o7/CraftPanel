'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { downloadFile } = require('./download');
const { resolveServer } = require('./versions');
const { extractZip } = require('./zip');
const properties = require('./properties');
const java = require('./java');
const servers = require('./servers');
const { ensureDir } = require('./paths');

function runJava(args, { cwd, javaPath, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true, env: { ...process.env } });
    let output = '';
    const handle = (chunk) => {
      const text = String(chunk);
      output += text;
      if (output.length > 20000) output = output.slice(-10000);
      if (onLine) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`El instalador de Fabric falló (código ${code}).\n${output.slice(-1500)}`));
    });
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function writeStartScripts(server, dir) {
  if (server.edition === 'bedrock') {
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(dir, 'start.bat'),
        '@echo off\r\ncd /d "%~dp0"\r\nbedrock_server.exe\r\npause\r\n',
        'utf8'
      );
    }
    fs.writeFileSync(
      path.join(dir, 'start.sh'),
      '#!/bin/sh\ncd "$(dirname "$0")"\nLD_LIBRARY_PATH=. ./bedrock_server\n',
      'utf8'
    );
    return;
  }
  const ram = Number(server.ramMB) || 2048;
  const xms = Math.min(1024, ram);
  const flags = `-Xms${xms}M -Xmx${ram}M -Dfile.encoding=UTF-8`;
  const jar = server.software === 'fabric' ? 'fabric-server-launch.jar' : 'server.jar';
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(dir, 'start.bat'),
      `@echo off\r\ncd /d "%~dp0"\r\njava ${flags} -jar ${jar} nogui\r\npause\r\n`,
      'utf8'
    );
  }
  fs.writeFileSync(
    path.join(dir, 'start.sh'),
    `#!/bin/sh\ncd "$(dirname "$0")"\njava ${flags} -jar ${jar} nogui\n`,
    'utf8'
  );
}

function writeInitialProperties(server, dir) {
  const file = path.join(dir, 'server.properties');
  if (server.edition === 'bedrock') {
    const portv6 = Number(server.port) < 65535 ? String(Number(server.port) + 1) : '19133';
    const overrides = {
      'server-name': server.motd || server.name,
      'server-port': String(server.port),
      'server-portv6': portv6,
      'online-mode': server.onlineMode ? 'true' : 'false',
      'allow-list': 'false',
      'difficulty': 'normal',
      'gamemode': 'survival',
      'max-players': '20',
    };
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, properties.setValues(text, overrides), 'utf8');
      return;
    }
    fs.writeFileSync(
      file,
      properties.build({
        ...properties.BEDROCK_DEFAULTS,
        ...overrides,
      }),
      'utf8'
    );
    return;
  }
  fs.writeFileSync(
    file,
    properties.build({
      ...properties.JAVA_DEFAULTS,
      'server-port': String(server.port),
      'motd': server.motd || server.name,
      'online-mode': server.onlineMode ? 'true' : 'false',
    }),
    'utf8'
  );
}

async function install({ server, dir, acceptEula = false, onProgress = () => {} }) {
  ensureDir(dir);
  const report = (phase, percent, message) => onProgress({ phase, percent, message });

  report('resolve', 1, 'Consultando la versión disponible...');
  const resolved = await resolveServer({ software: server.software, version: server.version });
  const javaInfo = java.resolve(server.javaPath);
  const required = resolved.javaMin || java.requirements(server.software, server.version);

  if (server.edition === 'java' && required && javaInfo.major && javaInfo.major < required) {
    throw new Error(
      `Esta versión necesita Java ${required} o superior, pero se detectó ${javaInfo.label}. ` +
        'Instala un JDK más reciente o selecciona otro ejecutable de Java en Ajustes.'
    );
  }

  if (resolved.kind === 'jar') {
    report('download', 4, `Descargando ${resolved.fileName}...`);
    const target = path.join(dir, 'server.jar');
    await downloadFile(resolved.url, target, {
      onProgress: (p) => report('download', 4 + (p.percent || 0) * 0.72, `Descargando servidor... ${Math.round(p.percent || 0)}%`),
    });
    if (resolved.sha256) {
      report('verify', 78, 'Verificando integridad...');
      const digest = await sha256File(target);
      if (digest.toLowerCase() !== resolved.sha256.toLowerCase()) {
        fs.rmSync(target, { force: true });
        throw new Error('El archivo descargado está dañado (SHA-256 no coincide). Inténtalo de nuevo.');
      }
    }
    server.build = resolved.build || null;
  } else if (resolved.kind === 'fabric') {
    const installerJar = path.join(dir, '.fabric-installer.jar');
    report('download', 4, 'Descargando instalador de Fabric...');
    await downloadFile(resolved.url, installerJar, {
      onProgress: (p) => report('download', 4 + (p.percent || 0) * 0.2, `Descargando instalador... ${Math.round(p.percent || 0)}%`),
    });
    report('install', 26, 'Instalando Fabric (esto puede tardar)...');
    await runJava(
      ['-jar', installerJar, 'server', '-mcversion', server.version, '-loader', resolved.loaderVersion, '-downloadMinecraft'],
      {
        cwd: dir,
        javaPath: javaInfo.path,
        onLine: (line) => report('install', 55, line.slice(0, 120)),
      }
    );
    fs.rmSync(installerJar, { force: true });
    if (!fs.existsSync(path.join(dir, 'fabric-server-launch.jar'))) {
      throw new Error('Fabric no generó fabric-server-launch.jar. Revisa la versión seleccionada.');
    }
  } else if (resolved.kind === 'bedrock-zip') {
    if (process.platform === 'win32' && !resolved.url.includes('bin-win')) {
      throw new Error('El servidor Bedrock solo está disponible para Windows y Linux x64');
    }
    const zipFile = path.join(dir, '.bedrock-download.zip');
    report('download', 4, `Descargando Bedrock ${resolved.version}...`);
    await downloadFile(resolved.url, zipFile, {
      onProgress: (p) => report('download', 4 + (p.percent || 0) * 0.7, `Descargando Bedrock... ${Math.round(p.percent || 0)}%`),
    });
    report('extract', 80, 'Extrayendo servidor Bedrock...');
    await extractZip(zipFile, dir, {
      onProgress: (done, total) => report('extract', 80 + (done / Math.max(1, total)) * 15, `Extrayendo archivos (${done}/${total})...`),
    });
    fs.rmSync(zipFile, { force: true });
    server.version = resolved.version || server.version;
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(path.join(dir, 'bedrock_server'), 0o755);
      } catch {
        /* opcional */
      }
    }
  }

  report('config', 96, 'Escribiendo configuración...');
  if (server.edition === 'java') {
    fs.writeFileSync(path.join(dir, 'eula.txt'), `# Aceptado desde CraftPanel\n# ${new Date().toISOString()}\neula=true\n`, 'utf8');
    server.eulaAccepted = true;
  } else if (acceptEula) {
    server.eulaAccepted = true;
  }
  writeInitialProperties(server, dir);
  writeStartScripts(server, dir);

  server.installed = true;
  server.javaMin = required || null;
  server.installedAt = new Date().toISOString();
  servers.writeMeta(dir, { ...server, dir: undefined });

  report('done', 100, '¡Servidor creado!');
  return { ...server, dir };
}

module.exports = { install, writeStartScripts, writeInitialProperties };
