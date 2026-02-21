#!/usr/bin/env node
/**
 * 知识库智能搜索系统 v2.0
 * Knowledge Base Intelligent Search System
 * 
 * 功能：全文检索、语义标签、多维度过滤、相关性排序
 */

const fs = require('fs');
const path = require('path');

class KnowledgeBaseSearch {
  constructor(options = {}) {
    this.kbPath = options.kbPath || './knowledge-base';
    this.memoryPath = options.memoryPath || './memory';
    this.index = new Map();
    this.tags = new Map();
    this.stats = {
      totalDocs: 0,
      totalLines: 0,
      totalWords: 0,
      categories: new Map()
    };
  }

  // ==================== 核心索引构建 ====================
  
  async buildIndex() {
    console.log('🔨 正在构建知识库索引...\n');
    
    const startTime = Date.now();
    
    // 扫描知识库目录
    await this.scanDirectory(this.kbPath, 'knowledge');
    
    // 扫描记忆目录
    if (fs.existsSync(this.memoryPath)) {
      await this.scanDirectory(this.memoryPath, 'memory');
    }
    
    // 扫描根目录关键文件
    await this.scanRootFiles();
    
    const buildTime = Date.now() - startTime;
    
    console.log(`✅ 索引构建完成！耗时 ${buildTime}ms\n`);
    this.printStats();
    
    return this;
  }

