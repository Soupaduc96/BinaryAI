import net from 'node:net';
import tls from 'node:tls';
import type { RedisCommands } from './redis-store.js';

/**
 * A four-command Redis client.
 *
 * Why not a client library: the store needs INCR, PEXPIRE, PTTL and PING. A
 * general-purpose client brings pub/sub, cluster routing, scripting, sentinel
 * discovery and a connection pool — none of which this uses, all of which would
 * be dependency surface in a security-relevant path. RESP2 for four integer
 * replies is about a hundred lines, and those hundred lines can be tested
 * against a real socket.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT VERIFIED
 *
 * Verified: the wire encoding, the reply parsing, in-order reply matching under
 * pipelining, and error propagation — all exercised against a real TCP server
 * speaking RESP in-process (see redis-client.test.ts).
 *
 * NOT verified: behaviour against an actual Redis server, authentication
 * against a real ACL, TLS, failover, cluster redirection (MOVED/ASK), or
 * anything about a production deployment. No Redis was reachable from the
 * environment this was written in. See docs/security.md.
 * ---------------------------------------------------------------------------
 */

export interface RedisClientOptions {
  /** redis:// or rediss:// URL. */
  readonly url: string;
  /** Milliseconds to wait for a connection before giving up. */
  readonly connectTimeoutMs?: number;
}

interface Pending {
  resolve(value: RespValue): void;
  reject(error: Error): void;
}

type RespValue = string | number | null;

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export function createRedisClient(options: RedisClientOptions): RedisCommands {
  const target = parseRedisUrl(options.url);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let socket: net.Socket | null = null;
  let connecting: Promise<net.Socket> | null = null;
  let closed = false;
  // FIFO. RESP guarantees replies come back in the order commands were sent,
  // which is the only reason a queue this simple is correct.
  let pending: Pending[] = [];
  let buffer = Buffer.alloc(0);

  function failAll(error: Error): void {
    const waiting = pending;
    pending = [];
    for (const entry of waiting) entry.reject(error);
  }

  function teardown(error: Error): void {
    socket?.destroy();
    socket = null;
    connecting = null;
    buffer = Buffer.alloc(0);
    failAll(error);
  }

  function onData(chunk: Buffer): void {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      const parsed = readReply(buffer);
      if (parsed === null) return;
      buffer = buffer.subarray(parsed.consumed);

      const entry = pending.shift();
      if (!entry) continue; // Unsolicited reply; nothing is waiting for it.
      if (parsed.error !== undefined) entry.reject(new Error(parsed.error));
      else entry.resolve(parsed.value);
    }
  }

  async function connect(): Promise<net.Socket> {
    if (closed) throw new Error('Redis client is closed.');
    if (socket && !socket.destroyed) return socket;
    if (connecting) return connecting;

    connecting = new Promise<net.Socket>((resolve, reject) => {
      const connection: net.Socket = target.tls
        ? tls.connect({ host: target.host, port: target.port, servername: target.host })
        : net.connect({ host: target.host, port: target.port });
      // TLS signals readiness with 'secureConnect'; a plain socket with
      // 'connect'. Waiting for the wrong one hangs until the timeout fires.
      const readyEvent = target.tls ? 'secureConnect' : 'connect';
      const timer = setTimeout(() => {
        connection.destroy();
        reject(new Error(`Redis connection to ${target.host}:${target.port} timed out.`));
      }, connectTimeoutMs);

      connection.once('error', (error) => {
        clearTimeout(timer);
        teardown(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      });
      // A close with commands still queued means their replies are never
      // coming. Rejecting them is what lets the limiter fail closed rather
      // than hang until a request timeout.
      connection.once('close', () => {
        socket = null;
        connecting = null;
        failAll(new Error('Redis connection closed.'));
      });
      connection.on('data', onData);

      connection.once(readyEvent, () => {
        clearTimeout(timer);
        connection.setNoDelay(true);
        socket = connection;
        resolve(connection);
      });
    });

    try {
      const connected = await connecting;
      // Handshake on a fresh connection, before anything else is queued.
      if (target.password !== undefined) {
        await send(
          connected,
          target.username === undefined
            ? ['AUTH', target.password]
            : ['AUTH', target.username, target.password],
        );
      }
      if (target.database !== undefined) {
        await send(connected, ['SELECT', String(target.database)]);
      }
      return connected;
    } catch (error) {
      connecting = null;
      throw error;
    }
  }

  function send(connection: net.Socket, args: readonly string[]): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      pending.push({ resolve, reject });
      connection.write(encodeCommand(args), (error) => {
        if (error) {
          // The write failed, so no reply is coming for it. Tear down rather
          // than leave a resolver queued that would later be matched to some
          // other command's reply.
          teardown(error);
        }
      });
    });
  }

  async function command(args: readonly string[]): Promise<RespValue> {
    return send(await connect(), args);
  }

  async function integerCommand(args: readonly string[]): Promise<number> {
    const value = await command(args);
    if (typeof value !== 'number') {
      throw new Error(`Expected an integer reply to ${args[0]}, received ${typeof value}.`);
    }
    return value;
  }

  return {
    incr: (key) => integerCommand(['INCR', key]),
    pexpire: (key, milliseconds) => integerCommand(['PEXPIRE', key, String(milliseconds)]),
    pttl: (key) => integerCommand(['PTTL', key]),

    async ping(): Promise<string> {
      const value = await command(['PING']);
      return typeof value === 'string' ? value : String(value);
    },

    async close(): Promise<void> {
      closed = true;
      teardown(new Error('Redis client is closing.'));
    },
  };
}

