const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const { initializeFirebase } = require('./config/firebase');
const SimpleWhatsAppService = require('./services/simpleWhatsAppService');

const app = express();
const server = http.createServer(app);

// CORS
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
app.use(express.json());

// Initialize Firebase
initializeFirebase();

// Initialize Simple WhatsApp Service
const whatsappService = new SimpleWhatsAppService(io);

// Add service to requests
app.use((req, res, next) => {
  req.whatsappService = whatsappService;
  next();
});

// Routes
app.use('/api/whatsapp', require('./routes/simpleWhatsApp'));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Simple WhatsApp Backend is running!', 
    timestamp: new Date()
  });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Admin connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Admin disconnected:', socket.id);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...');
  await whatsappService.disconnect();
  process.exit(0);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Simple WhatsApp Backend running on port ${PORT}`);
});
