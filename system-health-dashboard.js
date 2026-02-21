#!/usr/bin/env node
/**
 * 系统健康综合仪表板 v3.0
 * System Health Dashboard - 统一监控视图
 * 
 * 功能：
 * 1. 整合多源监控数据（系统、知识库、任务、Slack）
 * 2. 实时健康评分计算
 * 3. 趋势分析与告警
 * 4. ASCII可视化图表
 * 5. 集成工作汇报生成
 * 
 * @version 3.0.0
 * @author Clawy-OC
 * @date 2026-02-19
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

class SystemHealthDashboard {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || '/root/.openclaw/workspace';
    this.memoryDir = path.join(this.workspaceDir, 'memory');
    this.knowledgeBaseDir = path.join(this.workspaceDir, 'knowledge-base');
    
    // 健康阈值配置
    this.thresholds = {
      diskUsage: { warning: 70, critical: 85 },
      memoryUsage: { warning: 75, critical: 90 },
      taskCompletion: { warning: 30, good: 60, excellent: 80 },
      knowledgeGrowth: { min: 100 }, // 每天最少增长行数
      heartbeatInterval: { max: 1800 } // 最大允许30分钟无心跳
    };
    
    // 缓存
    this.cache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5分钟
  }

  // ==================== 数据收集 ====================

  /**
   * 收集系统指标
   */
  async collectSystemMetrics() {
    try {
      const metrics = {
        timestamp: new Date().toISOString(),
        system: await this.getSystemInfo(),
        disk: await this.getDiskUsage(),
        memory: await this.getMemoryUsage(),
        load: await this.getLoadAverage(),
        processes: await this.getProcessInfo()
      };
      
      return metrics;
    } catch (error) {
      console.error('收集系统指标失败:', error.message);
      return { error: error.message, timestamp: new Date().toISOString() };
    }
  }

  /**
   * 获取系统信息
   */
  async getSystemInfo() {
    try {
      const uptime = execSync('uptime -p', { encoding: 'utf8' }).trim();
      const hostname = execSync('hostname', { encoding: 'utf8' }).trim();
      const kernel = execSync('uname -r', { encoding: 'utf8' }).trim();
      
      return { uptime, hostname, kernel };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 获取磁盘使用情况
   */
  async getDiskUsage() {
    try {
      const output = execSync('df -h /', { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      const dataLine = lines[1];
      const parts = dataLine.split(/\s+/);
      
      return {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usagePercent: parseInt(parts[4].replace('%', '')),
        mount: parts[5]
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 获取内存使用情况
   */
  async getMemoryUsage() {
    try {
      const output = execSync('free -m', { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      const memLine = lines[1];
      const parts = memLine.split(/\s+/);
      
      const total = parseInt(parts[1]);
      const used = parseInt(parts[2]);
      const free = parseInt(parts[3]);
      const usagePercent = Math.round((used / total) * 100);
      
      return { total, used, free, usagePercent, unit: 'MB' };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 获取负载平均值
   */
  async getLoadAverage() {
    try {
      const output = execSync('uptime', { encoding: 'utf8' });
      const match = output.match(/load average[s]?:\s*([\d.]+),?\s*([\d.]+)?,?\s*([\d.]+)?/i);
      
      if (match) {
        return {
          '1min': parseFloat(match[1]) || 0,
          '5min': parseFloat(match[2]) || 0,
          '15min': parseFloat(match[3]) || 0
        };
      }
      
      return { error: '无法解析负载信息' };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 获取进程信息
   */
  async getProcessInfo() {
    try {
      const output = execSync('ps aux | wc -l', { encoding: 'utf8' });
      const processCount = parseInt(output.trim()) - 1;
      
      const nodeProcesses = execSync('pgrep -c node || echo 0', { encoding: 'utf8' });
      const nodeCount = parseInt(nodeProcesses.trim());
      
      return { total: processCount, node: nodeCount };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ==================== 知识库指标 ====================

  /**
   * 收集知识库指标
   */
  async collectKnowledgeBaseMetrics() {
    try {
      const metrics = {
        timestamp: new Date().toISOString(),
        files: await this.countKnowledgeBaseFiles(),
        code: await this.countCodeLines(),
        categories: await this.analyzeCategories(),
        growth: await this.calculateGrowth(),
        searchIndex: await this.checkSearchIndex()
      };
      
      return metrics;
    } catch (error) {
      console.error('收集知识库指标失败:', error.message);
      return { error: error.message, timestamp: new Date().toISOString() };
    }
  }

  /**
   * 统计知识库文件
   */
  async countKnowledgeBaseFiles() {
    try {
      const kbExists = await this.fileExists(this.knowledgeBaseDir);
      if (!kbExists) return { count: 0, categories: 0 };
      
      const entries = await fs.readdir(this.knowledgeBaseDir, { withFileTypes: true });
      let fileCount = 0;
      let dirCount = 0;
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          fileCount++;
        } else if (entry.isDirectory()) {
          dirCount++;
          const subFiles = await fs.readdir(path.join(this.knowledgeBaseDir, entry.name));
          fileCount += subFiles.filter(f => f.endsWith('.md')).length;
        }
      }
      
      return { count: fileCount, categories: dirCount };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 统计代码行数
   */
  async countCodeLines() {
    try {
      const result = {
        javascript: { files: 0, lines: 0 },
        markdown: { files: 0, lines: 0 },
        total: { files: 0, lines: 0 }
      };
      
      // 统计JS文件
      const jsOutput = execSync(
        `find ${this.workspaceDir} -name "*.js" -type f -exec wc -l {} + 2>/dev/null | tail -1`,
        { encoding: 'utf8' }
      );
      const jsMatch = jsOutput.match(/(\d+)\s+total/);
      if (jsMatch) {
        result.javascript.lines = parseInt(jsMatch[1]);
        result.javascript.files = parseInt(
          execSync(`find ${this.workspaceDir} -name "*.js" -type f | wc -l`, { encoding: 'utf8' }).trim()
        );
      }
      
      // 统计Markdown文件
      const mdOutput = execSync(
        `find ${this.workspaceDir} -name "*.md" -type f -exec wc -l {} + 2>/dev/null | tail -1`,
        { encoding: 'utf8' }
      );
      const mdMatch = mdOutput.match(/(\d+)\s+total/);
      if (mdMatch) {
        result.markdown.lines = parseInt(mdMatch[1]);
        result.markdown.files = parseInt(
          execSync(`find ${this.workspaceDir} -name "*.md" -type f | wc -l`, { encoding: 'utf8' }).trim()
        );
      }
      
      result.total.files = result.javascript.files + result.markdown.files;
      result.total.lines = result.javascript.lines + result.markdown.lines;
      
      return result;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 分析分类分布
   */
  async analyzeCategories() {
    const categories = {
      '🐳docker': ['docker', 'container'],
      '💬slack': ['slack', 'socket'],
      '🤖vllm': ['vllm', 'llm', 'ai', 'model'],
      '🔌websocket': ['websocket', 'ws', 'socket'],
      '🔧git': ['git', 'github'],
      '🔐ssh': ['ssh', 'secure'],
      '🤖ai': ['ai', 'agent', 'bot'],
      '🧠memory': ['memory', 'knowledge', 'kb'],
      '📊monitor': ['monitor', 'dashboard', 'metric'],
      '🧪test': ['test', 'spec']
    };
    
    const result = {};
    
    try {
      for (const [category, keywords] of Object.entries(categories)) {
        const keywordPattern = keywords.join('|');
        // 使用更简单的方法，避免复杂的shell转义
        const cmd = `grep -rliE "${keywordPattern}" ${this.workspaceDir} --include="*.js" --include="*.md" 2>/dev/null | wc -l`;
        const count = parseInt(
          execSync(cmd, { encoding: 'utf8' }).trim()
        );
        result[category] = count;
      }
      
      return result;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 计算增长趋势
   */
  async calculateGrowth() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const todayFile = path.join(this.memoryDir, `${today}.md`);
      
      // 获取今日memory文件中的代码行数统计
      let todayLines = 0;
      if (await this.fileExists(todayFile)) {
        const content = await fs.readFile(todayFile, 'utf8');
        const match = content.match(/累计代码[:\s]+(\d[\d,]*)/);
        if (match) {
          todayLines = parseInt(match[1].replace(/,/g, ''));
        }
      }
      
      // 获取历史数据（简化版，实际可从历史记录计算）
      return {
        todayLines,
        dailyAverage: Math.round(todayLines / Math.max(1, new Date().getDate())),
        trend: 'stable'
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 检查搜索索引状态
   */
  async checkSearchIndex() {
    try {
      const indexPath = path.join(this.workspaceDir, '.kb-index.json');
      const exists = await this.fileExists(indexPath);
      
      if (!exists) return { exists: false, lastUpdate: null };
      
      const stats = await fs.stat(indexPath);
      return {
        exists: true,
        lastUpdate: stats.mtime.toISOString(),
        size: this.formatBytes(stats.size)
      };
    } catch (error) {
      return { exists: false, error: error.message };
    }
  }

  // ==================== 任务指标 ====================

  /**
   * 收集任务指标
   */
  async collectTaskMetrics() {
    try {
      const tasksPath = path.join(this.workspaceDir, 'TASKS.md');
      
      if (!await this.fileExists(tasksPath)) {
        return { error: 'TASKS.md not found' };
      }
      
      const content = await fs.readFile(tasksPath, 'utf8');
      
      // 统计任务状态
      const completedMatch = content.match(/状态.*：\s*✅\s*已完成/g) || [];
      const inProgressMatch = content.match(/状态.*：\s*🔄\s*进行中/g) || [];
      const pendingMatch = content.match(/状态.*：\s*[⏳📋]\s*(待开始|待处理)/g) || [];
      
      // 统计优先级
      const p0Match = content.match(/优先级.*：\s*P0/g) || [];
      const p1Match = content.match(/优先级.*：\s*P1/g) || [];
      const p2Match = content.match(/优先级.*：\s*P2/g) || [];
      
      const total = completedMatch.length + inProgressMatch.length + pendingMatch.length;
      
      return {
        total,
        completed: completedMatch.length,
        inProgress: inProgressMatch.length,
        pending: pendingMatch.length,
        completionRate: total > 0 ? Math.round((completedMatch.length / total) * 100) : 0,
        priority: {
          P0: p0Match.length,
          P1: p1Match.length,
          P2: p2Match.length
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ==================== 健康评分 ====================

  /**
   * 计算综合健康评分
   */
  calculateHealthScore(metrics) {
    const scores = {
      system: this.calculateSystemScore(metrics.system),
      knowledge: this.calculateKnowledgeScore(metrics.knowledge),
      tasks: this.calculateTaskScore(metrics.tasks)
    };
    
    const weights = { system: 0.3, knowledge: 0.4, tasks: 0.3 };
    const totalScore = Math.round(
      scores.system * weights.system +
      scores.knowledge * weights.knowledge +
      scores.tasks * weights.tasks
    );
    
    return {
      total: totalScore,
      breakdown: scores,
      status: this.getHealthStatus(totalScore),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 计算系统健康评分
   */
  calculateSystemScore(systemMetrics) {
    if (!systemMetrics || systemMetrics.error) return 50;
    
    let score = 100;
    
    // 磁盘使用扣分
    const diskUsage = systemMetrics.disk?.usagePercent || 0;
    if (diskUsage > this.thresholds.diskUsage.critical) score -= 30;
    else if (diskUsage > this.thresholds.diskUsage.warning) score -= 15;
    
    // 内存使用扣分
    const memUsage = systemMetrics.memory?.usagePercent || 0;
    if (memUsage > this.thresholds.memoryUsage.critical) score -= 30;
    else if (memUsage > this.thresholds.memoryUsage.warning) score -= 15;
    
    // 负载扣分
    const load = systemMetrics.load?.['1min'] || 0;
    const cpuCount = parseInt(execSync('nproc', { encoding: 'utf8' }).trim());
    const loadRatio = load / cpuCount;
    if (loadRatio > 2) score -= 20;
    else if (loadRatio > 1) score -= 10;
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 计算知识库健康评分
   */
  calculateKnowledgeScore(kbMetrics) {
    if (!kbMetrics || kbMetrics.error) return 50;
    
    let score = 100;
    
    // 基于代码行数评分
    const totalLines = kbMetrics.code?.total?.lines || 0;
    if (totalLines < 10000) score -= 10;
    if (totalLines < 5000) score -= 10;
    
    // 检查搜索索引
    if (!kbMetrics.searchIndex?.exists) score -= 15;
    
    // 检查文件分布
    const fileCount = kbMetrics.files?.count || 0;
    if (fileCount < 10) score -= 10;
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 计算任务健康评分
   */
  calculateTaskScore(taskMetrics) {
    if (!taskMetrics || taskMetrics.error) return 50;
    
    let score = 100;
    
    // 基于完成率评分
    const completionRate = taskMetrics.completionRate || 0;
    if (completionRate < this.thresholds.taskCompletion.warning) score -= 30;
    else if (completionRate < this.thresholds.taskCompletion.good) score -= 15;
    else if (completionRate >= this.thresholds.taskCompletion.excellent) score += 10;
    
    // P0任务未完成扣分
    const p0Pending = (taskMetrics.priority?.P0 || 0) - 
                      (taskMetrics.completed || 0); // 简化计算
    if (p0Pending > 0) score -= p0Pending * 5;
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 获取健康状态描述
   */
  getHealthStatus(score) {
    if (score >= 90) return { level: 'excellent', emoji: '🟢', text: '优秀' };
    if (score >= 75) return { level: 'good', emoji: '🟡', text: '良好' };
    if (score >= 60) return { level: 'fair', emoji: '🟠', text: '一般' };
    return { level: 'poor', emoji: '🔴', text: '需关注' };
  }

  // ==================== 可视化 ====================

  /**
   * 生成ASCII进度条
   */
  generateProgressBar(percent, width = 30) {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}] ${percent}%`;
  }

  /**
   * 生成仪表盘ASCII图表
   */
  generateGauge(value, max = 100, size = 20) {
    const filled = Math.round((value / max) * size);
    const bar = '▓'.repeat(filled) + '░'.repeat(size - filled);
    return `${bar} ${value}/${max}`;
  }

  /**
   * 格式化仪表板显示
   */
  formatDashboard(health, metrics) {
    const lines = [];
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    
    lines.push('╔════════════════════════════════════════════════════════════════╗');
    lines.push('║           🦞 Clawy-OC 系统健康仪表板 v3.0                      ║');
    lines.push('╠════════════════════════════════════════════════════════════════╣');
    lines.push(`║  更新时间: ${now.padEnd(47)}║`);
    lines.push('╠════════════════════════════════════════════════════════════════╣');
    
    // 综合健康评分
    const status = health.status;
    lines.push('║  📊 综合健康评分                                               ║');
    lines.push(`║     ${status.emoji} ${status.text} ${this.generateGauge(health.total)}              ║`);
    lines.push('║                                                                ║');
    
    // 分项评分
    lines.push('║  📈 分项评分                                                   ║');
    lines.push(`║     系统健康  ${this.generateProgressBar(health.breakdown.system)}        ║`);
    lines.push(`║     知识库    ${this.generateProgressBar(health.breakdown.knowledge)}        ║`);
    lines.push(`║     任务状态  ${this.generateProgressBar(health.breakdown.tasks)}        ║`);
    lines.push('║                                                                ║');
    
    // 系统指标
    if (metrics.system && !metrics.system.error) {
      lines.push('║  🖥️  系统指标                                                  ║');
      const disk = metrics.system.disk;
      const mem = metrics.system.memory;
      const load = metrics.system.load;
      
      if (disk && disk.usagePercent !== undefined) {
        const used = disk.used || 'N/A';
        const total = disk.total || 'N/A';
        lines.push(`║     磁盘使用: ${disk.usagePercent}% (${used}/${total})${' '.repeat(28)}║`);
      }
      if (mem && mem.usagePercent !== undefined) {
        const used = mem.used || 0;
        const total = mem.total || 0;
        lines.push(`║     内存使用: ${mem.usagePercent}% (${used}/${total} MB)${' '.repeat(27)}║`);
      }
      if (load) {
        const load1 = (load['1min'] || 0).toFixed(2);
        const load5 = (load['5min'] || 0).toFixed(2);
        const load15 = (load['15min'] || 0).toFixed(2);
        lines.push(`║     系统负载: ${load1} / ${load5} / ${load15}${' '.repeat(32)}║`);
      }
      lines.push('║                                                                ║');
    }
    
    // 知识库指标
    if (metrics.knowledge && !metrics.knowledge.error) {
      lines.push('║  📚 知识库指标                                                 ║');
      const code = metrics.knowledge.code;
      if (code) {
        const jsFiles = code.javascript?.files || 0;
        const jsLines = code.javascript?.lines || 0;
        const mdFiles = code.markdown?.files || 0;
        const mdLines = code.markdown?.lines || 0;
        const totalLines = code.total?.lines || 0;
        lines.push(`║     JS文件: ${jsFiles}个 (${this.formatNumber(jsLines)}行)${' '.repeat(33)}║`);
        lines.push(`║     MD文件: ${mdFiles}个 (${this.formatNumber(mdLines)}行)${' '.repeat(33)}║`);
        lines.push(`║     总计: ${this.formatNumber(totalLines)}行代码${' '.repeat(40)}║`);
      }
      lines.push('║                                                                ║');
    }
    
    // 任务指标
    if (metrics.tasks && !metrics.tasks.error) {
      lines.push('║  ✅ 任务指标                                                   ║');
      const t = metrics.tasks;
      const completionRate = t.completionRate || 0;
      const completed = t.completed || 0;
      const total = t.total || 0;
      const p0 = t.priority?.P0 || 0;
      const p1 = t.priority?.P1 || 0;
      const p2 = t.priority?.P2 || 0;
      lines.push(`║     完成率: ${completionRate}% (完成${completed}/总计${total})${' '.repeat(26)}║`);
      lines.push(`║     优先级分布: P0(${p0}) P1(${p1}) P2(${p2})${' '.repeat(29)}║`);
      lines.push('║                                                                ║');
    }
    
    // 告警信息
    const alerts = this.generateAlerts(health, metrics);
    if (alerts.length > 0) {
      lines.push('║  ⚠️  告警信息                                                  ║');
      alerts.slice(0, 3).forEach(alert => {
        const msg = alert.substring(0, 56).padEnd(56);
        lines.push(`║     ! ${msg}  ║`);
      });
      lines.push('║                                                                ║');
    }
    
    lines.push('╚════════════════════════════════════════════════════════════════╝');
    
    return lines.join('\n');
  }

  /**
   * 生成告警信息
   */
  generateAlerts(health, metrics) {
    const alerts = [];
    
    // 系统告警
    if (metrics.system && !metrics.system.error) {
      const disk = metrics.system.disk;
      if (disk && disk.usagePercent > this.thresholds.diskUsage.critical) {
        alerts.push(`🔴 磁盘使用率过高: ${disk.usagePercent}%`);
      } else if (disk && disk.usagePercent > this.thresholds.diskUsage.warning) {
        alerts.push(`🟡 磁盘使用率警告: ${disk.usagePercent}%`);
      }
      
      const mem = metrics.system.memory;
      if (mem && mem.usagePercent > this.thresholds.memoryUsage.critical) {
        alerts.push(`🔴 内存使用率过高: ${mem.usagePercent}%`);
      }
    }
    
    // 任务告警
    if (metrics.tasks && !metrics.tasks.error) {
      if (metrics.tasks.completionRate < this.thresholds.taskCompletion.warning) {
        alerts.push(`🟡 任务完成率偏低: ${metrics.tasks.completionRate}%`);
      }
    }
    
    return alerts;
  }

  // ==================== 报告生成 ====================

  /**
   * 生成完整报告
   */
  async generateReport(format = 'dashboard') {
    // 收集所有指标
    const metrics = {
      system: await this.collectSystemMetrics(),
      knowledge: await this.collectKnowledgeBaseMetrics(),
      tasks: await this.collectTaskMetrics()
    };
    
    // 计算健康评分
    const health = this.calculateHealthScore(metrics);
    
    switch (format) {
      case 'dashboard':
        return this.formatDashboard(health, metrics);
      case 'json':
        return JSON.stringify({ health, metrics }, null, 2);
      case 'slack':
        return this.formatSlackReport(health, metrics);
      default:
        return this.formatDashboard(health, metrics);
    }
  }

  /**
   * 格式化Slack报告
   */
  formatSlackReport(health, metrics) {
    const status = health.status;
    const lines = [];
    
    lines.push(`📊 *系统健康仪表板* - ${status.emoji} ${status.text} (${health.total}/100)`);
    lines.push('');
    
    lines.push('*📈 分项评分*');
    lines.push(`• 系统: ${health.breakdown.system}/100`);
    lines.push(`• 知识库: ${health.breakdown.knowledge}/100`);
    lines.push(`• 任务: ${health.breakdown.tasks}/100`);
    lines.push('');
    
    if (metrics.system && !metrics.system.error) {
      lines.push('*🖥️ 系统*');
      lines.push(`• 磁盘: ${metrics.system.disk?.usagePercent}%`);
      lines.push(`• 内存: ${metrics.system.memory?.usagePercent}%`);
      lines.push(`• 负载: ${metrics.system.load?.['1min']?.toFixed(2)}`);
      lines.push('');
    }
    
    if (metrics.knowledge && !metrics.knowledge.error) {
      lines.push('*📚 知识库*');
      const total = metrics.knowledge.code?.total?.lines || 0;
      lines.push(`• 代码: ${this.formatNumber(total)}行`);
      lines.push(`• 文件: ${metrics.knowledge.files?.count}个`);
      lines.push('');
    }
    
    if (metrics.tasks && !metrics.tasks.error) {
      lines.push('*✅ 任务*');
      lines.push(`• 完成率: ${metrics.tasks.completionRate}%`);
      lines.push(`• 分布: P0(${metrics.tasks.priority.P0}) P1(${metrics.tasks.priority.P1}) P2(${metrics.tasks.priority.P2})`);
    }
    
    return lines.join('\n');
  }

  // ==================== 工具方法 ====================

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 格式化数字（添加千位分隔符）
   */
  formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 检查文件是否存在
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 保存历史数据
   */
  async saveHistory(data) {
    try {
      const historyPath = path.join(this.workspaceDir, '.health-history.json');
      let history = [];
      
      if (await this.fileExists(historyPath)) {
        const content = await fs.readFile(historyPath, 'utf8');
        history = JSON.parse(content);
      }
      
      history.push({
        timestamp: new Date().toISOString(),
        health: data.health,
        summary: {
          diskUsage: data.metrics.system?.disk?.usagePercent,
          memoryUsage: data.metrics.system?.memory?.usagePercent,
          taskCompletion: data.metrics.tasks?.completionRate,
          codeLines: data.metrics.knowledge?.code?.total?.lines
        }
      });
      
      // 只保留最近100条记录
      if (history.length > 100) {
        history = history.slice(-100);
      }
      
      await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
      return true;
    } catch (error) {
      console.error('保存历史数据失败:', error.message);
      return false;
    }
  }
}

// ==================== CLI ====================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'dashboard';
  
  const dashboard = new SystemHealthDashboard();
  
  switch (command) {
    case 'dashboard':
    case 'show':
      const report = await dashboard.generateReport('dashboard');
      console.log(report);
      break;
      
    case 'json':
      const json = await dashboard.generateReport('json');
      console.log(json);
      break;
      
    case 'slack':
      const slack = await dashboard.generateReport('slack');
      console.log(slack);
      break;
      
    case 'check':
      const checkReport = await dashboard.generateReport('json');
      const data = JSON.parse(checkReport);
      
      if (data.health.total < 60) {
        console.log('🔴 健康检查未通过');
        process.exit(1);
      } else {
        console.log('🟢 健康检查通过');
        process.exit(0);
      }
      break;
      
    case 'watch':
      console.log('👀 开始监控模式 (按 Ctrl+C 停止)...\n');
      const watch = async () => {
        console.clear();
        const r = await dashboard.generateReport('dashboard');
        console.log(r);
        console.log('\n⏱️  下次更新: 30秒后...');
      };
      watch();
      setInterval(watch, 30000);
      break;
      
    default:
      console.log(`
使用方法: node system-health-dashboard.js [命令]

命令:
  dashboard, show  显示ASCII仪表板 (默认)
  json             输出JSON格式报告
  slack            输出Slack格式报告
  check            健康检查 (非零退出码表示异常)
  watch            监控模式 (30秒刷新)

示例:
  node system-health-dashboard.js
  node system-health-dashboard.js json > report.json
  node system-health-dashboard.js watch
      `);
  }
}

// 导出类供测试使用
module.exports = SystemHealthDashboard;

// 如果直接运行则执行主函数
if (require.main === module) {
  main().catch(console.error);
}
