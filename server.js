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

const HOST_CODE = '12345678';

// プレイヤー管理: { "ユーザー名": { originalSocketId, name, isHost, currentSocketId, isOnline } }
let playersByName = {};
let playerOrder = []; // プレイヤー名（または識別ID）の配列
let chains = {};
let currentTurn = 0;
let totalTurns = 0;
let submittedCount = 0;
let timer = null;
let timeLeft = 60;
let isForcingNext = false;
let gameStarted = false;

io.on('connection', (socket) => {

    // ユーザー名登録 & 復帰判定
    socket.on('set-name', (data) => {
        const userName = data.name.trim() || '名無し';
        const isHostAttempt = (data.hostCode === HOST_CODE);

        // 🔄 再接続（同じ名前での入り直し）の判定
        if (playersByName[userName]) {
            // Socket IDの更新
            playersByName[userName].currentSocketId = socket.id;
            playersByName[userName].isOnline = true;
            if (isHostAttempt) playersByName[userName].isHost = true;

            socket.emit('host-granted', playersByName[userName].isHost);
            socket.emit('info-msg', `おかえりなさい！ ${userName} さんとして復帰しました。`);

            // ゲーム進行中の場合、現在のフェーズに復帰させる
            if (gameStarted) {
                reconnectPlayerToGame(socket, userName);
            } else {
                socket.emit('waiting-lobby');
            }
        } else {
            // ✨ 新規参加
            playersByName[userName] = {
                originalSocketId: socket.id,
                currentSocketId: socket.id,
                name: userName,
                isHost: isHostAttempt,
                isOnline: true
            };

            socket.emit('host-granted', isHostAttempt);
            if (!gameStarted) {
                socket.emit('waiting-lobby');
            }
        }

        io.emit('update-players', Object.keys(playersByName).length);
    });

    // 🎮 ゲーム開始処理（ホストのみ）
    socket.on('start-game', () => {
        const player = getPlayerBySocketId(socket.id);
        if (!player || !player.isHost) {
            socket.emit('error-msg', '⚠️ ゲームを開始できるのはホストのみです！');
            return;
        }

        const activePlayerNames = Object.keys(playersByName);
        if (activePlayerNames.length < 2) {
            socket.emit('error-msg', '⚠️ ゲームを開始するには2人以上必要です！');
            return;
        }

        gameStarted = true;
        playerOrder = activePlayerNames.sort(() => Math.random() - 0.5);
        currentTurn = 0;
        totalTurns = playerOrder.length;
        submittedCount = 0;
        chains = {};

        playerOrder.forEach((name) => { chains[name] = []; });

        io.emit('game-phase', { phase: 'initial_theme' });
        updateProgress();
        startTimer(60, () => forceSubmitAll());
    });

    // ⚡ 強制進行（ホストのみ）
    socket.on('force-next-phase', () => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.isHost) {
            forceSubmitAll();
        } else {
            socket.emit('error-msg', '⚠️ 強制進行できるのはホストのみです！');
        }
    });

    // 1. 最初のお題入力
    socket.on('submit-initial-theme', (text) => {
        const player = getPlayerBySocketId(socket.id);
        if (!player || !chains[player.name] || hasSubmitted(player.name)) return;

        chains[player.name].push({ type: 'text', value: text || '（未入力）', author: player.name, authorName: player.name });
        submittedCount++;
        updateProgress();

        checkTurnCompletion();
    });

    // 2. お絵かき完了
    socket.on('submit-drawing', (imageData) => {
        const player = getPlayerBySocketId(socket.id);
        if (!player) return;

        const sourceOwnerName = getSourceOwnerForPlayer(player.name, currentTurn);
        if (!sourceOwnerName || hasSubmitted(player.name, sourceOwnerName)) return;

        chains[sourceOwnerName].push({ type: 'image', value: imageData, author: player.name, authorName: player.name });
        submittedCount++;
        updateProgress();

        checkTurnCompletion();
    });

    // 3. 回答完了
    socket.on('submit-answer', (text) => {
        const player = getPlayerBySocketId(socket.id);
        if (!player) return;

        const sourceOwnerName = getSourceOwnerForPlayer(player.name, currentTurn);
        if (!sourceOwnerName || hasSubmitted(player.name, sourceOwnerName)) return;

        chains[sourceOwnerName].push({ type: 'text', value: text || '（未入力）', author: player.name, authorName: player.name });
        submittedCount++;
        updateProgress();

        checkTurnCompletion();
    });

    socket.on('disconnect', () => {
        const player = getPlayerBySocketId(socket.id);
        if (player) {
            player.isOnline = false;
        }
        io.emit('update-players', Object.keys(playersByName).length);
    });
});

