# Issue 731 Validation: `mintShieldedToken` + `receiveUnshielded` Combo Failure

Reproduces [midnightntwrk/midnight-js#731](https://github.com/midnightntwrk/midnight-js/issues/731) on a local dev chain. The wallet SDK cannot produce a valid transaction when a circuit uses both `mintShieldedToken` and `receiveUnshielded`.

## Quick Start

```bash
yarn install
yarn compile                 # requires compact toolchain (compactc 0.30.0+)
docker compose up -d --wait  # starts proof-server, indexer, node
yarn test:local              # runs the test suite (~90s)
docker compose down
```

**Prerequisites:**
- Node.js >= 22
- Yarn 1.x
- Docker (with compose v2)
- [Compact toolchain](https://docs.midnight.network/develop/tutorial/building/prereqs) >= 0.30.0 (only needed if recompiling the contract; pre-compiled artifacts are committed)

## Test Results

9 tests, all passing. Each isolates one variable of the bug.

| Test | Circuit | Operations | Result |
|------|---------|-----------|--------|
| deploy | constructor | deploy with `mint_fee=1000000` | pass |
| register | `receiveUnshielded` only | fee-only control | error 192 (no unshielded NIGHT on localnet) |
| free_mint | `mintShieldedToken` only | mint-only control | **SucceedEntirely** |
| **mint+fee (all)** | both | **bug repro** | **error 186 (EffectsCheckFailure)** |
| workaround deploy | constructor | deploy with `mint_fee=0` | pass |
| **workaround mint** | both (fee skipped) | **workaround confirmed** | **SucceedEntirely** |
| mint+fee (unshielded+dust) | both | skip shielded balancing | error (balancing failure) |
| empty wallet | deploy | no funds at all | balancing failure |

## Workarounds

### Recommended: Deploy with `mint_fee=0`, collect fees separately

The `mint` circuit has an `if (mint_fee > 0)` guard around `receiveUnshielded`. When `mint_fee=0`, only `mintShieldedToken` executes and succeeds. Collect fees in a separate circuit or off-chain.

```compact
// Deploy with _mint_fee = 0
constructor(_nonce: Bytes<32>, _mint_fee: Uint<128>) { ... }

// The mint circuit's if-guard skips receiveUnshielded when fee is 0
circuit mint(name: Bytes<32>): Bytes<32> {
    const coin_info = mintShieldedToken(...);
    if (mint_fee > (0 as Uint<128>)) {
        receiveUnshielded(nativeToken(), mint_fee);  // skipped when fee=0
    }
    return coin_info.color;
}

// Collect fees in a separate circuit
circuit payFee(): [] {
    receiveUnshielded(nativeToken(), fee_amount);
}
```

**Trade-off:** Breaks atomicity. Users can mint without paying. Requires off-chain enforcement or a two-phase pattern (mint pending, confirm after fee).

### Alternative: Use `mintUnshieldedToken` instead of `mintShieldedToken`

If the NFT doesn't require privacy, use `mintUnshieldedToken`. The unshielded balancer handles both operations and the combo works since no shielded balancing is needed.

### Alternative: Pre-shield NIGHT before minting

If the wallet has only unshielded NIGHT (faucet-funded), shield some NIGHT first so the shielded balancer has coins. This adds an extra transaction and fees. Does not fix the error 186 path (localnet shows the combo transaction is fundamentally malformed even when the shielded balancer has funds).

## Wallet SDK Deep Dive

### The Balancing Pipeline

The bug is in `wallet-sdk-facade`'s `balanceUnboundTransaction` ([`index.js:232-261`](node_modules/@midnight-ntwrk/wallet-sdk-facade/dist/index.js)). This function orchestrates three independent balancers:

```
balanceUnboundTransaction(tx, secretKeys, options)
  Line 237: shieldedBalancingTx  = shielded.balanceTransaction(keys, tx)    // creates separate tx
  Line 241: balancedUnshieldedTx = unshielded.balanceUnboundTransaction(tx) // modifies tx in-place
  Line 245: baseTx = balancedUnshieldedTx ?? tx
  Line 247: feeTx = dust.balanceTransactions(key, [baseTx, shieldedBalancingTx], ttl)
  Line 251: balancingTx = merge(shieldedBalancingTx, feeTx)
  Return:   { baseTransaction: baseTx, balancingTransaction: balancingTx }
```

Finalization at `index.js:297-302`:
```
finalizedTx = baseTx.bind().merge(finalizedBalancingTx)
```

### Two Failure Paths

#### Path 1: Wallet has only unshielded NIGHT (preview network, faucet-funded)

1. **Shielded balancer** runs first (line 238). Sees imbalances from `mintShieldedToken`. Tries to find shielded coins to create a Zswap offer. Wallet has zero shielded coins.
2. **Throws `InsufficientFundsError`** at [`wallet-sdk-shielded/dist/v1/Transacting.js:178`](node_modules/@midnight-ntwrk/wallet-sdk-shielded/dist/v1/Transacting.js).
3. Execution stops. **Unshielded balancer never runs.** The `receiveUnshielded` fee could have been handled by the unshielded balancer, but it never gets the chance.

#### Path 2: Wallet has only shielded NIGHT (localnet, block rewards)

1. **Shielded balancer** runs first (line 238). Has shielded NIGHT. Creates `shieldedBalancingTx` to handle `mintShieldedToken`. **Succeeds.**
2. **Unshielded balancer** runs (line 242). Sees `receiveUnshielded` requiring unshielded NIGHT inputs. Wallet has no unshielded UTXOs. Creates a malformed unshielded offer (outputs to the contract but no matching inputs). Modifies `tx` in-place.
3. **Dust balancer** runs (line 248). Calculates fees on the merged set.
4. **Merge** (line 251): composes `shieldedBalancingTx` + `feeTx`. Does **not** fix the malformed unshielded offer already embedded in `baseTx`.
5. **Finalize** (line 301): `baseTx.bind().merge(balancingTx)`. Final transaction has correct shielded balancing but a malformed unshielded offer.
6. **Chain rejects** with error 186 (`EffectsCheckFailure`) — declared `receiveUnshielded` effects don't match actual unshielded spends.

### Error Code Reference

Source: `midnight-node/ledger/src/versions/common/types.rs`

| Code | Name | Meaning |
|------|------|---------|
| 186 | `EffectsCheckFailure` | Transaction's declared effects (commitments, nullifiers, unshielded spends) don't match what the ledger computed |
| 192 | `InputsSignaturesLengthMismatch` | Unshielded offer has mismatched input count and signature count |

### Why Each Control Test Behaves As It Does

**`free_mint` (mint only) succeeds:** Only `mintShieldedToken` runs. Shielded balancer handles it. Unshielded balancer has nothing to do. No cross-domain composition needed.

**`mint` with `fee=0` succeeds:** The `if (mint_fee > 0)` guard skips `receiveUnshielded` at runtime. Circuit only executes `mintShieldedToken`. Same as `free_mint`.

**`register` (fee only) fails with 192:** Only `receiveUnshielded` runs. Shielded balancer sees no shielded imbalances and short-circuits. Unshielded balancer handles `receiveUnshielded` but with no unshielded UTXOs, produces an offer with outputs but no inputs. Chain rejects with input/signature mismatch (192).

**`mint` with `fee>0` fails with 186 (not 192):** Both operations run. Shielded effects change the chain's validation path. Effects consistency check (186) fires before input/signature matching (192).

### Root Cause Summary

The bug is a **composition failure**. The pipeline runs shielded and unshielded balancers independently on the same transaction, but:

1. Neither balancer knows about the other's domain requirements
2. The unshielded balancer can embed a malformed offer in `baseTx` with no validation
3. The shielded balancer can throw early (`InsufficientFunds`) preventing the unshielded balancer from running at all
4. The merge step only composes `shieldedBalancingTx` and `feeTx` — it doesn't validate `baseTx`'s unshielded offers

### Relevant Source Locations

| Component | Package | File | Lines |
|-----------|---------|------|-------|
| Facade balancing | `wallet-sdk-facade` | `dist/index.js` | 232-261 |
| Facade finalization | `wallet-sdk-facade` | `dist/index.js` | 289-313 |
| Facade merge | `wallet-sdk-facade` | `dist/index.js` | 156-160 |
| Shielded balancer | `wallet-sdk-shielded` | `dist/v1/Transacting.js` | 40-50 |
| Shielded fallible | `wallet-sdk-shielded` | `dist/v1/Transacting.js` | 122-159 |
| Shielded guaranteed | `wallet-sdk-shielded` | `dist/v1/Transacting.js` | 161-189 |
| Shielded imbalances | `wallet-sdk-shielded` | `dist/v1/TransactionOps.js` | 40-75 |
| Unshielded balancer | `wallet-sdk-unshielded-wallet` | `dist/v1/Transacting.js` | 289-326 |
| Balance recipe | `wallet-sdk-capabilities` | `dist/balancer/Balancer.js` | 21-62 |
| Counter offer | `wallet-sdk-capabilities` | `dist/balancer/CounterOffer.js` | 14-65 |

## Stack Versions

```
@midnight-ntwrk/midnight-js-*: 4.0.2
@midnight-ntwrk/ledger-v8: 8.0.3
@midnight-ntwrk/compact-runtime: 0.15.0
@midnight-ntwrk/wallet-sdk-facade: 3.0.0
@midnight-ntwrk/wallet-sdk-shielded: 2.1.0
@midnight-ntwrk/wallet-sdk-unshielded-wallet: 2.1.0
compactc: 0.30.0
proof-server: 8.0.3
indexer-standalone: 4.0.0
midnight-node: 0.22.3
```
