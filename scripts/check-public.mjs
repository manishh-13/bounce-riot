import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const names = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bannedNames = /(^|\/)(\.env(?:\.|$)|credentials|deployment\.json|generated-template\.json|test-results|\.artifacts|node_modules)(\/|$)/;
const checks = [
  ['AWS access key', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ['local user path', /\/Users\/[a-zA-Z0-9_-]+\//],
  ['internal endpoint', /\b(?:w|wiki|quip|phonetool)\.amazon\.com\b/],
];
const failures = [];
for (const name of new Set(names)) {
  if (name === '.env.example' || name === 'scripts/check-public.mjs') continue;
  if (bannedNames.test(name)) failures.push(`${name}: private/generated path`);
  const path = join(root, name);
  if ((await stat(path)).size > 2_000_000 || /\.(png|woff2?|jpg|jpeg|webp|gif|ico)$/.test(name)) continue;
  const text = await readFile(path, 'utf8');
  for (const [label, pattern] of checks) if (pattern.test(text)) failures.push(`${name}: ${label}`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Public-source check passed for ${new Set(names).size} files. This is a heuristic check, not a security guarantee.`);
