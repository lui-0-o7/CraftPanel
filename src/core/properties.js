'use strict';

/**
 * Lector/escritor de archivos .properties que conserva comentarios,
 * orden y claves desconocidas.
 */

function unescapeValue(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc === 'n') return '\n';
    if (esc === 't') return '\t';
    if (esc === 'r') return '\r';
    return esc;
  });
}

function escapeValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function parse(text) {
  const entries = [];
  const map = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      entries.push({ type: 'blank', raw });
      continue;
    }
    if (line.startsWith('#') || line.startsWith('!')) {
      entries.push({ type: 'comment', raw });
      continue;
    }
    const match = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (!match) {
      entries.push({ type: 'comment', raw });
      continue;
    }
    const key = match[1];
    const value = unescapeValue(match[2]);
    entries.push({ type: 'prop', key, value, raw });
    map[key] = value;
  }
  return { entries, map };
}

function setValues(text, patch) {
  const { entries } = parse(text);
  const pending = new Map(Object.entries(patch));
  const out = [];
  for (const entry of entries) {
    if (entry.type === 'prop' && pending.has(entry.key)) {
      out.push(`${entry.key}=${escapeValue(pending.get(entry.key))}`);
      pending.delete(entry.key);
    } else {
      out.push(entry.raw);
    }
  }
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const [key, value] of pending) out.push(`${key}=${escapeValue(value)}`);
  }
  let result = out.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return result;
}

function build(initial) {
  const lines = ['#Archivo de configuracion generado por CraftPanel'];
  for (const [key, value] of Object.entries(initial)) {
    lines.push(`${key}=${escapeValue(value)}`);
  }
  return lines.join('\n') + '\n';
}

const JAVA_DEFAULTS = {
  'server-port': '25565',
  'motd': 'Servidor de Minecraft',
  'gamemode': 'survival',
  'difficulty': 'normal',
  'max-players': '20',
  'online-mode': 'true',
  'pvp': 'true',
  'level-name': 'world',
  'view-distance': '10',
  'simulation-distance': '10',
  'spawn-protection': '16',
  'white-list': 'false',
  'allow-flight': 'false',
  'allow-nether': 'true',
  'enable-command-block': 'false',
  'enforce-secure-profile': 'true',
  'level-seed': '',
};

const BEDROCK_DEFAULTS = {
  'server-name': 'Servidor de Minecraft',
  'gamemode': 'survival',
  'difficulty': 'normal',
  'server-port': '19132',
  'server-portv6': '19133',
  'max-players': '20',
  'online-mode': 'true',
  'allow-cheats': 'false',
  'level-name': 'Bedrock level',
  'view-distance': '32',
  'tick-distance': '4',
  'player-idle-timeout': '30',
  'default-player-permission-level': 'member',
  'allow-list': 'false',
  'texturepack-required': 'false',
  'compression-threshold': '1',
  'client-side-chunk-generation-enabled': 'true',
  'block-network-ids-are-hashes': 'true',
  'server-authoritative-movement': 'server-auth',
};

const JAVA_EDITABLE = [
  { key: 'motd', label: 'Mensaje del día (MOTD)', type: 'text' },
  { key: 'server-port', label: 'Puerto', type: 'number', min: 1, max: 65535 },
  { key: 'gamemode', label: 'Modo de juego', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Dificultad', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'max-players', label: 'Jugadores máximos', type: 'number', min: 1, max: 500 },
  { key: 'online-mode', label: 'Verificar cuentas (online-mode)', type: 'boolean' },
  { key: 'pvp', label: 'PvP', type: 'boolean' },
  { key: 'white-list', label: 'Lista blanca', type: 'boolean' },
  { key: 'allow-flight', label: 'Permitir volar', type: 'boolean' },
  { key: 'allow-nether', label: 'Permitir el Nether', type: 'boolean' },
  { key: 'enable-command-block', label: 'Bloques de comandos', type: 'boolean' },
  { key: 'level-name', label: 'Nombre del mundo', type: 'text' },
  { key: 'level-seed', label: 'Semilla', type: 'text' },
  { key: 'view-distance', label: 'Distancia de visión', type: 'number', min: 2, max: 32 },
  { key: 'simulation-distance', label: 'Distancia de simulación', type: 'number', min: 2, max: 32 },
  { key: 'spawn-protection', label: 'Protección del spawn (bloques)', type: 'number', min: 0, max: 1000 },
  { key: 'enforce-secure-profile', label: 'Exigir perfil seguro', type: 'boolean' },
];

const BEDROCK_EDITABLE = [
  { key: 'server-name', label: 'Nombre del servidor', type: 'text' },
  { key: 'server-port', label: 'Puerto IPv4', type: 'number', min: 1, max: 65535 },
  { key: 'server-portv6', label: 'Puerto IPv6', type: 'number', min: 1, max: 65535 },
  { key: 'gamemode', label: 'Modo de juego', type: 'select', options: ['survival', 'creative', 'adventure'] },
  { key: 'difficulty', label: 'Dificultad', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'max-players', label: 'Jugadores máximos', type: 'number', min: 1, max: 100 },
  { key: 'online-mode', label: 'Verificar cuentas (Xbox Live)', type: 'boolean' },
  { key: 'allow-cheats', label: 'Permitir trucos', type: 'boolean' },
  { key: 'allow-list', label: 'Lista blanca (allowlist.json)', type: 'boolean' },
  { key: 'level-name', label: 'Nombre del mundo', type: 'text' },
  { key: 'view-distance', label: 'Distancia de visión', type: 'number', min: 4, max: 96 },
  { key: 'tick-distance', label: 'Distancia de tick', type: 'number', min: 4, max: 12 },
  { key: 'player-idle-timeout', label: 'Expulsar inactivos (min)', type: 'number', min: 0, max: 1440 },
  { key: 'default-player-permission-level', label: 'Permisos por defecto', type: 'select', options: ['visitor', 'member', 'operator'] },
];

module.exports = {
  parse,
  setValues,
  build,
  escapeValue,
  unescapeValue,
  JAVA_DEFAULTS,
  BEDROCK_DEFAULTS,
  JAVA_EDITABLE,
  BEDROCK_EDITABLE,
};
