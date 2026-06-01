# 创意工坊

当前版本：`1.6.1`

一个面向图片生成场景的本地工作台，支持多 Provider 配置、同步/异步生图、参考图生图、Prompt 润色、历史记录、收藏面板和图片详情查看。此外，项目提供了专为 Agent（如 OpenClaw）设计的解耦生图 Skill 模块。

## 界面预览

### 主界面

![主界面](screenshot/%E4%B8%BB%E7%95%8C%E9%9D%A2.png)

### 历史记录

![历史记录](screenshot/%E5%8E%86%E5%8F%B2%E8%AE%B0%E5%BD%95.png)

### 图片详情

![图片详情](screenshot/%E5%9B%BE%E7%89%87%E8%AF%A6%E6%83%85.png)

## 功能概览

- 多 Provider 统一配置，由服务端通过环境变量下发可用 Provider 列表
- 同步生图与异步生图两种模式
- 参考图上传与参考图生图
- Prompt 润色弹窗，支持接入 DeepSeek 一键润色
- 本地历史记录面板与历史弹窗
- 历史记录支持按原始提示词模糊搜索，不改变默认展示顺序
- 本地收藏能力，收藏文件保存到 `collection/`
- 图片详情弹窗，可查看 Prompt、改写后 Prompt、参数、分辨率和生成时长
- 图片卡片和详情页支持下载，若在设置中指定保存路径则写入本地绝对路径
- 系统公告 / 版本更新弹窗
- 服务端代理转发、超时控制、异步轮询和 SSE 透传

## 界面能力

### 生图模式

- `同步生图`
  - 适合直接等待结果返回
  - 支持输出格式、压缩级别、实验性流式输出
  - 单次最多 `10` 张
- `异步生图`
  - 适合长耗时任务
  - 提交后后台轮询任务结果
  - 单次最多 `4` 张
  - 可恢复未完成任务

### 参考图

- 支持上传 `JPG / JPEG / PNG`
- 单张不超过 `5MB`
- 异步模式下最多 `10` 张参考图
- 同步模式下最多 `1` 张参考图
- 历史记录中的图片也可以重新加入参考图列表

### 历史记录与收藏

- 右侧提供“历史记录”和“我的收藏”两个面板
- 历史记录支持按原始提示词搜索、打开详情、下载、应用配置、添加为参考图
- 收藏图片保存在本地 `collection/` 目录，并通过 `collection/manifest.json` 管理
- 收藏列表按文件名时间倒序排列，最新收藏优先显示
- 收藏查看全部时支持左右翻页查看

### 图片详情

- 查看当前记录的原始 Prompt
- 查看上游改写后的 Prompt（如果存在且不同）
- 查看请求参数与实际上游参数
- 查看分辨率和生成时长
- 多图记录支持在详情弹窗内左右切换

## 本地运行

先安装依赖，再启动本地 Node 服务：

```bash
npm install
npm start
```

默认访问地址：

```text
http://127.0.0.1:8000
```

不要直接双击打开 `index.html`。当前项目依赖本地 Node 服务提供：

- `/api/image/sync`
- `/api/image/async`
- `/api/image/poll`
- `/api/polish`
- `/api/upload`
- `/api/collection`

## 环境变量

项目启动时会自动读取根目录 `.env` 文件。建议先复制 [.env.example](/E:/github/image2/.env.example:1) 作为模板。

### 基础配置

- `PORT`：服务端端口，默认 `8000`
- `REQUEST_TIMEOUT_MS`：上游请求超时，默认 `300000`
- `UPLOAD_RETENTION_DAYS`：上传目录保留天数，默认 `7`

### 图片 Provider 配置

- `IMAGE_DEFAULT_PROVIDER_ID`：默认 Provider 的 `id`
- `IMAGE_PROVIDERS_JSON`：Provider 列表，必须是 JSON 数组

每个 Provider 支持这些字段：

- `id`：唯一标识
- `label`：前端显示名称
- `baseUrl`：Provider 基础地址
- `syncPath`：同步生图接口路径
- `editPath`：参考图编辑接口路径
- `asyncPath`：异步生图接口路径；`supportsAsync=true` 时必填
- `pollPathBase`：异步轮询路径前缀；`supportsAsync=true` 时必填
- `supportsAsync`：是否支持异步生图，必须显式声明

示例：

```env
IMAGE_DEFAULT_PROVIDER_ID=openai
IMAGE_PROVIDERS_JSON=[{"id":"openai","label":"OpenAI Images","baseUrl":"https://api.openai.com","syncPath":"/v1/images/generations","editPath":"/v1/images/edits","asyncPath":"","pollPathBase":"","supportsAsync":false}]
```

### DeepSeek 润色配置

- `DEEPSEEK_URL`：DeepSeek 接口地址
- `DEEPSEEK_API_KEY`：API Key
- `DEEPSEEK_MODEL`：模型名
- `DEEPSEEK_POLISH_SYSTEM_PROMPT`：服务端润色系统提示词

如果这四项有任意一项为空，前端仍会显示润色入口，但执行一键润色时会返回“服务端未配置 Prompt 润色功能”。

