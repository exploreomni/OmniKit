import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';

/** Keep mocked transport tests independent of external DNS while retaining URL/SSRF validation. */
export function mockPublicDns(t: TestContext): void {
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '203.0.114.7', family: 4 }]);
  syncBuiltinESMExports();
  t.after(() => {
    lookup.mock.restore();
    syncBuiltinESMExports();
  });
}
