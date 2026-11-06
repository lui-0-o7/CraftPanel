'use strict';

/* =============================== Utilidades =============================== */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SOFTWARE_LABELS = {
  paper: 'Paper',
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  bedrock: 'Bedrock oficial',
};

const STATUS_LABELS = {
  stopped: 'Detenido',
  starting: 'Iniciando…',
  running: 'En línea',
  stopping: 'Deteniendo…',
  crashed: 'Se cerró con error',
  error: 'Error',
};

const TUNNEL_HELP_JAVA =
  'Los túneles gratuitos de Cloudflare están pensados para HTTP. Para Minecraft, tus amigos deben instalar <strong>cloudflared</strong> y ejecutar el comando que aparece abajo; después se conectan a <code>127.0.0.1</code>. Si no funciona, usa UPnP o abre el puerto manualmente.';
const TUNNEL_HELP_BEDROCK =
  'El túnel de Cloudflare no sirve para Bedrock: Minecraft Bedrock usa <strong>UDP</strong> y estos túneles solo transportan TCP. Abre el puerto UDP en el router con UPnP o hazlo manualmente.';

const state = {
  info: null,
  config: null,
  servers: [],
  currentId: null,
  current: null,
  statuses: {},
  logs: [],
  players: [],
  props: null,
  backups: [],
  net: null,
  tunnel: { state: 'stopped' },
  activeTab: 'console',
  autoscroll: true,
  commandHistory: [],
  historyIndex: -1,
  versionToken: 0,
  newServer: { edition: 'java', software: 'paper' },
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanError(error) {
  return String(error?.message || error || 'Error desconocido')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

async function invoke(promise) {
  try {
    return await promise;
  } catch (error) {
    throw new Error(cleanError(error));
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

function formatUptime(startedAt) {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h} h ${m} min en línea`;
  if (m) return `${m} min ${s} s en línea`;
  return `${s} s en línea`;
}

function toast(message, type = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${type === 'info' ? '' : type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all 0.2s ease';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copiado al portapapeles');
}

function openModal(html, { wide = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  $('#modal-root').appendChild(overlay);
  return overlay;
}

function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <h2>${esc(title)}</h2>
      <p class="modal-sub">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="cancel">${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmLabel)}</button>
      </div>
    `);
    const close = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
  });
}

function showProgress(title) {
  $('#progress-title').textContent = title;
  $('#progress-message').textContent = 'Preparando…';
  $('#progress-bar').style.width = '0%';
  $('#progress-percent').textContent = '0%';
  $('#progress-overlay').classList.remove('hidden');
}

function setProgress(progress) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  $('#progress-bar').style.width = `${percent}%`;
  $('#progress-percent').textContent = `${Math.round(percent)}%`;
  if (progress.message) $('#progress-message').textContent = progress.message;
}

function hideProgress() {
  $('#progress-overlay').classList.add('hidden');
}

/* =============================== Arranque ================================ */

async function boot() {
  try {
    state.info = await invoke(window.api.app.info());
    state.config = state.info.config;
    $('#app-version').textContent = `v${state.info.version} · ${state.info.platform === 'win32' ? 'Windows' : state.info.platform}`;
    await refreshServers();
    subscribeEvents();
    setInterval(tick, 1000);

    const last = state.servers.find((s) => s.id === state.config.lastServerId);
    if (last) selectServer(last.id);
    else if (state.servers.length) selectServer(state.servers[0].id);
    else showEmpty();

    loadTunnelStatus();
  } catch (error) {
    toast(cleanError(error), 'error', 9000);
  }
}

function subscribeEvents() {
  window.api.events.serverStatus((status) => applyStatus(status));
  window.api.events.serverLog((entry) => {
    if (entry.id !== state.currentId) return;
    state.logs.push(entry);
    if (state.logs.length > 2500) state.logs.splice(0, state.logs.length - 2500);
    appendLogLine(entry);
  });
  window.api.events.installProgress((progress) => {
    if (!$('#progress-overlay').classList.contains('hidden')) setProgress(progress);
  });
  window.api.events.backupProgress((progress) => {
    if (progress.serverId === state.currentId) updateBackupProgress(progress);
  });
  window.api.events.tunnelStatus((status) => {
    state.tunnel = status;
    renderTunnel();
  });
  window.api.events.configChanged((config) => {
    state.config = config;
  });
}

async function refreshServers() {
  state.servers = await invoke(window.api.servers.list());
  for (const server of state.servers) {
    if (server.runtime) state.statuses[server.id] = server.runtime;
  }
  renderSidebar();
  if (state.currentId && !state.servers.some((s) => s.id === state.currentId)) {
    state.currentId = null;
    state.current = null;
    showEmpty();
  }
}

function showEmpty() {
  $('#empty-state').classList.remove('hidden');
  $('#server-view').classList.add('hidden');
}

function selectServer(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server) {
    showEmpty();
    return;
  }
  state.currentId = id;
  state.current = server;
  state.logs = [];
  state.players = state.statuses[id]?.players || server.runtime?.players || [];
  state.props = null;
  state.backups = [];
  state.net = null;
  state.activeTab = 'console';
  $('#public-check-result').textContent = '';
  $('#upnp-result').classList.add('hidden');
  $('#addr-lan').textContent = '—';
  $('#addr-public').textContent = '—';

  $('#empty-state').classList.add('hidden');
  $('#server-view').classList.remove('hidden');

  renderSidebar();
  renderHeader();
  renderStatus();
  renderPlayers();
  setTab('console');
  renderConsole();
  loadLogs(id);
  loadNetInfo();
  window.api.config.set({ lastServerId: id }).catch(() => {});
}

/* ================================ Sidebar =============================== */

