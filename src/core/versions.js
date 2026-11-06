'use strict';

const USER_AGENT = 'CraftPanel/1.0 (gestor de servidores Minecraft)';

const PAPER_API = 'https://fill.papermc.io/v3';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const BEDROCK_LINKS = 'https://net.web.minecraft-services.net/api/v1.0/download/links';

const cache = new Map();
const TTL = 5 * 60 * 1000;

async function fetchJson(url, { timeout = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
    return await res.json();
  } catch (err) {
    const causeMsg = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    console.error('Fetch Error Detail:', err, err.cause);
    if (err.name === 'AbortError') throw new Error('La descarga tardó demasiado (sin conexión o red lenta)');
    throw new Error(`Error de conexión al obtener datos de Minecraft${causeMsg}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function mojangManifest() {
  return cached('mojang-manifest', () => fetchJson(MOJANG_MANIFEST));
}

async function paperVersions() {
  return cached('paper-versions', async () => {
    const data = await fetchJson(`${PAPER_API}/projects/paper/versions`);
    return (data.versions || []).map((item) => ({
      id: item.version.id,
      javaMin: item.version?.java?.version?.minimum || 21,
      supported: item.version?.support?.status === 'SUPPORTED',
      latestBuild: Array.isArray(item.builds) ? item.builds[item.builds.length - 1] : null,
    }));
  });
}

async function vanillaVersions() {
  const manifest = await mojangManifest();
  return (manifest.versions || [])
    .filter((v) => v.type === 'release')
    .map((v) => ({ id: v.id, javaMin: null, supported: true }));
}

async function bedrockVersion() {
  return cached('bedrock-version', async () => {
    const data = await fetchJson(BEDROCK_LINKS);
    const links = data?.result?.links || [];
    const type = process.platform === 'win32' ? 'serverBedrockWindows' : 'serverBedrockLinux';
    const link = links.find((l) => l.downloadType === type);
    if (!link) throw new Error('Minecraft no publica el servidor Bedrock para esta plataforma');
    const match = /bedrock-server-([\d.]+)\.zip/.exec(link.downloadUrl);
    return { id: match ? match[1] : 'actual', url: link.downloadUrl };
  });
}

async function listVersions({ edition, software }) {
  if (edition === 'bedrock') {
    const b = await bedrockVersion();
    return {
      versions: [{ id: b.id, label: `${b.id} (oficial)`, supported: true }],
      note: 'El servidor Bedrock oficial solo se distribuye en su última versión.',
    };
  }
  if (software === 'paper') {
    const list = await paperVersions();
    return {
      versions: list.map((v) => ({
        id: v.id,
        label: `${v.id}${v.latestBuild ? ` · build ${v.latestBuild}` : ''}${v.supported ? '' : ' · sin soporte'}`,
        supported: v.supported,
        javaMin: v.javaMin,
      })),
    };
  }
  const list = await vanillaVersions();
  return { versions: list.map((v) => ({ id: v.id, label: v.id, supported: true })) };
}

async function resolveServer({ software, version }) {
  if (software === 'paper') {
    const build = await fetchJson(`${PAPER_API}/projects/paper/versions/${encodeURIComponent(version)}/builds/latest`);
    const download = build?.downloads?.['server:default'];
    if (!download?.url) throw new Error('No se encontró una build de Paper para esa versión');
    const catalog = await paperVersions().catch(() => []);
    const meta = catalog.find((item) => item.id === version);
    return {
      kind: 'jar',
      url: download.url,
      fileName: download.name || `paper-${version}.jar`,
      size: download.size || 0,
      sha256: download.checksums?.sha256 || '',
      build: build.id,
      javaMin: meta?.javaMin || 21,
    };
  }

  if (software === 'vanilla') {
    const manifest = await mojangManifest();
    const entry = (manifest.versions || []).find((v) => v.id === version);
    if (!entry) throw new Error(`La versión ${version} no existe en Mojang`);
    const meta = await fetchJson(entry.url);
    const server = meta?.downloads?.server;
    if (!server?.url) throw new Error('Esa versión no tiene servidor descargable');
    return {
      kind: 'jar',
      url: server.url,
      fileName: `minecraft-server-${version}.jar`,
      size: server.size || 0,
      sha1: server.sha1 || '',
      javaMin: meta?.javaVersion?.majorVersion || 17,
    };
  }

  if (software === 'fabric') {
    const installers = await fetchJson(`${FABRIC_META}/versions/installer`);
    const installer = (installers || []).find((i) => i.stable) || installers?.[0];
    if (!installer?.url) throw new Error('No se pudo obtener el instalador de Fabric');
    const loaders = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(version)}`);
    const loader = (loaders || []).find((l) => l.loader?.stable) || loaders?.[0];
    if (!loader?.loader?.version) throw new Error(`Fabric no soporta la versión ${version}`);
    const manifest = await mojangManifest();
    const entry = (manifest.versions || []).find((v) => v.id === version);
    let javaMin = 17;
    if (entry) {
      try {
        const meta = await fetchJson(entry.url);
        javaMin = meta?.javaVersion?.majorVersion || 17;
      } catch {
        /* opcional */
      }
    }
    return {
      kind: 'fabric',
      url: installer.url,
      fileName: `fabric-installer-${installer.version}.jar`,
      loaderVersion: loader.loader.version,
      javaMin,
    };
  }

  if (software === 'bedrock') {
    const b = await bedrockVersion();
    return {
      kind: 'bedrock-zip',
      url: b.url,
      fileName: b.url.split('/').pop(),
      version: b.id,
    };
  }

  throw new Error(`Software desconocido: ${software}`);
}

module.exports = { listVersions, resolveServer, fetchJson };
