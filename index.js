require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const dayjs = require('dayjs');

const app = express();
const PORT = process.env.PORT || 3000;

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// Supabase クライアント
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// エラーハンドリング
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

// 期限切れ判定
function isOverdue(row) {
  if (!row.date || !row.time) return false;
  return dayjs(`${row.date} ${row.time}`, 'YYYY-MM-DD HH:mm').isBefore(dayjs());
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
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ タスク名を指定してください' });
          continue;
        }

        const today = dayjs().format('YYYY-MM-DD');
        const deadlineDate = datePart || today;
        const deadlineTime = timePart || null;

        // メールアドレス取得
        const { data: userData } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        const userEmail = userData?.email || null;

        // todos に保存
        await supabase.from('todos').insert({
          user_id: userId,
          task: taskText,
          date: deadlineDate,
          time: deadlineTime,
          status: '未完了',
          is_notified: false,
          email: userEmail
        });

        await client.replyMessage(event.replyToken, { type: 'text', text: `🆕 タスク「${taskText}」を登録しました` });
        continue;
      }

      // --- メールアドレス登録 ---
      if (/^メールアドレス\s+/u.test(text)) {
        const email = text.replace(/^メールアドレス\s+/u, '').trim();
        if (!email) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ メールアドレスを入力してください' });
          continue;
        }

        const { data: existingUser } = await supabase
          .from('users')
          .select('id')
          .eq('line_user_id', userId)
          .single();

        if (existingUser) {
          await supabase.from('users').update({ email }).eq('id', existingUser.id);
          await client.replyMessage(event.replyToken, { type: 'text', text: `📧 メールアドレスを更新しました: ${email}` });
        } else {
          await supabase.from('users').insert({ line_user_id: userId, email });
          await client.replyMessage(event.replyToken, { type: 'text', text: `📧 メールアドレスを登録しました: ${email}` });
        }
        continue;
      }

      // --- 進捗確認 ---
      if (text === '進捗確認') {
        const { data: userData } = await supabase.from('users').select('email').eq('line_user_id', userId).single();
        const userEmail = userData?.email || null;

        let query = supabase.from('todos')
          .select('id, task, date, time, status, is_notified, email')
          .order('date', { ascending: true })
          .order('time', { ascending: true });
        query = userEmail ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`) : query.eq('user_id', userId);

        const { data } = await query;
        if (!data.length) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '📭 進捗中のタスクはありません。' });
          continue;
        }

        const lines = data.map(r => `🔹 ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
        await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // --- 締め切り確認 ---
      if (text === '締め切り確認') {
        const { data: userData } = await supabase.from('users').select('email').eq('line_user_id', userId).single();
        const userEmail = userData?.email || null;

        let query = supabase.from('todos')
          .select('id, task, date, time, status, is_notified, email')
          .order('date', { ascending: true })
          .order('time', { ascending: true });
        query = userEmail ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`) : query.eq('user_id', userId);

        const { data } = await query;
        if (!data.length) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '📭 登録されたタスクはありません。' });
          continue;
        }

        const lines = data.map(r => `🔹 ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
        await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // --- デフォルト応答 ---
      await client.replyMessage(event.replyToken, { type: 'text', text:
        '📌 コマンド一覧:\n追加 タスク名 [YYYY-MM-DD] [HH:mm]\nメールアドレス 登録\n進捗確認\n締め切り確認\n完了 タスク名'
      });

    } catch (err) {
      console.error('[Webhook Error]', err);
      await client.replyMessage(event.replyToken, { type: 'text', text: `❗️ エラーが発生しました: ${err.message}` });
    }
  }
  res.sendStatus(200);
});

// ===== 定期チェック (毎分) =====
cron.schedule('* * * * *', async () => {
  console.log("⏰ cron started");

  try {
    const { data, error } = await supabase.from('todos')
      .select('id, user_id, task, date, time, status, is_notified')
      .eq('status', '未完了')
      .neq('is_notified', true)
      .order('date', { ascending: true })
      .order('time', { ascending: true });

    if (error) {
      console.error("❌ Supabase error:", error);
      return;
    }

    if (!data || data.length === 0) {
      console.log("📭 No tasks to notify");
      return;
    }

    for (const row of data) {
      console.log("🔎 Checking task:", row);

      if (isOverdue(row)) {
        try {
          await client.pushMessage(row.user_id, {
            type: 'text',
            text: `💣 まだ終わってないタスク「${row.task}」を早くやれ！！`
          });
          console.log(`📩 Notified user ${row.user_id} about task: ${row.task}`);

          await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
        } catch (err) {
          console.error("❌ pushMessage error:", err);
        }
      } else {
        console.log(`⏭ 期限未到達: ${row.task}`);
      }
    }
  } catch (err) {
    console.error("❌ Cron job failed:", err);
  }
});
app.listen(PORT, () => console.log(`🚀 Bot Webhook running on port ${PORT}`));
