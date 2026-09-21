/** Disposable synthetic account only; reuses the verified follow-up 06 PG16. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
const container = 'mw-followup06-1789983829982-e8d9a9';
const base = 'http://127.0.0.1:3116';
const identity = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(identity.Config.Labels['moneyworry.acceptance'], 'followup06');
assert.equal(identity.State.Running, true);
assert.deepEqual(identity.HostConfig.PortBindings['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: '55436' }]);
function sql(query) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'mw_followup06_owner', '-d', 'mw_followup06'],
    { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
assert.equal(sql('SELECT current_database()'), 'mw_followup06');
assert.equal(sql("SELECT current_setting('server_version_num')::int / 10000"), '16');
let cookie = ''; let user; let phase = 'signup'; let trigger = false;
const request = async (path, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, data: await response.json() };
};
const pass = name => console.log(`FOLLOWUP07_HTTP ${name}=PASS`);
try {
  const email = `followup07-http-${randomBytes(8).toString('hex')}@example.invalid`;
  const password = randomBytes(12).toString('hex');
  const signup = await request('/api/auth/signup', { email, password, name: '후속7 장애 합성' });
  assert.equal(signup.status, 201); user = signup.data.user.user_id;
  assert.match(user, /^[0-9a-f-]{36}$/);
  phase = 'duplicate-first-request';
  const body = { request_id: randomUUID(), message: '내가 말한 급여일을 다시 알려줘.', chat_mode: 'wage' };
  const first = await request('/api/chat', body); assert.equal(first.data.conversation_persistence, 'saved');
  const id = first.data.conversation_id; assert.match(id, /^[0-9a-f-]{36}$/);
  if (process.argv.includes('--import-only')) {
    phase = 'concurrent-guest-import-retry';
    const importedBody = { import_id: randomUUID(), owner_user_id: randomUUID(), turns: [{ user_message: '합성 익명 회상 질문', company_id: null, response: first.data }] };
    const imported = await Promise.all([request('/api/conversations/import', importedBody), request('/api/conversations/import', importedBody)]);
    assert(imported.every(result => result.status === 200));
    assert.equal(imported[0].data.conversation_id, imported[1].data.conversation_id);
    const importedId = imported[0].data.conversation_id; assert.match(importedId, /^[0-9a-f-]{36}$/);
    const again = await request('/api/conversations/import', importedBody);
    assert.equal(again.data.reused, true);
    assert.equal((await request(`/api/conversations/${importedId}`)).data.turns.length, 1);
    assert.equal(sql(`SELECT owner_user_id FROM conversation_threads WHERE id='${importedId}'`), user);
    pass(phase);
  } else {
  const duplicates = await Promise.all([request('/api/chat', body), request('/api/chat', body)]);
  assert(duplicates.every(result => result.data.idempotent_replay === true && result.data.comparison_id === first.data.comparison_id));
  assert.equal((await request(`/api/conversations/${id}`)).data.turns.length, 1);
  pass(phase);
  phase = 'scoped-save-failure-save-only-retry';
  sql(`CREATE FUNCTION followup07_fail_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS (SELECT 1 FROM conversation_turns WHERE id=NEW.turn_id AND conversation_id='${id}') THEN
      RAISE EXCEPTION 'synthetic' USING ERRCODE='08006'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER followup07_fail_save BEFORE INSERT ON conversation_messages FOR EACH ROW EXECUTE FUNCTION followup07_fail_save();`);
  trigger = true;
  const retryBody = { ...body, request_id: randomUUID(), conversation_id: id };
  const failed = await request('/api/chat', retryBody);
  assert.equal(failed.data.conversation_persistence, 'unavailable');
  assert.equal((await request(`/api/conversations/${id}`)).data.turns.length, 1);
  sql('DROP TRIGGER followup07_fail_save ON conversation_messages; DROP FUNCTION followup07_fail_save();'); trigger = false;
  const retried = await request('/api/chat', retryBody);
  assert.equal(retried.data.conversation_persistence, 'saved');
  assert.equal(retried.data.comparison_id, failed.data.comparison_id);
  assert.equal((await request(`/api/conversations/${id}`)).data.turns.length, 2);
  pass(phase);
  phase = 'deleted-request-cannot-recreate';
  assert.equal((await request(`/api/conversations/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await request('/api/chat', { ...body, conversation_id: id })).status, 404);
  assert.equal(sql(`SELECT count(*) FROM conversation_threads WHERE id='${id}'`), '0');
  pass(phase);
  // No old test rows may be expired before running the shared maintenance entry point.
  phase = 'worker-restart-no-unrelated-expiry';
  assert.equal(sql('SELECT count(*) FROM conversation_threads WHERE expires_at <= now()'), '0');
  for (let run = 0; run < 2; run++) {
    const marker = '.runtime/followup07/worker'; assert(!existsSync(marker)); writeFileSync(marker, 'run');
    for (let n = 0; n < 60 && existsSync(marker); n++) await new Promise(done => setTimeout(done, 500));
    assert(!existsSync(marker));
    // Wait until the worker has had time to finish before asking for its restart.
    await new Promise(done => setTimeout(done, 3000));
  }
  pass('worker-restart-dispatched-check-parent-results');
  }
} catch (error) {
  console.log(`FOLLOWUP07_HTTP ${JSON.stringify({ phase, status: 'FAIL', code: error.code ?? 'ASSERTION' })}`);
  process.exitCode = 1;
} finally {
  if (trigger) sql('DROP TRIGGER followup07_fail_save ON conversation_messages; DROP FUNCTION followup07_fail_save();');
  // The identifier came from this run's signup; never delete other accounts/conversations.
  if (user) { sql(`DELETE FROM users WHERE id='${user}'`); pass('own-synthetic-user-cleanup'); }
}
