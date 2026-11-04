// 纯函数单元测试（零外部依赖，不触 DB）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose } from '../src/llm.js';
import { cosine, chunkText } from '../src/knowledge.js';
import { checkTransition, maskName, nextActionsOf } from '../src/common.js';

test('parseJsonLoose: 干净 JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('[1,2,3]'), [1, 2, 3]);
});

test('parseJsonLoose: 乱码尾巴剥离（真实 bug 样本：JSON 后跟中文乱码 + echoJSON。）', () => {
  const raw = '{"action":"tool","tool":"patient_search","args":{"name":"陈芳"}}红尘客栈是否? echoJSON。';
  assert.deepEqual(parseJsonLoose(raw), { action: 'tool', tool: 'patient_search', args: { name: '陈芳' } });
});

test('parseJsonLoose: 字符串内的括号不干扰平衡扫描', () => {
  assert.deepEqual(parseJsonLoose('{"s":"a{b}c"} tail {"x":1}'), { s: 'a{b}c' });
  assert.deepEqual(parseJsonLoose('{"s":"quote\\"end"} junk'), { s: 'quote"end' });
});

test('parseJsonLoose: 纯乱码返回 null', () => {
  assert.equal(parseJsonLoose('红尘客栈'), null);
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose(null), null);
  assert.equal(parseJsonLoose('{"unclosed":1'), null); // 未闭合
});

test('cosine: 同向=1、垂直=0、维度不等=0、空=0', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([1, 0], [1]), 0);
  assert.equal(cosine([], []), 0);
});

test('chunkText: 按大小切分 + 重叠 + 标题捕获', () => {
  const chunks = chunkText('A'.repeat(50), 20, 5);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].content.length, 20);
  // 重叠：chunk2 开头与 chunk1 尾部重叠 5 字符
  assert.equal(chunks[1].content.slice(0, 5), chunks[0].content.slice(15));
});

test('chunkText: 标题行捕获', () => {
  const chunks = chunkText('# 第一章\n正文一', 100, 0);
  assert.equal(chunks[0].heading, '第一章');
  assert.equal(chunks[0].content, '正文一');
});

test('checkTransition: 状态机白名单', () => {
  checkTransition('DRAFT', 'REVIEW');
  checkTransition('REVIEW', 'PUBLISHED');
  checkTransition('DEPRECATED', 'DRAFT'); // 废弃后可重新起草
  assert.throws(() => checkTransition('DRAFT', 'PUBLISHED'), /非法状态流转/);
  assert.throws(() => checkTransition('PUBLISHED', 'DRAFT'), /非法状态流转/);
});

test('checkTransition: 每个状态的可选后继与 nextActionsOf 对齐', () => {
  for (const st of ['DRAFT', 'REVIEW', 'PUBLISHED', 'DEPRECATED']) {
    assert.ok(Array.isArray(nextActionsOf(st)));
  }
});

test('maskName: 中文姓名保留首尾、短名退化', () => {
  assert.equal(maskName('张三'), '张*');
  assert.equal(maskName('张小样'), '张*样');
  assert.equal(maskName('李'), '*');
  assert.equal(maskName(''), '*');
});
