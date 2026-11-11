import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createApp, formatMixedModeWarning } from '../src/app.js';
import { MockDreamProvider } from '../src/providers/mock_provider.js';
import { MockDreamArchitect, OpenAICompatibleArchitect } from '../src/architect/index.js';
import { CreditLedger } from '../src/billing/credit_ledger.js';

describe('/api/health Architect Telemetry & Mixed-Mode Warning', () => {
  const SERVER_ROOT = path.resolve(__dirname, '..');
  const FIXTURES_DIR = path.join(SERVER_ROOT, 'fixtures');
  const originalStorageDir = process.env.STORAGE_DIR;
  let tempStorageDir: string;

  beforeEach(() => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-health-test-'));
    process.env.STORAGE_DIR = tempStorageDir;
  });

  afterEach(() => {
    if (originalStorageDir === undefined) {
      delete process.env.STORAGE_DIR;
    } else {
      process.env.STORAGE_DIR = originalStorageDir;
    }
    fs.rmSync(tempStorageDir, { recursive: true, force: true });
  });

  it('should include mock architect provider, isMock=true, and model=null in /api/health', async () => {
    const architect = new MockDreamArchitect();
    const provider = new MockDreamProvider(
      'http://127.0.0.1:5000',
      path.join(tempStorageDir, 'videos'),
      path.join(tempStorageDir, 'keyframes'),
      FIXTURES_DIR,
      architect
    );

    const { app } = createApp({
      dreamProvider: provider,
      dreamArchitect: architect,
      creditLedger: new CreditLedger({ usr_demo_101: { credits: 10, reservedCredits: 0 } }),
      queueDriver: 'memory'
    });

    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.architect).toEqual({
      provider: architect.name,
      model: null,
      isMock: true
    });
  });

  it('should include OpenAI-compatible architect provider, configured model, and isMock=false in /api/health', async () => {
    const architect = new OpenAICompatibleArchitect(
      'http://127.0.0.1:1234/v1',
      'qwen2.5-3b-instruct',
      'lm-studio',
      60000
    );
    const provider = new MockDreamProvider(
      'http://127.0.0.1:5000',
      path.join(tempStorageDir, 'videos'),
      path.join(tempStorageDir, 'keyframes'),
      FIXTURES_DIR,
      architect
    );

    const { app } = createApp({
      dreamProvider: provider,
      dreamArchitect: architect,
      creditLedger: new CreditLedger({ usr_demo_101: { credits: 10, reservedCredits: 0 } }),
      queueDriver: 'memory'
    });

    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.architect).toEqual({
      provider: architect.name,
      model: 'qwen2.5-3b-instruct',
      isMock: false
    });
  });

  it('should emit an explicit warning ONLY when Comfy GPU provider (isMock=false) is paired with Mock Architect (isMock=true)', () => {
    const mismatch = formatMixedModeWarning({ isMock: false }, { isMock: true });
    expect(mismatch).not.toBeNull();
    expect(mismatch).toContain('DREAM_PROVIDER=comfy + ARCHITECT_PROVIDER=mock');
    expect(mismatch).toContain('ARCHITECT_PROVIDER=openai_compat');

    expect(formatMixedModeWarning({ isMock: false }, { isMock: false })).toBeNull();
    expect(formatMixedModeWarning({ isMock: true }, { isMock: true })).toBeNull();
    expect(formatMixedModeWarning({ isMock: true }, { isMock: false })).toBeNull();
  });
});

