/**
 * Live smoke test against the real Bright Data API. Skipped by default —
 * only runs when POLYGRAPH_LIVE=1 is set, since it makes real network
 * calls and needs a real BRIGHTDATA_API_KEY (env or ~/.brightdata_admin_key).
 *
 * This intentionally exercises only read-only / harmless endpoints
 * (jobLog + hpErrors on a bogus id, which should 404/error cleanly) so it
 * never triggers a real paid collection run just by existing in CI.
 */
import { describe, it, expect } from 'vitest';
import { BrightDataClient, BrightDataError } from '../../../src/brightdata/client.js';

const live = process.env.POLYGRAPH_LIVE === '1';

describe.skipIf(!live)('BrightDataClient (live smoke)', () => {
  it('reaches the real API and gets a real (non-network-error) response for a bogus job id', async () => {
    const client = new BrightDataClient();

    // A nonexistent job id should surface as a clean 4xx BrightDataError
    // (proving auth + connectivity work), not a network-level throw.
    await expect(client.jobLog('j_polygraph_live_smoke_bogus')).rejects.toBeInstanceOf(BrightDataError);
  });
});
