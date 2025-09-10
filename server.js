const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const whatsappRoutes = require('./routes/whatsapp');
const { initializeFirebase } = require('./config/firebase');
const WhatsAppService = require('./services/whatsappService');

const app = express();
const server = http.createServer(app);

// CORS: allow multiple origins (localhost + Vercel) via env
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5174,https://balagh-admin.vercel.app')
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

// Middleware
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.options('*', cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firebase
initializeFirebase();

// Initialize WhatsApp Service ONCE - this was the bug!
const whatsappService = new WhatsAppService(io);

// Make io and whatsappService accessible to routes
app.set('io', io);
app.set('whatsappService', whatsappService); // Pass the instance directly, not a function

// Routes
app.use('/api/whatsapp', whatsappRoutes);

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
