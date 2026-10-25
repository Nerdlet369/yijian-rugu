# 衣见如故：面试穿搭私人数字导购

这是一个基于魔珐星云具身交互智能 SDK 的面试穿搭导购原型。用户可以通过文字或语音与数字人“小衣”交流，获取穿搭建议、查看参考图片，并上传照片获得有边界的视觉分析。

> ⚠️ **运行依赖（参赛 / 演示前必读）**
>
> 本项目有两层能力，依赖不同：
>
> 1. **真实数字人 + 视觉分析**：需要自备 **魔珐星云 App ID / App Secret**（在 `prototype/index.html` 内点击“连接数字人”填写，仅存在页面内存，不落盘），以及 **可用的视觉模型接口**。
>    - `server.js` 默认通过第三方中转 `https://code1.newcli.com` 调用模型 `gpt-6.1-sol`。**该中转与模型名不属于官方 OpenAI，稳定性不保证**，演示或评审前请改为你自己的可用 endpoint：复制 `.env.example` 为 `.env`，设置 `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`（官方接口填 `https://api.openai.com`）。
> 2. **本地兜底导购（无需任何外部密钥）**：见下方“已实现”第 6 条。即使没有魔珐凭证和视觉模型，评审者也能在本地启动项目，跑通「需求采集 → 按预算/风格/尺码筛选 → 推荐 2-3 套搭配 → 库存货架查询 → 生成购买清单」的完整闭环。这是满足可复现、可测试要求的关键。

## 已实现

- 真实数字人连接、文字对话、语音识别和播报打断
- 拍照或从相册选择图片
- 视觉模型分析服装颜色、版型、面试适配度和搭配建议（服务端调用，API Key 不进浏览器）
- 多轮上下文承接和朋友式表达
- 演示商品参考图和位置说明
- **本地兜底导购引擎**：零外部依赖，依据模拟商品目录与用户预算/风格/尺码，自动筛选、推荐、查库存货架、生成购买清单；缺货自动替换同风格有货款；支持试穿照片承接。无魔珐凭证时由 `local-agent.js` 接管对话分支。

## 本地运行

1. 复制 `.env.example` 为 `.env`，填写视觉模型 API Key（**仅在使用真实视觉分析时需要**；纯本地演示可跳过）。
2. 在项目根目录运行：

```powershell
node server.js
```

3. 浏览器打开 `http://localhost:8081/`。
4. 若要启用真实数字人，点击“连接数字人”，在页面内填写魔珐星云 App ID 和 App Secret；**不填也能直接进入本地兜底导购流程**。

也可以使用 Docker Compose：

```powershell
docker compose up --build
```

## 目录说明

- `prototype/`：前端页面、数字人 SDK 接入、本地兜底导购与商品演示数据
  - `index.html` / `app.js` / `styles.css` / `chat.css`：主界面与数字人交互
  - `recommendation.js`：与 DOM 无关的推荐 / 库存 / 清单引擎（浏览器与 Node 通用，可被测试）
  - `local-agent.js`：离线兜底 Agent，覆写无凭证时的对话分支，跑通推荐闭环
  - `catalog.json`：模拟商品目录（v3，含 25 件商品、8 套搭配、价格/尺码库存/货架位置/风格标签）
  - `recommendation.test.js`：`node --test` 覆盖引擎逻辑
- `server.js`：静态页面服务和照片视觉分析接口（含 JSON 降级重试、拒答检测、结构化解析与输入校验）
- `server.test.js`：视觉分析解析 / 校验单测
- `DEMO_SCRIPT.md`：完整演示脚本与当前能力边界
- `MVP_SPEC.md`、`PROJECT_BRIEF.md`：产品和技术说明

## 测试

```powershell
cd prototype
node --test recommendation.test.js
cd ..
node --test server.test.js
```

商品、价格、库存和货架位置目前为演示数据，不代表真实门店系统。不要提交 `.env`、API Key 或 App Secret。

> 备注：仓库根目录的 `demo.mp4` 与 `演示视频.mp4` 是同一文件的两个副本（内容一致），建议删除其中一个以免重复占用体积：`git rm demo.mp4`（删除不影响演示，二者内容相同）。
