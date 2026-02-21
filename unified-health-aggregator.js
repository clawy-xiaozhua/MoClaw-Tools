#!/usr/bin/env node
/**
 * 统一健康状态聚合器 v1.0
 * Unified Health Aggregator
 * 
 * 功能：
 * - 整合系统健康、趋势追踪、日志聚合、API监控数据
 * - 计算综合健康评分
 * - 生成统一仪表板输出
 * - 支持多格式输出（CLI/JSON/Slack）
 * 
 * @version 1.0.0
 * @author Clawy-OC
 * @date 2026-02-20
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ==================== 配置 ====================
const CONFIG = {
  // 数据源配置
  sources: {
    system: {
      enabled: true,
      weight: 0.30,
      command: 'node system-health-dashboard.js json 2>/dev/null',
      parseMethod: 'parseSystemHealth'
    },
    trend: {
      enabled: true,
      weight: 0.25,
      command: 'node trend-tracker.js json 2>/dev/null',
      parseMethod: 'parseTrend'
    },
    logs: {
      enabled: true,
      weight: 0.20,
      command: 'node log-aggregator.js report 2>/dev/null',
      parseMethod: 'parseLogs'
    },
    api: {
      enabled: true,
      weight: 0.15,
      command: 'node api-monitor.js check 2>/dev/null',
      parseMethod: 'parseAPI'
    },
    alerts: {
      enabled: true,
      weight: 0.10,
      command: 'node alert-hub.js list 2>/dev/null',
      parseMethod: 'parseAlerts'
    }
  },
  
  // 健康评分阈值
  thresholds: {
    excellent: 90,
    good: 75,
    fair: 60,
    poor: 40
  },
  
  // 输出格式
  outputFormat: 'cli'
};

// ==================== 工具函数 ====================
function formatTime(date = new Date()) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ==================== 数据解析器 ====================
class DataParser {
  static parseSystemHealth(output) {
    try {
      const data = JSON.parse(output);
      return {
        score: data.overallScore || data.score || 70,
        status: data.status || 'unknown',
        metrics: {
          cpu: data.system?.cpu || 0,
          memory: data.system?.memory || 0,
          disk: data.system?.disk || 0
        }
      };
    } catch (e) {
      return { score: 50, status: 'error', error: e.message };
    }
  }
  
  static parseTrend(output) {
    try {
      const data = JSON.parse(output);
      const trends = data.trends || {};
      let avgTrend = 0;
      let trendCount = 0;
      
      for (const [key, value] of Object.entries(trends)) {
        if (value.slope !== undefined) {
          avgTrend += value.slope;
          trendCount++;
        }
      }
      
      avgTrend = trendCount > 0 ? avgTrend / trendCount : 0;
      
      return {
        score: avgTrend > 0 ? 80 : avgTrend < -5 ? 50 : 70,
        status: avgTrend > 0 ? 'improving' : avgTrend < -5 ? 'degrading' : 'stable',
        trends: trends
      };
    } catch (e) {
      return { score: 50, status: 'error', error: e.message };
    }
  }
  
  static parseLogs(output) {
    try {
      // 移除前缀文本（如 "📊 生成系统报告"）
      const jsonStr = output.replace(/^[^\{]*\{/, '{');
      const data = JSON.parse(jsonStr);
      
      // 尝试多种可能的字段名
      let errorCount = 0;
      let warningCount = 0;
      
      // 直接字段
      if (data.errors) errorCount = typeof data.errors === 'number' ? data.errors : data.errors.length || 0;
      else if (data.errorCount) errorCount = data.errorCount;
      else if (data.alerts && data.alerts.active) errorCount = data.alerts.active;
      
      if (data.warnings) warningCount = typeof data.warnings === 'number' ? data.warnings : data.warnings.length || 0;
      else if (data.warningCount) warningCount = data.warningCount;
      else if (data.alerts && data.alerts.bySeverity) {
        warningCount = (data.alerts.bySeverity.warning || 0) + 
                       (data.alerts.bySeverity.medium || 0) + 
                       (data.alerts.bySeverity.low || 0);
      }
      
      // 如果没有错误，检查存储和数据源状态
      if (errorCount === 0 && warningCount === 0) {
        if (data.sources && data.sources > 0 && data.storage && data.storage.files > 0) {
          // 系统正在正常运行
          return {
            score: 100,
            status: 'healthy',
            errorCount: 0,
            warningCount: 0
          };
        }
      }
      
      let score = 100;
      score -= Math.min(errorCount * 10, 50);
      score -= Math.min(warningCount * 2, 20);
      
      return {
        score: Math.max(score, 20),
        status: errorCount > 10 ? 'critical' : errorCount > 0 ? 'warning' : warningCount > 0 ? 'warning' : 'healthy',
        errorCount,
        warningCount
      };
    } catch (e) {
      return { score: 50, status: 'error', error: e.message };
    }
  }
  
  static parseAPI(output) {
    try {
      // 尝试解析JSON
      const data = JSON.parse(output);
      if (data.checks && Array.isArray(data.checks)) {
        const total = data.checks.length;
        const healthy = data.checks.filter(c => c.status === 'healthy').length;
        const uptime = total > 0 ? (healthy / total) * 100 : 95;
        const avgResponseTime = data.checks.reduce((sum, c) => sum + (c.responseTime || 0), 0) / total;
        
        let score = uptime;
        if (avgResponseTime > 500) score -= 10;
        if (avgResponseTime > 1000) score -= 20;
        
        return {
          score: Math.max(score, 0),
          status: uptime > 99 ? 'healthy' : uptime > 95 ? 'degraded' : 'down',
          uptime,
          responseTime: avgResponseTime
        };
      }
      const uptime = data.uptime || data.successRate || 95;
      const responseTime = data.avgResponseTime || data.responseTime || 100;
      
      let score = uptime;
      if (responseTime > 500) score -= 10;
      if (responseTime > 1000) score -= 20;
      
      return {
        score: Math.max(score, 0),
        status: uptime > 99 ? 'healthy' : uptime > 95 ? 'degraded' : 'down',
        uptime,
        responseTime
      };
    } catch (e) {
      // 解析文本输出
      const healthyMatch = output.match(/✓.*healthy/gi);
      const errorMatch = output.match(/✗.*error/gi);
      const healthy = healthyMatch ? healthyMatch.length : 0;
      const error = errorMatch ? errorMatch.length : 0;
      const total = healthy + error;
      const uptime = total > 0 ? (healthy / total) * 100 : 50;
      
      return {
        score: Math.max(uptime, 0),
        status: uptime > 99 ? 'healthy' : uptime > 95 ? 'degraded' : 'down',
        uptime,
        responseTime: 0
      };
    }
  }
  
  static parseAlerts(output) {
    try {
      const data = JSON.parse(output);
      const critical = data.critical || data.criticalCount || 0;
      const warning = data.warning || data.warningCount || 0;
      
      let score = 100;
      score -= critical * 15;
      score -= warning * 5;
      
      return {
        score: Math.max(score, 0),
        status: critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'healthy',
        critical,
        warning
      };
    } catch (e) {
      // 解析文本输出
      const criticalMatch = output.match(/🔴|critical/gi);
      const warningMatch = output.match(/🟡|warning/gi);
      const critical = criticalMatch ? criticalMatch.length : 0;
      const warning = warningMatch ? warningMatch.length : 0;
      
      let score = 100;
      score -= critical * 15;
      score -= warning * 5;
      
      return {
        score: Math.max(score, 0),
        status: critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'healthy',
        critical,
        warning
      };
    }
  }
}

// ==================== 健康聚合器 ====================
class HealthAggregator {
  constructor(config = {}) {
    this.config = { ...CONFIG, ...config };
    this.dataDir = path.join(process.cwd(), 'health-aggregator');
    this.historyFile = path.join(this.dataDir, 'history.jsonl');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.data = {};
    this.scores = {};
    this.lastUpdate = null;
    
    ensureDir(this.dataDir);
  }
  
  // 收集所有数据源
  async collect() {
    console.log('📡 正在收集健康数据...');
    this.data = {};
    this.scores = {};
    
    for (const [name, source] of Object.entries(this.config.sources)) {
      if (!source.enabled) continue;
      
      try {
        const output = execSync(source.command, { 
          encoding: 'utf8', 
          timeout: 10000,
          cwd: process.cwd()
        });
        
        const parser = DataParser[source.parseMethod];
        if (parser) {
          this.data[name] = parser(output);
          this.scores[name] = this.data[name].score * source.weight;
          console.log(`  ✅ ${name}: ${this.data[name].score}分 [${this.data[name].status}]`);
        }
      } catch (e) {
        console.log(`  ⚠️ ${name}: 收集失败 - ${e.message}`);
        this.scores[name] = 0;
      }
    }
    
    this.lastUpdate = new Date();
    return this.data;
  }
  
  // 计算综合健康评分
  calculateScore() {
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const [name, source] of Object.entries(this.config.sources)) {
      if (!source.enabled) continue;
      totalWeight += source.weight;
      // 检查是否需要加权：如果scores[name] <= 100，说明是原始分数，需要加权
      const rawScore = this.scores[name] || 0;
      if (rawScore <= 100) {
        weightedSum += rawScore * source.weight;
      } else {
        // 已经是加权分数，直接累加
        weightedSum += rawScore;
      }
    }
    
    const score = Math.round(weightedSum);
    
    // 确定状态
    let status;
    if (score >= this.config.thresholds.excellent) status = '🟢 优秀';
    else if (score >= this.config.thresholds.good) status = '🟡 良好';
    else if (score >= this.config.thresholds.fair) status = '🟠 一般';
    else status = '🔴 严峻';
    
    return { score, status, weights: this.scores };
  }
  
  // 生成CLI输出
  generateCLI() {
    const { score, status } = this.calculateScore();
    
    let cli = `
╔══════════════════════════════════════════════════════════════╗
║       🦞 统一健康状态聚合器 v1.0                              ║
║       更新时间: ${formatTime(this.lastUpdate)}
╠══════════════════════════════════════════════════════════════╣
║  📊 综合健康评分                                             ║
║     ${status} ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░ ${score}/100          
║                                                              ║
║  📈 分项评分                                                 ║
`;
    
    // 添加每个数据源的详细信息
    const sourceNames = {
      system: '🖥️ 系统健康',
      trend: '📈 趋势分析',
      logs: '📋 日志聚合',
      api: '🔌 API监控',
      alerts: '🚨 告警中心'
    };
    
    for (const [name, source] of Object.entries(this.config.sources)) {
      if (!source.enabled) continue;
      const data = this.data[name];
      const sourceScore = data?.score || 0;
      const bar = '█'.repeat(Math.floor(sourceScore / 5)) + '░'.repeat(20 - Math.floor(sourceScore / 5));
      const label = sourceNames[name] || name;
      cli += `║     ${label} [${bar}] ${sourceScore}%\n`;
    }
    
    cli += `║                                                              ║
║  🔍 状态详情                                                 ║
`;
    
    // 添加状态详情
    if (this.data.system) {
      const sys = this.data.system;
      cli += `║     系统: ${sys.status} | CPU:${sys.metrics?.cpu || 0}% | 内存:${sys.metrics?.memory || 0}%\n`;
    }
    if (this.data.logs) {
      const log = this.data.logs;
      cli += `║     日志: ${log.status} | 错误:${log.errorCount || 0} | 警告:${log.warningCount || 0}\n`;
    }
    if (this.data.alerts) {
      const alert = this.data.alerts;
      cli += `║     告警: ${alert.status} | 严重:${alert.critical || 0} | 警告:${alert.warning || 0}\n`;
    }
    
    cli += `╚══════════════════════════════════════════════════════════════╝
`;
    
    return cli;
  }
  
  // 生成JSON输出
  generateJSON() {
    const { score, status } = this.calculateScore();
    
    return {
      timestamp: this.lastUpdate?.toISOString(),
      overall: {
        score,
        status,
        thresholds: this.config.thresholds
      },
      sources: this.data,
      weights: this.scores
    };
  }
  
  // 生成Slack格式
  generateSlack() {
    const { score, status } = this.calculateScore();
    
    let text = `🦞 *统一健康状态* - ${formatTime(this.lastUpdate)}\n`;
    text += `综合评分: *${score}*/100 ${status}\n\n`;
    text += `*分项评分:*\n`;
    
    const sourceNames = {
      system: '🖥️ 系统',
      trend: '📈 趋势',
      logs: '📋 日志',
      api: '🔌 API',
      alerts: '🚨 告警'
    };
    
    for (const [name, data] of Object.entries(this.data)) {
      const label = sourceNames[name] || name;
      text += `• ${label}: ${data.score}% [${data.status}]\n`;
    }
    
    return text;
  }
  
  // 保存状态
  save() {
    const state = {
      timestamp: this.lastUpdate?.toISOString(),
      scores: this.scores,
      overall: this.calculateScore()
    };
    
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    
    // 追加到历史
    const historyEntry = {
      timestamp: state.timestamp,
      score: state.overall.score,
      status: state.overall.status
    };
    
    fs.appendFileSync(this.historyFile, JSON.stringify(historyEntry) + '\n');
  }
  
  // 获取历史数据
  getHistory(hours = 24) {
    if (!fs.existsSync(this.historyFile)) return [];
    
    const cutoff = Date.now() - hours * 3600000;
    const history = [];
    
    const lines = fs.readFileSync(this.historyFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.timestamp).getTime() > cutoff) {
          history.push(entry);
        }
      } catch (e) {}
    }
    
    return history;
  }
  
  // 主运行方法
  async run(format = 'cli') {
    await this.collect();
    this.save();
    
    switch (format) {
      case 'json':
        console.log(JSON.stringify(this.generateJSON(), null, 2));
        break;
      case 'slack':
        console.log(this.generateSlack());
        break;
      default:
        console.log(this.generateCLI());
    }
    
    return this.generateJSON();
  }
}

// ==================== CLI ====================
function showHelp() {
  console.log(`
