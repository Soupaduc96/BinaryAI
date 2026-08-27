#!/usr/bin/env node
/**
 * A standalone RESP server, for proving the MULTI-INSTANCE property only.
 *
 * ===========================================================================
 * THIS IS NOT REDIS. Nothing verified against it may be described as Redis
 * verification.
 *
 * It implements four commands — INCR, PEXPIRE, PTTL, PING — to their documented
 * semantics, over a real TCP socket, in its own OS process. That is enough to
 * prove one specific thing that cannot otherwise be proven here:
 *
 *     two independent API processes, pointed at one shared counter,
 *     enforce ONE combined budget
 *
 * and to prove it end to end through the real RESP client, real sockets and
 * real HTTP requests rather than through a stub inside the test process.
 *
 * What it CANNOT prove, and what no report may claim on its strength: real
 * Redis semantics, persistence, eviction under memory pressure, replication,
 * failover, cluster redirection, ACLs or TLS. Redis proper is unavailable on
 * this platform without installing separate third-party software, and that
 * remains an external prerequisite. See docs/security.md.
 * ===========================================================================
 *
 *   node scripts/resp-server.mjs --port 6399
 */

import net from 'node:net';
import process from 'node:process';

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const port = Number(flag('port', '6399'));

/** key -> { value, expiresAt|null } */
const store = new Map();

function read(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function execute(args) {
  const command = String(args[0] ?? '').toUpperCase();
  const key = args[1];

  switch (command) {
    case 'PING':
      return '+PONG\r\n';

    case 'INCR': {
      const entry = read(key);
      if (!entry) {
        store.set(key, { value: 1, expiresAt: null });
        return ':1\r\n';
      }
      entry.value += 1;
      return `:${entry.value}\r\n`;
    }

    case 'PEXPIRE': {
      const entry = read(key);
      if (!entry) return ':0\r\n';
      entry.expiresAt = Date.now() + Number(args[2]);
      return ':1\r\n';
    }

    case 'PTTL': {
      const entry = read(key);
      // Redis: -2 for a missing key, -1 for a key with no expiry.
      if (!entry) return ':-2\r\n';
      if (entry.expiresAt === null) return ':-1\r\n';
      return `:${entry.expiresAt - Date.now()}\r\n`;
    }

    // Convenience for the harness, not part of the client's vocabulary.
    case 'FLUSHALL':
      store.clear();
      return '+OK\r\n';

    default:
      return `-ERR unknown command '${command}'\r\n`;
  }
}

/**
 * Parses one inbound RESP array, or returns null when the buffer holds only
 * part of one.
 *
 * The partial case is real: TCP delivers arbitrary chunks, and a server that
 * assumed one chunk was one command would work under light load and corrupt
 * itself under the concurrent traffic this exists to test.
 */
function takeCommand(buffer) {
  if (!buffer.startsWith('*')) return null;
  let cursor = buffer.indexOf('\r\n');
  if (cursor === -1) return null;
  const count = Number(buffer.slice(1, cursor));
  cursor += 2;

  const args = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer[cursor] !== '$') return null;
    const lengthEnd = buffer.indexOf('\r\n', cursor);
    if (lengthEnd === -1) return null;
    const length = Number(buffer.slice(cursor + 1, lengthEnd));
    const start = lengthEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.slice(start, start + length));
    cursor = start + length + 2;
  }
  return { args, consumed: cursor };
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const command = takeCommand(buffer);
      if (!command) break;
      buffer = buffer.slice(command.consumed);
      socket.write(execute(command.args));
    }
  });
  socket.on('error', () => socket.destroy());
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`RESP stand-in listening on 127.0.0.1:${port}\n`);
  process.stdout.write('NOT REDIS. For multi-instance proof only.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
