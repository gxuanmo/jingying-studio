# JINGYING STUDIO

副标题：净影工坊

JINGYING STUDIO 是一个本地优先的媒体清理工具，面向图片和视频里的文字、水印、字幕去除场景。当前仓库已经包含完整的本地闭环：前端工作台、FastAPI 算法服务、上传与任务管理、结果预览与下载，以及 SQLite 元数据持久化。

产品策略不是“一键神修复”，而是更保守的 `detect -> verify -> clean`：

- 只有在检测足够稳定时才输出结果
- 低置信度难例直接失败，而不是强行生成脏补丁
- 默认优先使用 classical / heuristic-first 算法栈，保持部署简单、运行可控

## 当前能力

### 图片

- 去图片文字
- 去图片水印

### 视频后端能力

- 去静态水印
- 去动态水印 `Beta`
- 去底部字幕
- 去烧录字幕 `Beta`

### 前端当前公开模式

前端工作台当前只开放稳定模式：

- 自动模式
- 图片去文字
- 图片去水印
- 视频静态水印
- 视频底部字幕

`视频动态水印` 和 `烧录字幕` 的后端能力仍然保留，但前端默认隐藏，避免把仍在打磨的 Beta 模式直接暴露给最终用户。

## 处理边界

- 视频大小不超过 `500MB`
- 视频时长不超过 `3 分钟`
- 视频最长边不超过 `1920`
- 当前更适合本地单机、内网试运行、私有部署原型

对下列场景，当前效果仍可能不稳定：

- 半透明或强动画水印
- 强运动镜头、快速缩放、剧烈透视变化
- 复杂纹理背景上的烧录字幕
- 大面积遮挡或大片透明浮层

## 技术路线

当前实现是 classical / heuristic-first，不依赖大模型或重型分割模型：

- 图片：形态学、阈值、边缘、角标区域分析、OpenCV inpaint
- 视频：角落持久性分析、字幕带分析、文本样候选、跨帧跟踪、时序修复

视频算法最近已升级为两遍扫描：

1. 第一遍做候选检测和时序稳定
2. 第二遍做 mask 细化和时空重建

修复核心使用：

- 静态水印：视频级持久区域分析
- 动态水印：小目标候选 + 轨迹稳定
- 字幕：底部 ROI / 画面内部文本带分析
- 重建：ECC 对齐 + 邻帧背景中位数融合 + Telea 兜底

更详细的算法说明见 [docs/video-removal-first-principles.md](docs/video-removal-first-principles.md)。

## 快速启动

推荐直接使用根目录脚本：

```bat
start-local.bat
```

脚本会自动完成：

- 检查 `python` 和 `npm`
- 探测依赖是否已安装
- 仅在缺依赖时执行安装
- 写入 `web/.env.local`
- 启动后端窗口
- 启动前端窗口
- 自动打开浏览器到 `http://localhost:3000`

### 启动参数

```bat
start-local.bat --no-install
start-local.bat --dry-run
start-local.bat --force-install
```

- `--no-install`：跳过依赖安装
- `--dry-run`：只打印命令，不真正执行
- `--force-install`：强制重新安装依赖

## 手动启动

### 1. 启动后端

```powershell
cd engine
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

默认地址：

```text
http://127.0.0.1:8000
```

### 2. 启动前端

```powershell
cd web
npm install
$env:NEXT_PUBLIC_ENGINE_URL="http://127.0.0.1:8000"
npm run dev
```

默认地址：

```text
http://127.0.0.1:3000
```

## API

后端提供这些接口：

- `GET /api/health`
- `POST /api/uploads`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/{job_id}`

静态资源挂载路径：

- `/uploads`
- `/results`
- `/previews`

## 环境变量

### 后端

定义位置：[engine/app/config.py](engine/app/config.py)

```text
MEDIA_CLEANER_DATA_DIR
MEDIA_CLEANER_METADATA_DB
MEDIA_CLEANER_CORS_ORIGINS
MEDIA_CLEANER_APP_TITLE
MEDIA_CLEANER_APP_VERSION
```

默认值：

- 数据目录：`./data`
- 元数据库：`./data/metadata.sqlite3`
- CORS：`http://localhost:3000,http://127.0.0.1:3000`

### 前端

主要使用：

```text
NEXT_PUBLIC_ENGINE_URL
```

示例见 [web/.env.example](web/.env.example)。

## 数据目录

项目默认会使用这些数据路径：

- `data/uploads`
- `data/results`
- `data/previews`
- `data/metadata.sqlite3`

任务历史和素材元数据会写入 SQLite，因此服务重启后仍可恢复最近任务记录。

## 项目结构

```text
.
├─ docs/
│  ├─ media-cleaner-spec.md
│  └─ video-removal-first-principles.md
├─ engine/
│  ├─ app/
│  │  ├─ algorithms/
│  │  ├─ schemas/
│  │  └─ services/
│  ├─ requirements.txt
│  ├─ smoke_test.py
│  └─ mode_smoke_test.py
├─ web/
│  ├─ src/app/
│  └─ src/components/
├─ start-local.bat
├─ start-local.ps1
└─ AGENTS.md
```

关键文件：

- 前端工作台：[web/src/components/cleaner-studio.tsx](web/src/components/cleaner-studio.tsx)
- 后端入口：[engine/app/main.py](engine/app/main.py)
- 图片算法：[engine/app/algorithms/image_cleaner.py](engine/app/algorithms/image_cleaner.py)
- 视频算法：[engine/app/algorithms/video_cleaner.py](engine/app/algorithms/video_cleaner.py)
- 任务管理：[engine/app/services/job_manager.py](engine/app/services/job_manager.py)

## 验证命令

### 后端

```powershell
cd engine
python -m compileall app
python smoke_test.py
python mode_smoke_test.py
```

### 前端

```powershell
cd web
npm run lint
npm run build
```

说明：

- `smoke_test.py` 覆盖图片、视频和 API 主链路
- `mode_smoke_test.py` 覆盖四类视频模式的合成回归样例

## 当前边界

这版已经适合：

- 本地单机使用
- 内网试运行
- 私有部署原型
- 算法验证和产品打样

暂时还不适合直接作为公网 SaaS 商用终版，主要因为缺少：

- 用户鉴权和权限体系
- 租户隔离
- 独立任务队列和 worker
- 对象存储抽象
- 更完整的异常监控、审计和计费体系

## 升级方向

建议优先做这三件事：

1. 引入鉴权、配额和任务归属
2. 拆分 Redis / worker 队列
3. 把算法升级为 `classical + 可插拔模型增强`

模型增强方向建议参考：

- 文本定位：DBNet / CRAFT
- 视频补全：E2FGVI / ProPainter
- 图像补洞兜底：LaMa
