import { describe, expect, test } from "bun:test";
import { ProjectConfigValidationError, parseProjectConfig } from "./schema.js";

describe("parseProjectConfig", () => {
  test("accepts a minimal valid config and fills in defaults", () => {
    const config = parseProjectConfig({
      project: { name: "acme-widgets" },
      source: { adapter: "git" },
    });

    expect(config.project.name).toBe("acme-widgets");
    expect(config.outputs).toEqual({
      runbooks: true,
      wiki: true,
      blog: true,
      policy: true,
    });
    expect(config.style.tone).toBe("technical");
    expect(config.paths.root).toBe("docs");
    expect(config.paths.runbooks).toBe("docs/runbooks");
  });

  test("accepts a fully specified config", () => {
    const config = parseProjectConfig({
      project: {
        name: "acme-widgets",
        description: "Widgets for the modern age",
        homepage: "https://acme.example.com",
        repository: "https://github.com/acme/widgets",
      },
      outputs: { runbooks: true, wiki: false, blog: true, policy: false },
      source: { adapter: "jira", options: { projectKey: "WID" } },
      style: { tone: "casual", accentColor: "#ff6600" },
      paths: { root: "documentation" },
    });

    expect(config.outputs.wiki).toBe(false);
    expect(config.source.options).toEqual({ projectKey: "WID" });
    expect(config.style.tone).toBe("casual");
    expect(config.paths.root).toBe("documentation");
  });

  test("rejects a config missing project.name", () => {
    expect(() =>
      parseProjectConfig({ project: {}, source: { adapter: "git" } }),
    ).toThrow(ProjectConfigValidationError);
  });

  test("rejects a config missing source.adapter", () => {
    expect(() =>
      parseProjectConfig({ project: { name: "x" }, source: {} }),
    ).toThrow(ProjectConfigValidationError);
  });

  test("rejects an invalid homepage URL", () => {
    expect(() =>
      parseProjectConfig({
        project: { name: "x", homepage: "not-a-url" },
        source: { adapter: "git" },
      }),
    ).toThrow(ProjectConfigValidationError);
  });

  test("rejects an invalid style.tone value", () => {
    expect(() =>
      parseProjectConfig({
        project: { name: "x" },
        source: { adapter: "git" },
        style: { tone: "sarcastic" },
      }),
    ).toThrow(ProjectConfigValidationError);
  });

  test("error message lists the offending path", () => {
    try {
      parseProjectConfig({ project: {}, source: { adapter: "git" } });
      throw new Error("expected parseProjectConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectConfigValidationError);
      expect((err as Error).message).toContain("project.name");
    }
  });

  test("sanitization config defaults: enabled, empty additive lists, warn-tier slop", () => {
    const config = parseProjectConfig({
      project: { name: "acme-widgets" },
      source: { adapter: "git" },
    });

    expect(config.sanitization.enabled).toBe(true);
    expect(config.sanitization.processTerms).toEqual([]);
    expect(config.sanitization.allowlist).toEqual([]);
    expect(config.sanitization.agentNames).toEqual([]);
    expect(config.sanitization.disableDefaultProcessTerms).toBe(false);
    expect(config.sanitization.slopEnabled).toBe(true);
    expect(config.sanitization.slopSeverity).toBe("warn");
  });

  test("sanitization config accepts a per-project internal vocabulary override", () => {
    const config = parseProjectConfig({
      project: { name: "acme-widgets" },
      source: { adapter: "git" },
      sanitization: {
        processTerms: ["tribe", "pod", "squad"],
        allowlist: ["acme-swarm-widget"],
        agentNames: ["InternalBotName"],
        slopSeverity: "error",
      },
    });

    expect(config.sanitization.processTerms).toEqual(["tribe", "pod", "squad"]);
    expect(config.sanitization.allowlist).toEqual(["acme-swarm-widget"]);
    expect(config.sanitization.agentNames).toEqual(["InternalBotName"]);
    expect(config.sanitization.slopSeverity).toBe("error");
    // built-in defaults are additive, not replaced
    expect(config.sanitization.disableDefaultProcessTerms).toBe(false);
  });

  test("rejects an invalid sanitization.slopSeverity value", () => {
    expect(() =>
      parseProjectConfig({
        project: { name: "x" },
        source: { adapter: "git" },
        sanitization: { slopSeverity: "critical" },
      }),
    ).toThrow(ProjectConfigValidationError);
  });
});
