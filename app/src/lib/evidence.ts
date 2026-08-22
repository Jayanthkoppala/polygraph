// Metric -> sentence, once, per ux-spec.md §5: no raw metric name (`fillRates`,
// `collapsedFields`, ...) may reach a `sentence`/`detail`/`label` — only `raw`.

// Every proof is a COMPARISON, never a lone number, and all four checks always
// render in this fixed order — a check that never ran says so, never passes silently.
import type { Evidence } from '@/lib/api';

export type EvidenceCheck = 'contract' | 'coherence' | 'identity' | 'canary';
export type EvidenceStatus = 'pass' | 'fail' | 'skipped';

/** Mirrors `src/checks/identity.ts`'s `IdentityMismatch`. */
export interface IdentityMismatch {
  input: unknown;
  requestedKey: string;
  extractedKey: string;
}

/** Mirrors `src/checks/canary.ts`'s `CanaryOutcome`. */
export interface CanaryOutcome {
  input: string;
  pass: boolean;
  reason?: string;
}

export interface EvidenceLine {
  check: EvidenceCheck;
  /** Fixed order label — "Contract" / "Coherence" / "Identity" / "Canary". */
  label: string;
  status: EvidenceStatus;
  /** The comparison sentence. Never a lone number, never a raw metric name. */
  sentence: string;
  /** A second, supporting sentence — only when the proof needs a scope
   *  statement beyond the headline (e.g. identity's "N of M rows"). */
  detail?: string;
  /** Verbatim engine Evidence for the `⌄ raw` disclosure. `null` when the check
   *  never ran — the reason is already fully expressed in `sentence`. */
  raw: Evidence | null;
}

/** The one entity-key substitution this evidence set proves — the pair `VerdictCard`'s
 *  rotating chip needs (§2.6). `null` unless identity failed with a mismatch. */
export function firstIdentityMismatch(evidence: Evidence[] | null): IdentityMismatch | null {
  const identityEv = (evidence ?? []).find((e) => e.check === 'identity');
  if (!identityEv || identityEv.ok) return null;
  const mismatches = asMismatches(identityEv.metrics?.mismatches);
  return mismatches[0] ?? null;
}

export interface EvidenceContext {
  evidence: Evidence[] | null;
  /** `CollectorState.cause` — explains WHY canary didn't run; the engine only runs
   *  it when `cause === 'STRUCTURAL'` (src/runner.ts). */
  cause: string | null;
  /** `CollectorState.rows` — scope for the contract pass sentence. `null` omits the
   *  row count rather than fabricating one. */
  rows: number | null;
}

export function translateEvidence({ evidence, cause, rows }: EvidenceContext): EvidenceLine[] {
  const list = evidence ?? [];
  const find = (check: EvidenceCheck) => list.find((e) => e.check === check);

  const contractEv = find('contract');
  const totalFields = fieldCount(contractEv);

  return [
    translateContract(contractEv, rows),
    translateCoherence(find('coherence'), totalFields),
    translateIdentity(find('identity')),
    translateCanary(find('canary'), cause),
  ];
}

/* -- Shared formatting: every sentence goes through these, so "0%" / "97.8%" /
      "1,204" are formatted identically everywhere. ------------------------- */

function pct(rate: number): string {
  const p = Math.round(rate * 1000) / 10; // one decimal place, trimmed
  return Number.isInteger(p) ? `${p}%` : `${p.toFixed(1)}%`;
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRates(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asMismatches(value: unknown): IdentityMismatch[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (m): m is IdentityMismatch =>
      !!m && typeof m === 'object' && typeof (m as IdentityMismatch).requestedKey === 'string' && typeof (m as IdentityMismatch).extractedKey === 'string',
  );
}

function asOutcomes(value: unknown): CanaryOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.filter((o): o is CanaryOutcome => !!o && typeof o === 'object' && typeof (o as CanaryOutcome).pass === 'boolean');
}

