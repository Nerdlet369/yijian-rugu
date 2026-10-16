const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

loadEnvFile();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8081);
const MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-6.1-sol';
const API_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
const WEB_ROOT = path.join(__dirname, 'prototype');
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const VISION_TIMEOUT_MS = 60000;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('图片过大，请选择小于 8 MB 的图片。'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('请求内容不是有效的 JSON。'), { statusCode: 400 })); }
    });
    request.on('error', reject);
  });
}

function extractOutputText(responseData) {
  if (typeof responseData?.output_text === 'string' && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }

  const fragments = [];
  for (const item of Array.isArray(responseData?.output) ? responseData.output : []) {
    if (typeof item?.text === 'string') fragments.push(item.text);
    if (typeof item?.content === 'string') fragments.push(item.content);
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string') {
        fragments.push(part.text);
      }
    }
  }

  if (!fragments.length && Array.isArray(responseData?.choices)) {
    const content = responseData.choices[0]?.message?.content;
    if (typeof content === 'string') fragments.push(content);
    if (Array.isArray(content)) {
      fragments.push(...content.map(part => part?.text).filter(text => typeof text === 'string'));
    }
  }

  return fragments.join('\n').trim();
}

function extractRefusal(responseData) {
  for (const item of Array.isArray(responseData?.output) ? responseData.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      if (part?.type === 'refusal' && typeof part.text === 'string') return part.text;
    }
  }
  return typeof responseData?.refusal === 'string' ? responseData.refusal : '';
}

function parseAnalysisResponse(responseData) {
  if (responseData?.status === 'incomplete') {
    const reason = responseData.incomplete_details?.reason;
    const detail = reason === 'max_output_tokens'
      ? '模型输出达到长度上限'
      : reason === 'content_filter'
        ? '模型输出被内容过滤中止'
        : '模型没有完成本次分析';
    throw new Error(`${detail}，请重试；若反复出现，请检查模型中转站的 Responses API 兼容性。`);
  }

  if (extractRefusal(responseData)) {
    throw new Error('视觉模型拒绝分析这张图片。请换一张主要展示衣物的清晰照片后重试。');
  }

  const outputText = extractOutputText(responseData);
  if (!outputText) {
    throw new Error('视觉模型没有返回可识别的分析文本。请重试；若反复出现，请检查模型中转站是否支持 Responses API 视觉输出。');
  }

  const fenced = outputText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const source = (fenced ? fenced[1] : outputText).trim();
  const start = source.indexOf('{');
  if (start < 0) {
    throw new Error('视觉模型返回的内容不是 JSON 格式。请重试；若反复出现，请检查模型中转站的结构化输出兼容性。');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      end = index;
      break;
    }
  }

  if (end < 0) {
    throw new Error('视觉模型返回的 JSON 不完整，可能被中转站截断。请重试；若反复出现，请检查模型中转站的 Responses API 兼容性。');
  }

  let parsed;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new Error('视觉模型返回的 JSON 格式无效。请重试；若反复出现，请检查模型中转站的结构化输出兼容性。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('视觉模型没有返回 JSON 对象，请重试。');
  }
  return parsed;
}

function isJsonModeUnsupported(responseData) {
  const message = String(responseData?.error?.message || responseData?.message || '');
  return /(?:unsupported|not supported|unrecognized|unknown|invalid)[^\n]{0,100}(?:text(?:\.format)?|json_object)|(?:text(?:\.format)?|json_object)[^\n]{0,100}(?:unsupported|not supported|unrecognized|unknown|invalid)|不支持[^\n]{0,60}(?:text|json_object)/i.test(message);
}

function createVisionRequestBody(image, jsonMode) {
  const body = {
    model: MODEL,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '你是友善、审慎、像朋友一样真诚的面试穿搭顾问。只分析照片中实际可见的衣物和穿搭信息，不要猜测人物身份、性别、身体尺寸、品牌、价格或图片外信息。请结合产品经理面试场景给出完整但简洁的建议，注意照片角度、光线、遮挡造成的不确定性。只返回 JSON 对象，不要 Markdown 或额外解释。字段必须为：category（衣物类别字符串）；colors（可见颜色字符串数组，最多5项）；style（款式、版型、领口或面料等可见特征，1-2句）；strengths（这套穿搭的优点数组，1-3项）；risks（确实可见、会影响场合适配或值得调整的问题数组；没有明确问题时返回空数组，不要把“照片信息不足”伪装成穿搭缺点）；reaction（只能是 delighted 或 thoughtful。delighted 仅用于照片里有明确、具体且值得真心称赞的穿搭亮点；thoughtful 用于需要权衡、存在可见调整项或照片信息不足的情况，不要为了活泼而强行惊叹）；interview_fit（是否适合产品经理面试、适合哪种正式程度，2-3句）；advice（可执行的改进建议，包括可替换单品，2-4句）；pairing（下装、鞋子、外套或配饰的搭配建议，2-3句）；occasions（适合的场合数组，1-3项）；caveats（仅说明照片无法判断的内容和判断局限，1-2句）。中文输出，总体控制在约250-450字。'
        },
        { type: 'input_image', image_url: image, detail: 'low' }
      ]
    }]
  };
  if (jsonMode) body.text = { format: { type: 'json_object' } };
  body.max_output_tokens = 1200;
  return body;
}

