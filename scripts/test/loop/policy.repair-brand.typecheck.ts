/**
 * Type-level proof that `Action`'s REPAIR variant cannot be hand-constructed
 * outside `policy.ts` — the REPAIR_BRAND invariant from Finding 1 of the
 * Task 4 fix round.
 *
 * This file is NOT a vitest test (no `.test.` in its name, on purpose:
 * vitest transpiles via esbuild without type-checking, so a `@ts-expect-error`
 * comment would silently do nothing under `npm test`). It's checked instead
 * by `npm run typecheck` (`tsc -p tsconfig.typecheck.json`), which type-checks
 * `test/` alongside `src/` — if the line below ever stops being a type error
 * (e.g. someone exports REPAIR_BRAND, or drops the brand), `tsc` fails with
 * "Unused '@ts-expect-error' directive", catching the regression.
 */
import type { Action } from '../../../src/loop/policy.js';

// @ts-expect-error — REPAIR requires the unexported REPAIR_BRAND symbol from
// policy.ts; only decide()'s STRUCTURAL path (via the private
// mintRepairAction) can attach it. A plain object literal is missing that
// required property for every cause, including IDENTITY.
const illegalRepair: Action = { type: 'REPAIR', heal_prompt: 'anyone could write this' };

void illegalRepair;