// ------------------------------------------------------------------- RESP2 --

/** `*2\r\n$4\r\nINCR\r\n$3\r\nkey\r\n` */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
  }
  return Buffer.from(parts.join(''), 'utf8');
}

export interface ParsedReply {
  readonly value: RespValue;
  readonly error?: string;
  /** Bytes consumed from the front of the buffer. */
  readonly consumed: number;
}

/**
 * Reads one reply, or returns null when the buffer holds only part of one.
 *
 * The partial case is the whole reason this is written by hand: TCP delivers
 * arbitrary chunks, and a parser that assumed one chunk was one reply would
 * work perfectly in development and corrupt itself under load.
 */
export function readReply(buffer: Buffer): ParsedReply | null {
  if (buffer.length === 0) return null;

  const end = buffer.indexOf('\r\n');
  if (end === -1) return null;

  const marker = String.fromCharCode(buffer[0] ?? 0);
  const line = buffer.subarray(1, end).toString('utf8');

  switch (marker) {
    case '+':
      return { value: line, consumed: end + 2 };
    case '-':
      return { value: null, error: line, consumed: end + 2 };
    case ':':
      return { value: Number(line), consumed: end + 2 };
    case '$': {
      const length = Number(line);
      if (length === -1) return { value: null, consumed: end + 2 };
      const start = end + 2;
      const finish = start + length;
      // The payload has not all arrived yet.
      if (buffer.length < finish + 2) return null;
      return { value: buffer.subarray(start, finish).toString('utf8'), consumed: finish + 2 };
    }
    default:
      // Arrays and other types are unreachable for the four commands this
      // client sends. Failing loudly beats silently returning a wrong value.
      return { value: null, error: `Unsupported RESP reply type "${marker}".`, consumed: end + 2 };
  }
}

export interface RedisTarget {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly database: number | undefined;
}

export function parseRedisUrl(url: string): RedisTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: ${redactUrl(url)}`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must use redis:// or rediss://, received "${parsed.protocol}".`);
  }

  const path = parsed.pathname.replace(/^\//, '');
  const database = path.length > 0 ? Number(path) : undefined;
  if (database !== undefined && !Number.isInteger(database)) {
    throw new Error(`REDIS_URL database index is not an integer: "${path}".`);
  }

  return {
    host: parsed.hostname.length > 0 ? parsed.hostname : '127.0.0.1',
    port: parsed.port.length > 0 ? Number(parsed.port) : 6379,
    tls: parsed.protocol === 'rediss:',
    username: parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined,
    database,
  };
}

/** Strips credentials so a malformed URL can be named in an error without leaking one. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}
