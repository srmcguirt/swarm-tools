import { z } from "zod";

/** The four output types this service knows how to generate. */
export const DOC_OUTPUT_KINDS = ["runbooks", "wiki", "blog", "policy"] as const;
export type DocOutputKind = (typeof DOC_OUTPUT_KINDS)[number];

/**
 * Sanitization gate config. All list fields are additive to the gate's
 * built-in defaults (see `src/gate/terms.ts`) unless the matching
 * `disableDefault*` flag is set — a project with its own internal
 * vocabulary (e.g. "tribe", "pod", "squad") adds to the base policy
 * instead of having to restate it.
 */
const SanitizationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Extra standalone-word process terms, hard-fail like the built-ins. */
    processTerms: z.array(z.string()).default([]),
    /** Extra ambiguous terms matched via the ~sentence-context heuristic (see gate/matcher.ts) rather than as a bare word. */
    contextualTerms: z.array(z.string()).default([]),
    /** Extra phrases exempt even though they contain a denylisted term (e.g. a project-specific product name). */
    allowlist: z.array(z.string()).default([]),
    /** Known agent/bot account names (e.g. pulled from a live `agents` table) to hard-fail on sight. */
    agentNames: z.array(z.string()).default([]),
    /** Extra model/product self-identification phrases. */
    modelNamePhrases: z.array(z.string()).default([]),
    disableDefaultProcessTerms: z.boolean().default(false),
    disableDefaultContextualTerms: z.boolean().default(false),
    disableDefaultAllowlist: z.boolean().default(false),
    disableDefaultModelNamePhrases: z.boolean().default(false),
    /** AI-slop prose markers (delve, leverage-as-verb, ...) are heuristic and warn-only by default — see gate README section. */
    slopEnabled: z.boolean().default(true),
    slopSeverity: z.enum(["warn", "error"]).default("warn"),
  })
  .default({});

export type SanitizationConfig = z.infer<typeof SanitizationConfigSchema>;

const ProjectIdentitySchema = z.object({
  name: z.string().min(1, "project.name is required"),
  description: z.string().optional(),
  homepage: z.string().url().optional(),
  repository: z.string().optional(),
});

const OutputsSchema = z
  .object({
    runbooks: z.boolean().default(true),
    wiki: z.boolean().default(true),
    blog: z.boolean().default(true),
    policy: z.boolean().default(true),
  })
  .default({});

const SourceSchema = z.object({
  /** Matches SourceAdapter.id — validated against a registry at load time, not here. */
  adapter: z.string().min(1, "source.adapter is required"),
  options: z.record(z.string(), z.unknown()).optional(),
});

const StyleSchema = z
  .object({
    tone: z.enum(["formal", "casual", "technical"]).default("technical"),
    accentColor: z.string().optional(),
    logo: z.string().optional(),
  })
  .default({});

const PathsSchema = z
  .object({
    root: z.string().default("docs"),
    runbooks: z.string().default("docs/runbooks"),
    wiki: z.string().default("docs/wiki"),
    blog: z.string().default("docs/blog"),
    policy: z.string().default("docs/policy"),
  })
  .default({});

/**
 * What a consuming project declares to stand up the doc service.
 * Validate with `parseProjectConfig` rather than using this schema raw.
 */
export const ProjectConfigSchema = z.object({
  project: ProjectIdentitySchema,
  outputs: OutputsSchema,
  source: SourceSchema,
  style: StyleSchema,
  paths: PathsSchema,
  sanitization: SanitizationConfigSchema,
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export class ProjectConfigValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(
      `Invalid doc-service project config:\n${issues
        .map(
          (issue) =>
            `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        )
        .join("\n")}`,
    );
    this.name = "ProjectConfigValidationError";
  }
}

/** Parse and validate a raw config object. Throws ProjectConfigValidationError on failure. */
export function parseProjectConfig(input: unknown): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ProjectConfigValidationError(result.error.issues);
  }
  return result.data;
}