  async scanDirectory(dirPath, type, depth = 0) {
    if (!fs.existsSync(dirPath)) return;
    if (depth > 5) return; // 限制递归深度
    
    // 忽略的目录
    const ignoreDirs = ['.git', 'node_modules', '.kb-analytics', '.kb-sync', '.backups', 'test-reports', 'monitor-agent-data'];
    
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        if (ignoreDirs.includes(entry.name)) continue;
        // 递归扫描子目录
        await this.scanDirectory(fullPath, type, depth + 1);
      } else if (entry.isFile() && this.isTextFile(entry.name)) {
        await this.indexFile(fullPath, type);
      }
    }
  }

  async scanRootFiles() {
    const rootFiles = ['MEMORY.md', 'SOUL.md', 'USER.md', 'TASKS.md', 'TOOLS.md'];
    
    for (const file of rootFiles) {
      const filePath = path.join('.', file);
      if (fs.existsSync(filePath)) {
        await this.indexFile(filePath, 'root');
      }
    }
  }

  isTextFile(filename) {
    const textExts = ['.md', '.txt', '.js', '.json', '.yaml', '.yml', '.sh', '.conf'];
    return textExts.some(ext => filename.toLowerCase().endsWith(ext));
  }

  async indexFile(filePath, type) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const stats = fs.statSync(filePath);
      
      // 提取元数据
      const metadata = this.extractMetadata(filePath, content, type);
      
      // 构建倒排索引
      const words = this.tokenize(content);
      const wordFreq = new Map();
      
      words.forEach(word => {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        
        if (!this.index.has(word)) {
          this.index.set(word, new Map());
        }
        this.index.get(word).set(filePath, {
          freq: wordFreq.get(word),
          positions: this.findPositions(content, word)
        });
      });

      // 提取标签
      const fileTags = this.extractTags(content, filePath);
      fileTags.forEach(tag => {
        if (!this.tags.has(tag)) {
          this.tags.set(tag, new Set());
        }
        this.tags.get(tag).add(filePath);
      });

      // 更新统计
      this.stats.totalDocs++;
      this.stats.totalLines += lines.length;
      this.stats.totalWords += words.length;
      
      const category = metadata.category || 'other';
      this.stats.categories.set(category, (this.stats.categories.get(category) || 0) + 1);
      
    } catch (err) {
      // 静默跳过无法读取的文件
    }
  }

  extractMetadata(filePath, content, type) {
    const filename = path.basename(filePath);
    const metadata = {
      type,
      filename,
      path: filePath,
      category: this.detectCategory(filename, content),
      title: this.extractTitle(content, filename),
      created: this.extractDate(content),
      importance: this.calculateImportance(content)
    };
    
    return metadata;
  }

  detectCategory(filename, content) {
    const categories = {
      docker: ['docker', 'container', 'compose'],
      slack: ['slack', 'message', 'channel'],
      vllm: ['vllm', 'llm', 'model', 'inference'],
      websocket: ['websocket', 'ws', 'socket', 'realtime'],
      git: ['git', 'github', 'version control'],
      ssh: ['ssh', 'secure shell', 'remote'],
      ai: ['ai', 'agent', 'openclaw', 'claude'],
      memory: ['memory', 'recall', 'remember']
    };

    const text = (filename + ' ' + content.slice(0, 2000)).toLowerCase();
    
    for (const [cat, keywords] of Object.entries(categories)) {
      if (keywords.some(kw => text.includes(kw))) {
        return cat;
      }
    }
    
    return 'general';
  }

  extractTitle(content, filename) {
    // 尝试提取 Markdown 标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) return titleMatch[1].trim();
    
    // 尝试提取 frontmatter 标题
    const fmMatch = content.match(/^title:\s*(.+)$/m);
    if (fmMatch) return fmMatch[1].trim();
    
    // 使用文件名
    return filename.replace(/\.[^.]+$/, '');
  }

  extractDate(content) {
    const dateMatch = content.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch ? dateMatch[1] : null;
  }

  calculateImportance(content) {
    let score = 0;
    
    // 长度因素（适中长度更重要）
    const length = content.length;
    if (length > 500 && length < 10000) score += 2;
    else if (length > 10000) score += 3;
    
    // 关键词重要性
    const importantKeywords = ['critical', 'important', 'key', '核心', '重要', '必须'];
    importantKeywords.forEach(kw => {
      if (content.toLowerCase().includes(kw)) score += 1;
    });
    
    // 代码块数量
    const codeBlocks = (content.match(/```/g) || []).length / 2;
    score += Math.min(codeBlocks, 3);
    
    return Math.min(score, 10);
  }

  tokenize(text) {
    // 简单的分词：提取单词和中文词汇
    const words = [];
    
    // 英文单词
    const englishWords = text.toLowerCase().match(/[a-z][a-z0-9_]*/g) || [];
    words.push(...englishWords.filter(w => w.length > 2));
    
    // 中文词汇（简单实现：连续中文字符）
    const chineseSegments = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
    words.push(...chineseSegments);
    
    return words;
  }

  findPositions(content, word) {
    const positions = [];
    let pos = content.toLowerCase().indexOf(word.toLowerCase());
    while (pos !== -1 && positions.length < 5) {
      positions.push(pos);
      pos = content.toLowerCase().indexOf(word.toLowerCase(), pos + 1);
    }
    return positions;
  }

  extractTags(content, filePath) {
    const tags = new Set();
    const text = content.toLowerCase();
    
    // 从内容中提取标签
    const tagPatterns = [
      { pattern: /`([^`]+)`/g, type: 'code' },
      { pattern: /\*\*([^*]+)\*\*/g, type: 'emphasis' },
      { pattern: /#\s*([\u4e00-\u9fa5a-zA-Z]+)/g, type: 'header' }
    ];
    
    tagPatterns.forEach(({ pattern }) => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const tag = match[1].trim().toLowerCase();
        if (tag.length > 2 && tag.length < 30) {
          tags.add(tag);
        }
      }
    });
    
    // 技术关键词标签
    const techKeywords = [
      'docker', 'slack', 'vllm', 'websocket', 'git', 'ssh', 'api',
      'javascript', 'python', 'node', 'linux', 'nginx', 'redis',
      'database', 'server', 'client', 'async', 'sync'
    ];
    
    techKeywords.forEach(kw => {
      if (text.includes(kw)) tags.add(kw);
    });
    
    return Array.from(tags);
  }

  // ==================== 搜索功能 ====================

  search(query, options = {}) {
    const {
      limit = 10,
      category = null,
      type = null,
      tags = [],
      fuzzy = false
    } = options;

    console.log(`\n🔍 搜索: "${query}"`);
    console.log('='.repeat(50));

    const startTime = Date.now();
    const queryWords = this.tokenize(query);
    
    if (queryWords.length === 0) {
      console.log('⚠️ 查询词太短，无法搜索');
      return [];
    }

    // 计算文档相关性分数
    const scores = new Map();
    
    queryWords.forEach(word => {
      const postings = this.index.get(word);
      if (postings) {
        postings.forEach((data, filePath) => {
          const currentScore = scores.get(filePath) || 0;
          // TF 加权
          const tf = Math.log(1 + data.freq);
          // IDF 加权（简化版）
          const idf = Math.log(this.stats.totalDocs / (postings.size + 1));
          scores.set(filePath, currentScore + tf * idf);
        });
      }
    });

    // 转换为结果数组
    let results = Array.from(scores.entries())
      .map(([filePath, score]) => ({
        path: filePath,
        score,
        metadata: this.getFileMetadata(filePath)
      }));

    // 应用过滤
    if (category) {
      results = results.filter(r => r.metadata?.category === category);
    }
    if (type) {
      results = results.filter(r => r.metadata?.type === type);
    }
    if (tags.length > 0) {
      results = results.filter(r => 
        tags.some(tag => this.tags.get(tag)?.has(r.path))
      );
    }

    // 排序和限制
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, limit);

    const searchTime = Date.now() - startTime;
    
    // 显示结果
    this.displayResults(results, searchTime);
    
    return results;
  }

  getFileMetadata(filePath) {
    // 简化实现：返回基本元数据
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        category: this.detectCategory(path.basename(filePath), content),
        title: this.extractTitle(content, path.basename(filePath))
      };
    } catch {
      return null;
    }
  }

  displayResults(results, searchTime) {
    if (results.length === 0) {
      console.log('❌ 未找到匹配结果\n');
      return;
    }

    console.log(`📊 找到 ${results.length} 个结果 (耗时 ${searchTime}ms)\n`);

    results.forEach((result, idx) => {
      const rank = idx + 1;
      const title = result.metadata?.title || path.basename(result.path);
      const category = result.metadata?.category || 'general';
      const score = result.score.toFixed(2);
      
      console.log(`${rank}. 📄 ${title}`);
      console.log(`   📂 ${result.path}`);
      console.log(`   🏷️  ${category} | ⭐ 相关度: ${score}`);
      
      // 显示摘要
      const snippet = this.getSnippet(result.path);
      if (snippet) {
        console.log(`   💬 ${snippet.substring(0, 100)}...`);
      }
      console.log();
    });
  }

  getSnippet(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // 返回前200个字符作为摘要
      return content.replace(/\s+/g, ' ').substring(0, 200).trim();
    } catch {
      return null;
    }
  }

  // ==================== 高级功能 ====================

  findRelated(filePath, limit = 5) {
    console.log(`\n🔗 查找与 "${path.basename(filePath)}" 相关的内容`);
    console.log('='.repeat(50));

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const words = this.tokenize(content);
      
      // 提取高频词
      const wordFreq = new Map();
      words.forEach(w => {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      });
      
      // 取前10个高频词作为相关查询
      const topWords = Array.from(wordFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([w]) => w);
      
      const relatedQuery = topWords.join(' ');
      return this.search(relatedQuery, { limit: limit + 1 })
        .filter(r => r.path !== filePath)
        .slice(0, limit);
    } catch {
      console.log('❌ 无法读取文件');
      return [];
    }
  }

  listByCategory() {
    console.log('\n📚 知识库分类统计');
    console.log('='.repeat(50));
    
    const sorted = Array.from(this.stats.categories.entries())
      .sort((a, b) => b[1] - a[1]);
    
    sorted.forEach(([cat, count]) => {
      const bar = '█'.repeat(Math.min(count, 20));
      console.log(`${cat.padEnd(12)} | ${bar} ${count}`);
    });
    
    console.log();
  }

  getPopularTags(limit = 20) {
    console.log('\n🏷️ 热门标签');
    console.log('='.repeat(50));
    
    const sorted = Array.from(this.tags.entries())
      .map(([tag, files]) => ({ tag, count: files.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    
    sorted.forEach(({ tag, count }) => {
      console.log(`#${tag} (${count})`);
    });
    
    console.log();
  }

  // ==================== 统计和报告 ====================

  printStats() {
    console.log('📊 知识库统计');
    console.log('='.repeat(50));
    console.log(`📄 文档总数: ${this.stats.totalDocs}`);
    console.log(`📝 总行数: ${this.stats.totalLines.toLocaleString()}`);
    console.log(`🔤 总词数: ${this.stats.totalWords.toLocaleString()}`);
    console.log(`🏷️ 唯一标签: ${this.tags.size}`);
    console.log(`🔍 索引词数: ${this.index.size}`);
    console.log();
    
    this.listByCategory();
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      stats: {
        totalDocs: this.stats.totalDocs,
        totalLines: this.stats.totalLines,
        totalWords: this.stats.totalWords,
        uniqueTags: this.tags.size,
        indexedWords: this.index.size
      },
      categories: Object.fromEntries(this.stats.categories),
      topTags: Array.from(this.tags.entries())
        .map(([tag, files]) => ({ tag, count: files.size }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
    };
    
    return report;
  }
}

// ==================== CLI 接口 ====================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'interactive';

  const kb = new KnowledgeBaseSearch();
  await kb.buildIndex();

  switch (command) {
    case 'search':
      const query = args.slice(1).join(' ') || 'docker';
      kb.search(query, { limit: 10 });
      break;
      
    case 'category':
      kb.listByCategory();
      break;
      
    case 'tags':
      kb.getPopularTags(20);
      break;
      
    case 'related':
      const file = args[1] || './knowledge-base/docker/docker-multi-project-proxy.md';
      kb.findRelated(file, 5);
      break;
      
    case 'report':
      console.log(JSON.stringify(kb.generateReport(), null, 2));
      break;
      
    case 'interactive':
    default:
      // 默认搜索示例
      console.log('\n🎯 示例搜索:\n');
      
      kb.search('docker compose', { limit: 5 });
      kb.search('slack bot', { limit: 5 });
      kb.search('SSH 配置', { limit: 5 });
      
      console.log('\n💡 使用方式:');
      console.log('  node kb-search-v2.js search <关键词>');
      console.log('  node kb-search-v2.js category');
      console.log('  node kb-search-v2.js tags');
      console.log('  node kb-search-v2.js related <文件路径>');
      console.log('  node kb-search-v2.js report');
      break;
  }
}

// 导出模块
module.exports = { KnowledgeBaseSearch };

// 直接运行
if (require.main === module) {
  main().catch(console.error);
}
