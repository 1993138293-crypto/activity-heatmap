"use strict";
/* ============================================================
   活动热力图 — 应用逻辑
   文件结构（自上而下）：
     一、存储与数据清洗        二、强度算法与索引
     三、统计与连续打卡        四、每日提醒
     五、界面状态与 DOM        六、主题
     七、渲染（统计/筛选/年/月/弹层）  八、视图切换与导航
     九、记录表单              十、全部记录页与备份
     十一、示例数据            十二、事件绑定与启动
   ============================================================ */

// ============================================================
// 一、存储与数据清洗
// ============================================================
const STORE_KEY = "heatmap.records.v1";        // 活动记录
const SETTINGS_KEY = "heatmap.settings.v1";    // 设置（标签颜色、提醒）
const FIRED_KEY = "heatmap.reminders.fired.v1";// 提醒「今天已发」记录
const WELCOME_KEY = "heatmap.welcome.v1";      // 是否已看过欢迎页
const THEME_KEY = "heatmap.theme.v1";          // 外观偏好
const PRESET_TAGS = ["运动", "学习", "健康", "工作", "生活"];
const MAX_TAGS_PER_RECORD = 5;

let records = {};   // { "2026-08-14": [ {id, title, note, level, duration, tags, time}, ... ] }
let settings = {};  // { tagColors: {标签名: 色号0-7}, reminders: [...] }
let fired = {};     // { 提醒id: "YYYY-MM-DD" }

// 数据清洗：过滤非法日期键与非法记录，补齐新字段（tags/duration），保证渲染不因脏数据崩溃
function sanitizeRecords(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const list = Array.isArray(obj[k])
      ? obj[k].filter(r => r && typeof r.title === "string" && r.title.trim())
      : [];
    if (!list.length) continue;
    out[k] = list.map(r => ({
      id: String(r.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      title: String(r.title).trim(),
      note: typeof r.note === "string" ? r.note : "",
      level: Math.min(4, Math.max(1, Number(r.level) || 1)),
      duration: (r.duration === null || r.duration === undefined || r.duration === "")
        ? null : Math.min(1440, Math.max(1, Math.round(Number(r.duration) || 0))) || null,
      tags: Array.isArray(r.tags)
        ? r.tags.map(t => String(t).trim()).filter(Boolean).slice(0, MAX_TAGS_PER_RECORD)
        : [],
      time: typeof r.time === "string" ? r.time : "",
    }));
  }
  return out;
}
function sanitizeSettings(s) {
  const out = { tagColors: {}, reminders: [] };
  if (!s || typeof s !== "object") return out;
  if (s.tagColors && typeof s.tagColors === "object") {
    for (const k of Object.keys(s.tagColors)) {
      const n = Number(s.tagColors[k]);
      if (Number.isInteger(n) && n >= 0 && n <= 7) out.tagColors[k] = n;
    }
  }
  if (Array.isArray(s.reminders)) {
    for (const r of s.reminders) {
      if (!r || typeof r !== "object") continue;
      const time = typeof r.time === "string" && /^\d{2}:\d{2}$/.test(r.time) ? r.time : null;
      const days = Array.isArray(r.days) && r.days.length === 7
        ? r.days.map(Boolean) : null;
      if (!time || !days) continue;
      out.reminders.push({
        id: String(r.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        time,
        text: (typeof r.text === "string" && r.text.trim()) || "记得记录今天的活动",
        days,
        enabled: r.enabled !== false,
      });
    }
  }
  return out;
}

function loadRecords() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return sanitizeRecords(raw);
  } catch (e) { /* 数据损坏时按空数据开始 */ }
  return {};
}
function saveRecords() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(records)); }
  catch (e) { alert("保存失败：浏览器存储不可用，请及时导出备份。"); }
}
function loadSettings() {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); }
  catch (e) { return sanitizeSettings(null); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (e) { /* 设置保存失败不阻塞主流程 */ }
}
function loadFired() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) { return {}; }
}
function saveFired() {
  // 只保留今天与昨天的记录，避免无限膨胀
  const today = fmtKey(todayDate());
  const yesterday = fmtKey(addDays(todayDate(), -1));
  for (const k of Object.keys(fired)) {
    if (fired[k] !== today && fired[k] !== yesterday) delete fired[k];
  }
  try { localStorage.setItem(FIRED_KEY, JSON.stringify(fired)); }
  catch (e) { /* 忽略 */ }
}

// ============================================================
// 二、强度算法与索引
// ============================================================
// 单条记录得分 = 强度 × 时长系数；时长系数 = 1 + 0.5 × min(1, 分钟/60)
// （即：记录满 1 小时，分值 ×1.5；半小时 ×1.25；未填时长系数为 1）
function recordScore(r) {
  const minutes = Number(r.duration) || 0;
  return Number(r.level) * (1 + 0.5 * Math.min(1, minutes / 60));
}
// 当天总分 → 0-4 级颜色映射。区间设计保证：
// 不填时长的单条记录 1/2/3/4 级显示仍为 1/2/3/4 级（向后兼容，不会“降级”）
function levelFromScore(s) {
  if (s <= 0) return 0;
  if (s <= 1.5) return 1;
  if (s <= 2.5) return 2;
  if (s <= 3.5) return 3;
  return 4;
}

