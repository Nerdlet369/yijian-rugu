const $ = id => document.getElementById(id);
let agent = null;
let finalTranscript = '';
let interimTranscript = '';

function log(message, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`;
  const output = $('log');
  output.textContent = output.textContent === '尚未开始。' ? line : `${output.textContent}\n${line}`;
  output.scrollTop = output.scrollHeight;
}

function status(message) {
  $('status').textContent = message;
  log(message);
}

function setControls(enabled) {
  ['ask-btn', 'start-asr-btn', 'stop-asr-btn', 'interrupt-btn', 'destroy-btn'].forEach(id => { $(id).disabled = !enabled; });
  $('init-btn').disabled = enabled;
}

function renderTranscript() {
  const text = `${finalTranscript}${interimTranscript ? `${finalTranscript ? ' ' : ''}${interimTranscript}` : ''}`.trim();
  $('transcript').value = text;
  $('send-transcript-btn').disabled = !text || !agent;
}

function appendFinalTranscript(text) {
  const clean = String(text || '').trim();
  if (!clean || finalTranscript.endsWith(clean)) return;
  finalTranscript = `${finalTranscript}${finalTranscript ? ' ' : ''}${clean}`;
  interimTranscript = '';
  renderTranscript();
}

async function initAgent() {
  if (!window.XingyunAvatarAgent) {
    status('SDK 脚本没有加载成功。检查网络，或打开浏览器控制台查看错误。');
    return;
  }
  const appId = $('app-id').value.trim();
  const appSecret = $('app-secret').value.trim();
  if (!appId || !appSecret) {
    status('请先填写 App ID 和 App Secret。');
    return;
  }
  $('init-btn').disabled = true;
  status('正在创建 SDK 实例并建立连接…');
  try {
    agent = new window.XingyunAvatarAgent({
      container: $('agent-avatar'),
      appId,
      appSecret,
      gatewayServer: 'https://nebula-agent.xingyun3d.com/user/v1/ttsa_v2/session',
      features: {
        // 只识别，不自动把每个 isFinal 片段发送给大模型。
        // 用户确认完整文本后，再显式调用 agent.ask(text)。
        auto_send_asr_to_llm: false
      },
      onMessage(error) {
        log('渲染错误', error);
      },
      agentCallbacks: {
        onAgentStateChange(state) { log('Agent 状态', state); },
        onASRResult(result) {
          log(`识别结果${result.isFinal ? '（最终）' : '（临时）'}`, result.text);
          if (result.isFinal) appendFinalTranscript(result.text);
          else { interimTranscript = String(result.text || '').trim(); renderTranscript(); }
          $('asr-state').textContent = result.isFinal ? '已得到一段结果，可继续说或确认发送' : '正在识别…';
        },
        onConversationChange(event) { log('对话状态', event); },
        onError(error) { log('Agent 错误', error); }
      }
    });
    await agent.init({ onDownloadProgress(progress) { status(`正在下载数字人资源：${progress.toFixed(0)}%`); } });
    setControls(true);
    status('初始化成功。先点“发文本”，再测试识别和打断。');
  } catch (error) {
    $('init-btn').disabled = false;
    status(`初始化失败：${error?.message || error}`);
    log('初始化异常', error);
  }
}

$('init-btn').addEventListener('click', initAgent);
$('ask-btn').addEventListener('click', async () => {
  try { status('正在请求数字人播报…'); await agent.ask('你好，请用一句话介绍你能怎样陪我挑面试穿搭。'); }
  catch (error) { status(`文本对话失败：${error?.message || error}`); log('ask 异常', error); }
});
$('start-asr-btn').addEventListener('click', async () => {
  try { interimTranscript = ''; $('asr-state').textContent = '正在申请麦克风…'; status('正在申请麦克风并开始识别…'); await agent.startASR(); $('asr-state').textContent = '正在识别…'; }
  catch (error) { status(`启动识别失败：${error?.message || error}`); log('startASR 异常', error); }
});
$('stop-asr-btn').addEventListener('click', async () => {
  try { await agent.stopASR(); interimTranscript = ''; renderTranscript(); $('asr-state').textContent = '已停止，可编辑后发送'; status('已停止识别。识别内容不会自动触发回答，请检查文本后点击“发送给数字人”。'); }
  catch (error) { status(`停止识别失败：${error?.message || error}`); log('stopASR 异常', error); }
});
$('clear-transcript-btn').addEventListener('click', () => { finalTranscript = ''; interimTranscript = ''; renderTranscript(); $('asr-state').textContent = '已清空'; });
$('transcript').addEventListener('input', () => { finalTranscript = $('transcript').value.trim(); interimTranscript = ''; renderTranscript(); });
$('send-transcript-btn').addEventListener('click', async () => {
  const text = $('transcript').value.trim();
  if (!text || !agent) return;
  try {
    await agent.stopASR();
    status('已将确认后的完整识别文本发送给数字人…');
    $('send-transcript-btn').disabled = true;
    await agent.ask(text);
    finalTranscript = '';
    interimTranscript = '';
    renderTranscript();
    $('asr-state').textContent = '已发送';
  } catch (error) { status(`发送识别文本失败：${error?.message || error}`); log('发送识别文本异常', error); }
});
$('interrupt-btn').addEventListener('click', () => {
  try { agent.interrupt('speak'); status('已发送客户端打断，当前播报应立即停止。'); }
  catch (error) { status(`打断失败：${error?.message || error}`); log('interrupt 异常', error); }
});
$('destroy-btn').addEventListener('click', async () => {
  try { await agent.destroy('user'); agent = null; setControls(false); status('会话已销毁。'); }
  catch (error) { status(`销毁失败：${error?.message || error}`); log('destroy 异常', error); }
});
window.addEventListener('beforeunload', () => { if (agent) void agent.destroy('page_unload'); });
