// ============================================================================
// Class08 多功能機器人 (倒數 + 課表查詢)
// ============================================================================

const KV_PREFIX = 'cd:';
const SCHEDULE_PREFIX = 'schedule:';
const REGISTRY_PREFIX = 'user_registry:';
const DEFAULT_TZ = 'Asia/Taipei';

// ⚠️ 請把這裡換成你未來架設的「課表網頁」網址！
const WEB_URL = 'https://friend-playtime.pages.dev'; 

// ========== 自訂貼圖設定 ==========
const CUSTOM_EMOJI = {
  success: '', // 例如 '<:check:123456789>'
  danger:  '',
  info:    '',
  theme:   ''
};

// 節次對照表 (依照你的學校設定)
const PERIOD_TIMES = {
  1:  { start: '08:10', end: '09:00' },
  2:  { start: '09:10', end: '10:00' },
  3:  { start: '10:10', end: '11:00' },
  4:  { start: '11:10', end: '12:00' },
  14: { start: '12:10', end: '13:00' }, // N 節
  5:  { start: '13:10', end: '14:00' },
  6:  { start: '14:10', end: '15:00' },
  7:  { start: '15:20', end: '16:10' },
  8:  { start: '16:20', end: '17:10' }
};

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

// ---------- 基礎驗證與工具 ----------
let cachedVerifyKey = null;
let cachedVerifyKeyHex = null;

