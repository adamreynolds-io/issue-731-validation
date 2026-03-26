import { CompiledContract } from '@midnight-ntwrk/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  type Ledger,
  type Witnesses,
  type ImpureCircuits,
} from './managed/fee-mint/contract/index.js';

import { Contract } from './managed/fee-mint/contract/index.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkConfigPath = path.resolve(currentDir, 'managed', 'fee-mint');

export const CompiledFeeMintContract = CompiledContract.make(
  'FeeMintContract',
  Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
