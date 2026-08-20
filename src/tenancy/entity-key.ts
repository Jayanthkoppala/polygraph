/**
 * Declarative entity-key rules a hosted tenant can pick in onboarding's
 * CONFIRM step (tenant-architecture.md §4 "Declarative entity keys"). A
 * self-serve user cannot hand us a `KeyExtractor` function the way
 * `extractors.ts`'s COLLECTOR_REGISTRY entries do — the rule is data
 * instead, compiled into the same function shape `checks/identity.ts`
 * expects.
 *
 * `url_regex` was deliberately cut from v1 (§4): a user-supplied regular
 * expression executed server-side is a ReDoS vector and Node has no
 * regex-execution timeout — there is no safe way to bound it without a
 * worker thread. These two declarative rules cover the overwhelming
 * majority of real collectors.
 */

export type EntityKeyRule =
  | { kind: 'input_equals_field' } // the raw input IS the expected key
  | { kind: 'url_path_segment'; index: number } // segment N of the input URL is the key
  | { kind: 'none' }; // don't check identity for this collector

/** Same shape as `checks/identity.ts`'s `KeyExtractor` — re-declared here
 * (rather than imported) so this module has no dependency on `checks/`,
 * matching `extractors.ts`'s own `EntityKeyFn` being a structurally
 * compatible, independently-declared type. */
export type KeyExtractor = (input: unknown) => string | undefined;

function urlOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in (input as Record<string, unknown>)) {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === 'string' && url !== '') return url;
  }
  return undefined;
}

/**
 * Compiles a declarative rule into a `KeyExtractor`. Returning `undefined`
 * on an unparseable/missing input matches `extractors.ts`'s own convention
 * ("can't parse … skip, don't false-flag") — `checkIdentity` excludes those
 * rows from the comparison rather than counting them as mismatches. Never
 * throws.
 */
export function compileEntityKeyRule(rule: EntityKeyRule): KeyExtractor {
  switch (rule.kind) {
    case 'input_equals_field':
      return (input) => (typeof input === 'string' && input !== '' ? input : undefined);
    case 'url_path_segment':
      return (input) => {
        const url = urlOf(input);
        if (!url) return undefined;
        try {
          const segments = new URL(url).pathname.split('/').filter(Boolean);
          const segment = segments[rule.index];
          return segment ? decodeURIComponent(segment) : undefined;
        } catch {
          return undefined;
        }
      };
    case 'none':
      return () => undefined;
  }
}