function hexToUint8(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function getVerifyKey(publicKey) {
  if (cachedVerifyKey && cachedVerifyKeyHex === publicKey) return cachedVerifyKey;
  cachedVerifyKey = await crypto.subtle.importKey(
    'raw', hexToUint8(publicKey),
    { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']
  );
  cachedVerifyKeyHex = publicKey;
  return cachedVerifyKey;
}

async function verify(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;
  const body = await request.clone().text();
  if (!body) return false;
  const key = await getVerifyKey(publicKey);
  const encoder = new TextEncoder();
  return crypto.subtle.verify('NODE-ED25519', key, hexToUint8(signature), encoder.encode(timestamp + body));
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isValidDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function formatTz(date, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function daysBetween(fromStr, toStr) {
  const a = Date.UTC(...fromStr.split('-').map(Number));
  const b = Date.UTC(...toStr.split('-').map(Number));
  return Math.round((b - a) / 86400000);
}

function clampName(name) {
  let cleaned = String(name).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length > 100) cleaned = cleaned.slice(0, 100).trim();
  if (!cleaned) cleaned = 'countdown';
  return cleaned;
}

function getTaipeiTime() {
  const now = new Date();
  const twTime = new Date(now.getTime() + 8 * 3600 * 1000);
  let day = twTime.getUTCDay(); 
  day = day === 0 ? 7 : day;
  const hh = String(twTime.getUTCHours()).padStart(2, '0');
  const mm = String(twTime.getUTCMinutes()).padStart(2, '0');
  return { day, time: `${hh}:${mm}` };
}

// ---------- UI 介面 ----------
const COLOR = { theme: 0x2b2d31, success: 0x23a55a, danger: 0xda373c, info: 0x5865f2 };

function uiCard(type, title, desc = null, fields = null, footer = null) {
  const e = { color: COLOR[type] || COLOR.theme, timestamp: new Date().toISOString() };
  const icon = CUSTOM_EMOJI[type] ? `${CUSTOM_EMOJI[type]} ` : '';
  e.title = icon + title;
  if (desc) e.description = desc;
  if (fields) e.fields = fields;
  if (footer) e.footer = { text: footer };
  return e;
}

async function discordApi(token, endpoint, method = 'GET', body = null) {
  const opt = { method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, opt);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) console.error(`API ${method} ${endpoint} failed: ${res.status}`, data);
  return { ok: res.ok, status: res.status, data };
}

async function patchOriginal(interaction, env, payload) {
  return fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
}

// ---------- 權限檢查 (原生管理員權限) ----------
function checkPermission(interaction) {
  const member = interaction.member;
  if (!member) return false;
  if (interaction.guild && interaction.guild.owner_id === member.user.id) return true;
  try {
    if (member.permissions && (BigInt(member.permissions) & 0x20n) === 0x20n) return true;
  } catch {}
  return false;
}

// ============================================================================
// 模組一：倒數系統
// ============================================================================
function normalizeConfig(cfg) {
  return {
    item: cfg.item || cfg.prefix || '',
    target_date: cfg.target_date,
    mode: cfg.mode || 'countdown',
    head: cfg.head !== undefined ? cfg.head : (cfg.emoji || ''),
    separator: cfg.separator || '',
    timezone: cfg.timezone || DEFAULT_TZ
  };
}

function genName(cfg, now = new Date()) {
  const c = normalizeConfig(cfg);
  const tz = c.timezone;
  const todayStr = formatTz(now, tz);
  const diff = daysBetween(todayStr, c.target_date);
  const abs = Math.abs(diff);

  let statusText = '';
  if (c.mode === 'countup') {
    if (diff < 0) statusText = `${c.item}已過 ${abs} 天`;
    else if (diff === 0) statusText = `${c.item}就是今天`;
    else statusText = `${c.item}還有 ${diff} 天`;
  } else {
    const hasCountdownWord = /倒數|倒数/.test(c.item);
    if (diff > 0) {
      const word = hasCountdownWord ? '' : '倒數 ';
      statusText = `${c.item}${word}${abs} 天`;
    } else if (diff === 0) {
      statusText = `${c.item}就是今天`;
    } else {
      statusText = `${c.item}已過 ${abs} 天`;
    }
  }

  return clampName(`${c.head}${c.separator}${statusText}`);
}

async function getAll(store) {
  const configs = [];
  const seen = new Set();
  const newList = await store.list({ prefix: KV_PREFIX });
  for (const k of newList.keys) {
    const v = await store.get(k.name);
    const cfg = safeParse(v);
    if (cfg) {
      configs.push({ key: k.name.slice(KV_PREFIX.length), ...cfg, _newFormat: true });
      seen.add(k.name.slice(KV_PREFIX.length));
    }
  }
  const oldList = await store.list();
  for (const k of oldList.keys) {
    if (k.name.startsWith(KV_PREFIX) || seen.has(k.name)) continue;
    const v = await store.get(k.name);
    const cfg = safeParse(v);
    if (cfg) configs.push({ key: k.name, ...cfg, _newFormat: false });
  }
  return configs;
}

async function getConfig(store, channelId) {
  const v = await store.get(KV_PREFIX + channelId);
  if (safeParse(v)) return { ...safeParse(v), _newFormat: true };
  const v2 = await store.get(channelId);
  if (safeParse(v2)) return { ...safeParse(v2), _newFormat: false };
  return null;
}

async function putConfig(store, channelId, cfg, migrateOld = false) {
  await store.put(KV_PREFIX + channelId, JSON.stringify(cfg));
  if (migrateOld) await store.delete(channelId);
}

async function deleteConfig(store, channelId) {
  await store.delete(KV_PREFIX + channelId);
  await store.delete(channelId);
}

async function handleCreate(interaction, env, ctx) {
  const opts = interaction.data.options[0].options || [];
  const getOpt = (n) => opts.find(o => o.name === n)?.value;

  let head = getOpt('標記') || '';
  let separator = getOpt('分隔') || '';
  if (head === '無') head = '';
  if (separator === '無') separator = '';

  const mode = getOpt('模式') || 'countdown';
  const item = (getOpt('項目') || '倒數').trim();
  const date = getOpt('日期');
  const tz = getOpt('時區') || DEFAULT_TZ;

  if (!isValidDate(date)) {
    return reply({ type: 4, data: { embeds: [uiCard('danger', '日期格式錯誤', '請使用 `YYYY-MM-DD` 格式，例如 `2030-05-25`。')], flags: 64 } });
  }

  const initialName = genName({ item, target_date: date, mode, head, separator, timezone: tz });

  ctx.waitUntil((async () => {
    const r = await discordApi(env.DISCORD_TOKEN, `/guilds/${interaction.guild_id}/channels`, 'POST', {
      name: initialName, type: 0
    });

    if (!r.ok) {
      await patchOriginal(interaction, env, { embeds: [uiCard('danger', '建立失敗', r.status === 403 ? 'Bot 缺少「管理頻道」權限。' : `HTTP ${r.status}`)] });
      return;
    }

    const channel = r.data;
    await putConfig(env.COUNTDOWN_STORE, channel.id, { item, target_date: date, mode, head, separator, timezone: tz });
    await patchOriginal(interaction, env, {
      embeds: [uiCard('success', '建立成功', `已成功建立新的倒數頻道 <#${channel.id}>。`,
        [
          { name: '目前名稱', value: `\`${initialName}\``, inline: false },
          { name: '模式', value: mode === 'countup' ? '累計' : '倒數', inline: true },
          { name: '日期', value: date, inline: true },
          { name: '時區', value: tz, inline: true }
        ], 'Class08 Countdown')]
    });
  })());
  return reply({ type: 5 });
}

async function handleEdit(interaction, env, ctx) {
  const opts = interaction.data.options[0].options || [];
  const getOpt = (n) => opts.find(o => o.name === n)?.value;

  const channelId = getOpt('頻道');
  const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);
  if (!cfg) return reply({ type: 4, data: { embeds: [uiCard('danger', '找不到記錄', `<#${channelId}> 不在倒數清單中。`)], flags: 64 } });

  const newHead = getOpt('標記');
  const newSep = getOpt('分隔');

  const current = normalizeConfig(cfg);
  let head = current.head;
  let separator = current.separator;

  if (newHead === '無') head = '';
  else if (newHead !== undefined) head = newHead;

  if (newSep === '無') separator = '';
  else if (newSep !== undefined) separator = newSep;

  const newMode = getOpt('模式');
  const newItem = getOpt('事項');
  const newDate = getOpt('日期');
  const newTz = getOpt('時區');

  if (newDate && !isValidDate(newDate)) {
    return reply({ type: 4, data: { embeds: [uiCard('danger', '日期格式錯誤', '請使用 `YYYY-MM-DD` 格式。')], flags: 64 } });
  }

  const merged = {
    item: newItem ?? current.item,
    target_date: newDate ?? current.target_date,
    mode: newMode ?? current.mode,
    head, separator,
    timezone: newTz ?? current.timezone
  };

  const newName = genName(merged);

  ctx.waitUntil((async () => {
    const r = await discordApi(env.DISCORD_TOKEN, `/channels/${channelId}`, 'PATCH', { name: newName });
    if (!r.ok) {
      await patchOriginal(interaction, env, { embeds: [uiCard('danger', '更新失敗', `HTTP ${r.status}`)] });
      return;
    }
    await putConfig(env.COUNTDOWN_STORE, channelId, merged, !cfg._newFormat);
    await patchOriginal(interaction, env, {
      embeds: [uiCard('success', '設定已更新', `已成功更新頻道 <#${channelId}>。`,
        [
          { name: '新名稱', value: `\`${newName}\``, inline: false },
          { name: '模式', value: merged.mode === 'countup' ? '累計' : '倒數', inline: true },
          { name: '日期', value: merged.target_date, inline: true },
          { name: '時區', value: merged.timezone, inline: true }
        ], 'Class08 Countdown')]
    });
  })());
  return reply({ type: 5 });
}

async function handleDelete(interaction, env) {
  const channelId = interaction.data.options[0].options.find(o => o.name === '頻道').value;
  const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);
  if (!cfg) return reply({ type: 4, data: { embeds: [uiCard('danger', '找不到記錄', `此頻道不在倒數清單中。`)], flags: 64 } });

  const r = await discordApi(env.DISCORD_TOKEN, `/channels/${channelId}`, 'DELETE');
  if (!r.ok && r.status !== 404) {
    return reply({ type: 4, data: { embeds: [uiCard('danger', '刪除失敗', r.status === 403 ? 'Bot 缺少「管理頻道」權限。' : `HTTP ${r.status}`)], flags: 64 } });
  }

  await deleteConfig(env.COUNTDOWN_STORE, channelId);
  return reply({ type: 4, data: { embeds: [uiCard('success', '已刪除', `頻道 <#${channelId}> 與記錄已清除。`)], flags: 64 } });
}

