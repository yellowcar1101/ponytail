const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('SessionStart keeps instructions when the optional map stalls or fails', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-map-timeout-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const hooks = path.join(temp, 'hooks');
  fs.mkdirSync(hooks);
  for (const file of ['ponytail-activate.js', 'ponytail-config.js', 'ponytail-runtime.js', 'ponytail-instructions.js']) {
    fs.copyFileSync(path.join(__dirname, '..', 'hooks', file), path.join(hooks, file));
  }
  const env = {
    ...process.env,
    PLUGIN_DATA: path.join(temp, 'data'),
    XDG_CONFIG_HOME: temp,
    PONYTAIL_DEFAULT_MODE: 'full',
  };
  for (const key of ['CLAUDE_PLUGIN_ROOT', 'COPILOT_PLUGIN_DATA', 'QODER_SESSION_ID', 'CURSOR_VERSION', 'CODEBUDDY_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR']) {
    delete env[key];
  }
  // Support both the old in-process call and the bounded subprocess, so the
  // stalled fixture reproduces the original five-second hook failure.
  for (const { body, enabled, expected } of [
    { body: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); return "late map";', enabled: '1', expected: false },
    { body: 'return "fast map";', enabled: '1', expected: true },
    { body: 'throw new Error("map unavailable");', enabled: '1', expected: false },
    { body: 'return "fast map";', enabled: '0', expected: false },
  ]) {
    fs.writeFileSync(path.join(hooks, 'ponytail-map.js'),
      `function buildMap() { ${body} }\nmodule.exports = { buildMap };\n` +
      'if (require.main === module) process.stdout.write(buildMap());\n');
    const result = spawnSync(process.execPath, [path.join(hooks, 'ponytail-activate.js')], {
      cwd: temp,
      env: { ...env, PONYTAIL_MAP: enabled },
      input: JSON.stringify({ source: 'startup', session_id: 'map-timeout-test' }),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, `startup exceeded the hook limit or failed: ${result.error || result.stderr}`);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.includes('PONYTAIL MODE ACTIVE — level: full'));
    assert.equal(context.includes('fast map'), expected);
    assert.ok(!context.includes('late map'));
    assert.equal(fs.readFileSync(path.join(env.PLUGIN_DATA, '.ponytail-active'), 'utf8'), 'full');
  }
});
