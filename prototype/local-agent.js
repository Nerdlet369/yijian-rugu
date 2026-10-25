/**
 * 衣见如故 · 本地兜底导购（离线 Agent）
 *
 * 不修改 app.js：经典脚本顶层 function 声明是全局绑定，调用处按引用解析，
 * 因此本文件在 app.js 之后加载并覆写 window.replyTo 即可接管「无魔珐凭证」
 * 时的对话分支，跑通「需求采集 -> 按预算/风格/尺码筛选 -> 推荐 2-3 套 ->
 * 库存货架 -> 购买清单」闭环。魔珐凭证存在时，app.js 仍走云端 Agent，不受影响。
 *
 * 依赖：recommendation.js（window.YijianReco）、app.js 的全局 addMessage /
 * escapeHtml / scrollToLatest / photoAnalysisState / photoAnalysisResult / products。
 */
(function () {
  'use strict';

  const Reco = window.YijianReco || {};
  let localCatalog = { products: [], outfits: [] };

  const sessionState = {
    mode: 'browse',
    occasion: null,
    budget_max: null,
    top_size: null,
    bottom_size: null,
    style_preference: [],
    excluded_colors: [],
    recommended: false,
    resolvedOutfits: [],
    selectedOutfitId: null
  };

  // 加载整份目录（含 outfits），与 app.js 的 products 加载互不干扰。
  fetch('./catalog.json', { cache: 'no-store' })
    .then(r => r.json())
    .then(p => { localCatalog = p; })
    .catch(() => { /* 失败则仅依赖全局 products + 空 outfits */ });

  function summaryState() {
    const parts = [];
    if (sessionState.occasion) parts.push(String(sessionState.occasion).slice(0, 30));
    if (sessionState.budget_max) parts.push(`预算¥${sessionState.budget_max}`);
    if (sessionState.style_preference.length) parts.push(sessionState.style_preference.join('/'));
    if (sessionState.top_size) parts.push(`上衣${sessionState.top_size}`);
    if (sessionState.bottom_size) parts.push(`下装${sessionState.bottom_size}`);
    return parts.join(' · ') || '面试穿搭';
  }

  function addMessageLines(title, lines) {
    const article = window.addMessage(title, 'assistant');
    const ul = document.createElement('ul');
    ul.className = 'reco-list';
    lines.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    article.querySelector('.message-content').appendChild(ul);
    window.scrollToLatest();
    return article;
  }

  function currentSelectedOutfit() {
    if (!sessionState.selectedOutfitId) return null;
    return sessionState.resolvedOutfits.find(o => o.id === sessionState.selectedOutfitId) || null;
  }

  function replyAppearanceOffline() {
    if (window.photoAnalysisState === 'ready') {
      const strengths = Array.isArray(window.photoAnalysisResult?.strengths) ? window.photoAnalysisResult.strengths : [];
      const strength = strengths.find(v => v && !/暂未观察|无法判断/.test(v));
      const detail = strength ? `我还认真看了照片里的搭配，${strength}，这个亮点我喜欢！` : '照片我收到啦，也结合能识别出的穿搭认真看过了！';
      window.addMessage(`当然美呀！照片我收到啦，${detail}你愿意这样认真挑、认真问，本身就很有魅力。`, 'assistant');
    } else if (window.photoAnalysisState === 'failed') {
      window.addMessage('当然美呀，先给你一个大大的肯定！照片我收到啦，只是这次图片分析没成功，我不想装作看清了细节；但我很愿意继续陪你聊穿搭。', 'assistant');
    } else {
      window.addMessage('当然美呀！先给你一个大大的肯定。哪天想让我陪你看看穿搭或试穿效果，发张照片来就好，我会认真陪你聊。', 'assistant');
    }
  }

  function replyPhotoOffline() {
    const r = window.photoAnalysisResult || {};
    const strengths = Array.isArray(r.strengths) ? r.strengths.filter(Boolean) : [];
    const risks = Array.isArray(r.risks) ? r.risks.filter(Boolean) : [];
    const fit = r.interview_fit || '结合面试场景再看';
    const advice = r.advice || '可结合试穿效果调整';
    const lead = strengths.length ? `我先说结论：这套整体可以，${strengths[0]}。` : '我认真看了照片里的搭配。';
    const risk = risks.length ? `有一点可调整：${risks[0]}。` : '我没有硬挑毛病，整体协调。';
    window.addMessage(`${lead}${risk}关于面试适配：${fit}建议：${advice}（照片光线角度可能影响判断，到店内自然光再确认）`, 'assistant');
  }

  function replyBrowse() {
    window.addMessage('好呀，你先按自己的节奏逛。我不主动打扰；看中哪件时，随时拍下来或从相册选图发给我，我们一起聊。想让我帮你挑面试穿搭的话，直接说岗位和预算就行。', 'assistant');
  }

  function askForMissingField(picked) {
    const field = Reco.nextMissingField ? Reco.nextMissingField(sessionState) : null;
    const hints = {
      occasion: '你准备参加什么类型的面试呀？比如互联网产品、传统行业，还是创意设计？',
      budget_max: '这次面试穿搭大概想控制在多少预算内？直接说个数字就好，比如 800。',
      top_size: '你平时上衣穿什么码？（M / L / S 都可以；不知道就说“帮我估”）',
      bottom_size: '裤装或裙装你一般穿什么码？（M / L / S；不知道就直接说）'
    };
    const pickedText = picked && picked.length ? `（我已记下：${picked.join('、')}）` : '';
    const tip = field && hints[field.key] ? hints[field.key] : '还想多了解一点你的偏好，再帮你挑。';
    window.addMessage(`好的，我只问几项和推荐有关的信息${pickedText}。${tip}`, 'assistant');
  }

  function showLocalRecommendations(intro) {
    const outfits = Reco.recommendOutfits ? Reco.recommendOutfits(localCatalog, sessionState) : [];
    if (!outfits.length) {
      window.addMessage('我这边暂时没有加载到商品资料，照片穿搭建议仍然可以继续聊。', 'assistant');
      return;
    }
    sessionState.resolvedOutfits = outfits;
    sessionState.recommended = true;
    const article = window.addMessage(intro || `我按你的需求（${summaryState()}）先挑 ${outfits.length} 套方向，都在预算内：`, 'assistant');
    const block = document.createElement('div');
    block.className = 'recommendation-block';
    outfits.forEach((o, i) => {
      const card = document.createElement('article');
      card.className = 'chat-product-card outfit-card';
      const itemsHtml = o.items.map(it => {
        const p = it.product;
        const img = p.image
          ? `<img src="${window.escapeHtml(p.image)}" alt="${window.escapeHtml(p.name)}" loading="lazy"/>`
          : `<div class="chat-product-placeholder" style="background:${window.escapeHtml(p.gradient || 'linear-gradient(145deg,#e5ddd3,#b8aa9a)')}"><span>图片待补充</span></div>`;
        const sub = it.substituted ? ' · 替补款' : '';
        return `<div class="outfit-item"><div class="outfit-thumb">${img}</div><small>${window.escapeHtml(p.name)}（${window.escapeHtml(p.color)}·${window.escapeHtml(it.size || '')}）${sub}</small></div>`;
      }).join('');
      const subs = o.substitutions && o.substitutions.length
        ? `<small class="outfit-sub">⚠️ ${window.escapeHtml(o.substitutions.join('；'))}</small>` : '';
      card.innerHTML =
        `<div class="outfit-head"><strong>${window.escapeHtml(o.name)}</strong><span>合计 ¥${o.totalPrice}</span></div>` +
        `<div class="outfit-items">${itemsHtml}</div>` +
        `<p class="outfit-reason">${window.escapeHtml(o.reasons || '')}</p>${subs}` +
        `<div class="recommendation-actions">` +
        `<button class="inline-action" data-outfit="${i}">选这套</button>` +
        `<button class="inline-action" data-loc="${i}">看位置</button>` +
        `<button class="inline-action" data-list="${i}">生成清单</button>` +
        `</div>`;
      block.appendChild(card);
    });
    const tail = document.createElement('div');
    tail.className = 'recommendation-actions';
    tail.innerHTML =
      '<button class="inline-action" data-message="这两套有什么区别？">对比一下</button>' +
      '<button class="inline-action" data-message="我想换个更轻松的风格">换风格</button>' +
      '<button class="inline-action" data-message="预算降到600">调预算</button>';
    block.appendChild(tail);
    article.querySelector('.message-content').appendChild(block);
    window.scrollToLatest();
  }

  function showLocalInventory(outfit, route) {
    const target = outfit || currentSelectedOutfit() || sessionState.resolvedOutfits[0];
    if (!target) { window.addMessage('先选一套搭配，我再帮你查尺码和货架位置～', 'assistant'); return; }
    const inv = Reco.checkInventory ? Reco.checkInventory(localCatalog, target, sessionState) : [];
    const lines = inv.map(it => {
      const stock = it.inSizeStock > 0 ? `${it.size} 码有货` : `${it.size} 码暂缺`;
      return `${it.name}（${it.color}）：${stock}，在 ${it.location.floor} ${it.location.zone}；其他有货尺码 ${it.availableSizes.join('/') || '无'}`;
    });
    const article = addMessageLines(`这套的尺码与货架（演示数据，实际以门店为准）：`, lines);
    if (route) {
      const routeEl = document.createElement('div');
      routeEl.className = 'mini-route';
      const zones = [...new Set(inv.map(i => `${i.location.floor} ${i.location.zone}`))];
      routeEl.innerHTML = `<span>你在这里</span><i>→</i><b>${zones.join('</b><i>→</i><b>')}</b>`;
      article.querySelector('.message-content').appendChild(routeEl);
    }
  }

  function showLocalShoppingList(outfit) {
    const target = outfit || currentSelectedOutfit() || sessionState.resolvedOutfits[0];
    if (!target) { window.addMessage('先选一套搭配，我再帮你生成购买清单～', 'assistant'); return; }
    const list = Reco.buildShoppingList ? Reco.buildShoppingList(target, sessionState) : { items: [], extras: [], total: 0, overBudget: false };
    const lines = list.items.map(it => `${it.name}｜${it.color}｜${it.size}｜¥${it.price}｜${it.location.floor}${it.location.zone}${it.stock > 0 ? '｜有货' : '｜缺货'}`);
    const article = addMessageLines(`购买清单（演示数据，总价 ¥${list.total}）：${list.overBudget ? '⚠️ 超出预算，可换更省的搭配' : ''}`, lines);
    if (list.extras && list.extras.length) {
      const ex = document.createElement('small');
      ex.className = 'reco-extra';
      ex.textContent = '可选加购：' + list.extras.map(e => `${e.name} ¥${e.price}`).join('、');
      article.querySelector('.message-content').appendChild(ex);
    }
  }

  function showLocalComparison() {
    const os = sessionState.resolvedOutfits.slice(0, 2);
    if (os.length < 2) { window.addMessage('目前只推荐出一套，先帮你生成更多方向再对比～', 'assistant'); return; }
    const [a, b] = os;
    window.addMessage(
      `两套对比：\n① ${a.name} ¥${a.totalPrice}｜${a.style}｜${a.occasion_tags.join('/')}\n` +
      `② ${b.name} ¥${b.totalPrice}｜${b.style}｜${b.occasion_tags.join('/')}\n` +
      `按你“专业但不要太严肃”，${a.totalPrice <= b.totalPrice ? a.name : b.name} 更稳妥也更省，但 ${b.name} 更轻松。最终看你试穿感觉。`,
      'assistant'
    );
  }

  // 离线主入口：覆写 app.js 的全局 replyTo。
  function runLocalAgent(message) {
    const m = String(message || '').trim();

    if (/我(?:美|漂亮|好看)|你觉得我|我看起来/.test(m)) return replyAppearanceOffline();

    // 照片已分析且用户在聊这套穿搭
    if (window.photoAnalysisState === 'ready' && /这套|照片|适合|调整|颜色|穿|搭配|看看/.test(m)) {
      return replyPhotoOffline();
    }

    // 自由浏览分支
    if (sessionState.mode === 'browse' && !/面试|推荐|帮我挑|搭配|帮我看|挑一套/.test(m)) return replyBrowse();
    if (/自己逛|先看看|自己看看|随便逛|我自己逛/.test(m)) { sessionState.mode = 'browse'; return replyBrowse(); }

    // 进入推荐模式
    sessionState.mode = 'recommendation';
    const picked = Reco.parseUserNeed ? Reco.parseUserNeed(m, sessionState) : [];

    if (!Reco.isReadyToRecommend || !Reco.isReadyToRecommend(sessionState)) return askForMissingField(picked);

    if (/对比|区别|差别|哪个好|怎么选|第一.*第二/.test(m)) return showLocalComparison();
    if (/位置|哪里|怎么走|楼层|路线|在.*楼/.test(m)) return showLocalInventory(null, true);
    if (/尺码|库存|有.*码|有没有货|缺货/.test(m)) return showLocalInventory(null, false);
    if (/换|不喜欢|轻松|预算|便宜|贵|风格|颜色|再来|再推荐/.test(m)) {
      sessionState.selectedOutfitId = null;
      return showLocalRecommendations('好，我按你最新的偏好重新挑几套～');
    }
    if (/清单|买下|购买|整理|下单/.test(m)) {
      const outfit = currentSelectedOutfit() || sessionState.resolvedOutfits[0];
      return showLocalShoppingList(outfit);
    }
    if (!sessionState.recommended) return showLocalRecommendations();

    window.addMessage(`我听到了：“${m}”。你想看哪一套的货架位置、确认尺码库存，还是想调整预算或风格我再帮你换？也可以把试穿照片发我，我结合照片给你更具体的建议。`, 'assistant');
  }

  // 接管离线对话分支
  window.replyTo = runLocalAgent;

  // 卡片按钮（选这套 / 看位置 / 生成清单）——在 app.js 既有监听之外叠加，互不冲突。
  const chatEl = document.getElementById('chatScroll');
  if (chatEl) {
    chatEl.addEventListener('click', event => {
      const outfitBtn = event.target.closest('[data-outfit]');
      if (outfitBtn) {
        const i = Number(outfitBtn.dataset.outfit);
        const o = sessionState.resolvedOutfits[i];
        if (o) { sessionState.selectedOutfitId = o.id; showLocalShoppingList(o); }
        return;
      }
      const locBtn = event.target.closest('[data-loc]');
      if (locBtn) { showLocalInventory(sessionState.resolvedOutfits[Number(locBtn.dataset.loc)], true); return; }
      const listBtn = event.target.closest('[data-list]');
      if (listBtn) { showLocalShoppingList(sessionState.resolvedOutfits[Number(listBtn.dataset.list)]); return; }
    });
  }

  console.info('[local-agent] 离线兜底导购已挂载；无魔珐凭证时由本地引擎驱动推荐闭环。');
})();
