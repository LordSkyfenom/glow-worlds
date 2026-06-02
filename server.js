const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => res.render('index'));
app.get('/donate', (req, res) => res.render('donate'));
app.get('/forum', (req, res) => res.render('forum'));

app.get('/api/online', (req, res) => res.json({ online: 0, max: 20 }));

app.listen(port, () => console.log(`Сервер запущен: http://localhost:${port}`));