import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictBase64Decode } from '../src/core/base64.mjs';

test('decodes canonical padded base64', () => {
  const data = Buffer.from([0, 1, 2, 250, 251, 252]);
  const r = strictBase64Decode(data.toString('base64'));
  assert.deepEqual([...r.data], [...data]);
});

test('accepts data URL prefix and whitespace', () => {
  const data = Buffer.from('hello apng');
  const r = strictBase64Decode(`data:image/png;base64,\n${data.toString('base64')}\n`);
  assert.equal(r.data.toString(), 'hello apng');
});

test('reports the first illegal character offset', () => {
  const r = strictBase64Decode('AAA@AAAA');
  assert.equal(r.error.offset, 3);
  assert.equal(r.error.char, '@');
});

test('rejects misplaced padding and unpadded input', () => {
  assert.equal(strictBase64Decode('AA==BB').error.char, '=');
  assert.equal(strictBase64Decode('AAA').error.reason.includes('填充'), true);
});

test('rejects empty content', () => {
  assert.equal(strictBase64Decode('   ').error.reason, '空内容');
});

test('256 KiB boundary input is handled', () => {
  const text = Buffer.alloc(256 * 1024, 65).toString('base64'); // > 256KiB text, decodes fine
  const r = strictBase64Decode(text);
  assert.ok(r.data);
});
