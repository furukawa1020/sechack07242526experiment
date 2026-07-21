export const STUDY_FORM_URL = "https://forms.gle/BeShY7cY5zMjunto9";
export const FORM_AUDIT_MAX_AGE_DAYS = 7;

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface FormAuditRecord {
  readonly status: "GO" | "NO-GO";
  readonly protocolVersion: string;
  readonly formUrl: string;
  readonly auditedOn: string;
  readonly contentSha256: string;
  readonly twoPersonVerified: boolean;
}

export interface FormAuditSubject {
  readonly protocolVersion: string;
  readonly formUrl: string;
  readonly formAudit?: FormAuditRecord | undefined;
}

export type FormAuditIssueCode =
  | "missing"
  | "status-not-go"
  | "unexpected-study-form-url"
  | "protocol-version-mismatch"
  | "form-url-mismatch"
  | "two-person-not-verified"
  | "invalid-audit-date"
  | "audit-date-in-future"
  | "stale-audit"
  | "invalid-content-sha256";

export interface FormAuditAssessment {
  readonly approved: boolean;
  readonly issues: readonly FormAuditIssueCode[];
  readonly ageDays: number | null;
}

function calendarDateToUtcMs(value: string): number | null {
  if (!CALENDAR_DATE_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds
    : null;
}

function japanCalendarDate(value: Date): string {
  return new Date(value.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Evaluates only local, signed-off evidence. It never fetches Google Forms or
 * sends experiment data outside the local application.
 */
export function assessFormAudit(
  subject: FormAuditSubject,
  now = new Date(),
): FormAuditAssessment {
  const record = subject.formAudit;
  if (record === undefined) {
    return Object.freeze({
      approved: false,
      issues: Object.freeze(["missing"] as const),
      ageDays: null,
    });
  }

  const issues: FormAuditIssueCode[] = [];
  if (record.status !== "GO") issues.push("status-not-go");
  if (subject.formUrl !== STUDY_FORM_URL) issues.push("unexpected-study-form-url");
  if (record.protocolVersion !== subject.protocolVersion) {
    issues.push("protocol-version-mismatch");
  }
  if (record.formUrl !== subject.formUrl) issues.push("form-url-mismatch");
  if (!record.twoPersonVerified) issues.push("two-person-not-verified");
  if (!SHA_256_PATTERN.test(record.contentSha256)) issues.push("invalid-content-sha256");

  const auditDay = calendarDateToUtcMs(record.auditedOn);
  const nowDay = calendarDateToUtcMs(japanCalendarDate(now));
  let ageDays: number | null = null;
  if (auditDay === null || nowDay === null) {
    issues.push("invalid-audit-date");
  } else {
    ageDays = Math.floor((nowDay - auditDay) / DAY_MS);
    if (ageDays < 0) {
      issues.push("audit-date-in-future");
    } else if (ageDays > FORM_AUDIT_MAX_AGE_DAYS) {
      issues.push("stale-audit");
    }
  }

  return Object.freeze({
    approved: issues.length === 0,
    issues: Object.freeze(issues),
    ageDays,
  });
}
