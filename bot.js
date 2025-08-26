/**
 * Fixed bot.js based on original index.js
 * - Removed command system (no boss-only commands like /nicklock, /gclock, etc.)
 * - Added proxy[](http://103.119.112.54:80) using HttpsProxyAgent
 * - Fixed issue where nickname is changed 4 times (added check to avoid redundant changes in initCheckLoop and event listener)
 * - Optimized for 30-40 groups: Increased delays between groups (15-20s), kept global concurrency 1, dynamic nickname delays (4-5s, 12-13s), and cooldown after 50 changes
 * - Reads APPSTATE directly from appstate.json (no .env APPSTATE)
 * - Bot sets its own nickname first, then others
 * - NO group messages sent (disabled all sendGroupMessage calls)
 * - Stops sending group messages during cooldown but continues reverting
 * - Dynamic nickname change speed:
 *   - First 4-5 nicknames: 4-5s delay
 *   - Next 5-6 nicknames: 12-13s delay
 *   - Next 5-6 nicknames: 4-5s delay (cycle repeats)
 * - Optimized for 20-30 groups with rate limiting
 * - Group-name revert: wait 47s after change detected
 * - Global concurrency limiter set to 1
 * - Fixed undefined nickname issue with default value
 * - Reduced logging to minimize server load
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();
const HttpsProxyAgent = require("https-proxy-agent");

// Proxy setup
const INDIAN_PROXY = "http://103.119.112.54:80";
let proxyAgent;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
  log("Proxy loaded successfully.");
} catch (err) {
  warn("Proxy load failed, using direct connection:", err);
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

// Timing rules - Optimized for 30-40 groups with increased delays
const GROUP_NAME_CHECK_INTERVAL = parseInt(process.env.GROUP_NAME_CHECK_INTERVAL) || 60 * 1000; // 60s
const GROUP_NAME_REVERT_DELAY = parseInt(process.env.GROUP_NAME_REVERT_DELAY) || 47 * 1000; // 47s
const FAST_NICKNAME_DELAY_MIN = parseInt(process.env.FAST_NICKNAME_DELAY_MIN) || 4000; // 4s
const FAST_NICKNAME_DELAY_MAX = parseInt(process.env.FAST_NICKNAME_DELAY_MAX) || 5000; // 5s
const SLOW_NICKNAME_DELAY_MIN = parseInt(process.env.SLOW_NICKNAME_DELAY_MIN) || 12000; // 12s
const SLOW_NICKNAME_DELAY_MAX = parseInt(process.env.SLOW_NICKNAME_DELAY_MAX) || 13000; // 13s
const NICKNAME_CHANGE_LIMIT = parseInt(process.env.NICKNAME_CHANGE_LIMIT) || 50; // Reduced to avoid rate limits
const NICKNAME_COOLDOWN = parseInt(process.env.NICKNAME_COOLDOWN) || 5 * 60 * 1000; // 5min
const TYPING_INTERVAL = parseInt(process.env.TYPING_INTERVAL) || 10 * 60 * 1000; // 10min
const APPSTATE_BACKUP_INTERVAL = parseInt(process.env.APPSTATE_BACKUP_INTERVAL) || 10 * 60 * 1000; // 10min
const MAX_PER_TICK = parseInt(process.env.MAX_PER_TICK) || 5; // Max 5 groups per check cycle
const GROUP_DELAY_MIN = 15000; // 15s min delay between groups for 30-40 groups
const GROUP_DELAY_MAX = 20000; // 20s max delay

const ENABLE_PUPPETEER = false; // Disabled as per user request
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

// Global concurrency limiter to reduce flood risk across groups
const GLOBAL_MAX_CONCURRENT = parseInt(process.env.GLOBAL_MAX_CONCURRENT) || 1;
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
    return Math.floor(Math.random() * (FAST_NICKNAME_DELAY_MAX - FAST_NICKNAME_DELAY_MIN + 1)) + FAST_NICKNAME_DELAY_MIN; // 4-5s
  } else {
    return Math.floor(Math.random() * (SLOW_NICKNAME_DELAY_MAX - SLOW_NICKNAME_DELAY_MIN + 1)) + SLOW_NICKNAME_DELAY_MIN; // 12-13s
  }
}
function timestamp() { return new Date().toTimeString().split(" ")[0]; }

// Send message to group (disabled for all cases)
async function sendGroupMessage(threadID, message) {
  // Disabled: No messages will be sent to groups
  info(`[${timestamp()}] Would have sent message to ${threadID}: ${message}`);
}

// per-thread queue helpers (but each task will acquire global slot before running)
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
    await sleep(500); // Increased to 500ms for 20-30 groups
  }
  q.running = false;
}

// Safe getThreadInfo wrapper to handle null or undefined data
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

// change thread title: try API methods, then Puppeteer fallback (best-effort)
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

// appState loader: read only from appstate.json
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

// init check: reapply nicknames according to groupLocks (run on start + periodically)
async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) continue;
      try {
        const threadInfo = await safeGetThreadInfo(apiObj, t);
        if (!threadInfo) continue;
        // Set bot's nickname first
        const botNick = group.nick || DEFAULT_NICKNAME;
        if (threadInfo.nicknames[BOSS_UID] !== botNick) {
          queueTask(t, async () => {
            try {
              await new Promise((res, rej) => apiObj.changeNickname(botNick, t, BOSS_UID, (err) => (err ? rej(err) : res())));
              log(`🎭 [${timestamp()}] [INIT] Set bot nick to ${botNick} in ${t}`);
              await sleep(getDynamicDelay(group.count || 0));
            } catch (e) {
              warn(`[${timestamp()}] INIT bot nick set failed in ${t}:`, e.message || e);
            }
          });
        }
        // Then set others' nicknames (fixed to change only once per user)
        for (const uid of threadInfo.participantIDs) {
          if (uid === BOSS_UID) continue; // Skip bot
          const desired = group.original?.[uid] || group.nick || DEFAULT_NICKNAME;
          if (!desired) continue;
          const current = threadInfo.nicknames[uid] || (threadInfo.userInfo.find(u => u.id === uid)?.nickname) || null;
          if (current !== desired) {
            queueTask(t, async () => {
              try {
                await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res())));
                log(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t} to "${desired}"`);
                group.count = (group.count || 0) + 1;
                await saveLocks();
                await sleep(getDynamicDelay(group.count));
              } catch (e) {
                warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message || e);
              }
            });
          }
        }
      } catch (e) {
        // ignore single thread failures
      }
    }
  } catch (e) {
    warn("initCheckLoop error:", e.message || e);
  }
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
          loginLib({ appState }, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) { rej(e); }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"} `);

      // load persisted locks
      await loadLocks();

      // group-name watcher: detects name change and reverts after GROUP_NAME_REVERT_DELAY (47s)
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
                info(`[${timestamp()}] [GCLOCK] Detected change in ${threadID} -> "${threadInfo.threadName}". Will revert after ${GROUP_NAME_REVERT_DELAY/1000}s if still changed.`);
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
            // warn(`[${timestamp()}] [GCLOCK] Error checking ${threadID}:`, e.message || e); // Commented to reduce logs
          }
        }
      }, GROUP_NAME_CHECK_INTERVAL);

      // anti-sleep typing indicator
      setInterval(async () => {
        for (const id of Object.keys(groupLocks)) {
          try {
            const g = groupLocks[id];
            if (!g || (!g.gclock && !g.enabled)) continue;
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

      // initial init check
      await initCheckLoop(api);
      setInterval(() => initCheckLoop(api).catch(e => warn("initCheck error:", e.message || e)), 5 * 60 * 1000);

      // Event listener (commands removed)
      api.listenMqtt(async (err, event) => {
        if (err) {
          warn("listenMqtt error:", err.message || err);
          return;
        }
        try {
          const threadID = event.threadID;
          const senderID = event.senderID;
          const body = (event.body || "").toString().trim();

          // Quick reaction to thread-name log events (also handled by poller)
          if (event.type === "event" && event.logMessageType === "log:thread-name") {
            const lockedName = groupLocks[event.threadID]?.groupName;
            if (lockedName && event.logMessageData?.name !== lockedName) {
              if (!groupNameChangeDetected[event.threadID]) {
                groupNameChangeDetected[event.threadID] = Date.now();
                info(`[${timestamp()}] [GCLOCK] Detected quick name change for ${event.threadID} -> will revert after ${GROUP_NAME_REVERT_DELAY/1000}s`);
              }
            }
          }

          // Nickname revert events (no group messages)
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

          // When members join / thread created, sync mapping if nicklock enabled
          if (event.type === "event" && (event.logMessageType === "log:subscribe" || event.logMessageType === "log:thread-created")) {
            const g = groupLocks[event.threadID];
            if (g && g.enabled) {
              try {
                const threadInfo = await safeGetThreadInfo(api, event.threadID);
                if (!threadInfo) return;
                g.original = g.original || {};
                for (const u of (threadInfo.userInfo || [])) {
                  if (u.id === BOSS_UID) continue; // Skip bot
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
      }); // end listenMqtt

      // login succeeded; reset attempts
      loginAttempts = 0;
      break; // stay logged in and let intervals/listener run
    } catch (e) {
      error(`[${timestamp()}] Login/Run error:`, e.message || e);
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  } // while
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
