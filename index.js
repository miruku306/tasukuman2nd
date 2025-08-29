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

// ===== スタンプ連打の設定とヘルパー =====
const STICKER_BURST_COUNT = Number(process.env.STICKER_BURST_COUNT || 10); // 送る総数
const STICKER_BURST_INTERVAL_MS = Number(process.env.STICKER_BURST_INTERVAL_MS || 500); // 5件ごとの間隔(ms)

// よく使われる無料スタンプの例
const STICKER_POOL = [
  { packageId: '446',   stickerId: '1988'  },
  { packageId: '446',   stickerId: '1990'  },
  { packageId: '446',   stickerId: '2003'  },
  { packageId: '11537', stickerId: '52002734' },
  { packageId: '11537', stickerId: '52002738' },
  { packageId: '11538', stickerId: '51626495' },
  { packageId: '11539', stickerId: '52114110' },
];

// 5件ずつまとめて push。バースト間にウェイトを入れる
async function sendStickerBurst(to, count = STICKER_BURST_COUNT, intervalMs = STICKER_BURST_INTERVAL_MS) {
  if (!count || count <= 0) return;
  const msgs = Array.from({ length: count }, (_, i) => {
    const s = STICKER_POOL[i % STICKER_POOL.length];
    return { type: 'sticker', packageId: String(s.packageId), stickerId: String(s.stickerId) };
  });

  for (let i = 0; i < msgs.length; i += 5) {
    const chunk = msgs.slice(i, i + 5);
    await client.pushMessage(to, chunk); // pushMessage は最大5件の配列を受け取れる
    if (i + 5 < msgs.length) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

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

        // users からメールアドレス取得（行なしはOK）
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

      // --- タスク完了（＝削除：Supabaseから物理削除） ---
      if (/^完了(\s+.+)?$/u.test(text)) {
        const name = text.replace(/^完了/u, '').trim();
        if (!name) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ 使い方: 完了 <タスク名>\n例: 完了 宿題'
          });
          continue;
        }

        // users からメールアドレス取得（行なしはOK）
        const { data: userData, error: userErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (userErr && userErr.code !== 'PGRST116') throw userErr;
        const userEmail = userData?.email || null;

        // 自分のタスクの中から task 名一致を取得（ステータスは問わず、全部削除）
        let sel = supabase
          .from('todos')
          .select('id, task')
          .eq('task', name);

        sel = userEmail
          ? sel.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : sel.eq('user_id', userId);

        const { data: targets, error: selErr } = await sel;
        if (selErr) throw selErr;

        if (!targets?.length) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '対象のタスクが見つかりませんでした。'
          });
          continue;
        }

        const ids = targets.map(t => t.id);
        const { error: delErr } = await supabase
          .from('todos')
          .delete()
          .in('id', ids); // ← Supabase 側のレコードを物理削除
        if (delErr) throw delErr;

        const list = targets.map(r => `✅ ${r.task}`).join('\n');
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `完了（削除）にしました:\n${list}`
        });
        continue;
      }

      // --- タスク削除/消去（ID不要：タスク名一致を削除） ---
      if (/^(削除|消去)(\s+.+)?$/u.test(text)) {
        const name = text.replace(/^(削除|消去)/u, '').trim();
        if (!name) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '⚠️ 使い方: 削除 <タスク名>\n例: 削除 宿題'
          });
          continue;
        }

        // users からメールアドレス取得（行なしはOK）
        const { data: userData, error: userErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (userErr && userErr.code !== 'PGRST116') throw userErr;
        const userEmail = userData?.email || null;

        // 自分のタスクの中から task 名一致を取得（ステータスは問わず）
        let sel = supabase
          .from('todos')
          .select('id, task')
          .eq('task', name);

        sel = userEmail
          ? sel.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : sel.eq('user_id', userId);

        const { data: targets, error: selErr } = await sel;
        if (selErr) throw selErr;

        if (!targets?.length) {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '対象のタスクが見つかりませんでした。'
          });
          continue;
        }

        const ids = targets.map(t => t.id);
        const { error: delErr } = await supabase
          .from('todos')
          .delete()
          .in('id', ids);
        if (delErr) throw delErr;

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `🗑️ 「${name}」を ${targets.length}件 削除しました。`
        });
        continue;
      }

      // --- 進捗確認 ---
      if (text === '進捗確認') {
        const { data: userData, error: userErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (userErr && userErr.code !== 'PGRST116') throw userErr;
        const userEmail = userData?.email || null;

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
        const { data: userData, error: userErr } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        if (userErr && userErr.code !== 'PGRST116') throw userErr;
        const userEmail = userData?.email || null;

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
          '締め切り確認\n' +
          '完了 <タスク名>（完了＝削除）\n' +
          '削除 <タスク名>（別名: 消去）'
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
  if (!data?.length) return;

  for (const row of data) {
    if (isOverdue(row)) {
      try {
        // テキスト通知
        await client.pushMessage(row.user_id, {
          type: 'text',
          text: `💣 まだ終わってないタスク「${row.task}」を早くやれ！！`
        });

        // スタンプ連打
        await sendStickerBurst(row.user_id);

        // 重複通知防止フラグ
        await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
        console.log('📩 push sent & flagged (with stickers):', row.id, row.task);
      } catch (e) {
        console.error('❌ pushMessage failed:', e?.statusMessage || e?.message || e);
      }
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Bot Webhook running on port ${PORT}`));