async function handleInfo(interaction, env) {
  const channelId = interaction.data.options?.[0]?.options?.find(o => o.name === '頻道')?.value;

  if (channelId) {
    const cfg = await getConfig(env.COUNTDOWN_STORE, channelId);
    if (!cfg) return reply({ type: 4, data: { embeds: [uiCard('danger', '找不到記錄', `<#${channelId}> 不在倒數清單中。`)], flags: 64 } });
    
    const c = normalizeConfig(cfg);
    const diff = daysBetween(formatTz(new Date(), c.timezone), c.target_date);
    const currentName = genName(c);
    const status = diff > 0 ? `還有 ${diff} 天` : diff === 0 ? '就是今天' : `已過 ${-diff} 天`;

    return reply({
      type: 4, data: { embeds: [uiCard('theme', '頻道詳細資訊', null, [
        { name: '項目', value: `\`${c.item}\``, inline: true },
        { name: '模式', value: c.mode === 'countup' ? '累計' : '倒數', inline: true },
        { name: '時區', value: c.timezone, inline: true },
        { name: '目標日期', value: c.target_date, inline: true },
        { name: '剩餘/已過', value: status, inline: true },
        { name: '目前名稱', value: `\`${currentName}\``, inline: false }
      ])], flags: 64 }
    });
  }

  const configs = await getAll(env.COUNTDOWN_STORE);
  if (configs.length === 0) return reply({ type: 4, data: { embeds: [uiCard('theme', '所有倒數頻道', '目前沒有任何倒數頻道。')], flags: 64 } });

  const shown = configs.slice(0, 25);
  const fields = shown.map(cfg => {
    const c = normalizeConfig(cfg);
    const diff = daysBetween(formatTz(new Date(), c.timezone), c.target_date);
    const modeLabel = c.mode === 'countup' ? '累計' : '倒數';
    const status = diff > 0 ? `還有 ${diff} 天` : diff === 0 ? '就是今天' : `已過 ${-diff} 天`;
    return {
      name: `<#${cfg.key}>`,
      value: `\`${c.item}\` · ${c.target_date} · ${modeLabel} · ${status}`,
      inline: false
    };
  });

  const desc = configs.length > 25 ? `共 ${configs.length} 個，僅顯示前 25 個。` : `共 ${configs.length} 個倒數頻道。`;
  return reply({ type: 4, data: { embeds: [uiCard('theme', '所有倒數頻道', desc, fields)], flags: 64 } });
}

