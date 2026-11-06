'use strict';

/* Prueba E2E de Fabric: electron scripts/e2e-fabric.js --user-data-dir=<temp> */

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
  const servers = require('../src/core/servers');
  const installer = require('../src/core/installer');
  const { ServerManager } = require('../src/core/processes');

  let managerRef = null;
  let logRef = [];

  try {
    const { meta, dir } = servers.create({
      name: 'Fabric de prueba',
      edition: 'java',
      software: 'fabric',
      version: '1.21.8',
      port: 25601,
      ramMB: 2048,
      motd: 'Fabric CraftPanel',
      onlineMode: false,
      eulaAccepted: true,
    });

    let phase = '';
    const installed = await installer.install({
      server: meta,
      dir,
      acceptEula: true,
      onProgress: (progress) => {
        if (progress.phase !== phase) {
          phase = progress.phase;
          console.log(`  [${progress.phase}] ${Math.round(progress.percent)}% ${progress.message || ''}`);
        }
      },
    });
    const files = fs.readdirSync(dir);
    console.log('Instalado. Archivos:', files.join(', '));
    if (!files.includes('fabric-server-launch.jar')) throw new Error('Falta fabric-server-launch.jar');

    const manager = new ServerManager();
    managerRef = manager;
    const logs = [];
    logRef = logs;
    manager.on('log', (entry) => {
      logs.push(entry.line);
      if (logs.length > 300) logs.shift();
    });
    let ready = false;
    manager.on('status', (status) => {
      if (status.status === 'running') ready = true;
    });

    console.log('Arrancando Fabric...');
    await manager.start(meta.id);
    await waitFor(() => ready, 180000, 'Fabric en línea');
    console.log('Fabric en línea.');

    manager.send(meta.id, 'list');
    await sleep(2000);

    console.log('Parando Fabric...');
    await manager.stop(meta.id, 90000);
    await waitFor(() => !manager.isRunning(meta.id), 30000, 'Fabric detenido');
    console.log('Detenido.');

    if (!fs.existsSync(path.join(dir, 'world', 'level.dat'))) throw new Error('No se generó el mundo');

    console.log('\nFABRIC E2E: TODO CORRECTO');
    app.exit(0);
  } catch (error) {
    console.error('\nFABRIC E2E FALLÓ:', error && error.stack ? error.stack : error);
    console.error('Últimas líneas:\n' + logRef.slice(-30).join('\n'));
    app.exit(1);
  }
});
