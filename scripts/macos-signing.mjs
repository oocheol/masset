/** Developer ID release prerequisites, DMG notarization and native trust checks.
 * Tauri signs/notarizes/staples the .app and signs the DMG. The final DMG needs
 * its own notarization ticket; integrity-only codesign checks do not establish trust.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const check = (value, message) => { if (!value) throw new Error(message); };
const usage = 'Usage: node scripts/macos-signing.mjs check | notarize <signed.dmg> <fresh-evidence-directory>';

export function validateSigningEnvironment(env) {
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  const match = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity ?? '');
  check(match, 'APPLE_SIGNING_IDENTITY must be a Developer ID Application identity. Ad-hoc signing cannot prevent the macOS warning. See docs/macos-signing.md.');
  const teamId = match[1];
  check(!env.APPLE_TEAM_ID || env.APPLE_TEAM_ID === teamId, 'APPLE_TEAM_ID differs from the Developer ID Application certificate.');
  check(Boolean(env.APPLE_CERTIFICATE) === Boolean(env.APPLE_CERTIFICATE_PASSWORD), 'Set both APPLE_CERTIFICATE (base64 .p12 including its private key) and APPLE_CERTIFICATE_PASSWORD, or use a local keychain identity.');
  if (env.APPLE_ID || env.APPLE_PASSWORD) {
    for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) check(env[key]?.trim(), `Missing ${key} for Apple notarization. APPLE_PASSWORD must be an app-specific password.`);
    return { teamId, authentication: 'apple-id' };
  }
  for (const key of ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) check(env[key]?.trim(), `Missing Apple notarization credentials: set APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID or APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH (missing ${key}).`);
  return { teamId, authentication: 'api-key' };
}

export function validateDeveloperId(description, expectedTeamId, { hardenedRuntime = false } = {}) {
  check(/^[A-Z0-9]{10}$/.test(expectedTeamId), 'An expected Apple Team ID is required for release verification.');
  check(!/^Signature=adhoc$/m.test(description), 'Ad-hoc signing does not establish Apple trust.');
  const authority = /^Authority=Developer ID Application: .+ \(([A-Z0-9]{10})\)$/m.exec(description);
  check(authority?.[1] === expectedTeamId && /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(description)?.[1] === expectedTeamId, 'The package is not signed by the expected Developer ID Application team.');
  check(/^Timestamp=.+$/m.test(description), 'The Developer ID signature is missing a secure timestamp.');
  check(!hardenedRuntime || /^.*flags=.*\bruntime\b.*$/m.test(description), 'The application must enable the hardened runtime for notarization.');
  return true;
}

export function validateNotarization(result) {
  check(typeof result.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.id), 'Apple did not return a notarization submission ID.');
  check(result.status === 'Accepted', `Apple notarization was not accepted (status: ${result.status ?? 'missing'}). The DMG must not be published.`);
  return true;
}

export async function verifyMacosTrust(run, { app, dmg, expectedTeamId }) {
  const required = async (exe, args, label) => {
    const result = await run(exe, args, label);
    check(result.exitCode === 0 && !result.timedOut && !result.launchError, `${label} failed; this package must not be published.`);
    return `${result.text ?? ''}\n${result.errorText ?? ''}`;
  };
  await required('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 'release-app-signature');
  await required('/usr/bin/codesign', ['--verify', '--strict', dmg], 'release-dmg-signature');
  validateDeveloperId(await required('/usr/bin/codesign', ['-dv', '--verbose=4', app], 'release-app-identity'), expectedTeamId, { hardenedRuntime: true });
  validateDeveloperId(await required('/usr/bin/codesign', ['-dv', '--verbose=4', dmg], 'release-dmg-identity'), expectedTeamId);
  await required('/usr/bin/xcrun', ['stapler', 'validate', app], 'release-app-ticket');
  await required('/usr/bin/xcrun', ['stapler', 'validate', dmg], 'release-dmg-ticket');
  const appPolicy = await required('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'release-app-gatekeeper');
  const dmgPolicy = await required('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg], 'release-dmg-gatekeeper');
  check([appPolicy, dmgPolicy].every(text => /^source=Notarized Developer ID$/m.test(text)), 'Gatekeeper did not identify both the app and DMG as Notarized Developer ID.');
  await required('/usr/bin/syspolicy_check', ['distribution', app], 'release-app-distribution');
  return { signature: 'developer-id', teamId: expectedTeamId, appBundleSealVerified: true, dmgSignatureVerified: true, secureTimestampVerified: true, hardenedRuntimeVerified: true, notarization: 'verified', appTicketVerified: true, dmgTicketVerified: true, gatekeeper: 'verified', distributionCheckVerified: true, gatekeeperScope: 'native policy assessments of the final DMG and its copied app; clean-machine first launch remains separate' };
}

// Never echo credential-bearing arguments or include them in thrown errors.
function execute(exe, args, { timeout = 60 } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    let timedOut = false, launchError, force;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 5000); }, timeout * 1000);
    child.on('error', error => { launchError = error.message; });
    child.on('close', exitCode => {
      clearTimeout(timer); clearTimeout(force);
      resolveResult({ exitCode, timedOut, launchError, text: Buffer.concat(stdout).toString('utf8'), errorText: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function prerequisites(env) {
  check(process.platform === 'darwin', 'Developer ID signing and notarization require macOS.');
  const settings = validateSigningEnvironment(env);
  if (settings.authentication === 'api-key') check((await lstat(env.APPLE_API_KEY_PATH)).isFile(), 'APPLE_API_KEY_PATH must identify the downloaded Apple .p8 private key.');
  if (!env.APPLE_CERTIFICATE) {
    const identities = await execute('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    check(identities.exitCode === 0 && identities.text.includes(`"${env.APPLE_SIGNING_IDENTITY.trim()}"`), 'The Developer ID Application certificate and private key are missing from the local keychain. In GitHub Actions, register APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD.');
  }
  return settings;
}

async function notarizeDmg(dmg, evidence, env) {
  const settings = await prerequisites(env);
  dmg = resolve(dmg); evidence = resolve(evidence);
  check(/\.dmg$/i.test(dmg) && (await lstat(dmg)).isFile(), 'Notarization input must be a regular signed DMG.');
  await mkdir(evidence, { recursive: false });
  const auth = settings.authentication === 'apple-id'
    ? ['--apple-id', env.APPLE_ID, '--password', env.APPLE_PASSWORD, '--team-id', settings.teamId]
    : ['--key', env.APPLE_API_KEY_PATH, '--key-id', env.APPLE_API_KEY, '--issuer', env.APPLE_API_ISSUER];
  const submission = await execute('/usr/bin/xcrun', ['notarytool', 'submit', dmg, ...auth, '--wait', '--timeout', '30m', '--output-format', 'json'], { timeout: 2100 });
  await writeFile(resolve(evidence, 'submission.json'), submission.text, { flag: 'wx' });
  await writeFile(resolve(evidence, 'submission.stderr.log'), submission.errorText, { flag: 'wx' });
  check(submission.exitCode === 0 && !submission.timedOut && !submission.launchError, 'DMG notarization failed; inspect the retained submission evidence. No release package is approved.');
  const result = JSON.parse(submission.text);
  if (result.status !== 'Accepted' && result.id) {
    const log = await execute('/usr/bin/xcrun', ['notarytool', 'log', result.id, ...auth]);
    await writeFile(resolve(evidence, 'apple-log.json'), log.text, { flag: 'wx' });
  }
  validateNotarization(result);
  for (const action of ['staple', 'validate']) {
    const ticket = await execute('/usr/bin/xcrun', ['stapler', action, dmg], { timeout: 120 });
    await writeFile(resolve(evidence, `${action}.log`), `${ticket.text}\n${ticket.errorText}`, { flag: 'wx' });
    check(ticket.exitCode === 0 && !ticket.timedOut && !ticket.launchError, `DMG ticket ${action} failed; this package must not be published.`);
  }
  console.log(JSON.stringify({ notarized: true, submissionId: result.id, dmg, evidence }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'check' && args.length === 0) {
      const settings = await prerequisites(process.env);
      console.log(`Developer ID release prerequisites configured for team ${settings.teamId}. Actual signing, notarization and Gatekeeper acceptance are checked after building.`);
    } else if (command === 'notarize' && args.length === 2) await notarizeDmg(args[0], args[1], process.env);
    else throw new Error(usage);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