// ============================================================================
// 模組二：課表查詢系統
// ============================================================================
async function updateRegistry(store, userId, guildId) {
  const key = REGISTRY_PREFIX + userId;
  let registry = safeParse(await store.get(key)) || [];
  if (!registry.includes(guildId)) {
    registry.push(guildId);
    await store.put(key, JSON.stringify(registry));
  }
}

// 🌟 生成網頁連結
async function handleOpenWeb(interaction) {
  const userId = interaction.member.user.id;
  const guildId = interaction.guild_id;
  const url = `${WEB_URL}/?uid=${userId}&gid=${guildId}`;
  
  return reply({
    type: 4,
    data: {
      embeds: [uiCard('info', '📅 登記空堂', '點擊下方的按鈕開啟專屬網頁，直接在表格上點選你的空堂時間！\n*(儲存後會自動同步回 Discord)*')],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5, // 5 代表連結按鈕
          label: '開啟課表網頁',
          url: url
        }]
      }],
      flags: 64
    }
  });
}

// 🌟 生成 Discord 內建下拉表單
async function handleOpenForm(interaction) {
  const dayOptions = [1,2,3,4,5,6,7].map(d => ({ label: `星期${DAY_NAMES[d-1]}`, value: d.toString() }));
  const periodOptions = [
    { label: '第 1 節 (08:10)', value: '1' }, { label: '第 2 節 (09:10)', value: '2' },
    { label: '第 3 節 (10:10)', value: '3' }, { label: '第 4 節 (11:10)', value: '4' },
    { label: '第 N 節 (12:10)', value: '14' }, { label: '第 5 節 (13:10)', value: '5' },
    { label: '第 6 節 (14:10)', value: '6' }, { label: '第 7 節 (15:20)', value: '7' },
    { label: '第 8 節 (16:20)', value: '8' }
  ];

  return reply({
    type: 4,
    data: {
      embeds: [uiCard('info', '📅 登記空堂 (Discord 版)', '請依序透過下方的選單選擇你的空堂時間，完成後點擊「確認提交」。')],
      components: [
        { type: 1, components: [{ type: 3, custom_id: 'form_day', placeholder: '1. 請選擇星期...', options: dayOptions }] },
        { type: 1, components: [{ type: 3, custom_id: 'form_start', placeholder: '2. 請選擇開始節次...', options: periodOptions }] },
        { type: 1, components: [{ type: 3, custom_id: 'form_end', placeholder: '3. 請選擇結束節次...', options: periodOptions }] },
        { type: 1, components: [{ type: 2, style: 3, label: '✅ 確認提交', custom_id: 'form_submit' }] }
      ],
      flags: 64
    }
  });
}