function fieldCount(contractEv: Evidence | undefined): number | null {
  if (!contractEv || contractEv.metrics?.skipped === true) return null;
  const rates = asRates(contractEv.metrics?.fillRates);
  const n = Object.keys(rates).length;
  return n > 0 ? n : null;
}

/** "skipped: no schema registered" -> a full sentence; two reasons get friendlier
 *  phrasing than a strip-and-capitalize would produce. */
function humanizeSkip(detail: string): string {
  const stripped = detail.replace(/^skipped:\s*/i, '').trim();
  if (stripped === 'no schema registered') {
    return 'Not checked — no schema is registered for this collector.';
  }
  if (stripped === 'no entity_key extractor registered') {
    return 'Not checked — no identity extractor is registered for this collector.';
  }
  const sentence = stripped.length > 0 ? `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}.` : 'no reason recorded.';
  return `Not checked — ${sentence}`;
}

type LineBuilder = (status: EvidenceStatus, sentence: string, raw: Evidence | null, detail?: string) => EvidenceLine;

/** Binds the two fields that are constant per check so each branch below is one line. */
function lineBuilder(check: EvidenceCheck, label: string): LineBuilder {
  return (status, sentence, raw, detail) =>
    detail === undefined ? { check, label, status, sentence, raw } : { check, label, status, sentence, detail, raw };
}

/* -- Contract -------------------------------------------------------- */

function translateContract(evidence: Evidence | undefined, rows: number | null): EvidenceLine {
  const line = lineBuilder('contract', 'Contract');
  if (!evidence) return line('skipped', 'Not checked — no contract evidence was recorded for this run.', null);
  if (evidence.metrics?.skipped === true) return line('skipped', humanizeSkip(evidence.detail), evidence);

  if (evidence.ok) {
    return line(
      'pass',
      rows != null
        ? `Every required field was filled, on all ${count(rows)} row(s), with no errors.`
        : 'Every required field was filled, with no errors.',
      evidence,
    );
  }

  const rates = asRates(evidence.metrics?.fillRates);
  const fields = Object.entries(rates);
  const requiredViolationRate = num(evidence.metrics?.requiredViolationRate) ?? 0;
  const errorRowRate = num(evidence.metrics?.errorRowRate) ?? 0;

  // A contract can fail purely on errored inputs with every returned field filled;
  // the worst-field framing below would name a collapsed field that doesn't exist.
  if (requiredViolationRate === 0 && errorRowRate > 0) {
    return line('fail', `${pct(errorRowRate)} of inputs errored out entirely — every field that did return data was fully filled.`, evidence);
  }

  if (fields.length === 0) {
    return line('fail', 'One or more required fields were missing on this run.', evidence);
  }

  const sorted = [...fields].sort((a, b) => a[1] - b[1]);
  const [worstName, worstRate] = sorted[0];
  const rest = sorted.slice(1);

  let othersDescription: string;
  if (rest.length === 0) {
    othersDescription = 'no other fields to compare against';
  } else {
    const allEqual = rest.every(([, r]) => Math.abs(r - rest[0][1]) < 0.005);
    if (allEqual) {
      othersDescription =
        rest.length <= 3
          ? `${joinNames(rest.map(([n]) => n))} all at ${pct(rest[0][1])}`
          : `every other field: ${pct(rest[0][1])}`;
    } else {
      const avg = rest.reduce((sum, [, r]) => sum + r, 0) / rest.length;
      othersDescription = `the other ${rest.length} field(s) average ${pct(avg)}`;
    }
  }

  return line('fail', `${worstName} was filled on ${pct(worstRate)} of rows — ${othersDescription}.`, evidence);
}

/* -- Coherence ------------------------------------------------------- */

