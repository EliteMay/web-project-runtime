import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessCandidateDiff, createPilotVerifier } from './pilot-verifier.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-safety-pilot-'));
function git(...args) {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error('git failure: ' + args.join(' ') + ': ' + run.stderr);
  return run.stdout.trim();
}
function write(name, contents) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), contents);
}
const protectedSource = 'export const keep = true;\n';
const expectedNames = ['static validation', 'behavior acceptance', 'task deterministic test'];
const validationPolicy = { verification: { requiredChecks: expectedNames.slice(0, 2) } };
const goodVerifier = createPilotVerifier({
  allowedPaths: ['src/core.js'],
  protectedPaths: ['tests/', '.github/', 'README.md'],
  maxChangedFiles: 1, maxDiffLines: 100,
  runAcceptance: async () => {
    // A protected acceptance oracle validates behavior and baseline feature
    // independently of the candidate's own test runner and assertions.
    const source = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
    if (!source.includes('a+b') || fs.readFileSync(path.join(root, 'src/keep.js'), 'utf8') !== protectedSource) {
      return [{ name: 'behavior acceptance', status: 'fail', evidence: 'old behavior broken' }];
    }
    return expectedNames.map(name => ({name, status: 'pass', evidence: 'external-fixture:' + name}));
  }
});
let base;
const context = candidateCommit => ({
  worktreeDir: root, baseCommit: base, candidateCommit,
  requiredRequirements: ['task deterministic test'], policy: validationPolicy
});
function candidate(change) {
  git('reset', '--hard', base);
  git('clean', '-fd');
  change();
  git('add', '-A');
  git('commit', '-m', 'candidate');
  return git('rev-parse', 'HEAD');
}
try {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Safety Fixture');
  git('config', 'user.email', 'safety@example.invalid');
  write('src/core.js', 'export const add=(a,b)=>a-b;\n');
  write('src/keep.js', protectedSource);
  write('tests/acceptance/held-out.js', '// trusted held-out fixture\n');
  write('README.md', 'Baseline contract\n');
  git('add', '-A');
  git('commit', '-m', 'baseline');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'candidate');

  let head = candidate(() => write('src/core.js', 'export const add=(a,b)=>a+b;\n'));
  let result = await goodVerifier(context(head));
  assert.equal(result.status, 'pass');
  assert.equal(result.checks.every(x => x.status === 'pass'), true);
  assert.equal(result.satisfiedRequirements.length, 1);

  head = candidate(() => write('src/core.js', 'export const add=(a,b)=>42;\n'));
  result = await goodVerifier(context(head));
  assert.equal(result.status, 'fail'); // App tests may lie; held-out behavior fails.

  head = candidate(() => write('README.md', 'Removed previous feature\n'));
  result = await goodVerifier(context(head));
  assert.equal(result.status, 'fail'); // Unrelated docs change forbidden.

  head = candidate(() => fs.rmSync(path.join(root, 'src/core.js')));
  result = await goodVerifier(context(head));
  assert.equal(result.status, 'fail'); // Delete existing code for fake success rejected.
  assert.equal(result.checks.some(x => x.name === 'guard/no-delete' && x.status === 'fail'), true);

  head = candidate(() => write('tests/acceptance/held-out.js', '/* skip tests */\n'));
  result = await goodVerifier(context(head));
  assert.equal(result.status, 'fail'); // Worker cannot edit its acceptance tests.

  head = candidate(() => write('src/core.js', 'x'.repeat(500) + '\n'));
  result = await goodVerifier(context(head));
  assert.equal(result.status, 'fail'); // Diff budget exceeded.

  head = candidate(() => write('src/core.js', Buffer.from([0, 255, 14, 1, 20])));
  result = await goodVerifier(context(head));
  assert.equal(result.status, 'fail'); // Binary file is denied.

  head = candidate(() => write('src/core.js', 'export const add=(a,b)=>a+b;\n'));
  const lyingVerifier = createPilotVerifier({
    allowedPaths: ['src/core.js'],
    runAcceptance: async () => [{ name: 'fake-check', status: 'pass', evidence: 'self-report' }]
  });
  result = await lyingVerifier(context(head));
  assert.equal(result.status, 'fail'); // Cannot rename, omit, or invent required checks.

  const noEvidence = createPilotVerifier({
    allowedPaths: ['src/core.js'],
    runAcceptance: async () => expectedNames.map(name => ({ name, status: 'pass', evidence: '' }))
  });
  assert.equal((await noEvidence(context(head))).status, 'fail');

  const brokenVerifier = createPilotVerifier({
    allowedPaths: ['src/core.js'],
    runAcceptance: async () => { throw new Error('offline'); }
  });
  assert.equal((await brokenVerifier(context(head))).status, 'uncertain');

  assert.throws(() => assessCandidateDiff({
    ...context(head), allowedPaths: ['**'], maxChangedFiles: 1
  }), /PILOT_INVALID_OPERATOR_SCOPE/);

  assert.equal(git('rev-parse', 'main'), base); // No main mutation.
  assert.equal(git('status', '--porcelain'), '');
  console.log('Loop Engineering adversarial safety pilot tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
