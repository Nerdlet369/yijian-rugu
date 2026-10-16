# 衣见如故：面试穿搭私人数字导购

这是一个基于魔珐星云具身交互智能 SDK 的面试穿搭导购原型。用户可以通过文字或语音与数字人“小衣”交流，获取穿搭建议、查看参考图片，并上传照片获得有边界的视觉分析。

## 已实现

- 真实数字人连接、文字对话、语音识别和播报打断
- 拍照或从相册选择图片
- 视觉模型分析服装颜色、版型、面试适配度和搭配建议
- 多轮上下文承接和朋友式表达
- 演示商品参考图和位置说明

## 本地运行

1. 复制 `.env.example` 为 `.env`，填写视觉模型 API Key。
2. 在项目根目录运行：

```powershell
node server.js
```

3. 浏览器打开 `http://localhost:8081/`。
4. 点击“连接数字人”，在页面内填写魔珐星云 App ID 和 App Secret。

也可以使用 Docker Compose：

```powershell
docker compose up --build
```

## 目录说明

- `prototype/`：前端页面、数字人 SDK 接入和商品演示数据
- `server.js`：静态页面服务和照片视觉分析接口
- `DEMO_SCRIPT.md`：完整演示脚本与当前能力边界
- `MVP_SPEC.md`、`PROJECT_BRIEF.md`：产品和技术说明

商品、价格、库存和货架位置目前为演示数据，不代表真实门店系统。不要提交 `.env`、API Key 或 App Secret。
