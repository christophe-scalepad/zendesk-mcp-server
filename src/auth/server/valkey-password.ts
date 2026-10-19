/**
 * The password for a `valkey://` store URI, read from `OAUTH_VALKEY_PASSWORD`.
 *
 * The URI in `OAUTH_STORE` comes from the Deployment spec, where an inline
 * password would be plain text in `kubectl describe`. The password therefore
 * travels its own env var, injected from a Kubernetes Secret via `envFrom`
 * (the pattern used for the in-cluster valkey, cf. do/devops !4400), and this
 * module splices it into the URI before the store opens: userinfo in a URL
 * with a password never needs percent-encoding beyond what characters outside
 * the userinfo safe set require, handled here with encodeURIComponent on the
 * whole string. Also the only supported way to give `valkey://` credentials —
 * one knob instead of two spellings (in-URI vs env) that could disagree.
 */
import { readEnv } from '../../utils/env';
import { createStartupError, STARTUP_DOCS } from '../../utils/startup-error';

const PASSWORD_ENV = 'OAUTH_VALKEY_PASSWORD';

export const spliceValkeyPassword = (storeUri: string): string => {
  const uri = new URL(storeUri);
  if (uri.protocol !== 'valkey:' && uri.protocol !== 'valkeys:') return storeUri;
  if (uri.password) {
    throw createStartupError(
      'OAUTH_STORE valkey:// URI already carries credentials; set the password ' +
        `only through ${PASSWORD_ENV}.`,
      STARTUP_DOCS.secretAndStore,
    );
  }
  const password = readEnv(PASSWORD_ENV).value;
  if (password === undefined || password === '') {
    throw createStartupError(
      `valkey:// store requires ${PASSWORD_ENV} (the URI must not carry credentials).`,
      STARTUP_DOCS.secretAndStore,
    );
  }
  const credentialed = new URL(storeUri);
  credentialed.password = encodeURIComponent(password);
  return credentialed.href;
};
