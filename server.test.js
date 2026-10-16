const assert = require('node:assert/strict');
const test = require('node:test');
const { extractOutputText, parseAnalysisResponse, isJsonModeUnsupported, validateAnalysis } = require('./server');

test('extracts text from Responses API output items', () => {
  assert.equal(extractOutputText({
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"category":"衬衫"}' }] }]
  }), '{"category":"衬衫"}');
});

test('accepts compatible chat completion text responses', () => {
  assert.equal(extractOutputText({
    choices: [{ message: { content: '{"category":"衬衫"}' } }]
  }), '{"category":"衬衫"}');
});

test('parses fenced JSON with surrounding commentary', () => {
  assert.deepEqual(parseAnalysisResponse({
    output_text: '```json\n{"category":"衬衫","style":"简洁"}\n```'
  }), { category: '衬衫', style: '简洁' });
});

test('explains incomplete JSON instead of leaking a parse exception', () => {
  assert.throws(
    () => parseAnalysisResponse({ output_text: '{"category":"衬衫",' }),
    /JSON 不完整/
  );
});

test('explains empty model output', () => {
  assert.throws(() => parseAnalysisResponse({ output: [] }), /没有返回可识别的分析文本/);
});

test('explains an incomplete Responses API result', () => {
  assert.throws(
    () => parseAnalysisResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    /达到长度上限/
  );
});

test('detects a relay that rejects JSON mode', () => {
  assert.equal(isJsonModeUnsupported({ error: { message: "Unsupported parameter: 'text.format'" } }), true);
  assert.equal(isJsonModeUnsupported({ error: { message: 'invalid image format' } }), false);
});

test('preserves a deliberate positive photo reaction without inventing a risk', () => {
  const analysis = validateAnalysis({
    reaction: 'delighted',
    strengths: ['颜色协调，外套轮廓利落'],
    risks: []
  });

  assert.equal(analysis.reaction, 'delighted');
  assert.deepEqual(analysis.risks, []);
});

test('falls back to a thoughtful photo reaction for unsupported values', () => {
  const analysis = validateAnalysis({ reaction: 'surprised', risks: [] });

  assert.equal(analysis.reaction, 'thoughtful');
  assert.deepEqual(analysis.risks, []);
});
