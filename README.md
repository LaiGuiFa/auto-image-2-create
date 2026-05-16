# Image Workspace

基于模型商 URL 和 API Key 的生图工作台。

项目提供：

- 多供应商生图配置，由服务端环境变量统一下发
- 同步/异步生图
- 参考图上传
- 本地历史记录与配置复用
- Prompt 润色弹窗和 DeepSeek 一键润色
- 可选代理转发，按供应商能力和 URL 匹配规则生效

## 运行

先安装依赖，再启动本地 Node 服务：

```bash
npm install
npm start
```

默认访问地址：

```text
http://127.0.0.1:8000
```

不要直接双击打开 `index.html`，需要通过 Node 服务运行。

## 环境变量

项目启动时会自动读取根目录 `.env` 文件。可以先复制 [`.env.example`](/E:/github/image2/.worktrees/provider-proxy-polish/.env.example:1) 作为模板。

### 基础配置

- `PORT`：服务端端口，默认 `8000`
- `REQUEST_TIMEOUT_MS`：上游请求超时，默认 `300000`
- `UPLOAD_RETENTION_DAYS`：上传目录保留天数，默认 `7`

### 生图供应商配置

- `IMAGE_DEFAULT_PROVIDER_ID`：默认供应商 id
- `IMAGE_PROVIDERS_JSON`：供应商列表，必须是 JSON 数组

每个供应商对象支持这些字段：

- `id`：唯一标识
- `label`：前端展示名称
- `baseUrl`：供应商基础地址
- `syncPath`：同步生图路径
- `asyncPath`：异步生图路径；`supportsAsync=true` 时必填
- `pollPathBase`：异步轮询路径前缀；`supportsAsync=true` 时必填
- `supportsAsync`：是否支持异步

示例：

```env
IMAGE_DEFAULT_PROVIDER_ID=openai
```

### DeepSeek 润色配置

- `DEEPSEEK_URL`：聊天接口地址
- `DEEPSEEK_API_KEY`：API Key
- `DEEPSEEK_MODEL`：模型名
- `DEEPSEEK_POLISH_SYSTEM_PROMPT`：服务端拼接到用户提示词前的润色系统提示词

如果这四项有任意一项为空，前端仍会显示润色入口，但一键润色会返回“润色服务未配置”。

## 当前实现约束

- API Key 按供应商维度保存在浏览器本地
- 代理开关只在供应商声明支持代理、且请求 URL 匹配供应商 `baseUrl` 时生效
- 不支持异步的供应商会在前端禁用异步相关行为
- 上传目录会在服务启动时清理 7 天前文件，并保留 `uploads/.gitignore`

## 目录

```text
index.html
server/
assets/js/
assets/css/
test/
uploads/
```

## License

MIT
