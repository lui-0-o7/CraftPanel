'use strict';

const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'upnp:rootdevice',
  'ssdp:all',
];

let discoveryCache = { at: 0, locations: [] };

function discover(timeoutMs = 3500) {
  if (discoveryCache.locations.length && Date.now() - discoveryCache.at < 60000) {
    return Promise.resolve(discoveryCache.locations);
  }
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const locations = new Set();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        /* ignora */
      }
      const list = [...locations];
      discoveryCache = { at: Date.now(), locations: list };
      resolve(list);
    };

    socket.on('message', (data) => {
      const text = data.toString('utf8');
      const match = /LOCATION:\s*(\S+)/i.exec(text);
      if (match) locations.add(match[1].trim());
    });
    socket.on('error', finish);
    socket.bind(() => {
      for (const st of SEARCH_TARGETS) {
        const message = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'MX: 2',
            `ST: ${st}`,
            '',
            '',
          ].join('\r\n')
        );
        try {
          socket.send(message, 1900, '239.255.255.250');
        } catch {
          /* ignora */
        }
      }
    });
    setTimeout(finish, timeoutMs);
  });
}

function fetchText(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('URL del router no válida'));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { 'User-Agent': 'CraftPanel/1.0' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchText(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 512 * 1024) req.destroy(new Error('Respuesta del router demasiado grande'));
        });
        res.on('end', () => resolve(data));
      }
    );
    req.on('timeout', () => req.destroy(new Error('El router no respondió')));
    req.on('error', reject);
  });
}

function soap(controlURL, serviceType, action, innerXml, timeoutMs = 8000) {
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${innerXml}</u:${action}></s:Body>` +
    '</s:Envelope>';

  return new Promise((resolve, reject) => {
    const parsed = new URL(controlURL);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      controlURL,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${serviceType}#${action}"`,
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'CraftPanel/1.0',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else {
            const code = /<errorCode>(\d+)<\/errorCode>/.exec(data)?.[1];
            reject(new Error(`El router rechazó la operación (${res.statusCode}${code ? ` / ${code}` : ''})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('El router no respondió')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function findService(xml, baseUrl) {
  const serviceRegex = /<service>([\s\S]*?)<\/service>/gi;
  let match;
  while ((match = serviceRegex.exec(xml))) {
    const block = match[1];
    const type = /<serviceType>([\s\S]*?)<\/serviceType>/i.exec(block)?.[1]?.trim();
    const control = /<controlURL>([\s\S]*?)<\/controlURL>/i.exec(block)?.[1]?.trim();
    if (!type || !control) continue;
    if (!/WAN(IP|PPP)Connection:\d/i.test(type)) continue;
    let controlURL;
    try {
      controlURL = new URL(control, baseUrl).toString();
    } catch {
      continue;
    }
    return { serviceType: type, controlURL };
  }
  return null;
}

async function findGateway() {
  const locations = await discover();
  for (const location of locations) {
    try {
      const xml = await fetchText(location);
      const urlBase = /<URLBase>([\s\S]*?)<\/URLBase>/i.exec(xml)?.[1]?.trim();
      const service = findService(xml, urlBase || location);
      if (service) return { ...service, location };
    } catch {
      /* siguiente router */
    }
  }
  return null;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getExternalIp(gateway) {
  try {
    const xml = await soap(
      gateway.controlURL,
      gateway.serviceType,
      'GetExternalIPAddress',
      '<NewRemoteHost></NewRemoteHost>'
    );
    return /<NewExternalIPAddress>([\s\S]*?)<\/NewExternalIPAddress>/i.exec(xml)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

async function deleteMapping(gateway, port, protocol) {
  try {
    await soap(
      gateway.controlURL,
      gateway.serviceType,
      'DeletePortMapping',
      '<NewRemoteHost></NewRemoteHost>' +
        `<NewExternalPort>${port}</NewExternalPort>` +
        `<NewProtocol>${protocol}</NewProtocol>`
    );
    return true;
  } catch {
    return false;
  }
}

async function addMapping(gateway, { port, protocol, internalIp, description }) {
  await deleteMapping(gateway, port, protocol);
  await soap(
    gateway.controlURL,
    gateway.serviceType,
    'AddPortMapping',
    '<NewRemoteHost></NewRemoteHost>' +
      `<NewExternalPort>${port}</NewExternalPort>` +
      `<NewProtocol>${protocol}</NewProtocol>` +
      `<NewInternalPort>${port}</NewInternalPort>` +
      `<NewInternalClient>${escapeXml(internalIp)}</NewInternalClient>` +
      '<NewEnabled>1</NewEnabled>' +
      `<NewPortMappingDescription>${escapeXml(description)}</NewPortMappingDescription>` +
      '<NewLeaseDuration>0</NewLeaseDuration>'
  );
}

async function openPorts({ port, internalIp, description }) {
  const gateway = await findGateway();
  if (!gateway) {
    return {
      ok: false,
      error: 'No se encontró un router compatible con UPnP. Abre el puerto manualmente en tu router.',
      results: [],
    };
  }
  const results = [];
  for (const protocol of ['TCP', 'UDP']) {
    try {
      await addMapping(gateway, { port, protocol, internalIp, description });
      results.push({ protocol, ok: true });
    } catch (err) {
      results.push({ protocol, ok: false, error: err.message });
    }
  }
  const externalIp = await getExternalIp(gateway);
  const anyOk = results.some((r) => r.ok);
  return {
    ok: anyOk,
    externalIp,
    results,
    error: anyOk ? '' : results.map((r) => `${r.protocol}: ${r.error}`).join(' · '),
  };
}

async function closePorts({ port }) {
  const gateway = await findGateway();
  if (!gateway) return { ok: false, error: 'No se encontró el router UPnP' };
  const results = [];
  for (const protocol of ['TCP', 'UDP']) {
    results.push({ protocol, ok: await deleteMapping(gateway, port, protocol) });
  }
  return { ok: true, results };
}

async function gatewayInfo() {
  const gateway = await findGateway();
  if (!gateway) return { found: false, externalIp: '' };
  return { found: true, externalIp: await getExternalIp(gateway), service: gateway.serviceType };
}

module.exports = { openPorts, closePorts, gatewayInfo, discover };
