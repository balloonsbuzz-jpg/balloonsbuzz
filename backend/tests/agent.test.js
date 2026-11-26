const { pool, signedIn } = require('./helpers');
const { decrypt } = require('../src/lib/crypto');

afterAll(() => pool.end());

const PROMPT_V2 = 'You are the BalloonsBuzz assistant. Keep replies short and sweet. (test v2)';

describe('AI agent config', () => {
  let owner;
  beforeAll(async () => { owner = await signedIn('owner'); });

  test('inbox agents cannot see or change AI settings; admins can', async () => {
    const agent = await signedIn('agent');
    expect((await agent.get('/api/agent/config')).status).toBe(403);
    expect((await agent.patch('/api/agent/config', { version: 1, temperature: 0.2 })).status).toBe(403);
    const admin = await signedIn('admin');
    const res = await admin.get('/api/agent/config');
    expect(res.status).toBe(200);
    expect(res.body.config.provider).toBe('deepseek');
  });

  test('the config never exposes the stored key; env key is reported as the source', async () => {
    const res = await owner.get('/api/agent/config');
    expect(res.body.config).not.toHaveProperty('api_key_enc');
    expect(res.body.config.api_key_source).toBe('env');
    expect(res.body.config.env_key_name).toBe('DEEPSEEK_API_KEY');
  });

  test('editing the prompt creates a version; history keeps the original; stale saves get 409', async () => {
    const start = (await owner.get('/api/agent/config')).body.config;
    const res = await owner.patch('/api/agent/config', { version: start.version, system_prompt: PROMPT_V2, change_note: 'first edit' });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ system_prompt: PROMPT_V2, version: start.version + 1 });

    const versions = (await owner.get('/api/agent/config/versions')).body.versions;
    expect(versions.map((v) => v.version)).toEqual([start.version + 1, start.version]);
    expect(versions[0]).toMatchObject({ change_note: 'first edit', created_by_name: 'Test owner' });

    const stale = await owner.patch('/api/agent/config', { version: start.version, temperature: 0.3 });
    expect(stale.status).toBe(409);
    expect(stale.body.details.current_version).toBe(start.version + 1);
  });

  test('restoring an old version brings the prompt back as a NEW version', async () => {
    const cur = (await owner.get('/api/agent/config')).body.config;
    const original = (await owner.get(`/api/agent/config/versions/${cur.version - 1}`)).body.version.snapshot.system_prompt;
    const res = await owner.post(`/api/agent/config/versions/${cur.version - 1}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.config.system_prompt).toBe(original);
    expect(res.body.config.version).toBe(cur.version + 1);
  });

  test('invalid settings are rejected with field details', async () => {
    const cur = (await owner.get('/api/agent/config')).body.config;
    const res = await owner.patch('/api/agent/config', { version: cur.version, temperature: 3, provider: 'acme' });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['provider', 'temperature']);
    const delay = await owner.patch('/api/agent/config', { version: cur.version, response_delay_min_ms: 5000, response_delay_max_ms: 1000 });
    expect(delay.status).toBe(400);
  });

  test('a key saved from the UI is stored encrypted, shown as last 4 only, and can be cleared', async () => {
    const res = await owner.put('/api/agent/config/api-key', { api_key: 'sk-live-abcdef123456WXYZ' });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ api_key_source: 'ui', api_key_last4: 'WXYZ' });
    expect(JSON.stringify(res.body)).not.toContain('abcdef123456');

    const { rows } = await pool.query(`SELECT api_key_enc FROM ai_agent_config`);
    expect(rows[0].api_key_enc).not.toContain('sk-live');
    expect(decrypt(rows[0].api_key_enc)).toBe('sk-live-abcdef123456WXYZ');

    const audit = await pool.query(`SELECT after FROM audit_log WHERE action = 'ai_agent_config.set_api_key'`);
    expect(JSON.stringify(audit.rows)).not.toContain('abcdef123456');

    const cleared = await owner.del('/api/agent/config/api-key');
    expect(cleared.body.config).toMatchObject({ api_key_source: 'env', api_key_last4: null });
  });

  test('prompt edits are audited without copying the whole prompt', async () => {
    const { rows } = await pool.query(
      `SELECT before, after FROM audit_log WHERE action = 'ai_agent_config.update' AND after ? 'system_prompt' LIMIT 1`);
    expect(rows[0].after.system_prompt).toMatch(/^\[v\d+, \d+ chars\]$/);
  });
});

describe('AI tools', () => {
  let owner;
  beforeAll(async () => { owner = await signedIn('owner'); });

  test('lists the 10 tools with their editable fields', async () => {
    const res = await owner.get('/api/agent/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(10);
    expect(res.body.tools[0]).toMatchObject({ name: 'get_pricing', is_required: true, is_customised: false });
  });

  test('required safety tools cannot be switched off; optional ones can', async () => {
    const bad = await owner.patch('/api/agent/tools/handover_to_human', { is_enabled: false });
    expect(bad.status).toBe(400);
    const ok = await owner.patch('/api/agent/tools/schedule_followup', { is_enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.body.tool.is_enabled).toBe(false);
  });

  test('descriptions are editable and can be reset to default', async () => {
    const edited = await owner.patch('/api/agent/tools/send_photos', { description: 'Send up to 4 photos of matching designs with prices.' });
    expect(edited.body.tool.is_customised).toBe(true);
    const reset = await owner.post('/api/agent/tools/send_photos/reset');
    expect(reset.body.tool.is_customised).toBe(false);
  });

  test('tool settings are validated against the code schema and merged', async () => {
    const bad = await owner.patch('/api/agent/tools/send_photos', { config: { default_count: 6 } });
    expect(bad.status).toBe(400);
    const wrongKey = await owner.patch('/api/agent/tools/send_photos', { config: { colour: 'pink' } });
    expect(wrongKey.status).toBe(400);
    const ok = await owner.patch('/api/agent/tools/send_photos', { config: { default_count: 2 } });
    expect(ok.status).toBe(200);
    expect(ok.body.tool.config).toMatchObject({ default_count: 2, max_count: 5, spread_across_packages: true });
  });

  test('agents cannot edit tools', async () => {
    const agent = await signedIn('agent');
    expect((await agent.patch('/api/agent/tools/send_photos', { is_enabled: false })).status).toBe(403);
  });
});
