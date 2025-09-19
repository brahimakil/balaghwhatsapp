const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const whatsappRoutes = require('./routes/whatsapp');
const { initializeFirebase } = require('./config/firebase');
const WhatsAppService = require('./services/whatsappService');
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

// Initialize WhatsApp Service ONCE - this was the bug!
const whatsappService = new WhatsAppService(io);
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
  const activeClients = whatsappService.getAllSessions();
  res.json({ 
    status: 'WhatsApp Backend is running!', 
    timestamp: new Date(),
    activeClients: activeClients.length,
    sessions: activeClients
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
  whatsappService.cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
  
  if (whatsappService) {
    await whatsappService.shutdown();
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
  
  if (whatsappService) {
    await whatsappService.shutdown();
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 WhatsApp Backend running on port ${PORT}`);
  console.log(`📱 Admin Panel should connect to: http://localhost:${PORT}`);
  
  // Restore saved sessions after server starts
  setTimeout(async () => {
    try {
      await whatsappService.restoreAllSessions();
      console.log('✅ Session restoration process completed');
    } catch (error) {
      console.error('❌ Error during session restoration:', error);
    }
  }, 3000); // Wait 3 seconds for everything to initialize
});
