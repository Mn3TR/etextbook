/**
 * 电子课本构建脚本 v2
 * 支持多教材：自动检测根目录下的教材文件夹，
 * 输出到 dist/<教材名>/ 目录，dist/index.html 为教材聚合首页
 *
 * 用法: node build.js
 * 添加新教材: 在根目录新建文件夹，按章节放好 .md 文件即可
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const katex = require('katex');

// ===================== 配置 =====================
const OUT_DIR = 'dist';
// 需要跳过的目录（不视为教材）
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.reasonix', '.git', 'asset',
  'assets', 'images', 'img',
]);

// 已知教材的章节映射（可扩展）
// key: 目录名前缀字母, value: { label, title }
// 若检测到的目录没有映射，会自动生成 label
const CHAPTER_MAP = {
  'A': { label: '第一章', title: '集合与基本逻辑用语' },
  'B': { label: '第二章', title: '一元二次函数、方程和不等式' },
  'C': { label: '第三章', title: '函数的概念与性质' },
  'D': { label: '第四章', title: '指数函数与对数函数' },
  'E': { label: '第五章', title: '三角函数' },
};

// 教材元数据（可选覆盖自动检测信息）
const TEXTBOOK_META = {
  '数学必修一(高一)': {
    subtitle: '高一 · 人教版',
    description: '人教版高中数学必修一，包含集合、函数、指数对数、三角函数等内容',
    color: '#2980b9',
    icon: '📐',
  },
};

// ===================== 工具函数 =====================

function renderInlineMath(math) {
  try {
    return katex.renderToString(math, {
      throwOnError: false, displayMode: false, output: 'html',
    });
  } catch (e) {
    return `<span class="katex-error" title="${e.message}">${math}</span>`;
  }
}

function renderBlockMath(math) {
  try {
    return katex.renderToString(math, {
      throwOnError: false, displayMode: true, output: 'html',
    });
  } catch (e) {
    return `<div class="katex-error">${math}</div>`;
  }
}

function preprocessMarkdown(text) {
  // 图片: ![[path]] → ![](path)
  text = text.replace(/!\[\[(.+?)\]\]/g, (match, imgPath) => {
    const normalized = imgPath.replace(/\\/g, '/');
    return `![${path.basename(normalized)}](${normalized})`;
  });
  // 块级公式 $$...$$ (先处理)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    return renderBlockMath(math.trim());
  });
  // 内联公式 $...$
  text = text.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match, math) => {
    const trimmed = math.trim();
    if (/^\d+$/.test(trimmed) || trimmed.length === 0) return match;
    return renderInlineMath(trimmed);
  });
  return text;
}

function extractSectionNumber(filename) {
  const m = filename.match(/^([\d.]+)/);
  return m ? m[1] : '';
}

function extractSectionTitle(filename) {
  return filename.replace(/^[\d.]+/, '').replace(/\.md$/, '');
}

function getChapterPrefix(dirName) {
  const m = dirName.match(/^([A-Z])/);
  return m ? m[1] : '';
}

/** 递归复制目录 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 判断一个目录是否可能是教材（包含子目录且有 .md 文件） */
function isTextbookDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());
    if (subdirs.length === 0) return false;
    // 至少有一个子目录包含 .md 文件
    return subdirs.some(d => {
      const files = fs.readdirSync(path.join(dirPath, d.name));
      return files.some(f => f.endsWith('.md'));
    });
  } catch { return false; }
}

/** 自动检测所有教材 */
function detectTextbooks(rootDir) {
  const textbooks = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));

  for (const entry of entries) {
    const dirPath = path.join(rootDir, entry.name);
    if (isTextbookDir(dirPath)) {
      textbooks.push(entry.name);
    }
  }
  return textbooks.sort();
}

// ===================== 教材扫描 =====================

