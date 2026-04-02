# Video Removal From First Principles

## Core formulation

Video watermark removal and subtitle removal are both background recovery problems.

We can write each frame as:

`I_t = alpha_t * O_t + (1 - alpha_t) * B_t`

- `I_t`: observed frame
- `O_t`: overlay foreground, such as watermark, logo, or subtitle glyphs
- `alpha_t`: opacity / matte
- `B_t`: latent clean background

The engineering problem always splits into two stages:

1. Localize the overlay mask `M_t`
2. Reconstruct the occluded background `B_t`

Everything else is a better way to do one of those two steps.

## Four problem types

### Static watermark

The overlay stays at a fixed position across the video.

Useful priors:

- strong corner prior
- long-term edge persistence
- stable geometry across many frames
- low temporal variance after camera alignment

This is the easiest case because time gives repeated chances to estimate the same mask and the same hidden background.

### Dynamic watermark

The overlay moves, fades, or animates.

Useful priors:

- small target prior
- trackable geometry
- moderate temporal continuity
- local appearance stays more consistent than the background

This is harder because the mask is no longer tied to one location. The system needs detection plus tracking, not only detection.

### Bottom subtitles

The subtitle stays near the lower band of the frame.

Useful priors:

- strong bottom-region prior
- horizontal text-line structure
- line-height and aspect-ratio regularity
- short-term temporal persistence

This is usually easier than burned subtitles because the spatial prior is strong.

### Burned-in subtitles

The text is rendered inside the main picture area.

Useful priors:

- text-like edges and strokes
- line structure
- temporal persistence
- center-band or interior-band search rather than full bottom prior

This is harder because the text competes directly with real scene edges, especially when the subtitle overlaps textured backgrounds.

## Mainstream approaches

### Classical pipeline

Typical structure:

1. Detect text/logo candidates with morphology, edge energy, connected components, or OCR-like heuristics
2. Track the candidates across time
3. Build a mask
4. Reconstruct missing pixels from aligned neighbor frames
5. Use image inpainting as fallback

Strengths:

- small dependency footprint
- controllable failure modes
- easy to run locally

Weaknesses:

- brittle on complex motion, transparency, and large occlusions
- struggles on heavily animated watermarks and difficult burned subtitles

### Deep detection + deep inpainting

Modern systems still follow the same `mask -> reconstruct` decomposition, but each block becomes learned.

Common design:

1. Text / logo detector or segmentation network for `M_t`
2. Optical flow or learned propagation across time
3. Video inpainting model for `B_t`

Representative references:

- [STTN](https://arxiv.org/abs/2007.10247)
- [E2FGVI](https://github.com/MCG-NKU/E2FGVI)
- [ProPainter](https://arxiv.org/abs/2309.03897)
- [Deep Blind Video Decaptioning](https://openaccess.thecvf.com/content_CVPR_2019/papers/Kim_Deep_Blind_Video_Decaptioning_by_Temporal_Aggregation_and_Recurrence_CVPR_2019_paper.pdf)
- [Video_Decaptioning official implementation](https://github.com/Linya-lab/Video_Decaptioning)
- [DB / DBNet](https://github.com/MhLiao/DB)
- [CRAFT](https://github.com/clovaai/CRAFT-pytorch)
- [LaMa](https://github.com/advimman/lama)

Strengths:

- much better on large masks, transparency, and complex motion
- better texture hallucination and temporal coherence

Weaknesses:

- heavier runtime and deployment cost
- model weights and dependency management become first-class concerns
- quality can still fail if the mask is wrong

## Current repository strategy

The current repository stays on a classical, heuristic-first stack with OpenCV only.

Current `engine/app/algorithms/video_cleaner.py` now uses:

1. Video-level static watermark analysis
   - corner persistence
   - edge-persistence accumulation
   - stable cluster merging
2. Per-frame candidate localization
   - bottom subtitle ROI
   - burned subtitle full-frame plus interior-band fallback
   - dynamic watermark small-target filtering
3. Temporal stabilization
   - track association using IoU, center-distance, and size consistency
   - track smoothing
   - small-gap interpolation
4. Mask refinement
   - box expansion by label type
   - text-energy plus edge refinement inside each region
5. Reconstruction
   - ECC-based motion compensation
   - per-pixel temporal median / mean background fusion
   - Telea fallback for unresolved pixels

This keeps the runtime simple and local-first, but it is still a conservative pipeline.

## When to upgrade to models

Move to a model-enhanced path when at least one of these becomes common:

- semi-transparent animated watermarks
- large logo overlays with non-text shapes
- heavy camera motion or zoom
- subtitles over highly textured content
- multi-line or stylized burned text
- stronger temporal consistency requirements

## Recommended model roadmap

### Step 1: better mask generation

Add an optional detector layer:

- DBNet or CRAFT for subtitle / burned-text localization
- a lightweight logo detector or segmentation model for non-text watermarks

### Step 2: better background reconstruction

Add an optional video inpainting backend:

- E2FGVI or ProPainter for default video inpainting
- LaMa as fallback for isolated frames or unresolved areas

### Step 3: dual backend

Keep two backends:

- `classical`: low dependency, fast local mode
- `model`: higher quality mode for harder inputs

That lets the product stay usable without GPU or heavy weights, while still having an upgrade path for difficult cases.
