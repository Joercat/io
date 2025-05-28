const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Serve static files from public directory
app.use(express.static('public'));

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Game configuration
const CONFIG = {
    WORLD_SIZE: 4000,
    INITIAL_SNAKE_LENGTH: 5,
    INITIAL_SPEED: 3,
    BOOST_SPEED: 6,
    BOOST_CONSUMPTION: 0.5,
    HEAD_SIZE: 12,
    BODY_SIZE: 10,
    FOOD_SIZE: 4,
    MAX_FOOD: 800,
    COLLISION_DAMAGE: 3
};

class GameServer {
    constructor() {
        this.players = {};
        this.food = [];
        this.gameLoop = null;
        
        this.initializeFood();
        this.startGameLoop();
    }

    initializeFood() {
        for (let i = 0; i < CONFIG.MAX_FOOD; i++) {
            this.spawnFood();
        }
    }

    spawnFood() {
        const colors = [
            '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', 
            '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe',
            '#fd79a8', '#fdcb6e', '#e17055', '#00b894'
        ];
        
        this.food.push({
            id: Math.random().toString(36),
            x: Math.random() * (CONFIG.WORLD_SIZE - 100) + 50,
            y: Math.random() * (CONFIG.WORLD_SIZE - 100) + 50,
            size: CONFIG.FOOD_SIZE + Math.random() * 3,
            color: colors[Math.floor(Math.random() * colors.length)]
        });
    }

    createPlayer(socketId, name) {
        const colors = [
            '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24',
            '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe'
        ];

        const startX = Math.random() * (CONFIG.WORLD_SIZE - 200) + 100;
        const startY = Math.random() * (CONFIG.WORLD_SIZE - 200) + 100;
        const angle = Math.random() * Math.PI * 2;

        const segments = [];
        for (let i = 0; i < CONFIG.INITIAL_SNAKE_LENGTH; i++) {
            segments.push({
                x: startX - i * 15 * Math.cos(angle),
                y: startY - i * 15 * Math.sin(angle)
            });
        }

        return {
            id: socketId,
            name: name,
            segments: segments,
            angle: angle,
            speed: CONFIG.INITIAL_SPEED,
            boosting: false,
            color: colors[Math.floor(Math.random() * colors.length)],
            headSize: CONFIG.HEAD_SIZE,
            bodySize: CONFIG.BODY_SIZE,
            score: 0,
            health: 100,
            lastUpdate: Date.now()
        };
    }

    updatePlayer(player, deltaTime) {
        if (!player.segments.length) return;

        const speed = player.boosting ? CONFIG.BOOST_SPEED : CONFIG.INITIAL_SPEED;
        const head = player.segments[0];

        // Calculate new head position
        const newX = head.x + Math.cos(player.angle) * speed;
        const newY = head.y + Math.sin(player.angle) * speed;

        // Boundary collision - kill player
        if (newX < 0 || newX > CONFIG.WORLD_SIZE || newY < 0 || newY > CONFIG.WORLD_SIZE) {
            this.killPlayer(player.id);
            return;
        }

        // Add new head
        player.segments.unshift({ x: newX, y: newY });

        // Remove tail (except when growing)
        if (!player.growing) {
            player.segments.pop();
        } else {
            player.growing = false;
        }

        // Boost consumption
        if (player.boosting && player.segments.length > CONFIG.INITIAL_SNAKE_LENGTH) {
            if (Math.random() < 0.02) { // 2% chance per frame when boosting
                player.segments.pop();
                player.score = Math.max(0, player.score - 1);
            }
        }

        // Check food collision
        this.checkFoodCollision(player);

        // Check snake collisions
        this.checkSnakeCollisions(player);
    }

    checkFoodCollision(player) {
        const head = player.segments[0];
        
        for (let i = this.food.length - 1; i >= 0; i--) {
            const food = this.food[i];
            const distance = Math.sqrt(
                Math.pow(head.x - food.x, 2) + Math.pow(head.y - food.y, 2)
            );

            if (distance < player.headSize + food.size) {
                // Eat food
                this.food.splice(i, 1);
                player.growing = true;
                player.score += Math.floor(food.size);
                
                // Spawn new food
                this.spawnFood();
            }
        }
    }

