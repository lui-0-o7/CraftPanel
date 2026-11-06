'use strict';

/* Prueba E2E de Bedrock: electron scripts/e2e-bedrock.js --user-data-dir=<temp> */

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

  console.log('Perfil:', app.getPath('userData'));
  let managerRef = null;
  let logRef = [];

  try {
    const { meta, dir } = servers.create({
      name: 'Bedrock de prueba',
      edition: 'bedrock',
      software: 'bedrock',
      version: '',
      port: 19142,
      ramMB: 1024,
      motd: 'Bedrock CraftPanel',
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
    console.log('Instalado. Versión:', installed.version);
    const files = fs.readdirSync(dir);
    console.log('Archivos:', files.slice(0, 12).join(', '));
    if (!files.includes('bedrock_server.exe')) throw new Error('Falta bedrock_server.exe');

    const manager = new ServerManager();
    managerRef = manager;
    const logs = [];
    logRef = logs;
    manager.on('log', (entry) => {
      logs.push(entry.line);
      if (logs.length > 200) logs.shift();
    });
    let ready = false;
    manager.on('status', (status) => {
      if (status.status === 'running') ready = true;
    });

    console.log('Arrancando Bedrock...');
    await manager.start(meta.id);
    await waitFor(() => ready, 120000, 'Bedrock en línea');
    console.log('Bedrock en línea.');

    manager.send(meta.id, 'list');
    await sleep(2500);

    console.log('Parando Bedrock...');
    await manager.stop(meta.id, 60000);
    await waitFor(() => !manager.isRunning(meta.id), 20000, 'Bedrock detenido');
    console.log('Detenido. Últimas líneas:', logs.slice(-3).join(' | '));

    if (!fs.existsSync(path.join(dir, 'worlds'))) throw new Error('No se creó la carpeta worlds');

    console.log('Creando copia...');
    const created = await backup.create(installed, {});
    console.log('Copia:', created.name, created.size, 'bytes');
    if (!backup.list(installed).length) throw new Error('Copia no listada');

    console.log('\nBEDROCK E2E: TODO CORRECTO');
    app.exit(0);
  } catch (error) {
    console.error('\nBEDROCK E2E FALLÓ:', error && error.stack ? error.stack : error);
    console.error('Estado:', managerRef ? JSON.stringify(managerRef.getStatus(managerRef.runtimes.keys().next().value)) : 'n/a');
    console.error('Últimas líneas:\n' + logRef.slice(-25).join('\n'));
    app.exit(1);
  }
});
