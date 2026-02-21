#!/usr/bin/env node
/**
 * 系统健康历史趋势追踪系统 v1.0
 * System Health Trend Tracker
 * 
 * 功能：
 * - 时间序列数据采集和存储
 * - 趋势分析和变化率计算
 * - ASCII折线图可视化
 * - 预测性告警（基于趋势）
 * 
 * @version 1.0.0
 * @author Clawy-OC
 * @date 2026-02-19
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ==================== 配置 ====================
const CONFIG = {
  // 数据存储
  dataDir: path.join(process.cwd(), 'health-trends'),
  dataFile: 'health-metrics.jsonl',
  
  // 采集设置
  maxDataPoints: 1000,        // 最大保留数据点数
  defaultTimeRange: '24h',    // 默认时间范围
  
  // 告警阈值
  trendThresholds: {
    disk: { warning: 5, critical: 10 },      // 每小时增长百分比
    memory: { warning: 8, critical: 15 },
    load: { warning: 0.5, critical: 1.0 }
  },
  
  // 可视化
  chartWidth: 60,
  chartHeight: 12
};

// ==================== 工具函数 ====================

/**
 * 格式化字节
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 格式化时间
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * 解析时间范围
 */
function parseTimeRange(range) {
  const match = range.match(/(\d+)([hdwmy])/);
  if (!match) return 24 * 60 * 60 * 1000; // 默认24小时
  
  const [, num, unit] = match;
  const multipliers = {
    'h': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000,
    'w': 7 * 24 * 60 * 60 * 1000,
    'm': 30 * 24 * 60 * 60 * 1000,
    'y': 365 * 24 * 60 * 60 * 1000
  };
  
  return parseInt(num) * (multipliers[unit] || multipliers['h']);
}

// ==================== 数据存储 ====================

class TrendDataStore {
  constructor(config = {}) {
    this.config = { ...CONFIG, ...config };
    this.dataPath = path.join(this.config.dataDir, this.config.dataFile);
    this.ensureDataDir();
  }
  
  /**
   * 确保数据目录存在
   */
  ensureDataDir() {
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
  }
  
  /**
   * 保存数据点
   */
  async save(dataPoint) {
    const line = JSON.stringify({
      timestamp: dataPoint.timestamp || Date.now(),
      ...dataPoint
    }) + '\n';
    
    fs.appendFileSync(this.dataPath, line);
    
    // 维护数据量
    await this.maintainDataSize();
  }
  
  /**
   * 维护数据大小
   */
  async maintainDataSize() {
    const data = this.loadAll();
    if (data.length > this.config.maxDataPoints) {
      const trimmed = data.slice(-this.config.maxDataPoints);
      fs.writeFileSync(
        this.dataPath,
        trimmed.map(d => JSON.stringify(d)).join('\n') + '\n'
      );
    }
  }
  
