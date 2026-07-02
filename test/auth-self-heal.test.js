import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recoverAccountsData } from '../src/auth.js';

// accounts.json has been observed getting emptied to `[]` out-of-band (NOT via
// removeAccount — its log never fired). recoverAccountsData restores the pool
// from the mirrored `.bak` snapshot when that happens, so a wipe survives a
// restart instead of silently logging out every account.

const silent = { warn() {}, error() {}, info() {} };
const ACCT = [{ apiKey: 'k1', email: 'a@b.com', id: '1111' }];

describe('recoverAccountsData (out-of-band wipe self-heal)', () => {
  let tmp, accountsFile, bakFile;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wfapi-heal-'));
    accountsFile = join(tmp, 'accounts.json');
    bakFile = join(tmp, 'accounts.json.bak');
  });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('returns the live file and does NOT recover when accounts.json is healthy', () => {
    writeFileSync(accountsFile, JSON.stringify(ACCT));
    writeFileSync(bakFile, JSON.stringify(ACCT));
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.deepEqual(r.data, ACCT);
    assert.equal(r.recovered, false);
  });

  it('recovers from .bak when accounts.json is EMPTY (the wipe case)', () => {
    writeFileSync(accountsFile, '[]');
    writeFileSync(bakFile, JSON.stringify(ACCT));
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.equal(r.recovered, true);
    assert.deepEqual(r.data, ACCT);
  });

  it('recovers from .bak when accounts.json is MISSING', () => {
    writeFileSync(bakFile, JSON.stringify(ACCT));
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.equal(r.recovered, true);
    assert.deepEqual(r.data, ACCT);
  });

  it('recovers from .bak when accounts.json is CORRUPT', () => {
    writeFileSync(accountsFile, '{not json');
    writeFileSync(bakFile, JSON.stringify(ACCT));
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.equal(r.recovered, true);
    assert.deepEqual(r.data, ACCT);
  });

  it('does NOT recover when both are empty (legit full-clear stays cleared)', () => {
    writeFileSync(accountsFile, '[]');
    writeFileSync(bakFile, '[]');
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.equal(r.recovered, false);
    assert.equal((r.data || []).length, 0);
  });

  it('does NOT recover when there is no backup at all', () => {
    writeFileSync(accountsFile, '[]');
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.equal(r.recovered, false);
    assert.equal((r.data || []).length, 0);
  });

  it('falls through safely when the backup itself is corrupt', () => {
    writeFileSync(accountsFile, '[]');
    writeFileSync(bakFile, '{not json');
    const r = recoverAccountsData({ accountsFile, bakFile, logger: silent });
    assert.equal(r.recovered, false);
    assert.equal((r.data || []).length, 0);
  });
});
