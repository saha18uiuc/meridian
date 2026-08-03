import pino, { type Logger } from 'pino';
import { SECRET_ENV_NAMES } from './env.js';

/**
 * One shared redaction list (§8 decision 21). A logger that redacts in some services and not
 * others is worse than no redaction, because it makes the leak intermittent and easy to miss.
 */
export const REDACTED_PATHS: string[] = [
  ...SECRET_ENV_NAMES,
  'authorization',
  'cookie',
  'password',
  'access_token',
].flatMap((name) => [
  name,
  `*.${name}`,
  `*.*.${name}`,
  `headers.${name}`,
  `env.${name}`,
  `req.headers.${name}`,
]);

export const REDACTION_CENSOR = '[redacted]';

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: REDACTED_PATHS, censor: REDACTION_CENSOR },
  });
}

export type { Logger };