// 预计算索引：数据变动时重建一次，渲染时直接查表（性能优化，数据越多提速越明显）
let index = { byDay: new Map(), tags: new Map(), totalRecords: 0 };
function rebuildIndex() {
  const byDay = new Map();
  const tags = new Map();
  let totalRecords = 0;
  for (const key of Object.keys(records)) {
    const list = records[key];
    if (!list || !list.length) continue;
    let score = 0;
    for (const r of list) {
      totalRecords++;
      score += recordScore(r);
      for (const t of r.tags || []) {
        tags.set(t, (tags.get(t) || 0) + 1);
      }
    }
    byDay.set(key, { score, level: levelFromScore(score), count: list.length });
  }
  index = { byDay, tags, totalRecords };
  ensureTagColors();
}
// 标签颜色固定跟随标签本身（不随筛选/排序变化），首次出现时分配色号
function ensureTagColors() {
  let changed = false;
  const used = new Set(Object.values(settings.tagColors));
  for (const tag of index.tags.keys()) {
    if (settings.tagColors[tag] !== undefined) continue;
    let slot = -1;
    for (let i = 0; i < 8; i++) {
      if (!used.has(i)) { slot = i; break; }
    }
    if (slot === -1) {
      // 超过 8 个标签时复用色号：按名字字符码求和取模，保持稳定
      let sum = 0;
      for (let i = 0; i < tag.length; i++) sum += tag.charCodeAt(i);
      slot = sum % 8;
    }
    settings.tagColors[tag] = slot;
    used.add(slot);
    changed = true;
  }
  if (changed) saveSettings();
}
function tagColorOf(tag) { return settings.tagColors[tag] || 0; }

// 某天汇总：不传 tag 时走索引（快）；传 tag 时对该天记录做过滤扫描
function daySummary(key, tag) {
  if (!tag) {
    const d = index.byDay.get(key);
    return d ? { count: d.count, level: d.level, score: d.score }
             : { count: 0, level: 0, score: 0 };
  }
  const list = records[key] || [];
  let score = 0, count = 0;
  for (const r of list) {
    if ((r.tags || []).includes(tag)) { score += recordScore(r); count++; }
  }
  return { count, level: levelFromScore(score), score };
}

// 记录增删改的统一入口：每次变动 → 存盘 → 重建索引 → 刷新界面
function commit() {
  saveRecords();
  rebuildIndex();
  refreshAll();
}
function addRecord(key, rec) {
  (records[key] || (records[key] = [])).push(rec);
  commit();
}
function updateRecord(key, id, patch) {
  const r = (records[key] || []).find(x => x.id === id);
  if (r) Object.assign(r, patch);
  commit();
}
function deleteRecord(key, id) {
  records[key] = (records[key] || []).filter(x => x.id !== id);
  if (!records[key].length) delete records[key];
  commit();
}
function replaceAllRecords(recs) {
  records = sanitizeRecords(recs);
  commit();
}

// ============================================================
// 三、统计与连续打卡
// ============================================================
function yearStats(y, tag) {
  let days = 0, total = 0, best = 0, run = 0;
  const d0 = new Date(y, 0, 1);
  const n = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  for (let i = 0; i < n; i++) {
    const s = daySummary(fmtKey(addDays(d0, i)), tag);
    if (s.count > 0) { days++; total += s.count; run++; best = Math.max(best, run); }
    else run = 0;
  }
  return { days, total, best };
}
// 当前连续打卡天数（今天无记录时从昨天起算，符合常见习惯）
function currentStreak(tag) {
  const today = fmtKey(todayDate());
  let d = parseKey(today);
  if (daySummary(fmtKey(d), tag).count === 0) d = addDays(d, -1);
  let streak = 0;
  while (daySummary(fmtKey(d), tag).count > 0) { streak++; d = addDays(d, -1); }
  return streak;
}

// ============================================================
// 四、每日提醒
// ============================================================
// 推送通道（待部署）：
//   部署到 HTTPS 服务器并安装到手机主屏后，在此接入 Web Push——
//   ① 注册 service worker（sw.js）监听 push 事件并弹出系统通知
//   ② 用户保存提醒时调用 Notification.requestPermission + pushManager.subscribe
//   ③ 把订阅信息发送给后端（或免费推送服务），由后端按提醒时间定时推送
//   接入后把 PUSH_READY 改为 true 并实现 deliverReminderViaPush()。
const PUSH_READY = false;
function deliverReminderViaPush(reminder) {
  /* 部署后实现：通过推送服务发送 reminder.text */
  return false;
}

// 判断某个提醒此刻是否应触发（纯函数，便于测试）
// date: Date 对象；hh/mm: 当前时分；firedToday: 今天是否已发过
function isReminderDue(rem, date, hh, mm, firedToday) {
  if (!rem || !rem.enabled) return false;
  const dow = (date.getDay() + 6) % 7;   // 0 = 周一
  if (!rem.days[dow]) return false;
  const [rh, rm] = rem.time.split(":").map(Number);
  if (hh < rh || (hh === rh && mm < rm)) return false;
  return !firedToday;
}

function checkReminders() {
  const now = new Date();
  const date = todayDate();
  for (const rem of settings.reminders || []) {
    const firedToday = fired[rem.id] === fmtKey(date);
    if (isReminderDue(rem, date, now.getHours(), now.getMinutes(), firedToday)) {
      fired[rem.id] = fmtKey(date);
      saveFired();
      fireReminder(rem);
    }
  }
}
function fireReminder(rem) {
  const todayCount = daySummary(fmtKey(todayDate())).count;
  showBanner(rem.text, todayCount > 0
    ? "今天已记录 " + todayCount + " 条，继续保持！"
    : "今天还没有记录，别让打卡断掉哦");
  // 桌面浏览器系统通知（页面打开时生效；iPhone 推送待部署后接入）
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification("活动热力图提醒", { body: rem.text, tag: "heatmap-reminder" });
    } catch (e) { /* 忽略通知失败 */ }
  }
}
function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    try { Notification.requestPermission(); } catch (e) { /* 忽略 */ }
  }
}

// 提醒横幅（应用内，iOS 通知样式）
let bannerTimer = null;
function showBanner(text, sub) {
  els.bannerText.textContent = text;
  els.bannerSub.textContent = sub;
  els.banner.hidden = false;
  void els.banner.offsetHeight;
  els.banner.classList.add("show");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 10000);
}
function hideBanner() {
  clearTimeout(bannerTimer);
  els.banner.classList.remove("show");
  setTimeout(() => { els.banner.hidden = true; }, 400);
}

