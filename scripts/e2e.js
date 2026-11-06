'use strict';

/* Prueba completa: crear, instalar, arrancar, parar y respaldar un servidor Paper.
   Uso: electron scripts/e2e.js --user-data-dir=<carpeta temporal> */

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await sleep(500);
  }
  throw new Error(`Tiempo de espera agotado: ${label}`);
}

app.whenReady().then(async () => {
  const store = require('../src/core/store');
  const servers = require('../src/core/servers');
  const installer = require('../src/core/installer');
  const backup = require('../src/core/backup');
  const { ServerManager } = require('../src/core/processes');

  const dir = store.serversDir();
  console.log('Perfil de pruebas:', app.getPath('userData'));
  console.log('Servidores en:', dir);

  try {
    const { meta, dir: serverDir } = servers.create({
      name: 'Servidor de prueba',
      edition: 'java',
      software: 'paper',
      version: '1.21.8',
      port: 25599,
      ramMB: 2048,
      motd: 'Prueba de CraftPanel',
      onlineMode: false,
      eulaAccepted: true,
    });
    console.log('Creado:', meta.id, serverDir);

    let lastPhase = '';
    const installed = await installer.install({
      server: meta,
      dir: serverDir,
      acceptEula: true,
      onProgress: (progress) => {
        if (progress.phase !== lastPhase || progress.percent > 99) {
          lastPhase = progress.phase;
          console.log(`  [${progress.phase}] ${Math.round(progress.percent)}% ${progress.message || ''}`);
        }
      },
    });
    console.log('Instalado. Archivos:', fs.readdirSync(serverDir).join(', '));
    if (!fs.existsSync(path.join(serverDir, 'server.jar'))) throw new Error('Falta server.jar');
    if (!fs.existsSync(path.join(serverDir, 'eula.txt'))) throw new Error('Falta eula.txt');

    const manager = new ServerManager();
    const logs = [];
    manager.on('log', (entry) => {
      logs.push(entry.line);
      if (logs.length > 400) logs.shift();
    });
    let ready = false;
    manager.on('status', (status) => {
      if (status.status === 'running') ready = true;
    });

    console.log('Arrancando servidor...');
    await manager.start(meta.id);
    await waitFor(() => ready, 180000, 'servidor en línea');
    console.log('Servidor en línea. PID:', manager.getStatus(meta.id).pid);

    manager.send(meta.id, 'list');
    await sleep(2500);

    console.log('Parando servidor...');
    await manager.stop(meta.id, 90000);
    await waitFor(() => !manager.isRunning(meta.id), 30000, 'servidor detenido');
    console.log('Detenido correctamente. Última línea:', logs[logs.length - 1]);

    const worldDir = path.join(serverDir, 'world');
    if (!fs.existsSync(worldDir)) throw new Error('El servidor no generó la carpeta world');
    console.log('Mundo generado:', fs.readdirSync(worldDir).slice(0, 8).join(', '));

    console.log('Creando copia de seguridad...');
    const created = await backup.create(installed, {
      onProgress: (progress) => {
        if (progress.percent > 99) console.log(`  copia: ${progress.message}`);
      },
    });
    console.log('Copia creada:', created.name, created.size, 'bytes');

    const list = backup.list(installed);
    if (!list.length) throw new Error('La copia no aparece en la lista');
    console.log('Copias:', list.length, list[0].name);

    console.log('Restaurando copia...');
    await backup.restore(installed, created.name);
    if (!fs.existsSync(path.join(serverDir, 'world', 'level.dat'))) {
      throw new Error('La restauración no recuperó level.dat');
    }
    console.log('Restauración correcta.');

    const propsFile = path.join(serverDir, 'server.properties');
    const properties = require('../src/core/properties');
    const text = fs.readFileSync(propsFile, 'utf8');
    fs.writeFileSync(propsFile, properties.setValues(text, { motd: 'MOTD actualizado' }), 'utf8');
    if (!fs.readFileSync(propsFile, 'utf8').includes('MOTD actualizado')) throw new Error('No se pudo editar el MOTD');
    console.log('Propiedades editadas correctamente.');

    console.log('\nE2E: TODO CORRECTO');
    app.exit(0);
  } catch (error) {
    console.error('\nE2E FALLÓ:', error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
