import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseProjectConfig } from "../config/schema.js";
import { scaffoldTemplateStructure, templateDirectories } from "./structure.js";

const config = parseProjectConfig({
  project: { name: "acme-widgets" },
  source: { adapter: "git" },
});

describe("templateDirectories", () => {
  test("lists runbooks, blog, policy, and the four Diataxis wiki subdirectories", () => {
    const dirs = templateDirectories(config);
    expect(dirs).toContain("docs/runbooks");
    expect(dirs).toContain("docs/blog");
    expect(dirs).toContain("docs/policy");
    expect(dirs).toContain(join("docs/wiki", "tutorials"));
    expect(dirs).toContain(join("docs/wiki", "how-to"));
    expect(dirs).toContain(join("docs/wiki", "reference"));
    expect(dirs).toContain(join("docs/wiki", "explanation"));
    expect(dirs).toHaveLength(7);
  });

  test("respects a custom paths.root override", () => {
    const custom = parseProjectConfig({
      project: { name: "acme-widgets" },
      source: { adapter: "git" },
      paths: {
        root: "documentation",
        runbooks: "documentation/runbooks",
        wiki: "documentation/wiki",
        blog: "documentation/blog",
        policy: "documentation/policy",
      },
    });
    const dirs = templateDirectories(custom);
    expect(dirs).toContain("documentation/runbooks");
  });
});

describe("scaffoldTemplateStructure", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "doc-service-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("creates every directory returned by templateDirectories", async () => {
    const created = await scaffoldTemplateStructure(config, { cwd });
    for (const dir of created) {
      const entries = await readdir(join(cwd, dir)).catch(() => null);
      expect(entries).not.toBeNull();
    }
  });

  test("is idempotent — running twice does not throw", async () => {
    await scaffoldTemplateStructure(config, { cwd });
    await expect(
      scaffoldTemplateStructure(config, { cwd }),
    ).resolves.toBeDefined();
  });
});
