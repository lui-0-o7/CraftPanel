'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const store = require('./src/core/store');
const servers = require('./src/core/servers');
const installer = require('./src/core/installer');
const versions = require('./src/core/versions');
const java = require('./src/core/java');
const properties = require('./src/core/properties');
const backup = require('./src/core/backup');
const network = require('./src/core/network');
const upnp = require('./src/core/upnp');
const { ServerManager } = require('./src/core/processes');
const { TunnelManager } = require('./src/core/tunnel');

const manager = new ServerManager();
const tunnels = new TunnelManager();

let win = null;
let quitting = false;
let shuttingDown = false;

async function shutdownServers() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await manager.shutdownAll();
  } catch {
    /* si algún servidor no responde, se fuerza el cierre igualmente */
  }
  tunnels.stop();
  shuttingDown = false;
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

manager.on('status', (status) => broadcast('server:status', status));
manager.on('log', (entry) => broadcast('server:log', entry));
tunnels.on('status', (status) => broadcast('tunnel:status', status));

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0d1117',
    title: 'CraftPanel',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', async (event) => {
    if (shuttingDown) {
      event.preventDefault();
      return;
    }
    const running = servers.list().filter((s) => manager.isRunning(s.id));
    if (!quitting && running.length) {
      event.preventDefault();
      const answer = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Detener y salir', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: 'Servidores en ejecución',
        message: `Hay ${running.length} servidor(es) en ejecución.`,
        detail: 'Si sales ahora se detendrán para guardar el mundo correctamente.',
      });
      if (answer === 0) {
        quitting = true;
        await shutdownServers();
        win.destroy();
      }
    } else if (!quitting) {
      tunnels.stop();
    }
  });
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown) {
    event.preventDefault();
    return;
  }
  if (quitting) return;
  const running = servers.list().filter((s) => manager.isRunning(s.id));
  if (!running.length) return;
  event.preventDefault();
  quitting = true;
  shutdownServers().finally(() => app.quit());
});

/* ----------------------------- Aplicación ----------------------------- */

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  userData: app.getPath('userData'),
  serversDir: store.serversDir(),
  config: store.load(),
  java: [],
  cloudflared: tunnels.available(),
}));

ipcMain.handle('app:openExternal', async (_event, url) => {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('Enlace no permitido');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:openPath', async (_event, target) => {
  const error = await shell.openPath(String(target));
  if (error) throw new Error(error);
  return true;
});

/* ------------------------------ Ajustes ------------------------------- */

ipcMain.handle('config:get', async () => store.load());
ipcMain.handle('config:set', async (_event, patch) => {
  const next = store.save(patch || {});
  broadcast('config:changed', next);
  return next;
});

