'use strict';
/*
 * 零依赖 WebSocket 最小实现（RFC 6455 子集）：
 *   服务端：attachServer(httpServer, { onConnection })
 *   客户端（测试用）：createClient(url, opts)
 * 仅支持本项目需要的能力：文本帧、自动 ping/pong、close 握手、mask 编解码、
 * 单帧消息上限保护（大文档仍远小于上限）。不支持分片与 permessage-deflate。
 */

const crypto = require('crypto');
const http = require('http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;

function makeAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/* ---------------- 服务端 ---------------- */

function attachServer(httpServer, handlers) {
  const wss = { clients: new Set() };
  httpServer.on('upgrade', function (req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = makeAccept(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const ws = new ServerSocket(socket, req);
    wss.clients.add(ws);
    socket.on('close', function () {
      wss.clients.delete(ws);
      ws._emitClose();
    });
    if (handlers && handlers.onConnection) handlers.onConnection(ws, req);
  });
  return wss;
}

class ServerSocket {
  constructor(socket, req) {
    this._socket = socket;
    this._listeners = { message: [], close: [] };
    this.readyState = 1; // OPEN
    this.url = req ? req.url : '/';
    this.headers = req ? req.headers : {};
    this._dead = false;
    this._buf = Buffer.alloc(0);
    this._frag = null; // {opcode, chunks:[]}
    const self = this;
    socket.on('data', function (d) { self._onData(d); });
    socket.on('error', function () { self._dead = true; });
  }
  on(evt, fn) {
    if (this._listeners[evt]) this._listeners[evt].push(fn);
    return this;
  }
  off(evt, fn) {
    if (!this._listeners[evt]) return;
    this._listeners[evt] = this._listeners[evt].filter(function (f) { return f !== fn; });
  }
  _emit(evt, arg) {
    for (const fn of (this._listeners[evt] || [])) {
      try { fn(arg); } catch (e) { /* 监听器异常不影响连接 */ }
    }
  }
  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    let consumed = 0;
    while (true) {
      const frame = this._parseFrame(this._buf.slice(consumed));
      if (!frame) break;
      consumed += frame.total;
      this._handleFrame(frame);
    }
    this._buf = consumed ? this._buf.slice(consumed) : this._buf;
  }
  _parseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const fin = b0 & 0x80;
    const opcode = b0 & 0x0f;
    const masked = b1 & 0x80;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > 0x7fffffff) { this.close(1009, 'frame too large'); return null; }
      len = Number(big); off = 10;
    }
    if (len > 20 * 1024 * 1024) { this.close(1009, 'frame too large'); return null; }
    let mask;
    if (masked) {
      if (buf.length < off + 4) return null;
      mask = buf.slice(off, off + 4); off += 4;
    }
    if (buf.length < off + len) return null;
    const payload = buf.slice(off, off + len);
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return { fin: fin, opcode: opcode, payload: payload, total: off + len };
  }
  _handleFrame(frame) {
    const opcode = frame.opcode;
    if (opcode === OP_PING) { this._send(OP_PONG, frame.payload); return; }
    if (opcode === OP_PONG) { return; }
    if (opcode === OP_CLOSE) {
      let code = 1000;
      if (frame.payload.length >= 2) code = frame.payload.readUInt16BE(0);
      if (this.readyState === 1) {
        this._send(OP_CLOSE, frame.payload);
        this.readyState = 2;
      }
      try { this._socket.end(); } catch (e) {}
      this._dead = true;
      this.readyState = 3;
      this._emitClose(code);
      return;
    }
    if (opcode === OP_TEXT || opcode === 0x0) {
      if (!frame.fin) {
        // 分片：缓存（客户端几乎不发，简单支持）
        if (!this._frag) this._frag = { chunks: [] };
        this._frag.chunks.push(frame.payload);
        return;
      }
      let payload = frame.payload;
      if (this._frag) {
        this._frag.chunks.push(payload);
        payload = Buffer.concat(this._frag.chunks);
        this._frag = null;
      }
      const text = payload.toString('utf8');
      this._emit('message', text);
    }
  }
  _emitClose(code) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this._emit('close', code || 1000);
  }
  send(data) {
    if (this.readyState !== 1) return;
    this._send(OP_TEXT, Buffer.from(String(data), 'utf8'));
  }
  ping() {
    if (this.readyState === 1) this._send(OP_PING, Buffer.alloc(0));
  }
  close(code, reason) {
    if (this.readyState !== 1) return;
    const payload = Buffer.alloc(2 + (reason ? Buffer.byteLength(reason) : 0));
    payload.writeUInt16BE(code || 1000, 0);
    if (reason) payload.write(reason, 2);
    this._send(OP_CLOSE, payload);
    this.readyState = 2;
    try { this._socket.end(); } catch (e) {}
  }
  _send(opcode, payload) {
    if (this._dead) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    try {
      this._socket.write(Buffer.concat([header, payload]));
    } catch (e) { this._dead = true; }
  }
}

/* ---------------- 客户端（测试/Node 环境用） ---------------- */

function createClient(urlOrOpts, opts) {
  return new Promise(function (resolve, reject) {
    let u, options;
    if (typeof urlOrOpts === 'string') {
      u = new URL(urlOrOpts);
      options = opts || {};
    } else {
      options = urlOrOpts || {};
      u = new URL(options.url);
    }
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      },
      timeout: options.timeout || 5000
    });
    req.on('upgrade', function (res, socket) {
      const ws = new ClientSocket(socket);
      ws.headers = res.headers;
      resolve(ws);
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.end();
  });
}

class ClientSocket extends ServerSocket {
  constructor(socket) {
    super(socket, null);
  }
  _send(opcode, payload) {
    if (this._dead) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2 + 4);
      header[1] = 0x80 | len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4 + 4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10 + 4);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    mask.copy(header, header.length - 4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try {
      this._socket.write(Buffer.concat([header, masked]));
    } catch (e) { this._dead = true; }
  }
}

module.exports = { attachServer: attachServer, createClient: createClient };
