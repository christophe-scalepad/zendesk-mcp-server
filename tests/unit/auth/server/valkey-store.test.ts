import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../../../src/auth/server/store';
import {
  createValkeyStore,
  expireMs,
  keyPrefixOf,
  type ValkeyClient,
  withoutKeyPrefix,
} from '../../../../src/auth/server/valkey-store';
import { isStartupError, STARTUP_DOCS } from '../../../../src/utils/startup-error';

// Live-server coverage runs wherever VALKEY_TEST_URL points at a Valkey
// (locally: `docker run -p 6379:6379 valkey/valkey`); the rest of the suite
// stays green serverless.
const live = process.env.VALKEY_TEST_URL ? describe : describe.skip;

/** A recording client whose events are fired by hand, so no server is needed. */
const stubClient = () => {
  const calls: unknown[][] = [];
  const data = new Map<string, string>();
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? [])
      (listener as (...a: unknown[]) => void)(...args);
  };
  let quits = 0;
  const client: ValkeyClient = {
    get: async (key) => {
      calls.push(['get', key]);
      return data.get(key) ?? null;
    },
    set: async (key, value, ...rest) => {
      calls.push(['set', key, value, ...rest]);
      data.set(key, value);
      return 'OK';
    },
    del: async (key) => {
      calls.push(['del', key]);
      return data.delete(key) ? 1 : 0;
    },
    quit: async () => {
      quits += 1;
      if (quits > 1) throw new Error('The client is closed');
      calls.push(['quit']);
      return 'OK';
    },
    disconnect: () => {
      calls.push(['disconnect']);
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return client;
    },
    off: (event, listener) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return client;
    },
    once: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      // The real client connects (or fails) on its own; a stub answers with a
      // ready microtask unless the test fires an event first.
      if (event === 'ready') queueMicrotask(() => emit('ready'));
      return client;
    },
  };
  return { client, calls, emit };
};

describe('valkey store configuration (pure)', () => {
  it('expires a record at the earliest whole millisecond Valkey accepts', () => {
    expect(expireMs(1500)).toBe(1500);
    expect(expireMs(0.4)).toBe(1);
    expect(expireMs(0)).toBe(1);
  });

  it('reads the key prefix from the URI, defaulting to oauth:', () => {
    expect(keyPrefixOf(new URL('valkey://h:6379/2?keyPrefix=tenant1:'))).toBe('tenant1:');
    expect(keyPrefixOf(new URL('valkey://h:6379/2'))).toBe('oauth:');
  });

  it('strips only the keyPrefix parameter from the URI handed to the client', () => {
    const cleaned = withoutKeyPrefix(new URL('valkeys://h:6379/0?keyPrefix=x:&tls=ca'));
    expect(cleaned.searchParams.get('keyPrefix')).toBeNull();
    expect(cleaned.searchParams.get('tls')).toBe('ca');
  });
});

describe('createValkeyStore', () => {
  it('connects through the client factory with the derived options', async () => {
    const stub = stubClient();
    const factory = vi.fn(() => stub.client);
    await createValkeyStore(new URL('valkeys://user:p%40ss@h:6379/2?keyPrefix=t:'), factory);
    expect(factory).toHaveBeenCalledOnce();
    const [href, options] = factory.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(href).toBe('valkeys://user:p%40ss@h:6379/2');
    expect(options).toMatchObject({
      keyPrefix: 't:',
      connectionName: 'zendesk-mcp-oauth-store',
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    expect((options.retryStrategy as (times: number) => number | null)(1)).toBe(200);
    expect((options.retryStrategy as (times: number) => number | null)(3)).toBeNull();
  });

  it('maps the record contract onto GET, SET and DEL', async () => {
    const stub = stubClient();
    const store = await createValkeyStore(new URL('valkey://h/0'), () => stub.client);
    await store.set('RefreshToken:x', 'sealed');
    await store.set('Expiring:x', 'sealed', 1500);
    expect(await store.get('RefreshToken:x')).toBe('sealed');
    expect(await store.get('missing')).toBeUndefined();
    await store.delete('RefreshToken:x');
    expect(await store.get('RefreshToken:x')).toBeUndefined();
    expect(stub.calls).toStrictEqual([
      ['set', 'RefreshToken:x', 'sealed'],
      ['set', 'Expiring:x', 'sealed', 'PX', 1500],
      ['get', 'RefreshToken:x'],
      ['get', 'missing'],
      ['del', 'RefreshToken:x'],
      ['get', 'RefreshToken:x'],
    ]);
  });

  it('stops startup with the operator-facing error when the server is unreachable', async () => {
    const stub = stubClient();
    const pending = createValkeyStore(new URL('valkey://h/0'), () => stub.client);
    stub.emit('error', new Error('connect ECONNREFUSED'));
    const err = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isStartupError(err)).toBe(true);
    expect((err as Error | undefined)?.message).toMatch(
      /Cannot reach the OAuth store server \(connect ECONNREFUSED\)/,
    );
    expect((err as Error | undefined)?.message).toContain(STARTUP_DOCS.secretAndStore);
    expect(stub.calls).toContainEqual(['disconnect']);
  });

  it('closes idempotently: a second close survives the closed client', async () => {
    const stub = stubClient();
    const store = await createValkeyStore(new URL('valkey://h/0'), () => stub.client);
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
    expect(stub.calls).toContainEqual(['disconnect']);
  });
});

describe('openStore with a valkey URI', () => {
  it('rejects an unreachable server at startup, before the port binds', async () => {
    const err = await openStore('valkey://127.0.0.1:1/0').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isStartupError(err)).toBe(true);
    expect((err as Error | undefined)?.message).toMatch(/Cannot reach the OAuth store server/);
  });
});

live('against a live Valkey', () => {
  const uri = process.env.VALKEY_TEST_URL as string;

  it('stores, reads and deletes records', async () => {
    const store = await openStore(uri);
    await store.set('it:k', 'v');
    expect(await store.get('it:k')).toBe('v');
    await store.delete('it:k');
    expect(await store.get('it:k')).toBeUndefined();
    await store.close();
  });

  it('expires a record after its ttl', async () => {
    const store = await openStore(uri);
    await store.set('it:ttl', 'v', 50);
    expect(await store.get('it:ttl')).toBe('v');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await store.get('it:ttl')).toBeUndefined();
    await store.close();
  });

  it('isolates records under different key prefixes', async () => {
    const a = await openStore(`${uri}?keyPrefix=a:`);
    const b = await openStore(`${uri}?keyPrefix=b:`);
    await a.set('it:k', '1');
    expect(await b.get('it:k')).toBeUndefined();
    await a.delete('it:k');
    await a.close();
    await b.close();
  });

  it('reads back over a reopen: persistence is the server\u2019s, not the client\u2019s', async () => {
    const first = await openStore(uri);
    await first.set('it:persist', 'yes');
    await first.close();
    const second = await openStore(uri);
    expect(await second.get('it:persist')).toBe('yes');
    await second.delete('it:persist');
    await second.close();
  });
});
