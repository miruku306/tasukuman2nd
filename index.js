// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Asia/Tokyo';
const nowJST = () => dayjs().tz(TZ);

const app = express();
const PORT = process.env.PORT || 3000;

// ヘルスチェック
app.get('/', (_req, res) => res.status(200).send('OK'));

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== 共通ユーティリティ ======
function pickRandom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

// 期限切れ判定
function isOverdue(row) {
  if (!row?.date || !row?.time) return false;
  const t = typeof row.time === 'string' && row.time.length === 5 ? `${row.time}:00` : row.time;
  const deadline = dayjs.tz(`${row.date} ${t}`, 'YYYY-MM-DD HH:mm:ss', TZ);
  return deadline.isBefore(nowJST());
}

// ====== スタンプ連打（期限超過時） ======
const STICKER_POOL = [
  { packageId: '446', stickerId: '1988' },
  { packageId: '446', stickerId: '1990' },
  { packageId: '446', stickerId: '2003' },
  { packageId: '11537', stickerId: '52002734' },
  { packageId: '11537', stickerId: '52002738' },
  { packageId: '11538', stickerId: '51626495' },
  { packageId: '11539', stickerId: '52114110' },
];
const STICKER_BURST_COUNT = Number(process.env.STICKER_BURST_COUNT || 10);
const STICKER_BURST_INTERVAL_MS = Number(process.env.STICKER_BURST_INTERVAL_MS || 500);

async function sendStickerBurst(to, count = STICKER_BURST_COUNT) {
  const msgs = Array.from({ length: count }, (_, i) => {
    const s = STICKER_POOL[i % STICKER_POOL.length];
    return { type: 'sticker', packageId: String(s.packageId), stickerId: String(s.stickerId) };
  });
  for (let i = 0; i < msgs.length; i += 5) {
    await client.pushMessage(to, msgs.slice(i, i + 5));
    if (i + 5 < msgs.length) {
      await new Promise(r => setTimeout(r, STICKER_BURST_INTERVAL_MS));
    }
  }
}

// ====== 煽り（期限前リマインド） ======
const TAUNT_STICKERS = [
  { packageId: '446', stickerId: '2005' },
  { packageId: '446', stickerId: '2002' },
  { packageId: '11537', stickerId: '52002757' },
];
const TAUNT_MESSAGES_24H = [
  '⏳ 24時間切ったぞ。余裕ぶっこいてると終わらんぞ？',
  '⏰ もう明日が締切。今のうちに始めようか？',
  '🗓️ 明日まで。未来の自分に恨まれたくなければ動け。',
];
const TAUNT_MESSAGES_1H = [
  '⚠️ 残り1時間。ここからが本番だ、やるぞ。',
  '⏰ 1時間切った。スマホ置け。いけ。',
  '🔥 ダラダラ禁止。60分で片をつける。',
];
const TAUNT_MESSAGES_15M = [
  '🚨 15分前！今やらないでいつやる？',
  '💣 15分で仕上げろ。やればできる。',
  '🧨 ラスト15分、全力でいけ！',
];
async function sendTaunt(to, phase, taskLabel){
  const pool = phase==='24h' ? TAUNT_MESSAGES_24H : phase==='1h' ? TAUNT_MESSAGES_1H : TAUNT_MESSAGES_15M;
  const sticker = pickRandom(TAUNT_STICKERS);
  await client.pushMessage(to, { type:'sticker', packageId:String(sticker.packageId), stickerId:String(sticker.stickerId) });
  await client.pushMessage(to, { type:'text', text:`${pickRandom(pool)}\n⛳ タスク: 「${taskLabel}」` });
}