  /**
   * 加载所有数据
   */
  loadAll() {
    if (!fs.existsSync(this.dataPath)) return [];
    
    const content = fs.readFileSync(this.dataPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  
  /**
   * 加载时间范围内的数据
   */
  loadRange(range) {
    const duration = parseTimeRange(range);
    const cutoff = Date.now() - duration;
    
    return this.loadAll().filter(d => d.timestamp >= cutoff);
  }
  
  /**
   * 获取最新数据点
   */
  getLatest() {
    const data = this.loadAll();
    return data[data.length - 1] || null;
  }
  
  /**
   * 清空数据
   */
  clear() {
    if (fs.existsSync(this.dataPath)) {
      fs.unlinkSync(this.dataPath);
    }
  }
}

// ==================== 系统指标采集器 ====================

class SystemMetricsCollector {
  /**
   * 采集磁盘使用情况
   */
  collectDisk() {
    try {
      const stats = fs.statSync('/');
      const { execSync } = require('child_process');
      
      // 使用df命令获取磁盘使用
      const output = execSync('df -h / | tail -1', { encoding: 'utf-8' });
      const parts = output.trim().split(/\s+/);
      
      const total = this.parseSize(parts[1]);
      const used = this.parseSize(parts[2]);
      const available = this.parseSize(parts[3]);
      const percent = parseInt(parts[4].replace('%', ''));
      
      return {
        total,
        used,
        available,
        percent,
        status: percent > 85 ? 'critical' : percent > 70 ? 'warning' : 'ok'
      };
    } catch (error) {
      return { error: error.message };
    }
  }
  
  /**
   * 解析大小字符串
   */
  parseSize(sizeStr) {
    const match = sizeStr.match(/^([\d.]+)([KMGT]?)$/);
    if (!match) return 0;
    
    const [, num, unit] = match;
    const multipliers = { '': 1, 'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4 };
    return parseFloat(num) * (multipliers[unit] || 1);
  }
  
  /**
   * 采集内存使用情况
   */
  collectMemory() {
    try {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      const percent = Math.round((used / total) * 100);
      
      return {
        total,
        used,
        free,
        percent,
        status: percent > 90 ? 'critical' : percent > 75 ? 'warning' : 'ok'
      };
    } catch (error) {
      return { error: error.message };
    }
  }
  
  /**
   * 采集系统负载
   */
  collectLoad() {
    try {
      const load = os.loadavg();
      const cpus = os.cpus().length;
      
      return {
        '1min': load[0],
        '5min': load[1],
        '15min': load[2],
        perCpu: load.map(l => l / cpus),
        status: load[0] > cpus ? 'critical' : load[0] > cpus * 0.7 ? 'warning' : 'ok'
      };
    } catch (error) {
      return { error: error.message };
    }
  }
  
  /**
   * 采集所有指标
   */
  collectAll() {
    return {
      disk: this.collectDisk(),
      memory: this.collectMemory(),
      load: this.collectLoad(),
      uptime: os.uptime(),
      timestamp: Date.now()
    };
  }
}

// ==================== 趋势分析引擎 ====================

class TrendAnalyzer {
  /**
   * 计算趋势
   */
  calculateTrend(data, metricPath) {
    if (data.length < 2) return { trend: 'stable', change: 0 };
    
    // 获取指标值
    const values = data.map(d => this.getNestedValue(d, metricPath)).filter(v => typeof v === 'number');
    if (values.length < 2) return { trend: 'stable', change: 0 };
    
    // 线性回归计算趋势
    const n = values.length;
    const sumX = values.reduce((sum, _, i) => sum + i, 0);
    const sumY = values.reduce((sum, v) => sum + v, 0);
    const sumXY = values.reduce((sum, v, i) => sum + i * v, 0);
    const sumXX = values.reduce((sum, _, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const avgValue = sumY / n;
    const changePercent = avgValue !== 0 ? (slope / avgValue) * 100 : 0;
    
    // 确定趋势方向
    let trend = 'stable';
    if (changePercent > 5) trend = 'increasing';
    else if (changePercent < -5) trend = 'decreasing';
    
    // 预测下一个值
    const predicted = values[values.length - 1] + slope;
    
    return {
      trend,
      slope,
      change: changePercent,
      predicted,
      avgValue,
      min: Math.min(...values),
      max: Math.max(...values),
      current: values[values.length - 1]
    };
  }
  
  /**
   * 获取嵌套值
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((o, p) => o?.[p], obj);
  }
  
  /**
   * 分析所有指标趋势
   */
  analyzeAll(data) {
    return {
      disk: this.calculateTrend(data, 'disk.percent'),
      memory: this.calculateTrend(data, 'memory.percent'),
      load: this.calculateTrend(data, 'load.1min'),
      timestamp: Date.now(),
      dataPoints: data.length,
      timeSpan: data.length > 1 ? data[data.length - 1].timestamp - data[0].timestamp : 0
    };
  }
  
  /**
   * 生成告警
   */
  generateAlerts(analysis, thresholds) {
    const alerts = [];
    
    // 磁盘告警
    if (analysis.disk.change > thresholds.disk.critical) {
      alerts.push({
        level: 'critical',
        metric: 'disk',
        message: `磁盘使用率每小时增长 ${analysis.disk.change.toFixed(1)}%，预计将在 ${this.estimateTimeToFull(analysis.disk)} 内满`,
        recommendation: '请立即清理磁盘空间'
      });
    } else if (analysis.disk.change > thresholds.disk.warning) {
      alerts.push({
        level: 'warning',
        metric: 'disk',
        message: `磁盘使用率增长较快: ${analysis.disk.change.toFixed(1)}%/小时`,
        recommendation: '建议检查磁盘使用情况'
      });
    }
    
    // 内存告警
    if (analysis.memory.change > thresholds.memory.critical) {
      alerts.push({
        level: 'critical',
        metric: 'memory',
        message: `内存使用率每小时增长 ${analysis.memory.change.toFixed(1)}%`,
        recommendation: '请检查内存泄漏'
      });
    }
    
    // 负载告警
    if (analysis.load.slope > thresholds.load.critical) {
      alerts.push({
        level: 'warning',
        metric: 'load',
        message: `系统负载呈上升趋势`,
        recommendation: '请关注系统性能'
      });
    }
    
    return alerts;
  }
  
  /**
   * 估算磁盘满时间
   */
  estimateTimeToFull(diskTrend) {
    if (diskTrend.slope <= 0) return '不会满';
    
    const remaining = 100 - diskTrend.current;
    const hoursToFull = remaining / (diskTrend.slope * diskTrend.current / 100);
    
    if (hoursToFull < 1) return `${Math.round(hoursToFull * 60)} 分钟`;
    if (hoursToFull < 24) return `${Math.round(hoursToFull)} 小时`;
    return `${Math.round(hoursToFull / 24)} 天`;
  }
}

// ==================== ASCII可视化 ====================

class ASCIITrendChart {
  constructor(width = 60, height = 12) {
    this.width = width;
    this.height = height;
  }
  
  /**
   * 绘制折线图
   */
  draw(data, options = {}) {
    const { title = 'Trend Chart', label = '', color = 'cyan' } = options;
    
    if (data.length === 0) return '无数据';
    
    const values = data.map(d => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    
    // 构建图表
    const lines = [];
    
    // 标题
    lines.push(`╔${'═'.repeat(this.width - 2)}╗`);
    lines.push(`║ ${title.padEnd(this.width - 4)} ║`);
    lines.push(`╠${'═'.repeat(this.width - 2)}╣`);
    
    // Y轴标签宽度
    const labelWidth = 8;
    const chartWidth = this.width - labelWidth - 4;
    
    // 绘制数据行（从上到下）
    for (let row = 0; row < this.height; row++) {
      const valueAtRow = max - (range * row / (this.height - 1));
      const label = valueAtRow.toFixed(0).padStart(6);
      
      let line = `║${label} │`;
      
      // 绘制每个数据点
      for (let col = 0; col < chartWidth; col++) {
        const dataIndex = Math.floor(col * data.length / chartWidth);
        const value = values[dataIndex];
        const normalizedRow = Math.floor((max - value) / range * (this.height - 1));
        
        // 使用不同字符表示数据点和连接线
        if (normalizedRow === row) {
          line += '●'; // 数据点
        } else if (dataIndex > 0) {
          const prevValue = values[dataIndex - 1];
          const prevRow = Math.floor((max - prevValue) / range * (this.height - 1));
          const minRow = Math.min(normalizedRow, prevRow);
          const maxRow = Math.max(normalizedRow, prevRow);
          
          if (row > minRow && row < maxRow) {
            line += prevValue < value ? '/' : '\\'; // 连接线
          } else {
            line += ' ';
          }
        } else {
          line += ' ';
        }
      }
      
      line = line.padEnd(this.width - 1) + '║';
      lines.push(line);
    }
    
    // X轴
    lines.push(`║${' '.repeat(labelWidth)}├${'─'.repeat(chartWidth)}┤${' '.repeat(2)}║`);
    
    // 时间标签
    const firstTime = formatTime(data[0].timestamp);
    const lastTime = formatTime(data[data.length - 1].timestamp);
    const timeLine = `║${' '.repeat(labelWidth)} ${firstTime.padEnd(chartWidth - lastTime.length - 2)}${lastTime}  ║`;
    lines.push(timeLine);
    
    // 底部
    lines.push(`╚${'═'.repeat(this.width - 2)}╝`);
    
    // 统计信息
    lines.push(`  📊 当前: ${values[values.length - 1].toFixed(1)} | 最低: ${min.toFixed(1)} | 最高: ${max.toFixed(1)} | 平均: ${(values.reduce((a,b)=>a+b,0)/values.length).toFixed(1)}`);
    
    return lines.join('\n');
  }
  
  /**
   * 绘制多指标对比图
   */
  drawMultiMetric(data, metrics) {
    const lines = [];
    
    lines.push('╔══════════════════════════════════════════════════════════════╗');
    lines.push('║           📈 系统健康趋势对比图                              ║');
    lines.push('╠══════════════════════════════════════════════════════════════╣');
    
    metrics.forEach(metric => {
      const metricData = data.map(d => ({
        timestamp: d.timestamp,
        value: this.getNestedValue(d, metric.path) || 0
      }));
      
      if (metricData.length > 0) {
        lines.push(`║  ${metric.icon} ${metric.name}`);
        lines.push(this.drawSparkline(metricData));
        lines.push('║');
      }
    });
    
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    
    return lines.join('\n');
  }
  
  /**
   * 绘制迷你图
   */
  drawSparkline(data) {
    const values = data.map(d => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    
    const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const sparkline = values.map(v => {
      const normalized = (v - min) / range;
      const index = Math.min(Math.floor(normalized * blocks.length), blocks.length - 1);
      return blocks[index];
    }).join('');
    
    const current = values[values.length - 1];
    const change = values.length > 1 ? current - values[0] : 0;
    const changeIcon = change > 0 ? '📈' : change < 0 ? '📉' : '➡️';
    
    return `║     ${sparkline} ${changeIcon} ${Math.abs(change).toFixed(1)}`;
  }
  
  getNestedValue(obj, path) {
    return path.split('.').reduce((o, p) => o?.[p], obj);
  }
}

// ==================== 主控制器 ====================

class HealthTrendTracker {
  constructor(config = {}) {
    this.config = { ...CONFIG, ...config };
    this.dataStore = new TrendDataStore(this.config);
    this.collector = new SystemMetricsCollector();
    this.analyzer = new TrendAnalyzer();
    this.visualizer = new ASCIITrendChart(this.config.chartWidth, this.config.chartHeight);
  }
  
  /**
   * 采集并保存当前数据
   */
  async collect() {
    const metrics = this.collector.collectAll();
    await this.dataStore.save(metrics);
    return metrics;
  }
  
  /**
   * 获取趋势报告
   */
  async getTrendReport(timeRange = this.config.defaultTimeRange) {
    const data = this.dataStore.loadRange(timeRange);
    
    if (data.length === 0) {
      return { error: '无历史数据，请先运行数据采集' };
    }
    
    const analysis = this.analyzer.analyzeAll(data);
    const alerts = this.analyzer.generateAlerts(analysis, this.config.trendThresholds);
    
    return {
      timeRange,
      dataPoints: data.length,
      analysis,
      alerts,
      latest: data[data.length - 1],
      first: data[0]
    };
  }
  
  /**
   * 生成可视化报告
   */
  async generateVisualReport(timeRange = '24h') {
    const report = await this.getTrendReport(timeRange);
    
    if (report.error) {
      return report.error;
    }
    
    const lines = [];
    
    // 标题
    lines.push('╔════════════════════════════════════════════════════════════════╗');
    lines.push('║           🦞 Clawy-OC 系统健康趋势报告 v1.0                    ║');
    lines.push('╠════════════════════════════════════════════════════════════════╣');
    
    // 时间范围信息
    const timeSpan = report.analysis.timeSpan;
    const hours = Math.round(timeSpan / (60 * 60 * 1000));
    lines.push(`║  📅 时间范围: ${timeRange} (${hours}小时) | 数据点: ${report.dataPoints}  ║`);
    lines.push('║                                                                ║');
    
    // 趋势摘要
    lines.push('║  📊 趋势摘要                                                   ║');
    lines.push('║  ───────────────────────────────────────────────────────────── ║');
    
    // 磁盘趋势
    const diskTrend = report.analysis.disk;
    const diskIcon = diskTrend.trend === 'increasing' ? '📈' : diskTrend.trend === 'decreasing' ? '📉' : '➡️';
    const diskStatus = diskTrend.current > 85 ? '🔴' : diskTrend.current > 70 ? '🟡' : '🟢';
    lines.push(`║  💾 磁盘: ${diskStatus} ${diskTrend.current.toFixed(1)}% ${diskIcon} ${diskTrend.change > 0 ? '+' : ''}${diskTrend.change.toFixed(1)}%/h  ║`);
    
    // 内存趋势
    const memTrend = report.analysis.memory;
    const memIcon = memTrend.trend === 'increasing' ? '📈' : memTrend.trend === 'decreasing' ? '📉' : '➡️';
    const memStatus = memTrend.current > 90 ? '🔴' : memTrend.current > 75 ? '🟡' : '🟢';
    lines.push(`║  🧠 内存: ${memStatus} ${memTrend.current.toFixed(1)}% ${memIcon} ${memTrend.change > 0 ? '+' : ''}${memTrend.change.toFixed(1)}%/h  ║`);
    
    // 负载趋势
    const loadTrend = report.analysis.load;
    const loadIcon = loadTrend.trend === 'increasing' ? '📈' : loadTrend.trend === 'decreasing' ? '📉' : '➡️';
    const loadStatus = loadTrend.current > 2 ? '🔴' : loadTrend.current > 1 ? '🟡' : '🟢';
    lines.push(`║  ⚡ 负载: ${loadStatus} ${loadTrend.current.toFixed(2)} ${loadIcon} ${loadTrend.slope > 0 ? '+' : ''}${loadTrend.slope.toFixed(3)}/h  ║`);
    
    lines.push('║                                                                ║');
    
    // 告警
    if (report.alerts.length > 0) {
      lines.push('║  🚨 趋势告警                                                   ║');
      lines.push('║  ───────────────────────────────────────────────────────────── ║');
      report.alerts.forEach(alert => {
        const icon = alert.level === 'critical' ? '🔴' : '🟡';
        const msg = `${icon} ${alert.message}`.substring(0, 55).padEnd(55);
        lines.push(`║  ${msg}  ║`);
      });
    } else {
      lines.push('║  ✅ 暂无趋势告警                                               ║');
    }
    
    lines.push('╚════════════════════════════════════════════════════════════════╝');
    
    // ASCII图表
    const data = this.dataStore.loadRange(timeRange);
    
    // 磁盘图表
    const diskData = data.map(d => ({
      timestamp: d.timestamp,
      value: d.disk?.percent || 0
    }));
    lines.push('');
    lines.push(this.visualizer.draw(diskData, { 
      title: '💾 磁盘使用率趋势', 
      label: '%',
      color: 'blue'
    }));
    
    // 内存图表
    const memData = data.map(d => ({
      timestamp: d.timestamp,
      value: d.memory?.percent || 0
    }));
    lines.push('');
    lines.push(this.visualizer.draw(memData, { 
      title: '🧠 内存使用率趋势', 
      label: '%',
      color: 'green'
    }));
    
    return lines.join('\n');
  }
  
  /**
   * 导出JSON报告
   */
  async exportJSON(timeRange = '24h') {
    const report = await this.getTrendReport(timeRange);
    return JSON.stringify(report, null, 2);
  }
  
  /**
   * 导出Slack格式
   */
  async exportSlack(timeRange = '24h') {
    const report = await this.getTrendReport(timeRange);
    
    if (report.error) {
      return report.error;
    }
    
    const lines = [];
    lines.push(`📈 *系统健康趋势报告* - ${new Date().toLocaleString('zh-CN')}`);
    lines.push(`📅 时间范围: ${timeRange} | 数据点: ${report.dataPoints}`);
    lines.push('');
    
    const disk = report.analysis.disk;
    lines.push(`💾 *磁盘*: ${disk.current.toFixed(1)}% (${disk.trend === 'increasing' ? '📈 +' : disk.trend === 'decreasing' ? '📉 ' : '➡️ '}${disk.change.toFixed(1)}%/h)`);
    
    const mem = report.analysis.memory;
    lines.push(`🧠 *内存*: ${mem.current.toFixed(1)}% (${mem.trend === 'increasing' ? '📈 +' : mem.trend === 'decreasing' ? '📉 ' : '➡️ '}${mem.change.toFixed(1)}%/h)`);
    
    const load = report.analysis.load;
    lines.push(`⚡ *负载*: ${load.current.toFixed(2)} (${load.trend === 'increasing' ? '📈 +' : load.trend === 'decreasing' ? '📉 ' : '➡️ '}${load.slope.toFixed(3)}/h)`);
    
    if (report.alerts.length > 0) {
      lines.push('');
      lines.push('🚨 *趋势告警*');
      report.alerts.forEach(alert => {
        lines.push(`${alert.level === 'critical' ? '🔴' : '🟡'} ${alert.message}`);
      });
    }
    
    return lines.join('\n');
  }
}

// ==================== CLI ====================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'report';
  const tracker = new HealthTrendTracker();
  
  switch (command) {
    case 'collect':
      // 采集数据
      const metrics = await tracker.collect();
      console.log('✅ 数据采集完成');
      console.log(`   💾 磁盘: ${metrics.disk?.percent}%`);
      console.log(`   🧠 内存: ${metrics.memory?.percent}%`);
      console.log(`   ⚡ 负载: ${metrics.load?.['1min']?.toFixed(2)}`);
      break;
      
    case 'report':
      // 生成报告
      const range = args[1] || '24h';
      const report = await tracker.generateVisualReport(range);
      console.log(report);
      break;
      
    case 'json':
      // JSON输出
      const jsonRange = args[1] || '24h';
      console.log(await tracker.exportJSON(jsonRange));
      break;
      
    case 'slack':
      // Slack格式
      const slackRange = args[1] || '24h';
      console.log(await tracker.exportSlack(slackRange));
      break;
      
    case 'clear':
      // 清空数据
      tracker.dataStore.clear();
      console.log('✅ 历史数据已清空');
      break;
      
    case 'demo':
      // 生成演示数据
      console.log('🎮 生成演示数据...');
      await generateDemoData(tracker);
      console.log('✅ 演示数据生成完成，运行 report 查看');
      break;
      
    default:
      console.log(`
🦞 Clawy-OC 系统健康趋势追踪系统 v1.0

用法: node trend-tracker.js <命令> [选项]

命令:
  collect          采集当前系统指标
  report [range]   生成趋势报告 (默认24h)
  json [range]     导出JSON格式
  slack [range]    导出Slack格式
  clear            清空历史数据
  demo             生成演示数据

时间范围格式:
  1h, 6h, 24h, 7d, 30d

示例:
  node trend-tracker.js collect
  node trend-tracker.js report 24h
  node trend-tracker.js json 7d
      `);
  }
}

/**
 * 生成演示数据
 */
async function generateDemoData(tracker) {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  
  // 生成24小时的演示数据
  for (let i = 24; i >= 0; i--) {
    const timestamp = now - (i * hourMs);
    
    // 模拟磁盘缓慢增长
    const diskPercent = 45 + (24 - i) * 0.5 + Math.random() * 2;
    
    // 模拟内存波动
    const memPercent = 50 + Math.sin(i / 3) * 10 + Math.random() * 5;
    
    // 模拟负载波动
    const load = 0.5 + Math.sin(i / 4) * 0.3 + Math.random() * 0.2;
    
    const mockData = {
      timestamp,
      disk: {
        percent: Math.min(100, diskPercent),
        status: diskPercent > 85 ? 'critical' : diskPercent > 70 ? 'warning' : 'ok'
      },
      memory: {
        percent: Math.min(100, memPercent),
        status: memPercent > 90 ? 'critical' : memPercent > 75 ? 'warning' : 'ok'
      },
      load: {
        '1min': load,
        status: load > 2 ? 'critical' : load > 1 ? 'warning' : 'ok'
      }
    };
    
    await tracker.dataStore.save(mockData);
  }
}

// 运行
if (require.main === module) {
  main().catch(console.error);
}

// 导出模块
module.exports = {
  HealthTrendTracker,
  TrendDataStore,
  SystemMetricsCollector,
  TrendAnalyzer,
  ASCIITrendChart,
  CONFIG
};
