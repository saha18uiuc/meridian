import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalCaseSchema, type EvalCase } from '@meridian/core/schemas';

/**
 * Loading and validating the checked-in eval cases.
 *
 * The schema lives in `@meridian/core` so the web layer and the harness agree on the shape; this
 * module adds only the filesystem half, which core must not have because core is imported by the
 * workflow bundle.
 *
 * A case file whose `caseKey` disagrees with its filename is rejected rather than renamed. The two
 * are used interchangeably in reports and in the repair loop, and a silent mismatch would make a
 * failure point at the wrong fixture.
 */

export const DEFAULT_CASE_DIR = 'examples/inbound-import-receiving/evals';

export function parseEvalCase(raw: unknown, sourcePath: string): EvalCase {
  const parsed = EvalCaseSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${sourcePath} is not a valid eval case: ${detail}`);
  }
  return parsed.data;
}

export function loadEvalCase(path: string): EvalCase {
  return parseEvalCase(JSON.parse(readFileSync(path, 'utf8')), path);
}

export function loadEvalCases(directory: string): EvalCase[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();

  return files.map((name) => {
    const evalCase = loadEvalCase(join(directory, name));
    const expectedName = `${evalCase.caseKey}.json`;
    if (name !== expectedName) {
      throw new Error(
        `${name} declares caseKey "${evalCase.caseKey}", which expects ${expectedName}`,
      );
    }
    return evalCase;
  });
}