    checkSnakeCollisions(player) {
        const head = player.segments[0];

        // Check collision with other players
        for (const otherPlayer of Object.values(this.players)) {
            if (otherPlayer.id === player.id) continue;
            if (!otherPlayer.segments.length) continue;

            for (let i = 0; i < otherPlayer.segments.length; i++) {
                const segment = otherPlayer.segments[i];
                const distance = Math.sqrt(
                    Math.pow(head.x - segment.x, 2) + Math.pow(head.y - segment.y, 2)
                );

                const collisionRadius = player.headSize + (i === 0 ? otherPlayer.headSize : otherPlayer.bodySize);
                
                if (distance < collisionRadius - 2) {
                    this.killPlayer(player.id);
                    // Create food from dead snake
                    this.spawnFoodFromSnake(player);
                    return;
                }
            }
        }

        // Check self collision (skip first few segments)
        for (let i = 4; i < player.segments.length; i++) {
            const segment = player.segments[i];
            const distance = Math.sqrt(
                Math.pow(head.x - segment.x, 2) + Math.pow(head.y - segment.y, 2)
            );

            if (distance < player.headSize + player.bodySize - 2) {
                this.killPlayer(player.id);
                this.spawnFoodFromSnake(player);
                return;
            }
        }
    }

    spawnFoodFromSnake(player) {
        // Create food orbs from snake segments
        for (let i = 0; i < player.segments.length; i += 2) {
            const segment = player.segments[i];
            if (this.food.length < CONFIG.MAX_FOOD * 2) {
                this.food.push({
                    id: Math.random().toString(36),
                    x: segment.x + (Math.random() - 0.5) * 20,
                    y: segment.y + (Math.random() - 0.5) * 20,
                    size: CONFIG.FOOD_SIZE + Math.random() * 4,
                    color: player.color
                });
            }
        }
    }

    killPlayer(playerId) {
        const player = this.players[playerId];
        if (player) {
            io.to(playerId).emit('playerDied', {
                playerId: playerId,
                score: player.score,
                length: player.segments.length
            });
            delete this.players[playerId];
        }
    }

    getGameState() {
        return {
            players: this.players,
            food: this.food,
            timestamp: Date.now()
        };
    }

    startGameLoop() {
        const targetFPS = 60;
        const frameTime = 1000 / targetFPS;
        
        this.gameLoop = setInterval(() => {
            const now = Date.now();
            
            // Update all players
            for (const player of Object.values(this.players)) {
                const deltaTime = now - player.lastUpdate;
                this.updatePlayer(player, deltaTime);
                player.lastUpdate = now;
            }

            // Maintain food count
            while (this.food.length < CONFIG.MAX_FOOD) {
                this.spawnFood();
            }

            // Send game state to all players
            io.emit('gameState', this.getGameState());
        }, frameTime);
    }

    addPlayer(socketId, name) {
        this.players[socketId] = this.createPlayer(socketId, name);
        return this.players[socketId];
    }

    removePlayer(socketId) {
        if (this.players[socketId]) {
            this.spawnFoodFromSnake(this.players[socketId]);
            delete this.players[socketId];
        }
    }

    updatePlayerDirection(socketId, angle) {
        if (this.players[socketId]) {
            this.players[socketId].angle = angle;
        }
    }

    updatePlayerBoost(socketId, boosting) {
        if (this.players[socketId]) {
            this.players[socketId].boosting = boosting;
        }
    }
}

// Initialize game server
const gameServer = new GameServer();

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinGame', (data) => {
        const player = gameServer.addPlayer(socket.id, data.name || 'Anonymous');
        socket.emit('playerJoined', { playerId: socket.id });
        console.log(`Player ${data.name} joined the game`);
    });

    socket.on('updateDirection', (data) => {
        gameServer.updatePlayerDirection(socket.id, data.angle);
    });

    socket.on('boost', (boosting) => {
        gameServer.updatePlayerBoost(socket.id, boosting);
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        gameServer.removePlayer(socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