function translateCoherence(evidence: Evidence | undefined, totalFields: number | null): EvidenceLine {
  const line = lineBuilder('coherence', 'Coherence');
  if (!evidence) return line('skipped', 'Not checked — no coherence evidence was recorded for this run.', null);
  if (evidence.metrics?.skipped === true) return line('skipped', humanizeSkip(evidence.detail), evidence);

  if (evidence.ok) {
    return line(
      'pass',
      totalFields != null
        ? `No field collapsed. Fill rates are even across all ${totalFields} field(s).`
        : 'No field collapsed. Fill rates are even across every field.',
      evidence,
    );
  }

  const collapsedFields = asStrings(evidence.metrics?.collapsedFields);

  if (collapsedFields.length > 0) {
    const names = joinNames(collapsedFields);
    const otherCount = totalFields != null ? Math.max(0, totalFields - collapsedFields.length) : null;
    return line(
      'fail',
      otherCount != null
        ? `Only ${names} collapsed. The other ${otherCount} field(s) are untouched — this is one broken extractor, not a dead page.`
        : `Only ${names} collapsed. Every other field is untouched — this is one broken extractor, not a dead page.`,
      evidence,
    );
  }

  if (evidence.metrics?.zeroRows === true) {
    return line('fail', 'This run returned zero rows even though the job reported work was done — the page came back empty.', evidence);
  }

  return line('fail', 'This run failed its coherence check, with no field collapse or empty-page signal recorded.', evidence);
}

/* -- Identity -------------------------------------------------------- */

function translateIdentity(evidence: Evidence | undefined): EvidenceLine {
  const line = lineBuilder('identity', 'Identity');
  if (!evidence) return line('skipped', 'Not checked — no identity evidence was recorded for this run.', null);
  if (evidence.metrics?.skipped === true) return line('skipped', humanizeSkip(evidence.detail), evidence);

  if (evidence.detail.startsWith('not applicable')) {
    return line('skipped', 'Not applicable — no entity key is configured for this collector to compare against.', evidence);
  }

  const compared = num(evidence.metrics?.compared) ?? 0;
  const mismatched = num(evidence.metrics?.mismatched) ?? 0;

  if (evidence.ok) {
    return line('pass', `Every ID requested matched the ID returned, across ${count(compared)} comparable row(s).`, evidence);
  }

  const mismatches = asMismatches(evidence.metrics?.mismatches);
  if (mismatches.length === 0) {
    return line('fail', `${count(mismatched)} of ${count(compared)} row(s) returned the wrong ID.`, evidence);
  }

  const first = mismatches[0];
  return line(
    'fail',
    `We asked for ${first.requestedKey}. The page returned ${first.extractedKey}.`,
    evidence,
    `${count(mismatched)} of ${count(compared)} row(s) are the wrong product.`,
  );
}

/* -- Canary ---------------------------------------------------------- */

function translateCanary(evidence: Evidence | undefined, cause: string | null): EvidenceLine {
  const line = lineBuilder('canary', 'Canary');
  // The engine only appends canary evidence when cause === 'STRUCTURAL'
  // (src/runner.ts), so a missing entry means it never ran, not that it was omitted.
  if (!evidence) {
    const sentence =
      cause === 'IDENTITY'
        ? "Not run. A canary re-fetch confirms a broken extractor; it can't confirm the wrong target was served."
        : 'Not run. A canary re-fetch only runs to confirm a suspected structural break.';
    return line('skipped', sentence, null);
  }
  if (evidence.metrics?.skipped === true) return line('skipped', humanizeSkip(evidence.detail), evidence);

  const outcomes = asOutcomes(evidence.metrics?.outcomes);
  const total = outcomes.length;
  const failCount = num(evidence.metrics?.failCount) ?? outcomes.filter((o) => !o.pass).length;

  if (evidence.ok) {
    return line('pass', `We re-fetched ${total} known-good input(s) just now. All ${total} came back clean.`, evidence);
  }

  const reason = outcomes.find((o) => !o.pass)?.reason ?? 'no reason recorded';
  return line('fail', `We re-fetched ${total} known-good input(s) just now. ${failCount} of ${total} failed: ${reason}.`, evidence);
}
