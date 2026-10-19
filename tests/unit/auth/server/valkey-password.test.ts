import { afterEach, describe, expect, it } from 'vitest';
import { spliceValkeyPassword } from '../../../../src/auth/server/valkey-password';

afterEach(() => {
  delete process.env['OAUTH_VALKEY_PASSWORD'];
});

describe('spliceValkeyPassword', () => {
  it('leaves non-valkey store URIs untouched', () => {
    process.env['OAUTH_VALKEY_PASSWORD'] = 'pw';
    expect(spliceValkeyPassword('file:///data/oauth-store.json')).toBe(
      'file:///data/oauth-store.json',
    );
    expect(spliceValkeyPassword('memory://x')).toBe('memory://x');
  });

  it('splices the env password into a bare valkey:// URI', () => {
    process.env['OAUTH_VALKEY_PASSWORD'] = 's3cret';
    expect(spliceValkeyPassword('valkey://zendesk-mcp-valkey:6379/0')).toBe(
      'valkey://:s3cret@zendesk-mcp-valkey:6379/0',
    );
  });

  it('splices into valkeys:// too, preserving db, port and keyPrefix', () => {
    process.env['OAUTH_VALKEY_PASSWORD'] = 's3cret';
    expect(spliceValkeyPassword('valkeys://host:6380/2?keyPrefix=oauth:')).toBe(
      'valkeys://:s3cret@host:6380/2?keyPrefix=oauth:',
    );
  });

  it('percent-encodes a password that needs it, so iovalkey decodes the raw value', () => {
    process.env['OAUTH_VALKEY_PASSWORD'] = 'a/b@c d';
    const spliced = new URL(spliceValkeyPassword('valkey://host:6379/0'));
    // iovalkey's parseURL runs decodeURIComponent on the userinfo (verified in
    // built/utils/index.js), so the decoded form is what reaches the server.
    expect(decodeURIComponent(spliced.password)).toBe('a/b@c d');
    expect(spliced.password).not.toBe('a/b@c d');
    expect(spliced.username).toBe('');
  });

  it('rejects an inline password in the URI: credentials come only from the env', () => {
    process.env['OAUTH_VALKEY_PASSWORD'] = 'pw';
    expect(() => spliceValkeyPassword('valkey://user:old@host:6379/0')).toThrow(
      /already carries credentials/,
    );
    expect(() => spliceValkeyPassword('valkey://:inlined@host:6379/0')).toThrow(
      /already carries credentials/,
    );
  });

  it('rejects a valkey URI without the env password set', () => {
    expect(() => spliceValkeyPassword('valkey://host:6379/0')).toThrow(/OAUTH_VALKEY_PASSWORD/);
  });

  it('rejects an empty OAUTH_VALKEY_PASSWORD', () => {
    process.env['OAUTH_VALKEY_PASSWORD'] = '';
    expect(() => spliceValkeyPassword('valkey://host:6379/0')).toThrow(/OAUTH_VALKEY_PASSWORD/);
  });
});
