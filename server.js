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

// ゲームデータ管理
let playerOrder = []; // プレイヤーの順番 [socketId1, socketId2, ...]
let chains = {};      // 各プレイヤー発の伝言チェーンデータ
let currentTurn = 0;  // 現在のターン数
let totalTurns = 0;   // 総ターン数（人数分）
let submittedCount = 0;
let timer = null;

io.on('connection', (socket) => {
    console.log('接続:', socket.id);

    // 接続時に現在の状態
    io.emit('update-players', io.engine.clientsCount);

    // ゲーム開始（2人以上）
    socket.on('start-game', () => {
        const clients = Array.from(io.sockets.sockets.keys());
        if (clients.length < 2) return;

        playerOrder = clients.sort(() => Math.random() - 0.5); // 順番をシャッフル
        currentTurn = 0;
        totalTurns = playerOrder.length;
        submittedCount = 0;
        chains = {};

        // 各プレイヤーのチェーン初期化
        playerOrder.forEach((id) => {
            chains[id] = [];
        });

        // 全員にお題入力フェーズを通知
        io.emit('game-phase', { phase: 'initial_theme' });
    });

    // 1. 最初のお題入力完了
    socket.on('submit-initial-theme', (text) => {
        if (!chains[socket.id]) return;

        chains[socket.id].push({ type: 'text', value: text, author: socket.id });
        submittedCount++;

        if (submittedCount === playerOrder.length) {
            startNextTurn();
        } else {
            socket.emit('waiting');
        }
    });

    // 2. お絵かき完了（またはタイムアップ）
    socket.on('submit-drawing', (imageData) => {
        const sourceOwnerId = getSourceOwnerForPlayer(socket.id, currentTurn);
        chains[sourceOwnerId].push({ type: 'image', value: imageData, author: socket.id });
        submittedCount++;

        if (submittedCount === playerOrder.length) {
            startNextTurn();
        } else {
            socket.emit('waiting');
        }
    });

    // 3. 回答（文章）完了
    socket.on('submit-answer', (text) => {
        const sourceOwnerId = getSourceOwnerForPlayer(socket.id, currentTurn);
        chains[sourceOwnerId].push({ type: 'text', value: text, author: socket.id });
        submittedCount++;

        if (submittedCount === playerOrder.length) {
            startNextTurn();
        } else {
            socket.emit('waiting');
        }
    });

    // 切断処理
    socket.on('disconnect', () => {
        io.emit('update-players', io.engine.clientsCount);
    });
});

// 現在のプレイヤーがどの「チェーン（伝言のもと）」を担当するか計算する関数
function getSourceOwnerForPlayer(playerId, turn) {
    const playerIndex = playerOrder.indexOf(playerId);
    const sourceIndex = (playerIndex - turn + playerOrder.length) % playerOrder.length;
    return playerOrder[sourceIndex];
}

// ターン進行処理
function startNextTurn() {
    clearInterval(timer);
    submittedCount = 0;
    currentTurn++;

    // 全ターン終了したら結果発表へ
    if (currentTurn >= totalTurns) {
        io.emit('game-phase', { phase: 'result', chains: chains, order: playerOrder });
        return;
    }

    // ターンタイプ判定（偶数ターンは絵を描く、奇数ターンは文章で当てる）
    const isDrawingTurn = currentTurn % 2 === 1;

    playerOrder.forEach((id) => {
        const sourceOwnerId = getSourceOwnerForPlayer(id, currentTurn);
        const lastEntry = chains[sourceOwnerId][chains[sourceOwnerId].length - 1];

        if (isDrawingTurn) {
            // 前の人の「文章」を見て「絵」を描く
            io.to(id).emit('game-phase', {
                phase: 'draw',
                promptText: lastEntry.value,
                timeLimit: 30
            });
        } else {
            // 前の人の「絵」を見て「文章」を当てる
            io.to(id).emit('game-phase', {
                phase: 'guess',
                promptImage: lastEntry.value,
                timeLimit: 20
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
