"use client";
/* eslint-disable @next/next/no-img-element */

import { startTransition, useEffect, useEffectEvent, useMemo, useState, type DragEvent } from "react";

type MediaType = "image" | "video";
type JobStatus = "queued" | "running" | "succeeded" | "failed";
type EngineStatus = "checking" | "online" | "offline";
type JobMode =
  | "auto"
  | "image_text"
  | "image_watermark"
  | "video_static_watermark"
  | "video_dynamic_watermark"
  | "video_bottom_subtitles"
  | "video_burned_subtitles";

type AssetRecord = {
  id: string;
  url: string;
  preview_url?: string | null;
  width: number;
  height: number;
  duration_seconds: number;
  file_size_bytes: number;
  media_type: MediaType;
  original_name: string;
};

type DetectionSummary = {
  label: string;
  confidence: number;
  area_ratio: number;
  frame_hits: number;
  boxes: number[][];
  notes: string[];
};

type JobRecord = {
  id: string;
  status: JobStatus;
  progress: number;
  result_url?: string | null;
  analysis_url?: string | null;
  error?: string | null;
  detections: DetectionSummary[];
  logs: string[];
  media_type: MediaType;
  mode: JobMode;
  updated_at: string;
  created_at: string;
};

const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://127.0.0.1:8000";

const MODE_OPTIONS: Array<{
  value: JobMode;
  title: string;
  badge: string;
  focus: string;
  mediaType: MediaType | "all";
  description: string;
}> = [
  {
    value: "auto",
    title: "自动模式",
    badge: "推荐",
    focus: "多检测器兜底",
    mediaType: "all",
    description: "自动尝试所有兼容检测器，只在置信度足够时输出结果。",
  },
  {
    value: "image_text",
    title: "图片去文字",
    badge: "图片",
    focus: "文字轮廓 + 修补",
    mediaType: "image",
    description: "适合截图、海报和商品图，优先处理清晰文本区域。",
  },
  {
    value: "image_watermark",
    title: "图片去水印",
    badge: "图片",
    focus: "角标 / 平铺 / Logo",
    mediaType: "image",
    description: "优先识别边缘稳定或重复出现的水印图层。",
  },
  {
    value: "video_static_watermark",
    title: "视频静态水印",
    badge: "视频",
    focus: "稳定角标",
    mediaType: "video",
    description: "利用长时稳定区域和邻近帧，适合固定角落水印。",
  },
  {
    value: "video_dynamic_watermark",
    title: "视频动态水印",
    badge: "Beta",
    focus: "移动浮层",
    mediaType: "video",
    description: "会先验证跨帧一致性，不够稳定时直接失败而不硬修。",
  },
  {
    value: "video_bottom_subtitles",
    title: "底部字幕",
    badge: "视频",
    focus: "下边缘字幕带",
    mediaType: "video",
    description: "聚焦底部字幕条带，使用对齐邻帧恢复背景。",
  },
  {
    value: "video_burned_subtitles",
    title: "烧录字幕",
    badge: "Beta",
    focus: "画面内字幕",
    mediaType: "video",
    description: "尝试处理画面内部硬字幕，难例会更快失败以避免脏结果。",
  },
];

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
};

const ENGINE_LABELS: Record<EngineStatus, string> = {
  checking: "检测中",
  online: "在线",
  offline: "离线",
};

const DETECTION_LABELS: Record<string, string> = {
  image_text: "图片文字",
  image_watermark: "图片水印",
  video_static_watermark: "静态水印",
  video_dynamic_watermark: "动态水印",
  video_bottom_subtitles: "底部字幕",
  video_burned_subtitles: "烧录字幕",
};

const WORKFLOW_STEPS = [
  { id: "01", title: "拖入素材", description: "先看预览，再决定是否提交。" },
  { id: "02", title: "选择模式", description: "模式会按图片 / 视频自动过滤。" },
  { id: "03", title: "等待置信判断", description: "达不到阈值就直接失败，不输出脏补丁。" },
];

const PRINCIPLES = [
  "本地优先，适合私有部署和内网试运行。",
  "先检测后修补，不把低置信度结果强行交付。",
  "对动态水印和烧录字幕保持严格失败策略。",
];

function isTerminal(status?: JobStatus) {
  return status === "succeeded" || status === "failed";
}

function prettyMode(mode: JobMode) {
  return MODE_OPTIONS.find((option) => option.value === mode)?.title ?? mode;
}

