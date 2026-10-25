/**
 * 衣见如故 · 本地兜底导购引擎（与 DOM 无关，浏览器 / Node 通用）
 *
 * 设计目标：当没有魔珐星云凭证、无法走云端 Agent 时，前端依旧能跑通
 * 「需求采集 -> 按预算/风格/尺码筛选 -> 推荐 2-3 套搭配 -> 库存货架查询 ->
 * 生成购买清单」的完整闭环。这样评审者即使没有外部密钥，也能本地启动项目
 * 复现主流程（满足 MVP_SPEC 的「可运行、可测试」标准）。
 *
 * 该模块不碰任何浏览器 API，纯函数 + 数据，可在 node:test 下被直接测试。
 * 浏览器环境挂到 window.YijianReco，Node 环境通过 module.exports 暴露。
 */

// ---------- 基础工具 ----------

function getProduct(catalog, id) {
  return catalog.products.find(p => p.id === id) || null;
}

function slotSizeKey(slot, state) {
  // 外套与上装跟随 top_size，裤装/裙装跟随 bottom_size；鞋与配饰只查是否有货。
  if (slot === 'outer' || slot === 'top') return state.top_size;
  if (slot === 'bottom') return state.bottom_size;
  return null;
}

function stockFor(product, size) {
  if (!product || !product.size_stock) return 0;
  if (size == null) {
    // 鞋/配饰：只要任一尺码有货即视为可售。
    return Object.values(product.size_stock).some(n => Number(n) > 0) ? 1 : 0;
  }
  return Number(product.size_stock[size] || 0);
}

function containsAny(list, candidates) {
  if (!Array.isArray(list) || !Array.isArray(candidates)) return false;
  return candidates.some(c => list.some(item => String(item).includes(c) || c.includes(item)));
}

// ---------- 需求采集状态机 ----------

const COLLECTION_FIELDS = [
  { key: 'occasion', label: '面试场合或岗位', example: '互联网公司产品经理面试' },
  { key: 'budget_max', label: '预算上限', example: '800' },
  { key: 'top_size', label: '上衣尺码', example: 'M' },
  { key: 'bottom_size', label: '裤装/裙装尺码', example: 'L' }
];

/**
 * 返回还需要采集的关键字段；集齐后才允许进入推荐。
 * 自由浏览模式不要求任何个人字段（由调用方控制是否调用本函数）。
 */
function nextMissingField(state) {
  for (const field of COLLECTION_FIELDS) {
    const value = state[field.key];
    if (field.key === 'budget_max') {
      if (value == null || Number(value) <= 0) return field;
    } else if (!value) {
      return field;
    }
  }
  return null;
}

function isReadyToRecommend(state) {
  return nextMissingField(state) === null;
}

/**
 * 把一句自由文本尽量解析进 state；返回本次识别到的字段摘要（用于回显）。
 * 只做轻量启发式，绝不臆测缺失信息。
 */
function parseUserNeed(text, state) {
  const t = String(text || '');
  const picked = [];
  if (/\d+\s*元|预算|￥|¥/i.test(t)) {
    const m = t.match(/(\d{2,5})\s*元?/);
    if (m && state.budget_max == null) {
      state.budget_max = Number(m[1]);
      picked.push(`预算 ¥${state.budget_max}`);
    }
  }
  if (/面试|岗位|行业|求职|校招|社招/i.test(t) && state.occasion == null) {
    state.occasion = t.replace(/[，。,.\s]/g, ' ').trim().slice(0, 40);
    picked.push('面试场合');
  }
  const sizeMatch = t.match(/([SMLXL]+)\s*码|尺码\s*([SMLXL]+)/i);
  if (sizeMatch) {
    const size = (sizeMatch[1] || sizeMatch[2]).toUpperCase();
    if (state.top_size == null) { state.top_size = size; picked.push(`上衣 ${size} 码`); }
    else if (state.bottom_size == null) { state.bottom_size = size; picked.push(`下装 ${size} 码`); }
  }
  if (/正式|严肃|传统/i.test(t)) state.style_preference = mergeTags(state.style_preference, ['正式']);
  if (/休闲|轻松|亲和|不那么严肃/i.test(t)) state.style_preference = mergeTags(state.style_preference, ['商务休闲', '亲和']);
  if (/黑/i.test(t) && /(不|别|排除|不要).*黑|不喜.*黑/i.test(t)) {
    state.excluded_colors = mergeTags(state.excluded_colors, ['黑', '纯黑']);
  }
  return picked;
}

