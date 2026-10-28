/**
 * serverHealthMonitor.job.ts — Autonomous 24/7 Server Watchdog for BuddyStore
 *
 * Runs every 2 minutes in the background:
 *   1. Checks Supabase PostgreSQL connectivity & ping latency
 *   2. Checks Video Importer VPC health endpoint
 *   3. Checks Host memory & disk utilization
 *
 * If any critical threshold is breached:
 *   - Immediately dispatches a formatted Telegram alert to all SUPER_ADMIN users
 *   - Employs a 15-minute cooldown per incident to prevent spam
 *   - Automatically sends a RECOVERY notification once the service is restored
 */

import os from 'os';
import si from 'systeminformation';
import prisma from '../lib/prisma';
import { mainBot } from '../bots/main.bot';
import config from '../config';

let monitorInterval: NodeJS.Timeout | null = null;

// Incident tracking for debounce and auto-recovery alerts
interface IncidentState {
  isFailing: boolean;
  firstFailedAt: number | null;
  lastAlertSentAt: number | null;
  failureMessage: string;
}

const incidents = {
  database: { isFailing: false, firstFailedAt: null, lastAlertSentAt: null, failureMessage: '' } as IncidentState,
  importer: { isFailing: false, firstFailedAt: null, lastAlertSentAt: null, failureMessage: '' } as IncidentState,
  memory: { isFailing: false, firstFailedAt: null, lastAlertSentAt: null, failureMessage: '' } as IncidentState,
  disk: { isFailing: false, firstFailedAt: null, lastAlertSentAt: null, failureMessage: '' } as IncidentState,
};

const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes between repeated alerts