/** 扫描一个教材的目录结构 */
function scanTextbook(textbookDir) {
  const chapters = [];
  const entries = fs.readdirSync(textbookDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const prefix = getChapterPrefix(entry.name);
    if (!prefix) continue;

    const info = CHAPTER_MAP[prefix] || {
      label: `第${prefix}部分`,
      title: entry.name.replace(/^[A-Z]，?/, ''),
    };
    const sections = [];

    const files = fs.readdirSync(path.join(textbookDir, entry.name))
      .filter(f => f.endsWith('.md'))
      .sort();

    for (const file of files) {
      const sectionNum = extractSectionNumber(file);
      const sectionTitle = extractSectionTitle(file);
      sections.push({
        file,
        sectionNum,
        sectionTitle,
        fullTitle: sectionNum ? `${sectionNum} ${sectionTitle}` : sectionTitle,
        outFile: file.replace('.md', '.html'),
      });
    }

    chapters.push({
      prefix, dirName: entry.name,
      label: info.label, title: info.title,
      sections,
    });
  }

  return chapters;
}

// ===================== HTML 构建 =====================

/** 侧边栏（单个教材内） */
function buildSidebar(textbookName, chapters, currentFile) {
  const meta = TEXTBOOK_META[textbookName] || {};
  const icon = meta.icon || '📖';

  let html = '<nav class="sidebar-nav">\n';
  html += `  <div class="sidebar-header">\n`;
  html += `    <h2>${icon} ${textbookName}</h2>\n`;
  if (meta.subtitle) {
    html += `    <p class="sidebar-subtitle">${meta.subtitle}</p>\n`;
  }
  html += `    <a href="../index.html" class="sidebar-home-link">🏠 返回教材首页</a>\n`;
  html += `  </div>\n`;
  html += '  <ul class="chapter-list">\n';

  for (const ch of chapters) {
    html += `    <li class="chapter-item">\n`;
    html += `      <div class="chapter-label">${ch.label}</div>\n`;
    html += `      <div class="chapter-title">${ch.title}</div>\n`;
    html += `      <ul class="section-list">\n`;
    for (const sec of ch.sections) {
      const active = sec.outFile === currentFile ? ' class="active"' : '';
      html += `        <li${active}><a href="${sec.outFile}">${sec.fullTitle}</a></li>\n`;
    }
    html += `      </ul>\n`;
    html += `    </li>\n`;
  }
  html += '  </ul>\n';
  html += '</nav>\n';
  return html;
}

/** 页面导航（上一节/下一节/教材目录/返回首页） */
function buildPageNav(chapters, currentFile, textbookName) {
  let prev = null, next = null;
  const allSections = [];
  for (const ch of chapters) {
    for (const sec of ch.sections) {
      allSections.push({ ...sec, chapter: ch });
    }
  }
  const idx = allSections.findIndex(s => s.outFile === currentFile);
  if (idx > 0) prev = allSections[idx - 1];
  if (idx >= 0 && idx < allSections.length - 1) next = allSections[idx + 1];

  let html = '<div class="page-nav">\n';
  html += `  <a href="../index.html" class="nav-home" title="教材聚合首页">🏠</a>\n`;
  html += `  <a href="index.html" class="nav-toc" title="本教材目录">📚 目录</a>\n`;
  if (prev) {
    html += `  <a href="${prev.outFile}" class="nav-prev" title="上一节">← ${prev.fullTitle}</a>\n`;
  } else {
    html += '  <span class="nav-prev disabled">← 已是第一节</span>\n';
  }
  if (next) {
    html += `  <a href="${next.outFile}" class="nav-next" title="下一节">${next.fullTitle} →</a>\n`;
  } else {
    html += '  <span class="nav-next disabled">已是最后一节 →</span>\n';
  }
  html += '</div>\n';
  return html;
}