// ============================================================
// 五、界面状态与 DOM
// ============================================================
const now = new Date();
const state = {
  view: "year",                 // "year" | "month"
  year: now.getFullYear(),      // 年视图光标
  month: { y: now.getFullYear(), m: now.getMonth() }, // 月视图光标
  filter: null,                 // 当前标签筛选（null = 全部）
  sheet: { open: false, key: null },                  // 底部弹层
  form: { mode: "add", key: null, id: null },         // 记录表单状态
  remForm: { mode: "add", id: null },                 // 提醒表单状态
};
const TILE_LABELS = { days: "有记录的日期", streak: "从今天往前连续", best: "本年度最长记录", total: "本年度累计条数" };

const $ = (id) => document.getElementById(id);
const els = {
  tiles: $("tiles"), statsYear: $("stats-year"),
  stDays: $("st-days"), stStreak: $("st-streak"), stBest: $("st-best"), stTotal: $("st-total"),
  stDaysSub: $("st-days-sub"), stStreakSub: $("st-streak-sub"),
  stBestSub: $("st-best-sub"), stTotalSub: $("st-total-sub"),
  seg: $("seg"), segThumb: $("seg-thumb"),
  segYear: $("seg-year"), segMonth: $("seg-month"),
  filterRow: $("filter-row"),
  chartTitle: $("chart-title"),
  yearView: $("year-view"), monthView: $("month-view"),
  yearScroll: $("year-scroll"), yearGrid: $("year-grid"), monthLabels: $("month-labels"),
  monthGrid: $("month-grid"),
  backdrop: $("backdrop"), sheet: $("sheet"),
  sheetDay: $("sheet-day"), sheetForm: $("sheet-form"),
  sheetRemind: $("sheet-remind"), sheetRemindForm: $("sheet-remind-form"),
  sheetDate: $("sheet-date"), sheetDateSub: $("sheet-date-sub"),
  recList: $("rec-list"), formTitle: $("form-title"),
  fTitle: $("f-title"), fNote: $("f-note"), fSave: $("f-save"), fDelete: $("f-delete"),
  fDuration: $("f-duration"), tagPick: $("tag-pick"), fTagInput: $("f-tag-input"),
  levelCap: $("level-cap"),
  remindSub: $("remind-sub"), remindNote: $("remind-note"), remList: $("rem-list"),
  remformTitle: $("remform-title"), fRemTime: $("f-rem-time"), fRemText: $("f-rem-text"),
  weekdayPick: $("weekday-pick"), remformSave: $("remform-save"), remformDelete: $("remform-delete"),
  banner: $("banner"), bannerText: $("banner-text"), bannerSub: $("banner-sub"),
  listview: $("listview"), listBody: $("list-body"), listCount: $("list-count"),
  tooltip: $("tooltip"), welcome: $("welcome"), fileInput: $("file-input"),
  icTheme: $("ic-theme"),
};

// ============================================================
// 六、主题（自动 / 浅色 / 深色）
// ============================================================
function currentTheme() { return localStorage.getItem(THEME_KEY) || "auto"; }
function applyTheme() {
  const t = currentTheme();
  document.documentElement.removeAttribute("data-theme");
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
  const svg = els.icTheme;
  if (t === "light") {
    svg.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  } else if (t === "dark") {
    svg.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>';
  } else {
    svg.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>';
  }
}

// ============================================================
// 七、渲染
// ============================================================
function renderStats() {
  const y = state.year;
  const tag = state.filter;
  const s = yearStats(y, tag);
  const streak = currentStreak(tag);
  els.statsYear.textContent = y + " 年 · 年度统计" + (tag ? " · 只看「" + tag + "」" : "");
  els.stDays.textContent = s.days;
  els.stStreak.textContent = streak;
  els.stBest.textContent = s.best;
  els.stTotal.textContent = s.total;
  els.stDaysSub.textContent = TILE_LABELS.days;
  els.stStreakSub.textContent = TILE_LABELS.streak;
  els.stBestSub.textContent = TILE_LABELS.best;
  els.stTotalSub.textContent = TILE_LABELS.total;
}

// 标签筛选条：全部 + 各标签（按记录数降序）
function renderFilters() {
  const tags = [...index.tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  // 当前筛选的标签已不存在时自动复位
  if (state.filter && !index.tags.has(state.filter)) state.filter = null;
  els.filterRow.innerHTML = "";
  els.filterRow.appendChild(makeFilterChip(null, "全部", index.totalRecords, !state.filter));
  for (const [tag, count] of tags) {
    els.filterRow.appendChild(makeFilterChip(tag, tag, count, state.filter === tag));
  }
  els.filterRow.hidden = tags.length === 0;   // 没有任何标签时不显示筛选条
}
function makeFilterChip(tag, label, count, selected) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fchip" + (selected ? " sel" : "");
  if (tag) {
    const dot = document.createElement("span");
    dot.className = "dot t" + tagColorOf(tag);
    b.appendChild(dot);
  }
  const name = document.createElement("span");
  name.textContent = label;
  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = count;
  b.appendChild(name); b.appendChild(cnt);
  b.setAttribute("aria-pressed", selected);
  b.addEventListener("click", () => {
    state.filter = tag;
    renderFilters(); renderStats();
    if (state.view === "year") renderYear(); else renderMonth();
    if (state.sheet.open && !els.sheetDay.hidden) renderSheetDay();
    if (!els.listview.hidden) renderList();
  });
  return b;
}

function renderTitle() {
  if (state.view === "year") els.chartTitle.textContent = state.year + " 年";
  else els.chartTitle.textContent = state.month.y + " 年 " + (state.month.m + 1) + " 月";
}

// ---- 年视图（GitHub 贡献图风格） ----
function yearWeeks(y) {
  const jan1 = new Date(y, 0, 1);
  const offset = (jan1.getDay() + 6) % 7; // 周一为一周起点
  const days = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  return Math.ceil((offset + days) / 7);
}
function yearStartDate(y) {
  const jan1 = new Date(y, 0, 1);
  return addDays(jan1, -((jan1.getDay() + 6) % 7));
}

