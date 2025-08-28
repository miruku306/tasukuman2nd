require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Client, middleware } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const dayjs = require('dayjs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ミドルウェア設定 ──
app.use(bodyParser.json());
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── LINE Bot SDK 初期化 ──
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

// ── Supabase クライアント初期化 ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── グローバルエラーハンドリング ──
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

// ── 期限切れ判定ユーティリティ ──
function isOverdue(row) {
  if (!row.date || !row.time) return false;
  const deadline = dayjs(`${row.date} ${row.time}`, 'YYYY-MM-DD HH:mm');
  return deadline.isBefore(dayjs());
}

// ===== LINE Webhook =====
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  for (const event of req.body.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    try {
      // --- タスク追加 ---
      if (/^(追加|登録)\s+/u.test(text)) {
        const parts = text.replace(/^(追加|登録)\s+/u, '').split(/\s+/);
        const taskText = parts[0];
        if (!taskText) {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ タスク名を指定してください。\n例: 追加 宿題 2025-08-30 21:00'
          });
          continue;
        }

        const today = dayjs().format('YYYY-MM-DD');
        const deadlineDate = parts[1] || today;
        const deadlineTime = parts[2] || null;

        let userEmail = null;
        const { data: uData, error: uErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (!uErr && uData) userEmail = uData.email;

        if (!userEmail) {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ メールアドレス未登録です。通知が届かない可能性があります。\n例: メールアドレス sample@example.com'
          });
        }

        const { error: insertErr } = await supabase
          .from('todos')
          .insert({
            user_id: userId,
            task: taskText,
            date: deadlineDate,
            time: deadlineTime,
            status: '未完了',
            is_notified: false,
            email: userEmail
          });
        if (insertErr) throw insertErr;

        await lineClient.replyMessage(event.replyToken, {
          type: 'text',
          text: `🆕 タスク「${taskText}」を登録しました${deadlineTime ? `（締切 ${deadlineDate} ${deadlineTime}）` : ''}`
        });
        continue;
      }

      // --- メールアドレス登録 ---
      if (/^メールアドレス\s+/u.test(text)) {
        const email = text.replace(/^メールアドレス\s+/u, '').trim();
        if (!email) {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ 有効なメールアドレスを入力してください。\n例: メールアドレス sample@example.com'
          });
          continue;
        }

        const { data: existing, error: selectErr } = await supabase
          .from('users')
          .select('id')
          .eq('line_user_id', userId)
          .single();
        if (selectErr && selectErr.code !== 'PGRST116') throw selectErr;

        if (existing) {
          const { error: updErr } = await supabase
            .from('users')
            .update({ email })
            .eq('id', existing.id);
          if (updErr) throw updErr;
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `📧 メールアドレスを更新しました: ${email}`
          });
        } else {
          const { error: insErr } = await supabase
            .from('users')
            .insert({ line_user_id: userId, email });
          if (insErr) throw insErr;
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `📧 メールアドレスを登録しました: ${email}`
          });
        }
        continue;
      }

      // --- 進捗確認 ---
      if (text === '進捗確認') {
        let userEmail = null;
        const { data: uData } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (uData) userEmail = uData.email;

        let query = supabase
          .from('todos')
          .select('task, date, time, status')
          .order('date', { ascending: true })
          .order('time', { ascending: true });
        query = userEmail
          ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;
        if (!data.length) {
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: '📭 進捗中のタスクはありません。' });
          continue;
        }

        const lines = data.map(r => {
          const d = `${r.date || ''} ${r.time || ''}`.trim();
          return `🔹 ${r.task} - ${d || '未定'} [${r.status}]`;
        });
        await lineClient.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // --- 締め切り確認 ---
      if (text === '締め切り確認') {
        let userEmail = null;
        const { data: uData } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (uData) userEmail = uData.email;

        let query = supabase
          .from('todos')
          .select('id, task, date, time, status, is_notified')
          .order('date', { ascending: true })
          .order('time', { ascending: true });
        query = userEmail
          ? query.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;
        if (!data.length) {
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: '📭 登録されたタスクはありません。' });
          continue;
        }

        const lines = [];
        for (const row of data) {
          const d = `${row.date || ''} ${row.time || ''}`.trim();
          lines.push(`🔹 ${row.task} - ${d || '未定'} [${row.status}]`);
          if (isOverdue(row) && row.status === '未完了' && !row.is_notified) {
            await lineClient.pushMessage(userId, [
              { type: 'text', text: `💣 タスク「${row.task}」の締め切りを過ぎています！` },
              { type: 'sticker', packageId: '446', stickerId: '1988' }
            ]);
            await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
          }
        }
        await lineClient.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n')