/** 完整 HTML 页面 */
function buildPage(title, content, sidebar, pageNav, textbookName, tocMode = false) {
  const meta = TEXTBOOK_META[textbookName] || {};
  const fullTitle = textbookName
    ? `${title} — ${textbookName} 电子课本`
    : `${title} — 数学电子课本集`;

  // 同一目录下的 style.css
  const stylePath = textbookName ? 'style.css' : 'style.css';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${fullTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css">
  <link rel="stylesheet" href="${stylePath}">
</head>
<body>
  <div class="layout">
    ${sidebar || ''}
    <main class="main-content ${tocMode ? 'toc-page' : ''}">
      ${pageNav || ''}
      <article class="content-body">
        ${content}
      </article>
      ${pageNav || ''}
      <footer class="page-footer">
        <p>${textbookName || '数学电子课本'} &mdash; 基于 Markdown 笔记自动生成</p>
      </footer>
    </main>
  </div>
</body>
</html>`;
}

/** 单个教材的目录页 */
function buildTextbookIndex(chapters, textbookName) {
  const meta = TEXTBOOK_META[textbookName] || {};
  const icon = meta.icon || '📖';
  const totalSections = chapters.reduce((s, c) => s + c.sections.length, 0);

  let html = `<h1>${icon} ${textbookName}</h1>\n`;
  if (meta.description) {
    html += `<p class="toc-intro">${meta.description}</p>\n`;
  }
  html += `<p class="toc-stats">共 ${chapters.length} 章 · ${totalSections} 节</p>\n`;
  html += `<a href="../index.html" class="back-to-home">← 返回教材首页</a>\n`;

  html += '<div class="toc-grid">\n';
  for (const ch of chapters) {
    html += `  <div class="toc-chapter">\n`;
    html += `    <div class="toc-chapter-header"${meta.color ? ` style="background:${meta.color}"` : ''}>\n`;
    html += `      <span class="toc-chapter-label">${ch.label}</span>\n`;
    html += `      <h2>${ch.title}</h2>\n`;
    html += `    </div>\n`;
    html += `    <ul class="toc-section-list">\n`;
    for (const sec of ch.sections) {
      html += `      <li><a href="${sec.outFile}">${sec.fullTitle}</a></li>\n`;
    }
    html += `    </ul>\n`;
    html += `  </div>\n`;
  }
  html += '</div>\n';

  const sidebar = buildSidebar(textbookName, chapters, 'index.html');
  const pageNav = buildPageNav(chapters, 'index.html', textbookName);
  return buildPage(`目录 · ${textbookName}`, html, sidebar, pageNav, textbookName, true);
}

// ===================== 教材聚合首页 =====================

/** 构建教材聚合首页 (dist/index.html) */
function buildHomePage(textbooks) {
  let html = '<h1>📚 数学电子课本集</h1>\n';
  html += '<p class="toc-intro">选择一本教材开始学习</p>\n';
  html += `<p class="toc-stats">共 ${textbooks.length} 本教材</p>\n`;

  html += '<div class="textbook-grid">\n';
  for (const tb of textbooks) {
    const meta = TEXTBOOK_META[tb.dirName] || {};
    const icon = meta.icon || '📖';
    const color = meta.color || '#2980b9';
    const desc = meta.description || '';

    html += `  <a href="${tb.dirName}/index.html" class="textbook-card" style="--accent:${color}">\n`;
    html += `    <div class="textbook-card-header">\n`;
    html += `      <span class="textbook-icon">${icon}</span>\n`;
    html += `      <h2>${tb.dirName}</h2>\n`;
    if (meta.subtitle) {
      html += `      <p class="textbook-subtitle">${meta.subtitle}</p>\n`;
    }
    html += `    </div>\n`;
    html += `    <div class="textbook-card-body">\n`;
    if (desc) html += `      <p>${desc}</p>\n`;
    html += `      <p class="textbook-stats">${tb.chapterCount} 章 · ${tb.sectionCount} 节</p>\n`;
    html += `    </div>\n`;
    html += `  </a>\n`;
  }
  html += '</div>\n';

  const pageNav = '<div class="page-nav"><span class="nav-home">🏠 教材首页</span></div>';

  // 首页无侧边栏
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>数学电子课本集</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="layout layout-home">
    <main class="main-content toc-page">
      ${pageNav}
      <article class="content-body">
        ${html}
      </article>
      <footer class="page-footer">
        <p>数学电子课本集 &mdash; 基于 Markdown 笔记自动生成</p>
      </footer>
    </main>
  </div>
</body>
</html>`;
}

// ===================== 主流程 =====================

function main() {
  console.log('📚 开始构建电子课本集...\n');

  // 1. 检测教材
  const detectedDirs = detectTextebooks('.');
  if (detectedDirs.length === 0) {
    console.log('❌ 未检测到任何教材目录。');
    console.log('   请确保根目录下有包含章节子目录（如 A,集合/）的文件夹。');
    process.exit(1);
  }

  console.log(`📂 检测到 ${detectedDirs.length} 本教材:`);
  for (const d of detectedDirs) console.log(`   · ${d}`);
  console.log();

  // 2. 创建输出目录
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 3. 逐个处理教材
  const textbookInfos = [];

  for (const tbDir of detectedDirs) {
    const tbName = tbDir;
    const chapters = scanTextbook(tbDir);
    const totalSections = chapters.reduce((s, c) => s + c.sections.length, 0);
    console.log(`📖 处理教材: ${tbName} (${chapters.length} 章, ${totalSections} 节)`);

    const tbOutDir = path.join(OUT_DIR, tbDir);
    if (!fs.existsSync(tbOutDir)) fs.mkdirSync(tbOutDir, { recursive: true });

    // 3a. 复制资源文件
    const tbAssetDir = path.join(tbDir, 'asset');
    if (fs.existsSync(tbAssetDir)) {
      copyDirSync(tbAssetDir, path.join(tbOutDir, 'asset'));
    }

    // 3b. 生成章节页面
    for (const ch of chapters) {
      for (const sec of ch.sections) {
        const mdPath = path.join(tbDir, ch.dirName, sec.file);
        const content = fs.readFileSync(mdPath, 'utf-8');
        const processed = preprocessMarkdown(content);
        const bodyHtml = marked.parse(processed);

        const sidebar = buildSidebar(tbName, chapters, sec.outFile);
        const pageNav = buildPageNav(chapters, sec.outFile, tbName);
        const fullTitle = `${ch.label} · ${sec.fullTitle}`;
        const html = buildPage(fullTitle, bodyHtml, sidebar, pageNav, tbName);

        fs.writeFileSync(path.join(tbOutDir, sec.outFile), html, 'utf-8');
      }
    }
    console.log(`   → 已生成 ${totalSections} 个章节页面`);

    // 3c. 生成该教材的目录页
    const indexHtml = buildTextbookIndex(chapters, tbName);
    fs.writeFileSync(path.join(tbOutDir, 'index.html'), indexHtml, 'utf-8');
    console.log(`   → 已生成教材目录页`);

    // 3d. 复制样式到教材目录
    if (fs.existsSync('style.css')) {
      fs.copyFileSync('style.css', path.join(tbOutDir, 'style.css'));
    }

    textbookInfos.push({
      dirName: tbDir,
      chapterCount: chapters.length,
      sectionCount: totalSections,
    });
  }

  // 4. 生成教材聚合首页
  console.log('\n📑 生成教材聚合首页...');
  const homeHtml = buildHomePage(textbookInfos);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), homeHtml, 'utf-8');

  // 5. 复制样式到 dist 根目录
  if (fs.existsSync('style.css')) {
    fs.copyFileSync('style.css', path.join(OUT_DIR, 'style.css'));
  }

  console.log(`\n✅ 构建完成！`);
  console.log(`   输出目录: ${path.resolve(OUT_DIR)}`);
  console.log(`   打开 ${path.join(OUT_DIR, 'index.html')} 查看教材聚合首页`);
  for (const tb of textbookInfos) {
    console.log(`   · ${tb.dirName}: ${OUT_DIR}/${tb.dirName}/index.html`);
  }
  console.log();
}

// 修正：拼写错误（兼容旧版本）
function detectTextebooks(rootDir) {
  return detectTextbooks(rootDir);
}

function detectTextbooks(rootDir) {
  const textbooks = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));

  for (const entry of entries) {
    const dirPath = path.join(rootDir, entry.name);
    if (isTextbookDir(dirPath)) {
      textbooks.push(entry.name);
    }
  }
  return textbooks.sort();
}

main();