const HOVER_TOOLTIP = window.matchMedia("(hover: hover)").matches;
function showTooltip(e, key) {
  const s = daySummary(key, state.filter);
  const d = parseKey(key);
  const text = (d.getMonth() + 1) + "月" + d.getDate() + "日";
  const sub = s.count ? "强度 " + s.level + " · " + s.count + " 条记录" : "无记录";
  els.tooltip.innerHTML = "";
  const b = document.createElement("b"); b.textContent = text; els.tooltip.appendChild(b);
  const sp = document.createElement("span"); sp.className = "t-sub";
  sp.textContent = " " + sub; els.tooltip.appendChild(sp);
  els.tooltip.hidden = false;
  moveTooltip(e);
}
function moveTooltip(e) {
  const w = els.tooltip.offsetWidth, h = els.tooltip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - 10;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - 10;
  els.tooltip.style.left = x + "px";
  els.tooltip.style.top = y + "px";
}
function hideTooltip() { els.tooltip.hidden = true; }

function renderYear() {
  const y = state.year;
  const tag = state.filter;
  const todayKey = fmtKey(todayDate());
  const start = yearStartDate(y);
  const weeks = yearWeeks(y);
  const canvas = els.yearGrid;
  canvas.innerHTML = "";
  canvas.style.width = (weeks * 14 - 2) + "px";

  const labels = els.monthLabels;
  labels.innerHTML = "";
  labels.style.width = (weeks * 14 - 2) + "px";
  for (let m = 0; m < 12; m++) {
    const first = new Date(y, m, 1);
    if (first.getFullYear() !== y) continue;
    const col = Math.floor(diffDays(first, start) / 7);
    const span = document.createElement("span");
    span.textContent = (m + 1) + "月";
    span.style.left = (col * 14) + "px";
    labels.appendChild(span);
  }

  for (let d = 0; d < weeks * 7; d++) {
    const date = addDays(start, d);
    const key = fmtKey(date);
    const inYear = date.getFullYear() === y;
    const cell = document.createElement("div");
    if (!inYear) {
      cell.className = "cell blank";
    } else {
      const future = key > todayKey;
      const s = daySummary(key, tag);
      cell.className = "cell" + (s.level ? " l" + s.level : "") + (future ? " future" : " clickable");
      if (key === todayKey) cell.classList.add("today");
      if (!future) {
        cell.addEventListener("click", () => openSheet(key));
        if (HOVER_TOOLTIP) {
          cell.addEventListener("mouseenter", (e) => showTooltip(e, key));
          cell.addEventListener("mousemove", moveTooltip);
          cell.addEventListener("mouseleave", hideTooltip);
        }
      }
    }
    canvas.appendChild(cell);
  }

  if (y === now.getFullYear()) {
    const col = Math.floor(diffDays(todayDate(), start) / 7);
    els.yearScroll.scrollLeft = Math.max(0, col * 14 - els.yearScroll.clientWidth / 2);
  } else {
    els.yearScroll.scrollLeft = 0;
  }
}

// ---- 月视图（iOS 日历风格） ----
function renderMonth() {
  const { y, m } = state.month;
  const tag = state.filter;
  const todayKey = fmtKey(todayDate());
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const grid = els.monthGrid;
  grid.innerHTML = "";

  for (let i = 0; i < rows * 7; i++) {
    const date = addDays(start, i);
    const key = fmtKey(date);
    const inMonth = date.getMonth() === m && date.getFullYear() === y;
    const s = daySummary(key, tag);
    const future = key > todayKey;
    const cell = document.createElement("button");
    cell.type = "button";
    let cls = "mcell";
    if (!inMonth) cls += " adj";
    if (s.level) cls += " l" + s.level;
    if (future) cls += " future";
    if (key === todayKey) cls += " today";
    if (!future) cls += " clickable";
    cell.className = cls;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = date.getDate();
    cell.appendChild(num);
    if (!future) {
      cell.setAttribute("aria-label",
        (date.getMonth() + 1) + "月" + date.getDate() + "日，" +
        (s.count ? "强度" + s.level + "，" + s.count + "条记录" : "无记录"));
      cell.addEventListener("click", () => openSheet(key));
      if (HOVER_TOOLTIP) {
        cell.addEventListener("mouseenter", (e) => showTooltip(e, key));
        cell.addEventListener("mousemove", moveTooltip);
        cell.addEventListener("mouseleave", hideTooltip);
      }
    }
    grid.appendChild(cell);
  }
}

// 数据变化后统一刷新（保持所有可见模块一致）
function refreshAll() {
  renderStats();
  renderFilters();
  renderTitle();
  if (state.view === "year") renderYear(); else renderMonth();
  if (state.sheet.open) {
    if (!els.sheetDay.hidden) renderSheetDay();
    if (!els.sheetRemind.hidden) renderReminders();
  }
  if (!els.listview.hidden) renderList();
}

// ============================================================
// 八、视图切换与导航
// ============================================================
function setView(v) {
  state.view = v;
  els.segYear.classList.toggle("active", v === "year");
  els.segMonth.classList.toggle("active", v === "month");
  els.segYear.setAttribute("aria-selected", v === "year");
  els.segMonth.setAttribute("aria-selected", v === "month");
  els.segThumb.style.transform = v === "month" ? "translateX(100%)" : "translateX(0)";
  els.yearView.hidden = v !== "year";
  els.monthView.hidden = v !== "month";
  renderTitle();
  if (v === "year") renderYear(); else renderMonth();
}
function changeYear(d) {
  const y = state.year + d;
  if (y < 2000 || y > now.getFullYear()) return;
  state.year = y;
  renderStats(); renderTitle(); renderYear();
}
function changeMonth(d) {
  let { y, m } = state.month;
  m += d;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  if (y < 2000) return;
  // 只拦截「向前」进入未来：目标月份晚于当前月份时拒绝；
  // 向后回退不受限（允许从任何位置往回浏览历史）
  if (d > 0) {
    const curY = now.getFullYear(), curM = now.getMonth();
    if (y > curY || (y === curY && m > curM)) return;
  }
  state.month = { y, m };
  renderTitle(); renderMonth();
}

