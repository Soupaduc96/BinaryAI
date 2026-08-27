import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedisClient, encodeCommand, parseRedisUrl, readReply } from './redis-client.js';

/**
 * The wire protocol.
 *
 * These run against a REAL TCP server that speaks RESP, in-process. That is a
 * genuine transport test — sockets, chunk boundaries, in-order reply matching —
 * and it is deliberately not described as a Redis test. It proves this client
 * speaks the protocol correctly; it proves nothing about a Redis server's
 * behaviour, its ACLs, its failover, or a production deployment. See the header
 * of redis-client.ts.
 */

interface StubServer {
  readonly url: string;
  /** Every command the server received, as argument arrays. */
  readonly received: string[][];
  stop(): Promise<void>;
}

/**
 * A server that parses inbound RESP commands and answers with `reply`.
 *
 * `reply` returns raw bytes so a test can produce malformed frames, split
 * replies across packets, or hang — the cases a mock would quietly skip.
 */
async function startStub(
  reply: (args: string[], socket: net.Socket) => string | Buffer | null,
): Promise<StubServer> {
  const received: string[][] = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const command = takeCommand(buffer);
        if (!command) break;
        buffer = buffer.slice(command.consumed);
        received.push(command.args);
        const response = reply(command.args, socket);
        if (response !== null) socket.write(response);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `redis://127.0.0.1:${port}`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Minimal inbound RESP array parser for the stub. */
function takeCommand(buffer: string): { args: string[]; consumed: number } | null {
  if (!buffer.startsWith('*')) return null;
  let cursor = buffer.indexOf('\r\n');
  if (cursor === -1) return null;
  const count = Number(buffer.slice(1, cursor));
  cursor += 2;

  const args: string[] = [];
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function stub(
  reply: (args: string[], socket: net.Socket) => string | Buffer | null,
): Promise<StubServer> {
  const server = await startStub(reply);
  cleanups.push(() => server.stop());
  return server;
}

describe('encodeCommand', () => {
  it('encodes a RESP array of bulk strings', () => {
    expect(encodeCommand(['INCR', 'k']).toString('utf8')).toBe('*2\r\n$4\r\nINCR\r\n$1\r\nk\r\n');
  });

  it('counts bytes, not characters', () => {
    // A key with a multi-byte character would produce a short length prefix if
    // this used .length, and the server would then read the next command's
    // bytes as part of this argument.
    const encoded = encodeCommand(['INCR', 'ké']).toString('utf8');
    expect(encoded).toContain('$3\r\nké\r\n');
  });
});

describe('readReply', () => {
  it('reads an integer reply', () => {
    expect(readReply(Buffer.from(':42\r\n'))).toMatchObject({ value: 42, consumed: 5 });
  });

  it('reads a simple string reply', () => {
    expect(readReply(Buffer.from('+PONG\r\n'))).toMatchObject({ value: 'PONG' });
  });

  it('reports an error reply as an error, not as a value', () => {
    // Returning the text as a value would let "ERR wrong number of arguments"
    // be counted as a rate-limit result.
    expect(readReply(Buffer.from('-ERR nope\r\n'))).toMatchObject({ error: 'ERR nope' });
  });

  it('reads a bulk string reply', () => {
    expect(readReply(Buffer.from('$5\r\nhello\r\n'))).toMatchObject({ value: 'hello' });
  });

  it('reads a null bulk reply', () => {
    expect(readReply(Buffer.from('$-1\r\n'))).toMatchObject({ value: null });
  });

  it('returns null for a frame that has not fully arrived', () => {
    // TCP delivers arbitrary chunks. A parser that assumed one chunk was one
    // reply would work in development and corrupt itself under load.
    expect(readReply(Buffer.from(':4'))).toBeNull();
    expect(readReply(Buffer.from('$5\r\nhel'))).toBeNull();
  });

  it('reports the exact byte count consumed so the next frame starts clean', () => {
    const parsed = readReply(Buffer.from(':1\r\n:2\r\n'));
    expect(parsed?.consumed).toBe(4);
  });

  it('refuses an unsupported reply type rather than guessing', () => {
    expect(readReply(Buffer.from('*1\r\n'))?.error).toMatch(/Unsupported/);
  });
});

describe('createRedisClient — over a real socket', () => {
  it('sends INCR and reads the integer back', async () => {
    const server = await stub(() => ':1\r\n');
    const client = createRedisClient({ url: server.url });

    await expect(client.incr('k')).resolves.toBe(1);
    expect(server.received).toEqual([['INCR', 'k']]);
    await client.close();
  });

  it('sends PEXPIRE with the TTL as a string argument', async () => {
    const server = await stub(() => ':1\r\n');
    const client = createRedisClient({ url: server.url });

    await client.pexpire('k', 60_000);
    expect(server.received[0]).toEqual(['PEXPIRE', 'k', '60000']);
    await client.close();
  });

  it('matches replies to commands in order under pipelining', async () => {
    // The FIFO queue is only correct because RESP guarantees ordering. If this
    // ever broke, one caller would receive another caller's count — and the
    // limiter would throttle the wrong identity.
    const server = await stub((args) => `:${args[1]}\r\n`);
    const client = createRedisClient({ url: server.url });

    const results = await Promise.all([client.incr('1'), client.incr('2'), client.incr('3')]);
    expect(results).toEqual([1, 2, 3]);
    await client.close();
  });

  it('reassembles a reply split across packets', async () => {
    const server = await stub((_args, socket) => {
      socket.write('$4\r\nPO');
      setTimeout(() => socket.write('NG\r\n'), 5);
      return null;
    });
    const client = createRedisClient({ url: server.url });

    await expect(client.ping()).resolves.toBe('PONG');
    await client.close();
  });

  it('rejects when the server returns an error reply', async () => {
    // Must not be swallowed: a silently-failed INCR is a silently-disabled
    // limit.
    const server = await stub(() => '-NOAUTH Authentication required.\r\n');
    const client = createRedisClient({ url: server.url });

    await expect(client.incr('k')).rejects.toThrow(/NOAUTH/);
    await client.close();
  });

  it('rejects a queued command when the connection drops', async () => {
    // Without this the promise would never settle and the request would hang
    // until an upstream timeout, instead of failing closed immediately.
    const server = await stub((_args, socket) => {
      socket.destroy();
      return null;
    });
    const client = createRedisClient({ url: server.url });

    await expect(client.incr('k')).rejects.toThrow(/closed|reset|ECONNRESET/i);
    await client.close();
  });

  it('rejects when nothing is listening', async () => {
    const client = createRedisClient({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 500 });
    await expect(client.ping()).rejects.toThrow();
    await client.close();
  });

  it('refuses to run after close', async () => {
    const server = await stub(() => ':1\r\n');
    const client = createRedisClient({ url: server.url });
    await client.close();

    await expect(client.incr('k')).rejects.toThrow(/closed/i);
  });

  it('authenticates before issuing commands when the URL carries a password', async () => {
    // Ordering matters: a command sent before AUTH is refused with NOAUTH.
    const server = await stub(() => '+OK\r\n');
    const client = createRedisClient({ url: server.url.replace('//', '//:hunter2@') });

    await client.ping();
    expect(server.received[0]).toEqual(['AUTH', 'hunter2']);
    await client.close();
  });

  it('selects the database from the URL path', async () => {
    const server = await stub(() => '+OK\r\n');
    const client = createRedisClient({ url: `${server.url}/3` });

    await client.ping();
    expect(server.received[0]).toEqual(['SELECT', '3']);
    await client.close();
  });

  it('refuses a non-integer reply to an integer command', async () => {
    // Coercing "OK" to NaN would produce a count that compares false against
    // every limit, silently allowing everything.
    const server = await stub(() => '+OK\r\n');
    const client = createRedisClient({ url: server.url });

    await expect(client.incr('k')).rejects.toThrow(/Expected an integer/);
    await client.close();
  });
});

describe('parseRedisUrl', () => {
  it('reads host, port and defaults', () => {
    expect(parseRedisUrl('redis://cache.internal:6380')).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      tls: false,
      database: undefined,
    });
  });

  it('defaults the port to 6379', () => {
    expect(parseRedisUrl('redis://localhost').port).toBe(6379);
  });

  it('marks rediss:// as TLS', () => {
    expect(parseRedisUrl('rediss://cache.internal').tls).toBe(true);
  });

  it('reads credentials and the database index', () => {
    expect(parseRedisUrl('redis://alice:s3cret@host:6379/2')).toMatchObject({
      username: 'alice',
      password: 's3cret',
      database: 2,
    });
  });

  it('rejects a non-Redis scheme', () => {
    // Pointing the limiter at an HTTP endpoint should fail at boot, not on the
    // first throttled request.
    expect(() => parseRedisUrl('http://localhost:6379')).toThrow(/redis:\/\//);
  });

  it('does not put the password in the error when the URL is malformed', () => {
    // Config errors are logged at boot. A password in one is a leaked password.
    expect(() => parseRedisUrl('redis://user:hunter2@:::')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });
});
