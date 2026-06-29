# 智能声乐评测应用 (AI Singing Evaluator)

## 项目概览
基于 Next.js 的智能声乐评测应用，包含音频上传、实时音高检测、旋律可视化、多维度评分（音准、节奏、情绪）、乐句级细粒度评分和详细评语生成功能，支持数据分享。

## 技术栈
- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI**: Tailwind CSS 4 + shadcn/ui + Lucide Icons
- **Animation**: Framer Motion
- **Audio**: Web Audio API
- **Storage**: Supabase (数据库), S3Storage (对象存储)
- **Package Manager**: pnpm

## UI 设计风格
- **风格**: 童趣风（圆润、明亮、友好）
- **主色**: #5DB7FF (蓝色)
- **辅色**: #FF8FB3 (粉色), #FFD447 (黄色), #77D982 (绿色)
- **背景**: #FFF7D6 (暖黄)
- **字体**: Nunito (圆润无衬线)
- **圆角**: 1rem - 1.5rem
- **阴影**: 柔和阴影 (shadow-card, shadow-float)

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
- **音准 (50%)**: 基于 MIDI 音高差计算
- **节奏 (30%)**: 完成度 80% + 覆盖率 20%
- **情绪 (20%)**: 基于音量动态和稳定性

### 分享功能
- 文件 URL 有效期: 90 天
- 分享链接: 永久有效

### UI 升级 (v9.1)
- 图标系统: emoji → Lucide SVG 图标
- 颜色系统: 使用 CSS 变量 (var(--primary), var(--success) 等)
- 动画效果: 学生卡片入场动画 (slideInLeft)
- 可访问性: 添加 aria-label 到按钮

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
