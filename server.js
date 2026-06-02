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
app.get('/', async (req, res) => {
  const servers = await pool.query('SELECT * FROM servers WHERE active = true ORDER BY id');
  res.render('index', { user: req.user, servers: servers.rows });
});
app.get('/donate', async (req, res) => {
  const products = await pool.query('SELECT * FROM donate_products ORDER BY id');
  res.render('donate', { user: req.user, products: products.rows });
});
app.get('/forum', (req, res) => res.render('forum', { user: req.user }));
app.get('/profile', async (req, res) => {
  if (!req.user) return res.redirect('/auth/discord');
  const orders = await pool.query('SELECT * FROM orders WHERE discord_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.render('profile', { user: req.user, orders: orders.rows });
});

// === Админ панель ===
app.get('/admin-panel', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).send('Доступ запрещён');
  const products = await pool.query('SELECT * FROM donate_products ORDER BY id');
  const servers = await pool.query('SELECT * FROM servers ORDER BY id');
  res.render('admin-panel', { user: req.user, products: products.rows, servers: servers.rows });
});

// === Discord auth ===
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// === API: удаление своего заказа (только confirmed/cancelled) ===
app.delete('/api/delete-order/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND discord_id = $2', [req.params.id, req.user.id]);
  if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const status = order.rows[0].status;
  if (status !== 'confirmed' && status !== 'cancelled') return res.status(400).json({ error: 'Cannot delete this order' });
  await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// === API: создание заказа ===
app.post('/create-order', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { productId, minecraft_nick } = req.body;
  const product = await pool.query('SELECT * FROM donate_products WHERE id = $1', [productId]);
  if (product.rows.length === 0) return res.status(400).json({ error: 'Invalid product' });
  const price = product.rows[0].price;
  const result = await pool.query(
    'INSERT INTO orders (discord_id, discord_name, minecraft_nick, product_type, price, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [req.user.id, req.user.username, minecraft_nick, product.rows[0].name, price, 'pending']
  );
  const paymentUrl = `https://yoomoney.ru/quickpay/confirm.xml?receiver=${process.env.MONEY_WALLET}&quickpay-form=shop&targets=Заказ%20№${result.rows[0].id}&sum=${price}&comment=order_${result.rows[0].id}&successURL=${process.env.BASE_URL}/donate`;
  res.json({ orderId: result.rows[0].id, price, paymentUrl, success: true });
});

app.post('/api/mark-as-paid', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { orderId } = req.body;
  const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND discord_id = $2', [orderId, req.user.id]);
  if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['waiting_confirmation', orderId]);
  res.json({ success: true });
});

// === API: админка заказы ===
app.get('/api/admin/orders', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(orders.rows);
});
app.post('/api/admin/confirm-order', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('UPDATE orders SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', req.body.orderId]);
  res.json({ success: true });
});
app.post('/api/admin/decline-order', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', req.body.orderId]);
  res.json({ success: true });
});

// === API: админка товары доната ===
app.get('/api/admin/products', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const products = await pool.query('SELECT * FROM donate_products ORDER BY id');
  res.json(products.rows);
});
app.post('/api/admin/add-product', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const { name, price, description, image_url } = req.body;
  await pool.query('INSERT INTO donate_products (name, price, description, image_url) VALUES ($1, $2, $3, $4)', [name, price, description, image_url]);
  res.json({ success: true });
});
app.put('/api/admin/update-product/:id', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const { name, price, description, image_url } = req.body;
  await pool.query('UPDATE donate_products SET name = $1, price = $2, description = $3, image_url = $4 WHERE id = $5', [name, price, description, image_url, req.params.id]);
  res.json({ success: true });
});
app.delete('/api/admin/delete-product/:id', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM donate_products WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// === API: админка сервера ===
app.get('/api/admin/servers', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const servers = await pool.query('SELECT * FROM servers ORDER BY id');
  res.json(servers.rows);
});
app.post('/api/admin/add-server', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const { name, ip, version, icon_url } = req.body;
  await pool.query('INSERT INTO servers (name, ip, version, icon_url, active) VALUES ($1, $2, $3, $4, true)', [name, ip, version, icon_url]);
  res.json({ success: true });
});
app.put('/api/admin/update-server/:id', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  const { name, ip, version, icon_url, active } = req.body;
  await pool.query('UPDATE servers SET name = $1, ip = $2, version = $3, icon_url = $4, active = $5 WHERE id = $6', [name, ip, version, icon_url, active, req.params.id]);
  res.json({ success: true });
});
app.delete('/api/admin/delete-server/:id', async (req, res) => {
  if (!req.user || !req.user.isOwner) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM servers WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/online', (req, res) => res.json({ online: 0, max: 20 }));

// === API: сообщения форума ===
app.get('/api/messages', async (req, res) => {
  const { category } = req.query;
  if (!category) return res.status(400).json({ error: 'Category required' });
  const result = await pool.query(`
    SELECT fm.*, u.username, u.avatar, u.discord_id
    FROM forum_messages fm
    JOIN users u ON fm.user_id = u.id
    WHERE fm.category = $1 AND fm.is_deleted = false
    ORDER BY fm.created_at ASC
  `, [category]);
  res.json(result.rows);
});
app.post('/api/messages', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { category, message } = req.body;
  const userResult = await pool.query('SELECT id FROM users WHERE discord_id = $1', [req.user.id]);
  if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  await pool.query('INSERT INTO forum_messages (user_id, category, message) VALUES ($1, $2, $3)', [userResult.rows[0].id, category, message]);
  res.json({ success: true });
});
app.delete('/api/messages/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
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
});

// === Запуск ===
app.listen(port, () => {
  console.log(`✅ Сервер Glow Worlds запущен на порту ${port}`);
});