async function handleFormSubmit(interaction, env) {
  const components = interaction.data.components;
  let dayVal, startVal, endVal;

  components.forEach(row => {
    row.components.forEach(comp => {
      if (comp.custom_id === 'form_day') dayVal = comp.values[0];
      if (comp.custom_id === 'form_start') startVal = comp.values[0];
      if (comp.custom_id === 'form_end') endVal = comp.values[0];
    });
  });

  if (!dayVal || !startVal || !endVal) {
    return reply({ type: 4, data: { embeds: [uiCard('danger', '填寫不完整', '請確保三個下拉選單都有選擇喔！')], flags: 64 } });
  }

  const day = parseInt(dayVal);
  const startPeriod = parseInt(startVal);
  const endPeriod = parseInt(endVal);

  if (startPeriod > endPeriod) {
    return reply({ type: 4, data: { embeds: [uiCard('danger', '節次錯誤', '開始節次不能晚於結束節次，請重新選擇。')], flags: 64 } });
  }

  const startTime = PERIOD_TIMES[startPeriod].start;
  const endTime = PERIOD_TIMES[endPeriod].end;

  const userId = interaction.member.user.id;
  const guildId = interaction.guild_id;
  const key = `${SCHEDULE_PREFIX}${guildId}:${userId}`;

  let data = safeParse(await env.COUNTDOWN_STORE.get(key)) || { name: interaction.member.displayName, freeSlots: [] };
  
  const isOverlap = data.freeSlots.some(c => 
    c.day === day && ((startTime >= c.start && startTime < c.end) || (endTime > c.start && endTime <= c.end) || (startTime <= c.start && endTime >= c.end))
  );

  if (isOverlap) {
    return reply({ type: 4, data: { embeds: [uiCard('danger', '時段重疊', '你在這個時段已經登記過空堂了，請先確認。')], flags: 64 } });
  }

  data.freeSlots.push({ day, start: startTime, end: endTime });
  data.freeSlots.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));

  await env.COUNTDOWN_STORE.put(key, JSON.stringify(data));
  await updateRegistry(env.COUNTDOWN_STORE, userId, guildId);

  return reply({
    type: 7, 
    data: {
      embeds: [uiCard('success', '空堂已登記', `✅ 已成功記錄 **星期${DAY_NAMES[day-1]} 第 ${startPeriod === 14 ? 'N' : startPeriod} ~ ${endPeriod === 14 ? 'N' : endPeriod} 節**有空。\n\n時間：\`${startTime} ~ ${endTime}\``)],
      components: []
    }
  });
}