async function requestVisionModel(image) {
  const request = async jsonMode => {
    const apiResponse = await fetch(`${API_BASE_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createVisionRequestBody(image, jsonMode)),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS)
    });
    const payload = await apiResponse.json().catch(() => ({}));
    return { apiResponse, payload };
  };

  const firstAttempt = await request(true);
  if (!firstAttempt.apiResponse.ok && isJsonModeUnsupported(firstAttempt.payload)) {
    console.warn('[vision] JSON mode is not supported by the endpoint; retrying with prompt-only JSON output.');
    return request(false);
  }
  return firstAttempt;
}

function validateAnalysis(value) {
  if (!value || typeof value !== 'object') throw new Error('模型没有返回结构化分析结果。');
  const list = (candidate, fallback) => {
    const values = Array.isArray(candidate) ? candidate : [];
    return values.map(item => String(item).trim()).filter(Boolean).slice(0, 4).length
      ? values.map(item => String(item).trim()).filter(Boolean).slice(0, 4)
      : fallback;
  };
  const analysis = {
    category: String(value.category || '无法确定'),
    colors: Array.isArray(value.colors) ? value.colors.map(String).slice(0, 5) : [],
    style: String(value.style || '无法确定'),
    strengths: list(value.strengths, ['暂未观察到明确优势']),
    risks: list(value.risks, []),
    reaction: value.reaction === 'delighted' ? 'delighted' : 'thoughtful',
    interview_fit: String(value.interview_fit || '需要结合具体面试场景判断。'),
    advice: String(value.advice || '建议结合试穿效果和面试场景判断。'),
    pairing: String(value.pairing || '建议搭配简洁、整洁的下装和鞋子。'),
    occasions: list(value.occasions, ['适合场合需要结合完整穿搭判断']),
    caveats: String(value.caveats || '照片可能受光线、角度和遮挡影响。')
  };
  for (const text of Object.values(analysis)) {
    if (Array.isArray(text)) {
      if (text.some(item => item.length > 180)) throw new Error('模型分析列表项超出允许长度。');
    } else if (text.length > 700) {
      throw new Error('模型分析字段超出允许长度。');
    }
  }
  return analysis;
}

async function analyzePhoto(request, response) {
  if (!process.env.OPENAI_API_KEY) {
    return sendJson(response, 503, { error: '视觉模型服务未配置：请在项目根目录 .env 中设置 OPENAI_API_KEY。' });
  }
  let body;
  try { body = await readJsonBody(request); }
  catch (error) { return sendJson(response, error.statusCode || 400, { error: error.message }); }

  const image = typeof body.image === 'string' ? body.image : '';
  const match = image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return sendJson(response, 400, { error: '图片格式不支持，请使用 JPEG、PNG、WebP 或 GIF。' });
  if (Buffer.byteLength(match[2], 'base64') > 8 * 1024 * 1024) {
    return sendJson(response, 413, { error: '图片过大，请选择小于 8 MB 的图片。' });
  }

  try {
    const { apiResponse, payload } = await requestVisionModel(image);
    if (!apiResponse.ok) {
      const message = payload.error?.message || `视觉模型请求失败（HTTP ${apiResponse.status}）。`;
      return sendJson(response, apiResponse.status >= 500 ? 502 : 400, { error: message });
    }
    const analysis = validateAnalysis(parseAnalysisResponse(payload));
    return sendJson(response, 200, { analysis, model: MODEL });
  } catch (error) {
    console.error('[vision] analysis failed:', error.message);
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return sendJson(response, 504, { error: '视觉模型服务响应超时（60 秒），请重试；若反复出现，请检查模型中转站状态或网络连接。' });
    }
    return sendJson(response, 502, { error: `视觉模型分析失败：${error.message}` });
  }
}

function serveStatic(request, response) {
  const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(WEB_ROOT, relativePath);
  if (!filePath.startsWith(`${WEB_ROOT}${path.sep}`) && filePath !== path.join(WEB_ROOT, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/analyze-photo') {
    void analyzePhoto(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, POST' }).end();
    return;
  }
  serveStatic(request, response);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`衣见如故原型已启动：http://localhost:${PORT}`);
    console.log(`视觉模型：${MODEL}；接口：${API_BASE_URL}/v1/responses；API Key：${process.env.OPENAI_API_KEY ? '已配置' : '未配置'}`);
    console.log('不要将 .env 文件或 API Key 分享、提交到公开仓库。');
  });
}

module.exports = { extractOutputText, parseAnalysisResponse, isJsonModeUnsupported, validateAnalysis };
