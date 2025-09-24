const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const whatsappRoutes = require('./routes/simpleWhatsApp');
const { initializeFirebase } = require('./config/firebase');
const SimpleWhatsAppService = require('./services/simpleWhatsAppService');

const app = express();
const server = http.createServer(app);

// CORS: allow multiple origins via env
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,https://balagh-admin.vercel.app')
  .split(',')
  .map(s => s.trim());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.options('*', cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize Firebase
initializeFirebase();

// Initialize Simple WhatsApp Service
const whatsappService = new SimpleWhatsAppService(io);

// Add services to request object
app.use((req, res, next) => {
  req.whatsappService = whatsappService;
  next();
});

// Routes - ONLY WhatsApp routes now
app.use('/api/whatsapp', whatsappRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Simple WhatsApp Backend is running!', 
    timestamp: new Date()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Admin connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Admin disconnected:', socket.id);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
});

// Add graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  if (whatsappService) {
    await whatsappService.disconnect();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
  
  if (whatsappService) {
    await whatsappService.disconnect();
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Add memory monitoring
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`💾 Memory Usage: ${Math.round(used.rss / 1024 / 1024)} MB`);
  
  // If using more than 6GB, restart
  if (used.rss > 6 * 1024 * 1024 * 1024) {
    console.log('⚠️ High memory usage detected, restarting...');
    process.exit(1);
  }
}, 60000); // Check every minute

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 Simple WhatsApp Backend running on port ${PORT}`);
  console.log(`📱 Admin Panel should connect to: http://localhost:${PORT}`);
});
