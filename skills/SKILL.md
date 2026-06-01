---
name: image2-skill
description: 使用多通道生图引擎生成高质量图片，返回图片的绝对物理存储路径。
---

# 生图工具 (image2-skill)

使用多通道 AI 生图引擎（支持 OpenAI 兼容接口，例如 carrotbot 等）进行高画质图片生成。

## 参数说明

此工具接收一个 JSON 格式的输入参数：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `prompt` | string | 是 | 无 | 想要生成的图片画面描述（支持中文或英文）。 |
| `providerId` | string | 否 | `image3` | 图像通道提供商 ID（如 `image3`、`openai` 等，定义在系统的配置文件中）。 |
| `size` | string | 否 | `1024x1024` | 生成的图片尺寸，例如 `1024x1024`、`512x512` 等。 |
| `quality` | string | 否 | `medium` | 图像质量，可选 `low`、`medium` |

## 使用示例

### 示例 1: 生成小猫喝牛奶
```json
{
  "prompt": "一只可爱的小猫正在用吸管喝旺仔牛奶"
}
```

### 示例 2: 指定生图通道
```json
{
  "prompt": "Cyberpunk city street, neon lights, rainy night, highly detailed",
  "providerId": "openai",
  "size": "512x512"
}
```

## 返回结果

工具执行成功后，将返回包含图片本地保存绝对路径（基于当前脚本所在位置动态计算）和相关信息的 JSON 结果：

```json
{
  "success": true,
  "provider": "image3",
  "prompt": "一只可爱的小猫正在仰头喝阿萨姆奶茶",
  "local_path": "/你的物理目录/skills/image/image-1780293016394.png"
}
```
