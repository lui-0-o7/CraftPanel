'use strict';

/* Pruebas del núcleo ejecutadas dentro de Electron: electron scripts/selftest.js */

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();

const results = [];
function ok(name, extra = '') {
  results.push({ status: 'OK', name, extra });
  console.log(`OK   ${name} ${extra}`);
}
function fail(name, error) {
  results.push({ status: 'FAIL', name, extra: String(error && error.stack ? error.stack : error) });
  console.log(`FAIL ${name}: ${error}`);
}

async function test(name, fn) {
  try {
    const extra = await fn();
    ok(name, extra ? String(extra) : '');
  } catch (error) {
    fail(name, error);
  }
}

app.whenReady().then(async () => {
  const properties = require('../src/core/properties');
  const { ZipWriter, extractZip, listZip } = require('../src/core/zip');
  const versions = require('../src/core/versions');
  const java = require('../src/core/java');
  const network = require('../src/core/network');
  const upnp = require('../src/core/upnp');
  const { downloadFile } = require('../src/core/download');

  await test('properties: parsear y conservar comentarios', () => {
    const original = '# comentario\nmotd=Hola mundo\nserver-port=25565\npvp=true\n';
    const parsed = properties.parse(original);
    if (parsed.map.motd !== 'Hola mundo') throw new Error('motd mal parseado');
    const updated = properties.setValues(original, { motd: 'Nuevo = valor', 'max-players': '30' });
    const again = properties.parse(updated);
    if (again.map.motd !== 'Nuevo = valor') throw new Error('motd no actualizado');
    if (again.map['max-players'] !== '30') throw new Error('clave nueva no añadida');
    if (!updated.includes('# comentario')) throw new Error('comentario perdido');
    return 'ok';
  });

  await test('zip: crear, listar y extraer', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'craftpanel-zip-'));
    const source = path.join(base, 'source');
    fs.mkdirSync(path.join(source, 'world', 'region'), { recursive: true });
    fs.writeFileSync(path.join(source, 'server.properties'), 'motd=zip test\n');
    fs.writeFileSync(path.join(source, 'world', 'level.dat'), Buffer.from([1, 2, 3, 4, 5]));
    fs.writeFileSync(path.join(source, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(4096, 7));

    const zipFile = path.join(base, 'test.zip');
    const writer = new ZipWriter(zipFile);
    writer.addDirectory(source);
    writer.close();

    const entries = listZip(zipFile);
    if (entries.length !== 3) throw new Error(`se esperaban 3 entradas, hay ${entries.length}`);

    const target = path.join(base, 'out');
    await extractZip(zipFile, target);
    const props = fs.readFileSync(path.join(target, 'server.properties'), 'utf8');
    if (!props.includes('zip test')) throw new Error('server.properties mal extraído');
    const region = fs.readFileSync(path.join(target, 'world', 'region', 'r.0.0.mca'));
    if (region.length !== 4096 || region[0] !== 7) throw new Error('archivo grande mal extraído');
    fs.rmSync(base, { recursive: true, force: true });
    return `${entries.length} archivos`;
  });

  await test('java: detectar instalaciones', () => {
    const list = java.detect();
    if (!list.length) throw new Error('no se detectó Java');
    return list.map((j) => `${j.vendor} ${j.version}`).join(' | ');
  });

  await test('versiones: Paper', async () => {
    const data = await versions.listVersions({ edition: 'java', software: 'paper' });
    if (!data.versions.length) throw new Error('lista vacía');
    return `${data.versions.length} versiones, última ${data.versions[0].id}`;
  });

  await test('versiones: Vanilla', async () => {
    const data = await versions.listVersions({ edition: 'java', software: 'vanilla' });
    if (!data.versions.length) throw new Error('lista vacía');
    return `${data.versions.length} versiones, última ${data.versions[0].id}`;
  });

  await test('versiones: Bedrock', async () => {
    const data = await versions.listVersions({ edition: 'bedrock', software: 'bedrock' });
    return data.versions.map((v) => v.id).join(', ');
  });

  await test('resolver: Paper descarga', async () => {
    const resolved = await versions.resolveServer({ software: 'paper', version: '1.21.8' });
    if (!/^https:\/\//.test(resolved.url)) throw new Error('URL inválida');
    return `${resolved.fileName} (${resolved.size} bytes, java ${resolved.javaMin})`;
  });

  await test('resolver: Fabric', async () => {
    const resolved = await versions.resolveServer({ software: 'fabric', version: '1.21.8' });
    if (!resolved.loaderVersion) throw new Error('sin loader');
    return `loader ${resolved.loaderVersion}`;
  });

  await test('resolver: Bedrock', async () => {
    const resolved = await versions.resolveServer({ software: 'bedrock', version: '' });
    if (!/bedrock-server-.*\.zip/.test(resolved.fileName)) throw new Error('archivo inesperado');
    return resolved.fileName;
  });

  await test('descarga: archivo pequeño', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'craftpanel-dl-'));
    const target = path.join(base, 'fabric-installer.jar');
    let last = 0;
    await downloadFile('https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar', target, {
      onProgress: (p) => {
        last = p.percent;
      },
    });
    const size = fs.statSync(target).size;
    if (size < 100000) throw new Error('descarga incompleta');
    fs.rmSync(base, { recursive: true, force: true });
    return `${size} bytes (${Math.round(last)}%)`;
  });

  await test('red: IP local y puerto libre', async () => {
    const lan = network.lanAddresses();
    if (!lan.length) throw new Error('sin interfaces');
    const free = await network.isPortFree(25565);
    return `${lan[0].address} · puerto 25565 ${free ? 'libre' : 'ocupado'}`;
  });

  await test('upnp: descubrir router', async () => {
    const info = await upnp.gatewayInfo();
    return info.found ? `router encontrado, IP ${info.externalIp || 'desconocida'}` : 'sin router UPnP';
  });

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\nRESUMEN: ${results.length - failed.length}/${results.length} pruebas correctas`);
  app.exit(failed.length ? 1 : 0);
});
