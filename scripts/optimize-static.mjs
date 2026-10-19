// 麦尼海塘 · 静态页面优化脚本（可重复运行，结果不变）
//
// 用法：node scripts/optimize-static.mjs [仓库根目录]
// 建议顺序：（如有）重新导出页面 → python3 scripts/optimize-media.py → 本脚本 → node scripts/validate-static.mjs
//
// 处理内容：
// 1. canonical、og:url 改为 www.mainihaitang.com 绝对地址；分享图缺失时补默认图；补 og:site_name。
// 2. （页面标题与描述由后台“页面设置”管理，本脚本不改写。）
// 3. favicon、apple-touch-icon、theme-color。
// 4. 品牌 wordmark / 印章改用 WebP 小图。
// 5. 视频：写入真实封面；首屏视频保留自动播放，其余改为“进入视口才加载播放”。
// 6. 删除旧的封面注入脚本（路径不匹配，从未生效）。
// 7. 首页加结构化数据；404 页加 noindex；生成 sitemap.xml 与 robots.txt。

import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const ORIGIN = "https://www.mainihaitang.com";
const SITE_NAME = "麦尼海塘 MANI GARDEN";
const SHARE_IMAGE = `${ORIGIN}/og.jpg`;
const VIDEO_SCRIPT = '<script src="/assets/mani-video.js" defer></script>';

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${ORIGIN}/#website`,
      url: `${ORIGIN}/`,
      name: SITE_NAME,
      inLanguage: ["zh-CN", "en"],
      publisher: { "@id": `${ORIGIN}/#organization` },
    },
    {
      "@type": "Organization",
      "@id": `${ORIGIN}/#organization`,
      name: "麦尼海塘",
      alternateName: "MANI GARDEN",
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/media/brand/mani-garden-seal.png`,
      founder: { "@id": `${ORIGIN}/#huang-hai` },
      address: {
        "@type": "PostalAddress",
        addressCountry: "CN",
        addressRegion: "四川省",
        addressLocality: "甘孜藏族自治州理塘县拉波镇",
        streetAddress: "中扎村",
      },
    },
    {
      "@type": "Person",
      "@id": `${ORIGIN}/#huang-hai`,
      name: "黄海",
      alternateName: "Huang Hai",
      url: `${ORIGIN}/huang-hai/`,
      worksFor: { "@id": `${ORIGIN}/#organization` },
    },
  ],
};

async function collectHtml(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "admin", "scripts"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await collectHtml(target)));
    else if (entry.name.endsWith(".html")) out.push(target);
  }
  return out;
}

function routeOf(file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel === "404.html") return null;
  return "/" + rel.replace(/index\.html$/, "");
}

function escapeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function setMeta(html, attr, key, value) {
  const re = new RegExp(`<meta ${attr}="${key}" content="[^"]*"\\/?>`);
  const tag = `<meta ${attr}="${key}" content="${escapeAttr(value)}"/>`;
  if (re.test(html)) return html.replace(re, tag);
  return html.replace("</head>", `${tag}</head>`);
}

function posterFor(src) {
  // /media/series/video/foo.mp4 → /media/posters/series-video-foo.webp
  return "/media/posters/" + src.slice("/media/".length, -".mp4".length).replace(/\//g, "-") + ".webp";
}

function optimizeVideos(html, isHomeLike) {
  let heroDone = !isHomeLike;
  return html.replace(/<video([^>]*)>(\s*<source src="([^"]+)")/g, (whole, attrs, sourcePart, src) => {
    let next = attrs.replace(/\sposter="[^"]*"/i, "").replace(/\spreload="[^"]*"/i, "");
    const isHero = !heroDone && /(?<![-\w])autoplay=/i.test(next);
    if (isHero) {
      heroDone = true;
      next += ' preload="auto"';
    } else {
      if (/\bautoplay=""/i.test(next)) {
        next = next.replace(/\sautoplay=""/i, "");
        if (!/\bdata-autoplay\b/.test(next)) next += ' data-autoplay=""';
      }
      next += ' preload="none"';
    }
    next += ` poster="${posterFor(src)}"`;
    return `<video${next}>${sourcePart}`;
  });
}