function getPlayerBySocketId(socketId) {
    return Object.values(playersByName).find(p => p.currentSocketId === socketId);
}

function getSourceOwnerForPlayer(playerName, turn) {
    const playerIndex = playerOrder.indexOf(playerName);
    if (playerIndex === -1) return null;
    const sourceIndex = (playerIndex - turn + playerOrder.length) % playerOrder.length;
    return playerOrder[sourceIndex];
}

function hasSubmitted(playerName, sourceOwnerName = playerName) {
    return chains[sourceOwnerName]?.some(item => item.author === playerName);
}

function checkTurnCompletion() {
    if (submittedCount >= playerOrder.length) {
        startNextTurn();
    } else {
        const player = Object.values(playersByName).find(p => p.currentSocketId);
        if (player) io.to(player.currentSocketId).emit('waiting');
    }
}

// 🔄 再接続時のゲーム状況復元
function reconnectPlayerToGame(socket, userName) {
    if (currentTurn >= totalTurns) {
        socket.emit('game-phase', { phase: 'result', chains: chains, order: playerOrder });
        return;
    }

    const sourceOwnerName = (currentTurn === 0) ? userName : getSourceOwnerForPlayer(userName, currentTurn);
    
    // すでに提出済みなら待機画面へ
    if (hasSubmitted(userName, sourceOwnerName)) {
        socket.emit('waiting');
        return;
    }

    if (currentTurn === 0) {
        socket.emit('game-phase', { phase: 'initial_theme' });
    } else {
        const isDrawingTurn = currentTurn % 2 === 1;
        const lastEntry = chains[sourceOwnerName][chains[sourceOwnerName].length - 1];

        if (isDrawingTurn) {
            socket.emit('game-phase', {
                phase: 'draw',
                promptText: lastEntry ? lastEntry.value : 'お題なし'
            });
        } else {
            socket.emit('game-phase', {
                phase: 'guess',
                promptImage: lastEntry ? lastEntry.value : ''
            });
        }
    }
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
    if (isForcingNext) return;
    isForcingNext = true;
    clearInterval(timer);

    io.emit('force-submit');

    setTimeout(() => {
        playerOrder.forEach((name) => {
            const sourceOwnerName = (currentTurn === 0) ? name : getSourceOwnerForPlayer(name, currentTurn);
            if (sourceOwnerName && !hasSubmitted(name, sourceOwnerName)) {
                if (currentTurn === 0) {
                    chains[name].push({ type: 'text', value: '（時間切れ/未提出）', author: name, authorName: name });
                } else if (currentTurn % 2 === 1) {
                    const dummyCanvas = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
                    chains[sourceOwnerName].push({ type: 'image', value: dummyCanvas, author: name, authorName: name });
                } else {
                    chains[sourceOwnerName].push({ type: 'text', value: '（時間切れ/未提出）', author: name, authorName: name });
                }
                submittedCount++;
            }
        });
        startNextTurn();
    }, 1200);
}

function startNextTurn() {
    clearInterval(timer);
    isForcingNext = false;
    submittedCount = 0;
    currentTurn++;

    if (currentTurn >= totalTurns) {
        gameStarted = false;
        io.emit('game-phase', { phase: 'result', chains: chains, order: playerOrder });
        return;
    }

    const isDrawingTurn = currentTurn % 2 === 1;
    updateProgress();

    playerOrder.forEach((name) => {
        const pObj = playersByName[name];
        const sourceOwnerName = getSourceOwnerForPlayer(name, currentTurn);
        const lastEntry = chains[sourceOwnerName][chains[sourceOwnerName].length - 1];

        if (pObj && pObj.currentSocketId) {
            if (isDrawingTurn) {
                io.to(pObj.currentSocketId).emit('game-phase', {
                    phase: 'draw',
                    promptText: lastEntry ? lastEntry.value : 'お題なし'
                });
            } else {
                io.to(pObj.currentSocketId).emit('game-phase', {
                    phase: 'guess',
                    promptImage: lastEntry ? lastEntry.value : ''
                });
            }
        }
    });

    startTimer(60, () => forceSubmitAll());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
