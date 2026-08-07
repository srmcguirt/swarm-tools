import { z } from "zod";

/** The four output types this service knows how to generate. */
export const DOC_OUTPUT_KINDS = ["runbooks", "wiki", "blog", "policy"] as const;
export type DocOutputKind = (typeof DOC_OUTPUT_KINDS)[number];

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
