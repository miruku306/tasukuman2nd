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

// 期限切れ判定（JST 厳密）
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
  if (!count || count <= 0) return;
  const msgs = Array.from({ length: count }, (_, i) => {
    const s = STICKER_POOL[i % STICKER_POOL.length];
    return { type: 'sticker', packageId: String(s.packageId), stickerId: String(s.stickerId) };
  });
  for (let i = 0; i < msgs.length; i += 5) {
    await client.pushMessage(to, msgs.slice(i, i + 5)); // 1回5件まで
    if (i + 5 < msgs.length) await new Promise(r => setTimeout(r, STICKER_BURST_INTERVAL_MS));
  }
}

// ====== 煽り（期限前リマインド：DB変更なし／可変タイミング） ======
const TAUNT_MINUTES = (process.env.TAUNT_MINUTES || '2880,1440,360,120,60,30,10,5,1')
  .split(',')
  .map(n => parseInt(n.trim(), 10))
  .filter(n => Number.isFinite(n) && n > 0);

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
const TAUNT_MESSAGES_1M = [
  '⏱ 残り1分！今すぐ手を動かせ！',
  '⚡️ ラスト1分、やるかやらないかの差だけ！',
  '🫨 1分切った。送信ボタンまで全力ダッシュ！',
];

function tauntPhaseByMinutes(min){
  // 4段階: 24h / 1h / 15m / 1m
  if (min <= 1) return '1m';
  if (min < 30) return '15m';
  if (min < 180) return '1h';
  return '24h';
}

async function sendTaunt(to, minutes, taskLabel){
  const phase = tauntPhaseByMinutes(minutes);
  const pool =
    phase === '1m' ? TAUNT_MESSAGES_1M :
    phase === '24h' ? TAUNT_MESSAGES_24H :
    phase === '1h' ? TAUNT_MESSAGES_1H :
    TAUNT_MESSAGES_15M;
  const sticker = pickRandom(TAUNT_STICKERS);
  await client.pushMessage(to, { type:'sticker', packageId:String(sticker.packageId), stickerId:String(sticker.stickerId) });
  await client.pushMessage(to, {
    type:'text',
    text:`${pickRandom(pool)}\n⛳ タスク: 「${taskLabel}」 （残り ${minutes} 分）`
  });
}