async function handleGameMySchedule(interaction, env) {
  const userId = interaction.member.user.id;
  const guildId = interaction.guild_id;
  const key = `${SCHEDULE_PREFIX}${guildId}:${userId}`;
  const data = safeParse(await env.COUNTDOWN_STORE.get(key));

  if (!data || data.freeSlots.length === 0) {
    const registryKey = REGISTRY_PREFIX + userId;
    const registry = safeParse(await env.COUNTDOWN_STORE.get(registryKey)) || [];
    const otherGuild = registry.find(g => g !== guildId);

    if (otherGuild) {
      return reply({
        type: 4,
        data: {
          embeds: [uiCard('info', '發現其他伺服器的課表', '偵測到你在其他伺服器有空堂紀錄。\n請問是否要將該紀錄同步到**本伺服器**？')],
          components: [{
            type: 1,
            components: [{
              type: 2,
              style: 3,
              label: '同意並同步',
              custom_id: `sync_data:${otherGuild}:${guildId}:${userId}`
            }]
          }],
          flags: 64
        }
      });
    }

    return reply({ type: 4, data: { embeds: [uiCard('theme', '我的空堂', '目前沒有任何空堂紀錄，請使用 `/登記空堂` 或 `/填寫課表`。')], flags: 64 } });
  }

  const list = data.freeSlots.map(c => `星期${DAY_NAMES[c.day - 1]}：\`${c.start} ~ ${c.end}\``).join('\n');
  return reply({ type: 4, data: { embeds: [uiCard('theme', '我的空堂', `以下是你登記的空堂時間：\n\n${list}`)], flags: 64 } });
}

async function handleGameQuery(interaction, env) {
  const guildId = interaction.guild_id;
  const tw = getTaipeiTime();
  
  const list = await env.COUNTDOWN_STORE.list({ prefix: `${SCHEDULE_PREFIX}${guildId}:` });
  if (list.keys.length === 0) {
    return reply({ type: 4, data: { embeds: [uiCard('theme', '空無一人', '本伺服器還沒有人登記空堂喔！')], flags: 64 } });
  }

  const freePlayers = [];
  const busyPlayers = [];

  for (const k of list.keys) {
    const data = safeParse(await env.COUNTDOWN_STORE.get(k.name));
    if (!data) continue;
    const userId = k.name.split(':')[2];

    const isFree = data.freeSlots.some(c => c.day === tw.day && tw.time >= c.start && tw.time < c.end);

    if (isFree) freePlayers.push(`<@${userId}>`);
    else busyPlayers.push(`<@${userId}>`);
  }

  let desc = `**查詢時間**：星期${DAY_NAMES[tw.day - 1]} ${tw.time}\n\n`;
  desc += `🟢 **確定有空 (${freePlayers.length})**：\n${freePlayers.join('、') || '無'}\n\n`;
  if (busyPlayers.length > 0) desc += `🔴 **正在上課 / 沒空 (${busyPlayers.length})**：\n${busyPlayers.join('、')}`;

  return reply({ type: 4, data: { embeds: [uiCard('theme', '遊戲玩家查詢結果', desc)], flags: 64 } });
}

async function handleGameClear(interaction, env) {
  const userId = interaction.member.user.id;
  const guildId = interaction.guild_id;
  await env.COUNTDOWN_STORE.delete(`${SCHEDULE_PREFIX}${guildId}:${userId}`);
  return reply({ type: 4, data: { embeds: [uiCard('success', '已清空', '你在本伺服器的空堂紀錄已刪除。')], flags: 64 } });
}

// ============================================================================
// 模組三：按鈕互動處理 (跨服同步)
// ============================================================================
async function handleComponent(interaction, env) {
  const customId = interaction.data.custom_id;
  if (customId === 'form_submit') return handleFormSubmit(interaction, env);

  if (customId.startsWith('sync_data:')) {
    const [, sourceGuild, targetGuild, targetUser] = customId.split(':');
    if (interaction.member.user.id !== targetUser) {
      return reply({ type: 4, data: { embeds: [uiCard('danger', '權限不足', '只有當事人本人可以同意同步。')], flags: 64 } });
    }

    const sourceKey = `${SCHEDULE_PREFIX}${sourceGuild}:${targetUser}`;
    const sourceData = safeParse(await env.COUNTDOWN_STORE.get(sourceKey));
    if (!sourceData) {
      return reply({ type: 4, data: { embeds: [uiCard('danger', '同步失敗', '來源資料已遺失。')], flags: 64 } });
    }

    const targetKey = `${SCHEDULE_PREFIX}${targetGuild}:${targetUser}`;
    await env.COUNTDOWN_STORE.put(targetKey, JSON.stringify(sourceData));
    await updateRegistry(env.COUNTDOWN_STORE, targetUser, targetGuild);

    return reply({
      type: 7,
      data: { embeds: [uiCard('success', '同步成功', '你在其他伺服器的空堂紀錄已成功同步！')], components: [] }
    });
  }
}

