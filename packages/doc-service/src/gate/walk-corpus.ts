import type { DocumentationCorpus } from "../ir/types.js";

/** One free-text (or attribution) field reachable from a corpus, with enough addressing to report a useful violation location. */
export interface CorpusField {
  recordType:
    | "project"
    | "workItem"
    | "decision"
    | "incident"
    | "procedure"
    | "timelineEvent";
  recordId: string;
  field: string;
  text: string;
}

/**
 * Every free-text field in a `DocumentationCorpus` that could reach a
 * generator, plus every `Provenance.author` field (checked for
 * agent-identity leakage — per ir/types.ts that field must be a real human
 * or organization identity, never an agent/session/worker/bot identifier).
 */
export function* walkCorpusText(
  corpus: DocumentationCorpus,
): Generator<CorpusField> {
  if (corpus.project.description) {
    yield {
      recordType: "project",
      recordId: corpus.project.name,
      field: "description",
      text: corpus.project.description,
    };
  }

  for (const w of corpus.workItems) {
    yield {
      recordType: "workItem",
      recordId: w.id,
      field: "title",
      text: w.title,
    };
    if (w.closureNarrative) {
      yield {
        recordType: "workItem",
        recordId: w.id,
        field: "closureNarrative",
        text: w.closureNarrative,
      };
    }
    if (w.provenance.author) {
      yield {
        recordType: "workItem",
        recordId: w.id,
        field: "provenance.author",
        text: w.provenance.author,
      };
    }
  }

  for (const d of corpus.decisions) {
    yield {
      recordType: "decision",
      recordId: d.id,
      field: "title",
      text: d.title,
    };
    yield {
      recordType: "decision",
      recordId: d.id,
      field: "summary",
      text: d.summary,
    };
    for (const [i, o] of d.optionsConsidered.entries()) {
      if (o.label) {
        yield {
          recordType: "decision",
          recordId: d.id,
          field: `optionsConsidered[${i}].label`,
          text: o.label,
        };
      }
      if (o.rationale) {
        yield {
          recordType: "decision",
          recordId: d.id,
          field: `optionsConsidered[${i}].rationale`,
          text: o.rationale,
        };
      }
    }
    for (const [i, e] of d.evidence.entries()) {
      yield {
        recordType: "decision",
        recordId: d.id,
        field: `evidence[${i}].description`,
        text: e.description,
      };
    }
    if (d.provenance.author) {
      yield {
        recordType: "decision",
        recordId: d.id,
        field: "provenance.author",
        text: d.provenance.author,
      };
    }
  }

  for (const inc of corpus.incidents) {
    yield {
      recordType: "incident",
      recordId: inc.id,
      field: "title",
      text: inc.title,
    };
    yield {
      recordType: "incident",
      recordId: inc.id,
      field: "symptom",
      text: inc.symptom,
    };
    yield {
      recordType: "incident",
      recordId: inc.id,
      field: "rootCause",
      text: inc.rootCause,
    };
    yield {
      recordType: "incident",
      recordId: inc.id,
      field: "fix",
      text: inc.fix,
    };
    yield {
      recordType: "incident",
      recordId: inc.id,
      field: "verification",
      text: inc.verification,
    };
    if (inc.preventionRule) {
      yield {
        recordType: "incident",
        recordId: inc.id,
        field: "preventionRule",
        text: inc.preventionRule,
      };
    }
    if (inc.provenance.author) {
      yield {
        recordType: "incident",
        recordId: inc.id,
        field: "provenance.author",
        text: inc.provenance.author,
      };
    }
  }

  for (const p of corpus.procedures) {
    yield {
      recordType: "procedure",
      recordId: p.id,
      field: "title",
      text: p.title,
    };
    for (const step of p.steps) {
      yield {
        recordType: "procedure",
        recordId: p.id,
        field: `steps[${step.order}].action`,
        text: step.action,
      };
      if (step.expectedResult) {
        yield {
          recordType: "procedure",
          recordId: p.id,
          field: `steps[${step.order}].expectedResult`,
          text: step.expectedResult,
        };
      }
    }
    for (const [i, g] of p.gotchas.entries()) {
      yield {
        recordType: "procedure",
        recordId: p.id,
        field: `gotchas[${i}]`,
        text: g,
      };
    }
    if (p.provenance.author) {
      yield {
        recordType: "procedure",
        recordId: p.id,
        field: "provenance.author",
        text: p.provenance.author,
      };
    }
  }

  for (const t of corpus.timeline) {
    yield {
      recordType: "timelineEvent",
      recordId: t.id,
      field: "title",
      text: t.title,
    };
    if (t.description) {
      yield {
        recordType: "timelineEvent",
        recordId: t.id,
        field: "description",
        text: t.description,
      };
    }
    if (t.provenance.author) {
      yield {
        recordType: "timelineEvent",
        recordId: t.id,
        field: "provenance.author",
        text: t.provenance.author,
      };
    }
  }
}
