"use client";
/* eslint-disable @next/next/no-img-element */

import { startTransition, useEffect, useMemo, useState, type DragEvent, type SVGProps } from "react";

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

type IconProps = SVGProps<SVGSVGElement>;

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
    description: "自动尝试兼容模式，只在置信度足够时输出结果。",
  },
  {
    value: "image_text",
    title: "图片去文字",
    badge: "图片",
    mediaType: "image",
    description: "适合截图、海报和商品图里的文字区域。",
  },
  {
    value: "image_watermark",
    title: "图片去水印",
    badge: "图片",
    mediaType: "image",
    description: "优先处理角标、平铺和边缘稳定的水印。",
  },
  {
    value: "video_static_watermark",
    title: "视频静态水印",
    badge: "视频",
    mediaType: "video",
    description: "适合固定角落或长时间稳定出现的水印。",
  },
  {
    value: "video_dynamic_watermark",
    title: "视频动态水印",
    badge: "Beta",
    mediaType: "video",
    description: "会先验证跨帧稳定性，不够稳定就直接失败。",
  },
  {
    value: "video_bottom_subtitles",
    title: "底部字幕",
    badge: "视频",
    mediaType: "video",
    description: "聚焦底部字幕带，优先恢复邻近帧背景。",
  },
  {
    value: "video_burned_subtitles",
    title: "烧录字幕",
    badge: "Beta",
    mediaType: "video",
    description: "处理画面内部硬字幕，难例会快速失败。",
  },
];

const PUBLIC_MODE_VALUES: JobMode[] = [
  "auto",
  "image_text",
  "image_watermark",
  "video_static_watermark",
  "video_bottom_subtitles",
];

const PUBLIC_MODE_OPTIONS = MODE_OPTIONS.filter((option) => PUBLIC_MODE_VALUES.includes(option.value));

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

function UploadIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function SparkIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    </svg>
  );
}

function ImageIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 16-4.5-4.5L8 20" />
    </svg>
  );
}

function VideoIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <rect x="3" y="5" width="13" height="14" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  );
}

function CheckIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function DownloadIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M4 20h16" />
    </svg>
  );
}

function ClockIcon(props: IconProps) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function modeIcon(mode: JobMode, className: string) {
  if (mode === "auto") return <SparkIcon className={className} />;
  if (mode.startsWith("image_")) return <ImageIcon className={className} />;
  return <VideoIcon className={className} />;
}

function isTerminal(status?: JobStatus) {
  return status === "succeeded" || status === "failed";
}

function prettyMode(mode: JobMode) {
  return MODE_OPTIONS.find((option) => option.value === mode)?.title ?? mode;
}

function prettyStatus(status: JobStatus) {
  return STATUS_LABELS[status] ?? status;
}

function prettyEngineStatus(status: EngineStatus) {
  return ENGINE_LABELS[status] ?? status;
}

function prettyDetection(label: string) {
  return DETECTION_LABELS[label] ?? label;
}

function buildUrl(path?: string | null) {
  if (!path) return null;
  return path.startsWith("http") ? path : `${ENGINE_URL}${path}`;
}

function inferMediaType(file: File | null, asset: AssetRecord | null): MediaType | null {
  if (file?.type.startsWith("image/")) return "image";
  if (file?.type.startsWith("video/")) return "video";
  return asset?.media_type ?? null;
}

