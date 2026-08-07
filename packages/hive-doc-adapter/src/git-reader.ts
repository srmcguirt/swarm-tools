/**
 * Read-only git history access, shelled out to the system `git` binary.
 * No dependency on any git library — `git log` with machine-delimited
 * output is sufficient and keeps this package's dependency surface at
 * exactly @libsql/client + doc-service.
 */

import { $ } from "bun";

export interface RawCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601, from git's %aI (strict ISO date). */
  authoredAt: string;
  subject: string;
}

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

export interface GitReaderOptions {
  repoPath: string;
  since?: string;
  until?: string;
}

export async function readGitCommits(
  options: GitReaderOptions,
): Promise<RawCommit[]> {
  const format = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`;
  const args = ["log", `--pretty=format:${format}`];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.until) args.push(`--until=${options.until}`);

  const result = await $`git -C ${options.repoPath} ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    // Not a git repo, or no commits yet — treat as empty history rather than failing extraction.
    return [];
  }

  const output = result.stdout.toString();
  const records = output
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean);

  return records.map((record) => {
    const [sha, authorName, authorEmail, authoredAt, subject] =
      record.split(FIELD_SEP);
    return {
      sha: sha ?? "",
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authoredAt: authoredAt ?? "",
      subject: subject ?? "",
    };
  });
}