## 当前实现说明

### 前端存储

- API Key 按 Provider 维度保存在浏览器本地
- 生成记录、待恢复异步任务、图片 Blob、设置项保存在 IndexedDB
- 已读版本公告会记录在本地 KV 中

### 服务端行为

- 服务端负责转发上游请求，避免前端直接暴露上游地址
- 同步生图支持 JSON 请求与 multipart 参考图编辑请求
- 当上游返回 `text/event-stream` 时，服务端会直接透传 SSE
- 异步模式通过 `/api/image/poll` 轮询任务状态
- 收藏接口会将文件写入 `collection/`，并维护 `collection/manifest.json`
- 上传目录会在服务启动时清理过期文件，同时保留 `uploads/.gitignore`

### 已知约束

- Provider 是否支持异步，完全取决于 `IMAGE_PROVIDERS_JSON` 配置
- 异步 Provider 未声明 `asyncPath` 或 `pollPathBase` 时，服务端会拒绝启动
- 收藏属于本地文件能力，不会同步到远程
- 直接静态预览页面时，生图代理与润色接口不可用

## 常用脚本
- 收藏图片保存在本地 `collection/` 目录，并通过 `collection/manifest.json` 管理
- 收藏列表按文件名时间倒序排列，最新收藏优先显示
- 收藏查看全部时支持左右翻页查看

### 图片详情

- 查看当前记录的原始 Prompt
- 查看上游改写后的 Prompt（如果存在且不同）
- 查看请求参数与实际上游参数
- 查看分辨率和生成时长
- 多图记录支持在详情弹窗内左右切换

## 本地运行

先安装依赖，再启动本地 Node 服务：

```bash
npm install
npm start
```

默认访问地址：

```text
http://127.0.0.1:8000
```

不要直接双击打开 `index.html`。当前项目依赖本地 Node 服务提供：

- `/api/image/sync`
- `/api/image/async`
- `/api/image/poll`
- `/api/polish`
- `/api/upload`
- `/api/collection`

## 环境变量

项目启动时会自动读取根目录 `.env` 文件。建议先复制 [.env.example](/E:/github/image2/.env.example:1) 作为模板。

### 基础配置

- `PORT`：服务端端口，默认 `8000`
- `REQUEST_TIMEOUT_MS`：上游请求超时，默认 `300000`
- `UPLOAD_RETENTION_DAYS`：上传目录保留天数，默认 `7`

### 图片 Provider 配置

- `IMAGE_DEFAULT_PROVIDER_ID`：默认 Provider 的 `id`
- `IMAGE_PROVIDERS_JSON`：Provider 列表，必须是 JSON 数组

每个 Provider 支持这些字段：

- `id`：唯一标识
- `label`：前端显示名称
- `baseUrl`：Provider 基础地址
- `syncPath`：同步生图接口路径
- `editPath`：参考图编辑接口路径
- `asyncPath`：异步生图接口路径；`supportsAsync=true` 时必填
- `pollPathBase`：异步轮询路径前缀；`supportsAsync=true` 时必填
- `supportsAsync`：是否支持异步生图，必须显式声明

示例：

```env
IMAGE_DEFAULT_PROVIDER_ID=openai
IMAGE_PROVIDERS_JSON=[{"id":"openai","label":"OpenAI Images","baseUrl":"https://api.openai.com","syncPath":"/v1/images/generations","editPath":"/v1/images/edits","asyncPath":"","pollPathBase":"","supportsAsync":false}]
```

### DeepSeek 润色配置

- `DEEPSEEK_URL`：DeepSeek 接口地址
- `DEEPSEEK_API_KEY`：API Key
- `DEEPSEEK_MODEL`：模型名
- `DEEPSEEK_POLISH_SYSTEM_PROMPT`：服务端润色系统提示词

如果这四项有任意一项为空，前端仍会显示润色入口，但执行一键润色时会返回“服务端未配置 Prompt 润色功能”。

## 当前实现说明

### 前端存储

- API Key 按 Provider 维度保存在浏览器本地
- 生成记录、待恢复异步任务、图片 Blob、设置项保存在 IndexedDB
- 已读版本公告会记录在本地 KV 中

### 服务端行为

- 服务端负责转发上游请求，避免前端直接暴露上游地址
- 同步生图支持 JSON 请求与 multipart 参考图编辑请求
- 当上游返回 `text/event-stream` 时，服务端会直接透传 SSE
- 异步模式通过 `/api/image/poll` 轮询任务状态
- 收藏接口会将文件写入 `collection/`，并维护 `collection/manifest.json`
- 上传目录会在服务启动时清理过期文件，同时保留 `uploads/.gitignore`

### 已知约束

- Provider 是否支持异步，完全取决于 `IMAGE_PROVIDERS_JSON` 配置
- 异步 Provider 未声明 `asyncPath` 或 `pollPathBase` 时，服务端会拒绝启动
- 收藏属于本地文件能力，不会同步到远程
- 直接静态预览页面时，生图代理与润色接口不可用

## 常用脚本

```bash
npm start
npm test
```



## License

MIT
