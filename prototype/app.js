let products = [];

const $ = id => document.getElementById(id);
const chat = $('chatScroll');
let communicationMode = 'text';
let recognition = null;
let sdkAgent = null;
let sdkInitializing = false;
let sdkVoiceActive = false;
let sdkFinalTranscript = '';
let sdkInterimTranscript = '';
let sdkSendTimer = null;
let sdkFloatingObserver = null;
let sdkFloatingSuppressTimer = null;
let sdkAsrStarting = false;
let recommendationContext = '';
let photoAnalysisContext = '';
let photoAnalysisResult = null;
let photoAnalysisState = 'none';
let photoAnalysisPromise = null;
let photoAnalysisRequestId = 0;
let pendingPhoto = null;
let productCatalogPromise = null;
let avatarReaction = 'idle';
let avatarSpeaking = false;
// SDK 可能会在自然停顿时先给出一段 final 结果；留出更长缓冲，避免把
// 一句话中间的停顿误判成用户已经说完。
const SDK_VOICE_SILENCE_MS = 4200;

const AVATAR_REACTION_META = {
  idle: { label: '在这里陪你逛' },
  reviewing: { label: '正在认真看' },
  delighted: { label: '这个亮点我喜欢' },
  thoughtful: { label: '我想帮你再斟酌一下' }
};

function scrollToLatest() { chat.scrollTop = chat.scrollHeight; }

function setSdkStatus(text, state = '') {
  const chip = $('sdkStatus');
  if (!chip) return;
  chip.textContent = text;
  chip.classList.toggle('connected', state === 'connected');
  chip.classList.toggle('busy', state === 'busy');
}

function setVoicePrompt(text) {
  const prompt = $('voicePrompt');
  if (prompt) prompt.textContent = text;
}

function setAvatarReaction(reaction = 'idle') {
  const next = AVATAR_REACTION_META[reaction] ? reaction : 'idle';
  avatarReaction = next;
  const stage = $('avatarStage');
  if (stage) {
    stage.classList.remove(...Object.keys(AVATAR_REACTION_META).map(value => `avatar-reaction-${value}`));
    stage.classList.add(`avatar-reaction-${next}`);
  }
  const status = $('avatarStatus');
  if (status) status.textContent = avatarSpeaking ? '正在为你讲解' : AVATAR_REACTION_META[next].label;
}

function setAvatarSpeaking(speaking) {
  avatarSpeaking = Boolean(speaking);
  const stage = $('avatarStage');
  if (stage) stage.classList.toggle('avatar-speaking', avatarSpeaking);
  const status = $('avatarStatus');
  if (status) status.textContent = avatarSpeaking ? '正在为你讲解' : AVATAR_REACTION_META[avatarReaction].label;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, character => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  })[character]);
}

