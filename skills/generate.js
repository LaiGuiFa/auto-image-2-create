import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 获取脚本当前目录及项目根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 优先基于当前脚本所在目录去加载 .env
dotenv.config({ path: path.join(__dirname, '.env') });

import { parseRuntimeConfig } from '../server/config.js';
import { resolveProvider, getProxyTarget } from '../server/proxy.js';

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
  process.exit(0); // 即使失败也返回 0，让 Agent 能安全解析 JSON 错误体
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
        // 如果不是 JSON，精确过滤掉所有以 '--' 开头的选项，并跳过对应选项的值（如 --provider）
        const promptArgs = [];
        for (let i = 2; i < process.argv.length; i++) {
          const arg = process.argv[i];
          if (arg.startsWith('--')) {
            // 如果是 --provider，则不仅过滤自身，还要跳过下一个值，并将其存入 providerId
            if (arg === '--provider') {
              if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
                inputArgs.providerId = process.argv[i + 1];
                i++; // 跳过下一个参数值
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

  // 命令行如果没有显式指定 --provider，则完全依赖环境变量中的默认提供商设置
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
    targetUrl = getProxyTarget(provider, 'sync');
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

  // 这里的 API Key 从当前系统 .env 或进程环境变量中读取
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
        // 解码并保存图片
        const buffer = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        
        // 保存至当前脚本所在目录下的 image 文件夹中，以保证独立移植性
        const skillImageDir = path.join(__dirname, 'image');
        await fs.mkdir(skillImageDir, { recursive: true });
        
        const filename = `image-${Date.now()}.png`;
        const localPath = path.join(skillImageDir, filename);
        await fs.writeFile(localPath, buffer);

        // 输出成功结果
        outputResult({
          success: true,
          provider: providerId,
          prompt: prompt,
          local_path: localPath.replace(/\\/g, '/') // 转换为通用斜杠路径方便展示
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
