require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// База данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Настройки
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || 'mysecret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE discord_id = $1', [profile.id]);
    let role = 'Player';
    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (discord_id, username, avatar, role) VALUES ($1, $2, $3, $4)',
        [profile.id, profile.username, profile.avatar, role]
      );
    } else {
      role = result.rows[0].role;
    }
    return done(null, {
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      role: role
    });
  } catch (err) {
    console.error(err);
    return done(err, null);
  }
}));

// Роуты
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/donate', (req, res) => res.render('donate', { user: req.user }));
app.get('/forum', (req, res) => res.render('forum', { user: req.user }));

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// API: получить сообщения
app.get('/api/messages', async (req, res) => {
  const { category } = req.query;
  if (!category) return res.json([]);
  try {
    const result = await pool.query(`
      SELECT fm.*, u.username, u.avatar, u.discord_id
      FROM forum_messages fm
      JOIN users u ON fm.user_id = u.id
      WHERE fm.category = $1 AND fm.is_deleted = false
      ORDER BY fm.created_at ASC
    `, [category]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: отправить сообщение
app.post('/api/messages', async (req, res) => {
  console.log('📨 POST /api/messages вызван');
  console.log('📦 Тело запроса:', req.body);
  console.log('👤 Пользователь:', req.user);

  if (!req.user) {
    console.log('❌ Нет пользователя');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { category, message } = req.body;
  if (!category || !message) {
    console.log('❌ Нет category или message');
    return res.status(400).json({ error: 'Missing category or message' });
  }

  try {
    const userResult = await pool.query('SELECT id FROM users WHERE discord_id = $1', [req.user.id]);
    console.log('🔍 Результат поиска пользователя:', userResult.rows);

    if (userResult.rows.length === 0) {
      console.log('❌ Пользователь не найден в БД');
      return res.status(404).json({ error: 'User not found in DB' });
    }

    const userId = userResult.rows[0].id;
    console.log('👤 userId:', userId);

    await pool.query(
      'INSERT INTO forum_messages (user_id, category, message) VALUES ($1, $2, $3)',
      [userId, category, message]
    );
    console.log('✅ Сообщение сохранено в БД');

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Ошибка сохранения:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: удалить сообщение
app.delete('/api/messages/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const message = await pool.query('SELECT * FROM forum_messages WHERE id = $1', [req.params.id]);
    if (message.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const userResult = await pool.query('SELECT id, role FROM users WHERE discord_id = $1', [req.user.id]);
    const userId = userResult.rows[0].id;
    const userRole = userResult.rows[0].role;
    const isModerator = ['Helper', 'Moderator', 'Sr.Moderator', 'Curator', 'Team', 'Leadership'].includes(userRole);
    const isOwner = message.rows[0].user_id === userId;
    const isAdmin = req.user.id === process.env.ADMIN_DISCORD_ID;

    if (isOwner || isModerator || isAdmin) {
      await pool.query('UPDATE forum_messages SET is_deleted = true WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'No permission' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: онлайн (заглушка)
app.get('/api/online', (req, res) => {
  res.json({ online: 0, max: 20 });
});

// Запуск сервера
app.listen(port, () => {
  console.log(`✅ Сервер запущен на порту ${port}`);
});