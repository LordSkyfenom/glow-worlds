require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Подключение к БД
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Настройки
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || 'secretkey',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// Middleware для пользователя (временный, без Discord)
app.use(async (req, res, next) => {
  req.user = null;
  next();
});

// Маршруты
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

app.get('/donate', (req, res) => {
  res.render('donate', { user: req.user });
});

app.get('/forum', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT fm.*, u.username, u.avatar 
      FROM forum_messages fm 
      JOIN users u ON fm.user_id = u.id 
      WHERE fm.is_deleted = false 
      ORDER BY fm.created_at ASC
    `);
    res.render('forum', { user: req.user, messages: result.rows });
  } catch (err) {
    console.error(err);
    res.render('forum', { user: req.user, messages: [] });
  }
});

// API для онлайна (заглушка)
app.get('/api/online', (req, res) => {
  res.json({ online: 0, max: 20 });
});

// API для сообщений форума
app.post('/api/messages', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  
  const { category, message } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO forum_messages (user_id, category, message) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, category, message]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Сервер запущен на http://localhost:${port}`);
});