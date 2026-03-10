const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow;
let tray;
let monitorInterval;
let dataStore;

// ─── Bangladesh BPDB Electricity Tariff 2024 ───────────────────────────────
// Residential (LT) slab rates (BDT per kWh)
const BD_TARIFF = {
  slabs: [
    { upTo: 75,   rate: 3.75,  label: '0–75 units'    },
    { upTo: 200,  rate: 5.26,  label: '76–200 units'  },
    { upTo: 300,  rate: 5.63,  label: '201–300 units' },
    { upTo: 400,  rate: 5.89,  label: '301–400 units' },
    { upTo: 600,  rate: 7.95,  label: '401–600 units' },
    { upTo: Infinity, rate: 9.32, label: '600+ units' }
  ],
  serviceCharge: 10,   // BDT flat
  demandCharge: 0,     // Not applicable for residential
  vatRate: 0.05        // 5% VAT
};

function calcBDTBill(kwhUsed) {
  let bill = 0;
  let remaining = kwhUsed;
  let prevSlab = 0;
  for (const slab of BD_TARIFF.slabs) {
    const inSlab = Math.min(remaining, slab.upTo - prevSlab);
    if (inSlab <= 0) break;
    bill += inSlab * slab.rate;
    remaining -= inSlab;
    prevSlab = slab.upTo;
    if (remaining <= 0) break;
  }
  bill += BD_TARIFF.serviceCharge;
  bill += bill * BD_TARIFF.vatRate;
  return Math.round(bill * 100) / 100;
}

// ─── Simple JSON-based data store ─────────────────────────────────────────
const DATA_DIR = path.join(app.getPath('userData'), 'voltwatch');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return getDefaultData();
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return getDefaultData(); }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Save error', e); }
}

function getDefaultData() {
  return {
    settings: {
      tdpWatts: 65,         // default assumed system TDP
      limitKwh: 100,
      limitBdt: 500,
      alertsEnabled: true
    },
    sessions: [],
    hourly: [],
    appUsage: {},
    startTime: Date.now(),
    totalWh: 0
  };
}

// ─── Power estimation ──────────────────────────────────────────────────────
let lastSampleTime = Date.now();
let accumulatedWh = 0;

async function estimatePowerAndApps(tdpWatts) {
  const si = require('systeminformation');

  let cpuLoad = 0;
  let memUsed = 0;
  let topApps = [];

  try {
    const [load, mem, procs] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.processes()
    ]);

    cpuLoad = load.currentLoad || 0;
    memUsed = (mem.active / mem.total) * 100;

    // Estimate watts: idle ~20% TDP, scale with CPU load
    const idleW = tdpWatts * 0.20;
    const estimatedW = idleW + (tdpWatts - idleW) * (cpuLoad / 100);

    // Top processes by CPU
    const sorted = (procs.list || [])
      .filter(p => p.cpu > 0.1)
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 8);

    topApps = sorted.map(p => ({
      name: p.name || 'Unknown',
      cpu: Math.round(p.cpu * 10) / 10,
      mem: Math.round(p.memRss / 1024 / 1024),
      estimatedW: Math.round((p.cpu / 100) * tdpWatts * 10) / 10
    }));

    return { watts: Math.round(estimatedW * 10) / 10, cpuLoad: Math.round(cpuLoad), memUsed: Math.round(memUsed), topApps };
  } catch (e) {
    // Fallback if systeminformation unavailable
    return { watts: tdpWatts * 0.3, cpuLoad: 30, memUsed: 50, topApps: [] };
  }
}

