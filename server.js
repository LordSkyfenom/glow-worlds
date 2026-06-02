require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

// База данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Настройки
app.use(express.json());
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

// API сообщений
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { category, message } = req.body;
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE discord_id = $1', [req.user.id]);
    const userId = userResult.rows[0].id;
    await pool.query(
      'INSERT INTO forum_messages (user_id, category, message) VALUES ($1, $2, $3)',
      [userId, category, message]
    );
    io.emit('new-message', { category });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      io.emit('message-deleted', { category: message.rows[0].category });
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'No permission' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/online', (req, res) => res.json({ online: 0, max: 20 }));

// Socket.io
let onlineUsers = 0;
io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online-count', onlineUsers);
  
  socket.on('join-category', (category) => {
    socket.join(category);
  });
  
  socket.on('new-message', (data) => {
    io.emit('new-message', data);
  });
  
  socket.on('delete-message', (data) => {
    io.emit('message-deleted', data);
  });
  
  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('online-count', onlineUsers);
  });
});

server.listen(port, () => {
  console.log(`✅ Сервер на порту ${port}`);
});