/**
 * Modified script: Removed command system, bot automatically processes groups from groupData.json.
 * - Applies nickname changes to all groups one by one (sequentially).
 * - Added proxy from previous bot.js (http://103.119.112.54:80).
 * - Optimized for 30-40 groups: Global concurrency 1, dynamic delays (4-5s fast, 12-13s slow), extra group-level delays (10-15s between groups).
 * - Added good functions: Anti-sleep typing, appstate backup (existing), graceful shutdown.
 * - Nickname revert on changes still active for locked groups.
 * - Group name revert still active if gclock enabled in groupData.json.
 * - No messages sent to groups.
 * - Speed tuned to avoid logout/block: Sequential processing, delays to bypass rate limits.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();
const HttpsProxyAgent = require("https-proxy-agent");

// Proxy from previous bot.js
const INDIAN_PROXY = "http://103.119.112.54:80";
let proxyAgent;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
  console.log("Proxy loaded successfully.");
} catch (err) {
  console.error("Proxy load failed, using direct connection:", err);
  proxyAgent = null;
}

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
function log(...a) { console.log(C.cyan + "[BOT]" + C.reset, ...a); }
function info(...a) { console.log(C.green + "[INFO]" + C.reset, ...a); }
function warn(...a) { console.log(C.yellow + "[WARN]" + C.reset, ...a); }
function error(...a) { console.log(C.red + "[ERR]" + C.reset, ...a); }

// Express for keepalive
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("✅ Facebook Bot is online and ready!"));
app.listen(PORT, () => log(`Server started on port ${PORT}`));

// Config (overrides via .env)
const BOSS_UID = process.env.BOSS_UID || "61570909979895";
const DEFAULT_NICKNAME = process.env.DEFAULT_NICKNAME || "😈Allah madarchod😈"; // Default nickname
const DATA_DIR = process.env.DATA_DIR || __dirname;
const appStatePath = path.join(DATA_DIR, "appstate.json");
const dataFile = path.join(DATA_DIR, "groupData.json");

// Timing rules - Tuned for 30-40 groups: Slower delays to avoid blocks
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 60 * 1000; // 60s
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47 * 1000; // 47s
const FAST_NICKNAME_DELAY_MIN = parseInt(process.env.FAST_NICKNAME_DELAY_MIN) || 10000; // 5s
const FAST_NICKNAME_DELAY_MAX = parseInt(process.env.FAST_NICKNAME_DELAY_MAX) || 12000; // 7s
const SLOW_NICKNAME_DELAY_MIN = parseInt(process.env.SLOW_NICKNAME_DELAY_MIN) || 15000; // 12s
const SLOW_NICKNAME_DELAY_MAX = parseInt(process.env.SLOW_NICKNAME_DELAY_MAX) || 20000; // 15s
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 50; // Reduced to avoid rate limits
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 5 * 60 * 1000; // 5min
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 10 * 60 * 1000; // 10min
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000; // 10min
const MAX_PER_TICK = parseInt(process.env.MAX_PER_TICK) || 5; // Max 5 groups per check cycle
const GROUP_PROCESS_DELAY = 10000 + Math.floor(Math.random() * 5000); // 10-15s delay between groups for safety

const ENABLE_PUPPETEER = false; // Disabled
const CHROME_EXECUTABLE = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;

// State
let api = null;
let groupLocks = {};                // persisted config loaded from groupData.json
let groupQueues = {};               // per-thread queues (in-memory)
let groupNameChangeDetected = {};   // timestamp recorded when change first noticed
let groupNameRevertInProgress = {}; // bool
let puppeteerBrowser = null;
let puppeteerPage = null;
let puppeteerAvailable = false;
let shuttingDown = false;

// Global concurrency limiter (1 for safety with 30-40 groups)
const GLOBAL_MAX_CONCURRENT = 1;
let globalActiveCount = 0;
const globalPending = [];
async function acquireGlobalSlot() {
  if (globalActiveCount < GLOBAL_MAX_CONCURRENT) {
    globalActiveCount++;
    return;
  }
  await new Promise((res) => globalPending.push(res));
  globalActiveCount++;
}
function releaseGlobalSlot() {
  globalActiveCount = Math.max(0, globalActiveCount - 1);
  if (globalPending.length) {
    const r = globalPending.shift();
    r();
  }
}

// Helpers: file ops
async function ensureDataFile() {
  try {
    await fsp.access(dataFile);
  } catch (e) {
    await fsp.writeFile(dataFile, JSON.stringify({}, null, 2));
  }
}
async function loadLocks() {
  try {
    await ensureDataFile();
    const txt = await fsp.readFile(dataFile, "utf8");
    groupLocks = JSON.parse(txt || "{}");
    // Ensure nick is set for all groups
    for (const threadID in groupLocks) {
      if (!groupLocks[threadID].nick) {
        groupLocks[threadID].nick = DEFAULT_NICKNAME;
      }
    }
    info("Loaded saved group locks.");
  } catch (e) {
    warn("Failed to load groupData.json:", e.message || e);
    groupLocks = {};
  }
}
async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
    info("Group locks saved.");
  } catch (e) {
    warn("Failed to save groupData.json:", e.message || e);
  }
}

// utilities
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function getDynamicDelay(count) {
  const cycle = count % 16; // Cycle: 0-4 fast, 5-10 slow, 11-15 fast
  if (cycle < 5 || cycle >= 11) {
    return Math.floor(Math.random() * (FAST_NICKNAME_DELAY_MAX - FAST_NICKNAME_DELAY_MIN + 1)) + FAST_NICKNAME_DELAY_MIN; // 5-7s
  } else {
    return Math.floor(Math.random() * (SLOW_NICKNAME_DELAY_MAX - SLOW_NICKNAME_DELAY_MIN + 1)) + SLOW_NICKNAME_DELAY_MIN; // 12-15s
  }
}
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// Send message to group (disabled)
async function sendGroupMessage(threadID, message) {
  info(`[${timestamp()}] Would have sent message to ${threadID}: ${message}`);
}

// per-thread queue helpers
function ensureQueue(threadID) {
  if (!groupQueues[threadID]) groupQueues[threadID] = { running: false, tasks: [] };
  return groupQueues[threadID];
}
function queueTask(threadID, fn) {
  const q = ensureQueue(threadID);
  q.tasks.push(fn);
  if (!q.running) runQueue(threadID);
}
async function runQueue(threadID) {
  const q = ensureQueue(threadID);
  if (q.running) return;
  q.running = true;
  while (q.tasks.length) {
    const fn = q.tasks.shift();
    try {
      await acquireGlobalSlot();
      try {
        await fn();
      } finally {
        releaseGlobalSlot();
      }
    } catch (e) {
      warn(`[${timestamp()}] Queue task error for ${threadID}:`, e.message || e);
    }
    await sleep(500); // Delay for safety
  }
  q.running = false;
}

// Safe getThreadInfo
async function safeGetThreadInfo(apiObj, threadID) {
  try {
    const info = await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, r) => (err ? rej(err) : res(r))));
    if (!info || typeof info !== 'object') {
      return null;
    }
    return {
      threadName: info.threadName || "",
      participantIDs: (info.participantIDs || (info.userInfo ? info.userInfo.map(u => u.id || '') : [])).filter(id => id),
      nicknames: info.nicknames || {},
      userInfo: Array.isArray(info.userInfo) ? info.userInfo.filter(u => u && u.id) : []
    };
  } catch (e) {
    return null;
  }
}

// Change thread title
async function changeThreadTitle(apiObj, threadID, title) {
  if (!apiObj) throw new Error("No api");
  if (typeof apiObj.setTitle === "function") {
    return new Promise((r, rej) => apiObj.setTitle(title, threadID, (err) => (err ? rej(err) : r())));
  }
  if (typeof apiObj.changeThreadTitle === "function") {
    return new Promise((r, rej) => apiObj.changeThreadTitle(title, threadID, (err) => (err ? rej(err) : r())));
  }
  throw new Error("No method to change thread title");
}

// Load appstate
async function loadAppState() {
  try {
    const txt = await fsp.readFile(appStatePath, "utf8");
    const appState = JSON.parse(txt);
    if (!Array.isArray(appState)) {
      throw new Error("Invalid appstate.json: must be an array");
    }
    return appState;
  } catch (e) {
    throw new Error(`Cannot load appstate.json: ${e.message || e}`);
  }
}

// Process all groups sequentially from groupData.json
async function processAllGroups(apiObj) {
  const threadIDs = Object.keys(groupLocks);
  info(`[${timestamp()}] Starting nickname changes for ${threadIDs.length} groups (one by one).`);
  for (let i = 0; i < threadIDs.length; i++) {
    const threadID = threadIDs[i];
    const group = groupLocks[threadID];
    if (!group || !group.enabled) continue;
    try {
      const threadInfo = await safeGetThreadInfo(apiObj, threadID);
      if (!threadInfo) {
        warn(`[${timestamp()}] Skipping ${threadID}: No thread info.`);
        continue;
      }
      // Set bot's nickname first
      const botNick = group.nick || DEFAULT_NICKNAME;
      if (threadInfo.nicknames[BOSS_UID] !== botNick) {
        queueTask(threadID, async () => {
          try {
            await new Promise((res, rej) => apiObj.changeNickname(botNick, threadID, BOSS_UID, (err) => (err ? rej(err) : res())));
            log(`🎭 [${timestamp()}] Set bot nick to ${botNick} in ${threadID}`);
            await sleep(getDynamicDelay(group.count || 0));
          } catch (e) {
            warn(`[${timestamp()}] Bot nick set failed in ${threadID}:`, e.message || e);
          }
        });
      }
      // Then set others' nicknames
      for (const uid of threadInfo.participantIDs) {
        if (uid === BOSS_UID) continue; // Skip bot
        const desired = group.original?.[uid] || group.nick || DEFAULT_NICKNAME;
        if (!desired) continue;
        const current = threadInfo.nicknames[uid] || (threadInfo.userInfo.find(u => u.id === uid)?.nickname) || null;
        if (current !== desired) {
          queueTask(threadID, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(desired, threadID, uid, (err) => (err ? rej(err) : res())));
              log(`🎭 [${timestamp()}] Reapplied nick for ${uid} in ${threadID} to "${desired}"`);
              group.count = (group.count || 0) + 1;
              await saveLocks();
              await sleep(getDynamicDelay(group.count));
            } catch (e) {
              warn(`[${timestamp()}] Nick revert failed ${uid} in ${threadID}:`, e.message || e);
            }
          });
        }
      }
      info(`[${timestamp()}] Finished processing group ${threadID} (${i+1}/${threadIDs.length}).`);
      await sleep(GROUP_PROCESS_DELAY); // Extra delay between groups for safety (10-15s)
    } catch (e) {
      warn(`[${timestamp()}] Error processing group ${threadID}:`, e.message || e);
    }
  }
  info(`[${timestamp()}] All groups processed.`);
}

// Main login + run with reconnect logic
let loginAttempts = 0;
async function loginAndRun() {
  while (!shuttingDown) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      api = await new Promise((res, rej) => {
        try {
          loginLib({ appState, agent: proxyAgent }, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"} `);

      // load persisted locks
      await loadLocks();

      // Automatically process all groups on startup
      await processAllGroups(api);

      // group-name watcher
      setInterval(async () => {
        const threadIDs = Object.keys(groupLocks);
        for (let i = 0; i < Math.min(MAX_PER_TICK, threadIDs.length); i++) {
          const threadID = threadIDs[i];
          const group = groupLocks[threadID];
          if (!group || !group.gclock) continue;
          if (groupNameRevertInProgress[threadID]) continue;
          try {
            const threadInfo = await safeGetThreadInfo(api, threadID);
            if (threadInfo && threadInfo.threadName !== group.groupName) {
              if (!groupNameChangeDetected[threadID]) {
                groupNameChangeDetected[threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> "${threadInfo.threadName}". Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s.`);
              } else {
                const elapsed = Date.now() - groupNameChangeDetected[threadID];
                if (elapsed >= GROUP_NAME_REVERT_DELAY) {
                  groupNameRevertInProgress[threadID] = true;
                  try {
                    await changeThreadTitle(api, threadID, group.groupName);
                    info(`[${timestamp()}] [GCLOCK] Reverted ${threadID} -> "${group.groupName}"`);
                  } catch (e) {
                    warn(`[${timestamp()}] [GCLOCK] Failed revert ${threadID}:`, e.message || e);
                  } finally {
                    groupNameChangeDetected[threadID] = null;
                    groupNameRevertInProgress[threadID] = false;
                  }
                }
              }
            } else {
              groupNameChangeDetected[threadID] = null;
            }
          } catch (e) {
            // Reduced logging
          }
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // anti-sleep typing indicator
      setInterval(async () => {
        for (const id of Object.keys(groupLocks)) {
          try {
            const g = groupLocks[id];
            if (!g || !g.enabled) continue;
            await new Promise((res, rej) => api.sendTypingIndicator(id, (err) => (err ? rej(err) : res())));
            await sleep(1200);
          } catch (e) {
            warn(`[${timestamp()}] Typing indicator failed for ${id}:`, e.message || e);
            if ((e.message || "").toLowerCase().includes("client disconnecting") || (e.message || "").toLowerCase().includes("not logged in")) {
              warn("Detected client disconnect - attempting reconnect...");
              try { api.removeAllListeners && api.removeAllListeners(); } catch(_){}
              throw new Error("FORCE_RECONNECT");
            }
          }
        }
      }, TYPING_INTERVAL);

      // appstate backup
      setInterval(async () => {
        try {
          const s = api.getAppState ? api.getAppState() : null;
          if (s) await fsp.writeFile(appStatePath, JSON.stringify(s, null, 2));
          info(`[${timestamp()}] Appstate backed up.`);
        } catch (e) { warn("Appstate backup error:", e.message || e); }
      }, APPSTATE_BACKUP_INTERVAL);

      // Periodically re-process groups (every 5 min)
      setInterval(() => processAllGroups(api).catch(e => warn("Re-process error:", e.message || e)), 5 * 60 * 1000);

      // Event listener (commands removed, keep reverts)
      api.listenMqtt(async (err, event) => {
        if (err) {
          warn("listenMqtt error:", err.message || err);
          return;
        }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;

          // Quick reaction to thread-name log events
          if (event.type === "event" && event.logMessageType === "log:thread-name") {
            const lockedName = groupLocks[event.threadID]?.groupName;
            if (lockedName && event.logMessageData?.name !== lockedName) {
              if (!groupNameChangeDetected[event.threadID]) {
                groupNameChangeDetected[event.threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected quick name change for ${event.threadID} -> will revert after ${GROUP_NAME_REVERT_DELAY/1000}s`);
              }
            }
          }

          // Nickname revert events
          if (event.logMessageType === "log:user-nickname") {
            const group = groupLocks[threadID];
            if (!group || !group.enabled || group.cooldown) return;

            const uid = event.logMessageData?.participant_id;
            const currentNick = event.logMessageData?.nickname;
            const lockedNick = (group.original && group.original[uid]) || group.nick || DEFAULT_NICKNAME;

            if (lockedNick && currentNick !== lockedNick) {
              queueTask(threadID, async () => {
                try {
                  await new Promise((res, rej) => api.changeNickname(lockedNick, threadID, uid, (err) => (err ? rej(err) : res())));
                  group.count = (group.count || 0) + 1;
                  info(`🎭 [${timestamp()}] [NICKLOCK] Reverted ${uid} in ${threadID} to "${lockedNick}"`);
                  if (group.count >= NICKNAME_CHANGE_LIMIT) {
                    group.cooldown = true;
                    warn(`⏸️ [${timestamp()}] [COOLDOWN] ${threadID} cooling down ${NICKNAME_COOLDOWN/1000}s`);
                    setTimeout(() => { 
                      group.cooldown = false; 
                      group.count = 0; 
                      info(`▶️ [${timestamp()}] [COOLDOWN] Lifted for ${threadID}`); 
                    }, NICKNAME_COOLDOWN);
                  }
                  await saveLocks();
                  await sleep(getDynamicDelay(group.count));
                } catch (e) {
                  warn(`[${timestamp()}] Nick revert failed for ${uid} in ${threadID}:`, e.message || e);
                }
              });
            }
          }

          // When members join / thread created, sync mapping
          if (event.type === "event" && (event.logMessageType === "log:subscribe" || event.logMessageType === "log:thread-created")) {
            const g = groupLocks[event.threadID];
            if (g && g.enabled) {
              try {
                const threadInfo = await safeGetThreadInfo(api, event.threadID);
                if (!threadInfo) return;
                g.original = g.original || {};
                for (const u of (threadInfo.userInfo || [])) {
                  if (u.id === BOSS_UID) continue;
                  g.original[u.id] = g.nick || DEFAULT_NICKNAME;
                  queueTask(event.threadID, async () => {
                    try {
                      await new Promise((res, rej) => api.changeNickname(g.nick || DEFAULT_NICKNAME, event.threadID, u.id, (err) => (err ? rej(err) : res())));
                      info(`[${timestamp()}] Set nick for new member ${u.id} in ${event.threadID} to "${g.nick || DEFAULT_NICKNAME}"`);
                      g.count = (g.count || 0) + 1;
                      await saveLocks();
                      await sleep(getDynamicDelay(g.count));
                    } catch (e) {
                      warn(`[${timestamp()}] Nick set failed for ${u.id}:`, e.message || e);
                    }
                  });
                }
                await saveLocks();
                info(`[${timestamp()}] Membership sync for ${event.threadID}`);
              } catch (e) { 
                warn(`Membership sync failed for ${event.threadID}:`, e.message || e); 
              }
            }
          }

        } catch (e) {
          if ((e && e.message) === "FORCE_RECONNECT") throw e;
          warn("Event handler caught error:", e.message || e);
        }
      });

      // login succeeded; reset attempts
      loginAttempts = 0;
      break; // stay logged in
    } catch (e) {
      error(`[${timestamp()}] Login/Run error:`, e.message || e);
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  }
}

// Start bot
loginAndRun().catch((e) => { error("Fatal start error:", e.message || e); process.exit(1); });

// Global handlers
process.on("uncaughtException", (err) => {
  error("uncaughtException:", err && err.stack ? err.stack : err);
  try { if (api && api.removeAllListeners) api.removeAllListeners(); } catch(_){}
  setTimeout(() => loginAndRun().catch(e=>error("relogin after exception failed:", e.message || e)), 5000);
});
process.on("unhandledRejection", (reason) => {
  warn("unhandledRejection:", reason);
  setTimeout(() => loginAndRun().catch(e=>error("relogin after rejection failed:", e.message || e)), 5000);
});

// graceful shutdown
async function gracefulExit() {
  shuttingDown = true;
  info("Graceful shutdown: saving state...");
  try { if (api && api.getAppState) await fsp.writeFile(appStatePath, JSON.stringify(api.getAppState(), null, 2)); } catch (e) {}
  try { await saveLocks(); } catch (e) {}
  try { if (puppeteerBrowser) await puppeteerBrowser.close(); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);