// ─── Monitoring loop ───────────────────────────────────────────────────────
async function runMonitor() {
  dataStore = loadData();
  const tdp = dataStore.settings.tdpWatts || 65;

  const result = await estimatePowerAndApps(tdp);
  const now = Date.now();
  const elapsed = (now - lastSampleTime) / 1000 / 3600; // hours
  lastSampleTime = now;

  const whGained = result.watts * elapsed;
  accumulatedWh += whGained;
  dataStore.totalWh = (dataStore.totalWh || 0) + whGained;

  // Track hourly data (last 24 hours)
  const hour = new Date().getHours();
  const today = new Date().toISOString().slice(0, 10);
  const hourKey = `${today}H${hour}`;

  const existing = dataStore.hourly.find(h => h.key === hourKey);
  if (existing) {
    existing.wh += whGained;
    existing.watts = result.watts;
  } else {
    dataStore.hourly.push({ key: hourKey, hour, date: today, wh: whGained, watts: result.watts });
    // Keep last 72 hours
    if (dataStore.hourly.length > 72) dataStore.hourly.shift();
  }

  // Track app usage
  for (const app of result.topApps) {
    if (!dataStore.appUsage[app.name]) {
      dataStore.appUsage[app.name] = { totalWh: 0, sessions: 0, name: app.name };
    }
    dataStore.appUsage[app.name].totalWh += app.estimatedW * elapsed;
    dataStore.appUsage[app.name].sessions++;
  }

  const totalKwh = dataStore.totalWh / 1000;
  const bill = calcBDTBill(totalKwh);
  const monthlyKwh = estimateMonthly(dataStore);

  saveData(dataStore);

  const payload = {
    watts: result.watts,
    cpuLoad: result.cpuLoad,
    memUsed: result.memUsed,
    topApps: result.topApps,
    totalWh: dataStore.totalWh,
    totalKwh: Math.round(totalKwh * 1000) / 1000,
    currentBill: bill,
    projectedMonthly: Math.round(calcBDTBill(monthlyKwh) * 100) / 100,
    projectedKwh: Math.round(monthlyKwh * 100) / 100,
    hourly: dataStore.hourly.slice(-24),
    appUsage: Object.values(dataStore.appUsage)
      .sort((a, b) => b.totalWh - a.totalWh)
      .slice(0, 10)
      .map(a => ({ ...a, totalKwh: Math.round(a.totalWh / 1000 * 1000) / 1000 })),
    settings: dataStore.settings,
    startTime: dataStore.startTime,
    tariff: BD_TARIFF
  };

  // Check limits and notify
  if (dataStore.settings.alertsEnabled) {
    const limitBdt = dataStore.settings.limitBdt;
    const limitKwh = dataStore.settings.limitKwh;
    if (limitBdt && bill >= limitBdt * 0.9 && bill < limitBdt) {
      sendNotification('⚡ VoltWatch Warning', `90% of your BDT ${limitBdt} bill limit reached! Current: ৳${bill}`);
    }
    if (limitBdt && bill >= limitBdt) {
      sendNotification('🚨 VoltWatch ALERT', `LIMIT EXCEEDED! Bill: ৳${bill} / Limit: ৳${limitBdt}`);
    }
    if (limitKwh && totalKwh >= limitKwh * 0.9 && totalKwh < limitKwh) {
      sendNotification('⚡ VoltWatch Warning', `90% of your ${limitKwh} kWh limit reached!`);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update', payload);
  }
}

function estimateMonthly(data) {
  const elapsedHours = (Date.now() - data.startTime) / 1000 / 3600;
  if (elapsedHours < 0.1) return 0;
  const kwhPerHour = (data.totalWh / 1000) / elapsedHours;
  return kwhPerHour * 24 * 30;
}

function sendNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ─── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('get-data', () => {
  const d = loadData();
  return d;
});

ipcMain.handle('save-settings', (_, settings) => {
  dataStore = loadData();
  dataStore.settings = { ...dataStore.settings, ...settings };
  saveData(dataStore);
  return { ok: true };
});

ipcMain.handle('reset-data', () => {
  const newData = getDefaultData();
  newData.settings = dataStore ? dataStore.settings : newData.settings;
  newData.startTime = Date.now();
  dataStore = newData;
  accumulatedWh = 0;
  lastSampleTime = Date.now();
  saveData(dataStore);
  return { ok: true };
});

ipcMain.handle('get-system-info', async () => {
  try {
    const si = require('systeminformation');
    const [cpu, system, osInfo] = await Promise.all([
      si.cpu(),
      si.system(),
      si.osInfo()
    ]);
    return { cpu: `${cpu.manufacturer} ${cpu.brand}`, system: system.model, os: `${osInfo.distro} ${osInfo.release}` };
  } catch {
    return { cpu: os.cpus()[0]?.model || 'Unknown', system: 'Unknown', os: `${os.platform()} ${os.release()}` };
  }
});

// ─── App lifecycle ─────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#e0e0e0',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, '../assets/icon.ico')
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  dataStore = loadData();
  lastSampleTime = Date.now();

  // Start monitoring every 3 seconds
  runMonitor();
  monitorInterval = setInterval(runMonitor, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    clearInterval(monitorInterval);
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
