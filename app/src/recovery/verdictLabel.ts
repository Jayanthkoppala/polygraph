// Plain-language names for what a delivery was judged to be.
//
// The raw codes (`PASS`, `FAILED_STRUCTURAL`, `BLOCKED`) are the grader's
// vocabulary, not a customer's, and a results table read at a glance should
// say what happened rather than what the enum is called. The code is never
// thrown away — it goes in the `title`, so the person debugging a webhook can
// still see exactly what the server decided.
//
// One helper, one precedence order, so two columns (or two surfaces) can never
// disagree about what a row means.
import type { RecoveryDelivery } from '@/lib/recoveryApi';

export interface VerdictDisplay {
  label: string;
  /** The raw grader output, for the cell's tooltip. */
  title: string;
  /** `chip` renders the coloured pill; `muted` is plain grey text with no
   *  chip — a test sample is not a judgement and must not look like one. */
  tone: 'pass' | 'fail' | 'blocked' | 'neutral' | 'muted';
}

/** What the grader actually said, for the tooltip. */
function rawOf(delivery: Pick<RecoveryDelivery, 'verdict' | 'cause'>): string {
  if (!delivery.verdict && !delivery.cause) return 'not graded';
  return delivery.cause ? `${delivery.verdict ?? '—'} (${delivery.cause})` : (delivery.verdict as string);
}

/**
 * Precedence, highest first:
 *
 *  1. **Test sample** — a two-row probe is not evidence about the collector's
 *     health, so it gets no verdict chip at all. Showing one would put a green
 *     "Healthy" next to a sample that proves nothing.
 *  2. **Blocked** — the source refused; whatever else the row shows is
 *     downstream of that.
 *  3. **Empty delivery** — zero data rows. Ahead of `PASS` on purpose: a
 *     delivery that graded PASS with nothing in it is the ambiguous-empty
 *     case, and calling it "Healthy" is exactly the lie this product exists
 *     to catch.
 *  4. The verdict itself.
 *  5. **Verification run** — the fallback for Polygraph's own post-repair run
 *     when it carries no verdict of its own.
 */
export function verdictLabel(
  delivery: Pick<RecoveryDelivery, 'verdict' | 'cause' | 'source' | 'rowCount' | 'testSample'>
): VerdictDisplay {
  const raw = rawOf(delivery);
  if (delivery.testSample) return { label: 'Test sample', title: raw, tone: 'muted' };

  const cause = (delivery.cause ?? '').toUpperCase();
  const verdict = (delivery.verdict ?? '').toUpperCase();
  if (cause.includes('BLOCKED') || verdict.includes('BLOCKED')) {
    return { label: 'Blocked', title: raw, tone: 'blocked' };
  }
  if (delivery.rowCount === 0) return { label: 'Empty delivery', title: raw, tone: 'fail' };
  if (verdict === 'PASS') return { label: 'Healthy', title: raw, tone: 'pass' };
  if (verdict === 'FAILED_STRUCTURAL') return { label: 'Wrong shape', title: raw, tone: 'fail' };
  if (verdict.startsWith('FAILED') || verdict.startsWith('SUSPECT')) {
    return { label: verdict.startsWith('SUSPECT') ? 'Needs a look' : 'Wrong shape', title: raw, tone: 'fail' };
  }
  if (delivery.source === 'verification') return { label: 'Verification run', title: raw, tone: 'neutral' };
  return { label: delivery.verdict ?? '—', title: raw, tone: 'neutral' };
}

/** What made this delivery arrive. Bright Data's own runs and Polygraph's
 *  post-repair verification run land in the same table and must never be
 *  mistaken for one another. */
export function triggerLabel(source: RecoveryDelivery['source']): string {
  return source === 'verification' ? 'Polygraph verification run' : 'Bright Data delivery';
}

/** `t_x.5` → `v5`, with the full stored id kept for the tooltip. A version we
 *  do not know is "—", never a guess. */
export function templateLabel(template: string | null | undefined): { label: string; title: string } {
  if (!template) return { label: '—', title: 'No template version recorded for this delivery' };
  const version = template.slice(template.lastIndexOf('.') + 1);
  return { label: /^\d+$/.test(version) ? `v${version}` : template, title: template };
}

/** Data rows ÷ (data rows + error records). `null` when the delivery carried
 *  neither, which is not the same as 0%. */
export function successRate(
  delivery: Pick<RecoveryDelivery, 'rowCount' | 'errorCount'>
): number | null {
  const rows = delivery.rowCount ?? 0;
  const total = rows + (delivery.errorCount ?? 0);
  if (total === 0) return null;
  return rows / total;
}
