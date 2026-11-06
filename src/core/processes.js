'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const java = require('./java');
const servers = require('./servers');

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG_LINES = 4000;

function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

function levelOf(line) {
  if (/\b(ERROR|SEVERE|FATAL|Exception|Error:)\b/.test(line)) return 'error';
  if (/\b(WARN|WARNING)\b/.test(line)) return 'warn';
  if (/joined the game|Player (connected|Spawned)|Done \(/.test(line)) return 'success';
  return 'info';
}

class Runtime {
  constructor(server) {
    this.server = server;
    this.proc = null;
    this.status = 'stopped';
    this.players = new Set();
    this.maxPlayers = 20;
    this.logs = [];
    this.buffer = '';
    this.startedAt = null;
    this.stopping = false;
    this.listTimer = null;
    this.lastExit = null;
    this.ready = false;
  }
}

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.runtimes = new Map();
  }

  runtime(id) {
    let rt = this.runtimes.get(id);
    if (!rt) {
      const server = servers.get(id);
      if (!server) return null;
      rt = new Runtime(server);
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  snapshot(rt) {
    return {
      id: rt.server.id,
      status: rt.status,
      players: [...rt.players],
      maxPlayers: rt.maxPlayers,
      startedAt: rt.startedAt,
      pid: rt.proc?.pid || null,
      lastExit: rt.lastExit,
      ready: rt.ready,
    };
  }

  emitStatus(rt) {
    this.emit('status', this.snapshot(rt));
  }

  log(rt, rawLine) {
    const line = stripAnsi(rawLine).replace(/\r$/, '');
    if (!line.trim()) return;
    const entry = { t: Date.now(), line, level: levelOf(line) };
    rt.logs.push(entry);
    if (rt.logs.length > MAX_LOG_LINES) rt.logs.splice(0, rt.logs.length - MAX_LOG_LINES);
    this.emit('log', { id: rt.server.id, ...entry });
    try {
      fs.appendFileSync(path.join(rt.server.dir, 'logs', 'latest.log'), `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      /* el registro es opcional */
    }
    this.parseLine(rt, line);
  }

  parseLine(rt, line) {
    const javaJoin = line.match(/\]:\s+([A-Za-z0-9_]{1,16}) joined the game/);
    if (javaJoin) {
      rt.players.add(javaJoin[1]);
      this.emitStatus(rt);
      return;
    }
    const javaLeave = line.match(/\]:\s+([A-Za-z0-9_]{1,16}) left the game/);
    if (javaLeave) {
      rt.players.delete(javaLeave[1]);
      this.emitStatus(rt);
      return;
    }
    const bedrockJoin = line.match(/Player (?:connected|Spawned):\s*([^,\s]+)/);
    if (bedrockJoin) {
      rt.players.add(bedrockJoin[1]);
      this.emitStatus(rt);
      return;
    }
    const bedrockLeave = line.match(/Player disconnected:\s*([^,\s]+)/);
    if (bedrockLeave) {
      rt.players.delete(bedrockLeave[1]);
      this.emitStatus(rt);
      return;
    }
    const list = line.match(/There are (\d+)(?:\s+of a max of|\/)\s*(\d+) players online:?\s*(.*)$/i);
    if (list) {
      rt.maxPlayers = Number(list[2]) || rt.maxPlayers;
      const names = String(list[3] || '')
        .split(/[, ]+/)
        .map((n) => n.trim())
        .filter(Boolean);
      rt.players = new Set(names);
      this.emitStatus(rt);
      return;
    }
    if (/Done \([\d.,]+s\)!/.test(line) || /Server started\./.test(line)) {
      rt.ready = true;
      rt.status = 'running';
      this.emitStatus(rt);
    }
  }

  buildCommand(rt) {
    const server = rt.server;
    if (!fs.existsSync(servers.executable(server))) {
      throw new Error(
        server.edition === 'bedrock'
          ? 'No se encontró bedrock_server.exe. Vuelve a crear el servidor o comprueba los archivos.'
          : 'No se encontró el archivo del servidor. Vuelve a crear el servidor.'
      );
    }

    if (server.edition === 'bedrock') {
      const exe = servers.executable(server);
      return {
        command: exe,
        args: [],
        options: {
          cwd: server.dir,
          windowsHide: true,
          env: { ...process.env, LD_LIBRARY_PATH: server.dir },
        },
      };
    }

    const javaInfo = java.resolve(server.javaPath);
    const ram = Math.max(512, Number(server.ramMB) || 2048);
    const args = [
      `-Xms${Math.min(1024, ram)}M`,
      `-Xmx${ram}M`,
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
    ];
    if (server.software === 'paper') {
      args.push(
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1ReservePercent=20',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:MaxTenuringThreshold=1'
      );
    }
    const jar = server.software === 'fabric' ? 'fabric-server-launch.jar' : 'server.jar';
    args.push('-jar', jar, 'nogui');
    return {
      command: javaInfo.path,
      args,
      options: { cwd: server.dir, windowsHide: true, env: { ...process.env } },
    };
  }

  async start(id) {
    const rt = this.runtime(id);
    if (!rt) throw new Error('Servidor no encontrado');
    if (rt.proc) throw new Error('El servidor ya está en ejecución');
    if (!rt.server.installed) throw new Error('El servidor todavía no está instalado');

    fs.mkdirSync(path.join(rt.server.dir, 'logs'), { recursive: true });
    try {
      fs.writeFileSync(path.join(rt.server.dir, 'logs', 'latest.log'), '');
    } catch {
      /* opcional */
    }

    const { command, args, options } = this.buildCommand(rt);
    rt.status = 'starting';
    rt.stopping = false;
    rt.ready = false;
    rt.players.clear();
    rt.buffer = '';
    rt.lastExit = null;
    rt.startedAt = Date.now();
    this.emitStatus(rt);

    const proc = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    rt.proc = proc;

    proc.stdout.on('data', (chunk) => this.consume(rt, chunk));
    proc.stderr.on('data', (chunk) => this.consume(rt, chunk));

    proc.on('error', (err) => {
      const message =
        err.code === 'ENOENT'
          ? 'No se encontró Java. Instala un JDK o indica la ruta en Ajustes.'
          : err.message;
      rt.status = 'error';
      rt.lastExit = { code: null, message };
      this.log(rt, `[CraftPanel] ${message}`);
      this.emitStatus(rt);
      rt.proc = null;
    });

    proc.on('close', (code) => {
      clearInterval(rt.listTimer);
      rt.listTimer = null;
      rt.proc = null;
      rt.players.clear();
      rt.ready = false;
      const wasStopping = rt.stopping;
      rt.stopping = false;
      rt.status = code === 0 || wasStopping ? 'stopped' : 'crashed';
      rt.lastExit = { code, at: Date.now(), expected: wasStopping || code === 0 };
      rt.startedAt = null;
      if (rt.status === 'crashed') {
        this.log(rt, `[CraftPanel] El servidor se cerró inesperadamente (código ${code}). Revisa la consola.`);
      }
      this.emitStatus(rt);
    });

    rt.listTimer = setInterval(() => {
      if (rt.proc && rt.status === 'running') this.send(id, 'list');
    }, 20000);

    return this.snapshot(rt);
  }

  consume(rt, chunk) {
    rt.buffer += String(chunk);
    if (rt.buffer.length > 200000) rt.buffer = rt.buffer.slice(-100000);
    const parts = rt.buffer.split(/\r?\n/);
    rt.buffer = parts.pop() ?? '';
    for (const part of parts) this.log(rt, part);
  }

  send(id, command) {
    const rt = this.runtime(id);
    if (!rt?.proc?.stdin) throw new Error('El servidor no está en ejecución');
    rt.proc.stdin.write(`${command}\n`);
    this.log(rt, `> ${command}`);
  }

  async stop(id, timeoutMs = 45000) {
    const rt = this.runtime(id);
    if (!rt?.proc) return { ok: true, alreadyStopped: true };
    rt.stopping = true;
    rt.status = 'stopping';
    this.emitStatus(rt);
    try {
      rt.proc.stdin.write('stop\n');
      this.log(rt, '> stop');
    } catch {
      this.kill(id);
      return { ok: true };
    }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      rt.proc.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      this.log(rt, '[CraftPanel] El servidor no respondió, cerrando por la fuerza...');
      this.kill(id);
    }
    return { ok: true, forced: !exited };
  }

  kill(id) {
    const rt = this.runtime(id);
    if (!rt?.proc) return;
    const pid = rt.proc.pid;
    rt.stopping = true;
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
      } else {
        rt.proc.kill('SIGKILL');
      }
    } catch {
      /* el proceso ya no existe */
    }
  }

  getLogs(id, limit = 500) {
    const rt = this.runtime(id);
    if (!rt) return [];
    return rt.logs.slice(-limit);
  }

  getStatus(id) {
    const rt = this.runtime(id);
    if (!rt) return null;
    return this.snapshot(rt);
  }

  isRunning(id) {
    return Boolean(this.runtime(id)?.proc);
  }

  async shutdownAll() {
    const running = [...this.runtimes.values()].filter((rt) => rt.proc);
    await Promise.allSettled(running.map((rt) => this.stop(rt.server.id, 20000)));
  }
}

module.exports = { ServerManager };
