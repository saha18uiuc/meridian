import { z } from 'zod';

/**
 * `manifest.json` inside a generated agent version, mirrored into
 * `agent_versions.build_manifest_json`.
 *
 * `toolkitVersions` holds concrete resolved versions (A29). `pnpm verify` greps recorded build
 * and execution metadata and fails on the literal string `latest`, because an irreproducible
 * version string makes the recorded lineage a lie.
 */
export const BuildManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    deploymentKey: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    versionNo: z.number().int().positive(),
    codePath: z.string().regex(/^generated-agents\/[a-z][a-z0-9-]{2,63}\/v[0-9]{3,}$/),
    specId: z.uuid(),
    specHash: z.string().length(64),
    specVersion: z.number().int().positive(),
    /**
     * `generatedFiles` and `validation` are named for the gate in
     * `meridian.check_agent_version_gate`, which refuses to promote a version whose manifest lacks
     * a non-empty `generatedFiles` array or any `validation` key at all. The database is the
     * authority on these two names; the schema follows it rather than the other way round.
     */
    generatedFiles: z.array(z.string().min(1)).min(1),
    capabilities: z.array(z.string().min(1)),
    generatedAt: z.string(),
    generator: z.object({ skill: z.string().min(1), model: z.string().min(1) }).strict(),
    toolkitVersions: z.record(z.string(), z.string().min(1)),
    validation: z
      .object({
        commands: z.array(z.string().min(1)).min(1),
        evalCaseKeys: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const [name, version] of Object.entries(manifest.toolkitVersions)) {
      if (version.trim().toLowerCase() === 'latest') {
        ctx.addIssue({
          code: 'custom',
          path: ['toolkitVersions', name],
          message: `toolkit version for "${name}" must be a concrete resolved version, not "latest"`,
        });
      }
    }
  });
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

export const ResolvedVersionsSchema = z
  .object({
    composioGmailToolkit: z.string().min(1),
    resolvedAt: z.string(),
    lockfileHash: z.string().length(64),
    composioCoreVersion: z.string().min(1),
  })
  .strict();
export type ResolvedVersions = z.infer<typeof ResolvedVersionsSchema>;
