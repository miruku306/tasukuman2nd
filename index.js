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

// ===== 追加: スタンプ連打（期限超過）の設定とヘルパー =====
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

// ===== 追加: 達成時の祝福（スタンプ→ほめ文→スタンプ） =====
const CONGRATS_STICKERS = [
  { packageId: '11537', stickerId: '52002735' },
  { packageId: '11537', stickerId: '52002739' },
  { packageId: '446',   stickerId: '1989'     },
];
const PRAISE_MESSAGES = [
  '👏 よくやった！この調子！',
  '🔥 最高！未来の自分が喜んでる！',
  '💯 完璧！次もサクッといこう！',
  '🎉 素晴らしい！積み上げ成功！',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendCongratsSequence(to, taskLabel) {
  const firstSticker = pickRandom(CONGRATS_STICKERS);
  const secondSticker = pickRandom(CONGRATS_STICKERS);
  // 1) スタンプ
  await client.pushMessage(to, { type: 'sticker', packageId: String(firstSticker.packageId), stickerId: String(firstSticker.stickerId) });
  // 2) ほめる文章
  const praise = `${pickRandom(PRAISE_MESSAGES)}\n✅ 完了: 「${taskLabel}」`;
  await client.pushMessage(to, { type: 'text', text: praise });
  // 3) もう一発スタンプ
  await client.pushMessage(to, { type: 'sticker', packageId: String(secondSticker.packageId), stickerId: String(secondSticker.stickerId) });
}

// ===== 追加: 期日前の煽り（圧）メッセージ機能 =====
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

async function sendTauntSequence(to, phase, taskLabel) {
  const msgPool = phase === '24h' ? TAUNT_MESSAGES_24H : phase === '1h' ? TAUNT_MESSAGES_1H : TAUNT_MESSAGES_15M;
  const sticker = pickRandom(TAUNT_STICKERS);
  // スタンプ → 煽り文 の2連
  await client.pushMessage(to, { type: 'sticker', packageId: String(sticker.packageId), stickerId: String(sticker.stickerId) });
  await client.pushMessage(to, { type: 'text', text: `${pickRandom(msgPool)}\n⛳ タスク: 「${taskLabel}」` });
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

      // --- 完了コマンド（完了 123  または  完了 宿題） ---
      if (/^完了\s+/u.test(text)) {
        const key = text.replace(/^完了\s+/u, '').trim();
        if (!key) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 完了したいタスクを指定してください\n例: 完了 123  または  完了 宿題' });
          continue;
        }

        // ユーザー識別（email 連携にも対応）
        const { data: userData } = await supabase
          .from('users')
          .select('email')
          .eq('line_user_id', userId)
          .single();
        const userEmail = userData?.email || null;

        // タスク検索: 1) id 完全一致、2) task の部分一致（未完了優先、期限が近い順）
        let base = supabase
          .from('todos')
          .select('id, task, date, time, status')
          .neq('status', '完了')
          .order('date', { ascending: true, nullsFirst: true })
          .order('time', { ascending: true, nullsFirst: true });

        base = userEmail
          ? base.or(`user_id.eq.${userId},email.eq.${userEmail}`)
          : base.eq('user_id', userId);

        // まずは ID 指定かどうか
        let target = null;
        if (/^\d+$/u.test(key)) {
          const { data: byId } = await base.eq('id', Number(key));
          target = byId?.[0] || null;
        }
        if (!target) {
          const { data: byText } = await base.ilike('task', `%${key}%`);
          target = byText?.[0] || null;
        }

        if (!target) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '🔍 該当する未完了タスクが見つかりませんでした。' });
          continue;
        }

        // 完了に更新
        const { error: updErr } = await supabase
          .from('todos')
          .update({ status: '完了', is_notified: true, completed_at: nowJST().format('YYYY-MM-DD HH:mm:ss') })
          .eq('id', target.id);
        if (updErr) throw updErr;

        // 祝福シーケンス（スタンプ→ほめ文→スタンプ）
        await sendCongratsSequence(userId, target.task);

        // 確認応答
        await client.replyMessage(event.replyToken, { type: 'text', text: `✅ タスク #${target.id} 「${target.task}」を完了にしました。` });
        continue;
      }

      // --- 圧 ON/OFF コマンド ---
      if (text === '圧オン' || text === '脅しオン') {
        await supabase.from('users').upsert({ line_user_id: userId, threat_mode: true }, { onConflict: 'line_user_id' });
        await client.replyMessage(event.replyToken, { type: 'text', text: '🟢 圧リマインドをONにしました' });
        continue;
      }
      if (text === '圧オフ' || text === '脅しオフ') {
        await supabase.from('users').upsert({ line_user_id: userId, threat_mode: false }, { onConflict: 'line_user_id' });
        await client.replyMessage(event.replyToken, { type: 'text', text: '⚪️ 圧リマインドをOFFにしました' });
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

        const lines = data.map(r => `🔹 #${r.id} ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
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

        const lines = data.map(r => `🔹 #${r.id} ${r.task} - ${r.date || '未定'} ${r.time || ''} [${r.status}]`);
        await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
        continue;
      }

      // --- デフォルト応答 ---
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          '📌 コマンド一覧:\n' +
          '追加 タスク名 [YYYY-MM-DD] [HH:mm]\n' +
          '完了 [ID|キーワード]\n' +
          '圧オン / 圧オフ\n' +
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
    .select('id, user_id, task, date, time, status, is_notified, reminded_24h, reminded_1h, reminded_15m')
    .eq('status', '未完了')
    .order('date', { ascending: true })
    .order('time', { ascending: true });

  if (error) {
    console.error('❌ Supabase error:', error);
    return;
  }
  if (!data?.length) {
    return;
  }

  for (const row of data) {
    // 期限未設定はスキップ（必要なら仕様に応じて変更）
    if (!row.date) continue;

    if (isOverdue(row) && !row.is_notified) {
      try {
        // 期限超過：テキスト + スタンプ連打
        await client.pushMessage(row.user_id, {
          type: 'text',
          text: `💣 まだ終わってないタスク「${row.task}」を早くやれ！！`
        });
        await sendStickerBurst(row.user_id);
        await supabase.from('todos').update({ is_notified: true }).eq('id', row.id);
        console.log('📩 push sent & flagged (with stickers):', row.id, row.task);
      } catch (e) {
        console.error('❌ pushMessage failed:', e?.statusMessage || e?.message || e);
      }
    } else {
      // 期限前の煽り（圧）フェーズ：24h / 1h / 15m
      try {
        // threat_mode を確認（未設定なら ON 扱い）
        const { data: userData } = await supabase
          .from('users')
          .select('threat_mode')
          .eq('line_user_id', row.user_id)
          .single();
        const threatMode = userData?.threat_mode ?? true;
        if (!threatMode) continue;

        // 期限との差分(分)
        const t = row.time ? (row.time.length === 5 ? `${row.time}:00` : row.time) : '23:59:59';
        const deadline = dayjs.tz(`${row.date} ${t}`, 'YYYY-MM-DD HH:mm:ss', TZ);
        const diffMin = deadline.diff(nowJST(), 'minute');
        if (diffMin <= 0) continue;

        let phase = null;
        if (diffMin <= 15 && !row.reminded_15m) phase = '15m';
        else if (diffMin <= 60 && !row.reminded_1h) phase = '1h';
        else if (diffMin <= 24 * 60 && !row.reminded_24h) phase = '24h';

        if (phase) {
          await sendTauntSequence(row.user_id, phase, row.task);
          const patch =
            phase === '15m' ? { reminded_15m: true } :
            phase === '1h'  ? { reminded_1h: true }  :
                              { reminded_24h: true };
          await supabase.from('todos').update(patch).eq('id', row.id);
          console.log(`⚡️ pre-deadline taunt sent [${phase}]:`, row.id, row.task);
        }
      } catch (e) {
        console.error('❌ pre-deadline taunt error:', e?.message || e);
      }
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Bot Webhook running on port ${PORT}`));
