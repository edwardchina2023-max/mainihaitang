// 麦尼海塘 · 发布前校验
// 用法：node scripts/validate-static.mjs [仓库根目录]
// 校验失败会抛出错误并给出具体文件；全部通过时打印汇总。
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? process.cwd());
const ORIGIN = "https://www.mainihaitang.com";
const ALLOWED_SCRIPTS = [/^<script src="\/assets\/mani-video\.js" defer><\/script>/, /^<script type="application\/ld\+json" id="mani-jsonld">/];

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(target)));
    else files.push(target);
  }
  return files;
}

const exists = (target) => access(target).then(() => true, () => false);
const fail = (message) => {
  throw new Error(message);
};

const htmlFiles = (await collect(root)).filter((file) => file.endsWith(".html"));
if (htmlFiles.length < 17) fail(`页面数量异常：期望至少 17 个（含 404），实际 ${htmlFiles.length}`);

let videoCount = 0;
for (const file of htmlFiles) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const html = await readFile(file, "utf8");
  const isNotFound = rel === "404.html";

  if (/modulepreload|codex-preview|Your site is taking shape|\/manigarden\//i.test(html)) fail(`残留旧构建或子路径标记：${rel}`);
  if (!/麦尼海塘/.test(html)) fail(`缺少品牌内容：${rel}`);

  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    const full = html.slice(html.indexOf(tag), html.indexOf(tag) + 120);
    if (!ALLOWED_SCRIPTS.some((re) => re.test(full))) fail(`出现未登记的脚本：${rel} → ${tag}`);
  }

  const route = "/" + rel.replace(/index\.html$/, "");
  if (isNotFound) {
    if (/rel="canonical"/.test(html)) fail("404 页不应有 canonical");
    if (!/name="robots" content="noindex"/.test(html)) fail("404 页缺少 noindex");
  } else if (!html.includes(`<link rel="canonical" href="${ORIGIN}${route}"/>`)) {
    fail(`canonical 不正确：${rel}`);
  }
  if (!html.includes(`<meta property="og:image" content="${ORIGIN}/og.jpg"/>`)) fail(`og:image 不是绝对地址：${rel}`);

  // 站内链接与资源必须存在
  for (const [, link] of html.matchAll(/(?:href|src|poster)="(\/[^"#?]*)/g)) {
    const relative = link.slice(1);
    const target = relative === "" || relative.endsWith("/") ? path.join(root, relative, "index.html") : path.join(root, relative);
    if (!(await exists(target))) fail(`站内链接失效：${link}（${rel}）`);
  }

  // 视频：都有封面；只有首页首屏视频允许原生自动播放
  const videos = [...html.matchAll(/<video([^>]*)>/g)];
  videoCount += videos.length;
  const autoplay = videos.filter(([, attrs]) => /(?<![-\w])autoplay=/i.test(attrs));
  for (const [, attrs] of videos) if (!/poster="/.test(attrs)) fail(`视频缺少封面：${rel}`);
  if (autoplay.length > (route === "/" || isNotFound ? 1 : 0)) fail(`自动播放视频过多：${rel}（${autoplay.length} 个）`);
  if (videos.length && !html.includes("/assets/mani-video.js")) fail(`有视频但未加载 mani-video.js：${rel}`);
}

for (const required of ["CNAME", "robots.txt", "sitemap.xml", "favicon.ico", "favicon-32.png", "apple-touch-icon.png", "og.jpg", "assets/mani-video.js"]) {
  if (!(await exists(path.join(root, required)))) fail(`缺少文件：${required}`);
}
const cname = (await readFile(path.join(root, "CNAME"), "utf8")).trim();
if (cname !== "www.mainihaitang.com") fail(`CNAME 异常：${cname}`);

const sitemap = await readFile(path.join(root, "sitemap.xml"), "utf8");
const sitemapCount = (sitemap.match(/<loc>/g) ?? []).length;
if (sitemapCount !== htmlFiles.length - 1) fail(`sitemap 收录 ${sitemapCount} 个地址，应为 ${htmlFiles.length - 1}`);

// 关键内容抽查（防止导出或编辑时丢失）
const homepage = await readFile(path.join(root, "index.html"), "utf8");
if (!/\/media\/video\/herd-home\.mp4/.test(homepage)) fail("首页缺少首屏纪实视频");
const diary = await readFile(path.join(root, "diary", "index.html"), "utf8");
if (!/\/media\/archive\/video\/snow-pasture\.mp4/.test(diary) || !/2023年12月14日/.test(diary)) fail("拉波日记缺少 2023年12月14日 雪地牧场记录");
const library = await readFile(path.join(root, "library", "index.html"), "utf8");
if (!/第三方报道/.test(library) || !/\/reports\/life-is-wilderness\//.test(library)) fail("风的消息缺少第三方报道页");
if (/\.pdf|\/media\/reports\//i.test(library)) fail("风的消息不应公开 PDF 文件");

console.log(`校验通过：${htmlFiles.length} 个页面、${videoCount} 个视频、sitemap ${sitemapCount} 个地址，站内链接全部有效。`);
