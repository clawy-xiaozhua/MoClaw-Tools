/**
 * Unified Task Scheduler - 统一任务调度器
 * 
 * 功能：
 * - 定时执行各种监控任务
 * - 任务依赖管理
 * - 任务结果汇总
 * - 失败重试机制
 * - 任务历史记录
 * 
 * @author Clawy-OC
 * @date 2026-02-20
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class UnifiedTaskScheduler {
  constructor(options = {}) {
    this.name = options.name || 'UnifiedTaskScheduler';
    this.tasks = new Map();
    this.taskHistory = [];
    this.runningTasks = new Set();
    this.resultsDir = options.resultsDir || './task-results';
    this.maxHistory = options.maxHistory || 1000;
    this.defaultRetry = options.defaultRetry || 3;
    this.defaultRetryDelay = options.defaultRetryDelay || 5000;
    
    // 确保结果目录存在
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
    
    // 调度器状态
    this.isRunning = false;
    this.intervalId = null;
    this.intervalMs = options.intervalMs || 60000; // 默认1分钟
    
    // 任务统计
    this.stats = {
      totalRuns: 0,
      successRuns: 0,
      failedRuns: 0,
      lastRun: null
    };
  }
  
  /**
   * 注册任务
   */
  registerTask(taskDef) {
    const task = {
      id: taskDef.id,
      name: taskDef.name || taskDef.id,
      type: taskDef.type || 'exec', // exec, script, http, function
      schedule: taskDef.schedule || 'interval', // interval, cron, once
      scheduleValue: taskDef.scheduleValue || 60000,
      enabled: taskDef.enabled !== false,
      priority: taskDef.priority || 5, // 1-10, 10 highest
      dependencies: taskDef.dependencies || [],
      retry: taskDef.retry ?? this.defaultRetry,
      retryDelay: taskDef.retryDelay || this.defaultRetryDelay,
      timeout: taskDef.timeout || 30000,
      handler: taskDef.handler,
      command: taskDef.command,
      script: taskDef.script,
      url: taskDef.url,
      options: taskDef.options || {},
      lastRun: null,
      lastResult: null,
      lastError: null,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      avgDuration: 0,
      totalDuration: 0
    };
    
    this.tasks.set(task.id, task);
    console.log(`✅ 任务已注册: ${task.id} (${task.name})`);
    return task;
  }
  
  /**
   * 移除任务
   */
  unregisterTask(taskId) {
    if (this.tasks.has(taskId)) {
      this.tasks.delete(taskId);
      console.log(`🗑️ 任务已移除: ${taskId}`);
      return true;
    }
    return false;
  }
  
  /**
   * 启用/禁用任务
   */
  setTaskEnabled(taskId, enabled) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.enabled = enabled;
      console.log(`📌 任务 ${taskId} 已${enabled ? '启用' : '禁用'}`);
      return true;
    }
    return false;
  }
  
  /**
   * 检查任务依赖
   */
  async checkDependencies(task) {
    if (task.dependencies.length === 0) return true;
    
    for (const depId of task.dependencies) {
      const depTask = this.tasks.get(depId);
      if (!depTask) {
        console.warn(`⚠️ 依赖任务不存在: ${depId}`);
        continue;
      }
      
      // 检查依赖任务是否在最近成功运行过
      if (!depTask.lastResult || depTask.lastResult.status !== 'success') {
        console.warn(`⚠️ 依赖任务未成功: ${depId}`);
        return false;
      }
    }
    return true;
  }
  
  /**
   * 执行单个任务
   */
  async executeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    
    if (this.runningTasks.has(taskId)) {
      console.log(`⏳ 任务正在运行: ${taskId}`);
      return null;
    }
    
    // 检查依赖
    const depsOk = await this.checkDependencies(task);
    if (!depsOk) {
      const result = {
        taskId,
        status: 'skipped',
        reason: 'dependencies_not_met',
        timestamp: new Date().toISOString()
      };
      return result;
    }
    
    this.runningTasks.add(taskId);
    const startTime = Date.now();
    
    console.log(`🔄 开始执行任务: ${task.name} (${taskId})`);
    
    let result = {
      taskId,
      taskName: task.name,
      status: 'running',
      startTime: new Date(startTime).toISOString(),
      timestamp: new Date().toISOString()
    };
    
    try {
      // 执行任务
      let output;
      switch (task.type) {
        case 'exec':
          output = this.executeExec(task);
          break;
        case 'script':
          output = await this.executeScript(task);
          break;
        case 'http':
          output = await this.executeHttp(task);
          break;
        case 'function':
          output = await task.handler(task.options);
          break;
        default:
          throw new Error(`未知任务类型: ${task.type}`);
      }
      
      const duration = Date.now() - startTime;
      
      result = {
        ...result,
        status: 'success',
        output,
        duration,
        endTime: new Date().toISOString()
      };
      
      // 更新任务统计
      task.runCount++;
      task.successCount++;
      task.totalDuration += duration;
      task.avgDuration = task.totalDuration / task.runCount;
      task.lastRun = result.timestamp;
      task.lastResult = result;
      task.lastError = null;
      
      this.stats.successRuns++;
      console.log(`✅ 任务完成: ${task.name} (${duration}ms)`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // 重试逻辑
      if (task.retry > 0) {
        console.log(`🔄 任务失败，剩余重试次数: ${task.retry}`);
        await this.sleep(task.retryDelay);
        task.retry--;
        
        this.runningTasks.delete(taskId);
        return this.executeTask(taskId);
      }
      
      result = {
        ...result,
        status: 'failed',
        error: error.message,
        duration,
        endTime: new Date().toISOString()
      };
      
      task.runCount++;
      task.failureCount++;
      task.lastRun = result.timestamp;
      task.lastResult = result;
      task.lastError = error.message;
      
      this.stats.failedRuns++;
      console.error(`❌ 任务失败: ${task.name} - ${error.message}`);
    }
    
    this.runningTasks.delete(taskId);
    this.stats.totalRuns++;
    this.stats.lastRun = result.timestamp;
    
    // 保存结果到文件
    this.saveTaskResult(taskId, result);
    
    // 添加到历史记录
    this.taskHistory.push(result);
    if (this.taskHistory.length > this.maxHistory) {
      this.taskHistory.shift();
    }
    
    return result;
  }
  
  /**
   * 执行命令行任务
   */
  executeExec(task) {
    const cmd = task.command;
    const options = {
      encoding: 'utf8',
      timeout: task.timeout,
      ...task.options
    };
    
    try {
      const output = execSync(cmd, options);
      return output.toString().trim();
    } catch (error) {
      // 命令执行失败不一定意味着任务失败
      if (task.options.ignoreError) {
        return error.message;
      }
      throw error;
    }
  }
  
  /**
   * 执行脚本任务
   */
  async executeScript(task) {
    // 动态加载并执行脚本
    const scriptPath = path.resolve(task.script);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`脚本文件不存在: ${scriptPath}`);
    }
    
    delete require.cache[require.resolve(scriptPath)];
    const script = require(scriptPath);
    
    if (typeof script === 'function') {
      return await script(task.options);
    } else if (typeof script.default === 'function') {
      return await script.default(task.options);
    } else {
      throw new Error('脚本必须导出函数');
    }
  }
  
  /**
   * 执行HTTP任务
   */
  async executeHttp(task) {
    const response = await fetch(task.url, {
      method: task.options.method || 'GET',
      headers: task.options.headers || {},
      ...task.options
    });
    
    if (!response.ok && !task.options.ignoreError) {
      throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  }
  
  /**
   * 等待指定毫秒
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 执行所有任务
   */
  async executeAll(parallel = true) {
    const results = [];
    const enabledTasks = Array.from(this.tasks.values())
      .filter(t => t.enabled)
      .sort((a, b) => b.priority - a.priority);
    
    if (parallel) {
      // 并行执行
      const promises = enabledTasks.map(task => 
        this.executeTask(task.id).catch(err => ({
          taskId: task.id,
          status: 'error',
          error: err.message
        }))
      );
      results.push(...await Promise.all(promises));
    } else {
      // 串行执行
      for (const task of enabledTasks) {
        const result = await this.executeTask(task.id);
        results.push(result);
      }
    }
    
    return results;
  }
  
  /**
   * 保存任务结果
   */
  saveTaskResult(taskId, result) {
    const filename = `${this.resultsDir}/${taskId}-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  }
  
  /**
   * 获取任务状态
   */
  getTaskStatus(taskId) {
    return this.tasks.get(taskId);
  }
  
  /**
   * 获取所有任务状态
   */
  getAllTaskStatus() {
    return Array.from(this.tasks.values()).map(task => ({
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      priority: task.priority,
      status: this.runningTasks.has(task.id) ? 'running' : 
              (task.lastResult?.status || 'idle'),
      lastRun: task.lastRun,
      lastDuration: task.lastResult?.duration,
      avgDuration: task.avgDuration,
      runCount: task.runCount,
      successCount: task.successCount,
      failureCount: task.failureCount,
      successRate: task.runCount > 0 
        ? ((task.successCount / task.runCount) * 100).toFixed(1) + '%' 
        : 'N/A'
    }));
  }
  
  /**
   * 获取调度器统计
   */
  getStats() {
    return {
      ...this.stats,
      taskCount: this.tasks.size,
      runningTasks: this.runningTasks.size,
      enabledTaskCount: Array.from(this.tasks.values()).filter(t => t.enabled).length
    };
  }
  
  /**
   * 启动调度器
   */
  start(intervalMs) {
    if (this.isRunning) {
      console.log('⚠️ 调度器已在运行中');
      return;
    }
    
    this.intervalMs = intervalMs || this.intervalMs;
    this.isRunning = true;
    
    console.log(`🚀 调度器启动，间隔: ${this.intervalMs}ms`);
    
    // 立即执行一次
    this.executeAll(true);
    
    // 设置定时执行
    this.intervalId = setInterval(() => {
      this.executeAll(true);
    }, this.intervalMs);
  }
  
  /**
   * 停止调度器
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️ 调度器未在运行');
      return;
    }
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    this.isRunning = false;
    console.log('🛑 调度器已停止');
  }
  
  /**
   * 生成ASCII状态仪表板
   */
  generateDashboard() {
    const tasks = this.getAllTaskStatus();
    const stats = this.getStats();
    
    let output = `
╔════════════════════════════════════════════════════════════════════╗
║          🤖 Unified Task Scheduler - 任务调度仪表板                ║
╠════════════════════════════════════════════════════════════════════╣
║  📊 调度器状态: ${this.isRunning ? '🟢 运行中' : '🔴 已停止'}                                        ║
║  ⏱️ 执行间隔: ${(this.intervalMs / 1000).toFixed(0)}秒                                              ║
╠════════════════════════════════════════════════════════════════════╣
║  📈 统计信息                                                         ║
║     总执行: ${stats.totalRuns} | 成功: ${stats.successRuns} | 失败: ${stats.failedRuns}              ║
║     任务数: ${stats.taskCount} | 启用: ${stats.enabledTaskCount} | 运行中: ${stats.runningTasks}        ║
╠════════════════════════════════════════════════════════════════════╣
║  📋 任务列表                                                         ║`;
    
    if (tasks.length === 0) {
      output += '\n║     (暂无任务)                                                  ║';
    } else {
      for (const task of tasks) {
        const statusIcon = task.status === 'running' ? '⏳' :
                          task.status === 'success' ? '✅' :
                          task.status === 'failed' ? '❌' : '⏸️';
        const enabledIcon = task.enabled ? '✅' : '⛔';
        
        output += `\n║     ${enabledIcon} ${task.id.padEnd(20)} ${statusIcon} ${(task.successRate || 'N/A').padEnd(6)} 平均${(task.avgDuration || 0).toString().padStart(5)}ms   ║`;
      }
    }
    
    output += `
╚════════════════════════════════════════════════════════════════════╝`;
    
    return output;
  }
  
  /**
   * 生成JSON格式状态
   */
  toJSON() {
    return {
      scheduler: {
        name: this.name,
        isRunning: this.isRunning,
        intervalMs: this.intervalMs
      },
      stats: this.getStats(),
      tasks: this.getAllTaskStatus(),
      history: this.taskHistory.slice(-10)
    };
  }
}

// 导出模块
module.exports = { UnifiedTaskScheduler };

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  
  // 创建调度器实例
  const scheduler = new UnifiedTaskScheduler({
    name: 'MainScheduler',
    resultsDir: './task-results'
  });
  
  // 注册示例任务
  scheduler.registerTask({
    id: 'health-check',
    name: '系统健康检查',
    type: 'exec',
    command: 'node system-health-dashboard.js json 2>/dev/null',
    priority: 10,
    enabled: true,
    retry: 2
  });
  
  scheduler.registerTask({
    id: 'memory-check',
    name: '内存使用检查',
    type: 'exec',
    command: 'free -m | head -2',
    priority: 8,
    enabled: true
  });
  
  scheduler.registerTask({
    id: 'disk-check',
    name: '磁盘使用检查',
    type: 'exec',
    command: 'df -h / | tail -1',
    priority: 7,
    enabled: true
  });
  
  scheduler.registerTask({
    id: 'load-check',
    name: '系统负载检查',
    type: 'exec',
    command: 'uptime',
    priority: 6,
    enabled: true
  });
  
  // 执行命令
  switch (command) {
    case 'run':
      scheduler.executeAll(true).then(results => {
        console.log(`\n📊 执行完成，共 ${results.length} 个任务`);
        console.log(scheduler.generateDashboard());
      });
      break;
      
    case 'status':
    default:
      console.log(scheduler.generateDashboard());
      break;
      
    case 'json':
      console.log(JSON.stringify(scheduler.toJSON(), null, 2));
      break;
      
    case 'start':
      scheduler.start(60000);
      break;
      
    case 'stop':
      scheduler.stop();
      break;
  }
}
