// The sentences the Repair receipts table tells, derived from the receipt
// itself.
//
// Deliberately not free text from the server: every sentence here is built
// from counts and field names the response already carries, so a receipt can
// never narrate something the evidence does not support. The heal prompt —
// the one piece of genuinely generated prose in a repair — is not returned by
// the API at all, precisely because it is written around the customer's data.
import type { RecoveryRepair } from '@/lib/recoveryApi';
import { templateLabel } from './verdictLabel';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The field names that broke. Prefers the diagnosis recorded at detection;
 *  falls back to the fields the repair restored, which is the same set seen
 *  from the other end. */
export function brokenFields(repair: RecoveryRepair): string[] {
  const regressed = repair.detail?.detected?.regressedFields ?? [];
  return regressed.length > 0 ? regressed : repair.fieldsRestored;
}

/** One sentence: what stopped working. */
export function brokenChangeSentence(repair: RecoveryRepair): string {
  if (repair.mode === 'bootstrap') {
    return 'This collector had never produced a delivery matching its declared schema.';
  }
  const fields = brokenFields(repair);
  const rows = repair.detail?.detected?.rowCount ?? null;
  if (fields.length === 0) {
    return 'A structural break was detected in this collector’s output.';
  }
  const where = rows !== null ? ` in a ${rows}-row delivery` : '';
  return `${plural(fields.length, 'field')} stopped arriving${where}.`;
}

/** "Generation v4 → v5", or `null` when either version is unknown — half a
 *  version range says less than no version range. */
export function generationLine(repair: RecoveryRepair): string | null {
  const before = repair.detail?.publication.templateBefore ?? repair.templateBefore;
  const after = repair.detail?.publication.templateAfter ?? repair.templateAfter;
  if (!before || !after) return null;
  return `Generation ${templateLabel(before).label} → ${templateLabel(after).label}`;
}

/** One sentence: what Polygraph did about it. */
export function repairNarrative(repair: RecoveryRepair): string {
  if (repair.mode === 'bootstrap') {
    return 'Polygraph generated a first working extraction and proved it against the declared schema before accepting it.';
  }
  const restored = repair.fieldsRestored.length;
  const tail =
    restored > 0
      ? `a fresh run brought ${plural(restored, 'field')} back.`
      : 'a fresh run confirmed the output was whole again.';
  return `Polygraph rewrote the extraction with Bright Data, published the new template, and ${tail}`;
}
