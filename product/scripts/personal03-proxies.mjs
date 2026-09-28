/** Local synthetic QA only. No credential/header logging; no product endpoint or mode. */
import { createServer, request as httpRequest } from 'node:http';
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function startPersonal03Proxies({ runtime, key, cap, appPort = 3128, webPort = 3127, captureSyntheticPrompt = false }) {
  const append = (file, value) => appendFileSync(resolve(runtime, file), JSON.stringify(value) + '\n');
  const listen = server => new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  let calls = 0, failures = 0, stopped = false;
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') { response.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    let payload;
    try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    const phase = payload.max_tokens === 120 ? 'rewrite' : payload.max_tokens === 100 ? 'classification' : 'generation';
    // One-shot fault injection is explicitly labelled, costs no upstream call.
    const fault = ['citation', 'unavailable'].find(kind => phase === 'generation' && existsSync(resolve(runtime, `${kind}.once`)));
    if (fault) {
      unlinkSync(resolve(runtime, `${fault}.once`));
      append('faults.jsonl', { phase, fault, actual_provider_call: false });
      response.writeHead(fault === 'citation' ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(fault === 'citation'
        ? { id: 'synthetic-fault', model: 'synthetic-citation-only', choices: [{ message: { content: '(근로기준법 제43조) (고용노동부 노동포털 「체불임금 해결 방법」)' }, finish_reason: 'stop' }] }
        : { error: { message: 'Synthetic local provider unavailable' } })); return;
    }
    if (stopped || calls >= cap) { append('cap-blocks.jsonl', { phase, calls }); response.writeHead(503).end('{}'); return; }
    const record = { call: ++calls, phase, started_at: new Date().toISOString(),
      prompt_sha256: createHash('sha256').update(JSON.stringify(payload.messages)).digest('hex'),
      temperature: payload.temperature, max_tokens: payload.max_tokens };
    append('attempts.jsonl', { call: calls, phase });
    if (captureSyntheticPrompt) record.messages = payload.messages;
    const began = performance.now();
    try {
      const upstream = await fetch('https://api.upstage.ai/v1/chat/completions', { method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(60000) });
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { data = {}; }
      Object.assign(record, { http_status: upstream.status, usage: data.usage ?? null, model: data.model ?? null,
        raw_answer: data.choices?.[0]?.message?.content ?? null, finish_reason: data.choices?.[0]?.finish_reason ?? null });
      failures = upstream.ok ? 0 : failures + 1;
      if ([401, 403, 429].includes(upstream.status) || failures >= 2) stopped = true;
      response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(raw);
    } catch {
      Object.assign(record, { http_status: null, usage: null, network_error: true });
      if (++failures >= 2) stopped = true;
      response.writeHead(502).end('{}');
    } finally { append('provider-calls.jsonl', { ...record, duration_ms: performance.now() - began }); }
  });
  await listen(provider);
  const web = createServer((request, response) => {
    const began = performance.now();
    const path = request.url?.split('?')[0];
    const upstream = httpRequest({ hostname: '127.0.0.1', port: appPort, path: request.url, method: request.method,
      headers: request.headers }, result => {
      response.writeHead(result.statusCode, result.headers);
      const chunks = [];
      result.on('data', chunk => { if (path === '/api/chat') chunks.push(chunk); });
      result.on('end', () => {
        if (path?.startsWith('/api/')) append('http.jsonl', { method: request.method, path, status: result.statusCode, duration_ms: performance.now() - began });
        if (path === '/api/chat') {
          try { append('chat-results.jsonl', { received_at: new Date().toISOString(), status: result.statusCode, response: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { append('chat-results.jsonl', { status: result.statusCode, parse_error: true }); }
        }
      });
      result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502).end(); });
    request.pipe(upstream);
  });
  try { await new Promise((done, reject) => { web.once('error', reject); web.listen(webPort, '127.0.0.1', done); }); }
  catch (error) { provider.close(); throw error; }
  return { providerUrl: `http://127.0.0.1:${provider.address().port}/chat/completions`,
    close: async () => { web.closeAllConnections(); provider.closeAllConnections(); await Promise.all([web, provider].map(server => new Promise(done => server.close(done)))); } };
}