// ====== LINE Webhook ======
app.post('/webhook', line.middleware(config), async (req, res) => {
  for (const event of req.body.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const userId = event.source.userId;
    const text = event.message.text.trim();

    try {
      // --- タスク追加 ---
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

        const { data: userData, error: userErr } = await supabase
          .from('users').select('email').eq('line_user_id', userId).single();
        if (userErr && userErr.code !== 'PGRST116') throw userErr;
        const userEmail = userData?.email || null;

        const { error: insErr } = await supabase.from('todos').insert({
          user_id: userId, task: taskText, date: deadlineDate, time: deadlineTime,
          status: '未完了', is_notified: false, email: userEmail
        });
        if (insErr) throw insErr;

        await client.replyMessage(event.replyToken, { type: 'text',
          text: `🆕 タスク「${taskText}」を登録しました${deadlineTime ? `（締切 ${deadlineDate} ${deadlineTime}）` : ''}` });
        continue;
      }

      // --- メールアドレス登録 ---
      if (/^メールアドレス\s+/u.test(text)) {
        const email = text.replace(/^メールアドレス\s+/u, '').trim();
        if (!email) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ メールアドレスを入力してください\n例: メールアドレス sample@example.com' });
          continue;
        }
        const { data: existing, error: selErr } = await supabase
          .from('users').select('id').eq('line_user_id', userId).single();
        if (selErr && selErr.code !== 'PGRST116') throw selErr;

        if (existing) {
          const { error } = await supabase.from('users').update({ email }).eq('id', existing.id);
          if (error) throw error;
          await client.replyMessage(event.replyToken, { type: 'text', text: `📧 メールアドレスを更新しました: ${email}` });
        } else {
          const { error } = await supabase.from('users').insert({ line_user_id: userId, email });
          if (error) throw error;
          await client.replyMessage(event.replyToken, { type: 'text', text: `📧 メールアドレスを登録しました: ${email}` });
        }
        continue;
      }

      // --- タスク完了（完了 タスク名） ---
      if (/^完了\s+/u.test(text)) {
        const taskName = text.replace(/^完了\s+/u, '').trim();
        if (!taskName) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 完了するタスク名を入力してください\n例: 完了 宿題' });
          continue;
        }

        // 未完了の中から完全一致を1件（期限近い順）
        const { data: candidates, error: qErr } = await supabase
          .from('todos')
          .select('id, task, date, time')
          .eq('user_id', userId)
          .eq('status', '未完了')
          .eq('task', taskName)
          .order('date', { ascending: true, nullsFirst: true })
          .order('time', { ascending: true, nullsFirst: true })
          .limit(1);
        if (qErr) throw qErr;

        const target = candidates?.[0];
        if (!target) {
          await client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 未完了のタスク「${taskName}」が見つかりませんでした` });
          continue;
        }

        const patch = { status: '完了', is_notified: true };
        // completed_at が存在する環境なら活用
        patch.completed_at = nowJST().toISOString();

        const { error: updErr } = await supabase
          .from('todos')
          .update(patch)
          .eq('id', target.id);
        if (updErr) throw updErr;

        await client.replyMessage(event.replyToken, [
          { type: 'text', text: `👏 タスク「${taskName}」完了！よくやった！` },
          { type: 'sticker', packageId: '11537', stickerId: '52002744' }
        ]);
        continue;
      }

      // --- 進捗確認 / 締め切り確認 ---
      if (text === '進捗確認' || text === '締め切り確認') {
        const { data: userData } = await supabase
          .from('users').select('email').eq('line_user_id', userId).single();
        const userEmail = userData?.email || null;

        let query = supabase.from('todos')
          .select('id, task, date, time, status, is_notified, email')
          .order('date', { ascending: true })
          .order('time', { ascending: true });
        query = userEmail ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`) : query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;

        if (!data?.length) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '📭 タスクはありません。' });
          continue;
        }
        const lines = data.map(r => `🔹 ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
        await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // --- デフォルト応答 ---
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          '📌 コマンド一覧:\n' +
          '追加 タスク名 [YYYY-MM-DD] [HH:mm]\n' +
          '完了 タスク名\n' +
          'メールアドレス your@example.com\n' +
          '進捗確認\n' +
          '締め切り確認'
      });

    } catch (err) {
      console.error('[Webhook Error]', err);
      try {
        await client.replyMessage(event.replyToken, { type: 'text', text: `❗️ エラーが発生しました: ${err.message}` });
      } catch (_) {}
    }
  }
  res.sendStatus(200);
});

// ====== 定期チェック（毎分） ======
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
      // 期限超過：テキスト + スタンプ連打
      try {
        await client.pushMessage(row.user_id, { type: 'text', text: `💣 まだ終わってないタスク「${row.task}」を早くやれ！！` });
        await sendStickerBurst(row.user_id); // ← 連打
        await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
      } catch (e) { console.error('❌ overdue push failed:', e?.message || e); }
    } else if (row.date) {
      // 期限前：TAUNT_MINUTES に一致したら煽る（DB変更なし）
      const t = row.time ? (row.time.length===5 ? `${row.time}:00` : row.time) : '23:59:59';
      const deadline = dayjs.tz(`${row.date} ${t}`, 'YYYY-MM-DD HH:mm:ss', TZ);
      const diffMin = deadline.diff(nowJST(), 'minute');
      try {
        if (TAUNT_MINUTES.includes(diffMin)) {
          await sendTaunt(row.user_id, diffMin, row.task);
        }
      } catch (e) { console.error('❌ pre-deadline taunt failed:', e?.message || e); }
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Bot Webhook running on port ${PORT}`));