function isModeCompatible(mode: JobMode, mediaType: MediaType | null) {
  const option = MODE_OPTIONS.find((item) => item.value === mode);
  return !mediaType || !option || option.mediaType === "all" || option.mediaType === mediaType;
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (!bytes) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDuration(seconds: number) {
  if (!seconds) return null;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${remainSeconds} 秒`;
}

function buildAssetMeta(asset: AssetRecord | null, file: File | null) {
  if (asset) {
    return [
      `${asset.width} × ${asset.height}`,
      asset.media_type === "video" ? formatDuration(asset.duration_seconds) : null,
      formatBytes(asset.file_size_bytes),
      asset.media_type === "video" ? "视频" : "图片",
    ].filter(Boolean) as string[];
  }

  if (file) {
    return [file.type.startsWith("video/") ? "视频" : "图片", formatBytes(file.size)].filter(Boolean) as string[];
  }

  return [];
}

function statusTone(status: JobStatus | EngineStatus) {
  if (status === "online" || status === "succeeded") return "ok";
  if (status === "failed" || status === "offline") return "danger";
  return "neutral";
}

function badgeTone(badge: string) {
  if (badge === "推荐") return "ok";
  if (badge === "Beta") return "danger";
  return "neutral";
}

function humanizeError(raw: string | null | undefined) {
  if (!raw) return null;

  const message = raw.trim();
  const lowered = message.toLowerCase();

  if (lowered.includes("choose an image or video first")) return "请先选择图片或视频。";
  if (lowered.includes("not compatible")) return "当前模式和素材类型不匹配。";
  if (lowered.includes("engine unavailable")) return "处理引擎不可用，请确认本地服务已启动。";
  if (lowered.includes("upload failed")) return "素材上传失败，请稍后重试。";
  if (lowered.includes("job creation failed")) return "任务创建失败。";
  if (lowered.includes("unsupported media type")) return "暂不支持这个文件类型。";
  if (lowered.includes("500mb")) return "文件超过 500MB 限制。";
  if (lowered.includes("3 minute")) return "视频时长超过 3 分钟限制。";
  if (lowered.includes("cannot run on an image")) return "当前是图片素材，请切换到图片模式。";
  if (lowered.includes("cannot run on a video")) return "当前是视频素材，请切换到视频模式。";
  if (lowered.includes("polling failed")) return "任务状态刷新失败，请稍后重试。";
  if (lowered.includes("no high-confidence removable watermark or subtitle pattern")) {
    return "没有检测到足够可靠的可移除区域。";
  }
  if (lowered.includes("did not produce a confident removable region")) {
    return "当前模式没有找到足够稳定的修补区域。";
  }

  return message;
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

  const activeMode = MODE_OPTIONS.find((option) => option.value === mode) ?? PUBLIC_MODE_OPTIONS[0];
  const inferredMediaType = inferMediaType(file, asset);
  const mediaMeta = buildAssetMeta(asset, file);
  const sourcePreviewUrl = useMemo(() => {
    if (asset?.preview_url) return buildUrl(asset.preview_url);
    return previewUrl;
  }, [asset?.preview_url, previewUrl]);
  const resultUrl = buildUrl(job?.result_url);
  const analysisUrl = buildUrl(job?.analysis_url);
  const displayError = humanizeError(job?.status === "failed" ? job.error : error);
  const runDisabled = !file || submitting || engineStatus === "offline";

  useEffect(() => {
    if (!isModeCompatible(mode, inferredMediaType)) {
      setMode("auto");
    }
  }, [inferredMediaType, mode]);

  useEffect(() => {
    if (!PUBLIC_MODE_VALUES.includes(mode)) {
      setMode("auto");
    }
  }, [mode]);

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
        setHistory(jobs.slice(0, 6));
      });
    } catch {
      // ignore history failures
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

  async function loadJob(jobId: string) {
    const response = await fetch(`${ENGINE_URL}/api/jobs/${jobId}`);
    if (!response.ok) throw new Error("Polling failed.");

    const nextJob: JobRecord = await response.json();
    startTransition(() => {
      setJob(nextJob);
      setHistory((current) => [nextJob, ...current.filter((item) => item.id !== nextJob.id)].slice(0, 6));
    });
  }

  useEffect(() => {
    void refreshHealth();
    void refreshHistory();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshHealth();
    }, 15000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!job || isTerminal(job.status)) return undefined;

    const timer = setInterval(() => {
      void loadJob(job.id).catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "Polling failed.");
      });
    }, 1500);

    return () => clearInterval(timer);
  }, [job]);

  useEffect(() => {
    if (!job || !isTerminal(job.status)) return;
    void refreshHistory();
  }, [job]);

  function adoptFile(nextFile: File | null) {
    if (!nextFile) return;

    if (!nextFile.type.startsWith("image/") && !nextFile.type.startsWith("video/")) {
      setError("暂不支持这个文件类型。");
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

  function handleDrag(event: DragEvent<HTMLElement>, active: boolean) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(active);
  }

  async function handleRun() {
    if (!file) {
      setError("请先选择图片或视频。");
      return;
    }

    if (!PUBLIC_MODE_VALUES.includes(mode)) {
      setError("当前模式暂未开放。");
      return;
    }

    if (!isModeCompatible(mode, inferredMediaType)) {
      setError("当前模式和素材类型不匹配。");
      return;
    }

    setSubmitting(true);
    setError(null);
    setAsset(null);
    setJob(null);

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
      setHistory((current) => [createdJob, ...current.filter((item) => item.id !== createdJob.id)].slice(0, 6));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unexpected failure.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="panel p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="eyebrow">JINGYING STUDIO</p>
              <h1 className="display-font mt-3 text-4xl tracking-[-0.04em] sm:text-5xl">净影工坊</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)] sm:text-base">
                本地优先的图片 / 视频清理工具。保留必要流程：上传素材、选择模式、查看结果。低置信度场景直接失败，不输出脏结果。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="badge" data-tone={statusTone(engineStatus)}>
                <CheckIcon className="h-4 w-4" />
                引擎 {prettyEngineStatus(engineStatus)}
              </span>
              <span className="badge" data-tone="neutral">1080p / 3 分钟 / 500MB</span>
              <span className="badge" data-tone="neutral">仅保留必要组件</span>
            </div>
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="space-y-6">
            <div className="panel p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="icon-box">
                  <UploadIcon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">上传素材</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">支持图片和视频。拖拽或点击选择，先看预览，再决定是否处理。</p>
                </div>
              </div>

              <label
                className="dropzone mt-5 block rounded-[22px] p-5 sm:p-6"
                data-active={dragActive}
                onDragEnter={(event) => handleDrag(event, true)}
                onDragLeave={(event) => handleDrag(event, false)}
                onDragOver={(event) => handleDrag(event, true)}
                onDrop={handleDrop}
              >
                <input accept="image/*,video/*" className="sr-only" onChange={(event) => adoptFile(event.target.files?.[0] ?? null)} type="file" />
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                    <UploadIcon className="h-4 w-4" />
                    {file ? file.name : "拖拽文件到这里，或点击选择"}
                  </div>
                  <p className="text-sm leading-6 text-[var(--muted)]">视频会在提交前校验大小、时长和分辨率限制。</p>
                </div>
              </label>

              {mediaMeta.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {mediaMeta.map((item) => (
                    <span key={item} className="badge" data-tone="neutral">
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="panel p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="icon-box">
                  <SparkIcon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">选择模式</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">不引入多余筛选器，只保留当前系统支持的模式。</p>
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {PUBLIC_MODE_OPTIONS.map((option) => {
                  const active = option.value === mode;
                  const compatible = isModeCompatible(option.value, inferredMediaType);

                  return (
                    <button
                      key={option.value}
                      className={`mode-card ${active ? "is-active" : ""}`}
                      disabled={!compatible}
                      onClick={() => setMode(option.value)}
                      type="button"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className="icon-box h-9 w-9 rounded-full">{modeIcon(option.value, "h-4 w-4")}</div>
                          <div>
                            <p className="text-sm font-semibold text-[var(--text)]">{option.title}</p>
                            <p className="mt-1 text-sm leading-6 text-[var(--muted)]">{option.description}</p>
                          </div>
                        </div>
                        <span className="badge shrink-0" data-tone={compatible ? badgeTone(option.badge) : "danger"}>
                          {compatible ? option.badge : "不可用"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="panel p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="icon-box">
                  <CheckIcon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">开始处理</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">当前模式：{activeMode.title}。动态水印和烧录字幕会更严格，低置信度任务会直接失败。</p>
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="grid gap-2 text-sm text-[var(--muted)]">
                  <span>素材：{file?.name ?? "未选择"}</span>
                  <span>引擎：{prettyEngineStatus(engineStatus)}</span>
                </div>

                <button className="primary-button justify-center" disabled={runDisabled} onClick={handleRun} type="button">
                  {submitting ? "处理中..." : "上传并处理"}
                </button>
              </div>

              {displayError ? (
                <div className="mt-4 rounded-[18px] border border-[rgba(179,92,58,0.18)] bg-[rgba(179,92,58,0.08)] px-4 py-3 text-sm leading-6 text-[var(--danger)]">
                  {displayError}
                </div>
              ) : null}
            </div>
          </section>

          <aside className="space-y-6">
            <div className="panel p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">当前任务</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">{job ? prettyMode(job.mode) : "等待新任务"}</p>
                </div>
                <span className="badge" data-tone={statusTone(job?.status ?? "queued")}>
                  {job ? prettyStatus(job.status) : "空闲"}
                </span>
              </div>

              <div className="mt-5">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${job?.progress ?? 0}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted)]">
                  <span>{job ? `更新于 ${formatDateLabel(job.updated_at)}` : "尚未开始"}</span>
                  <span>{job?.progress ?? 0}%</span>
                </div>
              </div>

              {(analysisUrl || resultUrl) && job?.status === "succeeded" ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {analysisUrl ? (
                    <a className="secondary-button" href={analysisUrl} rel="noreferrer" target="_blank">
                      查看检测图
                    </a>
                  ) : null}
                  {resultUrl ? (
                    <a className="secondary-button" href={resultUrl} rel="noreferrer" target="_blank">
                      <DownloadIcon className="h-4 w-4" />
                      下载结果
                    </a>
                  ) : null}
                </div>
              ) : null}

              {job?.detections?.length ? (
                <div className="mt-5 space-y-2">
                  {job.detections.slice(0, 4).map((detection) => (
                    <div key={detection.label} className="subtle-panel flex items-start justify-between gap-3 rounded-[16px] px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-[var(--text)]">{prettyDetection(detection.label)}</p>
                        <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                          置信度 {detection.confidence.toFixed(2)}，面积占比 {(detection.area_ratio * 100).toFixed(2)}%
                        </p>
                      </div>
                      <span className="badge" data-tone="neutral">
                        {detection.boxes.length} 框
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {job?.logs?.length ? (
                <div className="mt-5 rounded-[18px] bg-[var(--text)] px-4 py-4 text-sm leading-6 text-white/82">
                  {job.logs.slice(-3).map((line, index) => (
                    <p key={`${line}-${index}`}>{line}</p>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="panel p-5 sm:p-6">
              <h2 className="text-lg font-semibold">预览</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">只保留当前上传预览和处理结果。</p>

              <div className="mt-5 grid gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                    <ImageIcon className="h-4 w-4" />
                    当前上传
                  </div>
                  <div className="preview-frame">
                    {sourcePreviewUrl ? (
                      asset?.preview_url || inferredMediaType === "image" ? (
                        <img alt="当前上传预览" className="max-h-[240px] w-full object-cover" src={sourcePreviewUrl} />
                      ) : (
                        <video className="max-h-[240px] w-full object-cover" controls muted src={sourcePreviewUrl} />
                      )
                    ) : (
                      <div className="preview-empty">选择文件后显示预览</div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                    <SparkIcon className="h-4 w-4" />
                    处理结果
                  </div>
                  <div className="preview-frame">
                    {resultUrl && job?.status === "succeeded" ? (
                      job.media_type === "video" ? (
                        <video className="max-h-[240px] w-full object-cover" controls src={resultUrl} />
                      ) : (
                        <img alt="处理结果" className="max-h-[240px] w-full object-cover" src={resultUrl} />
                      )
                    ) : (
                      <div className="preview-empty">
                        {job?.status === "failed" ? "任务未通过置信判断，未输出结果。" : "处理完成后显示结果。"}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">最近任务</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">快速回看最近处理记录。</p>
                </div>
                <button className="secondary-button" onClick={() => void refreshHistory()} type="button">
                  <ClockIcon className="h-4 w-4" />
                  刷新
                </button>
              </div>

              {history.length ? (
                <div className="mt-5 space-y-2">
                  {history.map((item) => (
                    <button
                      key={item.id}
                      className={`history-item ${item.id === job?.id ? "is-active" : ""}`}
                      onClick={() => {
                        startTransition(() => {
                          setJob(item);
                          setError(null);
                        });
                        void loadJob(item.id).catch((nextError) => {
                          setError(nextError instanceof Error ? nextError.message : "Polling failed.");
                        });
                      }}
                      type="button"
                    >
                      <div className="flex items-start gap-3">
                        <div className="icon-box h-9 w-9 rounded-full">{modeIcon(item.mode, "h-4 w-4")}</div>
                        <div className="min-w-0 text-left">
                          <p className="truncate text-sm font-medium text-[var(--text)]">{prettyMode(item.mode)}</p>
                          <p className="mt-1 text-xs text-[var(--muted)]">{formatDateLabel(item.updated_at)}</p>
                        </div>
                      </div>
                      <span className="badge" data-tone={statusTone(item.status)}>
                        {prettyStatus(item.status)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-6 text-[var(--muted)]">还没有历史任务。</p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