🦞 统一健康状态聚合器 v1.0

用法: node unified-health-aggregator.js [选项]

选项:
  --json          输出JSON格式
  --slack         输出Slack格式
  --history       显示历史数据
  --hours <n>     历史数据小时数 (默认24)
  -h, --help      显示帮助

示例:
  node unified-health-aggregator.js
  node unified-health-aggregator.js --json
  node unified-health-aggregator.js --slack
  node unified-health-aggregator.js --history --hours 48
`);
}

// 主入口
async function main() {
  const args = process.argv.slice(2);
  let format = 'cli';
  let showHistory = false;
  let historyHours = 24;
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--json':
        format = 'json';
        break;
      case '--slack':
        format = 'slack';
        break;
      case '--history':
        showHistory = true;
        break;
      case '--hours':
        historyHours = parseInt(args[++i]) || 24;
        break;
      case '-h':
      case '--help':
        showHelp();
        process.exit(0);
    }
  }
  
  const aggregator = new HealthAggregator();
  
  if (showHistory) {
    const history = aggregator.getHistory(historyHours);
    console.log(`📊 历史数据 (最近${historyHours}小时):`);
    console.log(JSON.stringify(history, null, 2));
  } else {
    await aggregator.run(format);
  }
}

// 导出模块
module.exports = { HealthAggregator, DataParser, CONFIG };

// 运行
if (require.main === module) {
  main().catch(console.error);
}