// 月视图左右滑动切换月份
let touch = null;
els.monthGrid.addEventListener("touchstart", (e) => {
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
els.monthGrid.addEventListener("touchend", (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
    changeMonth(dx < 0 ? 1 : -1);
  }
}, { passive: true });

// ============================================================
// 九、弹层：详情 / 记录表单 / 提醒设置
// ============================================================
function showSheetSection(mode) {
  els.sheetDay.hidden = mode !== "day";
  els.sheetForm.hidden = mode !== "form";
  els.sheetRemind.hidden = mode !== "remind";
  els.sheetRemindForm.hidden = mode !== "remindform";
}
function showSheet() {
  els.backdrop.hidden = false;
  els.sheet.hidden = false;
  // 强制浏览器先以「屏幕外」初始状态布局一帧，再加 .show 触发滑入动画
  // （不依赖 requestAnimationFrame，任何环境下都可靠）
  void els.sheet.offsetHeight;
  els.backdrop.classList.add("show");
  els.sheet.classList.add("show");
}
function openSheet(key) {
  state.sheet = { open: true, key };
  state.form = { mode: "add", key, id: null };
  showSheetSection("day");
  renderSheetDay();
  showSheet();
  hideTooltip();
}
function closeSheet() {
  state.sheet.open = false;
  els.backdrop.classList.remove("show");
  els.sheet.classList.remove("show");
  setTimeout(() => { els.backdrop.hidden = true; els.sheet.hidden = true; }, 330);
}

// ---- 当日详情 ----
function renderSheetDay() {
  const key = state.sheet.key;
  const tag = state.filter;
  const d = parseKey(key);
  const s = daySummary(key, tag);
  els.sheetDate.textContent = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  const scoreText = Math.round(s.score * 10) / 10;
  els.sheetDateSub.textContent = WEEKDAYS[d.getDay()] +
    (s.count ? " · 强度 " + s.level + " · 得分 " + scoreText + " · " + s.count + " 条记录"
             : " · 还没有记录") +
    (tag ? "（只看「" + tag + "」）" : "");
  const list = (records[key] || []).filter(r => !tag || (r.tags || []).includes(tag));
  els.recList.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = tag
      ? "这一天没有「" + tag + "」标签的记录。"
      : "这一天还没有记录。\n点击上方按钮，记录你的第一项活动吧！";
    els.recList.appendChild(p);
    return;
  }
  const sorted = [...list].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  for (const r of sorted) {
    const btn = document.createElement("button");
    btn.className = "rec";
    btn.type = "button";
    btn.addEventListener("click", () => openForm("edit", key, r.id));

    const top = document.createElement("div");
    top.className = "rec-top";
    const title = document.createElement("span");
    title.className = "rec-title"; title.textContent = r.title;
    const meta = document.createElement("span");
    meta.className = "rec-meta";
    meta.appendChild(levelDots(r.level));
    const time = document.createElement("span");
    time.className = "rec-time"; time.textContent = r.time || "";
    meta.appendChild(time);
    top.appendChild(title); top.appendChild(meta);
    btn.appendChild(top);

    if ((r.tags || []).length || r.duration) {
      const extra = document.createElement("div");
      extra.className = "rec-extra";
      if (r.duration) {
        const dur = document.createElement("span");
        dur.className = "dur"; dur.textContent = r.duration + " 分钟";
        extra.appendChild(dur);
      }
      for (const t of r.tags || []) extra.appendChild(makeMiniTag(t));
      btn.appendChild(extra);
    }
    if (r.note) {
      const note = document.createElement("div");
      note.className = "rec-note"; note.textContent = r.note;
      btn.appendChild(note);
    }
    els.recList.appendChild(btn);
  }
}
function makeMiniTag(tag) {
  const s = document.createElement("span");
  s.className = "mini-tag";
  const dot = document.createElement("span");
  dot.className = "dot t" + tagColorOf(tag);
  const name = document.createElement("span");
  name.textContent = tag;
  s.appendChild(dot); s.appendChild(name);
  return s;
}
function levelDots(level) {
  const dots = document.createElement("span");
  dots.className = "dots";
  for (let i = 1; i <= 4; i++) {
    const d = document.createElement("i");
    if (i <= level) d.className = "on";
    dots.appendChild(d);
  }
  return dots;
}

// ---- 记录表单 ----
let formLevel = 2;
let formTags = [];
function setLevel(lv) {
  formLevel = lv;
  document.querySelectorAll(".level-btn").forEach((b) => {
    b.classList.toggle("sel", Number(b.dataset.lv) === lv);
    b.setAttribute("aria-pressed", Number(b.dataset.lv) === lv);
  });
  els.levelCap.textContent = LEVEL_NAMES[lv];
}
function knownTags() {
  const set = new Set(PRESET_TAGS);
  for (const t of index.tags.keys()) set.add(t);
  for (const t of formTags) set.add(t);
  const arr = [...set];
  // 已有标签按使用次数降序，预设新标签排后面
  arr.sort((a, b) => (index.tags.get(b) || 0) - (index.tags.get(a) || 0));
  return arr;
}
function renderTagPick() {
  els.tagPick.innerHTML = "";
  for (const t of knownTags()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tag-chip" + (formTags.includes(t) ? " sel" : "");
    b.setAttribute("aria-pressed", formTags.includes(t));
    const dot = document.createElement("span");
    dot.className = "dot t" + tagColorOf(t);
    const name = document.createElement("span");
    name.textContent = t;
    b.appendChild(dot); b.appendChild(name);
    b.addEventListener("click", () => {
      if (formTags.includes(t)) formTags = formTags.filter(x => x !== t);
      else if (formTags.length >= MAX_TAGS_PER_RECORD) {
        alert("每条记录最多 " + MAX_TAGS_PER_RECORD + " 个标签");
        return;
      }
      else formTags.push(t);
      renderTagPick();
    });
    els.tagPick.appendChild(b);
  }
}
function openForm(mode, key, id) {
  state.form = { mode, key, id: id || null };
  const r = mode === "edit" ? (records[key] || []).find(x => x.id === id) : null;
  showSheetSection("form");
  els.formTitle.textContent = mode === "edit" ? "编辑记录" : "添加记录";
  els.fTitle.value = r ? r.title : "";
  els.fNote.value = r ? (r.note || "") : "";
  els.fDuration.value = r && r.duration ? r.duration : "";
  els.fDelete.hidden = mode !== "edit";
  formTags = r ? [...(r.tags || [])]
    : (state.filter ? [state.filter] : []);   // 筛选状态下新记录默认带上该标签
  setLevel(r ? r.level : 2);
  renderTagPick();
  updateSaveState();
  setTimeout(() => els.fTitle.focus(), 350);
}
function updateSaveState() { els.fSave.disabled = els.fTitle.value.trim() === ""; }
function syncDurationChips() {
  document.querySelectorAll(".dchip").forEach((b) => {
    b.classList.toggle("sel", Number(b.dataset.min) === Number(els.fDuration.value));
  });
}

