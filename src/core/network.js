'use strict';

const os = require('node:os');
const net = require('node:net');

function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      out.push({ iface: name, address: item.address, mac: item.mac });
    }
  }
  return out;
}

function primaryAddress() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '8.8.8.8', port: 80 });
    const done = (value) => {
      try {
        socket.destroy();
      } catch {
        /* ignora */
      }
      resolve(value);
    };
    socket.setTimeout(1500, () => done(lanAddresses()[0]?.address || '127.0.0.1'));
    socket.on('connect', () => done(socket.localAddress));
    socket.on('error', () => done(lanAddresses()[0]?.address || '127.0.0.1'));
  });
}

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen({ port: Number(port), host, exclusive: true });
  });
}

let publicCache = { at: 0, ip: '' };

async function publicIp(force = false) {
  if (!force && publicCache.ip && Date.now() - publicCache.at < 5 * 60 * 1000) return publicCache.ip;
  const endpoints = ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json'];
  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.ip) {
        publicCache = { at: Date.now(), ip: data.ip };
        return data.ip;
      }
    } catch {
      /* prueba el siguiente */
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

module.exports = { lanAddresses, primaryAddress, isPortFree, publicIp };
