const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const whatsappRoutes = require('./routes/simpleWhatsApp'); // CHANGED
const { initializeFirebase } = require('./config/firebase');
const SimpleWhatsAppService = require('./services/simpleWhatsAppService'); // CHANGED
const EmailService = require('./services/emailService');
const notificationRoutes = require('./routes/notifications');

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
app.use(express.json());
// Initialize Firebase
initializeFirebase();

// Initialize Simple WhatsApp Service - CHANGED
const whatsappService = new SimpleWhatsAppService(io);
const emailService = new EmailService();
const NotificationEmailService = require('./services/notificationEmailService');
const notificationEmailService = new NotificationEmailService(emailService);

// Add services to request object
app.use((req, res, next) => {
  req.whatsappService = whatsappService;
  req.emailService = emailService;
  next();
});

// Add notification email service to app.locals
app.locals.notificationEmailService = notificationEmailService;

// Routes
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/email', require('./routes/email'));
app.use('/api/notifications', require('./routes/notifications'));

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

// Add these error handlers at the end of your server.js file, before server.listen()

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit the process, just log the error
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit the process, just log the error
});

// Add graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  whatsappService.disconnect();
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

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
  
  if (whatsappService) {
    await whatsappService.disconnect();
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Add this at the end of server.js to handle memory issues
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.log('🔄 Server will restart...');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('🔄 Server will restart...');
  process.exit(1);
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
