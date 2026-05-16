# Image Workspace

一个轻量的图片生成工作台。

项目本质是通过配置接口 URL 和 API Key 调用生图模型，并在前端完成参数设置、任务展示、历史记录和大图预览。前端记录保存在本地 `IndexedDB`，不依赖业务数据库。

---

## 功能

- 支持同步生图与异步生图
- 支持参考图上传
- 支持比例、像素预设与自定义尺寸
- 支持输出格式与压缩率设置
- 支持本地历史记录与配置复用
- 支持图片灯箱预览
- 支持 Token 用量统计

---

## 使用

1. 安装依赖后运行本地 Node 服务，不要直接用静态预览打开 `index.html`
2. 按需修改 [assets/js/config.js](/E:/github/image2/assets/js/config.js:1) 中的接口地址
3. 打开页面，在设置中填入可用的 API Key
4. 输入 Prompt、选择参数后开始生成

在项目目录执行：

```bash
npm install
npm start
```

然后访问 `http://127.0.0.1:8000`。

---

## 部署

本地默认由 Node 服务托管静态文件和接口：

```text
index.html      入口页面
server/         Node 服务与接口代理
assets/js/      原生 ES Module
assets/css/     页面样式
release.json    版本更新说明
```

## License

MIT
