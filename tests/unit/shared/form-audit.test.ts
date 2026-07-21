import { describe, expect, it } from "vitest";

import {
  assessFormAudit,
  FORM_AUDIT_MAX_AGE_DAYS,
  KNOWN_BLOCKED_FORM_CONTENT_SHA256,
  STUDY_FORM_URL,
  type FormAuditRecord,
} from "../../../src/shared/form-audit.js";

const PROTOCOL_VERSION = "R8-010-2x2-mock-v3";
const TODAY = new Date("2026-07-21T12:00:00.000Z");

function approvedRecord(overrides: Partial<FormAuditRecord> = {}): FormAuditRecord {
  return {
    status: "GO",
    protocolVersion: PROTOCOL_VERSION,
    formUrl: STUDY_FORM_URL,
    auditedOn: "2026-07-21",
    contentSha256: "a".repeat(64),
    twoPersonVerified: true,
    ...overrides,
  };
}

describe("form audit evidence gate", () => {
  it("fails closed when local audit evidence is missing", () => {
    expect(assessFormAudit({ protocolVersion: PROTOCOL_VERSION, formUrl: STUDY_FORM_URL }, TODAY))
      .toEqual({ approved: false, issues: ["missing"], ageDays: null });
  });

  it("accepts matching, two-person-verified GO evidence within the freshness window", () => {
    expect(assessFormAudit({
      protocolVersion: PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      formAudit: approvedRecord(),
    }, TODAY)).toEqual({ approved: true, issues: [], ageDays: 0 });

    const boundary = approvedRecord({ auditedOn: "2026-07-14" });
    expect(assessFormAudit({
      protocolVersion: PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      formAudit: boundary,
    }, TODAY)).toEqual({ approved: true, issues: [], ageDays: FORM_AUDIT_MAX_AGE_DAYS });
  });

  it("reports every independent evidence mismatch", () => {
    const assessment = assessFormAudit({
      protocolVersion: PROTOCOL_VERSION,
      formUrl: "https://forms.gle/different-form",
      formAudit: approvedRecord({
        status: "NO-GO",
        protocolVersion: "different-protocol",
        formUrl: "https://forms.gle/a-third-form",
        contentSha256: "INVALID",
        twoPersonVerified: false,
      }),
    }, TODAY);
    expect(assessment.approved).toBe(false);
    expect(assessment.issues).toEqual([
      "status-not-go",
      "unexpected-study-form-url",
      "protocol-version-mismatch",
      "form-url-mismatch",
      "two-person-not-verified",
      "invalid-content-sha256",
    ]);
  });

  it("rejects a previously observed NO-GO payload even if flags are manually flipped", () => {
    const assessment = assessFormAudit({
      protocolVersion: PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      formAudit: approvedRecord({
        contentSha256: KNOWN_BLOCKED_FORM_CONTENT_SHA256[0] ?? "",
      }),
    }, TODAY);
    expect(assessment.approved).toBe(false);
    expect(assessment.issues).toContain("known-blocked-content");
  });

  it.each([
    ["invalid date", "not-a-date", "invalid-audit-date", null],
    ["future date", "2026-07-22", "audit-date-in-future", -1],
    ["stale date", "2026-07-13", "stale-audit", 8],
  ] as const)("rejects %s", (_label, auditedOn, issue, ageDays) => {
    const assessment = assessFormAudit({
      protocolVersion: PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      formAudit: approvedRecord({ auditedOn }),
    }, TODAY);
    expect(assessment.approved).toBe(false);
    expect(assessment.issues).toContain(issue);
    expect(assessment.ageDays).toBe(ageDays);
  });

  it("uses the Asia/Tokyo calendar day around UTC midnight", () => {
    const justAfterMidnightInJapan = new Date("2026-07-20T15:30:00.000Z");
    expect(assessFormAudit({
      protocolVersion: PROTOCOL_VERSION,
      formUrl: STUDY_FORM_URL,
      formAudit: approvedRecord(),
    }, justAfterMidnightInJapan)).toEqual({ approved: true, issues: [], ageDays: 0 });
  });
});
