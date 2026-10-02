import { appendFileSync } from 'node:fs';

globalThis.fetch = async () => {
  appendFileSync(process.env.LAB_TEST_CALLS, 'network-denied\n');
  throw new Error('Offline test fixture');
};