function renderSidebar() {
  const list = $('#server-list');
  list.innerHTML = '';
  if (!state.servers.length) {
    list.innerHTML = '<div class="hint" style="padding:8px 10px">Todavía no hay servidores.</div>';
    return;
  }
  for (const server of state.servers) {
    const status = state.statuses[server.id]?.status || 'stopped';
    const item = document.createElement('button');
    item.className = `server-item ${server.id === state.currentId ? 'active' : ''}`;
    item.innerHTML = `
      <span class="dot ${esc(status)}"></span>
      <span class="srv-meta">
        <span class="srv-name">${esc(server.name)}</span>
        <span class="srv-sub">${esc(SOFTWARE_LABELS[server.software] || server.software)} ${esc(server.version || '')} · :${esc(server.port)}</span>
      </span>`;
    item.addEventListener('click', () => selectServer(server.id));
    list.appendChild(item);
  }
}

function renderHeader() {
  const server = state.current;
  if (!server) return;
  $('#srv-name').textContent = server.name;
  $('#srv-edition').textContent = server.edition === 'bedrock' ? 'Bedrock' : 'Java';
  $('#srv-software').textContent = SOFTWARE_LABELS[server.software] || server.software;
  $('#srv-version').textContent = server.version || '—';
  $('#addr-port').textContent = String(server.port);
  $('#net-edition-badge').textContent = server.edition === 'bedrock' ? 'Bedrock' : 'Java';
  $('#set-software-badge').textContent = `${SOFTWARE_LABELS[server.software] || server.software} · ${server.version || '—'}`;
  $('#manual-protocols').textContent =
    server.edition === 'bedrock'
      ? 'Bedrock usa UDP (puerto 19132 por defecto). El puerto IPv6 es 19133.'
      : 'Java usa TCP (puerto 25565 por defecto).';
  $('#manual-port-line').textContent = `Abre el puerto ${server.port} (${server.edition === 'bedrock' ? 'UDP' : 'TCP'}).`;
}

function renderStatus() {
  const server = state.current;
  if (!server) return;
  const status = state.statuses[server.id] || { status: 'stopped', players: [] };
  const pill = $('#srv-status');
  pill.textContent = STATUS_LABELS[status.status] || status.status;
  pill.className = `status-pill status-${status.status}`;

  const running = ['starting', 'running', 'stopping'].includes(status.status);
  $('#btn-start').classList.toggle('hidden', running);
  $('#btn-start').disabled = !server.installed;
  $('#btn-stop').classList.toggle('hidden', !running);
  $('#btn-kill').classList.toggle('hidden', !running);
  $('#srv-uptime').textContent = status.startedAt ? formatUptime(status.startedAt) : '';
  $('#player-count').textContent = String(state.players.length);
  $('#player-count').classList.toggle('hidden', !state.players.length);
  setPropsRunning(running);
  setSettingsRunning(running);
}

function tick() {
  const server = state.current;
  if (!server) return;
  const status = state.statuses[server.id];
  if (status?.startedAt) $('#srv-uptime').textContent = formatUptime(status.startedAt);
}

function applyStatus(status) {
  state.statuses[status.id] = status;
  renderSidebar();
  if (status.id !== state.currentId) return;
  state.players = status.players || [];
  renderStatus();
  renderPlayers();
}

/* ================================ Consola =============================== */

