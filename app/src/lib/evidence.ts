/**
 * Evidence translation — the fix for "there is no reason, or events, or
 * what the event even emits" (the literal complaint this task exists to
 * answer). ONE module, metric -> sentence, per ux-spec.md §5: "Write the
 * translation layer once, in one module, and never let a raw metric name
 * reach the screen." `requiredViolationRate`, `mismatchRate`,
 * `collapsedFields`, `errorRowRate`, `passRate` — none of those identifiers
 * is ever assembled into a rendered sentence by this module. They still
 * exist on `Evidence.metrics` and are reachable via each `EvidenceLine.raw`
 * for the `⌄ raw` disclosure (ux-spec.md §5: "Raw JSON lives behind a
 * disclosure... present for the engineer who will ask, invisible to
 * everyone else") — that disclosure is the one place those names are
 * SUPPOSED to be legible, and is not what this module's own output (the
 * `sentence`/`detail`/`label` fields) may ever contain.
 *
 * Every proof is a COMPARISON, never a lone number (ux-spec.md §5): a fill
 * rate is always stated against the rest of the schema's fields, a mismatch
 * is always the requested value next to the received one, a canary result
 * is always "N of M" with the failing reason attached.
 *
 * `translateEvidence` always returns exactly four lines, in this fixed
 * order — contract, coherence, identity, canary — per ux-spec.md §5's run
 * detail page: "All four checks always render, including the ones that
 * passed and the ones that didn't run." A check that never ran (no entry in
 * `evidence[]` at all — e.g. canary, which the engine only appends when
 * `cause === 'STRUCTURAL'`, see src/runner.ts) renders as `status: 'skipped'`
 * WITH the reason it didn't run, never as a silent omission and never as a
 * pass.
 */
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
  /** A second, supporting sentence — present only when the proof needs a
   * scope statement beyond the headline (e.g. identity's "N of M rows"). */
  detail?: string;
  /** The verbatim engine Evidence this line was derived from, for the
   * `⌄ raw` disclosure. `null` when the check never ran at all (nothing to
   * show raw — the reason is already fully expressed in `sentence`). */
  raw: Evidence | null;
}

/** The one entity-key substitution this evidence set proves, if any — the
 * exact pair `VerdictCard`'s rotating chip needs (ui-system.md §2.6 beat 1-2:
 * "the entity key chip in the card body rotates out... the returned key
 * rotates in"). `null` when there is no identity evidence, or identity
 * passed, or (defensively) it failed with an empty `mismatches[]`. */
export function firstIdentityMismatch(evidence: Evidence[] | null): IdentityMismatch | null {
  const identityEv = (evidence ?? []).find((e) => e.check === 'identity');
  if (!identityEv || identityEv.ok) return null;
  const mismatches = asMismatches(identityEv.metrics?.mismatches);
  return mismatches[0] ?? null;
}

