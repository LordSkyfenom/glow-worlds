require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// === База данных ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// === Настройки Express ===
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// === Сессии ===
app.use(session({
  secret: process.env.SESSION_SECRET || 'mysecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// === Passport Discord ===
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
    // Проверяем, является ли пользователь владельцем по DISCORD_ADMIN_ID
    const isOwner = (profile.id === process.env.DISCORD_ADMIN_ID);
    const role = isOwner ? 'Руководство' : 'Player';
    
    const result = await pool.query('SELECT * FROM users WHERE discord_id = $1', [profile.id]);
    
    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (discord_id, username, avatar, role, is_owner) VALUES ($1, $2, $3, $4, $5)',
        [profile.id, profile.username, profile.avatar, role, isOwner]
      );
    } else {
      await pool.query(
        'UPDATE users SET username = $1, avatar = $2, role = $3, is_owner = $4 WHERE discord_id = $5',
        [profile.username, profile.avatar, role, isOwner, profile.id]
      );
    }
    
    console.log(`👤 ${profile.username} — роль: ${role} | владелец: ${isOwner}`);
    
    return done(null, {
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      role: role,
      isOwner: isOwner
    });
  } catch (err) {
    console.error('❌ Discord auth error:', err);
    return done(err, null);
  }
}));

// === Роуты страниц ===
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/donate', (req, res) => res.render('donate', { user: req.user }));
app.get('/forum', (req, res) => res.render('forum', { user: req.user }));

// === Профиль (админка для владельца) ===
app.get('/profile', async (req, res) => {
  if (!req.user) return res.redirect('/auth/discord');
  
  const isOwner = req.user.isOwner === true;
  
  try {
    let orders;
    if (isOwner) {
      orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    } else {
      orders = await pool.query('SELECT * FROM orders WHERE discord_id = $1 ORDER BY created_at DESC', [req.user.id]);
    }
    return res.render('profile', { user: req.user, isOwner: isOwner, orders: orders.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).send('Ошибка базы данных: ' + err.message);
  }
});

// === Discord авторизация ===
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// === ДОНАТ ===
app.post('/create-order', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { product, minecraft_nick } = req.body;
  const prices = { 'pickaxe': 150, 'crown': 250, 'key': 150 };
  const price = prices[product];
  
  if (!price) return res.status(400).json({ error: 'Invalid product' });
  
  try {
    const result = await pool.query(
      `INSERT INTO orders (discord_id, discord_name, minecraft_nick, product_type, price, status) 
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [req.user.id, req.user.username, minecraft_nick, product, price]
    );
    const orderId = result.rows[0].id;
    
    const paymentUrl = `https://yoomoney.ru/quickpay/confirm.xml?receiver=${process.env.MONEY_WALLET}&quickpay-form=shop&targets=Заказ%20№${orderId}&sum=${price}&comment=order_${orderId}&successURL=${process.env.BASE_URL}/donate`;
    
    res.json({ orderId, price, paymentUrl, success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mark-as-paid', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { orderId } = req.body;
  
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND discord_id = $2', [orderId, req.user.id]);
    if (order.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['waiting_confirmation', orderId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel-order', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { orderId } = req.body;
  
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND discord_id = $2', [orderId, req.user.id]);
    if (order.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const status = order.rows[0].status;
    if (status !== 'pending' && status !== 'waiting_confirmation') {
      return res.status(400).json({ error: 'Cannot cancel order in current status' });
    }
    
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', orderId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// === АДМИНКА API ===
app.get('/api/admin/orders', async (req, res) => {
  if (!req.user || !req.user.isOwner) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(orders.rows);
});

app.post('/api/admin/confirm-order', async (req, res) => {
  if (!req.user || !req.user.isOwner) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { orderId } = req.body;
  await pool.query('UPDATE orders SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', orderId]);
  res.json({ success: true });
});

app.post('/api/admin/decline-order', async (req, res) => {
  if (!req.user || !req.user.isOwner) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { orderId } = req.body;
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', orderId]);
  res.json({ success: true });
});

// === API форума ===
app.get('/api/messages', async (req, res) => {
  const { category } = req.query;
  if (!category) return res.status(400).json({ error: 'Category required' });
  
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
  if (!category || !message) return res.status(400).json({ error: 'Missing fields' });
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE discord_id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    await pool.query(
      'INSERT INTO forum_messages (user_id, category, message) VALUES ($1, $2, $3)',
      [userResult.rows[0].id, category, message]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const messageResult = await pool.query('SELECT * FROM forum_messages WHERE id = $1', [req.params.id]);
    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    
    const userResult = await pool.query('SELECT id, role FROM users WHERE discord_id = $1', [req.user.id]);
    const userId = userResult.rows[0].id;
    const userRole = userResult.rows[0].role;
    const isOwner = messageResult.rows[0].user_id === userId;
    const isModerator = ['Helper', 'Moderator', 'Sr.Moderator', 'Curator', 'Team', 'Leadership'].includes(userRole);
    const isAdmin = req.user.isOwner === true;
    
    if (isOwner || isModerator || isAdmin) {
      await pool.query('UPDATE forum_messages SET is_deleted = true WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'No permission' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/online', (req, res) => {
  res.json({ online: 0, max: 20 });
});

app.listen(port, () => {
  console.log(`✅ Сервер Glow Worlds запущен на порту ${port}`);
});