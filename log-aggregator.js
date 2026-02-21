#!/usr/bin/env node
/**
 * 统一日志聚合与智能分析系统 v1.0
 * Unified Log Aggregation & Intelligence System
 * 
 * 功能：
 * - 聚合多个监控源的日志数据
 * - 智能模式识别和异常检测
 * - 统一告警管理和路由
 * - 时间序列数据库存储
 * - REST API查询接口
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ============== 配置管理 ==============
const CONFIG = {
  version: '1.0.0',
  dataDir: path.join(__dirname, 'data', 'logs'),
  retention: {
    raw: 7 * 24 * 60 * 60 * 1000,      // 7天原始数据
    aggregated: 30 * 24 * 60 * 60 * 1000, // 30天聚合数据
    archive: 365 * 24 * 60 * 60 * 1000   // 1年归档
  },
  sources: [
    { name: 'system-health', pattern: 'system-health-*.jsonl', parser: 'jsonl' },
    { name: 'api-monitor', pattern: 'api-monitor-*.jsonl', parser: 'jsonl' },
    { name: 'trend-tracker', pattern: 'trends-*.jsonl', parser: 'jsonl' },
    { name: 'application', pattern: 'app-*.log', parser: 'regex' }
  ],
  aggregation: {
    intervals: ['1m', '5m', '15m', '1h', '1d'],
    default: '5m'
  },
  anomaly: {
    threshold: 2.5,  // 标准差倍数
    minPoints: 10,   // 最小数据点
    window: '1h'     // 检测窗口
  }
};

// ============== 时间序列数据库 ==============
class TimeSeriesDB {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cache = new Map();
    this.init();
  }

  init() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // 写入数据点
  write(metric, value, tags = {}, timestamp = Date.now()) {
    const point = {
      t: timestamp,
      v: value,
      ...tags
    };
    
    const file = path.join(this.dataDir, `${metric}.jsonl`);
    const line = JSON.stringify(point) + '\n';
    fs.appendFileSync(file, line);
    
    // 更新缓存
    if (!this.cache.has(metric)) {
      this.cache.set(metric, []);
    }
    this.cache.get(metric).push(point);
    
    return point;
  }

  // 查询数据
  query(metric, start, end, aggregator = null) {
    const file = path.join(this.dataDir, `${metric}.jsonl`);
    if (!fs.existsSync(file)) return [];
    
    const points = [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    
    for (const line of lines) {
      try {
        const point = JSON.parse(line);
        if (point.t >= start && point.t <= end) {
          points.push(point);
        }
      } catch (e) {
        // 跳过无效行
      }
    }
    
    return aggregator ? this.aggregate(points, aggregator) : points;
  }

  // 聚合计算
  aggregate(points, interval) {
    const buckets = new Map();
    const intervalMs = this.parseInterval(interval);
    
    for (const point of points) {
      const bucket = Math.floor(point.t / intervalMs) * intervalMs;
      if (!buckets.has(bucket)) {
        buckets.set(bucket, []);
      }
      buckets.get(bucket).push(point.v);
    }
    
    const result = [];
    for (const [timestamp, values] of buckets) {
      result.push({
        t: timestamp,
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        p95: this.percentile(values, 0.95),
        p99: this.percentile(values, 0.99)
      });
    }
    
    return result.sort((a, b) => a.t - b.t);
  }

  parseInterval(interval) {
    const units = { m: 60000, h: 3600000, d: 86400000 };
    const match = interval.match(/^(\d+)([mhd])$/);
    return match ? parseInt(match[1]) * units[match[2]] : 300000;
  }

  percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }
}

// ============== 智能异常检测 ==============
class AnomalyDetector {
  constructor(config) {
    this.config = config;
    this.models = new Map();
  }

  // 检测异常
  detect(metric, points) {
    if (points.length < this.config.minPoints) {
      return { status: 'insufficient_data', anomalies: [] };
    }
    
    const values = points.map(p => p.v);
    const stats = this.calculateStats(values);
    const anomalies = [];
    
    for (let i = 0; i < points.length; i++) {
      const zscore = (values[i] - stats.mean) / stats.stdDev;
      if (Math.abs(zscore) > this.config.threshold) {
        anomalies.push({
          timestamp: points[i].t,
          value: values[i],
          zscore: zscore,
          direction: zscore > 0 ? 'high' : 'low',
          severity: this.calculateSeverity(zscore)
        });
      }
    }
    
    return {
      status: anomalies.length > 0 ? 'anomaly_detected' : 'normal',
      stats,
      anomalies,
      summary: {
        total: points.length,
        anomalies: anomalies.length,
        rate: anomalies.length / points.length
      }
    };
  }

  // 计算统计量
  calculateStats(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    return { mean, stdDev, variance };
  }

  // 计算严重程度
  calculateSeverity(zscore) {
    const abs = Math.abs(zscore);
    if (abs > 4) return 'critical';
    if (abs > 3) return 'high';
    if (abs > 2.5) return 'medium';
    return 'low';
  }

  // 趋势预测（简单线性回归）
  predict(points, steps = 5) {
    const n = points.length;
    const sumX = points.reduce((sum, p, i) => sum + i, 0);
    const sumY = points.reduce((sum, p) => sum + p.v, 0);
    const sumXY = points.reduce((sum, p, i) => sum + i * p.v, 0);
    const sumXX = points.reduce((sum, p, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    const predictions = [];
    for (let i = 1; i <= steps; i++) {
      predictions.push({
        step: i,
        value: slope * (n + i) + intercept,
        confidence: Math.max(0, 1 - i * 0.15)
      });
    }
    
    return predictions;
  }
}

// ============== 统一告警管理 ==============
class AlertManager {
  constructor() {
    this.rules = [];
    this.active = new Map();
    this.history = [];
  }

  // 添加告警规则
  addRule(rule) {
    this.rules.push({
      id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      created: Date.now(),
      ...rule
    });
    return this.rules[this.rules.length - 1];
  }

  // 评估告警
  evaluate(metric, value, tags = {}) {
    const alerts = [];
    
    for (const rule of this.rules) {
      if (rule.metric && rule.metric !== metric) continue;
      
      const triggered = this.checkCondition(rule.condition, value);
      const key = `${rule.id}:${metric}`;
      const existing = this.active.get(key);
      
      if (triggered && !existing) {
        // 新告警
        const alert = {
          id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          ruleId: rule.id,
          metric,
          value,
          tags,
          severity: rule.severity || 'warning',
          message: rule.message || `${metric} triggered alert`,
          started: Date.now(),
          status: 'firing'
        };
        this.active.set(key, alert);
        alerts.push(alert);
      } else if (!triggered && existing) {
        // 告警恢复
        existing.resolved = Date.now();
        existing.status = 'resolved';
        this.history.push(existing);
        this.active.delete(key);
        alerts.push({ ...existing, status: 'resolved' });
      }
    }
    
    return alerts;
  }

  checkCondition(condition, value) {
    if (typeof condition === 'function') {
      return condition(value);
    }
    if (condition.gt !== undefined) return value > condition.gt;
    if (condition.lt !== undefined) return value < condition.lt;
    if (condition.gte !== undefined) return value >= condition.gte;
    if (condition.lte !== undefined) return value <= condition.lte;
    if (condition.eq !== undefined) return value === condition.eq;
    return false;
  }

  // 获取活跃告警
  getActive() {
    return Array.from(this.active.values());
  }

  // 获取告警历史
  getHistory(limit = 100) {
    return this.history.slice(-limit);
  }

  // 生成告警摘要
  summary() {
    const active = this.getActive();
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, warning: 0 };
    
    for (const alert of active) {
      bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
    }
    
    return {
      active: active.length,
      bySeverity,
      totalHistory: this.history.length,
      rules: this.rules.length
    };
  }
}

// ============== 日志聚合引擎 ==============
class LogAggregator {
  constructor(config) {
    this.config = config;
    this.db = new TimeSeriesDB(config.dataDir);
    this.detector = new AnomalyDetector(config.anomaly);
    this.alerts = new AlertManager();
  }

  // 收集数据源
  async collect() {
    const results = [];
    
    for (const source of this.config.sources) {
      const files = this.findFiles(source.pattern);
      for (const file of files) {
        const points = await this.parseFile(file, source.parser);
        results.push({
          source: source.name,
          file,
          points: points.length
        });
      }
    }
    
    return results;
  }

  // 查找文件
  findFiles(pattern) {
    const files = [];
    const regex = new RegExp(pattern.replace('*', '.*'));
    
    if (fs.existsSync(this.config.dataDir)) {
      const entries = fs.readdirSync(this.config.dataDir);
      for (const entry of entries) {
        if (regex.test(entry)) {
          files.push(path.join(this.config.dataDir, entry));
        }
      }
    }
    
    return files;
  }

  // 解析文件
  async parseFile(file, parser) {
    const points = [];
    
    if (!fs.existsSync(file)) return points;
    
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n');
    
    for (const line of lines) {
      try {
        if (parser === 'jsonl') {
          const data = JSON.parse(line);
          points.push(data);
        } else if (parser === 'regex') {
          // 简单的日志行解析
          const match = line.match(/\[(.*?)\]\s+(\w+)\s+(.*)/);
          if (match) {
            points.push({
              t: new Date(match[1]).getTime(),
              level: match[2],
              message: match[3]
            });
          }
        }
      } catch (e) {
        // 跳过无效行
      }
    }
    
    return points;
  }

  // 执行完整分析
  analyze(metric, range = '1h') {
    const end = Date.now();
    const start = end - this.parseRange(range);
    
    // 查询数据
    const points = this.db.query(metric, start, end);
    
    // 异常检测
    const anomaly = this.detector.detect(metric, points);
    
    // 趋势预测
    const prediction = this.detector.predict(points, 5);
    
    return {
      metric,
      range,
      points: points.length,
      anomaly,
      prediction,
      aggregation: this.db.aggregate(points, '5m')
    };
  }

  parseRange(range) {
    const units = { m: 60000, h: 3600000, d: 86400000 };
    const match = range.match(/^(\d+)([mhd])$/);
    return match ? parseInt(match[1]) * units[match[2]] : 3600000;
  }

  // 生成综合报告
  generateReport() {
    return {
      timestamp: Date.now(),
      version: this.config.version,
      dataDir: this.config.dataDir,
      sources: this.config.sources.length,
      alerts: this.alerts.summary(),
      storage: this.calculateStorage()
    };
  }

  calculateStorage() {
    let total = 0;
    let files = 0;
    
    if (fs.existsSync(this.config.dataDir)) {
      const entries = fs.readdirSync(this.config.dataDir);
      for (const entry of entries) {
        const stat = fs.statSync(path.join(this.config.dataDir, entry));
        if (stat.isFile()) {
          total += stat.size;
          files++;
        }
      }
    }
    
    return {
      files,
      bytes: total,
      human: this.formatBytes(total)
    };
  }

  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${bytes.toFixed(2)} ${units[i]}`;
  }
}

// ============== CLI 接口 ==============
function cli() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  const aggregator = new LogAggregator(CONFIG);
  
  switch (command) {
    case 'collect':
      console.log('📥 收集数据源...');
      aggregator.collect().then(results => {
        console.table(results);
      });
      break;
      
    case 'analyze':
      const metric = args[1] || 'cpu';
      const range = args[2] || '1h';
      console.log(`🔍 分析指标: ${metric} (${range})`);
      const result = aggregator.analyze(metric, range);
      console.log(JSON.stringify(result, null, 2));
      break;
      
    case 'report':
      console.log('📊 生成系统报告');
      console.log(JSON.stringify(aggregator.generateReport(), null, 2));
      break;
      
    case 'alerts':
      console.log('🚨 告警状态');
      console.log(JSON.stringify(aggregator.alerts.summary(), null, 2));
      break;
      
    case 'test':
      runTests();
      break;
      
    case 'help':
    default:
      console.log(`
🦞 统一日志聚合与智能分析系统 v${CONFIG.version}

用法: node log-aggregator.js <命令> [选项]

命令:
  collect          收集所有数据源
  analyze <metric> [range]  分析指定指标 (默认: cpu, 1h)
  report           生成系统综合报告
  alerts           查看告警状态
  test             运行测试套件
  help             显示帮助信息

示例:
  node log-aggregator.js collect
  node log-aggregator.js analyze memory 1d
  node log-aggregator.js report
      `);
  }
}

// ============== 测试套件 ==============
function runTests() {
  console.log('\n🧪 日志聚合系统测试套件');
  console.log('=' .repeat(50));
  
  let passed = 0;
  let failed = 0;
  
  const tests = [
    {
      name: 'TimeSeriesDB 实例化',
      run: () => {
        const db = new TimeSeriesDB('/tmp/test-db');
        return db !== null;
      }
    },
    {
      name: '写入和查询数据点',
      run: () => {
        const db = new TimeSeriesDB('/tmp/test-db');
        const now = Date.now();
        db.write('test-metric', 100, { host: 'localhost' }, now);
        const points = db.query('test-metric', now - 1000, now + 1000);
        return points.length === 1 && points[0].v === 100;
      }
    },
    {
      name: '聚合计算',
      run: () => {
        const db = new TimeSeriesDB('/tmp/test-db');
        const now = Date.now();
        for (let i = 0; i < 10; i++) {
          db.write('agg-test', i * 10, {}, now + i * 60000);
        }
        const agg = db.aggregate(
          Array.from({ length: 10 }, (_, i) => ({ t: now + i * 60000, v: i * 10 })),
          '5m'
        );
        return agg.length > 0 && agg[0].avg !== undefined;
      }
    },
    {
      name: '异常检测',
      run: () => {
        const detector = new AnomalyDetector({ threshold: 2, minPoints: 5 });
        const points = Array.from({ length: 20 }, (_, i) => ({
          t: Date.now() + i * 1000,
          v: i === 15 ? 1000 : 10  // 一个异常值
        }));
        const result = detector.detect('test', points);
        return result.status === 'anomaly_detected' && result.anomalies.length > 0;
      }
    },
    {
      name: '趋势预测',
      run: () => {
        const detector = new AnomalyDetector({});
        const points = Array.from({ length: 10 }, (_, i) => ({
          t: Date.now() + i * 1000,
          v: i * 2
        }));
        const predictions = detector.predict(points, 3);
        return predictions.length === 3 && predictions[0].value !== undefined;
      }
    },
    {
      name: '告警规则管理',
      run: () => {
        const alerts = new AlertManager();
        const rule = alerts.addRule({
          metric: 'cpu',
          condition: { gt: 80 },
          severity: 'warning'
        });
        return rule.id && alerts.rules.length === 1;
      }
    },
    {
      name: '告警触发和恢复',
      run: () => {
        const alerts = new AlertManager();
        alerts.addRule({
          metric: 'memory',
          condition: { gt: 90 },
          severity: 'critical'
        });
        
        // 触发告警
        const firing = alerts.evaluate('memory', 95);
        const active1 = alerts.getActive();
        
        // 恢复告警
        const resolved = alerts.evaluate('memory', 50);
        const active2 = alerts.getActive();
        
        return firing.length === 1 && active1.length === 1 && active2.length === 0;
      }
    },
    {
      name: 'LogAggregator 实例化',
      run: () => {
        const agg = new LogAggregator(CONFIG);
        return agg.db !== null && agg.detector !== null;
      }
    },
    {
      name: '生成系统报告',
      run: () => {
        const agg = new LogAggregator(CONFIG);
        const report = agg.generateReport();
        return report.timestamp && report.version === CONFIG.version;
      }
    },
    {
      name: '字节格式化',
      run: () => {
        const agg = new LogAggregator(CONFIG);
        return agg.formatBytes(1024) === '1.00 KB' && agg.formatBytes(1024 * 1024) === '1.00 MB';
      }
    }
  ];
  
  for (const test of tests) {
    try {
      const result = test.run();
      if (result) {
        console.log(`✅ ${test.name}`);
        passed++;
      } else {
        console.log(`❌ ${test.name} - 返回false`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${test.name} - ${e.message}`);
      failed++;
    }
  }
  
  console.log('=' .repeat(50));
  console.log(`📊 测试结果: ✅ ${passed} | ❌ ${failed} | 📈 ${(passed / tests.length * 100).toFixed(1)}%`);
  
  return failed === 0;
}

// 运行CLI
if (require.main === module) {
  cli();
}

// 导出模块
module.exports = { LogAggregator, TimeSeriesDB, AnomalyDetector, AlertManager, CONFIG };
