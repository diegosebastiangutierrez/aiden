const fs = require('node:fs');

const requestFd = Number(process.env.AIDEN_PRODUCT_HOST_REQUEST_FD);
const responseFd = Number(process.env.AIDEN_PRODUCT_HOST_RESPONSE_FD);
const token = process.env.AIDEN_PRODUCT_HOST_TOKEN;
let sequence = 0;
function call(method, params) {
  const id = `fixture-${++sequence}`;
  fs.writeSync(requestFd, JSON.stringify({ version: 1, token, id, method, params }) + '\n');
  let text = '';
  const byte = Buffer.alloc(1);
  while (!text.endsWith('\n')) { if (fs.readSync(responseFd, byte, 0, 1, null) !== 1) throw new Error('authority pipe closed'); text += byte.toString(); }
  const response = JSON.parse(text);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
const admission = call('admit', { subjectId: 'fixture-subject', workspaceId: 'fixture-workspace', sourceArtifactId: 'fixture-artifact',
  sourceArtifactDigest: 'c'.repeat(64), sourceTaskId: 'fixture-task', sourceGeneration: 1,
  idempotencyKey: 'fixture-admission', goal: 'Review fixture output', title: 'Review fixture output' });
const acquired = call('acquire', admission);
call('release', { binding: acquired, reason: 'waiting_for_fixture_review' });
const publication = process.env.AIDEN_FIXTURE_PUBLICATION === '1' ? call('authorizePublication', {
  binding: admission,
  intentId: 'intent-fixture',
  intentDigest: 'd'.repeat(64),
  artifactId: 'artifact-fixture',
  artifactSha256: 'e'.repeat(64),
  accountId: 'account-fixture',
  targetId: 'target-fixture',
}) : null;
const access = process.env.AIDEN_FIXTURE_ACCESS === '1' ? call('accessMode', {}) : null;
const attempt = call('getAttempt', { attemptId: acquired.attemptId });
process.stdout.write(JSON.stringify({ admission, attempt, publication, access }));
