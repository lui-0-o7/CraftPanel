'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const store = require('./store');

class TunnelManager extends EventEmitter {
  constructor() {
    super();
    this.active = null;
    this.history = [];
  }

  binary() {
    return store.get('cloudflaredPath') || (process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  available() {
    try {
      const res = spawnSync(this.binary(), ['--version'], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
      if (res.status === 0) {
        return { ok: true, version: String(res.stdout || res.stderr || '').trim() };
      }
      return { ok: false, error: 'cloudflared no respondió' };
    } catch {
      return { ok: false, error: 'cloudflared no está instalado o no está en el PATH' };
    }
  }

  status() {
    if (!this.active) return { state: 'stopped' };
    return {
      state: this.active.state,
      serverId: this.active.serverId,
      host: this.active.host,
      url: this.active.host ? `tcp://${this.active.host}` : '',
      port: this.active.port,
      command: this.active.host
        ? `cloudflared access tcp --hostname ${this.active.host} --url 127.0.0.1:${this.active.port}`
        : '',
      error: this.active.error || '',
      log: this.active.log.slice(-25),
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }

  start(server) {
    if (this.active?.proc) {
      if (this.active.serverId === server.id) return this.status();
      this.stop();
    }
    const check = this.available();
    if (!check.ok) {
      throw new Error(
        'No se encontró cloudflared. Instálalo desde https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ o indica su ruta en Ajustes.'
      );
    }

    const port = Number(server.port);
    const proc = spawn(this.binary(), ['tunnel', '--url', `tcp://127.0.0.1:${port}`, '--no-autoupdate'], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });

    this.active = {
      serverId: server.id,
      port,
      proc,
      host: '',
      state: 'starting',
      error: '',
      log: [],
    };
    this.emitStatus();

    const handle = (chunk) => {
      const text = String(chunk).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.active.log.push(line.trim());
        if (this.active.log.length > 120) this.active.log.splice(0, this.active.log.length - 120);
        const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(line);
        if (match && !this.active.host) {
          this.active.host = match[1];
          this.active.state = 'running';
          this.emitStatus();
        }
      }
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);

    proc.on('error', (err) => {
      if (!this.active) return;
      this.active.state = 'error';
      this.active.error = err.message;
      this.emitStatus();
    });

    proc.on('close', (code) => {
      if (!this.active) return;
      const wasRunning = this.active.state === 'running';
      this.active.proc = null;
      if (this.active.state !== 'stopped') {
        this.active.state = 'error';
        this.active.error = wasRunning
          ? 'El túnel se cerró inesperadamente'
          : `cloudflared terminó con código ${code}`;
        this.emitStatus();
      }
    });

    return this.status();
  }

  stop() {
    if (!this.active) return { ok: true };
    this.active.state = 'stopped';
    const proc = this.active.proc;
    this.active.proc = null;
    try {
      proc?.kill();
    } catch {
      /* ignora */
    }
    this.emitStatus();
    this.active = null;
    return { ok: true };
  }
}

module.exports = { TunnelManager };