function clipSpeech(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

async function loadProductCatalog() {
  try {
    const response = await fetch('./catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`商品目录加载失败（HTTP ${response.status}）`);
    const payload = await response.json();
    if (!Array.isArray(payload.products)) throw new Error('商品目录格式不正确');
    products = payload.products;
    if (payload.demo === true) {
      console.info('[catalog] 当前加载的是演示商品数据，不代表真实门店商品或库存。');
    }
  } catch (error) {
    console.error('[catalog] load failed:', error);
    $('demoDisclaimer').textContent = '商品资料暂不可用；照片分析和数字人对话仍可使用';
  }
}

function suppressSdkFloatingLayers() {
  const root = $('agent-avatar');
  if (!root) return;
  const app = document.querySelector('.chat-app');
  document.querySelectorAll('body *').forEach(element => {
    if (root.contains(element) || (app && app.contains(element)) || element.closest('.sdk-dialog') || element === root) return;
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed') return;
    const rect = element.getBoundingClientRect();
    const nearBottomRight = rect.right >= window.innerWidth - 24 && rect.bottom >= window.innerHeight - 220 && rect.width <= 180 && rect.height <= 180;
    const fullScreenVisual = rect.width >= window.innerWidth * 0.7 && rect.height >= window.innerHeight * 0.7 && /canvas|iframe|video/i.test(element.tagName);
    if (nearBottomRight || fullScreenVisual) {
      element.style.setProperty('display', 'none', 'important');
    }
  });
}

function scheduleSdkFloatingSuppression() {
  if (sdkFloatingSuppressTimer) return;
  sdkFloatingSuppressTimer = window.setTimeout(() => {
    sdkFloatingSuppressTimer = null;
    suppressSdkFloatingLayers();
  }, 300);
}

function renderSdkTranscript() {
  const text = `${sdkFinalTranscript}${sdkInterimTranscript ? `${sdkFinalTranscript ? ' ' : ''}${sdkInterimTranscript}` : ''}`.trim();
  if (text) setVoicePrompt(`正在听：${text}`);
}

function scheduleSdkVoiceSend() {
  window.clearTimeout(sdkSendTimer);
  sdkSendTimer = window.setTimeout(() => { void sendSdkVoiceUtterance(); }, SDK_VOICE_SILENCE_MS);
}

async function sendSdkVoiceUtterance() {
  const text = `${sdkFinalTranscript} ${sdkInterimTranscript}`.trim();
  sdkFinalTranscript = '';
  sdkInterimTranscript = '';
  if (!text || !sdkAgent || !sdkVoiceActive) return;
  await submitUserTurn(text, { voice: true });
}

async function initRealAgent() {
  if (sdkInitializing || sdkAgent) return;
  if (!window.XingyunAvatarAgent) {
    $('sdkDialogMessage').textContent = 'SDK 脚本没有加载成功，请检查网络连接。';
    return;
  }
  const appId = $('sdkAppId').value.trim();
  const appSecret = $('sdkAppSecret').value.trim();
  if (!appId || !appSecret) {
    $('sdkDialogMessage').textContent = '请填写 App ID 和 App Secret。';
    return;
  }
  sdkInitializing = true;
  $('sdkConnectButton').disabled = true;
  $('sdkDialogMessage').textContent = '正在加载真实数字人资源，请稍候…';
  setSdkStatus('正在连接…', 'busy');
  try {
    sdkAgent = new window.XingyunAvatarAgent({
      container: $('agent-avatar'),
      appId,
      appSecret,
      gatewayServer: 'https://nebula-agent.xingyun3d.com/user/v1/ttsa_v2/session',
      features: { auto_send_asr_to_llm: false },
      onMessage(error) {
        console.warn('[Xingyun] render error', error);
        const message = String(error?.message || error || '未知渲染错误');
        if (/音频数据过期|audio(?:\s|_)?data.*(?:expired|stale)|expired.*audio/i.test(message)) {
          sdkVoiceActive = false;
          setAvatarSpeaking(false);
          setVoicePrompt('语音播放中断 · 请点击“语音陪逛”继续');
          setSdkStatus('数字人已连接', 'connected');
        }
      },
      agentCallbacks: {
        onAgentStateChange(state) {
          const value = JSON.stringify(state);
          if (/running|speaking|asking/i.test(value)) {
            setSdkStatus('数字人回答中', 'busy');
            setAvatarSpeaking(true);
          } else if (/ready|idle|completed/i.test(value)) {
            setSdkStatus('数字人已连接', 'connected');
            setAvatarSpeaking(false);
          }
        },
        onASRResult(result) {
          const text = String(result?.text || '').trim();
          if (!text) return;
          if (result.isFinal) {
            sdkFinalTranscript = `${sdkFinalTranscript}${sdkFinalTranscript ? ' ' : ''}${text}`;
            sdkInterimTranscript = '';
          } else sdkInterimTranscript = text;
          // final 结果出来后，用户仍可能继续补充。每个 interim/final 帧都
          // 重新计时，只有持续安静一段时间才真正提交本轮语音。
          if (sdkVoiceActive && (sdkFinalTranscript || sdkInterimTranscript)) scheduleSdkVoiceSend();
          renderSdkTranscript();
        },
        onConversationChange(event) {
          const value = JSON.stringify(event);
          if (/completed/i.test(value)) {
            setSdkStatus('数字人已连接', 'connected');
            setAvatarSpeaking(false);
            if (sdkVoiceActive) {
              // 星云 SDK 要求 startASR 由用户手势触发。回答结束后不能在
              // completed 回调里自动重启，否则旧房间可能已经关闭。
              sdkVoiceActive = false;
              window.clearTimeout(sdkSendTimer);
              setVoicePrompt('回答结束 · 点击“语音陪逛”继续说话');
            }
          }
        },
        onError(error) {
          console.warn('[Xingyun] agent error', error);
          sdkVoiceActive = false;
          sdkAsrStarting = false;
          window.clearTimeout(sdkSendTimer);
          setAvatarSpeaking(false);
          const message = String(error?.message || error || '未知错误');
          // 某些 SDK 版本会在一轮播报收尾时迟到一帧音频，返回“音频数据过期”。
          // 这不代表房间断开，也不应把整个数字人标记为连接异常。
          const staleAudioError = /音频数据过期|audio(?:\s|_)?data.*(?:expired|stale)|expired.*audio/i.test(message);
          if (staleAudioError) {
            setVoicePrompt('本轮语音已结束 · 点击“语音陪逛”继续说话');
            setSdkStatus(sdkAgent ? '数字人已连接' : '数字人未连接', sdkAgent ? 'connected' : '');
            return;
          }
          const fatalRoomError = /房间已关闭|身份验证数据缺失|request_id/i.test(message);
          setVoicePrompt(fatalRoomError
            ? '语音连接已结束 · 请点击“连接数字人”重新连接后再试'
            : `数字人出现问题：${message}`);
          setSdkStatus('连接异常', 'busy');
        }
      }
    });
    await sdkAgent.init({ onDownloadProgress(progress) { $('sdkDialogMessage').textContent = `正在下载数字人资源：${progress.toFixed(0)}%`; } });
    $('agent-avatar').classList.add('ready');
    $('avatarStage').classList.add('has-real-avatar');
    $('avatarStage').style.removeProperty('display');
    $('avatarStage').style.removeProperty('visibility');
    $('textInterruptButton').disabled = false;
    suppressSdkFloatingLayers();
    // SDK 初始化期间会持续修改 DOM。不要在每个 mutation 中同步遍历整棵
    // body，否则会抢占渲染线程，造成音频帧处理滞后和“音频数据过期”。
    sdkFloatingObserver = new MutationObserver(scheduleSdkFloatingSuppression);
    sdkFloatingObserver.observe(document.body, { childList: true, subtree: true });
    $('sdkDialogMessage').textContent = '连接成功。现在主网页已使用真实数字人。';
    $('demoDisclaimer').textContent = '拍照与相册随时可用 · 已接入真实数字人、语音识别和客户端打断';
    setSdkStatus('数字人已连接', 'connected');
    window.setTimeout(() => $('sdkDialog').close(), 500);
  } catch (error) {
    sdkAgent = null;
    if (sdkFloatingObserver) { sdkFloatingObserver.disconnect(); sdkFloatingObserver = null; }
    $('sdkDialogMessage').textContent = `连接失败：${error?.message || error}`;
    setSdkStatus('数字人未连接');
  } finally {
    sdkInitializing = false;
    $('sdkConnectButton').disabled = false;
  }
}

async function startSdkVoice() {
  if (!sdkAgent || sdkAsrStarting || sdkVoiceActive) return false;
  sdkAsrStarting = true;
  try {
    sdkVoiceActive = true;
    sdkFinalTranscript = '';
    sdkInterimTranscript = '';
    setVoicePrompt('正在申请麦克风…');
    await sdkAgent.startASR();
    setVoicePrompt('正在聆听，你可以直接说话');
    setSdkStatus('正在聆听', 'busy');
    return true;
  } catch (error) {
    sdkVoiceActive = false;
    setVoicePrompt(`麦克风启动失败：${error?.message || error}`);
    return false;
  } finally {
    sdkAsrStarting = false;
  }
}

async function stopSdkVoice() {
  sdkVoiceActive = false;
  sdkAsrStarting = false;
  window.clearTimeout(sdkSendTimer);
  if (sdkAgent) {
    try { await sdkAgent.stopASR(); } catch (error) { console.warn('[Xingyun] stop ASR error', error); }
  }
  setAvatarSpeaking(false);
  setSdkStatus(sdkAgent ? '数字人已连接' : '数字人未连接', sdkAgent ? 'connected' : '');
}

function addMessage(text, who = 'user') {
  const article = document.createElement('article');
  article.className = `message ${who}-message`;
  if (who === 'assistant') {
    article.innerHTML = '<div class="message-avatar">衣</div><div class="message-content"><span class="message-name">小衣</span><div class="message-text"></div></div>';
    article.querySelector('.message-text').textContent = text;
    if (!avatarSpeaking && avatarReaction === 'idle') setAvatarReaction('idle');
    if (communicationMode === 'voice' && !sdkAgent) speakText(text);
  } else {
    article.innerHTML = '<div class="message-content"><div class="message-text"></div></div>';
    article.querySelector('.message-text').textContent = text;
  }
  chat.append(article);
  scrollToLatest();
  return article;
}

function productCard(product, index) {
  const image = product.image
    ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" />`
    : `<div class="chat-product-placeholder" style="background:${escapeHtml(product.gradient || 'linear-gradient(145deg,#e5ddd3,#b8aa9a)')}"><span>图片待补充</span></div>`;
  const details = [product.color, product.price == null ? '价格待补充' : `¥${Number(product.price).toFixed(0)}`].filter(Boolean).join(' · ');
  return `<article class="chat-product-card"><div class="chat-product-visual">${image}<span>${escapeHtml(product.type)}</span><i>${index + 1}</i></div><div class="chat-product-copy"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(details)}</span><small>${escapeHtml(product.location || '门店位置待补充')}</small></div></article>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function isAppearanceQuestion(message) {
  return /我(?:美|漂亮|好看)(?:吗|不|吧)|你觉得我(?:美|漂亮|好看)|我看起来(?:怎么样|好看吗)/i.test(message);
}

function withRecommendationContext(message) {
  const context = [];
  if (photoAnalysisState === 'ready' && photoAnalysisContext) {
    context.push(`【重要：上一条用户消息已附带照片】照片已经收到，并已由视觉模型完成分析。你当前拿到的是照片分析摘要（不是原始图片像素），所以必须基于下面摘要回答；不要说“没看到照片”“没有图片”或要求用户重新描述，也不要编造摘要没有提到的五官、身材、品牌或价格细节。\n照片分析摘要：\n${photoAnalysisContext}`);
  } else if (photoAnalysisState === 'failed') {
    context.push('用户刚刚发送过一张照片，但照片分析失败。请承认照片已收到，不要声称看清了内容；若问题依赖照片细节，简短说明这次无法具体点评。');
  }
  context.push('请像熟悉的陪逛朋友一样自然、活泼、有温度地直接回答，不要像分析报告，不要念出规则。夸赞真诚但不捏造细节。');
  if (isAppearanceQuestion(message)) {
    if (photoAnalysisState === 'ready') {
      context.push('用户是在向朋友寻求一句真心话，不是在要求颜值打分：先热情、自然、明确地肯定她，再从照片摘要里挑一个真实的穿搭亮点夸她；可以说“当然呀/很有气质”，但不要假装看清摘要没有提供的五官或身材。1到3句，像朋友聊天。');
    } else if (photoAnalysisState === 'failed') {
      context.push('先自然热情地肯定她，再轻轻说明这次暂时不能具体点评照片搭配。像朋友聊天，不要冷冰冰拒绝。');
    } else {
      context.push('这是在向朋友讨一句真心话：先热情明确地肯定她，不要打分或用“无法判断”开头，也不要捏造五官、身材细节。');
    }
  }
  if (recommendationContext) {
    context.push(`【当前推荐商品资料】\n${recommendationContext}\n网页卡片图片只是展示，请依据商品资料回答，不要声称自己直接看到了图片。`);
  }
  return `${context.join('\n\n')}\n\n【现在请回答】用户现在说：${message}\n请直接承接上面这张已收到的照片和分析摘要回答，不要回复“没看到照片”。`;
}

function buildRecommendationContext(picks) {
  recommendationContext = picks.map((product, index) => (
    `${index + 1}. ${product.name}｜${product.type}｜${product.color}｜价格：${product.price == null ? '待补充' : `¥${product.price}`}｜位置：${product.location || '待补充'}\n` +
    `版型：${product.fit}；适合：${product.scene}；搭配：${product.pairing}；画面描述：${product.visual}`
  )).join('\n');
}

async function showRecommendations() {
  if (!products.length && productCatalogPromise) await productCatalogPromise;
  if (!products.length) {
    addMessage('我这边暂时没有加载到商品资料，照片穿搭建议仍然可以继续聊。', 'assistant');
    return;
  }
  const article = addMessage('我先从你提供的参考图里挑两种方向：藏青立领外套更正式，酒红针织搭配更柔和、偏轻松。这里只是基于图片的穿搭参考，不代表门店现货；你更喜欢哪种感觉？', 'assistant');
  const picks = products.filter(product => ['photo-navy-stand-collar-blazer', 'photo-burgundy-cardigan-look'].includes(product.id));
  buildRecommendationContext(picks);
  const cards = document.createElement('div');
  cards.className = 'recommendation-block';
  cards.innerHTML = `<div class="recommendation-title"><span>穿搭参考图</span><small>非真实商品/库存</small></div><div class="chat-product-grid">${picks.map(productCard).join('')}</div><div class="recommendation-actions"><button class="inline-action" data-message="我更喜欢第一种风格，正式感怎么样？">聊聊正式程度</button><button class="inline-action" data-message="第一件在店里有我的尺码吗？">问问尺码库存</button><button class="inline-action" data-message="我想换个更轻松的风格">换个风格</button></div>`;
  article.querySelector('.message-content').append(cards);
  scrollToLatest();
}

function shouldShowRecommendations(message) {
  return /面试|推荐|帮我挑|搭配|适合我|不知道穿|几套|几件|衣服.*看看|看看.*衣服|发.*(图|图片|衣服|穿搭)|给我.*(看看|挑)/i.test(message);
}

function showLocation() {
  const article = addMessage('第一套的外套和长裤在一楼 3 号区，衬衫在二楼 2 号区。先看一楼外套，旁边就能试长裤，再搭扶梯到二楼找衬衫。具体位置是演示数据，实际门店可接入地图或货架信息。', 'assistant');
  const route = document.createElement('div');
  route.className = 'mini-route';
  route.innerHTML = '<span>你在这里</span><i>→</i><b>1F · 3号区</b><i>→</i><b>2F · 2号区</b>';
  article.querySelector('.message-content').append(route);
}

function replyTo(message) {
  if (isAppearanceQuestion(message)) {
    if (photoAnalysisState === 'ready') {
      const strength = photoAnalysisResult?.strengths?.find(value => value && !/暂未观察|无法判断/.test(value));
      const detail = strength ? `我还认真看了照片里的搭配，${strength}，这个亮点我喜欢！` : '照片我收到啦，也结合能识别出的穿搭认真看过了！';
      addMessage(`当然美呀！照片我收到啦，${detail}你愿意这样认真挑、认真问，本身就很有魅力。`, 'assistant');
    } else if (photoAnalysisState === 'failed') {
      addMessage('当然美呀，先给你一个大大的肯定！照片我收到啦，只是这次图片分析没成功，我不想装作看清了细节；但我很愿意继续陪你聊穿搭。', 'assistant');
    } else {
      addMessage('当然美呀！先给你一个大大的肯定。哪天想让我陪你看看穿搭或试穿效果，发张照片来就好，我会认真陪你聊。', 'assistant');
    }
  } else if (/面试|推荐|帮我挑|搭配|适合我|不知道穿/.test(message)) {
    showRecommendations();
  } else if (/位置|哪里|怎么走|楼层/.test(message)) {
    showLocation();
  } else if (/尺码|库存|有.*码/.test(message)) {
    addMessage('我可以继续帮你查，不过还不知道你的尺码。你知道平时上衣或裤子穿什么码吗？不知道也没关系，可以先去试穿；这里显示的库存目前是演示数据。', 'assistant');
  } else if (/自己逛|先看看|自己看看/.test(message)) {
    addMessage('好呀，你先按自己的节奏逛。我不主动打扰；看中哪件时，随时拍下来或从相册选图发给我，我们一起聊。', 'assistant');
  } else if (/换|不喜欢|颜色|轻松|预算|便宜|贵/.test(message)) {
    addMessage('收到，我会把这个偏好放进考虑里，不会劝你穿自己不喜欢的。你希望保留哪部分、换掉哪部分？比如只换颜色，还是整体更休闲一点？', 'assistant');
  } else if (/清单|买下|购买/.test(message)) {
    addMessage('可以，我先把你喜欢的商品整理成清单。尺码和库存以到店确认或正式接入的门店数据为准；现在这个原型里它们还是模拟信息。', 'assistant');
  } else {
    addMessage(`我听到了：“${message}”。你可以继续告诉我面试场合、预算或偏好的感觉，也可以把看中的衣服拍给我，我会结合上下文给你建议。`, 'assistant');
  }
}

async function submitUserTurn(value, { voice = false, photoOnly = false } = {}) {
  const message = String(value || '').trim();
  if (!message && (!pendingPhoto || !photoOnly)) return;

  const photo = pendingPhoto;
  pendingPhoto = null;
  renderPhotoDraft();
  $('messageInput').value = '';

  let analysisPromise = null;
  if (photo) {
    const { status } = addPhotoMessage(message, photo.url);
    analysisPromise = analyzeSentPhoto(photo.file, status);
  } else {
    addMessage(message, 'user');
    if (photoAnalysisState === 'analyzing') analysisPromise = photoAnalysisPromise;
  }

  if (!message) return;

  if (sdkAgent) {
    try {
      if (voice) await sdkAgent.stopASR();
      // ASR 结束后本轮语音已经交给 ask()，不要在回答结束时隐式重启。
      if (voice) sdkVoiceActive = false;
      setSdkStatus('数字人回答中', 'busy');
      setVoicePrompt(analysisPromise ? '正在看照片，再回答你…' : '正在回答，你可以点击“打断”或直接再次开口');
      setAvatarSpeaking(true);
      if (analysisPromise) await analysisPromise;
      if (shouldShowRecommendations(message)) await showRecommendations();
      await sdkAgent.ask(withRecommendationContext(message));
    } catch (error) {
      setAvatarSpeaking(false);
      setVoicePrompt(`${voice ? '语音' : '发送'}失败：${error?.message || error}`);
      setSdkStatus('数字人已连接', 'connected');
    }
    return;
  }

  if (analysisPromise) await analysisPromise;
  window.setTimeout(() => replyTo(message), 280);
}

function sendMessage(value) {
  void submitUserTurn(value);
}

function speakText(text) {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.onstart = () => { setAvatarSpeaking(true); $('voicePrompt').textContent = '正在播报 · 点“模拟插话”可打断'; };
  utterance.onend = () => { setAvatarSpeaking(false); $('voicePrompt').textContent = '语音陪逛演示 · 点击下方按钮模拟插话'; };
  utterance.onerror = () => { setAvatarSpeaking(false); $('voicePrompt').textContent = '语音播报不可用 · 可继续体验界面演示'; };
  window.speechSynthesis.speak(utterance);
}

async function setMode(mode) {
  communicationMode = mode;
  const voice = mode === 'voice';
  $('voiceModeButton').classList.toggle('active', voice);
  $('textModeButton').classList.toggle('active', !voice);
  $('voiceModeButton').setAttribute('aria-selected', String(voice));
  $('textModeButton').setAttribute('aria-selected', String(!voice));
  $('voiceControls').hidden = !voice;
  $('textControls').hidden = voice;
  $('modeStatus').textContent = voice ? (sdkAgent ? '语音模式 · 正在连接麦克风' : '语音模式 · 演示中，未开启麦克风') : '文字模式 · 麦克风未开启';
  $('composerHint').textContent = voice ? '正式版可直接开口；数字人播报时也能插话' : '可以打字，或点麦克风转成文字；拍照和相册始终可用';
  renderPhotoDraft();
  if (!voice) {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (recognition) recognition.stop();
    await stopSdkVoice();
    setAvatarSpeaking(false);
    setAvatarReaction('idle');
    $('voicePrompt').textContent = '语音陪逛演示 · 语音功能尚未接入';
    return;
  }
  setAvatarSpeaking(false);
  setAvatarReaction('idle');
  $('voicePrompt').textContent = sdkAgent ? '正在开启真实麦克风…' : '语音陪逛演示 · 点击下方按钮模拟插话';
  if (sdkAgent) {
    await startSdkVoice();
    return;
  }
  const latestAssistant = [...chat.querySelectorAll('.assistant-message .message-text, .assistant-message .message-content > p')].at(-1);
  if (latestAssistant) speakText(latestAssistant.textContent);
}

function startDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $('modeStatus').textContent = '此浏览器不支持网页语音识别，可用手机键盘的麦克风';
    return;
  }
  if (recognition) recognition.stop();
  recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onstart = () => { $('modeStatus').textContent = '正在听你说…'; $('dictationButton').classList.add('recording'); };
  recognition.onresult = event => {
    const transcript = [...event.results].map(result => result[0].transcript).join('');
    $('messageInput').value = transcript;
  };
  recognition.onerror = () => { $('modeStatus').textContent = '语音识别未能启动，请检查浏览器权限'; };
  recognition.onend = () => {
    $('dictationButton').classList.remove('recording');
    if (communicationMode === 'text') $('modeStatus').textContent = '文字模式 · 麦克风未开启';
  };
  recognition.start();
}

function formatPhotoAnalysis(analysis) {
  const list = value => Array.isArray(value) && value.length ? value.join('；') : '暂无明确判断';
  const reaction = analysis.reaction === 'delighted' ? '有明确亮点，可以自然表达欣赏' : '温和斟酌，不夸大结论';
  return [
    `类别：${analysis.category}`,
    `颜色：${analysis.colors.join('、') || '不确定'}`,
    `款式/版型：${analysis.style}`,
    `优点：${list(analysis.strengths)}`,
    `需要注意：${list(analysis.risks)}`,
    `朋友式第一反应：${reaction}`,
    `面试适配度：${analysis.interview_fit}`,
    `改进建议：${analysis.advice}`,
    `搭配建议：${analysis.pairing || '暂无明确判断'}`,
    `适合场合：${list(analysis.occasions)}`,
    `判断局限：${analysis.caveats}`
  ].join('\n');
}

function choosePhotoReaction(analysis) {
  if (analysis?.reaction === 'delighted' || analysis?.reaction === 'thoughtful') return analysis.reaction;
  const risks = Array.isArray(analysis?.risks) ? analysis.risks.filter(Boolean) : [];
  const strengths = Array.isArray(analysis?.strengths) ? analysis.strengths.filter(Boolean) : [];
  const fit = String(analysis?.interview_fit || '');
  if (!risks.length && strengths.length && /高|适合|合适|优秀/.test(fit)) return 'delighted';
  return 'thoughtful';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('浏览器读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function analyzePhoto(file) {
  const imageDataUrl = await readFileAsDataUrl(file);
  const response = await fetch('/api/analyze-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `图片分析失败（HTTP ${response.status}）`);
  return result.analysis;
}

function renderPhotoDraft() {
  const draft = $('photoDraft');
  draft.hidden = !pendingPhoto;
  const copy = draft.querySelector('.photo-draft-copy span');
  const hint = $('composerHint');
  if (!pendingPhoto) {
    $('photoPreview').removeAttribute('src');
    copy.textContent = '选好照片后先预览；你可以附上文字发送，也可以只发照片，之后再说话或打字提问。';
    hint.textContent = communicationMode === 'voice'
      ? '语音陪逛已开启；选图不会自动发送，说话提问时可和照片一起发出'
      : '随时可以问我，也可以把看中的衣服拍给我';
    return;
  }
  $('photoPreview').src = pendingPhoto.url;
  copy.textContent = communicationMode === 'voice'
    ? '照片还没发送。直接说话提问会把照片和问题一起发出；也可以只发照片，之后再问。'
    : '照片还没发送。输入问题后点“发送”会一起发出；也可以只发照片，之后再问。';
  hint.textContent = communicationMode === 'voice'
    ? '选图只会暂存预览，不会上传；发送照片后我不会自动回复'
    : '选图只会暂存预览，不会上传；单独发图后我不会自动回复';
}

function addPhotoMessage(message, imageUrl) {
  const article = document.createElement('article');
  article.className = 'message user-message';
  const content = document.createElement('div');
  content.className = 'message-content';
  if (message) {
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message;
    content.append(text);
  }
  const image = document.createElement('img');
  image.className = 'sent-photo';
  image.alt = '你发送的照片';
  const releaseUrl = () => {
    image.removeEventListener('load', releaseUrl);
    image.removeEventListener('error', releaseUrl);
    URL.revokeObjectURL(image.src);
  };
  image.addEventListener('load', releaseUrl, { once: true });
  image.addEventListener('error', releaseUrl, { once: true });
  image.src = imageUrl;
  const status = document.createElement('span');
  status.className = 'photo-message-status';
  status.textContent = '照片已发送，正在整理穿搭信息；我等你提问后再回答';
  content.append(image, status);
  article.append(content);
  chat.append(article);
  scrollToLatest();
  return { article, status };
}

function analyzeSentPhoto(file, statusNode) {
  const requestId = ++photoAnalysisRequestId;
  photoAnalysisContext = '';
  photoAnalysisResult = null;
  photoAnalysisState = 'analyzing';
  const promise = analyzePhoto(file).then(analysis => {
    if (requestId !== photoAnalysisRequestId) return;
    photoAnalysisResult = analysis;
    photoAnalysisContext = formatPhotoAnalysis(analysis);
    photoAnalysisState = 'ready';
    statusNode.textContent = '照片收到啦，我等你提问';
  }).catch(error => {
    if (requestId !== photoAnalysisRequestId) return;
    photoAnalysisState = 'failed';
    statusNode.textContent = `照片已发送，但分析失败：${error?.message || '请检查视觉模型服务'}`;
    console.warn('[photo] analysis failed:', error);
  });
  photoAnalysisPromise = promise;
  return promise;
}

function showPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    $('modeStatus').textContent = '请选择图片文件';
    return;
  }
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
  pendingPhoto = { file, url: URL.createObjectURL(file) };
  renderPhotoDraft();
  $('cameraInput').value = '';
  $('albumInput').value = '';
}

$('sendButton').addEventListener('click', () => sendMessage($('messageInput').value));
$('messageInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage($('messageInput').value); }
});
$('cameraButton').addEventListener('click', () => $('cameraInput').click());
$('albumButton').addEventListener('click', () => $('albumInput').click());
$('cameraInput').addEventListener('change', event => showPhoto(event.target.files[0]));
$('albumInput').addEventListener('change', event => showPhoto(event.target.files[0]));
$('removePhotoButton').addEventListener('click', () => {
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.url);
  pendingPhoto = null;
  renderPhotoDraft();
});
$('sendPhotoOnlyButton').addEventListener('click', () => {
  void submitUserTurn('', { photoOnly: true });
});
$('voiceModeButton').addEventListener('click', () => setMode('voice'));
$('textModeButton').addEventListener('click', () => setMode('text'));
$('dictationButton').addEventListener('click', startDictation);
$('interruptButton').addEventListener('click', () => {
  if (sdkAgent) {
    try {
      sdkAgent.interrupt('speak');
      setAvatarSpeaking(false);
      setVoicePrompt('已打断播报，正在聆听你的话');
      if (communicationMode === 'voice') void startSdkVoice();
    } catch (error) { setVoicePrompt(`打断失败：${error?.message || error}`); }
    return;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  setAvatarSpeaking(false);
  $('avatarStatus').textContent = '用户打断了播报';
  $('voicePrompt').textContent = '播报已停止 · 正在接收你的话（模拟）';
  const sample = '等一下，我不想穿西装，有更轻松一点的吗？';
  addMessage(sample, 'user');
  window.setTimeout(() => replyTo(sample), 240);
});
chat.addEventListener('click', event => {
  const button = event.target.closest('[data-message]');
  if (button) sendMessage(button.dataset.message);
});
$('resetButton').addEventListener('click', () => window.location.reload());
$('sdkSetupButton').addEventListener('click', () => {
  if (sdkAgent) {
    if (communicationMode === 'voice') void stopSdkVoice();
    void sdkAgent.destroy('user');
    sdkAgent = null;
    if (sdkFloatingSuppressTimer) { window.clearTimeout(sdkFloatingSuppressTimer); sdkFloatingSuppressTimer = null; }
    if (sdkFloatingObserver) { sdkFloatingObserver.disconnect(); sdkFloatingObserver = null; }
    setAvatarSpeaking(false);
    setAvatarReaction('idle');
    $('agent-avatar').classList.remove('ready');
    $('avatarStage').classList.remove('has-real-avatar');
    $('textInterruptButton').disabled = true;
    setSdkStatus('数字人未连接');
    $('demoDisclaimer').textContent = '拍照与相册随时可用 · 当前使用网页演示模式；连接数字人后将启用真实播报、识别和打断';
    return;
  }
  $('sdkDialogMessage').textContent = '';
  $('sdkDialog').showModal();
});
$('sdkConnectButton').addEventListener('click', event => { event.preventDefault(); void initRealAgent(); });
$('textInterruptButton').addEventListener('click', () => {
  if (!sdkAgent) return;
  try {
    sdkAgent.interrupt('speak');
    setAvatarSpeaking(false);
    setSdkStatus('数字人已连接', 'connected');
    setVoicePrompt('已打断数字人播报');
  } catch (error) {
    setVoicePrompt(`打断失败：${error?.message || error}`);
  }
});
window.addEventListener('beforeunload', () => { if (sdkAgent) void sdkAgent.destroy('page_unload'); });

productCatalogPromise = loadProductCatalog();
