import { describe, expect, it } from 'vitest';
import { validateDeveloperId, validateNotarization, validateSigningEnvironment, verifyMacosTrust } from '../../scripts/macos-signing.mjs';

const teamId = 'ABCDE12345';
const identity = `Developer ID Application: Asset Studio Publisher (${teamId})`;
const credentials = { APPLE_SIGNING_IDENTITY: identity, APPLE_ID: 'publisher@example.invalid', APPLE_PASSWORD: 'fixture-app-specific-password', APPLE_TEAM_ID: teamId };
const signature = `Authority=${identity}\nAuthority=Developer ID Certification Authority\nTeamIdentifier=${teamId}\nTimestamp=Oct 4, 2026 at 12:00:00\nCodeDirectory v=20500 size=100 flags=0x10000(runtime)\n`;

describe('macOS release prerequisites', () => {
  it('requires an Apple distribution identity even when notarization credentials exist', () => {
    for (const signingIdentity of ['', '-', 'Apple Development: Test (ABCDE12345)', 'Apple Distribution: Test (ABCDE12345)']) {
      expect(() => validateSigningEnvironment({ ...credentials, APPLE_SIGNING_IDENTITY: signingIdentity })).toThrow('Developer ID Application');
    }
  });

  it('rejects a team mismatch and incomplete Apple ID or CI certificate credentials', () => {
    expect(() => validateSigningEnvironment({ ...credentials, APPLE_TEAM_ID: 'OTHER12345' })).toThrow('differs');
    expect(() => validateSigningEnvironment({ ...credentials, APPLE_PASSWORD: '' })).toThrow('Missing APPLE_PASSWORD');
    expect(() => validateSigningEnvironment({ ...credentials, APPLE_CERTIFICATE: 'fixture-p12-base64' })).toThrow('Set both');
    expect(() => validateSigningEnvironment({ APPLE_SIGNING_IDENTITY: identity })).toThrow('Missing Apple notarization credentials');
  });

  it('accepts complete Apple ID or API configuration without returning credentials', () => {
    expect(validateSigningEnvironment(credentials)).toEqual({ teamId, authentication: 'apple-id' });
    expect(validateSigningEnvironment({ APPLE_SIGNING_IDENTITY: identity, APPLE_API_KEY: 'fixture-key-id', APPLE_API_ISSUER: 'fixture-issuer', APPLE_API_KEY_PATH: '/private/fixture.p8' })).toEqual({ teamId, authentication: 'api-key' });
  });

  it('does not include the app-specific password in prerequisite errors', () => {
    expect(() => validateSigningEnvironment({ ...credentials, APPLE_TEAM_ID: '' })).toThrow('Missing APPLE_TEAM_ID');
    try { validateSigningEnvironment({ ...credentials, APPLE_TEAM_ID: '' }); }
    catch (error) { expect(error.message).not.toContain(credentials.APPLE_PASSWORD); }
  });
});

describe('Apple signing and notarization results', () => {
  it('rejects ad-hoc, wrong-team, untimestamped and unhardened signatures', () => {
    expect(() => validateDeveloperId('Signature=adhoc\nTeamIdentifier=not set', teamId)).toThrow('Ad-hoc');
    expect(() => validateDeveloperId(signature, 'OTHER12345')).toThrow('expected Developer ID');
    expect(() => validateDeveloperId(signature.replace(/^Timestamp=.*\n/m, ''), teamId)).toThrow('secure timestamp');
    expect(() => validateDeveloperId(signature.replace('0x10000(runtime)', '0x0(none)'), teamId, { hardenedRuntime: true })).toThrow('hardened runtime');
    expect(validateDeveloperId(signature, teamId, { hardenedRuntime: true })).toBe(true);
  });

  it('accepts only a completed Accepted notarization submission', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    for (const status of ['Invalid', 'In Progress', 'Rejected', undefined]) expect(() => validateNotarization({ id, status })).toThrow('not accepted');
    expect(() => validateNotarization({ status: 'Accepted' })).toThrow('submission ID');
    expect(validateNotarization({ id, status: 'Accepted' })).toBe(true);
  });
});

function nativeResults(overrides = {}) {
  const calls = [];
  const run = async (exe, args, label) => {
    calls.push({ exe, args, label });
    return { exitCode: 0, text: '', errorText: label.endsWith('-identity') ? signature : label.endsWith('-gatekeeper') ? 'accepted\nsource=Notarized Developer ID\n' : '', ...overrides[label] };
  };
  return { run, calls };
}
const packagePaths = { app: '/isolated/copied/Asset Studio.app', dmg: '/isolated/release.dmg', expectedTeamId: teamId };

describe('final macOS package trust gate', () => {
  it('checks app and DMG tickets, both Gatekeeper policies and native distribution eligibility', async () => {
    const { run, calls } = nativeResults();
    expect(await verifyMacosTrust(run, packagePaths)).toMatchObject({ notarization: 'verified', gatekeeper: 'verified', appTicketVerified: true, dmgTicketVerified: true, distributionCheckVerified: true });
    expect(calls.filter(call => call.exe === '/usr/bin/xcrun').map(call => call.args)).toEqual([
      ['stapler', 'validate', packagePaths.app], ['stapler', 'validate', packagePaths.dmg],
    ]);
    expect(calls.find(call => call.label === 'release-dmg-gatekeeper').args).toEqual(['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', packagePaths.dmg]);
    expect(calls.at(-1)).toMatchObject({ exe: '/usr/bin/syspolicy_check', args: ['distribution', packagePaths.app] });
  });

  it('does not treat a valid ad-hoc bundle seal as a distributable package', async () => {
    const { run, calls } = nativeResults({ 'release-app-identity': { errorText: 'Signature=adhoc\nTeamIdentifier=not set\n' } });
    await expect(verifyMacosTrust(run, packagePaths)).rejects.toThrow('Ad-hoc');
    expect(calls.some(call => call.label.endsWith('-gatekeeper'))).toBe(false);
  });

  it.each(['release-app-signature', 'release-dmg-signature', 'release-app-ticket', 'release-dmg-ticket', 'release-app-gatekeeper', 'release-dmg-gatekeeper', 'release-app-distribution'])('rejects failed native check %s', async label => {
    const { run } = nativeResults({ [label]: { exitCode: 1 } });
    await expect(verifyMacosTrust(run, packagePaths)).rejects.toThrow(`${label} failed`);
  });

  it('rejects a policy result that does not establish notarization', async () => {
    const { run } = nativeResults({ 'release-dmg-gatekeeper': { errorText: 'accepted\nsource=Developer ID\n' } });
    await expect(verifyMacosTrust(run, packagePaths)).rejects.toThrow('Notarized Developer ID');
  });
});
