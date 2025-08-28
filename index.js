// src/index.js

require('dotenv').config();
const express           = require('express');
const path              = require('path');
const line              = require('@line/bot-sdk');
const { createClient }  = require('@supabase/supabase-js');
const cron              = require('node-cron');
const dayjs             = require('dayjs');

const app   = express();
const PORT  = process.env.PORT || 3000;

// public フォルダはリポジトリ直下に配置している想定
const publicDir = path.join(__dirname, '..', 'public');

// 静的ファイル配信設定
app.use(express.static(publicDir));
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// LINE Bot SDK の設定
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// Supabase クライアント初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// グローバルエラーハンドリング
process.on('uncaughtException',  err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

// 締め切り判定ユーティリティ
function isOverdue(row) {
  if (!row.date || !row.time) return false;
  const deadline = dayjs(`${row.date} ${row.time}`, 'YYYY-MM-DD HH:mm');
  return deadline.isBefore(dayjs());
}

// ===== LINE Webhook =====
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  for (const event of req.body.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source.userId;
    const text   = event.message.text.trim();

    try {
      // --- タスク追加コマンド ---
      if (/^(追加|登録)\s+/u.test(text)) {
        console.log('Add command:', text);

        const parts    = text.replace(/^(追加|登録)\s+/u, '').split(/\s+/);
        const taskText = parts[0];
        if (!taskText) {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ タスク名を指定してください。\n例: 追加 宿題 2025-08-30 21:00'
          });
          continue;
        }

        // 日付・時刻のデフォルト
        const today        = dayjs().format('YYYY-MM-DD');
        const deadlineDate = parts[1] || today;
        const deadlineTime = parts[2] || null;

        // ユーザーのメールアドレス取得
        let userEmail = null;
        const { data: uData, error: uErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (!uErr && uData) userEmail = uData.email;

        // 未登録なら注意喚起
        if (!userEmail) {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ メールアドレス未登録です。通知が届かない可能性があります。\n例: メールアドレス sample@example.com'
          });
        }

        // todos テーブルにデータ挿入
        const { error: insertErr } = await supabase
          .from('todos')
          .insert({
            user_id:     userId,
            task:        taskText,
            date:        deadlineDate,
            time:        deadlineTime,
            status:      '未完了',
            is_notified: false,
            email:       userEmail
          });
        if (insertErr) {
          console.error('Supabase insert error:', insertErr);
          throw insertErr;
        }

        // 完了レスポンス
        await lineClient.replyMessage(event.replyToken, {
          type: 'text',
          text: `🆕 タスク「${taskText}」を登録しました${deadlineTime ? `（締切 ${deadlineDate} ${deadlineTime}）` : ''}`
        });
        continue;
      }

      // --- メールアドレス登録コマンド ---
      if (/^メールアドレス\s+/u.test(text)) {
        const email = text.replace(/^メールアドレス\s+/u, '').trim();
        if (!email) {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ 有効なメールアドレスを入力してください。'
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

      // --- 進捗確認・締め切り確認・完了コマンドなどは省略 ---
      // 必要に応じて前回のロジックをここに追加してください。

      // デフォルト応答
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text:
          '📌 コマンド一覧:\n' +
          '追加 タスク名 [YYYY-MM-DD] [HH:mm]\n' +
          'メールアドレス 登録\n' +
          '進捗確認\n' +
          '締め切り確認\n' +
          '完了 タスク名'
      });

    } catch (err) {
      console.error('[Webhook Error]', err);
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: `❗️ 内部エラーが発生しました: ${err.message}`
      });
    }
  }

  res.sendStatus(200);
});

// ===== 毎分定期爆撃チェック =====
cron.schedule('* * * * *', async () => {
  const { data, error } = await supabase
    .from('todos')
    .select('id, user_id, task, date, time, status, is_notified')
    .eq('status', '未完了')
    .neq('is_notified', true)
    .order('date', { ascending: true })
    .order('time', { ascending: true });

  if (error) return console.error('[Cron Error]', error);

  for (const row of data) {
    if (isOverdue(row)) {
      await lineClient.pushMessage(row.user_id, [
        { type: 'text', text: `💣 タスク「${row.task}」の期限を過ぎています！急いで！！` },
        { type: 'sticker', packageId: '446', stickerId: '1988' }
      ]);
      await supabase
        .from('todos')
        .update({ is_notified: true })
        .eq('id', row.id);
    }
  }
});

// サーバ起動はここだけ
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