export interface EvidenceContext {
  evidence: Evidence[] | null;
  /** `CollectorState.cause` — needed only to explain WHY canary didn't run
   * (a canary re-fetch confirms a structural break; it is never run to
   * confirm an identity failure — see src/runner.ts, canary only runs when
   * `cause === 'STRUCTURAL'`). */
  cause: string | null;
  /** `CollectorState.rows` — best-effort row count for the contract pass
   * sentence's scope ("...on all N rows"). `null` renders the sentence
   * without a row count rather than fabricating one. */
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

/* -------------------------------------------------------------------- */
/* Shared formatting — every sentence in this module goes through these  */
/* so "0%" / "97.8%" / "1,204" formatting is consistent everywhere.      */
/* -------------------------------------------------------------------- */

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

/** "skipped: no schema registered" -> a full sentence, never the raw engine
 * string verbatim (it's a valid English fragment, but not a sentence — and
 * two specific reasons get friendlier phrasing than a strip-and-capitalize
 * would produce). */
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

/* -------------------------------------------------------------------- */
/* Contract                                                              */
/* -------------------------------------------------------------------- */

function translateContract(evidence: Evidence | undefined, rows: number | null): EvidenceLine {
  const check: EvidenceCheck = 'contract';
  const label = 'Contract';

  if (!evidence) {
    return { check, label, status: 'skipped', sentence: 'Not checked — no contract evidence was recorded for this run.', raw: null };
  }
  if (evidence.metrics?.skipped === true) {
    return { check, label, status: 'skipped', sentence: humanizeSkip(evidence.detail), raw: evidence };
  }

  if (evidence.ok) {
    const sentence =
      rows != null
        ? `Every required field was filled, on all ${count(rows)} row(s), with no errors.`
        : 'Every required field was filled, with no errors.';
    return { check, label, status: 'pass', sentence, raw: evidence };
  }

  const rates = asRates(evidence.metrics?.fillRates);
  const fields = Object.entries(rates);
  const requiredViolationRate = num(evidence.metrics?.requiredViolationRate) ?? 0;
  const errorRowRate = num(evidence.metrics?.errorRowRate) ?? 0;

  // A contract can fail purely on errored inputs with every returned field
  // fully filled — the worst-field framing below would be misleading here
  // (there's no collapsed field to name), so this gets its own comparison.
  if (requiredViolationRate === 0 && errorRowRate > 0) {
    const sentence = `${pct(errorRowRate)} of inputs errored out entirely — every field that did return data was fully filled.`;
    return { check, label, status: 'fail', sentence, raw: evidence };
  }

  if (fields.length === 0) {
    return {
      check,
      label,
      status: 'fail',
      sentence: 'One or more required fields were missing on this run.',
      raw: evidence,
    };
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

  const sentence = `${worstName} was filled on ${pct(worstRate)} of rows — ${othersDescription}.`;
  return { check, label, status: 'fail', sentence, raw: evidence };
}

/* -------------------------------------------------------------------- */
/* Coherence                                                             */
/* -------------------------------------------------------------------- */

function translateCoherence(evidence: Evidence | undefined, totalFields: number | null): EvidenceLine {
  const check: EvidenceCheck = 'coherence';
  const label = 'Coherence';

  if (!evidence) {
    return { check, label, status: 'skipped', sentence: 'Not checked — no coherence evidence was recorded for this run.', raw: null };
  }
  if (evidence.metrics?.skipped === true) {
    return { check, label, status: 'skipped', sentence: humanizeSkip(evidence.detail), raw: evidence };
  }

  if (evidence.ok) {
    const sentence =
      totalFields != null
        ? `No field collapsed. Fill rates are even across all ${totalFields} field(s).`
        : 'No field collapsed. Fill rates are even across every field.';
    return { check, label, status: 'pass', sentence, raw: evidence };
  }

  const collapsedFields = asStrings(evidence.metrics?.collapsedFields);
  const zeroRows = evidence.metrics?.zeroRows === true;

  if (collapsedFields.length > 0) {
    const names = joinNames(collapsedFields);
    const otherCount = totalFields != null ? Math.max(0, totalFields - collapsedFields.length) : null;
    const sentence =
      otherCount != null
        ? `Only ${names} collapsed. The other ${otherCount} field(s) are untouched — this is one broken extractor, not a dead page.`
        : `Only ${names} collapsed. Every other field is untouched — this is one broken extractor, not a dead page.`;
    return { check, label, status: 'fail', sentence, raw: evidence };
  }

  if (zeroRows) {
    return {
      check,
      label,
      status: 'fail',
      sentence: 'This run returned zero rows even though the job reported work was done — the page came back empty.',
      raw: evidence,
    };
  }

  return {
    check,
    label,
    status: 'fail',
    sentence: 'This run failed its coherence check, with no field collapse or empty-page signal recorded.',
    raw: evidence,
  };
}

/* -------------------------------------------------------------------- */
/* Identity                                                              */
/* -------------------------------------------------------------------- */

function translateIdentity(evidence: Evidence | undefined): EvidenceLine {
  const check: EvidenceCheck = 'identity';
  const label = 'Identity';

  if (!evidence) {
    return { check, label, status: 'skipped', sentence: 'Not checked — no identity evidence was recorded for this run.', raw: null };
  }
  if (evidence.metrics?.skipped === true) {
    return { check, label, status: 'skipped', sentence: humanizeSkip(evidence.detail), raw: evidence };
  }
  if (evidence.detail.startsWith('not applicable')) {
    return {
      check,
      label,
      status: 'skipped',
      sentence: 'Not applicable — no entity key is configured for this collector to compare against.',
      raw: evidence,
    };
  }

  const compared = num(evidence.metrics?.compared) ?? 0;
  const mismatched = num(evidence.metrics?.mismatched) ?? 0;

  if (evidence.ok) {
    const sentence = `Every ID requested matched the ID returned, across ${count(compared)} comparable row(s).`;
    return { check, label, status: 'pass', sentence, raw: evidence };
  }

  const mismatches = asMismatches(evidence.metrics?.mismatches);
  const detail = `${count(mismatched)} of ${count(compared)} row(s) are the wrong product.`;

  if (mismatches.length === 0) {
    return {
      check,
      label,
      status: 'fail',
      sentence: `${count(mismatched)} of ${count(compared)} row(s) returned the wrong ID.`,
      raw: evidence,
    };
  }

  const first = mismatches[0];
  const sentence = `We asked for ${first.requestedKey}. The page returned ${first.extractedKey}.`;
  return { check, label, status: 'fail', sentence, detail, raw: evidence };
}

/* -------------------------------------------------------------------- */
/* Canary                                                                */
/* -------------------------------------------------------------------- */

function translateCanary(evidence: Evidence | undefined, cause: string | null): EvidenceLine {
  const check: EvidenceCheck = 'canary';
  const label = 'Canary';

  // The engine only appends canary evidence when cause === 'STRUCTURAL'
  // (src/runner.ts) — every other cause means it genuinely never ran, not
  // that it was omitted from the response. The reason it didn't run differs
  // by what the run actually found.
  if (!evidence) {
    const sentence =
      cause === 'IDENTITY'
        ? "Not run. A canary re-fetch confirms a broken extractor; it can't confirm the wrong target was served."
        : 'Not run. A canary re-fetch only runs to confirm a suspected structural break.';
    return { check, label, status: 'skipped', sentence, raw: null };
  }
  if (evidence.metrics?.skipped === true) {
    return { check, label, status: 'skipped', sentence: humanizeSkip(evidence.detail), raw: evidence };
  }

  const outcomes = asOutcomes(evidence.metrics?.outcomes);
  const total = outcomes.length;
  const failCount = num(evidence.metrics?.failCount) ?? outcomes.filter((o) => !o.pass).length;

  if (evidence.ok) {
    const sentence = `We re-fetched ${total} known-good input(s) just now. All ${total} came back clean.`;
    return { check, label, status: 'pass', sentence, raw: evidence };
  }

  const firstFail = outcomes.find((o) => !o.pass);
  const reason = firstFail?.reason ?? 'no reason recorded';
  const sentence = `We re-fetched ${total} known-good input(s) just now. ${failCount} of ${total} failed: ${reason}.`;
  return { check, label, status: 'fail', sentence, raw: evidence };
}
