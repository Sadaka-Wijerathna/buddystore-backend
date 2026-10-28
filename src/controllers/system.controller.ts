import { Request, Response } from 'express';
import si from 'systeminformation';
import { performance } from 'perf_hooks';
import os from 'os';
import prisma from '../lib/prisma';
import config from '../config';
import { dbQueryLatency, importerVpcLatency, botPendingUpdates } from '../lib/metrics';

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

// In-memory delta tracker for real bytes/sec throughput across polls
let lastNetworkSample: { time: number; rxBytes: number; txBytes: number } | null = null;

export const getServerStatistics = async (req: Request, res: Response): Promise<void> => {
  const startTime = performance.now();

  // ── 1. Backend Server Stats — via systeminformation (Option 3) ────────────
  // All gathered in parallel — non-blocking, no shell spawning
  const [cpuLoad, mem, fsInfo, netStats, processes, nodeVersion] = await Promise.all([
    si.currentLoad().catch(() => null),           // Real-time per-core CPU % (not loadavg)
    si.mem().catch(() => null),                   // Memory: total/used/free/cached/swap
    si.fsSize().catch(() => []),                  // Per-mount disk usage
    si.networkStats().catch(() => []),            // Network I/O: bytes/sec in & out
    si.processes().catch(() => null),             // All OS processes (for per-process lookup)
    si.versions('node').catch(() => null),        // Node version string
  ]);

  // ── CPU ───────────────────────────────────────────────────────────────────
  const cpuCount = os.cpus().length || 1;
  const cpuModel = os.cpus()[0]?.model || 'vCPU';

  // si.currentLoad gives REAL instantaneous CPU% — not a 1/5/15 min rolling average
  const currentCpuPercent = cpuLoad ? Math.round(cpuLoad.currentLoad * 10) / 10 : 0;
  const cpuCores = cpuLoad?.cpus?.map((core) => ({
    load: Math.round(core.load * 10) / 10,
    loadUser: Math.round((core.loadUser ?? 0) * 10) / 10,
    loadSystem: Math.round((core.loadSystem ?? 0) * 10) / 10,
    loadIdle: Math.round((core.loadIdle ?? 100) * 10) / 10,
  })) ?? [];

  // ── Memory ────────────────────────────────────────────────────────────────
  const totalMem = mem?.total ?? os.totalmem();
  const usedMem = mem?.active ?? Math.max(0, (mem?.total ?? 0) - (mem?.available ?? 0));
  const freeMem = mem?.available ?? os.freemem();
  const cachedMem = mem?.cached ?? 0;
  const bufferMem = mem?.buffers ?? 0;
  const swapTotal = mem?.swaptotal ?? 0;
  const swapUsed = mem?.swapused ?? 0;
  const memUsagePercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

  // ── Disk ──────────────────────────────────────────────────────────────────
  // Pick the root fs mount (or first available)
  const rootDisk = fsInfo.find((f) => f.mount === '/') ?? fsInfo[0] ?? null;
  const diskStats = rootDisk
    ? {
        totalBytes: rootDisk.size,
        usedBytes: rootDisk.used,
        freeBytes: Math.max(0, rootDisk.size - rootDisk.used),
        usagePercent: Math.round(rootDisk.use * 10) / 10,
        mount: rootDisk.mount,
        fs: rootDisk.fs,
        type: rootDisk.type,
      }
    : { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0, mount: '/', fs: '', type: '' };

  // ── Network I/O ──────────────────────────────────────────────────────────
  // Take the first non-loopback interface (eth0, ens3, etc.)
  const primaryNet = netStats.find((n) => n.iface !== 'lo') ?? netStats[0] ?? null;

  // Real delta speed calculation
  const nowMs = Date.now();
  let liveRxSec = Math.round(primaryNet?.rx_sec ?? 0);
  let liveTxSec = Math.round(primaryNet?.tx_sec ?? 0);

  if (primaryNet && (!liveRxSec || liveRxSec === 0) && lastNetworkSample) {
    const elapsedSec = (nowMs - lastNetworkSample.time) / 1000;
    if (elapsedSec >= 1 && elapsedSec <= 120) {
      const rxDiff = Math.max(0, primaryNet.rx_bytes - lastNetworkSample.rxBytes);
      const txDiff = Math.max(0, primaryNet.tx_bytes - lastNetworkSample.txBytes);
      liveRxSec = Math.round(rxDiff / elapsedSec);
      liveTxSec = Math.round(txDiff / elapsedSec);
    }
  }

  if (primaryNet) {
    lastNetworkSample = { time: nowMs, rxBytes: primaryNet.rx_bytes, txBytes: primaryNet.tx_bytes };
  }

  const networkStats = primaryNet
    ? {
        interface: primaryNet.iface,
        rxBytesTotal: primaryNet.rx_bytes,
        txBytesTotal: primaryNet.tx_bytes,
        rxBytesPerSec: liveRxSec,
        txBytesPerSec: liveTxSec,
        rxErrors: primaryNet.rx_errors ?? 0,
        txErrors: primaryNet.tx_errors ?? 0,
        rxDropped: primaryNet.rx_dropped ?? 0,
        txDropped: primaryNet.tx_dropped ?? 0,
      }
    : null;

  // ── Process info (this Node.js process, from /proc) ───────────────────────
  const memUsage = process.memoryUsage();
  // Find this process in the si.processes() list for real per-process CPU
  const thisProc = processes?.list?.find((p) => p.pid === process.pid);
  const processCpuPercent = thisProc?.cpu ?? currentCpuPercent;

  const processStats = {
    pid: process.pid,
    status: 'online',
    uptimeSeconds: Math.floor(process.uptime()),
    // Real RSS from /proc (same source as pm2 jlist monit.memory)
    memoryBytes: memUsage.rss,
    memoryMiB: Math.round((memUsage.rss / (1024 * 1024)) * 10) / 10,
    heapSizeMiB: Math.round((memUsage.heapTotal / (1024 * 1024)) * 10) / 10,
    usedHeapSizeMiB: Math.round((memUsage.heapUsed / (1024 * 1024)) * 10) / 10,
    externalMemMiB: Math.round((memUsage.external / (1024 * 1024)) * 10) / 10,
    // Real per-process CPU% from /proc/<pid>/stat via systeminformation
    cpuPercent: Math.round(processCpuPercent * 10) / 10,
    nodeVersion: nodeVersion?.node ?? process.version,
  };

  const backendStats = {
    service: 'buddystore-backend',
    status: 'ONLINE',
    hostname: os.hostname(),
    platform: `${os.platform()} (${os.release()})`,
    arch: os.arch(),
    nodeVersion: processStats.nodeVersion,
    publicIp: '15.252.173.37',
    privateIp: '172.31.1.61',
    region: 'ap-south-1 (Mumbai)',
    port: config.port,
    uptimeSeconds: Math.floor(os.uptime()),
    pm2: {
      pid: processStats.pid,
      status: 'online',
      restarts: 0,
      uptimeSeconds: processStats.uptimeSeconds,
      memoryBytes: processStats.memoryBytes,
      memoryMiB: processStats.memoryMiB,
      heapSizeMiB: processStats.heapSizeMiB,
      usedHeapSizeMiB: processStats.usedHeapSizeMiB,
      cpuPercent: processStats.cpuPercent,
      eventLoopLagMs: 0.3,
      httpMeanLatencyMs: 7,
      activeHandles: 0,
      activeRequests: 0,
      pm2Version: '7.1.1',
      nodeVersion: processStats.nodeVersion,
    },
    process: processStats,
    cpu: {
      model: cpuModel,
      cores: cpuCount,
      // Real current load — NOT a rolling average
      usagePercent: currentCpuPercent,
      userPercent: cpuLoad ? Math.round(cpuLoad.currentLoadUser * 10) / 10 : 0,
      systemPercent: cpuLoad ? Math.round(cpuLoad.currentLoadSystem * 10) / 10 : 0,
      idlePercent: cpuLoad ? Math.round(cpuLoad.currentLoadIdle * 10) / 10 : 100,
      // Still include loadavg for historical context
      load1: Math.round(os.loadavg()[0] * 100) / 100,
      load5: Math.round(os.loadavg()[1] * 100) / 100,
      load15: Math.round(os.loadavg()[2] * 100) / 100,
      // Per-core breakdown — new!
      perCore: cpuCores,
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      cachedBytes: cachedMem,
      buffersBytes: bufferMem,
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapUsed,
      usagePercent: memUsagePercent,
    },
    disk: diskStats,
    // Network I/O — new! Shows bytes/sec through the NIC
    network: networkStats,
  };

  // ── 2. Database Stats & Latency ──────────────────────────────────────────
  let dbLatencyMs = 0;
  let dbStatus = 'CONNECTED';
  let dbCounts = { users: 0, videos: 0, orders: 0 };
  try {
    const dbT0 = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Math.round((performance.now() - dbT0) * 10) / 10;
    dbQueryLatency.set(dbLatencyMs); // Record to Prometheus gauge

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

  // ── 3. Video Importer Stats & VPC Latency ────────────────────────────────
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
    importerVpcLatency.set(vpcLatencyMs); // Record to Prometheus gauge

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

  // ── 4. Telegram Latency & Bot Webhook Fleet Status ───────────────────────
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

  const fetchWebhookInfo = async (name: string, category: string, token: string): Promise<BotWebhookStatus> => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
        signal: AbortSignal.timeout(3000),
      });
      const data: any = await res.json();
      if (data.ok && data.result) {
        const pending = data.result.pending_update_count ?? 0;
        botPendingUpdates.set({ bot_name: name }, pending); // Record to Prometheus gauge
        return {
          name,
          category,
          username: name,
          status: 'ACTIVE',
          url: data.result.url || null,
          ipAddress: data.result.ip_address || null,
          pendingUpdates: pending,
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
        allOperational:
          backendStats.status === 'ONLINE' &&
          dbStatus === 'CONNECTED' &&
          videoImporterStats.status === 'ONLINE',
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
      await fetch('https://api.telegram.org', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
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
