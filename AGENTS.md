# AGENTS

本文件面向进入该仓库协作的代码代理和自动化助手，目标是降低误改、误测和误提交的概率。

## 项目目标

JINGYING STUDIO 是一个本地优先的媒体清理工具，包含：

- Next.js 前端工作台
- FastAPI 后端服务
- classical / heuristic-first 图片与视频清理算法

核心产品原则：

- 优先稳定，不强出结果
- 先检测，再验证，再修复
- 默认保持轻依赖、本地可运行

## 仓库结构

- `web/`：前端
- `engine/`：后端与算法
- `docs/`：产品和算法文档
- `data/`：运行期数据目录

关键文件：

- `web/src/components/cleaner-studio.tsx`
- `engine/app/main.py`
- `engine/app/algorithms/image_cleaner.py`
- `engine/app/algorithms/video_cleaner.py`
- `engine/app/services/job_manager.py`

## 当前功能边界

后端支持：

- `image_text`
- `image_watermark`
- `video_static_watermark`
- `video_dynamic_watermark` `Beta`
- `video_bottom_subtitles`
- `video_burned_subtitles` `Beta`

前端当前公开模式只开放：

- `auto`
- `image_text`
- `image_watermark`
- `video_static_watermark`
- `video_bottom_subtitles`

不要未经确认就把 `video_dynamic_watermark` 或 `video_burned_subtitles` 重新开放到前端公开界面。

## 本地运行

### 前端

```powershell
cd web
npm install
$env:NEXT_PUBLIC_ENGINE_URL="http://127.0.0.1:8000"
npm run dev
```

### 后端

```powershell
cd engine
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

## 修改后至少要跑的验证

### 改前端时

```powershell
cd web
npm run lint
npm run build
```

### 改算法或后端时

```powershell
cd engine
python smoke_test.py
python mode_smoke_test.py
```

说明：

- `smoke_test.py` 覆盖图片、视频和 API 主链路
- `mode_smoke_test.py` 覆盖静态水印、动态水印、底部字幕、烧录字幕四类视频模式

## 算法协作约束

- 当前视频算法是两遍扫描：第一遍检测和时序稳定，第二遍生成 mask 并修复输出
- 当前策略是 classical / heuristic-first，不要默认引入重型模型依赖
- 如果要接模型，请尽量保留 `classical` 后备路径
- 复杂算法决策先看 `docs/video-removal-first-principles.md`

## 文档维护要求

改动以下内容时，需要同步更新 README 或 docs：

- 对外公开能力
- 运行命令
- 测试入口
- 算法路线或模型升级方案

## 不要提交的内容

除非用户明确要求，不要提交这些运行产物：

- 根目录 `edge-dom-*.log`
- 根目录 `edge-dom-*.html`
- 根目录 `edge-headless.*`
- 根目录 `engine-server.*`
- 根目录 `web-server.*`
- 根目录 `ui-check.png`
- `engine/data/` 下的临时 smoke 数据和运行输出

## 提交原则

- 保持改动聚焦，不顺手混入无关清理
- 不要回滚用户已有修改
- 涉及 UI 文案、可见模式或后端能力边界时，优先让 README、前端展示、后端实际能力保持一致