// ---- 提醒设置 ----
let remDays = [true, true, true, true, true, true, true];
const REM_DAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];
function renderReminders() {
  const rems = settings.reminders || [];
  els.remindSub.textContent = "共 " + rems.length + " 个提醒";
  const todayCount = daySummary(fmtKey(todayDate())).count;
  els.remindNote.textContent = todayCount > 0
    ? "今天已记录 " + todayCount + " 条，当前连续 " + currentStreak() + " 天。"
    : "今天还没有记录，当前连续 " + currentStreak() + " 天。";
  els.remList.innerHTML = "";
  if (!rems.length) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "还没有提醒。\n点击下方按钮，设置每天几点提醒你打卡。";
    els.remList.appendChild(p);
    return;
  }
  for (const rem of rems) {
    const row = document.createElement("div");
    row.className = "rem-row" + (rem.enabled ? "" : " rem-off");

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "rem-edit";
    edit.addEventListener("click", () => openReminderForm("edit", rem.id));
    const time = document.createElement("div");
    time.className = "rem-time"; time.textContent = rem.time;
    const text = document.createElement("div");
    text.className = "rem-text"; text.textContent = rem.text;
    const days = document.createElement("div");
    days.className = "rem-days";
    days.textContent = rem.days.map((on, i) => on ? REM_DAY_NAMES[i] : "·").join(" ");
    edit.appendChild(time); edit.appendChild(text); edit.appendChild(days);

    const sw = document.createElement("label");
    sw.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rem.enabled;
    input.addEventListener("change", () => {
      rem.enabled = input.checked;
      saveSettings();
      renderReminders();
      if (rem.enabled) { checkReminders(); ensureNotificationPermission(); }
    });
    const i = document.createElement("i");
    sw.appendChild(input); sw.appendChild(i);

    row.appendChild(edit); row.appendChild(sw);
    els.remList.appendChild(row);
  }
}
function openReminders() {
  state.sheet.open = true;
  showSheetSection("remind");
  renderReminders();
  showSheet();
}
function openReminderForm(mode, id) {
  state.remForm = { mode, id: id || null };
  const r = mode === "edit" ? (settings.reminders || []).find(x => x.id === id) : null;
  showSheetSection("remindform");
  els.remformTitle.textContent = mode === "edit" ? "编辑提醒" : "添加提醒";
  els.fRemTime.value = r ? r.time : "20:00";
  els.fRemText.value = r ? r.text : "记得记录今天的活动";
  els.remformDelete.hidden = mode !== "edit";
  remDays = r ? [...r.days] : [true, true, true, true, true, true, true];
  renderRemDays();
}
function renderRemDays() {
  document.querySelectorAll(".wchip").forEach((b) => {
    b.classList.toggle("sel", remDays[Number(b.dataset.d)]);
  });
}
function saveReminderForm() {
  const time = els.fRemTime.value;
  if (!time) { alert("请选择提醒时间"); return; }
  if (!remDays.some(Boolean)) { alert("请至少选择一天"); return; }
  const text = els.fRemText.value.trim() || "记得记录今天的活动";
  if (state.remForm.mode === "edit") {
    const r = (settings.reminders || []).find(x => x.id === state.remForm.id);
    if (r) { r.time = time; r.text = text; r.days = remDays; }
  } else {
    settings.reminders = settings.reminders || [];
    settings.reminders.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time, text, days: remDays, enabled: true,
    });
  }
  saveSettings();
  ensureNotificationPermission();
  checkReminders();
  showSheetSection("remind");
  renderReminders();
}

