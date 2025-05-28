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
    },
    // Performance optimizations
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Serve static files from public directory
app.use(express.static('public'));

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Game configuration - optimized for performance
const CONFIG = {
    WORLD_SIZE: 4000,
    INITIAL_SNAKE_LENGTH: 5,
    INITIAL_SPEED: 3,
    BOOST_SPEED: 6,
    BOOST_CONSUMPTION: 0.5,
    HEAD_SIZE: 12,
    BODY_SIZE: 10,
    FOOD_SIZE: 4,
    MAX_FOOD: 600, // Reduced from 800
    COLLISION_DAMAGE: 3,
    SPAWN_IMMUNITY_TIME: 3000,
    COLLISION_TOLERANCE: 2,
    // Performance settings
    TICK_RATE: 30, // Reduced from 60 for better performance
    SPATIAL_GRID_SIZE: 100, // For spatial partitioning
    MAX_FOOD_FROM_SNAKE: 50 // Limit food spawning from dead snakes
};

class SpatialGrid {
    constructor(worldSize, cellSize) {
        this.cellSize = cellSize;
        this.cols = Math.ceil(worldSize / cellSize);
        this.rows = Math.ceil(worldSize / cellSize);
        this.grid = new Map();
    }

    clear() {
        this.grid.clear();
    }

    getKey(x, y) {
        const col = Math.floor(x / this.cellSize);
        const row = Math.floor(y / this.cellSize);
        return `${col},${row}`;
    }

    insert(x, y, object) {
        const key = this.getKey(x, y);
        if (!this.grid.has(key)) {
            this.grid.set(key, []);
        }
        this.grid.get(key).push(object);
    }

    getNearby(x, y, radius = 1) {
        const nearby = [];
        const col = Math.floor(x / this.cellSize);
        const row = Math.floor(y / this.cellSize);

        for (let i = -radius; i <= radius; i++) {
            for (let j = -radius; j <= radius; j++) {
                const key = `${col + i},${row + j}`;
                if (this.grid.has(key)) {
                    nearby.push(...this.grid.get(key));
                }
            }
        }
        return nearby;
    }
}

class GameServer {
    constructor() {
        this.players = new Map(); // Use Map for better performance
        this.food = [];
        this.gameLoop = null;
        this.lastUpdate = Date.now();
        
        // Spatial partitioning for collision detection
        this.spatialGrid = new SpatialGrid(CONFIG.WORLD_SIZE, CONFIG.SPATIAL_GRID_SIZE);
        
        // Pre-allocate arrays to reduce garbage collection
        this.playersToUpdate = [];
        this.deadPlayers = [];
        
        // Batch updates
        this.pendingUpdates = {
            players: new Set(),
            food: false
        };
        
        this.initializeFood();
        this.startGameLoop();
    }

    initializeFood() {
        // Pre-allocate food array
        this.food = new Array(CONFIG.MAX_FOOD);
        for (let i = 0; i < CONFIG.MAX_FOOD; i++) {
            this.food[i] = this.createFood();
        }
    }

    createFood() {
        const colors = [
            '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24',
            '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe',
            '#fd79a8', '#fdcb6e', '#e17055', '#00b894'
        ];

        return {
            id: Math.random().toString(36).substr(2, 9), // Faster ID generation
            x: Math.random() * (CONFIG.WORLD_SIZE - 100) + 50,
            y: Math.random() * (CONFIG.WORLD_SIZE - 100) + 50,
            size: CONFIG.FOOD_SIZE + Math.random() * 3,
            color: colors[Math.floor(Math.random() * colors.length)]
        };
    }

    spawnFood() {
        // Find empty slot or replace oldest
        for (let i = 0; i < this.food.length; i++) {
            if (!this.food[i]) {
                this.food[i] = this.createFood();
                return;
            }
        }
        // If no empty slots, replace random food
        const index = Math.floor(Math.random() * this.food.length);
        this.food[index] = this.createFood();
    }

