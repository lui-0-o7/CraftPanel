'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const USER_AGENT = 'CraftPanel/1.0 (gestor de servidores Minecraft)';

async function downloadFile(url, dest, { onProgress, signal, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal,
      redirect: 'follow',
    });
  } catch (err) {
    const causeMsg = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    console.error('Download Fetch Error Detail:', err, err.cause);
    throw new Error(`Error de conexión al descargar el archivo del servidor${causeMsg}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Error ${res.status} al descargar el archivo`);

  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  const file = fs.createWriteStream(tmp);
  let received = 0;
  let lastEmit = 0;

  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!file.write(Buffer.from(value))) await once(file, 'drain');
      const now = Date.now();
      if (onProgress && (now - lastEmit > 150 || (total && received >= total))) {
        lastEmit = now;
        onProgress({
          received,
          total,
          percent: total ? Math.min(100, (received / total) * 100) : 0,
        });
      }
    }
  } catch (err) {
    file.destroy();
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  await new Promise((resolve, reject) => {
    file.end((err) => (err ? reject(err) : resolve()));
  });
  await fs.promises.rename(tmp, dest);
  if (onProgress) onProgress({ received, total, percent: 100, done: true });
  return dest;
}

module.exports = { downloadFile };
