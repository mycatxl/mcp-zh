/**
 * Can the deploy script pick up CLOUDFLARE_API_TOKEN when it is set as a
 * user-level environment variable?
 *
 * Why this matters: wrangler accepts CLOUDFLARE_API_TOKEN as an alternative to
 * the interactive OAuth login. PI-Desktop's tool calls inherit the environment
 * block from when the app was started, so a variable set afterwards is NOT
 * visible via process.env — but it IS readable from HKCU\Environment on Windows.
 * This proves the read + injection path works, so a deployment can be driven
 * without an interactive browser round-trip.
 *
 *   node test/env-token.js
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
  }
}

const PROBE = 'PI_ENV_PROBE_TOKEN';

/** The exact read the deploy script would perform. */
export function readUserEnv(name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: 'utf8', timeout: 20000 },
    );
    const v = out.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

function writeUserEnv(name, value) {
  const script = value === null
    ? `[Environment]::SetEnvironmentVariable('${name}',$null,'User')`
    : `[Environment]::SetEnvironmentVariable('${name}','${value}','User')`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
  });
}

console.log('1) reading a user-level environment variable from the registry');
const TOKEN_SHAPE = 'probe-abc123-XYZ_9876543210';
writeUserEnv(PROBE, TOKEN_SHAPE);

const readBack = readUserEnv(PROBE);
check('value round-trips through the registry', readBack === TOKEN_SHAPE, readBack ? `${readBack.slice(0, 12)}…` : 'null');
check('process.env does NOT see it (expected on a long-running app)', process.env[PROBE] === undefined);

console.log('\n2) injecting it into a child process');
{
  const res = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(String(process.env.${PROBE} ?? 'MISSING'))`],
    { encoding: 'utf8', env: { ...process.env, [PROBE]: readBack } },
  );
  check('child process receives the injected value', res.stdout === TOKEN_SHAPE, res.stdout);
}
{
  // Without the injection the child must not see it — proving the injection is
  // what makes it work, not some ambient inheritance.
  const res = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(String(process.env.${PROBE} ?? 'MISSING'))`],
    { encoding: 'utf8', env: { ...process.env } },
  );
  check('child without injection sees nothing', res.stdout === 'MISSING', res.stdout);
}

console.log('\n3) does wrangler itself honour CLOUDFLARE_API_TOKEN?');
{
  // Run wrangler with a bogus token. The observable difference that proves the
  // variable is honoured: wrangler must NOT say "not authenticated / please run
  // wrangler login" — it must go straight to validating the token against the
  // API and fail there instead.
  //
  // The real output for a malformed token is:
  //   A request to the Cloudflare API (/user/tokens/verify) failed.
  //   Invalid request headers [code: 6003]
  //   - Invalid format for Authorization header [code: 6111]
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const res = spawnSync(process.execPath, [bin, 'whoami'], {
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: 'bogus-token-for-probing', WRANGLER_SEND_METRICS: 'false' },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

  const demandsLogin = /not authenticated|Please run .?wrangler login/i.test(out);
  check(
    'wrangler does NOT demand an interactive login when a token is present',
    !demandsLogin,
    demandsLogin ? 'still demanded login' : 'token path taken',
  );

  const validatedToken = /tokens\/verify|Authorization header|Authentication error|Invalid API Token|code: 6\d{3}/i.test(out);
  const evidence = (out.match(/tokens\/verify|code: 6\d{3}/i) ?? [''])[0];
  check('wrangler validates the token against the API instead', validatedToken, evidence);
}

console.log('\n4) cleanup');
writeUserEnv(PROBE, null);
check('probe variable removed', readUserEnv(PROBE) === null);

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
