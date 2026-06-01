import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 获取脚本当前目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 优先基于当前脚本所在目录去加载 .env
dotenv.config({ path: path.join(__dirname, '.env') });

// 统一输出 JSON 到标准输出，供 Agent 解析
function outputResult(data) {
  console.log(JSON.stringify(data, null, 2));
}

// 异常退出
function exitWithError(message, details = null) {
  outputResult({
    success: false,
    error: message,
    details: details
  });
  process.exit(0);
}

// ==========================================
// 原来外部依赖的配置解析逻辑，现在直接内聚为 Skill 自包含
// ==========================================
function parseRuntimeConfig() {
  const env = process.env;
  const raw = typeof env.IMAGE_PROVIDERS_JSON === 'string' ? env.IMAGE_PROVIDERS_JSON.trim() : '';
  if (!raw) {
    throw new Error('IMAGE_PROVIDERS_JSON is required');
  }

  let providers;
  try {
    providers = JSON.parse(raw);
  } catch {
    throw new Error('IMAGE_PROVIDERS_JSON is malformed');
  }

  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('IMAGE_PROVIDERS_JSON must be a non-empty array');
  }

  const defaultProviderId = String(env.IMAGE_DEFAULT_PROVIDER_ID || '').trim();
  if (!defaultProviderId) {
    throw new Error('IMAGE_DEFAULT_PROVIDER_ID is required');
  }

  return {
    providers,
    defaultProviderId
  };
}

function resolveProvider(runtimeConfig, providerId) {
  const requestedId = String(providerId || '').trim();
  if (requestedId) {
    const requested = runtimeConfig.providers.find((provider) => provider.id === requestedId);
    if (!requested) {
      throw new Error(`未找到图像服务：${requestedId}`);
    }
    return requested;
  }
  return runtimeConfig.providers.find((provider) => provider.id === runtimeConfig.defaultProviderId)
    || runtimeConfig.providers[0];
}

function getProxyTarget(provider) {
  const left = String(provider.baseUrl || '').replace(/\/+$/, '');
  const right = String(provider.syncPath || '');
  if (!left) return right;
  if (!right) return left;
  return right.startsWith('/') ? `${left}${right}` : `${left}/${right}`;
}

async function main() {
  // 1. 获取输入参数 (支持 JSON 格式或者直接平铺传参)
  let inputArgs = {};
  try {
    const rawArg = process.argv[2];
    if (rawArg) {
      if (rawArg.trim().startsWith('{')) {
        inputArgs = JSON.parse(rawArg);
      } else {
        const promptArgs = [];
        for (let i = 2; i < process.argv.length; i++) {
          const arg = process.argv[i];
          if (arg.startsWith('--')) {
            if (arg === '--provider') {
              if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
                inputArgs.providerId = process.argv[i + 1];
                i++;
              }
            }
            continue;
          }
          promptArgs.push(arg);
        }
        inputArgs.prompt = promptArgs.join(' ');
        if (process.argv.includes('--low')) inputArgs.quality = 'low';
        if (process.argv.includes('--high')) inputArgs.quality = 'high';
      }
    }
  } catch (err) {
    exitWithError('解析参数失败，请输入正确的参数格式。', err.message);
  }

  const prompt = inputArgs.prompt || '';
  if (!prompt.trim()) {
    exitWithError('生图提示词 (prompt) 不能为空。');
  }

  // 2. 加载项目配置
  let runtimeConfig;
  try {
    runtimeConfig = parseRuntimeConfig();
  } catch (err) {
    exitWithError('加载系统配置文件失败，请检查 .env。', err.message);
  }

  const providerId = inputArgs.providerId || runtimeConfig.defaultProviderId;
  if (!providerId) {
    exitWithError('未检测到默认的生图通道。请在参数中传入 --provider，或在 .env 中设置 IMAGE_DEFAULT_PROVIDER_ID。');
  }
  const size = inputArgs.size || '1024x1024';
  const quality = inputArgs.quality || 'medium';

  // 3. 解析服务商 API 终点
  let provider;
  let targetUrl;
  try {
    provider = resolveProvider(runtimeConfig, providerId);
    targetUrl = getProxyTarget(provider);
  } catch (err) {
    exitWithError(`解析提供商 [${providerId}] 失败。`, err.message);
  }

  // 4. 组装请求负载
  const payload = {
    model: 'gpt-image-2',
    prompt: prompt,
    size: size,
    quality: quality,
    response_format: 'b64_json',
    n: 1
  };

  const apiKey = process.env.IMAGE_API_KEY;
  if (!apiKey) {
    exitWithError('未检测到生图所需的 API 密钥，请在同目录下的 .env 中配置 IMAGE_API_KEY。');
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      exitWithError(`生图请求被服务商拒绝，状态码: ${response.status}`, errText);
    }

    const respData = await response.json();
    if (respData.data && respData.data.length > 0) {
      const b64 = respData.data[0].b64_json;
      if (b64) {
        const buffer = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        
        const skillImageDir = path.join(__dirname, 'image');
        await fs.mkdir(skillImageDir, { recursive: true });
        
        const filename = `image-${Date.now()}.png`;
        const localPath = path.join(skillImageDir, filename);
        await fs.writeFile(localPath, buffer);

        outputResult({
          success: true,
          provider: providerId,
          prompt: prompt,
          local_path: localPath.replace(/\\/g, '/')
        });
      } else {
        exitWithError('响应的 data[0] 中没有 b64_json 生图数据');
      }
    } else {
      exitWithError('响应结果中未包含任何图像数据 (data 字段为空)', respData);
    }
  } catch (err) {
    exitWithError('生图请求发生网络连接异常', err.message);
  }
}

main();