function optimizeHead(html, route, isNotFound) {
  // 旧的封面注入脚本：键名缺少前导斜杠，从未匹配成功
  html = html.replace(/<!--POSTER_INJECT-->\s*<script>[\s\S]*?<\/script>/, "");

  // canonical / noindex
  html = html.replace(/<link rel="canonical" href="[^"]*"\/?>\n?/g, "");
  if (isNotFound) {
    if (!/name="robots"/.test(html)) html = html.replace("</head>", '<meta name="robots" content="noindex"/></head>');
  } else {
    html = html.replace("</head>", `<link rel="canonical" href="${ORIGIN}${route}"/></head>`);
  }

  // 页面标题与描述由后台“页面设置”管理，这里不再改写

  // 分享信息：分享图缺失或不是本站绝对地址时，补成默认分享图
  if (!isNotFound) html = setMeta(html, "property", "og:url", `${ORIGIN}${route}`);
  html = setMeta(html, "property", "og:site_name", SITE_NAME);
  for (const [attr, key] of [["property", "og:image"], ["name", "twitter:image"]]) {
    const current = html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`));
    if (!current || !current[1].startsWith(`${ORIGIN}/`)) html = setMeta(html, attr, key, SHARE_IMAGE);
  }

  // 图标与主题色
  if (!/apple-touch-icon/.test(html)) {
    const icons =
      '<link rel="icon" href="/favicon.ico" sizes="any"/>' +
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>' +
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>' +
      '<meta name="theme-color" content="#f7f1e3"/>';
    html = html.replace(/<link rel="icon" href="[^"]*"\/?>/, "");
    html = html.replace("</head>", `${icons}</head>`);
  }

  // 品牌小图改用 WebP
  html = html
    .replaceAll('"/media/brand/mani-garden-wordmark.png"', '"/media/brand/mani-garden-wordmark.webp"')
    .replace(/(src|href)="\/media\/brand\/mani-garden-seal\.png"/g, '$1="/media/brand/mani-garden-seal.webp"');

  return html;
}

const files = await collectHtml(root);
const routes = [];
for (const file of files) {
  const route = routeOf(file);
  const isNotFound = route === null;
  const isHomeLike = route === "/" || isNotFound;
  let html = await readFile(file, "utf8");
  const before = html;

  html = optimizeHead(html, route, isNotFound);
  html = optimizeVideos(html, isHomeLike);

  if (/<video/.test(html) && !/mani-video\.js/.test(html)) {
    html = html.replace("</head>", `${VIDEO_SCRIPT}</head>`);
  }
  if (route === "/" && !html.includes('id="mani-jsonld"')) {
    html = html.replace(
      "</head>",
      `<script type="application/ld+json" id="mani-jsonld">${JSON.stringify(JSON_LD)}</script></head>`,
    );
  }

  if (html !== before) await writeFile(file, html, "utf8");
  if (route) routes.push(route);
}

// 所有封面图必须存在
for (const file of files) {
  const html = await readFile(file, "utf8");
  for (const [, poster] of html.matchAll(/poster="([^"]+)"/g)) {
    await access(path.join(root, poster)).catch(() => {
      throw new Error(`缺少封面图 ${poster}（先运行 python3 scripts/optimize-media.py）`);
    });
  }
}

// sitemap.xml / robots.txt
const today = new Date().toISOString().slice(0, 10);
routes.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  routes
    .map((r) => `  <url><loc>${ORIGIN}${r}</loc><lastmod>${today}</lastmod><priority>${r === "/" ? "1.0" : "0.7"}</priority></url>`)
    .join("\n") +
  "\n</urlset>\n";
await writeFile(path.join(root, "sitemap.xml"), sitemap, "utf8");
await writeFile(path.join(root, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, "utf8");

console.log(`已优化 ${files.length} 个页面，sitemap 收录 ${routes.length} 个地址。`);