// ====== LINE Webhook ======
app.post('/webhook', line.middleware(config), async (req, res) => {
  for (const event of req.body.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const userId = event.source.userId;
    const text = event.message.text.trim();

    try {
      // タスク追加
      if (/^(追加|登録)\s+/u.test(text)) {
        const parts = text.replace(/^(追加|登録)\s+/u, '').trim().split(/\s+/);
        const taskText = parts[0];
        const datePart = parts[1];
        const timePart = parts[2];
        if (!taskText) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ タスク名を指定してください\n例: 追加 宿題 2025-08-30 21:00' });
          continue;
        }
        const today = nowJST().format('YYYY-MM-DD');
        const deadlineDate = datePart || today;
        const deadlineTime = timePart || null;
        const { data: userData } = await supabase.from('users').select('email').eq('line_user_id', userId).single();
        const userEmail = userData?.email || null;
        await supabase.from('todos').insert({
          user_id: userId, task: taskText, date: deadlineDate, time: deadlineTime,
          status: '未完了', is_notified: false, email: userEmail
        });
        await client.replyMessage(event.replyToken, { type: 'text', text: `🆕 タスク「${taskText}」を登録しました${deadlineTime ? `（締切 ${deadlineDate} ${deadlineTime}）` : ''}` });
        continue;
      }

      // メールアドレス登録
      if (/^メールアドレス\s+/u.test(text)) {
        const email = text.replace(/^メールアドレス\s+/u, '').trim();
        if (!email) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ メールアドレスを入力してください\n例: メールアドレス sample@example.com' });
          continue;
        }
        const { data: existing } = await supabase.from('users').select('id').eq('line_user_id', userId).single();
        if (existing) {
          await supabase.from('users').update({ email }).eq('id', existing.id);
          await client.replyMessage(event.replyToken, { type: 'text', text: `📧 メールアドレスを更新しました: ${email}` });
        } else {
          await supabase.from('users').insert({ line_user_id: userId, email });
          await client.replyMessage(event.replyToken, { type: 'text', text: `📧 メールアドレスを登録しました: ${email}` });
        }
        continue;
      }

      // 進捗確認
      if (text === '進捗確認' || text === '締め切り確認') {
        const { data: userData } = await supabase.from('users').select('email').eq('line_user_id', userId).single();
        const userEmail = userData?.email || null;
        let query = supabase.from('todos').select('id, task, date, time, status, is_notified, email')
          .order('date', { ascending: true }).order('time', { ascending: true });
        query = userEmail ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`) : query.eq('user_id', userId);
        const { data } = await query;
        if (!data?.length) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '📭 タスクはありません。' });
          continue;
        }
        const lines = data.map(r => `🔹 ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
        await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // デフォルト応答
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '📌 コマンド一覧:\n' +
              '追加 タスク名 [YYYY-MM-DD] [HH:mm]\n' +
              'メールアドレス your@example.com\n' +
              '進捗確認\n' +
              '締め切り確認'
      });

    } catch (err) {
      console.error('[Webhook Error]', err);
      try { await client.replyMessage(event.replyToken, { type: 'text', text: `❗️ エラーが発生しました: ${err.message}` }); } catch (_) {}
    }
  }
  res.sendStatus(200);
});

// ====== 定期チェック ======
cron.schedule('* * * * *', async () => {
  const { data, error } = await supabase
    .from('todos')
    .select('id, user_id, task, date, time, status, is_notified')
    .eq('status', '未完了')
    .order('date', { ascending: true })
    .order('time', { ascending: true });
  if (error) return console.error('❌ Supabase error:', error);
  if (!data?.length) return;

  for (const row of data) {
    if (isOverdue(row) && !row.is_notified) {
      try {
        await client.pushMessage(row.user_id, { type: 'text', text: `💣 まだ終わってないタスク「${row.task}」を早くやれ！！` });
        await sendStickerBurst(row.user_id); // ← 期限超過時にスタンプ連打
        await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
      } catch (e) { console.error('❌ overdue push failed:', e); }
    } else if (row.date) {
      // 期限前の煽り（24h/1h/15m）
      const t = row.time ? (row.time.length===5 ? `${row.time}:00` : row.time) : '23:59:59';
      const deadline = dayjs.tz(`${row.date} ${t}`, 'YYYY-MM-DD HH:mm:ss', TZ);
      const diffMin = deadline.diff(nowJST(), 'minute');
      try {
        if (diffMin === 24*60) {
          await sendTaunt(row.user_id, '24h', row.task);
        } else if (diffMin === 60) {
          await sendTaunt(row.user_id, '1h', row.task);
        } else if (diffMin === 15) {
          await sendTaunt(row.user_id, '15m', row.task);
        }
      } catch (e) { console.error('❌ pre-deadline taunt failed:', e); }
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Bot Webhook running on port ${PORT}`));