function prettyDetection(label: string) {
  return DETECTION_LABELS[label] ?? label;
}

function prettyStatus(status: JobStatus) {
  return STATUS_LABELS[status] ?? status;
}

function prettyEngineStatus(status: EngineStatus) {
  return ENGINE_LABELS[status] ?? status;
}

function inferMediaType(file: File | null, asset: AssetRecord | null): MediaType | null {
  if (file?.type.startsWith("image/")) {
    return "image";
  }
  if (file?.type.startsWith("video/")) {
    return "video";
  }
  return asset?.media_type ?? null;
}

function isModeCompatible(mode: JobMode, mediaType: MediaType | null) {
  const option = MODE_OPTIONS.find((candidate) => candidate.value === mode);
  return !mediaType || !option || option.mediaType === "all" || option.mediaType === mediaType;
}

function buildUrl(path?: string | null) {
  if (!path) {
    return null;
  }
  return path.startsWith("http") ? path : `${ENGINE_URL}${path}`;
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (!bytes) {
    return null;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDuration(seconds: number) {
  if (!seconds) {
    return null;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${remainSeconds} 秒`;
}

function buildAssetMeta(asset: AssetRecord | null) {
  if (!asset) {
    return [];
  }

  return [
    `${asset.width} x ${asset.height}`,
    asset.media_type === "video" ? formatDuration(asset.duration_seconds) : null,
    formatBytes(asset.file_size_bytes),
    asset.media_type === "video" ? "视频" : "图片",
  ].filter(Boolean) as string[];
}

function buildPendingMeta(file: File | null) {
  if (!file) {
    return [];
  }

  return [file.type.startsWith("video/") ? "视频" : "图片", formatBytes(file.size)].filter(Boolean) as string[];
}

function statusTone(status: JobStatus | EngineStatus) {
  if (status === "online" || status === "succeeded") {
    return "border-[rgba(20,109,103,0.18)] bg-[rgba(20,109,103,0.12)] text-[var(--accent-strong)]";
  }
  if (status === "failed" || status === "offline") {
    return "border-[rgba(211,109,56,0.22)] bg-[rgba(211,109,56,0.12)] text-[var(--signal)]";
  }
  return "border-[var(--line)] bg-white/75 text-[var(--muted)]";
}

function badgeTone(badge: string) {
  if (badge === "推荐") {
    return "border-[rgba(20,109,103,0.16)] bg-[rgba(20,109,103,0.1)] text-[var(--accent-strong)]";
  }
  if (badge === "Beta") {
    return "border-[rgba(211,109,56,0.18)] bg-[rgba(211,109,56,0.12)] text-[var(--signal)]";
  }
  return "border-[var(--line)] bg-white/72 text-[var(--muted-strong)]";
}

function humanizeError(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }

  const message = raw.trim();
  const lowered = message.toLowerCase();

  if (lowered.includes("choose an image or video first")) return "请先选择一张图片或一段视频，再开始处理。";
  if (lowered.includes("not compatible")) return "当前模式和素材类型不匹配，请切换模式后重试。";
  if (lowered.includes("engine unavailable")) return "处理引擎暂时不可用，请确认本地服务是否已经启动。";
  if (lowered.includes("upload failed")) return "素材上传失败，请稍后重试。";
  if (lowered.includes("job creation failed")) return "任务创建失败，上传成功后未能进入处理队列。";
  if (lowered.includes("unsupported media type")) return "暂不支持这个文件类型，请上传图片或视频。";
  if (lowered.includes("500mb")) return "文件超过 500MB 的本地版限制，请先压缩后再试。";
  if (lowered.includes("3 minute")) return "视频时长超过 3 分钟的当前限制，请先裁剪后再试。";
  if (lowered.includes("cannot run on an image")) return "你选择的是视频模式，但当前上传的是图片素材。";
  if (lowered.includes("cannot run on a video")) return "你选择的是图片模式，但当前上传的是视频素材。";
  if (lowered.includes("no high-confidence removable watermark or subtitle pattern")) {
    return "这段视频里没有检测到足够可靠、可删除的水印或字幕区域。";
  }
  if (lowered.includes("did not produce a confident removable region")) {
    return "当前模式没有找到足够稳定的可修补区域，因此任务被安全终止。";
  }
  if (lowered.includes("failed to open")) return "素材读取失败，文件可能损坏，或编码格式当前版本无法处理。";
  if (lowered.includes("polling failed")) return "任务状态刷新失败，请稍后查看最近任务列表。";

  return message;
}

function buildTaskHeadline(job: JobRecord | null) {
  if (!job) return "还没有开始处理";
  if (job.status === "queued") return "任务已创建，等待引擎调度";
  if (job.status === "running") return "正在分析并修补素材";
  if (job.status === "succeeded") return "结果已生成，可以预览和下载";
  return "这次没有通过置信闸门";
}

function buildTaskDescription(job: JobRecord | null) {
  if (!job) return "上传素材、选择模式后，右侧会持续显示进度、检测摘要和结果出口。";
  if (job.status === "queued") return "任务已经进入队列，页面会自动刷新进度，无需手动操作。";
  if (job.status === "running") return "系统正在做检测、筛选和修补，低置信度区域会被直接放弃。";
  if (job.status === "succeeded") return "这次处理已经完成，你可以先看标注图，再决定是否下载结果。";
  return humanizeError(job.error) ?? "任务没有通过当前模式的置信判断，因此没有输出结果。";
}

export function CleanerStudio() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<JobMode>("auto");
  const [asset, setAsset] = useState<AssetRecord | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [history, setHistory] = useState<JobRecord[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("checking");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const activeMode = MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[0];
  const inferredMediaType = inferMediaType(file, asset);
  const sourcePreviewUrl = useMemo(() => {
    if (asset?.preview_url) {
      return buildUrl(asset.preview_url);
    }
    return previewUrl;
  }, [asset?.preview_url, previewUrl]);
  const resultUrl = buildUrl(job?.result_url);
  const analysisUrl = buildUrl(job?.analysis_url);
  const mediaMeta = asset ? buildAssetMeta(asset) : buildPendingMeta(file);
  const taskHeadline = buildTaskHeadline(job);
  const taskDescription = buildTaskDescription(job);
  const taskError = humanizeError(job?.status === "failed" ? job.error : error);
  const runDisabled = !file || submitting || engineStatus === "offline";
  const runHint = !file
    ? "先放入一份素材。"
    : engineStatus === "offline"
      ? "引擎离线时不会创建新任务。"
      : submitting
        ? "正在上传素材并创建任务。"
        : "所有检查通过后即可开始。";

  useEffect(() => {
    if (!isModeCompatible(mode, inferredMediaType)) {
      setMode("auto");
    }
  }, [inferredMediaType, mode]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return undefined;
    }

    const objectUrl = URL.createObjectURL(file);
    startTransition(() => {
      setPreviewUrl(objectUrl);
    });
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  async function refreshHistory() {
    try {
      const response = await fetch(`${ENGINE_URL}/api/jobs`);
      if (!response.ok) throw new Error("History refresh failed.");
      const jobs: JobRecord[] = await response.json();
      startTransition(() => {
        setHistory(jobs.slice(0, 8));
      });
    } catch {
      // History is best effort.
    }
  }

  async function refreshHealth() {
    try {
      const response = await fetch(`${ENGINE_URL}/api/health`);
      if (!response.ok) throw new Error("Engine unavailable.");
      startTransition(() => {
        setEngineStatus("online");
      });
    } catch {
      startTransition(() => {
        setEngineStatus("offline");
      });
    }
  }

  async function syncJob(jobId: string) {
    const response = await fetch(`${ENGINE_URL}/api/jobs/${jobId}`);
    if (!response.ok) throw new Error("Polling failed.");
    const nextJob: JobRecord = await response.json();
    startTransition(() => {
      setJob(nextJob);
      setHistory((current) => {
        const merged = [nextJob, ...current.filter((item) => item.id !== nextJob.id)];
        return merged.slice(0, 8);
      });
    });
  }

  const pollJob = useEffectEvent(async (jobId: string) => {
    await syncJob(jobId);
  });

  useEffect(() => {
    void refreshHealth();
    void refreshHistory();
  }, []);

  useEffect(() => {
    const handle = setInterval(() => {
      void refreshHealth();
    }, 15000);
    return () => clearInterval(handle);
  }, []);

  useEffect(() => {
    if (!job || isTerminal(job.status)) {
      return undefined;
    }

    const handle = setInterval(() => {
      void pollJob(job.id).catch((nextError) => {
        setError(humanizeError(nextError instanceof Error ? nextError.message : "Polling failed."));
      });
    }, 1500);

    return () => clearInterval(handle);
  }, [job]);

  useEffect(() => {
    if (!job || !isTerminal(job.status)) {
      return;
    }
    void refreshHistory();
  }, [job]);

  function resetComposer() {
    startTransition(() => {
      setFile(null);
      setAsset(null);
      setJob(null);
      setError(null);
      setDragActive(false);
    });
  }

  function adoptFile(nextFile: File | null) {
    if (!nextFile) {
      return;
    }

    if (!nextFile.type.startsWith("image/") && !nextFile.type.startsWith("video/")) {
      setError("暂不支持这个文件类型，请上传图片或视频。");
      return;
    }

    startTransition(() => {
      setFile(nextFile);
      setAsset(null);
      setJob(null);
      setError(null);
    });
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    adoptFile(event.dataTransfer.files?.[0] ?? null);
  }

  function handleDragState(event: DragEvent<HTMLElement>, next: boolean) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(next);
  }

  async function handleRun() {
    if (!file) {
      setError("请先选择一张图片或一段视频，再开始处理。");
      return;
    }

    if (!isModeCompatible(mode, inferredMediaType)) {
      setError("当前模式和素材类型不匹配，请切换模式后重试。");
      return;
    }

    setSubmitting(true);
    setError(null);
    setAsset(null);
    setJob(null);
    void refreshHealth();

    try {
      const formData = new FormData();
      formData.append("file", file);

      const uploadResponse = await fetch(`${ENGINE_URL}/api/uploads`, {
        method: "POST",
        body: formData,
      });
      if (!uploadResponse.ok) {
        const payload = await uploadResponse.json().catch(() => null);
        throw new Error(payload?.detail ?? "Upload failed.");
      }

      const uploadedAsset: AssetRecord = await uploadResponse.json();
      setAsset(uploadedAsset);

      const jobResponse = await fetch(`${ENGINE_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: uploadedAsset.id, mode }),
      });
      if (!jobResponse.ok) {
        const payload = await jobResponse.json().catch(() => null);
        throw new Error(payload?.detail ?? "Job creation failed.");
      }

      const createdJob: JobRecord = await jobResponse.json();
      setJob(createdJob);
      setHistory((current) => [createdJob, ...current.filter((item) => item.id !== createdJob.id)].slice(0, 8));
    } catch (nextError) {
      setError(humanizeError(nextError instanceof Error ? nextError.message : "Unexpected failure."));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSelectHistory(item: JobRecord) {
    startTransition(() => {
      setJob(item);
      setError(null);
    });

    void syncJob(item.id).catch((nextError) => {
      setError(humanizeError(nextError instanceof Error ? nextError.message : "Polling failed."));
    });
  }

  return (
    <main className="studio-shell relative min-h-screen overflow-x-clip text-[var(--foreground)]">
      <div className="studio-grid pointer-events-none absolute inset-0 opacity-50" />
      <div className="pointer-events-none absolute left-[-8%] top-[-5rem] h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(20,109,103,0.2),transparent_68%)] blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-8rem] right-[-8%] h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(211,109,56,0.18),transparent_68%)] blur-3xl" />

      <section className="relative mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6 lg:px-10 lg:py-8">
        <header className="hero-panel relative overflow-hidden rounded-[36px] border px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10">
          <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[42%] bg-[radial-gradient(circle_at_20%_30%,rgba(20,109,103,0.22),transparent_55%)] xl:block" />
          <div className="pointer-events-none absolute inset-x-[30%] top-12 h-px bg-[linear-gradient(90deg,transparent,rgba(20,109,103,0.24),transparent)]" />

          <div className="relative grid gap-8 xl:grid-cols-[minmax(0,1.16fr)_420px] xl:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="studio-chip font-mono text-[10px] uppercase tracking-[0.32em]">JINGYING STUDIO</span>
                <span className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] ${statusTone(engineStatus)}`}>
                  引擎 {prettyEngineStatus(engineStatus)}
                </span>
              </div>

              <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.38em] text-[var(--muted)]">
                Local-first media cleanup atelier
              </p>
              <h1 className="display-font mt-4 max-w-5xl text-[2.6rem] leading-[0.95] tracking-[-0.05em] text-[var(--foreground)] sm:text-[4.2rem] lg:text-[5.35rem]">
                让去字、去字幕、去水印，
                <span className="text-[var(--accent-strong)]">像进片前的质检工序一样可靠。</span>
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-8 text-[var(--muted-strong)] sm:text-lg">
                净影工坊不是追求“一键神奇修复”的魔法按钮，而是把检测、验证、修补拆开给你看。
                只有当识别结果足够稳定、置信度足够高时，系统才会真正输出结果。
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <a className="studio-button-primary" href="#workspace">
                  进入工作台
                </a>
                <a className="studio-button-secondary" href="#history">
                  查看最近任务
                </a>
              </div>

              <div className="mt-8 grid gap-3 md:grid-cols-3">
                {WORKFLOW_STEPS.map((step, index) => (
                  <article
                    key={step.id}
                    className="studio-inset rounded-[26px] px-4 py-4 [animation:rise-in_720ms_cubic-bezier(.2,.8,.2,1)_both]"
                    style={{ animationDelay: `${index * 120}ms` }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(20,109,103,0.14)] bg-white/70 font-mono text-[11px] tracking-[0.2em] text-[var(--accent-strong)]">
                        {step.id}
                      </span>
                      <p className="text-base font-semibold">{step.title}</p>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{step.description}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Session Brief</p>
                  <h2 className="display-font mt-2 text-3xl tracking-[-0.04em]">当前会话</h2>
                </div>
                <button
                  className="studio-button-secondary !px-4 !py-2 text-xs"
                  onClick={() => {
                    void refreshHealth();
                    void refreshHistory();
                  }}
                  type="button"
                >
                  刷新状态
                </button>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="studio-inset rounded-[24px] px-4 py-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">素材</p>
                  <p className="mt-2 text-sm font-medium text-[var(--muted-strong)]">
                    {file?.name ?? asset?.original_name ?? "还没有选择文件"}
                  </p>
                </div>
                <div className="studio-inset rounded-[24px] px-4 py-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">模式</p>
                  <p className="mt-2 text-sm font-medium text-[var(--muted-strong)]">{activeMode.title}</p>
                </div>
                <div className="studio-inset rounded-[24px] px-4 py-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">边界</p>
                  <p className="mt-2 text-sm font-medium text-[var(--muted-strong)]">1080p / 3 分钟 / 500MB</p>
                </div>
                <div className="studio-inset rounded-[24px] px-4 py-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">策略</p>
                  <p className="mt-2 text-sm font-medium text-[var(--muted-strong)]">低置信度直接失败，不硬修</p>
                </div>
              </div>

              <div className="mt-5 space-y-3">
                {PRINCIPLES.map((item) => (
                  <div key={item} className="flex items-start gap-3 text-sm leading-6 text-[var(--muted-strong)]">
                    <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </header>
        <section
          id="workspace"
          className="grid gap-6 xl:grid-cols-[minmax(0,1.06fr)_minmax(360px,420px)] xl:items-start"
        >
          <div className="flex flex-col gap-6">
            <section className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Step 01</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em] sm:text-[2.35rem]">上传并校验素材</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    支持图片和视频。拖拽进入后会先生成预览，再决定是否提交到引擎。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {["本地优先", "图片 / 视频", "自动预览"].map((pill) => (
                    <span key={pill} className="studio-chip text-xs text-[var(--muted-strong)]">
                      {pill}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.94fr)_minmax(280px,0.82fr)]">
                <div>
                  <label
                    className="studio-upload group flex min-h-[270px] cursor-pointer flex-col justify-between rounded-[30px] p-5 sm:p-6"
                    data-active={dragActive}
                    onDragEnter={(event) => handleDragState(event, true)}
                    onDragLeave={(event) => handleDragState(event, false)}
                    onDragOver={(event) => handleDragState(event, true)}
                    onDrop={handleDrop}
                  >
                    <input
                      accept="image/*,video/*"
                      className="sr-only"
                      onChange={(event) => adoptFile(event.target.files?.[0] ?? null)}
                      type="file"
                    />

                    <div>
                      <span className="studio-chip font-mono text-[10px] uppercase tracking-[0.3em]">Drop Zone</span>
                      <h3 className="mt-4 text-2xl font-semibold tracking-[-0.04em]">
                        {file ? "素材已就绪，可以继续选模式。" : "把文件拖进来，或点击这里选择。"}
                      </h3>
                      <p className="mt-3 max-w-xl text-sm leading-7 text-[var(--muted)]">
                        {file
                          ? "重新选择文件会重置当前会话，便于快速对比不同素材。"
                          : "视频会在提交前校验时长、尺寸和大小限制。图片会直接生成预览。"}
                      </p>
                    </div>

                    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                      <div className="flex flex-wrap gap-2">
                        {[
                          `引擎 ${prettyEngineStatus(engineStatus)}`,
                          inferredMediaType === "image"
                            ? "当前素材：图片"
                            : inferredMediaType === "video"
                              ? "当前素材：视频"
                              : "当前素材：未识别",
                          "自动校验限制",
                        ].map((pill) => (
                          <span key={pill} className="rounded-full border border-white/70 bg-white/72 px-3 py-1 text-xs font-medium text-[var(--muted-strong)]">
                            {pill}
                          </span>
                        ))}
                      </div>
                      <div className="text-sm text-[var(--muted)]">支持拖拽上传，减少来回点选。</div>
                    </div>
                  </label>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {file ? (
                      <>
                        <span className="rounded-full border border-[rgba(20,109,103,0.16)] bg-[rgba(20,109,103,0.11)] px-3 py-1 text-xs font-medium text-[var(--accent-strong)]">
                          {file.name}
                        </span>
                        {mediaMeta.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-[var(--line)] bg-white/80 px-3 py-1 text-xs font-medium text-[var(--muted-strong)]"
                          >
                            {item}
                          </span>
                        ))}
                        <button className="studio-button-secondary !px-4 !py-2 text-xs" onClick={resetComposer} type="button">
                          清空会话
                        </button>
                      </>
                    ) : (
                      <span className="text-sm text-[var(--muted)]">还没有选择文件，先拖入一张图片或一段视频。</span>
                    )}
                  </div>
                </div>

                <div className="grid gap-4">
                  <article className="preview-panel overflow-hidden rounded-[26px]">
                    <div className="flex items-center justify-between border-b border-[var(--line)] bg-white/72 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold">原始预览</p>
                        <p className="mt-1 text-xs text-[var(--muted)]">进入处理前先确认素材状态。</p>
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                        {inferredMediaType === "image" ? "IMAGE" : inferredMediaType === "video" ? "VIDEO" : "IDLE"}
                      </span>
                    </div>
                    {sourcePreviewUrl ? (
                      file?.type.startsWith("video/") && !asset?.preview_url ? (
                        <video className="max-h-[260px] w-full bg-black object-cover" controls muted src={sourcePreviewUrl} />
                      ) : (
                        <img alt="Source preview" className="max-h-[260px] w-full bg-black object-cover" src={sourcePreviewUrl} />
                      )
                    ) : (
                      <div className="flex min-h-[220px] items-center justify-center px-6 text-center text-sm leading-7 text-[var(--muted)]">
                        选择文件后，这里会显示原始预览。
                      </div>
                    )}
                  </article>

                  <article className="preview-panel overflow-hidden rounded-[26px]">
                    <div className="flex items-center justify-between border-b border-[var(--line)] bg-white/72 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold">检测标注图</p>
                        <p className="mt-1 text-xs text-[var(--muted)]">处理完成后可回看系统删除的区域。</p>
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">ANALYSIS</span>
                    </div>
                    {analysisUrl ? (
                      <img alt="Detection preview" className="max-h-[260px] w-full bg-black object-cover" src={analysisUrl} />
                    ) : (
                      <div className="flex min-h-[220px] items-center justify-center px-6 text-center text-sm leading-7 text-[var(--muted)]">
                        任务完成后，这里会出现带框选标注的分析图。
                      </div>
                    )}
                  </article>
                </div>
              </div>
            </section>
            <section className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Step 02</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em] sm:text-[2.35rem]">选择处理模式</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    当前文件类型会自动过滤不兼容模式，减少无效提交和来回试错。
                  </p>
                </div>
                <div className="text-sm text-[var(--muted)]">
                  当前选择：<span className="font-semibold text-[var(--foreground)]">{activeMode.title}</span>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                {MODE_OPTIONS.map((option) => {
                  const active = option.value === mode;
                  const compatible = isModeCompatible(option.value, inferredMediaType);
                  return (
                    <button
                      key={option.value}
                      className={`group rounded-[28px] border px-5 py-5 text-left ${
                        active
                          ? "border-[rgba(20,109,103,0.26)] bg-[linear-gradient(180deg,rgba(20,109,103,0.13),rgba(255,251,246,0.96))] shadow-[0_24px_52px_rgba(20,109,103,0.12)]"
                          : compatible
                            ? "bg-white/70 hover:-translate-y-0.5 hover:border-[rgba(20,109,103,0.25)]"
                            : "bg-white/45 opacity-45"
                      }`}
                      disabled={!compatible}
                      onClick={() => setMode(option.value)}
                      type="button"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xl font-semibold tracking-[-0.03em]">{option.title}</p>
                          <p className="mt-3 text-sm leading-7 text-[var(--muted)]">{option.description}</p>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] ${badgeTone(option.badge)}`}>
                          {compatible ? option.badge : "不可用"}
                        </span>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <span className="rounded-full border border-[var(--line)] bg-white/80 px-3 py-1 text-xs font-medium text-[var(--muted-strong)]">
                          {option.focus}
                        </span>
                        <span className="rounded-full border border-[var(--line)] bg-white/80 px-3 py-1 text-xs font-medium text-[var(--muted-strong)]">
                          {option.mediaType === "all"
                            ? "图片 / 视频"
                            : option.mediaType === "image"
                              ? "仅图片"
                              : "仅视频"}
                        </span>
                        {!compatible ? (
                          <span className="rounded-full border border-[rgba(211,109,56,0.18)] bg-[rgba(211,109,56,0.12)] px-3 py-1 text-xs font-medium text-[var(--signal)]">
                            当前文件不可用
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-end">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Step 03</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em] sm:text-[2.35rem]">提交并等待结果</h2>
                  <p className="mt-2 max-w-3xl text-sm leading-7 text-[var(--muted)]">
                    动态水印和烧录字幕会更严格。达不到置信阈值时，系统宁可直接失败，也不会交付明显脏掉的补丁结果。
                  </p>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ["素材", file?.name ?? "未选择"],
                      ["模式", activeMode.title],
                      ["引擎", prettyEngineStatus(engineStatus)],
                      ["预期输出", "先检测图，再决定是否导出"],
                    ].map(([label, value]) => (
                      <div key={label} className="studio-inset rounded-[24px] px-4 py-4">
                        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">{label}</p>
                        <p className="mt-2 text-sm font-medium text-[var(--muted-strong)]">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[28px] border border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,0.72),rgba(248,241,233,0.92))] p-5 shadow-[var(--shadow-soft)]">
                  <button
                    className="studio-button-primary w-full justify-center py-4 text-sm"
                    disabled={runDisabled}
                    onClick={handleRun}
                    type="button"
                  >
                    {submitting ? "正在上传并创建任务..." : "上传并开始处理"}
                  </button>
                  <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{runHint}</p>

                  {taskError ? (
                    <div className="mt-4 rounded-[22px] border border-[rgba(211,109,56,0.2)] bg-[rgba(211,109,56,0.1)] px-4 py-3 text-sm leading-6 text-[var(--signal)]">
                      {taskError}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          </div>

          <aside className="flex flex-col gap-6 xl:sticky xl:top-6">
            <section className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Live Monitor</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em]">当前任务</h2>
                </div>
                <span className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] ${statusTone(job?.status ?? "queued")}`}>
                  {job ? prettyStatus(job.status) : "IDLE"}
                </span>
              </div>

              <div className="mt-4">
                <p className="text-xl font-semibold tracking-[-0.03em]">{taskHeadline}</p>
                <p className="mt-2 text-sm leading-7 text-[var(--muted)]">{taskDescription}</p>
              </div>

              <div className="mt-5 rounded-[24px] border border-[var(--line)] bg-white/72 px-4 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold">{job ? prettyMode(job.mode) : activeMode.title}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {job ? `最近更新于 ${formatDateLabel(job.updated_at)}` : "任务开始后，进度会自动刷新。"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">Progress</p>
                    <p className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{job?.progress ?? 0}%</p>
                  </div>
                </div>

                <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/7">
                  <div
                    className={`progress-fill h-full rounded-full ${job?.status === "running" ? "is-running" : ""}`}
                    style={{ width: `${job?.progress ?? 0}%` }}
                  />
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[20px] border border-[var(--line)] bg-[rgba(255,255,255,0.75)] px-4 py-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">素材</p>
                    <p className="mt-2 text-sm text-[var(--muted-strong)]">
                      {asset?.original_name ?? file?.name ?? "等待上传"}
                    </p>
                  </div>
                  <div className="rounded-[20px] border border-[var(--line)] bg-[rgba(255,255,255,0.75)] px-4 py-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">当前策略</p>
                    <p className="mt-2 text-sm text-[var(--muted-strong)]">低置信度时直接失败</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Result</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em]">处理结果</h2>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {analysisUrl ? (
                    <a
                      className="studio-button-secondary !px-4 !py-2 text-xs"
                      href={analysisUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      查看标注图
                    </a>
                  ) : null}
                  {resultUrl && job?.status === "succeeded" ? (
                    <a
                      className="studio-button-primary !px-4 !py-2 text-xs"
                      href={resultUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      下载结果
                    </a>
                  ) : null}
                </div>
              </div>

              <div className="preview-panel mt-5 overflow-hidden rounded-[28px]">
                {resultUrl && job?.status === "succeeded" ? (
                  job.media_type === "video" ? (
                    <video className="max-h-[360px] w-full bg-black object-cover" controls src={resultUrl} />
                  ) : (
                    <img alt="Cleaned result" className="max-h-[360px] w-full bg-black object-cover" src={resultUrl} />
                  )
                ) : (
                  <div className="flex min-h-[240px] items-center justify-center px-6 text-center text-sm leading-7 text-[var(--muted)]">
                    {job?.status === "failed"
                      ? "任务没有通过当前置信闸门，因此这里不会输出修补后的结果。"
                      : "任务成功后，这里会展示处理后的图片或视频。"}
                  </div>
                )}
              </div>
            </section>

            <section className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">Detection</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em]">检测摘要</h2>
                </div>
                {job?.detections?.length ? (
                  <span className="studio-chip text-xs text-[var(--muted-strong)]">{job.detections.length} 项检测</span>
                ) : null}
              </div>

              {job?.detections?.length ? (
                <div className="mt-5 flex flex-col gap-3">
                  {job.detections.map((detection) => (
                    <article key={detection.label} className="rounded-[24px] border border-[var(--line)] bg-white/72 px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{prettyDetection(detection.label)}</p>
                          <p className="mt-2 text-xs leading-6 text-[var(--muted)]">
                            置信度 {detection.confidence.toFixed(2)}，面积占比 {(detection.area_ratio * 100).toFixed(2)}%
                            {detection.frame_hits ? `，命中 ${detection.frame_hits} 帧` : ""}
                          </p>
                        </div>
                        <span className="rounded-full border border-[rgba(20,109,103,0.16)] bg-[rgba(20,109,103,0.1)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--accent-strong)]">
                          {detection.boxes.length} 框
                        </span>
                      </div>
                      {detection.notes.length ? (
                        <p className="mt-3 text-xs leading-6 text-[var(--muted)]">{detection.notes.join(" ")}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-7 text-[var(--muted)]">
                  处理完成后，这里会说明哪些检测器被触发、置信度有多高，以及最终修补区域的大致规模。
                </p>
              )}
            </section>

            <section id="history" className="studio-panel rounded-[32px] p-5 sm:p-6">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--muted)]">History</p>
                  <h2 className="display-font mt-2 text-[2rem] tracking-[-0.04em]">最近任务</h2>
                </div>
                <button className="studio-button-secondary !px-4 !py-2 text-xs" onClick={() => void refreshHistory()} type="button">
                  刷新列表
                </button>
              </div>

              {history.length ? (
                <div className="mt-5 flex flex-col gap-3">
                  {history.map((item) => {
                    const selected = item.id === job?.id;
                    return (
                      <button
                        key={item.id}
                        className={`rounded-[24px] border px-4 py-4 text-left ${
                          selected
                            ? "border-[rgba(20,109,103,0.22)] bg-[rgba(20,109,103,0.11)]"
                            : "border-[var(--line)] bg-white/72 hover:-translate-y-0.5"
                        }`}
                        onClick={() => handleSelectHistory(item)}
                        type="button"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold">{prettyMode(item.mode)}</p>
                            <p className="mt-2 text-xs leading-6 text-[var(--muted)]">{formatDateLabel(item.updated_at)}</p>
                          </div>
                          <span className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${statusTone(item.status)}`}>
                            {prettyStatus(item.status)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-7 text-[var(--muted)]">
                  最近处理过的任务会显示在这里，方便回看进度和结果。
                </p>
              )}
            </section>

            {job?.logs?.length ? (
              <section className="rounded-[28px] border border-[rgba(14,44,46,0.16)] bg-[#132628] px-5 py-5 text-[#d7ece8] shadow-[0_24px_56px_rgba(10,19,20,0.18)]">
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#8dbcb7]">Engine Notes</p>
                <div className="mt-4 flex flex-col gap-2 text-sm leading-7">
                  {job.logs.map((line, index) => (
                    <p key={`${line}-${index}`}>{line}</p>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>
        </section>
      </section>
    </main>
  );
}