// ============================================================
// 十、全部记录页与备份
// ============================================================
function openList() {
  renderList();
  els.listview.hidden = false;
  void els.listview.offsetHeight;
  els.listview.classList.add("show");
}
function closeList() {
  els.listview.classList.remove("show");
  setTimeout(() => { els.listview.hidden = true; }, 310);
}
function renderList() {
  const tag = state.filter;
  const keys = Object.keys(records).sort().reverse();
  let total = 0;
  els.listBody.innerHTML = "";
  let lastGroup = "";
  for (const key of keys) {
    const list = (records[key] || []).filter(r => !tag || (r.tags || []).includes(tag));
    if (!list.length) continue;
    total += list.length;
    const d = parseKey(key);
    const group = d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月";
    if (group !== lastGroup) {
      lastGroup = group;
      const g = document.createElement("div");
      g.className = "lgroup"; g.textContent = group;
      els.listBody.appendChild(g);
    }
    for (const r of list) {
      const row = document.createElement("button");
      row.className = "lrow"; row.type = "button";
      row.addEventListener("click", () => { closeList(); setTimeout(() => openSheet(key), 320); });
      const day = document.createElement("span");
      day.className = "lrow-day";
      const b = document.createElement("b"); b.textContent = d.getDate();
      const wd = document.createElement("span"); wd.textContent = WEEKDAYS[d.getDay()];
      day.appendChild(b); day.appendChild(wd);
      const main = document.createElement("span");
      main.className = "lrow-main";
      const t = document.createElement("div"); t.className = "lrow-title"; t.textContent = r.title;
      main.appendChild(t);
      if ((r.tags || []).length || r.duration) {
        const meta = document.createElement("div");
        meta.className = "lrow-meta";
        if (r.duration) {
          const dur = document.createElement("span");
          dur.className = "mini-tag"; dur.textContent = r.duration + " 分钟";
          meta.appendChild(dur);
        }
        for (const tg of r.tags || []) meta.appendChild(makeMiniTag(tg));
        main.appendChild(meta);
      }
      if (r.note) {
        const note = document.createElement("div");
        note.className = "lrow-note"; note.textContent = r.note;
        main.appendChild(note);
      }
      const side = document.createElement("span");
      side.className = "lrow-side";
      side.appendChild(levelDots(r.level));
      if (r.time) {
        const time = document.createElement("span");
        time.className = "rec-time"; time.textContent = r.time;
        side.appendChild(time);
      }
      row.appendChild(day); row.appendChild(main); row.appendChild(side);
      els.listBody.appendChild(row);
    }
  }
  els.listCount.textContent = total ? "共 " + total + " 条" : "";
  if (!total) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = tag
      ? "没有带「" + tag + "」标签的记录。"
      : "还没有任何记录。\n回到主页，点击任意日期开始记录吧！";
    els.listBody.appendChild(p);
  }
}

// ============================================================
// 十一、示例数据
// ============================================================
const SAMPLE_TITLES = [
  ["跑步 3 公里", ["运动"]], ["健身训练 45 分钟", ["运动"]], ["散步 40 分钟", ["运动"]],
  ["阅读 30 分钟", ["学习"]], ["背单词 20 个", ["学习"]], ["学习新技能", ["学习"]],
  ["冥想 10 分钟", ["健康"]], ["早睡打卡", ["健康"]], ["喝水 8 杯", ["健康"]],
  ["写日记", ["生活"]], ["整理房间", ["生活"]], ["练琴 1 小时", ["生活"]],
];
const SAMPLE_NOTES = ["感觉不错", "状态一般", "坚持就是胜利", "有点累但完成了"];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sampleTime() { return pad(8 + Math.floor(Math.random() * 13)) + ":" + pad(Math.floor(Math.random() * 60)); }
function generateSampleData() {
  const recs = {};
  const today = todayDate();
  const add = (d, force) => {
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const p = isWeekend ? 0.3 : 0.52;
    if (!force && Math.random() > p) return;
    const n = 1 + (Math.random() < 0.35 ? 1 : 0) + (Math.random() < 0.12 ? 1 : 0);
    const list = [];
    for (let k = 0; k < n; k++) {
      const [title, tags] = pick(SAMPLE_TITLES);
      list.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title,
        note: Math.random() < 0.25 ? pick(SAMPLE_NOTES) : "",
        level: 1 + Math.floor(Math.random() * 3.4),
        duration: Math.random() < 0.35 ? pick([15, 20, 30, 30, 45, 60, 60, 90, 120]) : null,
        tags: [...tags],
        time: sampleTime(),
      });
    }
    recs[fmtKey(d)] = list;
  };
  for (let i = 340; i >= 0; i--) {
    const d = addDays(today, -i);
    add(d, i <= 6);  // 最近一周保证连续，让「连续打卡」有数据
  }
  return recs;
}

