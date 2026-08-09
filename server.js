const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const HOST_CODE = '12345678'; // 設定したホストコード

let players = {}; // { socketId: { name: '名前', isHost: false } }
let playerOrder = [];
let chains = {};
let currentTurn = 0;
let totalTurns = 0;
let submittedCount = 0;
let timer = null;
let timeLeft = 60;

io.on('connection', (socket) => {
    players[socket.id] = { name: '名無し', isHost: false };

    // ユーザー名登録 & ホスト判定
    socket.on('set-name', (data) => {
        if (players[socket.id]) {
            players[socket.id].name = data.name.trim() || '名無し';
            
            // 入力されたコードが一致する場合のみホスト権限を与える
            if (data.hostCode === HOST_CODE) {
                players[socket.id].isHost = true;
                socket.emit('host-granted', true); // ホスト権限通知
            } else {
                players[socket.id].isHost = false;
                socket.emit('host-granted', false);
            }
        }
        io.emit('update-players', Object.keys(players).length);
    });

    io.emit('update-players', Object.keys(players).length);

    // ゲーム開始処理
    socket.on('start-game', () => {
        const clients = Object.keys(players);
        if (clients.length < 2) return;

        playerOrder = clients.sort(() => Math.random() - 0.5);
        currentTurn = 0;
        totalTurns = playerOrder.length;
        submittedCount = 0;
        chains = {};

        playerOrder.forEach((id) => { chains[id] = []; });

        io.emit('game-phase', { phase: 'initial_theme' });
        updateProgress();
        startTimer(60, () => forceSubmitAll());
    });

    // 🔒 厳格なホスト判定：ホスト権限を持つユーザーだけが強制進行可能
    socket.on('force-next-phase', () => {
        if (players[socket.id] && players[socket.id].isHost) {
            forceSubmitAll();
        } else {
            socket.emit('error-msg', '⚠️ 強制進行できるのはホストのみです！');
        }
    });

    // 1. 最初のお題入力
    socket.on('submit-initial-theme', (text) => {
        if (!chains[socket.id] || hasSubmitted(socket.id)) return;

        const userName = players[socket.id]?.name || '名無し';
        chains[socket.id].push({ type: 'text', value: text || '無題', author: socket.id, authorName: userName });
        submittedCount++;
        updateProgress();

        if (submittedCount === playerOrder.length) {
            startNextTurn();
        } else {
            socket.emit('waiting');
        }
    });

    // 2. お絵かき完了
    socket.on('submit-drawing', (imageData) => {
        const sourceOwnerId = getSourceOwnerForPlayer(socket.id, currentTurn);
        if (hasSubmitted(socket.id, sourceOwnerId)) return;

        const userName = players[socket.id]?.name || '名無し';
        chains[sourceOwnerId].push({ type: 'image', value: imageData, author: socket.id, authorName: userName });
        submittedCount++;
        updateProgress();

        if (submittedCount === playerOrder.length) {
            startNextTurn();
        } else {
            socket.emit('waiting');
        }
    });

    // 3. 回答完了
    socket.on('submit-answer', (text) => {
        const sourceOwnerId = getSourceOwnerForPlayer(socket.id, currentTurn);
        if (hasSubmitted(socket.id, sourceOwnerId)) return;

        const userName = players[socket.id]?.name || '名無し';
        chains[sourceOwnerId].push({ type: 'text', value: text || 'パス', author: socket.id, authorName: userName });
        submittedCount++;
        updateProgress();

        if (submittedCount === playerOrder.length) {
            startNextTurn();
        } else {
            socket.emit('waiting');
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update-players', Object.keys(players).length);
    });
});

function getSourceOwnerForPlayer(playerId, turn) {
    const playerIndex = playerOrder.indexOf(playerId);
    const sourceIndex = (playerIndex - turn + playerOrder.length) % playerOrder.length;
    return playerOrder[sourceIndex];
}

function hasSubmitted(playerId, sourceOwnerId = playerId) {
    return chains[sourceOwnerId]?.some(item => item.author === playerId);
}

function updateProgress() {
    io.emit('progress-update', {
        current: submittedCount,
        total: playerOrder.length
    });
}

function startTimer(duration, onTimeout) {
    clearInterval(timer);
    timeLeft = duration;
    io.emit('timer-update', timeLeft);

    timer = setInterval(() => {
        timeLeft--;
        io.emit('timer-update', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(timer);
            onTimeout();
        }
    }, 1000);
}

function forceSubmitAll() {
    io.emit('force-submit');
}

function startNextTurn() {
    clearInterval(timer);
    submittedCount = 0;
    currentTurn++;

    if (currentTurn >= totalTurns) {
        io.emit('game-phase', { phase: 'result', chains: chains, order: playerOrder });
        return;
    }

    const isDrawingTurn = currentTurn % 2 === 1;
    updateProgress();

    playerOrder.forEach((id) => {
        const sourceOwnerId = getSourceOwnerForPlayer(id, currentTurn);
        const lastEntry = chains[sourceOwnerId][chains[sourceOwnerId].length - 1];

        if (isDrawingTurn) {
            io.to(id).emit('game-phase', {
                phase: 'draw',
                promptText: lastEntry.value
            });
        } else {
            io.to(id).emit('game-phase', {
                phase: 'guess',
                promptImage: lastEntry.value
            });
        }
    });

    startTimer(60, () => forceSubmitAll());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
