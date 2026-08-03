/**
 * Stands in for the `server-only` package under Vitest.
 *
 * The real package has no runtime behaviour at all: it ships an export map whose
 * `react-server` condition points at a module that throws, so importing a server module from a
 * client bundle fails the build. Vitest resolves the non-`react-server` condition and would import
 * the throwing module, which is why the alias exists. Nothing is being disabled — the guarantee is
 * enforced by `next build`, which the verification suite runs.
 */
export {};