function mergeTags(list, add) {
  const base = Array.isArray(list) ? list.slice() : [];
  add.forEach(t => { if (!base.includes(t)) base.push(t); });
  return base;
}

// ---------- 推荐引擎 ----------

/**
 * 依据会话状态筛选并解析出可推荐的搭配（最多 3 套）。
 * 处理：场合匹配、风格重合、排除色、预算、尺码缺货自动替换。
 */
function recommendOutfits(catalog, state) {
  const budget = Number(state.budget_max || Infinity);
  const stylePref = Array.isArray(state.style_preference) ? state.style_preference : [];
  const excluded = Array.isArray(state.excluded_colors) ? state.excluded_colors : [];

  const candidates = (catalog.outfits || []).filter(o => {
    // 场合：搭配的场合标签命中用户场合，或用户未指定场合。
    if (state.occasion && o.occasion_tags && o.occasion_tags.length) {
      if (!fuzzyOccasionMatch(state.occasion, o.occasion_tags)) return false;
    }
    // 排除色：任一核心单品命中排除色则整组淘汰。
    const coreColors = o.core.map(id => getProduct(catalog, id)).filter(Boolean).map(p => p.color);
    if (containsAny(coreColors, excluded)) return false;
    return true;
  });

  const resolved = [];
  for (const o of candidates) {
    const r = resolveOutfit(catalog, o, state);
    if (!r) continue;
    // 预算：核心三件总价需 <= 预算；风格偏好做软排序，不硬淘汰。
    if (r.totalPrice > budget) {
      r.overBudget = true;
    }
    r.styleMatch = stylePref.length ? containsAny(o.style_tags || [], stylePref) : true;
    resolved.push(r);
  }

  resolved.sort((a, b) => {
    if (a.overBudget !== b.overBudget) return a.overBudget ? 1 : -1; // 不超预算优先
    if (a.styleMatch !== b.styleMatch) return a.styleMatch ? -1 : 1; // 风格更贴合优先
    return a.totalPrice - b.totalPrice; // 更省优先
  });

  const inBudget = resolved.filter(r => !r.overBudget).slice(0, 3);
  return inBudget.length ? inBudget : resolved.slice(0, 3);
}

function fuzzyOccasionMatch(userOccasion, tags) {
  const u = String(userOccasion);
  const map = {
    传统: ['传统行业', '传统正式', '金融', '国企', '银行', '法律'],
    互联网: ['互联网', '产品', '技术', '科技', '创业'],
    创意: ['创意', '设计', '传媒', '艺术', '广告'],
    商务: ['商务', '销售', '市场']
  };
  for (const [k, aliases] of Object.entries(map)) {
    if (u.includes(k) && tags.some(tag => aliases.includes(tag) || tag.includes(k))) return true;
  }
  // 没有明确关键词时，只要搭配覆盖「商务休闲/正式」这类通用场合即放行。
  return tags.some(tag => /正式|商务|通用/.test(tag));
}

/**
 * 解析一套搭配的尺码与缺货替换；若核心单品在所需尺码无货且无法替换，返回 null。
 */
