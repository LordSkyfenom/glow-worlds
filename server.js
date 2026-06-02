require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const { Pool } = require('pg');
const { Client, EmbedBuilder } = require('discord.js');

const app = express();
const port = process.env.PORT || 3000;

// === База данных ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// === Discord бот ===
const discordBot = new Client({ intents: [] });

discordBot.once('ready', () => {
  console.log('🤖 Discord бот запущен');
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
  scope: ['identify', 'guilds', 'guilds.members.read']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let highestRoleName = 'Player';
    let highestRolePosition = -1;
    let isOwner = false;
    let allRoles = [];
    
    if (discordBot && process.env.DISCORD_GUILD_ID) {
      try {
        const guild = await discordBot.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await guild.members.fetch(profile.id);
        
        const sortedRoles = member.roles.cache
          .filter(role => role.name !== '@everyone')
          .sort((a, b) => b.position - a.position);
        
        allRoles = sortedRoles.map(r => ({ id: r.id, name: r.name, position: r.position }));
        
        const highestRole = sortedRoles.first();
        if (highestRole) {
          highestRoleName = highestRole.name;
          highestRolePosition = highestRole.position;
        }
        
        isOwner = sortedRoles.some(role => role.id === process.env.DISCORD_OWNER_ROLE_ID);
        
        console.log(`👤 ${profile.username}`);
        console.log(`   📋 Все роли: ${allRoles.map(r => `${r.name}(${r.position})`).join(', ')}`);
        console.log(`   ⭐ Высшая роль: ${highestRoleName} (позиция ${highestRolePosition})`);
        console.log(`   👑 Владелец: ${isOwner}`);
        
      } catch (err) {
        console.error('❌ Ошибка получения ролей:', err.message);
      }
    } else {
      console.log(`⚠️ Бот или GUILD_ID не настроены для пользователя ${profile.username}`);
    }
    
    const result = await pool.query('SELECT * FROM users WHERE discord_id = $1', [profile.id]);
    
    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (discord_id, username, avatar, role, is_owner) VALUES ($1, $2, $3, $4, $5)',
        [profile.id, profile.username, profile.avatar, highestRoleName, isOwner]
      );
    } else {
      await pool.query(
        'UPDATE users SET username = $1, avatar = $2, role = $3, is_owner = $4 WHERE discord_id = $5',
        [profile.username, profile.avatar, highestRoleName, isOwner, profile.id]
      );
    }
    
    return done(null, {
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      role: highestRoleName,
      isOwner: isOwner
    });
  } catch (err) {
    console.error('❌ Discord auth error:', err);
    return done(err, null);
  }
}));

// === ОТЛАДОЧНЫЙ МАРШРУТ ===
app.get('/debug-guild', async (req, res) => {
  if (!req.user) return res.status(401).send('Не авторизован. <a href="/auth/discord">Войдите через Discord</a>');
  
  try {
    if (!discordBot || !discordBot.isReady()) {
      return res.json({ error: 'Discord бот не готов или не запущен' });
    }
    
    const guild = await discordBot.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(req.user.id);
    const roles = member.roles.cache.map(r => ({ id: r.id, name: r.name, position: r.position }));
    
    res.json({
      guildName: guild.name,
      guildId: guild.id,
      memberName: member.user.username,
      memberId: member.id,
      roles: roles.sort((a, b) => b.position - a.position),
      isOwner: roles.some(r => r.id === process.env.DISCORD_OWNER_ROLE_ID),
      ownerRoleId: process.env.DISCORD_OWNER_ROLE_ID
    });
  } catch (err) {
    res.json({ error: err.message, stack: err.stack });
  }
});

// === Роуты страниц ===
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/donate', (req, res) => res.render('donate', { user: req.user }));
app.get('/forum', (req, res) => res.render('forum', { user: req.user }));

// === Профиль ===
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

// === ДОНАТ: создание заказа ===
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
    
    const paymentUrl = `https://yoomoney.ru/quickpay/confirm.xml?receiver=${process.env.YMONEY_WALLET}&quickpay-form=shop&targets=Заказ%20№${orderId}&sum=${price}&comment=order_${orderId}&successURL=${process.env.BASE_URL}/donate`;
    
    res.json({ orderId, price, paymentUrl, success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// === Пользователь нажал "Я оплатил" ===
app.post('/api/mark-as-paid', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { orderId } = req.body;
  
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND discord_id = $2', [orderId, req.user.id]);
    if (order.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['waiting_confirmation', orderId]);
    
    // Уведомление владельцу в Discord
    if (discordBot && process.env.DISCORD_OWNER_ROLE_ID && process.env.DISCORD_GUILD_ID) {
      try {
        const guild = await discordBot.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const ownerRole = guild.roles.cache.get(process.env.DISCORD_OWNER_ROLE_ID);
        if (ownerRole) {
          const channel = guild.systemChannel;
          if (channel) {
            const embed = new EmbedBuilder()
              .setColor(0xFFA500)
              .setTitle('💰 Новый ожидающий заказ!')
              .addFields(
                { name: '📦 Заказ #', value: `${orderId}`, inline: true },
                { name: '👤 Discord', value: `${req.user.username}`, inline: true },
                { name: '🎮 Minecraft ник', value: `${order.rows[0].minecraft_nick}`, inline: true },
                { name: '📦 Товар', value: `${order.rows[0].product_type}`, inline: true },
                { name: '💵 Сумма', value: `${order.rows[0].price} ₽`, inline: true }
              )
              .setTimestamp()
              .setFooter({ text: 'Зайдите в профиль на сайте, чтобы подтвердить или отклонить заказ.' });
            
            await channel.send({ content: `<@&${process.env.DISCORD_OWNER_ROLE_ID}>`, embeds: [embed] });
            console.log(`✅ Уведомление отправлено в канал о заказе #${orderId}`);
          }
        }
      } catch (err) {
        console.error('❌ Ошибка отправки уведомления:', err.message);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// === Отмена заказа пользователем ===
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
  
  try {
    await pool.query('UPDATE orders SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', orderId]);
    
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (order.rows.length > 0 && process.env.DISCORD_GUILD_ID && process.env.DISCORD_ROLE_SPONSOR) {
      try {
        const guild = await discordBot.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await guild.members.fetch(order.rows[0].discord_id);
        
        await member.roles.add(process.env.DISCORD_ROLE_SPONSOR);
        console.log(`✅ Роль спонсора выдана ${member.user.username}`);
        
        await member.send(`🎉 Ваш заказ #${orderId} подтверждён! Роль спонсора выдана. Спасибо за поддержку сервера Glow Worlds!`);
      } catch (err) {
        console.error('❌ Ошибка выдачи роли:', err.message);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
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