// ============================================================
// 十二、事件绑定与启动
// ============================================================
function bindEvents() {
  // 主题
  $("btn-theme").addEventListener("click", () => {
    const order = { auto: "light", light: "dark", dark: "auto" };
    localStorage.setItem(THEME_KEY, order[currentTheme()]);
    applyTheme();
  });

  // 视图切换与导航
  els.seg.addEventListener("click", (e) => {
    if (e.target.id === "seg-year") setView("year");
    if (e.target.id === "seg-month") setView("month");
  });
  $("btn-prev").addEventListener("click", () => state.view === "year" ? changeYear(-1) : changeMonth(-1));
  $("btn-next").addEventListener("click", () => state.view === "year" ? changeYear(1) : changeMonth(1));
  $("btn-today").addEventListener("click", () => {
    if (state.view === "year") { state.year = now.getFullYear(); renderStats(); renderTitle(); renderYear(); }
    else { state.month = { y: now.getFullYear(), m: now.getMonth() }; renderTitle(); renderMonth(); }
  });
  $("btn-quick-add").addEventListener("click", () => openSheet(fmtKey(todayDate())));

  // 弹层通用
  $("sheet-close").addEventListener("click", closeSheet);
  els.backdrop.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.banner.hidden) { hideBanner(); return; }
    if (!els.listview.hidden) closeList();
    else if (state.sheet.open) closeSheet();
  });

  // 详情 → 表单
  $("btn-add-rec").addEventListener("click", () => openForm("add", state.sheet.key));
  $("f-cancel").addEventListener("click", () => { showSheetSection("day"); renderSheetDay(); });
  $("form-back").addEventListener("click", () => { showSheetSection("day"); renderSheetDay(); });
  $("form-close").addEventListener("click", closeSheet);

  // 表单字段
  document.querySelectorAll(".level-btn").forEach((b) =>
    b.addEventListener("click", () => setLevel(Number(b.dataset.lv))));
  els.fTitle.addEventListener("input", updateSaveState);
  els.fDuration.addEventListener("input", syncDurationChips);
  document.querySelectorAll(".dchip").forEach((b) =>
    b.addEventListener("click", () => { els.fDuration.value = b.dataset.min; syncDurationChips(); }));
  $("f-tag-add").addEventListener("click", () => {
    const t = els.fTagInput.value.trim();
    if (!t) return;
    if (t.length > 8) { alert("标签最多 8 个字"); return; }
    els.fTagInput.value = "";
    if (formTags.includes(t)) return;
    if (formTags.length >= MAX_TAGS_PER_RECORD) { alert("每条记录最多 " + MAX_TAGS_PER_RECORD + " 个标签"); return; }
    formTags.push(t);
    renderTagPick();
  });
  els.fTagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") $("f-tag-add").click(); });

  // 保存 / 删除记录
  els.fSave.addEventListener("click", () => {
    const title = els.fTitle.value.trim();
    if (!title) return;
    const key = state.form.key;
    const durRaw = els.fDuration.value.trim();
    const duration = durRaw === "" ? null
      : (Math.min(1440, Math.max(0, Math.round(Number(durRaw) || 0))) || null);
    const nowTime = new Date();
    const time = pad(nowTime.getHours()) + ":" + pad(nowTime.getMinutes());
    if (state.form.mode === "edit") {
      updateRecord(key, state.form.id, {
        title, note: els.fNote.value.trim(), level: formLevel, duration, tags: [...formTags],
      });
    } else {
      addRecord(key, {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title, note: els.fNote.value.trim(), level: formLevel, duration, tags: [...formTags], time,
      });
    }
    showSheetSection("day");
    renderSheetDay();
  });
  els.fDelete.addEventListener("click", () => {
    if (!confirm("确定删除这条记录吗？")) return;
    deleteRecord(state.form.key, state.form.id);
    showSheetSection("day");
    renderSheetDay();
  });

  // 提醒
  $("btn-reminders").addEventListener("click", openReminders);
  $("remind-close").addEventListener("click", closeSheet);
  $("btn-add-remind").addEventListener("click", () => openReminderForm("add"));
  $("remform-back").addEventListener("click", () => { showSheetSection("remind"); renderReminders(); });
  $("remform-cancel").addEventListener("click", () => { showSheetSection("remind"); renderReminders(); });
  $("remform-close").addEventListener("click", closeSheet);
  $("remform-save").addEventListener("click", saveReminderForm);
  $("remform-delete").addEventListener("click", () => {
    if (!confirm("确定删除这个提醒吗？")) return;
    settings.reminders = (settings.reminders || []).filter(x => x.id !== state.remForm.id);
    saveSettings();
    showSheetSection("remind");
    renderReminders();
  });
  els.weekdayPick.addEventListener("click", (e) => {
    const b = e.target.closest ? e.target.closest(".wchip") : null;
    if (!b) return;
    const d = Number(b.dataset.d);
    remDays[d] = !remDays[d];
    renderRemDays();
  });
  // 测试提醒按钮（放在添加按钮上方）
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "btn-plain";
  testBtn.textContent = "发送测试提醒";
  testBtn.addEventListener("click", () => {
    const rem = (settings.reminders || []).find(r => r.enabled) || { text: "记得记录今天的活动" };
    fireReminder(rem);
  });
  $("btn-add-remind").insertAdjacentElement("beforebegin", testBtn);

  // 提醒横幅
  $("banner-close").addEventListener("click", hideBanner);
  $("banner-open").addEventListener("click", () => { hideBanner(); openSheet(fmtKey(todayDate())); });

  // 全部记录页
  $("btn-list").addEventListener("click", openList);
  $("list-back").addEventListener("click", closeList);

  // 导出 / 导入 / 清空
  $("btn-export").addEventListener("click", () => {
    const data = { app: "activity-heatmap", version: 2, exportedAt: new Date().toISOString(), records, settings };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "活动热力图备份-" + fmtKey(todayDate()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("btn-import").addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const recs = data && typeof data === "object" && data.records && typeof data.records === "object" ? data.records : null;
        if (!recs) { alert("备份文件格式不正确。"); return; }
        if (!confirm("导入将覆盖当前的全部记录（共 " + Object.keys(records).length + " 天），确定继续吗？")) return;
        if (data.settings && typeof data.settings === "object") {
          settings = sanitizeSettings(data.settings);
          saveSettings();
        }
        replaceAllRecords(recs);
        renderList();
        alert("导入成功！");
      } catch (e) { alert("文件读取失败：不是有效的备份文件。"); }
    };
    reader.readAsText(file);
  });
  $("btn-clear").addEventListener("click", () => {
    if (!confirm("确定清空全部活动记录吗？此操作不可恢复，建议先导出备份。")) return;
    replaceAllRecords({});
    renderList();
  });

  // 欢迎层
  $("welcome-sample").addEventListener("click", () => {
    replaceAllRecords(generateSampleData());
    localStorage.setItem(WELCOME_KEY, "1");
    els.welcome.hidden = true;
  });
  $("welcome-empty").addEventListener("click", () => {
    localStorage.setItem(WELCOME_KEY, "1");
    els.welcome.hidden = true;
  });
}

// ============================================================
// 启动
// ============================================================
function init() {
  applyTheme();
  settings = loadSettings();
  records = loadRecords();
  fired = loadFired();
  rebuildIndex();
  bindEvents();
  renderStats();
  renderFilters();
  setView("year");
  if (!localStorage.getItem(WELCOME_KEY)) els.welcome.hidden = false;
  checkReminders();
  setInterval(checkReminders, 20000);
  registerServiceWorker();
}

// PWA：注册 Service Worker（离线缓存 / 安装到主屏 / 未来接入推送）
// 仅在 http/https 环境下注册；本地双击打开的文件不受影响
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!location.protocol.startsWith("http")) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* 注册失败不影响正常使用（如个别旧浏览器） */
    });
  });
}

// ---- 日期工具（全部使用本地时区） ----
function pad(n) { return String(n).padStart(2, "0"); }
function fmtKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function parseKey(k) {
  const p = k.split("-").map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function diffDays(a, b) {
  return Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) -
                     new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 864e5);
}
function todayDate() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const LEVEL_NAMES = ["", "轻度", "中度", "较强", "高强度"];

init();
