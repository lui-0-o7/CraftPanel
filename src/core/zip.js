'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

class ZipWriter {
  constructor(dest) {
    this.dest = dest;
    this.fd = fs.openSync(dest, 'w');
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length, this.offset);
    this.offset += buf.length;
  }

  addFile(name, data, mtime = new Date()) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const deflated = zlib.deflateRawSync(content, { level: 6 });
    const useDeflate = deflated.length < content.length;
    const body = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(content);
    const { time, day } = dosDateTime(mtime);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    const localOffset = this.offset;
    this._write(header);
    this._write(nameBuf);
    this._write(body);

    this.entries.push({
      nameBuf,
      crc,
      compSize: body.length,
      size: content.length,
      method,
      time,
      day,
      localOffset,
    });
    return this.entries.length;
  }

  addDirectory(dir, { prefix = '', filter = null, onProgress = null } = {}) {
    const walk = (current, rel) => {
      let items = [];
      try {
        items = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(current, item.name);
        const relName = rel ? `${rel}/${item.name}` : item.name;
        if (filter && !filter(full, relName, item)) continue;
        if (item.isDirectory()) {
          walk(full, relName);
        } else if (item.isFile()) {
          try {
            const stat = fs.statSync(full);
            this.addFile(prefix ? `${prefix}/${relName}` : relName, fs.readFileSync(full), stat.mtime);
            if (onProgress) onProgress(relName, this.entries.length);
          } catch {
            /* archivo bloqueado: se omite */
          }
        }
      }
    };
    walk(dir, '');
  }

  close() {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.day, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBuf.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      this._write(header);
      this._write(entry.nameBuf);
    }
    const centralSize = this.offset - centralStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);

    fs.closeSync(this.fd);
    return this.dest;
  }
}

function safeJoin(destDir, name) {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(destDir, clean);
  const root = path.resolve(destDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

async function extractZip(zipPath, destDir, { onProgress } = {}) {
  const fd = await fs.promises.open(zipPath, 'r');
  try {
    const stat = await fd.stat();
    const tailSize = Math.min(stat.size, 66 * 1024);
    const tail = Buffer.alloc(tailSize);
    await fd.read(tail, 0, tailSize, stat.size - tailSize);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('El archivo ZIP está dañado');

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOffset);

    let pointer = 0;
    const files = [];
    for (let i = 0; i < count; i += 1) {
      if (cd.readUInt32LE(pointer) !== 0x02014b50) break;
      const method = cd.readUInt16LE(pointer + 10);
      const compSize = cd.readUInt32LE(pointer + 20);
      const nameLen = cd.readUInt16LE(pointer + 28);
      const extraLen = cd.readUInt16LE(pointer + 30);
      const commentLen = cd.readUInt16LE(pointer + 32);
      const localOffset = cd.readUInt32LE(pointer + 42);
      const name = cd.toString('utf8', pointer + 46, pointer + 46 + nameLen);
      pointer += 46 + nameLen + extraLen + commentLen;
      files.push({ name, method, compSize, localOffset });
    }

    let done = 0;
    for (const file of files) {
      const target = safeJoin(destDir, file.name);
      if (!target) continue;
      if (file.name.endsWith('/')) {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      const localHeader = Buffer.alloc(30);
      await fd.read(localHeader, 0, 30, file.localOffset);
      const lNameLen = localHeader.readUInt16LE(26);
      const lExtraLen = localHeader.readUInt16LE(28);
      const dataStart = file.localOffset + 30 + lNameLen + lExtraLen;
      const compressed = Buffer.alloc(file.compSize);
      if (file.compSize) await fd.read(compressed, 0, file.compSize, dataStart);
      const content = file.method === 8 ? zlib.inflateRawSync(compressed) : compressed;
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
      done += 1;
      if (onProgress) onProgress(done, files.length, file.name);
    }
  } finally {
    await fd.close();
  }
}

function listZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailSize = Math.min(size, 66 * 1024);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const out = [];
    let pointer = 0;
    for (let i = 0; i < count; i += 1) {
      if (cd.readUInt32LE(pointer) !== 0x02014b50) break;
      const size2 = cd.readUInt32LE(pointer + 24);
      const nameLen = cd.readUInt16LE(pointer + 28);
      const extraLen = cd.readUInt16LE(pointer + 30);
      const commentLen = cd.readUInt16LE(pointer + 32);
      out.push({ name: cd.toString('utf8', pointer + 46, pointer + 46 + nameLen), size: size2 });
      pointer += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { ZipWriter, extractZip, listZip, crc32 };
