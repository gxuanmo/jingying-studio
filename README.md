# Media Cleaner Lab

本项目是一个本地优先的媒体清理工具网站，面向图片和视频中的文字、水印、字幕去除场景。

当前版本已经具备完整的本地闭环：
- 中文前端工作台
- FastAPI 算法服务
- 图片与视频上传
- 任务创建、轮询、历史记录
- 结果预览与下载
- 检测分析预览图
- SQLite 元数据持久化

它的产品策略不是“硬凹一键神修复”，而是更偏保守的 `detect -> verify -> clean` 路线：
- 能较稳定识别时再输出结果
- 低置信度难例会直接失败
- 尽量避免生成明显脏补丁

## 支持能力

### 图片
- 去图片文字
- 去图片水印

### 视频
- 去静态水印
- 去动态水印（Beta）
- 去底部字幕
- 去烧录字幕（Beta）

### 当前处理限制
- 视频大小不超过 `500MB`
- 视频时长不超过 `3 分钟`
- 视频最长边不超过 `1920`，可理解为本地版按 `1080p` 档位控制

## 技术路线

当前引擎是 classical / heuristic-first 实现，不依赖大模型或重型分割模型：
- 图片：基于形态学、阈值、边缘、角标区域分析和 OpenCV inpaint
- 视频：基于时序稳定性、角落持久性、字幕带分析、跨帧跟踪和时域修复
- 结果策略：先检测，后修复，低置信度不强出结果

这意味着它比很多开源 baseline 更保守、更容易控制，但也意味着它不是 CapCut 那种工业级模型系统。动态水印和烧录字幕在难例上仍然可能失败。

## 一键启动

推荐直接使用根目录脚本：

```bat
start-local.bat
```

脚本会自动完成这些事：
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

说明：
- `--no-install`：跳过依赖安装，适合本机已经装好依赖
- `--dry-run`：只打印命令，不真正执行
- `--force-install`：即使探测到依赖存在，也强制重新安装

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
http://localhost:3000
```

## 核心接口

后端当前提供这些接口：

- `GET /api/health`
- `POST /api/uploads`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/{job_id}`

静态资源会挂载到：
- `/uploads`
- `/results`
- `/previews`

## 环境变量

### 后端

可选环境变量定义在 [`engine/app/config.py`](/d:/Users/g1327/Desktop/github-pro/engine/app/config.py)：

```text
MEDIA_CLEANER_DATA_DIR
MEDIA_CLEANER_METADATA_DB
MEDIA_CLEANER_CORS_ORIGINS
MEDIA_CLEANER_APP_TITLE
MEDIA_CLEANER_APP_VERSION
```

默认行为：
- 数据目录：`./data`
- 元数据库：`./data/metadata.sqlite3`
- CORS：`http://localhost:3000,http://127.0.0.1:3000`

### 前端

前端主要使用：

```text
NEXT_PUBLIC_ENGINE_URL
```

示例文件见 [web/.env.example](/d:/Users/g1327/Desktop/github-pro/web/.env.example)。

## 数据与持久化

项目默认会在根目录创建并使用这些数据：
- `data/uploads`
- `data/results`
- `data/previews`
- `data/metadata.sqlite3`

任务历史和素材元数据会写入 SQLite，因此服务重启后仍可恢复最近任务记录。

## 项目结构

```text
.
├─ docs/
├─ engine/
│  ├─ app/
│  │  ├─ algorithms/
│  │  ├─ schemas/
│  │  └─ services/
│  ├─ requirements.txt
│  └─ smoke_test.py
├─ web/
│  ├─ src/app/
│  └─ src/components/
├─ start-local.bat
└─ start-local.ps1
```

关键文件：
- 前端工作台：[web/src/components/cleaner-studio.tsx](/d:/Users/g1327/Desktop/github-pro/web/src/components/cleaner-studio.tsx)
- 后端入口：[engine/app/main.py](/d:/Users/g1327/Desktop/github-pro/engine/app/main.py)
- 图片算法：[engine/app/algorithms/image_cleaner.py](/d:/Users/g1327/Desktop/github-pro/engine/app/algorithms/image_cleaner.py)
- 视频算法：[engine/app/algorithms/video_cleaner.py](/d:/Users/g1327/Desktop/github-pro/engine/app/algorithms/video_cleaner.py)
- 任务管理：[engine/app/services/job_manager.py](/d:/Users/g1327/Desktop/github-pro/engine/app/services/job_manager.py)

## 已做验证

当前仓库至少已经验证过这些命令：

```powershell
cd engine
python -m compileall app
python smoke_test.py
```

```powershell
cd web
npm run lint
npm run build
```

## 当前边界

这版已经适合：
- 本地单机使用
- 内网试运行
- 私有部署原型
- 算法验证和产品打样

这版暂时还不适合直接宣称为公网 SaaS 商用终版，原因是还缺少：
- 用户鉴权和权限体系
- 租户隔离
- 独立任务队列和 worker
- 对象存储抽象
- 更完整的异常监控、审计和计费体系

## 已知限制

- 动态水印和烧录字幕仍属于 Beta 能力
- 引擎仍以 heuristic 为主，不是工业级分割模型方案
- 视频任务当前在 API 进程内以后台线程执行，不适合高并发公网场景
- 对极复杂背景、强运动镜头、大片透明浮层，效果仍可能不稳定

## 后续升级方向

如果要继续往“更接近商用”的版本推进，建议优先做这三件事：

1. 引入鉴权、配额和任务归属
2. 拆分 Redis / worker 队列
3. 接入对象存储，并把算法升级为 classical + 可插拔模型增强