ipcMain.handle('config:pick', async (_event, kind) => {
  if (kind === 'java') {
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecciona el ejecutable de Java',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  }
  if (kind === 'cloudflared') {
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecciona cloudflared',
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  }
  if (kind === 'serversDir') {
    const result = await dialog.showOpenDialog(win, {
      title: 'Carpeta donde guardar los servidores',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    store.save({ serversDir: result.filePaths[0] });
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('java:detect', async (_event, force) => java.detect(Boolean(force)));

/* ------------------------------ Servidores ---------------------------- */

function withStatus(server) {
  return { ...server, runtime: manager.getStatus(server.id) };
}

ipcMain.handle('servers:list', async () => servers.list().map(withStatus));

ipcMain.handle('servers:get', async (_event, id) => {
  const server = servers.requireServer(id);
  return withStatus(server);
});

ipcMain.handle('servers:create', async (_event, options) => {
  const opts = options || {};
  if (opts.edition === 'bedrock') {
    if (opts.software !== 'bedrock') throw new Error('Software no válido para Bedrock');
  } else if (!['paper', 'vanilla', 'fabric'].includes(opts.software)) {
    throw new Error('Software no válido para Java');
  }

  const { port } = servers.validate(opts);
  const conflict = servers.portInUse(port);
  if (conflict) throw new Error(`El puerto ${port} ya lo usa el servidor "${conflict.name}"`);
  if (!(await network.isPortFree(port))) {
    throw new Error(`El puerto ${port} está ocupado por otro programa. Prueba con otro.`);
  }

  const { meta, dir } = servers.create(opts);
  try {
    const installed = await installer.install({
      server: meta,
      dir,
      acceptEula: opts.eulaAccepted === true,
      onProgress: (progress) => broadcast('install:progress', { serverId: meta.id, ...progress }),
    });
    return { ...installed, dir };
  } catch (err) {
    try {
      servers.remove(meta.id, { deleteFiles: true });
    } catch {
      /* ignora */
    }
    throw err;
  }
});

ipcMain.handle('servers:reinstall', async (_event, id, options = {}) => {
  const server = servers.requireServer(id);
  if (manager.isRunning(id)) throw new Error('Detén el servidor antes de reinstalar');
  const merged = { ...server, ...(options.version ? { version: options.version } : {}) };
  const result = await installer.install({
    server: merged,
    dir: server.dir,
    acceptEula: true,
    onProgress: (progress) => broadcast('install:progress', { serverId: id, ...progress }),
  });
  return withStatus(result);
});

ipcMain.handle('servers:update', async (_event, id, patch) => {
  const server = servers.requireServer(id);
  const touchesProperties =
    patch.port !== undefined || patch.motd !== undefined || patch.onlineMode !== undefined;
  if (touchesProperties && manager.isRunning(id)) {
    throw new Error('Detén el servidor antes de cambiar el puerto, el MOTD o el modo online');
  }
  if (patch.port !== undefined && Number(patch.port) !== Number(server.port)) {
    if (manager.isRunning(id)) throw new Error('Detén el servidor antes de cambiar el puerto');
    const conflict = servers.portInUse(patch.port, id);
    if (conflict) throw new Error(`El puerto ya lo usa "${conflict.name}"`);
    if (!(await network.isPortFree(patch.port))) throw new Error('El puerto está ocupado por otro programa');
  }
  const updated = servers.update(id, patch);
  if (patch.port !== undefined || patch.motd !== undefined || patch.onlineMode !== undefined) {
    const propsFile = path.join(server.dir, 'server.properties');
    if (fs.existsSync(propsFile)) {
      const text = fs.readFileSync(propsFile, 'utf8');
      const patchProps = {};
      if (patch.port !== undefined) patchProps['server-port'] = String(patch.port);
      if (patch.motd !== undefined) {
        patchProps[server.edition === 'bedrock' ? 'server-name' : 'motd'] = patch.motd;
      }
      if (patch.onlineMode !== undefined) patchProps['online-mode'] = patch.onlineMode ? 'true' : 'false';
      fs.writeFileSync(propsFile, properties.setValues(text, patchProps), 'utf8');
    }
  }
  return withStatus(updated);
});

ipcMain.handle('servers:delete', async (_event, id, deleteFiles = true) => {
  const server = servers.requireServer(id);
  if (manager.isRunning(id)) await manager.stop(id, 20000);
  if (tunnels.status().serverId === id) tunnels.stop();
  servers.remove(id, { deleteFiles });
  return true;
});

ipcMain.handle('servers:start', async (_event, id) => {
  const server = servers.requireServer(id);
  const status = await manager.start(id);
  servers.update(id, { lastStartedAt: new Date().toISOString() });
  return status;
});

ipcMain.handle('servers:stop', async (_event, id) => manager.stop(id));
ipcMain.handle('servers:kill', async (_event, id) => {
  manager.kill(id);
  return true;
});
ipcMain.handle('servers:command', async (_event, id, command) => {
  const clean = String(command || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return false;
  manager.send(id, clean);
  return true;
});
ipcMain.handle('servers:status', async (_event, id) => manager.getStatus(id));
ipcMain.handle('servers:logs', async (_event, id, limit) => manager.getLogs(id, limit || 600));
ipcMain.handle('servers:openFolder', async (_event, id) => {
  const server = servers.requireServer(id);
  const error = await shell.openPath(server.dir);
  if (error) throw new Error(error);
  return true;
});

/* ---------------------------- Propiedades ----------------------------- */

ipcMain.handle('props:read', async (_event, id) => {
  const server = servers.requireServer(id);
  const file = path.join(server.dir, 'server.properties');
  if (!fs.existsSync(file)) throw new Error('El archivo server.properties no existe todavía');
  const text = fs.readFileSync(file, 'utf8');
  return {
    text,
    values: properties.parse(text).map,
    schema: server.edition === 'bedrock' ? properties.BEDROCK_EDITABLE : properties.JAVA_EDITABLE,
    running: manager.isRunning(id),
  };
});

ipcMain.handle('props:save', async (_event, id, payload) => {
  const server = servers.requireServer(id);
  if (manager.isRunning(id)) {
    throw new Error(
      'Detén el servidor antes de editar server.properties. Si no, Minecraft sobrescribirá los cambios al apagarse.'
    );
  }
  const file = path.join(server.dir, 'server.properties');
  let text = String(payload?.text ?? '');
  if (payload?.values && typeof payload.values === 'object') {
    text = properties.setValues(text, payload.values);
  }
  fs.writeFileSync(file, text, 'utf8');
  const map = properties.parse(text).map;
  const patch = {};
  if (map['server-port'] && Number(map['server-port']) !== Number(server.port)) {
    patch.port = Number(map['server-port']);
  }
  const motd = server.edition === 'bedrock' ? map['server-name'] : map['motd'];
  if (motd !== undefined && motd !== server.motd) patch.motd = motd;
  if (map['online-mode'] !== undefined) patch.onlineMode = map['online-mode'] === 'true';
  if (Object.keys(patch).length) servers.update(id, patch);
  return { ok: true, running: manager.isRunning(id) };
});

/* ------------------------------ Copias -------------------------------- */

ipcMain.handle('backups:list', async (_event, id) => {
  const server = servers.requireServer(id);
  return backup.list(server);
});

ipcMain.handle('backups:create', async (_event, id) => {
  const server = servers.requireServer(id);
  if (manager.isRunning(id)) throw new Error('Detén el servidor antes de crear una copia (así el mundo queda consistente)');
  return backup.create(server, {
    onProgress: (progress) => broadcast('backup:progress', { serverId: id, ...progress }),
  });
});

ipcMain.handle('backups:restore', async (_event, id, name) => {
  const server = servers.requireServer(id);
  if (manager.isRunning(id)) throw new Error('Detén el servidor antes de restaurar una copia');
  try {
    await backup.create(server, {
      onProgress: (progress) => broadcast('backup:progress', { serverId: id, ...progress, safety: true }),
    });
  } catch {
    /* si aún no hay mundo no se puede crear la copia de seguridad */
  }
  return backup.restore(server, name, {
    onProgress: (progress) => broadcast('backup:progress', { serverId: id, ...progress }),
  });
});

ipcMain.handle('backups:remove', async (_event, id, name) => {
  const server = servers.requireServer(id);
  return backup.remove(server, name);
});

ipcMain.handle('backups:open', async (_event, id) => {
  const server = servers.requireServer(id);
  const error = await shell.openPath(backup.backupsDir(server));
  if (error) throw new Error(error);
  return true;
});

/* -------------------------------- Red --------------------------------- */

ipcMain.handle('net:info', async () => ({
  lan: network.lanAddresses(),
  primary: await network.primaryAddress(),
}));

ipcMain.handle('net:extra', async () => {
  const [publicIp, gateway] = await Promise.all([
    network.publicIp(),
    upnp.gatewayInfo().catch(() => ({ found: false, externalIp: '' })),
  ]);
  return { publicIp, gateway };
});

ipcMain.handle('net:checkPort', async (_event, port) => network.isPortFree(Number(port)));

ipcMain.handle('net:checkPublic', async (_event, { host, port, edition }) => {
  if (!host) throw new Error('Todavía no se conoce tu IP pública');
  const base = edition === 'bedrock' ? 'https://api.mcsrvstat.us/bedrock/3' : 'https://api.mcsrvstat.us/3';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${base}/${encodeURIComponent(host)}:${Number(port)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CraftPanel/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`El servicio de comprobación respondió ${res.status}`);
    const data = await res.json();
    return {
      online: Boolean(data.online),
      players: data.players?.online ?? null,
      maxPlayers: data.players?.max ?? null,
      version: data.version || '',
      motd: Array.isArray(data.motd?.clean) ? data.motd.clean.join(' ') : '',
    };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('net:openPorts', async (_event, { port, description }) => {
  const internalIp = await network.primaryAddress();
  const result = await upnp.openPorts({
    port: Number(port),
    internalIp,
    description: description || 'CraftPanel Minecraft',
  });
  return { ...result, internalIp };
});

ipcMain.handle('net:closePorts', async (_event, port) => upnp.closePorts({ port: Number(port) }));

/* ------------------------------ Túnel --------------------------------- */

ipcMain.handle('tunnel:status', async () => tunnels.status());
ipcMain.handle('tunnel:available', async () => tunnels.available());
ipcMain.handle('tunnel:start', async (_event, id) => {
  const server = servers.requireServer(id);
  if (server.edition === 'bedrock') {
    throw new Error(
      'El túnel de Cloudflare no es compatible con Bedrock (usa UDP). Abre el puerto UDP con UPnP o manualmente en el router.'
    );
  }
  return tunnels.start(server);
});
ipcMain.handle('tunnel:stop', async () => tunnels.stop());

/* ------------------------------ Versiones ----------------------------- */

ipcMain.handle('servers:uploadWorld', async (_event, id) => {
  const server = servers.requireServer(id);
  const result = dialog.showOpenDialogSync(win, {
    title: 'Seleccionar mundo de Bedrock (Carpeta, ZIP o .mcworld)',
    properties: ['openDirectory', 'openFile'],
    filters: [
      { name: 'Mundos de Minecraft / ZIP', extensions: ['zip', 'mcworld'] },
      { name: 'Todas las carpetas / archivos', extensions: ['*'] }
    ]
  });
  if (!result || !result.length) return false;
  const targetPath = result[0];
  const stats = fs.statSync(targetPath);

  const worldsDir = path.join(server.dir, 'worlds');
  fs.mkdirSync(worldsDir, { recursive: true });

  const worldName = 'Bedrock level';
  const worldDest = path.join(worldsDir, worldName);

  try {
    if (stats.isDirectory()) {
      fs.rmSync(worldDest, { recursive: true, force: true });
      fs.cpSync(targetPath, worldDest, { recursive: true });
    } else {
      const ext = path.extname(targetPath).toLowerCase();
      if (ext === '.zip' || ext === '.mcworld') {
        const { extractZip } = require('./src/core/zip');
        const tempExtractDir = path.join(server.dir, 'temp_world_extract');
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
        fs.mkdirSync(tempExtractDir, { recursive: true });
        await extractZip(targetPath, tempExtractDir);

        // Buscar recursivamente un archivo level.dat
        function findLevelDat(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = findLevelDat(fullPath);
              if (found) return found;
            } else if (entry.isFile() && entry.name.toLowerCase() === 'level.dat') {
              return dir;
            }
          }
          return null;
        }

        const worldDir = findLevelDat(tempExtractDir);
        if (worldDir) {
          fs.rmSync(worldDest, { recursive: true, force: true });
          fs.mkdirSync(worldDest, { recursive: true });
          fs.cpSync(worldDir, worldDest, { recursive: true });
        } else {
          const entries = fs.readdirSync(tempExtractDir, { withFileTypes: true });
          const dirs = entries.filter(e => e.isDirectory());
          if (dirs.length === 1) {
            fs.rmSync(worldDest, { recursive: true, force: true });
            fs.mkdirSync(worldDest, { recursive: true });
            fs.cpSync(path.join(tempExtractDir, dirs[0].name), worldDest, { recursive: true });
          } else {
            throw new Error('No se encontró un mundo válido en el archivo ZIP. Debe contener un archivo level.dat.');
          }
        }

        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      } else {
        throw new Error('Formato de archivo no válido. Debe ser una carpeta, un ZIP o un .mcworld');
      }
    }
  } catch (err) {
    const tempExtractDir = path.join(server.dir, 'temp_world_extract');
    fs.rmSync(tempExtractDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return true;
});

ipcMain.handle('versions:list', async (_event, payload) =>
  versions.listVersions({ edition: payload?.edition || 'java', software: payload?.software || 'paper' })
);