function resolveOutfit(catalog, outfit, state) {
  const items = [];
  const substitutions = [];
  for (const id of outfit.core) {
    const product = getProduct(catalog, id);
    if (!product) return null;
    const size = slotSizeKey(product.slot, state);
    let stock = stockFor(product, size);
    let resolvedProduct = product;
    if (stock <= 0 && size != null) {
      // 尝试同槽位、风格相近、所需尺码有货的替代款。
      const alt = findAlternative(catalog, product, state);
      if (!alt) return null; // 缺货且无替代 -> 整组不可推荐
      resolvedProduct = alt;
      stock = stockFor(alt, size);
      substitutions.push({ from: product.name, to: alt.name, reason: `${product.name} 的 ${size} 码当前无货，已替换为同风格有货的 ${alt.name}` });
    }
    items.push({
      product: resolvedProduct,
      size,
      stock,
      location: resolvedProduct.location,
      substituted: resolvedProduct.id !== product.id
    });
  }
  const totalPrice = items.reduce((sum, it) => sum + Number(it.product.price || 0), 0);
  return {
    id: outfit.id,
    name: outfit.name,
    style: outfit.style,
    occasion_tags: outfit.occasion_tags,
    style_tags: outfit.style_tags,
    items,
    totalPrice,
    reasons: outfit.reasons,
    substitutions,
    optionalShoes: outfit.optional_shoes ? getProduct(catalog, outfit.optional_shoes) : null,
    optionalAccessory: outfit.optional_accessory ? getProduct(catalog, outfit.optional_accessory) : null
  };
}

function findAlternative(catalog, product, state) {
  const size = slotSizeKey(product.slot, state);
  return catalog.products.find(p =>
    p.id !== product.id &&
    p.slot === product.slot &&
    (p.style_tags || []).some(tag => (product.style_tags || []).includes(tag)) &&
    stockFor(p, size) > 0
  ) || null;
}

// ---------- 库存与货架 ----------

function checkInventory(catalog, outfit, state) {
  if (!outfit) return [];
  return outfit.items.map(it => {
    const p = it.product;
    const size = it.size;
    const inSize = size != null ? Number(p.size_stock?.[size] || 0) : 0;
    const anySize = Object.entries(p.size_stock || {})
      .filter(([, n]) => Number(n) > 0)
      .map(([s]) => s);
    return {
      name: p.name,
      color: p.color,
      size,
      inSizeStock: inSize,
      availableSizes: anySize,
      location: p.location,
      needsSubstitute: inSize <= 0 && size != null
    };
  });
}

// ---------- 购买清单 ----------

function buildShoppingList(outfit, state) {
  if (!outfit) return { items: [], total: 0, overBudget: false };
  const budget = Number(state.budget_max || Infinity);
  const listItems = outfit.items.map(it => ({
    name: it.product.name,
    color: it.product.color,
    size: it.size,
    price: Number(it.product.price || 0),
    stock: it.stock,
    location: it.product.location,
    substituted: it.substituted
  }));
  // 把推荐鞋/配饰一并纳入可选清单（不强制计入预算上限判断）。
  const extras = [];
  if (outfit.optionalShoes) extras.push({ name: outfit.optionalShoes.name, color: outfit.optionalShoes.color, size: '(按试穿)', price: Number(outfit.optionalShoes.price || 0), stock: 1, location: outfit.optionalShoes.location, substituted: false });
  if (outfit.optionalAccessory) extras.push({ name: outfit.optionalAccessory.name, color: outfit.optionalAccessory.color, size: '(通用)', price: Number(outfit.optionalAccessory.price || 0), stock: 1, location: outfit.optionalAccessory.location, substituted: false });

  const total = listItems.reduce((s, i) => s + i.price, 0);
  return {
    items: listItems,
    extras,
    total,
    overBudget: total > budget,
    budget
  };
}

// ---------- 尺码估算（仅作试穿建议，绝不评价外貌） ----------

function estimateSize({ heightCm, weightKg } = {}) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!h || !w) return { size: null, note: '身高体重不足，无法估算；建议直接试穿或手动选择尺码。' };
  // 极简经验区间，仅作演示，不替代品牌尺码表。
  let size = 'M';
  if (h >= 168 && w >= 60) size = 'L';
  if (h >= 175) size = 'L';
  if (h < 160) size = 'S';
  return { size, note: `根据身高 ${h}cm / 体重 ${w}kg 的粗略估算，可先试 ${size} 码；以实际试穿和品牌尺码表为准。` };
}

// ---------- 导出 ----------

const API = {
  getProduct,
  stockFor,
  nextMissingField,
  isReadyToRecommend,
  parseUserNeed,
  recommendOutfits,
  checkInventory,
  buildShoppingList,
  estimateSize,
  COLLECTION_FIELDS
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.YijianReco = API;
}