    createPlayer(socketId, name) {
        const colors = [
            '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24',
            '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe'
        ];

        // Faster spawn location finding
        const startX = Math.random() * (CONFIG.WORLD_SIZE - 400) + 200;
        const startY = Math.random() * (CONFIG.WORLD_SIZE - 400) + 200;
        const angle = Math.random() * Math.PI * 2;
        
        // Pre-allocate segments array
        const segments = new Array(CONFIG.INITIAL_SNAKE_LENGTH);
        for (let i = 0; i < CONFIG.INITIAL_SNAKE_LENGTH; i++) {
            segments[i] = {
                x: startX - i * 20 * Math.cos(angle),
                y: startY - i * 20 * Math.sin(angle)
            };
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
            lastUpdate: Date.now(),
            spawnTime: Date.now(),
            isInvulnerable: true,
            growing: false,
            needsUpdate: true
        };
    }

    updatePlayer(player, deltaTime) {
        if (!player.segments || player.segments.length === 0) return;

        // Check spawn immunity
        if (player.isInvulnerable && Date.now() - player.spawnTime > CONFIG.SPAWN_IMMUNITY_TIME) {
            player.isInvulnerable = false;
            player.needsUpdate = true;
        }

        const speed = player.boosting ? CONFIG.BOOST_SPEED : CONFIG.INITIAL_SPEED;
        const head = player.segments[0];
        
        // Calculate new head position
        const newX = head.x + Math.cos(player.angle) * speed;
        const newY = head.y + Math.sin(player.angle) * speed;

        // Boundary collision
        const margin = 30;
        if (newX < -margin || newX > CONFIG.WORLD_SIZE + margin ||
            newY < -margin || newY > CONFIG.WORLD_SIZE + margin) {
            this.deadPlayers.push(player.id);
            return;
        }

        // Update position
        player.segments[0] = { x: newX, y: newY };

        // Handle growth/tail removal
        if (player.growing) {
            player.segments.push({ x: head.x, y: head.y });
            player.growing = false;
        } else {
            // Shift segments efficiently
            for (let i = player.segments.length - 1; i > 0; i--) {
                player.segments[i].x = player.segments[i - 1].x;
                player.segments[i].y = player.segments[i - 1].y;
            }
        }

        // Boost consumption (optimized)
        if (player.boosting && player.segments.length > CONFIG.INITIAL_SNAKE_LENGTH + 3) {
            if (Math.random() < 0.01) { // Reduced frequency
                player.segments.pop();
                player.score = Math.max(0, player.score - 1);
                player.needsUpdate = true;
            }
        }

        // Mark for collision checking
        this.pendingUpdates.players.add(player);
    }

    checkCollisions() {
        // Clear spatial grid
        this.spatialGrid.clear();

        // Insert all snake segments into spatial grid
        for (const player of this.players.values()) {
            if (!player.segments || player.segments.length === 0) continue;
            
            for (let i = 0; i < player.segments.length; i++) {
                const segment = player.segments[i];
                this.spatialGrid.insert(segment.x, segment.y, {
                    player: player,
                    segmentIndex: i,
                    x: segment.x,
                    y: segment.y
                });
            }
        }

        // Check collisions using spatial grid
        for (const player of this.pendingUpdates.players) {
            if (!player.segments || player.segments.length === 0) continue;
            
            const head = player.segments[0];
            const nearby = this.spatialGrid.getNearby(head.x, head.y, 1);

            // Check food collision (optimized)
            this.checkFoodCollisionOptimized(player, head);

            // Check snake collisions only if not invulnerable
            if (!player.isInvulnerable) {
                this.checkSnakeCollisionsOptimized(player, head, nearby);
            }
        }
    }

    checkFoodCollisionOptimized(player, head) {
        // Use spatial awareness for food collision
        for (let i = this.food.length - 1; i >= 0; i--) {
            const food = this.food[i];
            if (!food) continue;

            const dx = head.x - food.x;
            const dy = head.y - food.y;
            const distanceSquared = dx * dx + dy * dy; // Avoid sqrt for performance
            const collisionDistanceSquared = Math.pow(player.headSize + food.size, 2);

            if (distanceSquared < collisionDistanceSquared) {
                // Eat food
                this.food[i] = null; // Mark for removal
                player.growing = true;
                player.score += Math.floor(food.size);
                player.needsUpdate = true;
                this.pendingUpdates.food = true;
                
                // Spawn new food (batched)
                setTimeout(() => this.spawnFood(), 0);
            }
        }
    }

