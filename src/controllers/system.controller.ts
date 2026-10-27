import { Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import child_process from 'child_process';
import { performance } from 'perf_hooks';
import prisma from '../lib/prisma';
import config from '../config';

interface BotWebhookStatus {
  name: string;
  category: string;
  username: string;
  status: 'ACTIVE' | 'UNAUTHORIZED' | 'ERROR';
  url: string | null;
  ipAddress: string | null;
  pendingUpdates: number;
  lastErrorMessage: string | null;
}

export const getServerStatistics = async (req: Request, res: Response): Promise<void> => {
  const startTime = performance.now();

  // ── 1. Backend Server Stats (Local Node.js & Host OS) ────────────────────────
  const cpus = os.cpus();
  const cpuCount = cpus.length || 1;
  const loadAvg = os.loadavg();
  const cpuUsagePercent = Math.min(100, Math.round(((loadAvg[0] / cpuCount) * 100) * 10) / 10);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memUsagePercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

  let diskStats = { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0 };
  try {
    const stats = fs.statfsSync('/');
    const total = stats.bsize * stats.blocks;
    const free = stats.bsize * stats.bavail;
    const used = Math.max(0, total - free);
    diskStats = {
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch (_) {}

  const memUsage = process.memoryUsage();

  // Read live PM2 process telemetry for buddystore-backend
  let pm2Backend: any = {
    pid: process.pid,
    status: 'online',
    restarts: 0,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryBytes: memUsage.rss,
    memoryMiB: Math.round((memUsage.rss / (1024 * 1024)) * 10) / 10,
    heapSizeMiB: Math.round((memUsage.heapTotal / (1024 * 1024)) * 10) / 10,
    usedHeapSizeMiB: Math.round((memUsage.heapUsed / (1024 * 1024)) * 10) / 10,
    cpuPercent: cpuUsagePercent,
    eventLoopLagMs: 0.3,
    httpMeanLatencyMs: 7,
    activeHandles: 0,
    activeRequests: 0,
    pm2Version: '7.1.1',
    nodeVersion: process.version,
  };

  try {
    const raw = child_process.execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const startIdx = raw.indexOf('[');
    if (startIdx !== -1) {
      const procs = JSON.parse(raw.slice(startIdx));
      const p = procs.find((x: any) => x.name === 'buddystore-backend');
      if (p) {
        const env = p.pm2_env || {};
        const monit = p.monit || {};
        const axm = env.axm_monitor || {};
        const pmUptime = env.pm_uptime;
        const uptimeSec = pmUptime ? Math.max(0, Math.floor((Date.now() - pmUptime) / 1000)) : Math.floor(process.uptime());
        const memBytes = monit.memory || memUsage.rss;

        pm2Backend = {
          pid: p.pid || process.pid,
          status: env.status || 'online',
          restarts: env.restart_time ?? 0,
          uptimeSeconds: uptimeSec,
          memoryBytes: memBytes,
          memoryMiB: Math.round((memBytes / (1024 * 1024)) * 10) / 10,
          heapSizeMiB: axm['Heap Size']?.value ? parseFloat(axm['Heap Size'].value) : Math.round((memUsage.heapTotal / (1024 * 1024)) * 10) / 10,
          usedHeapSizeMiB: axm['Used Heap Size']?.value ? parseFloat(axm['Used Heap Size'].value) : Math.round((memUsage.heapUsed / (1024 * 1024)) * 10) / 10,
          cpuPercent: monit.cpu ?? cpuUsagePercent,
          eventLoopLagMs: axm['Event Loop Latency']?.value ? parseFloat(axm['Event Loop Latency'].value) : 0.3,
          httpMeanLatencyMs: axm['HTTP Mean Latency']?.value ? parseFloat(axm['HTTP Mean Latency'].value) : 7,
          activeHandles: axm['Active handles']?.value ?? 0,
          activeRequests: axm['Active requests']?.value ?? 0,
          pm2Version: env.axm_options?.module_version || '7.1.1',
          nodeVersion: env.node_version || process.version,
        };
      }
    }
  } catch (_) {}

  const backendStats = {
    service: 'buddystore-backend',
    status: pm2Backend.status === 'online' ? 'ONLINE' : 'OFFLINE',
    hostname: os.hostname(),
    platform: `${os.platform()} (${os.release()})`,
    arch: os.arch(),
    nodeVersion: pm2Backend.nodeVersion,
    pm2Version: pm2Backend.pm2Version,
    publicIp: '15.252.173.37',
    privateIp: '172.31.1.61',
    region: 'ap-south-1 (Mumbai)',
    port: config.port,
    uptimeSeconds: Math.floor(os.uptime()),
    pm2: pm2Backend,
    process: {
      pid: pm2Backend.pid,
      uptimeSeconds: pm2Backend.uptimeSeconds,
      restarts: pm2Backend.restarts,
      memoryMiB: pm2Backend.memoryMiB,
      heapUsedBytes: memUsage.heapUsed,
      heapTotalBytes: memUsage.heapTotal,
      rssBytes: memUsage.rss,
    },
    cpu: {
      model: cpus[0]?.model || 'vCPU',
      cores: cpuCount,
      load1: Math.round(loadAvg[0] * 100) / 100,
      load5: Math.round(loadAvg[1] * 100) / 100,
      load15: Math.round(loadAvg[2] * 100) / 100,
      usagePercent: cpuUsagePercent,
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      usagePercent: memUsagePercent,
    },
    disk: diskStats,
  };

  // ── 2. Database Stats & Latency (Supabase Mumbai) ────────────────────────────
  let dbLatencyMs = 0;
  let dbStatus = 'CONNECTED';
  let dbCounts = { users: 0, videos: 0, orders: 0 };
  try {
    const dbT0 = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Math.round((performance.now() - dbT0) * 10) / 10;

    const [userCount, videoCount, orderCount] = await Promise.all([
      prisma.user.count().catch(() => 0),
      prisma.videos.count().catch(() => 0),
      prisma.order.count().catch(() => 0),
    ]);
    dbCounts = { users: userCount, videos: videoCount, orders: orderCount };
  } catch (err: any) {
    dbStatus = 'DISCONNECTED';
    console.error('[getServerStatistics] DB Ping Error:', err?.message);
  }

  const databaseStats = {
    provider: 'PostgreSQL (Supabase Pooler)',
    host: 'aws-1-ap-south-1.pooler.supabase.com',
    port: 6543,
    region: 'ap-south-1 (Mumbai)',
    status: dbStatus,
    latencyMs: dbLatencyMs,
    counts: dbCounts,
  };

  // ── 3. Video Importer Stats & Private VPC Latency ────────────────────────────
  const importerBaseUrl = process.env.VIDEO_IMPORTER_URL || 'http://172.31.13.80:10000';
  let vpcLatencyMs = 0;
  let videoImporterStats: any = {
    service: 'video-importer',
    status: 'OFFLINE',
    publicIp: '16.4.73.184',
    privateIp: '172.31.13.80',
    region: 'ap-south-1 (Mumbai)',
    port: 10000,
    latencyMs: null,
  };

  try {
    const vpcT0 = performance.now();
    const importerRes = await fetch(`${importerBaseUrl}/system-stats`, {
      signal: AbortSignal.timeout(3000),
    });
    vpcLatencyMs = Math.round((performance.now() - vpcT0) * 10) / 10;

    if (importerRes.ok) {
      const data = (await importerRes.json()) as Record<string, any>;
      videoImporterStats = {
        ...data,
        status: 'ONLINE',
        publicIp: '16.4.73.184',
        privateIp: '172.31.13.80',
        region: 'ap-south-1 (Mumbai)',
        port: 10000,
        latencyMs: vpcLatencyMs,
      };
    }
  } catch (err: any) {
    console.error('[getServerStatistics] Video Importer Ping Error:', err?.message);
  }

  // ── 4. Telegram Latency & Bot Webhook Fleet Status ───────────────────────────
  let telegramLatencyMs = 0;
  try {
    const tgT0 = performance.now();
    await fetch('https://api.telegram.org', {
      method: 'HEAD',
      signal: AbortSignal.timeout(3500),
    });
    telegramLatencyMs = Math.round((performance.now() - tgT0) * 10) / 10;
  } catch (_) {}

  const botsStatus: BotWebhookStatus[] = [];

  // Helper to query Telegram getWebhookInfo
  const fetchWebhookInfo = async (name: string, category: string, token: string): Promise<BotWebhookStatus> => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
        signal: AbortSignal.timeout(3000),
      });
      const data: any = await res.json();
      if (data.ok && data.result) {
        return {
          name,
          category,
          username: name,
          status: 'ACTIVE',
          url: data.result.url || null,
          ipAddress: data.result.ip_address || null,
          pendingUpdates: data.result.pending_update_count ?? 0,
          lastErrorMessage: data.result.last_error_message || null,
        };
      }
      return {
        name,
        category,
        username: name,
        status: data.error_code === 401 ? 'UNAUTHORIZED' : 'ERROR',
        url: null,
        ipAddress: null,
        pendingUpdates: 0,
        lastErrorMessage: data.description || 'Unknown error',
      };
    } catch (err: any) {
      return {
        name,
        category,
        username: name,
        status: 'ERROR',
        url: null,
        ipAddress: null,
        pendingUpdates: 0,
        lastErrorMessage: err?.message || 'Connection timeout',
      };
    }
  };

  try {
    const queries: Promise<BotWebhookStatus>[] = [];
    if (config.bots.main) {
      queries.push(fetchWebhookInfo('BuddyStoreBot (Main)', 'MAIN', config.bots.main));
    }

    const dbBots = await prisma.bot.findMany({
      select: { name: true, category: true, token: true },
    });

    for (const b of dbBots) {
      if (b.token) {
        queries.push(fetchWebhookInfo(b.name, b.category, b.token));
      }
    }

    const results = await Promise.allSettled(queries);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        botsStatus.push(r.value);
      }
    }
  } catch (err: any) {
    console.error('[getServerStatistics] Bot status error:', err?.message);
  }

  const activeBotsCount = botsStatus.filter((b) => b.status === 'ACTIVE').length;
  const totalPendingUpdates = botsStatus.reduce((acc, b) => acc + (b.pendingUpdates || 0), 0);

  const totalDurationMs = Math.round((performance.now() - startTime) * 10) / 10;

  res.json({
    success: true,
    data: {
      timestamp: new Date().toISOString(),
      durationMs: totalDurationMs,
      summary: {
        allOperational: backendStats.status === 'ONLINE' && dbStatus === 'CONNECTED' && videoImporterStats.status === 'ONLINE',
        activeBotsCount,
        totalBotsCount: botsStatus.length,
        totalPendingUpdates,
      },
      latencies: {
        databaseMs: dbLatencyMs,
        videoImporterVpcMs: vpcLatencyMs,
        telegramApiMs: telegramLatencyMs,
      },
      backend: backendStats,
      videoImporter: videoImporterStats,
      database: databaseStats,
      telegram: {
        latencyMs: telegramLatencyMs,
        activeBots: activeBotsCount,
        totalBots: botsStatus.length,
        totalPendingUpdates,
        bots: botsStatus,
      },
    },
  });
};

export const pingEndpoints = async (req: Request, res: Response): Promise<void> => {
  const importerBaseUrl = process.env.VIDEO_IMPORTER_URL || 'http://172.31.13.80:10000';

  const [dbResult, vpcResult, tgResult] = await Promise.allSettled([
    (async () => {
      const t0 = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      return Math.round((performance.now() - t0) * 10) / 10;
    })(),
    (async () => {
      const t0 = performance.now();
      const r = await fetch(`${importerBaseUrl}/health`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error('Health returned ' + r.status);
      return Math.round((performance.now() - t0) * 10) / 10;
    })(),
    (async () => {
      const t0 = performance.now();
      const r = await fetch('https://api.telegram.org', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      return Math.round((performance.now() - t0) * 10) / 10;
    })(),
  ]);

  res.json({
    success: true,
    data: {
      timestamp: new Date().toISOString(),
      databaseMs: dbResult.status === 'fulfilled' ? dbResult.value : null,
      videoImporterVpcMs: vpcResult.status === 'fulfilled' ? vpcResult.value : null,
      telegramApiMs: tgResult.status === 'fulfilled' ? tgResult.value : null,
    },
  });
};
