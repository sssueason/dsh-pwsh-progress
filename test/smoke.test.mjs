/**
 * dsh-pwsh-progress — smoke test（纯函数单元测试）。
 *
 * 直接 import 宿主半边（模块无外部依赖），验证进度解析与命令规范化：
 * - parseProgress：N/M 与 NN% 解析、多行取最后、边界与无效输入；
 * - cmdKeyOf：数字归一、大小写、空白折叠、截断；
 * - pctOf / progressLabel：比例换算与展示标签。
 *
 * 运行：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmdKeyOf, parseProgress, pctOf, progressLabel } from '../index.js';

test('parseProgress: N/M ratio', () => {
  assert.deepEqual(parseProgress('step 5/30'), { kind: 'ratio', current: 5, total: 30 });
  assert.deepEqual(parseProgress('progress 443/1212'), { kind: 'ratio', current: 443, total: 1212 });
  assert.deepEqual(parseProgress(' 773 / 1212 '), { kind: 'ratio', current: 773, total: 1212 });
});

test('parseProgress: NN% percent', () => {
  assert.deepEqual(parseProgress('79%'), { kind: 'percent', pct: 0.79 });
  assert.deepEqual(parseProgress('done 100%'), { kind: 'percent', pct: 1 });
  assert.deepEqual(parseProgress('0%'), { kind: 'percent', pct: 0 });
  assert.deepEqual(parseProgress('64.5%'), { kind: 'percent', pct: 0.645 });
});

test('parseProgress: multi-line takes the last matching line', () => {
  assert.deepEqual(parseProgress('a 1/10\nb 9/10'), { kind: 'ratio', current: 9, total: 10 });
  assert.deepEqual(parseProgress('10%\n80%'), { kind: 'percent', pct: 0.8 });
});

test('parseProgress: ratio wins over percent within the same line', () => {
  assert.deepEqual(parseProgress('50% 3/4'), { kind: 'ratio', current: 3, total: 4 });
});

test('parseProgress: invalid ratios are skipped, percent fallback applies', () => {
  // current > total → not a progress ratio
  assert.deepEqual(parseProgress('5/3'), null);
  assert.deepEqual(parseProgress('5/3 50%'), { kind: 'percent', pct: 0.5 });
  // total === 0 → not a progress ratio
  assert.deepEqual(parseProgress('1/0'), null);
});

test('parseProgress: no progress → null', () => {
  assert.equal(parseProgress(''), null);
  assert.equal(parseProgress('no progress here'), null);
  assert.equal(parseProgress('2026/08/26 date'), null);
  assert.equal(parseProgress(null), null);
  assert.equal(parseProgress(undefined), null);
});

test('cmdKeyOf: normalizes digits, case and whitespace', () => {
  const key = cmdKeyOf('1..25 | ForEach-Object { Write-Output "step $_/25"; Start-Sleep -Seconds 1 }; Write-Output "COMPLETE-OK"');
  assert.ok(key.length > 0);
  assert.ok(!/\d/.test(key), 'digits must be normalized away');
  assert.ok(!/[A-Z]/.test(key), 'must be lowercased');
  assert.ok(!/\s{2,}/.test(key), 'whitespace must be folded');
  // Same command with different numbers collides to the same key
  assert.equal(
    cmdKeyOf('1..25 | ForEach-Object { Write-Output "step $_/25" }'),
    cmdKeyOf('1..250 | ForEach-Object { Write-Output "step $_/250" }'),
  );
  // Different commands produce different keys
  assert.notEqual(cmdKeyOf('1..25 sleep'), cmdKeyOf('Get-Process'));
});

test('pctOf: converts progress to 0..1', () => {
  assert.equal(pctOf({ kind: 'ratio', current: 5, total: 25 }), 0.2);
  assert.equal(pctOf({ kind: 'percent', pct: 0.79 }), 0.79);
  assert.equal(pctOf(null), null);
});

test('progressLabel: human labels', () => {
  assert.equal(progressLabel({ kind: 'ratio', current: 14, total: 25 }), '56%（14/25）');
  assert.equal(progressLabel({ kind: 'percent', pct: 0.79 }), '79%');
  assert.equal(progressLabel(null), null);
});