    checkSnakeCollisionsOptimized(player, head, nearby) {
        const headSize = player.headSize;

        for (const nearbyObject of nearby) {
            const otherPlayer = nearbyObject.player;
            const segmentIndex = nearbyObject.segmentIndex;

            // Skip self collision for first few segments
            if (otherPlayer.id === player.id && segmentIndex < 8) continue;
            
            // Skip if other player is invulnerable
            if (otherPlayer.isInvulnerable && otherPlayer.id !== player.id) continue;

            const dx = head.x - nearbyObject.x;
            const dy = head.y - nearbyObject.y;
            const distanceSquared = dx * dx + dy * dy;

            const otherSize = segmentIndex === 0 ? otherPlayer.headSize : otherPlayer.bodySize;
            const collisionDistanceSquared = Math.pow(headSize + otherSize - CONFIG.COLLISION_TOLERANCE, 2);

            if (distanceSquared < collisionDistanceSquared) {
                this.deadPlayers.push(player.id);
                return;
            }
        }
    }

    processDead() {
        for (const playerId of this.deadPlayers) {
            const player = this.players.get(playerId);
            if (player) {
                this.spawnFoodFromSnake(player);
                io.to(playerId).emit('playerDied', {
                    playerId: playerId,
                    score: player.score,
                    length: player.segments.length
                });
                this.players.delete(playerId);
            }
        }
        this.deadPlayers.length = 0;
    }

    spawnFoodFromSnake(player) {
        // Limit food spawning to prevent lag
        const maxFoodToSpawn = Math.min(player.segments.length / 2, CONFIG.MAX_FOOD_FROM_SNAKE);
        
        for (let i = 0; i < maxFoodToSpawn && i < player.segments.length; i += 2) {
            const segment = player.segments[i];
            
            // Find empty slot in food array
            for (let j = 0; j < this.food.length; j++) {
                if (!this.food[j]) {
                    this.food[j] = {
                        id: Math.random().toString(36).substr(2, 9),
                        x: segment.x + (Math.random() - 0.5) * 20,
                        y: segment.y + (Math.random() - 0.5) * 20,
                        size: CONFIG.FOOD_SIZE + Math.random() * 4,
                        color: player.color
                    };
                    break;
                }
            }
        }
        this.pendingUpdates.food = true;
    }

    getGameState() {
        // Only send data that has changed
        const state = {
            timestamp: Date.now()
        };

        // Convert Map to Object for transmission
        if (this.pendingUpdates.players.size > 0) {
            state.players = {};
            for (const [id, player] of this.players) {
                state.players[id] = player;
            }
        }

        if (this.pendingUpdates.food) {
            // Filter out null food items
            state.food = this.food.filter(f => f !== null);
            this.pendingUpdates.food = false;
        }

        return state;
    }

    startGameLoop() {
        const frameTime = 1000 / CONFIG.TICK_RATE;
        let lastTime = Date.now();

        this.gameLoop = setInterval(() => {
            const now = Date.now();
            const deltaTime = now - lastTime;
            lastTime = now;

            // Clear pending updates
            this.pendingUpdates.players.clear();

            // Update all players
            for (const player of this.players.values()) {
                this.updatePlayer(player, deltaTime);
                player.lastUpdate = now;
            }

            // Process collisions in batch
            if (this.pendingUpdates.players.size > 0) {
                this.checkCollisions();
            }

            // Process dead players
            this.processDead();

            // Clean up null food items periodically
            if (Math.random() < 0.1) { // 10% chance each tick
                this.cleanupFood();
            }

            // Send game state (only if there are updates)
            const gameState = this.getGameState();
            if (gameState.players || gameState.food) {
                io.emit('gameState', gameState);
            }

            // Reset update flags
            for (const player of this.players.values()) {
                player.needsUpdate = false;
            }

        }, frameTime);
    }

