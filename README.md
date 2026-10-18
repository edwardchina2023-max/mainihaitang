# 麦尼海塘 MANI GARDEN · 官网

线上地址：<https://www.mainihaitang.com>（GitHub Pages，自有域名，根路径发布）

这是黄海在理塘麦尼海塘的第一人称牧场档案站：我在远方、拉波日记、麦尼牧场、理塘风物、山中四季、求真溯源、风的消息。

## 备份与恢复

| 备份 | 内容 | 创建时间 |
| --- | --- | --- |
| 分支 `backup/2026-10-18-before-optimization` | 2026-10-18 优化前的完整网站（提交 60baae4） | 2026-10-18 |

恢复方式（任选其一，都会新建一个“恢复提交”，不改写历史，恢复后仍可再撤销）：

1. **网页一键恢复**：仓库 → Actions → “一键恢复到备份版本” → Run workflow → 确认框输入 `RESTORE`。
2. **命令行**：`bash scripts/restore-backup.sh`（可在后面加其它备份分支名）。
3. **直接告诉 Claude “恢复麦尼海塘备份”**，由 Claude 执行第 2 种方式。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html`、各栏目目录 | 静态页面（含 `data-sss` 可视化编辑标记，请勿删除） |
| `assets/` | 样式与 `mani-video.js`（视频进入视口才播放） |
| `media/` | 图片、视频、音频；`media/posters/` 为视频封面 |
| `sitemap.xml`、`robots.txt` | 搜索引擎收录 |
| `og.jpg` | 分享卡片图（1200×630） |
| `scripts/` | 导出、优化、校验、恢复脚本 |

## 更新流程

日常改文字、换图片：用可视化编辑后台直接修改页面即可，改完运行第 3、4 步。

如果从《行路不难》项目工作区重新导出整站：

```bash
node scripts/export-static.mjs /absolute/path/to/website/dist   # 1. 导出（会覆盖页面与 media）
python3 scripts/optimize-media.py                              # 2. 视频压缩、封面、品牌小图（已处理的自动跳过）
node scripts/optimize-static.mjs                               # 3. SEO、分享、视频懒加载、sitemap
node scripts/validate-static.mjs                               # 4. 发布前校验
```

新增视频后同样运行第 2–4 步，脚本会自动生成封面并改为按需播放。

## 媒体规范

- 图片：WebP，长边 ≤1600px。
- 视频：H.264 + faststart；首屏视频 1080p，其余长边 ≤1280px、帧率 ≤30。
- 只有首页首屏视频原生自动播放；其余视频进入视口才加载、静音循环；访客开启“减少动态效果”或省流量模式时不自动播放。

## 内容边界

公开站点只保存已分级的公开资料，不存证件、完整录音、联系方式、精确位置、未授权影像或完整账本。AI 未生成任何冒充现场的纪实影像。