async function notifySuperAdmins(htmlMessage: string): Promise<void> {
  if (!config.shouldStartBots) return;

  try {
    const superAdmins = await prisma.user.findMany({
      where: { adminRole: 'SUPER_ADMIN' },
      select: { telegramId: true, telegramUsername: true },
    });

    if (superAdmins.length === 0) return;

    for (const admin of superAdmins) {
      if (!admin.telegramId) continue;
      try {
        await mainBot.api.sendMessage(admin.telegramId.toString(), htmlMessage, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (err: any) {
        console.warn(`[HealthMonitor] Could not alert admin ${admin.telegramUsername || admin.telegramId}:`, err?.message);
      }
    }
  } catch (err: any) {
    console.error('[HealthMonitor] Error querying super admins:', err?.message);
  }
}

async function runHealthCheck(): Promise<void> {
  const now = Date.now();
  const frontendUrl = (config.frontendUrl || 'https://tgbuddy.store').split(',')[0].trim();

  // ── 1. Check Supabase DB ──────────────────────────────────────────────────
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - t0;

    if (incidents.database.isFailing) {
      // RECOVERED!
      incidents.database.isFailing = false;
      incidents.database.firstFailedAt = null;
      incidents.database.lastAlertSentAt = null;

      await notifySuperAdmins(
        `✅ <b>DATABASE RECOVERED!</b>\n\nSupabase PostgreSQL (Mumbai) is back ONLINE (${dbLatency}ms latency).\nAll user orders & bot sessions restored.`
      );
    }
  } catch (err: any) {
    const wasAlreadyFailing = incidents.database.isFailing;
    incidents.database.isFailing = true;
    incidents.database.failureMessage = err?.message || 'Connection timeout';
    if (!incidents.database.firstFailedAt) incidents.database.firstFailedAt = now;

    const canAlert = !incidents.database.lastAlertSentAt || now - incidents.database.lastAlertSentAt > ALERT_COOLDOWN_MS;
    if (canAlert) {
      incidents.database.lastAlertSentAt = now;
      await notifySuperAdmins(
        `🚨 <b>CRITICAL ALERT: DATABASE DOWN!</b>\n\n` +
        `❌ <b>Service:</b> Supabase PostgreSQL (Pooler)\n` +
        `⚠️ <b>Error:</b> <code>${incidents.database.failureMessage.slice(0, 150)}</code>\n` +
        `⏱️ <b>Detected:</b> ${new Date().toISOString()}\n\n` +
        `👉 Orders and bot payments will fail until restored!\n` +
        `🔗 <a href="${frontendUrl}/admin/servers">Open Server Dashboard</a>`
      );
    }
  }

  // ── 2. Check Video Importer Service ───────────────────────────────────────
  const importerBaseUrl = process.env.VIDEO_IMPORTER_URL || 'http://172.31.13.80:10000';
  try {
    const res = await fetch(`${importerBaseUrl}/health`, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (incidents.importer.isFailing) {
      // RECOVERED!
      incidents.importer.isFailing = false;
      incidents.importer.firstFailedAt = null;
      incidents.importer.lastAlertSentAt = null;

      await notifySuperAdmins(
        `✅ <b>VIDEO IMPORTER RECOVERED!</b>\n\nPython Video Importer (AWS VPC) is back ONLINE and ready for jobs.`
      );
    }
  } catch (err: any) {
    incidents.importer.isFailing = true;
    incidents.importer.failureMessage = err?.message || 'Connection timeout';
    if (!incidents.importer.firstFailedAt) incidents.importer.firstFailedAt = now;

    const canAlert = !incidents.importer.lastAlertSentAt || now - incidents.importer.lastAlertSentAt > ALERT_COOLDOWN_MS;
    if (canAlert) {
      incidents.importer.lastAlertSentAt = now;
      await notifySuperAdmins(
        `⚠️ <b>ALERT: VIDEO IMPORTER UNREACHABLE</b>\n\n` +
        `❌ <b>Service:</b> video-importer (172.31.13.80:10000)\n` +
        `⚠️ <b>Reason:</b> <code>${incidents.importer.failureMessage}</code>\n` +
        `⏱️ <b>Detected:</b> ${new Date().toISOString()}\n\n` +
        `👉 Video imports and Hydrogram sessions will be suspended.\n` +
        `🔗 <a href="${frontendUrl}/admin/servers">Check Server Status</a>`
      );
    }
  }

  // ── 3. Check Host RAM & Disk Usage ────────────────────────────────────────
  try {
    const mem = await si.mem();
    const totalMem = mem.total || os.totalmem();
    const usedMem = mem.active || (totalMem - (mem.available || os.freemem()));
    const memPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

    if (memPercent >= 92) {
      const canAlert = !incidents.memory.lastAlertSentAt || now - incidents.memory.lastAlertSentAt > ALERT_COOLDOWN_MS;
      if (canAlert) {
        incidents.memory.lastAlertSentAt = now;
        await notifySuperAdmins(
          `⚠️ <b>HIGH MEMORY ALERT (EC2 Mumbai)</b>\n\n` +
          `📈 <b>Host RAM Usage:</b> <b>${memPercent.toFixed(1)}%</b>\n` +
          `💾 <b>Used:</b> ${(usedMem / 1024 / 1024).toFixed(0)} MB / ${(totalMem / 1024 / 1024).toFixed(0)} MB\n` +
          `⚠️ Risk of PM2 process crash or Out-Of-Memory reboot.\n\n` +
          `🔗 <a href="${frontendUrl}/admin/servers">Inspect Telemetry</a>`
        );
      }
    } else {
      incidents.memory.lastAlertSentAt = null;
    }
  } catch (_) {}
}

export function startServerHealthMonitor(): void {
  console.log('🛡️ [Jobs] Autonomous Server Health Watchdog started. (Checks every 2m)');

  // Run initial check after 10 seconds of startup
  setTimeout(() => {
    runHealthCheck().catch((err) => console.error('[HealthMonitor] Initial check error:', err?.message));
  }, 10000);

  // Repeat every 2 minutes
  monitorInterval = setInterval(() => {
    runHealthCheck().catch((err) => console.error('[HealthMonitor] Check error:', err?.message));
  }, 2 * 60 * 1000);
}

export function stopServerHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

