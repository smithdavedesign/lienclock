#!/usr/bin/env node
// Local check of the Cloudflare Worker against a real Postgres wire protocol, with no Postgres install:
// serves an in-memory PGlite on 127.0.0.1:<port> (default 54329) for `wrangler dev` to connect to.
//
//   npm run cf:build
//   node scripts/pglite-wire.mjs &
//   npx wrangler dev --var DATABASE_URL:postgres://postgres@127.0.0.1:54329/postgres
//
// Any user/password is accepted (no authentication) and every connection shares PGlite's single
// session, one message at a time: fine for clicking through, not for anything concurrent.
import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';

const port = Number(process.argv[2] ?? 54329);
const db = new PGlite();
await db.waitReady;

let queue = Promise.resolve();
/** PGlite is one session: run each message to completion before the next, across connections. */
const serially = (task) => (queue = queue.then(task, task));

function message(type, body = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const cstrings = (...parts) => Buffer.from(parts.map((p) => `${p}\0`).join(''), 'utf8');

function startupReply() {
  const keyData = Buffer.alloc(8);
  keyData.writeInt32BE(process.pid, 0);
  const idle = Buffer.from('I', 'latin1');
  return Buffer.concat([
    message('R', Buffer.alloc(4)), // AuthenticationOk
    message('S', cstrings('server_version', '17.0')),
    message('S', cstrings('server_encoding', 'UTF8')),
    message('S', cstrings('client_encoding', 'UTF8')),
    message('S', cstrings('DateStyle', 'ISO, MDY')),
    message('S', cstrings('integer_datetimes', 'on')),
    message('S', cstrings('standard_conforming_strings', 'on')),
    message('K', keyData),
    message('Z', idle), // ReadyForQuery
  ]);
}

createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let started = false;
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        buffer = buffer.subarray(length);
        if (code === 80877103 || code === 80877104) {
          socket.write('N'); // SSLRequest / GSSENCRequest: not here, carry on in plain text
          continue;
        }
        started = true;
        socket.write(startupReply());
        continue;
      }
      if (buffer.length < 5) return;
      const length = buffer.readInt32BE(1) + 1;
      if (buffer.length < length) return;
      const msg = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      if (msg[0] === 0x58) {
        socket.end(); // Terminate
        return;
      }
      serially(async () => {
        const reply = await db.execProtocolRaw(new Uint8Array(msg));
        if (reply.length && !socket.destroyed) socket.write(Buffer.from(reply));
      });
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`PGlite on postgres://postgres@127.0.0.1:${port}/postgres`));
