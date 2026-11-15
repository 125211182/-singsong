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
- **移动端 (< 768px)**: 底部标签页切换布局
  - 默认显示「主控台」
  - 可切换「课堂记录」和「乐谱视窗」
  - 底部固定导航栏

### 评分算法
- 新录音采用 `v3.7-feedback`。评分读取实际录音，在已知录音与伴奏启动差的固定时间轴上比较。
- 音准比较可靠逐帧和稳态音段，允许一次整体音区校准。节奏比较有序的起音、换音等事件。强弱比较与干声范唱对应片段的相对走势。
- 三项分别给出百分参考值。证据不足时记录为空并提示待复核，真实零分仍显示 0。新记录无自动总分、保底和荣誉等级。
- 乐句来自范唱的声音区间，使用同一时间轴和证据门槛。更换干声或伴奏后，重新确认乐段、调、速度和起点。
- 分享读取兼容历史总分、等级和分项值，旧数据按原值呈现。

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
pnpm exec tsc --noEmit

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
