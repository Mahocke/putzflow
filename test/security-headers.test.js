const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('Antworten tragen die zentralen Browser-Sicherheitsheader', async (t) => {
  const port = 43191;
  const env = {
    ...process.env,
    PORT: String(port),
    APP_SECRET: 'test-secret-that-is-longer-than-thirty-two-characters',
    DB_FILE: '/tmp/putzflow-security-headers-test.sqlite',
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'same-origin');
      assert.match(response.headers.get('permissions-policy'), /microphone=\(\)/);
      assert.equal(response.headers.get('x-powered-by'), null);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.fail('Testserver ist nicht gestartet');
});
