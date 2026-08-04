/**
 * A deliberately small `--flag value` parser.
 *
 * These scripts are operator tools invoked by copy-pasting a printed command, so the argument
 * surface is a handful of named options and nothing else. Pulling in a CLI framework for that
 * would add a dependency whose failure modes are larger than the problem.
 */

export type Args = Record<string, string | boolean>;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;

    // `--name=value` as well as `--name value`. Accepting only the second was worse than not
    // accepting the first: the equals form parsed as a flag named `board=examples/...`, so the
    // script ignored the argument and seeded the default board without saying anything.
    const equals = token.indexOf('=');
    if (equals > 2) {
      args[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }

    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

export function requireArg(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing required argument --${name}`);
  }
  return value.trim();
}

export function optionalArg(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function flag(args: Args, name: string): boolean {
  return args[name] === true || args[name] === 'true';
}

/**
 * The first bare token, skipping flags and the values they consume.
 *
 * `argv[0]` is not the same thing: a command that leads with `--once` would take the flag itself
 * as the positional argument and then look up something named after it.
 */
export function positional(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith('--')) return token;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) i += 1;
  }
  return undefined;
}
