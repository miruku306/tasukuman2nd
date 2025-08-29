import { createClient } from 'https://esm.sh/@supabase/supabase-js'

const supabase = createClient(
  'https://bteklaezhlfmjylybrlh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0ZWtsYWV6aGxmbWp5bHlicmxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTAzMTEzNDYsImV4cCI6MjA2NTg4NzM0Nn0.8YP7M1soC5NpuuhgtmDUB2cL2y6W3yfmL4rgSxaS0TE'
)

const taskInput = document.getElementById('taskInput')
const dateInput = document.getElementById('dateInput')
const timeInput = document.getElementById('timeInput')
const taskList = document.getElementById('taskList')
const message = document.getElementById('message')

// タスク一覧を読み込む
async function loadTasks() {
  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('email', window.userEmail)   // ✅ email一致
    .order('date', { ascending: true })

  if (error) {
    console.error('読み込み失敗:', error.message)
    message.textContent = 'タスクの読み込みに失敗しました。'
    return
  }

  renderTasks(data)
}

// タスクを表示
function renderTasks(tasks) {
  taskList.innerHTML = ''
  if (tasks.length === 0) {
    taskList.innerHTML = '<p>まだタスクがありません。</p>'
    return
  }

  tasks.forEach(task => {
    const div = document.createElement('div')
    div.className = 'task'
    div.innerHTML = `
      <div class="task-content">
        <strong>${task.task}</strong><br>
        <small>締切: ${task.date} ${task.time}</small>
      </div>
      <button class="delete" data-id="${task.id}">完了</button>
    `
    taskList.appendChild(div)

    // 通知予約（5分前）
    const deadline = new Date(`${task.date}T${task.time}`)
    const notifyTime = new Date(deadline.getTime() - 5 * 60 * 1000)
    const now = new Date()
    const timeout = notifyTime - now
    if (timeout > 0) {
      setTimeout(() => sendNotification(task), timeout)
    }
  })

  // 削除イベント
  document.querySelectorAll('.delete').forEach(button => {
    button.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-id')
      await deleteTask(id)
    })
  })
}

// タスク削除
async function deleteTask(id) {
  const { error } = await supabase.from('todos').delete().eq('id', id)
  if (error) {
    alert('削除失敗: ' + error.message)
  } else {
    loadTasks()
  }
}

// 通知を送信
function sendNotification(task) {
  if (Notification.permission === 'granted') {
    new Notification('⏰ タスクの時間です', {
      body: `${task.task}（${task.date} ${task.time}）`,
      icon: 'icon.png'
    })
  }
}

// タスク追加
document.getElementById('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault()

  const task = taskInput.value.trim()
  const date = dateInput.value
  const time = timeInput.value

  if (!task || !date || !time) {
    message.textContent = '全ての項目を入力してください。'
    return
  }

  const { error } = await supabase.from('todos').insert([
    {
      task,
      date,
      time,
      status: '未完了',         // ✅ 常に未完了で登録
      is_notified: false,
      email: window.userEmail // ✅ emailも保存
      
    }
    
  ])
  

  if (error) {
    message.textContent = '追加失敗: ' + error.message
    console.error(error)
  } else {
    message.textContent = '追加完了！'
    taskInput.value = ''
    dateInput.value = ''
    timeInput.value = ''
    loadTasks()
  }
})

// 通知許可
if (Notification.permission !== 'granted') {
  Notification.requestPermission()
}

// 初期表示
document.addEventListener('DOMContentLoaded', loadTasks)
