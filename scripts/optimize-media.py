#!/usr/bin/env python3
"""麦尼海塘 · 媒体优化脚本

做三件事（可重复运行，已处理过的文件会自动跳过）：
1. 视频转码：H.264 + faststart，非首屏视频长边 ≤1280，首屏视频保留 1080p；
   只有新文件比原文件小 15% 以上才替换。
2. 视频封面：为每段视频截取一帧，生成 /media/posters/<路径>.webp。
3. 品牌小图：生成网页用的 WebP 版 wordmark / 印章，以及 favicon、分享图。

用法：python3 scripts/optimize-media.py [仓库根目录]
依赖：ffmpeg、ffprobe（Pillow 可选，用于 favicon.ico）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
TAG = "mani-optimized-v1"
# 首屏视频：保留更高分辨率，保证大屏观感
HERO_VIDEOS = {"media/video/herd-home.mp4"}
# 个别视频开头画面不具代表性，指定封面取帧时间（秒）
POSTER_TIME = {
    "media/series/video/matsutake-walk.mp4": 6,
    "media/archive/video/matsutake-field.mp4": 6,
    "media/archive/video/wildlife-1.mp4": 9,
}


def run(cmd):
    """执行命令，失败时抛出带输出的异常。"""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"命令失败：{' '.join(cmd)}\n{result.stderr[-1500:]}")
    return result.stdout


MANIFEST_PATH = os.path.join(ROOT, "scripts", "media-manifest.json")
try:
    with open(MANIFEST_PATH, encoding="utf-8") as fh:
        MANIFEST = json.load(fh)
except (OSError, ValueError):
    MANIFEST = {}


def probe(path):
    data = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]))
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in data["streams"])
    comment = data.get("format", {}).get("tags", {}).get("comment", "")
    return int(video["width"]), int(video["height"]), float(data["format"]["duration"]), has_audio, comment, video.get("codec_name", "")


def transcode(rel):
    src = os.path.join(ROOT, rel)
    if MANIFEST.get(rel) == os.path.getsize(src):
        return f"跳过（已处理） {rel}"
    result = _transcode(rel)
    MANIFEST[rel] = os.path.getsize(src)
    return result


def _transcode(rel):
    src = os.path.join(ROOT, rel)
    width, height, duration, has_audio, comment, codec = probe(src)
    if comment == TAG:
        return f"跳过（已优化） {rel}"
    must_convert = codec != "h264"  # 例如手机拍的 HEVC，很多浏览器播不了
    hero = rel in HERO_VIDEOS
    long_side = 1920 if hero else 1280
    crf = "25" if hero else "26"
    scale = (
        f"scale='if(gte(iw,ih),min({long_side},iw),-2)':'if(gte(iw,ih),-2,min({long_side},ih))'"
    )
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "out.mp4")
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-i", src,
            "-vf", f"{scale},fps=fps='min(source_fps,30)'",
            "-c:v", "libx264", "-preset", "medium", "-crf", crf,
            "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-maxrate", "3M" if hero else "2.4M", "-bufsize", "6M",
        ]
        cmd += ["-c:a", "aac", "-b:a", "96k"] if has_audio else ["-an"]
        cmd += ["-movflags", "+faststart", "-metadata", f"comment={TAG}", out]
        run(cmd)
        before, after = os.path.getsize(src), os.path.getsize(out)
        if must_convert or after < before * 0.85:
            shutil.move(out, src)
            return f"压缩 {rel}: {before/1e6:.1f}MB → {after/1e6:.1f}MB"
        return f"保留原文件 {rel}: 压缩收益不足（{before/1e6:.1f}MB → {after/1e6:.1f}MB）"


def poster(rel):
    """为视频生成封面图，取 1 秒处（短视频取 10%）的画面。"""
    src = os.path.join(ROOT, rel)
    name = rel[len("media/"):-len(".mp4")].replace("/", "-") + ".webp"
    dst = os.path.join(ROOT, "media", "posters", name)
    if os.path.exists(dst):
        return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    duration = probe(src)[2]
    at = POSTER_TIME.get(rel, min(1.0, duration * 0.1))
    run([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{at:.2f}", "-i", src, "-frames:v", "1",
        "-vf", "scale='if(gte(iw,ih),min(1600,iw),-2)':'if(gte(iw,ih),-2,min(1600,ih))'",
        "-c:v", "libwebp", "-quality", "72", dst,
    ])
    return dst


def brand_assets():
    brand = os.path.join(ROOT, "media", "brand")
    jobs = [
        ("mani-garden-wordmark.png", "mani-garden-wordmark.webp", 720),
        ("mani-garden-seal.png", "mani-garden-seal.webp", 480),
    ]
    for src, dst, width in jobs:
        out = os.path.join(brand, dst)
        if not os.path.exists(out):
            run(["ffmpeg", "-y", "-v", "error", "-i", os.path.join(brand, src),
                 "-vf", f"scale={width}:-2", "-c:v", "libwebp", "-quality", "86", out])
    seal = os.path.join(brand, "mani-garden-seal.png")
    icons = [("favicon-32.png", 32), ("apple-touch-icon.png", 180), ("icon-512.png", 512)]
    for name, size in icons:
        out = os.path.join(ROOT, name)
        if not os.path.exists(out):
            run(["ffmpeg", "-y", "-v", "error", "-i", seal, "-vf",
                 f"scale={size}:{size}:force_original_aspect_ratio=decrease,"
                 f"pad={size}:{size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000", out])
    ico = os.path.join(ROOT, "favicon.ico")
    if not os.path.exists(ico):
        try:
            from PIL import Image
            Image.open(os.path.join(ROOT, "icon-512.png")).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
        except ImportError:
            print("未安装 Pillow，跳过 favicon.ico")
    og = os.path.join(ROOT, "og.jpg")
    if not os.path.exists(og):
        run(["ffmpeg", "-y", "-v", "error", "-i", os.path.join(ROOT, "og.png"), "-q:v", "3", og])


def main():
    videos = []
    for directory, _, files in os.walk(os.path.join(ROOT, "media")):
        for f in files:
            if f.endswith(".mp4"):
                videos.append(os.path.relpath(os.path.join(directory, f), ROOT))
    for rel in sorted(videos):
        print(transcode(rel), flush=True)
        poster(rel)
    # 删掉已不存在的视频记录，再保存清单（下次运行跳过已处理的视频）
    for rel in list(MANIFEST):
        if rel not in videos:
            del MANIFEST[rel]
    with open(MANIFEST_PATH, "w", encoding="utf-8") as fh:
        json.dump(MANIFEST, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    brand_assets()
    print(f"完成：{len(videos)} 段视频已检查，封面与品牌图已生成。")


if __name__ == "__main__":
    main()
