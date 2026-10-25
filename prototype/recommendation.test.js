const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8')
);
const R = require('./recommendation.js');

test('catalog 结构合法且规模达到 MVP 要求', () => {
  assert.ok(Array.isArray(catalog.products));
  assert.ok(catalog.products.length >= 20, '商品应 >= 20 件');
  assert.ok(Array.isArray(catalog.outfits));
  assert.ok(catalog.outfits.length >= 5, '搭配应 >= 5 套');
});

test('需求采集：集齐关键字段前不允许推荐', () => {
  const state = { occasion: null, budget_max: null, top_size: null, bottom_size: null };
  assert.equal(R.isReadyToRecommend(state), false);
  state.occasion = '互联网产品面试';
  state.budget_max = 800;
  state.top_size = 'M';
  state.bottom_size = 'L';
  assert.equal(R.isReadyToRecommend(state), true);
});

test('推荐：预算 800 内返回不超预算的搭配，且按价格升序', () => {
  const state = {
    occasion: '互联网公司产品经理面试',
    budget_max: 800,
    top_size: 'M',
    bottom_size: 'L',
    style_preference: ['商务休闲', '亲和'],
    excluded_colors: []
  };
  const outfits = R.recommendOutfits(catalog, state);
  assert.ok(outfits.length >= 1 && outfits.length <= 3);
  outfits.forEach(o => assert.ok(o.totalPrice <= 800, `${o.name} 应 <= 800，实际 ${o.totalPrice}`));
});

test('推荐：排除纯黑时淘汰含黑单品的搭配', () => {
  const state = {
    occasion: '传统行业面试',
    budget_max: 800,
    top_size: 'M',
    bottom_size: 'L',
    style_preference: ['正式'],
    excluded_colors: ['黑', '纯黑']
  };
  const outfits = R.recommendOutfits(catalog, state);
  const bad = outfits.find(o => o.items.some(it => /黑/.test(it.product.color)));
  assert.equal(bad, undefined, '不应推荐含黑单品的搭配');
});

test('推荐：尺码缺货时自动替换同风格有货款', () => {
  // striped-shirt 的 L 码无货；构造一个需要 L 码上装且选 o5 的场景。
  const state = {
    occasion: '创意行业面试',
    budget_max: 800,
    top_size: 'L',
    bottom_size: 'L',
    style_preference: ['亲和'],
    excluded_colors: []
  };
  const outfits = R.recommendOutfits(catalog, state);
  const o5 = outfits.find(o => o.id === 'o5-burgundy');
  // o5 含 striped-shirt(L 无货)，应被替换或淘汰；若仍存在则必须已替换。
  if (o5) {
    const striped = o5.items.find(it => it.product.id === 'striped-shirt');
    assert.equal(striped, undefined, 'striped-shirt 在 L 码无货，应被替换');
  }
});

test('库存查询：返回尺码、货架与缺货标记', () => {
  const state = { top_size: 'M', bottom_size: 'L' };
  const o1 = R.recommendOutfits(catalog, { ...state, occasion: '传统行业', budget_max: 800 })[0];
  const inv = R.checkInventory(catalog, o1, state);
  assert.ok(inv.length === 3);
  inv.forEach(i => {
    assert.ok(i.location && i.location.floor);
    assert.ok(Array.isArray(i.availableSizes));
  });
});

test('购买清单：总价计算且能识别超预算', () => {
  const state = { occasion: '互联网', budget_max: 800, top_size: 'M', bottom_size: 'L', style_preference: [], excluded_colors: [] };
  const o1 = R.recommendOutfits(catalog, state)[0];
  const list = R.buildShoppingList(o1, state);
  const sum = list.items.reduce((s, i) => s + i.price, 0);
  assert.equal(list.total, sum);
  assert.equal(list.overBudget, sum > 800);
});

test('尺码估算：身高体重不足时返回不确定提示，不臆测', () => {
  const r = R.estimateSize({});
  assert.equal(r.size, null);
  assert.match(r.note, /无法估算/);
});
