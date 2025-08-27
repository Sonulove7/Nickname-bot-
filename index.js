const { HttpsProxyAgent } = require("https-proxy-agent");
const path = require("path");
const fsp = require("fs").promises;
const ws3 = require("ws3-fca");
const loginLib = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
require("dotenv").config();

// प्रॉक्सी कॉन्फिगरेशन (आपकी दी हुई स्क्रिप्ट के समान)
const INDIAN_PROXY = "http://103.119.112.54:80";
let proxyAgent;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch {
  proxyAgent = null;
}

// अन्य कॉन्फिगरेशन
const appStatePath = process.env.APPSTATE_PATH || "/opt/render/project/src/appstate.json";
const dataFile = process.env.DATA_FILE_PATH || path.join(__dirname, "groupData.json");
let cachedAppState = null;
let loginAttempts = 0;
const MAX_LOGIN_ATTEMPTS = 5;
let shuttingDown = false;
let api;
let groupLocks = {};
const BOSS_UID = process.env.BOSS_UID || " 61578666851540"; // अपने बॉट का UID डालें
const DEFAULT_NICKNAME = "😈Allah madarchod😈";

// लॉगिंग फंक्शन्स
const timestamp = () => new Date().toISOString().split("T")[1].split(".")[0];
const info = (...a) => console.log("\x1b[32m[INFO]\x1b[0m", `[${timestamp()}]`, ...a);
const warn = (...a) => console.log("\x1b[33m[WARN]\x1b[0m", `[${timestamp()}]`, ...a);
const error = (...a) => console.log("\x1b[31m[ERR]\x1b[0m", `[${timestamp()}]`, ...a);
const log = (...a) => {
  if (process.env.MINIMAL_LOGGING) return;
  console.log("\x1b[36m[BOT]\x1b[0m", ...a);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// रैंडम डिले जनरेटर (ब्लॉक से बचने के लिए)
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// डायनामिक डिले (ग्रुप्स और यूजर्स के लिए)
function getDynamicDelay(count) {
  return Math.min(10000, 5000 + count * 200); // प्रति निकनेम 5-10 सेकंड
}
function getGroupDelay(count) {
  return Math.min(120000, 60000 + count * 1000); // प्रति ग्रुप 1-2 मिनट
}

async function loadAppState() {
  try {
    if (cachedAppState) {
      info("[DEBUG] Using cached appstate");
      return cachedAppState;
    }
    if (process.env.APPSTATE_JSON) {
      info("[DEBUG] Loading appstate from APPSTATE_JSON env");
      const appState = JSON.parse(process.env.APPSTATE_JSON);
      if (!Array.isArray(appState)) {
        throw new Error("Invalid APPSTATE_JSON: must be an array");
      }
      cachedAppState = appState;
      return appState;
    }
    info(`[DEBUG] Attempting to load appstate from: ${appStatePath}`);
    const txt = await fsp.readFile(appStatePath, "utf8");
    info(`[DEBUG] appstate.json content: ${txt}`);
    const appState = JSON.parse(txt);
    if (!Array.isArray(appState)) {
      throw new Error("Invalid appstate.json: must be an array");
    }
    cachedAppState = appState;
    return appState;
  } catch (e) {
    throw new Error(`Cannot load appstate: ${e.message || e}`);
  }
}

async function saveLocks() {
  try {
    const tmp = `${dataFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(groupLocks, null, 2));
    await fsp.rename(tmp, dataFile);
    if (Object.keys(groupLocks).some(t => groupLocks[t].count > 0)) {
      info("Group locks saved.");
    }
  } catch (e) {
    warn("Failed to save groupData.json:", e.message || e);
  }
}

async function loadLocks() {
  try {
    const txt = await fsp.readFile(dataFile, "utf8");
    groupLocks = JSON.parse(txt);
    info("Group locks loaded.");
  } catch (e) {
    warn("Failed to load groupData.json, starting fresh:", e.message || e);
    groupLocks = {};
  }
}

async function safeGetThreadInfo(apiObj, threadID) {
  try {
    return await new Promise((res, rej) => apiObj.getThreadInfo(threadID, (err, info) => (err ? rej(err) : res(info))));
  } catch (e) {
    warn(`Failed to get thread info for ${threadID}:`, e.message || e);
    return null;
  }
}

// टास्क क्यू मैनेजमेंट
const taskQueues = {};
function queueTask(threadID, task) {
  taskQueues[threadID] = taskQueues[threadID] || [];
  taskQueues[threadID].push(task);
  if (taskQueues[threadID].length === 1) {
    (async () => {
      while (taskQueues[threadID].length > 0) {
        const current = taskQueues[threadID][0];
        try {
          await current();
        } catch (e) {
          warn(`Task failed in queue for ${threadID}:`, e.message || e);
        }
        taskQueues[threadID].shift();
        await sleep(getRandomDelay(1000, 3000)); // प्रत्येक टास्क के बीच 1-3 सेकंड डिले
      }
    })();
  }
}

async function initCheckLoop(apiObj) {
  try {
    const threadIDs = Object.keys(groupLocks);
    info(`Processing ${threadIDs.length} groups...`);
    for (let t of threadIDs) {
      const group = groupLocks[t];
      if (!group || !group.enabled) {
        info(`Skipping disabled group ${t}`);
        continue;
      }
      try {
        const threadInfo = await safeGetThreadInfo(apiObj, t);
        if (!threadInfo) {
          warn(`No thread info for group ${t}, skipping...`);
          continue;
        }
        info(`Processing group ${t} (${threadInfo.threadName || "Unnamed"})`);
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
        // Set others' nicknames only if changed
        for (const uid of threadInfo.participantIDs) {
          if (uid === BOSS_UID) continue;
          const desired = group.original?.[uid] || group.nick || DEFAULT_NICKNAME;
          const current = threadInfo.nicknames[uid] || null;
          if (current !== desired && (!group.recentlyApplied?.[uid] || Date.now() - group.recentlyApplied[uid] > 10 * 60 * 1000)) {
            queueTask(t, async () => {
              try {
                await new Promise((res, rej) => apiObj.changeNickname(desired, t, uid, (err) => (err ? rej(err) : res())));
                log(`🎭 [${timestamp()}] [INIT] Reapplied nick for ${uid} in ${t} to "${desired}"`);
                group.count = (group.count || 0) + 1;
                group.recentlyApplied = group.recentlyApplied || {};
                group.recentlyApplied[uid] = Date.now();
                await saveLocks();
                await sleep(getDynamicDelay(group.count));
              } catch (e) {
                warn(`[${timestamp()}] INIT revert failed ${uid} in ${t}:`, e.message || e);
              }
            });
          }
        }
        // Clean up old recentlyApplied entries
        if (group.recentlyApplied) {
          const now = Date.now();
          for (const uid in group.recentlyApplied) {
            if (now - group.recentlyApplied[uid] > 10 * 60 * 1000) {
              delete group.recentlyApplied[uid];
            }
          }
          await saveLocks();
        }
        // ग्रुप्स के बीच डिले (30-40 ग्रुप्स के लिए)
        await sleep(getGroupDelay(threadIDs.indexOf(t)));
      } catch (e) {
        warn(`Error processing group ${t}:`, e.message || e);
      }
    }
    info("Completed processing all groups.");
  } catch (e) {
    warn("initCheckLoop error:", e.message || e);
  }
}

async function loginAndRun() {
  while (!shuttingDown && loginAttempts < MAX_LOGIN_ATTEMPTS) {
    try {
      const appState = await loadAppState();
      info(`[${timestamp()}] Attempt login (attempt ${++loginAttempts})`);
      const loginOptions = {
        appState,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
        agent: proxyAgent, // प्रॉक्सी वैकल्पिक, null होने पर बिना प्रॉक्सी के चलेगा
      };
      api = await new Promise((res, rej) => {
        try {
          loginLib(loginOptions, (err, a) => (err ? rej(err) : res(a)));
        } catch (e) {
          rej(e);
        }
      });
      api.setOptions({ listenEvents: true, selfListen: true, updatePresence: true });
      info(`[${timestamp()}] Logged in as: ${api.getCurrentUserID ? api.getCurrentUserID() : "(unknown)"} `);
      await loadLocks();
      loginAttempts = 0;
      // शुरू करें initCheckLoop
      setInterval(() => initCheckLoop(api), 15 * 60 * 1000); // हर 15 मिनट में चेक करें (30-40 ग्रुप्स के लिए)
      // Auto-save AppState
      setInterval(() => {
        try {
          const newAppState = api.getAppState();
          fsp.writeFile(appStatePath, JSON.stringify(newAppState, null, 2));
          info("AppState saved.");
        } catch (e) {
          warn("Failed saving AppState:", e.message || e);
        }
      }, 10 * 60 * 1000); // हर 10 मिनट में AppState सेव करें
      break;
    } catch (e) {
      error(`[${timestamp()}] Login/Run error:`, e.message || e);
      if (proxyAgent && e.message.includes("Proxy")) {
        warn(`[${timestamp()}] Proxy failed, retrying without proxy...`);
        proxyAgent = null; // प्रॉक्सी फेल होने पर डिसएबल करें
        continue;
      }
      if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        error("Max login attempts reached. Exiting...");
        process.exit(1);
      }
      const backoff = Math.min(60, (loginAttempts + 1) * 5);
      info(`Retrying login in ${backoff}s...`);
      await sleep(backoff * 1000);
    }
  }
}

// सर्वर शुरू करें
loginAndRun().catch(e => error("Startup error:", e.message || e));
