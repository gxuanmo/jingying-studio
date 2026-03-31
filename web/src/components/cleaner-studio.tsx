"use client";
/* eslint-disable @next/next/no-img-element */

import { startTransition, useEffect, useEffectEvent, useMemo, useState } from "react";

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
  mediaType: MediaType | "all";
  description: string;
}> = [
  {
    value: "auto",
    title: "自动模式",
    badge: "推荐",
    mediaType: "all",
    description: "自动尝试所有兼容的 classical 检测器，只有置信度过线时才会输出结果。",
  },
  {
    value: "image_text",
    title: "图片去文字",
    badge: "图片",
    mediaType: "image",
    description: "针对截图、海报和商品图里的文字做检测与修补。",
  },
  {
    value: "image_watermark",
    title: "图片去水印",
    badge: "图片",
    mediaType: "image",
    description: "优先处理角标水印、重复平铺水印和边缘稳定的 logo 区域。",
  },
  {
    value: "video_static_watermark",
    title: "视频静态水印",
    badge: "视频",
    mediaType: "video",
    description: "结合角落长期稳定性与边缘持久性分析，再用邻近帧做时域修复。",
  },
  {
    value: "video_dynamic_watermark",
    title: "视频动态水印",
    badge: "Beta",
    mediaType: "video",
    description: "跟踪小型移动浮层，置信度不够时会直接失败，不输出脏结果。",
  },
  {
    value: "video_bottom_subtitles",
    title: "底部字幕",
    badge: "视频",
    mediaType: "video",
    description: "聚焦底部字幕带，构建稳定行框，并从对齐邻帧里恢复背景。",
  },
  {
    value: "video_burned_subtitles",
    title: "烧录字幕",
    badge: "Beta",
    mediaType: "video",
    description: "尝试处理画面内部的硬字幕，跨帧稳定性不足时会快速失败。",
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

function assetMeta(asset: AssetRecord | null) {
  if (!asset) {
    return [];
  }

  const sizeMb = asset.file_size_bytes ? `${(asset.file_size_bytes / (1024 * 1024)).toFixed(1)}MB` : null;
  return [
    `${asset.width} x ${asset.height}`,
    asset.media_type === "video" && asset.duration_seconds > 0 ? `${asset.duration_seconds.toFixed(1)}s` : null,
    sizeMb,
    asset.media_type.toUpperCase(),
  ].filter(Boolean) as string[];
}

function statusTone(status: JobStatus | EngineStatus) {
  if (status === "online" || status === "succeeded") {
    return "bg-[rgba(11,122,117,0.12)] text-[var(--accent-strong)] border-[rgba(11,122,117,0.18)]";
  }
  if (status === "failed" || status === "offline") {
    return "bg-[rgba(221,107,45,0.12)] text-[var(--signal)] border-[rgba(221,107,45,0.2)]";
  }
  return "bg-white/75 text-[var(--muted)] border-[var(--line)]";
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

  const activeMode = MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[0];
  const inferredMediaType = inferMediaType(file, asset);

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
      if (!response.ok) {
        throw new Error("History refresh failed.");
      }
      const jobs: JobRecord[] = await response.json();
      startTransition(() => {
        setHistory(jobs.slice(0, 8));
      });
    } catch {
      // Keep history best-effort and silent.
    }
  }

  async function refreshHealth() {
    try {
      const response = await fetch(`${ENGINE_URL}/api/health`);
      if (!response.ok) {
        throw new Error("Engine unavailable.");
      }
      startTransition(() => {
        setEngineStatus("online");
      });
    } catch {
      startTransition(() => {
        setEngineStatus("offline");
      });
    }
  }

  const pollJob = useEffectEvent(async (jobId: string) => {
    const response = await fetch(`${ENGINE_URL}/api/jobs/${jobId}`);
    if (!response.ok) {
      throw new Error("Failed to refresh job status.");
    }
    const nextJob: JobRecord = await response.json();
    startTransition(() => {
      setJob(nextJob);
      setHistory((current) => {
        const merged = [nextJob, ...current.filter((item) => item.id !== nextJob.id)];
        return merged.slice(0, 8);
      });
    });
  });

  useEffect(() => {
    void refreshHealth();
    void refreshHistory();
  }, []);

  useEffect(() => {
    if (!job || isTerminal(job.status)) {
      return undefined;
    }

    const handle = setInterval(() => {
      void pollJob(job.id).catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "Polling failed.");
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

  async function handleRun() {
    if (!file) {
      setError("Choose an image or video first.");
      return;
    }

    if (!isModeCompatible(mode, inferredMediaType)) {
      setError("This mode is not compatible with the current file type.");
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          asset_id: uploadedAsset.id,
          mode,
        }),
      });
      if (!jobResponse.ok) {
        const payload = await jobResponse.json().catch(() => null);
        throw new Error(payload?.detail ?? "Job creation failed.");
      }

      const createdJob: JobRecord = await jobResponse.json();
      setJob(createdJob);
      setHistory((current) => [createdJob, ...current.filter((item) => item.id !== createdJob.id)].slice(0, 8));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unexpected failure.");
    } finally {
      setSubmitting(false);
    }
  }

  const sourcePreviewUrl = useMemo(() => {
    if (asset?.preview_url) {
      return buildUrl(asset.preview_url);
    }
    return previewUrl;
  }, [asset?.preview_url, previewUrl]);

  const resultUrl = buildUrl(job?.result_url);
  const analysisUrl = buildUrl(job?.analysis_url);
  const mediaMeta = assetMeta(asset);

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 text-[var(--foreground)] sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-0 grid-lines opacity-35" />
      <section className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="glass-card hero-sheen relative overflow-hidden rounded-[32px] border px-6 py-8 sm:px-8 sm:py-10">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[radial-gradient(circle_at_center,rgba(11,122,117,0.18),transparent_68%)] lg:block" />
          <div className="relative flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">
                JINGYING STUDIO / 净影工坊 / LOCAL FIRST
              </p>
              <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-[-0.05em] sm:text-6xl lg:text-7xl">
                中文友好的去字、去字幕、去水印工作台
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--muted)] sm:text-lg">
                这套工具偏保守路线：优先给你看清楚它检测到了什么、准备删哪里，再决定是否输出结果，
                而不是为了“一键神奇修复”去硬凑脏结果。
              </p>
            </div>
            <div className="grid w-full max-w-xl grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["引擎状态", prettyEngineStatus(engineStatus)],
                ["图片能力", "去字 + 去水印"],
                ["视频能力", "水印 + 字幕"],
                ["处理限制", "1080p / 3分钟 / 500MB"],
              ].map(([label, value]) => (
                <div key={label} className="metric-chip rounded-[22px] px-4 py-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">{label}</p>
                  <p className="mt-2 text-sm font-medium">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.12fr)_minmax(360px,0.88fr)]">
          <div className="glass-card rounded-[30px] border p-5 sm:p-6">
            <div className="flex flex-col gap-6">
              <div>
                <div className="flex items-center justify-between">
                  <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">上传素材</p>
                  <span
                    className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] ${statusTone(engineStatus)}`}
                  >
                    {prettyEngineStatus(engineStatus)}
                  </span>
                </div>
                <div className="mt-3 rounded-[26px] border border-dashed border-[var(--line)] bg-[var(--card-strong)] p-5">
                  <label className="flex cursor-pointer flex-col gap-3">
                    <span className="text-lg font-medium">选择要处理的图片或视频</span>
                    <span className="text-sm leading-6 text-[var(--muted)]">
                      视频会先校验时长、尺寸和大小限制。引擎离线时页面仍可浏览，但不会提交新任务。
                    </span>
                    <input
                      accept="image/*,video/*"
                      className="mt-2 block w-full cursor-pointer rounded-2xl border border-[var(--line)] bg-white/70 px-4 py-3 text-sm"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      type="file"
                    />
                  </label>

                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    <div className="overflow-hidden rounded-[24px] border border-[var(--line)] bg-black/5">
                      <div className="flex items-center justify-between border-b border-[var(--line)] bg-white/55 px-4 py-3">
                        <p className="text-sm font-semibold">原始预览</p>
                        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                          {inferredMediaType === "image" ? "图片" : inferredMediaType === "video" ? "视频" : "空闲"}
                        </p>
                      </div>
                      {sourcePreviewUrl ? (
                        file?.type.startsWith("video/") && !asset?.preview_url ? (
                          <video className="max-h-[320px] w-full object-cover" controls muted src={sourcePreviewUrl} />
                        ) : (
                          <img alt="Source preview" className="max-h-[320px] w-full object-cover" src={sourcePreviewUrl} />
                        )
                      ) : (
                        <div className="px-5 py-12 text-sm text-[var(--muted)]">选择文件后，这里会显示原始预览。</div>
                      )}
                    </div>

                    <div className="overflow-hidden rounded-[24px] border border-[var(--line)] bg-black/5">
                      <div className="flex items-center justify-between border-b border-[var(--line)] bg-white/55 px-4 py-3">
                        <p className="text-sm font-semibold">检测预览</p>
                        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                          标注图
                        </p>
                      </div>
                      {analysisUrl ? (
                        <img alt="Detection preview" className="max-h-[320px] w-full object-cover" src={analysisUrl} />
                      ) : (
                        <div className="px-5 py-12 text-sm text-[var(--muted)]">
                          任务完成后，这里会显示一张检测分析图，标出系统决定删除的区域。
                        </div>
                      )}
                    </div>
                  </div>

                  {file ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-medium text-[var(--accent-strong)]">
                        {file.name}
                      </span>
                      {mediaMeta.map((item) => (
                        <span
                          key={item}
                          className="rounded-full border border-[var(--line)] bg-white/70 px-3 py-1 text-xs font-medium"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">处理模式</p>
                  <p className="text-xs text-[var(--muted)]">当前：{activeMode.title}</p>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {MODE_OPTIONS.map((option) => {
                    const active = option.value === mode;
                    const compatible = isModeCompatible(option.value, inferredMediaType);
                    return (
                      <button
                        key={option.value}
                        className={`rounded-[24px] border px-4 py-4 text-left ${
                          active
                            ? "border-[var(--accent)] bg-[linear-gradient(180deg,rgba(11,122,117,0.16),rgba(255,252,247,0.96))] shadow-[0_18px_40px_rgba(11,122,117,0.12)]"
                            : compatible
                              ? "border-[var(--line)] bg-[var(--card-strong)] hover:-translate-y-0.5 hover:border-[rgba(11,122,117,0.36)]"
                              : "border-[var(--line)] bg-white/40 opacity-45"
                        }`}
                        disabled={!compatible}
                        onClick={() => setMode(option.value)}
                        type="button"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-base font-semibold">{option.title}</p>
                            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{option.description}</p>
                          </div>
                          <span className="rounded-full bg-white/80 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--accent-strong)]">
                            {compatible ? option.badge : "未启用"}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-[26px] border border-[var(--line)] bg-[var(--card-strong)] p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">开始处理</p>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--muted)]">
                      动态水印和烧录字幕模式默认更严格。如果置信闸门没过，任务会直接失败，而不是输出一块一块的脏补丁。
                    </p>
                  </div>
                  <button
                    className="rounded-full bg-[var(--foreground)] px-6 py-3 text-sm font-semibold text-white hover:-translate-y-0.5 hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={!file || submitting || engineStatus === "offline"}
                    onClick={handleRun}
                    type="button"
                  >
                    {submitting ? "提交中..." : "上传并处理"}
                  </button>
                </div>
                {error ? (
                  <div className="mt-4 rounded-2xl border border-[rgba(221,107,45,0.22)] bg-[rgba(221,107,45,0.1)] px-4 py-3 text-sm text-[var(--signal)]">
                    {error}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="glass-card rounded-[30px] border p-5 sm:p-6">
            <div className="flex h-full flex-col gap-5">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">当前任务</p>
                <div className="mt-3 rounded-[24px] border border-[var(--line)] bg-[var(--card-strong)] p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-lg font-semibold">{job ? prettyMode(job.mode) : "暂无任务"}</p>
                      <p className="mt-1 text-sm text-[var(--muted)]">
                        {job ? `状态：${prettyStatus(job.status)}` : "上传素材并选择模式后，就会在这里看到任务状态。"}
                      </p>
                    </div>
                    <div
                      className={`rounded-full border px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] ${statusTone(
                        (job?.status as JobStatus | undefined) ?? "queued",
                      )}`}
                    >
                      {job ? `${job.progress}%` : "idle"}
                    </div>
                  </div>

                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/8">
                    <div
                      className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--signal))]"
                      style={{ width: `${job?.progress ?? 0}%` }}
                    />
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[20px] border border-[var(--line)] bg-white/65 px-4 py-3">
                      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">素材</p>
                      <p className="mt-2 text-sm">{asset?.original_name ?? "暂无"}</p>
                    </div>
                    <div className="rounded-[20px] border border-[var(--line)] bg-white/65 px-4 py-3">
                      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                        输出策略
                      </p>
                      <p className="mt-2 text-sm">低置信度时直接失败，不硬出结果。</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-[24px] border border-[var(--line)] bg-[var(--card-strong)] p-4">
                <div className="flex items-center justify-between gap-4">
                  <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">处理结果</p>
                  {resultUrl && job?.status === "succeeded" ? (
                    <a
                      className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-xs font-semibold hover:-translate-y-0.5"
                      href={resultUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      下载结果
                    </a>
                  ) : null}
                </div>
                {resultUrl && job?.status === "succeeded" ? (
                  <div className="mt-4 overflow-hidden rounded-[22px] border border-[var(--line)] bg-black/4">
                    {job.media_type === "video" ? (
                      <video className="max-h-[360px] w-full object-cover" controls src={resultUrl} />
                    ) : (
                      <img alt="Cleaned result" className="max-h-[360px] w-full object-cover" src={resultUrl} />
                    )}
                  </div>
                ) : (
                  <div className="mt-4 rounded-[22px] border border-dashed border-[var(--line)] bg-white/48 px-4 py-10 text-sm text-[var(--muted)]">
                    任务成功后，这里会展示处理后图片或视频。
                  </div>
                )}
              </div>

              <div className="rounded-[24px] border border-[var(--line)] bg-[var(--card-strong)] p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">检测摘要</p>
                {job?.detections?.length ? (
                  <div className="mt-4 flex flex-col gap-3">
                    {job.detections.map((detection) => (
                      <div key={detection.label} className="rounded-[20px] border border-[var(--line)] bg-white/70 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold">{prettyDetection(detection.label)}</p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              置信度 {detection.confidence.toFixed(2)} / 面积占比 {(detection.area_ratio * 100).toFixed(2)}%
                              {detection.frame_hits ? ` / 命中 ${detection.frame_hits} 帧` : ""}
                            </p>
                          </div>
                          <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--accent-strong)]">
                            {detection.boxes.length} 个框
                          </span>
                        </div>
                        {detection.notes.length ? (
                          <p className="mt-3 text-xs leading-5 text-[var(--muted)]">{detection.notes.join(" ")}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
                    处理完成后，这里会显示哪些检测器被触发、置信度是多少，以及最终修补区域大概有多大。
                  </p>
                )}
              </div>

              <div className="rounded-[24px] border border-[var(--line)] bg-[var(--card-strong)] p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[var(--muted)]">最近任务</p>
                {history.length ? (
                  <div className="mt-4 flex flex-col gap-3">
                    {history.map((item) => (
                      <button
                        key={item.id}
                        className="rounded-[20px] border border-[var(--line)] bg-white/70 px-4 py-3 text-left hover:-translate-y-0.5"
                        onClick={() => setJob(item)}
                        type="button"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold">{prettyMode(item.mode)}</p>
                            <p className="mt-1 text-xs text-[var(--muted)]">{formatDateLabel(item.updated_at)}</p>
                          </div>
                          <span className={`rounded-full border px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${statusTone(item.status)}`}>
                            {prettyStatus(item.status)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-[var(--muted)]">最近处理过的任务会显示在这里，方便快速回看。</p>
                )}
              </div>

              {job?.logs?.length ? (
                <div className="rounded-[20px] bg-[#122327] px-4 py-4 text-[#d9ecea]">
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#8ebdb8]">引擎说明</p>
                  <div className="mt-3 flex flex-col gap-2 text-sm leading-6">
                    {job.logs.map((line, index) => (
                      <p key={`${line}-${index}`}>{line}</p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
