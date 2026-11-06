'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel) {
  return (...args) => ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel) {
  return (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('api', {
  app: {
    info: invoke('app:info'),
    openExternal: invoke('app:openExternal'),
    openPath: invoke('app:openPath'),
  },
  config: {
    get: invoke('config:get'),
    set: invoke('config:set'),
    pick: invoke('config:pick'),
  },
  java: {
    detect: invoke('java:detect'),
  },
  servers: {
    list: invoke('servers:list'),
    get: invoke('servers:get'),
    create: invoke('servers:create'),
    reinstall: invoke('servers:reinstall'),
    update: invoke('servers:update'),
    remove: invoke('servers:delete'),
    start: invoke('servers:start'),
    stop: invoke('servers:stop'),
    kill: invoke('servers:kill'),
    command: invoke('servers:command'),
    status: invoke('servers:status'),
    logs: invoke('servers:logs'),
    openFolder: invoke('servers:openFolder'),
    uploadWorld: invoke('servers:uploadWorld'),
  },
  props: {
    read: invoke('props:read'),
    save: invoke('props:save'),
  },
  backups: {
    list: invoke('backups:list'),
    create: invoke('backups:create'),
    restore: invoke('backups:restore'),
    remove: invoke('backups:remove'),
    open: invoke('backups:open'),
  },
  net: {
    info: invoke('net:info'),
    extra: invoke('net:extra'),
    checkPort: invoke('net:checkPort'),
    checkPublic: invoke('net:checkPublic'),
    openPorts: invoke('net:openPorts'),
    closePorts: invoke('net:closePorts'),
  },
  tunnel: {
    status: invoke('tunnel:status'),
    available: invoke('tunnel:available'),
    start: invoke('tunnel:start'),
    stop: invoke('tunnel:stop'),
  },
  versions: {
    list: invoke('versions:list'),
  },
  events: {
    serverStatus: subscribe('server:status'),
    serverLog: subscribe('server:log'),
    installProgress: subscribe('install:progress'),
    tunnelStatus: subscribe('tunnel:status'),
    backupProgress: subscribe('backup:progress'),
    configChanged: subscribe('config:changed'),
  },
});
