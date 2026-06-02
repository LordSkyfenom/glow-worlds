require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const { Pool } = require('pg');
const { Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();
const port = process.env.PORT || 3000;

// === База данных ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// === Discord бот для уведомлений ===
const discordBot = new Client({ intents: [] });

discordBot.once('ready', () => {
  console.log('🤖 Discord бот для уведомлений запущен');
});

discordBot.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error('❌ Ошибка входа Discord бота:', err.message);
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
    console.error('❌ Discord auth error:', err);
    return done(err, null);
  }
}));

// === Роуты страниц ===
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/donate', (req, res) => res.render('donate', { user: req.user }));
app.get('/forum', (req, res) => res.render('forum', { user: req.user }));

// === Discord авторизация ===
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// === ДОНАТ: создание заказа с уведомлением в ЛС Discord ===
app.post('/create-order', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { product, minecraft_nick } = req.body;
  const prices = { 'pickaxe': 150, 'crown': 250, 'key': 150 };
  const price = prices[product];
  
  if (!price) return res.status(400).json({ error: 'Invalid product' });
  
  try {
    const result = await pool.query(
      `INSERT INTO orders (discord_id, discord_name, minecraft_nick, product_type, price) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.id, req.user.username, minecraft_nick, product, price]
    );
    const orderId = result.rows[0].id;
    
    // Отправляем уведомление в ЛС админу в Discord
    if (discordBot && process.env.DISCORD_ADMIN_ID) {
      try {
        const adminUser = await discordBot.users.fetch(process.env.DISCORD_ADMIN_ID);
        if (adminUser) {
          const embed = new EmbedBuilder()
            .setColor(0x24af68)
            .setTitle('🆕 Новый заказ в донате!')
            .addFields(
              { name: '📦 Заказ #', value: `${orderId}`, inline: true },
              { name: '💰 Товар', value: `${product}`, inline: true },
              { name: '💵 Сумма', value: `${price} ₽`, inline: true },
              { name: '👤 Discord', value: `${req.user.username}`, inline: true },
              { name: '🎮 Minecraft ник', value: `${minecraft_nick}`, inline: true }
            )
            .setTimestamp();
          
          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`confirm_order_${orderId}`)
                .setLabel('✅ Подтвердить')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`decline_order_${orderId}`)
                .setLabel('❌ Отклонить')
                .setStyle(ButtonStyle.Danger)
            );
          
          await adminUser.send({ embeds: [embed], components: [row] });
          console.log(`✅ Уведомление отправлено админу о заказе #${orderId}`);
        }
      } catch (err) {
        console.error('❌ Ошибка отправки в ЛС:', err.message);
      }
    }
    
    res.json({ orderId, redirectUrl: `https://yoomoney.ru/quickpay/confirm.xml?receiver=${process.env.YMONEY_WALLET}&quickpay-form=shop&targets=Заказ%20№${orderId}&sum=${price}&comment=order_${orderId}&successURL=${process.env.BASE_URL}/donate?success=true` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// === Обработка кнопок подтверждения заказа (через API) ===
app.post('/api/confirm-order', async (req, res) => {
  const { orderId, action, adminId } = req.body;
  
  if (adminId !== process.env.DISCORD_ADMIN_ID) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  try {
    if (action === 'confirm') {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['confirmed', orderId]);
      console.log(`✅ Заказ #${orderId} подтверждён админом`);
    } else if (action === 'decline') {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', orderId]);
      console.log(`❌ Заказ #${orderId} отклонён админом`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === ВЕБХУК от ЮMoney ===
app.post('/yoomoney-webhook', async (req, res) => {
  const { notification_type, operation_id, label, amount, currency, datetime, sender, codepro, sha1_hash } = req.body;
  
  if (notification_type === 'p2p-incoming') {
    const orderId = label.split('_')[1];
    await pool.query('UPDATE orders SET status = $1, payment_id = $2 WHERE id = $3', ['paid', operation_id, orderId]);
    console.log(`✅ Заказ #${orderId} оплачен, ожидает подтверждения админом`);
  }
  
  res.send('OK');
});

// === API: получить сообщения форума ===
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

// === API: отправить сообщение ===
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

// === API: удалить сообщение ===
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
    const isAdmin = req.user.id === process.env.ADMIN_DISCORD_ID;
    
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

// === API: онлайн ===
app.get('/api/online', (req, res) => {
  res.json({ online: 0, max: 20 });
});

// === Запуск сервера ===
app.listen(port, () => {
  console.log(`✅ Сервер Glow Worlds запущен на порту ${port}`);
});