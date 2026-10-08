import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('Windows Job Object test NOT_RUN on non-Windows OS.');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-windows-job-'));
  const dll = path.resolve(import.meta.dirname,
    'windows-job-supervisor/bin/Release/net8.0/WindowsJobSupervisor.dll');
  const parentScript = path.join(root, 'parent.js');
  const childScript = path.join(root, 'grandchild.js');
  const marker = path.join(root, 'heartbeat.txt');

  fs.writeFileSync(childScript, String.raw`
    const fs = require('node:fs');
    const marker = process.argv[2];
    setInterval(() => fs.writeFileSync(marker, String(Date.now())), 35);
  `, 'utf8');
  fs.writeFileSync(parentScript, String.raw`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[3], process.argv[2]], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
    if (process.argv[4] === 'normal') {
      setTimeout(() => process.exit(0), 700);
    } else {
      setInterval(() => {}, 200);
    }
  `, 'utf8');

  try {
    assert.ok(fs.existsSync(dll), 'Windows native Job supervisor must be built first.');
    for (const scenario of ['timeout', 'normal']) {
      fs.rmSync(marker, {force: true});
      const result = spawnSync('dotnet', [
        dll, scenario === 'timeout' ? '1500' : '3500', root,
        process.execPath, parentScript, marker, childScript, scenario
      ], { encoding: 'utf8', timeout: 15000 });
      assert.ifError(result.error);
      assert.equal(result.status, scenario === 'timeout' ? 124 : 0,
        'supervisor should exit on timeout or normal exit, but got: ' + result.stderr);
      assert.ok(fs.existsSync(marker), 'grandchild did not start');
      const first = fs.readFileSync(marker, 'utf8');
      await new Promise(r => setTimeout(r, 350));
      assert.equal(fs.readFileSync(marker, 'utf8'), first,
        'grandchild escaped Windows Job Object after ' + scenario);
    }
    console.log('Loop Engineering Windows native Job Object process tree tests passed.');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}
