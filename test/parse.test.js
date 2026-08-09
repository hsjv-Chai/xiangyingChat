'use strict';

const assert = require('assert');
const { parseFile, scanFolder } = require('../src/parser');

const MAIN_FILE = '/Users/hsjv/Documents/响应导出/高三15班语文.html';
const FOLDER = '/Users/hsjv/Documents/响应导出';

// 1. 主文件解析正确性
const msgs = parseFile(MAIN_FILE);
assert.strictEqual(msgs.length, 553, '消息总数应为 553');

const types = {};
for (const m of msgs) types[m.type] = (types[m.type] || 0) + 1;
assert.deepStrictEqual(types, { GROUP_TEXT: 378, GROUP_IMAGE: 174, GROUP_NOTE: 1 }, '消息类型分布');

assert.strictEqual(msgs[0].datetime, '2026-06-10 12:42:15', '第一条应为最新消息');
assert.strictEqual(msgs[msgs.length - 1].datetime, '2024-08-26 09:02:10', '最后一条应为最早消息');
assert.strictEqual(msgs[0].fromName, '邱明峰');

// 2. 图片本地命中
const imgs = msgs.filter((m) => m.image);
assert.strictEqual(imgs.length, 175, '图片消息应为 175 条');
assert.ok(imgs.every((m) => m.image.localPath), '所有图片都应命中本地文件');
assert.ok(imgs.every((m) => m.image.src.startsWith('localimg://local/')), '本地图片走 localimg 协议');

// 3. 引用消息
const quoted = msgs.filter((m) => m.quote);
assert.strictEqual(quoted.length, 1, '应有一条引用消息');
assert.ok(quoted[0].quote.content, '引用应包含被引内容');

// 4. 文件夹扫描
const { summaries, errors } = scanFolder(FOLDER, new Map());
assert.ok(summaries.length >= 49, '应扫描出全部会话（49 个），实际 ' + summaries.length);
assert.strictEqual(errors.length, 0, '不应有解析失败文件');
for (let i = 1; i < summaries.length; i++) {
  assert.ok(summaries[i - 1].lastTime >= summaries[i].lastTime, '会话应按最近活跃倒序');
}
const target = summaries.find((s) => s.title === '高三15班语文');
assert.ok(target, '应包含高三15班语文');
assert.strictEqual(target.msgCount, 553);

// 5. 单聊与语音
const single = parseFile(FOLDER + '/吴亦巨.html');
assert.ok(single.some((m) => m.type.startsWith('SINGLE_')), '单聊消息类型存在');
assert.strictEqual(new Set(single.map((m) => m.fromName)).size, 2, '单聊包含两个发送者');

const audioFile = parseFile(FOLDER + '/23通用选考群.html');
assert.ok(audioFile.some((m) => m.audio), '应包含语音消息');

// 6. 异常输入不崩溃
assert.throws(() => parseFile('/dev/null'), /未找到消息数据/);

console.log('ALL TESTS PASSED');