async function loadLogs(id) {
  const startedAt = Date.now();
  try {
    const fetched = await invoke(window.api.servers.logs(id, 800));
    if (state.currentId !== id) return;
    const live = state.logs.filter((entry) => entry.t >= startedAt);
    const seen = new Set();
    const merged = [];
    for (const entry of [...fetched, ...live]) {
      const key = `${entry.t}|${entry.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    state.logs = merged.slice(-2000);
    renderConsole();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function renderConsole() {
  const consoleEl = $('#console');
  consoleEl.innerHTML = '';
  if (!state.logs.length) {
    consoleEl.innerHTML = '<div class="console-empty">La consola está vacía. Inicia el servidor para ver su salida aquí.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of state.logs.slice(-2000)) fragment.appendChild(logNode(entry));
  consoleEl.appendChild(fragment);
  if (state.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function logNode(entry) {
  const line = document.createElement('div');
  const isCommand = entry.line.startsWith('> ');
  line.className = `log-line log-${isCommand ? 'cmd' : entry.level || 'info'}`;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(entry.t).toLocaleTimeString('es-ES', { hour12: false });
  line.appendChild(time);
  line.appendChild(document.createTextNode(entry.line));
  return line;
}

function appendLogLine(entry) {
  const consoleEl = $('#console');
  const empty = $('.console-empty', consoleEl);
  if (empty) empty.remove();
  consoleEl.appendChild(logNode(entry));
  while (consoleEl.childElementCount > 2500) consoleEl.firstElementChild.remove();
  if (state.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}

/* =============================== Jugadores ============================== */

function renderPlayers() {
  const container = $('#players-list');
  const server = state.current;
  container.innerHTML = '';
  if (!state.players.length) {
    container.innerHTML = `<div class="empty-block">${
      state.statuses[server?.id]?.status === 'running'
        ? 'No hay jugadores conectados ahora mismo.'
        : 'Inicia el servidor para ver a los jugadores.'
    }</div>`;
    return;
  }
  for (const name of state.players) {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="player-name"><span class="avatar">${esc(name.slice(0, 1).toUpperCase())}</span>${esc(name)}</div>
      <div class="player-actions">
        <button class="btn btn-ghost" data-cmd="op ${esc(name)}" title="Dar operador">Op</button>
        <button class="btn btn-ghost" data-cmd="deop ${esc(name)}" title="Quitar operador">Deop</button>
        <button class="btn btn-ghost" data-cmd="kick ${esc(name)}" title="Expulsar">Kick</button>
        ${server?.edition === 'java' ? `<button class="btn btn-danger" data-cmd="ban ${esc(name)}" title="Banear">Ban</button>` : ''}
      </div>`;
    for (const button of $$('[data-cmd]', card)) {
      button.addEventListener('click', () => runCommand(button.dataset.cmd));
    }
    container.appendChild(card);
  }
}

async function runCommand(command) {
  if (!state.currentId) return;
  try {
    await invoke(window.api.servers.command(state.currentId, command));
    toast(`Comando enviado: ${command}`);
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ============================== Propiedades ============================= */

async function loadProperties() {
  if (!state.currentId) return;
  try {
    const data = await invoke(window.api.props.read(state.currentId));
    state.props = { ...data, rawMode: false, dirty: false };
    $('#props-raw').classList.add('hidden');
    $('#props-form').classList.remove('hidden');
    $('#btn-props-raw').textContent = 'Editor de texto';
    renderProperties();
  } catch (error) {
    $('#props-form').innerHTML = `<div class="empty-block">${esc(cleanError(error))}</div>`;
  }
}

function setSettingsRunning(running) {
  const disabled = Boolean(running);
  for (const selector of ['#set-port', '#set-motd', '#set-online']) {
    const input = $(selector);
    if (input) input.disabled = disabled;
  }
  $('#settings-warning')?.classList.toggle('hidden', !disabled);
}

function setPropsRunning(running) {
  const disabled = Boolean(running);
  $('#btn-props-save').disabled = disabled;
  $('#props-raw').readOnly = disabled;
  $('#props-warning').classList.toggle('hidden', !disabled);
  $$('#props-form input, #props-form select').forEach((input) => {
    input.disabled = disabled;
  });
}

function renderProperties() {
  const props = state.props;
  if (!props) return;
  const form = $('#props-form');
  form.innerHTML = '';
  $('#props-raw').value = props.text;

  for (const field of props.schema) {
    const value = props.values[field.key] ?? '';
    const label = document.createElement('label');
    label.className = `field${field.type === 'boolean' ? ' boolean' : ''}`;
    const title = document.createElement('span');
    title.textContent = field.label;
    label.appendChild(title);

    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      const options = [...field.options];
      if (value && !options.includes(value)) options.unshift(value);
      for (const option of options) {
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        input.appendChild(opt);
      }
      input.value = value || field.options[0];
    } else if (field.type === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === 'true';
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      input.value = value;
    }

    input.addEventListener('input', () => {
      const next = field.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
      state.props.values[field.key] = next;
      state.props.dirty = true;
    });
    label.appendChild(input);
    form.appendChild(label);
  }
  setPropsRunning(props.running);
}

async function saveProperties() {
  if (!state.currentId || !state.props) return;
  if (state.props.running) {
    toast('Detén el servidor antes de editar server.properties', 'warn');
    return;
  }
  try {
    const payload = state.props.rawMode
      ? { text: $('#props-raw').value }
      : { text: state.props.text, values: state.props.values };
    const result = await invoke(window.api.props.save(state.currentId, payload));
    toast(result.running ? 'Guardado. Se aplicará al reiniciar el servidor.' : 'Propiedades guardadas');
    await refreshServers();
    state.current = state.servers.find((s) => s.id === state.currentId) || state.current;
    renderHeader();
    await loadProperties();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function toggleRawEditor() {
  if (!state.props) return;
  state.props.rawMode = !state.props.rawMode;
  if (state.props.rawMode) {
    $('#props-raw').value = state.props.text;
    $('#props-raw').classList.remove('hidden');
    $('#props-form').classList.add('hidden');
    $('#btn-props-raw').textContent = 'Formulario';
  } else {
    loadProperties();
  }
}

/* ================================ Copias ================================ */

async function loadBackups() {
  if (!state.currentId) return;
  try {
    state.backups = await invoke(window.api.backups.list(state.currentId));
    renderBackups();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function renderBackups() {
  const container = $('#backups-list');
  container.innerHTML = '';
  if (!state.backups.length) {
    container.innerHTML = '<div class="empty-block">Todavía no hay copias. Crea una antes de actualizar o cambiar cosas importantes.</div>';
    return;
  }
  for (const item of state.backups) {
    const row = document.createElement('div');
    row.className = 'backup-row';
    row.innerHTML = `
      <div class="backup-info">
        <div class="backup-name">${esc(item.name)}</div>
        <div class="backup-sub">${formatBytes(item.size)} · ${esc(formatDate(item.createdAt))}</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-ghost btn-sm" data-act="restore">Restaurar</button>
        <button class="btn btn-danger btn-sm" data-act="delete">Eliminar</button>
      </div>`;
    row.querySelector('[data-act="restore"]').addEventListener('click', () => restoreBackup(item));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteBackup(item));
    container.appendChild(row);
  }
}

function updateBackupProgress(progress) {
  const wrap = $('#backup-progress');
  wrap.classList.remove('hidden');
  $('#backup-bar').style.width = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;
  $('#backup-progress-text').textContent = progress.message || '';
  if ((Number(progress.percent) || 0) >= 100) {
    setTimeout(() => wrap.classList.add('hidden'), 900);
  }
}

async function createBackup() {
  if (!state.currentId) return;
  try {
    $('#btn-backup-create').disabled = true;
    await invoke(window.api.backups.create(state.currentId));
    toast('Copia de seguridad creada');
    await loadBackups();
  } catch (error) {
    toast(cleanError(error), 'error', 6000);
  } finally {
    $('#btn-backup-create').disabled = false;
    $('#backup-progress').classList.add('hidden');
  }
}

async function restoreBackup(item) {
  const ok = await confirmDialog({
    title: 'Restaurar copia',
    message: `Se reemplazará el mundo actual por "${item.name}". Antes se creará una copia automática del estado actual.`,
    confirmLabel: 'Restaurar',
    danger: true,
  });
  if (!ok) return;
  showProgress('Restaurando copia…');
  try {
    await invoke(window.api.backups.restore(state.currentId, item.name));
    hideProgress();
    toast('Copia restaurada. Inicia el servidor para comprobarlo.');
    await loadBackups();
  } catch (error) {
    hideProgress();
    toast(cleanError(error), 'error', 7000);
  }
}

async function deleteBackup(item) {
  const ok = await confirmDialog({
    title: 'Eliminar copia',
    message: `¿Seguro que quieres borrar "${item.name}"? Esta acción no se puede deshacer.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke(window.api.backups.remove(state.currentId, item.name));
    toast('Copia eliminada');
    await loadBackups();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ================================= Red ================================= */

async function loadNetInfo() {
  const id = state.currentId;
  if (!id) return;
  try {
    const base = await invoke(window.api.net.info());
    if (state.currentId !== id) return;
    state.net = { ...(state.net || {}), ...base };
    renderNet();
  } catch {
    /* se reintenta al abrir la pestaña */
  }
  try {
    const extra = await invoke(window.api.net.extra());
    if (state.currentId !== id) return;
    state.net = { ...(state.net || {}), ...extra };
    renderNet();
  } catch {
    /* la IP pública y UPnP son opcionales */
  }
}

function isPrivateIp(ip) {
  if (!ip) return false;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  return false;
}

function renderNet() {
  const server = state.current;
  if (!server) return;
  const net = state.net;
  const lan = net?.primary || '—';
  const publicIp = net?.publicIp || '—';
  const port = server.port;
  $('#addr-lan').textContent = net ? `${lan}:${port}` : '—';
  $('#addr-public').textContent = net?.publicIp ? `${publicIp}:${port}` : '—';
  $('#net-lan').textContent = net ? `${lan}:${port}` : '—';
  $('#net-public').textContent = net?.publicIp ? `${publicIp}:${port}` : '—';

  const gateway = net?.gateway;
  const cgnat =
    gateway?.externalIp && (isPrivateIp(gateway.externalIp) || (net?.publicIp && gateway.externalIp !== net.publicIp));
  const baseHint =
    server.edition === 'bedrock'
      ? 'En Minecraft Bedrock: Jugar → Servidores → Añadir servidor. Usa la IP local si estáis en la misma red.'
      : 'En Minecraft Java: Multijugador → Añadir servidor. Usa la IP local si estáis en la misma red.';
  $('#net-connect-hint').textContent = cgnat
    ? `${baseHint} ⚠ Tu router no ve la misma IP pública que este PC: podrías estar detrás de CGNAT, y en ese caso el reenvío de puertos no funcionará.`
    : baseHint;

  const badge = $('#upnp-state');
  if (!gateway) {
    badge.textContent = 'Sin comprobar';
    badge.className = 'badge badge-muted';
  } else if (gateway.found) {
    badge.textContent = 'Router compatible';
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = 'UPnP no disponible';
    badge.className = 'badge badge-bad';
  }
  renderTunnel();
}

async function checkPublic() {
  const server = state.current;
  if (!server) return;
  const button = $('#btn-check-public');
  const result = $('#public-check-result');
  const host = state.net?.publicIp;
  if (!host) {
    toast('Todavía no se ha obtenido tu IP pública. Pulsa ↻ Actualizar.', 'warn');
    return;
  }
  button.disabled = true;
  result.textContent = 'Comprobando…';
  try {
    const data = await invoke(window.api.net.checkPublic({ host, port: server.port, edition: server.edition }));
    if (data.online) {
      result.textContent = `✅ Visible desde Internet · ${data.players ?? '?'}/${data.maxPlayers ?? '?'} jugadores${
        data.version ? ` · ${data.version}` : ''
      }`;
    } else {
      result.textContent = '❌ No se ve desde Internet. Abre el puerto o revisa el firewall.';
    }
  } catch (error) {
    result.textContent = `No se pudo comprobar: ${cleanError(error)}`;
  } finally {
    button.disabled = false;
  }
}

function renderTunnel() {
  const tunnel = state.tunnel || { state: 'stopped' };
  const isBedrock = state.current?.edition === 'bedrock';
  const badge = $('#tunnel-state');
  const labels = { stopped: 'Detenido', starting: 'Conectando…', running: 'Activo', error: 'Error' };
  badge.textContent = labels[tunnel.state] || tunnel.state;
  badge.className = `badge ${
    tunnel.state === 'running' ? 'badge-ok' : tunnel.state === 'error' ? 'badge-bad' : 'badge-muted'
  }`;
  const info = $('#tunnel-info');
  if (tunnel.state === 'running' && tunnel.command) {
    info.classList.remove('hidden');
    $('#tunnel-command').textContent = tunnel.command;
  } else {
    info.classList.add('hidden');
  }
  $('#tunnel-help').innerHTML = isBedrock ? TUNNEL_HELP_BEDROCK : TUNNEL_HELP_JAVA;
  $('#btn-tunnel-start').disabled = isBedrock || tunnel.state === 'starting' || tunnel.state === 'running';
  $('#btn-tunnel-stop').disabled = tunnel.state === 'stopped';
}

async function loadTunnelStatus() {
  try {
    state.tunnel = await invoke(window.api.tunnel.status());
    renderTunnel();
  } catch {
    /* opcional */
  }
}

async function openUpnpPorts() {
  if (!state.current) return;
  const button = $('#btn-upnp-open');
  button.disabled = true;
  button.textContent = 'Abriendo…';
  const resultEl = $('#upnp-result');
  resultEl.classList.remove('hidden', 'ok', 'bad');
  resultEl.textContent = 'Contactando con el router…';
  try {
    const result = await invoke(
      window.api.net.openPorts({ port: state.current.port, description: `CraftPanel - ${state.current.name}` })
    );
    const lines = [];
    if (result.ok) {
      lines.push(`✅ Puerto ${state.current.port} abierto en el router.`);
      if (result.externalIp) lines.push(`IP pública: ${result.externalIp}:${state.current.port}`);
      lines.push(`Destino: ${result.internalIp}`);
    } else {
      lines.push('❌ No se pudo abrir el puerto automáticamente.');
      if (result.error) lines.push(result.error);
      lines.push('Abre el puerto manualmente en el router (mira las instrucciones de abajo).');
    }
    for (const item of result.results || []) {
      lines.push(`${item.ok ? '•' : '✗'} ${item.protocol}: ${item.ok ? 'redirigido' : item.error || 'falló'}`);
    }
    resultEl.textContent = lines.join('\n');
    resultEl.classList.add(result.ok ? 'ok' : 'bad');
    resultEl.style.whiteSpace = 'pre-line';
    toast(result.ok ? 'Puerto abierto con UPnP' : 'UPnP no pudo abrir el puerto', result.ok ? 'info' : 'warn', 6000);
  } catch (error) {
    resultEl.textContent = cleanError(error);
    resultEl.classList.add('bad');
    toast(cleanError(error), 'error', 7000);
  } finally {
    button.disabled = false;
    button.textContent = 'Abrir puerto en el router';
  }
}

async function closeUpnpPorts() {
  if (!state.current) return;
  try {
    const result = await invoke(window.api.net.closePorts(state.current.port));
    const text = result.ok
      ? `Puerto ${state.current.port} cerrado en el router.`
      : result.error || 'No se pudo cerrar el puerto.';
    const resultEl = $('#upnp-result');
    resultEl.classList.remove('hidden');
    resultEl.textContent = text;
    resultEl.style.whiteSpace = 'pre-line';
    toast(text, result.ok ? 'info' : 'warn');
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

async function startTunnel() {
  if (!state.current) return;
  if (state.current.edition === 'bedrock') {
    toast('El túnel de Cloudflare no es compatible con Bedrock (UDP). Usa UPnP o abre el puerto en el router.', 'warn', 8000);
    return;
  }
  try {
    state.tunnel = await invoke(window.api.tunnel.start(state.current.id));
    renderTunnel();
  } catch (error) {
    toast(cleanError(error), 'error', 8000);
  }
}

async function stopTunnel() {
  try {
    await invoke(window.api.tunnel.stop());
    state.tunnel = { state: 'stopped' };
    renderTunnel();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

async function uploadWorld() {
  if (!state.currentId) return;
  try {
    const success = await invoke(window.api.servers.uploadWorld(state.currentId));
    if (success) {
      toast('Mundo cargado correctamente.');
    }
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ============================ Ajustes servidor ========================== */

async function ensureJavaList() {
  if (!state.info.java || !state.info.java.length) {
    try {
      state.info.java = await invoke(window.api.java.detect());
    } catch {
      state.info.java = [];
    }
  }
  return state.info.java;
}

async function renderSettingsTab() {
  const server = state.current;
  if (!server) return;
  $('#set-name').value = server.name;
  $('#set-port').value = server.port;
  $('#set-ram').value = server.ramMB;
  $('#set-motd').value = server.motd || '';
  $('#set-online').checked = server.onlineMode !== false;
  $('#set-ram-field').classList.toggle('hidden', server.edition === 'bedrock');
  const status = state.statuses[server.id]?.status || 'stopped';
  setSettingsRunning(['starting', 'running', 'stopping'].includes(status));

  const select = $('#set-java');
  select.innerHTML = '<option>Cargando…</option>';
  const detected = await ensureJavaList();
  select.innerHTML = '';
  for (const item of detected) {
    const option = document.createElement('option');
    option.value = item.path;
    option.textContent = `${item.label}${item.major >= 21 ? '' : ' (antiguo)'}`;
    select.appendChild(option);
  }
  if (server.javaPath && !detected.some((j) => j.path === server.javaPath)) {
    const option = document.createElement('option');
    option.value = server.javaPath;
    option.textContent = server.javaPath;
    select.appendChild(option);
  }
  select.value = server.javaPath || detected[0]?.path || '';

  await loadVersionOptions(server.software, server.version, $('#set-version'));
}

async function loadVersionOptions(software, currentVersion, select) {
  select.innerHTML = '<option>Cargando versiones…</option>';
  try {
    const edition = state.current?.edition || (software === 'bedrock' ? 'bedrock' : 'java');
    const data = await invoke(window.api.versions.list({ edition, software }));
    select.innerHTML = '';
    let found = false;
    for (const version of data.versions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = version.label || version.id;
      if (version.id === currentVersion) {
        option.selected = true;
        found = true;
      }
      select.appendChild(option);
    }
    if (!found && currentVersion) {
      const option = document.createElement('option');
      option.value = currentVersion;
      option.textContent = currentVersion;
      option.selected = true;
      select.prepend(option);
    }
  } catch (error) {
    select.innerHTML = '';
    const option = document.createElement('option');
    option.value = currentVersion || '';
    option.textContent = `${currentVersion || 'Sin conexión'} (no se pudo consultar)`;
    select.appendChild(option);
    toast(`No se pudieron cargar las versiones: ${cleanError(error)}`, 'warn', 6000);
  }
}

async function saveServerSettings() {
  if (!state.current) return;
  try {
    const running = ['starting', 'running', 'stopping'].includes(
      state.statuses[state.current.id]?.status || 'stopped'
    );
    const patch = {
      name: $('#set-name').value.trim(),
      javaPath: $('#set-java').value || '',
    };
    if (!running) {
      patch.port = Number($('#set-port').value);
      patch.motd = $('#set-motd').value;
      patch.onlineMode = $('#set-online').checked;
    }
    if (state.current.edition !== 'bedrock') patch.ramMB = Number($('#set-ram').value);
    await invoke(window.api.servers.update(state.current.id, patch));
    await refreshServers();
    state.current = state.servers.find((s) => s.id === state.currentId) || state.current;
    renderHeader();
    renderSidebar();
    toast('Ajustes guardados');
  } catch (error) {
    toast(cleanError(error), 'error', 6000);
  }
}

async function reinstallServer() {
  if (!state.current) return;
  const version = $('#set-version').value;
  const ok = await confirmDialog({
    title: 'Reinstalar servidor',
    message: `Se descargará de nuevo ${SOFTWARE_LABELS[state.current.software] || state.current.software} ${
      version || ''
    }. Los mundos y las copias se conservan. Haz una copia antes si el mundo es importante.`,
    confirmLabel: 'Reinstalar',
  });
  if (!ok) return;
  showProgress('Reinstalando servidor…');
  try {
    await invoke(window.api.servers.reinstall(state.current.id, { version }));
    hideProgress();
    await refreshServers();
    state.current = state.servers.find((s) => s.id === state.currentId) || state.current;
    renderHeader();
    await loadVersionOptions(state.current.software, state.current.version, $('#set-version'));
    toast('Servidor reinstalado correctamente');
  } catch (error) {
    hideProgress();
    toast(cleanError(error), 'error', 8000);
  }
}

async function deleteServer() {
  if (!state.current) return;
  const deleteFiles = $('#set-delete-files').checked;
  const ok = await confirmDialog({
    title: 'Eliminar servidor',
    message: deleteFiles
      ? `Se eliminará "${state.current.name}" y TODOS sus archivos, incluidos los mundos y las copias. Esta acción no se puede deshacer.`
      : `Se quitará "${state.current.name}" de CraftPanel, pero los archivos se conservarán en ${state.current.dir}.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  try {
    await invoke(window.api.servers.remove(state.current.id, deleteFiles));
    state.currentId = null;
    state.current = null;
    await refreshServers();
    if (state.servers.length) selectServer(state.servers[0].id);
    else showEmpty();
    toast('Servidor eliminado');
  } catch (error) {
    toast(cleanError(error), 'error', 7000);
  }
}

/* ================================ Nuevo ================================ */

function openNewServerModal() {
  state.newServer = { edition: 'java', software: 'paper' };
  const overlay = openModal(
    `
    <h2>Nuevo servidor</h2>
    <p class="modal-sub">Elige la edición y el software. CraftPanel descarga el servidor, acepta la configuración inicial y lo deja listo.</p>
    <div class="form-grid">
      <label class="field" style="grid-column:1/-1">
        <span>Edición</span>
        <div class="segmented" id="ns-edition">
          <button type="button" data-edition="java" class="active">Java</button>
          <button type="button" data-edition="bedrock">Bedrock</button>
        </div>
      </label>
      <label class="field"><span>Software</span><select id="ns-software"></select></label>
      <label class="field"><span>Versión</span><div id="ns-version-wrap"><select id="ns-version"></select></div></label>
      <label class="field"><span>Nombre</span><input id="ns-name" type="text" maxlength="60" placeholder="Mi servidor" /></label>
      <label class="field"><span>Puerto</span><input id="ns-port" type="number" min="1" max="65535" value="25565" /></label>
      <label class="field" id="ns-ram-field"><span>Memoria RAM (MB)</span><input id="ns-ram" type="number" min="512" max="65536" step="256" value="2048" /></label>
      <label class="field"><span>MOTD (mensaje del día)</span><input id="ns-motd" type="text" maxlength="120" value="¡Bienvenidos a mi servidor!" /></label>
      <label class="field checkbox-field" style="grid-column:1/-1">
        <span>Opciones</span>
        <label class="check-inline"><input type="checkbox" id="ns-online" checked /> Verificar cuentas (online-mode)</label>
      </label>
    </div>
    <div class="eula-box">
      <label class="check-inline">
        <input type="checkbox" id="ns-eula" />
        <span>Acepto el <a id="ns-eula-link">EULA de Minecraft</a> y entiendo que el servidor se ejecutará en este PC.</span>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="ns-cancel">Cancelar</button>
      <button class="btn btn-primary" id="ns-create">Crear servidor</button>
    </div>
    `,
    { wide: true }
  );

  const softwareSelect = $('#ns-software', overlay);

  const editionButtons = $$('#ns-edition button', overlay);
  const updateEdition = (edition) => {
    state.newServer.edition = edition;
    for (const button of editionButtons) button.classList.toggle('active', button.dataset.edition === edition);
    if (edition === 'bedrock') {
      softwareSelect.innerHTML = '<option value="bedrock">Bedrock oficial (Microsoft)</option>';
      $('#ns-port', overlay).value = 19132;
      $('#ns-ram-field', overlay).classList.add('hidden');
      $('#ns-version-wrap', overlay).innerHTML =
        '<div class="hint" style="padding:9px 0">Se instalará la última versión oficial disponible.</div>';
    } else {
      softwareSelect.innerHTML = `
        <option value="paper">Paper (recomendado, plugins y rendimiento)</option>
        <option value="vanilla">Vanilla (oficial de Mojang)</option>
        <option value="fabric">Fabric (mods)</option>`;
      $('#ns-port', overlay).value = 25565;
      $('#ns-ram-field', overlay).classList.remove('hidden');
      $('#ns-version-wrap', overlay).innerHTML = '<select id="ns-version"></select>';
    }
    state.newServer.software = edition === 'bedrock' ? 'bedrock' : 'paper';
    loadNewVersions(overlay);
  };

  for (const button of editionButtons) {
    button.addEventListener('click', () => updateEdition(button.dataset.edition));
  }
  softwareSelect.addEventListener('change', () => {
    state.newServer.software = softwareSelect.value;
    loadNewVersions(overlay);
  });

  $('#ns-eula-link', overlay).addEventListener('click', () => {
    window.api.app.openExternal('https://www.minecraft.net/en-us/eula');
  });
  $('#ns-cancel', overlay).addEventListener('click', () => overlay.remove());

  $('#ns-create', overlay).addEventListener('click', async () => {
    const button = $('#ns-create', overlay);
    const name = $('#ns-name', overlay).value.trim();
    const port = Number($('#ns-port', overlay).value);
    const eula = $('#ns-eula', overlay).checked;
    const versionInput = $('#ns-version', overlay);
    const version = versionInput ? versionInput.value : '';

    if (name.length < 2) return toast('Ponle un nombre al servidor (mínimo 2 caracteres)', 'warn');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('Puerto no válido', 'warn');
    if (!eula) return toast('Debes aceptar el EULA para continuar', 'warn');
    if (state.newServer.edition === 'java' && !version) return toast('Selecciona una versión', 'warn');

    button.disabled = true;
    button.textContent = 'Creando…';
    showProgress('Creando servidor…');
    try {
      const created = await invoke(
        window.api.servers.create({
          name,
          edition: state.newServer.edition,
          software: state.newServer.software,
          version,
          port,
          ramMB: Number($('#ns-ram', overlay).value) || 2048,
          motd: $('#ns-motd', overlay).value || name,
          onlineMode: $('#ns-online', overlay).checked,
          eulaAccepted: true,
        })
      );
      hideProgress();
      overlay.remove();
      await refreshServers();
      selectServer(created.id);
      toast('¡Servidor creado! Pulsa Iniciar para arrancarlo.', 'info', 6000);
    } catch (error) {
      hideProgress();
      button.disabled = false;
      button.textContent = 'Crear servidor';
      toast(cleanError(error), 'error', 9000);
    }
  });

  updateEdition('java');
  setTimeout(() => $('#ns-name', overlay).focus(), 60);
}

async function loadNewVersions(overlay) {
  const token = ++state.versionToken;
  const wrap = $('#ns-version-wrap', overlay);
  if (!wrap) return;
  const isBedrock = state.newServer.edition === 'bedrock';
  if (isBedrock) {
    wrap.innerHTML = '<div class="hint" style="padding:9px 0">Se instalará la última versión oficial disponible.</div>';
    return;
  }
  wrap.innerHTML = '<div class="hint" style="padding:9px 0">Cargando versiones…</div>';
  try {
    const data = await invoke(
      window.api.versions.list({ edition: 'java', software: state.newServer.software })
    );
    if (token !== state.versionToken) return;
    const select = document.createElement('select');
    select.id = 'ns-version';
    for (const version of data.versions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = version.label || version.id;
      select.appendChild(option);
    }
    wrap.innerHTML = '';
    wrap.appendChild(select);
  } catch (error) {
    if (token !== state.versionToken) return;
    wrap.innerHTML = '';
    const input = document.createElement('input');
    input.id = 'ns-version';
    input.type = 'text';
    input.placeholder = 'Ej. 1.21.8';
    wrap.appendChild(input);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.style.marginTop = '6px';
    hint.textContent = `No se pudo consultar la lista (${cleanError(error)}). Escribe la versión a mano.`;
    wrap.appendChild(hint);
  }
}

/* ============================== Ajustes app ============================= */

async function openAppSettings() {
  const config = state.config || {};
  const detected = await ensureJavaList();
  const javaOptions = detected
    .map(
      (item) =>
        `<option value="${esc(item.path)}" ${item.path === config.javaPath ? 'selected' : ''}>${esc(item.label)}</option>`
    )
    .join('');

  const overlay = openModal(
    `
    <h2>Ajustes de CraftPanel</h2>
    <p class="modal-sub">Rutas y preferencias globales. Los cambios se guardan al pulsar Guardar.</p>
    <div class="form-grid">
      <label class="field" style="grid-column:1/-1">
        <span>Carpeta de servidores</span>
        <div class="input-row">
          <input id="cfg-dir" type="text" readonly value="${esc(config.serversDir || '')}" />
          <button class="btn btn-ghost btn-sm" id="cfg-dir-pick">Cambiar…</button>
        </div>
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>Java detectado</span>
        <div class="input-row">
          <select id="cfg-java">
            <option value="">Automático (recomendado)</option>
            ${javaOptions}
          </select>
          <button class="btn btn-ghost btn-sm" id="cfg-java-pick">Examinar…</button>
        </div>
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>cloudflared (opcional)</span>
        <div class="input-row">
          <input id="cfg-cf" type="text" value="${esc(config.cloudflaredPath || '')}" placeholder="Se busca en el PATH" />
          <button class="btn btn-ghost btn-sm" id="cfg-cf-pick">Examinar…</button>
        </div>
        <span class="hint">${
          state.info?.cloudflared?.ok
            ? `Detectado: ${esc(state.info.cloudflared.version)}`
            : 'No detectado. Solo es necesario para el túnel experimental.'
        }</span>
      </label>
      <label class="field">
        <span>Copias por servidor</span>
        <input id="cfg-max" type="number" min="0" max="100" value="${esc(config.maxBackups ?? 10)}" />
        <span class="hint">Las copias más antiguas se borran al superar este número (0 = sin límite).</span>
      </label>
      <label class="field">
        <span>Servidores detectados</span>
        <div class="hint" style="padding-top:8px">${detected.length} instalación(es) de Java</div>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cfg-cancel">Cerrar</button>
      <button class="btn btn-primary" id="cfg-save">Guardar</button>
    </div>
    `,
    { wide: true }
  );

  $('#cfg-cancel', overlay).addEventListener('click', () => overlay.remove());

  $('#cfg-dir-pick', overlay).addEventListener('click', async () => {
    const dir = await invoke(window.api.config.pick('serversDir'));
    if (dir) {
      $('#cfg-dir', overlay).value = dir;
      await refreshServers();
    }
  });

  $('#cfg-java-pick', overlay).addEventListener('click', async () => {
    const picked = await invoke(window.api.config.pick('java'));
    if (!picked) return;
    const select = $('#cfg-java', overlay);
    const option = document.createElement('option');
    option.value = picked;
    option.textContent = picked;
    option.selected = true;
    select.appendChild(option);
  });

  $('#cfg-cf-pick', overlay).addEventListener('click', async () => {
    const picked = await invoke(window.api.config.pick('cloudflared'));
    if (picked) $('#cfg-cf', overlay).value = picked;
  });

  $('#cfg-save', overlay).addEventListener('click', async () => {
    try {
      state.config = await invoke(
        window.api.config.set({
          javaPath: $('#cfg-java', overlay).value || '',
          cloudflaredPath: $('#cfg-cf', overlay).value.trim(),
          maxBackups: Number($('#cfg-max', overlay).value) || 0,
        })
      );
      state.info = await invoke(window.api.app.info());
      overlay.remove();
      toast('Ajustes guardados');
      await refreshServers();
    } catch (error) {
      toast(cleanError(error), 'error');
    }
  });
}

/* ================================= Tabs ================================ */

function setTab(name) {
  state.activeTab = name;
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  for (const panel of $$('.panel')) panel.classList.toggle('active', panel.dataset.panel === name);

  if (name === 'properties') loadProperties();
  if (name === 'backups') loadBackups();
  if (name === 'network') {
    renderNet();
    loadNetInfo();
  }
  if (name === 'settings') renderSettingsTab();
  if (name === 'players') {
    if (state.statuses[state.currentId]?.status === 'running') runCommand('list');
    renderPlayers();
  }
  if (name === 'console') {
    const consoleEl = $('#console');
    if (state.autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}

/* ================================ Acciones ============================= */

async function startServer() {
  if (!state.currentId) return;
  const button = $('#btn-start');
  button.disabled = true;
  button.textContent = 'Iniciando…';
  try {
    await invoke(window.api.servers.start(state.currentId));
  } catch (error) {
    toast(cleanError(error), 'error', 8000);
  } finally {
    button.textContent = '▶ Iniciar';
    button.disabled = false;
    renderStatus();
  }
}

async function stopServer(force = false) {
  if (!state.currentId) return;
  if (!force) {
    const ok = await confirmDialog({
      title: 'Detener servidor',
      message: 'Se enviará el comando stop para guardar el mundo. Puede tardar unos segundos.',
      confirmLabel: 'Detener',
    });
    if (!ok) return;
  }
  try {
    if (force) await invoke(window.api.servers.kill(state.currentId));
    else await invoke(window.api.servers.stop(state.currentId));
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ================================ Eventos ============================== */

function bindEvents() {
  $('#btn-new').addEventListener('click', openNewServerModal);
  $('#btn-new-empty').addEventListener('click', openNewServerModal);
  $('#btn-settings').addEventListener('click', () =>
    openAppSettings().catch((error) => toast(cleanError(error), 'error'))
  );

  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  }

  $('#btn-start').addEventListener('click', startServer);
  $('#btn-stop').addEventListener('click', () => stopServer(false));
  $('#btn-kill').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Forzar cierre',
      message: 'El servidor se cerrará sin guardar. El mundo podría quedar corrupto. ¿Continuar?',
      confirmLabel: 'Forzar cierre',
      danger: true,
    });
    if (ok) stopServer(true);
  });

  $('#btn-open-folder').addEventListener('click', () => {
    if (!state.currentId) return;
    invoke(window.api.servers.openFolder(state.currentId)).catch((error) => toast(cleanError(error), 'error'));
  });

  $('#btn-goto-network').addEventListener('click', () => setTab('network'));

  $('#console-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#console-input');
    const command = input.value.trim();
    if (!command) return;
    if (state.commandHistory[state.commandHistory.length - 1] !== command) state.commandHistory.push(command);
    state.historyIndex = state.commandHistory.length;
    input.value = '';
    try {
      await invoke(window.api.servers.command(state.currentId, command));
    } catch (error) {
      toast(cleanError(error), 'error');
    }
  });

  $('#console-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      if (!state.commandHistory.length) return;
      event.preventDefault();
      state.historyIndex = Math.max(0, state.historyIndex - 1);
      event.target.value = state.commandHistory[state.historyIndex] || '';
    } else if (event.key === 'ArrowDown') {
      if (!state.commandHistory.length) return;
      event.preventDefault();
      state.historyIndex = Math.min(state.commandHistory.length, state.historyIndex + 1);
      event.target.value = state.commandHistory[state.historyIndex] || '';
    }
  });

  $('#autoscroll').addEventListener('change', (event) => {
    state.autoscroll = event.target.checked;
  });

  $('#btn-clear-console').addEventListener('click', () => {
    state.logs = [];
    renderConsole();
  });

  $('#btn-copy-console').addEventListener('click', () => {
    const text = state.logs.map((entry) => `[${new Date(entry.t).toLocaleTimeString('es-ES')}] ${entry.line}`).join('\n');
    copyText(text || '(consola vacía)');
  });

  $('#btn-refresh-players').addEventListener('click', () => {
    if (state.statuses[state.currentId]?.status === 'running') runCommand('list');
    renderPlayers();
  });

  $('#btn-props-save').addEventListener('click', saveProperties);
  $('#btn-props-raw').addEventListener('click', toggleRawEditor);

  $('#btn-backup-create').addEventListener('click', createBackup);
  $('#btn-backup-open').addEventListener('click', () => {
    if (!state.currentId) return;
    invoke(window.api.backups.open(state.currentId)).catch((error) => toast(cleanError(error), 'error'));
  });

  $('#btn-net-refresh').addEventListener('click', loadNetInfo);
  $('#btn-check-public').addEventListener('click', checkPublic);
  $('#btn-upnp-open').addEventListener('click', openUpnpPorts);
  $('#btn-upnp-close').addEventListener('click', closeUpnpPorts);
  $('#btn-tunnel-start').addEventListener('click', startTunnel);
  $('#btn-tunnel-stop').addEventListener('click', stopTunnel);

  $('#btn-save-settings').addEventListener('click', saveServerSettings);
  $('#btn-upload-world').addEventListener('click', uploadWorld);
  $('#btn-reinstall').addEventListener('click', reinstallServer);
  $('#btn-delete-server').addEventListener('click', deleteServer);
  $('#btn-pick-java').addEventListener('click', async () => {
    const picked = await invoke(window.api.config.pick('java'));
    if (!picked) return;
    const select = $('#set-java');
    const option = document.createElement('option');
    option.value = picked;
    option.textContent = picked;
    option.selected = true;
    select.appendChild(option);
  });

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-copy]');
    if (!trigger) return;
    const target = document.getElementById(trigger.dataset.copy);
    if (target) copyText(target.textContent);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const overlays = $$('#modal-root .overlay');
      const last = overlays[overlays.length - 1];
      if (last) last.remove();
    }
  });
}

bindEvents();
boot();
