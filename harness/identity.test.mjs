import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwner, assertProfileIdentity, buildSystemdUnit, parseCli, validateConfig } from './harness.mjs';

test('pinned owner rejects root and other users', () => {
  assert.doesNotThrow(() => assertOwner({ ownerUid: 1000 }, 1000));
  assert.throws(() => assertOwner({ ownerUid: 1000 }, 0), /without sudo/);
  assert.throws(() => assertOwner({ ownerUid: 1000 }, 1001), /belongs to UID/);
  assert.doesNotThrow(() => assertOwner({}, 0));
  assert.throws(() => validateConfig({ ownerUid: '1000', profiles: { default: {} } }), /ownerUid/);
});

test('pinned identity refuses missing, corrupt, renamed or wrong profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-identity-'));
  const profile = { userDataDir: dir, profileDirectory: 'Profile 1', expectedProfileName: 'Agent' };
  try {
    assert.throws(() => assertProfileIdentity(profile), /Refusing wrong/);
    writeFileSync(join(dir, 'Local State'), 'not json');
    assert.throws(() => assertProfileIdentity(profile), /Refusing wrong/);
    writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: {
      'Profile 1': { name: 'Your Chrome' }, 'Profile 2': { name: 'Agent' },
    } } }));
    assert.throws(() => assertProfileIdentity(profile), /Your Chrome/);
    writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: {
      'Profile 1': { name: 'Agent' },
    } } }));
    assert.doesNotThrow(() => assertProfileIdentity(profile));
    assert.doesNotThrow(() => assertProfileIdentity({ userDataDir: dir }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unit is pinned to configured owner', () => {
  const config = validateConfig({ ownerUid: 1000, profiles: { default: {} } });
  assert.match(buildSystemdUnit(config), /^ConditionUser=1000$/m);
});

test('profile directory cannot escape user data root', () => {
  for (const profileDirectory of ['..', '.', '../Profile 1', 'a/b', 'a\\b', '']) {
    assert.throws(() => validateConfig({ profiles: { default: { profileDirectory } } }), /single directory/);
  }
});

test('friendly management aliases', () => {
  for (const [alias, command] of Object.entries({ start: 'up', stop: 'down', ps: 'status', list: 'profiles', enable: 'install-service', disable: 'uninstall-service' })) {
    assert.equal(parseCli(['node', 'harness', alias]).command, command);
  }
});
