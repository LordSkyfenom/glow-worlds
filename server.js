require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
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

// Passport настройка
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
    
    let userRole = 'Player';
    
    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (discord_id, username, avatar, role) VALUES ($1, $2, $3, $4)',
        [profile.id, profile.username, profile.avatar, userRole]
      );
    } else {
      userRole = result.rows[0].role;
    }
    
    return done(null, {
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      role: userRole
    });
  } catch (err) {
    return done(err, null);
  }
}));

// Middleware для пользователя
app.use((req, res, next) => {
  res.locals.user = req.user || null;
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

// Discord авторизация
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// API для онлайна
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

// API для удаления сообщений
app.delete('/api/messages/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  
  try {
    const message = await pool.query('SELECT * FROM forum_messages WHERE id = $1', [req.params.id]);
    if (message.rows.length === 0) return res.status(404).json({ error: 'Сообщение не найдено' });
    
    const user = await pool.query('SELECT role FROM users WHERE discord_id = $1', [req.user.id]);
    const userRole = user.rows[0].role;
    const isAdmin = req.user.id === process.env.ADMIN_DISCORD_ID;
    const isModerator = ['Helper', 'Moderator', 'Sr.Moderator', 'Curator', 'Team', 'Leadership'].includes(userRole);
    const isOwner = message.rows[0].user_id === (await pool.query('SELECT id FROM users WHERE discord_id = $1', [req.user.id])).rows[0].id;
    
    if (isOwner || isModerator || isAdmin) {
      await pool.query('UPDATE forum_messages SET is_deleted = true WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'Нет прав' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Сервер запущен на http://localhost:${port}`);
});