    cleanupFood() {
        // Remove null entries and maintain food count
        this.food = this.food.filter(f => f !== null);
        
        // Spawn new food to maintain count
        while (this.food.length < CONFIG.MAX_FOOD) {
            this.food.push(this.createFood());
        }
        
        if (this.food.length < CONFIG.MAX_FOOD) {
            this.pendingUpdates.food = true;
        }
    }

    addPlayer(socketId, name) {
        const player = this.createPlayer(socketId, name);
        this.players.set(socketId, player);
        this.pendingUpdates.players.add(player);
        return player;
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            this.spawnFoodFromSnake(player);
            this.players.delete(socketId);
        }
    }

    updatePlayerDirection(socketId, angle) {
        const player = this.players.get(socketId);
        if (player && Math.abs(player.angle - angle) > 0.1) { // Only update if significant change
            player.angle = angle;
            player.needsUpdate = true;
            this.pendingUpdates.players.add(player);
        }
    }

    updatePlayerBoost(socketId, boosting) {
        const player = this.players.get(socketId);
        if (player && player.boosting !== boosting) { // Only update if changed
            player.boosting = boosting;
            player.needsUpdate = true;
            this.pendingUpdates.players.add(player);
        }
    }

    // Get player count for monitoring
    getPlayerCount() {
        return this.players.size;
    }

    // Get performance stats
    getStats() {
        return {
            players: this.players.size,
            food: this.food.filter(f => f !== null).length,
            memoryUsage: process.memoryUsage()
        };
    }
}

// Initialize game server
const gameServer = new GameServer();

// Performance monitoring
setInterval(() => {
    const stats = gameServer.getStats();
    console.log(`Players: ${stats.players}, Food: ${stats.food}, Memory: ${Math.round(stats.memoryUsage.heapUsed / 1024 / 1024)}MB`);
}, 30000); // Log every 30 seconds

// Socket.io connection handling with optimizations
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    // Rate limiting for input events
    let lastDirectionUpdate = 0;
    let lastBoostUpdate = 0;
    const DIRECTION_RATE_LIMIT = 16; // ~60fps max
    const BOOST_RATE_LIMIT = 100; // 10 times per second max

    socket.on('joinGame', (data) => {
        try {
            const player = gameServer.addPlayer(socket.id, data.name || 'Anonymous');
            socket.emit('playerJoined', { 
                playerId: socket.id,
                config: {
                    worldSize: CONFIG.WORLD_SIZE,
                    tickRate: CONFIG.TICK_RATE
                }
            });
            console.log(`Player ${data.name} joined the game`);
        } catch (error) {
            console.error('Error joining game:', error);
            socket.emit('error', { message: 'Failed to join game' });
        }
    });

    socket.on('updateDirection', (data) => {
        const now = Date.now();
        if (now - lastDirectionUpdate < DIRECTION_RATE_LIMIT) return;
        lastDirectionUpdate = now;

        try {
            if (typeof data.angle === 'number' && !isNaN(data.angle)) {
                gameServer.updatePlayerDirection(socket.id, data.angle);
            }
        } catch (error) {
            console.error('Error updating direction:', error);
        }
    });

    socket.on('boost', (boosting) => {
        const now = Date.now();
        if (now - lastBoostUpdate < BOOST_RATE_LIMIT) return;
        lastBoostUpdate = now;

        try {
            if (typeof boosting === 'boolean') {
                gameServer.updatePlayerBoost(socket.id, boosting);
            }
        } catch (error) {
            console.error('Error updating boost:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        try {
            gameServer.removePlayer(socket.id);
        } catch (error) {
            console.error('Error removing player:', error);
        }
    });

    // Handle client errors
    socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🐍 Optimized Slither.io server running on port ${PORT}`);
    console.log(`🌐 Visit http://localhost:${PORT} to play!`);
    console.log(`⚡ Performance optimizations enabled:`);
    console.log(`   - Tick rate: ${CONFIG.TICK_RATE}fps`);
    console.log(`   - Spatial partitioning enabled`);
    console.log(`   - Memory optimizations active`);
    console.log(`   - Rate limiting enabled`);
    
    if (process.env.RENDER) {
        console.log(`🌐 Render URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
    }
});

