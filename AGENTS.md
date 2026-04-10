# 智能声乐评测应用 (AI Singing Evaluator)

## 项目概览
基于 Next.js 的智能声乐评测应用，包含音频上传、实时音高检测、旋律可视化、多维度评分（音准、节奏、情绪）、乐句级细粒度评分和详细评语生成功能，支持数据分享。

## 技术栈
- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI**: Tailwind CSS 4 + shadcn/ui
- **Audio**: Web Audio API
- **Storage**: Supabase (数据库), S3Storage (对象存储)
- **Package Manager**: pnpm

## 关键设计决策

### 响应式布局
- **桌面端 (>= 768px)**: 三栏布局
  - 左侧: 320px (课堂记录)
  - 中间: flex-1 自适应 (主控台)
  - 右侧: 600px (乐谱视窗)
- **移动端 (< 768px)**: 三栏缩放布局
  - 左侧: 180px (min-width: 150px)
  - 中间: 自适应
  - 右侧: 200px (min-width: 160px)
- 学生卡片、按钮等组件均有移动端适配样式

### 评分算法
- **音准 (50%)**: 基于 MIDI 音高差计算
- **节奏 (30%)**: 完成度 80% + 覆盖率 20%
- **情绪 (20%)**: 基于音量动态和稳定性

### 分享功能
- 文件 URL 有效期: 90 天
- 分享链接: 永久有效

## 构建和测试命令
```bash
# 安装依赖
pnpm install

# 开发环境
pnpm dev

# 构建生产版本
pnpm build

# 类型检查
pnpm ts-check

# 代码检查
pnpm lint

# 启动生产环境
pnpm start
```

## API 接口
| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/share` | POST | 创建分享链接 |
| `/api/share/[id]` | GET | 获取分享数据 |
| `/api/upload` | POST | 上传音频/图片文件 |

## 环境变量
| 变量名 | 说明 |
|--------|------|
| `COZE_SUPABASE_URL` | Supabase 项目 URL |
| `COZE_SUPABASE_ANON_KEY` | Supabase 匿名密钥 |
| `COZE_BUCKET_ENDPOINT_URL` | S3 存储端点 |
| `COZE_BUCKET_NAME` | S3 存储桶名称 |

## 注意事项
- 音频文件上传前会降采样至 22.05kHz 单声道，减小文件大小
- Supabase/S3 客户端采用延迟初始化，避免构建时环境变量检查失败
