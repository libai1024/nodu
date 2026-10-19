# SCOPE UI v2 concept images

Created: 2026-10-19, Asia/Shanghai.

These are **AI-generated UI design concepts**, not captures of the working desktop app. Both are labeled `AI 生成概念图` in the image and show synthetic test shapes, with `合成测试帧 · 未连接设备` below the preview. Generated text, code, spacing and illustrative values do not establish implemented behavior; application source and actual runtime screenshots are authoritative.

Provider / tool: OpenAI built-in `image_gen.imagegen`, invoked through `tools.image_gen__imagegen` in built-in mode. No fallback CLI or separate API call was used. No source image was supplied. The underlying model identifier was not returned by the tool.

## Outputs

| File | Concept | Exact prompt | Generated source |
| --- | --- | --- | --- |
| `simple-mode.png` | Default simple layout; code + vision, no explorer or bottom log dock | `simple-mode.prompt.txt` | `/Users/wangwei/.codex/generated_images/01a14fe3-6762-7493-b8a5-8bbdd5a9428d/exec-4661d522-0b5a-4915-9b76-c0bf9a4383d5.png` |
| `professional-mode.png` | Professional layout; explorer + code + vision + log dock | `professional-mode.prompt.txt` | `/Users/wangwei/.codex/generated_images/01a14fe3-6762-7493-b8a5-8bbdd5a9428d/exec-dbf4d7c6-f20d-49fb-bf67-bbb56e3eed92.png` |

Both outputs are 1536 × 1024 PNGs. Files were copied byte-for-byte from the tool output, leaving originals intact. Each returned image was visually inspected for the selected mode, shared project identity, synthetic camera source label, readable primary controls, and expected layout. This revision follows the workspace's established graphite / mineral-mint design language in `DESIGN.md`.
