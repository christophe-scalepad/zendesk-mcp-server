import Valkey from 'iovalkey';
import { createStartupError, STARTUP_DOCS } from '../../utils/startup-error';
import type { CloseableStore } from './file-store';

/**
 * The client surface this module uses; iovalkey satisfies it structurally.
 * The event overloads narrow the names to the two awaited ones, which keeps a
 * typo'd event string a type error.
 */
export interface ValkeyClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: [] | ['PX' | 'EX', number]): Promise<string | null>;
  del(key: string): Promise<number>;
  quit(): Promise<string>;
  disconnect(): void;
  once(event: 'ready', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'ready' | 'error', listener: (...args: never[]) => void): unknown;
}

/** Options for the iovalkey constructor. */
export interface ValkeyStoreOptions {
  readonly connectionName: string;
  readonly lazyConnect: false;
  readonly maxRetriesPerRequest: null;
  readonly keyPrefix: string;
  readonly retryStrategy: (times: number) => number | null;
}

const DEFAULT_KEY_PREFIX = 'oauth:';
const CONNECTION_NAME = 'zendesk-mcp-oauth-store';
// Two attempts, then stop: a shutdown racing a dead server must not wait out
// an endless reconnect loop, and a steady-state outage fails visibly instead
// of retrying forever.
const retryStrategy = (times: number): number | null =>
  times > 2 ? null : Math.min(times * 200, 400);

const defaultClient = (href: string, options: ValkeyStoreOptions): ValkeyClient =>
  // iovalkey's declared get() also allows a Buffer (opt-in); with the default
  // options it answers strings, which is all this store ever reads.
  new Valkey(href, options) as unknown as ValkeyClient;

/**
 * Milliseconds a record must outlive, floored to the earliest whole ms Valkey
 * accepts. The memory store tolerates a 0 TTL (it lapses immediately); Valkey
 * rejects `PX 0` outright (`ERR invalid expire`), so the backend stays total.
 */
export const expireMs = (ttlMs: number): number => Math.max(1, Math.ceil(ttlMs));

/**
 * The key prefix from the URI's `keyPrefix` query parameter, defaulting to
 * `oauth:`. Stripped from the URL handed to the client afterwards: iovalkey
 * maps *every* query parameter onto its options, so leaving it in would also
 * set the library's own `keyPrefix` option and prefix every key a second time.
 */
export const keyPrefixOf = (uri: URL): string =>
  uri.searchParams.get('keyPrefix') ?? DEFAULT_KEY_PREFIX;

/** The URI minus its `keyPrefix` query parameter, for the client factory. */
export function withoutKeyPrefix(uri: URL): URL {
  const cleaned = new URL(uri.href);
  cleaned.searchParams.delete('keyPrefix');
  return cleaned;
}

/**
 * A sealed-record store on Valkey (or any Redis-compatible server). Commands
 * map 1:1: GET / SET ... PX / DEL. Keys are prefixed so one server can host
 * unrelated namespaces. Fail-fast at startup: an unreachable server stops the
 * process before the port binds, like an unwritable store file does.
 * Single instance still (ADR, Storage): single-use enforcement is an
 * in-process lock, which does not span replicas.
 */
export const createValkeyStore = async (
  uri: URL,
  createClient: (href: string, options: ValkeyStoreOptions) => ValkeyClient = defaultClient,
): Promise<CloseableStore> => {
  const keyPrefix = keyPrefixOf(uri);
  const client = createClient(withoutKeyPrefix(uri).href, {
    connectionName: CONNECTION_NAME,
    lazyConnect: false,
    maxRetriesPerRequest: null,
    keyPrefix,
    retryStrategy,
  });

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      client.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      client.off('ready', onReady);
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
  }).catch((err: unknown) => {
    // No graceful quit: the connection never completed, so drop the socket.
    client.disconnect();
    throw createStartupError(
      `Cannot reach the OAuth store server (${err instanceof Error ? err.message : 'unknown error'}).`,
      STARTUP_DOCS.secretAndStore,
      err,
    );
  });

  return {
    get: async (name) => {
      const value = await client.get(name);
      return value ?? undefined;
    },
    set: async (name, value, ttlMs) => {
      if (ttlMs === undefined) await client.set(name, value);
      else await client.set(name, value, 'PX', expireMs(ttlMs));
    },
    delete: async (name) => {
      await client.del(name);
    },
    close: async () => {
      try {
        await client.quit();
      } catch {
        // Already closed (shutdown racing a lost connection): done either way.
        client.disconnect();
      }
    },
  };
};