async function handleHelp() {
  return reply({
    type: 4, data: { embeds: [uiCard('info', 'Class08 機器人使用手冊', '提供倒數計時與遊戲空堂查詢功能。',
      [
        { name: '⏱️ 倒數系統', value: '`/cd 建立` - 建立新倒數\n`/cd 修改` - 修改倒數設定\n`/cd 刪除` - 刪除倒數頻道\n`/cd 資訊` - 查看倒數列表', inline: false },
        { name: '🎮 課表系統', value: '`/登記空堂` - 用選單登記空堂\n`/填寫課表` - 用網頁點擊登記\n`/查詢誰沒課` - 看現在誰有空\n`/我的空堂` - 查看自己的紀錄\n`/清空空堂` - 刪除所有紀錄', inline: false }
      ], '八班 Class08 · 自動化系統')], flags: 64 }
  });
}

// ============================================================================
// 路由分發
// ============================================================================
async function handleInteraction(interaction, env, ctx) {
  if (interaction.type === 3) return handleComponent(interaction, env);

  const cmd = interaction.data.name;
  
  if (cmd === '幫助') return handleHelp();

  // 倒數指令
  if (cmd === 'cd') {
    const sub = interaction.data.options?.[0]?.name;
    if (['建立', '修改', '刪除'].includes(sub) && !checkPermission(interaction)) {
      return reply({ type: 4, data: { embeds: [uiCard('danger', '權限不足', '只有伺服器管理員可以使用此功能。')], flags: 64 } });
    }

    switch (sub) {
      case '建立': return handleCreate(interaction, env, ctx);
      case '修改': return handleEdit(interaction, env, ctx);
      case '刪除': return handleDelete(interaction, env);
      case '資訊': return handleInfo(interaction, env);
    }
  }

  // 遊戲指令
  if (cmd === '填寫課表') return handleOpenWeb(interaction);
  if (cmd === '登記空堂') return handleOpenForm(interaction);
  if (cmd === '我的空堂') return handleGameMySchedule(interaction, env);
  if (cmd === '查詢誰沒課') return handleGameQuery(interaction, env);
  if (cmd === '清空空堂') return handleGameClear(interaction, env);

  return reply({ type: 4, data: { embeds: [uiCard('danger', '未知指令')], flags: 64 } });
}

// ============================================================================
// 主入口
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. 處理網頁的 CORS 預檢
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // 2. 處理網頁儲存資料 API
    if (url.pathname === '/api/save-schedule' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.userId || !body.guildId || !Array.isArray(body.freeSlots)) {
          return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
        }

        const key = `${SCHEDULE_PREFIX}${body.guildId}:${body.userId}`;
        let data = safeParse(await env.COUNTDOWN_STORE.get(key)) || { name: '未知玩家', freeSlots: [] };
        data.freeSlots = body.freeSlots;
        
        await env.COUNTDOWN_STORE.put(key, JSON.stringify(data));
        await updateRegistry(env.COUNTDOWN_STORE, body.userId, body.guildId);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // 3. 處理 Discord 請求
    if (request.method === 'POST') {
      if (!(await verify(request, env.DISCORD_PUBLIC_KEY))) return new Response('Invalid signature', { status: 401 });
      const interaction = await request.json();
      if (interaction.type === 1) return reply({ type: 1 });
      if (interaction.type === 2 || interaction.type === 3) return handleInteraction(interaction, env, ctx);
    }

    return new Response('Discord Countdown Worker OK', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
  
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const configs = await getAll(env.COUNTDOWN_STORE);
      const now = new Date();
      for (const c of configs) {
        try {
          if (!c._newFormat) await putConfig(env.COUNTDOWN_STORE, c.key, c, true);
          const name = genName(c, now);
          await discordApi(env.DISCORD_TOKEN, `/channels/${c.key}`, 'PATCH', { name });
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
      }
    })());
  }
};