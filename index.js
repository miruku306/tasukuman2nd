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

// ヘルスチェック（Render用）
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

// エラーハンドリング
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

// 期限切れ判定（JSTで厳密比較）
function isOverdue(row) {
  if (!row?.date || !row?.time) return false;
  const t = typeof row.time === 'string' && row.time.length === 5 ? `${row.time}:00` : row.time; // HH:mm → HH:mm:ss
  const deadline = dayjs.tz(`${row.date} ${t}`, 'YYYY-MM-DD HH:mm:ss', TZ);
  const now = nowJST();
  // デバッグしたい時だけ下のコメントを外してください
  // console.log('⏱ deadline:', deadline.format(), 'now:', now.format());
  return deadline.isBefore(now);
}

// ===== LINE Webhook =====
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
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ タスク名を指定してください\n例: 追加 宿題 2025-08-30 21:00'
          });
          continue;
        }

        const today = nowJST().format('YYYY-MM-DD');
        const deadlineDate = datePart || today;
        const deadlineTime = timePart || null;

        // users からメールアドレス取得
        const { data: userData, error: userErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (userErr && userErr.code !== 'PGRST116') throw userErr;
        const userEmail = userData?.email || null;

        // todos へ保存
        const { error: insErr } = await supabase.from('todos').insert({
          user_id: userId,
          task: taskText,
          date: deadlineDate,
          time: deadlineTime,
          status: '未完了',
          is_notified: false,
          email: userEmail
        });
        if (insErr) throw insErr;

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `🆕 タスク「${taskText}」を登録しました${deadlineTime ? `（締切 ${deadlineDate} ${deadlineTime}）` : ''}`
        });
        continue;
      }

      // --- メールアドレス登録 ---
      if (/^メールアドレス\s+/u.test(text)) {
        const email = text.replace(/^メールアドレス\s+/u, '').trim();
        if (!email) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ メールアドレスを入力してください\n例: メールアドレス sample@example.com'
          });
          continue;
        }

        const { data: existing, error: selErr } = await supabase
          .from('users')
          .select('id')
          .eq('line_user_id', userId)
          .single();
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

      // --- 進捗確認 ---
      if (text === '進捗確認') {
        const { data: userData } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        const userEmail = userData?.email || null;

        let query = supabase
          .from('todos')
          .select('id, task, date, time, status, is_notified, email')
          .order('date', { ascending: true })
          .order('time', { ascending: true });

        query = userEmail
          ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;

        if (!data?.length) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '📭 進捗中のタスクはありません。' });
          continue;
        }

        const lines = data.map(r => `🔹 ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
        await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // --- 締め切り確認 ---
      if (text === '締め切り確認') {
        const { data: userData } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        const userEmail = userData?.email || null;

        let query = supabase
          .from('todos')
          .select('id, task, date, time, status, is_notified, email')
          .order('date', { ascending: true })
          .order('time', { ascending: true });

        query = userEmail
          ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;

        if (!data?.length) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '📭 登録されたタスクはありません。' });
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
          'メールアドレス your@example.com\n' +
          '進捗確認\n' +
          '締め切り確認'
      });

    } catch (err) {
      console.error('[Webhook Error]', err);
      try {
        await client.replyMessage(event.replyToken, { type: 'text', text: `❗️ エラーが発生しました: ${err.message}` });
      } catch (_) {} // 返信期限切れなどは無視
    }
  }
  res.sendStatus(200);
});

// ===== 定期チェック (毎分) =====
cron.schedule('* * * * *', async () => {
  const now = nowJST().format('YYYY-MM-DD HH:mm:ss');
  console.log('⏰ cron tick JST:', now);

  const { data, error } = await supabase
    .from('todos')
    .select('id, user_id, task, date, time, status, is_notified')
    .eq('status', '未完了')
    .neq('is_notified', true)
    .order('date', { ascending: true })
    .order('time', { ascending: true });

  if (error) {
    console.error('❌ Supabase error:', error);
    return;
  }
  if (!data?.length) {
    // console.log('📭 No pending tasks');
    return;
  }

  for (const row of data) {
    if (isOverdue(row)) {
      try {
        await client.pushMessage(row.user_id, {
          type: 'text',
          text: `💣 まだ終わってないタスク「${row.task}」を早くやれ！！`
        });
        await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
        console.log('📩 push sent & flagged:', row.id, row.task);
      } catch (e) {
        console.error('❌ pushMessage failed:', e?.statusMessage || e?.message || e);
      }
    } else {
      // console.log('⏭ not yet:', row.task, row.date, row.time);
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Bot Webhook running on port ${PORT}`));
